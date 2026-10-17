"""Generate src/lib/evidence/__tests__/fixtures/normalizationV1.vectors.json.

Every expected value is written by hand below and then re-derived by an
independent reference (Python unicodedata NFC + the six v1 steps). The script
refuses to write if any hand-written expectation disagrees with the reference.

The matching vectors are run by the TypeScript matcher (matcher.test.ts) and,
since EVIDENCE-RECORDS-001A3, by the server's public.evidence_locate_quote in
suite 032. After changing a vector, regenerate the fixture, then the suite:

  python3 -I scripts/evidence-fixtures/gen_normalization_fixture.py write \
      src/lib/evidence/__tests__/fixtures/normalizationV1.vectors.json
  python3 -I scripts/evidence-fixtures/compose_parity_suite.py \
      src/lib/evidence/__tests__/fixtures/normalizationV1.vectors.json \
      supabase/tests/database/032_evidence_normalization_parity.test.sql

`check <out.json>` re-derives and compares, for other Python/Unicode versions.

No literal non-ASCII characters appear in this file: every one is chr(0x....).
"""
import hashlib
import json
import sys
import unicodedata

C = chr

# ---------------------------------------------------------------- reference --
REMOVED = {0x00AD, 0x200B, 0x2060, 0xFEFF}
WHITE_SPACE = {0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x0085, 0x00A0, 0x1680,
               0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A,
               0x2028, 0x2029, 0x202F, 0x205F, 0x3000}
assert len(WHITE_SPACE) == 25


def ref_normalize(text):
    """REQUIREMENTS-001 section I3, step by step, as separate passes (like the SQL)."""
    t = unicodedata.normalize("NFC", text)                               # 1
    t = "".join(ch for ch in t if ord(ch) not in REMOVED)                # 2
    t = "".join(" " if ord(ch) in WHITE_SPACE else ch for ch in t)       # 3 map
    while "  " in t:                                                     # 3 collapse
        t = t.replace("  ", " ")
    t = t.strip(" ")                                                     # 3 trim
    t = t.translate({0x2018: "'", 0x2019: "'", 0x201A: "'", 0x201B: "'",
                     0x201C: '"', 0x201D: '"', 0x201E: '"', 0x201F: '"'})  # 4
    t = t.translate({cp: "-" for cp in (0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212)})  # 5
    t = t.replace(C(0x2026), "...")                                      # 6
    t = t.replace(C(0x00B5), C(0x03BC))                                  # 6
    return t


def code_points(s):
    return " ".join("%04X" % ord(ch) for ch in s)


def sha256_hex(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def occurrences(haystack, needle):
    """All (overlapping) start positions, in code points."""
    if not needle:
        return []
    return [i for i in range(len(haystack) - len(needle) + 1) if haystack[i:i + len(needle)] == needle]


# EVIDENCE-RECORDS-001A3 (draft limit): more occurrences than this are not
# enumerated; the quote is too_many, which a save refuses as ambiguous.
OCCURRENCE_LIMIT = 100


def problems_of(quote):
    nq = ref_normalize(quote)
    out = []
    if len(quote) < 3:
        out.append("quote_too_short")
    if len(quote) > 1000:
        out.append("quote_too_long")
    if len(nq) < 3:
        out.append("normalized_too_short")
    if len(nq) > 1000:
        out.append("normalized_too_long")
    if not any(letter_or_digit(ch) for ch in nq):
        out.append("no_letter_or_digit")
    return out


# EVIDENCE-RECORDS-001A3 pins "a letter or a digit" as PostgreSQL's
# [[:alnum:]] under the builtin pg_c_utf8 collation: Unicode Alphabetic, or an
# ASCII digit. Alphabetic is every letter (L*), every letter number (Nl), and
# the Other_Alphabetic code points. Python has no Other_Alphabetic, so this
# reference covers it only for the code points the vectors below use: the
# circled Latin letters U+24B6..U+24E9 (DerivedCoreProperties.txt, Unicode
# 15.1 and 16.0). A vector using any other Other_Alphabetic character would
# need it added here.
OTHER_ALPHABETIC_USED = set(range(0x24B6, 0x24EA))


def letter_or_digit(ch):
    category = unicodedata.category(ch)
    return "0" <= ch <= "9" or category[0] == "L" or category == "Nl" or ord(ch) in OTHER_ALPHABETIC_USED


def utf16_index(text, cp_index):
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in text[:cp_index])


