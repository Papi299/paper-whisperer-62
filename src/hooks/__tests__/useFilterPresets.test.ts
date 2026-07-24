import { describe, it, expect, vi, beforeEach } from "vitest";

// The unit under test only uses pure helpers (no network). Mock the Supabase
// client so importing `useFilterPresets` does not spin up the real auth client
// and its background `_autoRefreshTokenTick`, which leaks into the test run
// as an unhandled rejection in the vitest/node environment.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

import {
  applyPreset,
  arePresetPayloadsEqual,
  buildPresetPayload,
  parsePresetPayload,
  prepareRename,
  validatePresetName,
  PRESET_NAME_MAX_LENGTH,
  PRESET_PAYLOAD_VERSION,
  type PresetPayload,
  type PresetSetters,
} from "../useFilterPresets";

// Silence the console.warn from parsePresetPayload's drop-path.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

function makeSetters(): PresetSetters & {
  calls: Record<keyof PresetSetters, unknown[]>;
} {
  const calls: Record<keyof PresetSetters, unknown[]> = {
    setSearchQuery: [],
    setYearFrom: [],
    setYearTo: [],
    setStudyType: [],
    setNotesPresence: [],
    setSelectedKeywords: [],
    setSelectedProjectIds: [],
    setSelectedTagIds: [],
  };
  return {
    calls,
    setSearchQuery: (v) => calls.setSearchQuery.push(v),
    setYearFrom: (v) => calls.setYearFrom.push(v),
    setYearTo: (v) => calls.setYearTo.push(v),
    setStudyType: (v) => calls.setStudyType.push(v),
    setNotesPresence: (v) => calls.setNotesPresence.push(v),
    setSelectedKeywords: (v) => calls.setSelectedKeywords.push(v),
    setSelectedProjectIds: (v) => calls.setSelectedProjectIds.push(v),
    setSelectedTagIds: (v) => calls.setSelectedTagIds.push(v),
  };
}

function defaultPayload(): PresetPayload {
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
  };
}

/** A raw version-1 payload as it would sit in the DB before the v2 bump. */
function v1Payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

// ── validatePresetName ──────────────────────────────────────────────────

describe("validatePresetName", () => {
  it("trims and accepts a non-empty name", () => {
    const res = validatePresetName("  my preset  ");
    expect(res).toEqual({ ok: true, name: "my preset" });
  });

  it("rejects an empty string", () => {
    const res = validatePresetName("");
    expect(res.ok).toBe(false);
  });

  it("rejects a whitespace-only string", () => {
    const res = validatePresetName("   \t   ");
    expect(res.ok).toBe(false);
  });

  it("rejects a name over the max length", () => {
    const tooLong = "x".repeat(PRESET_NAME_MAX_LENGTH + 1);
    const res = validatePresetName(tooLong);
    expect(res.ok).toBe(false);
  });

  it("accepts a name exactly at the max length", () => {
    const atMax = "x".repeat(PRESET_NAME_MAX_LENGTH);
    const res = validatePresetName(atMax);
    expect(res).toEqual({ ok: true, name: atMax });
  });
});

// ── buildPresetPayload ──────────────────────────────────────────────────

describe("buildPresetPayload", () => {
  it("attaches the current (version-2) version constant", () => {
    const payload = buildPresetPayload({
      searchQuery: "foo",
      yearFrom: "",
      yearTo: "",
      studyType: "all",
      notesPresence: "all",
      selectedKeywords: [],
      selectedProjectIds: [],
      selectedTagIds: [],
    });
    expect(PRESET_PAYLOAD_VERSION).toBe(2);
    expect(payload.version).toBe(PRESET_PAYLOAD_VERSION);
    expect(payload.searchQuery).toBe("foo");
  });

  it("round-trips multi-select project/tag arrays", () => {
    const payload = buildPresetPayload({
      searchQuery: "",
      yearFrom: "",
      yearTo: "",
      studyType: "all",
      notesPresence: "all",
      selectedKeywords: [],
      selectedProjectIds: ["p1", "p2"],
      selectedTagIds: ["t1"],
    });
    expect(payload.selectedProjectIds).toEqual(["p1", "p2"]);
    expect(payload.selectedTagIds).toEqual(["t1"]);
  });
});

// ── parsePresetPayload (Zod + v1 back-compat) ───────────────────────────

