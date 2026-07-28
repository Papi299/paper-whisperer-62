import { describe, it, expect } from "vitest";
import { resolveGeminiModel, DEFAULT_GEMINI_MODEL } from "../geminiModel.ts";

describe("resolveGeminiModel", () => {
  it("falls back to the default alias when unset/empty/whitespace", () => {
    expect(resolveGeminiModel(undefined)).toBe(DEFAULT_GEMINI_MODEL);
    expect(resolveGeminiModel(null)).toBe(DEFAULT_GEMINI_MODEL);
    expect(resolveGeminiModel("")).toBe(DEFAULT_GEMINI_MODEL);
    expect(resolveGeminiModel("   ")).toBe(DEFAULT_GEMINI_MODEL);
  });

  it("preserves the exact behavioral fallback", () => {
    expect(DEFAULT_GEMINI_MODEL).toBe("gemini-flash-latest");
  });

  it("uses and trims a configured override", () => {
    expect(resolveGeminiModel("gemini-2.0-flash")).toBe("gemini-2.0-flash");
    expect(resolveGeminiModel("  gemini-x  ")).toBe("gemini-x");
  });
});
