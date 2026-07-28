import { describe, it, expect } from "vitest";
import {
  buildCredentialIdentity,
  isCachedTokenUsable,
  buildProviderConfigIdentity,
  isCachedResponseUsable,
  type CachedToken,
  type CachedResponse,
} from "../providerCache.ts";

describe("credential identity + token cache reuse", () => {
  it("builds distinct identities for distinct credentials and never contains the raw key", () => {
    const a = buildCredentialIdentity("sa@x.iam", "proj-1", "fp-aaa");
    const b = buildCredentialIdentity("sa@x.iam", "proj-2", "fp-aaa"); // different project
    const c = buildCredentialIdentity("sa@x.iam", "proj-1", "fp-bbb"); // rotated key (fingerprint)
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    // Only a fingerprint is used — the identity carries no raw PEM material.
    expect(a).not.toMatch(/BEGIN PRIVATE KEY/);
  });

  it("reuses a valid, matching token but NOT one from a different credential config", () => {
    const cache: CachedToken = { identity: buildCredentialIdentity("sa@x", "proj-1", "fp1"), token: "t", expiresAtEpochSec: 2000 };
    const now = 1000;
    expect(isCachedTokenUsable(cache, cache.identity, now)).toBe(true);
    // Different identity (rotated key / changed project) → do not reuse.
    expect(isCachedTokenUsable(cache, buildCredentialIdentity("sa@x", "proj-1", "fp2"), now)).toBe(false);
    expect(isCachedTokenUsable(cache, buildCredentialIdentity("sa@x", "proj-9", "fp1"), now)).toBe(false);
  });

  it("does not reuse a token within the expiry skew window, or a null cache", () => {
    const cache: CachedToken = { identity: "id", token: "t", expiresAtEpochSec: 1000 };
    expect(isCachedTokenUsable(cache, "id", 950)).toBe(false); // within 60s skew
    expect(isCachedTokenUsable(cache, "id", 800)).toBe(true);
    expect(isCachedTokenUsable(null, "id", 0)).toBe(false);
  });
});

describe("response cache reuse", () => {
  it("reuses within TTL for the same full identity, not across a config change", () => {
    const idA = buildProviderConfigIdentity("proj-1", "gemini-flash-latest", "sa@x.iam", "fp-aaa");
    const idB = buildProviderConfigIdentity("proj-1", "gemini-2.0-flash", "sa@x.iam", "fp-aaa"); // model changed
    const cache: CachedResponse<{ x: number }> = { identity: idA, atMs: 1000, body: { x: 1 } };
    expect(isCachedResponseUsable(cache, idA, 1000 + 60_000, 120_000)).toBe(true);
    expect(isCachedResponseUsable(cache, idA, 1000 + 200_000, 120_000)).toBe(false); // past TTL
    expect(isCachedResponseUsable(cache, idB, 1000 + 60_000, 120_000)).toBe(false); // model changed
    expect(isCachedResponseUsable(null, idA, 0, 120_000)).toBe(false);
  });

  it("misses when ANY credential/config component changes (rotation is exercised next call)", () => {
    const base = buildProviderConfigIdentity("proj-1", "gemini-flash-latest", "sa@x.iam", "fp-aaa");
    const cache: CachedResponse<{ x: number }> = { identity: base, atMs: 1000, body: { x: 1 } };
    const within = 1000 + 60_000;
    // Same everything → hit.
    expect(isCachedResponseUsable(cache, base, within, 120_000)).toBe(true);
    // Each single change → miss, so a rotated key / changed SA / project / model
    // is never served a response produced under the previous credential.
    const changed = [
      buildProviderConfigIdentity("proj-2", "gemini-flash-latest", "sa@x.iam", "fp-aaa"), // project
      buildProviderConfigIdentity("proj-1", "gemini-2.0-flash", "sa@x.iam", "fp-aaa"), // model
      buildProviderConfigIdentity("proj-1", "gemini-flash-latest", "sa2@x.iam", "fp-aaa"), // client email
      buildProviderConfigIdentity("proj-1", "gemini-flash-latest", "sa@x.iam", "fp-bbb"), // rotated key
    ];
    for (const id of changed) {
      expect(id).not.toBe(base);
      expect(isCachedResponseUsable(cache, id, within, 120_000)).toBe(false);
    }
  });

  it("the response identity never contains raw PEM material (only a fingerprint)", () => {
    const id = buildProviderConfigIdentity("proj-1", "gemini-flash-latest", "sa@x.iam", "fp-aaa");
    expect(id).not.toMatch(/BEGIN PRIVATE KEY/);
    expect(id).toContain("fp-aaa");
  });
});
