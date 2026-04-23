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
