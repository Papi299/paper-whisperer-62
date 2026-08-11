import { useCallback, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { buildAccountExportArchive } from "@/lib/accountExport/buildAccountExportArchive";
import {
  accountExportFileName,
  triggerArchiveDownload,
} from "@/lib/accountExport/downloadAccountExport";
import { fetchAccountExportData } from "@/lib/accountExport/fetchAccountExportData";
import { createAttachmentDownloader } from "@/lib/accountExport/fetchAttachmentBinaries";
import {
  AccountExportError,
  type AccountExportProgress,
} from "@/lib/accountExport/types";

/**
 * Orchestration + UI state for PFA-C02 full account export.
 *
 * The hook owns only sequencing and presentation: the read layer, the archive
 * builder and the download trigger are separate pure-ish modules, so Settings
 * never becomes a data-export implementation.
 *
 * Semantics:
 *  - **Read-only.** Nothing here writes a row, an object, or a preference.
 *  - **Complete-or-fail.** Any failed category read, any failed attachment
 *    download, or any count that does not reconcile aborts the run. No archive
 *    is downloaded and no success toast is shown on the failure path.
 *  - **Single-flight.** A run in progress rejects further starts, so a double
 *    click cannot produce two archives or two downloads.
 *  - **Safe errors.** Only the high-level, user-safe `AccountExportError`
 *    message reaches the toast; raw Postgres/Storage/session detail stays on
 *    the error's `cause`.
 */

const GENERIC_FAILURE_MESSAGE = "Could not export your account data.";

export interface UseAccountExportResult {
  exportAccountData: () => Promise<void>;
  isExporting: boolean;
  progress: AccountExportProgress | null;
  /** False during an auth transition — the button must not attempt a run. */
  canExport: boolean;
}

export function useAccountExport(userId: string | null | undefined): UseAccountExportResult {
  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<AccountExportProgress | null>(null);
  // A ref, not the state flag: two clicks in the same tick would both observe
  // the pre-update state value and both start a run.
  const runningRef = useRef(false);

  const exportAccountData = useCallback(async () => {
    if (!userId || runningRef.current) return;

    runningRef.current = true;
    setIsExporting(true);
    setProgress({ stage: "collecting" });

    // One instant for the manifest and the filename, so they always agree.
    const generatedAt = new Date();

    try {
      const data = await fetchAccountExportData(userId);

      const { blob } = await buildAccountExportArchive({
        data,
        userId,
        generatedAt,
        downloadAttachment: createAttachmentDownloader(userId),
        onProgress: setProgress,
      });

      triggerArchiveDownload(blob, accountExportFileName(generatedAt));

      toast({
        title: "Account data exported",
        description: "Your archive has been downloaded.",
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description:
          error instanceof AccountExportError ? error.message : GENERIC_FAILURE_MESSAGE,
        variant: "destructive",
      });
    } finally {
      runningRef.current = false;
      setIsExporting(false);
      setProgress(null);
    }
  }, [userId, toast]);

  return {
    exportAccountData,
    isExporting,
    progress,
    canExport: !!userId,
  };
}
