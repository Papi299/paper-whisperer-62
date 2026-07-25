import { RefreshCw, Gauge, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  categoryLabel,
  windowLabel,
  type GeminiProviderQuotaResponse,
  type GeminiQuotaDimension,
} from "@/lib/geminiProviderQuota";

interface GeminiProviderQuotaCardProps {
  data: GeminiProviderQuotaResponse | null;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  onRefresh: () => void;
}

function fmtNum(n: number | null): string {
  return n === null ? "—" : n.toLocaleString();
}

function fmtTimestamp(iso: string): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
  } catch {
    return "unknown";
  }
}

function DimensionRow({ dim }: { dim: GeminiQuotaDimension }) {
  const scope = `${categoryLabel(dim.category)} · ${windowLabel(dim.window)}`;
  const remainingKnown = dim.remaining !== null;
  const remainingLabel = remainingKnown
    ? `${fmtNum(dim.remaining)} remaining`
    : "remaining not available for this window";
  return (
    <tr className="border-t">
      <th scope="row" className="py-1.5 pr-3 text-left font-medium">
        {scope}
        <span className="block text-xs font-normal text-muted-foreground">
          {dim.model}
          {dim.method ? ` · ${dim.method}` : ""}
        </span>
      </th>
      <td className="py-1.5 px-2 text-right tabular-nums">{fmtNum(dim.used)}</td>
      <td className="py-1.5 px-2 text-right tabular-nums">{fmtNum(dim.limit)}</td>
      <td className="py-1.5 pl-2 text-right tabular-nums" aria-label={remainingLabel} title={remainingLabel}>
        {remainingKnown ? fmtNum(dim.remaining) : "—"}
      </td>
      <td
        className="py-1.5 pl-2 text-right tabular-nums"
        title={dim.exceededAttempts === null ? "blocked attempts not reported" : undefined}
      >
        {fmtNum(dim.exceededAttempts)}
      </td>
    </tr>
  );
}

/**
 * Manager-only panel for the SHARED Google Gemini provider quota. Purely
 * presentational — the caller (Dashboard) owns `useGeminiProviderQuota` and
 * renders this ONLY when the viewer may see it, so ordinary users never fetch or
 * see this data. Distinguishes the shared provider quota from each user's
 * Paperlume allowance, states the approximate/lagging/shared nature explicitly,
 * and never fabricates a remaining count when the window is unreliable.
 */
export function GeminiProviderQuotaCard({
  data,
  isLoading,
  isError,
  isFetching,
  onRefresh,
}: GeminiProviderQuotaCardProps) {
  const unavailable = isError || !data || data.status === "unavailable";
  const lagSeconds = data?.metricsMayLagSeconds ?? 0;

  return (
    <Card aria-label="Gemini provider quota" className="w-full">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 p-4">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="h-4 w-4 shrink-0" aria-hidden="true" />
            Gemini provider quota
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Shared across all Paperlume users · Google Cloud project-level. Separate from each
            user&apos;s Paperlume AI allowance.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={isFetching}
          aria-label="Refresh provider quota"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
          <span className="ml-1.5">Refresh</span>
        </Button>
      </CardHeader>

      <CardContent className="p-4 pt-0 text-sm">
        {data && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary">Configured: {data.configuredModel}</Badge>
            {data.observedModels.length > 0 && (
              <span className="text-muted-foreground">
                Observed: {data.observedModels.join(", ")}
              </span>
            )}
          </div>
        )}

        {isLoading ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading provider quota">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : unavailable ? (
          <div
            className="flex items-start gap-2 rounded-md border border-muted bg-muted/30 px-3 py-2 text-muted-foreground"
            role="status"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <p>Gemini provider quota is temporarily unavailable.</p>
              {data?.message && <p className="mt-0.5 text-xs">{data.message}</p>}
            </div>
          </div>
        ) : data && data.dimensions.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Shared Gemini provider quota by dimension: used, limit, remaining, and blocked
                attempts.
              </caption>
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th scope="col" className="pb-1 pr-3 text-left font-medium">
                    Dimension
                  </th>
                  <th scope="col" className="pb-1 px-2 text-right font-medium">
                    Used
                  </th>
                  <th scope="col" className="pb-1 px-2 text-right font-medium">
                    Limit
                  </th>
                  <th scope="col" className="pb-1 pl-2 text-right font-medium">
                    Remaining
                  </th>
                  <th scope="col" className="pb-1 pl-2 text-right font-medium">
                    Blocked
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.dimensions.map((dim) => (
                  <DimensionRow key={`${dim.category}:${dim.model}:${dim.limitName}`} dim={dim} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-md border border-muted bg-muted/30 px-3 py-2 text-muted-foreground" role="status">
            No Gemini provider-quota dimensions were reported.
          </div>
        )}

        <p className="mt-3 text-xs text-muted-foreground">
          Values are approximate and shared across the Google project; Google metrics can lag
          {lagSeconds > 0 ? ` up to ~${lagSeconds}s` : ""}. Exceeding any dimension can block
          requests. Daily limits reset on Google&apos;s Pacific-time boundary. Observational only —
          not real-time billing or guaranteed availability.
          {data?.collectedAt ? ` Last collected ${fmtTimestamp(data.collectedAt)}.` : ""}
        </p>
      </CardContent>
    </Card>
  );
}
