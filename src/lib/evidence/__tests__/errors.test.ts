// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  classifyEvidenceForeignKeyError,
  classifyLifecycleError,
  EVIDENCE_ERROR_SPECS,
  isEvidenceLifecycleRpc,
  transportUncertainError,
  type EvidenceErrorKind,
} from "../errors";
import { EVIDENCE_FIELD_RPCS } from "../fieldRequests";
import { EVIDENCE_LIFECYCLE_RPCS } from "../lifecycleRequests";
import { readRepoFile } from "./fixtures/vectors";

/**
 * Error classification for the seven client RPCs: the fixed PR-A2 and PR-A3
 * refusals and their DETAIL, PostgREST's own codes, transport failures, and
 * the evidence foreign keys.
 */

const PR_A3_MIGRATION = "supabase/migrations/20261017155445_add_evidence_records_field_review_rebase_rpcs.sql";
const SQLSTATES: Readonly<Record<string, string>> = {
  insufficient_privilege: "42501",
  invalid_parameter_value: "22023",
  no_data_found: "P0002",
  raise_exception: "P0001",
  internal_error: "XX000",
};

const RPC = "evidence_update_study" as const;
const pg = (code: string, message: string, details: string | null = null) => ({ code, message, details, hint: null });

describe("the fixed PR-A2 refusals", () => {
  it.each<[string, string, EvidenceErrorKind, number]>([
    ["42501", "evidence_auth_required", "auth_required", 403],
    ["42501", "evidence_records_not_enabled", "records_not_enabled", 403],
    ["22023", "evidence_invalid_input", "invalid_input", 400],
    ["P0002", "evidence_not_found", "study_not_found", 500],
    ["P0002", "evidence_paper_not_found", "paper_not_found", 500],
    ["P0002", "evidence_link_not_found", "link_not_found", 500],
    ["P0001", "evidence_request_id_reused", "request_id_reused", 400],
    ["P0001", "evidence_version_conflict", "version_conflict", 400],
    ["P0001", "evidence_profile_change_blocked", "profile_change_blocked", 400],
    ["P0001", "evidence_last_link", "last_link", 400],
    ["P0001", "evidence_link_in_use", "link_in_use", 400],
    ["P0001", "evidence_abstract_too_long", "abstract_too_long", 400],
    ["P0001", "evidence_study_limit", "study_limit", 400],
    ["P0001", "evidence_history_limit", "history_limit", 400],
    ["P0001", "evidence_requires_read_committed", "requires_read_committed", 400],
    ["XX000", "evidence_internal_invariant", "internal_invariant", 500],
  ])("%s %s -> %s (applied: no)", (code, message, kind, status) => {
    const error = classifyLifecycleError(pg(code, message), status, RPC);
    expect(error).toMatchObject({ kind, applied: "no", code, status, detail: null, blocks: null });
    expect(error.userMessage).toBe(EVIDENCE_ERROR_SPECS[kind].userMessage);
    expect(error.userMessage).not.toContain("evidence_");
  });

  it("covers every refusal the deployed migration raises", () => {
    const sql = readRepoFile("supabase/migrations/20261016104232_add_evidence_records_lifecycle_rpcs.sql");
    const raised = new Set(Array.from(sql.matchAll(/RAISE EXCEPTION '(evidence_[a-z_]+)'/g), (m) => m[1]));
    expect(raised.size).toBe(16);
    for (const message of raised) {
      const code = new RegExp(`'${message}' USING ERRCODE = '([a-z_]+)'`).exec(sql)?.[1];
      const sqlstate = { insufficient_privilege: "42501", invalid_parameter_value: "22023", no_data_found: "P0002", raise_exception: "P0001", internal_error: "XX000" }[code ?? ""];
      expect(sqlstate, message).toBeDefined();
      expect(classifyLifecycleError(pg(sqlstate!, message), 400, RPC).kind, message).not.toBe("database_error");
    }
  });

  it("reads 'not found' by its SQLSTATE, not as a transport failure, though PostgREST answers it with HTTP 500", () => {
    expect(classifyLifecycleError(pg("P0002", "evidence_not_found"), 500, RPC)).toMatchObject({ kind: "study_not_found", category: "not_found", applied: "no" });
  });

  it("names the invalid argument by its client field, never echoing DETAIL raw", () => {
    expect(classifyLifecycleError(pg("22023", "evidence_invalid_input", "p_label"), 400, RPC).field).toBe("label");
    expect(classifyLifecycleError(pg("22023", "evidence_invalid_input", "p_expected_version"), 400, RPC).field).toBe("expectedVersion");
    expect(classifyLifecycleError(pg("22023", "evidence_invalid_input", "something else"), 400, RPC).field).toBeNull();
  });

  it("asks for a reload and a NEW request after a version conflict, and nothing after a reused id", () => {
    expect(classifyLifecycleError(pg("P0001", "evidence_version_conflict"), 400, RPC).retry).toBe("new_request_after_reload");
    expect(classifyLifecycleError(pg("P0001", "evidence_request_id_reused"), 400, RPC).retry).toBe("none");
  });

  it("matches messages exactly", () => {
    expect(classifyLifecycleError(pg("P0001", "evidence_version_conflict "), 400, RPC).kind).toBe("database_error");
    expect(classifyLifecycleError(pg("P0001", "Evidence_version_conflict"), 400, RPC).kind).toBe("database_error");
    expect(classifyLifecycleError(pg("22023", "evidence_version_conflict"), 400, RPC).kind).toBe("database_error");
  });
});

