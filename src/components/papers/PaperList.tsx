import { useRef, useCallback, useState, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PaperWithTags } from "@/types/database";
import { WeightedStudyType } from "@/hooks/useStudyTypePool";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ExternalLink, Pencil, Trash2, Sparkles, X, ChevronRight, ChevronDown } from "lucide-react";
import { QuickAddDriveLink } from "./QuickAddDriveLink";
import { ColumnId } from "@/hooks/useColumnVisibility";
import { ResizableTableHeader } from "./ResizableTableHeader";

interface PaperListProps {
  papers: PaperWithTags[];
  onEdit: (paper: PaperWithTags) => void;
  onDelete: (paperId: string) => void;
  findMatchingKeywords: (abstract: string | null) => string[];
  findMatchingStudyTypes: (title: string) => WeightedStudyType[];
  poolStudyTypes: { study_type: string; specificity_weight: number }[];
  visibleColumns: ColumnId[];
  columnWidths: { [key: string]: number };
  onColumnResize: (columnId: ColumnId, width: number) => void;
  normalizeKeyword: (keyword: string) => string;
  excludedKeywords: Set<string>;
  excludedStudyTypes: Set<string>;
  onExcludeStudyType: (studyType: string) => Promise<boolean>;
  onExcludeKeyword: (keyword: string) => Promise<boolean>;
  onUpdateDriveUrl: (paperId: string, driveUrl: string) => Promise<void>;
}

const BASE_ROW_HEIGHT = 52;
const EXPANDED_ROW_HEIGHT = 220;

// mergeStudyTypesByWeight removed — pipeline now assigns a single study type

