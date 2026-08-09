/**
 * Construction of canonical DOI resolver URLs from DOI names.
 *
 * This is the *output* half of DOI handling, and it is deliberately separate
 * from the *input* half. Recognition — deciding whether untrusted text is a DOI
 * resolver URL and, if so, which DOI name it refers to — belongs to the
 * identifier classifier. This module does the reverse, and only the reverse:
 *
 *   resolver URL  --(structural classifier)-->  DOI name
 *   DOI name      --(this module)------------>  canonical resolver URL
 *
 * Keeping the directions apart is what lets each side be strict. The classifier
 * may refuse anything it cannot authenticate; this module may assume it was
 * handed a DOI *name* and never has to guess whether its input is already a URL
 * or already encoded.
 *
 * ## Why string interpolation is wrong
 *
 * A DOI suffix is an opaque string. The DOI Handbook makes no promise that it
 * avoids characters that mean something else inside a URL, and real suffixes do
 * contain them. `https://doi.org/${doi}` therefore silently produces a URL that
 * names a *different* DOI, or no DOI at all: for the DOI name
 * `10.1000/456#789`, a browser parses everything from `#` onward as a fragment
 * and asks the proxy to resolve `10.1000/456`. The same applies to `?`, to a
 * space, and to a `/` inside the suffix.
 *
 * ## The encoding rule
 *
 * The algorithm is the DOI Handbook's, not a general-purpose URL escape.
 * `encodeURIComponent` is wrong in both directions here: it escapes the `/`
 * that separates prefix from suffix, which must stay a literal path separator,
 * and it escapes characters (`$ & + ; = : @`) that the DOI algorithm keeps
 * unescaped. The Handbook's algorithm is implemented in
 * `percentEncodeDoiComponent` below, per byte of the UTF-8 serialization.
 *
 * ## What this module never does
 *
 * It never inspects its input to decide whether it "looks already encoded".
 * A `%` in a DOI name is data — `10.1000/foo%23bar` is a DOI name whose suffix
 * contains a literal percent sign — so `%` is encoded like any other reserved
 * byte, and the canonical URL for that name contains `%2523`. That is correct,
 * not double encoding: the alternative, treating `%23` as pre-encoded, would
 * make the function's output depend on a guess about its caller's intent and
 * would collapse two distinct DOI names onto one URL.
 *
 * It also performs no network resolution and does not check that the DOI is
 * registered. Whether a DOI exists is the resolver's answer to give.
 *
 * @see DOI Handbook (2025), 4.7 "Percent-encoding" — the encoding algorithm,
 *   including the byte set that stays unescaped and the rule that prefix and
 *   suffix are encoded separately and rejoined with `/`.
 * @see DOI Handbook (2025), 4.4.4 "HTTP proxy form" — a DOI name is expressed
 *   as a URL by concatenating `https://doi.org/` with the percent-encoded DOI
 *   name; proxy forms starting `https://dx.doi.org` are deprecated.
 * @see DOI Handbook (2025), 3.2 "DOI name syntax" — a DOI name is a prefix and
 *   a suffix separated by `/`; the prefix is dot-separated segments, so the
 *   separator is the *first* `/` and any later one belongs to the suffix.
 * @see Crossref DOI display guidelines — display as a full URL in the form
 *   `https://doi.org/10.xxxx/xxxxx`, without a `doi:` prefix and without `dx`.
 */

/**
 * The canonical DOI proxy, as an origin with trailing separator.
 *
 * `https://doi.org/` is the form the DOI Foundation specifies for the HTTP
 * proxy form and the one Crossref's display guidelines require. `dx.doi.org`
 * still resolves and is still *accepted* as input by the identifier
 * classifier, but the Handbook marks it deprecated, so nothing here emits it.
 */
const DOI_RESOLVER_PREFIX = "https://doi.org/";

/**
 * The bytes the DOI percent-encoding algorithm leaves unescaped, besides ALPHA
 * and DIGIT.
 *
 * This is RFC 3986's `unreserved` set plus `sub-delims` plus `:` and `@` —
 * that is, `pchar` minus `%` (which must be escaped for percent-encoding to be
 * unambiguous) and minus `,`. The comma is excluded by the Handbook so that an
 * encoded DOI name can be passed through the "Which RA?" service, whose request
 * syntax gives the comma a separator meaning.
 *
 * Taken verbatim from the Handbook rather than derived, because the difference
 * between this set and `encodeURIComponent`'s is exactly the kind of detail
 * that is wrong when it is reasoned out from memory.
 */
const DOI_UNESCAPED_PUNCTUATION = "-._~!$&'()*+;=:@";

