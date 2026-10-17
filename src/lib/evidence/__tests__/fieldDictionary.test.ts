// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  ARM_FIELD_KEYS,
  CODE_LABELS,
  DESIGN_PROFILE_LABELS,
  DESIGN_PROFILE_LIMITATIONS,
  DESIGN_PROFILES,
  EVIDENCE_FIELDS,
  FIELD_KEYS,
  fieldKeysFor,
  fieldTier,
  getFieldDefinition,
  isArmRole,
  isDesignProfile,
  isFieldAllowedForArmRole,
  isFieldAllowedForDesign,
  isFieldKey,
  OUTCOME_FIELD_KEYS,
  STUDY_FIELD_KEYS,
  type FieldDefinition,
} from "../fieldDictionary";

/**
 * The closed field dictionary's inventory and metadata, against lists written
 * out here from the brief and Requirements-001 §H2-H5 / §E13 — independent of
 * both the module and the migration (the SQL comparison is the parity suite).
 */

const BRIEF_STUDY = [
  "design_as_reported", "design_classification", "setting", "registration_ids", "population_description",
  "condition", "eligibility_criteria", "demographics", "n_randomized", "n_enrolled",
];
const BRIEF_ARM = [
  "arm_name_as_reported", "description", "comparator_type", "dose_or_intensity", "frequency", "duration",
  "delivery_mode", "co_interventions",
];
const BRIEF_OUTCOME = ["outcome_name_as_reported", "outcome_definition", "measurement_instrument", "outcome_designation", "time_points"];

/** Requirements-001 §H2-H5, the Label column. */
const REQUIREMENTS_LABELS: Record<string, string> = {
  design_as_reported: "Design as described by the authors",
  design_classification: "Your classification of the design",
  setting: "Setting (countries, care setting)",
  registration_ids: "Trial registration numbers",
  population_description: "Who took part",
  condition: "Condition or health status",
  eligibility_criteria: "Eligibility criteria, as reported",
  demographics: "Key demographics (for example age, sex)",
  n_randomized: "Number randomized",
  n_enrolled: "Number enrolled or included",
  arm_name_as_reported: "Group name as reported",
  description: "What the group received",
  comparator_type: "Comparator type",
  dose_or_intensity: "Dose or intensity",
  frequency: "Frequency or schedule",
  duration: "Duration",
  delivery_mode: "How it was delivered",
  co_interventions: "Co-interventions",
  outcome_name_as_reported: "Outcome as named by the authors",
  outcome_definition: "Definition",
  measurement_instrument: "Measurement instrument or method",
  outcome_designation: "Primary or secondary",
  time_points: "Time points as reported",
};

/** Requirements-001 §E13 / §H: the core fields ("number randomized or enrolled" as §H3 qualifies it). */
const REQUIREMENTS_CORE = new Set([
  "design_as_reported", "design_classification", "population_description", "condition", "n_randomized",
  "arm_name_as_reported", "description", "dose_or_intensity", "duration", "comparator_type",
  "outcome_name_as_reported", "measurement_instrument", "time_points", "outcome_designation",
]);

describe("the closed inventory", () => {
  it("is exactly the 23 keys the brief lists, by scope and in order", () => {
    expect([...STUDY_FIELD_KEYS]).toEqual(BRIEF_STUDY);
    expect([...ARM_FIELD_KEYS]).toEqual(BRIEF_ARM);
    expect([...OUTCOME_FIELD_KEYS]).toEqual(BRIEF_OUTCOME);
    expect([...FIELD_KEYS]).toEqual([...BRIEF_STUDY, ...BRIEF_ARM, ...BRIEF_OUTCOME]);
    expect(Object.keys(EVIDENCE_FIELDS).sort()).toEqual([...FIELD_KEYS].sort());
  });

  it("holds no deferred field and nothing that is a result rather than a characteristic", () => {
    expect(isFieldKey("n_randomized_arm")).toBe(false);
    for (const key of FIELD_KEYS) {
      expect(key).not.toMatch(/result|effect|p_?value|significan|risk_of_bias|bias|grade|tldr|study_type|statistical/);
    }
  });

  it("is deeply frozen", () => {
    expect(Object.isFrozen(EVIDENCE_FIELDS)).toBe(true);
    for (const key of FIELD_KEYS) {
      const definition: FieldDefinition = EVIDENCE_FIELDS[key];
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.designProfiles)).toBe(true);
      expect(Object.isFrozen(definition.enforcement)).toBe(true);
      expect(() => {
        (definition as { label: string }).label = "changed";
      }).toThrow(TypeError);
    }
    expect(Object.isFrozen(FIELD_KEYS)).toBe(true);
  });
});

