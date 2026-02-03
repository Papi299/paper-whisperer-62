import { useState } from "react";
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
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Upload,
  X,
  FileText,
} from "lucide-react";
import { PoolStudyType } from "@/hooks/useStudyTypePool";
import { cn } from "@/lib/utils";

interface StudyTypePoolSectionProps {
  poolStudyTypes: PoolStudyType[];
  availableStudyTypes: string[];
  onAddStudyType: (studyType: string) => Promise<boolean>;
  onAddMultipleStudyTypes: (studyTypes: string[]) => Promise<number>;
  onDeleteStudyType: (id: string) => void;
  onDeleteAllStudyTypes: () => void;
}

export function StudyTypePoolSection({
  poolStudyTypes,
  availableStudyTypes,
  onAddStudyType,
  onAddMultipleStudyTypes,
  onDeleteStudyType,
  onDeleteAllStudyTypes,
}: StudyTypePoolSectionProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [showInput, setShowInput] = useState(false);
  const [newStudyType, setNewStudyType] = useState("");
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkStudyTypes, setBulkStudyTypes] = useState("");
  const [selectedForImport, setSelectedForImport] = useState<Set<string>>(
    new Set()
  );
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  const handleAddStudyType = async () => {
    if (newStudyType.trim()) {
      const success = await onAddStudyType(newStudyType);
      if (success) {
        setNewStudyType("");
        setShowInput(false);
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
    const studyTypes = bulkStudyTypes
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => s);
    if (studyTypes.length > 0) {
      await onAddMultipleStudyTypes(studyTypes);
      setBulkStudyTypes("");
      setBulkDialogOpen(false);
    }
  };

  const toggleImportStudyType = (studyType: string) => {
    setSelectedForImport((prev) => {
      const next = new Set(prev);
      if (next.has(studyType)) {
        next.delete(studyType);
      } else {
        next.add(studyType);
      }
      return next;
    });
  };

  const selectAllForImport = () => {
    const existingInPool = new Set(poolStudyTypes.map((st) => st.study_type.toLowerCase()));
    const newStudyTypes = availableStudyTypes.filter(
      (st) => !existingInPool.has(st.toLowerCase())
    );
    setSelectedForImport(new Set(newStudyTypes));
  };

  const existingInPool = new Set(poolStudyTypes.map((st) => st.study_type.toLowerCase()));
  const importableStudyTypes = availableStudyTypes.filter(
    (st) => !existingInPool.has(st.toLowerCase())
  );

  return (
    <>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className="flex items-center justify-between">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="p-0 h-auto hover:bg-transparent"
            >
              {isOpen ? (
                <ChevronDown className="h-4 w-4 mr-1" />
              ) : (
                <ChevronRight className="h-4 w-4 mr-1" />
              )}
              <FileText className="h-3 w-3 mr-1 text-cyan-500" />
              <span className="text-sm font-medium text-muted-foreground">
                Study Type Pool
              </span>
              {poolStudyTypes.length > 0 && (
                <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-xs">
                  {poolStudyTypes.length}
                </Badge>
              )}
            </Button>
          </CollapsibleTrigger>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6">
                <Plus className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setShowInput(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add single study type
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setBulkDialogOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add multiple study types
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setImportDialogOpen(true)}
                disabled={importableStudyTypes.length === 0}
              >
                <Upload className="mr-2 h-4 w-4" />
                Import from papers
              </DropdownMenuItem>
              {poolStudyTypes.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => setConfirmClearOpen(true)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Clear all
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <CollapsibleContent className="mt-2 space-y-1">
          {showInput && (
            <div className="flex gap-1">
              <Input
                placeholder="Study type"
                value={newStudyType}
                onChange={(e) => setNewStudyType(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddStudyType()}
                className="h-8 text-sm"
                autoFocus
              />
              <Button size="sm" className="h-8" onClick={handleAddStudyType}>
                Add
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0"
                onClick={() => {
                  setShowInput(false);
                  setNewStudyType("");
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}
          {poolStudyTypes.length === 0 ? (
            <p className="text-xs text-muted-foreground px-2 py-1">
              No study types yet. Add study types to auto-detect them in paper
              titles.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1 pt-1">
              {poolStudyTypes.map((st) => (
                <Badge
                  key={st.id}
                  variant="outline"
                  className="text-xs group cursor-default pr-1 border-cyan-500/50 text-cyan-600 dark:text-cyan-400"
                >
                  {st.study_type}
                  <button
                    className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => onDeleteStudyType(st.id)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>

      {/* Import from papers dialog */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Import Study Types from Papers</DialogTitle>
            <DialogDescription>
              Select study types from your existing papers to add to your pool.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {importableStudyTypes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                All study types from your papers are already in your pool.
              </p>
            ) : (
              <>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm text-muted-foreground">
                    {selectedForImport.size} selected
                  </span>
                  <Button variant="ghost" size="sm" onClick={selectAllForImport}>
                    Select all
                  </Button>
                </div>
                <ScrollArea className="h-[200px] border rounded-md p-2">
                  <div className="flex flex-wrap gap-1">
                    {importableStudyTypes.map((studyType) => (
                      <Badge
                        key={studyType}
                        variant={
                          selectedForImport.has(studyType) ? "default" : "outline"
                        }
                        className={cn(
                          "cursor-pointer text-xs",
                          selectedForImport.has(studyType) &&
                            "bg-primary text-primary-foreground"
                        )}
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
            <Button variant="outline" onClick={() => setImportDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleImportSelected}
              disabled={selectedForImport.size === 0}
            >
              Import ({selectedForImport.size})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk add dialog */}
      <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Multiple Study Types</DialogTitle>
            <DialogDescription>
              Enter study types separated by commas or new lines.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="e.g., Randomized Controlled Trial, Meta-Analysis, Cohort Study"
            value={bulkStudyTypes}
            onChange={(e) => setBulkStudyTypes(e.target.value)}
            rows={6}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleBulkAdd} disabled={!bulkStudyTypes.trim()}>
              Add Study Types
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm clear dialog */}
      <Dialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear Study Type Pool?</DialogTitle>
            <DialogDescription>
              This will remove all {poolStudyTypes.length} study type(s) from your
              pool. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClearOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                onDeleteAllStudyTypes();
                setConfirmClearOpen(false);
              }}
            >
              Clear All
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
