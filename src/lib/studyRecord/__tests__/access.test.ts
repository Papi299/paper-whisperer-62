import { describe, expect, it } from "vitest";
import { canOfferStudyRecordWrites, studyRecordWriteAccess } from "../access";

/**
 * The owner-only pilot as the UI mirrors it (EVIDENCE-RECORDS-001C1). The
 * server's `evidence_records_assert_writable()` decides; the UI offers create
 * and edit to exactly `owner`, from the access projection alone, and fails
 * closed while loading or after a failed lookup.
 */
const lookup = (role: string, extra: { isLoading?: boolean; isError?: boolean } = {}) => ({
  access: { role },
  isLoading: extra.isLoading ?? false,
  isError: extra.isError ?? false,
});

describe("studyRecordWriteAccess", () => {
  it("offers create and edit to exactly the owner", () => {
    expect(studyRecordWriteAccess(lookup("owner"))).toBe("allowed");
    expect(canOfferStudyRecordWrites(studyRecordWriteAccess(lookup("owner")))).toBe(true);
  });

  it.each(["manager", "user", "", "Owner", "owner ", "admin", "anon"])("does not treat %j as the owner", (role) => {
    expect(studyRecordWriteAccess(lookup(role))).toBe("not_allowed");
    expect(canOfferStudyRecordWrites(studyRecordWriteAccess(lookup(role)))).toBe(false);
  });

  it("offers nothing while the role is loading, even when a cached role says owner", () => {
    expect(studyRecordWriteAccess(lookup("owner", { isLoading: true }))).toBe("checking");
    expect(canOfferStudyRecordWrites("checking")).toBe(false);
  });

  it("offers nothing after the lookup failed, and says it is unknown", () => {
    expect(studyRecordWriteAccess(lookup("owner", { isError: true }))).toBe("unknown");
    expect(canOfferStudyRecordWrites("unknown")).toBe(false);
  });
});
