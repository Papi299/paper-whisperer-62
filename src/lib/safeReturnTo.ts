/**
 * The sign-in return target.
 *
 * An unauthenticated visitor who opens a handoff link must not lose the import
 * intent merely because they had to sign in first, so `/auth` accepts a
 * `returnTo` parameter. That parameter is attacker-reachable — `/auth?returnTo=…`
 * is a URL anyone can send — and a redirect built from attacker text is an open
 * redirect, which is a credible phishing primitive precisely *because* it starts
 * on the real PaperLume origin and fires immediately after a successful login.
 *
 * Two rules keep that from being possible.
 *
 * **1. The allowlist is one route, not "anything same-origin".** Only the
 * `/extension-import` handoff is a valid return target, and only when its query
 * is a valid handoff intent. A same-origin path is not automatically safe to
 * bounce a freshly authenticated session into, and nothing else in the
 * application needs this mechanism today.
 *
 * **2. The redirect target is rebuilt, never echoed.** What comes back is
 * constructed by `buildExtensionImportPath` from the parsed `kind` and
 * `identifier`, so the string handed to the router is one this application
 * produced. Even a value that passed every check cannot smuggle a fragment, a
 * second query parameter, an alternative encoding or trailing text through,
 * because none of that survives being re-derived from two validated fields.
 */

import {
  EXTENSION_IMPORT_PATH,
  buildExtensionImportPath,
  parseExtensionImportIntent,
} from "@/lib/extensionImportHandoff";

/**
 * Where a sign-in goes when there is no valid return target.
 *
 * `/` is the application's existing post-authentication destination — `Index`
 * redirects it on to `/dashboard` — so an absent or rejected `returnTo` behaves
 * exactly as sign-in did before this parameter existed.
 */
export const DEFAULT_POST_AUTH_PATH = "/";

/**
 * A base used only to give the WHATWG parser something to resolve against.
 *
 * `.invalid` is reserved by RFC 2606 and can never be a real host, so if a
 * candidate escapes to an absolute URL the host check below sees a host that is
 * not this one and rejects it. Nothing is ever fetched from it.
 */
const RELATIVE_PARSE_BASE = "http://return-to.invalid";

/**
 * Validate a `returnTo` value and return a safe internal path to redirect to.
 *
 * @returns A path this application constructed, or `null` when the value is not
 *   an acceptable return target. `null` means "use `DEFAULT_POST_AUTH_PATH`",
 *   never "redirect anyway".
 */
export function parseSafeReturnTo(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  // Must be a single-slash absolute path. This one check disposes of the whole
  // class before parsing: `https://evil.example/` and `javascript:…` have no
  // leading slash, and `//evil.example/` and `/\evil.example` are the
  // protocol-relative forms — the second because the WHATWG parser treats a
  // backslash as a slash in a special scheme, so `/\` is another spelling of
  // `//`.
  if (raw[0] !== "/") return null;
  if (raw[1] === "/" || raw[1] === "\\") return null;

  let url: URL;
  try {
    url = new URL(raw, RELATIVE_PARSE_BASE);
  } catch {
    return null;
  }

  // Belt and braces on the check above: if anything in the candidate managed to
  // change the origin, it is not a relative path and is refused.
  if (url.protocol !== "http:" || url.host !== "return-to.invalid") return null;

  // The narrow allowlist. Compared exactly — no prefix match, so
  // `/extension-import-evil` is a different route and is not accepted.
  if (url.pathname !== EXTENSION_IMPORT_PATH) return null;

  const intent = parseExtensionImportIntent(url.search);
  if (intent === null) return null;

  // Rebuilt from validated components, never echoed. See the module comment.
  return buildExtensionImportPath(intent);
}

/**
 * The `/auth` URL that preserves a handoff through sign-in.
 *
 * Takes the already-validated path the caller wants to come back to, so a
 * caller cannot accidentally build a link to an unvalidated destination.
 */
export function buildAuthPathWithReturnTo(returnToPath: string): string {
  const params = new URLSearchParams({ returnTo: returnToPath });
  return `/auth?${params.toString()}`;
}
