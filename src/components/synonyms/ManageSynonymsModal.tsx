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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2, Pencil } from "lucide-react";
import { Synonym } from "@/hooks/useSynonymPool";

interface ManageSynonymsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  synonymGroups: Synonym[];
  onAdd: (canonicalTerm: string, synonyms: string[]) => Promise<void>;
  onUpdate: (id: string, canonicalTerm: string, synonyms: string[]) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function ManageSynonymsModal({
  open,
  onOpenChange,
  synonymGroups,
  onAdd,
  onUpdate,
  onDelete,
}: ManageSynonymsModalProps) {
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<Synonym | null>(null);
  const [canonicalTerm, setCanonicalTerm] = useState("");
  const [synonymsText, setSynonymsText] = useState("");

  const parseSynonyms = (text: string): string[] => {
    const matches = text.match(/\[([^\]]+)\]/g);
    if (!matches) return [];
    return matches.map((m) => m.slice(1, -1).trim()).filter((s) => s.length > 0);
  };

  const formatSynonyms = (synonyms: string[]): string => {
    return synonyms.map((s) => `[${s}]`).join("");
  };

  const handleSubmit = async () => {
    const synonyms = parseSynonyms(synonymsText);
    if (!canonicalTerm.trim()) return;

    if (editingGroup) {
      await onUpdate(editingGroup.id, canonicalTerm.trim(), synonyms);
    } else {
      await onAdd(canonicalTerm.trim(), synonyms);
    }

    resetEditForm();
  };

  const handleEdit = (group: Synonym) => {
    setEditingGroup(group);
    setCanonicalTerm(group.canonical_term);
    setSynonymsText(formatSynonyms(group.synonyms));
    setEditDialogOpen(true);
  };

  const resetEditForm = () => {
    setEditDialogOpen(false);
    setEditingGroup(null);
    setCanonicalTerm("");
    setSynonymsText("");
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-background max-w-lg">
          <DialogHeader>
            <DialogTitle>Manage Synonyms</DialogTitle>
            <DialogDescription>
              Define canonical terms and their synonyms. All synonyms will display as the canonical term.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setEditDialogOpen(true)}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Synonym Group
            </Button>

            <div className="flex flex-col gap-2 overflow-y-auto max-h-[50vh] p-1">
                {synonymGroups.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No synonym groups yet
                  </p>
                ) : (
                  synonymGroups.map((group) => (
                    <div
                      key={group.id}
                      className="flex items-start justify-between gap-2 rounded-md border p-2 text-sm"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{group.canonical_term}</div>
                        <div className="text-xs text-muted-foreground whitespace-normal break-words">
                          {group.synonyms.join(", ")}
                        </div>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => handleEdit(group)}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-destructive"
                          onClick={() => onDelete(group.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add/Edit sub-dialog */}
      <Dialog open={editDialogOpen} onOpenChange={(o) => { if (!o) resetEditForm(); else setEditDialogOpen(true); }}>
        <DialogContent className="bg-background">
          <DialogHeader>
            <DialogTitle>
              {editingGroup ? "Edit Synonym Group" : "Add Synonym Group"}
            </DialogTitle>
            <DialogDescription>
              Define a canonical term and its synonyms.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="canonical">Display Name (Canonical Term)</Label>
              <Input
                id="canonical"
                placeholder="e.g., LDL"
                value={canonicalTerm}
                onChange={(e) => setCanonicalTerm(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="synonyms">
                Synonyms (wrap each in square brackets)
              </Label>
              <Textarea
                id="synonyms"
                placeholder="e.g., [Low-Density Lipoprotein][LDL-Cholesterol][LDL-C]"
                value={synonymsText}
                onChange={(e) => setSynonymsText(e.target.value)}
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={resetEditForm}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!canonicalTerm.trim()}>
              {editingGroup ? "Update" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
