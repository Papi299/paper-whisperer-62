import { useState, useMemo } from "react";
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
import { PoolStudyType } from "@/hooks/useStudyTypePool";

interface ManageStudyTypePoolModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poolStudyTypes: PoolStudyType[];
  availableStudyTypes: string[];
  onAddStudyType: (studyType: string) => Promise<boolean>;
  onAddMultipleStudyTypes: (studyTypes: string[]) => Promise<number>;
  onDeleteStudyType: (id: string) => void;
  onDeleteAllStudyTypes: () => void;
}

export function ManageStudyTypePoolModal({
  open,
  onOpenChange,
  poolStudyTypes,
  availableStudyTypes,
  onAddStudyType,
  onAddMultipleStudyTypes,
  onDeleteStudyType,
  onDeleteAllStudyTypes,
}: ManageStudyTypePoolModalProps) {
  const [newStudyType, setNewStudyType] = useState("");
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkStudyTypes, setBulkStudyTypes] = useState("");
  const [selectedForImport, setSelectedForImport] = useState<Set<string>>(new Set());
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  const handleAddStudyType = async () => {
    const trimmed = newStudyType.trim();
    if (!trimmed) return;
    const success = await onAddStudyType(trimmed);
    if (success) setNewStudyType("");
  };

  const handleBulkAdd = async () => {
    const types = bulkStudyTypes.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (types.length > 0) {
      await onAddMultipleStudyTypes(types);
      setBulkStudyTypes("");
      setBulkDialogOpen(false);
    }
  };

  const handleImportSelected = async () => {
    if (selectedForImport.size > 0) {
      await onAddMultipleStudyTypes(Array.from(selectedForImport));
      setSelectedForImport(new Set());
      setImportDialogOpen(false);
    }
  };

  const toggleImportStudyType = (studyType: string) => {
    setSelectedForImport((prev) => {
      const next = new Set(prev);
      if (next.has(studyType)) next.delete(studyType);
      else next.add(studyType);
      return next;
    });
  };

  const existingInPool = new Set(poolStudyTypes.map((st) => st.study_type.toLowerCase()));
  const importableStudyTypes = availableStudyTypes.filter((st) => !existingInPool.has(st.toLowerCase()));

  const selectAllForImport = () => {
    setSelectedForImport(new Set(importableStudyTypes));
  };

  const sorted = useMemo(
    () => [...poolStudyTypes].sort((a, b) => a.study_type.localeCompare(b.study_type)),
    [poolStudyTypes]
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-background max-w-md max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Manage Study Type Pool</DialogTitle>
            <DialogDescription>
              Add study types to match against paper titles and abstracts. All matches are assigned.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 flex-1 min-h-0">
            {/* Add input */}
            <div className="flex gap-1">
              <Input
                placeholder="Study type name…"
                value={newStudyType}
                onChange={(e) => setNewStudyType(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddStudyType()}
                className="h-8 text-sm"
              />
              <Button size="sm" className="h-8" onClick={handleAddStudyType} disabled={!newStudyType.trim()}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            {/* Action buttons */}
            <div className="flex gap-2 flex-wrap">
              <Button variant="outline" size="sm" onClick={() => setBulkDialogOpen(true)}>
                <Plus className="mr-1 h-3 w-3" />
                Bulk Add
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setImportDialogOpen(true)}
                disabled={importableStudyTypes.length === 0}
              >
                <Upload className="mr-1 h-3 w-3" />
                Import from Papers
              </Button>
              {poolStudyTypes.length > 0 && (
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

            {/* List */}
            <ScrollArea className="h-60">
              <div className="space-y-1 pr-3">
                {sorted.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No study types yet. Add one above.
                  </p>
                ) : (
                  sorted.map((st) => (
                    <div
                      key={st.id}
                      className="flex items-center justify-between rounded-md border px-2 py-1.5 text-sm"
                    >
                      <span className="truncate">{st.study_type}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive shrink-0"
                        onClick={() => onDeleteStudyType(st.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>

            <p className="text-xs text-muted-foreground">
              {poolStudyTypes.length} study type{poolStudyTypes.length !== 1 ? "s" : ""} in pool
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Add Dialog */}
      <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
        <DialogContent className="bg-background max-w-sm">
          <DialogHeader>
            <DialogTitle>Bulk Add Study Types</DialogTitle>
            <DialogDescription>
              Enter study types separated by commas or new lines.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Systematic Review&#10;Meta-Analysis&#10;RCT"
            value={bulkStudyTypes}
            onChange={(e) => setBulkStudyTypes(e.target.value)}
            rows={5}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleBulkAdd} disabled={!bulkStudyTypes.trim()}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Dialog */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="bg-background max-w-sm">
          <DialogHeader>
            <DialogTitle>Import from Papers</DialogTitle>
            <DialogDescription>
              Select study types found in your papers to add to the pool.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button variant="link" size="sm" onClick={selectAllForImport}>Select All</Button>
          </div>
          <ScrollArea className="h-48">
            <div className="space-y-1 pr-3">
              {importableStudyTypes.map((st) => (
                <label key={st} className="flex items-center gap-2 text-sm p-1 rounded hover:bg-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedForImport.has(st)}
                    onChange={() => toggleImportStudyType(st)}
                  />
                  {st}
                </label>
              ))}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleImportSelected} disabled={selectedForImport.size === 0}>
              Import ({selectedForImport.size})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm Clear Dialog */}
      <Dialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <DialogContent className="bg-background max-w-xs">
          <DialogHeader>
            <DialogTitle>Clear All Study Types?</DialogTitle>
            <DialogDescription>This will remove all study types from your pool.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClearOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { onDeleteAllStudyTypes(); setConfirmClearOpen(false); }}>
              Clear All
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
