/**
 * Edit Paper's AI organization-suggestion experience —
 * AI-PROJECT-TAG-SUGGESTIONS-001B.
 *
 * The invariants under test are behavioural, not cosmetic:
 *
 *   - **Nothing happens without a click.** Opening the dialog, loading the
 *     abstract and saving all invoke zero suggestion requests.
 *   - **Accepting an existing suggestion is LOCAL.** It changes the dialog's
 *     selection and nothing else; `onSave` runs only when the user saves, and
 *     cancelling discards the acceptance entirely.
 *   - **A new entity is created only on its own explicit click**, through the
 *     existing Project/Tag mutations, reconciled against the taxonomy as it is
 *     at that moment — never the one the server saw.
 *   - **Quota is advisory on the client and authoritative on the server.**
 *
 * The Edge wrapper is mocked at the module boundary; no real network runs.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PaperWithTags, Project, Tag } from "@/types/database";
import type { AiQuotaStatus } from "@/hooks/useAiQuota";
import type { OrganizationSuggestions } from "@/lib/suggestPaperOrganizationEdge";

// ── Mocks ──────────────────────────────────────────────────────────────

const { mockSuggest, mockInvoke, mockToast } = vi.hoisted(() => ({
  mockSuggest: vi.fn(),
  mockInvoke: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("@/lib/suggestPaperOrganizationEdge", async (importOriginal) => {
  // Keep the real error class, the real parser and the real empty-check — only
  // the network call is replaced, so classification stays under test elsewhere.
  const actual = await importOriginal<typeof import("@/lib/suggestPaperOrganizationEdge")>();
  return { ...actual, suggestPaperOrganization: mockSuggest };
});

vi.mock("@/hooks/useAttachments", () => ({
  useAttachments: () => ({
    attachments: [],
    loading: false,
    uploading: false,
    uploadAttachments: vi.fn(),
    deleteAttachment: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/useAbstract", () => ({
  // The dialog seeds the abstract from `paper.abstract`; the on-demand fetch
  // stays quiet so nothing races the assertions.
  useAbstract: () => ({ data: undefined, isLoading: false }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: mockInvoke },
    auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) },
  },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
  toast: mockToast,
}));

import { EditPaperDialog } from "../EditPaperDialog";
import { SuggestOrganizationError } from "@/lib/suggestPaperOrganizationEdge";

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
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

function makePaper(over: Partial<PaperWithTags> = {}): PaperWithTags {
  return {
    id: "paper-1",
    user_id: "u1",
    title: "Resistance training in older adults",
    authors: ["Author A"],
    year: 2024,
    journal: "J Test",
    pmid: null,
    doi: null,
    has_abstract: true,
    abstract: "A randomised trial of resistance training.",
    study_type: null,
    raw_study_type: null,
    statistical_methods: null,
    keywords: ["sarcopenia"],
    raw_keywords: null,
    mesh_terms: [],
    substances: [],
    pubmed_url: null,
    journal_url: null,
    drive_url: null,
    tldr: null,
    notes: null,
    insert_order: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    tags: [],
    projects: [],
    ...over,
  } as PaperWithTags;
}

/** A paper with a title and nothing else the server would accept as evidence. */
const TITLE_ONLY = makePaper({ abstract: null, keywords: [], study_type: null });

function suggestions(over: Partial<OrganizationSuggestions> = {}): OrganizationSuggestions {
  return {
    existingProjects: [],
    existingTags: [],
    newProjects: [],
    newTags: [],
    ...over,
  };
}

const FULL = suggestions({
  existingProjects: [{ id: PROJECT_A.id, name: PROJECT_A.name, reason: "Matches the cohort." }],
  existingTags: [{ id: TAG_A.id, name: TAG_A.name, reason: "Randomised design." }],
  newProjects: [
    { name: "Resistance Training", description: "Strength work.", reason: "Recurring theme." },
  ],
  newTags: [{ name: "older-adults", reason: "The cohort is 65+." }],
});

const EXEMPT_QUOTA: AiQuotaStatus = {
  allowed: true,
  reason: "quota_exempt",
  plan: "internal",
  planStatus: "active",
  periodType: "lifetime",
  used: 40,
  quota: 15,
  remaining: 0,
  resetAt: null,
  isExempt: true,
};

const ZERO_QUOTA: AiQuotaStatus = {
  allowed: false,
  reason: "quota_exceeded",
  plan: "free",
  planStatus: "active",
  periodType: "lifetime",
  used: 15,
  quota: 15,
  remaining: 0,
  resetAt: null,
  isExempt: false,
};

