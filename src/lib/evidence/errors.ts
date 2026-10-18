/**
 * Study-record errors, classified (EVIDENCE-RECORDS-001B; 001A3).
 *
 * The seven client RPCs — PR-A2's four lifecycle RPCs and PR-A3's three field
 * RPCs — raise fixed messages with fixed SQLSTATEs that never echo input, ids,
 * text or SQL (docs/evidence-records-lifecycle.md §4;
 * docs/evidence-records-field-operations.md §7). This module turns what
 * supabase-js returns into one typed error with:
 *
 *   * `kind` — exactly which refusal it was;
 *   * `category` — validation, conflict, permission, not_found, limit,
 *     transport, server or configuration;
 *   * `applied` — "no" or "unknown". A response carrying a SQLSTATE or a
 *     PostgREST code means the request's transaction rolled back, so nothing
 *     was applied. Only a missing or unstructured response (a network failure,
 *     a gateway 5xx) leaves it unknown;
 *   * `retry` — what a retry must be: the SAME prepared request (same request
 *     id, same arguments — safe, because the server replays an applied request
 *     instead of applying it twice), a NEW request after reloading (a version
 *     conflict), or nothing;
 *   * `userMessage` — fixed copy, never built from the server's text;
 *   * `detail` — where a PR-A3 refusal points: the argument, the path inside
 *     `p_changes` and the rule, parsed from DETAIL by a strict grammar (an
 *     unparseable DETAIL is dropped, never shown);
 *   * `blocks` — for `confirm_blocked`, what Confirm still needs, in the codes
 *     and order of `checkConfirm` (`review.ts`).
 *
 * Classification is by SQLSTATE and message, not by HTTP status: PostgREST
 * answers `P0002 evidence_not_found` with HTTP 500, so "5xx" does not mean
 * "transport". The status is used only where it is the signal — 42501 is 401
 * for a request with no session and 403 for a signed-in one.
 *
 * A permission failure is never reported as a missing schema: only
 * PGRST202/42883 naming the RPC that was called is `function_unavailable`.
 */

import { isMissingDatabaseObjectError } from "@/lib/missingDatabaseObject";
import type { EvidenceFieldRpc } from "./fieldRequests";
import { LAST_LINK_EXPLANATION, LINK_IN_USE_EXPLANATION, LINK_NOT_FOUND_EXPLANATION, PAPER_HELD_BY_STUDY_EXPLANATION } from "./identity";
import { EVIDENCE_LIFECYCLE_RPCS, type EvidenceLifecycleRpc } from "./lifecycleRequests";
import type { ConfirmBlock } from "./review";

/** Any of the seven client RPCs. */
export type EvidenceRpc = EvidenceLifecycleRpc | EvidenceFieldRpc;

export type EvidenceErrorCategory =
  | "validation"
  | "conflict"
  | "permission"
  | "not_found"
  | "limit"
  | "transport"
  | "server"
  | "configuration";

export type EvidenceErrorKind =
  | "auth_required"
  | "records_not_enabled"
  | "permission_denied"
  | "study_not_found"
  | "paper_not_found"
  | "link_not_found"
  | "invalid_input"
  | "request_id_reused"
  | "version_conflict"
  | "profile_change_blocked"
  | "last_link"
  | "link_in_use"
  | "abstract_too_long"
  | "study_limit"
  | "history_limit"
  | "requires_read_committed"
  | "internal_invariant"
  | "paper_has_study_record"
  | "function_unavailable"
  | "database_busy"
  | "service_unavailable"
  | "transport_uncertain"
  | "malformed_response"
  | "invalid_request"
  | "database_error"
  | "quote_not_found"
  | "source_changed_again"
  | "snapshot_limit"
  | "target_not_found"
  | "quote_ambiguous"
  | "confirm_blocked"
  | "arm_limit"
  | "outcome_limit"
  | "value_limit";

/**
 * Where a PR-A3 refusal points (its DETAIL): `p_changes[3].references[1].snapshot_id:
 * not_current` is `{ parameter: "changes", path: [3, "references", 1, "snapshot_id"],
 * rules: ["not_current"] }`. Path keys are the server's wire keys.
 */