# ------------------------------------------------------------------ vectors --
WS25 = "".join(C(cp) for cp in [0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x0085, 0x00A0, 0x1680,
                                0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
                                0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000])

# (id, origin, title, input, expected, second_pass or None)
N = []


def n(id_, origin, title, inp, expected, second_pass=None):
    N.append((id_, origin, title, inp, expected, second_pass))


# The 30 golden vectors of suite 031 (section N), transcribed exactly. Titles are
# the suite's own, without the "Nxx " prefix and the ": output" suffix.
O = "suite-031"
n("N01", O, "spaces around < (thin, narrow no-break, no-break)", "p" + C(0x2009) + "<" + C(0x202F) + "0.001" + C(0x00A0), "p < 0.001")
n("N02", O, "soft hyphen removed", "ran" + C(0x00AD) + "domized", "randomized")
n("N03", O, "curly double and single quotes", C(0x201C) + "blinded" + C(0x201D) + " and " + C(0x2018) + "open" + C(0x2019), '"blinded" and \'open\'')
n("N04", O, "low-9 and reversed-9 quotes", C(0x201E) + "a" + C(0x201F) + " " + C(0x201A) + "b" + C(0x201B), '"a" \'b\'')
n("N05", O, "en dash range", "12" + C(0x2013) + "14 weeks", "12-14 weeks")
n("N06", O, "minus sign", C(0x2212) + "2.1 kg", "-2.1 kg")
n("N07", O, "all mapped dashes", "a" + C(0x2010) + "b" + C(0x2011) + "c" + C(0x2012) + "d" + C(0x2013) + "e" + C(0x2014) + "f" + C(0x2015) + "g", "a-b-c-d-e-f-g")
n("N08", O, "e + combining acute composes (NFC)", "cafe" + C(0x0301), "caf" + C(0x00E9))
n("N09", O, "precomposed e acute unchanged", "caf" + C(0x00E9), "caf" + C(0x00E9))
n("N10", O, "micro sign to Greek mu", "5 " + C(0x00B5) + "g", "5 " + C(0x03BC) + "g")
n("N11", O, "Greek mu unchanged", "5 " + C(0x03BC) + "g", "5 " + C(0x03BC) + "g")
n("N12", O, "superscript 5 stays (NFKC hazard)", "10" + C(0x2075) + " cells", "10" + C(0x2075) + " cells")
n("N13", O, "superscript 2 stays", "5 m" + C(0x00B2), "5 m" + C(0x00B2))
n("N14", O, "fi ligature stays", C(0xFB01) + "ber", C(0xFB01) + "ber")
n("N15", O, "no case folding", "Placebo vs placebo", "Placebo vs placebo")
n("N16", O, "line breaks and tabs become one space", "a" + C(0x000D) + C(0x000A) + "b" + C(0x0009) + "c" + C(0x000B) + "d" + C(0x000C) + "e", "a b c d e")
n("N17", O, "ellipsis is three periods, not a wildcard", "A " + C(0x2026) + " B", "A ... B")
n("N18", O, "BOM, zero-width space and word joiner removed", C(0xFEFF) + "a" + C(0x200B) + "b" + C(0x2060) + "c", "abc")
n("N19", O, "collapse runs and trim", "  a   b  ", "a b")
n("N20", O, "separators and wide spaces", "a" + C(0x2028) + "b" + C(0x2029) + "c" + C(0x0085) + "d" + C(0x1680) + "e" + C(0x3000) + "f" + C(0x205F) + "g", "a b c d e f g")
n("N21", O, "all 25 White_Space characters", "x" + WS25 + "y", "x y")
n("N22", O, "removal happens before collapsing", "a " + C(0x200B) + " b", "a b")
n("N23", O, "soft hyphen blocks composition (step order)", "e" + C(0x00AD) + C(0x0301), "e" + C(0x0301), "" + C(0x00E9))
n("N24", O, "canonical singletons (Angstrom, Ohm)", C(0x212B) + " " + C(0x2126), C(0x00C5) + " " + C(0x03A9))
n("N25", O, "A + ring composes", "A" + C(0x030A), C(0x00C5))
n("N26", O, "nothing else: fullwidth hyphen, prime, modifier apostrophe, two-em dash", C(0xFF0D) + " " + C(0x2032) + " " + C(0x02BC) + " " + C(0x2E3A), C(0xFF0D) + " " + C(0x2032) + " " + C(0x02BC) + " " + C(0x2E3A))
n("N27", O, "only whitespace normalizes to empty", " " + C(0x0009) + C(0x00A0) + C(0x3000) + C(0x000A), "")
n("N28", O, "empty string", "", "")
n("N29", O, "plain ASCII is unchanged", "Adults with type 2 diabetes.", "Adults with type 2 diabetes.")
n("N30", O, "astral character unchanged", C(0x1D400) + " x", C(0x1D400) + " x")

