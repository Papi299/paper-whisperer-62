/**
 * The one web destination this extension may construct.
 *
 * `detectPaperFromUrl` decides *whether* the active tab names a paper; this
 * module decides *where* that identifier is handed to, and it is the only file
 * in the extension that names an external origin at all. Keeping it alone, pure
 * and free of Chrome APIs is what makes the origin and the encoding testable
 * without a browser — and what makes "which web origins can this extension
 * reach?" a question one short file answers.
 *
 * ## The origin is a constant, never a derivation
 *
 * `PAPERLUME_WEB_ORIGIN` is written out literally. It is not read from the
 * current tab's URL, a query parameter, extension storage, remote config, an
 * environment variable, page content, or a redirect some other site supplied.
 * The detected identifier influences the query string and nothing else: scheme,
 * host, port and pathname come from constants this file and
 * `@/lib/extensionImportHandoff` own.
 *
 * That is enforced structurally rather than by review. The URL is assembled by
 * assigning `pathname` and `search` onto a `URL` built from the origin
 * constant, because neither setter can change the host — assigning even
 * `//evil.example/x` to `pathname` yields
 * `https://app.paperlume.app//evil.example/x`, not another origin. The
 * alternative, `new URL(path, origin)`, would resolve a protocol-relative path
 * against the base and *could* change the host, so it is deliberately not used.
 *
 * ## No second handoff grammar
 *
 * The `?kind=…&value=…` contract belongs to `@/lib/extensionImportHandoff`,
 * which is also what the receiving route parses with. This module calls that
 * builder rather than restating it, so the extension cannot drift into emitting
 * a URL the route would refuse. The extension build aliases `@` to the
 * application's `src/` tree for exactly this kind of reuse.
 *
 * ## What is not handed over
 *
 * The identifier, and nothing else. No title, no source page URL, no referrer,
 * no Project or Tag id, no user id, no timestamp, no extension id, and no
 * analytics parameter. Building the URL is also the end of this module's job:
 * it issues no request and inspects no response — a browser tab navigating to
 * PaperLume is the whole of the transport.
 */

import {
  buildExtensionImportPath,
  type ExtensionImportIntent,
} from "@/lib/extensionImportHandoff";

import type { PaperDetection } from "./detectPaperFromUrl";

/** The canonical PaperLume Production origin. Origin only — no path, no query. */
export const PAPERLUME_WEB_ORIGIN = "https://app.paperlume.app";

/**
 * Map a detection onto the handoff contract, or refuse it.
 *
 * Only the two structurally authenticated states map to an intent.
 * `unsupported` and `restricted` produce `null` — there is no identifier to
 * hand over, and there is deliberately no third thing to send instead: no page
 * title, no source URL, no "let PaperLume have a look". A page the extension
 * could not identify is a page nothing is sent about.
 */
function toIntent(detection: PaperDetection): ExtensionImportIntent | null {
  if (detection.state === "pubmed") return { kind: "pmid", identifier: detection.pmid };
  if (detection.state === "doi") return { kind: "doi", identifier: detection.doi };
  return null;
}

/**
 * The PaperLume URL for a detection, or `null` when there is nothing to hand
 * over.
 *
 * Pure: no Chrome API, no I/O. Opening the returned URL is the caller's job,
 * which is what lets every property asserted about it — origin, path, query,
 * encoding — be asserted without a browser.
 */
export function buildPaperLumeHandoffUrl(detection: PaperDetection): string | null {
  const intent = toIntent(detection);
  if (intent === null) return null;

  const path = buildExtensionImportPath(intent);
  const queryStart = path.indexOf("?");

  // Host and scheme are fixed by construction here; see the module comment.
  const url = new URL(PAPERLUME_WEB_ORIGIN);
  url.pathname = queryStart === -1 ? path : path.slice(0, queryStart);
  url.search = queryStart === -1 ? "" : path.slice(queryStart + 1);

  return url.toString();
}
