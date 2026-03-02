import { useRef, useCallback, ReactNode } from "react";
import { TableHead } from "@/components/ui/table";
import { ColumnId } from "@/hooks/useColumnVisibility";
import { cn } from "@/lib/utils";

interface ResizableTableHeaderProps {
  columnId: ColumnId;
  label: string;
  width: number;
  onResize: (columnId: ColumnId, width: number) => void;
  className?: string;
  children?: ReactNode;
}

export function ResizableTableHeader({
  columnId,
  label,
  width,
  onResize,
  className,
  children,
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

  return (
    <TableHead
      ref={headerRef}
      className={cn("relative select-none border-r border-border", className)}
      style={{ width: `${width}px`, minWidth: `${width}px`, maxWidth: `${width}px` }}
    >
      {children || <div className="truncate pr-3">{label}</div>}
      <div
        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize bg-border hover:bg-primary/70 active:bg-primary transition-colors"
        onMouseDown={handleMouseDown}
      />
    </TableHead>
  );
}
