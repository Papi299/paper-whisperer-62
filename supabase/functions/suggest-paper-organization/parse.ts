/**
 * suggest-paper-organization — strict provider-response parsing.
 *
 * Pure. This is the module that actually holds the security boundary. The
 * system instruction asks the model to behave; nothing here assumes it did.
 * `responseMimeType: "application/json"` guarantees *syntax*, not semantics, so
 * every field below is re-derived or re-checked from scratch.
 *
 * ## The parse policy, exactly
 *
 * A response is **unusable** — the handler refunds the quota unit and returns a
 * neutral 500 — when any of these is true:
 *
 *   - the text is absent, or contains no JSON object;
 *   - `JSON.parse` fails;
 *   - the top level is not a plain object;
 *   - a top-level key is missing, unknown, or not an array;
 *   - any array is longer than `MAX_PROVIDER_ARRAY_ITEMS`;
 *   - an item is not a plain object, or carries an unknown key;
 *   - a `ref` is missing, is not a string, has the wrong syntax, or names an
 *     entity that was not in this request's taxonomy;
 *   - a `reason` / `name` / `description` has the wrong type, is empty where it
 *     must not be, or exceeds its bound.
 *
 * A response is **valid** — quota stays consumed — when it conforms, *including*
 * when every array is empty. "Nothing in your library fits this paper, and
 * nothing new is worth creating" is a real answer to the question the user
 * asked, and refunding it would pay users to ask about papers that do not need
 * organizing.
 *
 * Three things are **normalized rather than rejected**, because each has a
 * single obviously-correct reading and none can smuggle anything through:
 *
 *   1. *Duplicate references.* The same entity twice collapses to one
 *      suggestion, first occurrence winning.
 *   2. *Over-cap arrays.* Up to `MAX_PROVIDER_ARRAY_ITEMS`, an array longer than
 *      its category cap is truncated deterministically (first N in provider
 *      order) rather than rejected. Being one over a soft cap is ordinary model
 *      behaviour; being at twenty-five is not, and that is what the hard ceiling
 *      above catches.
 *   3. *New-name collisions.* See `resolveNewProjects` below.
 *
 * ## Why an unknown ref is fatal rather than dropped
 *
 * Both are safe — an unknown ref can never resolve to a row, because the only
 * ref→id path in this function is the map built in `prompt.ts`, and there is no
 * name matching, no fuzzy matching and no fallback anywhere. Rejecting the whole
 * response is chosen because a fabricated ref means the model is not honouring
 * the one contract term that keeps existing-entity suggestions truthful, and the
 * rest of that same response should not be trusted either. The user is refunded.
 */

import {
  MAX_EXISTING_PROJECT_SUGGESTIONS,
  MAX_EXISTING_TAG_SUGGESTIONS,
  MAX_NEW_PROJECT_DESCRIPTION_LENGTH,
  MAX_NEW_PROJECT_NAME_LENGTH,
  MAX_NEW_PROJECT_SUGGESTIONS,
  MAX_NEW_TAG_NAME_LENGTH,
  MAX_NEW_TAG_SUGGESTIONS,
  MAX_PROVIDER_ARRAY_ITEMS,
  MAX_REASON_LENGTH,
  normalizeName,
  sanitizeForProvider,
  type ExistingProjectSuggestion,
  type ExistingTagSuggestion,
  type NewProjectSuggestion,
  type NewTagSuggestion,
  type OrganizationSuggestions,
  type TaxonomyRefMap,
} from "./contract.ts";
import { PROJECT_REF_PREFIX, TAG_REF_PREFIX } from "./prompt.ts";

const PROJECT_REF_PATTERN = new RegExp(`^${PROJECT_REF_PREFIX}[1-9][0-9]*$`);
const TAG_REF_PATTERN = new RegExp(`^${TAG_REF_PREFIX}[1-9][0-9]*$`);

const TOP_LEVEL_KEYS = ["existingProjects", "existingTags", "newProjects", "newTags"] as const;

