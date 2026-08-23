import { test, expect, type Page, type Route } from "@playwright/test";
import {
  waitForDashboard,
  createProject,
  createTag,
  deleteProject,
  deleteTag,
  openEditPaperDialog,
} from "./helpers";

/**
 * AI-PROJECT-TAG-SUGGESTIONS-001B — the integrated Edit Paper experience,
 * end to end in a real browser against the local Supabase stack.
 *
 * ## No AI is called
 *
 * The browser's request to `/functions/v1/suggest-paper-organization` is
 * fulfilled by Playwright with deterministic contract data, so no Edge Function
 * runs, no Gemini request is made and no AI quota is spent — locally or
 * anywhere else. The spec also fails if the page reaches a Google host at all.
 *
 * ## What it proves that the unit tests cannot
 *
 *   - the **unsaved** draft really is what leaves the browser (asserted on the
 *     intercepted request body, not on a mocked function's arguments);
 *   - accepting an existing suggestion truly does not reach the database —
 *     proven by cancelling and reopening the dialog, which is the only way to
 *     see what was actually persisted;
 *   - an explicitly created Project/Tag really does survive that cancellation,
 *     because creation is immediate while the paper assignment is not;
 *   - Save Changes persists exactly the accepted assignments through the real
 *     `set_paper_projects` / `set_paper_tags` path.
 *
 * ## State
 *
 * Mutating, but only within fixtures it owns: two disposable Projects and two
 * disposable Tags (one pair created through the management modals, one pair
 * created by the feature under test), all removed in `afterAll`. Deleting them
 * cascades the junction rows away, so the paper's assignments are restored with
 * them. The one seeded paper it edits is the designated disposable
 * highest-order record, and the only field it touches — Study Type — is
 * reverted to its seeded empty value before the save. Order-independent.
 */

const SUGGEST_FUNCTION_PATH = "/functions/v1/suggest-paper-organization";

/** The designated disposable seed record: always the newest row, so always visible. */
const PAPER_TITLE = "E2E Primary Paper 120 — Disposable Highest-Order";

const STAMP = Date.now();
/** Pre-existing taxonomy the suggestions will recommend. */
const EXISTING_PROJECT = `_e2e_aiorg_proj_${STAMP}`;
const EXISTING_TAG = `_e2e_aiorg_tag_${STAMP}`;
/** Proposed-new taxonomy the user creates through the feature itself. */
const PROPOSED_TAG = `_e2e_aiorg_newtag_${STAMP}`;
const PROPOSED_PROJECT = `_e2e_aiorg_newproj_${STAMP}`;

/** An unsaved Study Type value that exists nowhere in the seed. */
const UNSAVED_STUDY_TYPE = `_e2e_unsaved_study_type_${STAMP}`;

/**
 * CORS headers for the stand-in response. The app (loopback Vite) and the local
 * Supabase API are different origins, so a fulfilled cross-origin response
 * still has to satisfy the browser's CORS check. Local test scaffolding, not a
 * copy of a production policy.
 */
const STAND_IN_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Hosts the browser must never reach during this spec. */
const PROVIDER_HOSTS = ["generativelanguage.googleapis.com", "googleapis.com", "google.com"];

/** One recorded invocation of the suggestion endpoint. */
interface SuggestInvocation {
  bodyKeys: string[];
  draftKeys: string[];
  paperId: string;
  title: string;
  abstract: string | null;
  keywords: string[];
  studyType: string | null;
  currentProjectIds: string[];
  currentTagIds: string[];
  /** Only the SHAPE of the credential is recorded — never the token value. */
  authorizationIsBearer: boolean;
  /** The raw body, so forbidden-field assertions can look at everything sent. */
  rawBody: string;
}

interface Recorder {
  invocations: SuggestInvocation[];
  providerRequests: string[];
  /** Real taxonomy ids, read from the app's own PostgREST reads. */
  projectIds: Map<string, string>;
  tagIds: Map<string, string>;
}

function newRecorder(): Recorder {
  return {
    invocations: [],
    providerRequests: [],
    projectIds: new Map(),
    tagIds: new Map(),
  };
}

