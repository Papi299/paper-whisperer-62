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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2, Upload, X, FolderOpen, ChevronRight, Pencil, Check } from "lucide-react";
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
  onRenameStudyTypeGroup: (oldName: string, newName: string) => Promise<void>;
  onDeleteStudyTypeGroup: (groupName: string) => Promise<void>;
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
  onRenameStudyTypeGroup,
  onDeleteStudyTypeGroup,
}: ManageStudyTypePoolModalProps) {
  const [newGroupName, setNewGroupName] = useState("");
  const [localGroups, setLocalGroups] = useState<string[]>([]);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editGroupValue, setEditGroupValue] = useState("");
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<string | null>(null);

  const [newStudyType, setNewStudyType] = useState("");
  const [newWeight, setNewWeight] = useState(1);
  const [selectedGroup, setSelectedGroup] = useState<string>("__none__");

  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkStudyTypes, setBulkStudyTypes] = useState("");
  const [selectedForImport, setSelectedForImport] = useState<Set<string>>(new Set());
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  const [pendingUpdate, setPendingUpdate] = useState<{
    studyType: string;
    weight: number;
    group: string | null;
  } | null>(null);

  const allGroups = useMemo(() => {
    const dbGroups = new Set(
      poolStudyTypes.map((st) => st.group_name).filter(Boolean) as string[]
    );
    localGroups.forEach((g) => dbGroups.add(g));
    return Array.from(dbGroups).sort();
  }, [poolStudyTypes, localGroups]);

  const grouped = useMemo(() => {
    const map = new Map<string, PoolStudyType[]>();
    const ungrouped: PoolStudyType[] = [];
    poolStudyTypes.forEach((st) => {
      if (st.group_name) {
        const list = map.get(st.group_name) || [];
        list.push(st);
        map.set(st.group_name, list);
      } else {
        ungrouped.push(st);
      }
    });
    return { map, ungrouped };
  }, [poolStudyTypes]);

  const emptyGroups = useMemo(() => {
    return allGroups.filter((g) => !grouped.map.has(g));
  }, [allGroups, grouped.map]);

  // Apply pending updates when poolStudyTypes changes
  useMemo(() => {
    if (!pendingUpdate) return;
    const item = poolStudyTypes.find(
      (st) => st.study_type.toLowerCase() === pendingUpdate.studyType.toLowerCase()
    );
    if (item) {
      if (pendingUpdate.weight !== 1 && item.specificity_weight !== pendingUpdate.weight) {
        onUpdateStudyTypeWeight(item.id, pendingUpdate.weight);
      }
      if (pendingUpdate.group && item.group_name !== pendingUpdate.group) {
        onUpdateStudyTypeGroup(item.id, pendingUpdate.group);
      }
      setPendingUpdate(null);
    }
  }, [poolStudyTypes, pendingUpdate, onUpdateStudyTypeWeight, onUpdateStudyTypeGroup]);

  const handleAddGroup = () => {
    const trimmed = newGroupName.trim();
    if (!trimmed) return;
    if (allGroups.some((g) => g.toLowerCase() === trimmed.toLowerCase())) return;
    setLocalGroups((prev) => [...prev, trimmed]);
    setNewGroupName("");
  };

  const handleRemoveLocalGroup = (group: string) => {
    setLocalGroups((prev) => prev.filter((g) => g !== group));
  };

  const handleStartEditGroup = (group: string) => {
    setEditingGroup(group);
    setEditGroupValue(group);
  };

  const handleSaveEditGroup = async (oldName: string) => {
    const trimmed = editGroupValue.trim();
    if (!trimmed || trimmed === oldName) {
      setEditingGroup(null);
      return;
    }
    // Check if it's a local-only group
    if (localGroups.includes(oldName) && !grouped.map.has(oldName)) {
      setLocalGroups((prev) => prev.map((g) => (g === oldName ? trimmed : g)));
    } else {
      await onRenameStudyTypeGroup(oldName, trimmed);
    }
    setEditingGroup(null);
  };

  const handleConfirmDeleteGroup = async (groupName: string) => {
    // If local-only, just remove from local state
    if (localGroups.includes(groupName) && !grouped.map.has(groupName)) {
      handleRemoveLocalGroup(groupName);
    } else {
      await onDeleteStudyTypeGroup(groupName);
      // Also remove from local groups if present
      setLocalGroups((prev) => prev.filter((g) => g !== groupName));
    }
    setConfirmDeleteGroup(null);
  };

  const handleAddStudyType = async () => {
    const trimmed = newStudyType.trim();
    if (!trimmed) return;
    const success = await onAddStudyType(trimmed);
    if (success) {
      const groupToSet = selectedGroup === "__none__" ? null : selectedGroup;
      if (newWeight !== 1 || groupToSet) {
        setPendingUpdate({ studyType: trimmed, weight: newWeight, group: groupToSet });
      }
      setNewStudyType("");
      setNewWeight(1);
      setSelectedGroup("__none__");
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
    const types = bulkStudyTypes.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
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
        <DialogContent className="bg-background max-w-lg max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Manage Study Type Pool</DialogTitle>
            <DialogDescription>
              Define groups first, then add study types and assign them to groups for hierarchical filtering.
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="types" className="flex-1 min-h-0 flex flex-col">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="groups">
                1. Groups
                {allGroups.length > 0 && (
                  <Badge variant="secondary" className="ml-1.5 text-[10px] h-4 px-1">
                    {allGroups.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="types">
                2. Study Types
                {poolStudyTypes.length > 0 && (
                  <Badge variant="secondary" className="ml-1.5 text-[10px] h-4 px-1">
                    {poolStudyTypes.length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>

            {/* ── Tab 1: Manage Groups ── */}
            <TabsContent value="groups" className="flex-1 min-h-0 space-y-3 mt-3">
              <div className="flex gap-1">
                <Input
                  placeholder="New group name…"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddGroup()}
                  className="h-8 text-sm"
                />
                <Button size="sm" className="h-8" onClick={handleAddGroup} disabled={!newGroupName.trim()}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              <ScrollArea className="h-56">
                <div className="space-y-1.5 pr-3">
                  {allGroups.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No groups yet. Add one above, then assign study types to it.
                    </p>
                  ) : (
                    allGroups.map((group) => {
                      const count = grouped.map.get(group)?.length || 0;
                      const isEditing = editingGroup === group;
                      const isConfirmingDelete = confirmDeleteGroup === group;

                      if (isConfirmingDelete) {
                        return (
                          <div key={group} className="rounded-md border border-destructive p-2 space-y-2">
                            <p className="text-sm">
                              Delete group <span className="font-semibold">"{group}"</span>?
                              {count > 0 && (
                                <span className="text-muted-foreground"> ({count} study type{count !== 1 ? "s" : ""} will become standalone)</span>
                              )}
                            </p>
                            <div className="flex gap-1 justify-end">
                              <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => setConfirmDeleteGroup(null)}>
                                Cancel
                              </Button>
                              <Button variant="destructive" size="sm" className="h-6 text-xs" onClick={() => handleConfirmDeleteGroup(group)}>
                                Delete
                              </Button>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div
                          key={group}
                          className="flex items-center justify-between rounded-md border p-2 text-sm"
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                            {isEditing ? (
                              <Input
                                value={editGroupValue}
                                onChange={(e) => setEditGroupValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleSaveEditGroup(group);
                                  if (e.key === "Escape") setEditingGroup(null);
                                }}
                                className="h-6 text-sm flex-1"
                                autoFocus
                              />
                            ) : (
                              <span className="font-medium truncate">{group}</span>
                            )}
                            <Badge variant="secondary" className="text-[10px] h-4 px-1 shrink-0">
                              {count} type{count !== 1 ? "s" : ""}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0">
                            {isEditing ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-primary"
                                onClick={() => handleSaveEditGroup(group)}
                                title="Save"
                              >
                                <Check className="h-3 w-3" />
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                onClick={() => handleStartEditGroup(group)}
                                title="Rename group"
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-destructive"
                              onClick={() => setConfirmDeleteGroup(group)}
                              title="Delete group"
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </ScrollArea>
              <p className="text-xs text-muted-foreground">
                Groups organize study types for hierarchical filtering. Deleting a group moves its study types to standalone.
              </p>
            </TabsContent>

            {/* ── Tab 2: Manage Study Types ── */}
            <TabsContent value="types" className="flex-1 min-h-0 space-y-3 mt-3">
              <div className="space-y-1.5">
                <div className="flex gap-1">
                  <Input
                    placeholder="Study type name…"
                    value={newStudyType}
                    onChange={(e) => setNewStudyType(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAddStudyType()}
                    className="h-8 text-sm flex-1"
                  />
                  <Input
                    type="number"
                    min={1}
                    max={99}
                    value={newWeight}
                    onChange={(e) => setNewWeight(Math.max(1, parseInt(e.target.value) || 1))}
                    className="h-8 w-14 text-xs text-center p-0"
                    title="Specificity weight"
                  />
                  <Button size="sm" className="h-8" onClick={handleAddStudyType} disabled={!newStudyType.trim()}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                <Select value={selectedGroup} onValueChange={setSelectedGroup}>
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue placeholder="No group (standalone)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No group (standalone)</SelectItem>
                    {allGroups.map((g) => (
                      <SelectItem key={g} value={g}>{g}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

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

              <ScrollArea className="h-52">
                <div className="space-y-2 pr-3">
                  {poolStudyTypes.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No study types yet. Add one above.
                    </p>
                  ) : (
                    <>
                      {Array.from(grouped.map.entries())
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([groupName, items]) => (
                          <div key={groupName} className="space-y-1">
                            <div className="flex items-center gap-1.5 px-1 pt-1">
                              <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                                {groupName}
                              </span>
                              <Badge variant="secondary" className="text-[10px] h-4 px-1">
                                {items.length}
                              </Badge>
                            </div>
                            {items.map((st) => (
                              <StudyTypeRow
                                key={st.id}
                                st={st}
                                allGroups={allGroups}
                                onUpdateWeight={onUpdateStudyTypeWeight}
                                onUpdateGroup={onUpdateStudyTypeGroup}
                                onDelete={onDeleteStudyType}
                                indented
                              />
                            ))}
                          </div>
                        ))}

                      {emptyGroups.map((g) => (
                        <div key={g} className="px-1 pt-1">
                          <div className="flex items-center gap-1.5">
                            <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                              {g}
                            </span>
                            <span className="text-[10px] text-muted-foreground italic">empty</span>
                          </div>
                        </div>
                      ))}

                      {grouped.ungrouped.length > 0 && (
                        <div className="space-y-1">
                          {(grouped.map.size > 0 || emptyGroups.length > 0) && (
                            <div className="flex items-center gap-1.5 px-1 pt-2">
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                                Standalone
                              </span>
                              <Badge variant="secondary" className="text-[10px] h-4 px-1">
                                {grouped.ungrouped.length}
                              </Badge>
                            </div>
                          )}
                          {grouped.ungrouped.map((st) => (
                            <StudyTypeRow
                              key={st.id}
                              st={st}
                              allGroups={allGroups}
                              onUpdateWeight={onUpdateStudyTypeWeight}
                              onUpdateGroup={onUpdateStudyTypeGroup}
                              onDelete={onDeleteStudyType}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>
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

// ── Row component for individual study types ──

interface StudyTypeRowProps {
  st: PoolStudyType;
  allGroups: string[];
  onUpdateWeight: (id: string, weight: number) => Promise<void>;
  onUpdateGroup: (id: string, groupName: string | null) => Promise<void>;
  onDelete: (id: string) => void;
  indented?: boolean;
}

function StudyTypeRow({
  st,
  allGroups,
  onUpdateWeight,
  onUpdateGroup,
  onDelete,
  indented,
}: StudyTypeRowProps) {
  return (
    <div className={cn("flex items-center gap-2 rounded-md border p-2 text-sm", indented && "ml-4")}>
      <span className="flex-1 min-w-0 truncate font-medium">{st.study_type}</span>
      <Select
        value={st.group_name || "__none__"}
        onValueChange={(val) => onUpdateGroup(st.id, val === "__none__" ? null : val)}
      >
        <SelectTrigger className="h-6 w-28 text-[11px] px-1.5">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">No group</SelectItem>
          {allGroups.map((g) => (
            <SelectItem key={g} value={g}>{g}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex items-center gap-1 shrink-0">
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
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-destructive shrink-0"
        onClick={() => onDelete(st.id)}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}
