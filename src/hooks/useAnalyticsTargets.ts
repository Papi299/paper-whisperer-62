import { useCallback, useMemo, useState } from "react";
import type { AuthorTargetSelection } from "@/lib/authorSelection";

/**
 * The Analytics "target" selections — the keywords and authors whose
 * distributions the user has asked to compare.
 *
 * This deliberately lives ABOVE the responsive presentation boundary. The
 * Dashboard renders analytics through two different shells (the desktop inline
 * Collapsible and the mobile bottom-sheet overlay) and picks between them with
 * `useIsMobile()`, so crossing 768px unmounts one shell and mounts the other.
 * `isAnalyticsOpen` already survived that swap because the Dashboard owned it;
 * these selections did not, because they were `useState` inside the shared
 * body. Rotating a phone or resizing a window therefore silently discarded the
 * user's exploratory selection.
 *
 * One authoritative state, passed to whichever shell is mounted — not two
 * states kept in step by effects, and not both shells mounted at once (which
 * would put duplicate controls in the accessibility tree).
 */
export interface AnalyticsTargets {
  selectedKeywords: string[];
  /**
   * Selected authors as `{ key, label }` rather than bare strings.
   *
   * A keyword is a literal: the string IS the thing selected, and nothing can
   * change what it refers to. An author is not, and has not been since 001C —
   * the same session can turn a selected mention into a person, merge that
   * person into another, and undo both. A bare key cannot survive those
   * transitions, and a bare key is also unprintable, so a selection whose entity
   * has left the current view would have nothing to put on its badge.
   *
   * The key stays stable and the label rides along as the last-resort way to
   * describe it. What each selection currently MEANS is derived on read by
   * `lib/authorSelection`, never written back here — which is what lets undoing
   * a merge restore the selection with no undo bookkeeping.
   */
  selectedAuthors: AuthorTargetSelection[];
  onToggleKeyword: (keyword: string) => void;
  /**
   * Replace the author selection wholesale.
   *
   * Deliberately not a toggle. Reconciling one click can touch several stored
   * entries at once — removing every key that converged on the badge, pinning
   * the siblings that would otherwise vanish with it — and that computation
   * belongs with the reconciliation rules in `lib/authorSelection`, not split
   * between there and a setter here. See `toggleAuthorSelection`.
   */
  onSetAuthors: (next: AuthorTargetSelection[]) => void;
  onClearKeywords: () => void;
  onClearAuthors: () => void;
}

/**
 * Session-scoped and deliberately not persisted: these are exploratory
 * selections about the *current* view, not a saved preference, so they are not
 * written to the database, the profile, the URL, localStorage or
 * sessionStorage. A page reload starts clean.
 *
 * Within a session they survive closing and reopening Analytics, which follows
 * naturally from the state living above the shell and matches how the panel is
 * actually used — closing it to look at the table underneath and reopening it
 * should not throw the comparison away.
 */
export function useAnalyticsTargets(): AnalyticsTargets {
  const [selectedKeywords, setSelectedKeywords] = useState<string[]>([]);
  const [selectedAuthors, setSelectedAuthors] = useState<AuthorTargetSelection[]>([]);

  // Toggle semantics are unchanged from the previous in-component state:
  // present → removed, absent → appended, preserving selection order.
  const onToggleKeyword = useCallback((keyword: string) => {
    setSelectedKeywords((prev) =>
      prev.includes(keyword) ? prev.filter((k) => k !== keyword) : [...prev, keyword],
    );
  }, []);

  const onSetAuthors = useCallback((next: AuthorTargetSelection[]) => {
    setSelectedAuthors(next);
  }, []);

  const onClearKeywords = useCallback(() => setSelectedKeywords([]), []);
  const onClearAuthors = useCallback(() => setSelectedAuthors([]), []);

  return useMemo(
    () => ({
      selectedKeywords,
      selectedAuthors,
      onToggleKeyword,
      onSetAuthors,
      onClearKeywords,
      onClearAuthors,
    }),
    [
      selectedKeywords,
      selectedAuthors,
      onToggleKeyword,
      onSetAuthors,
      onClearKeywords,
      onClearAuthors,
    ],
  );
}
