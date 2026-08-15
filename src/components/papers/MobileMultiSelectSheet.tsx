import * as React from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useVisualViewport } from "@/hooks/useVisualViewport";

/** One selectable row. `color` is a decorative swatch (Projects/Tags). */
export interface MobileMultiSelectOption {
  value: string;
  label: string;
  color?: string;
}

interface MobileMultiSelectSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sheet heading, e.g. "Select projects". Receives focus when the sheet opens. */
  title: string;
  description?: string;
  /** Options in the caller's own order — this component never re-sorts them. */
  options: MobileMultiSelectOption[];
  selectedValues: string[];
  onToggle: (value: string) => void;
  /** Clears only this category. Omit to render no clear action. */
  onClear?: () => void;
  clearLabel?: string;
  searchPlaceholder: string;
  /** Accessible name for the search field — stable regardless of placeholder. */
  searchLabel: string;
  emptyMessage: string;
  /**
   * Extra controls between the search field and the option list, for rules this
   * component deliberately knows nothing about (the Filters Any/All mode).
   */
  headerExtra?: React.ReactNode;
  /**
   * The control that opened this sheet. Focus returns to it explicitly on close
   * rather than via `document.activeElement`, because Safari — the owner's
   * browser — does not reliably focus a `<button>` when it is tapped.
   */
  triggerRef: React.RefObject<HTMLElement>;
}

/**
 * The mobile presentation for every searchable multi-select on the dashboard.
 *
 * On a phone the desktop anchored `Popover` fails in three compounding ways,
 * all of them reported from Production: Radix autofocuses the first field inside
 * it — the search box — so the software keyboard opens merely because the user
 * asked to *see* a list; the panel is anchored to a trigger that is usually near
 * the bottom of an already-open Dialog/Sheet, so it opens into the few pixels
 * left there; and once the keyboard covers that region the remaining options
 * cannot be reached at all.
 *
 * This replaces the anchored panel below 768px with a surface that owns the
 * bottom of the screen instead of being squeezed into it:
 *
 *  • **Opening never summons the keyboard.** `onOpenAutoFocus` is prevented and
 *    focus is placed on the heading, so the list is immediately readable and
 *    scrollable. The keyboard appears only when the user taps Search — the
 *    distinction is "opening a selector" vs. "asking to type", and the search
 *    field itself is untouched and fully usable.
 *  • **Height follows the visible viewport**, not `100vh`, and the sheet lifts
 *    off the bottom edge by whatever the keyboard covers, so the footer and the
 *    end of the list stay reachable while typing.
 *  • **The list is a plain overflow container**, not a `ScrollArea` or cmdk
 *    `CommandList`, so a touch pan is handled natively by the browser.
 *
 * Selection stays live (no draft/Apply copy) and the sheet stays open across
 * selections, because these are multi-selects; the user closes it explicitly.
 * The search query is local and resets on close, matching the dropdown it
 * replaces — it is never persisted anywhere.
 */
export function MobileMultiSelectSheet({
  open,
  onOpenChange,
  title,
  description,
  options,
  selectedValues,
  onToggle,
  onClear,
  clearLabel = "Clear",
  searchPlaceholder,
  searchLabel,
  emptyMessage,
  headerExtra,
  triggerRef,
}: MobileMultiSelectSheetProps) {
  const [search, setSearch] = React.useState("");
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const { height, bottomInset } = useVisualViewport(open);

  const selectedSet = React.useMemo(() => new Set(selectedValues), [selectedValues]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => option.label.toLowerCase().includes(q));
  }, [options, search]);

  const handleOpenChange = (next: boolean) => {
    if (!next) setSearch("");
    onOpenChange(next);
  };

  // Leave the parent surface visibly behind the sheet rather than replacing it,
  // so closing returns the user to the context they were configuring.
  const maxHeight = height > 0 ? Math.round(height * 0.85) : undefined;

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        // `z-[60]` puts this above the parent Dialog/Sheet's own `z-50` content
        // explicitly, rather than relying on the child portal happening to be
        // appended later in the DOM. Scoped to this component — no global
        // Dialog/Sheet layering is changed.
        className="z-[60] flex flex-col gap-0 rounded-t-xl p-0"
        style={{ maxHeight, bottom: bottomInset }}
        onOpenAutoFocus={(event) => {
          // The whole point: opening a selector is not a request to type.
          event.preventDefault();
          headingRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <SheetHeader className="shrink-0 space-y-1 border-b px-4 py-3 pr-12 text-left">
          {/* tabIndex -1 makes the heading a deliberate programmatic focus
              target: it is announced on open and is not a text field. */}
          <SheetTitle ref={headingRef} tabIndex={-1} className="text-base outline-none">
            {title}
          </SheetTitle>
          <SheetDescription className="text-xs">
            {description ?? "Tap Search to filter. Selecting keeps this open."}
          </SheetDescription>
        </SheetHeader>

        <div className="shrink-0 space-y-2 border-b px-4 py-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchLabel}
              className="h-10 pl-8"
            />
          </div>
          {headerExtra}
        </div>

        {/* A native overflow container: `overscroll-contain` keeps a flick from
            chaining into the parent sheet once this list hits its end. */}
        <div
          data-testid="mobile-selector-options"
          className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-2 py-2"
        >
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((option) => {
                const isSelected = selectedSet.has(option.value);
                return (
                  <li key={option.value}>
                    {/* One control per row: a full-width ARIA checkbox. A
                        `<label>` wrapping a Radix Checkbox would give the row
                        two overlapping hit targets; this gives a thumb the whole
                        row and exactly one toggle. */}
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isSelected}
                      onClick={() => onToggle(option.value)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left text-sm",
                        "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isSelected && "bg-accent/50",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded border",
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-input",
                        )}
                      >
                        {isSelected && <Check className="h-3.5 w-3.5" />}
                      </span>
                      {option.color && (
                        <span
                          aria-hidden="true"
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: option.color }}
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div
          className="flex shrink-0 items-center gap-2 border-t px-4 py-3"
          // Keep Done clear of the iPhone home indicator without padding the
          // control out on every other device.
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
        >
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {selectedValues.length} selected
          </span>
          {onClear && selectedValues.length > 0 && (
            <Button variant="outline" size="sm" onClick={onClear}>
              {clearLabel}
            </Button>
          )}
          <Button size="sm" className="ml-auto" onClick={() => handleOpenChange(false)}>
            Done
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
