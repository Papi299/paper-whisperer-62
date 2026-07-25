import { describe, it, expect } from "vitest";
import { pacificDayStartIso, pacificDayStartMs } from "../pacificTime.ts";

/** Format an instant as its America/Los_Angeles wall-clock date + time. */
function laWall(ms: number): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const g = (t: string) => p.find((x) => x.type === t)?.value;
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

describe("pacificDayStartIso — DST-safe Pacific midnight", () => {
  it("PST date: midnight is 08:00Z", () => {
    // 2026-01-15 12:00 PST.
    const now = new Date("2026-01-15T20:00:00Z");
    expect(pacificDayStartIso(now)).toBe("2026-01-15T08:00:00.000Z");
    expect(laWall(pacificDayStartMs(now))).toBe("2026-01-15 00:00:00");
  });

  it("PDT date: midnight is 07:00Z", () => {
    // 2026-07-15 13:00 PDT.
    const now = new Date("2026-07-15T20:00:00Z");
    expect(pacificDayStartIso(now)).toBe("2026-07-15T07:00:00.000Z");
    expect(laWall(pacificDayStartMs(now))).toBe("2026-07-15 00:00:00");
  });

  it("spring-forward day (2026-03-08): midnight is still PST → 08:00Z", () => {
    // After the 02:00→03:00 jump; local is PDT at this instant, but midnight
    // that day was PST. A naive wall-clock subtraction would be wrong here.
    const now = new Date("2026-03-08T20:00:00Z");
    expect(pacificDayStartIso(now)).toBe("2026-03-08T08:00:00.000Z");
    expect(laWall(pacificDayStartMs(now))).toBe("2026-03-08 00:00:00");
  });

  it("fall-back day (2026-11-01): midnight is still PDT → 07:00Z", () => {
    // After the 02:00→01:00 fall-back; local is PST at this instant, but
    // midnight that day was PDT.
    const now = new Date("2026-11-01T20:00:00Z");
    expect(pacificDayStartIso(now)).toBe("2026-11-01T07:00:00.000Z");
    expect(laWall(pacificDayStartMs(now))).toBe("2026-11-01 00:00:00");
  });

  it("the naive 'subtract wall-clock elapsed' approach diverges on the transition day (sanity)", () => {
    // On spring-forward day the civil day is 23h; naive subtraction lands an
    // hour off. This asserts our helper is NOT the naive one.
    const now = new Date("2026-03-08T20:00:00Z");
    // Naive: LA wall clock at `now` is 13:00:00 (PDT); subtracting 13h from now.
    const naive = new Date(now.getTime() - (13 * 3600) * 1000).toISOString();
    expect(naive).not.toBe(pacificDayStartIso(now));
  });
});
