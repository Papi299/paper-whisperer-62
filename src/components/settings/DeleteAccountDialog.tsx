import { useEffect, useId, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ACCOUNT_DELETION_CONFIRMATION, isDeletionConfirmed } from "@/lib/accountDeletion";

interface DeleteAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (confirmation: string) => void;
  isDeleting: boolean;
}

/**
 * PFA-C04 final confirmation for permanent account deletion.
 *
 * Deliberately a typed-phrase gate rather than a single click or a checkbox:
 * the action is irreversible, spans the account's whole library, and has no
 * Paperlume-side recovery path. The user must reproduce
 * `DELETE MY ACCOUNT` exactly before the destructive button becomes usable.
 *
 * Accessibility: this is a Radix `AlertDialog`, so it is `role="alertdialog"`,
 * focus-trapped, labelled by its title and described by its body — and it is
 * separately addressable from the surrounding Settings `role="dialog"`. The
 * destructive consequence is carried by the heading, the body copy and the
 * button label, never by color alone.
 */
export function DeleteAccountDialog({
  open,
  onOpenChange,
  onConfirm,
  isDeleting,
}: DeleteAccountDialogProps) {
  const [phrase, setPhrase] = useState("");
  const inputId = useId();
  const hintId = useId();

  // A fresh dialog always starts un-armed: reopening never inherits a
  // previously typed phrase, so the gate cannot be satisfied by accident.
  useEffect(() => {
    if (open) setPhrase("");
  }, [open]);

  const confirmed = isDeletionConfirmed(phrase);
  const canSubmit = confirmed && !isDeleting;

  return (
    <AlertDialog open={open} onOpenChange={isDeleting ? undefined : onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <TriangleAlert className="h-5 w-5 text-destructive" aria-hidden="true" />
            Delete your account?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-left">
              <p>
                This permanently deletes your Paperlume account and all of its data:
                your papers and notes, projects, tags, saved searches, keyword,
                synonym, study-type and exclusion pools, your settings, and every
                file you have attached to a paper.
              </p>
              <p>
                <strong>This cannot be undone.</strong> Paperlume cannot restore a
                deleted account, and you will not be able to sign in again with
                these credentials.
              </p>
              <p>
                If you want to keep a copy of your data, close this dialog and use{" "}
                <strong>Account data → Export account data</strong> first. Deleting
                does not export anything for you.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <Label htmlFor={inputId}>
            Type <span className="font-mono font-semibold">{ACCOUNT_DELETION_CONFIRMATION}</span> to
            confirm
          </Label>
          <Input
            id={inputId}
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            disabled={isDeleting}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={hintId}
          />
          <p id={hintId} className="text-xs text-muted-foreground">
            {confirmed
              ? "Confirmation phrase matches. Deleting is permanent."
              : "The phrase must match exactly, including capitals."}
          </p>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          {/*
            A plain Button, not AlertDialogAction: the action must stay mounted
            and disabled while the request is in flight, whereas AlertDialogAction
            closes the dialog on click. Closing mid-flight would drop the only
            in-progress affordance the user has.
          */}
          <Button
            variant="destructive"
            disabled={!canSubmit}
            aria-busy={isDeleting}
            onClick={() => {
              if (!canSubmit) return;
              onConfirm(phrase);
            }}
          >
            {isDeleting && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />}
            {isDeleting ? "Deleting account…" : "Delete my account"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
