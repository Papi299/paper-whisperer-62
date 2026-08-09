// Canonical DOI resolver URL construction.
//
// These are pure encoding tests: nothing here contacts doi.org, Crossref, or
// any resolver, because the property under test is what the *URL* says, not
// whether a DOI is registered. A test that asked the proxy would prove the
// registration status of a made-up DOI and nothing about the encoding.
//
// The expected values are derived from the DOI Handbook's algorithm rather than
// from what `encodeURIComponent` happens to do. The two disagree in both
// directions — the Handbook keeps `$ & + ; = : @` unescaped and escapes `,`,
// and it never escapes the prefix/suffix separator — so every vector below is
// written out literally instead of being computed, which would just re-assert
// the implementation against itself.
//
// @see DOI Handbook (2025) §3.7 "Percent-Encoding", §3.4.4 "HTTP Proxy Form",
//   §3.3 "Syntax of the DOI Name", §3.6 "UTF-8 Serialization"; Crossref DOI
//   display guidelines.

import { describe, it, expect } from "vitest";
import { canonicalDoiUrl } from "@/lib/doiIdentifiers";
import {
  DOI_CANONICAL_URL_VECTORS,
  DOI_UNUSABLE_NAMES,
} from "@/lib/__tests__/fixtures/doiEncodingVectors";

describe("canonicalDoiUrl builds the canonical resolver URL", () => {
  it.each(DOI_CANONICAL_URL_VECTORS)("%s", (_label, doiName, expected) => {
    expect(canonicalDoiUrl(doiName)).toBe(expected);
  });
});

