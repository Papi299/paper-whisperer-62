import { useCallback, useMemo, useState } from "react";

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
  selectedAuthors: string[];
  onToggleKeyword: (keyword: string) => void;
  onToggleAuthor: (author: string) => void;
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
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([]);

  // Toggle semantics are unchanged from the previous in-component state:
  // present → removed, absent → appended, preserving selection order.
  const onToggleKeyword = useCallback((keyword: string) => {
    setSelectedKeywords((prev) =>
      prev.includes(keyword) ? prev.filter((k) => k !== keyword) : [...prev, keyword],
    );
  }, []);

  const onToggleAuthor = useCallback((author: string) => {
    setSelectedAuthors((prev) =>
      prev.includes(author) ? prev.filter((a) => a !== author) : [...prev, author],
    );
  }, []);

  const onClearKeywords = useCallback(() => setSelectedKeywords([]), []);
  const onClearAuthors = useCallback(() => setSelectedAuthors([]), []);

  return useMemo(
    () => ({
      selectedKeywords,
      selectedAuthors,
      onToggleKeyword,
      onToggleAuthor,
      onClearKeywords,
      onClearAuthors,
    }),
    [
      selectedKeywords,
      selectedAuthors,
      onToggleKeyword,
      onToggleAuthor,
      onClearKeywords,
      onClearAuthors,
    ],
  );
}