async function openDashboard(page: Page) {
  await page.goto("/", { waitUntil: "networkidle" });
  await waitForDashboard(page);
}

/**
 * Learn the real `projects.id` / `tags.id` values by reading the app's own
 * metadata queries as they fly past.
 *
 * The alternative — querying PostgREST directly from the test — would need the
 * anon key and the user's token handled outside the browser. Observing the
 * reads the app already performs needs neither, and it keeps the spec honest:
 * these are exactly the ids the UI is holding.
 */
function watchTaxonomyIds(page: Page, recorder: Recorder) {
  page.on("response", (response) => {
    const url = response.url();
    const isProjects = url.includes("/rest/v1/projects");
    const isTags = url.includes("/rest/v1/tags");
    if (!isProjects && !isTags) return;
    if (!response.ok()) return;

    void response
      .json()
      .then((body: unknown) => {
        if (!Array.isArray(body)) return;
        const target = isProjects ? recorder.projectIds : recorder.tagIds;
        for (const row of body) {
          if (
            row &&
            typeof row === "object" &&
            typeof (row as { id?: unknown }).id === "string" &&
            typeof (row as { name?: unknown }).name === "string"
          ) {
            target.set((row as { name: string }).name, (row as { id: string }).id);
          }
        }
      })
      .catch(() => {
        /* A body that is not JSON is not a taxonomy read. */
      });
  });
}

function watchProviderHosts(page: Page, recorder: Recorder) {
  page.on("request", (request) => {
    let hostname: string;
    try {
      hostname = new URL(request.url()).hostname;
    } catch {
      return; // data:/blob: carry no host to check
    }
    if (PROVIDER_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
      recorder.providerRequests.push(request.url());
    }
  });
}

/** What the stand-in endpoint should answer with for one test. */
interface StandInSuggestions {
  existingProjects?: Array<{ id: string; name: string; reason: string }>;
  existingTags?: Array<{ id: string; name: string; reason: string }>;
  newProjects?: Array<{ name: string; description: string | null; reason: string }>;
  newTags?: Array<{ name: string; reason: string }>;
}

/**
 * Fulfil `suggest-paper-organization` deterministically.
 *
 * `build` is called per request so a test can answer using values it only
 * learns from the request itself.
 */
async function routeSuggestions(
  page: Page,
  recorder: Recorder,
  build: (invocation: SuggestInvocation) => StandInSuggestions,
) {
  await page.route(
    (url) => url.pathname === SUGGEST_FUNCTION_PATH,
    async (route: Route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: STAND_IN_CORS_HEADERS, body: "" });
        return;
      }

      const raw = request.postData() ?? "{}";
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      const draft = (body.draft ?? {}) as Record<string, unknown>;

      const invocation: SuggestInvocation = {
        bodyKeys: Object.keys(body).sort(),
        draftKeys: Object.keys(draft).sort(),
        paperId: String(body.paperId ?? ""),
        title: String(draft.title ?? ""),
        abstract: typeof draft.abstract === "string" ? draft.abstract : null,
        keywords: Array.isArray(draft.keywords) ? (draft.keywords as string[]) : [],
        studyType: typeof draft.studyType === "string" ? draft.studyType : null,
        currentProjectIds: Array.isArray(body.currentProjectIds)
          ? (body.currentProjectIds as string[])
          : [],
        currentTagIds: Array.isArray(body.currentTagIds) ? (body.currentTagIds as string[]) : [],
        authorizationIsBearer: /^Bearer \S+$/.test(request.headers()["authorization"] ?? ""),
        rawBody: raw,
      };
      recorder.invocations.push(invocation);

      const answer = build(invocation);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: STAND_IN_CORS_HEADERS,
        body: JSON.stringify({
          existingProjects: answer.existingProjects ?? [],
          existingTags: answer.existingTags ?? [],
          newProjects: answer.newProjects ?? [],
          newTags: answer.newTags ?? [],
        }),
      });
    },
  );
}

const suggestionSection = (page: Page) => page.getByTestId("ai-organization-suggestions");

