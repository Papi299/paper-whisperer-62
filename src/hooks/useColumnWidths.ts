import { useState, useEffect, useCallback } from "react";
import { ColumnId } from "./useColumnVisibility";

export interface ColumnWidths {
  [key: string]: number;
}

const STORAGE_KEY = "paper-index-column-widths";

const DEFAULT_WIDTHS: ColumnWidths = {
  title: 300,
  authors: 150,
  year: 80,
  journal: 120,
  studyType: 120,
  tags: 150,
  keywords: 200,
  links: 120,
};

const MIN_WIDTH = 60;
const MAX_WIDTH = 600;

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
