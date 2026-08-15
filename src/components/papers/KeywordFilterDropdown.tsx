import { useState, useMemo, useRef } from "react";
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
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileMultiSelectSheet } from "./MobileMultiSelectSheet";

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
   * Trigger/badge layout only — the same selection state and the same toggle
   * handler. Which selection surface opens is decided by viewport width
   * (`useIsMobile`), not by this prop.
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
  const isMobile = useIsMobile();
  const triggerRef = useRef<HTMLButtonElement>(null);

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

  const trigger = (
    <>
      <span className="mr-2">Keywords</span>
      {selectedKeywords.length > 0 && (
        <Badge variant="secondary" className="ml-1 h-5 px-1.5">
          {selectedKeywords.length}
        </Badge>
      )}
      <ChevronDown className={cn("h-4 w-4", stacked ? "ml-auto" : "ml-2")} />
    </>
  );

  const selectedBadges = selectedKeywords.length > 0 && (
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
  );

  // Below 768px the anchored panel is replaced by a bottom sheet. The keyword
  // list is the longest of the filter selectors, so it was also the least usable
  // one: anchored under a trigger low in the Filters sheet it had almost no room
  // left, and its search box was autofocused, raising the keyboard over what
  // little there was.
  if (isMobile) {
    return (
      <div className={cn(stacked ? "space-y-2" : "flex items-center gap-2")}>
        <Button
          ref={triggerRef}
          variant="outline"
          size="sm"
          className={cn("h-9", stacked && "w-full justify-between")}
          aria-label="Filter by keyword"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          {trigger}
        </Button>
        <MobileMultiSelectSheet
          open={open}
          onOpenChange={setOpen}
          title="Select keywords"
          triggerRef={triggerRef}
          options={availableKeywords.map((keyword) => ({
            value: keyword,
            label: keyword,
          }))}
          selectedValues={selectedKeywords}
          onToggle={onKeywordToggle}
          onClear={handleClearAll}
          clearLabel="Clear all"
          searchPlaceholder="Search keywords..."
          searchLabel="Search keywords"
          emptyMessage="No keywords found"
        />
        {selectedBadges}
      </div>
    );
  }

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
            {trigger}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-72 p-0 bg-popover max-w-[calc(100vw-2rem)]"
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
          <ScrollArea className="h-64">
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
      {selectedBadges}
    </div>
  );
}
