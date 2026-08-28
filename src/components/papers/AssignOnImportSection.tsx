/**
 * The shared assign-on-import Projects / Tags section.
 *
 * Moved out of `AddPaperDialog` verbatim so a second import surface reuses this
 * exact selector rather than growing a lookalike. `AddPaperDialog` still renders
 * it for all four of its tabs and its behaviour is unchanged — same component,
 * same desktop popover, same mobile sheet, same coarse-pointer focus handling,
 * same `selectedProjectIds` / `selectedTagIds` semantics, same badges. The only
 * change is where the file lives and that the section itself is now a component
 * taking its state as props instead of closing over the dialog's.
 *
 * The `/extension-import` handoff page renders the same section, so a phone or
 * tablet gets the bottom sheet and touch-safe focus there too, without either
 * surface being able to drift from the other.
 */

import * as React from "react";
import { useRef, useState } from "react";
import { Check, ChevronsUpDown, FolderOpen, Tags, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTouchSafeInitialFocus } from "@/hooks/useCoarsePointer";
import { cn } from "@/lib/utils";

import { MobileMultiSelectSheet } from "./MobileMultiSelectSheet";

/** One assignable category (Projects or Tags) in the shared assign-on-import section. */
export interface AssignmentEntity {
  id: string;
  name: string;
  color: string;
}

/**
 * The Projects / Tags picker in the shared assign-on-import section.
 *
 * One component for both categories and therefore for all three tabs — Import
 * IDs, Import File and Manual render the same section, so there is exactly one
 * selector implementation and no per-tab assignment state.
 *
 * Desktop keeps the compact `w-52` Command popover. Below 768px it becomes a
 * bottom sheet: the assign section sits low in an already-tall dialog, so the
 * anchored panel — then pinned with `avoidCollisions={false}` — opened straight
 * off the bottom of the phone viewport, and its `CommandInput` was autofocused,
 * so tapping "Projects" raised the software keyboard over what little of the
 * list was on screen. Selection semantics are untouched: the same toggle
 * handler and the same shared `selectedProjectIds` / `selectedTagIds` arrays.
 *
 * The popover that a tablet still gets inherited both halves of that problem
 * because a tablet is also a finger: it now declines initial autofocus on a
 * coarse pointer, and the collision pin is gone so a short landscape tablet
 * flips the panel above the trigger instead of off the bottom edge.
 */
