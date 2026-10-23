/**
 * The size `evidence_save_changes` measures a batch by (EVIDENCE-RECORDS-001C1).
 *
 * The RPC refuses a batch when `octet_length(p_changes::text) > 65536`: the
 * UTF-8 length of the batch as PostgreSQL's jsonb prints it. That text differs
 * from `JSON.stringify` in exactly one way that matters for length: jsonb
 * prints a space after every `:` between a key and its value, and after every
 * `,` between object members or array elements. Strings are escaped the same
 * way by both (`"`, `\`, the five short escapes, `\u00XX` for the other
 * control characters, everything else as raw UTF-8), integers print the same,
 * and key order — which jsonb changes — does not change the length.
 *
 * So the length is computed, not estimated: the compact JSON's UTF-8 bytes
 * plus one byte per separator space. A batch that fits by this count fits on
 * the server.
 */

const encoder = new TextEncoder();

/** UTF-8 bytes of `text`. */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

function separatorSpaces(value: unknown): number {
  if (Array.isArray(value)) {
    let spaces = value.length > 1 ? value.length - 1 : 0;
    for (const element of value) spaces += separatorSpaces(element);
    return spaces;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, member]) => member !== undefined);
    // ": " after each key, ", " between members.
    let spaces = entries.length > 0 ? entries.length * 2 - 1 : 0;
    for (const [, member] of entries) spaces += separatorSpaces(member);
    return spaces;
  }
  return 0;
}

/** `octet_length(value::jsonb::text)` for a JSON-serializable value. */
export function jsonbTextByteLength(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value)) + separatorSpaces(value);
}
