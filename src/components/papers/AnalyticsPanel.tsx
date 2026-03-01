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
import { BarChart3, ChevronDown, ChevronUp, X, Search } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

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
            <ScrollArea className="max-h-48">
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

export function AnalyticsPanel({ papers }: AnalyticsPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedKeywords, setSelectedKeywords] = useState<string[]>([]);
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([]);

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
      p.authors?.forEach((a) => set.add(a));
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

  const hasData = keywordStats.length > 0 || authorStats.length > 0;

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
            <p className="text-xs text-muted-foreground">
              Analyzing {papers.length} currently visible paper{papers.length !== 1 ? "s" : ""}
            </p>

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

            {!hasData && (
              <p className="text-sm text-muted-foreground text-center py-6">
                Select target keywords or authors above to see analytics.
              </p>
            )}

            {keywordStats.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">Keyword Distribution</h4>
                <div className="h-[200px]">
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
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "hsl(var(--popover))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "var(--radius)",
                          fontSize: 12,
                        }}
                      />
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
                <div className="h-[200px]">
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
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "hsl(var(--popover))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "var(--radius)",
                          fontSize: 12,
                        }}
                      />
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
