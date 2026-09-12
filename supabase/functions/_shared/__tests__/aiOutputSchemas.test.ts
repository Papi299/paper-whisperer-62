// @vitest-environment node
//
// Node rather than jsdom: these modules run in Deno and want no DOM (see the
// sibling Edge suites).
//
// AI-MULTI-PROVIDER-001B — the operation-owned JSON output schemas.
//
// 001B gave the provider-neutral request a `jsonSchema`, so that Anthropic's
// and OpenAI's NATIVE structured-output APIs enforce PaperLume's output shape
// instead of the prompt asking nicely. The schemas belong to the OPERATIONS
// (C39: adapters must not know what a TLDR or a Tag is), which makes them worth
// testing in their own right — a wrong schema would be a product contract
// stated twice, differently.
//
// This suite asks three questions:
//
//   1. Does each schema ACCEPT exactly what PaperLume's own parser accepts, and
//      reject shapes that are wrong?
//   2. Is each schema expressible in BOTH providers' documented JSON Schema
//      dialects — no keyword either of them rejects?
//   3. Does the schema leave PaperLume's real product rules to the PARSER,
//      which remains the final authority? This is the important one: the
//      dialects cannot express the suggestion caps or the ref rule at all, so
//      a schema that appeared to enforce them would be a lie.
//
// ## Why the validator below is written here
//
// It implements exactly the keyword subset BOTH providers document as
// supported — `type`, `properties`, `required`, `additionalProperties: false`,
// `items`. That is deliberate rather than lazy: a full-featured validator would
// happily honour `maxItems` and let a schema pass here that OpenAI would reject
// under `strict`. Checking against the real intersection is the point, and it
// adds no dependency to a task that changes no package.
import { describe, it, expect } from "vitest";
import {
  ANALYZE_JSON_SCHEMA,
  ANALYZE_SYSTEM_INSTRUCTION,
} from "../../analyze-paper/prompt.ts";
import { SUGGEST_JSON_SCHEMA } from "../../suggest-paper-organization/prompt.ts";
import { parseSuggestionsResponse } from "../../suggest-paper-organization/parse.ts";
import {
  MAX_EXISTING_PROJECT_SUGGESTIONS,
  MAX_EXISTING_TAG_SUGGESTIONS,
  MAX_NEW_PROJECT_SUGGESTIONS,
  MAX_NEW_TAG_SUGGESTIONS,
  MAX_REASON_LENGTH,
  type TaxonomyRefMap,
} from "../../suggest-paper-organization/contract.ts";

// ── A validator for the dialect intersection, and nothing wider ───────────

type Schema = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Does `value` satisfy `schema`, under the keyword subset both providers support? */
function validate(schema: Schema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];

  const actual =
    value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value === "number"
          ? Number.isInteger(value)
            ? "integer"
            : "number"
          : typeof value;

  const matches = types.some(
    (t) => t === actual || (t === "number" && actual === "integer"),
  );
  if (!matches) {
    errors.push(`${path}: expected ${types.join("|")}, got ${actual}`);
    return errors;
  }

  if (actual === "object") {
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    const required = (schema.required ?? []) as string[];
    const obj = value as Record<string, unknown>;

    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) {
        errors.push(`${path}: missing required "${key}"`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errors.push(`${path}: additional property "${key}"`);
        }
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        errors.push(...validate(sub, obj[key], `${path}.${key}`));
      }
    }
  }

  if (actual === "array" && isPlainObject(schema.items)) {
    (value as unknown[]).forEach((item, i) => {
      errors.push(...validate(schema.items as Schema, item, `${path}[${i}]`));
    });
  }

  return errors;
}

const accepts = (schema: Schema, value: unknown) => validate(schema, value).length === 0;

/** Every sub-schema in the tree, so keyword rules can be checked everywhere. */
function everySubSchema(schema: Schema, out: Schema[] = []): Schema[] {
  out.push(schema);
  const properties = schema.properties;
  if (isPlainObject(properties)) {
    for (const sub of Object.values(properties)) {
      if (isPlainObject(sub)) everySubSchema(sub, out);
    }
  }
  if (isPlainObject(schema.items)) everySubSchema(schema.items as Schema, out);
  return out;
}

// Keywords BOTH providers document as unsupported. Anthropic lists numeric and
// string-length constraints as unsupported; OpenAI lists these as unsupported
// under `strict`. A schema using one risks a 400 rather than enforcement.
const UNSUPPORTED_KEYWORDS = [
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "if",
  "then",
  "not",
];

