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
 * A third entry point, `extractDoiFromMetadataValue`, was added by
 * CHROME-EXTENSION-IMPORT-001E2-CORRECTION-01 for one specific untrusted input:
 * the `content` of a bibliographic `<meta>` element on a publisher page.
 *
 *   metadata value --(extractDoiFromMetadataValue)--> DOI name
 *
 * It is a *boundary*, not a fourth grammar — it composes `extractDoiFromDoiUrl`
 * and this module's own `DOI_NAME_PATTERN` — and it is the only function here
 * that trims its input, because it is the only one that receives a value which
 * has not already been authenticated as a DOI name. Its own comment says why.
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
 * serializes the prefix and suffix "without any normalization", so trimming,
 * collapsing or decoding any part of the input emits a link for a *different*
 * DOI. A space is ordinary DOI data — the Graphic type the syntax is drawn from
 * includes spaces — so `10.1000/example ` encodes to `…/example%20` rather than
 * losing its final code point.
 *
 * Nor does it lower-case. ASCII case *is* insensitive when two DOI names are
 * compared (§4.3.4, and `doiEquivalenceKey` below), but that rule is explicitly
 * scoped to comparison: *"It does not restrict DOI names to containing only
 * uppercase or lowercase letters."* The registered spelling is what a publisher
 * displays and what the proxy is handed, so folding it here would rewrite the
 * name to make a *comparison* convenient — which is what the equivalence key
 * exists to do without touching the name.
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

/**
 * The `doi:` scheme prefix, as it appears in a bibliographic presentation form.
 *
 * Matched case-insensitively and only at the *start* of the value, with any
 * whitespace that follows the colon consumed — `doi:10.1000/x`, `DOI: 10.1000/x`
 * and `Doi:\n10.1000/x` are the same reference written three ways. Anchored, so
 * a sentence that merely mentions a DOI (`See doi:10.1000/x for details`) is not
 * a DOI reference and gets no authority from containing one.
 */
const DOI_PRESENTATION_PREFIX = /^doi:\s*/i;

/**
 * Extract the DOI name from a bibliographic **metadata value** — the `content`
 * of a `citation_doi` / `dc.identifier` / `prism.doi` style `<meta>` element.
 *
 * ## Why this exists next to the other two, rather than as a third grammar
 *
 * `extractDoiFromDoiUrl` authenticates a *resolver URL*; `canonicalDoiUrl`
 * formats a *DOI name*. Neither describes the third thing the Chrome extension
 * has to read since CHROME-EXTENSION-IMPORT-001E2-CORRECTION-01: a value a
 * publisher wrote into a `<meta>` tag, which by convention is one of several
 * *presentation forms* of the same DOI name. This function is that boundary,
 * and it is deliberately built from the pieces already in this module —
 * `extractDoiFromDoiUrl` for the resolver form and `DOI_NAME_PATTERN` for the
 * bare form — so there is no fourth notion of what a DOI is anywhere in the
 * repository.
 *
 * ## It is narrower than the importer's classifier, on purpose
 *
 * `supabase/functions/_shared/identifierDetection.ts` classifies text a *person
 * pasted*, and its direct-DOI rule takes any value beginning `10.` at its word:
 * the person is asserting it is a DOI, and no URL it recognises can also look
 * like that. Publisher metadata carries no such assertion — it is untrusted
 * markup from a page the user merely happened to open — so a value is accepted
 * here only when it structurally *is* a DOI name (`DOI_NAME_PATTERN`), not when
 * it merely starts with `10.` or contains one. `doi:` with anything unparseable
 * after it is likewise refused rather than forwarded.
 *
 * That divergence is only ever in the narrowing direction, which is why it is
 * safe: every value this accepts, the classifier would also accept.
 *
 * ## Whitespace, and the one place trimming is correct
 *
 * `canonicalDoiUrl` and `extractDoiFromDoiUrl` never trim, because a space is
 * ordinary DOI data (Handbook §3.3) and trimming a name would silently emit a
 * link for a *different* DOI. Both of those functions receive a value that has
 * already been authenticated as a DOI name.
 *
 * This function is the input boundary itself, which is exactly where this
 * module's own rule says normalizing belongs — *"Normalizing an identifier
 * belongs at the input boundary, where the value is first taken in, not in the
 * encoder that formats it."* Surrounding whitespace in a `content` attribute is
 * markup indentation, not DOI data: publishers routinely wrap the value across
 * lines. So the outer whitespace is removed here, once, and nothing else about
 * the value is touched — no case folding, no percent-decoding, no unescaping,
 * and no alteration of the opaque suffix. Interior whitespace is preserved,
 * because that genuinely could be part of the name.
 *
 * Not case-folding here is a statement about *parsing*, not about equivalence.
 * `10.1000/AB` and `10.1000/ab` are the same DOI (§4.3.4), and a caller that
 * needs to know that asks `doiEquivalenceKey`; what this function returns is the
 * spelling the publisher actually wrote, which is what should be displayed and
 * handed on.
 *
 * ## What this never does
 *
 * It does not repair. A scheme-less `doi.org/10.1000/x` acquires no resolver
 * authority, a bare `10.1000` with no suffix is refused, and a URL on any other
 * host is refused however DOI-shaped its path looks. It performs no network
 * resolution: whether the DOI is registered is the resolver's answer to give,
 * not this function's.
 *
 * @param value One metadata `content` value, untrusted.
 * @returns The DOI name, or `null` when the value is not a DOI in any accepted
 *   presentation form.
 *
 * @example
 * extractDoiFromMetadataValue("10.1038/s41586-020-2649-2");
 * extractDoiFromMetadataValue("doi:10.1038/s41586-020-2649-2");
 * extractDoiFromMetadataValue("DOI: 10.1038/s41586-020-2649-2");
 * extractDoiFromMetadataValue("https://doi.org/10.1038/s41586-020-2649-2");
 * // all four → "10.1038/s41586-020-2649-2"
 */
