import { useEffect, useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { codePointLength } from "@/lib/evidence/normalization";
import { checkFlag, FLAG_BLOCK_MESSAGES } from "@/lib/evidence/review";
import type { RecordedValue } from "@/lib/evidence/types";
import { REVIEW_COPY } from "./reviewCopy";

interface FlagFormProps {
  readonly id: string;
  /** The SAVED value being flagged, at the version its card shows. */
  readonly value: RecordedValue;
  /** A Flag of this value is being recorded. */
  readonly working: boolean;
  /** Why it can't be sent right now (the card's hold), or null. */
  readonly heldReason: string | null;
  readonly onSubmit: (note: string) => void;
  readonly onCancel: () => void;
}

/**
 * Flag one saved value with a note (Requirements-001A §I3). The note is
 * checked as the server checks it — `checkFlag`: at least 3 characters after
 * trimming spaces, not blank after normalization v1, at most 2,000, well
 * formed — and a problem is shown in words and linked to the field. A value
 * already flagged starts from its note, and "Update flag" waits until the note
 * changes. Escape cancels without sending anything (the dialog does not close:
 * the form is marked `data-escape-closes-form`). Flagging never changes the
 * value, and a failed rule never flags it by itself.
 */
export function FlagForm({ id, value, working, heldReason, onSubmit, onCancel }: FlagFormProps) {
  const ids = useId();
  const existing = value.review.status === "disputed" ? value.review.note ?? "" : "";
  const [note, setNote] = useState(existing);
  const [attempted, setAttempted] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  const check = checkFlag(value, value.valueVersion, note);
  const unchanged = existing !== "" && note === existing;
  const reasons = check.kind === "blocked" ? check.reasons : [];
  // A length or character problem shows at once; "too short" waits for a first try, so an empty form isn't an error.
  const shownReason = reasons.find((reason) => reason !== "note_too_short") ?? (attempted ? reasons[0] : undefined);
  const error = shownReason ? FLAG_BLOCK_MESSAGES[shownReason] : null;
  const describedBy = [`${ids}-help`, `${ids}-count`, error ? `${ids}-error` : null, unchanged ? `${ids}-unchanged` : null].filter(Boolean).join(" ");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (working || unchanged || heldReason || check.kind !== "allowed") {
      fieldRef.current?.focus();
      return;
    }
    onSubmit(note);
  };

  return (
    <form
      id={id}
      data-escape-closes-form=""
      data-testid="flag-form"
      className="space-y-2 rounded-md border p-3"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      noValidate
    >
      <Label htmlFor={`${ids}-note`} className="text-sm">
        {REVIEW_COPY.flagLabel}
      </Label>
      <Textarea
        ref={fieldRef}
        id={`${ids}-note`}
        rows={3}
        value={note}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => setNote(event.target.value)}
      />
      <p id={`${ids}-help`} className="text-xs text-muted-foreground">
        {REVIEW_COPY.flagHelp}
      </p>
      <p id={`${ids}-count`} className="text-xs text-muted-foreground">
        {REVIEW_COPY.flagCount(codePointLength(note))}
      </p>
      {error && (
        <p id={`${ids}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {unchanged && (
        <p id={`${ids}-unchanged`} className="text-xs text-muted-foreground">
          {REVIEW_COPY.flagUnchanged}
        </p>
      )}
      {heldReason && <p className="text-xs">{heldReason}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" className="coarse:min-h-10" disabled={unchanged || working} aria-busy={working || undefined}>
          {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {existing ? REVIEW_COPY.flagUpdate : REVIEW_COPY.flagSubmit}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="coarse:min-h-10" onClick={onCancel}>
          {REVIEW_COPY.cancel}
        </Button>
      </div>
    </form>
  );
}
