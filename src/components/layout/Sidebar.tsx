import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Project, Tag } from "@/types/database";
import { PoolKeyword } from "@/hooks/useKeywordPool";
import { Synonym } from "@/hooks/useSynonymPool";
import { ExcludedKeyword, ExcludedStudyType } from "@/hooks/useExclusionPools";
import { PoolStudyType } from "@/hooks/useStudyTypePool";
import {
  FolderOpen,
  Tag as TagIcon,
  RefreshCw,
  Ban,
  Settings,
  Sparkles,
  FileText,
} from "lucide-react";
import { ManageSynonymsModal } from "@/components/synonyms/ManageSynonymsModal";
import { ManageExclusionsModal } from "@/components/exclusions/ManageExclusionsModal";
import { ManageKeywordPoolModal } from "@/components/keywords/ManageKeywordPoolModal";
import { ManageStudyTypePoolModal } from "@/components/study-types/ManageStudyTypePoolModal";
import { ManageProjectsModal } from "@/components/projects/ManageProjectsModal";
import { ManageTagsModal } from "@/components/tags/ManageTagsModal";

interface SidebarProps {
  projects: Project[];
  tags: Tag[];
  onCreateProject: (name: string) => void;
  onCreateTag: (name: string) => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (projectId: string) => void;
  onEditTag: (tag: Tag) => void;
  onDeleteTag: (tagId: string) => void;
  poolKeywords: PoolKeyword[];
  availableKeywords: string[];
  onAddPoolKeyword: (keyword: string) => Promise<boolean>;
  onAddMultiplePoolKeywords: (keywords: string[]) => Promise<number>;
  onDeletePoolKeyword: (keywordId: string) => void;
  onDeleteAllPoolKeywords: () => void;
  synonymGroups: Synonym[];
  onAddSynonymGroup: (canonicalTerm: string, synonyms: string[]) => Promise<void>;
  onUpdateSynonymGroup: (id: string, canonicalTerm: string, synonyms: string[]) => Promise<void>;
  onDeleteSynonymGroup: (id: string) => Promise<void>;
  excludedKeywords: ExcludedKeyword[];
  excludedStudyTypes: ExcludedStudyType[];
  onAddExcludedKeyword: (keyword: string) => Promise<boolean>;
  onDeleteExcludedKeyword: (id: string) => Promise<void>;
  onClearExcludedKeywords: () => Promise<void>;
  onAddExcludedStudyType: (studyType: string) => Promise<boolean>;
  onDeleteExcludedStudyType: (id: string) => Promise<void>;
  onClearExcludedStudyTypes: () => Promise<void>;
  poolStudyTypes: PoolStudyType[];
  availableStudyTypes: string[];
  onAddPoolStudyType: (studyType: string, groupName?: string | null, hierarchyRank?: number) => Promise<boolean>;
  onAddMultiplePoolStudyTypes: (studyTypes: string[]) => Promise<number>;
  onUpdatePoolStudyType: (id: string, updates: Partial<Pick<PoolStudyType, 'study_type' | 'group_name' | 'hierarchy_rank'>>) => Promise<void>;
  onDeletePoolStudyType: (id: string) => void;
  onDeleteAllPoolStudyTypes: () => void;
  onRenamePoolGroup: (oldName: string, newName: string, newRank?: number) => Promise<void>;
  onDeletePoolGroup: (groupName: string) => Promise<void>;
  onStudyTypePoolModalClose?: () => void;
}