export function extractDoiFromMetadataValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  // The resolver form first, and through the existing authenticator rather than
  // a host check written again here. It parses, so `https://doi.org.evil.example
  // /10.1000/x` and `https://evil.example/?u=https://doi.org/10.1000/x` are
  // refused for the same structural reasons they are refused everywhere else.
  const fromResolverUrl = extractDoiFromDoiUrl(trimmed);
  if (fromResolverUrl !== null) return fromResolverUrl;

  // Not a resolver URL. Whatever remains must be a DOI *name*, optionally
  // written with the `doi:` presentation prefix. A value carrying any other
  // scheme fails the pattern below rather than being unwrapped: `doi:https://…`
  // does not become a URL this function is willing to resolve.
  const bare = trimmed.replace(DOI_PRESENTATION_PREFIX, "").trim();

  return DOI_NAME_PATTERN.test(bare) ? bare : null;
}

/**
 * The ASCII letters DOI equivalence folds, as a code-point range pair.
 *
 * `A`–`Z` is U+0041..U+005A and `a`–`z` is U+0061..U+007A, exactly the two
 * ranges DOI Handbook §4.3.4 names. Written as code points rather than as a
 * call to `toLowerCase()` because those are not the same operation: `String
 * .prototype.toLowerCase` performs full Unicode case mapping, which folds
 * `Á`→`á`, `İ`→`i̇`, `Σ`→`σ` and much else the DOI rule explicitly leaves
 * alone — and one of those, in a suffix, would silently merge two DOI names the
 * Handbook says are different.
 */
const ASCII_UPPER_A = 0x41;
const ASCII_UPPER_Z = 0x5a;
const ASCII_CASE_OFFSET = 0x61 - 0x41;

