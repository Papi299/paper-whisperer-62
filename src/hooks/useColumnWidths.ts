import { useState, useEffect, useCallback } from "react";
import { ColumnId } from "./useColumnVisibility";

export interface ColumnWidths {
  [key: string]: number;
}

const STORAGE_KEY = "paper-index-column-widths";

const DEFAULT_WIDTHS: ColumnWidths = {
  checkbox: 40,
  title: 300,
  authors: 150,
  year: 80,
  journal: 120,
  studyType: 120,
  tags: 150,
  keywords: 200,
  links: 120,
};

/**
 * Clamp bounds for a column width, in px. Exported so the resize control can
 * advertise the same `aria-valuemin` / `aria-valuemax` that `setColumnWidth`
 * actually enforces — the keyboard and pointer paths must not disagree about
 * where a column stops shrinking or growing.
 */
export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 600;

const MIN_WIDTH = MIN_COLUMN_WIDTH;
const MAX_WIDTH = MAX_COLUMN_WIDTH;

export function useColumnWidths() {
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        return { ...DEFAULT_WIDTHS, ...JSON.parse(stored) };
      } catch {
        return DEFAULT_WIDTHS;
      }
    }
    return DEFAULT_WIDTHS;
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(columnWidths));
  }, [columnWidths]);

  const setColumnWidth = useCallback((columnId: ColumnId, width: number) => {
    const clampedWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
    setColumnWidths((prev) => ({
      ...prev,
      [columnId]: clampedWidth,
    }));
  }, []);

  const getColumnWidth = useCallback(
    (columnId: ColumnId) => columnWidths[columnId] || DEFAULT_WIDTHS[columnId] || 150,
    [columnWidths]
  );

  const resetWidths = useCallback(() => {
    setColumnWidths(DEFAULT_WIDTHS);
  }, []);

  return {
    columnWidths,
    setColumnWidth,
    getColumnWidth,
    resetWidths,
  };
}
