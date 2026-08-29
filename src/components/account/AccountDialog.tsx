import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UserCog } from "lucide-react";
import { useTouchSafeInitialFocus } from "@/hooks/useCoarsePointer";
import { useAccountExport } from "@/hooks/useAccountExport";
import { useAccountDeletion } from "@/hooks/useAccountDeletion";
import { AccountDataSection } from "@/components/settings/AccountDataSection";
import { DeleteAccountSection } from "@/components/settings/DeleteAccountSection";

interface AccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Authenticated user id, threaded from the Sidebar rather than resolved from
   * a second independent auth source — the same contract `SettingsDialog` uses.
   * Nullable-safe: while absent both actions stay disabled.
   */
  userId?: string | null;
}

/**
 * Account-lifecycle surface, reached from the Account menu (the authenticated
 * email dropdown) rather than from Settings.
 *
 * The split is deliberate: **Settings** configures the application (PubMed API
 * key, storage usage) and **Account** acts on the account itself. Both sections
 * rendered here were previously nested inside Settings, where an export and an
 * irreversible deletion sat directly beneath an API-key field. Nothing about
 * either behaviour changed in the move — the same two sections, driven by the
 * same two hooks, with the same typed-phrase deletion gate.
 *
 * Ownership note: `useAccountExport` and `useAccountDeletion` are now mounted
 * *here*, so Settings no longer instantiates account-lifecycle state at all.
 * Both hooks are single-flight and idle when the dialog is closed, and this
 * dialog mounts them only while it is open, so a closed Account dialog holds no
 * export or deletion state.
 *
 * Section order is Account data first, Danger zone last: the export is the
 * offered export-before-delete path, so the non-destructive action must be read
 * before the destructive one.
 */
export function AccountDialog({ open, onOpenChange, userId }: AccountDialogProps) {
  const accountExport = useAccountExport(userId);
  // PFA-C04. `userId` is used only for local UI/auth-state sanity — the hook
  // never sends it, and the Edge Function derives the deleted account solely
  // from the authenticated bearer token.
  const accountDeletion = useAccountDeletion(userId);

  // The first tabbable element here is the "Export account data" button, so
  // Radix's default initial focus raises no software keyboard. The heading is
  // still the better landing point on a coarse pointer: it puts a screen
  // reader at the top of the surface rather than mid-way into it, and it keeps
  // a finger user from arming a control they have not read yet.
  const { focusRef, onOpenAutoFocus } = useTouchSafeInitialFocus<HTMLHeadingElement>();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onOpenAutoFocus={onOpenAutoFocus}>
        <DialogHeader>
          <DialogTitle
            ref={focusRef}
            tabIndex={-1}
            className="flex items-center gap-2 outline-none"
          >
            <UserCog className="h-5 w-5" aria-hidden="true" />
            Account
          </DialogTitle>
          <DialogDescription>
            Export or permanently delete your PaperLume account.
          </DialogDescription>
        </DialogHeader>

        {/*
          Scroll container: the Danger zone must stay reachable on a short
          viewport without the header scrolling away with it.
        */}
        <div className="max-h-[60vh] space-y-4 overflow-y-auto py-2 pr-1">
          <AccountDataSection
            onExport={accountExport.exportAccountData}
            isExporting={accountExport.isExporting}
            progress={accountExport.progress}
            canExport={accountExport.canExport}
          />

          <DeleteAccountSection
            onDelete={accountDeletion.deleteAccount}
            isDeleting={accountDeletion.isDeleting}
            canDelete={accountDeletion.canDelete}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
