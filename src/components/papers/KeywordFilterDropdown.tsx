import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface KeywordFilterDropdownProps {
  selectedKeywords: string[];
  availableKeywords: string[];
  onKeywordToggle: (keyword: string) => void;
  /**
   * `inline` — the compact desktop toolbar control, with selected keywords
   * shown as badges beside the trigger.
   * `stacked` — full width inside the mobile Filters sheet, with the badges
   * wrapping onto their own line below the trigger instead of competing with
   * it for a 390px row.
   *
   * Presentation only — the same selection state and the same toggle handler.
   */
  variant?: "inline" | "stacked";
}

export function KeywordFilterDropdown({
  selectedKeywords,
  availableKeywords,
  onKeywordToggle,
  variant = "inline",
}: KeywordFilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredKeywords = useMemo(() => {
    if (!searchQuery) return availableKeywords;
    const query = searchQuery.toLowerCase();
    return availableKeywords.filter((kw) => kw.toLowerCase().includes(query));
  }, [availableKeywords, searchQuery]);

  const handleClearAll = () => {
    selectedKeywords.forEach((kw) => onKeywordToggle(kw));
  };

  if (availableKeywords.length === 0) {
    return null;
  }

  const stacked = variant === "stacked";

  return (
    <div className={cn(stacked ? "space-y-2" : "flex items-center gap-2")}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn("h-9", stacked && "w-full justify-between")}
            aria-label="Filter by keyword"
          >
            <span className="mr-2">Keywords</span>
            {selectedKeywords.length > 0 && (
              <Badge variant="secondary" className="ml-1 h-5 px-1.5">
                {selectedKeywords.length}
              </Badge>
            )}
            <ChevronDown className={cn("h-4 w-4", stacked ? "ml-auto" : "ml-2")} />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className={cn(
            "p-0 bg-popover max-w-[calc(100vw-2rem)]",
            stacked
              ? // Fit whatever space is actually left rather than a fixed 315px
                // panel. On a phone with the software keyboard raised the
                // viewport can drop to ~420px, and a fixed-height panel is then
                // clipped whichever way Radix flips it — measured at 390x420:
                // 145px cut off below when anchored down, 12px above when
                // flipped up. `--radix-popover-content-available-height` is
                // Radix's own measurement of the room remaining.
                "flex max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] flex-col"
              : "w-72",
          )}
          align="start"
          collisionPadding={8}
        >
          <div className="shrink-0 p-3 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search keywords..."
                aria-label="Search keywords"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8"
              />
            </div>
          </div>
          <ScrollArea className={cn(stacked ? "min-h-0 flex-1" : "h-64")}>
            <div className="p-2">
              {filteredKeywords.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No keywords found
                </p>
              ) : (
                filteredKeywords.map((keyword) => (
                  <label
                    key={keyword}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted cursor-pointer"
                  >
                    <Checkbox
                      checked={selectedKeywords.includes(keyword)}
                      onCheckedChange={() => onKeywordToggle(keyword)}
                    />
                    <span className="text-sm truncate flex-1">{keyword}</span>
                  </label>
                ))
              )}
            </div>
          </ScrollArea>
          {selectedKeywords.length > 0 && (
            <div className="shrink-0 p-2 border-t">
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={handleClearAll}
              >
                Clear all
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* Selected keywords badges */}
      {selectedKeywords.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedKeywords.slice(0, 3).map((keyword) => (
            <Badge
              key={keyword}
              variant="secondary"
              className="cursor-pointer"
              onClick={() => onKeywordToggle(keyword)}
            >
              {keyword}
              <X className="ml-1 h-3 w-3" />
            </Badge>
          ))}
          {selectedKeywords.length > 3 && (
            <Badge variant="outline">+{selectedKeywords.length - 3}</Badge>
          )}
        </div>
      )}
    </div>
  );
}
