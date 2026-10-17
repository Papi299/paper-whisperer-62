// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  ARM_ROLES,
  COUNT_MAX,
  COUNT_MIN,
  DESIGN_PROFILES,
  EVIDENCE_FIELDS,
  FIELD_KEYS,
  type FieldDefinition,
} from "../fieldDictionary";
import { MAX_POSTGRES_INTEGER } from "../ids";
import { QUOTE_MAX_LENGTH, QUOTE_MIN_LENGTH } from "../matcher";
import { ABSTRACT_MAX_LENGTH } from "../sources";
import {
  EVENT_TYPES,
  EXTRACTION_METHODS,
  LINK_ACTIONS,
  LINK_BASES,
  LINK_STATUSES,
  LOCATOR_KINDS,
  REFERENCE_PURPOSES,
  REFERENCE_SOURCE_KINDS,
  REQUEST_OPS,
  REVIEW_REASONS,
  REVIEW_STATUSES,
  SNAPSHOT_SOURCE_KINDS,
  STATE_REASONS,
  VALUE_STATES,
} from "../types";
import {
  LOCATOR_TEXT_MAX_LENGTH,
  MAX_SUPPORTING_REFERENCES,
  NOT_APPLICABLE_NOTE_MIN_LENGTH,
  STUDY_LABEL_MAX_LENGTH,
  STUDY_NOTES_MAX_LENGTH,
  UNCLEAR_NOTE_MIN_LENGTH,
  VALUE_NOTE_MAX_LENGTH,
} from "../validation";
import { FLAG_NOTE_MIN_LENGTH } from "../review";
import { readRepoFile } from "./fixtures/vectors";

/**
 * Drift detection: the TypeScript dictionary against the migrations' SQL.
 *
 * Every expected value here is DERIVED FROM THE SQL TEXT of the applied
 * migrations — the PR-A1 CHECK constraints and the PR-A2 argument checks and
 * family-change rule — never from the TypeScript under test, so the comparison
 * cannot be tautological. The negative controls at the end mutate each side
 * and prove that a missing key, an extra key, a wrong scope, shape, code list,
 * bound or design-family restriction each makes the comparison fail.
 *
 * Rules the requirements give to a later RPC are not in any SQL yet; they are
 * checked against the dictionary's own `enforcement` annotations, which must
 * say so.
 */

const PR_A1 = "supabase/migrations/20261012031537_add_evidence_records_foundation.sql";
const PR_A2 = "supabase/migrations/20261016104232_add_evidence_records_lifecycle_rpcs.sql";

// ── SQL reading ──────────────────────────────────────────────────────────────