/**
 * The equivalence key of a DOI name: two DOI names name the same DOI exactly
 * when their keys are `===`.
 *
 * ## The rule, and why it is not `toLowerCase()`
 *
 * DOI Handbook §4.3.4 "Case Insensitivity of the DOI Name":
 *
 * > *"When comparing two DOI names for equivalence, no normalization, as
 * > defined in ISO/IEC 10646, is performed and the DOI names are equivalent if,
 * > and only if, their code point sequences are identical, except that a code
 * > point in the range U+0041..U+005A (corresponding to LATIN CAPITAL LETTER A
 * > to LATIN CAPITAL LETTER Z) is considered identical to the corresponding
 * > code point in the range U+0061..U+007A (corresponding to characters LATIN
 * > SMALL LETTER A to LATIN SMALL LETTER Z)."*
 *
 * > *"The rule above has the effect of making DOI names case-insensitive only
 * > when testing for equivalence and only with respect to the Basic Latin
 * > Unicode block."*
 *
 * So the fold is **ASCII only**, and it is deliberately narrower than any
 * general-purpose lowercasing. The Handbook's own second example is the reason:
 *
 * ```text
 * 10.26321/Á.GUTIÉRREZ.ZARZA.02.2018.03
 * 10.26321/á.gutiérrez.zarza.02.2018.03      ← NOT the same DOI
 * ```
 *
 * `toLowerCase()` would collapse those two, because U+00C1 lowercases to
 * U+00E1. The Handbook says they are different DOI names, so this function
 * leaves every code point outside U+0041..U+005A exactly as it found it. That
 * also rules out `toLocaleLowerCase`, whose result depends on the host locale —
 * in Turkish, `I` becomes `ı`, which is not `i`, so the same DOI would compare
 * unequal to itself on a Turkish machine.
 *
 * Crossref documents the same rule for the suffixes it issues: *"Suffixes are
 * case insensitive, so `10.1006/abc` is the same in the system as
 * `10.1006/ABC`."*
 *
 * ## It is a key, not a name
 *
 * The value returned here is for **comparison only**. It is not a DOI name, is
 * not what should be displayed, is not what should be handed to
 * `/extension-import`, and is not what should be stored: the Handbook's rule is
 * scoped to equivalence testing and explicitly does not restrict what a DOI name
 * may contain. Callers that group by this key must keep one of the original
 * spellings as the representative, and `resolveDoiFromMetadata` in the extension
 * does exactly that.
 *
 * Nothing else is normalized — no trimming, no percent-decoding, no whitespace
 * collapsing — because the Handbook's rule has exactly one exception in it and
 * this function implements exactly that one.
 *
 * @param doiName A DOI name, unencoded.
 * @returns The comparison key, or `null` when the value is not a string.
 *
 * @example
 * doiEquivalenceKey("10.1000/AB") === doiEquivalenceKey("10.1000/ab"); // true
 * doiEquivalenceKey("10.26321/Á") === doiEquivalenceKey("10.26321/á"); // false
 *
 * @see DOI Handbook (2025), §4.3.4 "Case Insensitivity of the DOI Name".
 * @see Crossref, "Constructing your DOIs" — suffix case insensitivity.
 */
export function doiEquivalenceKey(doiName: string | null | undefined): string | null {
  if (typeof doiName !== "string") return null;

  let key = "";
  // Iterated by code point rather than by UTF-16 code unit. Every code point the
  // rule touches is in the BMP, so a surrogate pair can never be altered — but
  // iterating units and rebuilding would still be a needless chance to split
  // one, and `for…of` over a string yields code points.
  for (const character of doiName) {
    const code = character.codePointAt(0) as number;
    key +=
      code >= ASCII_UPPER_A && code <= ASCII_UPPER_Z
        ? String.fromCodePoint(code + ASCII_CASE_OFFSET)
        : character;
  }

  return key;
}

/**
 * Whether two DOI names name the same DOI, per Handbook §4.3.4.
 *
 * The predicate form of `doiEquivalenceKey`, for callers comparing a pair rather
 * than grouping a list. A non-string on either side is not a DOI name and is
 * equivalent to nothing, including to another non-string.
 */
export function doiNamesAreEquivalent(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const keyA = doiEquivalenceKey(a);
  const keyB = doiEquivalenceKey(b);

  return keyA !== null && keyB !== null && keyA === keyB;
}