const HEALTHY_QUOTA: AiQuotaStatus = { ...ZERO_QUOTA, allowed: true, reason: "ok", used: 3, remaining: 12 };

interface RenderOptions {
  paper?: PaperWithTags | null;
  projects?: Project[];
  tags?: Tag[];
  quotaStatus?: AiQuotaStatus | null;
  onSave?: (p: unknown) => Promise<boolean>;
  onOpenChange?: (open: boolean) => void;
  onCreateProject?: (name: string, description?: string | null) => Promise<Project | null>;
  onCreateTag?: (name: string) => Promise<Tag | null>;
  onAiQuotaRefresh?: () => void;
}

function renderDialog(options: RenderOptions = {}) {
  const props = {
    paper: options.paper === undefined ? makePaper() : options.paper,
    projects: options.projects ?? [PROJECT_A],
    tags: options.tags ?? [TAG_A],
    onSave: options.onSave ?? vi.fn(async () => true),
    onOpenChange: options.onOpenChange ?? vi.fn(),
    onCreateProject: options.onCreateProject ?? vi.fn(async () => null),
    onCreateTag: options.onCreateTag ?? vi.fn(async () => null),
    aiQuotaStatus: options.quotaStatus === undefined ? HEALTHY_QUOTA : options.quotaStatus,
    onAiQuotaRefresh: options.onAiQuotaRefresh ?? vi.fn(),
  };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <EditPaperDialog
        paper={props.paper}
        projects={props.projects}
        tags={props.tags}
        open
        onOpenChange={props.onOpenChange}
        onSave={props.onSave}
        userId="u1"
        aiQuotaStatus={props.aiQuotaStatus}
        onAiQuotaRefresh={props.onAiQuotaRefresh}
        onCreateProject={props.onCreateProject}
        onCreateTag={props.onCreateTag}
      />
    </QueryClientProvider>,
  );

  /** Re-render with a different paper, reusing the same tree. */
  const rerenderWith = (next: Partial<RenderOptions>) =>
    view.rerender(
      <QueryClientProvider client={client}>
        <EditPaperDialog
          paper={next.paper === undefined ? props.paper : next.paper}
          projects={next.projects ?? props.projects}
          tags={next.tags ?? props.tags}
          open
          onOpenChange={props.onOpenChange}
          onSave={props.onSave}
          userId="u1"
          aiQuotaStatus={props.aiQuotaStatus}
          onAiQuotaRefresh={props.onAiQuotaRefresh}
          onCreateProject={props.onCreateProject}
          onCreateTag={props.onCreateTag}
        />
      </QueryClientProvider>,
    );

  return { ...view, ...props, rerenderWith };
}

const suggestButton = () =>
  screen.getByRole("button", { name: /Suggest Projects & Tags|Suggest again|Suggesting/ });

// `@testing-library/user-event` is not a dependency of this repository — the
// established primitive in these suites is `fireEvent`.
function click(element: Element) {
  fireEvent.click(element);
}

/** Set a controlled input/textarea to an exact value. */
function setField(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Append to a controlled field, the way typing would. */
function appendField(label: string, suffix: string) {
  const field = screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: field.value + suffix } });
}

async function generate() {
  click(suggestButton());
  await waitFor(() => expect(mockSuggest).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSuggest.mockResolvedValue(suggestions());
});

// ── No automatic generation ────────────────────────────────────────────

describe("EditPaperDialog — suggestions are never automatic", () => {
  it("makes zero suggestion calls when the dialog opens", () => {
    renderDialog();
    expect(screen.getByTestId("ai-organization-suggestions")).toBeInTheDocument();
    expect(mockSuggest).not.toHaveBeenCalled();
  });

  it("makes zero suggestion calls when the user saves", async () => {
    const onSave = vi.fn(async () => true);
    renderDialog({ onSave });

    click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(mockSuggest).not.toHaveBeenCalled();
  });

  it("makes zero suggestion calls while the user types", async () => {
    renderDialog();
    appendField("Title", "!");
    expect(mockSuggest).not.toHaveBeenCalled();
  });
});

// ── Eligibility ────────────────────────────────────────────────────────

describe("EditPaperDialog — eligibility", () => {
  it("disables the action and explains why for a title-only draft", () => {
    renderDialog({ paper: TITLE_ONLY });
    expect(suggestButton()).toBeDisabled();
    expect(
      screen.getByText("Add an abstract, keywords, or a study type to get useful suggestions."),
    ).toBeInTheDocument();
  });

  it("does not invoke for an ineligible draft", async () => {
    renderDialog({ paper: TITLE_ONLY });
    click(suggestButton());
    expect(mockSuggest).not.toHaveBeenCalled();
  });

  it("becomes eligible as soon as the user supplies a study type", async () => {
    renderDialog({ paper: TITLE_ONLY });
    expect(suggestButton()).toBeDisabled();

    appendField("Study Type", "RCT");
    await waitFor(() => expect(suggestButton()).toBeEnabled());
  });
});

