import { useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { BarChart3, Download, Layers, Loader2 } from "lucide-react";
import { EXPORT_FORMAT_OPTIONS } from "@/lib/exportFormats";
import type { ExportFormat } from "@/hooks/useExportPapers";
import { ColumnId, ColumnConfig } from "@/hooks/useColumnVisibility";

interface MobileLibraryActionsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableColumns: ColumnConfig[];
  visibleColumns: ColumnId[];
  onToggleColumn: (columnId: ColumnId) => void;
  onFindDuplicates: () => void;
  onOpenAnalytics: () => void;
  onExport: (format: ExportFormat) => void;
  isExportReady?: boolean;
  isExporting?: boolean;
}

/** Section heading inside the sheet. */
function ActionSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The mobile "More" surface — the secondary library actions that used to sit
 * permanently in the toolbar and cost the paper table its viewport.
 *
 * Nothing was removed: Columns, Find Duplicates, Export and Analytics are all
 * here, one tap away, operating on exactly the same state and handlers the
 * desktop toolbar uses. Columns renders as a direct checkbox list rather than
 * nesting `ColumnVisibilityDropdown` inside a sheet, and Export as direct
 * format buttons rather than a nested dropdown — one state model, two
 * presentations, no second source of truth.
 */
export function MobileLibraryActionsSheet({
  open,
  onOpenChange,
  availableColumns,
  visibleColumns,
  onToggleColumn,
  onFindDuplicates,
  onOpenAnalytics,
  onExport,
  isExportReady,
  isExporting = false,
}: MobileLibraryActionsSheetProps) {
  const exportDisabled = !isExportReady || isExporting;

  /**
   * Actions that open a child overlay are deferred until this sheet has
   * actually finished closing.
   *
   * Opening one immediately would stack a second focus trap on the first and —
   * worse — the child would record its "opener" while that opener was a button
   * inside the closing sheet. Once this sheet unmounted that element would be
   * detached, leaving the child nowhere to return focus to, so focus fell to
   * `<body>`. This is the same defect PFA-C09 fixed for the navigation drawer,
   * and it is fixed the same way: park the action here and run it from Radix's
   * own `onCloseAutoFocus`, which fires at unmount — not from a guessed delay.
   *
   * By the time the child mounts, focus has been restored to the "More" trigger
   * in the Dashboard header: visible, connected, and still mounted when the
   * child later closes.
   */
  const pendingActionRef = useRef<(() => void) | null>(null);

  const deferUntilClosed = useCallback(
    (action: () => void) => {
      pendingActionRef.current = action;
      onOpenChange(false);
    },
    [onOpenChange],
  );

  const handleCloseAutoFocus = useCallback(() => {
    const pending = pendingActionRef.current;
    pendingActionRef.current = null;
    pending?.();
  }, []);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-[92vw] max-w-[26rem] flex-col gap-0 p-0 sm:max-w-[26rem]"
        onCloseAutoFocus={handleCloseAutoFocus}
      >
        <SheetHeader className="space-y-1 border-b px-4 py-4 text-left">
          <SheetTitle>Library actions</SheetTitle>
          <SheetDescription>
            Columns, duplicates, export and analytics for your library.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
          <ActionSection title="Tools">
            <div className="space-y-2">
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={() => deferUntilClosed(onFindDuplicates)}
              >
                <Layers className="mr-2 h-4 w-4" aria-hidden="true" />
                Find Duplicates
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={() => deferUntilClosed(onOpenAnalytics)}
              >
                <BarChart3 className="mr-2 h-4 w-4" aria-hidden="true" />
                Analytics &amp; Insights
              </Button>
            </div>
          </ActionSection>

          <ActionSection title="Export">
            <div className="space-y-2">
              {EXPORT_FORMAT_OPTIONS.map(({ format, label, Icon }) => (
                <Button
                  key={format}
                  variant="outline"
                  className="w-full justify-start"
                  disabled={exportDisabled}
                  title={exportDisabled ? (isExporting ? "Exporting…" : "Loading…") : undefined}
                  onClick={() => onExport(format)}
                >
                  {isExporting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Icon className="mr-2 h-4 w-4" aria-hidden="true" />
                  )}
                  {label}
                </Button>
              ))}
              {exportDisabled && !isExporting && (
                <p className="text-xs text-muted-foreground">
                  <Download className="mr-1 inline h-3 w-3" aria-hidden="true" />
                  Preparing your library for export…
                </p>
              )}
            </div>
          </ActionSection>

          <ActionSection title="Columns">
            <div className="space-y-1">
              {availableColumns.map((column) => {
                const inputId = `mobile-column-${column.id}`;
                return (
                  <div key={column.id} className="flex items-center gap-3 rounded-md py-1.5">
                    <Checkbox
                      id={inputId}
                      checked={visibleColumns.includes(column.id)}
                      disabled={column.required}
                      onCheckedChange={() => onToggleColumn(column.id)}
                    />
                    <Label htmlFor={inputId} className="flex-1 cursor-pointer font-normal">
                      {column.label}
                      {column.required && (
                        <span className="ml-1 text-xs text-muted-foreground">(required)</span>
                      )}
                    </Label>
                  </div>
                );
              })}
            </div>
          </ActionSection>
        </div>

        <div className="border-t px-4 py-3">
          <Button size="sm" className="w-full" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