/**
 * Keys allowed on an existing-entity item. `name` is tolerated and then
 * **ignored**: models commonly echo the entity's name next to its ref, and
 * rejecting a response over a redundant-but-harmless field would spend a user's
 * quota unit on pedantry. The name returned to the client always comes from the
 * server's own row, never from this field.
 */
const EXISTING_ITEM_KEYS = new Set(["ref", "reason", "name"]);
const NEW_PROJECT_ITEM_KEYS = new Set(["name", "description", "reason"]);
const NEW_TAG_ITEM_KEYS = new Set(["name", "reason"]);

export type ParseFailureReason = "empty" | "parse";

export type ParseSuggestionsResult =
  | { ok: true; suggestions: OrganizationSuggestions }
  | { ok: false; reason: ParseFailureReason; detail: string };

function invalid(detail: string): ParseSuggestionsResult {
  return { ok: false, reason: "parse", detail };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pull the model's text out of a Gemini `generateContent` payload. Returns
 * `null` for any shape that carries no text — a blocked candidate, an empty
 * candidate list, a malformed envelope — which the caller treats as an empty
 * (refundable) response.
 */
export function extractProviderText(payload: unknown): string | null {
  if (!isPlainObject(payload)) return null;
  const candidates = payload.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0];
  if (!isPlainObject(first)) return null;
  const content = first.content;
  if (!isPlainObject(content)) return null;
  const parts = content.parts;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const text = isPlainObject(parts[0]) ? parts[0].text : null;
  if (typeof text !== "string" || text.trim() === "") return null;
  return text;
}

/** Strip markdown fencing and isolate the outermost JSON object, as `analyze-paper` does. */
function isolateJsonObject(rawText: string): string | null {
  const cleaned = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return cleaned.substring(start, end + 1);
}

/** A bounded, non-empty user-facing string. Returns `null` when it violates the contract. */
function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > maxLength) return null;
  return sanitizeForProvider(trimmed);
}

function hasOnlyAllowedKeys(item: Record<string, unknown>, allowed: Set<string>): boolean {
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

/** Read one top-level array, enforcing presence, type and the hard ceiling. */
function readArray(
  root: Record<string, unknown>,
  key: string,
): { ok: true; items: unknown[] } | { ok: false; detail: string } {
  const value = root[key];
  if (!Array.isArray(value)) return { ok: false, detail: `${key}_not_array` };
  if (value.length > MAX_PROVIDER_ARRAY_ITEMS) return { ok: false, detail: `${key}_over_ceiling` };
  return { ok: true, items: value };
}

/**
 * Validate and resolve the existing-entity suggestions for one category.
 *
 * `lookup` is the request's ref map — the only ref→row path that exists. A ref
 * that is syntactically valid but absent from the map is fatal, not skipped.
 */
function resolveExisting<T extends { id: string; name: string }>(
  items: unknown[],
  pattern: RegExp,
  lookup: Map<string, T>,
  cap: number,
): { ok: true; resolved: Array<{ entity: T; reason: string }> } | { ok: false; detail: string } {
  const resolved: Array<{ entity: T; reason: string }> = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (!isPlainObject(item)) return { ok: false, detail: "existing_item_not_object" };
    if (!hasOnlyAllowedKeys(item, EXISTING_ITEM_KEYS)) {
      return { ok: false, detail: "existing_item_unknown_key" };
    }
    if (typeof item.ref !== "string" || !pattern.test(item.ref)) {
      return { ok: false, detail: "existing_item_bad_ref_syntax" };
    }
    const entity = lookup.get(item.ref);
    if (entity === undefined) return { ok: false, detail: "existing_item_unknown_ref" };

    const reason = boundedString(item.reason, MAX_REASON_LENGTH);
    if (reason === null) return { ok: false, detail: "existing_item_bad_reason" };

    // Duplicate reference — normalize, do not reject. The second mention adds
    // nothing, and the user must never see the same Project twice.
    if (seen.has(entity.id)) continue;
    seen.add(entity.id);
    resolved.push({ entity, reason });
  }

  return { ok: true, resolved: resolved.slice(0, cap) };
}

