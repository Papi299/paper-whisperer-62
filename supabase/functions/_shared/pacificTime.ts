// DST-safe America/Los_Angeles day-boundary helper — Part C.
//
// Pure module (no Deno APIs, no remote imports): Vitest (Node) tests it directly.
// Google's Gemini free-tier daily quota resets on the Pacific-time boundary, so
// the daily Monitoring interval must begin at midnight *Pacific* — which is a
// different UTC instant across PST/PDT and, critically, is NOT `now` minus the
// Pacific wall-clock hours/minutes/seconds (that is wrong on the two DST
// transition days, where the civil day is 23h or 25h long).
//
// Instead we resolve the UTC instant whose Los_Angeles wall clock reads
// Y-M-D 00:00:00 via a two-step offset fixpoint (wall-time → UTC), which is
// correct through spring-forward and fall-back.

const TZ = "America/Los_Angeles";

function part(parts: Intl.DateTimeFormatPart[], type: string): number {
  const v = parts.find((p) => p.type === type)?.value;
  return v ? Number(v) : 0;
}

/**
 * Offset (ms) such that the zone's wall-clock reading of `date`, interpreted as
 * if it were UTC, equals `date.getTime() + offset`. Negative for LA (behind UTC).
 */
function laOffsetMs(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const wallAsUtc = Date.UTC(
    part(parts, "year"),
    part(parts, "month") - 1,
    part(parts, "day"),
    part(parts, "hour"),
    part(parts, "minute"),
    part(parts, "second"),
  );
  // Round to whole seconds to avoid sub-second drift.
  return wallAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The Los_Angeles calendar Y-M-D of `now`. */
function laCalendarDate(now: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return { y: part(parts, "year"), m: part(parts, "month"), d: part(parts, "day") };
}

/** The UTC epoch-ms instant of midnight (00:00:00) of the current Pacific day. */
export function pacificDayStartMs(now: Date): number {
  const { y, m, d } = laCalendarDate(now);
  // Solve ts where wall(ts) = Y-M-D 00:00:00: ts = M - offset(ts). Two iterations
  // converge, including across a DST transition where offset(M) differs.
  const wallMidnightAsUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  let ts = wallMidnightAsUtc;
  for (let i = 0; i < 2; i++) {
    ts = wallMidnightAsUtc - laOffsetMs(new Date(ts));
  }
  return ts;
}

/** ISO string of midnight of the current Pacific day (for Monitoring intervals). */
export function pacificDayStartIso(now: Date): string {
  return new Date(pacificDayStartMs(now)).toISOString();
}
