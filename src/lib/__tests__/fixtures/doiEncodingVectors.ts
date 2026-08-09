/**
 * The canonical DOI resolver URL corpus, shared by both runtimes.
 *
 * `canonicalDoiUrl` exists twice — once in `src/lib/doiIdentifiers.ts` for the
 * application, once in `supabase/functions/_shared/identifierDetection.ts` for
 * the Edge runtime — because the browser bundle and the Deno Edge bundle are
 * separate module domains: `tsconfig.app.json` compiles only `src`, and the
 * Edge deploy bundle contains only `supabase/functions`, with no `@/` alias.
 * Neither can import the other's runtime code without breaking a boundary that
 * PR #193 established for exactly this reason.
 *
 * Duplicated logic drifts unless something forces it not to. That is this
 * file's whole job: both implementations are asserted against *these* vectors,
 * and a parity test feeds every vector through both and requires identical
 * output. A change to one implementation that the other does not receive fails
 * the parity test rather than shipping a link that differs by runtime.
 *
 * Expected values are written out literally, never computed, so the corpus
 * states the DOI Handbook's algorithm rather than re-deriving whichever
 * implementation is being tested.
 *
 * @see DOI Handbook (2025) §3.7 "Percent-Encoding", §3.4.4 "HTTP Proxy Form",
 *   §3.3 "Syntax of the DOI Name", §3.6 "UTF-8 Serialization".
 */

/** DOI name → canonical resolver URL. `[label, doiName, expectedUrl]`. */
export const DOI_CANONICAL_URL_VECTORS: ReadonlyArray<
  readonly [label: string, doiName: string, expected: string]
> = [
  // Ordinary DOIs must be untouched by the encoding — the overwhelmingly
  // common case, and the regression risk of introducing an encoder at all.
  ["ordinary DOI", "10.1000/example", "https://doi.org/10.1000/example"],
  ["real-world DOI, case preserved", "10.1056/NEJMoa2107934", "https://doi.org/10.1056/NEJMoa2107934"],
  ["sub-divided registrant code", "10.1000.10/example", "https://doi.org/10.1000.10/example"],
  ["numeric suffix", "10.1000/182", "https://doi.org/10.1000/182"],

  // Characters that silently truncate or redirect an interpolated URL.
  ["hash", "10.1000/456#789", "https://doi.org/10.1000/456%23789"],
  ["question mark", "10.1000/456?789", "https://doi.org/10.1000/456%3F789"],
  ["double quote", '10.1000/a"b', "https://doi.org/10.1000/a%22b"],
  ["space", "10.1000/a b", "https://doi.org/10.1000/a%20b"],
  ["comma", "10.1000/a,b", "https://doi.org/10.1000/a%2Cb"],
  ["angle brackets", "10.1000/<x>", "https://doi.org/10.1000/%3Cx%3E"],
  ["ampersand stays unescaped", "10.1000/a&b", "https://doi.org/10.1000/a&b"],

  // A literal `%` is DOI data. It is encoded like any other reserved byte, so
  // a name that *looks* pre-encoded canonicalizes to `%25xx`.
  ["literal percent", "10.1000/100%", "https://doi.org/10.1000/100%25"],
  ["percent-escape-looking sequence", "10.1000/foo%23bar", "https://doi.org/10.1000/foo%2523bar"],

  // Only the first `/` is the prefix/suffix separator; the rest is suffix data.
  ["one internal suffix slash", "10.1000/foo/bar", "https://doi.org/10.1000/foo%2Fbar"],
  ["several internal suffix slashes", "10.1000/a/b/c", "https://doi.org/10.1000/a%2Fb%2Fc"],
  ["trailing slash is a different name", "10.1000/example/", "https://doi.org/10.1000/example%2F"],

  // Whitespace is DOI data, not noise to be tidied away. Handbook 3.3 draws DOI
  // names from the Unicode Graphic type, which includes spaces, and 3.7 step 1
  // serializes each component "without any normalization" — so a space encodes
  // to %20 and the name keeps every code point it arrived with. Trimming would
  // emit the canonical URL of a *different* DOI, silently.
  ["trailing space in the suffix", "10.1000/example ", "https://doi.org/10.1000/example%20"],
  ["leading space in the suffix", "10.1000/ example", "https://doi.org/10.1000/%20example"],
  ["whitespace-only suffix is not an empty suffix", "10.1000/  ", "https://doi.org/10.1000/%20%20"],
  ["space either side of the whole name", "  10.1000/example  ", "https://doi.org/%20%2010.1000/example%20%20"],

  // Everything DOI Handbook 3.7 step 2a keeps unmodified, in one suffix.
  ["allowed punctuation set", "10.1000/-._~!$&'()*+;=:@", "https://doi.org/10.1000/-._~!$&'()*+;=:@"],

  // Non-ASCII is encoded per UTF-8 byte, not per code point.
  ["Latin-1 supplement", "10.1000/café", "https://doi.org/10.1000/caf%C3%A9"],
  ["CJK", "10.1000/日本語", "https://doi.org/10.1000/%E6%97%A5%E6%9C%AC%E8%AA%9E"],
  ["astral plane (surrogate pair)", "10.1000/\u{1D400}", "https://doi.org/10.1000/%F0%9D%90%80"],
  // Prefix `10.26321`, suffix `á/y`: a Unicode code point and a suffix-internal
  // slash in one vector. The prefix stays ASCII because Handbook 3.3.1 defines
  // it as a numeric directory indicator and registrant code.
  ["Unicode suffix with internal slash", "10.26321/á/y", "https://doi.org/10.26321/%C3%A1%2Fy"],

  // A `doi:` input yields a name the classifier does not reshape, so a name
  // without the `10.` indicator can legitimately reach the builder.
  ["no 10. indicator", "abc/def", "https://doi.org/abc/def"],
];

/** Values no resolver URL can be built from. `[label, value]`. */
export const DOI_UNUSABLE_NAMES: ReadonlyArray<readonly [label: string, value: string | null | undefined]> = [
  ["empty string", ""],
  ["null", null],
  ["undefined", undefined],
  ["no prefix/suffix separator", "10.1000"],
  ["empty suffix", "10.1000/"],
  ["empty prefix", "/example"],
  ["separator only", "/"],

  // Whitespace-only values are unusable for a structural reason, not because
  // they are whitespace: there is no `/` to separate a prefix from a suffix.
  // `"10.1000/  "` above, which *does* have one, is a usable DOI name.
  ["whitespace only", "   "],
  ["whitespace with no separator", " 10.1000 "],

  // Wrong direction: presentation forms, which the classifier turns into names.
  // Without the colon check these produce plausible-looking nonsense, because
  // the first `/` of `https://…` falls inside the scheme separator.
  ["canonical resolver URL", "https://doi.org/10.1000/example"],
  ["legacy resolver URL", "http://dx.doi.org/10.1000/example"],
  ["doi: presentation form", "doi:10.1000/example"],
  ["URN form", "urn:doi:10.1000/example"],
];
