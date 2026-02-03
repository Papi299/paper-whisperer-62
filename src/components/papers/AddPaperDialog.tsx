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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Link as LinkIcon, Search, PenLine } from "lucide-react";

interface ManualPaperData {
  title: string;
  authors: string;
  year: string;
  journal: string;
  pmid: string;
  doi: string;
  abstract: string;
  keywords: string;
  driveUrl: string;
}

interface AddPaperDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (identifiers: string[], driveUrl?: string) => Promise<void>;
  onSubmitManual?: (paperData: ManualPaperData) => Promise<void>;
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

const emptyManualData: ManualPaperData = {
  title: "",
  authors: "",
  year: "",
  journal: "",
  pmid: "",
  doi: "",
  abstract: "",
  keywords: "",
  driveUrl: "",
};

export function AddPaperDialog({ open, onOpenChange, onSubmit, onSubmitManual }: AddPaperDialogProps) {
  const [activeTab, setActiveTab] = useState<"search" | "manual">("search");
  
  // Search mode state
  const [input, setInput] = useState("");
  const [driveUrl, setDriveUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [detectedDriveLink, setDetectedDriveLink] = useState<string | null>(null);

  // Manual mode state
  const [manualData, setManualData] = useState<ManualPaperData>(emptyManualData);

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

  const handleSearchSubmit = async () => {
    const identifiers = extractIdentifiers(input);

    if (identifiers.length === 0) return;

    setLoading(true);
    try {
      await onSubmit(identifiers, driveUrl || undefined);
      resetAndClose();
    } finally {
      setLoading(false);
    }
  };

  const handleManualSubmit = async () => {
    if (!manualData.title.trim()) return;
    if (!onSubmitManual) return;

    setLoading(true);
    try {
      await onSubmitManual(manualData);
      resetAndClose();
    } finally {
      setLoading(false);
    }
  };

  const resetAndClose = () => {
    setInput("");
    setDriveUrl("");
    setDetectedDriveLink(null);
    setManualData(emptyManualData);
    setActiveTab("search");
    onOpenChange(false);
  };

  const updateManualField = (field: keyof ManualPaperData, value: string) => {
    setManualData((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      <DialogContent className="sm:max-w-[550px]">
        <DialogHeader>
          <DialogTitle>Add Papers</DialogTitle>
          <DialogDescription>
            Search by identifier or add paper details manually.
          </DialogDescription>
        </DialogHeader>
        
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "search" | "manual")}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="search" className="flex items-center gap-2">
              <Search className="h-4 w-4" />
              Search
            </TabsTrigger>
            <TabsTrigger value="manual" className="flex items-center gap-2">
              <PenLine className="h-4 w-4" />
              Manual Entry
            </TabsTrigger>
          </TabsList>

          <TabsContent value="search" className="space-y-4 mt-4">
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
                rows={5}
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
              <Button variant="outline" onClick={resetAndClose} disabled={loading}>
                Cancel
              </Button>
              <Button onClick={handleSearchSubmit} disabled={loading || extractIdentifiers(input).length === 0}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add Papers
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="manual" className="space-y-4 mt-4">
            <div className="grid gap-4">
              <div className="space-y-2">
                <Label htmlFor="manual-title">Title *</Label>
                <Input
                  id="manual-title"
                  placeholder="Paper title"
                  value={manualData.title}
                  onChange={(e) => updateManualField("title", e.target.value)}
                  disabled={loading}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="manual-authors">Authors (comma-separated)</Label>
                  <Input
                    id="manual-authors"
                    placeholder="Smith J, Doe A"
                    value={manualData.authors}
                    onChange={(e) => updateManualField("authors", e.target.value)}
                    disabled={loading}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="manual-year">Year</Label>
                  <Input
                    id="manual-year"
                    placeholder="2024"
                    value={manualData.year}
                    onChange={(e) => updateManualField("year", e.target.value)}
                    disabled={loading}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-journal">Journal</Label>
                <Input
                  id="manual-journal"
                  placeholder="Journal of Example Studies"
                  value={manualData.journal}
                  onChange={(e) => updateManualField("journal", e.target.value)}
                  disabled={loading}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="manual-pmid">PMID</Label>
                  <Input
                    id="manual-pmid"
                    placeholder="12345678"
                    value={manualData.pmid}
                    onChange={(e) => updateManualField("pmid", e.target.value)}
                    disabled={loading}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="manual-doi">DOI</Label>
                  <Input
                    id="manual-doi"
                    placeholder="10.1000/xyz123"
                    value={manualData.doi}
                    onChange={(e) => updateManualField("doi", e.target.value)}
                    disabled={loading}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-keywords">Keywords (comma-separated)</Label>
                <Input
                  id="manual-keywords"
                  placeholder="keyword1, keyword2, keyword3"
                  value={manualData.keywords}
                  onChange={(e) => updateManualField("keywords", e.target.value)}
                  disabled={loading}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-drive" className="flex items-center gap-2">
                  <LinkIcon className="h-4 w-4" />
                  Google Drive Link (optional)
                </Label>
                <Input
                  id="manual-drive"
                  placeholder="https://drive.google.com/file/d/..."
                  value={manualData.driveUrl}
                  onChange={(e) => updateManualField("driveUrl", e.target.value)}
                  disabled={loading}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-abstract">Abstract</Label>
                <Textarea
                  id="manual-abstract"
                  placeholder="Paper abstract..."
                  value={manualData.abstract}
                  onChange={(e) => updateManualField("abstract", e.target.value)}
                  rows={3}
                  disabled={loading}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={resetAndClose} disabled={loading}>
                Cancel
              </Button>
              <Button onClick={handleManualSubmit} disabled={loading || !manualData.title.trim() || !onSubmitManual}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add Paper
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
