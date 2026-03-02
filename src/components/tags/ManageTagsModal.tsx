import { useState } from "react";
import { Tag } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Pencil, Trash2, Plus, Tag as TagIcon } from "lucide-react";

interface ManageTagsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tags: Tag[];
  onCreateTag: (name: string) => void;
  onEditTag: (tag: Tag) => void;
  onDeleteTag: (tagId: string) => void;
}

export function ManageTagsModal({
  open,
  onOpenChange,
  tags,
  onCreateTag,
  onEditTag,
  onDeleteTag,
}: ManageTagsModalProps) {
  const [newName, setNewName] = useState("");

  const handleCreate = () => {
    if (newName.trim()) {
      onCreateTag(newName.trim());
      setNewName("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Manage Tags
            {tags.length > 0 && (
              <Badge variant="secondary" className="ml-2 text-xs">{tags.length}</Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            Create, edit, or delete your tags.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            placeholder="New tag name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="flex-1"
          />
          <Button size="sm" onClick={handleCreate} disabled={!newName.trim()}>
            <Plus className="mr-1 h-4 w-4" />
            Add
          </Button>
        </div>

        <div className="flex flex-col gap-2 overflow-y-auto max-h-[50vh] custom-scrollbar p-1">
          {tags.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No tags yet.</p>
          )}
          {tags.map((tag) => (
            <div
              key={tag.id}
              className="flex items-center gap-2 rounded-md border p-2 bg-card"
            >
              <TagIcon
                className="w-3 h-3 shrink-0"
                style={{ color: tag.color }}
              />
              <span className="flex-1 text-sm break-words min-w-0">{tag.name}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => onEditTag(tag)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
                onClick={() => onDeleteTag(tag.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