// ── Invocation ─────────────────────────────────────────────────────────

describe("EditPaperDialog — invocation", () => {
  it("invokes exactly once for one eligible click", async () => {
    renderDialog();
    await generate();
    expect(mockSuggest).toHaveBeenCalledTimes(1);
  });

  it("cannot be invoked twice by double-clicking while a request is in flight", async () => {
    let release: (value: OrganizationSuggestions) => void = () => {};
    mockSuggest.mockReturnValue(
      new Promise<OrganizationSuggestions>((resolve) => {
        release = resolve;
      }),
    );

    renderDialog();
    const button = suggestButton();
    click(button);
    await waitFor(() => expect(suggestButton()).toBeDisabled());
    click(suggestButton());
    click(suggestButton());

    expect(mockSuggest).toHaveBeenCalledTimes(1);

    release(suggestions());
    await waitFor(() => expect(suggestButton()).toBeEnabled());
  });

  it("sends the UNSAVED current title, abstract, keywords and study type", async () => {
    renderDialog();

    setField("Title", "Edited title");
    setField("Abstract", "Edited abstract");
    setField("Keywords (comma-separated)", "alpha, beta");
    setField("Study Type", "Cohort");

    await generate();

    expect(mockSuggest).toHaveBeenCalledWith(
      expect.objectContaining({
        paperId: "paper-1",
        draft: {
          title: "Edited title",
          abstract: "Edited abstract",
          keywords: ["alpha", "beta"],
          studyType: "Cohort",
        },
      }),
    );
  });

  it("sends the current LOCAL Project/Tag selection ids", async () => {
    renderDialog({
      paper: makePaper({ projects: [PROJECT_A], tags: [TAG_A] }),
    });

    await generate();

    expect(mockSuggest).toHaveBeenCalledWith(
      expect.objectContaining({
        currentProjectIds: [PROJECT_A.id],
        currentTagIds: [TAG_A.id],
      }),
    );
  });

  it("sends no unrelated paper field", async () => {
    renderDialog({ paper: makePaper({ notes: "private", doi: "10.1/x", tldr: "summary" }) });
    await generate();

    const arg = mockSuggest.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual(
      ["currentProjectIds", "currentTagIds", "draft", "paperId"].sort(),
    );
    expect(JSON.stringify(arg)).not.toContain("private");
    expect(JSON.stringify(arg)).not.toContain("10.1/x");
    expect(JSON.stringify(arg)).not.toContain("summary");
  });
});

// ── Rendering results ──────────────────────────────────────────────────

