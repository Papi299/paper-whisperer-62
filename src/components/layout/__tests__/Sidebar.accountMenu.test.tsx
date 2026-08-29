import { useState } from "react";
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

/**
 * PAPERLUME-PRIVACY-001C — the Account menu, the Account dialog it opens, and
 * the `/privacy` entry point beside them.
 *
 * The mobile cases here assert the *sequencing* the narrow-screen drawer must
 * keep: the drawer is closed before the dialog opens, and the dialog's focus
 * lands on a connected element. Real focus-trap behaviour across a Sheet →
 * Dialog handoff is a browser property and is covered in
 * `e2e/responsive-accessibility.spec.ts`; this suite pins the contract that
 * makes it possible.
 */

const {
  mockUseAuth,
  mockUseIsMobile,
  mockSignOut,
  mockUseAccountExport,
  mockUseAccountDeletion,
  mockUseSettings,
  mockUseStorageUsage,
  mockUsePools,
} = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseIsMobile: vi.fn(),
  mockSignOut: vi.fn(),
  mockUseAccountExport: vi.fn(),
  mockUseAccountDeletion: vi.fn(),
  mockUseSettings: vi.fn(),
  mockUseStorageUsage: vi.fn(),
  mockUsePools: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: mockUseAuth }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: mockUseIsMobile }));