/**
 * Validate the proposed new Projects, then reconcile them against the taxonomy
 * the server already holds.
 *
 * **Collision behaviour.** The server knows the caller's complete current
 * taxonomy — that is the whole premise of the request — so a "new" Project whose
 * name case-insensitively matches an existing one is not a new Project. It is
 * converted into an existing-Project suggestion, carrying the model's own
 * rationale, because the mapping is unambiguous: the database's
 * `(user_id, lower(name))` unique index guarantees at most one row can match, so
 * the conversion resolves to exactly one entity without any fuzzy matching. If
 * that entity is already suggested, or the existing-Project cap is full, the
 * proposal is dropped instead. Either way it is never returned as "new", so the
 * future UI can never offer to create a duplicate the database would reject.
 */
function resolveNewProjects(
  items: unknown[],
  existingByName: Map<string, { id: string; name: string }>,
  alreadySuggested: ExistingProjectSuggestion[],
):
  | { ok: true; newProjects: NewProjectSuggestion[]; promoted: ExistingProjectSuggestion[] }
  | { ok: false; detail: string } {
  const newProjects: NewProjectSuggestion[] = [];
  const promoted: ExistingProjectSuggestion[] = [];
  const seenNames = new Set<string>();
  const suggestedIds = new Set(alreadySuggested.map((s) => s.id));

  for (const item of items) {
    if (!isPlainObject(item)) return { ok: false, detail: "new_project_not_object" };
    if (!hasOnlyAllowedKeys(item, NEW_PROJECT_ITEM_KEYS)) {
      return { ok: false, detail: "new_project_unknown_key" };
    }

    const name = boundedString(item.name, MAX_NEW_PROJECT_NAME_LENGTH);
    if (name === null) return { ok: false, detail: "new_project_bad_name" };

    const reason = boundedString(item.reason, MAX_REASON_LENGTH);
    if (reason === null) return { ok: false, detail: "new_project_bad_reason" };

    let description: string | null = null;
    if (item.description !== undefined && item.description !== null) {
      if (typeof item.description !== "string") {
        return { ok: false, detail: "new_project_bad_description" };
      }
      const trimmed = item.description.trim();
      if (trimmed.length > MAX_NEW_PROJECT_DESCRIPTION_LENGTH) {
        return { ok: false, detail: "new_project_bad_description" };
      }
      description = trimmed === "" ? null : sanitizeForProvider(trimmed);
    }

    const normalized = normalizeName(name);

    // Duplicate proposal within the same response.
    if (seenNames.has(normalized)) continue;
    seenNames.add(normalized);

    const collision = existingByName.get(normalized);
    if (collision !== undefined) {
      if (suggestedIds.has(collision.id)) continue;
      suggestedIds.add(collision.id);
      promoted.push({ id: collision.id, name: collision.name, reason });
      continue;
    }

    newProjects.push({ name, description, reason });
  }

  return {
    ok: true,
    newProjects: newProjects.slice(0, MAX_NEW_PROJECT_SUGGESTIONS),
    promoted,
  };
}

/** Same contract as `resolveNewProjects`, for Tags, which carry no description. */
function resolveNewTags(
  items: unknown[],
  existingByName: Map<string, { id: string; name: string }>,
  alreadySuggested: ExistingTagSuggestion[],
):
  | { ok: true; newTags: NewTagSuggestion[]; promoted: ExistingTagSuggestion[] }
  | { ok: false; detail: string } {
  const newTags: NewTagSuggestion[] = [];
  const promoted: ExistingTagSuggestion[] = [];
  const seenNames = new Set<string>();
  const suggestedIds = new Set(alreadySuggested.map((s) => s.id));

  for (const item of items) {
    if (!isPlainObject(item)) return { ok: false, detail: "new_tag_not_object" };
    if (!hasOnlyAllowedKeys(item, NEW_TAG_ITEM_KEYS)) {
      return { ok: false, detail: "new_tag_unknown_key" };
    }

    const name = boundedString(item.name, MAX_NEW_TAG_NAME_LENGTH);
    if (name === null) return { ok: false, detail: "new_tag_bad_name" };

    const reason = boundedString(item.reason, MAX_REASON_LENGTH);
    if (reason === null) return { ok: false, detail: "new_tag_bad_reason" };

    const normalized = normalizeName(name);
    if (seenNames.has(normalized)) continue;
    seenNames.add(normalized);

    const collision = existingByName.get(normalized);
    if (collision !== undefined) {
      if (suggestedIds.has(collision.id)) continue;
      suggestedIds.add(collision.id);
      promoted.push({ id: collision.id, name: collision.name, reason });
      continue;
    }

    newTags.push({ name, reason });
  }

  return { ok: true, newTags: newTags.slice(0, MAX_NEW_TAG_SUGGESTIONS), promoted };
}

