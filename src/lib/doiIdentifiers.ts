/**
 * Structural recognition of DOI resolver URLs, and construction of canonical
 * DOI resolver URLs from DOI names.
 *
 * DOI handling has two directions and this module holds both, the way
 * `src/lib/pubmedIdentifiers.ts` holds both directions for PubMed. They remain
 * separate *functions*, because keeping them apart is what lets each side be
 * strict:
 *
 *   resolver URL  --(extractDoiFromDoiUrl)-->  DOI name
 *   DOI name      --(canonicalDoiUrl)------->  canonical resolver URL
 *
 * `extractDoiFromDoiUrl` refuses anything it cannot structurally authenticate;
 * `canonicalDoiUrl` may then assume it was handed a DOI *name* and never has to
 * guess whether its input is already a URL or already encoded. Neither calls
 * the other, and `canonicalDoiUrl` still rejects a URL outright rather than
 * unwrapping one.
 *
 * The recognition half is a second implementation of the classification that
 * `supabase/functions/_shared/identifierDetection.ts` already performs inside
 * the Edge Function's separate bundling domain — the same arrangement PubMed
 * recognition has had since that module was written, and for the same reason:
 * the deployed function and the bundled application are deployed by different
 * commands, on different cadences. `__tests__/doiIdentifiers.parity.test.ts`
 * pins the two to identical answers over a shared corpus, so a change to either
 * that the other does not match fails the suite instead of drifting silently.
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
 * It also never alters the DOI name it was given. The Handbook's algorithm
 * serializes the prefix and suffix "without any normalization", and DOI names
 * are equivalent only when their code point sequences are identical, so
 * trimming, collapsing, lower-casing or decoding any part of the input would
 * emit a link for a *different* DOI. A space is ordinary DOI data — the Graphic
 * type the syntax is drawn from includes spaces — so `10.1000/example ` encodes
 * to `…/example%20` rather than losing its final code point.
 *
 * It also performs no network resolution and does not check that the DOI is
 * registered. Whether a DOI exists is the resolver's answer to give.
 *
 * @see DOI Handbook (2025), §3.7 "Percent-Encoding" — the encoding algorithm,
 *   including the byte set that stays unescaped, the "without any
 *   normalization" requirement, and the rule that prefix and suffix are encoded
 *   separately and rejoined with `/`.
 * @see DOI Handbook (2025), §3.4.4 "HTTP Proxy Form" — a DOI name is expressed
 *   as a URL by concatenating `https://doi.org/` with the percent-encoded DOI
 *   name; proxy forms starting `https://dx.doi.org` are deprecated.
 * @see DOI Handbook (2025), §3.3 "Syntax of the DOI Name" — a DOI name is an
 *   ordered sequence of code points of the Graphic type (letters, marks,
 *   numbers, punctuation, symbols *and spaces*), arranged as a prefix and a
 *   suffix separated by U+002F SOLIDUS. The prefix is a numeric directory
 *   indicator optionally followed by a dot-separated registrant code, so the
 *   separator is the *first* `/` and any later one belongs to the suffix.
 * @see DOI Handbook (2025), §3.6 "UTF-8 Serialization" — one escape per UTF-8
 *   byte, never one per code point.
 * @see DOI Handbook (2025), §5.3.1 "DOI Proxy" — `https://doi.org` is the proxy
 *   an HTTP GET resolves the name against.
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
 * encoded DOI name can be passed through the "Which RA?" service (§5.6), whose
 * request syntax gives the comma a separator meaning.
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
 * §3.7.
 *
 * The component is serialized to UTF-8 first, with no byte order mark and no
 * normalization, and the rule is then applied to each *byte*, which is what
 * makes non-ASCII correct: a code point outside Basic Latin becomes the
 * percent-encoding of each of its two-to-four UTF-8 bytes (`é` → `%C3%A9`),
 * never a single escape of the code point.
 *
 * Every byte outside the unescaped set is encoded, `%` and the space included.
 * Nothing about the input is interpreted — this function has no notion of an
 * escape sequence in its input, only bytes.
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
 *   • not a string, or an empty string;
 *   • no `/`, so there is no prefix/suffix separator to preserve;
 *   • a literally empty prefix or a literally empty suffix;
 *   • a `:` in the prefix. Handbook §3.3.1 makes the prefix a numeric directory
 *     indicator and a dot-separated registrant code, so a colon there never
 *     occurs in a DOI name and always means the value is a *presentation form*
 *     carrying a scheme — `https://…`, `doi:…`, `urn:doi:…`. The suffix keeps
 *     its `:` and stays fully opaque; this is one check against the wrong
 *     direction, not a grammar.
 *
 * The `10.` directory indicator is deliberately *not* required. The classifier
 * accepts `doi:` forms without re-checking their shape, so a DOI name that
 * reached this point may legitimately not begin with `10.`, and rejecting it
 * here would drop a link the previous code would have produced.
 *
 * ## Whitespace is DOI data, and is preserved
 *
 * The name is **not** trimmed. Handbook §3.3 draws DOI names from the Unicode
 * Graphic type, which explicitly includes spaces, and §3.7 step 1 serializes
 * the components "without any normalization" — so a leading or trailing space
 * belongs to the name and encodes to `%20` like any other reserved byte.
 * Trimming would quietly emit the canonical URL of a *different* DOI, which is
 * exactly the class of bug this module exists to remove; a link that resolves
 * to the wrong record is worse than one that 404s. A suffix of nothing but
 * spaces is likewise not an empty suffix, so only a literally empty one is
 * rejected. Normalizing an identifier belongs at the input boundary, where the
 * value is first taken in, not in the encoder that formats it.
 *
 * An all-whitespace string still yields `null`, without a special case: it has
 * no `/`, so there is no separator to build a URL around.
 *
 * @param doiName A DOI name, unencoded.
 * @returns The canonical `https://doi.org/…` URL, or `null` when `doiName` is
 *   not usable as a DOI name.
 *
 * @example
 * canonicalDoiUrl("10.1000/456#789"); // "https://doi.org/10.1000/456%23789"
 * canonicalDoiUrl("10.1000/foo/bar");  // "https://doi.org/10.1000/foo%2Fbar"
 * canonicalDoiUrl("10.1000/example "); // "https://doi.org/10.1000/example%20"
 */
