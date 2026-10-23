import { useId, useMemo, useState } from "react";
import { FileText, Quote, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { FieldKey } from "@/lib/evidence/fieldDictionary";
import type { PaperId, SnapshotId } from "@/lib/evidence/ids";
import { locateQuote, type AdvisoryQuoteMatch } from "@/lib/evidence/matcher";
import { codePointLength, isNormalizationEmpty } from "@/lib/evidence/normalization";
import { LOCATOR_KINDS, type LocatorKind, type ReferencePurpose, type ReferenceSourceKind } from "@/lib/evidence/types";
import { LOCATOR_TEXT_MAX_LENGTH, MAX_SUPPORTING_REFERENCES } from "@/lib/evidence/validation";
import { setValueEdit, viewValue, type DraftReference, type DraftValueEdit, type NewReference } from "@/lib/studyRecord/draft";
import { addQuoteToEdit, matchProblem, QUOTE_MESSAGES } from "@/lib/studyRecord/quotes";
import type { StudyRecordLink } from "@/lib/studyRecord/read";
import { useEditor } from "./editorContext";
import { STUDY_RECORD_COPY } from "./studyRecordCopy";

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The sources of one value, by its state (FK-PROOF-001 §J): supporting quotes
 * and full-text references for Reported and Unclear, the sources examined for
 * Not reported and Unclear, and the sources that couldn't be checked for
 * Couldn't check. Every reference names one of the study's linked papers;
 * full-text references are a location only, always the user's statement.
 */
export function FieldSources({ valueKey, fieldKey, edit }: { readonly valueKey: string; readonly fieldKey: FieldKey; readonly edit: DraftValueEdit }) {
  const editor = useEditor();
  const [panel, setPanel] = useState<"quote" | "full_text" | null>(null);
  const link = editor.sourceLink;
  const copy = link?.currentCopy ?? null;
  const paperId = link?.link.paperId ?? null;
  const disabled = !editor.canEdit;
  const state = edit.state;
  const supporting = edit.references.filter((reference) => reference.reference.purpose === "supports").length;
  const canSupport = state === "reported" || state === "unclear";
  const atLimit = supporting >= MAX_SUPPORTING_REFERENCES;

  const remove = (index: number) => editor.updateValue(valueKey, (current) => ({ ...current, references: current.references.filter((_, i) => i !== index) }));
  const add = (reference: NewReference) =>
    editor.updateValue(valueKey, (current) => ({ ...current, references: [...current.references, { kind: "new", localId: editor.newLocalId(), reference }] }));

  const indexOf = (purpose: ReferencePurpose, sourceKind: ReferenceSourceKind) =>
    edit.references.findIndex(
      (reference) => reference.reference.purpose === purpose && reference.reference.sourceKind === sourceKind && reference.reference.paperId === paperId,
    );
  const toggle = (purpose: "examined" | "unavailable", sourceKind: ReferenceSourceKind, on: boolean) => {
    if (!paperId) return;
    if (!on) {
      const index = indexOf(purpose, sourceKind);
      if (index >= 0) remove(index);
      return;
    }
    if (purpose === "examined" && sourceKind === "abstract") {
      if (copy) add({ purpose, sourceKind, paperId, snapshotId: copy.id });
    } else if (purpose === "examined") add({ purpose: "examined", sourceKind: "full_text", paperId, locator: null });
    else add({ purpose: "unavailable", sourceKind, paperId });
  };

  return (
    <div className="space-y-2" role="group" aria-label={`${STUDY_RECORD_COPY.sourcesLabel}: ${editor.describeField(valueKey)}`}>
      {edit.references.length > 0 && (
        <ul className="space-y-2">
          {edit.references.map((reference, index) => (
            <ReferenceItem
              key={reference.kind === "kept" ? reference.reference.id : reference.localId}
              reference={reference}
              links={editor.links}
              disabled={disabled}
              onRemove={() => remove(index)}
            />
          ))}
        </ul>
      )}

      {state === "reported" && supporting === 0 && (
        <p className="rounded-md border border-amber-500/50 bg-amber-50 p-2 text-xs dark:bg-amber-950/30" data-testid="no-source-given">
          <span className="font-medium">{STUDY_RECORD_COPY.noSourceGiven}.</span> {STUDY_RECORD_COPY.noSourceGivenHelp}
        </p>
      )}

      {canSupport && !disabled && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="coarse:min-h-10" disabled={!copy || atLimit} onClick={() => setPanel(panel === "quote" ? null : "quote")} aria-expanded={panel === "quote"}>
            <Quote className="mr-1 h-4 w-4" aria-hidden="true" />
            {STUDY_RECORD_COPY.addQuote}
          </Button>
          <Button type="button" variant="outline" size="sm" className="coarse:min-h-10" disabled={atLimit} onClick={() => setPanel(panel === "full_text" ? null : "full_text")} aria-expanded={panel === "full_text"}>
            <FileText className="mr-1 h-4 w-4" aria-hidden="true" />
            {STUDY_RECORD_COPY.addFullTextReference}
          </Button>
        </div>
      )}
      {canSupport && !disabled && atLimit && <p className="text-xs text-muted-foreground">{STUDY_RECORD_COPY.quoteLimit}</p>}
      {canSupport && !disabled && !copy && <p className="text-xs text-muted-foreground">{STUDY_RECORD_COPY.noCopyForQuotes}</p>}
      {panel === "quote" && copy && !disabled && (
        <AddQuotePanel valueKey={valueKey} fieldKey={fieldKey} copyText={copy.exactText} snapshotId={copy.id} paperId={copy.paperId} onDone={() => setPanel(null)} />
      )}
      {panel === "full_text" && !disabled && (
        <AddFullTextPanel
          links={editor.links}
          defaultPaperId={paperId}
          onAdd={(reference) => {
            add(reference);
            setPanel(null);
          }}
          onCancel={() => setPanel(null)}
        />
      )}

      {(state === "not_reported" || state === "unclear") && paperId && (
        <fieldset disabled={disabled} className="space-y-1">
          <legend className="text-xs font-medium">{STUDY_RECORD_COPY.examinedLegend}</legend>
          <CheckRow
            label={STUDY_RECORD_COPY.examinedAbstract}
            checked={indexOf("examined", "abstract") >= 0}
            disabled={disabled || (!copy && indexOf("examined", "abstract") < 0)}
            onChange={(on) => toggle("examined", "abstract", on)}
          />
          <CheckRow label={STUDY_RECORD_COPY.examinedFullText} checked={indexOf("examined", "full_text") >= 0} disabled={disabled} onChange={(on) => toggle("examined", "full_text", on)} />
        </fieldset>
      )}

      {state === "source_unavailable" && paperId && (
        <fieldset disabled={disabled} className="space-y-1">
          <legend className="text-xs font-medium">{STUDY_RECORD_COPY.unavailableLegend}</legend>
          {(!copy || indexOf("unavailable", "abstract") >= 0) && (
            <CheckRow
              label={STUDY_RECORD_COPY.unavailableAbstract}
              checked={indexOf("unavailable", "abstract") >= 0}
              disabled={disabled}
              onChange={(on) => toggle("unavailable", "abstract", on)}
            />
          )}
          <CheckRow
            label={STUDY_RECORD_COPY.unavailableFullText}
            checked={indexOf("unavailable", "full_text") >= 0}
            disabled={disabled}
            onChange={(on) => toggle("unavailable", "full_text", on)}
          />
        </fieldset>
      )}
    </div>
  );
}

