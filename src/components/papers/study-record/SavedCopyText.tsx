import { forwardRef, useMemo } from "react";
import { highlightSegments, type TextRange } from "./sourcePaneModel";

interface SavedCopyTextProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The saved copy's exact text. */
  readonly text: string;
  /** Passages to mark, as string indices of `text`. */
  readonly ranges: readonly TextRange[];
}

/**
 * A saved copy of an abstract as plain text nodes — never HTML — in
 * `white-space: pre-wrap`, so every character, space and line break shows as
 * saved. Marked passages carry an underline as well as a colour.
 */
export const SavedCopyText = forwardRef<HTMLDivElement, SavedCopyTextProps>(function SavedCopyText({ text, ranges, className, ...rest }, ref) {
  const segments = useMemo(() => highlightSegments(text, ranges), [text, ranges]);
  return (
    <div
      ref={ref}
      className={`whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-sm leading-relaxed [overflow-wrap:anywhere]${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {segments.map((segment, index) =>
        segment.highlighted ? (
          <mark key={index} className="bg-amber-100 underline decoration-dotted underline-offset-2 dark:bg-amber-900/50">
            {segment.text}
          </mark>
        ) : (
          segment.text
        ),
      )}
    </div>
  );
});
