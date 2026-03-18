import { useEffect, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { PaperWithTags, Project, Tag } from "@/types/database";
import { Loader2, X, Link as LinkIcon, Check, ChevronsUpDown, FolderOpen, Tags, Trash2, FileText, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAttachments, OnAttachmentsChange } from "@/hooks/useAttachments";

interface EditPaperDialogProps {
  paper: PaperWithTags | null;
  projects: Project[];
  tags: Tag[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (paper: Partial<PaperWithTags> & { tagIds: string[]; projectIds: string[] }) => Promise<void>;
  userId?: string | null;
  onAttachmentsChange?: OnAttachmentsChange;
}

export function EditPaperDialog({
  paper,
  projects,
  tags,
  open,
  onOpenChange,
  onSave,
  userId,
  onAttachmentsChange,
}: EditPaperDialogProps) {
  const [title, setTitle] = useState("");
  const [authors, setAuthors] = useState("");
  const [year, setYear] = useState("");
  const [journal, setJournal] = useState("");
  const [pmid, setPmid] = useState("");
  const [doi, setDoi] = useState("");
  const [abstract, setAbstract] = useState("");
  const [studyType, setStudyType] = useState("");
  const [statisticalMethods, setStatisticalMethods] = useState("");
  const [keywords, setKeywords] = useState("");
  const [driveUrl, setDriveUrl] = useState("");
  const [pubmedUrl, setPubmedUrl] = useState("");
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const { attachments, uploading, uploadAttachments, deleteAttachment } = useAttachments(
    paper?.id,
    userId,
    onAttachmentsChange,
  );

  useEffect(() => {
    if (paper) {
      setTitle(paper.title);
      setAuthors(paper.authors.join(", "));
      setYear(paper.year?.toString() || "");
      setJournal(paper.journal || "");
      setPmid(paper.pmid || "");
      setDoi(paper.doi || "");
      setAbstract(paper.abstract || "");
      setStudyType(paper.study_type || "");
      setStatisticalMethods(paper.statistical_methods || "");
      setKeywords(paper.keywords.join(", "));
      setDriveUrl(paper.drive_url || "");
      setPubmedUrl(paper.pubmed_url || "");
      setSelectedProjectIds(paper.projects.map((p) => p.id));
      setSelectedTagIds(paper.tags.map((t) => t.id));
    }
  }, [paper]);

  const handleSave = async () => {
    if (!paper) return;

    setLoading(true);
    try {
      await onSave({
        id: paper.id,
        title,
        authors: authors.split(",").map((a) => a.trim()).filter(Boolean),
        year: year ? parseInt(year) : null,
        journal: journal || null,
        pmid: pmid || null,
        doi: doi || null,
        abstract: abstract || null,
        study_type: studyType || null,
        statistical_methods: statisticalMethods || null,
        keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean),
        drive_url: driveUrl || null,
        pubmed_url: pubmedUrl || null,
        tagIds: selectedTagIds,
        projectIds: selectedProjectIds,
      });
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  };

  const toggleProject = (projectId: string) => {
    setSelectedProjectIds((prev) =>
      prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId]
    );
  };

  const toggleTag = (tagId: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Paper</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* ── Column 1: Metadata ── */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={loading}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="authors">Authors (comma-separated)</Label>
                <Input
                  id="authors"
                  value={authors}
                  onChange={(e) => setAuthors(e.target.value)}
                  disabled={loading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="year">Year</Label>
                <Input
                  id="year"
                  type="number"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  disabled={loading}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="journal">Journal</Label>
              <Input
                id="journal"
                value={journal}
                onChange={(e) => setJournal(e.target.value)}
                disabled={loading}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="pmid">PMID</Label>
                <Input
                  id="pmid"
                  value={pmid}
                  onChange={(e) => setPmid(e.target.value)}
                  disabled={loading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="doi">DOI</Label>
                <Input
                  id="doi"
                  value={doi}
                  onChange={(e) => setDoi(e.target.value)}
                  disabled={loading}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pubmedUrl">PubMed URL</Label>
              <Input
                id="pubmedUrl"
                value={pubmedUrl}
                onChange={(e) => setPubmedUrl(e.target.value)}
                placeholder="https://pubmed.ncbi.nlm.nih.gov/..."
                disabled={loading}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="driveUrl" className="flex items-center gap-2">
                <LinkIcon className="h-4 w-4" />
                Google Drive Link
              </Label>
              <Input
                id="driveUrl"
                value={driveUrl}
                onChange={(e) => setDriveUrl(e.target.value)}
                placeholder="https://drive.google.com/file/d/..."
                disabled={loading}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="keywords">Keywords (comma-separated)</Label>
              <Input
                id="keywords"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                disabled={loading}
              />
            </div>
          </div>

          {/* ── Column 2: Categorization ── */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="abstract">Abstract</Label>
              <Textarea
                id="abstract"
                value={abstract}
                onChange={(e) => setAbstract(e.target.value)}
                rows={5}
                disabled={loading}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="studyType">Study Type</Label>
                <Input
                  id="studyType"
                  value={studyType}
                  onChange={(e) => setStudyType(e.target.value)}
                  placeholder="e.g., RCT, Meta-analysis"
                  disabled={loading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="statisticalMethods">Statistical Methods</Label>
                <Input
                  id="statisticalMethods"
                  value={statisticalMethods}
                  onChange={(e) => setStatisticalMethods(e.target.value)}
                  placeholder="e.g., ANOVA, Regression"
                  disabled={loading}
                />
              </div>
            </div>

            {/* Projects — Searchable Combobox */}
            <div className="space-y-2 relative">
              <Label>Projects</Label>
              <Popover open={projectOpen} onOpenChange={setProjectOpen} modal={true}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-between h-9" disabled={loading}>
                    <span className="flex items-center gap-1.5">
                      <FolderOpen className="h-3.5 w-3.5" />
                      {selectedProjectIds.length > 0
                        ? `${selectedProjectIds.length} project${selectedProjectIds.length !== 1 ? "s" : ""} selected`
                        : "Select projects..."}
                    </span>
                    <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" side="bottom" align="start" sideOffset={4} avoidCollisions={false} style={{ pointerEvents: 'auto' }}>
                  <Command filter={(value, search) => value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0}>
                    <CommandInput placeholder="Search projects..." />
                    <CommandList>
                      <CommandEmpty>No projects found.</CommandEmpty>
                      <CommandGroup>
                        {projects.map((project) => (
                          <CommandItem
                            key={project.id}
                            value={project.name}
                            onSelect={() => toggleProject(project.id)}
                          >
                            <Check className={cn("mr-2 h-4 w-4", selectedProjectIds.includes(project.id) ? "opacity-100" : "opacity-0")} />
                            <span className="w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: project.color }} />
                            {project.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {selectedProjectIds.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {selectedProjectIds.map((id) => {
                    const project = projects.find((p) => p.id === id);
                    return project ? (
                      <Badge key={id} variant="outline" className="text-xs flex items-center gap-1 pr-1">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: project.color }} />
                        {project.name}
                        <button onClick={() => toggleProject(id)} className="hover:bg-muted rounded p-0.5">
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ) : null;
                  })}
                </div>
              )}
            </div>

            {/* Tags — Searchable Combobox */}
            <div className="space-y-2 relative">
              <Label>Tags</Label>
              <Popover open={tagOpen} onOpenChange={setTagOpen} modal={true}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-between h-9" disabled={loading}>
                    <span className="flex items-center gap-1.5">
                      <Tags className="h-3.5 w-3.5" />
                      {selectedTagIds.length > 0
                        ? `${selectedTagIds.length} tag${selectedTagIds.length !== 1 ? "s" : ""} selected`
                        : "Select tags..."}
                    </span>
                    <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" side="bottom" align="start" sideOffset={4} avoidCollisions={false} style={{ pointerEvents: 'auto' }}>
                  <Command filter={(value, search) => value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0}>
                    <CommandInput placeholder="Search tags..." />
                    <CommandList>
                      <CommandEmpty>No tags found.</CommandEmpty>
                      <CommandGroup>
                        {tags.map((tag) => (
                          <CommandItem
                            key={tag.id}
                            value={tag.name}
                            onSelect={() => toggleTag(tag.id)}
                          >
                            <Check className={cn("mr-2 h-4 w-4", selectedTagIds.includes(tag.id) ? "opacity-100" : "opacity-0")} />
                            <span className="w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: tag.color }} />
                            {tag.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {selectedTagIds.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {selectedTagIds.map((id) => {
                    const tag = tags.find((t) => t.id === id);
                    return tag ? (
                      <Badge key={id} variant="secondary" className="text-xs flex items-center gap-1 pr-1">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color }} />
                        {tag.name}
                        <button onClick={() => toggleTag(id)} className="hover:bg-muted rounded p-0.5">
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ) : null;
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Visuals & Attachments (full width) ── */}
        {userId && paper && (
          <div className="space-y-3">
            <Label className="flex items-center gap-2 text-sm font-medium">
              <Upload className="h-4 w-4" />
              Visuals &amp; Attachments
            </Label>

            {/* Drop zone */}
            <div
              className={cn(
                "flex flex-col items-center justify-center rounded-md border-2 border-dashed p-6 text-center text-sm text-muted-foreground cursor-pointer transition-colors",
                dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                uploading && "pointer-events-none opacity-60",
              )}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const files = Array.from(e.dataTransfer.files);
                if (files.length > 0) uploadAttachments(files);
              }}
            >
              {uploading ? (
                <><Loader2 className="mb-2 h-5 w-5 animate-spin" /> Uploading…</>
              ) : (
                <>
                  <Upload className="mb-2 h-5 w-5" />
                  <span>Drop files here or <span className="text-primary underline">browse</span></span>
                  <span className="mt-1 text-xs">Images &amp; PDFs · Max 20 MB each</span>
                </>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) uploadAttachments(files);
                e.target.value = "";
              }}
            />

            {/* Thumbnail grid */}
            {attachments.length > 0 && (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                {attachments.map((att) => (
                  <div key={att.id} className="group relative rounded-md border overflow-hidden bg-muted">
                    <a href={att.publicUrl} target="_blank" rel="noopener noreferrer" className="block">
                      {att.file_type.startsWith("image/") ? (
                        <img
                          src={att.publicUrl}
                          alt={att.file_name}
                          className="h-20 w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-20 w-full items-center justify-center">
                          <FileText className="h-8 w-8 text-muted-foreground" />
                        </div>
                      )}
                    </a>
                    <p className="truncate px-1 py-0.5 text-[10px] text-muted-foreground">{att.file_name}</p>
                    <button
                      onClick={() => deleteAttachment(att)}
                      className="absolute right-1 top-1 hidden rounded bg-destructive p-0.5 text-destructive-foreground group-hover:flex"
                      title="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