describe("parsePresetPayload", () => {
  it("returns the parsed payload for a valid version-2 row", () => {
    const payload = defaultPayload();
    expect(parsePresetPayload(payload)).toEqual(payload);
  });

  it("accepts a fully-populated version-2 payload", () => {
    const payload: PresetPayload = {
      ...defaultPayload(),
      selectedProjectIds: ["p1", "p2"],
      selectedTagIds: ["t1"],
    };
    expect(parsePresetPayload(payload)).toEqual(payload);
  });

  it("round-trips a raw quoted search string verbatim", () => {
    const payload: PresetPayload = {
      ...defaultPayload(),
      searchQuery: '"muscle protein synthesis"',
    };
    const parsed = parsePresetPayload(payload);
    expect(parsed?.searchQuery).toBe('"muscle protein synthesis"');
  });

  it("normalizes a version-1 payload with no project/tag into empty arrays", () => {
    const parsed = parsePresetPayload(v1Payload());
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe(PRESET_PAYLOAD_VERSION);
    expect(parsed?.selectedProjectIds).toEqual([]);
    expect(parsed?.selectedTagIds).toEqual([]);
  });

  it("normalizes a version-1 payload with one project and one tag into 1-element arrays", () => {
    const parsed = parsePresetPayload(
      v1Payload({ selectedProjectId: "proj-1", selectedTagId: "tag-1" }),
    );
    expect(parsed?.version).toBe(PRESET_PAYLOAD_VERSION);
    expect(parsed?.selectedProjectIds).toEqual(["proj-1"]);
    expect(parsed?.selectedTagIds).toEqual(["tag-1"]);
  });

  it("preserves the other fields when upgrading a version-1 payload", () => {
    const parsed = parsePresetPayload(
      v1Payload({
        searchQuery: "sleep",
        yearFrom: "2020",
        yearTo: "2024",
        studyType: "RCT",
        notesPresence: "has",
        selectedKeywords: ["a", "b"],
        selectedProjectId: "proj-1",
      }),
    );
    expect(parsed).toMatchObject({
      version: PRESET_PAYLOAD_VERSION,
      searchQuery: "sleep",
      yearFrom: "2020",
      yearTo: "2024",
      studyType: "RCT",
      notesPresence: "has",
      selectedKeywords: ["a", "b"],
      selectedProjectIds: ["proj-1"],
      selectedTagIds: [],
    });
  });

  it("returns null when the version sentinel is missing", () => {
    const { version: _omit, ...without } = defaultPayload();
    expect(parsePresetPayload(without)).toBeNull();
  });

  it("returns null for a future/unknown version", () => {
    const future = { ...defaultPayload(), version: 99 };
    expect(parsePresetPayload(future)).toBeNull();
  });

  it("returns null when notesPresence is not one of the three literals", () => {
    const bad = { ...defaultPayload(), notesPresence: "maybe" };
    expect(parsePresetPayload(bad)).toBeNull();
  });

  it("returns null for a malformed version-1 payload (wrong field type)", () => {
    const bad = v1Payload({ selectedProjectId: 123 });
    expect(parsePresetPayload(bad)).toBeNull();
  });

  it("returns null for totally wrong shapes", () => {
    expect(parsePresetPayload(null)).toBeNull();
    expect(parsePresetPayload("nope")).toBeNull();
    expect(parsePresetPayload({})).toBeNull();
  });
});

// ── applyPreset ─────────────────────────────────────────────────────────

