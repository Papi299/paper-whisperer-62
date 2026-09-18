/**
 * The one place a caught throwable is allowed to become something an Edge
 * Function may log — EDGE-LOG-PRIVACY-HARDENING-001.
 *
 * ## The problem this exists to remove
 *
 * `err.message` is not content-free, and three separate mechanisms make it
 * carry exactly the data PaperLume promises not to log:
 *
 *   * **V8 `JSON.parse`** quotes the input in its message. Parsing a malformed
 *     generated answer produces `Unexpected token 'S', "{"tldr": Sleep depr"...
 *     is not valid JSON` — a fragment of the paper's content, in the log line
 *     someone would read while diagnosing.
 *   * **`fetch` transport errors** can embed the request URL. For PubMed that
 *     URL carries the PMID, the DOI or title being searched, and the user's
 *     `api_key`; for Crossref it carries the DOI or title.
 *   * **Any thrown value at all.** `String(error)` on a non-Error is whatever
 *     that value stringifies to, and a runtime library may put operational
 *     detail into a message without ever telling us.
 *
 * Redacting a known query parameter does not fix this: the rule has to be that
 * arbitrary throwable text never crosses into a log, not that we strip the
 * parts we happened to think of.
 *
 * ## The boundary
 *
 * `boundedErrorName` maps any thrown value onto one of the literals in
 * `BOUNDED_ERROR_NAMES`. The return value is chosen from that frozen list, so
 * it is content-free **by construction** rather than by inspection: an input
 * whose `name` is not on the list becomes `unknown_error_name`, and a thrown
 * non-object becomes `non_error`. Even a hostile value that sets its own `name`
 * can only ever select a list entry — it cannot introduce text.
 *
 * It is also **total**: reading a property is executable code, so a value whose
 * `name` is an accessor or a `Proxy` trap can throw on being read. That read is
 * guarded, and a value that cannot be read safely collapses to
 * `unknown_error_name`. The reducer therefore never throws — which matters
 * because it is called from `catch` blocks, where a secondary exception would
 * escape past the bounded log line it was building and carry its own message
 * out instead.
 *
 * What survives is the part that is actually diagnostic: `SyntaxError` says a
 * body did not parse, `TimeoutError` says we stopped waiting, `TypeError` says
 * the connection failed. Callers pair it with their own server-generated
 * bounded facts (operation, source, HTTP status, attempt number, error class).
 *
 * Pure module: no Deno APIs and no remote imports, so Vitest exercises the
 * exact shipped code rather than a copy of it.
 */

/**
 * Every name a log line may contain. Standard ECMAScript error names plus the
 * `DOMException` names the Edge runtime's `fetch`/`AbortSignal` produce.
 *
 * Deliberately a closed list. Adding an entry is a review decision about
 * whether that name can carry content; nothing else can reach a log.
 */
export const BOUNDED_ERROR_NAMES = Object.freeze([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "DOMException",
  "AbortError",
  "TimeoutError",
  "NetworkError",
  "NotSupportedError",
  "InvalidStateError",
  // Not a standard error name: the value thrown was not an object.
  "non_error",
  // An object with a `name` this list does not admit.
  "unknown_error_name",
] as const);

export type BoundedErrorName = (typeof BOUNDED_ERROR_NAMES)[number];

/** Membership test that keeps the widening in one place. */
function isBoundedErrorName(value: string): value is BoundedErrorName {
  return (BOUNDED_ERROR_NAMES as readonly string[]).includes(value);
}

/**
 * The only representation of a caught throwable that may be logged.
 *
 * Reads `name` structurally rather than through `instanceof`, because a value
 * thrown across a realm boundary (or a `DOMException` subclass) is still worth
 * naming. The allowlist is what makes that safe: an unrecognised `name` — set
 * by a library or by an attacker — collapses to `unknown_error_name`.
 *
 * **Total, and non-throwing for every JavaScript value.** That is a property of
 * this function, not a hope about its callers: it runs inside `catch` blocks
 * whose whole purpose is to fail safely, so an exception escaping from *here*
 * would defeat the boundary — it would abandon the bounded log line and carry
 * its own message up instead. Reading `.name` is not a passive lookup: it is a
 * property access, and a property access runs code. An accessor or a `Proxy`
 * `get` trap may throw, and the value it throws is arbitrary. So the read is
 * guarded, and a read that cannot complete safely collapses to
 * `unknown_error_name` like any other unusable name.
 *
 * The guard is deliberately narrow: only the `name` read is wrapped, so a
 * well-behaved accessor (a real `DOMException` exposes `name` on its
 * prototype) still yields its allow-listed name.
 *
 * Never reads `message`, `stack`, `cause`, or any other property; never
 * stringifies or serializes the value; and never lets a thrown value's own text
 * reach the result — the caught exception is discarded unexamined.
 */
export function boundedErrorName(error: unknown): BoundedErrorName {
  if (typeof error !== "object" || error === null) return "non_error";

  let name: unknown;
  try {
    name = (error as { name?: unknown }).name;
  } catch {
    // A throwing getter or Proxy trap. Whatever it threw is not inspected.
    return "unknown_error_name";
  }

  if (typeof name !== "string") return "unknown_error_name";
  return isBoundedErrorName(name) ? name : "unknown_error_name";
}
