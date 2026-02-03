import { useState } from "react";
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
import { Loader2 } from "lucide-react";

interface AddPaperDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (identifiers: string[]) => Promise<void>;
}

export function AddPaperDialog({ open, onOpenChange, onSubmit }: AddPaperDialogProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    const identifiers = input
      .split(/[\n,]+/)
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    if (identifiers.length === 0) return;

    setLoading(true);
    try {
      await onSubmit(identifiers);
      setInput("");
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Add Papers</DialogTitle>
          <DialogDescription>
            Paste PMIDs, DOIs, PubMed links, or paper titles. Each identifier on a new line.
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
              rows={8}
              disabled={loading}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={loading || !input.trim()}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Papers
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
