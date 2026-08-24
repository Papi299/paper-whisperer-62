/**
 * The `PaperOrganizationSuggestions` creation-interlock contract, tested
 * directly on the component rather than through Edit Paper.
 *
 * ## Why call *ordering* and not `waitFor`
 *
 * The dialog disables Save while `onCreationPendingChange(true)` is in effect,
 * and the invariant is that Save becomes impossible **before** the insert
 * starts — not merely soon afterwards. `await waitFor(() => expect(save)
 * .toBeDisabled())` cannot see that difference: it passes for an implementation
 * that reports the transition from a passive effect, which runs only after the
 * next render commits, leaving a window in which the mutation is already in
 * flight while Save is still live. Worse, React Testing Library wraps
 * `fireEvent` in `act()`, which flushes effects before returning — so even a
 * bare post-click assertion cannot distinguish the two.
 *
 * What distinguishes them is the order of the *callbacks themselves*. The
 * handler calls `onCreateProject` on its own call stack, before returning; a
 * passive effect can only run after that. So:
 *
 *   event-path (correct):  ["pending:true", "createProject", …]
 *   effect-based (buggy):  ["createProject", "pending:true", …]
 *
 * Every test below records into one shared log and asserts the whole sequence,
 * which is why reverting to the effect flips them red rather than leaving them
 * quietly green.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import type { Project, Tag } from "@/types/database";
import type { OrganizationSuggestions } from "@/lib/suggestPaperOrganizationEdge";

const { mockSuggest, mockToast } = vi.hoisted(() => ({
  mockSuggest: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("@/lib/suggestPaperOrganizationEdge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/suggestPaperOrganizationEdge")>();
  return { ...actual, suggestPaperOrganization: mockSuggest };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
  toast: mockToast,
}));

import { PaperOrganizationSuggestions } from "../PaperOrganizationSuggestions";

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

// ── Fixtures ───────────────────────────────────────────────────────────

const PROJECT_A: Project = {
  id: "proj-a",
  user_id: "u1",
  name: "Sarcopenia",
  description: null,
  color: "#111111",
  created_at: "2026-01-01T00:00:00Z",
};
const TAG_A: Tag = {
  id: "tag-a",
  user_id: "u1",
  name: "RCT",
  color: "#222222",
  created_at: "2026-01-01T00:00:00Z",
};

const PROPOSED_PROJECT = "Resistance Training";
const PROPOSED_TAG = "older-adults";

const SUGGESTIONS: OrganizationSuggestions = {
  existingProjects: [],
  existingTags: [],
  newProjects: [
    { name: PROPOSED_PROJECT, description: "Strength work.", reason: "Recurring theme." },
  ],
  newTags: [{ name: PROPOSED_TAG, reason: "The cohort is 65+." }],
};

/** A promise the test resolves by hand, so the in-flight window is explicit. */
function deferred<T>() {
  let release: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, rej) => {
    release = resolve;
    reject = rej;
  });
  return { promise, release: (v: T) => release(v), reject: (r: unknown) => reject(r) };
}

interface Harness {
  projects?: Project[];
  tags?: Tag[];
  onCreateProject?: (name: string, description?: string | null) => Promise<Project | null>;
  onCreateTag?: (name: string) => Promise<Tag | null>;
}

/**
 * Render the surface with every callback wired into one ordered log.
 * The log is the assertion surface for all the interlock tests.
 */
