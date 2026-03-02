import { useState } from "react";
import { Project } from "@/types/database";
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
import { Pencil, Trash2, Plus } from "lucide-react";

interface ManageProjectsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  onCreateProject: (name: string) => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (projectId: string) => void;
}

export function ManageProjectsModal({
  open,
  onOpenChange,
  projects,
  onCreateProject,
  onEditProject,
  onDeleteProject,
}: ManageProjectsModalProps) {
  const [newName, setNewName] = useState("");

  const handleCreate = () => {
    if (newName.trim()) {
      onCreateProject(newName.trim());
      setNewName("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Manage Projects
            {projects.length > 0 && (
              <Badge variant="secondary" className="ml-2 text-xs">{projects.length}</Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            Create, edit, or delete your projects.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            placeholder="New project name"
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
          {projects.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No projects yet.</p>
          )}
          {projects.map((project) => (
            <div
              key={project.id}
              className="flex items-center gap-2 rounded-md border p-2 bg-card"
            >
              <div
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: project.color }}
              />
              <span className="flex-1 text-sm break-words min-w-0">{project.name}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => onEditProject(project)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
                onClick={() => onDeleteProject(project.id)}
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
