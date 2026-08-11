import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStorageMock } from "./supabaseMock";

const { mockStorageFrom } = vi.hoisted(() => ({ mockStorageFrom: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), storage: { from: mockStorageFrom } },
}));

import {
  ATTACHMENT_DOWNLOAD_CONCURRENCY,
  createAttachmentDownloader,
  downloadAttachmentsBounded,
} from "../fetchAttachmentBinaries";
import { AccountExportError, type ExportedAttachment } from "../types";

const USER = "user-a";
const OTHER_USER = "user-b";

function attachment(overrides: Partial<ExportedAttachment> = {}): ExportedAttachment {
  return {
    id: "att-1",
    user_id: USER,
    paper_id: "p1",
    file_path: `${USER}/p1/att-1.pdf`,
    file_name: "study.pdf",
    file_type: "application/pdf",
    size_bytes: 3,
    created_at: "2026-01-01T00:00:00Z",
    archive_path: "attachments/p1/att-1-study.pdf",
    ...overrides,
  } as ExportedAttachment;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createAttachmentDownloader", () => {
  it("downloads from the private bucket by authenticated path", async () => {
    const storage = createStorageMock({
      objects: { [`${USER}/p1/att-1.pdf`]: new Uint8Array([1, 2, 3]) },
    });
    mockStorageFrom.mockImplementation((bucket: string) => storage.from(bucket));

    const bytes = await createAttachmentDownloader(USER)(attachment());

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(mockStorageFrom).toHaveBeenCalledWith("attachments");
    expect(storage.requested).toEqual([`${USER}/p1/att-1.pdf`]);
  });

  it("refuses — without issuing a request — a path outside the user namespace", async () => {
    const storage = createStorageMock({
      objects: { [`${OTHER_USER}/p1/att-1.pdf`]: new Uint8Array([9, 9]) },
    });
    mockStorageFrom.mockImplementation((bucket: string) => storage.from(bucket));

    const download = createAttachmentDownloader(USER);

    await expect(
      download(attachment({ file_path: `${OTHER_USER}/p1/att-1.pdf` })),
    ).rejects.toBeInstanceOf(AccountExportError);
    await expect(
      download(attachment({ file_path: `${USER}/../${OTHER_USER}/att.pdf` })),
    ).rejects.toBeInstanceOf(AccountExportError);
    await expect(
      download(attachment({ user_id: OTHER_USER })),
    ).rejects.toBeInstanceOf(AccountExportError);

    // Fail-closed means no Storage request happened at all.
    expect(storage.requested).toEqual([]);
  });

  it("reports a safe message when Storage fails", async () => {
    const storage = createStorageMock({
      objects: {},
      errors: { [`${USER}/p1/att-1.pdf`]: new Error("Object not found: bucket attachments") },
    });
    mockStorageFrom.mockImplementation((bucket: string) => storage.from(bucket));

    const error = await createAttachmentDownloader(USER)(attachment()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AccountExportError);
    expect((error as AccountExportError).stage).toBe("attachments");
    expect((error as AccountExportError).message).toBe(
      "Could not download one of your attachments.",
    );
    expect((error as AccountExportError).message).not.toContain("bucket");
  });
});

describe("downloadAttachmentsBounded", () => {
  it("defaults to a small fixed concurrency bound", () => {
    expect(ATTACHMENT_DOWNLOAD_CONCURRENCY).toBeGreaterThan(0);
    expect(ATTACHMENT_DOWNLOAD_CONCURRENCY).toBeLessThanOrEqual(4);
  });

  it("never holds more than `concurrency` binaries in flight", async () => {
    const attachments = Array.from({ length: 25 }, (_, i) =>
      attachment({ id: `att-${i}`, archive_path: `attachments/p1/att-${i}.pdf` }),
    );

    let inFlight = 0;
    let maxInFlight = 0;
    const download = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return new Uint8Array([1]);
    };

    const seen: string[] = [];
    for await (const result of downloadAttachmentsBounded(attachments, download, 3)) {
      seen.push(result.attachment.id);
    }

    expect(seen).toHaveLength(25);
    expect(maxInFlight).toBe(3);
  });

  it("yields results in input order", async () => {
    const attachments = Array.from({ length: 6 }, (_, i) => attachment({ id: `att-${i}` }));
    // Deliberately inverted latency so completion order differs from input order.
    const download = async (a: ExportedAttachment) => {
      const index = Number(a.id.split("-")[1]);
      await new Promise((resolve) => setTimeout(resolve, (6 - index) * 2));
      return new Uint8Array([index]);
    };

    const seen: string[] = [];
    for await (const result of downloadAttachmentsBounded(attachments, download, 3)) {
      seen.push(result.attachment.id);
    }

    expect(seen).toEqual(["att-0", "att-1", "att-2", "att-3", "att-4", "att-5"]);
  });

  it("aborts on the first failure without leaving unhandled rejections", async () => {
    const attachments = Array.from({ length: 6 }, (_, i) => attachment({ id: `att-${i}` }));
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
    window.addEventListener("unhandledrejection", onUnhandled);

    const download = async (a: ExportedAttachment) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (a.id !== "att-0") throw new Error(`boom ${a.id}`);
      return new Uint8Array([1]);
    };

    const seen: string[] = [];
    const run = async () => {
      for await (const result of downloadAttachmentsBounded(attachments, download, 3)) {
        seen.push(result.attachment.id);
      }
    };

    await expect(run()).rejects.toBeInstanceOf(AccountExportError);
    expect(seen).toEqual(["att-0"]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    window.removeEventListener("unhandledrejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it("handles an empty attachment set", async () => {
    const seen: unknown[] = [];
    for await (const result of downloadAttachmentsBounded([], async () => new Uint8Array())) {
      seen.push(result);
    }
    expect(seen).toEqual([]);
  });
});