describe.each([
  ["analyze", ANALYZE_JSON_SCHEMA],
  ["suggest", SUGGEST_JSON_SCHEMA],
])("%s schema — expressible in both providers' dialects", (_name, wrapper) => {
  const subSchemas = everySubSchema(wrapper.schema as Schema);

  it("has a name a provider will accept as an identifier", () => {
    // OpenAI requires a `name` on `text.format`; Anthropic ignores it.
    expect(wrapper.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("is rooted at an object", () => {
    expect((wrapper.schema as Schema).type).toBe("object");
  });

  it.each(UNSUPPORTED_KEYWORDS)("uses no %s anywhere in the tree", (keyword) => {
    for (const sub of subSchemas) {
      expect(sub).not.toHaveProperty(keyword);
    }
  });

  it("sets additionalProperties:false on every object, as both dialects require", () => {
    for (const sub of subSchemas) {
      if (sub.type === "object") expect(sub.additionalProperties).toBe(false);
    }
  });

  it("lists EVERY property in required, as strict mode demands", () => {
    // OpenAI's strict mode requires every property to be required; a nullable
    // field is expressed as a type union, not by omission.
    for (const sub of subSchemas) {
      if (sub.type !== "object") continue;
      const properties = Object.keys((sub.properties ?? {}) as Record<string, unknown>);
      expect([...((sub.required ?? []) as string[])].sort()).toEqual(properties.sort());
    }
  });

  it("names no provider, endpoint, credential or model", () => {
    const asText = JSON.stringify(wrapper);
    for (const forbidden of [
      "anthropic",
      "openai",
      "gemini",
      "api-key",
      "Authorization",
      "claude",
      "gpt-",
      "http",
    ]) {
      expect(asText.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

// ── The analyze schema ────────────────────────────────────────────────────

describe("the analyze schema mirrors the existing product contract", () => {
  const schema = ANALYZE_JSON_SCHEMA.schema as Schema;

  it("is exactly the three fields the browser has always received", () => {
    expect(Object.keys(schema.properties as Record<string, unknown>).sort()).toEqual([
      "statisticalMethods",
      "studyType",
      "tldr",
    ]);
    // Not renamed, not extended: the same three keys the prompt has always
    // demanded and `index.ts` has always parsed.
    expect(ANALYZE_SYSTEM_INSTRUCTION).toContain("exactly these three keys");
    for (const key of ["tldr", "studyType", "statisticalMethods"]) {
      expect(ANALYZE_SYSTEM_INSTRUCTION).toContain(`- ${key}:`);
    }
  });

  it("accepts a known-valid analysis", () => {
    expect(
      accepts(schema, {
        tldr: "A randomized trial found intervention A outperformed B over 12 weeks.",
        studyType: "Randomized Controlled Trial",
        statisticalMethods: "ANOVA, double-blind, placebo-controlled",
      }),
    ).toBe(true);
  });

  it("accepts the 'Not specified' values the instruction asks for", () => {
    expect(
      accepts(schema, { tldr: "x", studyType: "Not specified", statisticalMethods: "Not specified" }),
    ).toBe(true);
  });

  it.each([
    ["an extra unexpected field", { tldr: "a", studyType: "b", statisticalMethods: "c", extra: 1 }],
    ["a wrong field type", { tldr: 42, studyType: "b", statisticalMethods: "c" }],
    ["a null field", { tldr: null, studyType: "b", statisticalMethods: "c" }],
    ["a missing field", { tldr: "a", studyType: "b" }],
    ["an array instead of an object", [{ tldr: "a", studyType: "b", statisticalMethods: "c" }]],
    ["a bare string", "just prose"],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(accepts(schema, value)).toBe(false);
  });
});

// ── The suggest schema ────────────────────────────────────────────────────

const VALID_SUGGESTION = {
  existingProjects: [{ ref: "P1", reason: "The paper studies this project's topic." }],
  existingTags: [{ ref: "T1", reason: "The abstract names this method." }],
  newProjects: [{ name: "Sleep and Recovery", description: "Sleep studies.", reason: "No home." }],
  newTags: [{ name: "crossover", reason: "The design is a crossover trial." }],
};

describe("the suggest schema mirrors the existing product contract", () => {
  const schema = SUGGEST_JSON_SCHEMA.schema as Schema;

  it("is exactly the four keys the instruction and the parser agree on", () => {
    expect(Object.keys(schema.properties as Record<string, unknown>).sort()).toEqual([
      "existingProjects",
      "existingTags",
      "newProjects",
      "newTags",
    ]);
  });

  it("accepts a known-valid current suggestion shape", () => {
    expect(validate(schema, VALID_SUGGESTION)).toEqual([]);
  });

  it("accepts every array empty — a real answer, not a failure", () => {
    expect(
      accepts(schema, { existingProjects: [], existingTags: [], newProjects: [], newTags: [] }),
    ).toBe(true);
  });

  it("accepts a null new-Project description, as the parser does", () => {
    expect(
      accepts(schema, {
        ...VALID_SUGGESTION,
        newProjects: [{ name: "N", description: null, reason: "r" }],
      }),
    ).toBe(true);
  });

  it.each([
    ["an unknown top-level key", { ...VALID_SUGGESTION, extraKey: [] }],
    ["a missing top-level key", { existingProjects: [], existingTags: [], newProjects: [] }],
    ["a top-level value that is not an array", { ...VALID_SUGGESTION, newTags: {} }],
    [
      "an unknown key on an existing item",
      { ...VALID_SUGGESTION, existingProjects: [{ ref: "P1", reason: "r", id: "leak" }] },
    ],
    [
      "a ref that is not a string",
      { ...VALID_SUGGESTION, existingProjects: [{ ref: 1, reason: "r" }] },
    ],
    [
      "a missing reason",
      { ...VALID_SUGGESTION, existingTags: [{ ref: "T1" }] },
    ],
    [
      "a new Tag carrying a description it has no room for",
      { ...VALID_SUGGESTION, newTags: [{ name: "n", reason: "r", description: "d" }] },
    ],
    ["an array instead of an object", [VALID_SUGGESTION]],
  ])("rejects %s", (_label, value) => {
    expect(accepts(schema, value)).toBe(false);
  });

  it("refuses an `id` field anywhere — a database id must be unrepresentable", () => {
    // `prompt.ts` never sends an id, and `parse.ts` resolves refs through the
    // request-local map. The schema agrees: there is nowhere to put one.
    expect(JSON.stringify(schema)).not.toContain('"id"');
    expect(
      accepts(schema, {
        ...VALID_SUGGESTION,
        existingProjects: [{ ref: "P1", reason: "r", id: "00000000-0000-4000-8000-000000000000" }],
      }),
    ).toBe(false);
  });
});

// ── The schema is NOT the parser, and the parser is the authority ─────────

describe("the caps stay where they are enforced: in the parser", () => {
  it("keeps the CURRENT caps, not the proposed future ones", () => {
    // 001B is not the suggestion-cap quality experiment. 5/10/2/5 is a separate
    // product decision and must not arrive by accident with a schema.
    expect(MAX_EXISTING_PROJECT_SUGGESTIONS).toBe(3);
    expect(MAX_EXISTING_TAG_SUGGESTIONS).toBe(5);
    expect(MAX_NEW_PROJECT_SUGGESTIONS).toBe(2);
    expect(MAX_NEW_TAG_SUGGESTIONS).toBe(3);
    expect(MAX_REASON_LENGTH).toBe(400);
  });

  it("does not attempt to express the caps in the schema — no dialect can", () => {
    // Stated as a test so that a future edit adding `maxItems` fails here
    // rather than in a provider 400 nobody sees.
    const asText = JSON.stringify(SUGGEST_JSON_SCHEMA.schema);
    expect(asText).not.toContain("maxItems");
    expect(asText).not.toContain("maxLength");
    expect(asText).not.toContain(String(MAX_REASON_LENGTH));
  });

  it("a schema-VALID response that breaks the caps is still capped by the parser", () => {
    // The point of the whole section: a provider can return this and claim
    // schema compliance, and PaperLume still returns the contracted maximum.
    const refMap: TaxonomyRefMap = {
      projects: new Map(
        Array.from({ length: 8 }, (_, i) => [
          `P${i + 1}`,
          { id: `id-p-${i}`, name: `Project ${i}`, description: null },
        ]),
      ),
      tags: new Map(
        Array.from({ length: 8 }, (_, i) => [`T${i + 1}`, { id: `id-t-${i}`, name: `Tag ${i}` }]),
      ),
    };
    const overCap = {
      existingProjects: Array.from({ length: 8 }, (_, i) => ({
        ref: `P${i + 1}`,
        reason: "a reason",
      })),
      existingTags: Array.from({ length: 8 }, (_, i) => ({ ref: `T${i + 1}`, reason: "a reason" })),
      newProjects: Array.from({ length: 8 }, (_, i) => ({
        name: `New project ${i}`,
        description: null,
        reason: "a reason",
      })),
      newTags: Array.from({ length: 8 }, (_, i) => ({ name: `newtag${i}`, reason: "a reason" })),
    };

    // Schema-valid …
    expect(validate(SUGGEST_JSON_SCHEMA.schema as Schema, overCap)).toEqual([]);

    // … and still capped by PaperLume's own parser.
    const parsed = parseSuggestionsResponse(JSON.stringify(overCap), refMap);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.suggestions.existingProjects).toHaveLength(MAX_EXISTING_PROJECT_SUGGESTIONS);
    expect(parsed.suggestions.existingTags).toHaveLength(MAX_EXISTING_TAG_SUGGESTIONS);
    expect(parsed.suggestions.newProjects).toHaveLength(MAX_NEW_PROJECT_SUGGESTIONS);
    expect(parsed.suggestions.newTags).toHaveLength(MAX_NEW_TAG_SUGGESTIONS);
  });

  it("a schema-VALID response with an over-length reason is still rejected by the parser", () => {
    const refMap: TaxonomyRefMap = {
      projects: new Map([["P1", { id: "id-p-1", name: "Project", description: null }]]),
      tags: new Map(),
    };
    const longReason = {
      existingProjects: [{ ref: "P1", reason: "x".repeat(MAX_REASON_LENGTH + 1) }],
      existingTags: [],
      newProjects: [],
      newTags: [],
    };
    expect(validate(SUGGEST_JSON_SCHEMA.schema as Schema, longReason)).toEqual([]);
    expect(parseSuggestionsResponse(JSON.stringify(longReason), refMap).ok).toBe(false);
  });

  it("a schema-VALID response with an INVENTED ref is still rejected by the parser", () => {
    // The rule no JSON Schema dialect can express: a ref must name an entity
    // from THIS request's taxonomy. This is the clearest statement of why the
    // parser — not the provider's schema claim — is the authority.
    const refMap: TaxonomyRefMap = {
      projects: new Map([["P1", { id: "id-p-1", name: "Project", description: null }]]),
      tags: new Map(),
    };
    const invented = {
      existingProjects: [{ ref: "P99", reason: "a reason" }],
      existingTags: [],
      newProjects: [],
      newTags: [],
    };
    expect(validate(SUGGEST_JSON_SCHEMA.schema as Schema, invented)).toEqual([]);
    expect(parseSuggestionsResponse(JSON.stringify(invented), refMap).ok).toBe(false);
  });

  it("a schema-valid response the parser accepts still round-trips end to end", () => {
    const refMap: TaxonomyRefMap = {
      projects: new Map([["P1", { id: "id-p-1", name: "Sleep", description: null }]]),
      tags: new Map([["T1", { id: "id-t-1", name: "crossover-design" }]]),
    };
    expect(validate(SUGGEST_JSON_SCHEMA.schema as Schema, VALID_SUGGESTION)).toEqual([]);
    const parsed = parseSuggestionsResponse(JSON.stringify(VALID_SUGGESTION), refMap);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.suggestions.existingProjects[0].id).toBe("id-p-1");
    expect(parsed.suggestions.existingTags[0].id).toBe("id-t-1");
    expect(parsed.suggestions.newProjects[0].name).toBe("Sleep and Recovery");
    expect(parsed.suggestions.newTags[0].name).toBe("crossover");
  });

  it("the parser still tolerates the `name` key the schema does not offer", () => {
    // The one place the schema is STRICTER than the parser. Deliberate: the
    // instruction never asks for `name`, the parser ignores it when present,
    // and nothing about the product changes either way.
    const refMap: TaxonomyRefMap = {
      projects: new Map([["P1", { id: "id-p-1", name: "Sleep", description: null }]]),
      tags: new Map(),
    };
    const withName = {
      existingProjects: [{ ref: "P1", name: "Sleep", reason: "a reason" }],
      existingTags: [],
      newProjects: [],
      newTags: [],
    };
    expect(accepts(SUGGEST_JSON_SCHEMA.schema as Schema, withName)).toBe(false);
    expect(parseSuggestionsResponse(JSON.stringify(withName), refMap).ok).toBe(true);
  });
});
