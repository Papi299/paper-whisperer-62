import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Plus, X, Trash2 } from "lucide-react";
import { ExcludedKeyword, ExcludedStudyType } from "@/hooks/useExclusionPools";

interface ManageExclusionsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  excludedKeywords: ExcludedKeyword[];
  excludedStudyTypes: ExcludedStudyType[];
  onAddExcludedKeyword: (keyword: string) => Promise<boolean>;
  onDeleteExcludedKeyword: (id: string) => Promise<void>;
  onClearExcludedKeywords: () => Promise<void>;
  onAddExcludedStudyType: (studyType: string) => Promise<boolean>;
  onDeleteExcludedStudyType: (id: string) => Promise<void>;
  onClearExcludedStudyTypes: () => Promise<void>;
}

export function ManageExclusionsModal({
  open,
  onOpenChange,
  excludedKeywords,
  excludedStudyTypes,
  onAddExcludedKeyword,
  onDeleteExcludedKeyword,
  onClearExcludedKeywords,
  onAddExcludedStudyType,
  onDeleteExcludedStudyType,
  onClearExcludedStudyTypes,
}: ManageExclusionsModalProps) {
  const [newKeyword, setNewKeyword] = useState("");
  const [newStudyType, setNewStudyType] = useState("");

  const handleAddKeyword = async () => {
    if (newKeyword.trim()) {
      const success = await onAddExcludedKeyword(newKeyword);
      if (success) setNewKeyword("");
    }
  };

  const handleAddStudyType = async () => {
    if (newStudyType.trim()) {
      const success = await onAddExcludedStudyType(newStudyType.trim());
      if (success) setNewStudyType("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-background max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage Exclusion Pools</DialogTitle>
          <DialogDescription>
            Excluded keywords and study types are hidden from display.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-6 pr-3">
            {/* Keyword Exclusions */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">
                  Excluded Keywords ({excludedKeywords.length})
                </Label>
                {excludedKeywords.length > 0 && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
                        <Trash2 className="h-3 w-3 mr-1" />
                        Clear
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Clear all excluded keywords?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will remove all {excludedKeywords.length} keywords from your exclusion list.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={onClearExcludedKeywords}>
                          Clear All
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>

              <div className="flex gap-1">
                <Input
                  placeholder="Add keyword to exclude..."
                  value={newKeyword}
                  onChange={(e) => setNewKeyword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddKeyword()}
                  className="h-8 text-sm"
                />
                <Button size="sm" className="h-8 px-2" onClick={handleAddKeyword}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              {excludedKeywords.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {excludedKeywords.map((ek) => (
                    <Badge
                      key={ek.id}
                      variant="destructive"
                      className="text-xs flex items-center gap-1 pr-1"
                    >
                      {ek.keyword}
                      <button
                        onClick={() => onDeleteExcludedKeyword(ek.id)}
                        className="hover:bg-destructive-foreground/20 rounded p-0.5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* Study Type Exclusions */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">
                  Excluded Study Types ({excludedStudyTypes.length})
                </Label>
                {excludedStudyTypes.length > 0 && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
                        <Trash2 className="h-3 w-3 mr-1" />
                        Clear
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Clear all excluded study types?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will remove all {excludedStudyTypes.length} study types from your exclusion list.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={onClearExcludedStudyTypes}>
                          Clear All
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>

              <div className="flex gap-1">
                <Input
                  placeholder="Type study type to exclude..."
                  value={newStudyType}
                  onChange={(e) => setNewStudyType(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddStudyType()}
                  className="h-8 text-sm"
                />
                <Button size="sm" className="h-8 px-2" onClick={handleAddStudyType}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              {excludedStudyTypes.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {excludedStudyTypes.map((est) => (
                    <Badge
                      key={est.id}
                      variant="destructive"
                      className="text-xs flex items-center gap-1 pr-1"
                    >
                      {est.study_type}
                      <button
                        onClick={() => onDeleteExcludedStudyType(est.id)}
                        className="hover:bg-destructive-foreground/20 rounded p-0.5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
