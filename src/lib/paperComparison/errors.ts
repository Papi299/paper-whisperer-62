/**
 * The two ways a comparison read can fail. Both fail closed: no row from a
 * failed read is ever shown.
 *
 * Messages carry a reason code or HTTP status only — never a paper id, title
 * or other stored content — so an error that reaches a log or an error
 * boundary discloses nothing about the library.
 */

/**
 * The response arrived but cannot be trusted as a whole: a row the request did
 * not ask for, a row twice, a row or nested record owned by someone else, or a
 * shape PostgREST does not produce for this select. Never retried
 * automatically — the same query would return the same response.
 *
 * An ordinary unavailable paper (deleted, never existed, not the user's) is
 * NOT an integrity failure: it simply produces no row.
 */
export type ComparisonIntegrityReason =
  | "malformed_response"
  | "unrequested_paper"
  | "duplicate_paper"
  | "owner_mismatch"
  | "relationship_mismatch";

export class ComparisonIntegrityError extends Error {
  readonly kind = "integrity" as const;
  readonly reason: ComparisonIntegrityReason;

  constructor(reason: ComparisonIntegrityReason) {
    super(`Comparison response failed an integrity check: ${reason}`);
    this.name = "ComparisonIntegrityError";
    this.reason = reason;
  }
}

/**
 * The read itself failed. Only a transient failure — no HTTP response at all
 * (network error), 408, 429 or a 5xx — is worth one automatic retry; anything
 * else (400, 401, 403, …) would fail the same way again.
 */
export class ComparisonTransportError extends Error {
  readonly kind = "transport" as const;
  readonly status: number;
  readonly transient: boolean;

  constructor(status: number) {
    super(`Comparison read failed with HTTP status ${status}`);
    this.name = "ComparisonTransportError";
    this.status = status;
    this.transient = status === 0 || status === 408 || status === 429 || status >= 500;
  }
}
