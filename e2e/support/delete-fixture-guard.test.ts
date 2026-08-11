import { describe, it, expect } from "vitest";
// The lifecycle fixture is plain Node ESM (no compile step), imported here so
// its Production fail-closed guard has coverage of its own.
import {
  assertLoopbackApiUrl,
  PRODUCTION_SUPABASE_REF,
} from "../../scripts/e2e-local-delete-fixture.mjs";

/**
 * PFA-C04 introduced a new destructive execution path: a helper that creates a
 * disposable Auth user, uploads Storage objects for it, and later proves it was
 * deleted. Everything it does is irreversible, so its target check must fail
 * closed *before* any credential is read, any user is created, any object is
 * uploaded, or any deletion is verified.
 *
 * These are pure unit tests over URL strings — no Docker, Supabase, network, or
 * filesystem access — matching the existing backend-guard.test.ts contract.
 */

describe("account-deletion fixture guard — accepted targets", () => {
  it.each([
    "http://127.0.0.1:54321",
    "http://127.0.0.1:54321/",
    "http://localhost:54321",
    "http://[::1]:54321",
    "http://127.9.9.9:1234",
    "https://localhost:54321",
  ])("accepts the loopback target %s", (url) => {
    expect(() => assertLoopbackApiUrl(url)).not.toThrow();
  });
});

describe("account-deletion fixture guard — Production is refused", () => {
  it("refuses the Production project ref", () => {
    expect(() => assertLoopbackApiUrl(`https://${PRODUCTION_SUPABASE_REF}.supabase.co`)).toThrow(
      /Production project ref/i,
    );
  });

  it("refuses the Production ref even inside an otherwise loopback-looking URL", () => {
    // A loopback host is not enough: the forbidden ref anywhere in the URL wins.
    expect(() =>
      assertLoopbackApiUrl(`http://127.0.0.1:54321/${PRODUCTION_SUPABASE_REF}`),
    ).toThrow(/Production project ref/i);
  });

  it("names the exact Production ref the repository protects", () => {
    expect(PRODUCTION_SUPABASE_REF).toBe("lioxtgiputfniqbktcsz");
  });
});

describe("account-deletion fixture guard — every non-loopback target is refused", () => {
  it.each([
    ["a remote Supabase project", "https://abcdefghijklmnop.supabase.co"],
    ["a lookalike host", "http://localhost.example.com:54321"],
    ["a subdomain of loopback", "http://sub.localhost:54321"],
    ["a public host", "https://app.paperlume.app"],
    ["a private LAN host", "http://192.168.1.10:54321"],
    ["a loopback-looking hostname", "http://127.0.0.1.example.com"],
  ])("refuses %s", (_label, url) => {
    expect(() => assertLoopbackApiUrl(url)).toThrow(/not loopback/i);
  });

  it.each([
    ["a non-http protocol", "postgres://127.0.0.1:54322/postgres"],
    ["a file URL", "file:///tmp/supabase"],
  ])("refuses %s", (_label, url) => {
    expect(() => assertLoopbackApiUrl(url)).toThrow(/http\(s\)/i);
  });

  it.each([
    ["a blank value", ""],
    ["a relative path", "/functions/v1/delete-account"],
    ["a bare host", "127.0.0.1:54321"],
    ["undefined", undefined],
    ["null", null],
    ["a number", 54321],
  ])("refuses %s as a malformed URL", (_label, value) => {
    expect(() => assertLoopbackApiUrl(value as string)).toThrow(/valid absolute URL/i);
  });
});

describe("account-deletion fixture guard — failure shape", () => {
  it("always throws rather than returning a falsy value", () => {
    // A guard that returned undefined for a bad target would let the caller
    // proceed; every rejection path must be an exception.
    for (const bad of ["", "https://evil.example", "postgres://127.0.0.1:5432"]) {
      let threw = false;
      try {
        assertLoopbackApiUrl(bad);
      } catch {
        threw = true;
      }
      expect(threw, `${bad} must throw`).toBe(true);
    }
  });

  it("never echoes the rejected value, which could carry a secret", () => {
    try {
      assertLoopbackApiUrl("https://evil.example/?apikey=sb_secret_should_not_be_echoed");
    } catch (error) {
      expect((error as Error).message).not.toContain("sb_secret_should_not_be_echoed");
      expect((error as Error).message).not.toContain("apikey");
    }
  });
});
