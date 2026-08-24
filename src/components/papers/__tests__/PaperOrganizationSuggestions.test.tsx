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

/**
 * Replay a recorded transition stream through the interlock rule the dialog
 * documents and implements: acquiring always takes ownership, releasing applies
 * only if it carries the owning token.
 *
 * Asserting on this rather than only on the raw calls is what makes these
 * component-level tests load-bearing. A child that emitted an unowned release —
 * or no token at all — would leave a conforming parent unlocked here, which is
 * exactly the production defect, without any dependence on how this particular
 * dialog happens to be written.
 */
function effectivePending(calls: Array<{ pending: boolean; token: number }>): boolean {
  let owner: number | null = null;
  for (const call of calls) {
    if (call.pending) {
      owner = call.token;
    } else if (owner === call.token) {
      owner = null;
    }
  }
  return owner !== null;
}

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
  paperId?: string;
  onCreateProject?: (name: string, description?: string | null) => Promise<Project | null>;
  onCreateTag?: (name: string) => Promise<Tag | null>;
}

/**
 * Render the surface with every callback wired into one ordered log.
 * The log is the assertion surface for all the interlock tests.
 */
function renderSurface(harness: Harness = {}) {
  const order: string[] = [];

  /** Every interlock transition with its token, for the ownership assertions. */
  const pendingCalls: Array<{ pending: boolean; token: number }> = [];
  const onCreationPendingChange = vi.fn((pending: boolean, token: number) => {
    order.push(`pending:${pending}`);
    pendingCalls.push({ pending, token });
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

  const renderTree = (paperId: string) => (
    <PaperOrganizationSuggestions
      paperId={paperId}
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
    />
  );

  const view = render(renderTree(harness.paperId ?? "paper-1"));

  /** Switch the surface to another paper without unmounting it. */
  const changePaper = (paperId: string) => view.rerender(renderTree(paperId));

  return {
    changePaper,
    ...view,
    order,
    pendingCalls,
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

// ── Ownership: a superseded creation may not release a newer one ───────

/**
 * The same component instance can be handed a different `paperId` — the prop
 * is part of its contract, and the reset effect is written for exactly that.
 * Production reaches the equivalent state by unmounting and remounting instead
 * (Dashboard clears `editingPaper` on close, and the dialog is modal, so a
 * second paper cannot be opened over the first), which the Edit Paper suite
 * covers at the real Save boundary. These prove the *component's* ownership
 * cannot be corrupted through its supported prop transition either.
 */
describe("PaperOrganizationSuggestions — a superseded creation owns nothing", () => {
  it("a stale Project completion cannot release the newer creation's interlock", async () => {
    const creationA = deferred<Project | null>();
    const creationB = deferred<Project | null>();
    const create = vi
      .fn<(name: string, description?: string | null) => Promise<Project | null>>()
      .mockReturnValueOnce(creationA.promise)
      .mockReturnValueOnce(creationB.promise);

    const surface = renderSurface({ onCreateProject: create });
    await generate();

    // ── A owns the interlock ──
    fireEvent.click(createProjectButton());
    const tokenA = surface.pendingCalls.at(-1)!.token;
    expect(surface.pendingCalls.at(-1)).toEqual({ pending: true, token: tokenA });

    // ── The paper changes: A is abandoned and its interlock handed back ──
    surface.changePaper("paper-2");
    expect(surface.pendingCalls.at(-1)).toEqual({ pending: false, token: tokenA });

    // ── B takes the interlock ──
    await generate();
    fireEvent.click(createProjectButton());
    const tokenB = surface.pendingCalls.at(-1)!.token;
    expect(tokenB).not.toBe(tokenA);
    expect(surface.pendingCalls.at(-1)).toEqual({ pending: true, token: tokenB });

    // ── THE DECISIVE WINDOW: old A settles while B is still in flight ──
    await act(async () => {
      creationA.release({ ...PROJECT_A, id: "proj-A", name: PROPOSED_PROJECT });
      await Promise.resolve();
    });

    // A may speak, but only ever about itself — never a release carrying B's
    // token, which is the only thing the parent would obey.
    expect(surface.pendingCalls.filter((c) => !c.pending && c.token === tokenB)).toEqual([]);
    expect(surface.pendingCalls.at(-1)).toEqual({ pending: false, token: tokenA });
    // The decisive property: a conforming parent is STILL LOCKED for B.
    expect(effectivePending(surface.pendingCalls)).toBe(true);
    // A's id must not be staged against the paper it does not belong to.
    expect(surface.onSelectProject).not.toHaveBeenCalled();

    // ── Only B's own completion releases B ──
    await act(async () => {
      creationB.release({ ...PROJECT_A, id: "proj-B", name: PROPOSED_PROJECT });
      await Promise.resolve();
    });
    expect(surface.onSelectProject).toHaveBeenCalledWith("proj-B");
    expect(surface.pendingCalls.at(-1)).toEqual({ pending: false, token: tokenB });
    expect(effectivePending(surface.pendingCalls)).toBe(false);
  });

  it("a stale Tag completion cannot release the newer creation's interlock", async () => {
    const creationA = deferred<Tag | null>();
    const creationB = deferred<Tag | null>();
    const create = vi
      .fn<(name: string) => Promise<Tag | null>>()
      .mockReturnValueOnce(creationA.promise)
      .mockReturnValueOnce(creationB.promise);

    const surface = renderSurface({ onCreateTag: create });
    await generate();

    fireEvent.click(createTagButton());
    const tokenA = surface.pendingCalls.at(-1)!.token;

    surface.changePaper("paper-2");
    expect(surface.pendingCalls.at(-1)).toEqual({ pending: false, token: tokenA });

    await generate();
    fireEvent.click(createTagButton());
    const tokenB = surface.pendingCalls.at(-1)!.token;
    expect(tokenB).not.toBe(tokenA);

    await act(async () => {
      creationA.release({ ...TAG_A, id: "tag-A", name: PROPOSED_TAG });
      await Promise.resolve();
    });

    expect(surface.pendingCalls.filter((c) => !c.pending && c.token === tokenB)).toEqual([]);
    expect(effectivePending(surface.pendingCalls)).toBe(true);
    expect(surface.onSelectTag).not.toHaveBeenCalled();

    await act(async () => {
      creationB.release({ ...TAG_A, id: "tag-B", name: PROPOSED_TAG });
      await Promise.resolve();
    });
    expect(surface.onSelectTag).toHaveBeenCalledWith("tag-B");
    expect(surface.pendingCalls.at(-1)).toEqual({ pending: false, token: tokenB });
    expect(effectivePending(surface.pendingCalls)).toBe(false);
  });

  it.each([
    ["a null result", "null" as const],
    ["a thrown rejection", "throw" as const],
  ])("a stale creation ending in %s releases only its own token", async (_label, outcome) => {
    const creationA = deferred<Project | null>();
    const creationB = deferred<Project | null>();
    const create = vi
      .fn<(name: string, description?: string | null) => Promise<Project | null>>()
      .mockReturnValueOnce(creationA.promise)
      .mockReturnValueOnce(creationB.promise);

    const surface = renderSurface({ onCreateProject: create });
    await generate();

    fireEvent.click(createProjectButton());
    const tokenA = surface.pendingCalls.at(-1)!.token;

    surface.changePaper("paper-2");
    await generate();
    fireEvent.click(createProjectButton());
    const tokenB = surface.pendingCalls.at(-1)!.token;

    await act(async () => {
      if (outcome === "throw") {
        creationA.reject(new Error("stale insert exploded"));
        await creationA.promise.catch(() => undefined);
      } else {
        creationA.release(null);
      }
      await Promise.resolve();
    });

    // Ownership applies to every `finally`, not only the successful one.
    expect(surface.pendingCalls.filter((c) => !c.pending && c.token === tokenB)).toEqual([]);
    expect(surface.pendingCalls.at(-1)).toEqual({ pending: false, token: tokenA });
    expect(effectivePending(surface.pendingCalls)).toBe(true);

    await act(async () => {
      creationB.release({ ...PROJECT_A, id: "proj-B", name: PROPOSED_PROJECT });
      await Promise.resolve();
    });
    expect(surface.pendingCalls.at(-1)).toEqual({ pending: false, token: tokenB });
  });

  it("a stale completion cannot clear the newer creation's local busy state", async () => {
    const creationA = deferred<Project | null>();
    const creationB = deferred<Project | null>();
    const create = vi
      .fn<(name: string, description?: string | null) => Promise<Project | null>>()
      .mockReturnValueOnce(creationA.promise)
      .mockReturnValueOnce(creationB.promise);

    const surface = renderSurface({ onCreateProject: create });
    await generate();

    fireEvent.click(createProjectButton());
    surface.changePaper("paper-2");
    await generate();
    fireEvent.click(createProjectButton());

    // B is busy: its own control and the Tag create beside it are both locked,
    // which is what `creatingKey` / `creatingRef` buy.
    expect(createProjectButton()).toBeDisabled();
    expect(createTagButton()).toBeDisabled();

    await act(async () => {
      creationA.release({ ...PROJECT_A, id: "proj-A", name: PROPOSED_PROJECT });
      await Promise.resolve();
    });

    // A's completion must not unlock B's spinner or its double-click guard.
    expect(createProjectButton()).toBeDisabled();
    expect(createTagButton()).toBeDisabled();

    await act(async () => {
      creationB.release({ ...PROJECT_A, id: "proj-B", name: PROPOSED_PROJECT });
      await Promise.resolve();
    });
    await waitFor(() => expect(createTagButton()).toBeEnabled());
  });
});
