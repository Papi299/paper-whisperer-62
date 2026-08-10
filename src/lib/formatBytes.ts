/**
 * Deterministic human-readable byte formatting for storage surfaces.
 *
 * **Binary units** (1 KB = 1024 B, 1 MB = 1024² B, 1 GB = 1024³ B) — chosen to
 * match the configured quota values, which are binary byte counts of familiar
 * limits: the Free `storage_quota_bytes` default of `524288000` is exactly
 * 500 MB and the Pro baseline `2147483648` is exactly 2 GB. Decimal (SI) units
 * would render those as "524.3 MB" / "2.1 GB", which reads as a wrong quota.
 *
 * Precision is deliberately shallow — at most one decimal, and none at all when
 * the value is whole — so a gauge shows `500 MB`, not `500.0 MB`.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const STEP = 1024;

/**
 * Format a byte count as a short human-readable string.
 *
 * Examples: `0 B`, `512 KB`, `12.4 MB`, `500 MB`, `2 GB`.
 *
 * Non-finite and negative inputs are floored to `0 B` — the stored counters are
 * `BIGINT NOT NULL CHECK (used_bytes >= 0)`, so a negative here means a bad
 * read, and a display gauge must not render `-1 B`.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  let value = bytes;
  let unit = 0;
  while (value >= STEP && unit < UNITS.length - 1) {
    value /= STEP;
    unit++;
  }

  // Whole bytes never carry a decimal.
  if (unit === 0) return `${Math.round(value)} ${UNITS[0]}`;

  let rounded = Math.round(value * 10) / 10;
  // Rounding can land exactly on the next unit boundary (1023.97 KB → 1024.0),
  // which must display as `1 MB`, not `1024 KB`.
  if (rounded >= STEP && unit < UNITS.length - 1) {
    rounded = Math.round((rounded / STEP) * 10) / 10;
    unit++;
  }

  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${UNITS[unit]}`;
}