describe("permissions and a missing schema are never confused", () => {
  it("reads a function-level permission refusal as permission, by session", () => {
    const denied = pg("42501", "permission denied for function evidence_update_study");
    expect(classifyLifecycleError(denied, 403, RPC).kind).toBe("permission_denied");
    expect(classifyLifecycleError(denied, 401, RPC).kind).toBe("auth_required");
  });

  it("reports function_unavailable only for the RPC's own missing-function error", () => {
    const missing = pg("PGRST202", "Could not find the function public.evidence_update_study(p_design_profile, p_expected_version, p_label, p_notes, p_request_id, p_study_id) in the schema cache");
    expect(classifyLifecycleError(missing, 404, RPC).kind).toBe("function_unavailable");
    expect(classifyLifecycleError(pg("42883", "function public.evidence_update_study(uuid) does not exist"), 404, RPC).kind).toBe("function_unavailable");
    const other = pg("PGRST202", "Could not find the function public.search_papers(p_query) in the schema cache");
    expect(classifyLifecycleError(other, 404, RPC).kind).toBe("invalid_request");
    expect(classifyLifecycleError(pg("42P01", "relation \"public.evidence_studies\" does not exist"), 404, RPC).kind).toBe("database_error");
  });

  it("reads PostgREST's session errors as needing a sign-in", () => {
    expect(classifyLifecycleError(pg("PGRST301", "JWT expired"), 401, RPC).kind).toBe("auth_required");
    expect(classifyLifecycleError(pg("PGRST303", "JWT claims validation failed"), 401, RPC).kind).toBe("auth_required");
  });
});

