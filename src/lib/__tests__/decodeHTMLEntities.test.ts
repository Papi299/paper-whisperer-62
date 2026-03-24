import { describe, it, expect } from "vitest";
import { decodeHTMLEntities } from "../decodeHTMLEntities";

describe("decodeHTMLEntities", () => {
  it("decodes hex numeric entities", () => {
    expect(decodeHTMLEntities("&#x2009;")).toBe("\u2009"); // thin space
    expect(decodeHTMLEntities("&#xb1;")).toBe("±");
    expect(decodeHTMLEntities("&#x2013;")).toBe("–"); // en-dash
    expect(decodeHTMLEntities("&#x2265;")).toBe("≥");
  });

  it("decodes decimal numeric entities", () => {
    expect(decodeHTMLEntities("&#177;")).toBe("±");
    expect(decodeHTMLEntities("&#8201;")).toBe("\u2009"); // thin space
  });

  it("decodes common named entities", () => {
    expect(decodeHTMLEntities("&amp;")).toBe("&");
    expect(decodeHTMLEntities("&lt;")).toBe("<");
    expect(decodeHTMLEntities("&gt;")).toBe(">");
    expect(decodeHTMLEntities("&quot;")).toBe('"');
    expect(decodeHTMLEntities("&apos;")).toBe("'");
    expect(decodeHTMLEntities("&nbsp;")).toBe("\u00A0");
  });

  it("decodes mixed content from the reported bug", () => {
    const input = "46.4&#x2009;&#xb1;&#x2009;1.4 yr, body mass index (BMI) 32.3&#x2009;&#xb1;&#x2009;5.4 kg/m2";
    const expected = "46.4\u2009±\u20091.4 yr, body mass index (BMI) 32.3\u2009±\u20095.4 kg/m2";
    expect(decodeHTMLEntities(input)).toBe(expected);
  });

  it("returns null for null input", () => {
    expect(decodeHTMLEntities(null)).toBeNull();
  });

  it("returns falsy for undefined input", () => {
    expect(decodeHTMLEntities(undefined)).toBeFalsy();
  });

  it("returns falsy for empty string", () => {
    expect(decodeHTMLEntities("")).toBeFalsy();
  });

  it("leaves plain text unchanged", () => {
    expect(decodeHTMLEntities("Normal text without entities")).toBe("Normal text without entities");
  });

  it("leaves already-decoded Unicode unchanged", () => {
    expect(decodeHTMLEntities("±")).toBe("±");
    expect(decodeHTMLEntities("≥")).toBe("≥");
  });
});