describe("EditPaperDialog — rendering results", () => {
  it("renders every category with its reason", async () => {
    mockSuggest.mockResolvedValue(FULL);
    renderDialog();
    await generate();

    await screen.findByText("Matches the cohort.");
    expect(screen.getByText("Randomised design.")).toBeInTheDocument();
    expect(screen.getByText("Recurring theme.")).toBeInTheDocument();
    expect(screen.getByText("The cohort is 65+.")).toBeInTheDocument();
    // The proposed Project's description is shown alongside its reason.
    expect(screen.getByText("Strength work.")).toBeInTheDocument();
  });

  it("renders an honest empty-success state for a valid all-empty response", async () => {
    mockSuggest.mockResolvedValue(suggestions());
    renderDialog();
    await generate();

    const empty = await screen.findByTestId("ai-organization-empty");
    expect(empty).toHaveTextContent("No strong Project or Tag suggestions for this paper.");
    // Not an error, and nothing claims a failure.
    expect(screen.queryByTestId("ai-organization-error")).not.toBeInTheDocument();
  });

  it("removes a dismissed suggestion from the current result set", async () => {
    mockSuggest.mockResolvedValue(FULL);
    renderDialog();
    await generate();

    await screen.findByText("Matches the cohort.");
    click(screen.getByRole("button", { name: 'Dismiss project suggestion "Sarcopenia"' }));
    await waitFor(() => expect(screen.queryByText("Matches the cohort.")).not.toBeInTheDocument());
    // Purely local: nothing was persisted about the rejection.
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

// ── Accepting existing suggestions — LOCAL ONLY ────────────────────────

describe("EditPaperDialog — accepting an existing suggestion is local until Save", () => {
  it("accepting an existing Project changes only the local selection", async () => {
    mockSuggest.mockResolvedValue(FULL);
    const onSave = vi.fn(async () => true);
    renderDialog({ onSave });
    await generate();

    click(await screen.findByRole("button", { name: 'Select project "Sarcopenia" for this paper' }));

    // The selector now reports one selected project…
    await screen.findByText("1 project selected");
    // …and nothing has been persisted.
    expect(onSave).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("accepting an existing Tag changes only the local selection", async () => {
    mockSuggest.mockResolvedValue(FULL);
    const onSave = vi.fn(async () => true);
    renderDialog({ onSave });
    await generate();

    click(await screen.findByRole("button", { name: 'Select tag "RCT" for this paper' }));

    await screen.findByText("1 tag selected");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows the accepted item as Selected instead of offering Select again", async () => {
    mockSuggest.mockResolvedValue(FULL);
    renderDialog();
    await generate();

    click(await screen.findByRole("button", { name: 'Select project "Sarcopenia" for this paper' }));

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: 'Select project "Sarcopenia" for this paper' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getAllByText("Selected").length).toBeGreaterThan(0);
  });

  it("Save includes the accepted ids", async () => {
    mockSuggest.mockResolvedValue(FULL);
    const onSave = vi.fn(async () => true);
    renderDialog({ onSave });
    await generate();

    click(await screen.findByRole("button", { name: 'Select project "Sarcopenia" for this paper' }));
    click(screen.getByRole("button", { name: 'Select tag "RCT" for this paper' }));
    click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        projectIds: [PROJECT_A.id],
        tagIds: [TAG_A.id],
      }),
    );
  });

  it("cancelling without Save assigns nothing", async () => {
    mockSuggest.mockResolvedValue(FULL);
    const onSave = vi.fn(async () => true);
    const onOpenChange = vi.fn();
    renderDialog({ onSave, onOpenChange });
    await generate();

    click(await screen.findByRole("button", { name: 'Select project "Sarcopenia" for this paper' }));
    click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not offer Select for a Project that has left the taxonomy since generation", async () => {
    mockSuggest.mockResolvedValue(FULL);
    // The suggestion names `proj-a`, but the current taxonomy no longer has it.
    renderDialog({ projects: [] });
    await generate();

    const button = await screen.findByRole("button", {
      name: 'Select project "Sarcopenia" for this paper',
    });
    expect(button).toBeDisabled();
    expect(screen.getByText("No longer in your library.")).toBeInTheDocument();
  });
});

// ── New entities — explicit creation ───────────────────────────────────

describe("EditPaperDialog — Create & select", () => {
  it("calls the existing Project mutation only after the explicit click, with the description", async () => {
    mockSuggest.mockResolvedValue(FULL);
    const created: Project = { ...PROJECT_A, id: "proj-new", name: "Resistance Training" };
    const onCreateProject = vi.fn(async () => created);
    renderDialog({ onCreateProject });
    await generate();

    // Rendering the proposal must not have created anything.
    await screen.findByText("Recurring theme.");
    expect(onCreateProject).not.toHaveBeenCalled();

    click(screen.getByRole("button", {
        name: 'Create project "Resistance Training" and select it for this paper',
      }));

    await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(1));
    expect(onCreateProject).toHaveBeenCalledWith("Resistance Training", "Strength work.");
  });

  it("selects the returned id locally after a successful creation", async () => {
    mockSuggest.mockResolvedValue(FULL);
    const created: Project = { ...PROJECT_A, id: "proj-new", name: "Resistance Training" };
    const onSave = vi.fn(async () => true);
    renderDialog({ onCreateProject: vi.fn(async () => created), onSave });
    await generate();

    click(await screen.findByRole("button", {
        name: 'Create project "Resistance Training" and select it for this paper',
      }));

    await screen.findByText("1 project selected");
    // Still not persisted — the assignment waits for Save.
    expect(onSave).not.toHaveBeenCalled();

    click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ projectIds: ["proj-new"] })),
    );
  });

  it("cannot start a second creation while one is pending", async () => {
    mockSuggest.mockResolvedValue(FULL);
    let release: (value: Project | null) => void = () => {};
    const onCreateProject = vi.fn(
      () =>
        new Promise<Project | null>((resolve) => {
          release = resolve;
        }),
    );
    renderDialog({ onCreateProject });
    await generate();

    const button = await screen.findByRole("button", {
      name: 'Create project "Resistance Training" and select it for this paper',
    });
    click(button);
    click(button);
    click(button);

    expect(onCreateProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ ...PROJECT_A, id: "proj-new", name: "Resistance Training" });
      await Promise.resolve();
    });
  });

  it("selects nothing when creation fails", async () => {
    mockSuggest.mockResolvedValue(FULL);
    const onSave = vi.fn(async () => true);
    renderDialog({ onCreateProject: vi.fn(async () => null), onSave });
    await generate();

    click(await screen.findByRole("button", {
        name: 'Create project "Resistance Training" and select it for this paper',
      }));

    await waitFor(() => expect(screen.queryByText("1 project selected")).not.toBeInTheDocument());
    click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ projectIds: [] })),
    );
  });

  it("uses the existing Tag mutation for a proposed new Tag", async () => {
    mockSuggest.mockResolvedValue(FULL);
    const createdTag: Tag = { ...TAG_A, id: "tag-new", name: "older-adults" };
    const onCreateTag = vi.fn(async () => createdTag);
    renderDialog({ onCreateTag });
    await generate();

    click(await screen.findByRole("button", {
        name: 'Create tag "older-adults" and select it for this paper',
      }));

    await waitFor(() => expect(onCreateTag).toHaveBeenCalledWith("older-adults"));
    await screen.findByText("1 tag selected");
  });

  it("selects the existing row instead of creating a duplicate on a unique current collision", async () => {
    mockSuggest.mockResolvedValue(FULL);
    // The user created " resistance training " themselves after generation.
    const collided: Project = { ...PROJECT_A, id: "proj-collide", name: " resistance training " };
    const onCreateProject = vi.fn(async () => null);
    const onSave = vi.fn(async () => true);
    renderDialog({ projects: [PROJECT_A, collided], onCreateProject, onSave });
    await generate();

    click(await screen.findByRole("button", {
        name: 'Select existing project " resistance training " for this paper',
      }));

    await waitFor(() => expect(screen.getByText("1 project selected")).toBeInTheDocument());
    expect(onCreateProject).not.toHaveBeenCalled();

    click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ projectIds: ["proj-collide"] }),
      ),
    );
  });

  it("creates nothing and selects nothing on an AMBIGUOUS current collision", async () => {
    mockSuggest.mockResolvedValue(FULL);
    const a: Project = { ...PROJECT_A, id: "collide-1", name: "Resistance Training" };
    const b: Project = { ...PROJECT_A, id: "collide-2", name: " resistance training " };
    const onCreateProject = vi.fn(async () => null);
    const onSave = vi.fn(async () => true);
    renderDialog({ projects: [a, b], onCreateProject, onSave });
    await generate();

    click(await screen.findByRole("button", {
        name: 'Create project "Resistance Training" and select it for this paper',
      }));

    // No creation, no arbitrary tie-break, and the user is told why.
    expect(onCreateProject).not.toHaveBeenCalled();
    // Rendered twice on purpose: once in the sr-only live region and once
    // visibly (aria-hidden), so a screen reader hears it exactly once.
    const notices = await screen.findAllByText(/Several projects are already named/);
    expect(notices.length).toBeGreaterThan(0);

    click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ projectIds: [] })),
    );
  });

  it("states that creation is immediate while assignment waits for Save", async () => {
    mockSuggest.mockResolvedValue(FULL);
    renderDialog();
    await generate();

    await screen.findByText(
      "Creating adds it to your library now; this paper is assigned only when you save.",
    );
  });
});

