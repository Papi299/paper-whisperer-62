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
import { Plus, Trash2, Upload, X, FolderOpen } from "lucide-react";
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
  onUpdateStudyTypeGroup: (id: string, groupName: string | null) => Promise<void>;
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
  onUpdateStudyTypeGroup,
}: ManageStudyTypePoolModalProps) {
  const [newStudyType, setNewStudyType] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkStudyTypes, setBulkStudyTypes] = useState("");
  const [selectedForImport, setSelectedForImport] = useState<Set<string>>(new Set());
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupValue, setEditingGroupValue] = useState("");

  const handleAddStudyType = async () => {
    if (newStudyType.trim()) {
      const success = await onAddStudyType(newStudyType);
      if (success && newGroupName.trim()) {
        // Find the just-added study type and set its group
        // We need to wait for re-render, so we handle this via a callback pattern
        // For now, user can set group after adding
      }
      if (success) {
        setNewStudyType("");
        setNewGroupName("");
      }
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

  const handleStartEditGroup = (st: PoolStudyType) => {
    setEditingGroupId(st.id);
    setEditingGroupValue(st.group_name || "");
  };

  const handleSaveGroup = async (id: string) => {
    const val = editingGroupValue.trim() || null;
    await onUpdateStudyTypeGroup(id, val);
    setEditingGroupId(null);
    setEditingGroupValue("");
  };

  const existingInPool = new Set(poolStudyTypes.map((st) => st.study_type.toLowerCase()));
  const importableStudyTypes = availableStudyTypes.filter((st) => !existingInPool.has(st.toLowerCase()));

  // Group study types by group_name for display
  const grouped = new Map<string, PoolStudyType[]>();
  const ungrouped: PoolStudyType[] = [];
  poolStudyTypes.forEach((st) => {
    if (st.group_name) {
      const list = grouped.get(st.group_name) || [];
      list.push(st);
      grouped.set(st.group_name, list);
    } else {
      ungrouped.push(st);
    }
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-background max-w-lg">
          <DialogHeader>
            <DialogTitle>Manage Study Type Pool</DialogTitle>
            <DialogDescription>
              Study types are auto-detected in paper titles. Assign a group to enable hierarchical filtering.
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

            {/* Study type list with groups */}
            <ScrollArea className="h-64">
              <div className="space-y-1.5 pr-3">
                {poolStudyTypes.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No study types yet
                  </p>
                ) : (
                  <>
                    {/* Grouped items */}
                    {Array.from(grouped.entries()).map(([groupName, items]) => (
                      <div key={groupName} className="space-y-1">
                        <div className="flex items-center gap-1.5 px-1 pt-1">
                          <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{groupName}</span>
                          <Badge variant="secondary" className="text-[10px] h-4 px-1">{items.length}</Badge>
                        </div>
                        {items.map((st) => (
                          <StudyTypeRow
                            key={st.id}
                            st={st}
                            editingGroupId={editingGroupId}
                            editingGroupValue={editingGroupValue}
                            onEditingGroupValueChange={setEditingGroupValue}
                            onStartEditGroup={handleStartEditGroup}
                            onSaveGroup={handleSaveGroup}
                            onCancelEditGroup={() => setEditingGroupId(null)}
                            onUpdateWeight={onUpdateStudyTypeWeight}
                            onDelete={onDeleteStudyType}
                            indented
                          />
                        ))}
                      </div>
                    ))}
                    {/* Ungrouped items */}
                    {ungrouped.map((st) => (
                      <StudyTypeRow
                        key={st.id}
                        st={st}
                        editingGroupId={editingGroupId}
                        editingGroupValue={editingGroupValue}
                        onEditingGroupValueChange={setEditingGroupValue}
                        onStartEditGroup={handleStartEditGroup}
                        onSaveGroup={handleSaveGroup}
                        onCancelEditGroup={() => setEditingGroupId(null)}
                        onUpdateWeight={onUpdateStudyTypeWeight}
                        onDelete={onDeleteStudyType}
                      />
                    ))}
                  </>
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

// Extracted row component
interface StudyTypeRowProps {
  st: PoolStudyType;
  editingGroupId: string | null;
  editingGroupValue: string;
  onEditingGroupValueChange: (v: string) => void;
  onStartEditGroup: (st: PoolStudyType) => void;
  onSaveGroup: (id: string) => Promise<void>;
  onCancelEditGroup: () => void;
  onUpdateWeight: (id: string, weight: number) => Promise<void>;
  onDelete: (id: string) => void;
  indented?: boolean;
}

function StudyTypeRow({
  st,
  editingGroupId,
  editingGroupValue,
  onEditingGroupValueChange,
  onStartEditGroup,
  onSaveGroup,
  onCancelEditGroup,
  onUpdateWeight,
  onDelete,
  indented,
}: StudyTypeRowProps) {
  const isEditingGroup = editingGroupId === st.id;

  return (
    <div className={cn("flex flex-col gap-1 rounded-md border p-2 text-sm", indented && "ml-4")}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex-1 min-w-0 truncate font-medium">{st.study_type}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-xs text-muted-foreground">W:</span>
          <Input
            type="number"
            min={1}
            max={99}
            value={st.specificity_weight}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              if (val >= 1) onUpdateWeight(st.id, val);
            }}
            className="h-6 w-12 text-xs text-center p-0"
            title="Specificity weight"
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-destructive"
            onClick={() => onDelete(st.id)}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {/* Group editing row */}
      <div className="flex items-center gap-1.5">
        <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
        {isEditingGroup ? (
          <>
            <Input
              value={editingGroupValue}
              onChange={(e) => onEditingGroupValueChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSaveGroup(st.id);
                if (e.key === "Escape") onCancelEditGroup();
              }}
              placeholder="Group name (empty = none)"
              className="h-5 text-xs flex-1"
              autoFocus
            />
            <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => onSaveGroup(st.id)}>
              <Plus className="h-3 w-3" />
            </Button>
          </>
        ) : (
          <button
            onClick={() => onStartEditGroup(st)}
            className="text-xs text-muted-foreground hover:text-foreground truncate text-left"
          >
            {st.group_name || "No group – click to set"}
          </button>
        )}
      </div>
    </div>
  );
}
