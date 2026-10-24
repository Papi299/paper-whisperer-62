import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDITED_READ_RPCS,
  classifyStudyRecordRequest,
  watchStudyRecordTraffic,
  type WatchedPage,
  type WatchedRequest,
} from "./study-record-traffic";

/**
 * CI-E2E-EVIDENCE-WATCH-001: what the Study Record specs' network watch lets
 * through. Pure unit tests on stub requests — no browser, stack or network —
 * and, at the end, each audited read checked against the migrations that
 * define it, so the allowance cannot outlive the audit it rests on.
 */

const API = "http://127.0.0.1:54321";
const USER = "5f3c9a2e-1b7d-4e8a-9c6f-0d2e4b8a7c13";
/** Each spec's own study-record RPCs, as the specs pass them. */
const REVIEW_SPEC: ReadonlySet<string> = new Set(["evidence_save_changes", "evidence_update_study", "evidence_set_link", "evidence_review_fields"]);
const C1_SPEC: ReadonlySet<string> = new Set([
  "evidence_create_study_from_paper",
  "evidence_update_study",
  "evidence_save_changes",
  "evidence_set_link",
  "evidence_delete_study",
]);

/** A stub request; `body` is sent as JSON unless it is already a string. */
const request = (method: string, path: string, body?: unknown): WatchedRequest => ({
  method: () => method,
  url: () => `${API}${path}`,
  postData: () => (body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body)),
});
const classify = (method: string, path: string, body?: unknown, spec: ReadonlySet<string> = REVIEW_SPEC) =>
  classifyStudyRecordRequest(request(method, path, body), spec);
const rpc = (name: string) => `/rest/v1/rpc/${name}`;

