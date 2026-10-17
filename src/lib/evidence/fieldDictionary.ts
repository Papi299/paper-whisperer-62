/**
 * The closed Study/PICO field dictionary (EVIDENCE-RECORDS-001B).
 *
 * Exactly the 23 field keys PR-A1 permits (`20261012031537`, CHECK
 * `evidence_field_values_field_key_check`), with the value shape and bounds of
 * `evidence_field_values_value_shape_check`. The field set is closed and a
 * key's meaning never changes: a new meaning gets a new key in a new migration
 * (Requirements-001 §H1). So this file may only follow the migration, never
 * lead it, and `fieldDictionary.parity.test.ts` re-derives every key, scope,
 * shape, bound and code list from the migration's SQL text and compares.
 *
 * Deliberately absent: `n_randomized_arm` (deferred, Q10), and anything that is
 * not a study characteristic — no results, effect sizes, significance or risk
 * of bias (Requirements-001 §F4). Paper metadata, TL;DR, `study_type` and
 * `statistical_methods` are not evidence and never prefill a field.
 *
 * Where each rule is enforced is recorded per field in `enforcement`, because
 * the sources differ and must not be confused:
 *   * `pr_a1_check` — a CHECK constraint of the applied PR-A1 migration;
 *   * `pr_a2_rpc` — an applied PR-A2 RPC (`20261016104232`);
 *   * `pr_a3_rpc` — the PR-A3 save RPC `evidence_save_changes`
 *     (`20261017155445`, EVIDENCE-RECORDS-001A3), whose own copy of this
 *     dictionary `fieldDictionary.parity.test.ts` compares with this one;
 *   * `none` — there is no rule (every design family allows the field).
 * Labels, sections and core/optional status are presentation metadata from
 * Requirements-001 §E3, §E13 and §H2-H5.
 */

import { deepFreeze } from "./freeze";

export const DESIGN_PROFILES = ["rct_parallel", "intervention_other", "non_intervention"] as const;
export type DesignProfile = (typeof DESIGN_PROFILES)[number];

/** The two families with groups (arms) and a number randomized (Requirements-001 §F2, §H3, §H4). */
export const INTERVENTION_DESIGN_PROFILES = ["rct_parallel", "intervention_other"] as const;

export const FIELD_SCOPES = ["study", "arm", "outcome"] as const;
export type FieldScope = (typeof FIELD_SCOPES)[number];

export const ARM_ROLES = ["intervention", "comparator"] as const;
export type ArmRole = (typeof ARM_ROLES)[number];

export const DESIGN_CLASSIFICATION_CODES = [
  "rct_parallel",
  "rct_cluster",
  "rct_crossover",
  "rct_other",
  "non_randomized_controlled",
  "single_group_intervention",
  "cohort",
  "case_control",
  "cross_sectional",
  "case_series",
  "other",
] as const;
export type DesignClassificationCode = (typeof DESIGN_CLASSIFICATION_CODES)[number];

export const COMPARATOR_TYPE_CODES = [
  "placebo",
  "sham",
  "usual_care",
  "no_intervention",
  "waitlist",
  "active_comparator",
  "other",
] as const;
export type ComparatorTypeCode = (typeof COMPARATOR_TYPE_CODES)[number];

export const OUTCOME_DESIGNATION_CODES = ["primary", "secondary"] as const;
export type OutcomeDesignationCode = (typeof OUTCOME_DESIGNATION_CODES)[number];

/** The four value shapes of the PR-A1 shape CHECK. */
export const VALUE_SHAPES = ["text", "code", "integer_with_reported_text", "text_list"] as const;
export type ValueShape = (typeof VALUE_SHAPES)[number];

export type FieldTier = "core" | "optional";
export type FieldSection = "study_design" | "participants" | "interventions" | "outcomes";
export type RuleSource = "pr_a1_check" | "pr_a2_rpc" | "pr_a3_rpc" | "none";

/** The integer range of a confirmed number (`value_int BETWEEN 0 AND 10000000`). */
export const COUNT_MIN = 0;
export const COUNT_MAX = 10_000_000;

interface FieldDefinitionBase {
  readonly key: string;
  readonly scope: FieldScope;
  readonly section: FieldSection;
  readonly label: string;
  /** The design families whose form shows the field. */
  readonly designProfiles: readonly DesignProfile[];
  /** For a group field, the roles it applies to; null for study and outcome fields. */
  readonly armRoles: readonly ArmRole[] | null;
  /** Core or optional, per design family where it differs (`n_enrolled`). */
  readonly tier: FieldTier | Readonly<Record<DesignProfile, FieldTier>>;
  readonly enforcement: {
    readonly scope: RuleSource;
    readonly shapeAndBounds: RuleSource;
    readonly designFamily: readonly RuleSource[];
    readonly armRole: RuleSource;
    readonly listHygiene: RuleSource;
  };
}

