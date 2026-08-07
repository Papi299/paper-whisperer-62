import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PaperWithTags } from "@/types/database";
import type { Attachment } from "@/hooks/useAttachments";

// The dialog's only dynamic navigation is the attachment thumbnail link, so
// the attachment source is stubbed and Supabase is never contacted.
const attachmentsRef: { current: Attachment[] } = { current: [] };
vi.mock("@/hooks/useAttachments", () => ({
  useAttachments: () => ({
    attachments: attachmentsRef.current,
    loading: false,
    uploading: false,
    uploadAttachments: vi.fn(),
    deleteAttachment: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: vi.fn() },
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
    }),
  },
}));

import { EditPaperDialog } from "../EditPaperDialog";

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

function makeAttachment(publicUrl: string): Attachment {
  return {
    id: "att-1",
    paper_id: "paper-1",
    user_id: "u1",
    file_path: "u1/paper.pdf",
    file_name: "paper.pdf",
    file_type: "application/pdf",
    size_bytes: 1024,
    created_at: "2026-01-01T00:00:00Z",
    publicUrl,
  };
}

const PAPER: PaperWithTags = {
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
};

function renderDialog(paper: PaperWithTags = PAPER) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EditPaperDialog
        paper={paper}
        projects={[]}
        tags={[]}
        open
        onOpenChange={vi.fn()}
        onSave={vi.fn(async () => true)}
        userId="u1"
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  attachmentsRef.current = [];
});

describe("EditPaperDialog — attachment navigation", () => {
  it("keeps a normal Supabase signed https URL clickable", () => {
    const signed =
      "https://abcdefgh.supabase.co/storage/v1/object/sign/attachments/u1/paper.pdf?token=eyJhbGciOiJIUzI1NiJ9.payload.sig";
    attachmentsRef.current = [makeAttachment(signed)];

    renderDialog();

    const link = screen.getByText("paper.pdf").closest("div")?.querySelector("a") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe(signed);
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
  });

  const unsafe = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<h1>x</h1>",
    "file:///etc/passwd",
    "//evil.example/x",
    "",
  ];

  it.each(unsafe)("does not render %s as an attachment href", (value) => {
    attachmentsRef.current = [makeAttachment(value)];

    renderDialog();

    // The attachment tile still renders (the file stays visible and deletable),
    // it just is not a navigation target.
    expect(screen.getByText("paper.pdf")).toBeInTheDocument();
    const hrefs = Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
    for (const href of hrefs) {
      expect(href).not.toContain("javascript");
      expect(href).not.toContain("data:");
      expect(href).not.toContain("etc/passwd");
      expect(href).not.toContain("evil");
    }
  });
});

describe("EditPaperDialog — historical unsafe URL values stay editable", () => {
  it("still renders and populates the URL fields for a paper with unsafe stored URLs", () => {
    renderDialog({
      ...PAPER,
      drive_url: "javascript:alert(1)",
      pubmed_url: "data:text/html,<h1>x</h1>",
    });

    // No migration is required: the values remain visible and correctable in
    // the form, they simply never become links anywhere in the UI.
    expect(screen.getByLabelText("Cloud Storage URL")).toHaveValue("javascript:alert(1)");
    expect(screen.getByLabelText("PubMed URL")).toHaveValue("data:text/html,<h1>x</h1>");
  });
});
