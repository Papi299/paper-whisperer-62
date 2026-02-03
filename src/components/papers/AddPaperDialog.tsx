import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Loader2, Link as LinkIcon } from "lucide-react";

interface AddPaperDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (identifiers: string[], driveUrl?: string) => Promise<void>;
}

// Check if a string is a Google Drive link
function isGoogleDriveLink(text: string): boolean {
  return text.includes("drive.google.com") || text.includes("docs.google.com");
}

// Extract Google Drive links from text
function extractDriveLinks(text: string): string[] {
  const urlRegex = /(https?:\/\/[^\s,]+(?:drive|docs)\.google\.com[^\s,]*)/gi;
  return text.match(urlRegex) || [];
}

// Extract non-Drive identifiers from text
function extractIdentifiers(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && !isGoogleDriveLink(id));
}

export function AddPaperDialog({ open, onOpenChange, onSubmit }: AddPaperDialogProps) {
  const [input, setInput] = useState("");
  const [driveUrl, setDriveUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [detectedDriveLink, setDetectedDriveLink] = useState<string | null>(null);

  // Auto-detect Drive links when input changes
  useEffect(() => {
    const driveLinks = extractDriveLinks(input);
    if (driveLinks.length > 0 && !driveUrl) {
      setDetectedDriveLink(driveLinks[0]);
    } else if (driveLinks.length === 0) {
      setDetectedDriveLink(null);
    }
  }, [input, driveUrl]);

  const handleUseDriveLink = () => {
    if (detectedDriveLink) {
      setDriveUrl(detectedDriveLink);
      // Remove the drive link from input
      setInput((prev) => prev.replace(detectedDriveLink, "").trim());
      setDetectedDriveLink(null);
    }
  };

  const handleSubmit = async () => {
    const identifiers = extractIdentifiers(input);

    if (identifiers.length === 0) return;

    setLoading(true);
    try {
      await onSubmit(identifiers, driveUrl || undefined);
      setInput("");
      setDriveUrl("");
      setDetectedDriveLink(null);
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setInput("");
    setDriveUrl("");
    setDetectedDriveLink(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Add Papers</DialogTitle>
          <DialogDescription>
            Paste PMIDs, DOIs, PubMed links, or paper titles. Google Drive links will be auto-detected.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="identifiers">Paper Identifiers</Label>
            <Textarea
              id="identifiers"
              placeholder={`Enter identifiers (one per line):
12345678
10.1000/xyz123
https://pubmed.ncbi.nlm.nih.gov/12345678/
Paper title to search for`}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={6}
              disabled={loading}
            />
          </div>

          {detectedDriveLink && (
            <div className="flex items-center gap-2 p-3 bg-muted rounded-md">
              <LinkIcon className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground flex-1 truncate">
                Drive link detected
              </span>
              <Button size="sm" variant="secondary" onClick={handleUseDriveLink}>
                Use as Drive Link
              </Button>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="drive-url" className="flex items-center gap-2">
              <LinkIcon className="h-4 w-4" />
              Google Drive Link (optional)
            </Label>
            <Input
              id="drive-url"
              placeholder="https://drive.google.com/file/d/..."
              value={driveUrl}
              onChange={(e) => setDriveUrl(e.target.value)}
              disabled={loading}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={handleClose} disabled={loading}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={loading || extractIdentifiers(input).length === 0}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Papers
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
