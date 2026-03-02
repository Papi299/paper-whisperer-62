import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2, Upload, X, Pencil, Check } from "lucide-react";
import { PoolStudyType } from "@/hooks/useStudyTypePool";

interface ManageStudyTypePoolModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poolStudyTypes: PoolStudyType[];
  availableStudyTypes: string[];
  onAddStudyType: (studyType: string, groupName?: string | null, hierarchyRank?: number) => Promise<boolean>;
  onAddMultipleStudyTypes: (studyTypes: string[]) => Promise<number>;
  onUpdateStudyType: (id: string, updates: Partial<Pick<PoolStudyType, 'study_type' | 'group_name' | 'hierarchy_rank'>>) => Promise<void>;
  onDeleteStudyType: (id: string) => void;
  onDeleteAllStudyTypes: () => void;
  onRenameGroup: (oldName: string, newName: string, newRank?: number) => Promise<void>;
  onDeleteGroup: (groupName: string) => Promise<void>;
}

export function ManageStudyTypePoolModal({
  open,
  onOpenChange,
  poolStudyTypes,
  availableStudyTypes,
  onAddStudyType,
  onAddMultipleStudyTypes,
  onUpdateStudyType,
  onDeleteStudyType,
  onDeleteAllStudyTypes,
  onRenameGroup,
  onDeleteGroup,
}: ManageStudyTypePoolModalProps) {
  // Group tab state
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupRank, setNewGroupRank] = useState("1");
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editGroupName, setEditGroupName] = useState("");
  const [editGroupRank, setEditGroupRank] = useState("");
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<string | null>(null);

  // Subtype tab state
  const [newSubtype, setNewSubtype] = useState("");
  const [newSubtypeGroup, setNewSubtypeGroup] = useState<string>("__none__");
  const [editingSubtype, setEditingSubtype] = useState<string | null>(null);
  const [editSubtypeName, setEditSubtypeName] = useState("");
  const [editSubtypeGroup, setEditSubtypeGroup] = useState<string>("__none__");

  // Bulk/Import state
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkStudyTypes, setBulkStudyTypes] = useState("");
  const [selectedForImport, setSelectedForImport] = useState<Set<string>>(new Set());
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  // Derived: unique groups
  const groups = useMemo(() => {
    const map = new Map<string, number>();
    poolStudyTypes.forEach(st => {
      if (st.group_name) {
        if (!map.has(st.group_name) || st.hierarchy_rank < (map.get(st.group_name) ?? 99)) {
          map.set(st.group_name, st.hierarchy_rank);
        }
      }
    });
    return Array.from(map.entries())
      .map(([name, rank]) => ({ name, rank }))
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  }, [poolStudyTypes]);

  // Subtypes sorted by group rank then name
  const sortedSubtypes = useMemo(
    () => [...poolStudyTypes].sort((a, b) => {
      const rankA = a.hierarchy_rank || 99;
      const rankB = b.hierarchy_rank || 99;
      if (rankA !== rankB) return rankA - rankB;
      return a.study_type.localeCompare(b.study_type);
    }),
    [poolStudyTypes]
  );

  const handleAddGroup = async () => {
    const name = newGroupName.trim();
    const rank = parseInt(newGroupRank) || 99;
    if (!name) return;
    // Add a placeholder subtype to create the group, or just track it
    // Groups are defined by study types that reference them, so we just set state
    // We'll add a dummy entry: user can then add subtypes to it
    // Actually, groups are implicit. Let's just toast info.
    // For a clean UX, let's allow adding a group by creating a placeholder
    // But that's messy. Instead, groups only exist when subtypes reference them.
    // So we just show existing groups. The user adds subtypes and assigns groups.
    // Let me just track groups locally from existing data.
    // Actually the user wants to "add groups" in Tab 1. Let's allow it by
    // simply noting that a group exists when at least one subtype uses it.
    // The UX should guide: "Create a group, then assign subtypes to it in Tab 2"
    
    // Check if group already exists
    if (groups.some(g => g.name.toLowerCase() === name.toLowerCase())) {
      return;
    }
    // We can't create a group without a subtype in current schema.
    // So we'll just tell the user. But per the request, let's make it work
    // by storing group info implicitly. We'll just show it in the UI once subtypes use it.
    // For now, show a note.
    setNewGroupName("");
    setNewGroupRank("1");
  };

  const handleSaveGroupEdit = async (oldName: string) => {
    const name = editGroupName.trim();
    const rank = parseInt(editGroupRank) || 99;
    if (!name) return;
    await onRenameGroup(oldName, name, rank);
    setEditingGroup(null);
  };

  const handleDeleteGroup = async (groupName: string) => {
    await onDeleteGroup(groupName);
    setConfirmDeleteGroup(null);
  };

  const handleAddSubtype = async () => {
    const trimmed = newSubtype.trim();
    if (!trimmed) return;
    const groupName = newSubtypeGroup === "__none__" ? null : newSubtypeGroup;
    const rank = groupName ? (groups.find(g => g.name === groupName)?.rank ?? 99) : 99;
    const success = await onAddStudyType(trimmed, groupName, rank);
    if (success) {
      setNewSubtype("");
    }
  };

  const handleSaveSubtypeEdit = async (id: string) => {
    const name = editSubtypeName.trim();
    if (!name) return;
    const groupName = editSubtypeGroup === "__none__" ? null : editSubtypeGroup;
    const rank = groupName ? (groups.find(g => g.name === groupName)?.rank ?? 99) : 99;
    await onUpdateStudyType(id, { study_type: name, group_name: groupName, hierarchy_rank: rank });
    setEditingSubtype(null);
  };

  const handleBulkAdd = async () => {
    const types = bulkStudyTypes.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
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

  const toggleImportStudyType = (st: string) => {
    setSelectedForImport(prev => {
      const next = new Set(prev);
      if (next.has(st)) next.delete(st); else next.add(st);
      return next;
    });
  };

  const existingInPool = new Set(poolStudyTypes.map(st => st.study_type.toLowerCase()));
  const importableStudyTypes = availableStudyTypes.filter(st => !existingInPool.has(st.toLowerCase()));

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-background max-w-lg max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Manage Study Type Pool</DialogTitle>
            <DialogDescription>
              Configure evidence hierarchy groups and subtypes. The highest-ranked match wins.
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="groups" className="flex-1 min-h-0 flex flex-col">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="groups">1. Groups & Hierarchy</TabsTrigger>
              <TabsTrigger value="subtypes">2. Subtypes</TabsTrigger>
            </TabsList>

            {/* ── Tab 1: Groups ── */}
            <TabsContent value="groups" className="flex-1 min-h-0 flex flex-col space-y-3">
              <p className="text-xs text-muted-foreground">
                Groups define hierarchy ranks (1 = highest evidence). Assign subtypes in Tab 2.
              </p>

              {/* Add group — groups are implicit, created when a subtype uses them */}
              <div className="flex gap-1 items-end">
                <div className="flex-1">
                  <label className="text-xs text-muted-foreground">Group Name</label>
                  <Input
                    placeholder="e.g. Consensus Statement"
                    value={newGroupName}
                    onChange={e => setNewGroupName(e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="w-16">
                  <label className="text-xs text-muted-foreground">Rank</label>
                  <Input
                    type="number"
                    min={1}
                    max={99}
                    value={newGroupRank}
                    onChange={e => setNewGroupRank(e.target.value)}
                    className="h-8 text-sm text-center"
                  />
                </div>
                <Button
                  size="sm"
                  className="h-8"
                  disabled={!newGroupName.trim()}
                  onClick={async () => {
                    // Create group by adding a placeholder subtype with that group
                    const name = newGroupName.trim();
                    const rank = parseInt(newGroupRank) || 99;
                    if (groups.some(g => g.name.toLowerCase() === name.toLowerCase())) return;
                    // Add a subtype with the group name as both subtype and group to bootstrap
                    const success = await onAddStudyType(name, name, rank);
                    if (success) {
                      setNewGroupName("");
                      setNewGroupRank("1");
                    }
                  }}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              <div className="flex-1 min-h-[150px] max-h-[50vh] overflow-y-auto pr-1">
                <div className="space-y-1">
                  {groups.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-6">
                      No groups yet. Add one above, then assign subtypes in Tab 2.
                    </p>
                  ) : (
                    groups.map(group => (
                      <div key={group.name} className="flex items-center gap-1 rounded-md border px-2 py-1.5 text-sm">
                        {editingGroup === group.name ? (
                          <>
                            <Input
                              value={editGroupName}
                              onChange={e => setEditGroupName(e.target.value)}
                              className="h-6 text-sm flex-1"
                              autoFocus
                            />
                            <Input
                              type="number"
                              min={1}
                              max={99}
                              value={editGroupRank}
                              onChange={e => setEditGroupRank(e.target.value)}
                              className="h-6 w-14 text-sm text-center"
                            />
                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleSaveGroupEdit(group.name)}>
                              <Check className="h-3 w-3" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setEditingGroup(null)}>
                              <X className="h-3 w-3" />
                            </Button>
                          </>
                        ) : confirmDeleteGroup === group.name ? (
                          <>
                            <span className="flex-1 text-xs text-destructive">Delete "{group.name}"? Types become standalone.</span>
                            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => handleDeleteGroup(group.name)}>Yes</Button>
                            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setConfirmDeleteGroup(null)}>No</Button>
                          </>
                        ) : (
                          <>
                            <Badge variant="outline" className="text-xs mr-1">Rank {group.rank}</Badge>
                            <span className="flex-1 truncate">{group.name}</span>
                            <span className="text-xs text-muted-foreground mr-1">
                              {poolStudyTypes.filter(st => st.group_name === group.name).length} subtypes
                            </span>
                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => {
                              setEditingGroup(group.name);
                              setEditGroupName(group.name);
                              setEditGroupRank(String(group.rank));
                            }}>
                              <Pencil className="h-3 w-3" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => setConfirmDeleteGroup(group.name)}>
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </TabsContent>

            {/* ── Tab 2: Subtypes ── */}
            <TabsContent value="subtypes" className="flex-1 min-h-0 flex flex-col space-y-3">
              {/* Add subtype */}
              <div className="flex gap-1 items-end">
                <div className="flex-1">
                  <Input
                    placeholder="Subtype name…"
                    value={newSubtype}
                    onChange={e => setNewSubtype(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleAddSubtype()}
                    className="h-8 text-sm"
                  />
                </div>
                <Select value={newSubtypeGroup} onValueChange={setNewSubtypeGroup}>
                  <SelectTrigger className="h-8 w-[140px] text-sm">
                    <SelectValue placeholder="No group" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No group</SelectItem>
                    {groups.map(g => (
                      <SelectItem key={g.name} value={g.name}>
                        {g.name} (R{g.rank})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" className="h-8" onClick={handleAddSubtype} disabled={!newSubtype.trim()}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              {/* Action buttons */}
              <div className="flex gap-2 flex-wrap">
                <Button variant="outline" size="sm" onClick={() => setBulkDialogOpen(true)}>
                  <Plus className="mr-1 h-3 w-3" />
                  Bulk Add
                </Button>
                <Button variant="outline" size="sm" onClick={() => setImportDialogOpen(true)} disabled={importableStudyTypes.length === 0}>
                  <Upload className="mr-1 h-3 w-3" />
                  Import from Papers
                </Button>
                {poolStudyTypes.length > 0 && (
                  <Button variant="outline" size="sm" className="text-destructive ml-auto" onClick={() => setConfirmClearOpen(true)}>
                    <Trash2 className="mr-1 h-3 w-3" />
                    Clear All
                  </Button>
                )}
              </div>

              {/* List */}
              <div className="flex-1 min-h-[150px] max-h-[50vh] overflow-y-auto pr-1">
                <div className="space-y-1">
                  {sortedSubtypes.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-6">No subtypes yet.</p>
                  ) : (
                    sortedSubtypes.map(st => (
                      <div key={st.id} className="flex items-start gap-1 rounded-md border px-2 py-1.5 text-sm">
                        {editingSubtype === st.id ? (
                          <>
                            <Input
                              value={editSubtypeName}
                              onChange={e => setEditSubtypeName(e.target.value)}
                              className="h-6 text-sm flex-1"
                              autoFocus
                            />
                            <Select value={editSubtypeGroup} onValueChange={setEditSubtypeGroup}>
                              <SelectTrigger className="h-6 w-[110px] text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">No group</SelectItem>
                                {groups.map(g => (
                                  <SelectItem key={g.name} value={g.name}>{g.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleSaveSubtypeEdit(st.id)}>
                              <Check className="h-3 w-3" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setEditingSubtype(null)}>
                              <X className="h-3 w-3" />
                            </Button>
                          </>
                        ) : (
                          <>
                            {st.group_name && (
                              <Badge variant="secondary" className="text-[10px] shrink-0">
                                R{st.hierarchy_rank} · {st.group_name}
                              </Badge>
                            )}
                            {!st.group_name && (
                              <Badge variant="outline" className="text-[10px] shrink-0 text-muted-foreground">
                                R{st.hierarchy_rank}
                              </Badge>
                            )}
                            <span className="flex-1 min-w-0 whitespace-normal break-words">{st.study_type}</span>
                            <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => {
                              setEditingSubtype(st.id);
                              setEditSubtypeName(st.study_type);
                              setEditSubtypeGroup(st.group_name || "__none__");
                            }}>
                              <Pencil className="h-3 w-3" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive shrink-0" onClick={() => onDeleteStudyType(st.id)}>
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                {poolStudyTypes.length} subtype{poolStudyTypes.length !== 1 ? "s" : ""} in pool
              </p>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Bulk Add Dialog */}
      <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
        <DialogContent className="bg-background max-w-sm">
          <DialogHeader>
            <DialogTitle>Bulk Add Subtypes</DialogTitle>
            <DialogDescription>Enter subtypes separated by commas or new lines. They will be added without a group (rank 99).</DialogDescription>
          </DialogHeader>
          <Textarea placeholder="Systematic Review&#10;Meta-Analysis&#10;RCT" value={bulkStudyTypes} onChange={e => setBulkStudyTypes(e.target.value)} rows={5} />
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
            <DialogDescription>Select study types found in your papers to add to the pool.</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button variant="link" size="sm" onClick={() => setSelectedForImport(new Set(importableStudyTypes))}>Select All</Button>
          </div>
          <ScrollArea className="h-48">
            <div className="space-y-1 pr-3">
              {importableStudyTypes.map(st => (
                <label key={st} className="flex items-center gap-2 text-sm p-1 rounded hover:bg-muted cursor-pointer">
                  <input type="checkbox" checked={selectedForImport.has(st)} onChange={() => toggleImportStudyType(st)} />
                  {st}
                </label>
              ))}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleImportSelected} disabled={selectedForImport.size === 0}>Import ({selectedForImport.size})</Button>
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
            <Button variant="destructive" onClick={() => { onDeleteAllStudyTypes(); setConfirmClearOpen(false); }}>Clear All</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
