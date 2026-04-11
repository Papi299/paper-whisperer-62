import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

/**
 * React hook for managing the PubMed API key stored server-side in the
 * profiles table. Replaces the old localStorage-based approach.
 */
export function useSettings() {
  const { user } = useAuth();
  const [pubmedApiKey, setPubmedApiKeyState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch key from server on mount / user change
  useEffect(() => {
    if (!user) {
      setPubmedApiKeyState(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("pubmed_api_key")
        .eq("user_id", user.id)
        .single();

      if (!cancelled) {
        if (!error && data) {
          setPubmedApiKeyState(data.pubmed_api_key ?? null);
        }
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [user]);

  const setPubmedApiKey = useCallback(async (key: string) => {
    if (!user) return;
    const trimmed = key.trim();
    if (!trimmed) return;

    const { error } = await supabase
      .from("profiles")
      .update({ pubmed_api_key: trimmed })
      .eq("user_id", user.id);

    if (!error) {
      setPubmedApiKeyState(trimmed);
    }
    return error ?? undefined;
  }, [user]);

  const clearPubmedApiKey = useCallback(async () => {
    if (!user) return;

    const { error } = await supabase
      .from("profiles")
      .update({ pubmed_api_key: null })
      .eq("user_id", user.id);

    if (!error) {
      setPubmedApiKeyState(null);
    }
    return error ?? undefined;
  }, [user]);

  return {
    settings: { pubmedApiKey },
    loading,
    setPubmedApiKey,
    clearPubmedApiKey,
  };
}
