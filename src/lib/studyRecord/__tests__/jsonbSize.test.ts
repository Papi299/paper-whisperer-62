import { describe, expect, it } from "vitest";
import { jsonbTextByteLength, utf8ByteLength } from "../jsonbSize";

/**
 * `evidence_save_changes` refuses `octet_length(p_changes::text) > 65536`.
 * The expected texts below are what PostgreSQL 17 prints for these values
 * (`select v::jsonb::text`): a space after every key's colon and after every
 * comma, keys reordered (shorter first), strings escaped like JSON. Key order
 * changes no length, so each expectation is the byte length of that text.
 */
const cases: [string, unknown, string][] = [
  ["an empty array", [], "[]"],
  ["an empty object", {}, "{}"],
  ["scalars", [1, null, true, "x"], '[1, null, true, "x"]'],
  ["a nested object", { op: "set_value", target: { scope: "study" } }, '{"op": "set_value", "target": {"scope": "study"}}'],
  ["arrays of objects", [{ a: 1 }, { b: [1, 2] }], '[{"a": 1}, {"b": [1, 2]}]'],
  ["escapes", { t: 'a"b\\c\nd\te' }, '{"t": "a\\"b\\\\c\\nd\\te"}'],
  ["a control character", { t: String.fromCodePoint(0x1f) }, '{"t": "\\u001f"}'],
];

describe("jsonbTextByteLength", () => {
  it.each(cases)("measures %s as PostgreSQL prints it", (_label, value, printed) => {
    expect(jsonbTextByteLength(value)).toBe(utf8ByteLength(printed));
  });

  it("counts UTF-8 bytes, not UTF-16 units: thin spaces, superscripts and astral characters", () => {
    const thin = String.fromCodePoint(0x2009); // 3 bytes
    const squared = String.fromCodePoint(0x00b2); // 2 bytes
    const astral = String.fromCodePoint(0x1d4b3); // 4 bytes, 2 UTF-16 units
    const value = { q: `30${thin}kg/m${squared}${astral}` };
    // {"q": "30 kg/m² 𝒳"} → 9 bytes of structure + 2 + 3 + 4 + 2 + 4
    expect(jsonbTextByteLength(value)).toBe(9 + 2 + 3 + 4 + 2 + 4);
    expect(jsonbTextByteLength(value)).toBeGreaterThan(JSON.stringify(value).length);
  });

  it("ignores members whose value is undefined, as JSON does", () => {
    expect(jsonbTextByteLength({ a: 1, b: undefined })).toBe(utf8ByteLength('{"a": 1}'));
  });
});
