import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import App from "../App";

/**
 * The client route table in `src/App.tsx`, under the real React Router.
 *
 * `App` is the one place that maps a URL to a page: a declarative
 * `BrowserRouter` with six routes and a catch-all. Route matching, the
 * catch-all, and history traversal all run inside `react-router`, so a router
 * release can change what a URL renders without any application source
 * changing. Nothing else exercises that table: the page suites render a page
 * directly inside a `MemoryRouter`, and the E2E lane never opens an unknown
 * route or walks the history stack.
 *
 * What this pins, against the real `App` and the real `BrowserRouter`:
 *
 *  1. **Deep links.** Every declared path renders its page on a direct load (a
 *     typed URL or a refresh), with or without a trailing slash, and the query
 *     string reaches the extension handoff route intact.
 *  2. **The catch-all.** An unknown or malformed path — extra segments, a
 *     `//host`-shaped path, a long run of slashes — renders the real `NotFound`
 *     page in place: no redirect, no error, and the location stays exactly as
 *     the visitor typed it.
 *  3. **History.** A client-side `<Link>` navigation pushes an entry, and the
 *     browser's Back and Forward buttons (`popstate`) render the right page.
 *
 * The six page bodies are replaced by markers, because their own behaviour
 * (auth redirects, data loading) belongs to their own suites and needs a
 * session this test does not have. `NotFound` stays real: it reads only the
 * location. Nothing here asserts timing — a CPU-cost assertion would be
 * flaky on a loaded runner — only which page each URL reaches.
 */

vi.mock("@/pages/Index", () => ({ default: () => <main data-testid="page">index</main> }));
vi.mock("@/pages/Auth", () => ({ default: () => <main data-testid="page">auth</main> }));
vi.mock("@/pages/Dashboard", () => ({ default: () => <main data-testid="page">dashboard</main> }));
vi.mock("@/pages/ExtensionImport", () => ({
  default: () => <main data-testid="page">extension-import</main>,
}));
vi.mock("@/pages/ResetPassword", () => ({
  default: () => <main data-testid="page">reset-password</main>,
}));
vi.mock("@/pages/Privacy", async () => {
  const { Link } = await import("react-router");
  return {
    default: () => (
      <main data-testid="page">
        privacy
        <Link to="/auth">Sign in</Link>
      </main>
    ),
  };
});

const NOT_FOUND_LOG = "404 Error: User attempted to access non-existent route:";

/** Load `App` as if `path` had been typed into the address bar. */
function renderAt(path: string) {
  window.history.replaceState(null, "", `${window.location.origin}${path}`);
  return render(<App />);
}

const currentPage = () => screen.getByTestId("page").firstChild?.textContent;

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  window.history.replaceState(null, "", `${window.location.origin}/`);
});

describe("App route table", () => {
  it.each([
    ["/", "index"],
    ["/auth", "auth"],
    ["/dashboard", "dashboard"],
    ["/dashboard/", "dashboard"],
    ["/extension-import?kind=pmid&identifier=12345678", "extension-import"],
    ["/reset-password", "reset-password"],
    ["/privacy", "privacy"],
    ["/privacy/", "privacy"],
  ])("renders %s directly as the %s page", (path, page) => {
    renderAt(path);

    expect(currentPage()).toBe(page);
    expect(`${window.location.pathname}${window.location.search}`).toBe(path);
    expect(screen.queryByText("404")).not.toBeInTheDocument();
  });

  it.each([
    ["an unknown path", "/does-not-exist"],
    ["an extra segment under a real route", "/dashboard/extra"],
    ["a //host-shaped path", "//evil.example"],
    ["a long run of slashes", `/${"/".repeat(2000)}x`],
  ])("renders the real NotFound page in place for %s", (_label, path) => {
    renderAt(path);

    expect(screen.getByRole("heading", { name: "404" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to Home" })).toHaveAttribute("href", "/");
    expect(screen.queryByTestId("page")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe(path);
    expect(consoleError).toHaveBeenCalledWith(NOT_FOUND_LOG, path);
  });

  it("pushes a client-side Link navigation and replays it with Back and Forward", async () => {
    renderAt("/privacy");
    expect(currentPage()).toBe("privacy");

    fireEvent.click(screen.getByRole("link", { name: "Sign in" }));
    await waitFor(() => expect(currentPage()).toBe("auth"));
    expect(window.location.pathname).toBe("/auth");

    act(() => window.history.back());
    await waitFor(() => expect(currentPage()).toBe("privacy"));
    expect(window.location.pathname).toBe("/privacy");

    act(() => window.history.forward());
    await waitFor(() => expect(currentPage()).toBe("auth"));
    expect(window.location.pathname).toBe("/auth");
  });
});
