import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Settings2 } from "lucide-react";
import { ColumnId, ColumnConfig } from "@/hooks/useColumnVisibility";

interface ColumnVisibilityDropdownProps {
  availableColumns: ColumnConfig[];
  visibleColumns: ColumnId[];
  onToggleColumn: (columnId: ColumnId) => void;
}

export function ColumnVisibilityDropdown({
  availableColumns,
  visibleColumns,
  onToggleColumn,
}: ColumnVisibilityDropdownProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings2 className="mr-2 h-4 w-4" />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48 bg-popover">
        <DropdownMenuLabel>Toggle Columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {availableColumns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={visibleColumns.includes(column.id)}
            onCheckedChange={() => onToggleColumn(column.id)}
            disabled={column.required}
          >
            {column.label}
            {column.required && (
              <span className="ml-1 text-xs text-muted-foreground">(required)</span>
            )}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