export function canonicalDoiUrl(doiName: string | null | undefined): string | null {
  if (typeof doiName !== "string") return null;
  if (!doiName) return null;

  // DOI Handbook §3.3: prefix and suffix are separated by U+002F SOLIDUS, and
  // the prefix is a directory indicator plus a dot-separated registrant code —
  // so the separator is the *first* `/`. Any later one is part of the opaque
  // suffix and is therefore data, encoded below rather than emitted as another
  // path separator.
  const separatorIndex = doiName.indexOf("/");
  if (separatorIndex <= 0) return null;

  const prefix = doiName.slice(0, separatorIndex);
  const suffix = doiName.slice(separatorIndex + 1);
  if (!suffix) return null;

  // A scheme-carrying presentation form, not a DOI name. See the note above.
  if (prefix.includes(":")) return null;

  return `${DOI_RESOLVER_PREFIX}${percentEncodeDoiComponent(prefix)}/${percentEncodeDoiComponent(suffix)}`;
}

/**
 * The DOI proxy hosts, compared exactly against the parsed hostname.
 *
 * `doi.org` is the form the DOI Foundation and Crossref both document as
 * canonical. `dx.doi.org` is the earlier, no-longer-preferred proxy hostname;
 * both organisations state it keeps resolving and it still appears in older
 * published references, so a URL on one is a DOI reference exactly as much as a
 * URL on the other. Nothing here *emits* `dx.doi.org` — see
 * `DOI_RESOLVER_PREFIX` above — but recognition has to accept what exists.
 */
const DOI_RESOLVER_HOSTS: ReadonlySet<string> = new Set(["doi.org", "dx.doi.org"]);