describe("transport and transient failures", () => {
  it("leaves 'applied' unknown when no structured answer arrived, and resends the same request", () => {
    const network = { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" };
    expect(classifyLifecycleError(network, 0, RPC)).toMatchObject({ kind: "transport_uncertain", applied: "unknown", retry: "same_request" });
    expect(classifyLifecycleError({ message: "<html>502 Bad Gateway</html>" }, 502, RPC)).toMatchObject({ kind: "transport_uncertain", applied: "unknown" });
    expect(classifyLifecycleError({ message: "upstream timeout" }, 504, RPC).kind).toBe("transport_uncertain");
    expect(classifyLifecycleError(null, null, RPC).kind).toBe("transport_uncertain");
    expect(transportUncertainError().userMessage).toContain("it won't be applied twice");
  });

  it("knows the requests that never reached the database", () => {
    expect(classifyLifecycleError({ message: "Too Many Requests" }, 429, RPC)).toMatchObject({ kind: "service_unavailable", applied: "no" });
    expect(classifyLifecycleError({ message: "Request Timeout" }, 408, RPC).kind).toBe("service_unavailable");
    expect(classifyLifecycleError({ message: "Invalid API key" }, 401, RPC).kind).toBe("auth_required");
    expect(classifyLifecycleError({ message: "Bad Request" }, 400, RPC).kind).toBe("invalid_request");
    expect(classifyLifecycleError(pg("PGRST003", "Timed out acquiring connection from connection pool."), 504, RPC)).toMatchObject({ kind: "service_unavailable", applied: "no" });
    expect(classifyLifecycleError(pg("PGRST102", "Empty or invalid json"), 400, RPC).kind).toBe("invalid_request");
  });

  it("retries a transaction that failed for a transient reason with the same request", () => {
    for (const code of ["40001", "40P01", "55P03", "57014"]) {
      expect(classifyLifecycleError(pg(code, "transient"), 500, RPC)).toMatchObject({ kind: "database_busy", applied: "no", retry: "same_request" });
    }
  });

  it("keeps any other database error generic, with fixed copy that echoes nothing", () => {
    const leaky = pg("23514", 'new row for relation "evidence_studies" violates check constraint, id=0310dead-0000-0000-0000-000000000000');
    const error = classifyLifecycleError(leaky, 400, RPC);
    expect(error).toMatchObject({ kind: "database_error", code: "23514", applied: "no" });
    expect(error.userMessage).toBe("Couldn't save. Your changes are still here — try again.");
    expect(JSON.stringify(error)).not.toContain("0310dead");
    expect(JSON.stringify(error)).not.toContain("violates");
  });
});

describe("the evidence foreign keys (paper delete, duplicate merge, unlink backstop)", () => {
  const fk = (constraint: string, table = "evidence_study_reports") =>
    pg("23503", `update or delete on table "papers" violates foreign key constraint "${constraint}" on table "${table}"`, 'Key (user_id, id)=(a, b) is still referenced from table "x".');

  it("explains a paper a study record holds", () => {
    expect(classifyEvidenceForeignKeyError(fk("evidence_study_reports_paper_fkey"), 409)).toMatchObject({ kind: "paper_has_study_record", code: "23503", status: 409, applied: "no" });
    expect(classifyEvidenceForeignKeyError(fk("evidence_field_anchors_link_fkey", "evidence_field_anchors"))?.kind).toBe("link_in_use");
    expect(classifyEvidenceForeignKeyError(fk("evidence_field_anchors_snapshot_fkey", "evidence_field_anchors"))?.kind).toBe("link_in_use");
  });

  it("never masks an unrelated foreign-key violation or another error", () => {
    expect(classifyEvidenceForeignKeyError(fk("paper_tags_paper_id_fkey", "paper_tags"))).toBeNull();
    expect(classifyEvidenceForeignKeyError(fk("evidence_study_reports_paper_fkey_old"))).toBeNull();
    expect(classifyEvidenceForeignKeyError(pg("23505", 'duplicate key value violates unique constraint "evidence_study_reports_paper_fkey"'))).toBeNull();
    expect(classifyEvidenceForeignKeyError("23503")).toBeNull();
    expect(classifyLifecycleError(fk("paper_tags_paper_id_fkey", "paper_tags"), 409, RPC).kind).toBe("database_error");
    expect(classifyEvidenceForeignKeyError(fk("evidence_study_reports_paper_fkey"))?.userMessage).not.toContain("Key (");
  });
});

describe("the fixed PR-A3 refusals (EVIDENCE-RECORDS-001A3)", () => {
  const SAVE = "evidence_save_changes" as const;

  it.each<[string, string, EvidenceErrorKind, string]>([
    ["P0002", "evidence_target_not_found", "target_not_found", "not_found"],
    ["P0001", "evidence_quote_not_found", "quote_not_found", "validation"],
    ["P0001", "evidence_quote_ambiguous", "quote_ambiguous", "validation"],
    ["P0001", "evidence_confirm_blocked", "confirm_blocked", "validation"],
    ["P0001", "evidence_source_changed_again", "source_changed_again", "conflict"],
    ["P0001", "evidence_snapshot_limit", "snapshot_limit", "limit"],
    ["P0001", "evidence_arm_limit", "arm_limit", "limit"],
    ["P0001", "evidence_outcome_limit", "outcome_limit", "limit"],
    ["P0001", "evidence_value_limit", "value_limit", "limit"],
  ])("%s %s -> %s", (code, message, kind, category) => {
    expect(classifyLifecycleError(pg(code, message), 400, SAVE)).toMatchObject({ kind, category, applied: "no", code });
  });

  it("covers every refusal the PR-A3 migration raises, with the SQLSTATE it raises it with", () => {
    const sql = readRepoFile(PR_A3_MIGRATION);
    const raised = new Map<string, Set<string>>();
    for (const m of sql.matchAll(/RAISE EXCEPTION '(evidence_[a-z_]+)'\s+USING ERRCODE = '([a-z_]+)'/g)) {
      raised.set(m[1], (raised.get(m[1]) ?? new Set()).add(m[2]));
    }
    expect(raised.size).toBe(18);
    for (const [message, codes] of raised) {
      expect(codes.size, message).toBe(1);
      const sqlstate = SQLSTATES[[...codes][0]];
      expect(sqlstate, message).toBeDefined();
      const kind = classifyLifecycleError(pg(sqlstate, message), 400, SAVE).kind;
      expect(kind, message).not.toBe("database_error");
      // The same message under another SQLSTATE is not that refusal.
      expect(classifyLifecycleError(pg(sqlstate === "P0001" ? "P0002" : "P0001", message), 400, SAVE).kind, message).toBe("database_error");
    }
  });

  it("reads a payload DETAIL into the argument, the path and the rules", () => {
    const error = classifyLifecycleError(pg("22023", "evidence_invalid_input", "p_changes[3].references[1].snapshot_id: not_current"), 400, SAVE);
    expect(error).toMatchObject({ kind: "invalid_input", field: "changes", detail: { parameter: "changes", path: [3, "references", 1, "snapshot_id"], rules: ["not_current"] } });
    expect(classifyLifecycleError(pg("22023", "evidence_invalid_input", "p_changes[0].references: too_many_supporting,basis_required"), 400, SAVE).detail).toEqual({
      parameter: "changes",
      path: [0, "references"],
      rules: ["too_many_supporting", "basis_required"],
    });
    expect(classifyLifecycleError(pg("22023", "evidence_invalid_input", "p_changes: too_large"), 400, SAVE).detail).toEqual({ parameter: "changes", path: [], rules: ["too_large"] });
    expect(classifyLifecycleError(pg("22023", "evidence_invalid_input", "p_expected_abstract_sha256: source_empty"), 400, "evidence_rebase_source")).toMatchObject({
      field: "expectedAbstractSha256",
      detail: { rules: ["source_empty"] },
    });
    expect(classifyLifecycleError(pg("22023", "evidence_invalid_input", "p_note"), 400, "evidence_review_fields")).toMatchObject({ field: "note", detail: { path: [], rules: [] } });
  });

  it("reads where a not-found, a version conflict and a quote refusal point", () => {
    expect(classifyLifecycleError(pg("P0002", "evidence_target_not_found", "p_changes[2].target.arm_id"), 500, SAVE).detail).toEqual({ parameter: "changes", path: [2, "target", "arm_id"], rules: [] });
    expect(classifyLifecycleError(pg("P0002", "evidence_link_not_found", "p_changes[0].references[2].paper_id"), 500, SAVE).detail?.path).toEqual([0, "references", 2, "paper_id"]);
    expect(classifyLifecycleError(pg("P0001", "evidence_version_conflict", "p_changes[1].expected_value_version"), 400, SAVE)).toMatchObject({
      kind: "version_conflict",
      retry: "new_request_after_reload",
      detail: { path: [1, "expected_value_version"] },
    });
    expect(classifyLifecycleError(pg("P0001", "evidence_version_conflict", "p_expected_value_version"), 400, "evidence_review_fields").field).toBe("expectedValueVersion");
    expect(classifyLifecycleError(pg("P0001", "evidence_version_conflict"), 400, SAVE).detail).toBeNull();
    expect(classifyLifecycleError(pg("P0001", "evidence_quote_ambiguous", "p_changes[4].references[0]"), 400, SAVE).detail?.path).toEqual([4, "references", 0]);
  });

  it("reads what Confirm still needs, in checkConfirm's codes", () => {
    const blocked = classifyLifecycleError(pg("P0001", "evidence_confirm_blocked", "examined_source_missing,examined_abstract_not_current,note_missing"), 400, "evidence_review_fields");
    expect(blocked).toMatchObject({ kind: "confirm_blocked", blocks: ["examined_source_missing", "examined_abstract_not_current", "note_missing"], detail: null, field: null });
    for (const details of [null, "", "not_recorded", "stale_version", "note_missing,note_missing", "note_missing, count_not_confirmed", "made_up"]) {
      expect(classifyLifecycleError(pg("P0001", "evidence_confirm_blocked", details), 400, "evidence_review_fields").blocks, String(details)).toBeNull();
    }
  });

  it("drops a DETAIL that is not in the RPCs' grammar, and never echoes one", () => {
    for (const details of [
      "p_changes[3].references[1].quote_text: <script>",
      "p_changes[01]: invalid",
      "p_changes[3] : invalid",
      "p_unknown: invalid",
      "changes[3]: invalid",
      "p_changes[3].Quote: invalid",
      "p_changes[3]: invalid trailing",
      "Key (id)=(0310dead-0000-0000-0000-000000000000) is not present",
    ]) {
      const error = classifyLifecycleError(pg("22023", "evidence_invalid_input", details), 400, SAVE);
      expect(error, details).toMatchObject({ kind: "invalid_input", field: null, detail: null });
      expect(JSON.stringify(error)).not.toContain("0310dead");
      expect(JSON.stringify(error)).not.toContain("script");
    }
  });

  it("reports function_unavailable for a PR-A3 RPC only when its own function is missing", () => {
    const missing = pg("PGRST202", "Could not find the function public.evidence_save_changes(p_changes, p_expected_version, p_request_id, p_study_id) in the schema cache");
    expect(classifyLifecycleError(missing, 404, SAVE).kind).toBe("function_unavailable");
    expect(classifyLifecycleError(missing, 404, "evidence_review_fields").kind).toBe("invalid_request");
    expect(classifyLifecycleError(pg("42501", "permission denied for function evidence_locate_quote"), 403, SAVE).kind).toBe("permission_denied");
  });
});

describe("the RPC names", () => {
  it("are exactly the seven client RPCs the migrations grant", () => {
    expect([...EVIDENCE_LIFECYCLE_RPCS]).toEqual(["evidence_create_study_from_paper", "evidence_update_study", "evidence_set_link", "evidence_delete_study"]);
    expect([...EVIDENCE_FIELD_RPCS]).toEqual(["evidence_save_changes", "evidence_review_fields", "evidence_rebase_source"]);
    expect(isEvidenceLifecycleRpc("evidence_normalize_v1")).toBe(false);
    expect(isEvidenceLifecycleRpc("evidence_records_assert_writable")).toBe(false);
    expect(isEvidenceLifecycleRpc("evidence_save_changes")).toBe(false);
    const grants = (path: string) => Array.from(readRepoFile(path).matchAll(/GRANT EXECUTE ON FUNCTION public\.([a-z_0-9]+)\(/g), (m) => m[1]).sort();
    expect(grants("supabase/migrations/20261016104232_add_evidence_records_lifecycle_rpcs.sql")).toEqual([...EVIDENCE_LIFECYCLE_RPCS].sort());
    expect(grants(PR_A3_MIGRATION)).toEqual([...EVIDENCE_FIELD_RPCS].sort());
  });

  it("has a specification for every error kind", () => {
    for (const spec of Object.values(EVIDENCE_ERROR_SPECS)) {
      expect(spec.userMessage.length).toBeGreaterThan(0);
      expect(spec.userMessage).not.toMatch(/evidence_|SQL|uuid|[0-9a-f]{8}-[0-9a-f]{4}/i);
    }
  });
});