describe("the dashboard's audited reads", () => {
  it("are exactly the three RPCs the dashboard sends unprompted, and cannot be added to", () => {
    expect(Object.keys(AUDITED_READ_RPCS).sort()).toEqual(["get_ai_quota_status", "get_current_user_access", "get_keyword_options"]);
    expect(Object.isFrozen(AUDITED_READ_RPCS)).toBe(true);
    for (const audit of Object.values(AUDITED_READ_RPCS)) {
      expect(Object.isFrozen(audit.args) && Object.isFrozen(audit.required)).toBe(true);
      expect(audit.required.every((arg) => audit.args.includes(arg))).toBe(true);
    }
  });

  it("allow get_keyword_options only as its audit allows: POSTed, with p_user_id and the filter arguments it takes", () => {
    expect(classify("POST", rpc("get_keyword_options"), { p_user_id: USER })).toEqual({ kind: "audited-read", rpc: "get_keyword_options" });
    const filtered = { p_user_id: USER, p_paper_ids: [USER], p_year_from: 2001, p_year_to: 2020, p_study_types: ["RCT"] };
    expect(classify("POST", rpc("get_keyword_options"), filtered).kind).toBe("audited-read");

    expect(classify("POST", rpc("get_keyword_options"), {})).toEqual({
      kind: "forbidden",
      rpc: "get_keyword_options",
      what: "rpc get_keyword_options (missing argument p_user_id)",
    });
    expect(classify("POST", rpc("get_keyword_options"), { p_user_id: USER, p_limit: 5 }).kind).toBe("forbidden");
    expect(classify("GET", `${rpc("get_keyword_options")}?p_user_id=${USER}`).kind).toBe("forbidden");
    expect(classify("POST", rpc("get_keyword_options"), `p_user_id=${USER}`).kind).toBe("forbidden");
    expect(classify("POST", rpc("get_keyword_options"), [USER]).kind).toBe("forbidden");
  });

  it("allow get_ai_quota_status only with p_user_id, and nothing else", () => {
    expect(classify("POST", rpc("get_ai_quota_status"), { p_user_id: USER })).toEqual({ kind: "audited-read", rpc: "get_ai_quota_status" });
    expect(classify("POST", rpc("get_ai_quota_status"), { p_user_id: USER, p_feature: "ai_analysis" })).toEqual({
      kind: "forbidden",
      rpc: "get_ai_quota_status",
      what: "rpc get_ai_quota_status (unexpected argument p_feature)",
    });
    expect(classify("POST", rpc("get_ai_quota_status"), {}).kind).toBe("forbidden");
    expect(classify("PATCH", rpc("get_ai_quota_status"), { p_user_id: USER }).kind).toBe("forbidden");
  });

  it("allow get_current_user_access only without arguments, in both specs", () => {
    for (const spec of [REVIEW_SPEC, C1_SPEC]) {
      expect(classify("POST", rpc("get_current_user_access"), {}, spec)).toEqual({ kind: "audited-read", rpc: "get_current_user_access" });
      expect(classify("POST", rpc("get_current_user_access"), undefined, spec).kind).toBe("audited-read");
      expect(classify("POST", rpc("get_current_user_access"), { p_user_id: USER }, spec).kind).toBe("forbidden");
    }
  });

  it("let a CORS preflight through, but no method other than POST for a call", () => {
    expect(classify("OPTIONS", rpc("get_keyword_options")).kind).toBe("audited-read");
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE"]) {
      expect(classify(method, rpc("get_ai_quota_status"), { p_user_id: USER })).toMatchObject({ kind: "forbidden", what: `rpc get_ai_quota_status (sent with ${method})` });
    }
  });

  it.each([
    "get_keyword_options_v2",
    "get_keyword_option",
    "xget_keyword_options",
    "GET_KEYWORD_OPTIONS",
    "get_ai_quota_status_admin",
    "reset_ai_quota_status",
    "get_export_status",
    "get_study_type_options",
    "get_duplicate_papers",
    "set_keyword_options",
    "get_current_user_access_for",
  ])("are matched by exact name, never by a get_ or _status pattern: %s is refused", (name) => {
    expect(classify("POST", rpc(name), { p_user_id: USER })).toEqual({ kind: "forbidden", rpc: name, what: `rpc ${name}` });
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("are not found among the names every object has: %s is refused", (name) => {
    expect(classify("POST", rpc(name), {})).toEqual({ kind: "forbidden", rpc: name, what: `rpc ${name}` });
  });
});

describe("the study-record RPCs", () => {
  it("are allowed by exact name, as each spec lists them, with their POST bodies", () => {
    const body = { p_study_id: USER, p_action: "confirm", p_note: null };
    expect(classify("POST", rpc("evidence_review_fields"), body)).toEqual({ kind: "study-record", rpc: "evidence_review_fields", body });
    expect(classify("POST", rpc("evidence_create_study_from_paper"), { p_label: "Doe 2024" }, C1_SPEC)).toMatchObject({ kind: "study-record" });
  });

  it("are refused where the spec doesn't use them", () => {
    for (const name of ["evidence_create_study_from_paper", "evidence_delete_study"]) {
      expect(classify("POST", rpc(name), {}, REVIEW_SPEC)).toEqual({ kind: "forbidden", rpc: name, what: `rpc ${name}` });
    }
    expect(classify("POST", rpc("evidence_review_fields"), {}, C1_SPEC).kind).toBe("forbidden");
  });

  it.each(["evidence_save_changes2", "evidence_save_changes_bulk", "evidence_review_fields_all", "EVIDENCE_SAVE_CHANGES"])(
    "match exactly: %s, which only starts like one, is refused",
    (name) => {
      expect(classify("POST", rpc(name), {})).toEqual({ kind: "forbidden", rpc: name, what: `rpc ${name}` });
    },
  );

  it.each(["consume_ai_quota", "delete_papers_with_attachment_cleanup", "merge_exact_duplicates", "evidence_records_assert_writable"])(
    "do not excuse a write RPC, however it is sent: %s",
    (name) => {
      for (const method of ["POST", "GET"]) {
        expect(classify(method, rpc(name), {}, C1_SPEC)).toEqual({ kind: "forbidden", rpc: name, what: `rpc ${name}` });
      }
    },
  );

  it("refuse a POST whose body isn't a JSON object, and a path that isn't one RPC", () => {
    expect(classify("POST", rpc("evidence_save_changes"), "p_study_id=1").kind).toBe("forbidden");
    expect(classify("POST", rpc("evidence_save_changes"), "[]").kind).toBe("forbidden");
    expect(classify("GET", `${rpc("get_keyword_options")}/extra`)).toEqual({ kind: "forbidden", what: "GET /rest/v1/rpc/get_keyword_options/extra" });
    expect(classify("POST", "/rest/v1/rpc/").kind).toBe("forbidden");
  });
});

describe("everything else the watch sees", () => {
  it.each(["POST", "PATCH", "PUT", "DELETE"])("refuses a direct table write: %s", (method) => {
    for (const table of ["papers", "evidence_field_values", "evidence_events"]) {
      expect(classify(method, `/rest/v1/${table}?id=eq.${USER}`, {})).toEqual({ kind: "forbidden", what: `${method} /rest/v1/${table}` });
    }
  });

  it("lets table reads pass", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(classify(method, `/rest/v1/papers?select=id`).kind).toBe("pass");
  });

  it.each(["POST", "GET", "OPTIONS"])("refuses every Edge Function call: %s", (method) => {
    expect(classify(method, "/functions/v1/analyze-paper", {})).toEqual({ kind: "forbidden", what: `${method} /functions/v1/analyze-paper` });
  });

  it("leaves Auth and Storage outside the watch, as before", () => {
    expect(classify("POST", "/auth/v1/token?grant_type=refresh_token", {}).kind).toBe("pass");
    expect(classify("GET", "/storage/v1/object/sign/attachments/a.pdf").kind).toBe("pass");
  });

  it("names a refusal by method and path or RPC — never by its query string or a value it carries", () => {
    const write = classify("PATCH", `/rest/v1/papers?id=eq.${USER}`, { title: "SECRET-TITLE" });
    const read = classify("POST", rpc("get_ai_quota_status"), { p_user_id: USER, p_extra: "SECRET-VALUE" });
    for (const verdict of [write, read]) {
      expect(verdict.kind).toBe("forbidden");
      expect(JSON.stringify(verdict)).not.toMatch(new RegExp(`${USER}|SECRET|\\?`));
    }
  });
});

