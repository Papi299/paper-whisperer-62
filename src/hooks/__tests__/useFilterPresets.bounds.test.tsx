/**
 * Filter-preset selection bounds (PAPERLUME-SECURITY-ZOD-4-MIGRATION-001).
 *
 * GHSA-mrhx-c7xc-m3w5: a Zod array schema with no length constraint walks every
 * element of an oversized input and builds an issue per bad element. Preset
 * payloads are JSONB rows that only their owner can write, and nothing
 * server-side bounds them, so the read path now bounds the three selection
 * arrays itself:
 *
 *  • `findOversizedPresetSelection` checks only the arrays' `length`, before any
 *    schema runs (constant time; no element is read; nothing is copied);
 *  • the v1, v2 and v3 schemas carry the same `.max(PRESET_MAX_SELECTIONS)`;
 *  • an over-cap row takes the existing drop-and-warn path, never truncation;
 *  • `savePreset` / `updatePreset` refuse an over-cap payload before the
 *    network, so the app never writes a preset it would then refuse to load.
 *
 * All data is synthetic and bounded: the largest real array has 1001 entries,
 * and the "huge" input is a sparse proxied array that allocates nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { fromMock, toastMock, db } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  toastMock: vi.fn(),
  db: {
    listRows: [] as unknown[],
    insert: [] as unknown[],
    update: [] as unknown[],
    deletes: 0,
  },
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: fromMock } }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

import {
  applyPreset,
  findOversizedPresetSelection,
  parsePresetPayload,
  presetPayloadSchema,
  presetPayloadV1Schema,
  presetPayloadV2Schema,
  useFilterPresets,
  PRESET_MAX_SELECTIONS,
  PRESET_PAYLOAD_VERSION,
  type PresetPayload,
  type PresetSetters,
} from "../useFilterPresets";

const MAX = PRESET_MAX_SELECTIONS;
const SELECTION_FIELDS = ["selectedKeywords", "selectedProjectIds", "selectedTagIds"] as const;

/** `count` distinct synthetic values: "p-0", "p-1", … */
function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
}

function v3(overrides: Partial<Record<keyof PresetPayload, unknown>> = {}): Record<string, unknown> {
  return {
    version: PRESET_PAYLOAD_VERSION,
    searchQuery: "",
    yearFrom: "",
    yearTo: "",
    studyType: "all",
    notesPresence: "all",
    selectedKeywords: [],
    selectedProjectIds: [],
    selectedTagIds: [],
    projectMatchMode: "any",
    tagMatchMode: "any",
    ...overrides,
  };
}

function v2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    searchQuery: "",
    yearFrom: "",
    yearTo: "",
    studyType: "all",
    notesPresence: "all",
    selectedKeywords: [],
    selectedProjectIds: [],
    selectedTagIds: [],
    ...overrides,
  };
}

function v1(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    searchQuery: "",
    yearFrom: "",
    yearTo: "",
    studyType: "all",
    notesPresence: "all",
    selectedKeywords: [],
    selectedProjectId: null,
    selectedTagId: null,
    ...overrides,
  };
}

/** Freeze an object and every array/object inside it. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * A proxied, sparse array whose `length` is `length` but which owns no elements,
 * so it allocates nothing. Every read of an index is counted.
 */
function countingSparseArray(length: number) {
  const target: string[] = [];
  target.length = length;
  const reads = { elements: 0 };
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) reads.elements += 1;
      return Reflect.get(t, prop, receiver);
    },
  });
  return { proxy, reads };
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  db.listRows = [];
  db.insert = [];
  db.update = [];
  db.deletes = 0;
  fromMock.mockImplementation((table: string) => {
    if (table !== "filter_presets") throw new Error(`unexpected table ${table}`);
    return {
      select: () => ({
        order: () => Promise.resolve({ data: db.listRows, error: null }),
      }),
      insert: (row: { user_id: string; name: string; payload: unknown }) => {
        db.insert.push(row);
        return {
          select: () => ({
            single: () =>
              Promise.resolve({
                data: {
                  id: "preset-new",
                  name: row.name,
                  payload: row.payload,
                  created_at: "2026-11-23T00:00:00Z",
                  updated_at: "2026-11-23T00:00:00Z",
                },
                error: null,
              }),
          }),
        };
      },
      update: (patch: unknown) => {
        db.update.push(patch);
        return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
      },
      delete: () => {
        db.deletes += 1;
        return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
      },
    };
  });
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("PRESET_MAX_SELECTIONS", () => {
  it("is 1000 entries per selection array", () => {
    expect(PRESET_MAX_SELECTIONS).toBe(1000);
  });
});