// ── Quota ──────────────────────────────────────────────────────────────

describe("EditPaperDialog — suggestion quota semantics", () => {
  it("intercepts a known-zero non-exempt click before any request", async () => {
    const onAiQuotaRefresh = vi.fn();
    renderDialog({ quotaStatus: ZERO_QUOTA, onAiQuotaRefresh });

    click(suggestButton());

    expect(mockSuggest).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "AI requests used up", variant: "destructive" }),
    );
    // Nothing was spent, so nothing needs re-reading.
    expect(onAiQuotaRefresh).not.toHaveBeenCalled();
  });

  it("never blocks an exempt user whose commercial remaining reads zero", async () => {
    renderDialog({ quotaStatus: EXEMPT_QUOTA });

    await generate();
    expect(mockSuggest).toHaveBeenCalledTimes(1);
  });

  it("does not block when the quota status is unknown", async () => {
    renderDialog({ quotaStatus: null });

    await generate();
    expect(mockSuggest).toHaveBeenCalledTimes(1);
  });

  it("shows the AI-request allowance message for an authoritative 402", async () => {
    mockSuggest.mockRejectedValue(
      new SuggestOrganizationError("quota_exceeded", "AI quota exceeded.", {
        plan: "free",
        periodType: "lifetime",
        used: 15,
        quota: 15,
        remaining: 0,
        resetAt: null,
        message: "AI quota exceeded.",
      }),
    );
    renderDialog();
    await generate();

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "AI requests used up" }),
      ),
    );
    const description = (mockToast.mock.calls.at(-1)?.[0] as { description?: string }).description;
    expect(description).toContain("AI requests");
    expect(description).not.toContain("AI analyses");
  });

  it("shows neutral wording for a provider failure — never a plan wall", async () => {
    mockSuggest.mockRejectedValue(
      new SuggestOrganizationError(
        "provider_failure",
        "Suggestions are temporarily unavailable. Please try again later.",
      ),
    );
    renderDialog();
    await generate();

    const error = await screen.findByTestId("ai-organization-error");
    expect(error).toHaveTextContent("Suggestions are temporarily unavailable.");
    expect(error).not.toHaveTextContent(/used up|quota|allowance/i);
    // Emphatically not the quota toast.
    const titles = mockToast.mock.calls.map((c) => (c[0] as { title?: string }).title);
    expect(titles).not.toContain("AI requests used up");
  });

  it("refreshes the shared quota after an actual attempt (success)", async () => {
    const onAiQuotaRefresh = vi.fn();
    mockSuggest.mockResolvedValue(FULL);
    renderDialog({ onAiQuotaRefresh });
    await generate();

    await waitFor(() => expect(onAiQuotaRefresh).toHaveBeenCalledTimes(1));
  });

  it("refreshes the shared quota after a provider failure too (a refund may have happened)", async () => {
    const onAiQuotaRefresh = vi.fn();
    mockSuggest.mockRejectedValue(
      new SuggestOrganizationError("provider_failure", "Suggestions are temporarily unavailable."),
    );
    renderDialog({ onAiQuotaRefresh });
    await generate();

    await waitFor(() => expect(onAiQuotaRefresh).toHaveBeenCalledTimes(1));
  });

  it("does not refresh when the click was intercepted for ineligibility", async () => {
    const onAiQuotaRefresh = vi.fn();
    renderDialog({ paper: TITLE_ONLY, onAiQuotaRefresh });

    click(suggestButton());
    expect(mockSuggest).not.toHaveBeenCalled();
    expect(onAiQuotaRefresh).not.toHaveBeenCalled();
  });
});