describe("applyPreset", () => {
  it("invokes every setter exactly once for a default payload", () => {
    const setters = makeSetters();
    const result = applyPreset(defaultPayload(), setters, [], []);

    expect(setters.calls.setSearchQuery).toEqual([""]);
    expect(setters.calls.setYearFrom).toEqual([""]);
    expect(setters.calls.setYearTo).toEqual([""]);
    expect(setters.calls.setStudyType).toEqual(["all"]);
    expect(setters.calls.setNotesPresence).toEqual(["all"]);
    expect(setters.calls.setSelectedKeywords).toEqual([[]]);
    expect(setters.calls.setSelectedProjectIds).toEqual([[]]);
    expect(setters.calls.setSelectedTagIds).toEqual([[]]);
    expect(result).toEqual({ droppedProjectCount: 0, droppedTagCount: 0 });
  });

  it("restores a fully-populated payload when all projects and tags still exist", () => {
    const setters = makeSetters();
    const payload: PresetPayload = {
      version: PRESET_PAYLOAD_VERSION,
      searchQuery: '"muscle protein synthesis"',
      yearFrom: "2020",
      yearTo: "2025",
      studyType: "Review",
      notesPresence: "has",
      selectedKeywords: ["sleep", "exercise"],
      selectedProjectIds: ["proj-1", "proj-2"],
      selectedTagIds: ["tag-1"],
    };
    const result = applyPreset(
      payload,
      setters,
      [{ id: "proj-1" }, { id: "proj-2" }],
      [{ id: "tag-1" }],
    );

    expect(setters.calls.setSearchQuery).toEqual(['"muscle protein synthesis"']);
    expect(setters.calls.setSelectedKeywords).toEqual([["sleep", "exercise"]]);
    expect(setters.calls.setSelectedProjectIds).toEqual([["proj-1", "proj-2"]]);
    expect(setters.calls.setSelectedTagIds).toEqual([["tag-1"]]);
    expect(result).toEqual({ droppedProjectCount: 0, droppedTagCount: 0 });
  });

  it("partially drops stale project ids and keeps valid siblings", () => {
    const setters = makeSetters();
    const payload: PresetPayload = {
      ...defaultPayload(),
      selectedProjectIds: ["proj-1", "proj-gone", "proj-2"],
      selectedTagIds: ["tag-1"],
    };
    const result = applyPreset(
      payload,
      setters,
      [{ id: "proj-1" }, { id: "proj-2" }],
      [{ id: "tag-1" }],
    );

    expect(setters.calls.setSelectedProjectIds).toEqual([["proj-1", "proj-2"]]);
    expect(setters.calls.setSelectedTagIds).toEqual([["tag-1"]]);
    expect(result.droppedProjectCount).toBe(1);
    expect(result.droppedTagCount).toBe(0);
  });

  it("partially drops stale tag ids and keeps valid siblings", () => {
    const setters = makeSetters();
    const payload: PresetPayload = {
      ...defaultPayload(),
      selectedProjectIds: ["proj-1"],
      selectedTagIds: ["tag-1", "tag-gone", "tag-also-gone"],
    };
    const result = applyPreset(payload, setters, [{ id: "proj-1" }], [{ id: "tag-1" }]);

    expect(setters.calls.setSelectedProjectIds).toEqual([["proj-1"]]);
    expect(setters.calls.setSelectedTagIds).toEqual([["tag-1"]]);
    expect(result.droppedProjectCount).toBe(0);
    expect(result.droppedTagCount).toBe(2);
  });

  it("reports drops in both categories", () => {
    const setters = makeSetters();
    const payload: PresetPayload = {
      ...defaultPayload(),
      selectedProjectIds: ["proj-gone"],
      selectedTagIds: ["tag-gone-1", "tag-gone-2"],
    };
    const result = applyPreset(payload, setters, [], []);

    expect(setters.calls.setSelectedProjectIds).toEqual([[]]);
    expect(setters.calls.setSelectedTagIds).toEqual([[]]);
    expect(result).toEqual({ droppedProjectCount: 1, droppedTagCount: 2 });
  });

  it("treats empty saved arrays as non-stale (no toast path)", () => {
    const setters = makeSetters();
    const result = applyPreset(defaultPayload(), setters, [], []);
    expect(result).toEqual({ droppedProjectCount: 0, droppedTagCount: 0 });
  });
});

// ── arePresetPayloadsEqual ──────────────────────────────────────────────

/** A fully-populated payload used as the base for field-by-field diffs. */
function populatedPayload(): PresetPayload {
  return {
    version: PRESET_PAYLOAD_VERSION,
    searchQuery: '"muscle protein synthesis"',
    yearFrom: "2020",
    yearTo: "2024",
    studyType: "RCT",
    notesPresence: "has",
    selectedKeywords: ["sleep", "asthma", "HIIT"],
    selectedProjectIds: ["11111111-1111-1111-1111-111111111111", "aaaa"],
    selectedTagIds: ["22222222-2222-2222-2222-222222222222"],
  };
}

