import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

interface PaperSearchFieldProps {
  value: string;
  onChange: (query: string) => void;
  /**
   * Element id, which also ties the `sr-only` label to the input. Only one
   * search field is ever mounted (desktop and mobile are composed
   * conditionally, not toggled with `display`), so the default is safe; the
   * prop exists so a second instance could never silently duplicate an id.
   */
  id?: string;
  className?: string;
}

/**
 * The library search input.
 *
 * Extracted so the desktop inline toolbar and the compact mobile header render
 * the same control against the same state instead of two drifting copies. On
 * mobile this stays permanently visible and is deliberately NOT moved into the
 * Filters sheet — searching is the highest-frequency action on a phone, and
 * hiding it behind an overlay would cost a tap on every single use.
 *
 * The visible design is label-less, so the accessible name is carried by an
 * `sr-only` <label> rather than the placeholder, which disappears as soon as
 * the user types.
 */
export function PaperSearchField({
  value,
  onChange,
  id = "paper-search",
  className,
}: PaperSearchFieldProps) {
  return (
    <div className={cn("relative", className)}>
      <Label htmlFor={id} className="sr-only">
        Search papers
      </Label>
      <Search
        className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        id={id}
        placeholder={'Search titles, authors, notes, keywords... Use "..." for exact phrase'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pl-9"
      />
    </div>
  );
}