/** Remove `--` comments, leaving string literals (and their `--`, if any) intact. */
function stripComments(sql: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/** The text inside the parentheses that open at `open`, respecting string literals. */
function balanced(sql: string, open: number): string {
  let depth = 0;
  let inString = false;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") inString = sql[i + 1] === "'" ? ((i += 1), true) : false;
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced parentheses at ${open}`);
}

/** The body of `CONSTRAINT <name> CHECK (...)`. */
function checkBody(sql: string, name: string): string {
  const at = sql.indexOf(`CONSTRAINT ${name}`);
  if (at === -1) throw new Error(`no constraint ${name}`);
  const check = sql.indexOf("CHECK", at);
  return balanced(sql, sql.indexOf("(", check)).replace(/\s+/g, " ");
}

/** Every 'literal' in `text`, in order. */
const literals = (text: string): string[] => Array.from(text.matchAll(/'((?:[^']|'')*)'/g), (m) => m[1].replace(/''/g, "'"));

/** The list in `<column> IN (...)` within `body`. */
function inList(body: string, column: string): string[] {
  const at = body.search(new RegExp(`\\b${column} IN \\(`));
  if (at === -1) throw new Error(`no IN list for ${column}`);
  return literals(balanced(body, body.indexOf("(", at)));
}

const number = (body: string, pattern: RegExp): number => {
  const match = pattern.exec(body);
  if (!match) throw new Error(`no match for ${pattern} in ${body.slice(0, 120)}`);
  return Number(match[1]);
};

// ── Facts derived from the PR-A1 field CHECKs ────────────────────────────────

interface SqlFieldFacts {
  key: string;
  scope: "study" | "arm" | "outcome";
  shape: FieldDefinition["shape"];
  textMax?: number;
  reportedTextMax?: number;
  integer?: [number, number];
  codes?: string[];
  list?: { minEntries: number; maxEntries: number; minLength: number; maxLength: number; whitespace: "none" | "inner_only" };
}

function parseFieldFacts(sqlText: string): SqlFieldFacts[] {
  const sql = stripComments(sqlText);
  const keyCheck = checkBody(sql, "evidence_field_values_field_key_check");
  const scopeOf = new Map<string, SqlFieldFacts["scope"]>();
  const branch = (marker: string) => {
    const at = keyCheck.indexOf(marker);
    if (at === -1) throw new Error(`no ${marker} branch`);
    return literals(balanced(keyCheck, keyCheck.indexOf("(", keyCheck.indexOf("field_key IN", at))));
  };
  for (const key of branch("WHEN arm_id IS NOT NULL")) scopeOf.set(key, "arm");
  for (const key of branch("WHEN outcome_id IS NOT NULL")) scopeOf.set(key, "outcome");
  for (const key of branch("ELSE field_key IN")) scopeOf.set(key, "study");


  const shapeCheck = checkBody(sql, "evidence_field_values_value_shape_check");
  const facts: SqlFieldFacts[] = [];
  // Each branch: WHEN field_key IN (...) | field_key = '...' THEN <body>, up to the next WHEN or ELSE.
  const branches = shapeCheck.split(/ WHEN /).slice(1);
  for (const raw of branches) {
    const [condition, rest] = raw.split(/ THEN /);
    const body = rest.split(/ ELSE false/)[0];
    const keys = condition.startsWith("field_key IN") ? literals(condition) : [literals(condition)[0]];
    let fact: Omit<SqlFieldFacts, "key" | "scope">;
    if (/value_list IS NOT NULL/.test(body)) {
      const regex = literals(body.slice(body.indexOf("~")))[0];
      const cardinality = /cardinality\(value_list\) BETWEEN (\d+) AND (\d+)/.exec(body);
      if (!cardinality) throw new Error("no cardinality");
      const none = /^\^\[\^\\s\\x1f\]\{(\d+),(\d+)\}/.exec(regex);
      const inner = /^\^\[\^\\s\\x1f\]\(\?:\[\^\\x1f\]\{0,(\d+)\}\[\^\\s\\x1f\]\)\?/.exec(regex);
      if (!none && !inner) throw new Error(`unknown list element pattern ${regex}`);
      fact = {
        shape: "text_list",
        list: {
          minEntries: Number(cardinality[1]),
          maxEntries: Number(cardinality[2]),
          minLength: none ? Number(none[1]) : 1,
          maxLength: none ? Number(none[2]) : Number(inner![1]) + 2,
          whitespace: none ? "none" : "inner_only",
        },
      };
    } else if (/value_code IS NOT NULL/.test(body)) {
      fact = { shape: "code", codes: inList(body, "value_code") };
    } else if (/value_int IS NOT NULL/.test(body)) {
      fact = {
        shape: "integer_with_reported_text",
        reportedTextMax: number(body, /char_length\(value_text\) <= (\d+)/),
        integer: [number(body, /value_int BETWEEN (\d+) AND/), number(body, /value_int BETWEEN \d+ AND (\d+)/)],
      };
    } else if (/value_text IS NOT NULL/.test(body)) {
      fact = { shape: "text", textMax: number(body, /char_length\(value_text\) <= (\d+)/) };
    } else {
      throw new Error(`unknown shape branch: ${body}`);
    }
    // The field-key CHECK decides which keys exist; a shape branch for any
    // other key permits nothing.
    for (const key of keys) {
      const scope = scopeOf.get(key);
      if (scope) facts.push({ key, scope, ...fact });
    }
  }
  const missingShape = [...scopeOf.keys()].filter((k) => !facts.some((f) => f.key === k));
  if (missingShape.length > 0) throw new Error(`keys without a shape: ${missingShape}`);
  // Scope by scope, each in the order of the field-key CHECK's list.
  const position = new Map([...scopeOf.keys()].map((key, index) => [key, index]));
  const rank = { study: 0, arm: 1, outcome: 2 } as const;
  return facts.sort((a, b) => rank[a.scope] - rank[b.scope] || (position.get(a.key) as number) - (position.get(b.key) as number));
}

/** PR-A2: moving to non_intervention is refused while any group or any listed field value exists. */
function parseFamilyRule(sqlText: string): { blockingProfile: string; blocksGroups: boolean; blockingKeys: string[] } {
  const sql = stripComments(sqlText);
  const body = sql.slice(sql.indexOf("CREATE FUNCTION public.evidence_update_study"), sql.indexOf("CREATE FUNCTION public.evidence_set_link"));
  const rule = /IF p_design_profile = '([a-z_]+)' AND v_study\.design_profile <> '[a-z_]+'([\s\S]*?)THEN\s+RAISE EXCEPTION 'evidence_profile_change_blocked'/.exec(body);
  if (!rule) throw new Error("no family-change rule");
  return {
    blockingProfile: rule[1],
    blocksGroups: /FROM public\.evidence_arms/.test(rule[2]),
    blockingKeys: Array.from(rule[2].matchAll(/field_key = '([a-z_]+)'/g), (m) => m[1]),
  };
}

// ── The comparison under test ────────────────────────────────────────────────

type Dictionary = Readonly<Record<string, FieldDefinition>>;

function compareDictionary(
  dictionary: Dictionary,
  facts: readonly SqlFieldFacts[],
  family: ReturnType<typeof parseFamilyRule>,
): string[] {
  const problems: string[] = [];
  const sqlKeys = new Set(facts.map((f) => f.key));
  for (const key of Object.keys(dictionary)) if (!sqlKeys.has(key)) problems.push(`extra key ${key}`);
  for (const fact of facts) {
    const def = dictionary[fact.key];
    if (!def) {
      problems.push(`missing key ${fact.key}`);
      continue;
    }
    if (def.key !== fact.key) problems.push(`${fact.key}: key property ${def.key}`);
    if (def.scope !== fact.scope) problems.push(`${fact.key}: scope ${def.scope}, SQL ${fact.scope}`);
    if (def.shape !== fact.shape) {
      problems.push(`${fact.key}: shape ${def.shape}, SQL ${fact.shape}`);
      continue;
    }
    if (def.shape === "text" && def.text.maxLength !== fact.textMax) problems.push(`${fact.key}: text max ${def.text.maxLength}, SQL ${fact.textMax}`);
    if (def.shape === "code" && JSON.stringify(def.codes) !== JSON.stringify(fact.codes)) problems.push(`${fact.key}: codes differ`);
    if (def.shape === "integer_with_reported_text") {
      if (def.reportedText.maxLength !== fact.reportedTextMax) problems.push(`${fact.key}: reported text max differs`);
      if (def.integer.min !== fact.integer![0] || def.integer.max !== fact.integer![1]) problems.push(`${fact.key}: integer range differs`);
    }
    if (def.shape === "text_list") {
      const got = { minEntries: def.list.minEntries, maxEntries: def.list.maxEntries, ...def.list.entry };
      if (JSON.stringify(got) !== JSON.stringify({ ...fact.list })) problems.push(`${fact.key}: list bounds differ`);
    }
    // Design family: PR-A2 refuses non_intervention while groups or the listed values exist; nothing restricts the others.
    const blocked = fact.scope === "arm" ? family.blocksGroups : family.blockingKeys.includes(fact.key);
    const profiles = def.designProfiles as readonly string[];
    if (profiles.includes(family.blockingProfile) === blocked) problems.push(`${fact.key}: ${family.blockingProfile} allowed is ${!blocked} in SQL`);
    for (const profile of DESIGN_PROFILES) {
      if (profile !== family.blockingProfile && !profiles.includes(profile)) problems.push(`${fact.key}: ${profile} missing`);
    }
    if (blocked && !def.enforcement.designFamily.includes("pr_a2_rpc")) problems.push(`${fact.key}: family rule source not pr_a2_rpc`);
    if (!blocked && JSON.stringify(def.enforcement.designFamily) !== JSON.stringify(["none"])) problems.push(`${fact.key}: unrestricted but annotated`);
  }
  return problems;
}

// ── The real comparison ──────────────────────────────────────────────────────

/** The migration's text with comment markers removed and white space collapsed: its prose, readable as sentences. */
const prose = (sql: string) => sql.split("\n").map((line) => line.replace(/^\s*--\s?/, "")).join(" ").replace(/\s+/g, " ");

const pra1 = readRepoFile(PR_A1);
const pra2 = readRepoFile(PR_A2);
const facts = parseFieldFacts(pra1);
const family = parseFamilyRule(pra2);
const sql1 = stripComments(pra1);
const sql2 = stripComments(pra2);

describe("the dictionary equals the PR-A1 field CHECKs and the PR-A2 family rule", () => {
  it("derives 23 keys from the migration, 10 study, 8 group and 5 outcome", () => {
    expect(facts).toHaveLength(23);
    expect(facts.filter((f) => f.scope === "study")).toHaveLength(10);
    expect(facts.filter((f) => f.scope === "arm")).toHaveLength(8);
    expect(facts.filter((f) => f.scope === "outcome")).toHaveLength(5);
    expect(family).toEqual({ blockingProfile: "non_intervention", blocksGroups: true, blockingKeys: ["n_randomized"] });
  });

  it("has no mismatch in keys, scopes, shapes, bounds, code lists or design families", () => {
    expect(compareDictionary(EVIDENCE_FIELDS as unknown as Dictionary, facts, family)).toEqual([]);
  });

  it("lists the keys in the migration's order", () => {
    expect([...FIELD_KEYS]).toEqual([
      ...facts.filter((f) => f.scope === "study").map((f) => f.key),
      ...facts.filter((f) => f.scope === "arm").map((f) => f.key),
      ...facts.filter((f) => f.scope === "outcome").map((f) => f.key),
    ]);
  });

  it("has no key the migration defers or omits", () => {
    expect(Object.keys(EVIDENCE_FIELDS)).not.toContain("n_randomized_arm");
    expect(prose(pra1)).toContain("`n_randomized_arm` is deferred");
  });

  it("annotates the comparator-only rule as a planned RPC rule, as the migration says it is", () => {
    expect(EVIDENCE_FIELDS.comparator_type.armRoles).toEqual(["comparator"]);
    expect(EVIDENCE_FIELDS.comparator_type.enforcement.armRole).toBe("pr_a3_planned");
    expect(prose(pra1)).toContain("`comparator_type` appears only on comparator groups");
    for (const key of FIELD_KEYS.filter((k) => k !== "comparator_type")) expect(EVIDENCE_FIELDS[key].enforcement.armRole).toBe("none");
  });

  it("annotates list hygiene (trim, de-duplicate) as a planned RPC rule", () => {
    expect(prose(pra1)).toContain("Trimming and de-duplication are the RPC's");
    for (const key of FIELD_KEYS) {
      const expected = EVIDENCE_FIELDS[key].shape === "text_list" ? "pr_a3_planned" : "none";
      expect(EVIDENCE_FIELDS[key].enforcement.listHygiene).toBe(expected);
      expect(EVIDENCE_FIELDS[key].enforcement.scope).toBe("pr_a1_check");
      expect(EVIDENCE_FIELDS[key].enforcement.shapeAndBounds).toBe("pr_a1_check");
    }
  });
});

describe("every other closed vocabulary and bound equals the SQL", () => {
  it.each([
    ["evidence_studies_design_profile_check", "design_profile", DESIGN_PROFILES],
    ["evidence_study_reports_link_status_check", "link_status", LINK_STATUSES],
    ["evidence_study_reports_link_basis_check", "link_basis", LINK_BASES],
    ["evidence_arms_arm_role_check", "arm_role", ARM_ROLES],
    ["evidence_field_values_value_state_check", "value_state", VALUE_STATES],
    ["evidence_field_values_state_reason_check", "state_reason", STATE_REASONS],
    ["evidence_field_values_review_status_check", "review_status", REVIEW_STATUSES],
    ["evidence_field_anchors_purpose_check", "purpose", REFERENCE_PURPOSES],
    ["evidence_field_anchors_source_kind_check", "source_kind", REFERENCE_SOURCE_KINDS],
    ["evidence_field_anchors_locator_kind_check", "locator_kind", LOCATOR_KINDS],
    ["evidence_events_event_type_check", "event_type", EVENT_TYPES],
    ["evidence_events_op_check", "op", REQUEST_OPS],
  ] as const)("%s", (constraint, column, list) => {
    expect(inList(checkBody(sql1, constraint), column)).toEqual([...list]);
  });

  it("single-value vocabularies", () => {
    expect(checkBody(sql1, "evidence_source_snapshots_source_kind_check")).toContain(`source_kind = '${SNAPSHOT_SOURCE_KINDS[0]}'`);
    expect(checkBody(sql1, "evidence_field_values_extraction_method_check")).toContain(`extraction_method = '${EXTRACTION_METHODS[0]}'`);
    expect(checkBody(sql1, "evidence_field_values_review_reason_check")).toContain(`review_reason = '${REVIEW_REASONS[0]}'`);
  });

  it("text and count bounds", () => {
    expect(checkBody(sql1, "evidence_studies_label_check")).toContain(`char_length(label) <= ${STUDY_LABEL_MAX_LENGTH}`);
    expect(checkBody(sql1, "evidence_studies_notes_check")).toContain(`char_length(notes) <= ${STUDY_NOTES_MAX_LENGTH}`);
    expect(checkBody(sql1, "evidence_field_values_note_check")).toContain(`char_length(note) <= ${VALUE_NOTE_MAX_LENGTH}`);
    expect(checkBody(sql1, "evidence_field_values_review_note_check")).toContain(`char_length(review_note) <= ${VALUE_NOTE_MAX_LENGTH}`);
    expect(checkBody(sql1, "evidence_field_values_review_note_check")).toContain(`>= ${FLAG_NOTE_MIN_LENGTH}`);
    const stateNote = checkBody(sql1, "evidence_field_values_state_note_check");
    expect(stateNote).toContain(`WHEN 'unclear' THEN char_length(btrim(coalesce(note, ''))) >= ${UNCLEAR_NOTE_MIN_LENGTH}`);
    expect(stateNote).toContain(`WHEN 'not_applicable' THEN char_length(btrim(coalesce(note, ''))) >= ${NOT_APPLICABLE_NOTE_MIN_LENGTH}`);
    expect(checkBody(sql1, "evidence_field_anchors_quote_text_check")).toContain(`BETWEEN ${QUOTE_MIN_LENGTH} AND ${QUOTE_MAX_LENGTH}`);
    expect(checkBody(sql1, "evidence_field_anchors_locator_text_check")).toContain(`char_length(locator_text) <= ${LOCATOR_TEXT_MAX_LENGTH}`);
    expect(checkBody(sql1, "evidence_field_anchors_position_check")).toContain(`BETWEEN 0 AND ${MAX_SUPPORTING_REFERENCES - 1}`);
    expect(checkBody(sql1, "evidence_source_snapshots_exact_text_check")).toContain(`BETWEEN 1 AND ${ABSTRACT_MAX_LENGTH}`);
    expect(checkBody(sql1, "evidence_field_values_value_shape_check")).toContain(`value_int BETWEEN ${COUNT_MIN} AND ${COUNT_MAX}`);
  });

  it("the PR-A2 argument checks", () => {
    const create = sql2.slice(sql2.indexOf("CREATE FUNCTION public.evidence_create_study_from_paper"), sql2.indexOf("CREATE FUNCTION public.evidence_update_study"));
    expect(create).toContain(`char_length(p_label) > ${STUDY_LABEL_MAX_LENGTH} OR public.evidence_normalize_v1(p_label) = ''`);
    expect(inList(create.replace(/\s+/g, " "), "p_design_profile NOT")).toEqual([...DESIGN_PROFILES]);
    expect(inList(create.replace(/\s+/g, " "), "p_link_status NOT")).toEqual([...LINK_STATUSES]);
    expect(create).toContain(`char_length(v_abstract) > ${ABSTRACT_MAX_LENGTH}`);
    const update = sql2.slice(sql2.indexOf("CREATE FUNCTION public.evidence_update_study"), sql2.indexOf("CREATE FUNCTION public.evidence_set_link"));
    expect(update).toContain(`char_length(p_notes) > ${STUDY_NOTES_MAX_LENGTH} OR public.evidence_normalize_v1(p_notes) = ''`);
    expect(update).toContain(`p_expected_version IS NULL OR p_expected_version < 1`);
    const setLink = sql2.slice(sql2.indexOf("CREATE FUNCTION public.evidence_set_link"), sql2.indexOf("CREATE FUNCTION public.evidence_delete_study"));
    expect(inList(setLink.replace(/\s+/g, " "), "p_action NOT")).toEqual([...LINK_ACTIONS]);
    expect(MAX_POSTGRES_INTEGER).toBe(2 ** 31 - 1);
  });
});

describe("negative controls: the comparison is not tautological", () => {
  const clone = () => structuredClone(EVIDENCE_FIELDS) as unknown as Record<string, Record<string, unknown>>;
  const compare = (dictionary: Record<string, unknown>) => compareDictionary(dictionary as unknown as Dictionary, facts, family);

  it.each([
    ["a missing key", (d: Record<string, Record<string, unknown>>) => delete d.setting, "missing key setting"],
    ["an extra key", (d: Record<string, Record<string, unknown>>) => (d.n_randomized_arm = { ...d.n_randomized, key: "n_randomized_arm" }), "extra key n_randomized_arm"],
    ["a wrong scope", (d: Record<string, Record<string, unknown>>) => (d.condition.scope = "outcome"), "condition: scope outcome, SQL study"],
    ["a wrong shape", (d: Record<string, Record<string, unknown>>) => (d.duration = { ...d.duration, shape: "text_list" }), "duration: shape text_list, SQL text"],
    ["a wrong code list", (d: Record<string, Record<string, unknown>>) => (d.comparator_type.codes = ["placebo", "sham"]), "comparator_type: codes differ"],
    ["a reordered code list", (d: Record<string, Record<string, unknown>>) => (d.outcome_designation.codes = ["secondary", "primary"]), "outcome_designation: codes differ"],
    ["a wrong text bound", (d: Record<string, Record<string, unknown>>) => (d.setting.text = { minLength: 1, maxLength: 999 }), "setting: text max 999, SQL 1000"],
    ["a wrong integer bound", (d: Record<string, Record<string, unknown>>) => (d.n_enrolled.integer = { min: 0, max: 9_999_999 }), "n_enrolled: integer range differs"],
    ["a wrong list bound", (d: Record<string, Record<string, unknown>>) => (d.time_points.list = { minEntries: 1, maxEntries: 11, entry: { minLength: 1, maxLength: 100, whitespace: "inner_only" } }), "time_points: list bounds differ"],
    ["a group field allowed in non_intervention", (d: Record<string, Record<string, unknown>>) => (d.frequency.designProfiles = [...DESIGN_PROFILES]), "frequency: non_intervention allowed is false in SQL"],
    ["n_randomized allowed in non_intervention", (d: Record<string, Record<string, unknown>>) => (d.n_randomized.designProfiles = [...DESIGN_PROFILES]), "n_randomized: non_intervention allowed is false in SQL"],
    ["a study field forbidden in non_intervention", (d: Record<string, Record<string, unknown>>) => (d.condition.designProfiles = ["rct_parallel", "intervention_other"]), "condition: non_intervention allowed is true in SQL"],
    ["a field missing an intervention family", (d: Record<string, Record<string, unknown>>) => (d.description.designProfiles = ["rct_parallel"]), "description: intervention_other missing"],
  ])("catches %s", (_label, mutate, expected) => {
    const dictionary = clone();
    mutate(dictionary);
    expect(compare(dictionary)).toContain(expected);
  });

  it.each([
    ["a key removed from the CHECK list", (s: string) => s.replace("'delivery_mode',\n                'co_interventions')", "'co_interventions')"), "extra key delivery_mode"],
    ["a key added to the CHECK list", (s: string) => s.replace("'measurement_instrument', 'outcome_designation', 'time_points')", "'measurement_instrument', 'outcome_designation', 'time_points', 'effect_size')").replace("WHEN field_key = 'time_points'", "WHEN field_key = 'effect_size' THEN value_text IS NOT NULL AND char_length(value_text) <= 50\n            WHEN field_key = 'time_points'"), "missing key effect_size"],
    ["a changed text bound", (s: string) => s.replace("AND char_length(value_text) <= 300 AND", "AND char_length(value_text) <= 301 AND"), "arm_name_as_reported: text max 300, SQL 301"],
    ["a changed code list", (s: string) => s.replace("'waitlist', 'active_comparator', 'other')", "'waitlist', 'active_comparator', 'attention_control', 'other')"), "comparator_type: codes differ"],
    ["a changed cardinality", (s: string) => s.replace("cardinality(value_list) BETWEEN 1 AND 5", "cardinality(value_list) BETWEEN 1 AND 6"), "registration_ids: list bounds differ"],
    ["a key moved to another scope", (s: string) => s.replace("'outcome_name_as_reported', 'outcome_definition',", "'outcome_definition',").replace("'design_as_reported', 'design_classification', 'setting',", "'design_as_reported', 'design_classification', 'setting', 'outcome_name_as_reported',"), "outcome_name_as_reported: scope outcome, SQL study"],
  ])("catches %s in the SQL", (_label, mutate, expected) => {
    const mutated = mutate(pra1);
    expect(mutated).not.toBe(pra1);
    expect(compareDictionary(EVIDENCE_FIELDS as unknown as Dictionary, parseFieldFacts(mutated), family)).toContain(expected);
  });

  it("catches a changed family rule in the PR-A2 SQL", () => {
    const mutated = pra2.replace("fv.field_key = 'n_randomized'", "fv.field_key = 'n_enrolled'");
    expect(mutated).not.toBe(pra2);
    const problems = compareDictionary(EVIDENCE_FIELDS as unknown as Dictionary, facts, parseFamilyRule(mutated));
    // SQL now blocks n_enrolled instead: both keys disagree with the dictionary.
    expect(problems).toContain("n_randomized: non_intervention allowed is true in SQL");
    expect(problems).toContain("n_enrolled: non_intervention allowed is false in SQL");
  });

  it("does not read rules out of comments", () => {
    const commented = pra1.replace(
      "    CONSTRAINT evidence_field_values_field_key_check CHECK (",
      "    -- CONSTRAINT evidence_field_values_field_key_check CHECK (field_key IN ('decoy'))\n    CONSTRAINT evidence_field_values_field_key_check CHECK (",
    );
    expect(commented).not.toBe(pra1);
    expect(parseFieldFacts(commented)).toEqual(facts);
  });
});
