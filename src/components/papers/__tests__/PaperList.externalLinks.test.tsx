import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PaperWithTags } from "@/types/database";

// PaperList only touches Supabase to mint signed attachment URLs; stub that so
// the link-rendering behavior under test is deterministic and offline.
const createSignedUrlsMock = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: { from: () => ({ createSignedUrls: (...a: unknown[]) => createSignedUrlsMock(...a) }) },
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
    }),
  },
}));

import { PaperList } from "../PaperList";

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};

  // jsdom reports every element as zero-sized. @tanstack/virtual-core sizes the
  // scroll viewport from `offsetHeight`, so without this the virtualizer
  // concludes no row is on screen and renders an empty table — which would make
  // the "unsafe href is absent" assertions below pass for the wrong reason.
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 1000 });
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    // Row height: keeps measured rows smaller than the viewport above.
    return { x: 0, y: 0, top: 0, left: 0, bottom: 52, right: 1000, width: 1000, height: 52, toJSON: () => ({}) } as DOMRect;
  };
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  createSignedUrlsMock.mockReset();
  createSignedUrlsMock.mockResolvedValue({ data: [] });
});

function makePaper(overrides: Partial<PaperWithTags> = {}): PaperWithTags {
  return {
    id: "paper-1",
    user_id: "u1",
    title: "A study of things",
    authors: ["Author A"],
    year: 2024,
    journal: "J Test",
    pmid: null,
    doi: null,
    has_abstract: false,
    study_type: null,
    raw_study_type: null,
    statistical_methods: null,
    keywords: [],
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
    ...overrides,
  };
}

function renderList(paper: PaperWithTags) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PaperList
        papers={[paper]}
        userId="u1"
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        findMatchingKeywords={() => []}
        visibleColumns={["title", "links"]}
        columnWidths={{ title: 200, links: 200 }}
        onColumnResize={vi.fn()}
        normalizeKeyword={(k) => k}
        excludedKeywords={new Set()}
        excludedStudyTypes={new Set()}
        onExcludeStudyType={vi.fn(async () => true)}
        onExcludeKeyword={vi.fn(async () => true)}
        onUpdateDriveUrl={vi.fn(async () => {})}
        selectedPaperIds={new Set()}
        onToggleSelect={vi.fn()}
        onToggleSelectAll={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

/** Raw href attributes of every anchor currently rendered. */
function renderedHrefs(): string[] {
  return Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
}

/**
 * Guard for the negative cases: the virtualizer renders nothing when the
 * viewport measures zero, and an empty table would make every "unsafe href is
 * absent" assertion pass for the wrong reason. Assert the row is really there.
 */
function expectRowRendered(paper: PaperWithTags) {
  expect(screen.getByText(paper.title)).toBeInTheDocument();
  expect(screen.getByTitle("Search on Google Scholar")).toBeInTheDocument();
}

const UNSAFE = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "  javascript:alert(1)",
  "java\tscript:alert(1)",
  "data:text/html,<h1>x</h1>",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "ftp://evil.example/f",
  "mailto:a@b.com",
  "//evil.example/path",
  "/evil/path",
  "evil.example/path",
  "not a url",
];

