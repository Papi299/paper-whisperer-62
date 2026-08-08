import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Cloud, Check, X, Loader2 } from "lucide-react";
import { toSafeExternalHref } from "@/lib/externalUrl";

interface QuickAddDriveLinkProps {
  paperId: string;
  driveUrl: string | null;
  onSave: (paperId: string, driveUrl: string) => Promise<void>;
}

export function QuickAddDriveLink({ paperId, driveUrl, onSave }: QuickAddDriveLinkProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue("");
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const handleSave = async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    // Dedicated URL-entry flow: refuse a value we would not be willing to
    // navigate to, rather than storing a link the UI can never open. The
    // user's own text is saved as-is — never rewritten to a scheme they
    // did not type.
    if (!toSafeExternalHref(trimmed)) {
      setError("Enter a full http:// or https:// link.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(paperId, trimmed);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  // Only a value that passes the scheme allowlist becomes a real link. An
  // unsafe historical value falls through to the add/replace popover below, so
  // the row stays usable and the user can correct it.
  const safeDriveHref = toSafeExternalHref(driveUrl);
  if (safeDriveHref) {
    return (
      <Button variant="ghost" size="icon" className="h-8 w-8 group-hover:text-white group-hover:hover:bg-white/20" asChild>
        <a href={safeDriveHref} target="_blank" rel="noopener noreferrer" title="Open cloud link">
          <Cloud className="h-4 w-4" />
        </a>
      </Button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 opacity-40 hover:opacity-100 group-hover:text-white group-hover:hover:bg-white/20 transition-opacity"
          title={driveUrl ? "Replace unsafe cloud link" : "Add cloud link"}
        >
          <Cloud className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="start" side="bottom">
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            placeholder="Paste cloud link..."
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
              if (e.key === "Escape") setOpen(false);
            }}
            className="h-8 text-sm"
            disabled={saving}
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0"
            onClick={handleSave}
            disabled={!value.trim() || saving}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0"
            onClick={() => setOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