export interface EvidenceErrorDetail {
  /** The argument, as the client calls it. */
  readonly parameter: string;
  /** Below the argument: change and reference indices (0-based) and wire keys. */
  readonly path: readonly (string | number)[];
  /** The rules broken, in the server's order; empty when it named only the place. */
  readonly rules: readonly string[];
}

export interface EvidenceError {
  readonly kind: EvidenceErrorKind;
  readonly category: EvidenceErrorCategory;
  readonly applied: "no" | "unknown";
  readonly retry: "same_request" | "new_request_after_reload" | "none";
  readonly userMessage: string;
  /** The argument the server named, as the client calls it (`invalid_input` and the PR-A3 refusals with a DETAIL). */
  readonly field: string | null;
  readonly detail: EvidenceErrorDetail | null;
  /** For `confirm_blocked`: what Confirm still needs; null when the server's list could not be read. */
  readonly blocks: readonly ConfirmBlock[] | null;
  /** The SQLSTATE or PostgREST code, for diagnostics. Never message text, ids or SQL. */
  readonly code: string | null;
  readonly status: number | null;
}

interface KindSpec {
  readonly category: EvidenceErrorCategory;
  readonly retry: EvidenceError["retry"];
  readonly userMessage: string;
}

export const EVIDENCE_ERROR_SPECS: Readonly<Record<EvidenceErrorKind, KindSpec>> = Object.freeze({
  auth_required: { category: "permission", retry: "same_request", userMessage: "Your session has ended. Sign in again, then try again." },
  records_not_enabled: { category: "permission", retry: "none", userMessage: "Study records aren't available for your account yet." },
  permission_denied: { category: "permission", retry: "none", userMessage: "You don't have permission to do that." },
  study_not_found: { category: "not_found", retry: "none", userMessage: "This study record no longer exists." },
  paper_not_found: { category: "not_found", retry: "none", userMessage: "This paper is no longer in your library." },
  link_not_found: { category: "not_found", retry: "none", userMessage: LINK_NOT_FOUND_EXPLANATION },
  invalid_input: {
    category: "validation",
    retry: "none",
    userMessage: "Something in this change isn't valid. Check it and try again.",
  },
  request_id_reused: {
    category: "conflict",
    retry: "none",
    userMessage: "This change couldn't be matched to the action that started it. Reload the study record and try again.",
  },
  version_conflict: {
    category: "conflict",
    retry: "new_request_after_reload",
    userMessage:
      "This study record was changed in another tab or window. Reload to see the latest version — copy anything you need first.",
  },
  profile_change_blocked: {
    category: "conflict",
    retry: "none",
    userMessage: "Remove the groups and the number randomized before changing this to a study without an assigned intervention.",
  },
  last_link: { category: "conflict", retry: "none", userMessage: LAST_LINK_EXPLANATION },
  link_in_use: { category: "conflict", retry: "none", userMessage: LINK_IN_USE_EXPLANATION },
  abstract_too_long: {
    category: "limit",
    retry: "none",
    userMessage: "This paper's abstract is longer than 50,000 characters, so a study record can't save a copy of it.",
  },
  study_limit: { category: "limit", retry: "none", userMessage: "You've reached the limit of 2,000 study records." },
  history_limit: { category: "limit", retry: "none", userMessage: "This study record has reached its limit of 5,000 history entries." },
  requires_read_committed: {
    category: "configuration",
    retry: "none",
    userMessage: "Couldn't save because of a server configuration problem. Your change wasn't saved.",
  },
  internal_invariant: { category: "server", retry: "none", userMessage: "Something went wrong on the server. Your change wasn't saved." },
  paper_has_study_record: { category: "conflict", retry: "none", userMessage: PAPER_HELD_BY_STUDY_EXPLANATION },
  function_unavailable: {
    category: "configuration",
    retry: "none",
    userMessage: "Study records aren't available in this version of PaperLume yet. Reload the page and try again.",
  },
  database_busy: { category: "transport", retry: "same_request", userMessage: "The database was busy. Your change wasn't saved — try again." },
  service_unavailable: {
    category: "transport",
    retry: "same_request",
    userMessage: "PaperLume couldn't reach the database. Your change wasn't saved — try again.",
  },
  transport_uncertain: {
    category: "transport",
    retry: "same_request",
    userMessage: "We couldn't confirm whether your change was saved. Try again — it won't be applied twice.",
  },
  malformed_response: {
    category: "server",
    retry: "same_request",
    userMessage: "PaperLume received an unexpected answer. Try again, or reload the study record to see its current state.",
  },
  invalid_request: { category: "validation", retry: "none", userMessage: "Couldn't send this change. Reload the page and try again." },
  database_error: { category: "server", retry: "same_request", userMessage: "Couldn't save. Your changes are still here — try again." },
  quote_not_found: {
    category: "validation",
    retry: "none",
    userMessage:
      "This text wasn't found in the saved abstract. Select it directly in the abstract, or add it as a full-text reference if it comes from elsewhere.",
  },
  source_changed_again: {
    category: "conflict",
    retry: "new_request_after_reload",
    userMessage: "The abstract in your library changed again. Review it, then save a copy.",
  },
  snapshot_limit: { category: "limit", retry: "none", userMessage: "This paper has reached its limit of 20 saved abstract copies." },
  target_not_found: {
    category: "not_found",
    retry: "none",
    userMessage: "Part of this study record no longer exists. Reload it to see its current state.",
  },
  quote_ambiguous: {
    category: "validation",
    retry: "none",
    userMessage: "This text appears several times in the abstract. Select the one you mean, or add a few words.",
  },
  confirm_blocked: { category: "validation", retry: "none", userMessage: "This value can't be confirmed yet. Check what it still needs." },
  arm_limit: { category: "limit", retry: "none", userMessage: "A study record can have up to 20 groups." },
  outcome_limit: { category: "limit", retry: "none", userMessage: "A study record can have up to 50 outcomes." },
  value_limit: { category: "limit", retry: "none", userMessage: "A study record can hold up to 400 recorded fields." },
});

