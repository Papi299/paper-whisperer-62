// @vitest-environment node
import { describe, expect, it } from "vitest";

import { isCanonicalUuid, MAX_POSTGRES_INTEGER, toPaperId, toRequestId, toStudyId, toStudyVersion, toValueVersion } from "../ids";

describe("identities", () => {
  it("accepts only canonical UUIDs, returned in lowercase", () => {
    expect(toStudyId("50000000-0000-4000-8000-0000000000AB")).toBe("50000000-0000-4000-8000-0000000000ab");
    expect(isCanonicalUuid("50000000-0000-4000-8000-000000000001")).toBe(true);
    for (const bad of ["", "5000000000004000800000000000001", "{50000000-0000-4000-8000-000000000001}", " 50000000-0000-4000-8000-000000000001", "z0000000-0000-4000-8000-000000000001", null, 7]) {
      expect(toPaperId(bad)).toBeNull();
      expect(toRequestId(bad)).toBeNull();
    }
  });
});

describe("versions", () => {
  it("are integers from 1 to the PostgreSQL integer maximum", () => {
    expect(toStudyVersion(1)).toBe(1);
    expect(toStudyVersion(MAX_POSTGRES_INTEGER)).toBe(MAX_POSTGRES_INTEGER);
    for (const bad of [0, -1, 1.5, MAX_POSTGRES_INTEGER + 1, Number.NaN, "2", null]) {
      expect(toStudyVersion(bad)).toBeNull();
      expect(toValueVersion(bad)).toBeNull();
    }
  });
});
