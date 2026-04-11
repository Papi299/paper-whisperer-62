import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Trash2, Save, Key, Loader2 } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { useToast } from "@/hooks/use-toast";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { settings, loading, setPubmedApiKey, clearPubmedApiKey } = useSettings();
  const { toast } = useToast();
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);

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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Settings
          </DialogTitle>
          <DialogDescription>
            Configure your application preferences.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
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
            </div>
          </div>
        )}

        <DialogFooter className="flex gap-2 sm:justify-between">
          {hasKey && (
            <Button variant="destructive" size="sm" onClick={handleRemove} disabled={saving}>
              {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1 h-4 w-4" />}
              Remove Key
            </Button>
          )}
          <Button onClick={handleSave} disabled={!keyInput.trim() || saving || loading}>
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
