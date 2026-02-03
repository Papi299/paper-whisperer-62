import { useState, useEffect } from "react";
import { Tag } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface EditTagDialogProps {
  tag: Tag | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (tagId: string, updates: Partial<Tag>) => Promise<void>;
}

const PRESET_COLORS = [
  "#8b5cf6", // violet
  "#6366f1", // indigo
  "#3b82f6", // blue
  "#0ea5e9", // sky
  "#14b8a6", // teal
  "#22c55e", // green
  "#eab308", // yellow
  "#f97316", // orange
  "#ef4444", // red
  "#ec4899", // pink
];

export function EditTagDialog({
  tag,
  open,
  onOpenChange,
  onSave,
}: EditTagDialogProps) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#8b5cf6");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (tag) {
      setName(tag.name);
      setColor(tag.color || "#8b5cf6");
    }
  }, [tag]);

  const handleSave = async () => {
    if (!tag || !name.trim()) return;

    setSaving(true);
    try {
      await onSave(tag.id, {
        name: name.trim(),
        color,
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Tag</DialogTitle>
          <DialogDescription>
            Update the tag name and color.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="tag-name">Name</Label>
            <Input
              id="tag-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tag name"
            />
          </div>
          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-2">
              {PRESET_COLORS.map((presetColor) => (
                <button
                  key={presetColor}
                  type="button"
                  className={`w-8 h-8 rounded-full border-2 transition-all ${
                    color === presetColor
                      ? "border-foreground scale-110"
                      : "border-transparent hover:scale-105"
                  }`}
                  style={{ backgroundColor: presetColor }}
                  onClick={() => setColor(presetColor)}
                />
              ))}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <Label htmlFor="custom-tag-color" className="text-xs text-muted-foreground">
                Custom:
              </Label>
              <Input
                id="custom-tag-color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-12 h-8 p-1 cursor-pointer"
              />
              <Input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-24 h-8 text-xs"
                placeholder="#000000"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