describe("watchStudyRecordTraffic", () => {
  /** A page that delivers each sent request to its current listeners, as Playwright's does. */
  function fakePage() {
    const listeners = new Set<(request: WatchedRequest) => void>();
    const page: WatchedPage = {
      on: (_event, listener) => listeners.add(listener),
      off: (_event, listener) => listeners.delete(listener),
    };
    return { page, send: (sent: WatchedRequest) => listeners.forEach((listener) => listener(sent)), listeners };
  }

  it("keeps the dashboard's reads apart from the study-record calls, in order, until stopped", () => {
    const { page, send, listeners } = fakePage();
    const traffic = watchStudyRecordTraffic(page, [...REVIEW_SPEC]);
    expect(listeners.size).toBe(1);

    const review = { p_action: "confirm", p_note: null };
    send(request("POST", rpc("get_keyword_options"), { p_user_id: USER }));
    send(request("GET", "/rest/v1/evidence_studies?select=id"));
    send(request("POST", rpc("evidence_review_fields"), review));
    send(request("POST", rpc("get_ai_quota_status"), { p_user_id: USER }));
    send(request("POST", rpc("consume_ai_quota"), { p_user_id: USER }));
    send(request("PATCH", "/rest/v1/evidence_field_values?id=eq.1", {}));
    send(request("POST", "/functions/v1/analyze-paper", {}));

    expect(traffic.rpcs).toEqual(["get_keyword_options", "evidence_review_fields", "get_ai_quota_status", "consume_ai_quota"]);
    expect(traffic.reads).toEqual(["get_keyword_options", "get_ai_quota_status"]);
    expect(traffic.bodiesOf("evidence_review_fields")).toEqual([review]);
    expect(traffic.forbidden).toEqual(["rpc consume_ai_quota", "PATCH /rest/v1/evidence_field_values", "POST /functions/v1/analyze-paper"]);

    traffic.stop();
    expect(listeners.size).toBe(0);
    send(request("POST", rpc("evidence_review_fields"), review));
    send(request("POST", rpc("get_duplicate_papers"), {}));
    expect(traffic.bodiesOf("evidence_review_fields")).toHaveLength(1);
    expect(traffic.forbidden).toHaveLength(3);
  });

  it("keeps bodies of the spec's own RPCs only, as POSTed", () => {
    const { page, send } = fakePage();
    const traffic = watchStudyRecordTraffic(page, [...C1_SPEC]);
    const bodies = traffic.bodiesOf("evidence_save_changes"); // live: filled as requests arrive
    send(request("GET", rpc("evidence_save_changes")));
    send(request("POST", rpc("evidence_save_changes"), { p_changes: [] }));
    expect(bodies).toEqual([{ p_changes: [] }]);
    expect(() => traffic.bodiesOf("evidence_review_fields")).toThrow("evidence_review_fields is not one of this watch's study-record RPCs.");
  });
});