describe("findOversizedPresetSelection (raw pre-parse guard)", () => {
  it("passes every selection array at exactly the cap", () => {
    expect(
      findOversizedPresetSelection(
        v3({
          selectedKeywords: ids("k", MAX),
          selectedProjectIds: ids("p", MAX),
          selectedTagIds: ids("t", MAX),
        }),
      ),
    ).toBeNull();
  });

  it.each(SELECTION_FIELDS)("reports %s one entry over the cap", (field) => {
    expect(findOversizedPresetSelection(v3({ [field]: ids("x", MAX + 1) }))).toEqual({
      field,
      length: MAX + 1,
    });
  });

  it("checks the v1 keyword array as well", () => {
    expect(findOversizedPresetSelection(v1({ selectedKeywords: ids("k", MAX + 1) }))).toEqual({
      field: "selectedKeywords",
      length: MAX + 1,
    });
  });

  it("ignores non-objects, missing fields and non-arrays (the schemas reject those)", () => {
    for (const raw of [null, undefined, 0, "x", true, [], {}, { selectedKeywords: "k" }]) {
      expect(findOversizedPresetSelection(raw)).toBeNull();
    }
    // An object pretending to be large is not an array; the schema rejects it.
    expect(findOversizedPresetSelection(v3({ selectedTagIds: { length: 10_000_000 } }))).toBeNull();
    expect(parsePresetPayload(v3({ selectedTagIds: { length: 10_000_000 } }))).toBeNull();
  });

  it("rejects a 10-million-length array by its length alone: no element is read", () => {
    const { proxy, reads } = countingSparseArray(10_000_000);
    expect(findOversizedPresetSelection(v3({ selectedKeywords: proxy }))).toEqual({
      field: "selectedKeywords",
      length: 10_000_000,
    });
    expect(parsePresetPayload(v3({ selectedKeywords: proxy }))).toBeNull();
    expect(reads.elements).toBe(0);
  });
});

