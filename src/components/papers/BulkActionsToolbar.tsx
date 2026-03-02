import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Trash2, FolderOpen, Tags, X, Loader2, FolderMinus, TagsIcon } from "lucide-react";
import { Project, Tag } from "@/types/database";

interface BulkActionsToolbarProps {
  selectedCount: number;
  onClearSelection: () => void;
  onBulkDelete: () => Promise<void>;
  onBulkSetProjects: (projectIds: string[]) => Promise<void>;
  onBulkSetTags: (tagIds: string[]) => Promise<void>;
  projects: Project[];
  tags: Tag[];
}

export function BulkActionsToolbar({
  selectedCount,
  onClearSelection,
  onBulkDelete,
  onBulkSetProjects,
  onBulkSetTags,
  projects,
  tags,
}: BulkActionsToolbarProps) {
  const [loading, setLoading] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [clearProjectsConfirmOpen, setClearProjectsConfirmOpen] = useState(false);
  const [clearTagsConfirmOpen, setClearTagsConfirmOpen] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  const handleDelete = async () => {
    setLoading(true);
    try {
      await onBulkDelete();
    } finally {
      setLoading(false);
      setDeleteConfirmOpen(false);
    }
  };

  const handleSetProjects = async () => {
    setLoading(true);
    try {
      await onBulkSetProjects(selectedProjectIds);
    } finally {
      setLoading(false);
      setProjectDialogOpen(false);
      setSelectedProjectIds([]);
    }
  };

  const handleClearProjects = async () => {
    setLoading(true);
    try {
      await onBulkSetProjects([]);
    } finally {
      setLoading(false);
      setClearProjectsConfirmOpen(false);
    }
  };

  const handleSetTags = async () => {
    setLoading(true);
    try {
      await onBulkSetTags(selectedTagIds);
    } finally {
      setLoading(false);
      setTagDialogOpen(false);
      setSelectedTagIds([]);
    }
  };

  const handleClearTags = async () => {
    setLoading(true);
    try {
      await onBulkSetTags([]);
    } finally {
      setLoading(false);
      setClearTagsConfirmOpen(false);
    }
  };

  const toggleProject = (id: string) => {
    setSelectedProjectIds(prev =>
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    );
  };

  const toggleTag = (id: string) => {
    setSelectedTagIds(prev =>
      prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]
    );
  };

  if (selectedCount === 0) return null;

  return (
    <>
      <div className="sticky bottom-4 z-50 mx-auto w-fit">
        <div className="flex items-center gap-3 rounded-lg border bg-background/95 backdrop-blur px-4 py-2.5 shadow-lg">
          <Badge variant="secondary" className="text-sm font-medium">
            {selectedCount} selected
          </Badge>

          <div className="h-5 w-px bg-border" />

          <Button
            variant="destructive"
            size="sm"
            disabled={loading}
            onClick={() => setDeleteConfirmOpen(true)}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Trash2 className="h-4 w-4 mr-1" />}
            Delete
          </Button>

          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => { setSelectedProjectIds([]); setProjectDialogOpen(true); }}
          >
            <FolderOpen className="h-4 w-4 mr-1" />
            Set Project
          </Button>

          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => setClearProjectsConfirmOpen(true)}
          >
            <FolderMinus className="h-4 w-4 mr-1" />
            Clear Projects
          </Button>

          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => { setSelectedTagIds([]); setTagDialogOpen(true); }}
          >
            <Tags className="h-4 w-4 mr-1" />
            Set Tags
          </Button>

          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => setClearTagsConfirmOpen(true)}
          >
            <X className="h-4 w-4 mr-1" />
            Clear Tags
          </Button>

          <div className="h-5 w-px bg-border" />

          <Button variant="ghost" size="sm" onClick={onClearSelection} disabled={loading}>
            <X className="h-4 w-4 mr-1" />
            Clear Selection
          </Button>
        </div>
      </div>

      {/* Delete confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selectedCount} paper{selectedCount !== 1 ? "s" : ""}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">This action cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)} disabled={loading}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear Projects confirmation */}
      <Dialog open={clearProjectsConfirmOpen} onOpenChange={setClearProjectsConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear projects from {selectedCount} paper{selectedCount !== 1 ? "s" : ""}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">All project assignments will be removed from the selected papers.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearProjectsConfirmOpen(false)} disabled={loading}>Cancel</Button>
            <Button variant="destructive" onClick={handleClearProjects} disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Clear Projects
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear Tags confirmation */}
      <Dialog open={clearTagsConfirmOpen} onOpenChange={setClearTagsConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear tags from {selectedCount} paper{selectedCount !== 1 ? "s" : ""}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">All tag assignments will be removed from the selected papers.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearTagsConfirmOpen(false)} disabled={loading}>Cancel</Button>
            <Button variant="destructive" onClick={handleClearTags} disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Clear Tags
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set Project dialog */}
      <Dialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set Projects for {selectedCount} paper{selectedCount !== 1 ? "s" : ""}</DialogTitle>
          </DialogHeader>
          <div className="max-h-60 overflow-y-auto space-y-2">
            {projects.length === 0 && <p className="text-sm text-muted-foreground">No projects available.</p>}
            {projects.map(p => (
              <label key={p.id} className="flex items-center gap-2 cursor-pointer py-1">
                <Checkbox
                  checked={selectedProjectIds.includes(p.id)}
                  onCheckedChange={() => toggleProject(p.id)}
                />
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: p.color }} />
                <span className="text-sm">{p.name}</span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProjectDialogOpen(false)} disabled={loading}>Cancel</Button>
            <Button onClick={handleSetProjects} disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set Tags dialog */}
      <Dialog open={tagDialogOpen} onOpenChange={setTagDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set Tags for {selectedCount} paper{selectedCount !== 1 ? "s" : ""}</DialogTitle>
          </DialogHeader>
          <div className="max-h-60 overflow-y-auto space-y-2">
            {tags.length === 0 && <p className="text-sm text-muted-foreground">No tags available.</p>}
            {tags.map(t => (
              <label key={t.id} className="flex items-center gap-2 cursor-pointer py-1">
                <Checkbox
                  checked={selectedTagIds.includes(t.id)}
                  onCheckedChange={() => toggleTag(t.id)}
                />
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.color }} />
                <span className="text-sm">{t.name}</span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTagDialogOpen(false)} disabled={loading}>Cancel</Button>
            <Button onClick={handleSetTags} disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
