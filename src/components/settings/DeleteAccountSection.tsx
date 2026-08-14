import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DeleteAccountDialog } from "@/components/settings/DeleteAccountDialog";

interface DeleteAccountSectionProps {
  onDelete: (confirmation: string) => void;
  isDeleting: boolean;
  /** False during an auth transition; the destructive action stays disabled. */
  canDelete: boolean;
}

/**
 * Settings → Danger zone (PFA-C04).
 *
 * Visually and structurally separated from the sections above it so the
 * destructive action can never be mistaken for the adjacent, read-only
 * **Account data** export. The section itself performs no deletion: clicking
 * only opens the confirmation dialog, which is where the typed phrase gate and
 * the actual invocation live.
 */
export function DeleteAccountSection({
  onDelete,
  isDeleting,
  canDelete,
}: DeleteAccountSectionProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    // A <section> so "what the Danger zone contains" is an answerable question
    // in the DOM rather than a visual impression — nothing that is not account
    // deletion may live inside this element.
    <section className="space-y-2 border-t border-destructive/40 pt-4">
      <div className="flex items-center gap-2">
        <TriangleAlert className="h-4 w-4 text-destructive" aria-hidden="true" />
        <h3 className="text-sm font-medium text-destructive">Danger zone</h3>
      </div>

      <p className="text-sm font-medium">Delete account</p>

      <p className="text-xs text-muted-foreground">
        Permanently delete your Paperlume account, library data, settings, and
        attachments. This cannot be undone. We recommend exporting your account
        data first.
      </p>

      <Button
        variant="destructive"
        size="sm"
        disabled={!canDelete || isDeleting}
        onClick={() => setDialogOpen(true)}
      >
        Delete account
      </Button>

      <DeleteAccountDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConfirm={onDelete}
        isDeleting={isDeleting}
      />
    </section>
  );
}
