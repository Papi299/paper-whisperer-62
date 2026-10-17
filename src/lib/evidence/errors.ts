/**
 * Study-record errors, classified (EVIDENCE-RECORDS-001B).
 *
 * The four lifecycle RPCs raise fixed messages with fixed SQLSTATEs that never
 * echo input, ids or SQL (PR-A2 header; docs/evidence-records-lifecycle.md §4).
 * This module turns what supabase-js returns into one typed error with:
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
 *   * `userMessage` — fixed copy, never built from the server's text.
 *
 * Classification is by SQLSTATE and message, not by HTTP status: PostgREST
 * answers `P0002 evidence_not_found` with HTTP 500, so "5xx" does not mean
 * "transport". The status is used only where it is the signal — 42501 is 401
 * for a request with no session and 403 for a signed-in one.
 *
 * A permission failure is never reported as a missing schema: only
 * PGRST202/42883 naming one of the four RPCs is `function_unavailable`.
 */

import { isMissingDatabaseObjectError } from "@/lib/missingDatabaseObject";
import { LAST_LINK_EXPLANATION, LINK_IN_USE_EXPLANATION, LINK_NOT_FOUND_EXPLANATION, PAPER_HELD_BY_STUDY_EXPLANATION } from "./identity";
import { EVIDENCE_LIFECYCLE_RPCS, type EvidenceLifecycleRpc } from "./lifecycleRequests";

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
  | "snapshot_limit";

export interface EvidenceError {
  readonly kind: EvidenceErrorKind;
  readonly category: EvidenceErrorCategory;
  readonly applied: "no" | "unknown";
  readonly retry: "same_request" | "new_request_after_reload" | "none";
  readonly userMessage: string;
  /** For `invalid_input`: the argument the server named, as the client calls it. */
  readonly field: string | null;
  /** The SQLSTATE or PostgREST code, for diagnostics. Never message text, ids or SQL. */
  readonly code: string | null;
  readonly status: number | null;
  /** True for a reserved PR-A3 error: a contract, not a deployed endpoint. */
  readonly reserved: boolean;
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
  snapshot_limit: { category: "limit", retry: "none", userMessage: "This paper has reached its limit of saved abstract copies." },
});

/** The fixed PR-A2 refusals: SQLSTATE and message, exactly as raised. */
const DEPLOYED: ReadonlyArray<readonly [string, string, EvidenceErrorKind]> = [
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
];

/**
 * RESERVED, NOT DEPLOYED: refusals the requirements give to PR-A3's RPCs
 * (Requirements-001 §L9; 001A §E3). No deployed function raises them, and
 * their SQLSTATE is not pinned yet; they are recognized only as P0001, the
 * convention every PR-A2 refusal follows, and marked `reserved`.
 */
const RESERVED: ReadonlyArray<readonly [string, string, EvidenceErrorKind]> = [
  ["P0001", "evidence_quote_not_found", "quote_not_found"],
  ["P0001", "evidence_source_changed_again", "source_changed_again"],
  ["P0001", "evidence_snapshot_limit", "snapshot_limit"],
];

/** `evidence_invalid_input` DETAIL (the parameter) mapped to the client's field name. */
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
});

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

function build(kind: EvidenceErrorKind, extra: { code?: string | null; status?: number | null; field?: string | null; applied?: "no" | "unknown"; reserved?: boolean } = {}): EvidenceError {
  const spec = EVIDENCE_ERROR_SPECS[kind];
  return Object.freeze({
    kind,
    category: spec.category,
    applied: extra.applied ?? "no",
    retry: spec.retry,
    userMessage: spec.userMessage,
    field: extra.field ?? null,
    code: extra.code ?? null,
    status: extra.status ?? null,
    reserved: extra.reserved ?? false,
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
 * four lifecycle RPCs. `functionName` lets a missing-function error be
 * recognized only when it names that RPC.
 */
export function classifyLifecycleError(error: unknown, status: number | null, functionName: EvidenceLifecycleRpc): EvidenceError {
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

  for (const [sqlstate, text, kind] of DEPLOYED) {
    if (code === sqlstate && message === text) {
      const field = kind === "invalid_input" && typeof e.details === "string" ? PARAMETER_FIELDS[e.details] ?? null : null;
      return build(kind, { code, status, field });
    }
  }
  for (const [sqlstate, text, kind] of RESERVED) {
    if (code === sqlstate && message === text) return build(kind, { code, status, reserved: true });
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
