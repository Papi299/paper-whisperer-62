import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * PAPERLUME-SIDEBAR-UX-BRAND-001 — the web app shows the canonical PaperLume
 * mark, not a generic icon, on its identity surfaces and in the browser tab.
 *
 * "Canonical" is the property under test: the mark must come from
 * `assets/brand/svg/paperlume-symbol.svg` (brand-spec.md — the source of truth
 * the Chrome extension also derives from), not from a redrawn or copied SVG
 * that could drift from it. The sidebar's brand row is covered with the rest of
 * the sidebar in `components/layout/__tests__/Sidebar.taxonomyRows.test.tsx`.
 */

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      getSession: () => Promise.resolve({ data: { session: null } }),
      updateUser: vi.fn(),
    },
  },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

// The canonical master itself, resolved exactly as the app resolves it.
import canonicalSymbolUrl from "../../../../assets/brand/svg/paperlume-symbol.svg?no-inline";
import { PaperLumeMark } from "../PaperLumeMark";
import Auth from "@/pages/Auth";
import ResetPassword from "@/pages/ResetPassword";
import Privacy from "@/pages/Privacy";

const REPO_ROOT = resolve(__dirname, "../../../..");
const CANONICAL_SYMBOL = "assets/brand/svg/paperlume-symbol.svg";

/** Every rendered `<img>` that is the canonical symbol. */
function brandMarks(container: HTMLElement) {
  return Array.from(container.querySelectorAll("img")).filter(
    (img) => img.getAttribute("src") === canonicalSymbolUrl,
  );
}

describe("PaperLumeMark", () => {
  it("renders the canonical brand-pack symbol", () => {
    const { container } = render(<PaperLumeMark />);

    expect(brandMarks(container)).toHaveLength(1);
    // A URL to the master file itself — not an inlined, re-encoded copy.
    expect(new URL(canonicalSymbolUrl, "http://localhost").pathname).toBe(`/${CANONICAL_SYMBOL}`);
    expect(existsSync(resolve(REPO_ROOT, CANONICAL_SYMBOL))).toBe(true);
  });

  it("is decorative unless a surface asks for a name", () => {
    const { container, rerender } = render(<PaperLumeMark />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(brandMarks(container)[0]).toHaveAttribute("alt", "");

    rerender(<PaperLumeMark alt="PaperLume" />);
    expect(screen.getByRole("img", { name: "PaperLume" })).toBe(brandMarks(container)[0]);
  });

  it("imports the master rather than a copy of it", () => {
    // No second PaperLume symbol may exist under the app's own source trees —
    // a copy there would be a competing brand source.
    const source = readFileSync(resolve(__dirname, "../PaperLumeMark.tsx"), "utf-8");
    expect(source).toMatch(/from "(\.\.\/)+assets\/brand\/svg\/paperlume-symbol\.svg\?no-inline"/);
  });
});

describe("favicon", () => {
  const html = readFileSync(resolve(REPO_ROOT, "index.html"), "utf-8");
  const icons = Array.from(html.matchAll(/<link\s[^>]*rel="icon"[^>]*>/g), (m) => m[0]);
  const hrefOf = (tag: string) => tag.match(/href="([^"]+)"/)?.[1];

  it("is the canonical symbol, with the canonical 32px export as fallback", () => {
    expect(icons.map(hrefOf)).toEqual([
      "/assets/brand/png/paperlume-32.png",
      `/${CANONICAL_SYMBOL}`,
    ]);
    for (const tag of icons) {
      expect(existsSync(resolve(REPO_ROOT, hrefOf(tag)!.slice(1)))).toBe(true);
    }
  });

  it("no longer uses the generic emoji data URI", () => {
    expect(html).not.toMatch(/rel="icon"[^>]*href="data:/);
  });
});

describe("identity surfaces", () => {
  it("Auth shows the mark beside the visible PaperLume title, decoratively", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/auth"]}>
        <Auth />
      </MemoryRouter>,
    );

    expect(brandMarks(container)).toHaveLength(1);
    expect(brandMarks(container)[0]).toHaveAttribute("alt", "");
    expect(screen.getByText("PaperLume", { exact: true })).toBeInTheDocument();
    expect(container.querySelector(".lucide-book-open")).toBeNull();
  });

  it("ResetPassword names the mark, because no visible text names the brand", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/reset-password"]}>
        <ResetPassword />
      </MemoryRouter>,
    );

    expect(screen.queryByText("PaperLume", { exact: true })).toBeNull();
    expect(screen.getByRole("img", { name: "PaperLume" })).toBe(brandMarks(container)[0]);
    expect(container.querySelector(".lucide-book-open")).toBeNull();
  });

  it("Privacy's home link is named once, by its text", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/privacy"]}>
        <Privacy />
      </MemoryRouter>,
    );

    const home = screen.getByRole("link", { name: "PaperLume" });
    expect(home).toHaveAttribute("href", "/");
    expect(brandMarks(home)).toHaveLength(1);
    expect(brandMarks(home)[0]).toHaveAttribute("alt", "");
    expect(container.querySelector(".lucide-book-open")).toBeNull();
  });
});