describe("per-field metadata", () => {
  it.each([...FIELD_KEYS])("%s is described completely", (key) => {
    const definition: FieldDefinition = getFieldDefinition(key);
    expect(definition.key).toBe(key);
    expect(definition.label).toBe(REQUIREMENTS_LABELS[key]);
    expect(BRIEF_STUDY.includes(key) ? "study" : BRIEF_ARM.includes(key) ? "arm" : "outcome").toBe(definition.scope);
    expect(definition.designProfiles.every(isDesignProfile)).toBe(true);
    expect(definition.armRoles === null).toBe(definition.scope !== "arm");
    if (definition.armRoles) expect(definition.armRoles.every(isArmRole)).toBe(true);
    switch (definition.shape) {
      case "text":
        expect(definition.text.minLength).toBe(1);
        expect(definition.text.maxLength).toBeGreaterThan(0);
        break;
      case "code":
        expect(definition.codes.length).toBeGreaterThan(1);
        expect(new Set(definition.codes).size).toBe(definition.codes.length);
        expect(Object.keys(CODE_LABELS[key]).sort()).toEqual([...definition.codes].sort());
        break;
      case "integer_with_reported_text":
        expect(definition.reportedText).toEqual({ minLength: 1, maxLength: 200 });
        expect(definition.integer).toEqual({ min: 0, max: 10_000_000 });
        break;
      case "text_list":
        expect(definition.list.minEntries).toBe(1);
        break;
    }
  });

  it("gives each field the value shape the brief names", () => {
    const shapes = Object.fromEntries(FIELD_KEYS.map((key) => [key, EVIDENCE_FIELDS[key].shape]));
    expect(Object.entries(shapes).filter(([, s]) => s === "code").map(([k]) => k)).toEqual([
      "design_classification",
      "comparator_type",
      "outcome_designation",
    ]);
    expect(Object.entries(shapes).filter(([, s]) => s === "integer_with_reported_text").map(([k]) => k)).toEqual(["n_randomized", "n_enrolled"]);
    expect(Object.entries(shapes).filter(([, s]) => s === "text_list").map(([k]) => k)).toEqual(["registration_ids", "time_points"]);
    expect(Object.values(shapes).filter((s) => s === "text")).toHaveLength(23 - 3 - 2 - 2);
  });

  it("bounds registration numbers and time points as Requirements-001 §H2/§H5 do", () => {
    expect(EVIDENCE_FIELDS.registration_ids.list).toEqual({ minEntries: 1, maxEntries: 5, entry: { minLength: 3, maxLength: 50, whitespace: "none" } });
    expect(EVIDENCE_FIELDS.time_points.list).toEqual({ minEntries: 1, maxEntries: 10, entry: { minLength: 1, maxLength: 100, whitespace: "inner_only" } });
  });

  it("marks exactly the Requirements-001 core fields as core, n_enrolled only for non_intervention", () => {
    for (const key of FIELD_KEYS) {
      for (const profile of DESIGN_PROFILES) {
        const expected = key === "n_enrolled" ? (profile === "non_intervention" ? "core" : "optional") : REQUIREMENTS_CORE.has(key) ? "core" : "optional";
        expect(fieldTier(key, profile), `${key} in ${profile}`).toBe(expected);
      }
    }
  });
});

describe("design families and group roles", () => {
  it("shows no group field in a non-intervention study", () => {
    expect(fieldKeysFor("arm", "non_intervention")).toEqual([]);
    for (const key of ARM_FIELD_KEYS) expect(isFieldAllowedForDesign(key, "non_intervention")).toBe(false);
  });

  it("shows the number randomized only in the intervention families", () => {
    expect(isFieldAllowedForDesign("n_randomized", "rct_parallel")).toBe(true);
    expect(isFieldAllowedForDesign("n_randomized", "intervention_other")).toBe(true);
    expect(isFieldAllowedForDesign("n_randomized", "non_intervention")).toBe(false);
    expect(fieldKeysFor("study", "non_intervention")).toEqual(BRIEF_STUDY.filter((k) => k !== "n_randomized"));
  });

  it("shows every field in both intervention families", () => {
    for (const profile of ["rct_parallel", "intervention_other"] as const) {
      expect([...fieldKeysFor("study", profile), ...fieldKeysFor("arm", profile), ...fieldKeysFor("outcome", profile)]).toEqual([...FIELD_KEYS]);
    }
  });

  it("applies comparator type to comparator groups only", () => {
    expect(isFieldAllowedForArmRole("comparator_type", "comparator")).toBe(true);
    expect(isFieldAllowedForArmRole("comparator_type", "intervention")).toBe(false);
    expect(fieldKeysFor("arm", "rct_parallel", "intervention")).toEqual(BRIEF_ARM.filter((k) => k !== "comparator_type"));
    expect(fieldKeysFor("arm", "rct_parallel", "comparator")).toEqual(BRIEF_ARM);
  });

  it("labels the three families and their limitations (Requirements-001 §E2, §F2)", () => {
    expect(Object.keys(DESIGN_PROFILE_LABELS)).toEqual([...DESIGN_PROFILES]);
    expect(DESIGN_PROFILE_LABELS.rct_parallel).toBe("Randomized trial, parallel groups");
    expect(DESIGN_PROFILE_LIMITATIONS.rct_parallel).toBeNull();
    expect(DESIGN_PROFILE_LIMITATIONS.non_intervention).toBe("Exposure and comparison fields aren't available in this version.");
  });

  it("recognizes only its own vocabularies", () => {
    expect(isFieldKey("setting")).toBe(true);
    expect(isFieldKey("Setting")).toBe(false);
    expect(isFieldKey(7)).toBe(false);
    expect(isDesignProfile("rct_cluster")).toBe(false);
    expect(isArmRole("placebo")).toBe(false);
  });
});