/** The only schemes an absolute resolver URL may use. Compared exactly. */
const DOI_RESOLVER_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * The shape a resolver path must have to be a DOI *name* rather than some other
 * page on the proxy host: the `10.` directory indicator, a registrant code, the
 * `/` that separates prefix from suffix, and a non-empty suffix.
 *
 * Deliberately the weakest check that distinguishes a DOI from
 * `https://doi.org/`, `https://doi.org/about` and `https://doi.org/10.1000` —
 * not a DOI grammar validator. The suffix is `.+` because a DOI suffix is
 * opaque and may itself contain `/`; `[^/]+` for the registrant code stops the
 * prefix from swallowing the separator. The `s` flag lets a suffix that
 * contains a newline still match, because a decoded `%0A` is suffix data.
 */
const DOI_NAME_PATTERN = /^10\.[^/]+\/.+$/s;

/**
 * Parse a value into an absolute http(s) `URL`, or `null`.
 *
 * No base URL is supplied, so relative and scheme-relative values
 * (`//doi.org/10.1000/example`) fail rather than resolving against the
 * application origin. Input is never repaired — no scheme is prepended or
 * guessed, because doing so would invent the very authority this function
 * exists to verify.
 */
function parseResolverUrl(value: string | null | undefined): URL | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  // `protocol` is lowercased by the parser, so this exact-match check also
  // covers `HTTPS:` and `JaVaScRiPt:`.
  return DOI_RESOLVER_PROTOCOLS.has(parsed.protocol) ? parsed : null;
}

/**
 * Extract the DOI name a resolver URL refers to.
 *
 * Untrusted text cannot be recognised by substring: `"doi.org"` occurs in
 * `https://notdoi.org/10.1000/example`, in
 * `https://doi.org.evil.example/10.1000/example`, in
 * `https://evil.example/?url=https://doi.org/10.1000/example`, and in
 * `https://doi.org@evil.example/10.1000/example` — none of which is a DOI
 * reference. A substring test grants that text an authority it has not earned,
 * and the value that results is persisted: `doi` participates in the per-user
 * deduplication domain.
 *
 * Recognition is therefore structural, and a decision is made only from the
 * parsed `protocol`, `hostname` and `pathname`:
 *
 *   • `hostname` is compared for exact equality against an explicit host set.
 *     The parser lowercases it, so `DOI.ORG` matches without a manual case
 *     fold, while `notdoi.org` and `doi.org.evil.example` do not.
 *   • `hostname` excludes user-info, so `https://doi.org@evil.example/…`
 *     resolves to `evil.example` and is rejected.
 *   • The DOI is read from `pathname` only, so neither a query nor a fragment
 *     can supply or replace it.
 *
 * The DOI is taken as the *whole* path rather than its first segment: a DOI
 * suffix is opaque and may contain further `/` characters, which
 * `https://doi.org/10.1000/a/b` genuinely names. Nothing else is trimmed off
 * either — the proxy treats the path verbatim as the DOI name (a trailing slash
 * makes `10.1000/182/`, a different name, which is why the resolver answers 404
 * for it), so silently repairing one here would name a DOI the user was not
 * looking at.
 *
 * The path is percent-decoded exactly once. `pathname` is still URL-encoded
 * while a DOI name is not, and every consumer encodes it again on the way out
 * (`canonicalDoiUrl` for display, `encodeURIComponent` for Crossref, the
 * `[doi]` term for PubMed E-utilities), so returning the encoded path would
 * double-escape every reserved character a suffix contains. A malformed escape
 * is not a DOI and fails closed rather than being passed on half-decoded.
 *
 * @returns The DOI name, or `null` when the value is not a DOI resolver URL.
 */
export function extractDoiFromDoiUrl(value: string | null | undefined): string | null {
  const url = parseResolverUrl(value);
  if (!url) return null;

  if (!DOI_RESOLVER_HOSTS.has(url.hostname)) return null;

  // `pathname` always begins with `/` on a hierarchical URL; everything after
  // that first separator is the DOI name the proxy was asked to resolve.
  const encodedDoi = url.pathname.slice(1);
  if (!encodedDoi) return null;

  let doi: string;
  try {
    doi = decodeURIComponent(encodedDoi);
  } catch {
    return null;
  }

  return DOI_NAME_PATTERN.test(doi) ? doi : null;
}

/** Whether a value is a DOI resolver URL naming a specific DOI. */
export function isDoiResolverUrl(value: string | null | undefined): boolean {
  return extractDoiFromDoiUrl(value) !== null;
}
