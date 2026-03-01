import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2, Upload, X } from "lucide-react";
import { PoolKeyword } from "@/hooks/useKeywordPool";
import { cn } from "@/lib/utils";

interface ManageKeywordPoolModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poolKeywords: PoolKeyword[];
  availableKeywords: string[];
  onAddKeyword: (keyword: string) => Promise<boolean>;
  onAddMultipleKeywords: (keywords: string[]) => Promise<number>;
  onDeleteKeyword: (keywordId: string) => void;
  onDeleteAllKeywords: () => void;
}

export function ManageKeywordPoolModal({
  open,
  onOpenChange,
  poolKeywords,
  availableKeywords,
  onAddKeyword,
  onAddMultipleKeywords,
  onDeleteKeyword,
  onDeleteAllKeywords,
}: ManageKeywordPoolModalProps) {
  const [newKeyword, setNewKeyword] = useState("");
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkKeywords, setBulkKeywords] = useState("");
  const [selectedForImport, setSelectedForImport] = useState<Set<string>>(new Set());
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  const handleAddKeyword = async () => {
    if (newKeyword.trim()) {
      const success = await onAddKeyword(newKeyword);
      if (success) setNewKeyword("");
    }
  };

  const handleImportSelected = async () => {
    if (selectedForImport.size > 0) {
      await onAddMultipleKeywords(Array.from(selectedForImport));
      setSelectedForImport(new Set());
      setImportDialogOpen(false);
    }
  };

  const handleBulkAdd = async () => {
    const keywords = bulkKeywords.split(/[,\n]/).map((k) => k.trim()).filter((k) => k);
    if (keywords.length > 0) {
      await onAddMultipleKeywords(keywords);
      setBulkKeywords("");
      setBulkDialogOpen(false);
    }
  };

  const toggleImportKeyword = (keyword: string) => {
    setSelectedForImport((prev) => {
      const next = new Set(prev);
      if (next.has(keyword)) next.delete(keyword);
      else next.add(keyword);
      return next;
    });
  };

  const selectAllForImport = () => {
    const existingInPool = new Set(poolKeywords.map((pk) => pk.keyword.toLowerCase()));
    setSelectedForImport(new Set(availableKeywords.filter((k) => !existingInPool.has(k.toLowerCase()))));
  };

  const existingInPool = new Set(poolKeywords.map((pk) => pk.keyword.toLowerCase()));
  const importableKeywords = availableKeywords.filter((k) => !existingInPool.has(k.toLowerCase()));

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-background max-w-lg">
          <DialogHeader>
            <DialogTitle>Manage Keyword Pool</DialogTitle>
            <DialogDescription>
              Keywords in your pool are auto-detected in paper abstracts.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {/* Add single keyword */}
            <div className="flex gap-1">
              <Input
                placeholder="Add a keyword…"
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddKeyword()}
                className="h-8 text-sm"
              />
              <Button size="sm" className="h-8" onClick={handleAddKeyword} disabled={!newKeyword.trim()}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            {/* Action buttons */}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setBulkDialogOpen(true)}>
                <Plus className="mr-1 h-3 w-3" />
                Bulk Add
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setImportDialogOpen(true)}
                disabled={importableKeywords.length === 0}
              >
                <Upload className="mr-1 h-3 w-3" />
                Import from Papers
              </Button>
              {poolKeywords.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive ml-auto"
                  onClick={() => setConfirmClearOpen(true)}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  Clear All
                </Button>
              )}
            </div>

            {/* Keyword list */}
            <ScrollArea className="h-64">
              <div className="flex flex-wrap gap-1 pr-3">
                {poolKeywords.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8 w-full">
                    No keywords yet
                  </p>
                ) : (
                  poolKeywords.map((pk) => (
                    <Badge key={pk.id} variant="outline" className="text-xs group cursor-default pr-1">
                      {pk.keyword}
                      <button
                        className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => onDeleteKeyword(pk.id)}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>

      {/* Import from papers sub-dialog */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="bg-background max-w-md">
          <DialogHeader>
            <DialogTitle>Import Keywords from Papers</DialogTitle>
            <DialogDescription>Select keywords from your existing papers to add to your pool.</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {importableKeywords.length === 0 ? (
              <p className="text-sm text-muted-foreground">All keywords from your papers are already in your pool.</p>
            ) : (
              <>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm text-muted-foreground">{selectedForImport.size} selected</span>
                  <Button variant="ghost" size="sm" onClick={selectAllForImport}>Select all</Button>
                </div>
                <ScrollArea className="h-[200px] border rounded-md p-2">
                  <div className="flex flex-wrap gap-1">
                    {importableKeywords.map((keyword) => (
                      <Badge
                        key={keyword}
                        variant={selectedForImport.has(keyword) ? "default" : "outline"}
                        className={cn("cursor-pointer text-xs", selectedForImport.has(keyword) && "bg-primary text-primary-foreground")}
                        onClick={() => toggleImportKeyword(keyword)}
                      >
                        {keyword}
                      </Badge>
                    ))}
                  </div>
                </ScrollArea>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleImportSelected} disabled={selectedForImport.size === 0}>
              Import ({selectedForImport.size})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk add sub-dialog */}
      <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
        <DialogContent className="bg-background">
          <DialogHeader>
            <DialogTitle>Add Multiple Keywords</DialogTitle>
            <DialogDescription>Enter keywords separated by commas or new lines.</DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="e.g., machine learning, randomized trial, cohort study"
            value={bulkKeywords}
            onChange={(e) => setBulkKeywords(e.target.value)}
            rows={6}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleBulkAdd} disabled={!bulkKeywords.trim()}>Add Keywords</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm clear sub-dialog */}
      <Dialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <DialogContent className="bg-background">
          <DialogHeader>
            <DialogTitle>Clear Keyword Pool?</DialogTitle>
            <DialogDescription>
              This will remove all {poolKeywords.length} keyword(s) from your pool. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClearOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { onDeleteAllKeywords(); setConfirmClearOpen(false); }}>
              Clear All
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