# The PR-A2 migration's own $verify$ checks of the installed normalizer.
O = "migration-verify"
n("V01", O, "NFKC hazards left alone", "10" + C(0x2075) + " cells; 5 m" + C(0x00B2) + "; " + C(0xFB01) + "ber", "10" + C(0x2075) + " cells; 5 m" + C(0x00B2) + "; " + C(0xFB01) + "ber")
n("V02", O, "NFC composes", "cafe" + C(0x0301), "caf" + C(0x00E9))
n("V03", O, "white space mapped, collapsed and trimmed", "  p" + C(0x2009) + "<" + C(0x202F) + "0.001" + C(0x00A0) + C(0x000D) + C(0x000A), "p < 0.001")
n("V04", O, "removal before collapse", "a " + C(0x200B) + " b" + C(0x00AD) + "c", "a bc")
n("V05", O, "soft hyphen after NFC keeps the pair decomposed", "e" + C(0x00AD) + C(0x0301), "e" + C(0x0301), C(0x00E9))
n("V06", O, "quotes, dashes, ellipsis and micro sign", C(0x201C) + "a" + C(0x201D) + " " + C(0x2018) + "b" + C(0x2019) + " " + C(0x2013) + " " + C(0x2212) + " " + C(0x2026) + " " + C(0x00B5), '"a" \'b\' - - ... ' + C(0x03BC))