export interface TextFieldDefinition extends FieldDefinitionBase {
  readonly shape: "text";
  /** Characters are Unicode code points, as PostgreSQL's char_length counts them. */
  readonly text: { readonly minLength: 1; readonly maxLength: number };
}

export interface CodeFieldDefinition extends FieldDefinitionBase {
  readonly shape: "code";
  readonly codes: readonly string[];
}

export interface CountFieldDefinition extends FieldDefinitionBase {
  readonly shape: "integer_with_reported_text";
  /** The verbatim reported text AND the integer the user confirmed, always together. */
  readonly reportedText: { readonly minLength: 1; readonly maxLength: number };
  readonly integer: { readonly min: number; readonly max: number };
}

export interface ListFieldDefinition extends FieldDefinitionBase {
  readonly shape: "text_list";
  readonly list: {
    readonly minEntries: 1;
    readonly maxEntries: number;
    readonly entry: {
      readonly minLength: number;
      readonly maxLength: number;
      /** `none`: no white space anywhere; `inner_only`: none at either end. */
      readonly whitespace: "none" | "inner_only";
    };
  };
}

export type FieldDefinition = TextFieldDefinition | CodeFieldDefinition | CountFieldDefinition | ListFieldDefinition;

const ALL_PROFILES = DESIGN_PROFILES;
const BOTH_ROLES = ARM_ROLES;

const STUDY_RULES = {
  scope: "pr_a1_check",
  shapeAndBounds: "pr_a1_check",
  designFamily: ["none"],
  armRole: "none",
  listHygiene: "none",
} as const;

// Groups exist only in the intervention families. PR-A2 refuses moving a study
// that has any group to non_intervention; the PR-A3 save RPC refuses adding a
// group, or any group value, to a non_intervention study.
const ARM_RULES = {
  scope: "pr_a1_check",
  shapeAndBounds: "pr_a1_check",
  designFamily: ["pr_a2_rpc", "pr_a3_rpc"],
  armRole: "none",
  listHygiene: "none",
} as const;

const OUTCOME_RULES = STUDY_RULES;

const text = (maxLength: number) => ({ minLength: 1, maxLength }) as const;

