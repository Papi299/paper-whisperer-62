import { useState } from "react";
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { Project } from "@/types/database";

/**
 * PAPERLUME-SIDEBAR-UX-BRAND-001 — each taxonomy row is ONE button.
 *
 * Before this change every row was a static icon/label/count followed by a
 * separate icon-only gear button that carried the destination-specific name
 * (PFA-C09). The row itself is now that button, so this suite pins:
 *
 *  - the six rows keep their exact PFA-C09 accessible names, and are each a
 *    single native button with nothing interactive nested inside;
 *  - no gear buttons survive (the one real Settings row is untouched);
 *  - each row opens its own modal, and on a narrow screen it still closes the
 *    drawer first and opens the modal only afterwards;
 *  - the count, hidden from the name by `aria-label`, is the row's description;
 *  - the brand row shows the canonical PaperLume mark, decoratively.
 *
 * Keyboard activation (Tab/Enter/Space), geometry and focus visibility are
 * browser properties and are covered in `e2e/responsive-accessibility.spec.ts`.
 */

const { mockUseAuth, mockUseIsMobile, mockUsePools } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseIsMobile: vi.fn(),
  mockUsePools: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: mockUseAuth }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: mockUseIsMobile }));
vi.mock("@/hooks/useAccountExport", () => ({
  useAccountExport: () => ({ exportAccountData: vi.fn(), isExporting: false, progress: null, canExport: true }),
}));
vi.mock("@/hooks/useAccountDeletion", () => ({
  useAccountDeletion: () => ({ deleteAccount: vi.fn(), isDeleting: false, canDelete: true }),
}));
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    settings: { pubmedApiKey: null },
    loading: false,
    setPubmedApiKey: vi.fn(),
    clearPubmedApiKey: vi.fn(),
  }),
}));
vi.mock("@/hooks/useStorageUsage", () => ({
  useStorageUsage: () => ({ status: null, isLoading: false, isError: true, refetch: vi.fn() }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/contexts/PoolsContext", () => ({ usePools: mockUsePools }));

import canonicalSymbolUrl from "../../../../assets/brand/svg/paperlume-symbol.svg?no-inline";
import { Sidebar } from "../Sidebar";

/** Row → accessible name → the modal it opens, in rail order. */
const ROWS = [
  { label: "Projects", name: "Manage projects", dialog: "Manage Projects" },
  { label: "Tags", name: "Manage tags", dialog: "Manage Tags" },
  { label: "Keyword Pool", name: "Manage keyword pool", dialog: "Manage Keyword Pool" },
  { label: "Study Type Pool", name: "Manage study type pool", dialog: "Manage Study Type Pool" },
  { label: "Synonyms", name: "Manage synonyms", dialog: "Manage Synonyms" },
  { label: "Exclusions", name: "Manage exclusions", dialog: "Manage Exclusion Pools" },
];

const EMAIL = "researcher@example.com";
const ACCOUNT_TRIGGER = `Account menu for ${EMAIL}`;
const INTERACTIVE = "button, a, input, select, textarea, [tabindex], [role='button']";

beforeAll(() => {
  // Radix's popper/focus machinery needs these; jsdom implements none of them.
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

function poolsStub() {
  return {
    poolKeywords: [],
    addKeyword: vi.fn(),
    addMultipleKeywords: vi.fn(),
    deleteKeyword: vi.fn(),
    deleteAllKeywords: vi.fn(),
    synonymGroups: [],
    addSynonymGroup: vi.fn(),
    updateSynonymGroup: vi.fn(),
    deleteSynonymGroup: vi.fn(),
    excludedKeywords: [],
    excludedStudyTypes: [],
    addExcludedKeyword: vi.fn(),
    deleteExcludedKeyword: vi.fn(),
    clearExcludedKeywords: vi.fn(),
    addExcludedStudyType: vi.fn(),
    deleteExcludedStudyType: vi.fn(),
    clearExcludedStudyTypes: vi.fn(),
    poolStudyTypes: [],
    addStudyType: vi.fn(),
    addMultipleStudyTypes: vi.fn(),
    updateStudyType: vi.fn(),
    renameGroup: vi.fn(),
    deleteGroup: vi.fn(),
  };
}

function project(n: number): Project {
  return {
    id: `project-${n}`,
    user_id: "user-1",
    name: `Project ${n}`,
    description: null,
    color: "#000000",
    created_at: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseAuth.mockReturnValue({ user: { id: "user-1", email: EMAIL }, signOut: vi.fn() });
  mockUseIsMobile.mockReturnValue(false);
  mockUsePools.mockReturnValue(poolsStub());
});

/**
 * Hosts the sidebar the way Dashboard does — owning the narrow-screen drawer
 * flag, behind a stand-in for the header trigger the drawer hands focus back to.
 */
function SidebarHost({
  projects = [],
  onNavOpenChange,
}: {
  projects?: Project[];
  onNavOpenChange?: (open: boolean) => void;
}) {
  const [navOpen, setNavOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="Open navigation menu"
        onClick={() => {
          onNavOpenChange?.(true);
          setNavOpen(true);
        }}
      >
        Menu
      </button>
      <Sidebar
        projects={projects}
        tags={[]}
        onCreateProject={vi.fn()}
        onCreateTag={vi.fn()}
        onEditProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onEditTag={vi.fn()}
        onDeleteTag={vi.fn()}
        availableKeywords={[]}
        availableStudyTypes={[]}
        onDeletePoolStudyType={vi.fn()}
        onDeleteAllPoolStudyTypes={vi.fn()}
        mobileNavOpen={navOpen}
        onMobileNavOpenChange={(open) => {
          onNavOpenChange?.(open);
          setNavOpen(open);
        }}
      />
    </>
  );
}

function renderSidebar(props: Parameters<typeof SidebarHost>[0] = {}) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <SidebarHost {...props} />
    </MemoryRouter>,
  );
}

const rail = () => screen.getByRole("complementary");

describe("taxonomy rows", () => {
  it("are each one native button, named for its destination", () => {
    renderSidebar();

    for (const { label, name } of ROWS) {
      const row = within(rail()).getByRole("button", { name });
      expect(row.tagName).toBe("BUTTON");
      // The whole row: the visible label is inside the control itself…
      expect(row).toHaveTextContent(label);
      // …and is contained in its accessible name, so speech input can say
      // what it sees (WCAG 2.5.3).
      expect(name.toLowerCase()).toContain(label.toLowerCase());
      expect(row.querySelectorAll(INTERACTIVE)).toHaveLength(0);
    }
  });

  it("leave no separate gear buttons behind", () => {
    renderSidebar();

    const names = within(rail())
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim());
    expect(names).toEqual([...ROWS.map((row) => row.name), "Settings", ACCOUNT_TRIGGER]);

    // The one gear left is the real Settings destination's own icon.
    const gears = rail().querySelectorAll(".lucide-settings");
    expect(gears).toHaveLength(1);
    expect(within(rail()).getByRole("button", { name: "Settings" }).contains(gears[0])).toBe(true);
  });

  it.each(ROWS)("$label opens $dialog", async ({ name, dialog }) => {
    renderSidebar();

    fireEvent.click(within(rail()).getByRole("button", { name }));

    expect(await screen.findByRole("dialog", { name: dialog })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("carries the count as the row's description, not its name", () => {
    renderSidebar({ projects: [project(1), project(2), project(3)] });

    const projects = within(rail()).getByRole("button", { name: "Manage projects" });
    expect(projects).toHaveAccessibleName("Manage projects");
    expect(projects).toHaveAccessibleDescription("3");
  });

  it("keeps the existing zero-count behaviour", () => {
    renderSidebar();

    // A zero count is hidden on every row except Synonyms (`alwaysShowCount`),
    // exactly as before — and a hidden count describes nothing.
    for (const { name } of ROWS) {
      const row = within(rail()).getByRole("button", { name });
      if (name === "Manage synonyms") {
        expect(row).toHaveAccessibleDescription("0");
      } else {
        expect(row).not.toHaveAttribute("aria-describedby");
        expect(row).toHaveTextContent(/^[^0-9]+$/);
      }
    }
  });
});

describe("narrow-screen drawer → taxonomy row", () => {
  it("closes the drawer before opening the modal, and focus comes home", async () => {
    mockUseIsMobile.mockReturnValue(true);
    // Sampled whenever a modal layer changes hands: 2 would mean the drawer
    // and the Projects dialog were mounted together (stacked focus traps).
    const openDialogs: number[] = [];
    const sample = () => openDialogs.push(document.querySelectorAll('[role="dialog"]').length);
    renderSidebar({ onNavOpenChange: vi.fn(sample) });

    const navTrigger = screen.getByRole("button", { name: "Open navigation menu" });
    navTrigger.focus();
    fireEvent.click(navTrigger);
    const drawer = await screen.findByRole("dialog", { name: /PaperLume navigation/i });

    fireEvent.click(within(drawer).getByRole("button", { name: "Manage projects" }));
    sample();

    const projects = await screen.findByRole("dialog", { name: "Manage Projects" });
    sample();
    expect(screen.queryByRole("dialog", { name: /PaperLume navigation/i })).toBeNull();
    expect(Math.max(...openDialogs)).toBeLessThanOrEqual(1);

    // The dialog recorded the header trigger as its opener — only possible if
    // it mounted after the drawer had closed and restored focus.
    fireEvent.click(within(projects).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(navTrigger));
  });
});

describe("brand row", () => {
  it("shows the canonical PaperLume mark beside the name, decoratively", () => {
    renderSidebar();

    const marks = Array.from(rail().querySelectorAll("img")).filter(
      (img) => img.getAttribute("src") === canonicalSymbolUrl,
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveAttribute("alt", "");
    expect(within(rail()).queryByRole("img")).toBeNull();
    expect(within(rail()).getByText("PaperLume", { exact: true })).toBeInTheDocument();
    expect(rail().querySelector(".lucide-book-open")).toBeNull();
  });
});