/** The fixed refusals of the PR-A2 and PR-A3 RPCs: SQLSTATE and message, exactly as raised. */
const RAISED: ReadonlyArray<readonly [string, string, EvidenceErrorKind]> = [
  ["42501", "evidence_auth_required", "auth_required"],
  ["42501", "evidence_records_not_enabled", "records_not_enabled"],
  ["22023", "evidence_invalid_input", "invalid_input"],
  ["P0002", "evidence_not_found", "study_not_found"],
  ["P0002", "evidence_paper_not_found", "paper_not_found"],
  ["P0002", "evidence_link_not_found", "link_not_found"],
  ["P0001", "evidence_request_id_reused", "request_id_reused"],
  ["P0001", "evidence_version_conflict", "version_conflict"],
  ["P0001", "evidence_profile_change_blocked", "profile_change_blocked"],
  ["P0001", "evidence_last_link", "last_link"],
  ["P0001", "evidence_link_in_use", "link_in_use"],
  ["P0001", "evidence_abstract_too_long", "abstract_too_long"],
  ["P0001", "evidence_study_limit", "study_limit"],
  ["P0001", "evidence_history_limit", "history_limit"],
  ["P0001", "evidence_requires_read_committed", "requires_read_committed"],
  ["XX000", "evidence_internal_invariant", "internal_invariant"],
  // EVIDENCE-RECORDS-001A3 (20261017155445).
  ["P0002", "evidence_target_not_found", "target_not_found"],
  ["P0001", "evidence_quote_not_found", "quote_not_found"],
  ["P0001", "evidence_quote_ambiguous", "quote_ambiguous"],
  ["P0001", "evidence_confirm_blocked", "confirm_blocked"],
  ["P0001", "evidence_source_changed_again", "source_changed_again"],
  ["P0001", "evidence_snapshot_limit", "snapshot_limit"],
  ["P0001", "evidence_arm_limit", "arm_limit"],
  ["P0001", "evidence_outcome_limit", "outcome_limit"],
  ["P0001", "evidence_value_limit", "value_limit"],
];