const DEFINITIONS = {
  // ── Study-level fields (Requirements-001 §H2) ──────────────────────────────
  design_as_reported: {
    key: "design_as_reported",
    scope: "study",
    section: "study_design",
    label: "Design as described by the authors",
    shape: "text",
    text: text(500),
    designProfiles: ALL_PROFILES,
    armRoles: null,
    tier: "core",
    enforcement: STUDY_RULES,
  },
  design_classification: {
    key: "design_classification",
    scope: "study",
    section: "study_design",
    label: "Your classification of the design",
    shape: "code",
    codes: DESIGN_CLASSIFICATION_CODES,
    designProfiles: ALL_PROFILES,
    armRoles: null,
    tier: "core",
    enforcement: STUDY_RULES,
  },
  setting: {
    key: "setting",
    scope: "study",
    section: "study_design",
    label: "Setting (countries, care setting)",
    shape: "text",
    text: text(1000),
    designProfiles: ALL_PROFILES,
    armRoles: null,
    tier: "optional",
    enforcement: STUDY_RULES,
  },
  registration_ids: {
    key: "registration_ids",
    scope: "study",
    section: "study_design",
    label: "Trial registration numbers",
    shape: "text_list",
    list: { minEntries: 1, maxEntries: 5, entry: { minLength: 3, maxLength: 50, whitespace: "none" } },
    designProfiles: ALL_PROFILES,
    armRoles: null,
    tier: "optional",
    enforcement: { ...STUDY_RULES, listHygiene: "pr_a3_rpc" },
  },
  // ── Population fields, study level (§H3) ───────────────────────────────────
  population_description: {
    key: "population_description",
    scope: "study",
    section: "participants",
    label: "Who took part",
    shape: "text",
    text: text(2000),
    designProfiles: ALL_PROFILES,
    armRoles: null,
    tier: "core",
    enforcement: STUDY_RULES,
  },
  condition: {
    key: "condition",
    scope: "study",
    section: "participants",
    label: "Condition or health status",
    shape: "text",
    text: text(500),
    designProfiles: ALL_PROFILES,
    armRoles: null,
    tier: "core",
    enforcement: STUDY_RULES,
  },
  eligibility_criteria: {
    key: "eligibility_criteria",
    scope: "study",
    section: "participants",
    label: "Eligibility criteria, as reported",
    shape: "text",
    text: text(4000),
    designProfiles: ALL_PROFILES,
    armRoles: null,
    tier: "optional",
    enforcement: STUDY_RULES,
  },
  demographics: {
    key: "demographics",
    scope: "study",
    section: "participants",
    label: "Key demographics (for example age, sex)",
    shape: "text",
    text: text(2000),
    designProfiles: ALL_PROFILES,
    armRoles: null,
    tier: "optional",
    enforcement: STUDY_RULES,
  },
  n_randomized: {
    key: "n_randomized",
    scope: "study",
    section: "participants",
    label: "Number randomized",
    shape: "integer_with_reported_text",
    reportedText: text(200),
    integer: { min: COUNT_MIN, max: COUNT_MAX },
    designProfiles: INTERVENTION_DESIGN_PROFILES,
    armRoles: null,
    tier: "core",
    // PR-A2 refuses moving to non_intervention while an n_randomized value
    // exists; the PR-A3 save RPC refuses recording one there.
    enforcement: { ...STUDY_RULES, designFamily: ["pr_a2_rpc", "pr_a3_rpc"] },
  },
  n_enrolled: {
    key: "n_enrolled",
    scope: "study",
    section: "participants",
    label: "Number enrolled or included",
    shape: "integer_with_reported_text",
    reportedText: text(200),
    integer: { min: COUNT_MIN, max: COUNT_MAX },
    designProfiles: ALL_PROFILES,
    armRoles: null,
    tier: { rct_parallel: "optional", intervention_other: "optional", non_intervention: "core" },
    enforcement: STUDY_RULES,
  },
  // ── Group (arm) fields — intervention families only (§H4) ──────────────────
  arm_name_as_reported: {
    key: "arm_name_as_reported",
    scope: "arm",
    section: "interventions",
    label: "Group name as reported",
    shape: "text",
    text: text(300),
    designProfiles: INTERVENTION_DESIGN_PROFILES,
    armRoles: BOTH_ROLES,
    tier: "core",
    enforcement: ARM_RULES,
  },
  description: {
    key: "description",
    scope: "arm",
    section: "interventions",
    label: "What the group received",
    shape: "text",
    text: text(4000),
    designProfiles: INTERVENTION_DESIGN_PROFILES,
    armRoles: BOTH_ROLES,
    tier: "core",
    enforcement: ARM_RULES,
  },
  comparator_type: {
    key: "comparator_type",
    scope: "arm",
    section: "interventions",
    label: "Comparator type",
    shape: "code",
    codes: COMPARATOR_TYPE_CODES,
    designProfiles: INTERVENTION_DESIGN_PROFILES,
    armRoles: ["comparator"],
    tier: "core",
    // Comparator groups only: Requirements-001 §H4/§H6 give this to an RPC, and
    // PR-A1's header lists it among the rules it does not enforce. The PR-A3
    // save RPC enforces it, on the batch's final state.
    enforcement: { ...ARM_RULES, armRole: "pr_a3_rpc" },
  },
  dose_or_intensity: {
    key: "dose_or_intensity",
    scope: "arm",
    section: "interventions",
    label: "Dose or intensity",
    shape: "text",
    text: text(500),
    designProfiles: INTERVENTION_DESIGN_PROFILES,
    armRoles: BOTH_ROLES,
    tier: "core",
    enforcement: ARM_RULES,
  },
  frequency: {
    key: "frequency",
    scope: "arm",
    section: "interventions",
    label: "Frequency or schedule",
    shape: "text",
    text: text(500),
    designProfiles: INTERVENTION_DESIGN_PROFILES,
    armRoles: BOTH_ROLES,
    tier: "optional",
    enforcement: ARM_RULES,
  },
  duration: {
    key: "duration",
    scope: "arm",
    section: "interventions",
    label: "Duration",
    shape: "text",
    text: text(500),
    designProfiles: INTERVENTION_DESIGN_PROFILES,
    armRoles: BOTH_ROLES,
    tier: "core",
    enforcement: ARM_RULES,
  },
  delivery_mode: {
    key: "delivery_mode",
    scope: "arm",
    section: "interventions",
    label: "How it was delivered",
    shape: "text",
    text: text(500),
    designProfiles: INTERVENTION_DESIGN_PROFILES,
    armRoles: BOTH_ROLES,
    tier: "optional",
    enforcement: ARM_RULES,
  },
  co_interventions: {
    key: "co_interventions",
    scope: "arm",
    section: "interventions",
    label: "Co-interventions",
    shape: "text",
    text: text(1000),
    designProfiles: INTERVENTION_DESIGN_PROFILES,
    armRoles: BOTH_ROLES,
    tier: "optional",
    enforcement: ARM_RULES,
  },
  // ── Outcome fields — all families (§H5) ────────────────────────────────────
  outcome_name_as_reported: {
    key: "outcome_name_as_reported",
    scope: "outcome",
    section: "outcomes",
    label: "Outcome as named by the authors",
    shape: "text",
    text: text(500),
    designProfiles: ALL_PROFILES,
    armRoles: null,
    tier: "core",
    enforcement: OUTCOME_RULES,
  },
  outcome_definition: {
    key: "outcome_definition",
    scope: "outcome",
    section: "outcomes",
    label: "Definition",
    shape: "text",
    text: text(2000),
    designProfiles: ALL_PROFILES,
    armRoles: null,
    tier: "optional",
    enforcement: OUTCOME_RULES,
  },
  measurement_instrument: {
    key: "measurement_instrument",
    scope: "outcome",
    section: "outcomes",
    label: "Measurement instrument or method",
    shape: "text",
    text: text(500),
    designProfiles: ALL_PROFILES,
    armRoles: null,
    tier: "core",
    enforcement: OUTCOME_RULES,
  },
  outcome_designation: {
    key: "outcome_designation",
    scope: "outcome",
    section: "outcomes",
    label: "Primary or secondary",
    shape: "code",
    codes: OUTCOME_DESIGNATION_CODES,
    designProfiles: ALL_PROFILES,
    armRoles: null,
    tier: "core",
    enforcement: OUTCOME_RULES,
  },
  time_points: {
    key: "time_points",
    scope: "outcome",
    section: "outcomes",
    label: "Time points as reported",
    shape: "text_list",
    list: { minEntries: 1, maxEntries: 10, entry: { minLength: 1, maxLength: 100, whitespace: "inner_only" } },
    designProfiles: ALL_PROFILES,
    armRoles: null,
    tier: "core",
    enforcement: { ...OUTCOME_RULES, listHygiene: "pr_a3_rpc" },
  },
} as const satisfies Record<string, FieldDefinition>;

