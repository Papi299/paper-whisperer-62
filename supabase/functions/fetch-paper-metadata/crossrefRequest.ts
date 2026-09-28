/**
 * The Crossref request identity and URLs — CROSSREF-OPERATIONAL-IDENTITY-001A.
 *
 * Every request this function makes to the Crossref REST API is built here, so
 * the operator identity it carries is defined exactly once.
 *
 * ## The identity
 *
 * Crossref asks API clients to identify themselves with an email address it can
 * use to contact the operator about a problem with their requests, and routes
 * identified traffic to its "polite" pool. No registration or API key is
 * involved. Its current guidance ("Access and authentication", updated
 * 2025-10-16) is to include the address in the `mailto` query parameter or the
 * agent header, and it strongly recommends `mailto` in every request. The
 * etiquette example in its older, now deprecated documentation also names the
 * tool and its version in the `User-Agent`. PaperLume sends both, with the same
 * contact.
 *
 * The contact is PaperLume's already-published address. It is an operator
 * contact, not user data and not a secret: Crossref receives it by design. It is
 * **temporary**:
 * - it replaces `PaperIndex/1.0 (mailto:support@paperindex.app)`, which named the
 *   retired product and an address never shown to be reachable;
 * - `support@paperlume.app` is deliberately not used, because it is not an active
 *   mailbox yet. Moving to it later is a change to `CROSSREF_CONTACT_EMAIL` alone.
 *
 * ## The URLs
 *
 * Only the contact is added.
 * - The DOI is still encoded exactly once, with `encodeURIComponent`, and arrives
 *   unencoded: `detectIdentifier` proves the DOI name and is the single place it
 *   is normalized.
 * - The title search keeps its `query.title` encoding and `rows=1`.
 *
 * No other parameter and no other user content is sent. These URLs carry the
 * DOI or the title, so they are never logged:
 * - the transport (`./upstreamFetch.ts`) logs only bounded facts;
 * - the catch blocks in `index.ts` log only an allow-listed error name.
 */

/** The product name Crossref sees. */
export const CROSSREF_CLIENT_NAME = "PaperLume";
/** The client version Crossref sees. */
export const CROSSREF_CLIENT_VERSION = "1.0";
/** The operator contact Crossref may use. Temporary — see the module comment. */
export const CROSSREF_CONTACT_EMAIL = "mutrisport@gmail.com";

/** `PaperLume/1.0 (mailto:mutrisport@gmail.com)` */
export const CROSSREF_USER_AGENT =
  `${CROSSREF_CLIENT_NAME}/${CROSSREF_CLIENT_VERSION} (mailto:${CROSSREF_CONTACT_EMAIL})`;

const CROSSREF_WORKS_ENDPOINT = "https://api.crossref.org/works";

/**
 * The `mailto` query parameter. It is encoded like any query value, except that
 * `@` stays literal: RFC 3986 allows it in a query, and it is how Crossref's own
 * examples write the parameter (`mailto=yourmail@company.org`).
 */
const CROSSREF_MAILTO_PARAM =
  `mailto=${encodeURIComponent(CROSSREF_CONTACT_EMAIL).replace(/%40/g, "@")}`;

/** `GET /works/{doi}` for a DOI name proven by `detectIdentifier`: the DOI is one path segment. */
export function crossrefWorkUrl(doi: string): string {
  return `${CROSSREF_WORKS_ENDPOINT}/${encodeURIComponent(doi)}?${CROSSREF_MAILTO_PARAM}`;
}

/** `GET /works?query.title=…&rows=1`: the single best title match. */
export function crossrefTitleSearchUrl(title: string): string {
  return `${CROSSREF_WORKS_ENDPOINT}?query.title=${encodeURIComponent(title)}&rows=1&${CROSSREF_MAILTO_PARAM}`;
}

/** The request init every Crossref call hands to the transport; a fresh object each time. */
export function crossrefRequestInit(): RequestInit {
  return { headers: { "User-Agent": CROSSREF_USER_AGENT } };
}