describe("parsePresetPayload — bounds on read", () => {
  it("v3: accepts the maximum valid length in every array, without truncation", () => {
    const parsed = parsePresetPayload(
      v3({
        selectedKeywords: ids("k", MAX),
        selectedProjectIds: ids("p", MAX),
        selectedTagIds: ids("t", MAX),
        projectMatchMode: "all",
        tagMatchMode: "any",
      }),
    );
    expect(parsed?.selectedKeywords).toEqual(ids("k", MAX));
    expect(parsed?.selectedProjectIds).toEqual(ids("p", MAX));
    expect(parsed?.selectedTagIds).toEqual(ids("t", MAX));
    expect(parsed?.projectMatchMode).toBe("all");
    expect(parsed?.tagMatchMode).toBe("any");
  });

  it.each(SELECTION_FIELDS)("v3: rejects %s one entry over the maximum (null, not truncated)", (field) => {
    expect(parsePresetPayload(v3({ [field]: ids("x", MAX + 1) }))).toBeNull();
  });

  it("v2: accepts the maximum and upgrades to v3 with Any/Any", () => {
    const parsed = parsePresetPayload(
      v2({
        selectedKeywords: ids("k", MAX),
        selectedProjectIds: ids("p", MAX),
        selectedTagIds: ids("t", MAX),
      }),
    );
    expect(parsed).toMatchObject({
      version: PRESET_PAYLOAD_VERSION,
      projectMatchMode: "any",
      tagMatchMode: "any",
    });
    expect(parsed?.selectedKeywords).toHaveLength(MAX);
    expect(parsed?.selectedProjectIds).toHaveLength(MAX);
    expect(parsed?.selectedTagIds).toHaveLength(MAX);
  });

  it.each(SELECTION_FIELDS)("v2: rejects %s one entry over the maximum", (field) => {
    expect(parsePresetPayload(v2({ [field]: ids("x", MAX + 1) }))).toBeNull();
  });

  it("v1: accepts the maximum keyword list and upgrades scalars to arrays", () => {
    const parsed = parsePresetPayload(
      v1({ selectedKeywords: ids("k", MAX), selectedProjectId: "p-1", selectedTagId: null }),
    );
    expect(parsed?.selectedKeywords).toHaveLength(MAX);
    expect(parsed?.selectedProjectIds).toEqual(["p-1"]);
    expect(parsed?.selectedTagIds).toEqual([]);
  });

  it("v1: rejects a keyword list one entry over the maximum", () => {
    expect(parsePresetPayload(v1({ selectedKeywords: ids("k", MAX + 1) }))).toBeNull();
  });

  it("accepts empty arrays in every version", () => {
    expect(parsePresetPayload(v3())).not.toBeNull();
    expect(parsePresetPayload(v2())).not.toBeNull();
    expect(parsePresetPayload(v1())).not.toBeNull();
  });

  it("counts stored entries, not unique ones: duplicates within the cap dedupe in first-seen order", () => {
    const stored = [...ids("p", 3), ...Array.from({ length: MAX - 3 }, () => "p-1")];
    expect(stored).toHaveLength(MAX);
    const parsed = parsePresetPayload(v3({ selectedProjectIds: stored, selectedTagIds: ["t-2", "t-1", "t-2"] }));
    expect(parsed?.selectedProjectIds).toEqual(["p-0", "p-1", "p-2"]);
    expect(parsed?.selectedTagIds).toEqual(["t-2", "t-1"]);
    expect(parsePresetPayload(v3({ selectedProjectIds: [...stored, "p-1"] }))).toBeNull();
  });

  it("rejects oversized raw arrays before any schema parse runs (v3, v2 or v1)", () => {
    const spies = [
      vi.spyOn(presetPayloadSchema, "safeParse"),
      vi.spyOn(presetPayloadV2Schema, "safeParse"),
      vi.spyOn(presetPayloadV1Schema, "safeParse"),
    ];
    try {
      for (const raw of [
        v3({ selectedKeywords: ids("k", MAX + 1) }),
        v2({ selectedTagIds: ids("t", MAX + 1) }),
        v1({ selectedKeywords: ids("k", MAX + 1) }),
      ]) {
        expect(parsePresetPayload(raw)).toBeNull();
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("the exported schemas enforce the same cap on their own", () => {
    for (const field of SELECTION_FIELDS) {
      expect(presetPayloadSchema.safeParse(v3({ [field]: ids("x", MAX) })).success).toBe(true);
      expect(presetPayloadSchema.safeParse(v3({ [field]: ids("x", MAX + 1) })).success).toBe(false);
      expect(presetPayloadV2Schema.safeParse(v2({ [field]: ids("x", MAX) })).success).toBe(true);
      expect(presetPayloadV2Schema.safeParse(v2({ [field]: ids("x", MAX + 1) })).success).toBe(false);
    }
    expect(presetPayloadV1Schema.safeParse(v1({ selectedKeywords: ids("k", MAX) })).success).toBe(true);
    expect(presetPayloadV1Schema.safeParse(v1({ selectedKeywords: ids("k", MAX + 1) })).success).toBe(false);
  });

  it("fails safely: returns null and warns without logging the oversized array", () => {
    const raw = v3({ selectedTagIds: ids("a-long-synthetic-tag-identifier", MAX + 1) });
    expect(() => parsePresetPayload(raw)).not.toThrow();
    expect(parsePresetPayload(raw)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("[useFilterPresets] Dropping invalid preset payload:", [
      { code: "too_big", path: ["selectedTagIds"], maximum: MAX, length: MAX + 1 },
    ]);
    expect(JSON.stringify(warnSpy.mock.calls).length).toBeLessThan(1_000);
  });

  it("never mutates the raw input, valid or oversized", () => {
    const valid = deepFreeze(v3({ selectedProjectIds: ["A", "A", "B"], selectedKeywords: ids("k", MAX) }));
    const oversized = deepFreeze(v2({ selectedKeywords: ids("k", MAX + 1) }));
    const before = JSON.stringify([valid, oversized]);
    expect(parsePresetPayload(valid)?.selectedProjectIds).toEqual(["A", "B"]);
    expect(parsePresetPayload(oversized)).toBeNull();
    expect(JSON.stringify([valid, oversized])).toBe(before);
  });

  it("performs no database access while parsing", () => {
    parsePresetPayload(v3({ selectedKeywords: ids("k", MAX) }));
    parsePresetPayload(v3({ selectedKeywords: ids("k", MAX + 1) }));
    parsePresetPayload(v1({ selectedKeywords: ids("k", MAX + 1) }));
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe("parsePresetPayload — contract unchanged under the bound", () => {
  it.each([
    ["an unknown version", v3({ version: 4 })],
    ["version 0", v3({ version: 0 })],
    ["a string version", v3({ version: "3" })],
    ["a null version", v3({ version: null })],
    ["an invalid projectMatchMode", v3({ projectMatchMode: "some" })],
    ["an invalid tagMatchMode", v3({ tagMatchMode: "ALL" })],
    ["an invalid notesPresence", v3({ notesPresence: "maybe" })],
    ["a missing selection array", (() => {
      const { selectedTagIds: _omit, ...rest } = v3();
      return rest;
    })()],
    ["a string instead of an array", v3({ selectedKeywords: "k" })],
    ["numbers inside a selection array", v3({ selectedProjectIds: [1, 2] })],
    ["null inside a selection array", v2({ selectedTagIds: [null] })],
    ["a numeric year", v3({ yearFrom: 2020 })],
    ["a v1 numeric scalar id", v1({ selectedProjectId: 123 })],
  ])("still rejects %s", (_label, raw) => {
    expect(parsePresetPayload(raw)).toBeNull();
  });

  it("still strips unknown keys rather than rejecting the row", () => {
    const parsed = parsePresetPayload({ ...v3(), extra: "ignored" });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("extra");
  });
});

describe("applyPreset at the bound", () => {
  function recordingSetters() {
    const calls: Partial<Record<keyof PresetSetters, unknown>> = {};
    const setter =
      <K extends keyof PresetSetters>(key: K) =>
      (value: unknown) => {
        calls[key] = value;
      };
    const setters = {
      setSearchQuery: setter("setSearchQuery"),
      setYearFrom: setter("setYearFrom"),
      setYearTo: setter("setYearTo"),
      setStudyType: setter("setStudyType"),
      setNotesPresence: setter("setNotesPresence"),
      setSelectedKeywords: setter("setSelectedKeywords"),
      setSelectedProjectIds: setter("setSelectedProjectIds"),
      setSelectedTagIds: setter("setSelectedTagIds"),
      setProjectMatchMode: setter("setProjectMatchMode"),
      setTagMatchMode: setter("setTagMatchMode"),
    } as PresetSetters;
    return { setters, calls };
  }

  it("drops unknown ids from a maximum-size preset and keeps mode semantics", () => {
    const payload = parsePresetPayload(
      v3({
        selectedProjectIds: ids("p", MAX),
        selectedTagIds: ids("t", MAX),
        projectMatchMode: "all",
        tagMatchMode: "all",
      }),
    );
    expect(payload).not.toBeNull();
    const { setters, calls } = recordingSetters();
    const result = applyPreset(
      payload as PresetPayload,
      setters,
      ids("p", 10).map((id) => ({ id })),
      [],
    );
    expect(calls.setSelectedProjectIds).toEqual(ids("p", 10));
    expect(calls.setSelectedTagIds).toEqual([]);
    expect(calls.setProjectMatchMode).toBe("all");
    expect(calls.setTagMatchMode).toBe("any");
    expect(result).toEqual({ droppedProjectCount: MAX - 10, droppedTagCount: MAX });
  });
});

describe("useFilterPresets — save and update honour the same bound", () => {
  function wrapper() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
  }

  function payload(overrides: Partial<PresetPayload> = {}): PresetPayload {
    return { ...(v3() as unknown as PresetPayload), ...overrides };
  }

  async function mountHook() {
    const hook = renderHook(() => useFilterPresets({ userId: "user-1" }), { wrapper: wrapper() });
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
    return hook;
  }

  it.each(SELECTION_FIELDS)("savePreset refuses %s over the cap before the network", async (field) => {
    const { result } = await mountHook();
    let created: unknown = "unset";
    await act(async () => {
      created = await result.current.savePreset("Too many", payload({ [field]: ids("x", MAX + 1) }));
    });
    expect(created).toBeNull();
    expect(db.insert).toEqual([]);
    expect(toastMock).toHaveBeenCalledWith({
      title: "Could not save preset",
      description: expect.stringContaining(`at most ${MAX}`),
      variant: "destructive",
    });
  });

  it("updatePreset refuses an over-cap payload before the network", async () => {
    const { result } = await mountHook();
    let ok: unknown = "unset";
    await act(async () => {
      ok = await result.current.updatePreset(
        { id: "preset-1", name: "Mine" },
        payload({ selectedKeywords: ids("k", MAX + 1) }),
      );
    });
    expect(ok).toBe(false);
    expect(db.update).toEqual([]);
    expect(toastMock).toHaveBeenCalledWith({
      title: "Could not update preset",
      description: expect.stringContaining(`at most ${MAX}`),
      variant: "destructive",
    });
  });

  it("savePreset writes a maximum-size v3 payload unchanged and reads it back whole", async () => {
    const { result } = await mountHook();
    const full = payload({
      selectedKeywords: ids("k", MAX),
      selectedProjectIds: ids("p", MAX),
      selectedTagIds: ids("t", MAX),
      projectMatchMode: "all",
    });
    let created: Awaited<ReturnType<typeof result.current.savePreset>> = null;
    await act(async () => {
      created = await result.current.savePreset("Big but valid", full);
    });
    expect(db.insert).toHaveLength(1);
    expect(db.insert[0]).toEqual({ user_id: "user-1", name: "Big but valid", payload: full });
    expect(created).not.toBeNull();
    expect(created!.payload).toEqual(full);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Preset saved" }));
  });

  it("updatePreset writes a maximum-size payload unchanged", async () => {
    const { result } = await mountHook();
    const full = payload({ selectedTagIds: ids("t", MAX), tagMatchMode: "all" });
    let ok: unknown = "unset";
    await act(async () => {
      ok = await result.current.updatePreset({ id: "preset-1", name: "Mine" }, full);
    });
    expect(ok).toBe(true);
    expect(db.update).toEqual([{ payload: full }]);
  });

  it("the list read upgrades v1/v2 rows, drops an oversized row, and writes nothing", async () => {
    db.listRows = [
      { id: "r1", name: "Legacy one", payload: v1({ selectedKeywords: ["sleep"], selectedProjectId: "p-1" }), created_at: "t", updated_at: "t" },
      { id: "r2", name: "Legacy two", payload: v2({ selectedTagIds: ["t-1", "t-1"] }), created_at: "t", updated_at: "t" },
      { id: "r3", name: "Oversized", payload: v3({ selectedKeywords: ids("k", MAX + 1) }), created_at: "t", updated_at: "t" },
      { id: "r4", name: "Current", payload: v3({ tagMatchMode: "all", selectedTagIds: ["t-9"] }), created_at: "t", updated_at: "t" },
    ];
    const { result } = await mountHook();
    await waitFor(() => expect(result.current.presets).toHaveLength(3));

    expect(result.current.presets.map((p) => p.id)).toEqual(["r4", "r1", "r2"]);
    const byId = Object.fromEntries(result.current.presets.map((p) => [p.id, p.payload]));
    expect(byId.r1).toMatchObject({ version: 3, selectedProjectIds: ["p-1"], projectMatchMode: "any" });
    expect(byId.r2).toMatchObject({ version: 3, selectedTagIds: ["t-1"], tagMatchMode: "any" });
    expect(byId.r4).toMatchObject({ version: 3, tagMatchMode: "all" });
    expect(db.insert).toEqual([]);
    expect(db.update).toEqual([]);
    expect(db.deletes).toBe(0);
  });
});
