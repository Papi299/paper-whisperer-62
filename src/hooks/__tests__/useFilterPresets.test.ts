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
    setSelectedProjectId: [],
    setSelectedTagId: [],
  };
  return {
    calls,
    setSearchQuery: (v) => calls.setSearchQuery.push(v),
    setYearFrom: (v) => calls.setYearFrom.push(v),
    setYearTo: (v) => calls.setYearTo.push(v),
    setStudyType: (v) => calls.setStudyType.push(v),
    setNotesPresence: (v) => calls.setNotesPresence.push(v),
    setSelectedKeywords: (v) => calls.setSelectedKeywords.push(v),
    setSelectedProjectId: (v) => calls.setSelectedProjectId.push(v),
    setSelectedTagId: (v) => calls.setSelectedTagId.push(v),
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
    selectedProjectId: null,
    selectedTagId: null,
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
  it("attaches the current version constant", () => {
    const payload = buildPresetPayload({
      searchQuery: "foo",
      yearFrom: "",
      yearTo: "",
      studyType: "all",
      notesPresence: "all",
      selectedKeywords: [],
      selectedProjectId: null,
      selectedTagId: null,
    });
    expect(payload.version).toBe(PRESET_PAYLOAD_VERSION);
    expect(payload.searchQuery).toBe("foo");
  });
});

// ── parsePresetPayload (Zod) ────────────────────────────────────────────

describe("parsePresetPayload", () => {
  it("returns the parsed payload for a valid row", () => {
    const payload = defaultPayload();
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
    expect(setters.calls.setSelectedProjectId).toEqual([null]);
    expect(setters.calls.setSelectedTagId).toEqual([null]);
    expect(result).toEqual({ droppedProjectId: false, droppedTagId: false });
  });

  it("restores a fully-populated payload when project and tag still exist", () => {
    const setters = makeSetters();
    const payload: PresetPayload = {
      version: PRESET_PAYLOAD_VERSION,
      searchQuery: '"muscle protein synthesis"',
      yearFrom: "2020",
      yearTo: "2025",
      studyType: "Review",
      notesPresence: "has",
      selectedKeywords: ["sleep", "exercise"],
      selectedProjectId: "proj-1",
      selectedTagId: "tag-1",
    };
    const result = applyPreset(
      payload,
      setters,
      [{ id: "proj-1" }, { id: "proj-2" }],
      [{ id: "tag-1" }],
    );

    expect(setters.calls.setSearchQuery).toEqual(['"muscle protein synthesis"']);
    expect(setters.calls.setSelectedKeywords).toEqual([["sleep", "exercise"]]);
    expect(setters.calls.setSelectedProjectId).toEqual(["proj-1"]);
    expect(setters.calls.setSelectedTagId).toEqual(["tag-1"]);
    expect(result).toEqual({ droppedProjectId: false, droppedTagId: false });
  });

  it("drops a stale project id and reports it", () => {
    const setters = makeSetters();
    const payload: PresetPayload = {
      ...defaultPayload(),
      selectedProjectId: "proj-gone",
      selectedTagId: "tag-1",
    };
    const result = applyPreset(payload, setters, [{ id: "proj-1" }], [{ id: "tag-1" }]);

    expect(setters.calls.setSelectedProjectId).toEqual([null]);
    expect(setters.calls.setSelectedTagId).toEqual(["tag-1"]);
    expect(result.droppedProjectId).toBe(true);
    expect(result.droppedTagId).toBe(false);
  });

  it("drops a stale tag id and reports it", () => {
    const setters = makeSetters();
    const payload: PresetPayload = {
      ...defaultPayload(),
      selectedProjectId: "proj-1",
      selectedTagId: "tag-gone",
    };
    const result = applyPreset(payload, setters, [{ id: "proj-1" }], [{ id: "tag-1" }]);

    expect(setters.calls.setSelectedProjectId).toEqual(["proj-1"]);
    expect(setters.calls.setSelectedTagId).toEqual([null]);
    expect(result.droppedProjectId).toBe(false);
    expect(result.droppedTagId).toBe(true);
  });

  it("reports both drops when both ids are stale", () => {
    const setters = makeSetters();
    const payload: PresetPayload = {
      ...defaultPayload(),
      selectedProjectId: "proj-gone",
      selectedTagId: "tag-gone",
    };
    const result = applyPreset(payload, setters, [], []);

    expect(setters.calls.setSelectedProjectId).toEqual([null]);
    expect(setters.calls.setSelectedTagId).toEqual([null]);
    expect(result).toEqual({ droppedProjectId: true, droppedTagId: true });
  });

  it("treats a null saved project id as non-stale (no toast path)", () => {
    const setters = makeSetters();
    const result = applyPreset(defaultPayload(), setters, [], []);
    expect(result.droppedProjectId).toBe(false);
    expect(result.droppedTagId).toBe(false);
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
    selectedProjectId: "11111111-1111-1111-1111-111111111111",
    selectedTagId: "22222222-2222-2222-2222-222222222222",
  };
}

describe("arePresetPayloadsEqual", () => {
  it("returns true for two identical default payloads", () => {
    expect(arePresetPayloadsEqual(defaultPayload(), defaultPayload())).toBe(true);
  });

  it("returns true for two identical fully-populated payloads", () => {
    expect(arePresetPayloadsEqual(populatedPayload(), populatedPayload())).toBe(true);
  });

  it.each<[keyof PresetPayload, Partial<PresetPayload>]>([
    ["searchQuery", { searchQuery: "different" }],
    ["yearFrom", { yearFrom: "2019" }],
    ["yearTo", { yearTo: "2025" }],
    ["studyType", { studyType: "meta-analysis" }],
    ["notesPresence", { notesPresence: "none" }],
    ["selectedProjectId", { selectedProjectId: "33333333-3333-3333-3333-333333333333" }],
    ["selectedTagId", { selectedTagId: null }],
  ])("returns false when %s differs", (_field, patch) => {
    const a = populatedPayload();
    const b = { ...populatedPayload(), ...patch };
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

  it("returns false when selectedKeywords lengths differ", () => {
    const a = populatedPayload();
    const b = { ...populatedPayload(), selectedKeywords: ["sleep", "asthma"] };
    expect(arePresetPayloadsEqual(a, b)).toBe(false);
  });

  it("returns true for empty selectedKeywords on both sides", () => {
    expect(arePresetPayloadsEqual(defaultPayload(), defaultPayload())).toBe(true);
  });

  it("distinguishes null from empty string on selectedProjectId", () => {
    // The payload Zod schema currently only produces UUID | null, but the
    // comparator must not silently treat "" as null — a future schema
    // accident should still read as dirty, not clean.
    const a = { ...populatedPayload(), selectedProjectId: null };
    const b = { ...populatedPayload(), selectedProjectId: "" as unknown as string };
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

  it("treats case differences in searchQuery as dirty", () => {
    const a = { ...populatedPayload(), searchQuery: "Asthma" };
    const b = { ...populatedPayload(), searchQuery: "asthma" };
    expect(arePresetPayloadsEqual(a, b)).toBe(false);
  });
});
