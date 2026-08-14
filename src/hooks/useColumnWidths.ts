import { useState, useEffect, useCallback } from "react";
import { ColumnId } from "./useColumnVisibility";
import {
  DEFAULT_COLUMN_WIDTHS,
  clampColumnWidth,
  getDefaultColumnWidth,
} from "@/lib/columnWidths";

export interface ColumnWidths {
  [key: string]: number;
}

const STORAGE_KEY = "paper-index-column-widths";

export function useColumnWidths() {
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        return { ...DEFAULT_COLUMN_WIDTHS, ...JSON.parse(stored) };
      } catch {
        return DEFAULT_COLUMN_WIDTHS;
      }
    }
    return DEFAULT_COLUMN_WIDTHS;
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(columnWidths));
  }, [columnWidths]);

  // Clamped per column, using the same bounds the resize separators advertise
  // via aria-valuemin / aria-valuemax. See src/lib/columnWidths.ts.
  const setColumnWidth = useCallback((columnId: ColumnId, width: number) => {
    setColumnWidths((prev) => ({
      ...prev,
      [columnId]: clampColumnWidth(columnId, width),
    }));
  }, []);

  const getColumnWidth = useCallback(
    (columnId: ColumnId) => columnWidths[columnId] || getDefaultColumnWidth(columnId),
    [columnWidths]
  );

  const resetWidths = useCallback(() => {
    setColumnWidths(DEFAULT_COLUMN_WIDTHS);
  }, []);

  return {
    columnWidths,
    setColumnWidth,
    getColumnWidth,
    resetWidths,
  };
}
