import { useState, useMemo } from "react";
import { PaperWithTags } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { BarChart3, ChevronDown, ChevronUp, X, Search, FileText, Users, Calendar, FlaskConical } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

/** Decode HTML entities (e.g. &#xc1;ngel → Ángel) using a temporary textarea */
function decodeHtml(html: string): string {
  const txt = document.createElement("textarea");
  txt.innerHTML = html;
  return txt.value;
}

interface AnalyticsPanelProps {
  papers: PaperWithTags[];
}

function MultiSelectPopover({
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(
    () =>
      options.filter((o) => o.toLowerCase().includes(search.toLowerCase())),
    [options, search]
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 text-xs">
              {label}
              {selected.length > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-xs px-1.5 py-0">
                  {selected.length}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2" align="start">
            <div className="relative mb-2">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={`Search ${label.toLowerCase()}...`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-7 text-sm"
              />
            </div>
            <ScrollArea className="max-h-[300px] overflow-y-auto">
              <div className="space-y-0.5">
                {filtered.length === 0 && (
                  <p className="text-xs text-muted-foreground py-2 px-2">No matches</p>
                )}
                {filtered.map((option) => (
                  <label
                    key={option}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer text-sm"
                  >
                    <Checkbox
                      checked={selected.includes(option)}
                      onCheckedChange={() => onToggle(option)}
                    />
                    <span className="truncate">{option}</span>
                  </label>
                ))}
              </div>
            </ScrollArea>
          </PopoverContent>
        </Popover>
        {selected.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs text-muted-foreground"
            onClick={onClear}
          >
            Clear
          </Button>
        )}
      </div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((s) => (
            <Badge key={s} variant="secondary" className="text-xs pr-1">
              <span className="truncate max-w-[120px]">{s}</span>
              <button
                onClick={() => onToggle(s)}
                className="ml-1 hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

const CHART_COLORS = [
  "hsl(222, 47%, 31%)",
  "hsl(210, 60%, 45%)",
  "hsl(190, 50%, 40%)",
  "hsl(160, 45%, 40%)",
  "hsl(140, 40%, 45%)",
  "hsl(40, 70%, 50%)",
  "hsl(20, 65%, 50%)",
  "hsl(0, 60%, 50%)",
];

function PercentTooltip({ active, payload, total }: {
  active?: boolean;
  payload?: Array<{ value: number; name: string }>;
  total: number;
}) {
  if (!active || !payload?.[0]) return null;
  const value = payload[0].value;
  const pct = total > 0 ? ((value / total) * 100).toFixed(1) : "0";
  return (
    <div className="bg-popover border border-border rounded-md px-3 py-2 text-xs shadow">
      <span className="font-medium">{value}</span>
      <span className="text-muted-foreground ml-1">({pct}%)</span>
    </div>
  );
}

export function AnalyticsPanel({ papers }: AnalyticsPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedKeywords, setSelectedKeywords] = useState<string[]>([]);
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([]);

  // Summary stats
  const summaryStats = useMemo(() => {
    const uniqueAuthors = new Set(papers.flatMap(p => p.authors || []));
    const years = papers.map(p => p.year).filter((y): y is number => y != null);
    const minYear = years.length > 0 ? Math.min(...years) : null;
    const maxYear = years.length > 0 ? Math.max(...years) : null;
    const uniqueStudyTypes = new Set(
      papers.map(p => p.study_type).filter((st): st is string => !!st)
    );
    return {
      totalPapers: papers.length,
      uniqueAuthors: uniqueAuthors.size,
      yearRange: minYear && maxYear
        ? minYear === maxYear ? `${minYear}` : `${minYear}\u2013${maxYear}`
        : "N/A",
      studyTypesCount: uniqueStudyTypes.size,
    };
  }, [papers]);

  // Study type distribution (auto, no selection needed)
  // Exclude papers with empty/generic study types ("Not specified", "Journal Article")
  const studyTypeStats = useMemo(() => {
    const excluded = new Set(["not specified", "journal article"]);
    const counts: Record<string, number> = {};
    papers.forEach(p => {
      const st = p.study_type?.trim();
      if (st && !excluded.has(st.toLowerCase())) counts[st] = (counts[st] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [papers]);

  // Year distribution
  const yearStats = useMemo(() => {
    const counts: Record<number, number> = {};
    papers.forEach(p => {
      if (p.year) counts[p.year] = (counts[p.year] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([year, count]) => ({ name: year, count }))
      .sort((a, b) => Number(a.name) - Number(b.name));
  }, [papers]);

  // Extract unique keywords and authors from current filtered papers
  const availableKeywords = useMemo(() => {
    const set = new Set<string>();
    papers.forEach((p) => {
      p.keywords?.forEach((k) => set.add(k));
      p.mesh_terms?.forEach((k) => set.add(k));
    });
    return Array.from(set).sort();
  }, [papers]);

  const availableAuthors = useMemo(() => {
    const set = new Set<string>();
    papers.forEach((p) => {
      p.authors?.forEach((a) => set.add(decodeHtml(a)));
    });
    return Array.from(set).sort();
  }, [papers]);

  // Compute keyword stats
  const keywordStats = useMemo(() => {
    if (selectedKeywords.length === 0) return [];
    return selectedKeywords.map((kw) => {
      const kwLower = kw.toLowerCase();
      const count = papers.filter((p) => {
        const allKw = [...(p.keywords || []), ...(p.mesh_terms || [])];
        return allKw.some((k) => k.toLowerCase() === kwLower);
      }).length;
      return { name: kw, count };
    }).sort((a, b) => b.count - a.count);
  }, [selectedKeywords, papers]);

  // Compute author stats
  const authorStats = useMemo(() => {
    if (selectedAuthors.length === 0) return [];
    return selectedAuthors.map((author) => {
      const authorLower = author.toLowerCase();
      const count = papers.filter((p) =>
        p.authors?.some((a) => a.toLowerCase() === authorLower)
      ).length;
      return { name: author, count };
    }).sort((a, b) => b.count - a.count);
  }, [selectedAuthors, papers]);

  const toggleKeyword = (kw: string) => {
    setSelectedKeywords((prev) =>
      prev.includes(kw) ? prev.filter((k) => k !== kw) : [...prev, kw]
    );
  };

  const toggleAuthor = (a: string) => {
    setSelectedAuthors((prev) =>
      prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]
    );
  };

  const chartHeight = (dataLength: number) =>
    Math.max(150, Math.min(dataLength * 28 + 40, 400));

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="outline" size="sm" className="mb-4 gap-2">
          <BarChart3 className="h-4 w-4" />
          Analytics & Insights
          {isOpen ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Card className="mb-4">
          <CardContent className="pt-4 pb-4 space-y-4">
            {/* Summary stats row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="flex items-center gap-2 rounded-md border p-2.5">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-lg font-semibold leading-none">{summaryStats.totalPapers}</p>
                  <p className="text-xs text-muted-foreground">Papers</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-md border p-2.5">
                <Users className="h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-lg font-semibold leading-none">{summaryStats.uniqueAuthors}</p>
                  <p className="text-xs text-muted-foreground">Authors</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-md border p-2.5">
                <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-lg font-semibold leading-none">{summaryStats.yearRange}</p>
                  <p className="text-xs text-muted-foreground">Year Range</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-md border p-2.5">
                <FlaskConical className="h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-lg font-semibold leading-none">{summaryStats.studyTypesCount}</p>
                  <p className="text-xs text-muted-foreground">Study Types</p>
                </div>
              </div>
            </div>

            {/* Study type distribution (automatic) */}
            {studyTypeStats.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">Study Type Distribution</h4>
                <div style={{ height: chartHeight(studyTypeStats.length) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={studyTypeStats} layout="vertical" margin={{ left: 10, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis type="number" allowDecimals={false} className="text-xs" />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={200}
                        tick={{ fontSize: 11 }}
                        className="text-xs"
                      />
                      <RechartsTooltip content={<PercentTooltip total={papers.length} />} />
                      <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                        {studyTypeStats.map((_, i) => (
                          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Year distribution (automatic) */}
            {yearStats.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">Publication Year Distribution</h4>
                <div className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={yearStats} margin={{ left: 10, right: 20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="name" className="text-xs" tick={{ fontSize: 11 }} />
                      <YAxis allowDecimals={false} className="text-xs" />
                      <RechartsTooltip content={<PercentTooltip total={papers.length} />} />
                      <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                        {yearStats.map((_, i) => (
                          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Keyword / Author selectors */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <MultiSelectPopover
                label="Target Keywords"
                options={availableKeywords}
                selected={selectedKeywords}
                onToggle={toggleKeyword}
                onClear={() => setSelectedKeywords([])}
              />
              <MultiSelectPopover
                label="Target Authors"
                options={availableAuthors}
                selected={selectedAuthors}
                onToggle={toggleAuthor}
                onClear={() => setSelectedAuthors([])}
              />
            </div>

            {keywordStats.length === 0 && authorStats.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-2">
                Select target keywords or authors above to compare their distribution.
              </p>
            )}

            {keywordStats.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">Keyword Distribution</h4>
                <div style={{ height: chartHeight(keywordStats.length) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={keywordStats} layout="vertical" margin={{ left: 10, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis type="number" allowDecimals={false} className="text-xs" />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={120}
                        tick={{ fontSize: 11 }}
                        className="text-xs"
                      />
                      <RechartsTooltip content={<PercentTooltip total={papers.length} />} />
                      <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                        {keywordStats.map((_, i) => (
                          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {authorStats.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">Author Distribution</h4>
                <div style={{ height: chartHeight(authorStats.length) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={authorStats} layout="vertical" margin={{ left: 10, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis type="number" allowDecimals={false} className="text-xs" />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={120}
                        tick={{ fontSize: 11 }}
                        className="text-xs"
                      />
                      <RechartsTooltip content={<PercentTooltip total={papers.length} />} />
                      <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                        {authorStats.map((_, i) => (
                          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </CollapsibleContent>
    </Collapsible>
  );
}