function renderSurface(harness: Harness = {}) {
  const order: string[] = [];

  const onCreationPendingChange = vi.fn((pending: boolean) => {
    order.push(`pending:${pending}`);
  });
  const onSelectProject = vi.fn((id: string) => {
    order.push(`selectProject:${id}`);
  });
  const onSelectTag = vi.fn((id: string) => {
    order.push(`selectTag:${id}`);
  });
  const onCreateProject = vi.fn((name: string, description?: string | null) => {
    order.push("createProject");
    return (harness.onCreateProject ?? (async () => null))(name, description);
  });
  const onCreateTag = vi.fn((name: string) => {
    order.push("createTag");
    return (harness.onCreateTag ?? (async () => null))(name);
  });

  const view = render(
    <PaperOrganizationSuggestions
      paperId="paper-1"
      draft={{
        title: "Resistance training in older adults",
        abstract: "A randomised trial.",
        keywords: ["sarcopenia"],
        studyType: "",
      }}
      projects={harness.projects ?? [PROJECT_A]}
      tags={harness.tags ?? [TAG_A]}
      selectedProjectIds={[]}
      selectedTagIds={[]}
      onSelectProject={onSelectProject}
      onSelectTag={onSelectTag}
      onCreateProject={onCreateProject}
      onCreateTag={onCreateTag}
      onCreationPendingChange={onCreationPendingChange}
    />,
  );

  return {
    ...view,
    order,
    onCreationPendingChange,
    onSelectProject,
    onSelectTag,
    onCreateProject,
    onCreateTag,
  };
}

async function generate() {
  fireEvent.click(screen.getByRole("button", { name: /Suggest Projects & Tags/ }));
  await waitFor(() => expect(mockSuggest).toHaveBeenCalled());
  await screen.findByText("Recurring theme.");
}

const createProjectButton = (name = PROPOSED_PROJECT) =>
  screen.getByRole("button", { name: `Create project "${name}" and select it for this paper` });
const createTagButton = (name = PROPOSED_TAG) =>
  screen.getByRole("button", { name: `Create tag "${name}" and select it for this paper` });

beforeEach(() => {
  vi.clearAllMocks();
  mockSuggest.mockResolvedValue(SUGGESTIONS);
});

// ── The interlock opens on the event path ──────────────────────────────

describe("PaperOrganizationSuggestions — creation interlock is synchronous", () => {
  it("reports pending BEFORE the Project insert starts", async () => {
    const creation = deferred<Project | null>();
    const surface = renderSurface({ onCreateProject: () => creation.promise });
    await generate();

    fireEvent.click(createProjectButton());

    // The discriminator. An effect-based implementation records
    // ["createProject", "pending:true"] — the mutation would already be in
    // flight with Save still live.
    expect(surface.order).toEqual(["pending:true", "createProject"]);

    await act(async () => {
      creation.release({ ...PROJECT_A, id: "proj-new", name: PROPOSED_PROJECT });
      await Promise.resolve();
    });
  });

  it("reports pending BEFORE the Tag insert starts", async () => {
    const creation = deferred<Tag | null>();
    const surface = renderSurface({ onCreateTag: () => creation.promise });
    await generate();

    fireEvent.click(createTagButton());

    expect(surface.order).toEqual(["pending:true", "createTag"]);

    await act(async () => {
      creation.release({ ...TAG_A, id: "tag-new", name: PROPOSED_TAG });
      await Promise.resolve();
    });
  });

  it("selects the new Project id before releasing the interlock", async () => {
    const creation = deferred<Project | null>();
    const surface = renderSurface({ onCreateProject: () => creation.promise });
    await generate();

    fireEvent.click(createProjectButton());
    await act(async () => {
      creation.release({ ...PROJECT_A, id: "proj-new", name: PROPOSED_PROJECT });
      await Promise.resolve();
    });

    // Selection lands in the same synchronous continuation that then clears the
    // interlock, so Save cannot re-enable in a render without the new id.
    expect(surface.order).toEqual([
      "pending:true",
      "createProject",
      "selectProject:proj-new",
      "pending:false",
    ]);
  });

  it("selects the new Tag id before releasing the interlock", async () => {
    const creation = deferred<Tag | null>();
    const surface = renderSurface({ onCreateTag: () => creation.promise });
    await generate();

    fireEvent.click(createTagButton());
    await act(async () => {
      creation.release({ ...TAG_A, id: "tag-new", name: PROPOSED_TAG });
      await Promise.resolve();
    });

    expect(surface.order).toEqual([
      "pending:true",
      "createTag",
      "selectTag:tag-new",
      "pending:false",
    ]);
  });

  it("releases the interlock and selects nothing when the mutation returns null", async () => {
    const creation = deferred<Project | null>();
    const surface = renderSurface({ onCreateProject: () => creation.promise });
    await generate();

    fireEvent.click(createProjectButton());
    await act(async () => {
      creation.release(null);
      await Promise.resolve();
    });

    expect(surface.order).toEqual(["pending:true", "createProject", "pending:false"]);
    expect(surface.onSelectProject).not.toHaveBeenCalled();
  });

  it("releases the interlock through finally when the mutation throws", async () => {
    const creation = deferred<Project | null>();
    const surface = renderSurface({ onCreateProject: () => creation.promise });
    await generate();

    fireEvent.click(createProjectButton());
    expect(surface.order).toEqual(["pending:true", "createProject"]);

    await act(async () => {
      creation.reject(new Error("insert exploded"));
      // Let the rejection travel through the handler's catch and finally.
      await creation.promise.catch(() => undefined);
      await Promise.resolve();
    });

    // A throwing mutation must never strand Save disabled…
    expect(surface.order).toEqual(["pending:true", "createProject", "pending:false"]);
    // …and must not select an id that was never proven to exist.
    expect(surface.onSelectProject).not.toHaveBeenCalled();
    // The failure is stated rather than swallowed into an unhandled rejection.
    expect(screen.getAllByText(/could not be created/).length).toBeGreaterThan(0);
  });
});