/** Byte-value lookup for the unescaped set. Built once. */
const DOI_UNESCAPED_BYTES: ReadonlySet<number> = new Set(
  [
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "abcdefghijklmnopqrstuvwxyz",
    "0123456789",
    DOI_UNESCAPED_PUNCTUATION,
  ]
    .join("")
    .split("")
    .map((character) => character.charCodeAt(0)),
);

/**
 * Percent-encode one DOI component — a prefix or a suffix — per DOI Handbook
 * 4.7.
 *
 * The component is serialized to UTF-8 first and the rule is then applied to
 * each *byte*, which is what makes non-ASCII correct: a code point outside
 * Basic Latin becomes the percent-encoding of each of its two-to-four UTF-8
 * bytes (`é` → `%C3%A9`), never a single escape of the code point.
 *
 * Every byte outside the unescaped set is encoded, `%` included. Nothing about
 * the input is interpreted — this function has no notion of an escape sequence
 * in its input, only bytes.
 */
function percentEncodeDoiComponent(component: string): string {
  const bytes = new TextEncoder().encode(component);

  let encoded = "";
  for (const byte of bytes) {
    encoded += DOI_UNESCAPED_BYTES.has(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }

  return encoded;
}

/**
 * Build the canonical DOI resolver URL for a DOI name.
 *
 * The input is a DOI **name** (`10.1000/456#789`), never a resolver URL. A URL
 * is rejected rather than unwrapped: recognizing resolver URLs is the
 * classifier's job, and accepting them here would mean guessing whether the
 * value that arrived was already encoded — the guess this module exists to
 * avoid. Rejection matters because the failure is otherwise silent: the first
 * `/` in `https://doi.org/10.1000/example` falls inside `https://`, so
 * interpolation-by-another-name would emit a plausible-looking
 * `https://doi.org/https:/%2Fdoi.org%2F10.1000%2Fexample`.
 *
 * Validation is deliberately minimal — the weakest rule that rejects a value no
 * resolver URL could usefully be built from, matching the existing classifier's
 * stance that this layer is not a DOI grammar validator:
 *
 *   • not a string, or empty/whitespace-only;
 *   • no `/`, so there is no prefix/suffix separator to preserve;
 *   • an empty prefix or an empty suffix;
 *   • a `:` in the prefix. Handbook 3.2 makes the prefix dot-separated
 *     segments, so a colon there never occurs in a DOI name and always means
 *     the value is a *presentation form* carrying a scheme — `https://…`,
 *     `doi:…`, `urn:doi:…`. The suffix keeps its `:` and stays fully opaque;
 *     this is one check against the wrong direction, not a grammar.
 *
 * The `10.` directory indicator is deliberately *not* required. The classifier
 * accepts `doi:` forms without re-checking their shape, so a DOI name that
 * reached this point may legitimately not begin with `10.`, and rejecting it
 * here would drop a link the previous code would have produced.
 *
 * Surrounding whitespace is trimmed. Unlike input authentication — where
 * repairing a value would invent authority — this is formatting a value whose
 * authority is already established, and encoding the spaces instead would emit
 * a link with `%20` at its edges that no resolver can answer.
 *
 * @param doiName A DOI name, unencoded.
 * @returns The canonical `https://doi.org/…` URL, or `null` when `doiName` is
 *   not usable as a DOI name.
 *
 * @example
 * canonicalDoiUrl("10.1000/456#789"); // "https://doi.org/10.1000/456%23789"
 * canonicalDoiUrl("10.1000/foo/bar");  // "https://doi.org/10.1000/foo%2Fbar"
 */
export function canonicalDoiUrl(doiName: string | null | undefined): string | null {
  if (typeof doiName !== "string") return null;

  const trimmed = doiName.trim();
  if (!trimmed) return null;

  // DOI Handbook 3.2: prefix and suffix are separated by `/`, and the prefix is
  // dot-separated segments — so the separator is the *first* `/`. Any later one
  // is part of the opaque suffix and is therefore data, encoded below rather
  // than emitted as another path separator.
  const separatorIndex = trimmed.indexOf("/");
  if (separatorIndex <= 0) return null;

  const prefix = trimmed.slice(0, separatorIndex);
  const suffix = trimmed.slice(separatorIndex + 1);
  if (!suffix) return null;

  // A scheme-carrying presentation form, not a DOI name. See the note above.
  if (prefix.includes(":")) return null;

  return `${DOI_RESOLVER_PREFIX}${percentEncodeDoiComponent(prefix)}/${percentEncodeDoiComponent(suffix)}`;
}
