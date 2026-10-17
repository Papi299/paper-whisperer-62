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
import { EVIDENCE_LIFECYCLE_RPCS } from "../lifecycleRequests";
import { readRepoFile } from "./fixtures/vectors";

/**
 * Error classification for the four lifecycle RPCs: the fixed PR-A2 refusals,
 * PostgREST's own codes, transport failures, and the evidence foreign keys.
 */

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
    expect(error).toMatchObject({ kind, applied: "no", code, status, reserved: false });
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

describe("reserved PR-A3 contracts", () => {
  it("recognizes them only as reserved, not as deployed endpoints", () => {
    expect(classifyLifecycleError(pg("P0001", "evidence_quote_not_found"), 400, RPC)).toMatchObject({ kind: "quote_not_found", reserved: true });
    expect(classifyLifecycleError(pg("P0001", "evidence_source_changed_again"), 400, RPC)).toMatchObject({ kind: "source_changed_again", reserved: true });
    expect(classifyLifecycleError(pg("P0001", "evidence_snapshot_limit"), 400, RPC)).toMatchObject({ kind: "snapshot_limit", reserved: true });
    const sql = readRepoFile("supabase/migrations/20261016104232_add_evidence_records_lifecycle_rpcs.sql");
    for (const message of ["evidence_quote_not_found", "evidence_source_changed_again", "evidence_snapshot_limit"]) {
      expect(sql.includes(`RAISE EXCEPTION '${message}'`), `${message} must not be deployed yet`).toBe(false);
    }
  });
});

describe("the RPC names", () => {
  it("are exactly the four deployed client RPCs", () => {
    expect([...EVIDENCE_LIFECYCLE_RPCS]).toEqual(["evidence_create_study_from_paper", "evidence_update_study", "evidence_set_link", "evidence_delete_study"]);
    expect(isEvidenceLifecycleRpc("evidence_normalize_v1")).toBe(false);
    expect(isEvidenceLifecycleRpc("evidence_records_assert_writable")).toBe(false);
    const sql = readRepoFile("supabase/migrations/20261016104232_add_evidence_records_lifecycle_rpcs.sql");
    const granted = Array.from(sql.matchAll(/GRANT EXECUTE ON FUNCTION public\.([a-z_0-9]+)\(/g), (m) => m[1]);
    expect(granted.sort()).toEqual([...EVIDENCE_LIFECYCLE_RPCS].sort());
  });

  it("has a specification for every error kind", () => {
    for (const spec of Object.values(EVIDENCE_ERROR_SPECS)) {
      expect(spec.userMessage.length).toBeGreaterThan(0);
      expect(spec.userMessage).not.toMatch(/evidence_|SQL|uuid|[0-9a-f]{8}-[0-9a-f]{4}/i);
    }
  });
});
