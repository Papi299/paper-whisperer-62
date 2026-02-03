import { useEffect, useState } from "react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PaperWithTags, Project, Tag } from "@/types/database";
import { Loader2, X, Link as LinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface EditPaperDialogProps {
  paper: PaperWithTags | null;
  projects: Project[];
  tags: Tag[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (paper: Partial<PaperWithTags> & { tagIds: string[] }) => Promise<void>;
}

export function EditPaperDialog({
  paper,
  projects,
  tags,
  open,
  onOpenChange,
  onSave,
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
  const [projectId, setProjectId] = useState<string | null>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

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
      setProjectId(paper.project_id);
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
        project_id: projectId,
        tagIds: selectedTagIds,
      });
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  };

  const toggleTag = (tagId: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Paper</DialogTitle>
        </DialogHeader>
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
            <Label htmlFor="abstract">Abstract</Label>
            <Textarea
              id="abstract"
              value={abstract}
              onChange={(e) => setAbstract(e.target.value)}
              rows={3}
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

          <div className="space-y-2">
            <Label htmlFor="keywords">Keywords (comma-separated)</Label>
            <Input
              id="keywords"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
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
            <Label>Project</Label>
            <Select
              value={projectId || "none"}
              onValueChange={(v) => setProjectId(v === "none" ? null : v)}
              disabled={loading}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No project</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    <div className="flex items-center gap-2">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: project.color }}
                      />
                      {project.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Tags</Label>
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => (
                <Badge
                  key={tag.id}
                  variant={selectedTagIds.includes(tag.id) ? "default" : "outline"}
                  className="cursor-pointer"
                  onClick={() => toggleTag(tag.id)}
                  style={
                    selectedTagIds.includes(tag.id)
                      ? { backgroundColor: tag.color }
                      : { borderColor: tag.color }
                  }
                >
                  {tag.name}
                  {selectedTagIds.includes(tag.id) && (
                    <X className="ml-1 h-3 w-3" />
                  )}
                </Badge>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
