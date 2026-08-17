import { ReactNode } from "react";
import { resolveOverlappingMatches, scanLexicalTerms } from "@/lib/lexicalTerms";

/**
 * Renders abstract text with Keyword Pool terms highlighted.
 *
 * Boundary semantics are not decided here: `scanLexicalTerms` owns the one
 * definition of "this pool term occurs here", shared with the keyword
 * extraction path, so a term can never highlight inside an unrelated word
 * (`CT` in `effects`) while counting as absent for enrichment. Overlaps are
 * resolved before rendering so no span is ever wrapped twice.
 *
 * Highlighting is purely lexical. Suppressing negated occurrences is the
 * extraction layer's job — a visible term stays visible.
 *
 * Every rendered segment is sliced straight out of `text`, so the abstract the
 * user sees is byte-for-byte the original despite matching being case-,
 * dash- and whitespace-insensitive.
 */
export function HighlightedAbstract({ text, keywords }: { text: string; keywords: string[] }) {
  if (keywords.length === 0) return <>{text}</>;

  const matches = resolveOverlappingMatches(scanLexicalTerms(text, keywords).matches);
  if (matches.length === 0) return <>{text}</>;

  const parts: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of matches) {
    if (match.start > lastIndex) {
      parts.push(text.slice(lastIndex, match.start));
    }
    parts.push(
      <mark key={match.start} className="bg-yellow-200/60 rounded-sm px-0.5">
        {match.matchedText}
      </mark>
    );
    lastIndex = match.end;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
}