# New vectors for EVIDENCE-RECORDS-001B.
O = "001b"
n("B01", O, "NFC reorders marks by combining class, then composes", "a" + C(0x0301) + C(0x0323), C(0x1EA1) + C(0x0301))
n("B02", O, "NFC composes two marks in sequence", "o" + C(0x0308) + C(0x0304), C(0x022B))
n("B03", O, "Hangul jamo compose to a syllable", C(0x1100) + C(0x1161) + C(0x11A8), C(0xAC01))
n("B04", O, "Hangul LV syllable plus final consonant composes", C(0xAC00) + C(0x11A8), C(0xAC01))
n("B05", O, "composition exclusion expands to two code points", C(0x0958), C(0x0915) + C(0x093C))
n("B06", O, "supplementary composition exclusion expands", C(0x1D15E), C(0x1D157) + C(0x1D165))
n("B07", O, "Kelvin sign is a canonical singleton for K", "300 " + C(0x212A), "300 K")
n("B08", O, "CJK compatibility ideograph has a canonical singleton", C(0xF900), C(0x8C48))
n("B09", O, "Greek alpha with oxia is a singleton for tonos", C(0x1F71), C(0x03AC))
n("B10", O, "Greek alpha plus combining tonos composes", C(0x03B1) + C(0x0301), C(0x03AC))
n("B11", O, "Hebrew presentation form is excluded from composition", C(0xFB1D), C(0x05D9) + C(0x05B4))
n("B12", O, "marks reorder even with nothing to compose", "q" + C(0x0301) + C(0x0323), "q" + C(0x0323) + C(0x0301))
n("B13", O, "soft hyphen next to a space", "trial" + C(0x00AD) + " arm", "trial arm")
n("B14", O, "zero-width joiner and non-joiner are not removed", "a" + C(0x200C) + "b" + C(0x200D) + "c", "a" + C(0x200C) + "b" + C(0x200D) + "c")
n("B15", O, "blank-looking characters that are not White_Space stay", "a" + C(0x180E) + "b" + C(0x2800) + "c" + C(0x3164) + "d" + C(0xFFA0) + "e", "a" + C(0x180E) + "b" + C(0x2800) + "c" + C(0x3164) + "d" + C(0xFFA0) + "e")
n("B16", O, "quote lookalikes are not mapped", C(0x0060) + C(0x00B4) + C(0x2039) + C(0x203A) + C(0x00AB) + C(0x00BB) + C(0xFF02) + C(0xFF07), C(0x0060) + C(0x00B4) + C(0x2039) + C(0x203A) + C(0x00AB) + C(0x00BB) + C(0xFF02) + C(0xFF07))
n("B17", O, "dash lookalikes, superscript and subscript minus are not mapped", C(0xFE58) + C(0xFE63) + C(0x2E3B) + C(0x2043) + C(0x02D7) + C(0x207B) + C(0x208B), C(0xFE58) + C(0xFE63) + C(0x2E3B) + C(0x2043) + C(0x02D7) + C(0x207B) + C(0x208B))
n("B18", O, "other ellipses are not mapped; two ellipses are six periods", C(0x22EF) + C(0x2025) + C(0xFE19) + " ...." + C(0x2026) + C(0x2026), C(0x22EF) + C(0x2025) + C(0xFE19) + " ..........")
n("B19", O, "scientific units: degree, Celsius sign, micro, plus-minus, times, superscript minus", "37 " + C(0x00B0) + "C; 5 " + C(0x2103) + "; 10 " + C(0x00B5) + "mol/L; " + C(0x00B1) + "2 " + C(0x00D7) + " 10" + C(0x207B) + C(0x00B3), "37 " + C(0x00B0) + "C; 5 " + C(0x2103) + "; 10 " + C(0x03BC) + "mol/L; " + C(0x00B1) + "2 " + C(0x00D7) + " 10" + C(0x207B) + C(0x00B3))
n("B20", O, "subscripts and superscripts stay", "CO" + C(0x2082) + ", H" + C(0x2082) + "O, x" + C(0x00B9) + ", 10" + C(0x2079), "CO" + C(0x2082) + ", H" + C(0x2082) + "O, x" + C(0x00B9) + ", 10" + C(0x2079))
n("B21", O, "more ligatures stay", C(0xFB00) + " " + C(0xFB02) + " " + C(0xFB03) + " " + C(0x0132) + " " + C(0x0133), C(0xFB00) + " " + C(0xFB02) + " " + C(0xFB03) + " " + C(0x0132) + " " + C(0x0133))
n("B22", O, "case-distinct letters stay distinct", C(0x00DF) + " SS " + C(0x0130) + " i " + C(0x0131) + " I", C(0x00DF) + " SS " + C(0x0130) + " i " + C(0x0131) + " I")
n("B23", O, "zero-width space blocks composition (non-idempotent)", "e" + C(0x200B) + C(0x0301), "e" + C(0x0301), C(0x00E9))
n("B24", O, "word joiner blocks composition (non-idempotent)", "A" + C(0x2060) + C(0x030A), "A" + C(0x030A), C(0x00C5))
n("B25", O, "BOM blocks composition (non-idempotent)", "n" + C(0xFEFF) + C(0x0303), "n" + C(0x0303), C(0x00F1))
n("B26", O, "line breaks, tabs and CRLF at the ends and inside", C(0x000D) + C(0x000A) + "Methods:" + C(0x0009) + "RCT" + C(0x000D) + C(0x000A) + C(0x000D) + C(0x000A) + "Results" + C(0x000A), "Methods: RCT Results")
n("B27", O, "mixed spaces collapse to one", "a" + C(0x0020) + C(0x00A0) + C(0x0020) + C(0x2007) + "b", "a b")
n("B28", O, "supplementary characters, a ZWJ sequence and a flag stay", C(0x1F600) + " " + C(0x1F469) + C(0x200D) + C(0x1F52C) + " " + C(0x1F1FA) + C(0x1F1F8) + " " + C(0x20000), C(0x1F600) + " " + C(0x1F469) + C(0x200D) + C(0x1F52C) + " " + C(0x1F1FA) + C(0x1F1F8) + " " + C(0x20000))
n("B29", O, "supplementary character next to mapped punctuation", C(0x1F9EA) + " " + C(0x2013) + " " + C(0x2026), C(0x1F9EA) + " - ...")
n("B30", O, "a leading combining mark survives the trim", " " + C(0x0301) + "a", C(0x0301) + "a")
n("B31", O, "micro sign before a combining mark becomes mu", C(0x00B5) + C(0x0301), C(0x03BC) + C(0x0301))
n("B32", O, "format characters only normalize to empty", C(0x00AD) + C(0x200B) + C(0x2060) + C(0xFEFF), "")
n("B33", O, "next line and line and paragraph separators only normalize to empty", C(0x0085) + C(0x2028) + C(0x2029), "")
n("B34", O, "fullwidth digits are not folded (no NFKC)", C(0xFF11) + C(0xFF12) + C(0xFF10), C(0xFF11) + C(0xFF12) + C(0xFF10))
n("B35", O, "Arabic-Indic digits stay", C(0x0661) + C(0x0662) + C(0x0660), C(0x0661) + C(0x0662) + C(0x0660))
n("B36", O, "thin space inside a number becomes a space", "1" + C(0x2009) + "204", "1 204")
n("B37", O, "curly quotes around an ellipsis", C(0x201C) + C(0x2026) + C(0x201D), '"..."')
n("B38", O, "a dash between no-break spaces", "a" + C(0x00A0) + C(0x2014) + C(0x00A0) + "b", "a - b")
n("B39", O, "removed characters inside leading white space", C(0x200B) + " " + C(0x00AD) + " a", "a")
n("B40", O, "case and punctuation survive", "P<0.05; p<0.05.", "P<0.05; p<0.05.")