describe("arePresetPayloadsEqual", () => {
  it("returns true for two identical default payloads", () => {
    expect(arePresetPayloadsEqual(defaultPayload(), defaultPayload())).toBe(true);
  });

  it("returns true for two identical fully-populated payloads", () => {
    expect(arePresetPayloadsEqual(populatedPayload(), populatedPayload())).toBe(true);
  });

  it.each<[string, Partial<PresetPayload>]>([
    ["searchQuery", { searchQuery: "different" }],
    ["yearFrom", { yearFrom: "2019" }],
    ["yearTo", { yearTo: "2025" }],
    ["studyType", { studyType: "meta-analysis" }],
    ["notesPresence", { notesPresence: "none" }],
    ["selectedProjectIds", { selectedProjectIds: ["33333333-3333-3333-3333-333333333333"] }],
    ["selectedTagIds", { selectedTagIds: [] }],
  ])("returns false when %s differs", (_field, patch) => {
    const a = populatedPayload();
    const b = { ...populatedPayload(), ...patch };
    expect(arePresetPayloadsEqual(a, b)).toBe(false);
  });

  it("compares selectedProjectIds order-insensitively", () => {
    const a = { ...populatedPayload(), selectedProjectIds: ["A", "B"] };
    const b = { ...populatedPayload(), selectedProjectIds: ["B", "A"] };
    expect(arePresetPayloadsEqual(a, b)).toBe(true);
  });

  it("compares selectedTagIds order-insensitively", () => {
    const a = { ...populatedPayload(), selectedTagIds: ["X", "Y", "Z"] };
    const b = { ...populatedPayload(), selectedTagIds: ["Z", "X", "Y"] };
    expect(arePresetPayloadsEqual(a, b)).toBe(true);
  });

  it("returns false when a project id is added (dirty)", () => {
    const a = { ...populatedPayload(), selectedProjectIds: ["A"] };
    const b = { ...populatedPayload(), selectedProjectIds: ["A", "B"] };
    expect(arePresetPayloadsEqual(a, b)).toBe(false);
  });

  it("returns false when a tag id is removed (dirty)", () => {
    const a = { ...populatedPayload(), selectedTagIds: ["A", "B"] };
    const b = { ...populatedPayload(), selectedTagIds: ["A"] };
    expect(arePresetPayloadsEqual(a, b)).toBe(false);
  });

  it("returns true when selectedKeywords are the same set in a different order", () => {
    const a = populatedPayload(); // ["sleep", "asthma", "HIIT"]
    const b = { ...populatedPayload(), selectedKeywords: ["HIIT", "sleep", "asthma"] };
    expect(arePresetPayloadsEqual(a, b)).toBe(true);
  });

  it("returns false when selectedKeywords differ by one element", () => {
    const a = populatedPayload();
    const b = { ...populatedPayload(), selectedKeywords: ["sleep", "asthma", "keto"] };
    expect(arePresetPayloadsEqual(a, b)).toBe(false);
  });

  it("returns false for a version mismatch (defensive / future-proof)", () => {
    const a = populatedPayload();
    const b = { ...populatedPayload(), version: 99 as unknown as typeof PRESET_PAYLOAD_VERSION };
    expect(arePresetPayloadsEqual(a, b)).toBe(false);
  });

  it("treats whitespace differences in searchQuery as dirty", () => {
    const a = { ...populatedPayload(), searchQuery: "sleep" };
    const b = { ...populatedPayload(), searchQuery: "sleep " };
    expect(arePresetPayloadsEqual(a, b)).toBe(false);
  });
});

// ── prepareRename ───────────────────────────────────────────────────────

describe("prepareRename", () => {
  const preset = { name: "My Preset" };

  it("returns ok with the trimmed new name when it differs", () => {
    expect(prepareRename(preset, "  Other name  ")).toEqual({
      kind: "ok",
      trimmedName: "Other name",
    });
  });

  it("returns noop when the trimmed new name equals the current name", () => {
    expect(prepareRename(preset, "My Preset")).toEqual({ kind: "noop" });
  });

  it("returns noop when only surrounding whitespace differs (equal after trim)", () => {
    expect(prepareRename(preset, "   My Preset   ")).toEqual({ kind: "noop" });
  });

  it("treats a case-only difference as a real rename, not a no-op", () => {
    expect(prepareRename(preset, "my preset")).toEqual({
      kind: "ok",
      trimmedName: "my preset",
    });
  });

  it("returns invalid for an empty new name", () => {
    const res = prepareRename(preset, "");
    expect(res.kind).toBe("invalid");
  });

  it("returns invalid for a new name over the max length", () => {
    const tooLong = "x".repeat(PRESET_NAME_MAX_LENGTH + 1);
    const res = prepareRename(preset, tooLong);
    expect(res.kind).toBe("invalid");
  });

  it("returns ok for a new name exactly at the max length", () => {
    const atMax = "x".repeat(PRESET_NAME_MAX_LENGTH);
    expect(prepareRename(preset, atMax)).toEqual({ kind: "ok", trimmedName: atMax });
  });
});