function CheckRow({ label, checked, disabled, onChange }: { readonly label: string; readonly checked: boolean; readonly disabled: boolean; readonly onChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2 coarse:min-h-10">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(value) => onChange(value === true)} />
      <Label htmlFor={id} className="cursor-pointer text-sm font-normal">
        {label}
      </Label>
    </div>
  );
}

function paperTitle(links: readonly StudyRecordLink[], paperId: string): string {
  return links.find((link) => link.link.paperId === paperId)?.paperTitle ?? STUDY_RECORD_COPY.thisPaper;
}

/** How one reference reads: what it is, whose statement it is, and — for an abstract quote — where it was found. */
function ReferenceItem({
  reference,
  links,
  disabled,
  onRemove,
}: {
  readonly reference: DraftReference;
  readonly links: readonly StudyRecordLink[];
  readonly disabled: boolean;
  readonly onRemove: () => void;
}) {
  const r = reference.reference;
  const link = links.find((candidate) => candidate.link.paperId === r.paperId);
  const current = link?.currentCopy ?? null;
  let title: string;
  let detail: string | null = null;
  let quote: string | null = null;
  if (r.purpose === "supports" && r.sourceKind === "abstract") {
    title = STUDY_RECORD_COPY.quoteFromAbstract;
    quote = r.quoteText;
    if (reference.kind === "kept" && reference.reference.purpose === "supports" && reference.reference.sourceKind === "abstract") {
      const { match } = reference.reference;
      detail =
        current && reference.reference.snapshotId === current.id
          ? `${STUDY_RECORD_COPY.quoteFound}${match.count > 1 ? ` (${STUDY_RECORD_COPY.quoteOccurrence(match.occurrence, match.count)})` : ""}`
          : STUDY_RECORD_COPY.quoteEarlierCopy;
    } else if (reference.kind === "new" && reference.reference.purpose === "supports" && reference.reference.sourceKind === "abstract") {
      const advisory: AdvisoryQuoteMatch | null = current ? locateQuote(reference.reference.quoteText, current.exactText) : null;
      const problem = advisory ? matchProblem(advisory) : QUOTE_MESSAGES.notFound;
      const { occurrence, expectedMatchCount } = reference.reference;
      detail = problem ?? (occurrence && expectedMatchCount ? `${STUDY_RECORD_COPY.quoteFound} (${STUDY_RECORD_COPY.quoteOccurrence(occurrence, expectedMatchCount)})` : STUDY_RECORD_COPY.quoteFound);
    }
  } else if (r.purpose === "supports") {
    title = STUDY_RECORD_COPY.fullTextOf(paperTitle(links, r.paperId));
    detail = r.sourceKind === "full_text" && "locator" in r && r.locator ? `${STUDY_RECORD_COPY.locatorKinds[r.locator.kind]} ${r.locator.text} · ${STUDY_RECORD_COPY.yourReference}` : STUDY_RECORD_COPY.yourReference;
  } else if (r.purpose === "examined") {
    title = r.sourceKind === "abstract" ? `Examined: ${STUDY_RECORD_COPY.examinedAbstract.toLowerCase()}` : `Examined: the full text of ${paperTitle(links, r.paperId)}`;
    if (r.sourceKind === "abstract" && "snapshotId" in r && current && r.snapshotId !== current.id) detail = STUDY_RECORD_COPY.quoteEarlierCopy;
    if (r.sourceKind === "full_text") detail = STUDY_RECORD_COPY.yourReference;
  } else {
    title = `Couldn't check: the ${r.sourceKind === "abstract" ? "abstract" : "full text"} of ${paperTitle(links, r.paperId)}`;
  }
  return (
    <li className="flex items-start justify-between gap-2 rounded-md bg-muted/40 p-2 text-sm">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium break-words [overflow-wrap:anywhere]">{title}</p>
        {quote !== null && <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-2 text-xs [overflow-wrap:anywhere]">{quote}</blockquote>}
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </div>
      {!disabled && (
        <Button type="button" variant="ghost" size="icon" className="h-10 w-10 shrink-0" aria-label={`${STUDY_RECORD_COPY.removeSource}: ${title}`} onClick={onRemove}>
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      )}
    </li>
  );
}

/**
 * "Add quote" — the keyboard and phone path to quoting (Requirements-001 §E4,
 * §E11). The browser shows where the text occurs, as advice; with several
 * occurrences the user must choose one. The server matches it again on save.
 */
function AddQuotePanel({
  valueKey,
  fieldKey,
  copyText,
  snapshotId,
  paperId,
  onDone,
}: {
  readonly valueKey: string;
  readonly fieldKey: FieldKey;
  readonly copyText: string;
  readonly snapshotId: SnapshotId;
  readonly paperId: PaperId;
  readonly onDone: () => void;
}) {
  const editor = useEditor();
  const ids = useId();
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const match = useMemo(() => (text === "" ? null : locateQuote(text, copyText)), [text, copyText]);
  const problem = match ? matchProblem(match) : null;
  const ready = match?.kind === "unique" || (match?.kind === "multiple" && chosen !== null && chosen <= match.count);

  const addQuote = () => {
    if (!match || !ready) return;
    const multiple = match.kind === "multiple";
    const reference = {
      purpose: "supports" as const,
      sourceKind: "abstract" as const,
      paperId,
      snapshotId,
      quoteText: text,
      occurrence: multiple ? chosen : null,
      expectedMatchCount: multiple ? match.count : null,
    };
    const current = viewValue(editor.baseValues, editor.draft, valueKey).edit;
    const result = addQuoteToEdit(current, fieldKey, reference, editor.newLocalId(), null);
    if (!result.ok) {
      setMessage(result.reason === "limit" ? STUDY_RECORD_COPY.quoteLimit : STUDY_RECORD_COPY.quoteNeedsState);
      return;
    }
    editor.update((draft) => setValueEdit(editor.baseValues, draft, valueKey, result.edit));
    onDone();
  };

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="add-quote-panel">
      <Label htmlFor={`${ids}-quote`} className="text-xs">
        {STUDY_RECORD_COPY.typedQuoteLabel}
      </Label>
      <Textarea
        id={`${ids}-quote`}
        rows={3}
        value={text}
        aria-describedby={`${ids}-quote-help ${ids}-quote-status`}
        onChange={(event) => {
          setText(event.target.value);
          setChosen(null);
          setMessage(null);
        }}
      />
      <p id={`${ids}-quote-help`} className="text-xs text-muted-foreground">
        {STUDY_RECORD_COPY.typedQuoteHelp}
      </p>
      <p id={`${ids}-quote-status`} role="status" className="text-xs" data-testid="add-quote-status">
        {match === null
          ? ""
          : problem
            ? problem
            : match.kind === "unique"
              ? STUDY_RECORD_COPY.typedQuoteFoundOnce
              : match.kind === "multiple"
                ? STUDY_RECORD_COPY.typedQuoteFoundMany(match.count)
                : ""}
      </p>
      {match?.kind === "multiple" && (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium">{STUDY_RECORD_COPY.occurrenceLegend}</legend>
          <RadioGroup value={chosen === null ? "" : String(chosen)} onValueChange={(value) => setChosen(Number(value))} className="gap-1">
            {match.occurrences.map((occurrence) => (
              <label key={occurrence.occurrence} className="flex cursor-pointer items-start gap-2 rounded p-1 text-xs coarse:min-h-10">
                <RadioGroupItem value={String(occurrence.occurrence)} className="mt-0.5" aria-label={STUDY_RECORD_COPY.occurrenceOption(occurrence.occurrence)} />
                <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {occurrence.context.truncatedBefore && "…"}
                  {occurrence.context.before}
                  <mark className="bg-amber-100 underline decoration-dotted dark:bg-amber-900/50">{occurrence.context.match}</mark>
                  {occurrence.context.after}
                  {occurrence.context.truncatedAfter && "…"}
                </span>
              </label>
            ))}
          </RadioGroup>
        </fieldset>
      )}
      {message && (
        <p role="alert" className="text-xs text-destructive">
          {message}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" size="sm" className="coarse:min-h-10" disabled={!ready} onClick={addQuote}>
          {STUDY_RECORD_COPY.addThisQuote}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="coarse:min-h-10" onClick={onDone}>
          {STUDY_RECORD_COPY.cancel}
        </Button>
      </div>
    </div>
  );
}

/**
 * A supporting full-text reference: one linked report and a location in it.
 * Locator-only (001A PD-3): no full-text quotation is stored, and nothing
 * checks the location.
 */
function AddFullTextPanel({
  links,
  defaultPaperId,
  onAdd,
  onCancel,
}: {
  readonly links: readonly StudyRecordLink[];
  readonly defaultPaperId: PaperId | null;
  readonly onAdd: (reference: NewReference) => void;
  readonly onCancel: () => void;
}) {
  const ids = useId();
  const [paper, setPaper] = useState<string>(defaultPaperId ?? links[0]?.link.paperId ?? "");
  const [kind, setKind] = useState<LocatorKind>("page");
  const [text, setText] = useState("");
  const valid = text !== "" && !isNormalizationEmpty(text) && codePointLength(text) <= LOCATOR_TEXT_MAX_LENGTH;
  const selected = links.find((link) => link.link.paperId === paper);
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="add-full-text-panel">
      <p className="text-xs text-muted-foreground">{STUDY_RECORD_COPY.fullTextNotice}</p>
      {links.length > 1 && (
        <div className="space-y-1">
          <Label htmlFor={`${ids}-paper`} className="text-xs">
            {STUDY_RECORD_COPY.fullTextReport}
          </Label>
          <select id={`${ids}-paper`} className={SELECT_CLASS} value={paper} onChange={(event) => setPaper(event.target.value)}>
            {links.map((link) => (
              <option key={link.link.id} value={link.link.paperId}>
                {link.paperTitle ?? STUDY_RECORD_COPY.thisPaper}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
        <div className="space-y-1">
          <Label htmlFor={`${ids}-kind`} className="text-xs">
            {STUDY_RECORD_COPY.locatorKind}
          </Label>
          <select id={`${ids}-kind`} className={SELECT_CLASS} value={kind} onChange={(event) => setKind(event.target.value as LocatorKind)}>
            {LOCATOR_KINDS.map((option) => (
              <option key={option} value={option}>
                {STUDY_RECORD_COPY.locatorKinds[option]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-text`} className="text-xs">
            {STUDY_RECORD_COPY.locatorText}
          </Label>
          <Input id={`${ids}-text`} value={text} placeholder={STUDY_RECORD_COPY.locatorPlaceholder} onChange={(event) => setText(event.target.value)} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{STUDY_RECORD_COPY.yourReference}</p>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          className="coarse:min-h-10"
          disabled={!valid || !selected}
          onClick={() => selected && onAdd({ purpose: "supports", sourceKind: "full_text", paperId: selected.link.paperId, locator: { kind, text } })}
        >
          {STUDY_RECORD_COPY.addReference}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="coarse:min-h-10" onClick={onCancel}>
          {STUDY_RECORD_COPY.cancel}
        </Button>
      </div>
    </div>
  );
}