export type FieldKey = keyof typeof DEFINITIONS;
type Definitions = typeof DEFINITIONS;
export type FieldDefinitionOf<K extends FieldKey> = Definitions[K];
export type FieldKeyOfScope<S extends FieldScope> = {
  [K in FieldKey]: Definitions[K]["scope"] extends S ? K : never;
}[FieldKey];
export type FieldKeyOfShape<V extends ValueShape> = {
  [K in FieldKey]: Definitions[K]["shape"] extends V ? K : never;
}[FieldKey];
export type StudyFieldKey = FieldKeyOfScope<"study">;
export type ArmFieldKey = FieldKeyOfScope<"arm">;
export type OutcomeFieldKey = FieldKeyOfScope<"outcome">;
export type TextFieldKey = FieldKeyOfShape<"text">;
export type CodeFieldKey = FieldKeyOfShape<"code">;
export type CountFieldKey = FieldKeyOfShape<"integer_with_reported_text">;
export type ListFieldKey = FieldKeyOfShape<"text_list">;

/** Every field, keyed by field key. Deeply frozen. */
export const EVIDENCE_FIELDS: Readonly<Definitions> = deepFreeze(DEFINITIONS);

/** Keys per scope, in the order of the PR-A1 CHECK list. */
export const STUDY_FIELD_KEYS = deepFreeze([
  "design_as_reported",
  "design_classification",
  "setting",
  "registration_ids",
  "population_description",
  "condition",
  "eligibility_criteria",
  "demographics",
  "n_randomized",
  "n_enrolled",
] as const satisfies readonly StudyFieldKey[]);

export const ARM_FIELD_KEYS = deepFreeze([
  "arm_name_as_reported",
  "description",
  "comparator_type",
  "dose_or_intensity",
  "frequency",
  "duration",
  "delivery_mode",
  "co_interventions",
] as const satisfies readonly ArmFieldKey[]);

