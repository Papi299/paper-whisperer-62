import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  MoreHorizontal,
  Trash2,
  Upload,
  X,
  Sparkles,
} from "lucide-react";
import { PoolKeyword } from "@/hooks/useKeywordPool";
import { cn } from "@/lib/utils";

interface KeywordPoolSectionProps {
  poolKeywords: PoolKeyword[];
  availableKeywords: string[];
  onAddKeyword: (keyword: string) => Promise<boolean>;
  onAddMultipleKeywords: (keywords: string[]) => Promise<number>;
  onDeleteKeyword: (keywordId: string) => void;
  onDeleteAllKeywords: () => void;
}

export function KeywordPoolSection({
  poolKeywords,
  availableKeywords,
  onAddKeyword,
  onAddMultipleKeywords,
  onDeleteKeyword,
  onDeleteAllKeywords,
}: KeywordPoolSectionProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [showInput, setShowInput] = useState(false);
  const [newKeyword, setNewKeyword] = useState("");
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkKeywords, setBulkKeywords] = useState("");
  const [selectedForImport, setSelectedForImport] = useState<Set<string>>(
    new Set()
  );
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  const handleAddKeyword = async () => {
    if (newKeyword.trim()) {
      const success = await onAddKeyword(newKeyword);
      if (success) {
        setNewKeyword("");
        setShowInput(false);
      }
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
    const keywords = bulkKeywords
      .split(/[,\n]/)
      .map((k) => k.trim())
      .filter((k) => k);
    if (keywords.length > 0) {
      await onAddMultipleKeywords(keywords);
      setBulkKeywords("");
      setBulkDialogOpen(false);
    }
  };

  const toggleImportKeyword = (keyword: string) => {
    setSelectedForImport((prev) => {
      const next = new Set(prev);
      if (next.has(keyword)) {
        next.delete(keyword);
      } else {
        next.add(keyword);
      }
      return next;
    });
  };

  const selectAllForImport = () => {
    const existingInPool = new Set(poolKeywords.map((pk) => pk.keyword.toLowerCase()));
    const newKeywords = availableKeywords.filter(
      (k) => !existingInPool.has(k.toLowerCase())
    );
    setSelectedForImport(new Set(newKeywords));
  };

  const existingInPool = new Set(poolKeywords.map((pk) => pk.keyword.toLowerCase()));
  const importableKeywords = availableKeywords.filter(
    (k) => !existingInPool.has(k.toLowerCase())
  );

  return (
    <>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className="flex items-center justify-between">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="p-0 h-auto hover:bg-transparent"
            >
              {isOpen ? (
                <ChevronDown className="h-4 w-4 mr-1" />
              ) : (
                <ChevronRight className="h-4 w-4 mr-1" />
              )}
              <Sparkles className="h-3 w-3 mr-1 text-amber-500" />
              <span className="text-sm font-medium text-muted-foreground">
                Keyword Pool
              </span>
              {poolKeywords.length > 0 && (
                <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-xs">
                  {poolKeywords.length}
                </Badge>
              )}
            </Button>
          </CollapsibleTrigger>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6">
                <Plus className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setShowInput(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add single keyword
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setBulkDialogOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add multiple keywords
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setImportDialogOpen(true)}
                disabled={importableKeywords.length === 0}
              >
                <Upload className="mr-2 h-4 w-4" />
                Import from papers
              </DropdownMenuItem>
              {poolKeywords.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => setConfirmClearOpen(true)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Clear all
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <CollapsibleContent className="mt-2 space-y-1">
          {showInput && (
            <div className="flex gap-1">
              <Input
                placeholder="Keyword"
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddKeyword()}
                className="h-8 text-sm"
                autoFocus
              />
              <Button size="sm" className="h-8" onClick={handleAddKeyword}>
                Add
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0"
                onClick={() => {
                  setShowInput(false);
                  setNewKeyword("");
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}
          {poolKeywords.length === 0 ? (
            <p className="text-xs text-muted-foreground px-2 py-1">
              No keywords yet. Add keywords to auto-detect them in paper
              abstracts.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1 pt-1">
              {poolKeywords.map((pk) => (
                <Badge
                  key={pk.id}
                  variant="outline"
                  className="text-xs group cursor-default pr-1"
                >
                  {pk.keyword}
                  <button
                    className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => onDeleteKeyword(pk.id)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>

      {/* Import from papers dialog */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Import Keywords from Papers</DialogTitle>
            <DialogDescription>
              Select keywords from your existing papers to add to your pool.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {importableKeywords.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                All keywords from your papers are already in your pool.
              </p>
            ) : (
              <>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm text-muted-foreground">
                    {selectedForImport.size} selected
                  </span>
                  <Button variant="ghost" size="sm" onClick={selectAllForImport}>
                    Select all
                  </Button>
                </div>
                <ScrollArea className="h-[200px] border rounded-md p-2">
                  <div className="flex flex-wrap gap-1">
                    {importableKeywords.map((keyword) => (
                      <Badge
                        key={keyword}
                        variant={
                          selectedForImport.has(keyword) ? "default" : "outline"
                        }
                        className={cn(
                          "cursor-pointer text-xs",
                          selectedForImport.has(keyword) &&
                            "bg-primary text-primary-foreground"
                        )}
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
            <Button variant="outline" onClick={() => setImportDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleImportSelected}
              disabled={selectedForImport.size === 0}
            >
              Import ({selectedForImport.size})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk add dialog */}
      <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Multiple Keywords</DialogTitle>
            <DialogDescription>
              Enter keywords separated by commas or new lines.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="e.g., machine learning, randomized trial, cohort study"
            value={bulkKeywords}
            onChange={(e) => setBulkKeywords(e.target.value)}
            rows={6}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleBulkAdd} disabled={!bulkKeywords.trim()}>
              Add Keywords
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm clear dialog */}
      <Dialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear Keyword Pool?</DialogTitle>
            <DialogDescription>
              This will remove all {poolKeywords.length} keyword(s) from your
              pool. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClearOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                onDeleteAllKeywords();
                setConfirmClearOpen(false);
              }}
            >
              Clear All
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