function AssignmentSelector({
  items,
  selectedIds,
  onToggle,
  icon,
  triggerLabel,
  mobileTitle,
  searchPlaceholder,
  searchLabel,
  emptyMessage,
}: {
  items: AssignmentEntity[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  icon: React.ReactNode;
  triggerLabel: string;
  mobileTitle: string;
  searchPlaceholder: string;
  searchLabel: string;
  emptyMessage: string;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const triggerRef = useRef<HTMLButtonElement>(null);
  // A tablet keeps the anchored popover but is driven by a finger: opening the
  // selector must not autofocus the CommandInput and raise the keyboard over
  // the options. Focus goes to the popover panel (Radix gives it
  // `tabIndex={-1}`), so it is still inside the open surface.
  const { focusRef: popoverRef, onOpenAutoFocus } =
    useTouchSafeInitialFocus<HTMLDivElement>();

  const triggerContent = (
    <>
      {icon}
      {triggerLabel}
      <ChevronsUpDown className="h-3 w-3 opacity-50" />
    </>
  );

  if (isMobile) {
    return (
      <>
        <Button
          ref={triggerRef}
          variant="outline"
          size="sm"
          className="h-8 justify-between gap-1"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          {triggerContent}
        </Button>
        <MobileMultiSelectSheet
          open={open}
          onOpenChange={setOpen}
          title={mobileTitle}
          triggerRef={triggerRef}
          options={items.map((item) => ({
            value: item.id,
            label: item.name,
            color: item.color,
          }))}
          selectedValues={selectedIds}
          onToggle={onToggle}
          searchPlaceholder={searchPlaceholder}
          searchLabel={searchLabel}
          emptyMessage={emptyMessage}
        />
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen} modal={true}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 justify-between gap-1">
          {triggerContent}
        </Button>
      </PopoverTrigger>
      {/* `avoidCollisions={false}` was dropped on measured evidence, not on
          principle. The assign section sits low in a tall dialog, so with a
          realistic 12-project list the pinned panel ran 67px past the bottom
          edge at 1024×768 — a landscape tablet — leaving its last options
          unreachable. With collision avoidance on, Radix flips it to
          `side="top"` there (fully on screen), and 768×1024 and 834×1194 stay
          byte-identical to the pinned placement, so nothing that already
          worked moved. */}
      <PopoverContent
        ref={popoverRef}
        onOpenAutoFocus={onOpenAutoFocus}
        className="w-52 p-0"
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        style={{ pointerEvents: 'auto' }}
      >
        <Command filter={(value, search) => value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0}>
          <CommandInput placeholder={searchPlaceholder} aria-label={searchLabel} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {items.map((item) => (
                <CommandItem key={item.id} value={item.name} onSelect={() => onToggle(item.id)}>
                  <Check className={cn("mr-2 h-4 w-4", selectedIds.includes(item.id) ? "opacity-100" : "opacity-0")} />
                  <span className="w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: item.color }} />
                  {item.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Render the assign-on-import section, or nothing when the user owns no
 * taxonomy at all.
 *
 * `context` reproduces `AddPaperDialog`'s existing two headings exactly:
 * `"current-import"` labels selections that apply to the run about to happen,
 * `"next-import"` labels the ones left on screen after a completed run, which
 * configure the *next* one. The handoff page only ever has a current import.
 */
export function AssignOnImportSection({
  projects,
  tags,
  selectedProjectIds,
  selectedTagIds,
  onToggleProject,
  onToggleTag,
  context,
}: {
  projects: AssignmentEntity[];
  tags: AssignmentEntity[];
  selectedProjectIds: string[];
  selectedTagIds: string[];
  onToggleProject: (id: string) => void;
  onToggleTag: (id: string) => void;
  context: "current-import" | "next-import";
}) {
  if (projects.length === 0 && tags.length === 0) return null;
  const isNext = context === "next-import";
  return (
    <div className="space-y-3 rounded-md border border-dashed p-3">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {isNext ? "Assignments for next import" : "Assign on Import"}
      </p>
      {isNext && (
        <p className="text-xs text-muted-foreground">
          These selections apply to the next batch, not the completed import.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {projects.length > 0 && (
          <AssignmentSelector
            items={projects}
            selectedIds={selectedProjectIds}
            onToggle={onToggleProject}
            icon={<FolderOpen className="h-3.5 w-3.5 mr-1" aria-hidden="true" />}
            triggerLabel={
              selectedProjectIds.length > 0
                ? `${selectedProjectIds.length} project${selectedProjectIds.length !== 1 ? "s" : ""}`
                : "Projects"
            }
            mobileTitle="Select projects"
            searchPlaceholder="Search projects..."
            searchLabel="Search projects"
            emptyMessage="No projects found."
          />
        )}

        {tags.length > 0 && (
          <AssignmentSelector
            items={tags}
            selectedIds={selectedTagIds}
            onToggle={onToggleTag}
            icon={<Tags className="h-3.5 w-3.5 mr-1" aria-hidden="true" />}
            triggerLabel={
              selectedTagIds.length > 0
                ? `${selectedTagIds.length} tag${selectedTagIds.length !== 1 ? "s" : ""}`
                : "Tags"
            }
            mobileTitle="Select tags"
            searchPlaceholder="Search tags..."
            searchLabel="Search tags"
            emptyMessage="No tags found."
          />
        )}
      </div>

      {/* Show selected items as badges */}
      {(selectedProjectIds.length > 0 || selectedTagIds.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {selectedProjectIds.map((id) => {
            const project = projects.find((p) => p.id === id);
            return project ? (
              <Badge key={id} variant="outline" className="text-xs flex items-center gap-1 pr-1">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: project.color }} />
                {project.name}
                <button
                  type="button"
                  onClick={() => onToggleProject(id)}
                  aria-label={`Remove project ${project.name}`}
                  className="hover:bg-muted rounded p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ) : null;
          })}
          {selectedTagIds.map((id) => {
            const tag = tags.find((t) => t.id === id);
            return tag ? (
              <Badge key={id} variant="secondary" className="text-xs flex items-center gap-1 pr-1">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: tag.color }} />
                {tag.name}
                <button
                  type="button"
                  onClick={() => onToggleTag(id)}
                  aria-label={`Remove tag ${tag.name}`}
                  className="hover:bg-muted rounded p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}
