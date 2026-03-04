import { describe, it, expect } from "vitest";
import { getErrorMessage } from "../errorUtils";

describe("getErrorMessage", () => {
  it("extracts message from Error instance", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("extracts message from TypeError", () => {
    expect(getErrorMessage(new TypeError("type mismatch"))).toBe("type mismatch");
  });

  it("returns string errors directly", () => {
    expect(getErrorMessage("something went wrong")).toBe("something went wrong");
  });

  it("extracts message from object with message property", () => {
    expect(getErrorMessage({ message: "api error" })).toBe("api error");
  });

  it("returns fallback for null", () => {
    expect(getErrorMessage(null)).toBe("An unexpected error occurred");
  });

  it("returns fallback for undefined", () => {
    expect(getErrorMessage(undefined)).toBe("An unexpected error occurred");
  });

  it("returns fallback for number", () => {
    expect(getErrorMessage(42)).toBe("An unexpected error occurred");
  });

  it("returns fallback for object without message", () => {
    expect(getErrorMessage({ code: 500 })).toBe("An unexpected error occurred");
  });
});