// ── Staleness and concurrency ──────────────────────────────────────────

describe("EditPaperDialog — staleness and concurrency", () => {
  it("ignores a response that arrives after the paper changed", async () => {
    let release: (value: OrganizationSuggestions) => void = () => {};
    mockSuggest.mockReturnValue(
      new Promise<OrganizationSuggestions>((resolve) => {
        release = resolve;
      }),
    );

    const { rerenderWith } = renderDialog();
    click(suggestButton());
    await waitFor(() => expect(mockSuggest).toHaveBeenCalled());

    // A different paper is opened before the response lands.
    rerenderWith({ paper: makePaper({ id: "paper-2", title: "Another paper" }) });
    release(FULL);

    await waitFor(() => expect(screen.getByTestId("ai-organization-suggestions")).toBeInTheDocument());
    expect(screen.queryByText("Matches the cohort.")).not.toBeInTheDocument();
  });

  it("ignores a response that arrives after the dialog was closed", async () => {
    let release: (value: OrganizationSuggestions) => void = () => {};
    mockSuggest.mockReturnValue(
      new Promise<OrganizationSuggestions>((resolve) => {
        release = resolve;
      }),
    );

    const { unmount } = renderDialog();
    click(suggestButton());
    await waitFor(() => expect(mockSuggest).toHaveBeenCalled());

    // Closing Edit Paper unmounts the surface (Radix removes closed content).
    unmount();
    await act(async () => {
      release(FULL);
      await Promise.resolve();
    });

    // Nothing rendered, and no state update on an unmounted tree.
    expect(screen.queryByText("Matches the cohort.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ai-organization-suggestions")).not.toBeInTheDocument();
  });

  it("resets suggestion state when the dialog switches papers", async () => {
    mockSuggest.mockResolvedValue(FULL);
    const { rerenderWith } = renderDialog();
    await generate();
    await screen.findByText("Matches the cohort.");

    rerenderWith({ paper: makePaper({ id: "paper-2", title: "Another paper" }) });

    await waitFor(() => expect(screen.queryByText("Matches the cohort.")).not.toBeInTheDocument());
    // Back to the un-generated state, not an error state.
    expect(screen.getByRole("button", { name: /Suggest Projects & Tags/ })).toBeInTheDocument();
    expect(screen.queryByTestId("ai-organization-error")).not.toBeInTheDocument();
  });

  it("does not render a response generated for a since-edited draft", async () => {
    let release: (value: OrganizationSuggestions) => void = () => {};
    mockSuggest.mockReturnValue(
      new Promise<OrganizationSuggestions>((resolve) => {
        release = resolve;
      }),
    );

    renderDialog();
    click(suggestButton());
    await waitFor(() => expect(mockSuggest).toHaveBeenCalled());

    // The user keeps editing while Gemini thinks.
    appendField("Title", " — revised");
    release(FULL);

    await waitFor(() => expect(suggestButton()).toBeEnabled());
    expect(screen.queryByText("Matches the cohort.")).not.toBeInTheDocument();
  });

  it("marks an on-screen result set stale when the draft changes afterwards", async () => {
    mockSuggest.mockResolvedValue(FULL);
    renderDialog();
    await generate();
    await screen.findByText("Matches the cohort.");

    appendField("Study Type", "Cohort");

    const stale = await screen.findByTestId("ai-organization-stale");
    expect(stale).toBeInTheDocument();
    // Nothing further may be accepted until the user regenerates.
    expect(
      screen.getByRole("button", { name: 'Select project "Sarcopenia" for this paper' }),
    ).toBeDisabled();
    // But regenerating is still offered.
    expect(suggestButton()).toBeEnabled();
  });

  it("keeps an already-accepted selection when the result set goes stale", async () => {
    mockSuggest.mockResolvedValue(FULL);
    const onSave = vi.fn(async () => true);
    renderDialog({ onSave });
    await generate();

    click(await screen.findByRole("button", { name: 'Select project "Sarcopenia" for this paper' }));
    appendField("Study Type", "Cohort");
    await screen.findByTestId("ai-organization-stale");

    click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ projectIds: [PROJECT_A.id] }),
      ),
    );
  });

  it("lets only the newest of two overlapping generations commit", async () => {
    const releases: Array<(value: OrganizationSuggestions) => void> = [];
    mockSuggest.mockImplementation(
      () => new Promise<OrganizationSuggestions>((resolve) => releases.push(resolve)),
    );

    renderDialog();
    click(suggestButton());
    await waitFor(() => expect(mockSuggest).toHaveBeenCalledTimes(1));

    // Editing the draft frees the button (the in-flight request is now for an
    // older draft) — start a second generation.
    appendField("Study Type", "Cohort");
    // The first request is still in flight, so the button stays disabled until
    // it settles; release it first and prove its result is discarded.
    releases[0](FULL);
    await waitFor(() => expect(suggestButton()).toBeEnabled());
    expect(screen.queryByText("Matches the cohort.")).not.toBeInTheDocument();

    click(suggestButton());
    await waitFor(() => expect(mockSuggest).toHaveBeenCalledTimes(2));
    releases[1](
      suggestions({
        existingTags: [{ id: TAG_A.id, name: TAG_A.name, reason: "The newer answer." }],
      }),
    );

    await screen.findByText("The newer answer.");
    expect(screen.queryByText("Matches the cohort.")).not.toBeInTheDocument();
  });
});

