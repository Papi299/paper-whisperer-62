import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { examinedAbstract, fullTextReference, historyRows, quoteReference, sha, textDigest, valueDigest } from "./historyFixtures";

/**
 * The History model reads digests and before/after objects; this suite ties
 * the shapes its tests use (`historyFixtures.ts`) to the installed writers
 * (EVIDENCE-RECORDS-001C2B). Each region of the two migrations that builds an
 * event's JSON is parsed — every `jsonb_build_object(...)`, split into its
 * top-level arguments, the keys being the string literals in key position —
 * and its key set must equal the keys the fixtures use for those events. A key
 * added to or dropped from an event by a later migration fails here, so the
 * History viewer is reconsidered rather than silently showing less, or
 * showing what it shouldn't.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const LIFECYCLE = readFileSync(join(ROOT, "supabase/migrations/20261016104232_add_evidence_records_lifecycle_rpcs.sql"), "utf8");
const FIELD_OPS = readFileSync(join(ROOT, "supabase/migrations/20261017155445_add_evidence_records_field_review_rebase_rpcs.sql"), "utf8");

/** The text between `start` and the next `end` after it, both found exactly once from where the search begins. */
function region(sql: string, start: string, end: string, from = 0): string {
  const at = sql.indexOf(start, from);
  if (at < 0) throw new Error(`marker not found: ${start}`);
  const stop = sql.indexOf(end, at + start.length);
  if (stop < 0) throw new Error(`end marker not found: ${end}`);
  return sql.slice(at, stop);
}

/** Every key of every `jsonb_build_object(...)` in `sql`, at any depth. Comments are removed first. */
function jsonbKeys(source: string): Set<string> {
  const sql = source.replace(/--[^\n]*/g, "");
  const keys = new Set<string>();
  const call = /jsonb_build_object\(/g;
  for (let match = call.exec(sql); match; match = call.exec(sql)) {
    const args: string[] = [];
    let current = "";
    let depth = 1;
    let quoted = false;
    for (let i = match.index + match[0].length; i < sql.length; i += 1) {
      const c = sql[i];
      if (quoted) {
        current += c;
        if (c === "'") {
          if (sql[i + 1] === "'") current += sql[++i];
          else quoted = false;
        }
        continue;
      }
      if (c === "'") quoted = true;
      else if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) break;
      } else if (c === "," && depth === 1) {
        args.push(current.trim());
        current = "";
        continue;
      }
      current += c;
    }
    args.push(current.trim());
    args.forEach((arg, index) => {
      const key = index % 2 === 0 ? /^'([a-z_0-9]+)'$/.exec(arg) : null;
      if (key) keys.add(key[1]);
    });
  }
  return keys;
}

/** Every object key in `value`, at any depth. */
function objectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => objectKeys(item, into));
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      objectKeys(inner, into);
    }
  }
  return into;
}

const sorted = (keys: Iterable<string>) => [...keys].sort();
const ENVELOPE = ["event_type", "target_id", "field_key", "before", "after"];
const fixtureKeys = (types: readonly string[], version?: number) =>
  objectKeys(
    historyRows()
      .filter((row) => types.includes(row.event_type) && (version === undefined || row.study_version === version))
      .map((row) => [row.before, row.after]),
  );

