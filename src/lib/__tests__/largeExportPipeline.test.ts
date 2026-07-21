import { describe, it, expect, vi } from "vitest";
import { fetchAllPages } from "../fetchAllPages";

/**
 * Integration-style test: simulates the full export pipeline for >1000 papers.
 *
 * Verifies:
 * 1. fetchAllPages correctly collects all papers across multiple pages
 * 2. Junction hydration (tags/projects) works after chunked fetch
 * 3. No data is lost or duplicated
 */
describe("large export pipeline (>1000 rows)", () => {
  it("fetches 2500 papers, hydrates tags/projects, produces correct output", async () => {
    const TOTAL_PAPERS = 2500;
    const PAGE_SIZE = 1000;

    // Simulate paper rows
    const allPapers = Array.from({ length: TOTAL_PAPERS }, (_, i) => ({
      id: `paper-${i}`,
      title: `Paper ${i}`,
      authors: [`Author ${i}`],
      year: 2020 + (i % 5),
      journal: `Journal ${i % 10}`,
      study_type: i % 3 === 0 ? "RCT" : i % 3 === 1 ? "Meta-Analysis" : "Cohort Study",
      keywords: [`kw-${i % 20}`],
      mesh_terms: [] as string[],
      substances: [] as string[],
      abstract: `Abstract for paper ${i}`,
    }));

    // Simulate tag junction rows (every paper has 1-2 tags)
    const allTagJunctions = allPapers.flatMap((p, i) => {
      const junctions = [{ paper_id: p.id, tag_id: `tag-${i % 5}` }];
      if (i % 3 === 0) junctions.push({ paper_id: p.id, tag_id: `tag-${(i + 1) % 5}` });
      return junctions;
    });

    // Simulate project junction rows (every other paper)
    const allProjectJunctions = allPapers
      .filter((_, i) => i % 2 === 0)
      .map((p, i) => ({ paper_id: p.id, project_id: `proj-${i % 3}` }));

    // Tag/project metadata
    const tags = Array.from({ length: 5 }, (_, i) => ({
      id: `tag-${i}`,
      name: `Tag ${i}`,
      color: "#000",
      user_id: "u1",
      created_at: "2023-01-01",
    }));
    const projects = Array.from({ length: 3 }, (_, i) => ({
      id: `proj-${i}`,
      name: `Project ${i}`,
      color: "#000",
      user_id: "u1",
      description: null,
      created_at: "2023-01-01",
      updated_at: "2023-01-01",
    }));

    // ── Step 1: fetchAllPages for papers ──
    const fetchedPapers = await fetchAllPages<(typeof allPapers)[number]>(
      () => ({
        range: async (from: number, to: number) => ({
          data: allPapers.slice(from, to + 1),
          error: null,
        }),
      }),
      PAGE_SIZE,
    );

    expect(fetchedPapers).toHaveLength(TOTAL_PAPERS);

    // ── Step 2: Simulate chunked junction fetch (inline, mirroring fetchInChunks logic) ──
    const paperIds = fetchedPapers.map((p) => p.id);
    const CHUNK_SIZE = 500;

    // Simulate fetchInChunks for tags
    const tagRows: typeof allTagJunctions = [];
    for (let i = 0; i < paperIds.length; i += CHUNK_SIZE) {
      const chunk = new Set(paperIds.slice(i, i + CHUNK_SIZE));
      const matching = allTagJunctions.filter((r) => chunk.has(r.paper_id));
      tagRows.push(...matching);
    }

    // Simulate fetchInChunks for projects
    const projectRows: typeof allProjectJunctions = [];
    for (let i = 0; i < paperIds.length; i += CHUNK_SIZE) {
      const chunk = new Set(paperIds.slice(i, i + CHUNK_SIZE));
      const matching = allProjectJunctions.filter((r) => chunk.has(r.paper_id));
      projectRows.push(...matching);
    }

    // ── Step 3: Hydrate ──
    const tagsMap = new Map(tags.map((t) => [t.id, t]));
    const projectsMap = new Map(projects.map((p) => [p.id, p]));

    const hydratedPapers = fetchedPapers.map((paper) => {
      const paperTagIds = tagRows
        .filter((pt) => pt.paper_id === paper.id)
        .map((pt) => pt.tag_id);
      const paperProjectIds = projectRows
        .filter((pp) => pp.paper_id === paper.id)
        .map((pp) => pp.project_id);

      return {
        ...paper,
        tags: paperTagIds.map((id) => tagsMap.get(id)).filter(Boolean),
        projects: paperProjectIds.map((id) => projectsMap.get(id)).filter(Boolean),
      };
    });

    // ── Assertions ──
    expect(hydratedPapers).toHaveLength(TOTAL_PAPERS);

    // Every paper should have at least 1 tag
    const papersWithTags = hydratedPapers.filter((p) => p.tags.length > 0);
    expect(papersWithTags).toHaveLength(TOTAL_PAPERS);

    // Papers at i%3===0 should have 2 tags
    const papersWithTwoTags = hydratedPapers.filter((p) => p.tags.length === 2);
    const expectedTwoTagCount = Math.floor(TOTAL_PAPERS / 3) + 1; // 0, 3, 6, ... 2499
    expect(papersWithTwoTags.length).toBe(expectedTwoTagCount);

    // Every other paper should have a project
    const papersWithProjects = hydratedPapers.filter((p) => p.projects.length > 0);
    expect(papersWithProjects).toHaveLength(Math.ceil(TOTAL_PAPERS / 2));

    // Verify no truncation at page boundaries (paper 999, 1000, 1999, 2000)
    expect(hydratedPapers[999].id).toBe("paper-999");
    expect(hydratedPapers[999].tags.length).toBeGreaterThanOrEqual(1);
    expect(hydratedPapers[1000].id).toBe("paper-1000");
    expect(hydratedPapers[1000].tags.length).toBeGreaterThanOrEqual(1);
    expect(hydratedPapers[1999].id).toBe("paper-1999");
    expect(hydratedPapers[2000].id).toBe("paper-2000");

    // Verify chunk boundaries for junction data (ID 499→500, 999→1000)
    const paper499 = hydratedPapers.find((p) => p.id === "paper-499")!;
    const paper500 = hydratedPapers.find((p) => p.id === "paper-500")!;
    expect(paper499.tags.length).toBeGreaterThanOrEqual(1);
    expect(paper500.tags.length).toBeGreaterThanOrEqual(1);
  });
});
