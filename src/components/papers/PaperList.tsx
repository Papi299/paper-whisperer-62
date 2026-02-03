import { PaperWithTags, Tag } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ExternalLink, MoreHorizontal, Pencil, Trash2, FolderOpen, Sparkles } from "lucide-react";

interface PaperListProps {
  papers: PaperWithTags[];
  onEdit: (paper: PaperWithTags) => void;
  onDelete: (paperId: string) => void;
  findMatchingKeywords: (abstract: string | null) => string[];
}

export function PaperList({ papers, onEdit, onDelete, findMatchingKeywords }: PaperListProps) {
  const generateGoogleScholarUrl = (title: string) => {
    return `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}`;
  };

  if (papers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-muted-foreground mb-2">No papers yet</p>
        <p className="text-sm text-muted-foreground">
          Add papers using PMIDs, DOIs, or titles
        </p>
      </div>
    );
  }

  // Helper function to get unique combined keywords
  const getCombinedKeywords = (paper: PaperWithTags, matchedPoolKeywords: string[]) => {
    const allKeywords = new Set<string>();
    const result: { keyword: string; source: 'pool' | 'mesh' | 'substance' }[] = [];
    
    // Add matched pool keywords first (highest priority)
    matchedPoolKeywords.forEach(kw => {
      const normalizedKw = kw.toLowerCase();
      if (!allKeywords.has(normalizedKw)) {
        allKeywords.add(normalizedKw);
        result.push({ keyword: kw, source: 'pool' });
      }
    });
    
    // Add MeSH terms (skip if already present)
    (paper.mesh_terms || []).forEach(kw => {
      const normalizedKw = kw.toLowerCase();
      if (!allKeywords.has(normalizedKw)) {
        allKeywords.add(normalizedKw);
        result.push({ keyword: kw, source: 'mesh' });
      }
    });
    
    // Add Substances (skip if already present)
    (paper.substances || []).forEach(kw => {
      const normalizedKw = kw.toLowerCase();
      if (!allKeywords.has(normalizedKw)) {
        allKeywords.add(normalizedKw);
        result.push({ keyword: kw, source: 'substance' });
      }
    });
    
    return result;
  };

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[35%]">Title</TableHead>
            <TableHead>Authors</TableHead>
            <TableHead>Year</TableHead>
            <TableHead>Journal</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead>Keywords</TableHead>
            <TableHead>Links</TableHead>
            <TableHead className="w-[50px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {papers.map((paper) => {
            const matchedPoolKeywords = findMatchingKeywords(paper.abstract);
            const combinedKeywords = getCombinedKeywords(paper, matchedPoolKeywords);
            return (
              <TableRow key={paper.id}>
                <TableCell className="font-medium">
                  <div className="space-y-1">
                    <p className="line-clamp-2">{paper.title}</p>
                    {paper.project && (
                      <Badge variant="outline" className="text-xs">
                        <div
                          className="w-2 h-2 rounded-full mr-1"
                          style={{ backgroundColor: paper.project.color }}
                        />
                        {paper.project.name}
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {paper.authors.slice(0, 3).join(", ")}
                  {paper.authors.length > 3 && " et al."}
                </TableCell>
                <TableCell>{paper.year || "-"}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {paper.journal || "-"}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {paper.tags.slice(0, 3).map((tag) => (
                      <Badge
                        key={tag.id}
                        variant="secondary"
                        className="text-xs"
                        style={{ borderColor: tag.color }}
                      >
                        {tag.name}
                      </Badge>
                    ))}
                    {paper.tags.length > 3 && (
                      <Badge variant="secondary" className="text-xs">
                        +{paper.tags.length - 3}
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1 max-w-[200px]">
                    {combinedKeywords.slice(0, 4).map(({ keyword, source }) => (
                      <Badge
                        key={`${source}-${keyword}`}
                        variant="outline"
                        className={`text-xs ${
                          source === 'pool' 
                            ? 'border-amber-500/50 text-amber-600 dark:text-amber-400' 
                            : source === 'mesh'
                            ? 'border-blue-500/50 text-blue-600 dark:text-blue-400'
                            : 'border-green-500/50 text-green-600 dark:text-green-400'
                        }`}
                      >
                        {source === 'pool' && <Sparkles className="h-2.5 w-2.5 mr-1" />}
                        {keyword}
                      </Badge>
                    ))}
                    {combinedKeywords.length > 4 && (
                      <Badge variant="outline" className="text-xs">
                        +{combinedKeywords.length - 4}
                      </Badge>
                    )}
                  </div>
                </TableCell>
              <TableCell>
                <div className="flex gap-1">
                  {paper.drive_url && (
                    <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                      <a
                        href={paper.drive_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open in Google Drive"
                      >
                        <FolderOpen className="h-4 w-4" />
                      </a>
                    </Button>
                  )}
                  {paper.pubmed_url && (
                    <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                      <a href={paper.pubmed_url} target="_blank" rel="noopener noreferrer" title="PubMed">
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </Button>
                  )}
                  {paper.journal_url && (
                    <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                      <a href={paper.journal_url} target="_blank" rel="noopener noreferrer" title="Journal">
                        <span className="text-xs font-bold">J</span>
                      </a>
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                    <a
                      href={generateGoogleScholarUrl(paper.title)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Search on Google Scholar"
                    >
                      <span className="text-xs font-bold">GS</span>
                    </a>
                  </Button>
                </div>
              </TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onEdit(paper)}>
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => onDelete(paper.id)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