/**
 * Parse, validate and normalize the model's text into the application's own
 * suggestion shape.
 *
 * Existing-entity suggestions carry the **server's** id and the **server's**
 * name, read from the row the ref resolved to. Nothing the model wrote is used
 * as an identity, and the ephemeral ref never appears in the response — the
 * browser receives the persistent id it will need in 001B, and nothing else.
 */
export function parseSuggestionsResponse(
  rawText: string,
  refMap: TaxonomyRefMap,
): ParseSuggestionsResult {
  const isolated = isolateJsonObject(rawText);
  if (isolated === null) return invalid("no_json_object");

  let root: unknown;
  try {
    root = JSON.parse(isolated);
  } catch {
    return invalid("json_parse_failed");
  }

  if (!isPlainObject(root)) return invalid("root_not_object");

  for (const key of Object.keys(root)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) return invalid("unknown_top_level_key");
  }

  const arrays: Record<string, unknown[]> = {};
  for (const key of TOP_LEVEL_KEYS) {
    const read = readArray(root, key);
    if (!read.ok) return invalid(read.detail);
    arrays[key] = read.items;
  }

  const existingProjects = resolveExisting(
    arrays.existingProjects,
    PROJECT_REF_PATTERN,
    refMap.projects,
    MAX_EXISTING_PROJECT_SUGGESTIONS,
  );
  if (!existingProjects.ok) return invalid(existingProjects.detail);

  const existingTags = resolveExisting(
    arrays.existingTags,
    TAG_REF_PATTERN,
    refMap.tags,
    MAX_EXISTING_TAG_SUGGESTIONS,
  );
  if (!existingTags.ok) return invalid(existingTags.detail);

  const projectSuggestions: ExistingProjectSuggestion[] = existingProjects.resolved.map(
    ({ entity, reason }) => ({ id: entity.id, name: entity.name, reason }),
  );
  const tagSuggestions: ExistingTagSuggestion[] = existingTags.resolved.map(
    ({ entity, reason }) => ({ id: entity.id, name: entity.name, reason }),
  );

  // Name → row indexes over the *complete* taxonomy that was shown to the model,
  // used only for collision detection. Built from the ref map's values, so it is
  // by construction the same set of caller-owned rows.
  const projectsByName = new Map<string, { id: string; name: string }>();
  for (const project of refMap.projects.values()) {
    projectsByName.set(normalizeName(project.name), project);
  }
  const tagsByName = new Map<string, { id: string; name: string }>();
  for (const tag of refMap.tags.values()) {
    tagsByName.set(normalizeName(tag.name), tag);
  }

  const newProjects = resolveNewProjects(arrays.newProjects, projectsByName, projectSuggestions);
  if (!newProjects.ok) return invalid(newProjects.detail);

  const newTags = resolveNewTags(arrays.newTags, tagsByName, tagSuggestions);
  if (!newTags.ok) return invalid(newTags.detail);

  // A promoted collision is an existing-entity suggestion, so it is subject to
  // the existing-entity cap — never a way to exceed it.
  const finalProjects = [...projectSuggestions, ...newProjects.promoted].slice(
    0,
    MAX_EXISTING_PROJECT_SUGGESTIONS,
  );
  const finalTags = [...tagSuggestions, ...newTags.promoted].slice(0, MAX_EXISTING_TAG_SUGGESTIONS);

  return {
    ok: true,
    suggestions: {
      existingProjects: finalProjects,
      existingTags: finalTags,
      newProjects: newProjects.newProjects,
      newTags: newTags.newTags,
    },
  };
}