describe("the resolver authority is the canonical one", () => {
  it("always emits https://doi.org/, never the deprecated dx host", () => {
    for (const [, doiName] of DOI_CANONICAL_URL_VECTORS) {
      expect(canonicalDoiUrl(doiName)).toMatch(/^https:\/\/doi\.org\//);
    }
  });

  it("never emits http:// or dx.doi.org", () => {
    for (const [, doiName] of DOI_CANONICAL_URL_VECTORS) {
      const url = canonicalDoiUrl(doiName)!;
      expect(url.startsWith("http://")).toBe(false);
      expect(url).not.toContain("dx.doi.org");
    }
  });
});

describe("the prefix/suffix separator is the only literal slash", () => {
  it("keeps exactly one `/` after the resolver origin", () => {
    // `10.1000/a/b/c` has three slashes in the name; only the first separates
    // prefix from suffix, so the emitted path must contain exactly one.
    const url = canonicalDoiUrl("10.1000/a/b/c")!;
    const path = url.slice("https://doi.org/".length);
    expect(path.split("/")).toHaveLength(2);
    expect(url).toBe("https://doi.org/10.1000/a%2Fb%2Fc");
  });

  it("does not escape the separator the way encodeURIComponent would", () => {
    expect(canonicalDoiUrl("10.1000/example")).not.toContain("10.1000%2Fexample");
  });
});

describe("a literal percent sign in a DOI name is data, not an escape", () => {
  // The trap this module exists to avoid: a DOI name may contain `%`, so a
  // sequence that *looks* pre-encoded is not. Guessing would make the output
  // depend on the caller's intent and collapse two distinct names onto one URL.
  it("encodes the percent itself, producing %25xx", () => {
    expect(canonicalDoiUrl("10.1000/foo%23bar")).toBe("https://doi.org/10.1000/foo%2523bar");
  });

  it("gives two distinct DOI names two distinct URLs", () => {
    // `foo#bar` and `foo%23bar` are different DOI names. If `%23` were treated
    // as pre-encoded, both would canonicalize to the same URL and one of the
    // two papers would resolve to the other's record.
    const withHash = canonicalDoiUrl("10.1000/foo#bar");
    const withLiteralPercent = canonicalDoiUrl("10.1000/foo%23bar");

    expect(withHash).toBe("https://doi.org/10.1000/foo%23bar");
    expect(withLiteralPercent).toBe("https://doi.org/10.1000/foo%2523bar");
    expect(withHash).not.toBe(withLiteralPercent);
  });

  it("encodes a bare trailing percent rather than emitting a broken escape", () => {
    expect(canonicalDoiUrl("10.1000/100%")).toBe("https://doi.org/10.1000/100%25");
  });
});

describe("the unescaped byte set is the DOI Handbook's, not encodeURIComponent's", () => {
  // DOI Handbook 3.7 step 2a: ALPHA, DIGIT, "-", ".", "_", "~", "!", "$", "&",
  // "'", "(", ")", "*", "+", ";", "=", ":", "@" are output unmodified.
  const HANDBOOK_UNESCAPED = "-._~!$&'()*+;=:@";

  it.each(HANDBOOK_UNESCAPED.split(""))("leaves %s unescaped", (character) => {
    expect(canonicalDoiUrl(`10.1000/a${character}b`)).toBe(`https://doi.org/10.1000/a${character}b`);
  });

  it("leaves the whole allowed punctuation set unescaped in one suffix", () => {
    expect(canonicalDoiUrl(`10.1000/${HANDBOOK_UNESCAPED}`)).toBe(
      `https://doi.org/10.1000/${HANDBOOK_UNESCAPED}`,
    );
  });

  it("keeps characters encodeURIComponent would escape", () => {
    // These are the concrete divergences: `encodeURIComponent` escapes all of
    // them, the DOI algorithm does not. Asserting the divergence explicitly is
    // what stops a future "simplification" to encodeURIComponent.
    for (const character of "$&+;=:@") {
      expect(encodeURIComponent(character)).not.toBe(character);
      expect(canonicalDoiUrl(`10.1000/${character}`)).toBe(`https://doi.org/10.1000/${character}`);
    }
  });

  it("escapes the comma, which encodeURIComponent also escapes but ~ does not need", () => {
    // The Handbook singles out `,`: it is escaped so an encoded DOI name can be
    // used in a "Which RA?" service request, where the comma is a separator.
    expect(canonicalDoiUrl("10.1000/a,b")).toBe("https://doi.org/10.1000/a%2Cb");
  });

  it("uses uppercase hex digits", () => {
    // Only visible on bytes whose hex has a letter digit: `<` is 0x3C, `é` is
    // <C3 A9>. RFC 3986 3.2.1 prefers uppercase, and so does the rest of the
    // web platform, so a lowercase escape would be gratuitously inconsistent.
    expect(canonicalDoiUrl("10.1000/<é>")).toBe("https://doi.org/10.1000/%3C%C3%A9%3E");
    expect(canonicalDoiUrl("10.1000/<é>")).not.toMatch(/%[0-9a-f]*[a-f]/);
  });
});

describe("non-ASCII is encoded as UTF-8 bytes", () => {
  it("encodes a Latin-1 supplement code point as two bytes", () => {
    // é is U+00E9 → UTF-8 <C3 A9>. One escape per byte, never one per code point.
    expect(canonicalDoiUrl("10.1000/café")).toBe("https://doi.org/10.1000/caf%C3%A9");
  });

  it("encodes a CJK code point as three bytes", () => {
    // 日 is U+65E5 → UTF-8 <E6 97 A5>.
    expect(canonicalDoiUrl("10.1000/日")).toBe("https://doi.org/10.1000/%E6%97%A5");
  });

  it("encodes an astral code point as four bytes", () => {
    // U+1D400 (MATHEMATICAL BOLD CAPITAL A) → UTF-8 <F0 9D 90 80>. A surrogate
    // pair in JS, so a per-char implementation would emit two broken escapes.
    expect(canonicalDoiUrl("10.1000/\u{1D400}")).toBe("https://doi.org/10.1000/%F0%9D%90%80");
  });

  it("encodes non-ASCII alongside other escaped bytes in one suffix", () => {
    // Prefix `10.26321`, suffix `á.x/y` — the first `/` is the separator, so
    // everything after it is suffix data: `á` becomes two bytes, the `.` stays
    // unescaped, and the suffix-internal `/` escapes. The prefix stays ASCII
    // because Handbook 3.3.1 defines it as a numeric directory indicator and
    // registrant code, so there is no non-ASCII prefix to test.
    expect(canonicalDoiUrl("10.26321/á.x/y")).toBe("https://doi.org/10.26321/%C3%A1.x%2Fy");
  });
});

describe("values that cannot form a resolver URL yield null", () => {
  it.each(DOI_UNUSABLE_NAMES)("%s", (_label, value) => {
    expect(canonicalDoiUrl(value)).toBeNull();
  });

  it("rejects a resolver URL, because the input contract is a DOI name", () => {
    // Rejected, not unwrapped — recognizing resolver URLs belongs to the
    // classifier. The failure would otherwise be silent rather than loud: the
    // first `/` falls inside `https://`, so the value would encode to a
    // plausible-looking `https://doi.org/https:/%2Fdoi.org%2F10.1000%2Fexample`.
    expect(canonicalDoiUrl("https://doi.org/10.1000/example")).toBeNull();
  });

  it("keeps a colon in the suffix, where it is legal DOI data", () => {
    // The wrong-direction guard looks at the prefix only; the suffix stays
    // opaque, and `:` is in the Handbook's unescaped set.
    expect(canonicalDoiUrl("10.1000/a:b")).toBe("https://doi.org/10.1000/a:b");
  });
});

describe("whitespace is DOI data and is preserved, never trimmed", () => {
  // Handbook 3.3 draws DOI names from the Unicode Graphic type, which includes
  // spaces, and 3.7 step 1 serializes each component "without any
  // normalization". So a space is an ordinary code point of the name, and
  // dropping one produces the canonical URL of a *different* DOI — a link that
  // resolves to the wrong record, which is worse than one that 404s.

  it("encodes whitespace inside the name", () => {
    expect(canonicalDoiUrl("10.1000/a b")).toBe("https://doi.org/10.1000/a%20b");
  });

  it("encodes a trailing space rather than dropping it", () => {
    expect(canonicalDoiUrl("10.1000/example ")).toBe("https://doi.org/10.1000/example%20");
  });

  it("encodes a leading space in the suffix rather than dropping it", () => {
    expect(canonicalDoiUrl("10.1000/ example")).toBe("https://doi.org/10.1000/%20example");
  });

  it("treats a whitespace-only suffix as a suffix, not as an empty one", () => {
    // The precise regression `.trim()` caused: `10.1000/  ` would collapse to
    // `10.1000/`, be rejected as empty-suffixed, and lose the link entirely.
    expect(canonicalDoiUrl("10.1000/  ")).toBe("https://doi.org/10.1000/%20%20");
    expect(canonicalDoiUrl("10.1000/")).toBeNull();
  });

  it("preserves whitespace on either side of the whole name", () => {
    expect(canonicalDoiUrl("  10.1000/example  ")).toBe(
      "https://doi.org/%20%2010.1000/example%20%20",
    );
  });

  it("keeps names that differ only by whitespace distinct", () => {
    // The identity property the encoder owes its callers: distinct code point
    // sequences must map to distinct URLs. Normalizing any of them here would
    // merge two DOI names, exactly as a `%23` "already encoded" guess would.
    const urls = ["10.1000/example", "10.1000/example ", "10.1000/ example"].map(canonicalDoiUrl);
    expect(new Set(urls).size).toBe(3);
  });

  it("still rejects an all-whitespace value, for want of a separator", () => {
    // Not a whitespace special case — `"   "` has no `/`, so there is no
    // prefix/suffix boundary to build a URL around.
    expect(canonicalDoiUrl("   ")).toBeNull();
    expect(canonicalDoiUrl(" 10.1000 ")).toBeNull();
  });
});

describe("canonicalization is idempotent on the DOI name", () => {
  it("produces the same URL however many times the name is passed through", () => {
    for (const [, doiName] of DOI_CANONICAL_URL_VECTORS) {
      const once = canonicalDoiUrl(doiName);
      expect(canonicalDoiUrl(doiName)).toBe(once);
    }
  });
});
