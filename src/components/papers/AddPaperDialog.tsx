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
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Loader2, Link as LinkIcon, Upload, PenLine, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";

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
  onSubmitManual?: (paperData: ManualPaperData) => Promise<void>;
  onBulkImport?: (
    identifiers: string[],
    onProgress?: (current: number, total: number, addedIds: string[], skippedIds: string[], failedIds: string[]) => void
  ) => Promise<void>;
}

// Parse bulk input: split on commas, newlines, or whitespace (but preserve DOIs with dots)
function parseBulkIdentifiers(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .flatMap((line) => line.trim().split(/\s+/))
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
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

export function AddPaperDialog({ open, onOpenChange, onSubmitManual, onBulkImport }: AddPaperDialogProps) {
  const [activeTab, setActiveTab] = useState<"import" | "manual">("import");

  // Manual mode state
  const [manualData, setManualData] = useState<ManualPaperData>(emptyManualData);
  const [loading, setLoading] = useState(false);

  // Import state
  const [bulkInput, setBulkInput] = useState("");
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 });
  const [bulkResults, setBulkResults] = useState<{ addedIds: string[]; skippedIds: string[]; failedIds: string[] }>({ addedIds: [], skippedIds: [], failedIds: [] });

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

  const handleBulkImport = async () => {
    if (!onBulkImport) return;
    const ids = parseBulkIdentifiers(bulkInput);
    if (ids.length === 0) return;

    // Reset results at the start of each new import
    setBulkResults({ addedIds: [], skippedIds: [], failedIds: [] });
    setBulkRunning(true);
    setBulkProgress({ current: 0, total: ids.length });

    try {
      await onBulkImport(ids, (current, total, addedIds, skippedIds, failedIds) => {
        setBulkProgress({ current, total });
        setBulkResults({ addedIds: [...addedIds], skippedIds: [...skippedIds], failedIds: [...failedIds] });
      });
    } finally {
      setBulkRunning(false);
    }
  };

  const resetAndClose = () => {
    setBulkInput("");
    setBulkRunning(false);
    setBulkProgress({ current: 0, total: 0 });
    setBulkResults({ addedIds: [], skippedIds: [], failedIds: [] });
    setManualData(emptyManualData);
    setActiveTab("import");
    onOpenChange(false);
  };

  const updateManualField = (field: keyof ManualPaperData, value: string) => {
    setManualData((prev) => ({ ...prev, [field]: value }));
  };

  const bulkIds = parseBulkIdentifiers(bulkInput);
  const progressPercent = bulkProgress.total > 0 ? Math.round((bulkProgress.current / bulkProgress.total) * 100) : 0;
  const bulkComplete = !bulkRunning && bulkProgress.total > 0 && bulkProgress.current === bulkProgress.total;

  return (
    <Dialog open={open} onOpenChange={bulkRunning ? undefined : resetAndClose}>
      <DialogContent className="sm:max-w-[550px]">
        <DialogHeader>
          <DialogTitle>Add Papers</DialogTitle>
          <DialogDescription>
            Import by identifier or add manually.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "import" | "manual")}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="import" className="flex items-center gap-2" disabled={bulkRunning}>
              <Upload className="h-4 w-4" />
              Import
            </TabsTrigger>
            <TabsTrigger value="manual" className="flex items-center gap-2" disabled={bulkRunning}>
              <PenLine className="h-4 w-4" />
              Manual
            </TabsTrigger>
          </TabsList>

          <TabsContent value="import" className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="bulk-identifiers">
                Paste PMIDs or DOIs (comma, space, or newline separated)
              </Label>
              <Textarea
                id="bulk-identifiers"
                placeholder={`Paste your list of identifiers here, e.g.:
38237512
37654321, 36543210
10.1000/xyz123
10.1016/j.example.2024.01.001`}
                value={bulkInput}
                onChange={(e) => setBulkInput(e.target.value)}
                rows={6}
                disabled={bulkRunning}
              />
              {bulkIds.length > 0 && !bulkRunning && !bulkComplete && (
                <p className="text-sm text-muted-foreground">
                  {bulkIds.length} identifier{bulkIds.length !== 1 ? "s" : ""} detected
                </p>
              )}
            </div>

            {bulkRunning && (
              <div className="space-y-3">
                <Progress value={progressPercent} className="h-2" />
                <p className="text-sm text-muted-foreground text-center">
                  Processing {bulkProgress.current} of {bulkProgress.total}…
                  {bulkResults.addedIds.length > 0 && <span className="text-foreground"> · {bulkResults.addedIds.length} added</span>}
                  {bulkResults.skippedIds.length > 0 && <span className="text-muted-foreground"> · {bulkResults.skippedIds.length} skipped</span>}
                  {bulkResults.failedIds.length > 0 && <span className="text-destructive"> · {bulkResults.failedIds.length} failed</span>}
                </p>
              </div>
            )}

            {bulkComplete && (
              <div className="rounded-md border border-border bg-muted/50 p-4 space-y-3 max-h-60 overflow-y-auto">
                <p className="font-medium text-sm">Import Results Summary</p>

                {bulkResults.addedIds.length > 0 && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-sm font-medium text-green-700 dark:text-green-400">
                      <CheckCircle2 className="h-4 w-4" />
                      Added ({bulkResults.addedIds.length})
                    </div>
                    <ul className="ml-6 text-xs text-muted-foreground space-y-0.5">
                      {bulkResults.addedIds.map((id) => (
                        <li key={id} className="font-mono">{id}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {bulkResults.skippedIds.length > 0 && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-sm font-medium text-yellow-700 dark:text-yellow-400">
                      <AlertTriangle className="h-4 w-4" />
                      Skipped — Duplicates ({bulkResults.skippedIds.length})
                    </div>
                    <ul className="ml-6 text-xs text-muted-foreground space-y-0.5">
                      {bulkResults.skippedIds.map((id) => (
                        <li key={id} className="font-mono">{id}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {bulkResults.failedIds.length > 0 && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                      <XCircle className="h-4 w-4" />
                      Failed ({bulkResults.failedIds.length})
                    </div>
                    <ul className="ml-6 text-xs text-muted-foreground space-y-0.5">
                      {bulkResults.failedIds.map((id) => (
                        <li key={id} className="font-mono">{id}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={resetAndClose} disabled={bulkRunning}>
                {bulkRunning ? "Running…" : (bulkComplete ? "Close" : "Cancel")}
              </Button>
              <Button
                onClick={handleBulkImport}
                disabled={bulkRunning || bulkIds.length === 0 || !onBulkImport}
              >
                {bulkRunning && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Import {bulkIds.length > 0 ? `${bulkIds.length} Paper${bulkIds.length !== 1 ? "s" : ""}` : "Papers"}
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
