import { PaperWithTags } from "@/types/database";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ExternalLink, MoreHorizontal, Pencil, Trash2, FolderOpen, Sparkles, X } from "lucide-react";
import { ColumnId } from "@/hooks/useColumnVisibility";
import { ResizableTableHeader } from "./ResizableTableHeader";

interface PaperListProps {
  papers: PaperWithTags[];
  onEdit: (paper: PaperWithTags) => void;
  onDelete: (paperId: string) => void;
  findMatchingKeywords: (abstract: string | null) => string[];
  findMatchingStudyTypes: (title: string) => string[];
  visibleColumns: ColumnId[];
  columnWidths: { [key: string]: number };
  onColumnResize: (columnId: ColumnId, width: number) => void;
  normalizeKeyword: (keyword: string) => string;
  excludedKeywords: Set<string>;
  excludedStudyTypes: Set<string>;
  onExcludeStudyType: (studyType: string) => Promise<boolean>;
  onExcludeKeyword: (keyword: string) => Promise<boolean>;
}

// Helper function to deduplicate by specificity - prefer longer/more specific matches
function deduplicateBySpecificity(types: string[]): string[] {
  // Sort by length descending (longer = more specific)
  const sorted = [...types].sort((a, b) => b.length - a.length);
  const result: string[] = [];
  
  for (const type of sorted) {
    const lowerType = type.toLowerCase();
    // Add if no existing result contains this type as a substring
    // AND this type doesn't contain any existing result as substring
    const isDuplicate = result.some(existing => {
      const lowerExisting = existing.toLowerCase();
      return lowerExisting.includes(lowerType) || lowerType.includes(lowerExisting);
    });
    if (!isDuplicate) {
      result.push(type);
    }
  }
  
  return result;
}

