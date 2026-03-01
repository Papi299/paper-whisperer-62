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
import { PoolStudyType } from "@/hooks/useStudyTypePool";
import { cn } from "@/lib/utils";

interface ManageStudyTypePoolModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poolStudyTypes: PoolStudyType[];
  availableStudyTypes: string[];
  onAddStudyType: (studyType: string) => Promise<boolean>;
  onAddMultipleStudyTypes: (studyTypes: string[]) => Promise<number>;
  onDeleteStudyType: (id: string) => void;
  onDeleteAllStudyTypes: () => void;
  onUpdateStudyTypeWeight: (id: string, weight: number) => Promise<void>;
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
  onUpdateStudyTypeWeight,
}: ManageStudyTypePoolModalProps) {
  const [newStudyType, setNewStudyType] = useState("");
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkStudyTypes, setBulkStudyTypes] = useState("");
  const [selectedForImport, setSelectedForImport] = useState<Set<string>>(new Set());
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  const handleAddStudyType = async () => {
    if (newStudyType.trim()) {
      const success = await onAddStudyType(newStudyType);
      if (success) setNewStudyType("");
    }
  };

  const handleImportSelected = async () => {
    if (selectedForImport.size > 0) {
      await onAddMultipleStudyTypes(Array.from(selectedForImport));
      setSelectedForImport(new Set());
      setImportDialogOpen(false);
    }
  };

  const handleBulkAdd = async () => {
    const types = bulkStudyTypes.split(/[,\n]/).map((s) => s.trim()).filter((s) => s);
    if (types.length > 0) {
      await onAddMultipleStudyTypes(types);
      setBulkStudyTypes("");
      setBulkDialogOpen(false);
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

  const selectAllForImport = () => {
    const existingInPool = new Set(poolStudyTypes.map((st) => st.study_type.toLowerCase()));
    setSelectedForImport(new Set(availableStudyTypes.filter((st) => !existingInPool.has(st.toLowerCase()))));
  };

  const existingInPool = new Set(poolStudyTypes.map((st) => st.study_type.toLowerCase()));
  const importableStudyTypes = availableStudyTypes.filter((st) => !existingInPool.has(st.toLowerCase()));

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-background max-w-lg">
          <DialogHeader>
            <DialogTitle>Manage Study Type Pool</DialogTitle>
            <DialogDescription>
              Study types in your pool are auto-detected in paper titles. Adjust specificity weights to control priority.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {/* Add single study type */}
            <div className="flex gap-1">
              <Input
                placeholder="Add a study type…"
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
            <div className="flex gap-2">
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

            {/* Study type list with weights */}
            <ScrollArea className="h-64">
              <div className="space-y-1.5 pr-3">
                {poolStudyTypes.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No study types yet
                  </p>
                ) : (
                  poolStudyTypes.map((st) => (
                    <div key={st.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
                      <span className="flex-1 min-w-0 truncate">{st.study_type}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-xs text-muted-foreground">W:</span>
                        <Input
                          type="number"
                          min={1}
                          max={99}
                          value={st.specificity_weight}
                          onChange={(e) => {
                            const val = parseInt(e.target.value);
                            if (val >= 1) onUpdateStudyTypeWeight(st.id, val);
                          }}
                          className="h-6 w-12 text-xs text-center p-0"
                          title="Specificity weight"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-destructive"
                          onClick={() => onDeleteStudyType(st.id)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
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
            <DialogTitle>Import Study Types from Papers</DialogTitle>
            <DialogDescription>Select study types from your existing papers to add to your pool.</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {importableStudyTypes.length === 0 ? (
              <p className="text-sm text-muted-foreground">All study types from your papers are already in your pool.</p>
            ) : (
              <>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm text-muted-foreground">{selectedForImport.size} selected</span>
                  <Button variant="ghost" size="sm" onClick={selectAllForImport}>Select all</Button>
                </div>
                <ScrollArea className="h-[200px] border rounded-md p-2">
                  <div className="flex flex-wrap gap-1">
                    {importableStudyTypes.map((studyType) => (
                      <Badge
                        key={studyType}
                        variant={selectedForImport.has(studyType) ? "default" : "outline"}
                        className={cn("cursor-pointer text-xs", selectedForImport.has(studyType) && "bg-primary text-primary-foreground")}
                        onClick={() => toggleImportStudyType(studyType)}
                      >
                        {studyType}
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
            <DialogTitle>Add Multiple Study Types</DialogTitle>
            <DialogDescription>Enter study types separated by commas or new lines.</DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="e.g., Randomized Controlled Trial, Meta-Analysis, Cohort Study"
            value={bulkStudyTypes}
            onChange={(e) => setBulkStudyTypes(e.target.value)}
            rows={6}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleBulkAdd} disabled={!bulkStudyTypes.trim()}>Add Study Types</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm clear sub-dialog */}
      <Dialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <DialogContent className="bg-background">
          <DialogHeader>
            <DialogTitle>Clear Study Type Pool?</DialogTitle>
            <DialogDescription>
              This will remove all {poolStudyTypes.length} study type(s) from your pool. This action cannot be undone.
            </DialogDescription>
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