export function PaperList({
  papers,
  onEdit,
  onDelete,
  findMatchingKeywords,
  findMatchingStudyTypes,
  poolStudyTypes,
  visibleColumns,
  columnWidths,
  onColumnResize,
  normalizeKeyword,
  excludedKeywords,
  excludedStudyTypes,
  onExcludeStudyType,
  onExcludeKeyword,
  onUpdateDriveUrl,
}: PaperListProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const toggleRow = useCallback((paperId: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(paperId)) {
        next.delete(paperId);
      } else {
        next.add(paperId);
      }
      return next;
    });
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: papers.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: useCallback(
      (index: number) => {
        if (expandedRows.has(papers[index]?.id)) return EXPANDED_ROW_HEIGHT;
        return BASE_ROW_HEIGHT;
      },
      [expandedRows, papers]
    ),
    overscan: 10,
    measureElement: useCallback((el: HTMLElement) => {
      return el.getBoundingClientRect().height;
    }, []),
  });

  const generateGoogleScholarUrl = (title: string) => {
    return `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}`;
  };

  const isVisible = (columnId: ColumnId) => visibleColumns?.includes(columnId) ?? true;
  const getWidth = (columnId: ColumnId) => columnWidths?.[columnId] || 150;

  // Count visible columns for the abstract row colspan
  const visibleColumnCount = useMemo(() => {
    const cols: ColumnId[] = ["title", "authors", "year", "journal", "studyType", "tags", "keywords", "links"];
    return cols.filter(c => isVisible(c)).length + 2; // +2 for expand chevron col and actions col
  }, [visibleColumns]);

  const getCombinedKeywords = useCallback((paper: PaperWithTags, matchedPoolKeywords: string[]) => {
    const seenNormalized = new Set<string>();
    const result: { keyword: string; displayName: string; source: 'pool' | 'pubmed' | 'mesh' | 'substance' }[] = [];
    
    const isExcluded = (kw: string) => excludedKeywords?.has(kw.toLowerCase()) ?? false;
    
    matchedPoolKeywords.forEach(kw => {
      if (isExcluded(kw)) return;
      const displayName = normalizeKeyword(kw);
      const normalizedKey = displayName.toLowerCase();
      if (!seenNormalized.has(normalizedKey)) {
        seenNormalized.add(normalizedKey);
        result.push({ keyword: kw, displayName, source: 'pool' });
      }
    });
    
    (paper.keywords || []).forEach(kw => {
      if (isExcluded(kw)) return;
      const displayName = normalizeKeyword(kw);
      const normalizedKey = displayName.toLowerCase();
      if (!seenNormalized.has(normalizedKey)) {
        seenNormalized.add(normalizedKey);
        result.push({ keyword: kw, displayName, source: 'pubmed' });
      }
    });
    
    (paper.mesh_terms || []).forEach(kw => {
      if (isExcluded(kw)) return;
      const displayName = normalizeKeyword(kw);
      const normalizedKey = displayName.toLowerCase();
      if (!seenNormalized.has(normalizedKey)) {
        seenNormalized.add(normalizedKey);
        result.push({ keyword: kw, displayName, source: 'mesh' });
      }
    });
    
    (paper.substances || []).forEach(kw => {
      if (isExcluded(kw)) return;
      const displayName = normalizeKeyword(kw);
      const normalizedKey = displayName.toLowerCase();
      if (!seenNormalized.has(normalizedKey)) {
        seenNormalized.add(normalizedKey);
        result.push({ keyword: kw, displayName, source: 'substance' });
      }
    });
    
    result.sort((a, b) => a.displayName.localeCompare(b.displayName));
    
    return result;
  }, [excludedKeywords, normalizeKeyword]);

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

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div
      ref={scrollContainerRef}
      className="rounded-md border overflow-auto"
      style={{ maxHeight: "calc(100vh - 220px)" }}
    >
      <Table style={{ tableLayout: "fixed" }}>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <TableHead className="w-[36px] px-1"></TableHead>
            {isVisible("title") && (
              <ResizableTableHeader columnId="title" label="Title" width={getWidth("title")} onResize={onColumnResize} />
            )}
            {isVisible("authors") && (
              <ResizableTableHeader columnId="authors" label="Authors" width={getWidth("authors")} onResize={onColumnResize} />
            )}
            {isVisible("year") && (
              <ResizableTableHeader columnId="year" label="Year" width={getWidth("year")} onResize={onColumnResize} />
            )}
            {isVisible("journal") && (
              <ResizableTableHeader columnId="journal" label="Journal" width={getWidth("journal")} onResize={onColumnResize} />
            )}
            {isVisible("studyType") && (
              <ResizableTableHeader columnId="studyType" label="Study Type" width={getWidth("studyType")} onResize={onColumnResize} />
            )}
            {isVisible("tags") && (
              <ResizableTableHeader columnId="tags" label="Tags" width={getWidth("tags")} onResize={onColumnResize} />
            )}
            {isVisible("keywords") && (
              <ResizableTableHeader columnId="keywords" label="Keywords" width={getWidth("keywords")} onResize={onColumnResize} />
            )}
            {isVisible("links") && (
              <ResizableTableHeader columnId="links" label="Links" width={getWidth("links")} onResize={onColumnResize} />
            )}
            <TableHead className="w-[70px]"></TableHead>
          </TableRow>
        </TableHeader>
        {/* Spacer for items before visible window */}
        {virtualItems.length > 0 && virtualItems[0].start > 0 && (
          <tbody aria-hidden="true">
            <tr style={{ height: `${virtualItems[0].start}px` }}>
              <td />
            </tr>
          </tbody>
        )}
        {virtualItems.map((virtualRow) => {
          const paper = papers[virtualRow.index];
          const isExpanded = expandedRows.has(paper.id);
          const matchedPoolKeywords = findMatchingKeywords(paper.abstract);
          const combinedKeywords = getCombinedKeywords(paper, matchedPoolKeywords);
          return (
            <PaperRow
              key={paper.id}
              paper={paper}
              virtualIndex={virtualRow.index}
              measureElement={rowVirtualizer.measureElement}
              isExpanded={isExpanded}
              onToggleExpand={toggleRow}
              matchedPoolKeywords={matchedPoolKeywords}
              combinedKeywords={combinedKeywords}
              isVisible={isVisible}
              getWidth={getWidth}
              visibleColumnCount={visibleColumnCount}
              onEdit={onEdit}
              onRequestDelete={setDeleteConfirmId}
              findMatchingStudyTypes={findMatchingStudyTypes}
              poolStudyTypes={poolStudyTypes}
              excludedStudyTypes={excludedStudyTypes}
              onExcludeStudyType={onExcludeStudyType}
              onExcludeKeyword={onExcludeKeyword}
              onUpdateDriveUrl={onUpdateDriveUrl}
              generateGoogleScholarUrl={generateGoogleScholarUrl}
            />
          );
        })}
        {/* Spacer for items after visible window */}
        {virtualItems.length > 0 && (
          <tbody aria-hidden="true">
            <tr
              style={{
                height: `${rowVirtualizer.getTotalSize() - (virtualItems[virtualItems.length - 1].end)}px`,
              }}
            >
              <td />
            </tr>
          </tbody>
        )}
      </Table>
      <AlertDialog open={!!deleteConfirmId} onOpenChange={(open) => !open && setDeleteConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Paper</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this paper? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteConfirmId) {
                  onDelete(deleteConfirmId);
                  setDeleteConfirmId(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// Extracted row component to keep PaperList lean
interface PaperRowProps {
  paper: PaperWithTags;
  isExpanded: boolean;
  onToggleExpand: (id: string) => void;
  matchedPoolKeywords: string[];
  combinedKeywords: { keyword: string; displayName: string; source: 'pool' | 'pubmed' | 'mesh' | 'substance' }[];
  isVisible: (col: ColumnId) => boolean;
  getWidth: (col: ColumnId) => number;
  visibleColumnCount: number;
  onEdit: (paper: PaperWithTags) => void;
  onRequestDelete: (paperId: string) => void;
  findMatchingStudyTypes: (title: string) => WeightedStudyType[];
  poolStudyTypes: { study_type: string; specificity_weight: number }[];
  excludedStudyTypes: Set<string>;
  onExcludeStudyType: (studyType: string) => Promise<boolean>;
  onExcludeKeyword: (keyword: string) => Promise<boolean>;
  onUpdateDriveUrl: (paperId: string, driveUrl: string) => Promise<void>;
  generateGoogleScholarUrl: (title: string) => string;
  virtualIndex: number;
  measureElement: (el: HTMLElement | null) => void;
}

function PaperRow({
  paper,
  isExpanded,
  onToggleExpand,
  combinedKeywords,
  isVisible,
  getWidth,
  visibleColumnCount,
  onEdit,
  onRequestDelete,
  findMatchingStudyTypes,
  poolStudyTypes,
  excludedStudyTypes,
  onExcludeStudyType,
  onExcludeKeyword,
  onUpdateDriveUrl,
  generateGoogleScholarUrl,
  virtualIndex,
  measureElement,
}: PaperRowProps) {
  return (
    <tbody ref={measureElement} data-index={virtualIndex}>
      <TableRow>
        {/* Expand/Collapse chevron */}
        <TableCell className="w-[36px] px-1">
          {paper.abstract ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onToggleExpand(paper.id)}
              title={isExpanded ? "Collapse abstract" : "Expand abstract"}
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </Button>
          ) : (
            <div className="h-7 w-7" />
          )}
        </TableCell>
        {isVisible("title") && (
          <TableCell style={{ width: getWidth("title"), minWidth: getWidth("title"), maxWidth: getWidth("title") }}>
            <div className="space-y-1">
              <p className="font-medium whitespace-normal break-words leading-snug">{paper.title}</p>
              {paper.projects.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {paper.projects.map((proj) => (
                    <Badge key={proj.id} variant="outline" className="text-xs">
                      <div
                        className="w-2 h-2 rounded-full mr-1"
                        style={{ backgroundColor: proj.color }}
                      />
                      {proj.name}
                    </Badge>
                  ))}
                </div>
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
              const studyTypeValue = (paper.study_type || "").trim();
              
              if (!studyTypeValue) return <span>-</span>;
              
              // Check exclusion
              const excludedSet = excludedStudyTypes ?? new Set<string>();
              const isExcluded = Array.from(excludedSet).some(
                excluded => studyTypeValue.toLowerCase() === excluded || studyTypeValue.toLowerCase().includes(excluded)
              );
              
              if (isExcluded) return <span>-</span>;
              
              return (
                <div className="flex items-center gap-1">
                  <Badge
                    variant="outline"
                    className="text-xs group/badge hover:pr-1"
                  >
                    <span className="truncate max-w-[150px]">{studyTypeValue}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onExcludeStudyType(studyTypeValue);
                      }}
                      className="ml-1 opacity-0 group-hover/badge:opacity-100 transition-opacity hover:text-destructive"
                      title={`Exclude "${studyTypeValue}"`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                </div>
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
              <QuickAddDriveLink
                paperId={paper.id}
                driveUrl={paper.drive_url}
                onSave={onUpdateDriveUrl}
              />
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
          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onEdit(paper)} title="Edit">
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:text-destructive/80 transition-colors"
              onClick={() => onRequestDelete(paper.id)}
              title="Delete"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {/* Expanded abstract row */}
      {isExpanded && paper.abstract && (
        <tr>
          <td colSpan={visibleColumnCount}>
            <div className="px-6 py-4 bg-muted/50 border-t border-border">
              <p className="text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide">Abstract</p>
              <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
                {paper.abstract}
              </p>
            </div>
          </td>
        </tr>
      )}
    </tbody>
  );
}
