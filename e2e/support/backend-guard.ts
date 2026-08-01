/**
 * Backend-target guard — pure, dependency-free validation used by the local
 * Playwright E2E lifecycle to make accidental Production-backed test runs fail
 * closed.
 *
 * This module is intentionally pure and side-effect free:
 *   - no Docker, no Supabase, no browser, no network, no filesystem;
 *   - it only parses and validates URL *strings* / hostnames;
 *   - it is imported by three call sites — `playwright.config.ts` (Layer 1,
 *     pre-server), `e2e/global-setup.ts` (Layer 2, browser-runtime), and its
 *     own Vitest unit test — so it must import nothing environment-specific
 *     beyond the WHATWG `URL` global (present in Node and jsdom).
 *
 * Security contract:
 *   - It never accepts a target merely because the substring "localhost"
 *     appears somewhere in the string — it parses the URL and validates the
 *     actual hostname.
 *   - It denies the known Production project ref anywhere in the URL.
 *   - It denies every non-loopback host (all remote hosts, all *.supabase.co
 *     projects, and lookalikes such as `localhost.example.com`).
 *   - Its thrown errors describe only URL-derived, non-sensitive facts
 *     (origin / hostname / protocol). The guard is only ever handed URLs, so
 *     it can never echo a key, password, token, or JWT.
 */

/**
 * The Production Supabase project ref. It must never appear in any local E2E
 * execution target. Kept as a constant so the denial is a single source of
 * truth shared by every call site and every test.
 */
export const PRODUCTION_SUPABASE_REF = "lioxtgiputfniqbktcsz";

/** Error type thrown by every guard assertion, so callers can catch narrowly. */
export class BackendGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendGuardError";
  }
}

/**
 * Parse a value that is expected to be a non-blank URL string.
 * Throws {@link BackendGuardError} on a non-string, blank, or malformed value.
 */
export function parseUrl(raw: unknown, label = "URL"): URL {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new BackendGuardError(`${label} is missing or blank.`);
  }
  const trimmed = raw.trim();
  try {
    return new URL(trimmed);
  } catch {
    // Never echo the supplied value (not even a truncated prefix). A malformed
    // value handed to the guard could itself contain a secret-looking token
    // (key/password/JWT/query string); the message reports only the label.
    throw new BackendGuardError(`${label} is not a valid absolute URL.`);
  }
}

/** True when `hostname` is an IPv4 loopback address (127.0.0.0/8). */
function isIpv4Loopback(hostname: string): boolean {
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  return m.slice(1).every((octet) => Number(octet) <= 255);
}

/** True when `hostname` (brackets already stripped) is the IPv6 loopback (::1). */
function isIpv6Loopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "::1") return true;
  // Fully-expanded form. The WHATWG URL parser compresses `[::1]`, so this
  // branch only matters when a raw, un-parsed hostname is checked directly.
  if (h === "0:0:0:0:0:0:0:1") return true;
  return false;
}

/**
 * True when `hostname` is a loopback host: `localhost`, an IPv4 127.0.0.0/8
 * address, or the IPv6 loopback `::1`. The comparison is exact — `localhost`
 * matches but `localhost.example.com` does not.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (h === "") return false;
  if (h === "localhost") return true;
  const unbracketed = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (isIpv6Loopback(unbracketed)) return true;
  if (isIpv4Loopback(h)) return true;
  return false;
}

/** True when the forbidden Production project ref appears anywhere in `value`. */
export function containsProductionRef(value: string): boolean {
  return value.toLowerCase().includes(PRODUCTION_SUPABASE_REF);
}

/**
 * True when `hostname` belongs to a remote Supabase-hosted project
 * (`*.supabase.co` / `*.supabase.in`, or the bare apex). Used only to produce
 * a clearer error message; the loopback check below already denies these.
 */
export function isRemoteSupabaseHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return (
    h === "supabase.co" ||
    h === "supabase.in" ||
    h.endsWith(".supabase.co") ||
    h.endsWith(".supabase.in")
  );
}

/** Normalized origin (`protocol//host[:port]`, lowercased) for exact matching. */
export function normalizeOrigin(url: URL): string {
  return url.origin.toLowerCase();
}

/** Reject any protocol other than http/https. */
function assertHttpProtocol(url: URL, label: string): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BackendGuardError(
      `${label} must use http(s); got protocol "${url.protocol}" (host "${url.hostname}").`,
    );
  }
}

/**
 * Validate that `raw` is a safe *local* Supabase API target and return the
 * parsed URL. Throws {@link BackendGuardError} if it is blank, malformed, not
 * http(s), contains the Production ref, is a remote Supabase project, or is any
 * non-loopback host.
 */
export function assertLocalSupabaseUrl(raw: unknown, label = "Supabase URL"): URL {
  const url = parseUrl(raw, label);
  assertHttpProtocol(url, label);

  if (containsProductionRef(url.href)) {
    throw new BackendGuardError(
      `${label} references the forbidden Production project ref ` +
        `"${PRODUCTION_SUPABASE_REF}"; refusing to run E2E against Production ` +
        `(host "${url.hostname}").`,
    );
  }

  if (isRemoteSupabaseHost(url.hostname)) {
    throw new BackendGuardError(
      `${label} points at a remote Supabase project (host "${url.hostname}"). ` +
        `Local E2E must target a loopback stack only.`,
    );
  }

  if (!isLoopbackHostname(url.hostname)) {
    throw new BackendGuardError(
      `${label} host "${url.hostname}" is not a loopback address. Local E2E ` +
        `requires localhost, 127.0.0.0/8, or [::1] (origin ${normalizeOrigin(url)}).`,
    );
  }

  return url;
}

/**
 * Validate that the application `BASE_URL` is a loopback origin (any port).
 * Same host rules as {@link assertLocalSupabaseUrl}; the port is unconstrained
 * because the dev server port is configurable.
 */
export function assertLoopbackAppUrl(raw: unknown, label = "BASE_URL"): URL {
  const url = parseUrl(raw, label);
  assertHttpProtocol(url, label);
  if (containsProductionRef(url.href)) {
    throw new BackendGuardError(
      `${label} references the forbidden Production project ref; refusing.`,
    );
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new BackendGuardError(
      `${label} must be a loopback application origin (localhost / 127.0.0.1 / ` +
        `[::1]); got host "${url.hostname}".`,
    );
  }
  return url;
}

/**
 * Assert that an `expected` and an `actual` target resolve to the exact same
 * origin. When `requireLocal` is true (the default) both must independently be
 * valid local Supabase targets first. Returns the two parsed URLs.
 */
export function assertOriginsMatch(
  expectedRaw: unknown,
  actualRaw: unknown,
  options: { label?: string; requireLocal?: boolean } = {},
): { expected: URL; actual: URL } {
  const { label = "Supabase origin", requireLocal = true } = options;
  const expected = requireLocal
    ? assertLocalSupabaseUrl(expectedRaw, `expected ${label}`)
    : parseUrl(expectedRaw, `expected ${label}`);
  const actual = requireLocal
    ? assertLocalSupabaseUrl(actualRaw, `actual ${label}`)
    : parseUrl(actualRaw, `actual ${label}`);

  const expectedOrigin = normalizeOrigin(expected);
  const actualOrigin = normalizeOrigin(actual);
  if (expectedOrigin !== actualOrigin) {
    throw new BackendGuardError(
      `Backend target mismatch: expected ${label} ${expectedOrigin} but got ` +
        `${actualOrigin}. Refusing to proceed.`,
    );
  }
  return { expected, actual };
}
