import { supabase } from "@/integrations/supabase/client";
import { createEvidenceLifecycleClient } from "@/lib/evidence/lifecycleClient";

/**
 * The one study-record write client of the application (EVIDENCE-RECORDS-001C1):
 * PR-B's typed adapter over the shared Supabase client. Every Study Record
 * write goes through it — and so through its seven literal RPC names, its
 * prepared-request check and its response validation. Creating it calls
 * nothing.
 */
export const studyRecordClient = createEvidenceLifecycleClient(supabase);

/** A new request id for one user action. A retry of that action reuses it. */
export function newStudyRecordRequestId(): string {
  return crypto.randomUUID();
}
