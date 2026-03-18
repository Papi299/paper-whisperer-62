import { useState, useMemo } from "react";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown, ChevronRight, Plus, Trash2, Pencil, RefreshCw } from "lucide-react";
import { Synonym } from "@/hooks/useSynonymPool";

interface SynonymPoolSectionProps {
  synonymGroups: Synonym[];
  onAdd: (canonicalTerm: string, synonyms: string[]) => Promise<void>;
  onUpdate: (id: string, canonicalTerm: string, synonyms: string[]) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function SynonymPoolSection({
  synonymGroups,
  onAdd,
  onUpdate,
  onDelete,
}: SynonymPoolSectionProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<Synonym | null>(null);
  const [canonicalTerm, setCanonicalTerm] = useState("");
  const [synonymsText, setSynonymsText] = useState("");

  // Parse synonyms from square bracket format: [term1][term2][term3]
  const parseSynonyms = (text: string): string[] => {
    const matches = text.match(/\[([^\]]+)\]/g);
    if (!matches) return [];
    return matches.map((m) => m.slice(1, -1).trim()).filter((s) => s.length > 0);
  };

  // Format synonyms to square bracket format
  const formatSynonyms = (synonyms: string[]): string => {
    return synonyms.map((s) => `[${s}]`).join("");
  };

  // Check if canonical term already exists (excluding current editing group)
  const isDuplicateCanonical = useMemo(() => {
    if (!canonicalTerm.trim()) return false;
    return synonymGroups.some(
      (g) =>
        g.canonical_term.toLowerCase() === canonicalTerm.trim().toLowerCase() &&
        g.id !== editingGroup?.id
    );
  }, [canonicalTerm, synonymGroups, editingGroup]);

  const handleSubmit = async () => {
    const synonyms = parseSynonyms(synonymsText);

    if (!canonicalTerm.trim() || isDuplicateCanonical) return;

    if (editingGroup) {
      await onUpdate(editingGroup.id, canonicalTerm.trim(), synonyms);
    } else {
      await onAdd(canonicalTerm.trim(), synonyms);
    }

    setDialogOpen(false);
    setCanonicalTerm("");
    setSynonymsText("");
    setEditingGroup(null);
  };

  const handleEdit = (group: Synonym) => {
    setEditingGroup(group);
    setCanonicalTerm(group.canonical_term);
    setSynonymsText(formatSynonyms(group.synonyms));
    setDialogOpen(true);
  };

  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setEditingGroup(null);
      setCanonicalTerm("");
      setSynonymsText("");
    }
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="flex items-center justify-between py-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 flex-1 justify-start px-2">
            {isOpen ? (
              <ChevronDown className="mr-2 h-4 w-4" />
            ) : (
              <ChevronRight className="mr-2 h-4 w-4" />
            )}
            <RefreshCw className="mr-2 h-4 w-4" />
            <span>Synonyms</span>
            <Badge variant="secondary" className="ml-2">
              {synonymGroups.length}
            </Badge>
          </Button>
        </CollapsibleTrigger>
        <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
          <DialogTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <Plus className="h-4 w-4" />
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-background">
            <DialogHeader>
              <DialogTitle>
                {editingGroup ? "Edit Synonym Group" : "Add Synonym Group"}
              </DialogTitle>
              <DialogDescription>
                Define a canonical term and its synonyms. All synonyms will display as the
                canonical term.
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
                {isDuplicateCanonical && (
                  <p className="text-xs text-destructive">
                    A synonym group with this canonical term already exists.
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="synonyms">
                  Synonyms (wrap each in square brackets)
                </Label>
                <Textarea
                  id="synonyms"
                  placeholder="e.g., [Low-Density Lipoprotein][LDL-Cholesterol][LDL-C][Diabetes Mellitus, Type 2]"
                  value={synonymsText}
                  onChange={(e) => setSynonymsText(e.target.value)}
                  rows={4}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleDialogOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={!canonicalTerm.trim() || isDuplicateCanonical}>
                {editingGroup ? "Update" : "Add"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <CollapsibleContent>
        <ScrollArea className="h-48">
          <div className="space-y-2 px-2 pb-2">
            {synonymGroups.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
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
                    <div className="text-xs text-muted-foreground truncate">
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
        </ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  );
}
