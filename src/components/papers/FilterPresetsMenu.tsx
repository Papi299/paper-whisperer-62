import { useState, useCallback, useRef, useEffect } from "react";
import { Bookmark, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useToast } from "@/hooks/use-toast";
import {
  type FilterPreset,
  type PresetPayload,
  PRESET_NAME_MAX_LENGTH,
  validatePresetName,
} from "@/hooks/useFilterPresets";

interface FilterPresetsMenuProps {
  presets: FilterPreset[];
  isLoading: boolean;
  isSaving: boolean;
  /** Build the payload to persist from the current filter state. */
  getCurrentPayload: () => PresetPayload;
  /** Save a new preset under the given name. Returns true on success. */
  onSave: (name: string, payload: PresetPayload) => Promise<boolean>;
  /** Load a preset into the current filter state (triggers the stale-ID guard). */
  onLoad: (preset: FilterPreset) => void;
  /** Delete a preset by id + name (name is used only for the confirmation copy). */
  onDelete: (preset: Pick<FilterPreset, "id" | "name">) => Promise<void>;
}

/**
 * Saved Searches / Filter Presets dropdown. Lives in the actions row of
 * `SearchFilters` alongside Clear/Export. Offers three actions:
 *
 *   • Save current search…     — opens a small Dialog with a name input
 *   • Load (row click)         — invokes the parent's `onLoad` callback,
 *                                which replaces the current filter state
 *   • Delete (trailing trash)  — opens an AlertDialog for confirmation
 *
 * The menu itself is a shadcn `DropdownMenu`. Save + Delete each open their
 * own modal. Empty state shows a compact muted message.
 */
export function FilterPresetsMenu({
  presets,
  isLoading,
  isSaving,
  getCurrentPayload,
  onSave,
  onLoad,
  onDelete,
}: FilterPresetsMenuProps) {
  const { toast } = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [presetToDelete, setPresetToDelete] = useState<FilterPreset | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus the name input when the Save dialog opens.
  useEffect(() => {
    if (saveOpen) {
      // Next tick — Radix hasn't mounted the input yet on the first effect run.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [saveOpen]);

  const openSaveDialog = useCallback(() => {
    setNameDraft("");
    setSaveOpen(true);
    setMenuOpen(false);
  }, []);

  const handleSaveSubmit = useCallback(async () => {
    const validation = validatePresetName(nameDraft);
    if (!validation.ok) {
      toast({ title: "Invalid name", description: validation.error, variant: "destructive" });
      return;
    }
    const payload = getCurrentPayload();
    const ok = await onSave(validation.name, payload);
    if (ok) {
      setSaveOpen(false);
      setNameDraft("");
    }
  }, [nameDraft, getCurrentPayload, onSave, toast]);

  const handleLoadClick = useCallback(
    (preset: FilterPreset) => {
      onLoad(preset);
      setMenuOpen(false);
    },
    [onLoad],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!presetToDelete) return;
    await onDelete({ id: presetToDelete.id, name: presetToDelete.name });
    setPresetToDelete(null);
  }, [presetToDelete, onDelete]);

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <Bookmark className="mr-1 h-4 w-4" />
            Presets
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="bg-popover w-72">
          <DropdownMenuItem onClick={openSaveDialog} className="cursor-pointer">
            <Plus className="mr-2 h-4 w-4" />
            Save current search…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Saved searches
          </DropdownMenuLabel>
          {isLoading ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">Loading…</div>
          ) : presets.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">No saved searches yet</div>
          ) : (
            <div className="max-h-[320px] overflow-y-auto">
              {presets.map((preset) => (
                <div
                  key={preset.id}
                  className="flex items-center gap-1 px-1 py-0.5"
                >
                  <button
                    type="button"
                    onClick={() => handleLoadClick(preset)}
                    className="flex-1 truncate rounded px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    title={preset.name}
                  >
                    {preset.name}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPresetToDelete(preset);
                      setMenuOpen(false);
                    }}
                    aria-label={`Delete preset "${preset.name}"`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Save dialog */}
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Save current search</DialogTitle>
            <DialogDescription>
              Give this search and filter combination a name you can recognise later.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSaveSubmit();
            }}
          >
            <Input
              ref={inputRef}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="e.g. Recent reviews on sleep"
              maxLength={PRESET_NAME_MAX_LENGTH}
              disabled={isSaving}
            />
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setSaveOpen(false)}
                disabled={isSaving}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving || nameDraft.trim().length === 0}>
                {isSaving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!presetToDelete}
        onOpenChange={(open) => !open && setPresetToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete saved search?</AlertDialogTitle>
            <AlertDialogDescription>
              {presetToDelete
                ? `"${presetToDelete.name}" will be permanently removed. This cannot be undone.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDeleteConfirm()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