// ── Each audit, re-read from the migrations that define the function ─────────
//
// The database's own checks cover the installed catalog: migrations
// 20260926152414 and 20260926202754 assert each function's volatility, and
// pgTAP 020 pins get_keyword_options' body. This ties the watch's allowance to
// the same definitions: if one is redefined, re-audit it here.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATIONS = resolve(ROOT, "supabase/migrations");

/** The md5 of each audited body, as installed (`md5(prosrc)`). */
const AUDITED_BODIES: Record<string, string> = {
  get_current_user_access: "ae71f19d36042f6d3b5be43d0dda2556",
  get_keyword_options: "531010c10d84ee94c7c1e00d65a2e7f5",
  get_ai_quota_status: "212b9a3ed220e347e8d8ca486b6d83a1",
};

/** Statements a read may not run, as words. */
const WRITES = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY|CREATE|ALTER|DROP|GRANT|REVOKE|CALL|PERFORM|EXECUTE|NEXTVAL|SETVAL|LOCK|NOTIFY)\b/i;

/** Remove `--` and block comments and the contents of string literals: what is left is code. */
function codeOnly(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; i += 1) {
    if (sql.startsWith("--", i)) {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out += "\n";
    } else if (sql.startsWith("/*", i)) {
      i = sql.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 1;
    } else if (sql[i] === "'") {
      for (i += 1; i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'"); i += sql[i] === "'" ? 2 : 1);
      out += "''";
    } else {
      out += sql[i];
    }
  }
  return out;
}

/** The text inside the parentheses that open at `open`. */
function inParentheses(sql: string, open: number): string {
  let depth = 0;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === "(") depth += 1;
    if (sql[i] === ")" && --depth === 0) return sql.slice(open + 1, i);
  }
  throw new Error("unbalanced parentheses");
}

interface Definition {
  file: string;
  args: string[];
  signature: string;
  volatility: string;
  body: string;
}

interface Migration {
  file: string;
  sql: string;
}

/** The repository's migrations, in the order they apply. */
const MIGRATION_FILES: Migration[] = readdirSync(MIGRATIONS)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => ({ file, sql: readFileSync(resolve(MIGRATIONS, file), "utf8") }));

