import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

/** Minimal shape the filter needs from a Project or Tag. */
export interface EntityFilterItem {
  id: string;
  name: string;
  /** Optional swatch color (Projects/Tags always have one, but keep it optional). */
  color?: string;
}

interface SearchableEntityMultiFilterProps {
  /** Full list of selectable entities (already sorted by the caller). */
  items: EntityFilterItem[];
  /** Currently-selected entity IDs. Order-insensitive; may be empty. */
  selectedIds: string[];
  /** Toggle a single entity on/off. Keeps the popover open. */
  onToggle: (id: string) => void;
  /** Clear the entire selection for this category. */
  onClear: () => void;
  /** Trigger text when nothing is selected, e.g. "All Projects". */
  allLabel: string;
  /** Singular noun for the count pill, e.g. "Project". */
  nounSingular: string;
  /** Plural noun for the count pill, e.g. "Projects". */
  nounPlural: string;
  /** Placeholder for the in-dropdown search box. */
  searchPlaceholder: string;
  /** Message shown when the search matches nothing, e.g. "No projects found." */
  emptyMessage: string;
  /** Accessible name for the trigger button (announced to screen readers). */
  ariaLabel: string;
  /** Optional extra classes for the trigger button. */
  className?: string;
}

/**
 * A searchable, accessible multi-select filter for a single entity category
 * (Projects or Tags) on the Papers dashboard.
 *
 * Behavior:
 *  • zero selected  → trigger shows `allLabel` ("All Projects").
 *  • one selected   → trigger shows the single name (truncated, full name in
 *    `title` + `aria-label`), on one line, never overflowing the fixed trigger.
 *  • many selected  → trigger shows a compact `N Projects` count.
 *
 * Selection semantics are OR *within* this category — the parent intersects the
 * resulting paper-ID set with the other filter categories (AND across).
 *
 * Search is case-insensitive substring matching, whitespace-tolerant, computed
 * here (`shouldFilter={false}` on `Command`) so behavior is deterministic and
 * unit-testable rather than dependent on cmdk's internal fuzzy scoring. The
 * popover stays open across selections, and the search box resets on close.
 */
export function SearchableEntityMultiFilter({
  items,
  selectedIds,
  onToggle,
  onClear,
  allLabel,
  nounSingular,
  nounPlural,
  searchPlaceholder,
  emptyMessage,
  ariaLabel,
  className,
}: SearchableEntityMultiFilterProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.name.toLowerCase().includes(q));
  }, [items, search]);

  /** The single selected entity, when exactly one is selected. */
  const singleSelected = useMemo(
    () => (selectedIds.length === 1 ? items.find((i) => i.id === selectedIds[0]) ?? null : null),
    [selectedIds, items],
  );

  // Trigger label + accessible name.
  const count = selectedIds.length;
  let triggerContent: React.ReactNode;
  let accessibleName: string;
  if (count === 0) {
    triggerContent = <span className="truncate">{allLabel}</span>;
    accessibleName = `${ariaLabel}. ${allLabel}`;
  } else if (count === 1 && singleSelected) {
    triggerContent = (
      <span className="flex items-center gap-1.5 min-w-0">
        {singleSelected.color && (
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: singleSelected.color }}
          />
        )}
        <span className="truncate" title={singleSelected.name}>
          {singleSelected.name}
        </span>
      </span>
    );
    accessibleName = `${ariaLabel}. ${singleSelected.name} selected`;
  } else {
    // One selected but not yet loaded into `items`, or many selected.
    const label = `${count} ${count === 1 ? nounSingular : nounPlural}`;
    triggerContent = <span className="truncate">{label}</span>;
    accessibleName = `${ariaLabel}. ${label} selected`;
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={accessibleName}
          className={cn("w-[180px] justify-between font-normal min-w-0", className)}
        >
          <span className="flex items-center gap-1.5 min-w-0 overflow-hidden">
            {triggerContent}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[16rem] max-w-[calc(100vw-2rem)] p-0 bg-popover"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={searchPlaceholder}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            {filteredItems.length > 0 && (
              <CommandGroup>
                {filteredItems.map((item) => {
                  const isSelected = selectedSet.has(item.id);
                  return (
                    <CommandItem
                      key={item.id}
                      value={item.id}
                      // Keep the search text so the user can keep selecting
                      // multiple matches without the list resetting.
                      onSelect={() => onToggle(item.id)}
                      aria-selected={isSelected}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4 shrink-0",
                          isSelected ? "opacity-100" : "opacity-0",
                        )}
                      />
                      {item.color && (
                        <span
                          className="w-2 h-2 rounded-full mr-2 shrink-0"
                          style={{ backgroundColor: item.color }}
                        />
                      )}
                      <span className="truncate" title={item.name}>
                        {item.name}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
          {count > 0 && (
            <div className="border-t p-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-center"
                onClick={onClear}
              >
                Clear{" "}
                {count === 1 ? nounSingular.toLowerCase() : nounPlural.toLowerCase()}
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
