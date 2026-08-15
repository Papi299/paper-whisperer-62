import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Trash2, Save, Key, Loader2 } from "lucide-react";
import { useTouchSafeInitialFocus } from "@/hooks/useCoarsePointer";
import { useSettings } from "@/hooks/useSettings";
import { useToast } from "@/hooks/use-toast";
import { useStorageUsage } from "@/hooks/useStorageUsage";
import { useAccountExport } from "@/hooks/useAccountExport";
import { useAccountDeletion } from "@/hooks/useAccountDeletion";
import { StorageUsageSection } from "@/components/settings/StorageUsageSection";
import { AccountDataSection } from "@/components/settings/AccountDataSection";
import { DeleteAccountSection } from "@/components/settings/DeleteAccountSection";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Authenticated user id, threaded from the Sidebar rather than resolved from
   * a second independent auth source. Nullable-safe: while absent the storage
   * query stays disabled and the gauge reports unavailable.
   */
  userId?: string | null;
}

export function SettingsDialog({ open, onOpenChange, userId }: SettingsDialogProps) {
  const { settings, loading, setPubmedApiKey, clearPubmedApiKey } = useSettings();
  const { toast } = useToast();
  // Only queried while the dialog is open; refetched on reopen so the gauge
  // reflects attachment activity since the last visit.
  const storage = useStorageUsage(userId, { enabled: open });
  // Independent of the PubMed and Storage sections: an export in progress
  // never blocks them, and neither of them gates an export.
  const accountExport = useAccountExport(userId);
  // PFA-C04. `userId` is used only for local UI/auth-state sanity — the hook
  // never sends it, and the Edge Function derives the deleted account solely
  // from the authenticated bearer token.
  const accountDeletion = useAccountDeletion(userId);
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  // Settings is opened to read it — the storage gauge, the export and delete
  // sections — far more often than to type an API key. The PubMed field is
  // simply the first tabbable element, so Radix focused it and the software
  // keyboard covered most of the dialog on a tablet. On a coarse pointer the
  // heading takes initial focus instead; on a mouse the field still does.
  const { focusRef, onOpenAutoFocus } = useTouchSafeInitialFocus<HTMLHeadingElement>();

  const hasKey = !!settings.pubmedApiKey;

  // Reset input when dialog opens
  useEffect(() => {
    if (open) {
      setKeyInput(settings.pubmedApiKey ?? "");
    }
  }, [open, settings.pubmedApiKey]);

  const handleSave = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setSaving(true);
    const error = await setPubmedApiKey(trimmed);
    setSaving(false);
    if (error) {
      toast({ title: "Error saving API key", description: "Please try again.", variant: "destructive" });
    } else {
      toast({ title: "API key saved", description: "PubMed requests will now use your API key for faster fetching." });
      onOpenChange(false);
    }
  };

  const handleRemove = async () => {
    setSaving(true);
    const error = await clearPubmedApiKey();
    setSaving(false);
    if (error) {
      toast({ title: "Error removing API key", description: "Please try again.", variant: "destructive" });
    } else {
      setKeyInput("");
      toast({ title: "API key removed", description: "PubMed requests will use the default rate limit." });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onOpenAutoFocus={onOpenAutoFocus}>
        <DialogHeader>
          <DialogTitle
            ref={focusRef}
            tabIndex={-1}
            className="flex items-center gap-2 outline-none"
          >
            <Key className="h-5 w-5" />
            Settings
          </DialogTitle>
          <DialogDescription>
            Configure your application preferences.
          </DialogDescription>
        </DialogHeader>

        {/*
          Scroll container: Settings now carries four sections plus the Danger
          zone, which can exceed a short viewport. Bounding the height here keeps
          the header and footer fixed and every section reachable, without
          changing the dialog width or any existing section's layout.
        */}
        <div className="max-h-[60vh] space-y-4 overflow-y-auto py-2 pr-1">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            /*
              A real <section> rather than a <div>: Save and Remove Key act on
              this field and nothing else, so they have to be contained by the
              same element the field is. It is deliberately left unnamed —
              naming it would give the region the input's own accessible name
              twice over, so the section stays generic and the Label remains the
              input's single accessible name.
            */
            <section className="space-y-2">
              <Label htmlFor="pubmed-api-key">PubMed API Key (NCBI)</Label>
              <Input
                id="pubmed-api-key"
                type="password"
                placeholder="Enter your NCBI API key..."
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave();
                }}
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">
                With an API key, PubMed allows 10 requests/sec instead of 3/sec — bulk imports run ~3x faster.
                Get a free key at{" "}
                <a
                  href="https://www.ncbi.nlm.nih.gov/account/settings/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-primary"
                >
                  ncbi.nlm.nih.gov/account/settings
                </a>.
              </p>

              {/*
                Both actions are PubMed-only: handleSave writes just the PubMed
                key and handleRemove clears just the PubMed key. They previously
                sat in the dialog-level DialogFooter, which rendered after the
                Danger zone and made Remove Key read as an account-deletion
                control. Wrapping instead of a footer, so the row degrades by
                stacking at narrow widths rather than overflowing.
              */}
              <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                {hasKey && (
                  <Button variant="destructive" size="sm" onClick={handleRemove} disabled={saving}>
                    {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
                    Remove Key
                  </Button>
                )}
                <Button size="sm" onClick={handleSave} disabled={!keyInput.trim() || saving || loading}>
                  {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
                  Save
                </Button>
              </div>
            </section>
          )}

          <StorageUsageSection
            status={storage.status}
            isLoading={storage.isLoading}
            isError={storage.isError}
          />

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
