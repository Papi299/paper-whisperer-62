import { describe, it, expect } from "vitest";
import { formatBytes } from "../formatBytes";

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

describe("formatBytes", () => {
  it("renders whole bytes without a unit jump or decimals", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("uses binary units so configured quota values read as familiar limits", () => {
    // The Free default `storage_quota_bytes` and the Pro baseline.
    expect(formatBytes(524288000)).toBe("500 MB");
    expect(formatBytes(2147483648)).toBe("2 GB");
    expect(formatBytes(10 * GB)).toBe("10 GB");
  });

  it("steps up at exact binary boundaries", () => {
    expect(formatBytes(KB)).toBe("1 KB");
    expect(formatBytes(512 * KB)).toBe("512 KB");
    expect(formatBytes(MB)).toBe("1 MB");
    expect(formatBytes(GB)).toBe("1 GB");
  });

  it("keeps at most one decimal and drops a trailing .0", () => {
    expect(formatBytes(Math.round(12.4 * MB))).toBe("12.4 MB");
    expect(formatBytes(Math.round(1.5 * GB))).toBe("1.5 GB");
    expect(formatBytes(2 * MB)).toBe("2 MB");
  });

  it("promotes to the next unit when rounding lands on the boundary", () => {
    // 1023.99… KB must not render as "1024 KB".
    expect(formatBytes(MB - 1)).toBe("1 MB");
    expect(formatBytes(GB - 1)).toBe("1 GB");
  });

  it("floors non-finite and negative input to 0 B rather than rendering garbage", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});