# (id, title, quote, snapshot, kind, exact ranges [(a, b, snapped)])
M = []


def m(id_, title, quote, snapshot, kind, exact=()):
    M.append((id_, title, quote, snapshot, kind, list(exact)))


ABSTRACT = "Adults with type 2 diabetes were randomized (n = 120)."
m("M01", "unique match", "type 2 diabetes", ABSTRACT, "unique", [(12, 27, False)])
m("M02", "no match", "type 1 diabetes", ABSTRACT, "not_found")
m("M03", "overlapping occurrences all count", "aaa", "aaaaa", "multiple", [(0, 3, False), (1, 4, False), (2, 5, False)])
m("M04", "case is significant", "placebo", "Placebo-controlled", "not_found")
m("M05", "a precomposed quote finds a decomposed copy", "caf" + C(0x00E9), "cafe" + C(0x0301) + " au lait", "unique", [(0, 5, False)])
m("M06", "a removed soft hyphen stays inside the exact range", "randomized", "ran" + C(0x00AD) + "domized trial", "unique", [(0, 11, False)])
m("M07", "an ellipsis matches three full stops", "A ... B", "A " + C(0x2026) + " B", "unique", [(0, 5, False)])
m("M08", "a match ending inside an expanded ellipsis snaps to the whole character", "t..", "wait" + C(0x2026) + "then", "unique", [(3, 5, True)])
m("M09", "an ellipsis is not a wildcard", "A ... B", "A big B", "not_found")
m("M10", "spacing around punctuation counts", "p < 0.001", "p<0.001", "not_found")
m("M11", "thin and narrow no-break spaces match a space", "p < 0.001", "p" + C(0x2009) + "<" + C(0x202F) + "0.001", "unique", [(0, 9, False)])
m("M12", "a quote of punctuation only is invalid", "...", ABSTRACT, "invalid")
m("M13", "punctuation and spaces only is invalid", "-- ;", ABSTRACT, "invalid")
m("M14", "two characters are too short", "ab", ABSTRACT, "invalid")
m("M15", "too short once normalized", "a  " + C(0x00AD), ABSTRACT, "invalid")
m("M16", "1,001 characters are too long", "a" * 1001, ABSTRACT, "invalid")
m("M17", "too long as stored even though short once normalized", "a" + " " * 1000 + "b", "a b", "invalid")
m("M18", "offsets count code points, not UTF-16 units", "120 randomized", C(0x1F600) + " 120 randomized; 120 analysed", "unique", [(2, 16, False)])
m("M19", "two emoji are two characters: too short", C(0x1F600) + C(0x1F600), C(0x1F600) + C(0x1F600) + C(0x1F600), "invalid")
m("M20", "combining characters shift exact offsets", "ana", "Man" + C(0x0303) + "ana trial", "unique", [(4, 7, False)])
m("M21", "several matches come with their positions", "received drug X", "Group A received drug X. Group B received placebo. Group C received drug X.", "multiple", [(8, 23, False), (59, 74, False)])
m("M22", "each input is normalized exactly once", C(0x00E9) + "tude", "e" + C(0x00AD) + C(0x0301) + "tude", "not_found")
m("M23", "a decomposed quote finds a precomposed copy", "e" + C(0x0301) + "tude", C(0x00E9) + "tude", "unique", [(0, 5, False)])
m("M24", "a line break matches a space and maps to both characters", "line second", "first line" + C(0x000D) + C(0x000A) + "second line", "unique", [(6, 18, False)])
m("M25", "overlapping occurrences inside a word", "ana", "banana", "multiple", [(1, 4, False), (3, 6, False)])
m("M26", "white space around the quote is normalized away", "  type 2 ", ABSTRACT, "unique", [(12, 18, False)])
m("M27", "a no-break space in the copy matches a space", "10 mg", "10" + C(0x00A0) + "mg daily", "unique", [(0, 5, False)])
m("M28", "the micro sign in the copy matches mu", "5 " + C(0x03BC) + "g", "5 " + C(0x00B5) + "g/kg", "unique", [(0, 4, False)])
m("M29", "a superscript never matches a digit", "105 cells", "10" + C(0x2075) + " cells", "not_found")
m("M30", "an en dash matches a hyphen", "12-14 weeks", "12" + C(0x2013) + "14 weeks", "unique", [(0, 11, False)])
m("M31", "a quote equal to the whole copy", "Placebo.", "Placebo.", "unique", [(0, 8, False)])
m("M32", "trailing white space of the copy is trimmed", "here.", "ends here.  ", "unique", [(5, 10, False)])
m("M33", "a match ending inside one ellipsis of two", "1..", "1" + C(0x2026) + C(0x2026) + "2", "unique", [(0, 2, True)])
# EVIDENCE-RECORDS-001A3: the server matcher runs these too (suite 032).
m("M34", "a zero-width space inside the quote is removed before matching", "type 2" + C(0x200B) + " diabetes", ABSTRACT, "unique", [(12, 27, False)])
m("M35", "a word joiner inside a word is removed", "dia" + C(0x2060) + "betes", ABSTRACT, "unique", [(19, 27, False)])
m("M36", "a subscript is not a digit", "H2O", "Water (H" + C(0x2082) + "O) was given.", "not_found")
m("M37", "a subscript quote finds its subscript", "H" + C(0x2082) + "O", "Water (H" + C(0x2082) + "O) was given.", "unique", [(7, 10, False)])
m("M38", "a degree sign is not a masculine ordinal", "37 " + C(0x00BA) + "C", "Incubated at 37 " + C(0x00B0) + "C.", "not_found")
m("M39", "a unit with a superscript matches exactly", "10" + C(0x2079) + "/L", "Platelets 150 " + C(0x00D7) + " 10" + C(0x2079) + "/L.", "unique", [(16, 21, False)])
m("M40", "circled letters are letters (Unicode Alphabetic)", C(0x24D0) + C(0x24D1) + C(0x24D2), "Groups " + C(0x24D0) + C(0x24D1) + C(0x24D2) + " were compared.", "unique", [(7, 10, False)])
m("M41", "Arabic-Indic digits alone are not a letter or an ASCII digit", C(0x0661) + C(0x0662) + C(0x0660), "n = " + C(0x0661) + C(0x0662) + C(0x0660) + " randomized", "invalid")
m("M42", "vulgar fractions alone are not digits", C(0x00BD) + " " + C(0x00BD), C(0x00BD) + " " + C(0x00BD) + " dose", "invalid")
m("M43", "a Roman numeral is a letter number (Alphabetic)", C(0x216B) * 3, "Phase " + C(0x216B) * 3 + ".", "unique", [(6, 9, False)])
m("M44", "invisible characters only: empty once normalized", C(0x200B) * 3 + C(0x2060), ABSTRACT, "invalid")
m("M45", "a match at the very start of the copy", "Adults with", ABSTRACT, "unique", [(0, 11, False)])
m("M46", "a match at the very end of the copy", "(n = 120).", ABSTRACT, "unique", [(44, 54, False)])
m("M47", "leading white space of the copy is trimmed before offsets", "Adults", "  " + C(0x00A0) + "Adults first.", "unique", [(3, 9, False)])
m("M48", "a decomposed letter in the middle of a quote", "nai" + C(0x0308) + "ve", "A na" + C(0x00EF) + "ve design.", "unique", [(2, 7, False)])
m("M49", "an astral letter in the quote is one character", "x" + C(0x1D400) + "y", "Model x" + C(0x1D400) + "y fitted.", "unique", [(6, 9, False)])
m("M50", "100 overlapping occurrences are all enumerated", "aaa", "a" * 102, "multiple", [(i, i + 3, False) for i in range(100)])
m("M51", "101 occurrences are too many to enumerate", "aaa", "a" * 103, "too_many")


