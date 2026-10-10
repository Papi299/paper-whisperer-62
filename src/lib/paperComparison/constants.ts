/**
 * Fixed bounds and literals for the multi-paper comparison read model
 * (EVIDENCE-MATRIX-001A).
 */

/** A comparison of fewer papers than this is never presented as one. */
export const MIN_COMPARISON_PAPERS = 2;

/**
 * The most papers one comparison may request. A larger selection is refused,
 * never truncated: silently comparing "the first ten" would compare papers the
 * user did not choose to compare.
 */
export const MAX_COMPARISON_PAPERS = 10;

/**
 * The literal the AI analysis prompt asks the model to return when an abstract
 * states nothing for a field, and that a user may also have typed or kept.
 * Stored as text, it records that no value was given — never that the paper
 * reported none — so the read model keeps it apart from real values.
 */
export const NOT_SPECIFIED_PLACEHOLDER = "Not specified";

/** Delay before the single automatic retry of a transient read failure. */
export const COMPARISON_RETRY_DELAY_MS = 1000;
