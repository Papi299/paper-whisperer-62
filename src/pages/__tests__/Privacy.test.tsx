import { describe, it, expect } from "vitest";
import { render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Privacy from "../Privacy";

/**
 * PAPERLUME-PRIVACY-001B — the public Privacy Policy page.
 *
 * Three separable things are under test, and conflating them would weaken all
 * three:
 *
 *  1. **The route is public.** The page is rendered with *nothing* around it but
 *     a router — no `QueryClientProvider`, no auth context, no Supabase mock. A
 *     page that grew a session dependency would fail here rather than only in a
 *     signed-out browser. `sourceDoesNotReadAuth` pins the same property at the
 *     module level, because a dependency can be added without being exercised
 *     on the first render.
 *
 *  2. **The approved copy is intact.** The wording is owner-approved legal text,
 *     not product copy: it may not be rewritten, reordered, or quietly dropped.
 *     The guard is the section spine — all twenty numbered headings, in order —
 *     plus the sentinel phrases that carry the disclosures the policy exists to
 *     make (operator identity, the Gemini Free-tier warning, the Vercel
 *     opt-out, the age statement, the privacy address). It deliberately does
 *     NOT restate the whole document: a test that duplicates the policy has to
 *     be edited every time the policy is, which is exactly the edit it is
 *     supposed to make visible.
 *
 *  3. **Nothing from drafting leaked.** The published page carries no research
 *     citations, footnotes, or external source references — only the `mailto:`
 *     address and the policy's own canonical URL may leave the page.
 *
 *  4. **Section 4 is frozen, and is pinned block by block.** The Chrome-extension
 *     section is the one part of this policy whose accuracy a Chrome Web Store
 *     reviewer can check against the shipping extension in a single click, and
 *     Google treats a discrepancy between the posted policy, the Dashboard
 *     disclosures and the item's behaviour as a program-policy violation. So
 *     unlike the rest of the document — guarded by spine and sentinels — §4 is
 *     asserted as an exact ordered list of its rendered blocks
 *     (`SECTION_4_APPROVED`, owner-approved 2026-08-30 under
 *     PRIVACY-POLICY-EXTENSION-METADATA-001B). Whitespace is collapsed first, so
 *     JSX line wrapping and source formatting are invisible to the assertion and
 *     only a change to the *rendered wording* can fail it. Any reword, reorder,
 *     drop or addition fails, which is the intent: this copy may not drift from
 *     what the owner approved without someone deciding to.
 */

const PAGE_TITLE = "PaperLume Privacy Policy";
const CANONICAL_URL = "https://app.paperlume.app/privacy";
const PRIVACY_EMAIL = "mutrisport@gmail.com";

/** The twenty section headings, in the order the approved copy establishes. */
const SECTION_HEADINGS = [
  "1. Scope of this Privacy Policy",
  "2. Information PaperLume processes",
  "3. Browser storage and cookies",
  "4. PaperLume Chrome extension",
  "5. How we use information",
  "6. Google Gemini AI — important Free-tier disclosure",
  "7. PubMed and NCBI",
  "8. Crossref",
  "9. Supabase",
  "10. Vercel",
  "11. Transactional email and Resend",
  "12. International processing",
  "13. Retention",
  "14. Deleting your information and account",
  "15. Access, correction, and data export",
  "16. Security",
  "17. Children",
  "18. Advertising, analytics, and sale of information",
  "19. Changes to this Privacy Policy",
  "20. Contact",
];

/**
 * Sentinel sentences. Each one is a disclosure the policy is published in order
 * to make, so its removal is a substantive change rather than copy polish.
 */
const SENTINELS = [
  "Maor Pichadza",
  "MutriSport",
  PRIVACY_EMAIL,
  "Free / Unpaid tier of the Google Gemini API",
  "opted out of Vercel's optional use of Hobby-plan customer content for AI or model-training purposes",
  "18 years of age or older",
  "Do not use PaperLume's AI features with personal, sensitive, confidential, proprietary, unpublished, or otherwise private information while PaperLume uses Gemini's Free tier.",
  "pre-commercial beta service",
  "Effective date: August 30, 2026",
  "Mumbai, India",
  "Supabase Free tier",
  "Hobby plan",
  "no active billing integration and no current user billing records",
  "not intended for users in those regions",
];

/**
 * Section 4, exactly as the owner approved it on 2026-08-30, one entry per
 * rendered `<p>` or `<li>` in document order.
 *
 * Kept verbatim rather than summarised: the point of the assertion is that the
 * published wording is the approved wording, and a paraphrase here would defeat
 * it. The four DOI metadata names, the Limited Use sentence, the
 * locally-and-transiently disclosure and the bounded "It does not" list are all
 * load-bearing for the Store disclosure (Website content = Yes, Web history =
 * Yes), so none of them may be edited here to make a failing test pass — a
 * mismatch means the page changed, and the page is the thing to fix.
 */
const SECTION_4_APPROVED = [
  "The PaperLume Chrome extension has a narrow purpose: to detect a supported scholarly-paper identifier from the page you are viewing and open PaperLume so that you can choose whether to import the paper.",
  "The extension examines the current tab only when you explicitly activate PaperLume from your browser toolbar. It does not continuously monitor your browsing activity and does not run a background content script. Chrome grants the extension temporary access to the active tab in response to your click. That temporary access is revoked when the tab navigates to a different website origin or when the tab is closed.",
  "When you activate the extension, it first reads the URL of the currently active browser tab to determine whether it contains a supported PubMed or DOI pattern. If the URL itself identifies a supported paper, the extension does not inspect the page for DOI metadata.",
  "If the URL of an ordinary web page does not identify a supported paper, the extension then checks metadata in that page's header for a DOI. It recognizes only four standard DOI metadata names: \u201Ccitation_doi,\u201D \u201Cdc.identifier,\u201D \u201Cdc.identifier.doi,\u201D and \u201Cprism.doi.\u201D It uses the content value only when a metadata element matches one of those names. This check runs only in the main page frame and does not inspect the contents of embedded frames.",
  "Not every website publishes this metadata, and the extension does not use the page title or other page content as a fallback, so it cannot identify a paper on every page.",
  "The extension processes the active-tab URL and, when necessary, the matching DOI metadata locally and transiently while determining the paper identifier. It does not persist that information, and opening the extension does not automatically transmit it to PaperLume.",
  "It does not:",
  "maintain a browsing-history database;",
  "read article or body text, the page title, abstracts, author names, links, form contents, or iframe contents;",
  "use the content values of page metadata other than the supported DOI metadata described above;",
  "read website cookies or authentication tokens;",
  "store the active-tab URL or the DOI metadata it reads from the page;",
  "use background content scripts; or",
  "directly transmit the active-tab URL or webpage content to PaperLume.",
  "If you choose to continue, the extension opens the PaperLume web application and provides only the detected identifier type and value, such as a PMID or DOI.",
  "Nothing is sent to PaperLume merely because you open the extension.",
  "Authentication and the actual import take place in the PaperLume web application.",
  "PaperLume uses information accessed by the Chrome extension only in accordance with the Chrome Web Store User Data Policy, including its Limited Use requirements.",
] as const;

/**
 * The claim the amendment existed to retire.
 *
 * A positive assertion that the new copy is present would still pass if the old
 * sentence came back beside it, so the retired wording is pinned as a negative
 * as well. It was true of every extension version up to and including 001E2 and
 * became false on 2026-08-29, when the DOI metadata fallback shipped.
 */
const RETIRED_CLAIM = "read the contents of the webpage or its DOM";

function renderPolicy() {
  const { container, unmount } = render(
    <MemoryRouter initialEntries={["/privacy"]}>
      <Privacy />
    </MemoryRouter>,
  );
  return { container, unmount, ui: within(container) };
}

/** Visible text with runs of whitespace collapsed, so JSX line wrapping is invisible. */
function visibleText(container: HTMLElement): string {
  return (container.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("Privacy policy page", () => {
  it("renders with no auth provider, query client, or Supabase session in scope", () => {
    const { ui, unmount } = renderPolicy();

    expect(ui.getByRole("heading", { level: 1, name: PAGE_TITLE })).toBeInTheDocument();

    unmount();
  });

  it("does not import an auth or Supabase dependency", () => {
    const source = readFileSync(resolve(__dirname, "../Privacy.tsx"), "utf-8");

    // A guard on the module graph, not on one render: an auth import that is
    // only read on a later branch would still make the route non-public. Only
    // import specifiers are inspected — the policy copy itself names Supabase,
    // and a text search would read that as a dependency.
    const specifiers = Array.from(source.matchAll(/^import[^;]*?from\s+["']([^"']+)["']/gm)).map(
      (m) => m[1],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/useAuth|supabase|Auth$/i);
    }

    // Nor may it reach a session through a non-import path.
    expect(source).not.toMatch(/\buseAuth\s*\(/);
    expect(source).not.toMatch(/\bsupabase\s*\./);
  });

  it("publishes all twenty approved sections, in order, as headings", () => {
    const { container, unmount } = renderPolicy();

    const rendered = Array.from(container.querySelectorAll("h2")).map((h) =>
      (h.textContent ?? "").replace(/\s+/g, " ").trim(),
    );

    expect(rendered).toEqual(SECTION_HEADINGS);

    unmount();
  });

  it("keeps every sentinel disclosure of the approved copy", () => {
    const { container, unmount } = renderPolicy();
    const text = visibleText(container);

    for (const sentinel of SENTINELS) {
      expect(text).toContain(sentinel.replace(/\s+/g, " "));
    }

    unmount();
  });

  it("exposes the privacy address as a mailto link everywhere it appears", () => {
    const { ui, container, unmount } = renderPolicy();

    const mailtoLinks = ui.getAllByRole("link", { name: PRIVACY_EMAIL });
    expect(mailtoLinks.length).toBeGreaterThan(0);
    for (const link of mailtoLinks) {
      expect(link).toHaveAttribute("href", `mailto:${PRIVACY_EMAIL}`);
    }

    // The address must never appear as bare, unactionable text.
    const bareText = Array.from(container.querySelectorAll("p, li"))
      .filter((el) => !el.querySelector("a"))
      .map((el) => el.textContent ?? "")
      .join(" ");
    expect(bareText).not.toContain(PRIVACY_EMAIL);

    unmount();
  });

  it("states its own canonical URL as a link", () => {
    const { ui, unmount } = renderPolicy();

    expect(ui.getByRole("link", { name: CANONICAL_URL })).toHaveAttribute("href", CANONICAL_URL);

    unmount();
  });

  it("owns the document title and canonical reference, and restores both on unmount", () => {
    const previousTitle = document.title;

    const { unmount } = renderPolicy();

    expect(document.title).toBe(PAGE_TITLE);
    const canonicals = document.head.querySelectorAll('link[rel="canonical"]');
    expect(canonicals).toHaveLength(1);
    expect(canonicals[0]).toHaveAttribute("href", CANONICAL_URL);

    unmount();

    // Leaving the page must not leave a canonical reference behind claiming the
    // privacy URL for whatever route renders next.
    expect(document.title).toBe(previousTitle);
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(0);
  });

  it("publishes no drafting citations or external source references", () => {
    const { container, unmount } = renderPolicy();

    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    // The only two destinations the published page may offer.
    expect(new Set(hrefs)).toEqual(new Set([`mailto:${PRIVACY_EMAIL}`, CANONICAL_URL, "/"]));

    const text = visibleText(container);
    // Bracketed footnote markers and stray drafting URLs are what a research
    // citation looks like once it survives into published copy.
    expect(text).not.toMatch(/\[\d+\]/);
    expect(text).not.toMatch(/https?:\/\/(?!app\.paperlume\.app\/privacy)/);

    unmount();
  });

  it("publishes Section 4 exactly as the owner approved it", () => {
    const { container, unmount } = renderPolicy();

    const heading = container.querySelector("h2#chrome-extension");
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toBe("4. PaperLume Chrome extension");

    const section = heading!.closest("section");
    expect(section).not.toBeNull();

    // Whitespace is collapsed, so JSX wrapping is invisible and only rendered
    // wording is under test.
    const blocks = Array.from(section!.querySelectorAll("p, li")).map((el) =>
      (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    );

    expect(blocks).toEqual([...SECTION_4_APPROVED]);

    unmount();
  });

  it("no longer claims the extension never reads the webpage or its DOM", () => {
    const { container, unmount } = renderPolicy();

    // The amendment's whole reason for existing. Asserted against the entire
    // page, not just §4, so the retired sentence cannot reappear elsewhere.
    expect(visibleText(container)).not.toContain(RETIRED_CLAIM);

    unmount();
  });

  it("uses one h1 and nests its subheadings below the section headings", () => {
    const { container, unmount } = renderPolicy();

    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelectorAll("h2").length).toBe(SECTION_HEADINGS.length);
    // Subsections exist (§2 and §6 have them) and none of them outranks an h2.
    expect(container.querySelectorAll("h3").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("h4, h5, h6")).toHaveLength(0);

    unmount();
  });
});
