import { describe, it, expect, beforeEach } from "vitest";
import {
  ATTACHMENT_CLEANUP_OBJECT_NAMES,
  isAttachmentCleanupSchemaMissing,
  noteAttachmentCleanupObjectPresent,
  resetAttachmentCleanupAvailabilityForTests,
} from "../attachmentCleanupAvailability";

/**
 * The rollout classifier for ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001.
 *
 * Two failures matter and they pull in opposite directions:
 *
 *  * too narrow, and paper deletion breaks in Production for everyone between
 *    the Vercel deploy and the migration;
 *  * too wide, and a genuine fault — a permission error, an RLS refusal, a
 *    network failure — is silently answered by dropping every user down to the
 *    lossy pre-migration cleanup path, forever, with nothing reported.
 *
 * So every assertion below is about the exact boundary between those.
 */
describe("isAttachmentCleanupSchemaMissing", () => {
  beforeEach(() => {
    resetAttachmentCleanupAvailabilityForTests();
  });

  it("declares exactly the four objects this feature is willing to miss", () => {
    // Spelled out rather than derived: widening this list is a decision about
    // what the product will silently tolerate, and it must be visible in a diff.
    expect([...ATTACHMENT_CLEANUP_OBJECT_NAMES]).toEqual([
      "attachment_cleanup_queue",
      "delete_attachment_with_cleanup",
      "delete_papers_with_attachment_cleanup",
      "queue_untracked_attachment_cleanup",
    ]);
  });

  it("does NOT list the internal path helper", () => {
    // No client calls `attachment_cleanup_path_is_safe`, so an error naming it
    // would mean something nobody predicted and must never be swallowed.
    expect([...ATTACHMENT_CLEANUP_OBJECT_NAMES]).not.toContain(
      "attachment_cleanup_path_is_safe",
    );
  });

  describe("the pre-migration shapes it must recognise", () => {
    it("recognises PostgREST's missing-function code for a cleanup RPC", () => {
      expect(
        isAttachmentCleanupSchemaMissing({
          code: "PGRST202",
          message:
            "Could not find the function public.delete_papers_with_attachment_cleanup(p_paper_ids) in the schema cache",
        }),
      ).toBe(true);
    });

    it("recognises PostgREST's missing-table code for the queue", () => {
      expect(
        isAttachmentCleanupSchemaMissing({
          code: "PGRST205",
          message: "Could not find the table 'public.attachment_cleanup_queue' in the schema cache",
        }),
      ).toBe(true);
    });

    it("recognises the undefined_function SQLSTATE", () => {
      expect(
        isAttachmentCleanupSchemaMissing({
          code: "42883",
          message: "function public.queue_untracked_attachment_cleanup(uuid, text) does not exist",
        }),
      ).toBe(true);
    });

    it("recognises the undefined_table SQLSTATE", () => {
      expect(
        isAttachmentCleanupSchemaMissing({
          code: "42P01",
          message: 'relation "public.attachment_cleanup_queue" does not exist',
        }),
      ).toBe(true);
    });

    it("matches the object name case-insensitively", () => {
      expect(
        isAttachmentCleanupSchemaMissing({
          code: "42883",
          message: "function public.DELETE_ATTACHMENT_WITH_CLEANUP(uuid) does not exist",
        }),
      ).toBe(true);
    });
  });

  describe("the failures it must NOT swallow", () => {
    it("rejects a permission error, however it is worded", () => {
      expect(
        isAttachmentCleanupSchemaMissing({
          code: "42501",
          message: "permission denied for function delete_attachment_with_cleanup",
        }),
      ).toBe(false);
    });

    it("rejects the RPC's own ownership refusal", () => {
      // P0001 is what every guard in these functions raises. Treating it as
      // "not installed" would turn a refused cross-user delete into a fallback
      // that tries the same thing a second way.
      expect(
        isAttachmentCleanupSchemaMissing({
          code: "P0001",
          message: "One or more papers do not exist or do not belong to the caller",
        }),
      ).toBe(false);
    });

    it("rejects a missing-object error naming an UNRELATED relation", () => {
      // A real schema problem elsewhere in the product. Reporting it as "the
      // cleanup feature is not installed" would hide it.
      expect(
        isAttachmentCleanupSchemaMissing({
          code: "42P01",
          message: 'relation "public.papers" does not exist',
        }),
      ).toBe(false);
    });

    it("rejects a missing-object code with no object name at all", () => {
      expect(isAttachmentCleanupSchemaMissing({ code: "42P01", message: "" })).toBe(false);
    });

    it("rejects a network failure", () => {
      expect(isAttachmentCleanupSchemaMissing(new TypeError("Failed to fetch"))).toBe(false);
    });

    it("rejects a constraint violation", () => {
      expect(
        isAttachmentCleanupSchemaMissing({
          code: "23514",
          message: 'new row violates check constraint "attachment_cleanup_queue_reason_known"',
        }),
      ).toBe(false);
    });

    it("rejects null, undefined and a bare string", () => {
      expect(isAttachmentCleanupSchemaMissing(null)).toBe(false);
      expect(isAttachmentCleanupSchemaMissing(undefined)).toBe(false);
      expect(isAttachmentCleanupSchemaMissing("attachment_cleanup_queue does not exist")).toBe(false);
    });
  });

  describe("a partially installed schema is broken, not old", () => {
    it("refuses the compatibility verdict once any cleanup object has answered", () => {
      const missingRpc = {
        code: "PGRST202",
        message:
          "Could not find the function public.delete_attachment_with_cleanup(p_attachment_id) in the schema cache",
      };
      // Before any evidence, this is an ordinary pre-migration environment.
      expect(isAttachmentCleanupSchemaMissing(missingRpc)).toBe(true);

      resetAttachmentCleanupAvailabilityForTests();
      // The queue answered, so this environment HAS the migration. A missing
      // function now means somebody dropped one — a state a transactional
      // migration cannot produce, and one that must be seen rather than
      // silently downgraded to the lossy path for every user.
      noteAttachmentCleanupObjectPresent("attachment_cleanup_queue");
      expect(isAttachmentCleanupSchemaMissing(missingRpc)).toBe(false);
    });

    it("counts evidence from any cleanup object, not just the queue", () => {
      noteAttachmentCleanupObjectPresent("delete_papers_with_attachment_cleanup");
      expect(
        isAttachmentCleanupSchemaMissing({
          code: "PGRST205",
          message: "Could not find the table 'public.attachment_cleanup_queue' in the schema cache",
        }),
      ).toBe(false);
    });

    it("starts from no evidence again after a reset", () => {
      noteAttachmentCleanupObjectPresent("attachment_cleanup_queue");
      resetAttachmentCleanupAvailabilityForTests();
      expect(
        isAttachmentCleanupSchemaMissing({
          code: "42P01",
          message: 'relation "public.attachment_cleanup_queue" does not exist',
        }),
      ).toBe(true);
    });
  });
});