// ── Paths that start no insert must not hold Save at all ───────────────

describe("PaperOrganizationSuggestions — non-insert paths never engage the interlock", () => {
  it("an ambiguous current collision creates nothing and never reports pending", async () => {
    const surface = renderSurface({
      projects: [
        { ...PROJECT_A, id: "collide-1", name: PROPOSED_PROJECT },
        { ...PROJECT_A, id: "collide-2", name: ` ${PROPOSED_PROJECT.toLowerCase()} ` },
      ],
    });
    await generate();

    fireEvent.click(createProjectButton());

    expect(surface.order).toEqual([]);
    expect(surface.onCreateProject).not.toHaveBeenCalled();
    expect(surface.onSelectProject).not.toHaveBeenCalled();
    expect(surface.onCreationPendingChange).not.toHaveBeenCalled();
  });

  it("a unique current collision selects the existing row without engaging the interlock", async () => {
    const surface = renderSurface({
      projects: [{ ...PROJECT_A, id: "collide-1", name: ` ${PROPOSED_PROJECT.toLowerCase()} ` }],
    });
    await generate();

    fireEvent.click(
      screen.getByRole("button", {
        name: `Select existing project " ${PROPOSED_PROJECT.toLowerCase()} " for this paper`,
      }),
    );

    // Selecting an existing row starts no insert, so Save must stay available.
    expect(surface.order).toEqual(["selectProject:collide-1"]);
    expect(surface.onCreateProject).not.toHaveBeenCalled();
    expect(surface.onCreationPendingChange).not.toHaveBeenCalled();
  });

  it("an ambiguous Tag collision creates nothing and never reports pending", async () => {
    const surface = renderSurface({
      tags: [
        { ...TAG_A, id: "tcollide-1", name: PROPOSED_TAG },
        { ...TAG_A, id: "tcollide-2", name: ` ${PROPOSED_TAG.toUpperCase()} ` },
      ],
    });
    await generate();

    fireEvent.click(createTagButton());

    expect(surface.order).toEqual([]);
    expect(surface.onCreateTag).not.toHaveBeenCalled();
    expect(surface.onCreationPendingChange).not.toHaveBeenCalled();
  });

  it("releases the interlock on unmount so a closed dialog cannot strand Save", async () => {
    const creation = deferred<Project | null>();
    const surface = renderSurface({ onCreateProject: () => creation.promise });
    await generate();

    fireEvent.click(createProjectButton());
    expect(surface.order).toEqual(["pending:true", "createProject"]);

    surface.unmount();
    expect(surface.order).toEqual(["pending:true", "createProject", "pending:false"]);

    // The insert still completes — the entity is the user's, and the contract
    // keeps it — but nothing is staged against a surface that is gone.
    await act(async () => {
      creation.release({ ...PROJECT_A, id: "proj-new", name: PROPOSED_PROJECT });
      await Promise.resolve();
    });
    expect(surface.onSelectProject).not.toHaveBeenCalled();
  });
});