export const OUTCOME_FIELD_KEYS = deepFreeze([
  "outcome_name_as_reported",
  "outcome_definition",
  "measurement_instrument",
  "outcome_designation",
  "time_points",
] as const satisfies readonly OutcomeFieldKey[]);

export const FIELD_KEYS: readonly FieldKey[] = deepFreeze([...STUDY_FIELD_KEYS, ...ARM_FIELD_KEYS, ...OUTCOME_FIELD_KEYS]);

const FIELD_KEY_SET: ReadonlySet<string> = new Set(FIELD_KEYS);

export function isFieldKey(value: unknown): value is FieldKey {
  return typeof value === "string" && FIELD_KEY_SET.has(value);
}

export function isDesignProfile(value: unknown): value is DesignProfile {
  return typeof value === "string" && (DESIGN_PROFILES as readonly string[]).includes(value);
}

export function isArmRole(value: unknown): value is ArmRole {
  return typeof value === "string" && (ARM_ROLES as readonly string[]).includes(value);
}

export function getFieldDefinition<K extends FieldKey>(key: K): FieldDefinitionOf<K> {
  return EVIDENCE_FIELDS[key];
}

/** Core or optional for this design family. */
export function fieldTier(key: FieldKey, profile: DesignProfile): FieldTier {
  const tier: FieldDefinition["tier"] = EVIDENCE_FIELDS[key].tier;
  return typeof tier === "string" ? tier : tier[profile];
}

/** Whether the design family's form shows the field at all. */
export function isFieldAllowedForDesign(key: FieldKey, profile: DesignProfile): boolean {
  return (EVIDENCE_FIELDS[key].designProfiles as readonly DesignProfile[]).includes(profile);
}

/** Whether a group field applies to a group of this role (`comparator_type`: comparators only). */
export function isFieldAllowedForArmRole(key: ArmFieldKey, role: ArmRole): boolean {
  return (EVIDENCE_FIELDS[key].armRoles as readonly ArmRole[]).includes(role);
}

/** The keys a design family's form shows for one scope, in dictionary order. */
export function fieldKeysFor(scope: FieldScope, profile: DesignProfile, armRole?: ArmRole): FieldKey[] {
  return FIELD_KEYS.filter((key) => {
    const definition: FieldDefinition = EVIDENCE_FIELDS[key];
    if (definition.scope !== scope || !isFieldAllowedForDesign(key, profile)) return false;
    if (scope === "arm" && armRole) return (definition.armRoles ?? []).includes(armRole);
    return true;
  });
}

/** Labels for the design families (Requirements-001 §E2). */
export const DESIGN_PROFILE_LABELS: Readonly<Record<DesignProfile, string>> = deepFreeze({
  rct_parallel: "Randomized trial, parallel groups",
  intervention_other:
    "Another intervention study (cluster or crossover randomized, non-randomized controlled, single group)",
  non_intervention: "A study without an assigned intervention (cohort, case-control, cross-sectional…)",
});

/** What a design family cannot capture, shown to the user (Requirements-001 §F2). */
export const DESIGN_PROFILE_LIMITATIONS: Readonly<Record<DesignProfile, string | null>> = deepFreeze({
  rct_parallel: null,
  intervention_other:
    "Design-specific details — clusters, periods, washout, allocation method — aren't captured in this version.",
  non_intervention: "Exposure and comparison fields aren't available in this version.",
});

/**
 * Display labels for the closed code lists. The codes are the migration's; the
 * wording is provisional copy for PR-C1 (only the design-family labels above
 * come from the requirements).
 */
export const CODE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = deepFreeze({
  design_classification: {
    rct_parallel: "Randomized trial, parallel groups",
    rct_cluster: "Randomized trial, cluster",
    rct_crossover: "Randomized trial, crossover",
    rct_other: "Randomized trial, other design (for example factorial)",
    non_randomized_controlled: "Non-randomized controlled study",
    single_group_intervention: "Single-group intervention study",
    cohort: "Cohort study",
    case_control: "Case-control study",
    cross_sectional: "Cross-sectional study",
    case_series: "Case series",
    other: "Other",
  } satisfies Record<DesignClassificationCode, string>,
  comparator_type: {
    placebo: "Placebo",
    sham: "Sham",
    usual_care: "Usual care",
    no_intervention: "No intervention",
    waitlist: "Waitlist",
    active_comparator: "Active comparator",
    other: "Other",
  } satisfies Record<ComparatorTypeCode, string>,
  outcome_designation: {
    primary: "Primary",
    secondary: "Secondary",
  } satisfies Record<OutcomeDesignationCode, string>,
});