export function Sidebar({
  projects,
  tags,
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
  onUpdatePoolStudyType,
  onDeletePoolStudyType,
  onDeleteAllPoolStudyTypes,
  onRenamePoolGroup,
  onDeletePoolGroup,
  onStudyTypePoolModalClose,
}: SidebarProps) {
  const [synonymsModalOpen, setSynonymsModalOpen] = useState(false);
  const [exclusionsModalOpen, setExclusionsModalOpen] = useState(false);
  const [keywordPoolModalOpen, setKeywordPoolModalOpen] = useState(false);
  const [studyTypePoolModalOpen, setStudyTypePoolModalOpen] = useState(false);
  const [projectsModalOpen, setProjectsModalOpen] = useState(false);
  const [tagsModalOpen, setTagsModalOpen] = useState(false);

  const totalExclusions = excludedKeywords.length + excludedStudyTypes.length;

  return (
    <aside className="w-64 border-r bg-muted/30 flex flex-col">
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4">
          {/* All Papers */}
          <Button
            variant="ghost"
            className="w-full justify-start"
          >
            <FolderOpen className="mr-2 h-4 w-4" />
            All Papers
          </Button>

          {/* Projects - compact row with Manage button */}
          <div className="flex items-center justify-between py-1 px-2">
            <div className="flex items-center gap-2">
              <FolderOpen className="h-4 w-4 text-indigo-500" />
              <span className="text-sm font-medium text-muted-foreground">Projects</span>
              {projects.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {projects.length}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setProjectsModalOpen(true)}
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>

          {/* Tags - compact row with Manage button */}
          <div className="flex items-center justify-between py-1 px-2">
            <div className="flex items-center gap-2">
              <TagIcon className="h-4 w-4 text-violet-500" />
              <span className="text-sm font-medium text-muted-foreground">Tags</span>
              {tags.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {tags.length}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setTagsModalOpen(true)}
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>

          {/* Keyword Pool - compact row with Manage button */}
          <div className="flex items-center justify-between py-1 px-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-500" />
              <span className="text-sm font-medium text-muted-foreground">Keyword Pool</span>
              {poolKeywords.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {poolKeywords.length}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setKeywordPoolModalOpen(true)}
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>

          {/* Study Type Pool - compact row with Manage button */}
          <div className="flex items-center justify-between py-1 px-2">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-cyan-500" />
              <span className="text-sm font-medium text-muted-foreground">Study Type Pool</span>
              {poolStudyTypes.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {poolStudyTypes.length}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setStudyTypePoolModalOpen(true)}
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>

          {/* Synonyms - compact row with Manage button */}
          <div className="flex items-center justify-between py-1 px-2">
            <div className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium text-muted-foreground">Synonyms</span>
              <Badge variant="secondary" className="text-xs">
                {synonymGroups.length}
              </Badge>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setSynonymsModalOpen(true)}
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>

          {/* Exclusion Pools - compact row with Manage button */}
          <div className="flex items-center justify-between py-1 px-2">
            <div className="flex items-center gap-2">
              <Ban className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium text-muted-foreground">Exclusions</span>
              {totalExclusions > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {totalExclusions}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setExclusionsModalOpen(true)}
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </ScrollArea>

      {/* Modals rendered outside scroll area to avoid clipping */}
      <ManageProjectsModal
        open={projectsModalOpen}
        onOpenChange={setProjectsModalOpen}
        projects={projects}
        onCreateProject={onCreateProject}
        onEditProject={onEditProject}
        onDeleteProject={onDeleteProject}
      />
      <ManageTagsModal
        open={tagsModalOpen}
        onOpenChange={setTagsModalOpen}
        tags={tags}
        onCreateTag={onCreateTag}
        onEditTag={onEditTag}
        onDeleteTag={onDeleteTag}
      />
      <ManageSynonymsModal
        open={synonymsModalOpen}
        onOpenChange={setSynonymsModalOpen}
        synonymGroups={synonymGroups}
        onAdd={onAddSynonymGroup}
        onUpdate={onUpdateSynonymGroup}
        onDelete={onDeleteSynonymGroup}
      />
      <ManageExclusionsModal
        open={exclusionsModalOpen}
        onOpenChange={setExclusionsModalOpen}
        excludedKeywords={excludedKeywords}
        excludedStudyTypes={excludedStudyTypes}
        onAddExcludedKeyword={onAddExcludedKeyword}
        onDeleteExcludedKeyword={onDeleteExcludedKeyword}
        onClearExcludedKeywords={onClearExcludedKeywords}
        onAddExcludedStudyType={onAddExcludedStudyType}
        onDeleteExcludedStudyType={onDeleteExcludedStudyType}
        onClearExcludedStudyTypes={onClearExcludedStudyTypes}
      />
      <ManageKeywordPoolModal
        open={keywordPoolModalOpen}
        onOpenChange={setKeywordPoolModalOpen}
        poolKeywords={poolKeywords}
        availableKeywords={availableKeywords}
        onAddKeyword={onAddPoolKeyword}
        onAddMultipleKeywords={onAddMultiplePoolKeywords}
        onDeleteKeyword={onDeletePoolKeyword}
        onDeleteAllKeywords={onDeleteAllPoolKeywords}
      />
      <ManageStudyTypePoolModal
        open={studyTypePoolModalOpen}
        onOpenChange={(open) => {
          setStudyTypePoolModalOpen(open);
          if (!open) onStudyTypePoolModalClose?.();
        }}
        poolStudyTypes={poolStudyTypes}
        availableStudyTypes={availableStudyTypes}
        onAddStudyType={onAddPoolStudyType}
        onAddMultipleStudyTypes={onAddMultiplePoolStudyTypes}
        onUpdateStudyType={onUpdatePoolStudyType}
        onDeleteStudyType={onDeletePoolStudyType}
        onDeleteAllStudyTypes={onDeleteAllPoolStudyTypes}
        onRenameGroup={onRenamePoolGroup}
        onDeleteGroup={onDeletePoolGroup}
      />
    </aside>
  );
}
