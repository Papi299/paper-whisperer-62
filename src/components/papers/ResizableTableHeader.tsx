import { useRef, useCallback, ReactNode } from "react";
import { TableHead } from "@/components/ui/table";
import { ColumnId } from "@/hooks/useColumnVisibility";
import { getColumnBounds, nextWidthForResizeKey } from "@/lib/columnWidths";
import { cn } from "@/lib/utils";
import { ArrowUp, ArrowDown } from "lucide-react";

export type SortDirection = "asc" | "desc";

interface ResizableTableHeaderProps {
  columnId: ColumnId;
  label: string;
  width: number;
  onResize: (columnId: ColumnId, width: number) => void;
  className?: string;
  children?: ReactNode;
  sortable?: boolean;
  sortDirection?: SortDirection | null;
  onSort?: (columnId: ColumnId) => void;
}

export function ResizableTableHeader({
  columnId,
  label,
  width,
  onResize,
  className,
  children,
  sortable,
  sortDirection,
  onSort,
}: ResizableTableHeaderProps) {
  const headerRef = useRef<HTMLTableCellElement>(null);
  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = width;

      const handleMouseMove = (e: MouseEvent) => {
        const delta = e.clientX - startXRef.current;
        const newWidth = startWidthRef.current + delta;
        onResize(columnId, newWidth);
      };

      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [columnId, onResize, width]
  );

  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const next = nextWidthForResizeKey(e.key, e.shiftKey, width, columnId);
      if (next === null) return;
      // Claim the key so it neither scrolls the table's horizontal scroll
      // container nor reaches the sort control in this same header.
      e.preventDefault();
      e.stopPropagation();
      onResize(columnId, next);
    },
    [columnId, onResize, width]
  );

  const handleSort = useCallback(() => {
    if (sortable && onSort) {
      onSort(columnId);
    }
  }, [sortable, onSort, columnId]);

  // `aria-sort` belongs on the column header itself; the arrow glyph is left
  // decorative so the direction is announced once, not twice.
  // Advertised bounds are the bounds actually enforced, per column — the
  // selection column's floor is lower than a text column's.
  const bounds = getColumnBounds(columnId);

  const ariaSort = sortable
    ? sortDirection === "asc"
      ? "ascending"
      : sortDirection === "desc"
        ? "descending"
        : "none"
    : undefined;

  return (
    <TableHead
      ref={headerRef}
      aria-sort={ariaSort}
      className={cn("relative select-none border-r border-border", className)}
      style={{ width: `${width}px`, minWidth: `${width}px`, maxWidth: `${width}px` }}
    >
      {children ??
        (sortable ? (
          // A real button, so sorting is reachable by Tab + Enter/Space rather
          // than only by a pointer click on the `<th>`.
          <button
            type="button"
            onClick={handleSort}
            className="flex w-full items-center gap-1 pr-3 text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            <span className="truncate">{label}</span>
            {sortDirection === "asc" && <ArrowUp className="h-3 w-3 shrink-0" aria-hidden="true" />}
            {sortDirection === "desc" && <ArrowDown className="h-3 w-3 shrink-0" aria-hidden="true" />}
          </button>
        ) : (
          <div className="flex items-center gap-1 pr-3">
            <span className="truncate">{label}</span>
          </div>
        ))}
      <div
        role="separator"
        aria-orientation="vertical"
        // `label` is empty for the selection column, which still resizes.
        aria-label={`Resize ${label || columnId} column`}
        aria-valuenow={width}
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        tabIndex={0}
        onKeyDown={handleResizeKeyDown}
        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize bg-border hover:bg-primary/70 active:bg-primary transition-colors focus-visible:outline-none focus-visible:bg-primary focus-visible:ring-2 focus-visible:ring-ring"
        onMouseDown={(e) => {
          e.stopPropagation();
          handleMouseDown(e);
        }}
      />
    </TableHead>
  );
}
