/**
 * The sign-in return target.
 *
 * An open redirect that fires immediately after a successful login on the real
 * PaperLume origin is a credible phishing primitive, so the negative corpus here
 * is the point of the module. Two properties are asserted throughout:
 *
 *   • only the `/extension-import` route with a *valid* handoff is accepted —
 *     not "anything beginning with a slash";
 *   • what comes back is rebuilt from the parsed identifier, so no attacker text
 *     is ever handed to the router even when the value passed every check.
 */

import { describe, it, expect } from "vitest";

import { buildExtensionImportPath } from "@/lib/extensionImportHandoff";
import {
  DEFAULT_POST_AUTH_PATH,
  buildAuthPathWithReturnTo,
  parseSafeReturnTo,
} from "@/lib/safeReturnTo";

describe("parseSafeReturnTo — accepted targets", () => {
  it("accepts the exact PMID handoff form", () => {
    expect(parseSafeReturnTo("/extension-import?kind=pmid&value=12345678")).toBe(
      "/extension-import?kind=pmid&value=12345678",
    );
  });

  it("accepts the exact DOI handoff form", () => {
    const path = buildExtensionImportPath({ kind: "doi", identifier: "10.1000/example" });
    expect(parseSafeReturnTo(path)).toBe(path);
  });

  it("accepts a DOI whose suffix needs encoding", () => {
    const path = buildExtensionImportPath({ kind: "doi", identifier: "10.1000/a#b" });
    expect(parseSafeReturnTo(path)).toBe(path);
  });

  it("round-trips every path the builder produces", () => {
    const intents = [
      { kind: "pmid", identifier: "1" },
      { kind: "pmid", identifier: "999999999999" },
      { kind: "doi", identifier: "10.1000/a/b/c" },
      { kind: "doi", identifier: "10.1056/NEJMoa2107934" },
    ] as const;
    for (const intent of intents) {
      const path = buildExtensionImportPath(intent);
      expect(parseSafeReturnTo(path)).toBe(path);
    }
  });
});

describe("parseSafeReturnTo — the target is rebuilt, never echoed", () => {
  it("drops a fragment rather than carrying it through", () => {
    expect(
      parseSafeReturnTo("/extension-import?kind=pmid&value=12345678#evil"),
    ).toBe("/extension-import?kind=pmid&value=12345678");
  });

  it("drops unrelated query parameters", () => {
    expect(
      parseSafeReturnTo("/extension-import?kind=pmid&value=12345678&next=https://evil.example"),
    ).toBe("/extension-import?kind=pmid&value=12345678");
  });

  it("normalises parameter order", () => {
    expect(parseSafeReturnTo("/extension-import?value=12345678&kind=pmid")).toBe(
      "/extension-import?kind=pmid&value=12345678",
    );
  });
});

describe("parseSafeReturnTo — rejected targets", () => {
  const REJECTED = [
    ["an absolute https URL", "https://evil.example/"],
    ["an absolute http URL", "http://evil.example/extension-import?kind=pmid&value=1"],
    ["a protocol-relative URL", "//evil.example/"],
    ["a protocol-relative URL to the right path", "//evil.example/extension-import?kind=pmid&value=1"],
    ["a backslash protocol-relative URL", "/\\evil.example/"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a data: URL", "data:text/html,<h1>hi</h1>"],
    ["a mailto: URL", "mailto:someone@evil.example"],
    ["a scheme-relative host", "evil.example/extension-import?kind=pmid&value=1"],
    ["an absolute URL with a userinfo trick", "https://app.paperlume.app@evil.example/"],
    ["a bare relative path", "extension-import?kind=pmid&value=1"],
    ["blank", ""],
    ["whitespace only", "   "],
  ] as const;

  it.each(REJECTED)("refuses %s", (_label, value) => {
    expect(parseSafeReturnTo(value)).toBeNull();
  });

  it("refuses null and undefined", () => {
    expect(parseSafeReturnTo(null)).toBeNull();
    expect(parseSafeReturnTo(undefined)).toBeNull();
  });
});

describe("parseSafeReturnTo — the allowlist is one route", () => {
  const OTHER_INTERNAL_PATHS = [
    ["the dashboard", "/dashboard"],
    ["the root", "/"],
    ["the auth page itself", "/auth"],
    ["password reset", "/reset-password"],
    ["an unknown path", "/whatever"],
    ["a prefix lookalike", "/extension-import-evil?kind=pmid&value=1"],
    ["a nested path", "/extension-import/nested?kind=pmid&value=1"],
    ["a trailing slash", "/extension-import/?kind=pmid&value=1"],
  ] as const;

  it.each(OTHER_INTERNAL_PATHS)("refuses %s", (_label, value) => {
    // A same-origin path is not automatically a safe place to bounce a freshly
    // authenticated session into, and nothing else needs this mechanism today.
    expect(parseSafeReturnTo(value)).toBeNull();
  });
});

describe("parseSafeReturnTo — the right route with an invalid handoff", () => {
  const INVALID_HANDOFFS = [
    ["no query at all", "/extension-import"],
    ["an empty query", "/extension-import?"],
    ["a missing value", "/extension-import?kind=pmid"],
    ["a missing kind", "/extension-import?value=12345678"],
    ["an unknown kind", "/extension-import?kind=title&value=some+paper"],
    ["an invalid PMID", "/extension-import?kind=pmid&value=abc"],
    ["a resolver URL as a DOI", "/extension-import?kind=doi&value=https%3A%2F%2Fdoi.org%2F10.1000%2Fexample"],
    ["a repeated value", "/extension-import?kind=pmid&value=1&value=2"],
  ] as const;

  it.each(INVALID_HANDOFFS)("refuses %s", (_label, value) => {
    expect(parseSafeReturnTo(value)).toBeNull();
  });
});

describe("the fallback destination", () => {
  it("is the application's pre-existing post-sign-in path", () => {
    // `Index` redirects `/` on to `/dashboard`, so a rejected or absent
    // `returnTo` behaves exactly as sign-in did before this parameter existed.
    expect(DEFAULT_POST_AUTH_PATH).toBe("/");
  });

  it("is deterministic and internal", () => {
    expect(DEFAULT_POST_AUTH_PATH.startsWith("/")).toBe(true);
    expect(DEFAULT_POST_AUTH_PATH.startsWith("//")).toBe(false);
  });
});

describe("buildAuthPathWithReturnTo", () => {
  it("produces a link whose returnTo survives the round trip", () => {
    const target = buildExtensionImportPath({ kind: "doi", identifier: "10.1000/a b" });
    const authPath = buildAuthPathWithReturnTo(target);

    expect(authPath.startsWith("/auth?")).toBe(true);

    const returned = new URL(authPath, "http://local.invalid").searchParams.get("returnTo");
    expect(parseSafeReturnTo(returned)).toBe(target);
  });

  it("encodes the target so it cannot break out of the query", () => {
    const authPath = buildAuthPathWithReturnTo("/extension-import?kind=pmid&value=12345678");
    // One `?` only — the target's own separators are encoded.
    expect(authPath.split("?")).toHaveLength(2);
    expect(authPath).toContain("%3Fkind%3Dpmid");
  });
});