vi.mock("@/hooks/useAccountExport", () => ({ useAccountExport: mockUseAccountExport }));
vi.mock("@/hooks/useAccountDeletion", () => ({ useAccountDeletion: mockUseAccountDeletion }));
vi.mock("@/hooks/useSettings", () => ({ useSettings: mockUseSettings }));
vi.mock("@/hooks/useStorageUsage", () => ({ useStorageUsage: mockUseStorageUsage }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/contexts/PoolsContext", () => ({ usePools: mockUsePools }));

import { Sidebar } from "../Sidebar";

const EMAIL = "researcher@example.com";
const TRIGGER_NAME = `Account menu for ${EMAIL}`;

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

beforeEach(() => {
  vi.clearAllMocks();
  mockUseAuth.mockReturnValue({ user: { id: "user-1", email: EMAIL }, signOut: mockSignOut });
  mockUseIsMobile.mockReturnValue(false);
  mockUsePools.mockReturnValue(poolsStub());
  mockUseAccountExport.mockReturnValue({
    exportAccountData: vi.fn(),
    isExporting: false,
    progress: null,
    canExport: true,
  });
  mockUseAccountDeletion.mockReturnValue({
    deleteAccount: vi.fn(),
    isDeleting: false,
    canDelete: true,
  });
  mockUseSettings.mockReturnValue({
    settings: { pubmedApiKey: null },
    loading: false,
    setPubmedApiKey: vi.fn(),
    clearPubmedApiKey: vi.fn(),
  });
  mockUseStorageUsage.mockReturnValue({
    status: null,
    isLoading: false,
    isError: true,
    refetch: vi.fn(),
  });
});

/** Reports the current route so navigation can be asserted on. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

/**
 * Hosts the sidebar the way Dashboard does — owning the narrow-screen drawer
 * flag — so a request to close the drawer really closes it and Radix's own
 * close lifecycle runs, rather than being asserted on a spy alone.
 */
function SidebarHost({
  initialNavOpen = false,
  onNavOpenChange,
}: {
  initialNavOpen?: boolean;
  onNavOpenChange?: (open: boolean) => void;
}) {
  const [navOpen, setNavOpen] = useState(initialNavOpen);
  return (
    <>
      {/* Stands in for the Dashboard header trigger: it is the element the
          drawer must hand focus back to, and the one a dialog opened from
          inside the drawer must record as its opener. */}
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
        projects={[]}
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
      <LocationProbe />
    </>
  );
}

function renderSidebar(
  props: { initialNavOpen?: boolean; onNavOpenChange?: (open: boolean) => void } = {},
) {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Routes>
        <Route path="*" element={<SidebarHost {...props} />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Opens the Account menu from the keyboard, the way Radix's trigger expects. */
async function openAccountMenu(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.findByRole("menu");
}

function accountMenuTrigger() {
  return screen.getByRole("button", { name: TRIGGER_NAME });
}

describe("Account menu", () => {
  it("keeps the signed-in email as the visible trigger", () => {
    renderSidebar();

    const trigger = accountMenuTrigger();
    expect(trigger).toHaveTextContent(EMAIL);
    // Radix announces it as a menu button, so the trigger is discoverable as
    // one rather than as a bare label.
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens from the keyboard alone", async () => {
    renderSidebar();
    const trigger = accountMenuTrigger();

    await openAccountMenu(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("contains exactly Account, Privacy Policy and Sign out, in that order", async () => {
    renderSidebar();
    const menu = await openAccountMenu(accountMenuTrigger());

    const items = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent?.trim());
    expect(items).toEqual(["Account", "Privacy Policy", "Sign out"]);
  });

  it("adds none of the legal or support surfaces that do not exist yet", async () => {
    renderSidebar();
    const menu = await openAccountMenu(accountMenuTrigger());

    for (const absent of [/terms/i, /support/i, /cookie/i, /ai disclosure/i]) {
      expect(within(menu).queryByRole("menuitem", { name: absent })).toBeNull();
    }
  });

  it("separates the session-ending item from the two that are not", async () => {
    renderSidebar();
    const menu = await openAccountMenu(accountMenuTrigger());

    const separator = within(menu).getByRole("separator");
    const privacy = within(menu).getByRole("menuitem", { name: "Privacy Policy" });
    const signOut = within(menu).getByRole("menuitem", { name: "Sign out" });

    expect(
      privacy.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      separator.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("exposes no destructive account command directly in the menu", async () => {
    renderSidebar();
    const menu = await openAccountMenu(accountMenuTrigger());

    expect(within(menu).queryByRole("menuitem", { name: /delete/i })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /export/i })).toBeNull();
  });

  it("still signs out", async () => {
    renderSidebar();
    const menu = await openAccountMenu(accountMenuTrigger());

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Sign out" }));

    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});

describe("Account menu → Account dialog", () => {
  it("opens the dedicated Account dialog with both sections", async () => {
    renderSidebar();
    const menu = await openAccountMenu(accountMenuTrigger());

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Account" }));

    const dialog = await screen.findByRole("dialog", { name: "Account" });
    expect(within(dialog).getByRole("heading", { name: "Account data" })).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /export account data/i }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Danger zone" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Delete account" })).toBeInTheDocument();
  });

  it("does not sign the user out or navigate away", async () => {
    renderSidebar();
    const menu = await openAccountMenu(accountMenuTrigger());

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Account" }));
    await screen.findByRole("dialog", { name: "Account" });

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(screen.getByTestId("location")).toHaveTextContent("/dashboard");
  });

  it("wires the export action to the account-export hook", async () => {
    const exportAccountData = vi.fn();
    mockUseAccountExport.mockReturnValue({
      exportAccountData,
      isExporting: false,
      progress: null,
      canExport: true,
    });
    renderSidebar();
    const menu = await openAccountMenu(accountMenuTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Account" }));
    const dialog = await screen.findByRole("dialog", { name: "Account" });

    fireEvent.click(within(dialog).getByRole("button", { name: /export account data/i }));

    expect(exportAccountData).toHaveBeenCalledTimes(1);
    expect(mockUseAccountExport).toHaveBeenLastCalledWith("user-1");
  });

  it("keeps the typed-phrase gate in front of deletion", async () => {
    const deleteAccount = vi.fn();
    mockUseAccountDeletion.mockReturnValue({
      deleteAccount,
      isDeleting: false,
      canDelete: true,
    });
    renderSidebar();
    const menu = await openAccountMenu(accountMenuTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Account" }));
    const dialog = await screen.findByRole("dialog", { name: "Account" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete account" }));

    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByRole("button", { name: "Delete my account" })).toBeDisabled();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("returns focus to the Account menu trigger when the dialog closes", async () => {
    renderSidebar();
    const trigger = accountMenuTrigger();
    const menu = await openAccountMenu(trigger);

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Account" }));
    const dialog = await screen.findByRole("dialog", { name: "Account" });

    // The dialog opened only after the menu had closed and handed focus back,
    // so the opener it recorded is the trigger — still mounted and visible.
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Account" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(accountMenuTrigger()));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.isConnected).toBe(true);
  });
});

describe("Account menu → Privacy Policy", () => {
  it("carries an in-app href rather than the canonical absolute URL", async () => {
    renderSidebar();
    const menu = await openAccountMenu(accountMenuTrigger());

    const item = within(menu).getByRole("menuitem", { name: "Privacy Policy" });
    expect(item.tagName).toBe("A");
    expect(item).toHaveAttribute("href", "/privacy");
    expect(item.getAttribute("href")).not.toMatch(/^https?:/);
  });

  it("navigates to /privacy", async () => {
    renderSidebar();
    const menu = await openAccountMenu(accountMenuTrigger());

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Privacy Policy" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/privacy"));
  });

  it("does not sign the user out or open a dialog", async () => {
    renderSidebar();
    const menu = await openAccountMenu(accountMenuTrigger());

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Privacy Policy" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/privacy"));
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Narrow-screen drawer → Account menu", () => {
  /**
   * Renders the drawer open and keeps `mobileNavOpen` under test control, the
   * way Dashboard owns it, so the close can be observed rather than assumed.
   */
  /**
   * Opens the drawer the way a user does — from the header trigger — so the
   * Sheet records a real opener and focus restoration is actually exercised.
   */
  async function renderDrawer(onNavOpenChange = vi.fn()) {
    mockUseIsMobile.mockReturnValue(true);
    const view = renderSidebar({ onNavOpenChange });
    const navTrigger = screen.getByRole("button", { name: "Open navigation menu" });
    navTrigger.focus();
    fireEvent.click(navTrigger);
    await screen.findByRole("dialog", { name: /PaperLume navigation/i });
    return { onNavOpenChange, navTrigger, view };
  }

  function drawer() {
    return screen.getByRole("dialog", { name: /PaperLume navigation/i });
  }

  it("renders the Account menu inside the drawer", async () => {
    await renderDrawer();

    const trigger = within(drawer()).getByRole("button", { name: TRIGGER_NAME });
    const menu = await openAccountMenu(trigger);

    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent?.trim()),
    ).toEqual(["Account", "Privacy Policy", "Sign out"]);
  });

  it("hands the drawer off to the Account dialog without stacking focus traps", async () => {
    // Sampled whenever a modal layer changes hands. A stacked handoff shows up
    // as a sample of 2: the drawer and the Account dialog mounted together.
    const openDialogs: number[] = [];
    const sample = () => openDialogs.push(document.querySelectorAll('[role="dialog"]').length);
    const { navTrigger } = await renderDrawer(vi.fn(sample));

    const trigger = within(drawer()).getByRole("button", { name: TRIGGER_NAME });
    const menu = await openAccountMenu(trigger);

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Account" }));
    sample();

    const dialog = await screen.findByRole("dialog", { name: "Account" });
    sample();

    // The drawer is gone by the time the Account dialog exists, and at no
    // observed point were both mounted — no stacked Radix focus traps.
    expect(screen.queryByRole("dialog", { name: /PaperLume navigation/i })).toBeNull();
    expect(Math.max(...openDialogs)).toBeLessThanOrEqual(1);

    expect(within(dialog).getByRole("heading", { name: "Account data" })).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Danger zone" })).toBeInTheDocument();

    // Focus is inside the dialog and on a connected node.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.activeElement?.isConnected).toBe(true);

    // The discriminating assertion. The dialog can only return focus to the
    // header trigger if it recorded *that* element as its opener — which is
    // only true when the drawer had already closed and restored focus before
    // the dialog mounted. Opening the dialog eagerly instead records the email
    // button inside the closing drawer, which is detached moments later, and
    // focus falls to <body>.
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Account" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(navTrigger));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.isConnected).toBe(true);
  });

  it("dismisses the drawer rather than being torn down by the navigation", async () => {
    // The route is sampled at the instant the drawer is asked to close. A link
    // left to navigate on its own never asks at all — the drawer would simply
    // vanish with the page — so both the call and the route at that moment are
    // asserted.
    const routeAtNavClose: (string | null)[] = [];
    const { navTrigger } = await renderDrawer(
      vi.fn((open: boolean) => {
        if (!open) routeAtNavClose.push(screen.getByTestId("location").textContent);
      }),
    );

    const trigger = within(drawer()).getByRole("button", { name: TRIGGER_NAME });
    const menu = await openAccountMenu(trigger);

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Privacy Policy" }));

    await waitFor(() => expect(routeAtNavClose).toContain("/dashboard"));
    expect(routeAtNavClose).toEqual(["/dashboard"]);

    // The navigation does then complete, with no drawer and no menu behind it.
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/privacy"));
    expect(screen.queryByRole("dialog", { name: /PaperLume navigation/i })).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(mockSignOut).not.toHaveBeenCalled();

    // The drawer released focus to the header trigger on its way out, so the
    // user is not stranded on <body> after the route change.
    expect(navTrigger.isConnected).toBe(true);
  });
});
