-- EVIDENCE-RECORDS-001B suite 032: match normalization v1 - parity with the
-- shared golden fixture; since EVIDENCE-RECORDS-001A3, the server's quote
-- location too.
--
-- WHAT THIS PROVES
-- The deployed public.evidence_normalize_v1(text) (20261016104232, PR-A2) and
-- the TypeScript normalizeEvidenceV1 (src/lib/evidence/normalization.ts) answer
-- the SAME vectors identically, and so do public.evidence_locate_quote
-- (20261017155445, PR-A3) and the TypeScript locateQuote
-- (src/lib/evidence/matcher.ts). All read one fixture:
--
--   src/lib/evidence/__tests__/fixtures/normalizationV1.vectors.json
--
-- The text between the two dollar-quote tags below is that file, byte for byte;
-- src/lib/evidence/__tests__/normalization.parity.test.ts fails if the two ever
-- differ. To change a vector, edit the JSON file, then replace everything
-- between the tags with its exact contents (scripts/evidence-fixtures/ holds
-- the generator and this suite's composer). The file is printable ASCII: every
-- other character is a JSON \u escape, which PostgreSQL's jsonb decodes, so
-- this suite holds no invisible character either.
--
-- The expected values were computed OUTSIDE both implementations - Python's
-- unicodedata NFC plus the six REQUIREMENTS-001 section I3 steps, identical
-- under Unicode 13.0 and 16.0 - and agree with the 30 vectors and SHA-256s
-- suite 031 already pins (the fixture carries those 30 as N01-N30, plus the
-- migration's own $verify$ checks as V01-V06).
--
-- Per normalization vector:
--   * the JSON input decodes to exactly the recorded code points (so jsonb
--     decoding is itself checked, not assumed);
--   * the installed function's output equals the expected text;
--   * the SHA-256 of that output, as a saved copy's normalized_sha256 is
--     computed, equals the expected digest;
--   * for the non-idempotent vectors, a SECOND pass gives the recorded second-
--     pass text - documenting why every input must be normalized exactly once.
-- Per matching vector:
--   * the normalized quote's length in characters (code points, as
--     char_length counts them - two emoji are two, not four UTF-16 units);
--   * every occurrence of the normalized quote in the normalized copy,
--     overlapping ones included, as 0-based half-open character ranges.
--
-- The occurrence query in section M is a TEST ORACLE over built-in substr and
-- char_length, independent of any matcher. It pins the offset convention -
-- 0-based, half-open PostgreSQL character positions of the v1-normalized copy -
-- on the real server. Section L then runs the installed evidence_locate_quote
-- on every matching vector: its kind (invalid, not_found, unique, multiple),
-- its count, its problems for an invalid quote (letter or digit: Unicode
-- Alphabetic or an ASCII digit, by the builtin pg_c_utf8 collation), and every
-- occurrence at the oracle's offsets - none for an invalid quote, which is
-- never located even where the oracle finds it, and none beyond the cap of
-- 100 occurrences (too_many), which M50 and M51 pin. This suite creates no
-- function.
--
-- Runs as the database owner (both functions are owner-only), in one transaction
-- that rolls back. Synthetic data only; no remote calls.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- The shared fixture, verbatim ----------------------------------------------

CREATE TEMP TABLE fixture ON COMMIT DROP AS
SELECT $fixture${
  "fixture": "evidence-normalization-v1",
  "fixture_version": 2,
  "normalization_version": "v1",
  "authority": "public.evidence_normalize_v1(text), supabase/migrations/20261016104232_add_evidence_records_lifecycle_rpcs.sql; public.evidence_locate_quote(text[], text), supabase/migrations/20261017155445_add_evidence_records_field_review_rebase_rpcs.sql",
  "letter_or_digit": "Unicode Alphabetic or an ASCII digit: PostgreSQL [[:alnum:]] under the builtin pg_c_utf8 collation, whatever the database collation.",
  "expected_values": "Hand-written, then re-derived outside both implementations by Python unicodedata NFC plus the six v1 steps; identical under Unicode 13.0 and 16.0.",
  "offsets": "0-based, half-open, in Unicode code points. expected_normalized indexes the v1-normalized snapshot; expected_exact indexes the original snapshot; expected_exact_utf16 gives the same exact range as JavaScript string indices.",
  "occurrence_limit": "At most 100 occurrences are enumerated. Beyond that the kind is too_many: expected_normalized still lists every occurrence (the oracle's answer), but no matcher reports an offset or a count, exactly as for an invalid quote.",
  "consumers": [
    "src/lib/evidence/__tests__/normalization.test.ts",
    "src/lib/evidence/__tests__/normalization.parity.test.ts",
    "src/lib/evidence/__tests__/matcher.test.ts",
    "supabase/tests/database/032_evidence_normalization_parity.test.sql"
  ],
  "normalization": [
    {
      "id": "N01",
      "origin": "suite-031",
      "title": "spaces around < (thin, narrow no-break, no-break)",
      "input": "p\u2009<\u202f0.001\u00a0",
      "input_code_points": "0070 2009 003C 202F 0030 002E 0030 0030 0031 00A0",
      "expected": "p < 0.001",
      "expected_sha256": "ac4df7ee2d153f8845beaebd887b5a838a429d4e48575f9e3e41031f2a33e5c8"
    },
    {
      "id": "N02",
      "origin": "suite-031",
      "title": "soft hyphen removed",
      "input": "ran\u00addomized",
      "input_code_points": "0072 0061 006E 00AD 0064 006F 006D 0069 007A 0065 0064",
      "expected": "randomized",
      "expected_sha256": "c78e2c6a7e4ba04d05abe48c0046400325d7b4d5a2281a71a0df465997bc9797"
    },
    {
      "id": "N03",
      "origin": "suite-031",
      "title": "curly double and single quotes",
      "input": "\u201cblinded\u201d and \u2018open\u2019",
      "input_code_points": "201C 0062 006C 0069 006E 0064 0065 0064 201D 0020 0061 006E 0064 0020 2018 006F 0070 0065 006E 2019",
      "expected": "\"blinded\" and 'open'",
      "expected_sha256": "0cc01df13223d976021cd26367350568a7c765103258bfc55c6b05c9634c6993"
    },
    {
      "id": "N04",
      "origin": "suite-031",
      "title": "low-9 and reversed-9 quotes",
      "input": "\u201ea\u201f \u201ab\u201b",
      "input_code_points": "201E 0061 201F 0020 201A 0062 201B",
      "expected": "\"a\" 'b'",
      "expected_sha256": "40e1da853aeebfa8a30f2170cc6e95a553208c4514064a65c0f8a352874d730f"
    },
    {
      "id": "N05",
      "origin": "suite-031",
      "title": "en dash range",
      "input": "12\u201314 weeks",
      "input_code_points": "0031 0032 2013 0031 0034 0020 0077 0065 0065 006B 0073",
      "expected": "12-14 weeks",
      "expected_sha256": "a5ee9a069e0ee73a4e0d19408c47c378cc9e79160a5b89efc577b27e10e04486"
    },
    {
      "id": "N06",
      "origin": "suite-031",
      "title": "minus sign",
      "input": "\u22122.1 kg",
      "input_code_points": "2212 0032 002E 0031 0020 006B 0067",
      "expected": "-2.1 kg",
      "expected_sha256": "47b049d7076fb4d03300ef207d5a1e3b4fa044f67b3bd013293e1cab76a5b4f2"
    },
    {
      "id": "N07",
      "origin": "suite-031",
      "title": "all mapped dashes",
      "input": "a\u2010b\u2011c\u2012d\u2013e\u2014f\u2015g",
      "input_code_points": "0061 2010 0062 2011 0063 2012 0064 2013 0065 2014 0066 2015 0067",
      "expected": "a-b-c-d-e-f-g",
      "expected_sha256": "483fefe153fe9a94667bcbfb80fa9cf74506a9a32ba0f80f1aacb311ac0688f7"
    },
    {
      "id": "N08",
      "origin": "suite-031",
      "title": "e + combining acute composes (NFC)",
      "input": "cafe\u0301",
      "input_code_points": "0063 0061 0066 0065 0301",
      "expected": "caf\u00e9",
      "expected_sha256": "850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e"
    },
    {
      "id": "N09",
      "origin": "suite-031",
      "title": "precomposed e acute unchanged",
      "input": "caf\u00e9",
      "input_code_points": "0063 0061 0066 00E9",
      "expected": "caf\u00e9",
      "expected_sha256": "850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e"
    },
    {
      "id": "N10",
      "origin": "suite-031",
      "title": "micro sign to Greek mu",
      "input": "5 \u00b5g",
      "input_code_points": "0035 0020 00B5 0067",
      "expected": "5 \u03bcg",
      "expected_sha256": "f331bc43a9476fe99f623fe4e0ee5dbbb0a9661a7a062f024c90b7edbfd5de5c"
    },
    {
      "id": "N11",
      "origin": "suite-031",
      "title": "Greek mu unchanged",
      "input": "5 \u03bcg",
      "input_code_points": "0035 0020 03BC 0067",
      "expected": "5 \u03bcg",
      "expected_sha256": "f331bc43a9476fe99f623fe4e0ee5dbbb0a9661a7a062f024c90b7edbfd5de5c"
    },
    {
      "id": "N12",
      "origin": "suite-031",
      "title": "superscript 5 stays (NFKC hazard)",
      "input": "10\u2075 cells",
      "input_code_points": "0031 0030 2075 0020 0063 0065 006C 006C 0073",
      "expected": "10\u2075 cells",
      "expected_sha256": "58064f92009bb8e27d8333ff733593934b5acf7518e53553aca357e1df36b64d"
    },
    {
      "id": "N13",
      "origin": "suite-031",
      "title": "superscript 2 stays",
      "input": "5 m\u00b2",
      "input_code_points": "0035 0020 006D 00B2",
      "expected": "5 m\u00b2",
      "expected_sha256": "145ead7315bc60166e65160f73ea9fc9b13bbfb0598ebc0e8108ad11d3243c66"
    },
    {
      "id": "N14",
      "origin": "suite-031",
      "title": "fi ligature stays",
      "input": "\ufb01ber",
      "input_code_points": "FB01 0062 0065 0072",
      "expected": "\ufb01ber",
      "expected_sha256": "7ec6c036b25596d5c5163c9ab7cd78a7032a5da9bd123a68f5049767fdd6db85"
    },
    {
      "id": "N15",
      "origin": "suite-031",
      "title": "no case folding",
      "input": "Placebo vs placebo",
      "input_code_points": "0050 006C 0061 0063 0065 0062 006F 0020 0076 0073 0020 0070 006C 0061 0063 0065 0062 006F",
      "expected": "Placebo vs placebo",
      "expected_sha256": "b57ef4c50d212f67f2c782be996359c229dce0635ec86477b6565167e47e5af9"
    },
    {
      "id": "N16",
      "origin": "suite-031",
      "title": "line breaks and tabs become one space",
      "input": "a\r\nb\tc\u000bd\fe",
      "input_code_points": "0061 000D 000A 0062 0009 0063 000B 0064 000C 0065",
      "expected": "a b c d e",
      "expected_sha256": "52cf9f06f83e0a0a90dc25dcf548c18421244f9520c577672cd27b6618f12134"
    },
    {
      "id": "N17",
      "origin": "suite-031",
      "title": "ellipsis is three periods, not a wildcard",
      "input": "A \u2026 B",
      "input_code_points": "0041 0020 2026 0020 0042",
      "expected": "A ... B",
      "expected_sha256": "26bf87b9ed4c180cf97c8784cdc39b9c9c9a99d1dbbe3aaebe221aeda4c8a92a"
    },
    {
      "id": "N18",
      "origin": "suite-031",
      "title": "BOM, zero-width space and word joiner removed",
      "input": "\ufeffa\u200bb\u2060c",
      "input_code_points": "FEFF 0061 200B 0062 2060 0063",
      "expected": "abc",
      "expected_sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    },
    {
      "id": "N19",
      "origin": "suite-031",
      "title": "collapse runs and trim",
      "input": "  a   b  ",
      "input_code_points": "0020 0020 0061 0020 0020 0020 0062 0020 0020",
      "expected": "a b",
      "expected_sha256": "c8687a08aa5d6ed2044328fa6a697ab8e96dc34291e8c2034ae8c38e6fcc6d65"
    },
    {
      "id": "N20",
      "origin": "suite-031",
      "title": "separators and wide spaces",
      "input": "a\u2028b\u2029c\u0085d\u1680e\u3000f\u205fg",
      "input_code_points": "0061 2028 0062 2029 0063 0085 0064 1680 0065 3000 0066 205F 0067",
      "expected": "a b c d e f g",
      "expected_sha256": "54ff557e9f8f96a09c179ad2101dbca7e608ebc826b03c8833518097fa2dd32f"
    },
    {
      "id": "N21",
      "origin": "suite-031",
      "title": "all 25 White_Space characters",
      "input": "x\t\n\u000b\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000y",
      "input_code_points": "0078 0009 000A 000B 000C 000D 0020 0085 00A0 1680 2000 2001 2002 2003 2004 2005 2006 2007 2008 2009 200A 2028 2029 202F 205F 3000 0079",
      "expected": "x y",
      "expected_sha256": "887fcea6a80333c6c02ae7e79735f0edad8d811f0b61431495f796f4bf6a7c19"
    },
    {
      "id": "N22",
      "origin": "suite-031",
      "title": "removal happens before collapsing",
      "input": "a \u200b b",
      "input_code_points": "0061 0020 200B 0020 0062",
      "expected": "a b",
      "expected_sha256": "c8687a08aa5d6ed2044328fa6a697ab8e96dc34291e8c2034ae8c38e6fcc6d65"
    },
    {
      "id": "N23",
      "origin": "suite-031",
      "title": "soft hyphen blocks composition (step order)",
      "input": "e\u00ad\u0301",
      "input_code_points": "0065 00AD 0301",
      "expected": "e\u0301",
      "expected_sha256": "bf12767b0f2a56b2190075bae8169f656e3ce8d6357d4aff184bc6c7ea48f9f6",
      "second_pass": "\u00e9"
    },
    {
      "id": "N24",
      "origin": "suite-031",
      "title": "canonical singletons (Angstrom, Ohm)",
      "input": "\u212b \u2126",
      "input_code_points": "212B 0020 2126",
      "expected": "\u00c5 \u03a9",
      "expected_sha256": "69dc02ebabc7bba88abeca8e014d783275c7fd651e2e8022a23125a641221dc9"
    },
    {
      "id": "N25",
      "origin": "suite-031",
      "title": "A + ring composes",
      "input": "A\u030a",
      "input_code_points": "0041 030A",
      "expected": "\u00c5",
      "expected_sha256": "0a94dc9d420d1142d6b71de60f9bf7e2f345a4d62c9f141b091539769ddf3075"
    },
    {
      "id": "N26",
      "origin": "suite-031",
      "title": "nothing else: fullwidth hyphen, prime, modifier apostrophe, two-em dash",
      "input": "\uff0d \u2032 \u02bc \u2e3a",
      "input_code_points": "FF0D 0020 2032 0020 02BC 0020 2E3A",
      "expected": "\uff0d \u2032 \u02bc \u2e3a",
      "expected_sha256": "867dc66ab3599d13b059545f77090b62828d45a1b461f013bef0eab55ca914b0"
    },
    {
      "id": "N27",
      "origin": "suite-031",
      "title": "only whitespace normalizes to empty",
      "input": " \t\u00a0\u3000\n",
      "input_code_points": "0020 0009 00A0 3000 000A",
      "expected": "",
      "expected_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    },
    {
      "id": "N28",
      "origin": "suite-031",
      "title": "empty string",
      "input": "",
      "input_code_points": "",
      "expected": "",
      "expected_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    },
    {
      "id": "N29",
      "origin": "suite-031",
      "title": "plain ASCII is unchanged",
      "input": "Adults with type 2 diabetes.",
      "input_code_points": "0041 0064 0075 006C 0074 0073 0020 0077 0069 0074 0068 0020 0074 0079 0070 0065 0020 0032 0020 0064 0069 0061 0062 0065 0074 0065 0073 002E",
      "expected": "Adults with type 2 diabetes.",
      "expected_sha256": "aac3d8cd3e5ca9a6eb7c4940648518e76d339d56aae162097cc61097aee93a7a"
    },
    {
      "id": "N30",
      "origin": "suite-031",
      "title": "astral character unchanged",
      "input": "\ud835\udc00 x",
      "input_code_points": "1D400 0020 0078",
      "expected": "\ud835\udc00 x",
      "expected_sha256": "bbb15d65e30517e3695724d44dbabf80e636e9eb032397f3eb6845abb896b85c"
    },
    {
      "id": "V01",
      "origin": "migration-verify",
      "title": "NFKC hazards left alone",
      "input": "10\u2075 cells; 5 m\u00b2; \ufb01ber",
      "input_code_points": "0031 0030 2075 0020 0063 0065 006C 006C 0073 003B 0020 0035 0020 006D 00B2 003B 0020 FB01 0062 0065 0072",
      "expected": "10\u2075 cells; 5 m\u00b2; \ufb01ber",
      "expected_sha256": "58b8db5c8c2408169b12c8c413b1e15e01fe4fb4e7d722723411644d8cb664ff"
    },
    {
      "id": "V02",
      "origin": "migration-verify",
      "title": "NFC composes",
      "input": "cafe\u0301",
      "input_code_points": "0063 0061 0066 0065 0301",
      "expected": "caf\u00e9",
      "expected_sha256": "850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e"
    },
    {
      "id": "V03",
      "origin": "migration-verify",
      "title": "white space mapped, collapsed and trimmed",
      "input": "  p\u2009<\u202f0.001\u00a0\r\n",
      "input_code_points": "0020 0020 0070 2009 003C 202F 0030 002E 0030 0030 0031 00A0 000D 000A",
      "expected": "p < 0.001",
      "expected_sha256": "ac4df7ee2d153f8845beaebd887b5a838a429d4e48575f9e3e41031f2a33e5c8"
    },
    {
      "id": "V04",
      "origin": "migration-verify",
      "title": "removal before collapse",
      "input": "a \u200b b\u00adc",
      "input_code_points": "0061 0020 200B 0020 0062 00AD 0063",
      "expected": "a bc",
      "expected_sha256": "2e65a63082cec858883150c68dd138505008e5b6665f9e80c1e1a14de7671247"
    },
    {
      "id": "V05",
      "origin": "migration-verify",
      "title": "soft hyphen after NFC keeps the pair decomposed",
      "input": "e\u00ad\u0301",
      "input_code_points": "0065 00AD 0301",
      "expected": "e\u0301",
      "expected_sha256": "bf12767b0f2a56b2190075bae8169f656e3ce8d6357d4aff184bc6c7ea48f9f6",
      "second_pass": "\u00e9"
    },
    {
      "id": "V06",
      "origin": "migration-verify",
      "title": "quotes, dashes, ellipsis and micro sign",
      "input": "\u201ca\u201d \u2018b\u2019 \u2013 \u2212 \u2026 \u00b5",
      "input_code_points": "201C 0061 201D 0020 2018 0062 2019 0020 2013 0020 2212 0020 2026 0020 00B5",
      "expected": "\"a\" 'b' - - ... \u03bc",
      "expected_sha256": "57f22c3f226f5b3feb4900b434a0d2782fbb1d70403b88d731ce11d9d8d112ef"
    },
    {
      "id": "B01",
      "origin": "001b",
      "title": "NFC reorders marks by combining class, then composes",
      "input": "a\u0301\u0323",
      "input_code_points": "0061 0301 0323",
      "expected": "\u1ea1\u0301",
      "expected_sha256": "599713dc048d732aadd79d93b98c9d0fa63fab64526f0af2ed19beab3eaa9f69"
    },
    {
      "id": "B02",
      "origin": "001b",
      "title": "NFC composes two marks in sequence",
      "input": "o\u0308\u0304",
      "input_code_points": "006F 0308 0304",
      "expected": "\u022b",
      "expected_sha256": "dad05a36af2c7a6f1d1ffd27c1ddbf112e0e95710f29d6486f020e9148fbccfd"
    },
    {
      "id": "B03",
      "origin": "001b",
      "title": "Hangul jamo compose to a syllable",
      "input": "\u1100\u1161\u11a8",
      "input_code_points": "1100 1161 11A8",
      "expected": "\uac01",
      "expected_sha256": "45ec909f30174e6585c67833638ece2b73752a2e17b142f2071d058792f16c89"
    },
    {
      "id": "B04",
      "origin": "001b",
      "title": "Hangul LV syllable plus final consonant composes",
      "input": "\uac00\u11a8",
      "input_code_points": "AC00 11A8",
      "expected": "\uac01",
      "expected_sha256": "45ec909f30174e6585c67833638ece2b73752a2e17b142f2071d058792f16c89"
    },
    {
      "id": "B05",
      "origin": "001b",
      "title": "composition exclusion expands to two code points",
      "input": "\u0958",
      "input_code_points": "0958",
      "expected": "\u0915\u093c",
      "expected_sha256": "615d7ded5160a3c326af1446286beca5beb402e22f91b4b32f07ea9e29ac61ad"
    },
    {
      "id": "B06",
      "origin": "001b",
      "title": "supplementary composition exclusion expands",
      "input": "\ud834\udd5e",
      "input_code_points": "1D15E",
      "expected": "\ud834\udd57\ud834\udd65",
      "expected_sha256": "4e434707544e9c5092405d20f7fee40a0c1c093391d107c997673831cb9bd68d"
    },
    {
      "id": "B07",
      "origin": "001b",
      "title": "Kelvin sign is a canonical singleton for K",
      "input": "300 \u212a",
      "input_code_points": "0033 0030 0030 0020 212A",
      "expected": "300 K",
      "expected_sha256": "eb672eaac041dc5f36eb08b14de3d88ab44834b6adc259900c9c0c3a882bcdb4"
    },
    {
      "id": "B08",
      "origin": "001b",
      "title": "CJK compatibility ideograph has a canonical singleton",
      "input": "\uf900",
      "input_code_points": "F900",
      "expected": "\u8c48",
      "expected_sha256": "3efe6ddf76cf9fac3cb2085a425f8e2bf4ce9bd49bb1c5f8377dee0021465391"
    },
    {
      "id": "B09",
      "origin": "001b",
      "title": "Greek alpha with oxia is a singleton for tonos",
      "input": "\u1f71",
      "input_code_points": "1F71",
      "expected": "\u03ac",
      "expected_sha256": "2d1490ba7b907d3a5ebeded589b3ce1f442e249409d8743510b6f3d004d3afd3"
    },
    {
      "id": "B10",
      "origin": "001b",
      "title": "Greek alpha plus combining tonos composes",
      "input": "\u03b1\u0301",
      "input_code_points": "03B1 0301",
      "expected": "\u03ac",
      "expected_sha256": "2d1490ba7b907d3a5ebeded589b3ce1f442e249409d8743510b6f3d004d3afd3"
    },
    {
      "id": "B11",
      "origin": "001b",
      "title": "Hebrew presentation form is excluded from composition",
      "input": "\ufb1d",
      "input_code_points": "FB1D",
      "expected": "\u05d9\u05b4",
      "expected_sha256": "dd20467ede940eae7eacd23fd772c758ecb8fb57882d8cb0a27264e66e448d05"
    },
    {
      "id": "B12",
      "origin": "001b",
      "title": "marks reorder even with nothing to compose",
      "input": "q\u0301\u0323",
      "input_code_points": "0071 0301 0323",
      "expected": "q\u0323\u0301",
      "expected_sha256": "fd5f78d29fd15363b79b062e216e35b963cb9a017b3b6d871ed7bcf08b2e98ef"
    },
    {
      "id": "B13",
      "origin": "001b",
      "title": "soft hyphen next to a space",
      "input": "trial\u00ad arm",
      "input_code_points": "0074 0072 0069 0061 006C 00AD 0020 0061 0072 006D",
      "expected": "trial arm",
      "expected_sha256": "4333c3ffa218df1d64357af51847277d5fc16322897fc9bdb6ad23b6d0e48601"
    },
    {
      "id": "B14",
      "origin": "001b",
      "title": "zero-width joiner and non-joiner are not removed",
      "input": "a\u200cb\u200dc",
      "input_code_points": "0061 200C 0062 200D 0063",
      "expected": "a\u200cb\u200dc",
      "expected_sha256": "8a987f5b6f17572bdc30287757b7ee9f281d09da5900b82d2d5fb72e65dde9d5"
    },
    {
      "id": "B15",
      "origin": "001b",
      "title": "blank-looking characters that are not White_Space stay",
      "input": "a\u180eb\u2800c\u3164d\uffa0e",
      "input_code_points": "0061 180E 0062 2800 0063 3164 0064 FFA0 0065",
      "expected": "a\u180eb\u2800c\u3164d\uffa0e",
      "expected_sha256": "1befd0a1cf68e6324b4bdeb0c32e154905426ddfb5d472ba7e6f7f1759052fa5"
    },
    {
      "id": "B16",
      "origin": "001b",
      "title": "quote lookalikes are not mapped",
      "input": "`\u00b4\u2039\u203a\u00ab\u00bb\uff02\uff07",
      "input_code_points": "0060 00B4 2039 203A 00AB 00BB FF02 FF07",
      "expected": "`\u00b4\u2039\u203a\u00ab\u00bb\uff02\uff07",
      "expected_sha256": "32d94fa563e1d27b57bc99f7c482fa48dbe319d624cbaf1df1d5b76fb1b3c67a"
    },
    {
      "id": "B17",
      "origin": "001b",
      "title": "dash lookalikes, superscript and subscript minus are not mapped",
      "input": "\ufe58\ufe63\u2e3b\u2043\u02d7\u207b\u208b",
      "input_code_points": "FE58 FE63 2E3B 2043 02D7 207B 208B",
      "expected": "\ufe58\ufe63\u2e3b\u2043\u02d7\u207b\u208b",
      "expected_sha256": "65d31766230ef72174937a22a2b0280b7dcc19ef45071bfb9279c3b0b0d89c43"
    },
    {
      "id": "B18",
      "origin": "001b",
      "title": "other ellipses are not mapped; two ellipses are six periods",
      "input": "\u22ef\u2025\ufe19 ....\u2026\u2026",
      "input_code_points": "22EF 2025 FE19 0020 002E 002E 002E 002E 2026 2026",
      "expected": "\u22ef\u2025\ufe19 ..........",
      "expected_sha256": "4e8f61b220cd202b263ae7bbd459ea70a8e63c2a774919b081b7b2d6d00c8352"
    },
    {
      "id": "B19",
      "origin": "001b",
      "title": "scientific units: degree, Celsius sign, micro, plus-minus, times, superscript minus",
      "input": "37 \u00b0C; 5 \u2103; 10 \u00b5mol/L; \u00b12 \u00d7 10\u207b\u00b3",
      "input_code_points": "0033 0037 0020 00B0 0043 003B 0020 0035 0020 2103 003B 0020 0031 0030 0020 00B5 006D 006F 006C 002F 004C 003B 0020 00B1 0032 0020 00D7 0020 0031 0030 207B 00B3",
      "expected": "37 \u00b0C; 5 \u2103; 10 \u03bcmol/L; \u00b12 \u00d7 10\u207b\u00b3",
      "expected_sha256": "a75e23eecb9b47389a8256054cb5dab8f2d66eb1ab0c362938d84d1af38cdb24"
    },
    {
      "id": "B20",
      "origin": "001b",
      "title": "subscripts and superscripts stay",
      "input": "CO\u2082, H\u2082O, x\u00b9, 10\u2079",
      "input_code_points": "0043 004F 2082 002C 0020 0048 2082 004F 002C 0020 0078 00B9 002C 0020 0031 0030 2079",
      "expected": "CO\u2082, H\u2082O, x\u00b9, 10\u2079",
      "expected_sha256": "76500b4cbdca7652e476f352497013cf9c1d5343e851b46d9a873aa4195cc7e7"
    },
    {
      "id": "B21",
      "origin": "001b",
      "title": "more ligatures stay",
      "input": "\ufb00 \ufb02 \ufb03 \u0132 \u0133",
      "input_code_points": "FB00 0020 FB02 0020 FB03 0020 0132 0020 0133",
      "expected": "\ufb00 \ufb02 \ufb03 \u0132 \u0133",
      "expected_sha256": "720de5ab6fbbfac81906965349c8c8c4c4a6d6482be8b6857f0de8324e4467f4"
    },
    {
      "id": "B22",
      "origin": "001b",
      "title": "case-distinct letters stay distinct",
      "input": "\u00df SS \u0130 i \u0131 I",
      "input_code_points": "00DF 0020 0053 0053 0020 0130 0020 0069 0020 0131 0020 0049",
      "expected": "\u00df SS \u0130 i \u0131 I",
      "expected_sha256": "8b308990be8c7aa77404eb1eb1de13ae3292f78ef522506bca73171cb64381b1"
    },
    {
      "id": "B23",
      "origin": "001b",
      "title": "zero-width space blocks composition (non-idempotent)",
      "input": "e\u200b\u0301",
      "input_code_points": "0065 200B 0301",
      "expected": "e\u0301",
      "expected_sha256": "bf12767b0f2a56b2190075bae8169f656e3ce8d6357d4aff184bc6c7ea48f9f6",
      "second_pass": "\u00e9"
    },
    {
      "id": "B24",
      "origin": "001b",
      "title": "word joiner blocks composition (non-idempotent)",
      "input": "A\u2060\u030a",
      "input_code_points": "0041 2060 030A",
      "expected": "A\u030a",
      "expected_sha256": "446b2da699e20cd17905c4d73147935ffe84e37d2df872fb5c72fcf1838715cc",
      "second_pass": "\u00c5"
    },
    {
      "id": "B25",
      "origin": "001b",
      "title": "BOM blocks composition (non-idempotent)",
      "input": "n\ufeff\u0303",
      "input_code_points": "006E FEFF 0303",
      "expected": "n\u0303",
      "expected_sha256": "202d2280a6cf90d498e66f45f2330fd588e809fc5059c0246f54f6da94aa0a23",
      "second_pass": "\u00f1"
    },
    {
      "id": "B26",
      "origin": "001b",
      "title": "line breaks, tabs and CRLF at the ends and inside",
      "input": "\r\nMethods:\tRCT\r\n\r\nResults\n",
      "input_code_points": "000D 000A 004D 0065 0074 0068 006F 0064 0073 003A 0009 0052 0043 0054 000D 000A 000D 000A 0052 0065 0073 0075 006C 0074 0073 000A",
      "expected": "Methods: RCT Results",
      "expected_sha256": "bacd08387e69367659e5e4f972c32cb0384b1b775e05a6e1e36d2eff8a256ebd"
    },
    {
      "id": "B27",
      "origin": "001b",
      "title": "mixed spaces collapse to one",
      "input": "a \u00a0 \u2007b",
      "input_code_points": "0061 0020 00A0 0020 2007 0062",
      "expected": "a b",
      "expected_sha256": "c8687a08aa5d6ed2044328fa6a697ab8e96dc34291e8c2034ae8c38e6fcc6d65"
    },
    {
      "id": "B28",
      "origin": "001b",
      "title": "supplementary characters, a ZWJ sequence and a flag stay",
      "input": "\ud83d\ude00 \ud83d\udc69\u200d\ud83d\udd2c \ud83c\uddfa\ud83c\uddf8 \ud840\udc00",
      "input_code_points": "1F600 0020 1F469 200D 1F52C 0020 1F1FA 1F1F8 0020 20000",
      "expected": "\ud83d\ude00 \ud83d\udc69\u200d\ud83d\udd2c \ud83c\uddfa\ud83c\uddf8 \ud840\udc00",
      "expected_sha256": "57e051b546b9811b95ca9506aeff9d24bf60700501148c3f4621504d08dd086a"
    },
    {
      "id": "B29",
      "origin": "001b",
      "title": "supplementary character next to mapped punctuation",
      "input": "\ud83e\uddea \u2013 \u2026",
      "input_code_points": "1F9EA 0020 2013 0020 2026",
      "expected": "\ud83e\uddea - ...",
      "expected_sha256": "9276eedc73eda0cc5539a27d77e6c5b06238d07afa673cbfd511a4197fce4002"
    },
    {
      "id": "B30",
      "origin": "001b",
      "title": "a leading combining mark survives the trim",
      "input": " \u0301a",
      "input_code_points": "0020 0301 0061",
      "expected": "\u0301a",
      "expected_sha256": "cb52dae9f5d73829927129f1fa3677686ca2c8f5bc0baaf5655f04c7c18ad4a7"
    },
    {
      "id": "B31",
      "origin": "001b",
      "title": "micro sign before a combining mark becomes mu",
      "input": "\u00b5\u0301",
      "input_code_points": "00B5 0301",
      "expected": "\u03bc\u0301",
      "expected_sha256": "2c88964fbe03283f10d53c800382c694c5783de50a26b1fd91ad24f21a84838c"
    },
    {
      "id": "B32",
      "origin": "001b",
      "title": "format characters only normalize to empty",
      "input": "\u00ad\u200b\u2060\ufeff",
      "input_code_points": "00AD 200B 2060 FEFF",
      "expected": "",
      "expected_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    },
    {
      "id": "B33",
      "origin": "001b",
      "title": "next line and line and paragraph separators only normalize to empty",
      "input": "\u0085\u2028\u2029",
      "input_code_points": "0085 2028 2029",
      "expected": "",
      "expected_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    },
    {
      "id": "B34",
      "origin": "001b",
      "title": "fullwidth digits are not folded (no NFKC)",
      "input": "\uff11\uff12\uff10",
      "input_code_points": "FF11 FF12 FF10",
      "expected": "\uff11\uff12\uff10",
      "expected_sha256": "062a21590cfaa46d59314b5e0bb976ce4842e91bf24651a271f71fd5ce7d0a21"
    },
    {
      "id": "B35",
      "origin": "001b",
      "title": "Arabic-Indic digits stay",
      "input": "\u0661\u0662\u0660",
      "input_code_points": "0661 0662 0660",
      "expected": "\u0661\u0662\u0660",
      "expected_sha256": "82554d34337ffe3eff97ae7ffc26b7b8d0264a777889df69f8b87c387c917bb5"
    },
    {
      "id": "B36",
      "origin": "001b",
      "title": "thin space inside a number becomes a space",
      "input": "1\u2009204",
      "input_code_points": "0031 2009 0032 0030 0034",
      "expected": "1 204",
      "expected_sha256": "9e3efb83bcc6a80e4381aee3b5571368b40c0c0cc09a2ca45e248aae50026439"
    },
    {
      "id": "B37",
      "origin": "001b",
      "title": "curly quotes around an ellipsis",
      "input": "\u201c\u2026\u201d",
      "input_code_points": "201C 2026 201D",
      "expected": "\"...\"",
      "expected_sha256": "df4d4b02de4c4fc19047c9c3a5a3764b522093a88aaaa737b270940626e62e64"
    },
    {
      "id": "B38",
      "origin": "001b",
      "title": "a dash between no-break spaces",
      "input": "a\u00a0\u2014\u00a0b",
      "input_code_points": "0061 00A0 2014 00A0 0062",
      "expected": "a - b",
      "expected_sha256": "5a079debdfff12da1d964e8d70c9517ee439bec8f4dacfbc05277931c3b8f778"
    },
    {
      "id": "B39",
      "origin": "001b",
      "title": "removed characters inside leading white space",
      "input": "\u200b \u00ad a",
      "input_code_points": "200B 0020 00AD 0020 0061",
      "expected": "a",
      "expected_sha256": "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"
    },
    {
      "id": "B40",
      "origin": "001b",
      "title": "case and punctuation survive",
      "input": "P<0.05; p<0.05.",
      "input_code_points": "0050 003C 0030 002E 0030 0035 003B 0020 0070 003C 0030 002E 0030 0035 002E",
      "expected": "P<0.05; p<0.05.",
      "expected_sha256": "d610f3154b3377a522f60eda7381998e82187f4547fc85ee9ceee82f9048d0b7"
    }
  ],
  "matching": [
    {
      "id": "M01",
      "title": "unique match",
      "quote": "type 2 diabetes",
      "snapshot": "Adults with type 2 diabetes were randomized (n = 120).",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 15,
      "expected_normalized": [
        [
          12,
          27
        ]
      ],
      "expected_exact": [
        [
          12,
          27
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          12,
          27
        ]
      ]
    },
    {
      "id": "M02",
      "title": "no match",
      "quote": "type 1 diabetes",
      "snapshot": "Adults with type 2 diabetes were randomized (n = 120).",
      "expected_kind": "not_found",
      "invalid_problems": [],
      "normalized_quote_length": 15,
      "expected_normalized": [],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M03",
      "title": "overlapping occurrences all count",
      "quote": "aaa",
      "snapshot": "aaaaa",
      "expected_kind": "multiple",
      "invalid_problems": [],
      "normalized_quote_length": 3,
      "expected_normalized": [
        [
          0,
          3
        ],
        [
          1,
          4
        ],
        [
          2,
          5
        ]
      ],
      "expected_exact": [
        [
          0,
          3
        ],
        [
          1,
          4
        ],
        [
          2,
          5
        ]
      ],
      "expected_exact_snapped": [
        false,
        false,
        false
      ],
      "expected_exact_utf16": [
        [
          0,
          3
        ],
        [
          1,
          4
        ],
        [
          2,
          5
        ]
      ]
    },
    {
      "id": "M04",
      "title": "case is significant",
      "quote": "placebo",
      "snapshot": "Placebo-controlled",
      "expected_kind": "not_found",
      "invalid_problems": [],
      "normalized_quote_length": 7,
      "expected_normalized": [],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M05",
      "title": "a precomposed quote finds a decomposed copy",
      "quote": "caf\u00e9",
      "snapshot": "cafe\u0301 au lait",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 4,
      "expected_normalized": [
        [
          0,
          4
        ]
      ],
      "expected_exact": [
        [
          0,
          5
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          0,
          5
        ]
      ]
    },
    {
      "id": "M06",
      "title": "a removed soft hyphen stays inside the exact range",
      "quote": "randomized",
      "snapshot": "ran\u00addomized trial",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 10,
      "expected_normalized": [
        [
          0,
          10
        ]
      ],
      "expected_exact": [
        [
          0,
          11
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          0,
          11
        ]
      ]
    },
    {
      "id": "M07",
      "title": "an ellipsis matches three full stops",
      "quote": "A ... B",
      "snapshot": "A \u2026 B",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 7,
      "expected_normalized": [
        [
          0,
          7
        ]
      ],
      "expected_exact": [
        [
          0,
          5
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          0,
          5
        ]
      ]
    },
    {
      "id": "M08",
      "title": "a match ending inside an expanded ellipsis snaps to the whole character",
      "quote": "t..",
      "snapshot": "wait\u2026then",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 3,
      "expected_normalized": [
        [
          3,
          6
        ]
      ],
      "expected_exact": [
        [
          3,
          5
        ]
      ],
      "expected_exact_snapped": [
        true
      ],
      "expected_exact_utf16": [
        [
          3,
          5
        ]
      ]
    },
    {
      "id": "M09",
      "title": "an ellipsis is not a wildcard",
      "quote": "A ... B",
      "snapshot": "A big B",
      "expected_kind": "not_found",
      "invalid_problems": [],
      "normalized_quote_length": 7,
      "expected_normalized": [],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M10",
      "title": "spacing around punctuation counts",
      "quote": "p < 0.001",
      "snapshot": "p<0.001",
      "expected_kind": "not_found",
      "invalid_problems": [],
      "normalized_quote_length": 9,
      "expected_normalized": [],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M11",
      "title": "thin and narrow no-break spaces match a space",
      "quote": "p < 0.001",
      "snapshot": "p\u2009<\u202f0.001",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 9,
      "expected_normalized": [
        [
          0,
          9
        ]
      ],
      "expected_exact": [
        [
          0,
          9
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          0,
          9
        ]
      ]
    },
    {
      "id": "M12",
      "title": "a quote of punctuation only is invalid",
      "quote": "...",
      "snapshot": "Adults with type 2 diabetes were randomized (n = 120).",
      "expected_kind": "invalid",
      "invalid_problems": [
        "no_letter_or_digit"
      ],
      "normalized_quote_length": 3,
      "expected_normalized": [],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M13",
      "title": "punctuation and spaces only is invalid",
      "quote": "-- ;",
      "snapshot": "Adults with type 2 diabetes were randomized (n = 120).",
      "expected_kind": "invalid",
      "invalid_problems": [
        "no_letter_or_digit"
      ],
      "normalized_quote_length": 4,
      "expected_normalized": [],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M14",
      "title": "two characters are too short",
      "quote": "ab",
      "snapshot": "Adults with type 2 diabetes were randomized (n = 120).",
      "expected_kind": "invalid",
      "invalid_problems": [
        "quote_too_short",
        "normalized_too_short"
      ],
      "normalized_quote_length": 2,
      "expected_normalized": [
        [
          21,
          23
        ]
      ],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M15",
      "title": "too short once normalized",
      "quote": "a  \u00ad",
      "snapshot": "Adults with type 2 diabetes were randomized (n = 120).",
      "expected_kind": "invalid",
      "invalid_problems": [
        "normalized_too_short"
      ],
      "normalized_quote_length": 1,
      "expected_normalized": [
        [
          21,
          22
        ],
        [
          34,
          35
        ]
      ],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M16",
      "title": "1,001 characters are too long",
      "quote": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "snapshot": "Adults with type 2 diabetes were randomized (n = 120).",
      "expected_kind": "invalid",
      "invalid_problems": [
        "quote_too_long",
        "normalized_too_long"
      ],
      "normalized_quote_length": 1001,
      "expected_normalized": [],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M17",
      "title": "too long as stored even though short once normalized",
      "quote": "a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        b",
      "snapshot": "a b",
      "expected_kind": "invalid",
      "invalid_problems": [
        "quote_too_long"
      ],
      "normalized_quote_length": 3,
      "expected_normalized": [
        [
          0,
          3
        ]
      ],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M18",
      "title": "offsets count code points, not UTF-16 units",
      "quote": "120 randomized",
      "snapshot": "\ud83d\ude00 120 randomized; 120 analysed",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 14,
      "expected_normalized": [
        [
          2,
          16
        ]
      ],
      "expected_exact": [
        [
          2,
          16
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          3,
          17
        ]
      ]
    },
    {
      "id": "M19",
      "title": "two emoji are two characters: too short",
      "quote": "\ud83d\ude00\ud83d\ude00",
      "snapshot": "\ud83d\ude00\ud83d\ude00\ud83d\ude00",
      "expected_kind": "invalid",
      "invalid_problems": [
        "quote_too_short",
        "normalized_too_short",
        "no_letter_or_digit"
      ],
      "normalized_quote_length": 2,
      "expected_normalized": [
        [
          0,
          2
        ],
        [
          1,
          3
        ]
      ],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M20",
      "title": "combining characters shift exact offsets",
      "quote": "ana",
      "snapshot": "Man\u0303ana trial",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 3,
      "expected_normalized": [
        [
          3,
          6
        ]
      ],
      "expected_exact": [
        [
          4,
          7
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          4,
          7
        ]
      ]
    },
    {
      "id": "M21",
      "title": "several matches come with their positions",
      "quote": "received drug X",
      "snapshot": "Group A received drug X. Group B received placebo. Group C received drug X.",
      "expected_kind": "multiple",
      "invalid_problems": [],
      "normalized_quote_length": 15,
      "expected_normalized": [
        [
          8,
          23
        ],
        [
          59,
          74
        ]
      ],
      "expected_exact": [
        [
          8,
          23
        ],
        [
          59,
          74
        ]
      ],
      "expected_exact_snapped": [
        false,
        false
      ],
      "expected_exact_utf16": [
        [
          8,
          23
        ],
        [
          59,
          74
        ]
      ]
    },
    {
      "id": "M22",
      "title": "each input is normalized exactly once",
      "quote": "\u00e9tude",
      "snapshot": "e\u00ad\u0301tude",
      "expected_kind": "not_found",
      "invalid_problems": [],
      "normalized_quote_length": 5,
      "expected_normalized": [],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M23",
      "title": "a decomposed quote finds a precomposed copy",
      "quote": "e\u0301tude",
      "snapshot": "\u00e9tude",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 5,
      "expected_normalized": [
        [
          0,
          5
        ]
      ],
      "expected_exact": [
        [
          0,
          5
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          0,
          5
        ]
      ]
    },
    {
      "id": "M24",
      "title": "a line break matches a space and maps to both characters",
      "quote": "line second",
      "snapshot": "first line\r\nsecond line",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 11,
      "expected_normalized": [
        [
          6,
          17
        ]
      ],
      "expected_exact": [
        [
          6,
          18
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          6,
          18
        ]
      ]
    },
    {
      "id": "M25",
      "title": "overlapping occurrences inside a word",
      "quote": "ana",
      "snapshot": "banana",
      "expected_kind": "multiple",
      "invalid_problems": [],
      "normalized_quote_length": 3,
      "expected_normalized": [
        [
          1,
          4
        ],
        [
          3,
          6
        ]
      ],
      "expected_exact": [
        [
          1,
          4
        ],
        [
          3,
          6
        ]
      ],
      "expected_exact_snapped": [
        false,
        false
      ],
      "expected_exact_utf16": [
        [
          1,
          4
        ],
        [
          3,
          6
        ]
      ]
    },
    {
      "id": "M26",
      "title": "white space around the quote is normalized away",
      "quote": "  type 2 ",
      "snapshot": "Adults with type 2 diabetes were randomized (n = 120).",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 6,
      "expected_normalized": [
        [
          12,
          18
        ]
      ],
      "expected_exact": [
        [
          12,
          18
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          12,
          18
        ]
      ]
    },
    {
      "id": "M27",
      "title": "a no-break space in the copy matches a space",
      "quote": "10 mg",
      "snapshot": "10\u00a0mg daily",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 5,
      "expected_normalized": [
        [
          0,
          5
        ]
      ],
      "expected_exact": [
        [
          0,
          5
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          0,
          5
        ]
      ]
    },
    {
      "id": "M28",
      "title": "the micro sign in the copy matches mu",
      "quote": "5 \u03bcg",
      "snapshot": "5 \u00b5g/kg",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 4,
      "expected_normalized": [
        [
          0,
          4
        ]
      ],
      "expected_exact": [
        [
          0,
          4
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          0,
          4
        ]
      ]
    },
    {
      "id": "M29",
      "title": "a superscript never matches a digit",
      "quote": "105 cells",
      "snapshot": "10\u2075 cells",
      "expected_kind": "not_found",
      "invalid_problems": [],
      "normalized_quote_length": 9,
      "expected_normalized": [],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M30",
      "title": "an en dash matches a hyphen",
      "quote": "12-14 weeks",
      "snapshot": "12\u201314 weeks",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 11,
      "expected_normalized": [
        [
          0,
          11
        ]
      ],
      "expected_exact": [
        [
          0,
          11
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          0,
          11
        ]
      ]
    },
    {
      "id": "M31",
      "title": "a quote equal to the whole copy",
      "quote": "Placebo.",
      "snapshot": "Placebo.",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 8,
      "expected_normalized": [
        [
          0,
          8
        ]
      ],
      "expected_exact": [
        [
          0,
          8
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          0,
          8
        ]
      ]
    },
    {
      "id": "M32",
      "title": "trailing white space of the copy is trimmed",
      "quote": "here.",
      "snapshot": "ends here.  ",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 5,
      "expected_normalized": [
        [
          5,
          10
        ]
      ],
      "expected_exact": [
        [
          5,
          10
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          5,
          10
        ]
      ]
    },
    {
      "id": "M33",
      "title": "a match ending inside one ellipsis of two",
      "quote": "1..",
      "snapshot": "1\u2026\u20262",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 3,
      "expected_normalized": [
        [
          0,
          3
        ]
      ],
      "expected_exact": [
        [
          0,
          2
        ]
      ],
      "expected_exact_snapped": [
        true
      ],
      "expected_exact_utf16": [
        [
          0,
          2
        ]
      ]
    },
    {
      "id": "M34",
      "title": "a zero-width space inside the quote is removed before matching",
      "quote": "type 2\u200b diabetes",
      "snapshot": "Adults with type 2 diabetes were randomized (n = 120).",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 15,
      "expected_normalized": [
        [
          12,
          27
        ]
      ],
      "expected_exact": [
        [
          12,
          27
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          12,
          27
        ]
      ]
    },
    {
      "id": "M35",
      "title": "a word joiner inside a word is removed",
      "quote": "dia\u2060betes",
      "snapshot": "Adults with type 2 diabetes were randomized (n = 120).",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 8,
      "expected_normalized": [
        [
          19,
          27
        ]
      ],
      "expected_exact": [
        [
          19,
          27
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          19,
          27
        ]
      ]
    },
    {
      "id": "M36",
      "title": "a subscript is not a digit",
      "quote": "H2O",
      "snapshot": "Water (H\u2082O) was given.",
      "expected_kind": "not_found",
      "invalid_problems": [],
      "normalized_quote_length": 3,
      "expected_normalized": [],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M37",
      "title": "a subscript quote finds its subscript",
      "quote": "H\u2082O",
      "snapshot": "Water (H\u2082O) was given.",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 3,
      "expected_normalized": [
        [
          7,
          10
        ]
      ],
      "expected_exact": [
        [
          7,
          10
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          7,
          10
        ]
      ]
    },
    {
      "id": "M38",
      "title": "a degree sign is not a masculine ordinal",
      "quote": "37 \u00baC",
      "snapshot": "Incubated at 37 \u00b0C.",
      "expected_kind": "not_found",
      "invalid_problems": [],
      "normalized_quote_length": 5,
      "expected_normalized": [],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M39",
      "title": "a unit with a superscript matches exactly",
      "quote": "10\u2079/L",
      "snapshot": "Platelets 150 \u00d7 10\u2079/L.",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 5,
      "expected_normalized": [
        [
          16,
          21
        ]
      ],
      "expected_exact": [
        [
          16,
          21
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          16,
          21
        ]
      ]
    },
    {
      "id": "M40",
      "title": "circled letters are letters (Unicode Alphabetic)",
      "quote": "\u24d0\u24d1\u24d2",
      "snapshot": "Groups \u24d0\u24d1\u24d2 were compared.",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 3,
      "expected_normalized": [
        [
          7,
          10
        ]
      ],
      "expected_exact": [
        [
          7,
          10
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          7,
          10
        ]
      ]
    },
    {
      "id": "M41",
      "title": "Arabic-Indic digits alone are not a letter or an ASCII digit",
      "quote": "\u0661\u0662\u0660",
      "snapshot": "n = \u0661\u0662\u0660 randomized",
      "expected_kind": "invalid",
      "invalid_problems": [
        "no_letter_or_digit"
      ],
      "normalized_quote_length": 3,
      "expected_normalized": [
        [
          4,
          7
        ]
      ],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M42",
      "title": "vulgar fractions alone are not digits",
      "quote": "\u00bd \u00bd",
      "snapshot": "\u00bd \u00bd dose",
      "expected_kind": "invalid",
      "invalid_problems": [
        "no_letter_or_digit"
      ],
      "normalized_quote_length": 3,
      "expected_normalized": [
        [
          0,
          3
        ]
      ],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M43",
      "title": "a Roman numeral is a letter number (Alphabetic)",
      "quote": "\u216b\u216b\u216b",
      "snapshot": "Phase \u216b\u216b\u216b.",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 3,
      "expected_normalized": [
        [
          6,
          9
        ]
      ],
      "expected_exact": [
        [
          6,
          9
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          6,
          9
        ]
      ]
    },
    {
      "id": "M44",
      "title": "invisible characters only: empty once normalized",
      "quote": "\u200b\u200b\u200b\u2060",
      "snapshot": "Adults with type 2 diabetes were randomized (n = 120).",
      "expected_kind": "invalid",
      "invalid_problems": [
        "normalized_too_short",
        "no_letter_or_digit"
      ],
      "normalized_quote_length": 0,
      "expected_normalized": [],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    },
    {
      "id": "M45",
      "title": "a match at the very start of the copy",
      "quote": "Adults with",
      "snapshot": "Adults with type 2 diabetes were randomized (n = 120).",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 11,
      "expected_normalized": [
        [
          0,
          11
        ]
      ],
      "expected_exact": [
        [
          0,
          11
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          0,
          11
        ]
      ]
    },
    {
      "id": "M46",
      "title": "a match at the very end of the copy",
      "quote": "(n = 120).",
      "snapshot": "Adults with type 2 diabetes were randomized (n = 120).",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 10,
      "expected_normalized": [
        [
          44,
          54
        ]
      ],
      "expected_exact": [
        [
          44,
          54
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          44,
          54
        ]
      ]
    },
    {
      "id": "M47",
      "title": "leading white space of the copy is trimmed before offsets",
      "quote": "Adults",
      "snapshot": "  \u00a0Adults first.",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 6,
      "expected_normalized": [
        [
          0,
          6
        ]
      ],
      "expected_exact": [
        [
          3,
          9
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          3,
          9
        ]
      ]
    },
    {
      "id": "M48",
      "title": "a decomposed letter in the middle of a quote",
      "quote": "nai\u0308ve",
      "snapshot": "A na\u00efve design.",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 5,
      "expected_normalized": [
        [
          2,
          7
        ]
      ],
      "expected_exact": [
        [
          2,
          7
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          2,
          7
        ]
      ]
    },
    {
      "id": "M49",
      "title": "an astral letter in the quote is one character",
      "quote": "x\ud835\udc00y",
      "snapshot": "Model x\ud835\udc00y fitted.",
      "expected_kind": "unique",
      "invalid_problems": [],
      "normalized_quote_length": 3,
      "expected_normalized": [
        [
          6,
          9
        ]
      ],
      "expected_exact": [
        [
          6,
          9
        ]
      ],
      "expected_exact_snapped": [
        false
      ],
      "expected_exact_utf16": [
        [
          6,
          10
        ]
      ]
    },
    {
      "id": "M50",
      "title": "100 overlapping occurrences are all enumerated",
      "quote": "aaa",
      "snapshot": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "expected_kind": "multiple",
      "invalid_problems": [],
      "normalized_quote_length": 3,
      "expected_normalized": [
        [
          0,
          3
        ],
        [
          1,
          4
        ],
        [
          2,
          5
        ],
        [
          3,
          6
        ],
        [
          4,
          7
        ],
        [
          5,
          8
        ],
        [
          6,
          9
        ],
        [
          7,
          10
        ],
        [
          8,
          11
        ],
        [
          9,
          12
        ],
        [
          10,
          13
        ],
        [
          11,
          14
        ],
        [
          12,
          15
        ],
        [
          13,
          16
        ],
        [
          14,
          17
        ],
        [
          15,
          18
        ],
        [
          16,
          19
        ],
        [
          17,
          20
        ],
        [
          18,
          21
        ],
        [
          19,
          22
        ],
        [
          20,
          23
        ],
        [
          21,
          24
        ],
        [
          22,
          25
        ],
        [
          23,
          26
        ],
        [
          24,
          27
        ],
        [
          25,
          28
        ],
        [
          26,
          29
        ],
        [
          27,
          30
        ],
        [
          28,
          31
        ],
        [
          29,
          32
        ],
        [
          30,
          33
        ],
        [
          31,
          34
        ],
        [
          32,
          35
        ],
        [
          33,
          36
        ],
        [
          34,
          37
        ],
        [
          35,
          38
        ],
        [
          36,
          39
        ],
        [
          37,
          40
        ],
        [
          38,
          41
        ],
        [
          39,
          42
        ],
        [
          40,
          43
        ],
        [
          41,
          44
        ],
        [
          42,
          45
        ],
        [
          43,
          46
        ],
        [
          44,
          47
        ],
        [
          45,
          48
        ],
        [
          46,
          49
        ],
        [
          47,
          50
        ],
        [
          48,
          51
        ],
        [
          49,
          52
        ],
        [
          50,
          53
        ],
        [
          51,
          54
        ],
        [
          52,
          55
        ],
        [
          53,
          56
        ],
        [
          54,
          57
        ],
        [
          55,
          58
        ],
        [
          56,
          59
        ],
        [
          57,
          60
        ],
        [
          58,
          61
        ],
        [
          59,
          62
        ],
        [
          60,
          63
        ],
        [
          61,
          64
        ],
        [
          62,
          65
        ],
        [
          63,
          66
        ],
        [
          64,
          67
        ],
        [
          65,
          68
        ],
        [
          66,
          69
        ],
        [
          67,
          70
        ],
        [
          68,
          71
        ],
        [
          69,
          72
        ],
        [
          70,
          73
        ],
        [
          71,
          74
        ],
        [
          72,
          75
        ],
        [
          73,
          76
        ],
        [
          74,
          77
        ],
        [
          75,
          78
        ],
        [
          76,
          79
        ],
        [
          77,
          80
        ],
        [
          78,
          81
        ],
        [
          79,
          82
        ],
        [
          80,
          83
        ],
        [
          81,
          84
        ],
        [
          82,
          85
        ],
        [
          83,
          86
        ],
        [
          84,
          87
        ],
        [
          85,
          88
        ],
        [
          86,
          89
        ],
        [
          87,
          90
        ],
        [
          88,
          91
        ],
        [
          89,
          92
        ],
        [
          90,
          93
        ],
        [
          91,
          94
        ],
        [
          92,
          95
        ],
        [
          93,
          96
        ],
        [
          94,
          97
        ],
        [
          95,
          98
        ],
        [
          96,
          99
        ],
        [
          97,
          100
        ],
        [
          98,
          101
        ],
        [
          99,
          102
        ]
      ],
      "expected_exact": [
        [
          0,
          3
        ],
        [
          1,
          4
        ],
        [
          2,
          5
        ],
        [
          3,
          6
        ],
        [
          4,
          7
        ],
        [
          5,
          8
        ],
        [
          6,
          9
        ],
        [
          7,
          10
        ],
        [
          8,
          11
        ],
        [
          9,
          12
        ],
        [
          10,
          13
        ],
        [
          11,
          14
        ],
        [
          12,
          15
        ],
        [
          13,
          16
        ],
        [
          14,
          17
        ],
        [
          15,
          18
        ],
        [
          16,
          19
        ],
        [
          17,
          20
        ],
        [
          18,
          21
        ],
        [
          19,
          22
        ],
        [
          20,
          23
        ],
        [
          21,
          24
        ],
        [
          22,
          25
        ],
        [
          23,
          26
        ],
        [
          24,
          27
        ],
        [
          25,
          28
        ],
        [
          26,
          29
        ],
        [
          27,
          30
        ],
        [
          28,
          31
        ],
        [
          29,
          32
        ],
        [
          30,
          33
        ],
        [
          31,
          34
        ],
        [
          32,
          35
        ],
        [
          33,
          36
        ],
        [
          34,
          37
        ],
        [
          35,
          38
        ],
        [
          36,
          39
        ],
        [
          37,
          40
        ],
        [
          38,
          41
        ],
        [
          39,
          42
        ],
        [
          40,
          43
        ],
        [
          41,
          44
        ],
        [
          42,
          45
        ],
        [
          43,
          46
        ],
        [
          44,
          47
        ],
        [
          45,
          48
        ],
        [
          46,
          49
        ],
        [
          47,
          50
        ],
        [
          48,
          51
        ],
        [
          49,
          52
        ],
        [
          50,
          53
        ],
        [
          51,
          54
        ],
        [
          52,
          55
        ],
        [
          53,
          56
        ],
        [
          54,
          57
        ],
        [
          55,
          58
        ],
        [
          56,
          59
        ],
        [
          57,
          60
        ],
        [
          58,
          61
        ],
        [
          59,
          62
        ],
        [
          60,
          63
        ],
        [
          61,
          64
        ],
        [
          62,
          65
        ],
        [
          63,
          66
        ],
        [
          64,
          67
        ],
        [
          65,
          68
        ],
        [
          66,
          69
        ],
        [
          67,
          70
        ],
        [
          68,
          71
        ],
        [
          69,
          72
        ],
        [
          70,
          73
        ],
        [
          71,
          74
        ],
        [
          72,
          75
        ],
        [
          73,
          76
        ],
        [
          74,
          77
        ],
        [
          75,
          78
        ],
        [
          76,
          79
        ],
        [
          77,
          80
        ],
        [
          78,
          81
        ],
        [
          79,
          82
        ],
        [
          80,
          83
        ],
        [
          81,
          84
        ],
        [
          82,
          85
        ],
        [
          83,
          86
        ],
        [
          84,
          87
        ],
        [
          85,
          88
        ],
        [
          86,
          89
        ],
        [
          87,
          90
        ],
        [
          88,
          91
        ],
        [
          89,
          92
        ],
        [
          90,
          93
        ],
        [
          91,
          94
        ],
        [
          92,
          95
        ],
        [
          93,
          96
        ],
        [
          94,
          97
        ],
        [
          95,
          98
        ],
        [
          96,
          99
        ],
        [
          97,
          100
        ],
        [
          98,
          101
        ],
        [
          99,
          102
        ]
      ],
      "expected_exact_snapped": [
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false
      ],
      "expected_exact_utf16": [
        [
          0,
          3
        ],
        [
          1,
          4
        ],
        [
          2,
          5
        ],
        [
          3,
          6
        ],
        [
          4,
          7
        ],
        [
          5,
          8
        ],
        [
          6,
          9
        ],
        [
          7,
          10
        ],
        [
          8,
          11
        ],
        [
          9,
          12
        ],
        [
          10,
          13
        ],
        [
          11,
          14
        ],
        [
          12,
          15
        ],
        [
          13,
          16
        ],
        [
          14,
          17
        ],
        [
          15,
          18
        ],
        [
          16,
          19
        ],
        [
          17,
          20
        ],
        [
          18,
          21
        ],
        [
          19,
          22
        ],
        [
          20,
          23
        ],
        [
          21,
          24
        ],
        [
          22,
          25
        ],
        [
          23,
          26
        ],
        [
          24,
          27
        ],
        [
          25,
          28
        ],
        [
          26,
          29
        ],
        [
          27,
          30
        ],
        [
          28,
          31
        ],
        [
          29,
          32
        ],
        [
          30,
          33
        ],
        [
          31,
          34
        ],
        [
          32,
          35
        ],
        [
          33,
          36
        ],
        [
          34,
          37
        ],
        [
          35,
          38
        ],
        [
          36,
          39
        ],
        [
          37,
          40
        ],
        [
          38,
          41
        ],
        [
          39,
          42
        ],
        [
          40,
          43
        ],
        [
          41,
          44
        ],
        [
          42,
          45
        ],
        [
          43,
          46
        ],
        [
          44,
          47
        ],
        [
          45,
          48
        ],
        [
          46,
          49
        ],
        [
          47,
          50
        ],
        [
          48,
          51
        ],
        [
          49,
          52
        ],
        [
          50,
          53
        ],
        [
          51,
          54
        ],
        [
          52,
          55
        ],
        [
          53,
          56
        ],
        [
          54,
          57
        ],
        [
          55,
          58
        ],
        [
          56,
          59
        ],
        [
          57,
          60
        ],
        [
          58,
          61
        ],
        [
          59,
          62
        ],
        [
          60,
          63
        ],
        [
          61,
          64
        ],
        [
          62,
          65
        ],
        [
          63,
          66
        ],
        [
          64,
          67
        ],
        [
          65,
          68
        ],
        [
          66,
          69
        ],
        [
          67,
          70
        ],
        [
          68,
          71
        ],
        [
          69,
          72
        ],
        [
          70,
          73
        ],
        [
          71,
          74
        ],
        [
          72,
          75
        ],
        [
          73,
          76
        ],
        [
          74,
          77
        ],
        [
          75,
          78
        ],
        [
          76,
          79
        ],
        [
          77,
          80
        ],
        [
          78,
          81
        ],
        [
          79,
          82
        ],
        [
          80,
          83
        ],
        [
          81,
          84
        ],
        [
          82,
          85
        ],
        [
          83,
          86
        ],
        [
          84,
          87
        ],
        [
          85,
          88
        ],
        [
          86,
          89
        ],
        [
          87,
          90
        ],
        [
          88,
          91
        ],
        [
          89,
          92
        ],
        [
          90,
          93
        ],
        [
          91,
          94
        ],
        [
          92,
          95
        ],
        [
          93,
          96
        ],
        [
          94,
          97
        ],
        [
          95,
          98
        ],
        [
          96,
          99
        ],
        [
          97,
          100
        ],
        [
          98,
          101
        ],
        [
          99,
          102
        ]
      ]
    },
    {
      "id": "M51",
      "title": "101 occurrences are too many to enumerate",
      "quote": "aaa",
      "snapshot": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "expected_kind": "too_many",
      "invalid_problems": [],
      "normalized_quote_length": 3,
      "expected_normalized": [
        [
          0,
          3
        ],
        [
          1,
          4
        ],
        [
          2,
          5
        ],
        [
          3,
          6
        ],
        [
          4,
          7
        ],
        [
          5,
          8
        ],
        [
          6,
          9
        ],
        [
          7,
          10
        ],
        [
          8,
          11
        ],
        [
          9,
          12
        ],
        [
          10,
          13
        ],
        [
          11,
          14
        ],
        [
          12,
          15
        ],
        [
          13,
          16
        ],
        [
          14,
          17
        ],
        [
          15,
          18
        ],
        [
          16,
          19
        ],
        [
          17,
          20
        ],
        [
          18,
          21
        ],
        [
          19,
          22
        ],
        [
          20,
          23
        ],
        [
          21,
          24
        ],
        [
          22,
          25
        ],
        [
          23,
          26
        ],
        [
          24,
          27
        ],
        [
          25,
          28
        ],
        [
          26,
          29
        ],
        [
          27,
          30
        ],
        [
          28,
          31
        ],
        [
          29,
          32
        ],
        [
          30,
          33
        ],
        [
          31,
          34
        ],
        [
          32,
          35
        ],
        [
          33,
          36
        ],
        [
          34,
          37
        ],
        [
          35,
          38
        ],
        [
          36,
          39
        ],
        [
          37,
          40
        ],
        [
          38,
          41
        ],
        [
          39,
          42
        ],
        [
          40,
          43
        ],
        [
          41,
          44
        ],
        [
          42,
          45
        ],
        [
          43,
          46
        ],
        [
          44,
          47
        ],
        [
          45,
          48
        ],
        [
          46,
          49
        ],
        [
          47,
          50
        ],
        [
          48,
          51
        ],
        [
          49,
          52
        ],
        [
          50,
          53
        ],
        [
          51,
          54
        ],
        [
          52,
          55
        ],
        [
          53,
          56
        ],
        [
          54,
          57
        ],
        [
          55,
          58
        ],
        [
          56,
          59
        ],
        [
          57,
          60
        ],
        [
          58,
          61
        ],
        [
          59,
          62
        ],
        [
          60,
          63
        ],
        [
          61,
          64
        ],
        [
          62,
          65
        ],
        [
          63,
          66
        ],
        [
          64,
          67
        ],
        [
          65,
          68
        ],
        [
          66,
          69
        ],
        [
          67,
          70
        ],
        [
          68,
          71
        ],
        [
          69,
          72
        ],
        [
          70,
          73
        ],
        [
          71,
          74
        ],
        [
          72,
          75
        ],
        [
          73,
          76
        ],
        [
          74,
          77
        ],
        [
          75,
          78
        ],
        [
          76,
          79
        ],
        [
          77,
          80
        ],
        [
          78,
          81
        ],
        [
          79,
          82
        ],
        [
          80,
          83
        ],
        [
          81,
          84
        ],
        [
          82,
          85
        ],
        [
          83,
          86
        ],
        [
          84,
          87
        ],
        [
          85,
          88
        ],
        [
          86,
          89
        ],
        [
          87,
          90
        ],
        [
          88,
          91
        ],
        [
          89,
          92
        ],
        [
          90,
          93
        ],
        [
          91,
          94
        ],
        [
          92,
          95
        ],
        [
          93,
          96
        ],
        [
          94,
          97
        ],
        [
          95,
          98
        ],
        [
          96,
          99
        ],
        [
          97,
          100
        ],
        [
          98,
          101
        ],
        [
          99,
          102
        ],
        [
          100,
          103
        ]
      ],
      "expected_exact": [],
      "expected_exact_snapped": [],
      "expected_exact_utf16": []
    }
  ]
}
$fixture$::jsonb AS doc;

CREATE TEMP VIEW nv AS
SELECT e.v->>'id' AS id, e.v->>'title' AS title, e.v->>'input' AS input,
       e.v->>'input_code_points' AS input_code_points, e.v->>'expected' AS expected,
       e.v->>'expected_sha256' AS expected_sha256, e.v->>'second_pass' AS second_pass, e.ord
  FROM fixture, jsonb_array_elements(fixture.doc->'normalization') WITH ORDINALITY AS e(v, ord);

CREATE TEMP VIEW mv AS
SELECT e.v->>'id' AS id, e.v->>'title' AS title, e.v->>'quote' AS quote, e.v->>'snapshot' AS snapshot,
       (e.v->>'normalized_quote_length')::integer AS normalized_quote_length,
       e.v->'expected_normalized' AS expected_normalized,
       e.v->>'expected_kind' AS expected_kind, e.v->'invalid_problems' AS invalid_problems, e.ord
  FROM fixture, jsonb_array_elements(fixture.doc->'matching') WITH ORDINALITY AS e(v, ord);

SELECT plan(
  4
  + (SELECT 3 * count(*)::integer + count(second_pass)::integer FROM nv)
  + (SELECT 4 * count(*)::integer FROM mv));

-- F. The fixture itself -----------------------------------------------------

SELECT is((SELECT doc->>'fixture' FROM fixture), 'evidence-normalization-v1',
  'F1 the embedded document is the evidence normalization v1 fixture');
SELECT is((SELECT doc->>'normalization_version' FROM fixture), 'v1',
  'F2 its vectors are for normalization version v1');
SELECT is((SELECT count(DISTINCT id)::integer FROM (SELECT id FROM nv UNION ALL SELECT id FROM mv) AS ids),
          (SELECT count(*)::integer FROM nv) + (SELECT count(*)::integer FROM mv),
  'F3 every vector id is unique');
SELECT is((SELECT count(*)::integer FROM nv WHERE id ~ '^N(0[1-9]|[12][0-9]|30)$'), 30,
  'F4 the thirty golden vectors of suite 031 are in the fixture');

-- N. Normalization vectors --------------------------------------------------

-- lpad truncates a longer string, so pad to at least four digits, never fewer.
SELECT is(coalesce((SELECT string_agg(lpad(h.hex, greatest(4, char_length(h.hex)), '0'), ' ' ORDER BY i)
                      FROM generate_series(1, char_length(nv.input)) AS i,
                           LATERAL (SELECT upper(to_hex(ascii(substr(nv.input, i, 1)))) AS hex) AS h), ''),
          nv.input_code_points,
          nv.id || ' ' || nv.title || ': the input decodes to its recorded code points')
  FROM nv ORDER BY nv.ord;

SELECT is(public.evidence_normalize_v1(nv.input), nv.expected,
          nv.id || ' ' || nv.title || ': output')
  FROM nv ORDER BY nv.ord;

SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1(nv.input), 'UTF8')), 'hex'), nv.expected_sha256,
          nv.id || ' ' || nv.title || ': SHA-256 of the output')
  FROM nv ORDER BY nv.ord;

SELECT is(public.evidence_normalize_v1(public.evidence_normalize_v1(nv.input)), nv.second_pass,
          nv.id || ' ' || nv.title || ': a second pass differs, so each input is normalized once')
  FROM nv WHERE nv.second_pass IS NOT NULL ORDER BY nv.ord;

-- M. Matching vectors: lengths and offsets in characters --------------------

SELECT is(char_length(public.evidence_normalize_v1(mv.quote)), mv.normalized_quote_length,
          mv.id || ' ' || mv.title || ': normalized quote length in characters')
  FROM mv ORDER BY mv.ord;

SELECT is((SELECT coalesce(jsonb_agg(jsonb_build_array(i - 1, i - 1 + char_length(q.nq)) ORDER BY i), '[]'::jsonb)
             FROM (SELECT public.evidence_normalize_v1(mv.quote) AS nq,
                          public.evidence_normalize_v1(mv.snapshot) AS ns) AS q,
                  generate_series(1, greatest(char_length(q.ns) - char_length(q.nq) + 1, 0)) AS i
            WHERE char_length(q.nq) > 0 AND substr(q.ns, i, char_length(q.nq)) = q.nq),
          mv.expected_normalized,
          mv.id || ' ' || mv.title || ': every occurrence as 0-based character ranges of the normalized copy')
  FROM mv ORDER BY mv.ord;

-- L. The server's quote location (EVIDENCE-RECORDS-001A3) -------------------

SELECT is((SELECT l.status || ' ' || coalesce(l.match_count::text, '-') || ' ' || array_to_string(l.problems, ',')
             FROM public.evidence_locate_quote(ARRAY[mv.quote], mv.snapshot) AS l),
          mv.expected_kind || ' '
          || CASE WHEN mv.expected_kind IN ('invalid', 'too_many') THEN '-' ELSE jsonb_array_length(mv.expected_normalized)::text END || ' '
          || (SELECT coalesce(string_agg(p.x, ',' ORDER BY p.o), '')
                FROM jsonb_array_elements_text(mv.invalid_problems) WITH ORDINALITY AS p(x, o)),
          mv.id || ' ' || mv.title || ': evidence_locate_quote gives the kind, count and problems')
  FROM mv ORDER BY mv.ord;

SELECT is((SELECT coalesce(jsonb_agg(jsonb_build_array(u.s, u.s + l.normalized_length) ORDER BY u.i), '[]'::jsonb)
             FROM public.evidence_locate_quote(ARRAY[mv.quote], mv.snapshot) AS l,
                  unnest(l.starts) WITH ORDINALITY AS u(s, i)),
          CASE WHEN mv.expected_kind IN ('invalid', 'too_many') THEN '[]'::jsonb ELSE mv.expected_normalized END,
          mv.id || ' ' || mv.title || ': evidence_locate_quote gives every occurrence at the oracle''s offsets'
          || CASE mv.expected_kind WHEN 'invalid' THEN ' (none: an invalid quote is not located)'
                                   WHEN 'too_many' THEN ' (none: too many to enumerate)' ELSE '' END)
  FROM mv ORDER BY mv.ord;

SELECT * FROM finish();
ROLLBACK;