// ── The Analyze path keeps working, with coherent quota UX ─────────────

describe("EditPaperDialog — AI Analyze coherence (§11)", () => {
  it("still smart-merges: a specific PubMed study type survives a generic AI guess", async () => {
    mockInvoke.mockResolvedValue({
      data: {
        studyType: "Study",
        statisticalMethods: "ANOVA",
        tldr: "Short summary.",
      },
      error: null,
    });
    renderDialog({ paper: makePaper({ study_type: "Randomized Controlled Trial" }) });

    click(screen.getByRole("button", { name: /AI Analyze/ }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalled());

    await waitFor(() =>
      expect(screen.getByLabelText("Study Type")).toHaveValue("Randomized Controlled Trial"),
    );
    expect(screen.getByLabelText("Statistical Methods")).toHaveValue("ANOVA");
    expect(screen.getByLabelText("TL;DR")).toHaveValue("Short summary.");
  });

  it("intercepts a known-zero non-exempt Analyze click before invoking", async () => {
    const onAiQuotaRefresh = vi.fn();
    renderDialog({ quotaStatus: ZERO_QUOTA, onAiQuotaRefresh });

    click(screen.getByRole("button", { name: /AI Analyze/ }));

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "AI requests used up" }),
    );
    expect(onAiQuotaRefresh).not.toHaveBeenCalled();
  });

  it("does not intercept an exempt user's Analyze click", async () => {
    mockInvoke.mockResolvedValue({ data: { tldr: "x" }, error: null });
    renderDialog({ quotaStatus: EXEMPT_QUOTA });

    click(screen.getByRole("button", { name: /AI Analyze/ }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
  });

  it("parses an authoritative 402 from Analyze into the AI-request wall", async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
        context: new Response(
          JSON.stringify({
            error: "quota_exceeded",
            message: "AI quota exceeded.",
            details: {
              plan: "free",
              period_type: "lifetime",
              used: 15,
              quota: 15,
              remaining: 0,
              reset_at: null,
            },
          }),
          { status: 402 },
        ),
      }),
    });
    renderDialog();

    click(screen.getByRole("button", { name: /AI Analyze/ }));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "AI requests used up" }),
      ),
    );
  });

  it("keeps an Analyze provider failure distinct from quota exhaustion", async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
        context: new Response(
          JSON.stringify({
            error: "analysis_unavailable",
            code: "provider_rate_limit",
            message: "AI analysis is temporarily unavailable. Please try again later.",
          }),
          { status: 500 },
        ),
      }),
    });
    renderDialog();

    click(screen.getByRole("button", { name: /AI Analyze/ }));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "AI analysis unavailable" }),
      ),
    );
    const titles = mockToast.mock.calls.map((c) => (c[0] as { title?: string }).title);
    expect(titles).not.toContain("AI requests used up");
  });

  it("refreshes the shared quota after an actual Analyze invocation", async () => {
    const onAiQuotaRefresh = vi.fn();
    mockInvoke.mockResolvedValue({ data: { tldr: "x" }, error: null });
    renderDialog({ onAiQuotaRefresh });

    click(screen.getByRole("button", { name: /AI Analyze/ }));
    await waitFor(() => expect(onAiQuotaRefresh).toHaveBeenCalledTimes(1));
  });

  it("organization suggestions never overwrite study type, methods, TLDR, abstract or keywords", async () => {
    mockSuggest.mockResolvedValue(FULL);
    renderDialog({
      paper: makePaper({
        study_type: "Randomized Controlled Trial",
        statistical_methods: "ANOVA",
        tldr: "Existing summary",
      }),
    });

    const before = {
      studyType: (screen.getByLabelText("Study Type") as HTMLInputElement).value,
      methods: (screen.getByLabelText("Statistical Methods") as HTMLInputElement).value,
      tldr: (screen.getByLabelText("TL;DR") as HTMLInputElement).value,
      abstract: (screen.getByLabelText("Abstract") as HTMLTextAreaElement).value,
      keywords: (screen.getByLabelText("Keywords (comma-separated)") as HTMLInputElement).value,
    };

    await generate();
    await screen.findByText("Matches the cohort.");
    click(screen.getByRole("button", { name: 'Select project "Sarcopenia" for this paper' }));

    expect((screen.getByLabelText("Study Type") as HTMLInputElement).value).toBe(before.studyType);
    expect((screen.getByLabelText("Statistical Methods") as HTMLInputElement).value).toBe(before.methods);
    expect((screen.getByLabelText("TL;DR") as HTMLInputElement).value).toBe(before.tldr);
    expect((screen.getByLabelText("Abstract") as HTMLTextAreaElement).value).toBe(before.abstract);
    expect((screen.getByLabelText("Keywords (comma-separated)") as HTMLInputElement).value).toBe(
      before.keywords,
    );
  });
});

