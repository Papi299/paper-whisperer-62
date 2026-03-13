import { useState, useEffect, useCallback } from "react";

const SETTINGS_STORAGE_KEY = "paper-index-settings";

interface Settings {
  pubmedApiKey: string | null;
}

const DEFAULT_SETTINGS: Settings = {
  pubmedApiKey: null,
};

/**
 * Plain (non-React) accessor for the PubMed API key.
 * Used by fetchPaperMetadataEdge.ts which runs outside React components.
 */
export function getPubmedApiKey(): string | null {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Settings;
    return parsed.pubmedApiKey || null;
  } catch {
    return null;
  }
}

/**
 * React hook for managing application settings persisted in localStorage.
 * Follows the same pattern as useColumnWidths / useColumnVisibility.
 */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(() => {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (stored) {
      try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
      } catch {
        return DEFAULT_SETTINGS;
      }
    }
    return DEFAULT_SETTINGS;
  });

  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const setPubmedApiKey = useCallback((key: string) => {
    setSettings((prev) => ({ ...prev, pubmedApiKey: key }));
  }, []);

  const clearPubmedApiKey = useCallback(() => {
    setSettings((prev) => ({ ...prev, pubmedApiKey: null }));
  }, []);

  return { settings, setPubmedApiKey, clearPubmedApiKey };
}
