import { BookOpen, FlaskConical, FolderOpen, Plus, SearchX, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ACCEPTED_FILE_EXTENSIONS,
  type AcceptedFileExtension,
} from "./AddPaperDialog";

/**
 * Human-readable name for every extension the file importer actually parses.
 *
 * Typed as a total `Record` over `AcceptedFileExtension`, so adding a parser to
 * `ACCEPTED_FILE_EXTENSIONS` without naming it here fails `npm run typecheck`.
 * That is the guard that keeps this onboarding copy honest: new users are only
 * ever told about formats the product genuinely reads.
 */
const FILE_FORMAT_LABELS: Record<AcceptedFileExtension, string> = {
  ".bib": "BibTeX",
  ".ris": "RIS",
  ".nbib": "PubMed",
  ".enw": "EndNote",
  ".csv": "CSV",
};

/** The three conceptual first-run steps, in the order a new user meets them. */
const ONBOARDING_STEPS = [
  {
    icon: Upload,
    title: "Add",
    body: "Import PMIDs, DOIs or titles, upload a reference file, or enter a paper manually.",
  },
  {
    icon: FolderOpen,
    title: "Organize",
    body: "Group papers into Projects and label them with Tags from the left sidebar.",
  },
  {
    icon: FlaskConical,
    title: "Refine",
    body: "As the library grows, curate the Keyword and Study Type pools to sharpen filtering.",
  },
] as const;

export interface PaperListEmptyStateProps {
  /**
   * Papers the signed-in user owns, independent of the active filters. This —
   * not the length of the currently visible page — is what separates a genuinely
   * empty account from a filter that happens to match nothing.
   */
  totalCount: number;
  /** Whether any search/filter is currently narrowing the list. */
  hasActiveFilters: boolean;
  /** Opens the existing AddPaperDialog. No second import path is introduced. */
  onAddPapers: () => void;
  /** Dashboard's `handleClearFilters` (also clears the loaded-preset pointer). */
  onClearFilters: () => void;
}

/**
 * What `PaperList` renders instead of the table when nothing is visible.
 *
 * Three distinct states, because "no rows on screen" has three different
 * meanings and the old single `No papers yet` message was wrong for two of them:
 *
 *  - `totalCount === 0` — a genuinely empty library. This is the PFA-C06
 *    first-run surface: what to do first, which import methods exist, and where
 *    the organization tools live.
 *  - `totalCount > 0 && hasActiveFilters` — the user owns papers but the current
 *    search/filters match none of them. Offers the existing clear-filters action
 *    and deliberately shows no first-run coaching.
 *  - `totalCount > 0 && !hasActiveFilters` — defensive fallback. Should not
 *    normally happen; renders a neutral message rather than claiming the library
 *    is empty when it is not.
 *
 * Onboarding is derived entirely from live library state, so it disappears on
 * the first import and reappears if the library is later emptied. There is no
 * persisted flag, tour, or dismissal to keep in sync.
 */
export function PaperListEmptyState({
  totalCount,
  hasActiveFilters,
  onAddPapers,
  onClearFilters,
}: PaperListEmptyStateProps) {
  // ── States B and C: the library is not empty, this view just has no rows ──
  if (totalCount > 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <SearchX className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-lg font-semibold">
          {hasActiveFilters
            ? "No papers match your current filters"
            : "No papers to display"}
        </h2>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          {hasActiveFilters
            ? "Try adjusting your search or filters."
            : "Your library has papers, but none are being shown right now."}
        </p>
        {hasActiveFilters && (
          <Button variant="outline" className="mt-4" onClick={onClearFilters}>
            Clear filters
          </Button>
        )}
      </div>
    );
  }

  // ── State A: genuinely empty library — the PFA-C06 first-run surface ──
  return (
    <div className="flex flex-1 items-start justify-center overflow-auto px-4 py-10">
      <div className="w-full max-w-2xl rounded-lg border bg-card p-6 text-card-foreground sm:p-8">
        <div className="flex flex-col items-center text-center">
          <BookOpen className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-xl font-semibold">Build your research library</h2>
          <p className="mt-2 max-w-lg text-sm text-muted-foreground">
            Start by adding papers with PMIDs, DOIs, or titles, importing a
            reference file, or entering a paper manually.
          </p>
          <p className="mt-2 max-w-lg text-sm text-muted-foreground">
            Reference files:{" "}
            {ACCEPTED_FILE_EXTENSIONS.map((ext) => `${FILE_FORMAT_LABELS[ext]} (${ext})`).join(", ")}
            .
          </p>
          <Button className="mt-5" onClick={onAddPapers}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            Add your first papers
          </Button>
        </div>

        <ol className="mt-8 grid gap-5 border-t pt-6 sm:grid-cols-3">
          {ONBOARDING_STEPS.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex flex-col items-center gap-2 text-center sm:items-start sm:text-left">
              <Icon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              <h3 className="text-sm font-medium">{title}</h3>
              <p className="text-sm text-muted-foreground">{body}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