/** A DETAIL's parameter mapped to the client's field name. Any other parameter is not read. */
const PARAMETER_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  p_paper_id: "paperId",
  p_study_id: "studyId",
  p_label: "label",
  p_design_profile: "designProfile",
  p_link_status: "linkStatus",
  p_notes: "notes",
  p_action: "action",
  p_expected_version: "expectedVersion",
  p_request_id: "requestId",
  p_changes: "changes",
  p_value_id: "valueId",
  p_expected_value_version: "expectedValueVersion",
  p_note: "note",
  p_expected_abstract_sha256: "expectedAbstractSha256",
});

/**
 * DETAIL as the RPCs write it: a parameter, then `[n]` indices and `.key`
 * names, then optionally `: rule[,rule...]`. Nothing else is accepted.
 */
const DETAIL_GRAMMAR = /^(p_[a-z0-9_]+)((?:\[(?:0|[1-9][0-9]{0,8})\]|\.[a-z_]+)*)(?:: ([a-z_]+(?:,[a-z_]+)*))?$/;

/** The Confirm preconditions the server can name — every ConfirmBlock but the two only the browser sees. */
const SERVER_CONFIRM_BLOCKS: ReadonlySet<string> = new Set<ConfirmBlock>([
  "sources_not_allowed",
  "examined_source_missing",
  "unclear_source_missing",
  "unavailable_source_missing",
  "no_current_support",
  "unclear_source_not_current",
  "examined_abstract_not_current",
  "unavailable_abstract_has_copy",
  "count_not_confirmed",
  "state_reason_missing",
  "note_missing",
]);

function parseDetail(details: unknown): EvidenceErrorDetail | null {
  if (typeof details !== "string") return null;
  const match = DETAIL_GRAMMAR.exec(details);
  const parameter = match ? PARAMETER_FIELDS[match[1]] : undefined;
  if (!match || !parameter) return null;
  const path = Array.from(match[2].matchAll(/\[([0-9]+)\]|\.([a-z_]+)/g), (segment) =>
    segment[1] !== undefined ? Number(segment[1]) : segment[2],
  );
  return Object.freeze({ parameter, path: Object.freeze(path), rules: Object.freeze(match[3] ? match[3].split(",") : []) });
}

function parseBlocks(details: unknown): readonly ConfirmBlock[] | null {
  if (typeof details !== "string" || !/^[a-z_]+(?:,[a-z_]+)*$/.test(details)) return null;
  const blocks = details.split(",");
  if (!blocks.every((block) => SERVER_CONFIRM_BLOCKS.has(block)) || new Set(blocks).size !== blocks.length) return null;
  return Object.freeze(blocks as ConfirmBlock[]);
}

/** SQLSTATEs of a transaction that failed for a transient reason and rolled back. */
const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "55P03", "57014"]);

/** The PR-A1 NO ACTION keys and what their refusal means (FK-PROOF-001; 001A §D2). */
const PROTECTING_FOREIGN_KEYS: Readonly<Record<string, EvidenceErrorKind>> = Object.freeze({
  evidence_study_reports_paper_fkey: "paper_has_study_record",
  evidence_field_anchors_link_fkey: "link_in_use",
  evidence_field_anchors_snapshot_fkey: "link_in_use",
});

interface PostgrestLikeError {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

interface BuildExtra {
  readonly code?: string | null;
  readonly status?: number | null;
  readonly field?: string | null;
  readonly detail?: EvidenceErrorDetail | null;
  readonly blocks?: readonly ConfirmBlock[] | null;
  readonly applied?: "no" | "unknown";
}

function build(kind: EvidenceErrorKind, extra: BuildExtra = {}): EvidenceError {
  const spec = EVIDENCE_ERROR_SPECS[kind];
  return Object.freeze({
    kind,
    category: spec.category,
    applied: extra.applied ?? "no",
    retry: spec.retry,
    userMessage: spec.userMessage,
    field: extra.field ?? null,
    detail: extra.detail ?? null,
    blocks: extra.blocks ?? null,
    code: extra.code ?? null,
    status: extra.status ?? null,
  });
}

/** The constraint a 23503 names, from PostgreSQL's fixed message form. */
function violatedForeignKey(error: PostgrestLikeError): string | null {
  if (error.code !== "23503" || typeof error.message !== "string") return null;
  const match = /violates foreign key constraint "([^"]+)"/.exec(error.message);
  return match ? match[1] : null;
}

