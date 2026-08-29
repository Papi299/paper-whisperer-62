import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { accountExportStatusText } from "@/lib/accountExport/downloadAccountExport";
import type { AccountExportProgress } from "@/lib/accountExport/types";

interface AccountDataSectionProps {
  onExport: () => void;
  isExporting: boolean;
  progress: AccountExportProgress | null;
  /** False during an auth transition; the action stays disabled. */
  canExport: boolean;
}

/**
 * Account → Account data (PFA-C02).
 *
 * Rendered by `AccountDialog`; it lived under Settings until the account
 * actions were split out of it. The file stays here so the move costs no
 * rename churn in the history and the tests that pin it.
 *
 * A read-only, user-initiated, local download of the account's own data. It is
 * not an email export, not a background job, and not a commercial feature —
 * there is no upgrade, checkout, or paywall path here. It is also not account
 * deletion: nothing in this section destroys data, so it carries no
 * destructive-style confirmation — that is PFA-C04, the separate Danger zone
 * below it.
 *
 * While a run is in progress the button is disabled and reports a bounded
 * stage — preparing, per-attachment progress, then archiving — rather than an
 * indefinite spinner, and the status is text as well as motion.
 */
export function AccountDataSection({
  onExport,
  isExporting,
  progress,
  canExport,
}: AccountDataSectionProps) {
  return (
    <div className="space-y-2 border-t pt-4">
      <div className="flex items-center gap-2">
        <Download className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-medium">Account data</h3>
      </div>

      <p className="text-xs text-muted-foreground">
        Download a copy of your Paperlume library, notes, projects, tags, saved
        searches, keyword and study-type pools, settings, and attachments as a
        single ZIP archive. API keys and credentials are never included.
      </p>

      <Button
        variant="outline"
        size="sm"
        onClick={onExport}
        disabled={isExporting || !canExport}
        aria-busy={isExporting}
      >
        {isExporting ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="mr-1 h-4 w-4" aria-hidden="true" />
        )}
        Export account data
      </Button>

      {isExporting && (
        <p className="text-xs text-muted-foreground tabular-nums" role="status">
          {accountExportStatusText(progress)}
        </p>
      )}
    </div>
  );
}
