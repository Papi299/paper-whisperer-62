import { describe, it, expect } from "vitest";
import { toSafeExternalHref } from "@/lib/externalUrl";

describe("toSafeExternalHref — accepted", () => {
  const accepted: [label: string, input: string, expected: string][] = [
    ["https origin", "https://example.com", "https://example.com/"],
    [
      "https with path, query and fragment",
      "https://example.com/path?q=1#fragment",
      "https://example.com/path?q=1#fragment",
    ],
    ["http origin", "http://example.com", "http://example.com/"],
    ["surrounding whitespace", "  https://example.com/paper  ", "https://example.com/paper"],
    ["surrounding newlines/tabs", "\n\thttps://example.com/paper\t\n", "https://example.com/paper"],
    ["uppercase scheme is normalized", "HTTPS://example.com/paper", "https://example.com/paper"],
    ["mixed-case scheme is normalized", "HtTp://example.com/paper", "http://example.com/paper"],
    ["explicit port", "https://example.com:8443/a", "https://example.com:8443/a"],
    [
      "supabase-style signed attachment URL",
      "https://abcdefgh.supabase.co/storage/v1/object/sign/attachments/u1/file.pdf?token=eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ4In0.sig",
      "https://abcdefgh.supabase.co/storage/v1/object/sign/attachments/u1/file.pdf?token=eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ4In0.sig",
    ],
    [
      "generated google scholar URL",
      "https://scholar.google.com/scholar?q=A%20paper%20title",
      "https://scholar.google.com/scholar?q=A%20paper%20title",
    ],
    [
      "generated pubmed URL",
      "https://pubmed.ncbi.nlm.nih.gov/12345678/",
      "https://pubmed.ncbi.nlm.nih.gov/12345678/",
    ],
    ["doi resolver URL", "https://doi.org/10.1234/abc", "https://doi.org/10.1234/abc"],
    [
      "google drive URL",
      "https://drive.google.com/file/d/1a2b3c/view",
      "https://drive.google.com/file/d/1a2b3c/view",
    ],
  ];

  it.each(accepted)("accepts %s", (_label, input, expected) => {
    expect(toSafeExternalHref(input)).toBe(expected);
  });
});

describe("toSafeExternalHref — rejected", () => {
  const rejected: [label: string, input: string | null | undefined][] = [
    // Script-executing schemes.
    ["javascript:", "javascript:alert(1)"],
    ["uppercase JAVASCRIPT:", "JAVASCRIPT:alert(1)"],
    ["mixed-case JaVaScRiPt:", "JaVaScRiPt:alert(1)"],
    ["leading whitespace + javascript:", "   javascript:alert(1)"],
    ["leading newline + javascript:", "\njavascript:alert(1)"],
    ["vbscript:", "vbscript:msgbox(1)"],

    // Obfuscation the WHATWG parser normalizes away. A textual check on the
    // raw string would miss these; comparing the parsed protocol does not.
    ["tab inside the scheme", "java\tscript:alert(1)"],
    ["newline inside the scheme", "java\nscript:alert(1)"],
    ["carriage return inside the scheme", "java\rscript:alert(1)"],
    ["tab+newline inside the scheme", "ja\tva\nscript:alert(1)"],
    ["leading NUL control character", "\u0000javascript:alert(1)"],
    ["leading C0 control characters", "\u0001\u0002javascript:alert(1)"],
    ["mixed case + tab obfuscation", "Ja\tVa\nScRiPt:alert(1)"],
    ["tab inside vbscript:", "vb\tscript:msgbox(1)"],

    // Other non-navigable schemes.
    ["data: html", "data:text/html,<h1>test</h1>"],
    ["data: base64 html", "data:text/html;base64,PGgxPnRlc3Q8L2gxPg=="],
    ["file:", "file:///etc/passwd"],
    ["ftp:", "ftp://example.com/file"],
    ["mailto:", "mailto:test@example.com"],
    ["tel:", "tel:+15551234567"],
    ["blob:", "blob:https://example.com/550e8400-e29b-41d4-a716-446655440000"],
    ["custom app scheme", "myapp://open/thing"],
    ["about:", "about:blank"],

    // Non-absolute inputs: these would otherwise resolve against the app origin.
    ["scheme-relative", "//example.com/path"],
    ["backslash scheme-relative", "\\\\example.com/path"],
    ["root-relative path", "/example/path"],
    ["relative path", "example/path"],
    ["bare hostname with path", "example.com/path"],
    ["bare hostname", "example.com"],

    // Malformed / empty.
    ["free text", "not a url"],
    ["scheme with no host", "https://"],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["tab/newline only", "\t\n  \r"],
    ["null", null],
    ["undefined", undefined],
  ];

  it.each(rejected)("rejects %s", (_label, input) => {
    expect(toSafeExternalHref(input)).toBeNull();
  });

  it("rejects non-string values defensively", () => {
    // Values read back from the database and from parsed import files are not
    // type-checked at runtime, so a non-string must fail closed, not throw.
    expect(toSafeExternalHref(42 as unknown as string)).toBeNull();
    expect(toSafeExternalHref({} as unknown as string)).toBeNull();
  });
});

describe("toSafeExternalHref — never repairs unsafe input", () => {
  it("does not prepend a scheme to a bare hostname", () => {
    expect(toSafeExternalHref("example.com")).toBeNull();
  });

  it("does not rewrite a rejected scheme into http(s)", () => {
    for (const input of ["ftp://example.com/file", "file:///etc/passwd", "javascript:alert(1)"]) {
      expect(toSafeExternalHref(input)).toBeNull();
    }
  });

  it("preserves the query string of an accepted URL verbatim", () => {
    const signed = "https://example.com/o?token=a.b-c_d&x=1";
    expect(toSafeExternalHref(signed)).toBe(signed);
  });
});