# --------------------------------------------------------------------- build --
def build():
    norm = []
    seen = set()
    for id_, origin, title, inp, expected, second_pass in N:
        assert id_ not in seen, id_
        seen.add(id_)
        got = ref_normalize(inp)
        if got != expected:
            raise SystemExit("REFERENCE DISAGREES %s: %r != %r" % (id_, code_points(got), code_points(expected)))
        if second_pass is not None:
            again = ref_normalize(expected)
            if again != second_pass:
                raise SystemExit("SECOND PASS DISAGREES %s: %r != %r" % (id_, code_points(again), code_points(second_pass)))
            if again == expected:
                raise SystemExit("%s claims non-idempotence but is idempotent" % id_)
        entry = {"id": id_, "origin": origin, "title": title, "input": inp,
                 "input_code_points": code_points(inp), "expected": expected,
                 "expected_sha256": sha256_hex(expected)}
        if second_pass is not None:
            entry["second_pass"] = second_pass
        norm.append(entry)

    match = []
    for id_, title, quote, snapshot, kind, exact in M:
        assert id_ not in seen, id_
        seen.add(id_)
        nq = ref_normalize(quote)
        ns = ref_normalize(snapshot)
        starts = occurrences(ns, nq)
        problems = problems_of(quote)
        ref_kind = ("invalid" if problems else "not_found" if not starts else "unique" if len(starts) == 1
                    else "multiple" if len(starts) <= OCCURRENCE_LIMIT else "too_many")
        if ref_kind != kind:
            raise SystemExit("KIND DISAGREES %s: reference %s, hand %s" % (id_, ref_kind, kind))
        if kind in ("unique", "multiple"):
            if len(exact) != len(starts):
                raise SystemExit("%s: %d exact ranges for %d occurrences" % (id_, len(exact), len(starts)))
            for (a, b, snapped) in exact:
                piece = ref_normalize(snapshot[a:b])
                if nq not in piece or (not snapped and piece != nq):
                    raise SystemExit("%s: exact range %d-%d normalizes to %r" % (id_, a, b, piece))
        elif exact:
            raise SystemExit("%s: exact ranges given for a non-match" % id_)
        match.append({
            "id": id_, "title": title, "quote": quote, "snapshot": snapshot,
            "expected_kind": kind,
            "invalid_problems": problems,
            "normalized_quote_length": len(nq),
            "expected_normalized": [[s, s + len(nq)] for s in starts],
            "expected_exact": [[a, b] for (a, b, _) in exact],
            "expected_exact_snapped": [snapped for (_, _, snapped) in exact],
            "expected_exact_utf16": [[utf16_index(snapshot, a), utf16_index(snapshot, b)] for (a, b, _) in exact],
        })

    return {
        "fixture": "evidence-normalization-v1",
        "fixture_version": 2,
        "normalization_version": "v1",
        "authority": "public.evidence_normalize_v1(text), supabase/migrations/20261016104232_add_evidence_records_lifecycle_rpcs.sql; public.evidence_locate_quote(text[], text), supabase/migrations/20261017155445_add_evidence_records_field_review_rebase_rpcs.sql",
        "letter_or_digit": "Unicode Alphabetic or an ASCII digit: PostgreSQL [[:alnum:]] under the builtin pg_c_utf8 collation, whatever the database collation.",
        "expected_values": "Hand-written, then re-derived outside both implementations by Python unicodedata NFC plus the six v1 steps; identical under Unicode 13.0 and 16.0.",
        "offsets": "0-based, half-open, in Unicode code points. expected_normalized indexes the v1-normalized snapshot; expected_exact indexes the original snapshot; expected_exact_utf16 gives the same exact range as JavaScript string indices.",
        "occurrence_limit": "At most %d occurrences are enumerated. Beyond that the kind is too_many: expected_normalized still lists every occurrence (the oracle's answer), but no matcher reports an offset or a count, exactly as for an invalid quote." % OCCURRENCE_LIMIT,
        "consumers": [
            "src/lib/evidence/__tests__/normalization.test.ts",
            "src/lib/evidence/__tests__/normalization.parity.test.ts",
            "src/lib/evidence/__tests__/matcher.test.ts",
            "supabase/tests/database/032_evidence_normalization_parity.test.sql",
        ],
        "normalization": norm,
        "matching": match,
    }


def serialize(doc):
    text = json.dumps(doc, ensure_ascii=True, indent=2) + "\n"
    assert all(0x20 <= ord(ch) <= 0x7E or ch == "\n" for ch in text), "fixture must be printable ASCII"
    assert "$fixture$" not in text, "the SQL dollar-quote tag must not occur in the fixture"
    assert "\\u0000" not in text, "PostgreSQL text cannot hold U+0000"
    return text


if __name__ == "__main__":
    mode, path = sys.argv[1], sys.argv[2]
    text = serialize(build())
    if mode == "write":
        with open(path, "w", encoding="ascii", newline="\n") as f:
            f.write(text)
        print("wrote", path, len(text), "bytes;", len(N), "normalization vectors,", len(M), "matching vectors; unicode", unicodedata.unidata_version)
    elif mode == "check":
        with open(path, encoding="ascii") as f:
            on_disk = f.read()
        if on_disk != text:
            raise SystemExit("MISMATCH under Python %s / Unicode %s" % (sys.version.split()[0], unicodedata.unidata_version))
        print("identical under Python", sys.version.split()[0], "/ Unicode", unicodedata.unidata_version)