/**
 * The 23503 a paper delete or duplicate merge gets when a study links to the
 * paper — or the backstop refusal of an unlink a reference still uses. Null for
 * every other error, including every other foreign-key violation, so an
 * unrelated failure is never explained away as a study record.
 */
export function classifyEvidenceForeignKeyError(error: unknown, status: number | null = null): EvidenceError | null {
  if (!error || typeof error !== "object") return null;
  const constraint = violatedForeignKey(error as PostgrestLikeError);
  const kind = constraint ? PROTECTING_FOREIGN_KEYS[constraint] : undefined;
  return kind ? build(kind, { code: "23503", status }) : null;
}

/** A transport failure with no response to judge: whether anything was applied is unknown. */
export function transportUncertainError(status: number | null = null): EvidenceError {
  return build("transport_uncertain", { status, applied: "unknown" });
}

/** A 2xx response this client cannot trust: the request may have been applied. */
export function malformedResponseError(status: number | null = null): EvidenceError {
  return build("malformed_response", { status, applied: "unknown" });
}

/** A request object `prepare*` did not build; nothing was sent. */
export function invalidRequestError(): EvidenceError {
  return build("invalid_request");
}

/**
 * Classify the `error` (and HTTP `status`) supabase-js returned for one of the
 * seven client RPCs. `functionName` lets a missing-function error be
 * recognized only when it names that RPC.
 */
export function classifyLifecycleError(error: unknown, status: number | null, functionName: EvidenceRpc): EvidenceError {
  if (!error || typeof error !== "object") return transportUncertainError(status);
  const e = error as PostgrestLikeError;
  const code = typeof e.code === "string" && e.code !== "" ? e.code : null;
  const message = typeof e.message === "string" ? e.message : "";

  if (code === null) {
    // No SQLSTATE and no PostgREST code: the database's answer never arrived.
    if (status === 401) return build("auth_required", { status });
    if (status === 408 || status === 429) return build("service_unavailable", { status });
    if (status !== null && status >= 400 && status < 500) return build("invalid_request", { status });
    return transportUncertainError(status);
  }

  for (const [sqlstate, text, kind] of RAISED) {
    if (code === sqlstate && message === text) {
      if (kind === "confirm_blocked") return build(kind, { code, status, blocks: parseBlocks(e.details) });
      const detail = parseDetail(e.details);
      return build(kind, { code, status, field: detail?.parameter ?? null, detail });
    }
  }

  if (isMissingDatabaseObjectError(error, [functionName])) return build("function_unavailable", { code, status });
  const foreignKey = classifyEvidenceForeignKeyError(error, status);
  if (foreignKey) return foreignKey;
  if (code === "42501") return build(status === 401 ? "auth_required" : "permission_denied", { code, status });
  if (code === "PGRST301" || code === "PGRST302" || code === "PGRST303") return build("auth_required", { code, status });
  if (/^PGRST0\d\d$/.test(code)) return build("service_unavailable", { code, status });
  if (/^PGRST\d{3}$/.test(code)) return build("invalid_request", { code, status });
  if (TRANSIENT_SQLSTATES.has(code)) return build("database_busy", { code, status });
  return build("database_error", { code, status });
}

/** Whether `name` is one of the four lifecycle RPCs. */
export function isEvidenceLifecycleRpc(name: unknown): name is EvidenceLifecycleRpc {
  return typeof name === "string" && (EVIDENCE_LIFECYCLE_RPCS as readonly string[]).includes(name);
}
