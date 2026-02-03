import { useState, useEffect } from "react";

export type ColumnId = 
  | "title"
  | "authors"
  | "year"
  | "journal"
  | "tags"
  | "keywords"
  | "studyType"
  | "links";

export interface ColumnConfig {
  id: ColumnId;
  label: string;
  defaultVisible: boolean;
  required?: boolean; // Cannot be hidden
}

export const AVAILABLE_COLUMNS: ColumnConfig[] = [
  { id: "title", label: "Title", defaultVisible: true, required: true },
  { id: "authors", label: "Authors", defaultVisible: true },
  { id: "year", label: "Year", defaultVisible: true },
  { id: "journal", label: "Journal", defaultVisible: true },
  { id: "studyType", label: "Study Type", defaultVisible: false },
  { id: "tags", label: "Tags", defaultVisible: true },
  { id: "keywords", label: "Keywords", defaultVisible: true },
  { id: "links", label: "Links", defaultVisible: true },
];

const STORAGE_KEY = "paper-index-visible-columns";

export function useColumnVisibility() {
  const [visibleColumns, setVisibleColumns] = useState<ColumnId[]>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch {
        return AVAILABLE_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id);
      }
    }
    return AVAILABLE_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id);
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(visibleColumns));
  }, [visibleColumns]);

  const toggleColumn = (columnId: ColumnId) => {
    const column = AVAILABLE_COLUMNS.find((c) => c.id === columnId);
    if (column?.required) return; // Cannot hide required columns

    setVisibleColumns((prev) =>
      prev.includes(columnId)
        ? prev.filter((id) => id !== columnId)
        : [...prev, columnId]
    );
  };

  const isColumnVisible = (columnId: ColumnId) => visibleColumns.includes(columnId);

  return {
    visibleColumns,
    toggleColumn,
    isColumnVisible,
    availableColumns: AVAILABLE_COLUMNS,
  };
}
