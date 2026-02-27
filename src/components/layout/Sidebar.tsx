import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Project, Tag } from "@/types/database";
import { PoolKeyword } from "@/hooks/useKeywordPool";
import { Synonym } from "@/hooks/useSynonymPool";
import { ExcludedKeyword, ExcludedStudyType } from "@/hooks/useExclusionPools";
import { PoolStudyType } from "@/hooks/useStudyTypePool";
import {
  FolderOpen,
  Tag as TagIcon,
  Plus,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { KeywordPoolSection } from "@/components/keywords/KeywordPoolSection";
import { SynonymPoolSection } from "@/components/synonyms/SynonymPoolSection";
import { ExclusionPoolsSection } from "@/components/exclusions/ExclusionPoolsSection";
import { StudyTypePoolSection } from "@/components/study-types/StudyTypePoolSection";

interface SidebarProps {
  projects: Project[];
  tags: Tag[];
  selectedProjectId: string | null;
  selectedTagId: string | null;
  onSelectProject: (projectId: string | null) => void;
  onSelectTag: (tagId: string | null) => void;
  onCreateProject: (name: string) => void;
  onCreateTag: (name: string) => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (projectId: string) => void;
  onEditTag: (tag: Tag) => void;
  onDeleteTag: (tagId: string) => void;
  // Keyword pool props
  poolKeywords: PoolKeyword[];
  availableKeywords: string[];
  onAddPoolKeyword: (keyword: string) => Promise<boolean>;
  onAddMultiplePoolKeywords: (keywords: string[]) => Promise<number>;
  onDeletePoolKeyword: (keywordId: string) => void;
  onDeleteAllPoolKeywords: () => void;
  // Synonym pool props
  synonymGroups: Synonym[];
  onAddSynonymGroup: (canonicalTerm: string, synonyms: string[]) => Promise<void>;
  onUpdateSynonymGroup: (id: string, canonicalTerm: string, synonyms: string[]) => Promise<void>;
  onDeleteSynonymGroup: (id: string) => Promise<void>;
  // Exclusion pool props
  excludedKeywords: ExcludedKeyword[];
  excludedStudyTypes: ExcludedStudyType[];
  onAddExcludedKeyword: (keyword: string) => Promise<boolean>;
  onDeleteExcludedKeyword: (id: string) => Promise<void>;
  onClearExcludedKeywords: () => Promise<void>;
  onAddExcludedStudyType: (studyType: string) => Promise<boolean>;
  onDeleteExcludedStudyType: (id: string) => Promise<void>;
  onClearExcludedStudyTypes: () => Promise<void>;
  // Study type pool props
  poolStudyTypes: PoolStudyType[];
  availableStudyTypes: string[];
  onAddPoolStudyType: (studyType: string) => Promise<boolean>;
  onAddMultiplePoolStudyTypes: (studyTypes: string[]) => Promise<number>;
  onDeletePoolStudyType: (id: string) => void;
  onDeleteAllPoolStudyTypes: () => void;
  onUpdateStudyTypeWeight: (id: string, weight: number) => Promise<void>;
}

export function Sidebar({
  projects,
  tags,
  selectedProjectId,
  selectedTagId,
  onSelectProject,
  onSelectTag,
  onCreateProject,
  onCreateTag,
  onEditProject,
  onDeleteProject,
  onEditTag,
  onDeleteTag,
  poolKeywords,
  availableKeywords,
  onAddPoolKeyword,
  onAddMultiplePoolKeywords,
  onDeletePoolKeyword,
  onDeleteAllPoolKeywords,
  synonymGroups,
  onAddSynonymGroup,
  onUpdateSynonymGroup,
  onDeleteSynonymGroup,
  excludedKeywords,
  excludedStudyTypes,
  onAddExcludedKeyword,
  onDeleteExcludedKeyword,
  onClearExcludedKeywords,
  onAddExcludedStudyType,
  onDeleteExcludedStudyType,
  onClearExcludedStudyTypes,
  poolStudyTypes,
  availableStudyTypes,
  onAddPoolStudyType,
  onAddMultiplePoolStudyTypes,
  onDeletePoolStudyType,
  onDeleteAllPoolStudyTypes,
  onUpdateStudyTypeWeight,
}: SidebarProps) {
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [tagsOpen, setTagsOpen] = useState(true);
  const [newProjectName, setNewProjectName] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [showProjectInput, setShowProjectInput] = useState(false);
  const [showTagInput, setShowTagInput] = useState(false);

  const handleCreateProject = () => {
    if (newProjectName.trim()) {
      onCreateProject(newProjectName.trim());
      setNewProjectName("");
      setShowProjectInput(false);
    }
  };

  const handleCreateTag = () => {
    if (newTagName.trim()) {
      onCreateTag(newTagName.trim());
      setNewTagName("");
      setShowTagInput(false);
    }
  };

  return (
    <aside className="w-64 border-r bg-muted/30 flex flex-col">
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4">
          {/* All Papers */}
          <Button
            variant={selectedProjectId === null && selectedTagId === null ? "secondary" : "ghost"}
            className="w-full justify-start"
            onClick={() => {
              onSelectProject(null);
              onSelectTag(null);
            }}
          >
            <FolderOpen className="mr-2 h-4 w-4" />
            All Papers
          </Button>

          {/* Projects */}
          <Collapsible open={projectsOpen} onOpenChange={setProjectsOpen}>
            <div className="flex items-center justify-between">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="p-0 h-auto hover:bg-transparent">
                  {projectsOpen ? (
                    <ChevronDown className="h-4 w-4 mr-1" />
                  ) : (
                    <ChevronRight className="h-4 w-4 mr-1" />
                  )}
                  <span className="text-sm font-medium text-muted-foreground">Projects</span>
                </Button>
              </CollapsibleTrigger>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setShowProjectInput(true)}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <CollapsibleContent className="mt-2 space-y-1">
              {showProjectInput && (
                <div className="flex gap-1">
                  <Input
                    placeholder="Project name"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateProject()}
                    className="h-8 text-sm"
                    autoFocus
                  />
                  <Button size="sm" className="h-8" onClick={handleCreateProject}>
                    Add
                  </Button>
                </div>
              )}
              {projects.map((project) => (
                <div
                  key={project.id}
                  className={cn(
                    "flex items-center justify-between group rounded-md",
                    selectedProjectId === project.id && "bg-secondary"
                  )}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex-1 justify-start h-8"
                    onClick={() => {
                      onSelectProject(project.id);
                      onSelectTag(null);
                    }}
                  >
                    <div
                      className="w-2 h-2 rounded-full mr-2"
                      style={{ backgroundColor: project.color }}
                    />
                    <span className="truncate">{project.name}</span>
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onEditProject(project)}>
                        <Pencil className="mr-2 h-4 w-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => onDeleteProject(project.id)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>

          {/* Tags */}
          <Collapsible open={tagsOpen} onOpenChange={setTagsOpen}>
            <div className="flex items-center justify-between">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="p-0 h-auto hover:bg-transparent">
                  {tagsOpen ? (
                    <ChevronDown className="h-4 w-4 mr-1" />
                  ) : (
                    <ChevronRight className="h-4 w-4 mr-1" />
                  )}
                  <span className="text-sm font-medium text-muted-foreground">Tags</span>
                </Button>
              </CollapsibleTrigger>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setShowTagInput(true)}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <CollapsibleContent className="mt-2 space-y-1">
              {showTagInput && (
                <div className="flex gap-1">
                  <Input
                    placeholder="Tag name"
                    value={newTagName}
                    onChange={(e) => setNewTagName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateTag()}
                    className="h-8 text-sm"
                    autoFocus
                  />
                  <Button size="sm" className="h-8" onClick={handleCreateTag}>
                    Add
                  </Button>
                </div>
              )}
              {tags.map((tag) => (
                <div
                  key={tag.id}
                  className={cn(
                    "flex items-center justify-between group rounded-md",
                    selectedTagId === tag.id && "bg-secondary"
                  )}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex-1 justify-start h-8"
                    onClick={() => {
                      onSelectTag(tag.id);
                      onSelectProject(null);
                    }}
                  >
                    <TagIcon
                      className="w-3 h-3 mr-2"
                      style={{ color: tag.color }}
                    />
                    <span className="truncate">{tag.name}</span>
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onEditTag(tag)}>
                        <Pencil className="mr-2 h-4 w-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => onDeleteTag(tag.id)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>

          {/* Keyword Pool */}
          <KeywordPoolSection
            poolKeywords={poolKeywords}
            availableKeywords={availableKeywords}
            onAddKeyword={onAddPoolKeyword}
            onAddMultipleKeywords={onAddMultiplePoolKeywords}
            onDeleteKeyword={onDeletePoolKeyword}
            onDeleteAllKeywords={onDeleteAllPoolKeywords}
          />

          {/* Study Type Pool */}
          <StudyTypePoolSection
            poolStudyTypes={poolStudyTypes}
            availableStudyTypes={availableStudyTypes}
            onAddStudyType={onAddPoolStudyType}
            onAddMultipleStudyTypes={onAddMultiplePoolStudyTypes}
            onDeleteStudyType={onDeletePoolStudyType}
            onDeleteAllStudyTypes={onDeleteAllPoolStudyTypes}
            onUpdateStudyTypeWeight={onUpdateStudyTypeWeight}
          />

          {/* Synonym Pool */}
          <SynonymPoolSection
            synonymGroups={synonymGroups}
            onAdd={onAddSynonymGroup}
            onUpdate={onUpdateSynonymGroup}
            onDelete={onDeleteSynonymGroup}
          />

          {/* Exclusion Pools */}
          <ExclusionPoolsSection
            excludedKeywords={excludedKeywords}
            excludedStudyTypes={excludedStudyTypes}
            onAddExcludedKeyword={onAddExcludedKeyword}
            onDeleteExcludedKeyword={onDeleteExcludedKeyword}
            onClearExcludedKeywords={onClearExcludedKeywords}
            onAddExcludedStudyType={onAddExcludedStudyType}
            onDeleteExcludedStudyType={onDeleteExcludedStudyType}
            onClearExcludedStudyTypes={onClearExcludedStudyTypes}
          />
        </div>
      </ScrollArea>
    </aside>
  );
}