describe("PaperList — pubmed_url", () => {
  it("renders a link for a safe pubmed_url", () => {
    renderList(makePaper({ pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/12345678/" }));

    const link = screen.getByTitle("PubMed") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/12345678/");
    expect(link.rel).toBe("noopener noreferrer");
    expect(link.target).toBe("_blank");
  });

  it.each(UNSAFE)("does not render %s as a pubmed href", (unsafe) => {
    const paper = makePaper({ pubmed_url: unsafe });
    renderList(paper);
    expectRowRendered(paper);

    expect(screen.queryByTitle("PubMed")).toBeNull();
    for (const href of renderedHrefs()) {
      expect(href).not.toContain("javascript");
      expect(href).not.toContain("vbscript");
      expect(href).not.toContain("data:");
      expect(href).not.toContain("evil");
      expect(href).not.toContain("etc/passwd");
    }
  });
});

describe("PaperList — journal_url", () => {
  it("renders a link for a safe journal_url", () => {
    renderList(makePaper({ journal_url: "https://doi.org/10.1234/abc" }));

    const link = screen.getByTitle("Journal") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://doi.org/10.1234/abc");
    expect(link.rel).toBe("noopener noreferrer");
  });

  it.each(UNSAFE)("does not render %s as a journal href", (unsafe) => {
    const paper = makePaper({ journal_url: unsafe });
    renderList(paper);
    expectRowRendered(paper);

    expect(screen.queryByTitle("Journal")).toBeNull();
    for (const href of renderedHrefs()) {
      expect(href).not.toContain("javascript");
      expect(href).not.toContain("vbscript");
      expect(href).not.toContain("data:");
      expect(href).not.toContain("evil");
      expect(href).not.toContain("etc/passwd");
    }
  });
});

describe("PaperList — generated Google Scholar link", () => {
  it("stays a valid https link after hardening", () => {
    renderList(makePaper({ title: "A study of things" }));

    const link = screen.getByTitle("Search on Google Scholar") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      "https://scholar.google.com/scholar?q=A%20study%20of%20things",
    );
    expect(link.protocol).toBe("https:");
  });

  it("survives a title containing URL-significant characters", () => {
    renderList(makePaper({ title: "javascript:alert(1) & <b>x</b> #1" }));

    const link = screen.getByTitle("Search on Google Scholar") as HTMLAnchorElement;
    // The title is percent-encoded into the query, so it can never change the
    // scheme of the generated URL.
    expect(link.protocol).toBe("https:");
    expect(link.host).toBe("scholar.google.com");
  });
});

describe("PaperList — drive_url via QuickAddDriveLink", () => {
  it("renders a link for a safe drive_url", () => {
    renderList(makePaper({ drive_url: "https://drive.google.com/file/d/1a2b3c/view" }));

    const link = screen.getByTitle("Open cloud link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://drive.google.com/file/d/1a2b3c/view");
  });

  it("does not render an unsafe drive_url as an href", () => {
    const paper = makePaper({ drive_url: "javascript:alert(1)" });
    renderList(paper);
    expectRowRendered(paper);

    expect(screen.queryByTitle("Open cloud link")).toBeNull();
    for (const href of renderedHrefs()) expect(href).not.toContain("javascript");
  });
});

describe("PaperList — attachment signed URLs", () => {
  const attachment = {
    id: "att-1",
    file_name: "paper.pdf",
    file_path: "u1/paper.pdf",
    file_type: "application/pdf",
  };

  it("keeps a normal Supabase signed https URL clickable", async () => {
    const signed =
      "https://abcdefgh.supabase.co/storage/v1/object/sign/attachments/u1/paper.pdf?token=eyJhbGciOiJIUzI1NiJ9.payload.sig";
    createSignedUrlsMock.mockResolvedValue({ data: [{ signedUrl: signed }] });

    renderList(makePaper({ paper_attachments: [attachment] }));
    fireEvent.click(screen.getByTitle("Attachments"));

    await waitFor(() => {
      const link = screen.getByText("paper.pdf").closest("a") as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect(link.getAttribute("href")).toBe(signed);
      expect(link.rel).toBe("noopener noreferrer");
    });
  });

  it("does not render a non-http(s) signed URL as an href", async () => {
    createSignedUrlsMock.mockResolvedValue({ data: [{ signedUrl: "javascript:alert(1)" }] });

    renderList(makePaper({ paper_attachments: [attachment] }));
    fireEvent.click(screen.getByTitle("Attachments"));

    await waitFor(() => expect(screen.getByText("paper.pdf")).toBeInTheDocument());
    expect(screen.getByText("paper.pdf").closest("a")).toBeNull();
    for (const href of renderedHrefs()) expect(href).not.toContain("javascript");
  });
});
