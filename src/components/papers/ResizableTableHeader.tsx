import { useRef, useCallback, ReactNode } from "react";
import { TableHead } from "@/components/ui/table";
import { ColumnId } from "@/hooks/useColumnVisibility";
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

  const handleClick = useCallback(() => {
    if (sortable && onSort) {
      onSort(columnId);
    }
  }, [sortable, onSort, columnId]);

  return (
    <TableHead
      ref={headerRef}
      className={cn("relative select-none border-r border-border", sortable && "cursor-pointer hover:bg-muted/50", className)}
      style={{ width: `${width}px`, minWidth: `${width}px`, maxWidth: `${width}px` }}
      onClick={handleClick}
    >
      {children || (
        <div className="flex items-center gap-1 pr-3">
          <span className="truncate">{label}</span>
          {sortable && sortDirection === "asc" && <ArrowUp className="h-3 w-3 shrink-0" />}
          {sortable && sortDirection === "desc" && <ArrowDown className="h-3 w-3 shrink-0" />}
        </div>
      )}
      <div
        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize bg-border hover:bg-primary/70 active:bg-primary transition-colors"
        onMouseDown={(e) => {
          e.stopPropagation();
          handleMouseDown(e);
        }}
      />
    </TableHead>
  );
}