/** What `migrations`, in order, leave of `public.<name>`: its definitions since its last DROP, and its volatility now. */
function installed(name: string, migrations: Migration[] = MIGRATION_FILES): { definitions: Definition[]; volatility: string | null } {
  const ALIASES: Record<string, string> = { int: "integer", int4: "integer" };
  const VOLATILITY = /\b(VOLATILE|STABLE|IMMUTABLE)\b/i;
  let definitions: Definition[] = [];
  let volatility: string | null = null;
  for (const { file, sql } of migrations) {
    // Early migrations name the function without its schema (it is created in public either way).
    const statement = new RegExp(
      String.raw`^(CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|DROP\s+FUNCTION(?:\s+IF\s+EXISTS)?|ALTER\s+FUNCTION)\s+(?:"?public"?\.)?"?${name}"?\s*\(`,
      "gim",
    );
    for (let m = statement.exec(sql); m; m = statement.exec(sql)) {
      const open = m.index + m[0].length - 1;
      const raw = inParentheses(sql, open);
      const list = codeOnly(raw);
      const afterArgs = open + raw.length + 2;
      const verb = m[1].split(/\s+/)[0].toUpperCase();
      if (verb === "DROP") {
        definitions = [];
        volatility = null;
      } else if (verb === "ALTER") {
        const change = VOLATILITY.exec(codeOnly(sql.slice(afterArgs, sql.indexOf(";", afterArgs))));
        if (change) volatility = change[1].toUpperCase();
      } else {
        const tag = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(sql.slice(afterArgs));
        if (!tag) throw new Error(`${file}: no dollar-quoted body for ${name}`);
        const bodyStart = afterArgs + tag.index + tag[0].length;
        const bodyEnd = sql.indexOf(tag[1], bodyStart);
        const attributes = codeOnly(sql.slice(afterArgs, afterArgs + tag.index) + sql.slice(bodyEnd + tag[1].length, sql.indexOf(";", bodyEnd)));
        const args = list.split(",").map((arg) => arg.trim()).filter(Boolean);
        const parsed = args.map((arg) => arg.replace(/\s+DEFAULT\s+[\s\S]*$/i, "").split(/\s+/));
        definitions.push({
          file,
          args: parsed.map(([argName]) => argName.toLowerCase()),
          signature: parsed.map(([, ...type]) => ALIASES[type.join(" ").toLowerCase()] ?? type.join(" ").toLowerCase()).join(","),
          volatility: VOLATILITY.exec(attributes)?.[1].toUpperCase() ?? "VOLATILE",
          body: sql.slice(bodyStart, bodyEnd),
        });
        volatility = definitions[definitions.length - 1].volatility;
      }
    }
  }
  return { definitions, volatility };
}

describe("each audited read, as the migrations define it", () => {
  it.each(Object.keys(AUDITED_READ_RPCS))("%s: one signature, STABLE, the arguments allowed above, the audited body, and no write in it", (name) => {
    const { definitions, volatility } = installed(name);
    expect(definitions.length).toBeGreaterThan(0);
    // Every CREATE since the last DROP has the same signature: there is no overload a call could reach instead.
    expect(new Set(definitions.map((d) => d.signature)).size).toBe(1);
    expect(volatility).toBe("STABLE");
    const latest = definitions[definitions.length - 1];
    expect(latest.args).toEqual(AUDITED_READ_RPCS[name].args);
    expect(createHash("md5").update(latest.body, "utf8").digest("hex")).toBe(AUDITED_BODIES[name]);
    expect(codeOnly(latest.body)).not.toMatch(WRITES);
  });

  it("reads the history it was audited on: get_keyword_options was last dropped in 20260518010000, then replaced once", () => {
    expect(installed("get_keyword_options").definitions.map((d) => d.file)).toEqual([
      "20260518010000_rpc_auth_uid_ownership_check.sql",
      "20260802025704_harden_rpc_and_relational_ownership.sql",
    ]);
    expect(installed("get_ai_quota_status").definitions.map((d) => d.file)).toEqual(["20260725090000_add_internal_access_and_ai_quota_exemption.sql"]);
    expect(installed("get_current_user_access").definitions.map((d) => d.file)).toEqual(["20260902120000_add_ai_model_selection_foundation.sql"]);
  });

  it("would catch a later migration that makes a read volatile, overloads it, or writes in it (the checks can fail)", () => {
    const later = (sql: string): Migration[] => [...MIGRATION_FILES, { file: "29990101000000_negative_control.sql", sql }];
    expect(installed("get_ai_quota_status", later("ALTER FUNCTION public.get_ai_quota_status(uuid) VOLATILE;\n")).volatility).toBe("VOLATILE");
    const overload = installed(
      "get_keyword_options",
      later("CREATE OR REPLACE FUNCTION public.get_keyword_options(p_user_id uuid, p_reset boolean)\nRETURNS void LANGUAGE sql AS $$ SELECT 1 $$;\n"),
    );
    expect(new Set(overload.definitions.map((d) => d.signature)).size).toBe(2);
    expect(overload.volatility).toBe("VOLATILE");
    expect(codeOnly("BEGIN INSERT INTO t VALUES (1); END")).toMatch(WRITES);
    // Only code counts: a word in a comment or a string is not a statement.
    expect(codeOnly("BEGIN -- INSERT in a comment\n RAISE EXCEPTION 'no UPDATE here'; /* DELETE */ END")).not.toMatch(WRITES);
  });
});
