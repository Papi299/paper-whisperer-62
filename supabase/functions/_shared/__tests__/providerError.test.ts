import { describe, it, expect } from "vitest";
import {
  classifyProviderError,
  isProviderLimit,
  NEUTRAL_ANALYSIS_UNAVAILABLE_MESSAGE,
} from "../providerError.ts";

describe("classifyProviderError", () => {
  it("classifies a Google 429 as a provider rate limit (NOT a plan wall)", () => {
    expect(classifyProviderError({ kind: "http", status: 429 })).toBe("provider_rate_limit");
    expect(isProviderLimit(classifyProviderError({ kind: "http", status: 429 }))).toBe(true);
  });

  it("classifies 5xx / network / timeout as provider_unavailable", () => {
    expect(classifyProviderError({ kind: "http", status: 500 })).toBe("provider_unavailable");
    expect(classifyProviderError({ kind: "http", status: 503 })).toBe("provider_unavailable");
    expect(classifyProviderError({ kind: "network" })).toBe("provider_unavailable");
    expect(classifyProviderError({ kind: "timeout" })).toBe("provider_unavailable");
  });

  it("classifies empty / parse failures as malformed_response", () => {
    expect(classifyProviderError({ kind: "empty" })).toBe("malformed_response");
    expect(classifyProviderError({ kind: "parse" })).toBe("malformed_response");
  });

  it("treats 403 RESOURCE_EXHAUSTED as a provider limit", () => {
    expect(classifyProviderError({ kind: "http", status: 403 })).toBe("provider_rate_limit");
  });

  it("classifies other 4xx as unknown (not a plan wall)", () => {
    expect(classifyProviderError({ kind: "http", status: 400 })).toBe("unknown");
    expect(classifyProviderError({ kind: "http", status: 404 })).toBe("unknown");
  });

  it("defaults to unknown when nothing is known", () => {
    expect(classifyProviderError({})).toBe("unknown");
  });

  it("exposes a neutral, non-operational user message", () => {
    expect(NEUTRAL_ANALYSIS_UNAVAILABLE_MESSAGE).toMatch(/temporarily unavailable/i);
    expect(NEUTRAL_ANALYSIS_UNAVAILABLE_MESSAGE).not.toMatch(/google|gemini|quota|project|429/i);
  });
});
