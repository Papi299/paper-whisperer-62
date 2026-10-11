import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toSafeExternalHref } from "@/lib/externalUrl";
import { cn } from "@/lib/utils";
import type { AttachmentSummary, ComparisonTaxonomy, FieldValue } from "@/lib/paperComparison/types";
import { LIST_PREVIEW_ITEMS, MISSING_VALUE_TEXT, isLongText, type ComparisonFieldDef, type FieldContent } from "./comparisonFields";

/**
 * One stored value in the comparison, in whichever of its four states it is
 * (EVIDENCE-MATRIX-001B).
 *
 * Text is rendered as text, never as HTML: an abstract stored with markup or
 * entities shows them literally, exactly as the library holds it. A long text
 * is clamped by CSS only, so the whole stored string stays in the document for
 * screen readers and find-in-page and is never cut by code. A long list shows
 * its first items with a visible "Showing N of M", so a shortened list never
 * looks complete. Every list element is its own item: "Clinical Trial, Phase
 * II" is one publication type, never two. A long token with no break in it
 * (an identifier, a run-together term) wraps anywhere rather than widening a
 * card past a phone screen.
 */

function MissingValue({ value }: { value: Exclude<FieldValue<unknown>, { kind: "present" }> }) {
  return (
    <span className="italic text-muted-foreground" data-value-state={value.kind}>
      {MISSING_VALUE_TEXT[value.kind]}
    </span>
  );
}

interface ExpandProps {
  /** Whether the full value is shown. */
  expanded: boolean;
  onToggle: () => void;
  /** The element that holds the value, for `aria-controls`. */
  valueId: string;
  /** Space-separated ids naming the paper, so a control says which paper it acts on. */
  paperDescribedBy: string;
}

function ExpandToggle({ expanded, onToggle, valueId, paperDescribedBy, showLabel }: ExpandProps & { showLabel: string }) {
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto min-h-6 px-0 py-0.5 coarse:min-h-10"
      aria-expanded={expanded}
      aria-controls={valueId}
      aria-describedby={paperDescribedBy}
      onClick={onToggle}
    >
      {expanded ? "Show less" : showLabel}
    </Button>
  );
}

function TextValue({ text, field, ...expand }: { text: string; field: ComparisonFieldDef } & ExpandProps) {
  const clampable = field.long === true && isLongText(text);
  return (
    <div className="space-y-1">
      <p
        id={expand.valueId}
        className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", clampable && !expand.expanded && "line-clamp-4")}
      >
        {text}
      </p>
      {clampable && <ExpandToggle {...expand} showLabel={`Show full ${field.noun}`} />}
    </div>
  );
}

function ListValue({ items, field, ...expand }: { items: readonly string[]; field: ComparisonFieldDef } & ExpandProps) {
  const shortened = items.length > LIST_PREVIEW_ITEMS;
  const shown = shortened && !expand.expanded ? items.slice(0, LIST_PREVIEW_ITEMS) : items;
  return (
    <div className="space-y-1">
      <ul id={expand.valueId} className="flex flex-wrap gap-1">
        {shown.map((item, index) => (
          <li key={`${index}:${item}`} className="min-w-0 max-w-full rounded-sm bg-muted px-1.5 py-0.5 text-xs [overflow-wrap:anywhere]">
            {item}
          </li>
        ))}
      </ul>
      {shortened && (
        <div className="flex flex-wrap items-center gap-x-2">
          {!expand.expanded && (
            <span className="text-xs text-muted-foreground">
              Showing {LIST_PREVIEW_ITEMS} of {items.length}
            </span>
          )}
          <ExpandToggle {...expand} showLabel={`Show all ${items.length} ${field.noun}`} />
        </div>
      )}
    </div>
  );
}

function TaxonomyValue({ taxonomy, noun }: { taxonomy: ComparisonTaxonomy; noun: string }) {
  const { items, unavailableCount } = taxonomy;
  return (
    <div className="space-y-1">
      {items.length > 0 ? (
        <ul className="flex flex-wrap gap-1">
          {items.map((item) => (
            <li
              key={item.id}
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-xs [overflow-wrap:anywhere]"
            >
              {item.color && (
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} aria-hidden="true" />
              )}
              {item.name}
            </li>
          ))}
        </ul>
      ) : (
        unavailableCount === 0 && <span className="italic text-muted-foreground">No {noun} assigned</span>
      )}
      {unavailableCount > 0 && (
        <p className="text-xs italic text-muted-foreground">
          {unavailableCount} {unavailableCount === 1 ? "assignment" : "assignments"} could not be read
        </p>
      )}
    </div>
  );
}

function attachmentText({ total, pdf, image, other }: AttachmentSummary): string {
  if (total === 0) return "None recorded";
  const parts = [
    pdf > 0 ? `${pdf} PDF` : null,
    image > 0 ? `${image} ${image === 1 ? "image" : "images"}` : null,
    other > 0 ? `${other} other` : null,
  ].filter(Boolean);
  return `${total} ${total === 1 ? "file" : "files"} (${parts.join(", ")})`;
}

/**
 * The read model's derived link, passed through the app's external-URL
 * allowlist as every other anchor is — and offered only if the allowlist
 * leaves it unchanged. URL normalization resolves "." and ".." segments, so a
 * stored DOI such as "10.1000/.." would otherwise point somewhere other than
 * the link derived from it.
 */
function allowlistedLink(href: string | null): string | null {
  const allowed = toSafeExternalHref(href);
  return allowed !== null && allowed === href ? allowed : null;
}

function IdentifierValue({
  value,
  href,
  linkLabel,
  paperDescribedBy,
}: {
  value: FieldValue<string>;
  href: string | null;
  linkLabel: string;
  paperDescribedBy: string;
}) {
  if (value.kind !== "present") return <MissingValue value={value} />;
  const safeHref = allowlistedLink(href);
  return (
    <div className="space-y-1">
      <p className="break-all">{value.value}</p>
      {safeHref && (
        <a
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-describedby={paperDescribedBy}
          className="inline-flex min-h-6 items-center gap-1 rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-10"
        >
          {linkLabel}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      )}
    </div>
  );
}

export interface ComparisonValueProps extends ExpandProps {
  field: ComparisonFieldDef;
  content: FieldContent;
  className?: string;
}

/** Render `content` for `field`. Missing states never look like values. */
export function ComparisonValue({ field, content, className, ...expand }: ComparisonValueProps) {
  let body: JSX.Element;
  switch (content.type) {
    case "text":
      body =
        content.value.kind === "present" ? (
          <TextValue text={content.value.value} field={field} {...expand} />
        ) : (
          <MissingValue value={content.value} />
        );
      break;
    case "list":
      body =
        content.value.kind === "present" ? (
          <ListValue items={content.value.value} field={field} {...expand} />
        ) : (
          <MissingValue value={content.value} />
        );
      break;
    case "year":
      body =
        content.value.kind === "present" ? <span>{String(content.value.value)}</span> : <MissingValue value={content.value} />;
      break;
    case "identifier":
      body = (
        <IdentifierValue
          value={content.value}
          href={content.href}
          linkLabel={content.linkLabel}
          paperDescribedBy={expand.paperDescribedBy}
        />
      );
      break;
    case "taxonomy":
      body = <TaxonomyValue taxonomy={content.taxonomy} noun={field.noun} />;
      break;
    case "attachments":
      body = <span>{attachmentText(content.summary)}</span>;
      break;
  }
  return <div className={cn("min-w-0 text-sm", className)}>{body}</div>;
}