describe("the shapes History reads are the shapes the RPCs write", () => {
  it("a value digest (evidence_value_digest): every key, at every depth", () => {
    const sql = region(FIELD_OPS, "CREATE FUNCTION public.evidence_value_digest", "$fn$;");
    // Every content shape and every kind of reference, as the fixtures build them.
    const digests = [
      valueDigest({ valueId: "v", fieldKey: "condition", references: [quoteReference("a"), examinedAbstract("b"), fullTextReference("c")], note: textDigest(1, 2) }),
      valueDigest({ valueId: "v", fieldKey: "comparator_type", content: { code: "placebo" }, review: { status: "disputed", note: textDigest(2, 3) } }),
      valueDigest({ valueId: "v", fieldKey: "n_randomized", content: { reported_text: textDigest(3, 4), value: 1 } }),
      valueDigest({ valueId: "v", fieldKey: "registration_ids", content: { entries: { sha256: sha(4), count: 1 } } }),
    ];
    expect(sorted(objectKeys(digests))).toEqual(sorted(jsonbKeys(sql)));
  });

  it("create: study_created, link_created and the first source_captured", () => {
    const create = region(LIFECYCLE, "CREATE FUNCTION public.evidence_create_study_from_paper", "$fn$;");
    const sql = region(create, "INSERT INTO public.evidence_events", "RETURN v_result;");
    expect(sorted(fixtureKeys(["study_created", "link_created", "source_captured"], 1))).toEqual(sorted(jsonbKeys(sql)));
  });

  it("update: study_updated, with notes as a fingerprint", () => {
    const sql = region(LIFECYCLE, "IF v_study.label <> p_label THEN", "v_version := v_study.row_version + 1;");
    expect(sorted(fixtureKeys(["study_updated"]))).toEqual(sorted(jsonbKeys(sql)));
  });

  it("set_link: link_status_changed and link_removed", () => {
    const status = region(LIFECYCLE, "v_event  := 'link_status_changed';", "END IF;");
    expect(sorted(fixtureKeys(["link_status_changed"]))).toEqual(sorted(jsonbKeys(status)));
    const removed = region(LIFECYCLE, "SELECT coalesce(jsonb_agg(c.id ORDER BY c.seq), '[]'::jsonb) INTO v_copies", "v_after  := NULL;");
    // link_removed can't happen today (a last link can't be removed); its shape, as the model's own test builds it.
    expect(sorted(jsonbKeys(removed))).toEqual(sorted(["paper_id", "link_status", "link_basis", "snapshot_ids"]));
  });

  it("save, groups and outcomes: arm_* and outcome_*, with a removal's values", () => {
    const sql = region(FIELD_OPS, "-- -- Phase 2: groups and outcomes", "-- -- Phase 3:");
    const types = ["arm_added", "arm_updated", "arm_removed", "outcome_added", "outcome_updated", "outcome_removed"];
    expect(sorted(new Set([...ENVELOPE, ...fixtureKeys(types)]))).toEqual(sorted(jsonbKeys(sql)));
  });

  it("save, values: value_saved and value_cleared carry digests only", () => {
    const sql = region(FIELD_OPS, "-- -- Phase 5: write the values", "-- -- Phase 6:");
    expect(sorted(jsonbKeys(sql))).toEqual(sorted(ENVELOPE));
    expect(sql).toContain("v_before := public.evidence_value_digest(v_uid, v_value.id);");
    expect(sql).toContain("v_after := public.evidence_value_digest(v_uid, v_id);");
  });

  it("review: review_confirmed and review_flagged carry digests only", () => {
    const sql = region(FIELD_OPS, "CREATE FUNCTION public.evidence_review_fields", "$fn$;");
    const events = region(sql, "INSERT INTO public.evidence_events", "RETURN v_result;");
    expect(jsonbKeys(events).size).toBe(0);
    expect(sql).toContain("v_before := public.evidence_value_digest(v_uid, p_value_id);");
    expect(sql).toContain("v_after := public.evidence_value_digest(v_uid, p_value_id);");
    expect(sql).toContain("v_event := 'review_confirmed';");
    expect(sql).toContain("v_event := 'review_flagged';");
  });

  it("rebase: source_captured, anchor_rematched, anchor_not_rematched and source_rebased (review_needs_rereview carries digests)", () => {
    const rebase = region(FIELD_OPS, "CREATE FUNCTION public.evidence_rebase_source", "$fn$;");
    const sql = region(rebase, "-- The new copy. Copies are never updated", "v_version := v_current + 1;");
    const types = ["source_captured", "anchor_rematched", "anchor_not_rematched", "source_rebased"];
    expect(sorted(new Set([...ENVELOPE, ...fixtureKeys(types, 11)]))).toEqual(sorted(jsonbKeys(sql)));
    expect(sql).toContain("'event_type', 'review_needs_rereview'");
    expect(sql).toContain("'before', v_digests -> v_val.id::text, 'after', public.evidence_value_digest(v_uid, v_val.id)");
  });

  it("no installed function writes review_reset — History never has to interpret one", () => {
    for (const sql of [LIFECYCLE, FIELD_OPS]) {
      const code = sql.replace(/--[^\n]*/g, "");
      // No event is built with it, by a jsonb event list or an event variable.
      expect(code).not.toMatch(/'event_type',\s*'review_reset'/);
      expect(code).not.toMatch(/v_event\s*:=\s*'review_reset'/);
    }
    // And the migration says why: a save records the review it cleared.
    expect(FIELD_OPS).toContain("review_reset is not emitted: value_saved records the review it cleared.");
  });

  it("the parser sees keys, not values: a string value in key position is not a key", () => {
    expect(sorted(jsonbKeys("jsonb_build_object('event_type', 'arm_added', 'after', jsonb_build_object('x', 'y', 'n', f('a', 'b')))"))).toEqual(["after", "event_type", "n", "x"]);
    expect(sorted(jsonbKeys("-- jsonb_build_object('commented', 1)\njsonb_build_object('it''s', 1, 'k', 'v')"))).toEqual(["k"]);
  });
});
