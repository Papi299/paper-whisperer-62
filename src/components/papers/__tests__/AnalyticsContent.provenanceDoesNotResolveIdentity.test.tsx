import { describe, it, expect, beforeAll, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { AnalyticsContent } from "../AnalyticsContent";
import { useAnalyticsTargets } from "@/hooks/useAnalyticsTargets";
import { makeAuthorProvenance, type AuthorProvenance } from "@/lib/authorProvenance";
import type { Paper } from "@/types/database";

/**
 * AUTHOR-IDENTITY-PROVENANCE-001B — the boundary between provenance and
 * identity, asserted where a user would see it break.
 *
 * 001A made Analytics group author *mentions* by a textual comparison key.
 * 001B adds structured provenance — including checksum-valid ORCIDs — to the
 * paper rows those mentions come from. The whole point of this task is that the
 * new data does NOT change the grouping:
 *
 *   • `Stuart M. Phillips` and `Stuart M Phillips` still group, because their
 *     text is formatting-equivalent — not because of anything new;
 *   • `S M Phillips` and `Stuart M Phillips` still stay apart, even when both
 *     papers carry the SAME ORCID. Deciding those are one researcher is
 *     identity resolution, and 001B deliberately does not do it.
 *
 * If a later change ever makes Analytics aggregate on ORCID, this file fails —
 * which is the intent. That is a product decision, not a refactor.
 */

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => <>{children}</>,
    BarChart: ({ data }: { data: Array<{ name: string; count: number }> }) => (
      <ul>
        {data.map((datum) => (
          <li key={datum.name}>{`${datum.name} = ${datum.count}`}</li>
        ))}
      </ul>
    ),
  };
});

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

/** One ORCID, deliberately shared by mentions that must NOT be merged. */
const SHARED_ORCID = "0000-0002-1825-0097";

function pubmedProvenance(names: string[]): AuthorProvenance[] {
  return names.map((name) =>
    makeAuthorProvenance({
      source: "pubmed_api",
      source_field: "Author",
      kind: "personal",
      source_name: name,
      family_name: "Phillips",
      affiliations: ["McMaster University"],
      identifiers: [{ scheme: "ORCID", value: SHARED_ORCID }],
    }),
  );
}

let paperSeq = 0;
function makePaper(authors: string[], provenance?: AuthorProvenance[] | null): Paper {
  paperSeq += 1;
  return {
    id: `paper-${paperSeq}`,
    user_id: "user-1",
    title: `Paper ${paperSeq}`,
    authors,
    author_provenance: provenance,
    year: 2020,
    journal: null,
    pmid: null,
    doi: null,
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
    insert_order: paperSeq,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };
}

function Harness({ papers }: { papers: Paper[] }) {
  const targets = useAnalyticsTargets();
  return <AnalyticsContent papers={papers} isLoading={false} targets={targets} />;
}

const openAuthors = () => {
  fireEvent.click(screen.getByRole("button", { name: /^Target Authors/ }));
};

const optionLabels = () =>
  screen
    .getAllByRole("checkbox")
    .map((box) => (box.closest("label") ?? box).textContent ?? "");

describe("Analytics author grouping is unaffected by structured provenance", () => {
  it("keeps ambiguous variants separate even when both carry the same ORCID", () => {
    const papers = [
      makePaper(["S M Phillips"], pubmedProvenance(["S M Phillips"])),
      makePaper(["Stuart M Phillips"], pubmedProvenance(["Stuart M Phillips"])),
      makePaper(["Stuart Phillips"], pubmedProvenance(["Stuart Phillips"])),
    ];

    render(<Harness papers={papers} />);
    openAuthors();

    const labels = optionLabels();
    // Three mentions in, three options out. A shared ORCID is provenance about
    // what a source stated, never a merge instruction.
    expect(labels).toHaveLength(3);
    expect(labels.some((label) => label.includes("S M Phillips"))).toBe(true);
    expect(labels.some((label) => label.includes("Stuart M Phillips"))).toBe(true);
    expect(labels.some((label) => label.includes("Stuart Phillips"))).toBe(true);
  });

  it("still groups formatting-equivalent mentions, provenance or not", () => {
    const papers = [
      // One with rich provenance, one legacy row with none at all — the 001A
      // textual key is what groups them, and it works across both.
      makePaper(["Stuart M. Phillips"], pubmedProvenance(["Stuart M. Phillips"])),
      makePaper(["Stuart M Phillips"], null),
    ];

    render(<Harness papers={papers} />);
    openAuthors();

    expect(optionLabels()).toHaveLength(1);
  });

  it("groups a legacy NULL-provenance library exactly as it always did", () => {
    // Every read path must keep working from `authors` alone.
    const papers = [
      makePaper(["Stuart M. Phillips"], null),
      makePaper(["stuart  m  phillips"], null),
      makePaper(["S M Phillips"], null),
    ];

    render(<Harness papers={papers} />);
    openAuthors();

    // The two formatting variants group; the ambiguous shortening does not.
    expect(optionLabels()).toHaveLength(2);
  });
});
