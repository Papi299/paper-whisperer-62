import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { DuplicateGroup, DuplicatePaperInfo, DuplicatePaperSet } from "@/types/database";
import { useToast } from "@/hooks/use-toast";
import { queryKeys } from "@/lib/queryKeys";
import { parseDuplicateGroups } from "@/lib/parseDuplicateGroups";

/** Type guard proving an array holds at least two elements (a `DuplicatePaperSet`). */
function hasAtLeastTwo(items: DuplicatePaperInfo[]): items is DuplicatePaperSet {
  return items.length >= 2;
}

/**
 * Minimal disjoint-set / union-find over integer group indices.
 * Roots are kept as the *smallest* member index so component discovery order
 * follows first appearance in the input.
 */
function createUnionFind(size: number) {
  const parent = Array.from({ length: size }, (_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    // Path compression.
    let node = x;
    while (parent[node] !== root) {
      const next = parent[node];
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Attach the higher index under the lower so the root stays the earliest.
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };
  return { find, union };
}

/**
 * Consolidates duplicate groups into their transitive connected components.
 *
 * Two groups belong to the same component when they share one or more paper
 * IDs, directly or transitively (e.g. a DOI group that bridges two PMID groups
 * discovered earlier). This is a true union-find over the input groups, so an
 * arbitrary number of components and bridges collapse correctly — unlike a
 * first-match accumulation, which would leave a bridged component behind and
 * emit a paper ID in more than one output group.
 *
 * Guarantees for any valid `DuplicateGroup[]` input:
 *   • connected-component completeness — every directly/transitively connected
 *     pair of input groups ends up in exactly one output group;
 *   • global uniqueness — every paper ID appears exactly once across the whole
 *     output (components are disjoint and papers are deduped by id);
 *   • at-least-two — each output group is a valid `DuplicatePaperSet`
 *     (each input group already has ≥2 papers, so a component has ≥2);
 *   • deterministic paper order — first-seen input order (group order, then
 *     paper order within a group);
 *   • deterministic component order — by first appearance of any member;
 *   • match_type — "doi"/"pmid"/"both" derived from the component's groups
 *     (a synthesized "both" input group counts as mixed evidence);
 *   • match_value — the earliest input group in the component supplies it
 *     (a deterministic compatibility rule; identifiers are never concatenated);
 *   • input immutability — the input array, group objects, `papers` tuples and
 *     `DuplicatePaperInfo` objects are never mutated; fresh objects/arrays are
 *     constructed for the output.
 *
 * Exported for focused testing.
 */
export function mergeOverlappingGroups(groups: DuplicateGroup[]): DuplicateGroup[] {
  if (groups.length === 0) return [];

  // 1. Union groups that share any paper id (build connected components).
  const uf = createUnionFind(groups.length);
  const firstGroupForPaper = new Map<string, number>();
  for (let i = 0; i < groups.length; i++) {
    for (const paper of groups[i].papers) {
      const prev = firstGroupForPaper.get(paper.id);
      if (prev === undefined) firstGroupForPaper.set(paper.id, i);
      else uf.union(i, prev);
    }
  }

  // 2. Bucket input-group indices by component root, preserving first-appearance
  //    order both for components and for the group members within them.
  const componentOrder: number[] = [];
  const membersByRoot = new Map<number, number[]>();
  for (let i = 0; i < groups.length; i++) {
    const root = uf.find(i);
    let members = membersByRoot.get(root);
    if (members === undefined) {
      members = [];
      membersByRoot.set(root, members);
      componentOrder.push(root);
    }
    members.push(i);
  }

  // 3. Materialise each component into a fresh output group.
  const result: DuplicateGroup[] = [];
  for (const root of componentOrder) {
    const members = membersByRoot.get(root)!; // ascending input-group order
    const seen = new Set<string>();
    const papers: DuplicatePaperInfo[] = [];
    let hasDoi = false;
    let hasPmid = false;

    for (const gi of members) {
      const group = groups[gi];
      if (group.match_type === "doi" || group.match_type === "both") hasDoi = true;
      if (group.match_type === "pmid" || group.match_type === "both") hasPmid = true;
      for (const paper of group.papers) {
        if (seen.has(paper.id)) continue;
        seen.add(paper.id);
        papers.push({ ...paper }); // fresh paper object — never alias the input
      }
    }

    // Each input group already carried ≥2 papers, so a component always does;
    // the guard both proves the `DuplicatePaperSet` type and fails closed.
    if (!hasAtLeastTwo(papers)) continue;

    const match_type: DuplicateGroup["match_type"] =
      hasDoi && hasPmid ? "both" : hasDoi ? "doi" : "pmid";
    // Earliest input group in the component supplies the compatibility value.
    const match_value = groups[members[0]].match_value;

    result.push({ match_type, match_value, papers });
  }

  return result;
}

/**
 * Scores a paper by counting its non-null/non-empty fields.
 * Used to suggest the most complete paper as the "keep" candidate.
 */
function scorePaper(paper: DuplicatePaperInfo): number {
  let score = 0;
  if (paper.title) score++;
  if (paper.authors && paper.authors.length > 0) score++;
  if (paper.year) score++;
  if (paper.journal) score++;
  if (paper.pmid) score++;
  if (paper.doi) score++;
  if (paper.abstract) score += 2; // abstract is especially valuable
  if (paper.study_type) score++;
  if (paper.keywords && paper.keywords.length > 0) score++;
  return score;
}

/**
 * Returns the paper ID with the highest metadata completeness score.
 */
export function suggestKeepPaper(group: DuplicateGroup): string {
  let bestId = group.papers[0].id;
  let bestScore = -1;

  for (const paper of group.papers) {
    const s = scorePaper(paper);
    if (s > bestScore) {
      bestScore = s;
      bestId = paper.id;
    }
  }

  return bestId;
}

export function useDeduplication(userId: string | undefined) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [scanning, setScanning] = useState(false);
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [merging, setMerging] = useState(false);

  // ── Detection ──

  const scanForDuplicates = useCallback(async () => {
    if (!userId) return;
    setScanning(true);
    setDuplicateGroups([]);

    try {
      const { data, error } = await supabase.rpc("get_duplicate_papers");

      if (error) {
        toast({
          title: "Error scanning for duplicates",
          description: error.message,
          variant: "destructive",
        });
        return;
      }

      const rawGroups = parseDuplicateGroups(data);
      const merged = mergeOverlappingGroups(rawGroups);
      setDuplicateGroups(merged);
    } catch (err) {
      toast({
        title: "Error scanning for duplicates",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setScanning(false);
    }
  }, [userId, toast]);

  // ── Merge ──
  // Simplified: no optimistic updates for dedup (cross-library operation).
  // The dedup dialog shows a "merging..." spinner, so a brief refetch is acceptable.

  const mergeDuplicateGroup = useCallback(
    async (keepId: string, discardIds: string[]) => {
      if (!userId || discardIds.length === 0) return false;

      // Server call
      const { error } = await supabase.rpc("merge_exact_duplicates", {
        p_keep_id: keepId,
        p_discard_ids: discardIds,
      });

      if (error) {
        toast({
          title: "Error merging duplicates",
          description: error.message,
          variant: "destructive",
        });
        return false;
      }

      // Invalidate all papers caches to refetch with correct data
      queryClient.invalidateQueries({ queryKey: queryKeys.papers.all(userId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.papers.count(userId) });
      queryClient.invalidateQueries({ queryKey: ["junction"] });

      return true;
    },
    [userId, queryClient, toast],
  );

  /** Merge all groups sequentially with the given keep selections. */
  const mergeAllGroups = useCallback(
    async (selections: Map<number, string>) => {
      if (!userId) return;
      setMerging(true);

      let successCount = 0;
      let failCount = 0;

      // Defensive fail-closed guard: with correct connected-component
      // consolidation no paper ID can span two groups, but we never want to
      // submit a paper as a discard candidate in two separate RPC calls, so we
      // verify global uniqueness at the mutation boundary and refuse (rather
      // than silently drop) any group that would violate it.
      const submittedIds = new Set<string>();

      for (const [groupIdx, keepId] of selections.entries()) {
        const group = duplicateGroups[groupIdx];
        if (!group) continue;

        const groupIds = group.papers.map((p) => p.id);
        const discardIds = groupIds.filter((id) => id !== keepId);

        if (discardIds.length === 0) continue;

        const keepInGroup = groupIds.includes(keepId);
        const discardUnique = new Set(discardIds).size === discardIds.length;
        const keepInDiscard = discardIds.includes(keepId);
        const collidesAcrossGroups = groupIds.some((id) => submittedIds.has(id));

        if (!keepInGroup || !discardUnique || keepInDiscard || collidesAcrossGroups) {
          // Fail closed: do not issue the merge, surface it as a failure.
          failCount++;
          continue;
        }

        const ok = await mergeDuplicateGroup(keepId, discardIds);
        if (ok) {
          successCount++;
          for (const id of groupIds) submittedIds.add(id);
        } else {
          failCount++;
        }
      }

      setMerging(false);

      if (failCount === 0) {
        toast({
          title: "Duplicates merged",
          description: `Successfully merged ${successCount} duplicate group${successCount !== 1 ? "s" : ""}.`,
        });
      } else {
        toast({
          title: "Merge partially failed",
          description: `${successCount} merged, ${failCount} failed. Check your data and try again.`,
          variant: "destructive",
        });
      }

      // Clear groups after merge
      setDuplicateGroups([]);
    },
    [userId, duplicateGroups, mergeDuplicateGroup, toast],
  );

  return {
    scanning,
    duplicateGroups,
    merging,
    scanForDuplicates,
    mergeAllGroups,
  };
}