export function PaperList({
  papers,
  onEdit,
  onDelete,
  findMatchingKeywords,
  findMatchingStudyTypes,
  visibleColumns,
  columnWidths,
  onColumnResize,
  normalizeKeyword,
  excludedKeywords,
  excludedStudyTypes,
  onExcludeStudyType,
  onExcludeKeyword,
}: PaperListProps) {
  const generateGoogleScholarUrl = (title: string) => {
    return `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}`;
  };

  const isVisible = (columnId: ColumnId) => visibleColumns?.includes(columnId) ?? true;
  const getWidth = (columnId: ColumnId) => columnWidths?.[columnId] || 150;

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

  // Helper function to get unique combined keywords with normalization (excludes filtered keywords)
  const getCombinedKeywords = (paper: PaperWithTags, matchedPoolKeywords: string[]) => {
    const seenNormalized = new Set<string>();
    const result: { keyword: string; displayName: string; source: 'pool' | 'pubmed' | 'mesh' | 'substance' }[] = [];
    
    // Helper to check if keyword should be excluded (with fallback for undefined)
    const isExcluded = (kw: string) => excludedKeywords?.has(kw.toLowerCase()) ?? false;
    
    // Add matched pool keywords first (highest priority)
    matchedPoolKeywords.forEach(kw => {
      if (isExcluded(kw)) return; // Skip excluded keywords
      const displayName = normalizeKeyword(kw);
      const normalizedKey = displayName.toLowerCase();
      if (!seenNormalized.has(normalizedKey)) {
        seenNormalized.add(normalizedKey);
        result.push({ keyword: kw, displayName, source: 'pool' });
      }
    });
    
    // Add PubMed keywords (author-designated, second priority)
    (paper.keywords || []).forEach(kw => {
      if (isExcluded(kw)) return; // Skip excluded keywords
      const displayName = normalizeKeyword(kw);
      const normalizedKey = displayName.toLowerCase();
      if (!seenNormalized.has(normalizedKey)) {
        seenNormalized.add(normalizedKey);
        result.push({ keyword: kw, displayName, source: 'pubmed' });
      }
    });
    
    // Add MeSH terms (skip if already present after normalization or excluded)
    (paper.mesh_terms || []).forEach(kw => {
      if (isExcluded(kw)) return; // Skip excluded keywords
      const displayName = normalizeKeyword(kw);
      const normalizedKey = displayName.toLowerCase();
      if (!seenNormalized.has(normalizedKey)) {
        seenNormalized.add(normalizedKey);
        result.push({ keyword: kw, displayName, source: 'mesh' });
      }
    });
    
    // Add Substances (skip if already present after normalization or excluded)
    (paper.substances || []).forEach(kw => {
      if (isExcluded(kw)) return; // Skip excluded keywords
      const displayName = normalizeKeyword(kw);
      const normalizedKey = displayName.toLowerCase();
      if (!seenNormalized.has(normalizedKey)) {
        seenNormalized.add(normalizedKey);
        result.push({ keyword: kw, displayName, source: 'substance' });
      }
    });
    
    // Sort alphabetically by display name
    result.sort((a, b) => a.displayName.localeCompare(b.displayName));
    
    return result;
  };

  return (
    <div className="rounded-md border overflow-x-auto">
      <Table style={{ tableLayout: "fixed" }}>
        <TableHeader>
          <TableRow>
            {isVisible("title") && (
              <ResizableTableHeader
                columnId="title"
                label="Title"
                width={getWidth("title")}
                onResize={onColumnResize}
              />
            )}
            {isVisible("authors") && (
              <ResizableTableHeader
                columnId="authors"
                label="Authors"
                width={getWidth("authors")}
                onResize={onColumnResize}
              />
            )}
            {isVisible("year") && (
              <ResizableTableHeader
                columnId="year"
                label="Year"
                width={getWidth("year")}
                onResize={onColumnResize}
              />
            )}
            {isVisible("journal") && (
              <ResizableTableHeader
                columnId="journal"
                label="Journal"
                width={getWidth("journal")}
                onResize={onColumnResize}
              />
            )}
            {isVisible("studyType") && (
              <ResizableTableHeader
                columnId="studyType"
                label="Study Type"
                width={getWidth("studyType")}
                onResize={onColumnResize}
              />
            )}
            {isVisible("tags") && (
              <ResizableTableHeader
                columnId="tags"
                label="Tags"
                width={getWidth("tags")}
                onResize={onColumnResize}
              />
            )}
            {isVisible("keywords") && (
              <ResizableTableHeader
                columnId="keywords"
                label="Keywords"
                width={getWidth("keywords")}
                onResize={onColumnResize}
              />
            )}
            {isVisible("links") && (
              <ResizableTableHeader
                columnId="links"
                label="Links"
                width={getWidth("links")}
                onResize={onColumnResize}
              />
            )}
            <TableHead className="w-[50px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {papers.map((paper) => {
            const matchedPoolKeywords = findMatchingKeywords(paper.abstract);
            const combinedKeywords = getCombinedKeywords(paper, matchedPoolKeywords);
            return (
              <TableRow key={paper.id}>
                {isVisible("title") && (
                  <TableCell style={{ width: getWidth("title"), minWidth: getWidth("title"), maxWidth: getWidth("title") }}>
                    <div className="space-y-1">
                      <p className="font-medium line-clamp-2">{paper.title}</p>
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
                )}
                {isVisible("authors") && (
                  <TableCell
                    className="text-sm text-muted-foreground"
                    style={{ width: getWidth("authors"), minWidth: getWidth("authors"), maxWidth: getWidth("authors") }}
                  >
                    <div className="truncate">
                      {paper.authors.slice(0, 3).join(", ")}
                      {paper.authors.length > 3 && " et al."}
                    </div>
                  </TableCell>
                )}
                {isVisible("year") && (
                  <TableCell style={{ width: getWidth("year"), minWidth: getWidth("year"), maxWidth: getWidth("year") }}>
                    {paper.year || "-"}
                  </TableCell>
                )}
                {isVisible("journal") && (
                  <TableCell
                    className="text-sm text-muted-foreground"
                    style={{ width: getWidth("journal"), minWidth: getWidth("journal"), maxWidth: getWidth("journal") }}
                  >
                    <div className="truncate">{paper.journal || "-"}</div>
                  </TableCell>
                )}
                {isVisible("studyType") && (
                  <TableCell
                    className="text-sm"
                    style={{ width: getWidth("studyType"), minWidth: getWidth("studyType"), maxWidth: getWidth("studyType") }}
                  >
                    {(() => {
                      // Get study types from Publication Types (existing data)
                      const publicationTypes = paper.study_type
                        ?.split(/[,;]+/)
                        .map(t => t.trim())
                        .filter(Boolean) || [];
                      
                      // Find matching study types from pool in title
                      const titleMatches = findMatchingStudyTypes(paper.title);
                      
                      // Combine and deduplicate by specificity
                      const allTypes = [...titleMatches, ...publicationTypes];
                      const deduplicatedTypes = deduplicateBySpecificity(allTypes);
                      
                      // Filter out excluded tokens
                      const excludedSet = excludedStudyTypes ?? new Set<string>();
                      const filteredTokens = deduplicatedTypes.filter(token => {
                        const lowerToken = token.toLowerCase();
                        return !Array.from(excludedSet).some(
                          excluded => lowerToken === excluded || lowerToken.includes(excluded)
                        );
                      });
                      
                      if (filteredTokens.length === 0) return <span>-</span>;
                      
                      // Determine which tokens came from title matching
                      const titleMatchLower = new Set(titleMatches.map(t => t.toLowerCase()));
                      
                      return (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="flex flex-wrap gap-1 cursor-default">
                                {filteredTokens.map((token, index) => {
                                  const isFromTitle = titleMatchLower.has(token.toLowerCase());
                                  return (
                                    <Badge
                                      key={`${token}-${index}`}
                                      variant="outline"
                                      className={`text-xs group/badge hover:pr-1 ${
                                        isFromTitle
                                          ? 'border-cyan-500/50 text-cyan-600 dark:text-cyan-400'
                                          : ''
                                      }`}
                                    >
                                      <span className="truncate max-w-[150px]">{token}</span>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          onExcludeStudyType(token);
                                        }}
                                        className="ml-1 opacity-0 group-hover/badge:opacity-100 transition-opacity hover:text-destructive"
                                        title={`Exclude "${token}"`}
                                      >
                                        <X className="h-3 w-3" />
                                      </button>
                                    </Badge>
                                  );
                                })}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="max-w-md bg-popover" align="start">
                              <div className="flex flex-wrap gap-1 p-1">
                                {filteredTokens.map((token, index) => {
                                  const isFromTitle = titleMatchLower.has(token.toLowerCase());
                                  return (
                                    <Badge
                                      key={`tooltip-${token}-${index}`}
                                      variant="outline"
                                      className={`text-xs ${
                                        isFromTitle
                                          ? 'border-cyan-500/50 text-cyan-600 dark:text-cyan-400'
                                          : ''
                                      }`}
                                    >
                                      {isFromTitle && <span className="mr-1 text-[10px] opacity-70">T:</span>}
                                      {token}
                                    </Badge>
                                  );
                                })}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      );
                    })()}
                  </TableCell>
                )}
                {isVisible("tags") && (
                  <TableCell style={{ width: getWidth("tags"), minWidth: getWidth("tags"), maxWidth: getWidth("tags") }}>
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
                )}
                {isVisible("keywords") && (
                  <TableCell style={{ width: getWidth("keywords"), minWidth: getWidth("keywords"), maxWidth: getWidth("keywords") }}>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex flex-wrap gap-1 cursor-default">
                            {combinedKeywords.map(({ keyword, displayName, source }) => (
                              <Badge
                                key={`${source}-${keyword}`}
                                variant="outline"
                                className={`text-xs group/badge hover:pr-1 ${
                                  source === 'pool' 
                                    ? 'border-amber-500/50 text-amber-600 dark:text-amber-400' 
                                    : source === 'pubmed'
                                    ? 'border-purple-500/50 text-purple-600 dark:text-purple-400'
                                    : source === 'mesh'
                                    ? 'border-blue-500/50 text-blue-600 dark:text-blue-400'
                                    : 'border-green-500/50 text-green-600 dark:text-green-400'
                                }`}
                              >
                                {source === 'pool' && <Sparkles className="h-2.5 w-2.5 mr-1" />}
                                {displayName}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onExcludeKeyword(keyword);
                                  }}
                                  className="ml-1 opacity-0 group-hover/badge:opacity-100 transition-opacity hover:text-destructive"
                                  title={`Exclude "${keyword}"`}
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </Badge>
                            ))}
                          </div>
                        </TooltipTrigger>
                        {combinedKeywords.length > 0 && (
                          <TooltipContent side="bottom" className="max-w-md bg-popover" align="start">
                            <div className="flex flex-wrap gap-1 p-1">
                              {combinedKeywords.map(({ keyword, displayName, source }) => (
                                <Badge
                                  key={`tooltip-${source}-${keyword}`}
                                  variant="outline"
                                  className={`text-xs ${
                                    source === 'pool' 
                                      ? 'border-amber-500/50 text-amber-600 dark:text-amber-400' 
                                      : source === 'pubmed'
                                      ? 'border-purple-500/50 text-purple-600 dark:text-purple-400'
                                      : source === 'mesh'
                                      ? 'border-blue-500/50 text-blue-600 dark:text-blue-400'
                                      : 'border-green-500/50 text-green-600 dark:text-green-400'
                                  }`}
                                >
                                  {source === 'pool' && <Sparkles className="h-2.5 w-2.5 mr-1" />}
                                  {displayName}
                                </Badge>
                              ))}
                            </div>
                          </TooltipContent>
                        )}
                      </Tooltip>
                    </TooltipProvider>
                  </TableCell>
                )}
                {isVisible("links") && (
                  <TableCell style={{ width: getWidth("links"), minWidth: getWidth("links"), maxWidth: getWidth("links") }}>
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
                )}
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="bg-popover">
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
