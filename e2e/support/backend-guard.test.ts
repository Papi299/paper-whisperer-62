import { describe, it, expect } from "vitest";
import {
  BackendGuardError,
  PRODUCTION_SUPABASE_REF,
  assertLocalSupabaseUrl,
  assertLoopbackAppUrl,
  assertOriginsMatch,
  containsProductionRef,
  isLoopbackHostname,
  isRemoteSupabaseHost,
  normalizeOrigin,
  parseUrl,
} from "./backend-guard";

/**
 * Pure unit tests for the E2E backend-target guard. No Docker, no Supabase, no
 * browser, no network — this file only exercises string/URL validation logic.
 */

const LOCAL_API = "http://127.0.0.1:54321";
const LOCAL_API_LOCALHOST = "http://localhost:54321";
const PRODUCTION_URL = `https://${PRODUCTION_SUPABASE_REF}.supabase.co`;
const OTHER_CLOUD_PROJECT = "https://abcdefghijklmnopqrst.supabase.co";

// Sensitive-looking fixtures the guard must never receive nor echo.
const FAKE_KEY = "sb_publishable_THIS_IS_A_FAKE_KEY_should_never_be_logged";
const FAKE_PASSWORD = "P@ssw0rd-should-never-be-logged-1234";

describe("isLoopbackHostname", () => {
  it("accepts exact loopback hosts", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.10.20.30")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("0:0:0:0:0:0:0:1")).toBe(true);
  });

  it("rejects lookalikes and remote hosts", () => {
    expect(isLoopbackHostname("localhost.example.com")).toBe(false);
    expect(isLoopbackHostname("notlocalhost")).toBe(false);
    expect(isLoopbackHostname("127.0.0.1.example.com")).toBe(false);
    expect(isLoopbackHostname("128.0.0.1")).toBe(false);
    expect(isLoopbackHostname("example.com")).toBe(false);
    expect(isLoopbackHostname("")).toBe(false);
  });
});

describe("containsProductionRef / isRemoteSupabaseHost", () => {
  it("detects the production ref anywhere in the string", () => {
    expect(containsProductionRef(PRODUCTION_URL)).toBe(true);
    expect(
      containsProductionRef(`http://127.0.0.1/${PRODUCTION_SUPABASE_REF}`),
    ).toBe(true);
    expect(containsProductionRef(LOCAL_API)).toBe(false);
  });

  it("detects remote supabase hosts but not loopback", () => {
    expect(isRemoteSupabaseHost("abc.supabase.co")).toBe(true);
    expect(isRemoteSupabaseHost("supabase.co")).toBe(true);
    expect(isRemoteSupabaseHost("localhost")).toBe(false);
    expect(isRemoteSupabaseHost("127.0.0.1")).toBe(false);
  });
});

describe("parseUrl", () => {
  it("rejects blank and non-string values", () => {
    expect(() => parseUrl("", "X")).toThrow(BackendGuardError);
    expect(() => parseUrl("   ", "X")).toThrow(BackendGuardError);
    expect(() => parseUrl(undefined, "X")).toThrow(BackendGuardError);
    expect(() => parseUrl(null, "X")).toThrow(BackendGuardError);
    expect(() => parseUrl(12345, "X")).toThrow(BackendGuardError);
  });

  it("rejects malformed URLs", () => {
    expect(() => parseUrl("not a url", "X")).toThrow(BackendGuardError);
    expect(() => parseUrl("http://", "X")).toThrow(BackendGuardError);
  });
});

describe("assertLocalSupabaseUrl", () => {
  it("accepts loopback API targets", () => {
    expect(assertLocalSupabaseUrl(LOCAL_API).origin).toBe("http://127.0.0.1:54321");
    expect(assertLocalSupabaseUrl(LOCAL_API_LOCALHOST).origin).toBe(
      "http://localhost:54321",
    );
    // Correctly-normalized IPv6 loopback.
    expect(assertLocalSupabaseUrl("http://[::1]:54321").origin).toBe(
      "http://[::1]:54321",
    );
  });

  it("rejects blank and malformed values", () => {
    expect(() => assertLocalSupabaseUrl("")).toThrow(BackendGuardError);
    expect(() => assertLocalSupabaseUrl("http://")).toThrow(BackendGuardError);
  });

  it("rejects the production ref (direct or browser-observed)", () => {
    expect(() => assertLocalSupabaseUrl(PRODUCTION_URL)).toThrow(
      /production project ref/i,
    );
  });

  it("rejects another supabase cloud project (direct or browser-observed)", () => {
    expect(() => assertLocalSupabaseUrl(OTHER_CLOUD_PROJECT)).toThrow(
      /remote supabase project/i,
    );
  });

  it("rejects the deceptive localhost.example.com host", () => {
    expect(() => assertLocalSupabaseUrl("http://localhost.example.com")).toThrow(
      /not a loopback/i,
    );
  });

  it("rejects a remote host with loopback in the path/query", () => {
    expect(() =>
      assertLocalSupabaseUrl("http://evil.example.com/localhost?x=127.0.0.1"),
    ).toThrow(/not a loopback/i);
  });

  it("rejects non-http protocols", () => {
    expect(() => assertLocalSupabaseUrl("ftp://127.0.0.1:54321")).toThrow(
      /http/i,
    );
    // Scheme-confusion: a host:port with no scheme parses as scheme "localhost:".
    expect(() => assertLocalSupabaseUrl("localhost:54321")).toThrow(/http/i);
  });
});

describe("assertLoopbackAppUrl", () => {
  it("accepts a loopback app origin on any port", () => {
    expect(assertLoopbackAppUrl("http://localhost:8080").origin).toBe(
      "http://localhost:8080",
    );
  });

  it("rejects a non-loopback app origin", () => {
    expect(() => assertLoopbackAppUrl("https://app.example.com")).toThrow(
      BackendGuardError,
    );
  });
});

describe("assertOriginsMatch", () => {
  it("accepts identical local origins", () => {
    expect(() => assertOriginsMatch(LOCAL_API, LOCAL_API)).not.toThrow();
  });

  it("rejects an expected/actual host mismatch", () => {
    expect(() =>
      assertOriginsMatch(LOCAL_API, LOCAL_API_LOCALHOST),
    ).toThrow(/mismatch/i);
  });

  it("rejects a port mismatch", () => {
    expect(() =>
      assertOriginsMatch("http://127.0.0.1:54321", "http://127.0.0.1:54322"),
    ).toThrow(/mismatch/i);
  });

  it("rejects a browser-observed production origin", () => {
    expect(() => assertOriginsMatch(LOCAL_API, PRODUCTION_URL)).toThrow(
      /production project ref/i,
    );
  });

  it("rejects a browser-observed remote origin", () => {
    expect(() => assertOriginsMatch(LOCAL_API, OTHER_CLOUD_PROJECT)).toThrow(
      /remote supabase project/i,
    );
  });
});

describe("normalizeOrigin", () => {
  it("produces a lowercased origin string", () => {
    expect(normalizeOrigin(new URL("HTTP://LocalHost:54321/rest/v1"))).toBe(
      "http://localhost:54321",
    );
  });
});

describe("error messages never echo secrets", () => {
  it("does not include key/password fixtures the guard was never given", () => {
    // The guard only ever receives URLs; assert that even when validation
    // fails, the thrown message contains no key/password material.
    let message = "";
    try {
      assertLocalSupabaseUrl(PRODUCTION_URL);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(FAKE_KEY);
    expect(message).not.toContain(FAKE_PASSWORD);
    expect(message.length).toBeGreaterThan(0);
  });
});