// ── Placement and accessibility ────────────────────────────────────────

describe("EditPaperDialog — placement and accessibility", () => {
  it("lives inside the dialog's single scroll owner and adds no second one", () => {
    renderDialog();
    const scroller = screen.getByTestId("edit-paper-scroll");
    const section = screen.getByTestId("ai-organization-suggestions");

    expect(scroller).toContainElement(section);
    expect(section.className).not.toMatch(/overflow-y-auto|overflow-auto|max-h-/);
  });

  it("exposes a live region and real buttons with meaningful names", async () => {
    mockSuggest.mockResolvedValue(FULL);
    renderDialog();

    const section = screen.getByTestId("ai-organization-suggestions");
    expect(within(section).getByRole("status")).toBeInTheDocument();

    await generate();
    const select = await screen.findByRole("button", {
      name: 'Select project "Sarcopenia" for this paper',
    });
    expect(select.tagName).toBe("BUTTON");
    expect(select).toHaveAttribute("type", "button");
  });

  it("announces the outcome without relying on color alone", async () => {
    mockSuggest.mockResolvedValue(suggestions());
    renderDialog();
    await generate();

    const status = within(screen.getByTestId("ai-organization-suggestions")).getByRole("status");
    await waitFor(() =>
      expect(status).toHaveTextContent("No strong Project or Tag suggestions for this paper."),
    );
  });

  it("states the cost and the staging semantics up front", () => {
    renderDialog();
    expect(
      screen.getByText(
        "Uses 1 AI request. Suggestions are optional and nothing is assigned until you save.",
      ),
    ).toBeInTheDocument();
  });
});
