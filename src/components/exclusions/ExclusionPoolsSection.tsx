import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { ChevronDown, ChevronRight, Plus, X, Trash2, Ban } from "lucide-react";
import { ExcludedKeyword, ExcludedStudyType } from "@/hooks/useExclusionPools";

interface ExclusionPoolsSectionProps {
  excludedKeywords: ExcludedKeyword[];
  excludedStudyTypes: ExcludedStudyType[];
  onAddExcludedKeyword: (keyword: string) => Promise<boolean>;
  onDeleteExcludedKeyword: (id: string) => Promise<void>;
  onClearExcludedKeywords: () => Promise<void>;
  onAddExcludedStudyType: (studyType: string) => Promise<boolean>;
  onDeleteExcludedStudyType: (id: string) => Promise<void>;
  onClearExcludedStudyTypes: () => Promise<void>;
}

const STUDY_TYPES = [
  "RCT",
  "Meta-analysis",
  "Systematic Review",
  "Cohort Study",
  "Case-Control",
  "Cross-sectional",
  "Case Report",
  "Review",
];

export function ExclusionPoolsSection({
  excludedKeywords,
  excludedStudyTypes,
  onAddExcludedKeyword,
  onDeleteExcludedKeyword,
  onClearExcludedKeywords,
  onAddExcludedStudyType,
  onDeleteExcludedStudyType,
  onClearExcludedStudyTypes,
}: ExclusionPoolsSectionProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [newKeyword, setNewKeyword] = useState("");
  const [selectedStudyType, setSelectedStudyType] = useState("");

  const handleAddKeyword = async () => {
    if (newKeyword.trim()) {
      const success = await onAddExcludedKeyword(newKeyword);
      if (success) {
        setNewKeyword("");
      }
    }
  };

  const handleAddStudyType = async () => {
    if (selectedStudyType) {
      const success = await onAddExcludedStudyType(selectedStudyType);
      if (success) {
        setSelectedStudyType("");
      }
    }
  };

  const totalExclusions = excludedKeywords.length + excludedStudyTypes.length;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-between px-2 py-1.5 h-auto font-medium text-sm"
        >
          <span className="flex items-center gap-2">
            <Ban className="h-4 w-4" />
            Exclusion Pools
            {totalExclusions > 0 && (
              <Badge variant="secondary" className="ml-1 text-xs">
                {totalExclusions}
              </Badge>
            )}
          </span>
          {isOpen ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2 py-2 space-y-4">
        {/* Keyword Exclusions */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-medium text-muted-foreground">
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
            <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
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
            <Label className="text-xs font-medium text-muted-foreground">
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
            <Select value={selectedStudyType} onValueChange={setSelectedStudyType}>
              <SelectTrigger className="h-8 text-sm flex-1">
                <SelectValue placeholder="Select study type..." />
              </SelectTrigger>
              <SelectContent className="bg-popover">
                {STUDY_TYPES.filter(
                  (type) =>
                    !excludedStudyTypes.some(
                      (est) => est.study_type.toLowerCase() === type.toLowerCase()
                    )
                ).map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              className="h-8 px-2"
              onClick={handleAddStudyType}
              disabled={!selectedStudyType}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          {excludedStudyTypes.length > 0 && (
            <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
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

        {totalExclusions > 0 && (
          <p className="text-xs text-muted-foreground italic">
            Papers with excluded keywords or study types are hidden from the main table.
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