/** Set a controlled field to an exact value. */
async function setField(page: Page, label: string, value: string) {
  await page.getByRole("dialog").getByLabel(label, { exact: true }).fill(value);
}

async function generateSuggestions(page: Page, recorder: Recorder) {
  const before = recorder.invocations.length;
  await suggestionSection(page)
    .getByRole("button", { name: /Suggest Projects & Tags|Suggest again/ })
    .click();
  await expect
    .poll(() => recorder.invocations.length, { timeout: 15_000 })
    .toBeGreaterThan(before);
}

/** The Projects selector's summary text ("2 projects selected" / "Select projects..."). */
const projectsTrigger = (page: Page) =>
  page.getByRole("dialog").getByRole("button", { name: /projects? selected|Select projects/ });
const tagsTrigger = (page: Page) =>
  page.getByRole("dialog").getByRole("button", { name: /tags? selected|Select tags/ });

async function closeDialogWithCancel(page: Page) {
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}

async function saveDialog(page: Page) {
  await page.getByRole("dialog").getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 15_000 });
}

// ══════════════════════════════════════════════════════════════════════════

test.describe("AI organization suggestions in Edit Paper", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: "e2e/.auth/user.json" });
    const page = await context.newPage();
    try {
      await openDashboard(page);
      // Tolerate residue from a previous `E2E_KEEP_LOCAL_STACK=1` debug run.
      await deleteProject(page, EXISTING_PROJECT);
      await deleteProject(page, PROPOSED_PROJECT);
      await deleteTag(page, EXISTING_TAG);
      await deleteTag(page, PROPOSED_TAG);
      await createProject(page, EXISTING_PROJECT);
      await createTag(page, EXISTING_TAG);
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: "e2e/.auth/user.json" });
    const page = await context.newPage();
    try {
      await openDashboard(page);
      // Deleting the taxonomy cascades `paper_projects` / `paper_tags` away, so
      // the seeded paper's assignments are restored along with it.
      await deleteProject(page, EXISTING_PROJECT);
      await deleteProject(page, PROPOSED_PROJECT);
      await deleteTag(page, EXISTING_TAG);
      await deleteTag(page, PROPOSED_TAG);
    } finally {
      await context.close();
    }
  });

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  });

  test("sends the unsaved draft, stages acceptance locally, and keeps an explicitly created Tag on cancel", async ({
    page,
  }) => {
    const recorder = newRecorder();
    watchTaxonomyIds(page, recorder);
    watchProviderHosts(page, recorder);

    await openDashboard(page);
    await expect
      .poll(() => recorder.projectIds.get(EXISTING_PROJECT), { timeout: 20_000 })
      .toBeTruthy();
    await expect.poll(() => recorder.tagIds.get(EXISTING_TAG), { timeout: 20_000 }).toBeTruthy();

    const projectId = recorder.projectIds.get(EXISTING_PROJECT)!;
    const tagId = recorder.tagIds.get(EXISTING_TAG)!;

    await routeSuggestions(page, recorder, () => ({
      existingProjects: [
        { id: projectId, name: EXISTING_PROJECT, reason: "Matches the fixture cohort." },
      ],
      existingTags: [{ id: tagId, name: EXISTING_TAG, reason: "Matches the fixture design." }],
      newTags: [{ name: PROPOSED_TAG, reason: "A concept the library does not cover yet." }],
    }));

    await openEditPaperDialog(page, PAPER_TITLE);
    await expect(suggestionSection(page)).toBeVisible();

    // ── The draft is changed but NOT saved ──────────────────────────────
    await setField(page, "Study Type", UNSAVED_STUDY_TYPE);

    await generateSuggestions(page, recorder);

    // ── The intercepted request carries the unsaved values ──────────────
    expect(recorder.invocations).toHaveLength(1);
    const invocation = recorder.invocations[0];
    expect(invocation.studyType).toBe(UNSAVED_STUDY_TYPE);
    expect(invocation.title).toBe(PAPER_TITLE);
    expect(invocation.abstract ?? "").toContain("Deterministic abstract");
    expect(invocation.keywords.length).toBeGreaterThan(0);
    expect(invocation.authorizationIsBearer).toBe(true);

    // ── …and nothing else ───────────────────────────────────────────────
    expect(invocation.bodyKeys).toEqual([
      "currentProjectIds",
      "currentTagIds",
      "draft",
      "paperId",
    ]);
    expect(invocation.draftKeys).toEqual(["abstract", "keywords", "studyType", "title"]);
    for (const forbidden of [
      "authors",
      "journal",
      "notes",
      "tldr",
      "statisticalMethods",
      "pmid",
      "doi",
      "pubmedUrl",
      "driveUrl",
      "user_id",
      "userId",
      "email",
      "quota",
    ]) {
      expect(invocation.rawBody).not.toContain(`"${forbidden}"`);
    }
    // The seeded note text must not have travelled inside any field either.
    expect(invocation.rawBody).not.toContain("Deterministic note");

    // ── Results render with their reasons ───────────────────────────────
    const section = suggestionSection(page);
    await expect(section.getByText("Matches the fixture cohort.")).toBeVisible();
    await expect(section.getByText("Matches the fixture design.")).toBeVisible();
    await expect(section.getByText("A concept the library does not cover yet.")).toBeVisible();

    // ── Accept an existing Project (local only) ─────────────────────────
    await expect(projectsTrigger(page)).toHaveText(/Select projects/);
    await section
      .getByRole("button", { name: `Select project "${EXISTING_PROJECT}" for this paper` })
      .click();
    await expect(projectsTrigger(page)).toHaveText(/1 project selected/);

    // ── Explicitly create a proposed new Tag (immediate creation) ───────
    await section
      .getByRole("button", { name: `Create tag "${PROPOSED_TAG}" and select it for this paper` })
      .click();
    await expect(tagsTrigger(page)).toHaveText(/1 tag selected/);

    // ── Cancel: the paper must be left exactly as it was ────────────────
    await closeDialogWithCancel(page);

    await openEditPaperDialog(page, PAPER_TITLE);
    // The accepted Project was never assigned…
    await expect(projectsTrigger(page)).toHaveText(/Select projects/);
    // …nor was the created Tag attached to this paper…
    await expect(tagsTrigger(page)).toHaveText(/Select tags/);
    // …and the unsaved Study Type is gone, because it was never saved.
    await expect(
      page.getByRole("dialog").getByLabel("Study Type", { exact: true }),
    ).not.toHaveValue(UNSAVED_STUDY_TYPE);

    // …but the Tag the user explicitly created is still in the library.
    await tagsTrigger(page).click();
    await expect(page.getByRole("option", { name: PROPOSED_TAG })).toBeVisible();
    await page.keyboard.press("Escape");

    await closeDialogWithCancel(page);

    expect(recorder.providerRequests).toEqual([]);
  });

  test("Save Changes persists exactly the accepted assignments", async ({ page }) => {
    const recorder = newRecorder();
    watchTaxonomyIds(page, recorder);
    watchProviderHosts(page, recorder);

    await openDashboard(page);
    await expect
      .poll(() => recorder.projectIds.get(EXISTING_PROJECT), { timeout: 20_000 })
      .toBeTruthy();
    await expect.poll(() => recorder.tagIds.get(EXISTING_TAG), { timeout: 20_000 }).toBeTruthy();

    const projectId = recorder.projectIds.get(EXISTING_PROJECT)!;
    const tagId = recorder.tagIds.get(EXISTING_TAG)!;

    await routeSuggestions(page, recorder, () => ({
      existingProjects: [
        { id: projectId, name: EXISTING_PROJECT, reason: "Matches the fixture cohort." },
      ],
      existingTags: [{ id: tagId, name: EXISTING_TAG, reason: "Matches the fixture design." }],
      newProjects: [
        {
          name: PROPOSED_PROJECT,
          description: "Created by the E2E acceptance flow.",
          reason: "A theme the library does not cover yet.",
        },
      ],
    }));

    await openEditPaperDialog(page, PAPER_TITLE);
    const section = suggestionSection(page);

    // Change the draft first, so the request is provably about unsaved text.
    await setField(page, "Study Type", UNSAVED_STUDY_TYPE);
    await generateSuggestions(page, recorder);
    expect(recorder.invocations[0].studyType).toBe(UNSAVED_STUDY_TYPE);

    // Accept one existing Project, one existing Tag, and create one Project.
    await section
      .getByRole("button", { name: `Select project "${EXISTING_PROJECT}" for this paper` })
      .click();
    await section
      .getByRole("button", { name: `Select tag "${EXISTING_TAG}" for this paper` })
      .click();
    await section
      .getByRole("button", {
        name: `Create project "${PROPOSED_PROJECT}" and select it for this paper`,
      })
      .click();

    await expect(projectsTrigger(page)).toHaveText(/2 projects selected/);
    await expect(tagsTrigger(page)).toHaveText(/1 tag selected/);

    // Revert Study Type to its seeded (empty) value before saving, so the only
    // durable change this spec makes is the taxonomy it cleans up. Editing the
    // draft after a result is on screen marks the suggestions stale — and the
    // already-accepted selections must survive that.
    await setField(page, "Study Type", "");
    await expect(page.getByTestId("ai-organization-stale")).toBeVisible();
    await expect(projectsTrigger(page)).toHaveText(/2 projects selected/);
    await expect(tagsTrigger(page)).toHaveText(/1 tag selected/);

    await saveDialog(page);

    // ── Reopen: the assignments are on the row, the Study Type is not ───
    await openEditPaperDialog(page, PAPER_TITLE);
    await expect(projectsTrigger(page)).toHaveText(/2 projects selected/);
    await expect(tagsTrigger(page)).toHaveText(/1 tag selected/);
    await expect(page.getByRole("dialog").getByLabel("Study Type", { exact: true })).toHaveValue("");

    // The saved selection is exactly the two Projects and the one Tag accepted.
    await expect(page.getByRole("dialog").getByText(EXISTING_PROJECT)).toBeVisible();
    await expect(page.getByRole("dialog").getByText(PROPOSED_PROJECT)).toBeVisible();
    await expect(page.getByRole("dialog").getByText(EXISTING_TAG)).toBeVisible();

    await closeDialogWithCancel(page);

    expect(recorder.providerRequests).toEqual([]);
  });

  test("makes no request without an explicit click, and refuses an ineligible draft", async ({
    page,
  }) => {
    const recorder = newRecorder();
    watchProviderHosts(page, recorder);
    await routeSuggestions(page, recorder, () => ({}));

    await openDashboard(page);
    await openEditPaperDialog(page, PAPER_TITLE);

    const section = suggestionSection(page);
    await expect(section).toBeVisible();
    // Opening the dialog, and letting the abstract load, calls nothing.
    await expect(page.getByRole("dialog").getByLabel("Abstract", { exact: true })).toHaveValue(
      /Deterministic abstract/,
    );
    expect(recorder.invocations).toHaveLength(0);

    // Strip every supporting signal: a title alone is not enough evidence, and
    // the client says so instead of spending an AI request to find out.
    await setField(page, "Abstract", "");
    await setField(page, "Keywords (comma-separated)", "");
    await setField(page, "Study Type", "");

    const suggestButton = section.getByRole("button", {
      name: /Suggest Projects & Tags|Suggest again/,
    });
    await expect(suggestButton).toBeDisabled();
    await expect(
      section.getByText("Add an abstract, keywords, or a study type to get useful suggestions."),
    ).toBeVisible();

    // Cancel — none of those field edits may reach the database.
    await closeDialogWithCancel(page);

    await openEditPaperDialog(page, PAPER_TITLE);
    await expect(page.getByRole("dialog").getByLabel("Abstract", { exact: true })).toHaveValue(
      /Deterministic abstract/,
    );
    await closeDialogWithCancel(page);

    expect(recorder.invocations).toHaveLength(0);
    expect(recorder.providerRequests).toEqual([]);
  });
});
