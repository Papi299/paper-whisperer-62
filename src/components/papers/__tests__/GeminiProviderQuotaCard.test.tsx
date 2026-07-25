import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { GeminiProviderQuotaCard } from "../GeminiProviderQuotaCard";
import type { GeminiProviderQuotaResponse, GeminiQuotaDimension } from "@/lib/geminiProviderQuota";

function dim(overrides: Partial<GeminiQuotaDimension> = {}): GeminiQuotaDimension {
  return {
    category: "requests",
    model: "gemini-flash-latest",
    limitName: "GenerateContentRequestsPerDayPerProjectPerModel-FreeTier",
    method: null,
    window: "day",
    used: 50,
    limit: 200,
    remaining: 150,
    exceededAttempts: 0,
    ...overrides,
  };
}

function resp(overrides: Partial<GeminiProviderQuotaResponse> = {}): GeminiProviderQuotaResponse {
  return {
    status: "ok",
    configuredModel: "gemini-flash-latest",
    observedModels: ["gemini-flash-latest"],
    providerTier: "free",
    sharedScope: true,
    collectedAt: "2026-07-25T12:00:00Z",
    metricsMayLagSeconds: 240,
    dimensions: [dim()],
    ...overrides,
  };
}

const noop = () => {};

describe("GeminiProviderQuotaCard", () => {
  it("labels the panel and states it is shared/project-level (distinct from user allowance)", () => {
    render(<GeminiProviderQuotaCard data={resp()} isLoading={false} isError={false} isFetching={false} onRefresh={noop} />);
    expect(screen.getByLabelText("Gemini provider quota")).toBeInTheDocument();
    expect(screen.getByText(/shared across all paperlume users/i)).toBeInTheDocument();
    expect(screen.getByText(/separate from each user/i)).toBeInTheDocument();
  });

  it("renders request day limits with used/limit/remaining", () => {
    render(<GeminiProviderQuotaCard data={resp()} isLoading={false} isError={false} isFetching={false} onRefresh={noop} />);
    const row = screen.getByRole("row", { name: /Requests/ });
    expect(within(row).getByText("50")).toBeInTheDocument();
    expect(within(row).getByText("200")).toBeInTheDocument();
    expect(within(row).getByText("150")).toBeInTheDocument();
  });

  it("renders input-token minute limits and multiple models", () => {
    const data = resp({
      observedModels: ["gemini-flash-latest", "gemini-2.0-flash"],
      dimensions: [
        dim({ category: "requests", model: "gemini-flash-latest", window: "minute", limitName: "PerMinute", used: 3, limit: 15, remaining: 12 }),
        dim({ category: "input_tokens", model: "gemini-2.0-flash", window: "minute", limitName: "TokPerMinute", used: 1000, limit: 1000000, remaining: 999000 }),
      ],
    });
    render(<GeminiProviderQuotaCard data={data} isLoading={false} isError={false} isFetching={false} onRefresh={noop} />);
    expect(screen.getByText(/Observed:/)).toHaveTextContent("gemini-2.0-flash");
    expect(screen.getByRole("row", { name: /Requests/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Input tokens/ })).toBeInTheDocument();
  });

  it("shows an unknown-window dimension without fabricating remaining", () => {
    const data = resp({ dimensions: [dim({ window: "unknown", used: 5, limit: 100, remaining: null })] });
    render(<GeminiProviderQuotaCard data={data} isLoading={false} isError={false} isFetching={false} onRefresh={noop} />);
    const row = screen.getByRole("row", { name: /Requests/ });
    // remaining cell shows a dash with an explanatory label, not a made-up number.
    expect(within(row).getByTitle(/remaining not available for this window/i)).toBeInTheDocument();
  });

  it("renders em-dashes for missing usage and limit (never invents 0)", () => {
    const data = resp({ dimensions: [dim({ used: null, limit: null, remaining: null })] });
    render(<GeminiProviderQuotaCard data={data} isLoading={false} isError={false} isFetching={false} onRefresh={noop} />);
    const row = screen.getByRole("row", { name: /Requests/ });
    // used + limit + remaining all "—"
    expect(within(row).getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("renders blocked attempts as unknown (—) when null, '0' when zero, and the value when positive", () => {
    // null → unknown marker with an explanatory title (never fabricated as 0).
    const { unmount } = render(
      <GeminiProviderQuotaCard data={resp({ dimensions: [dim({ exceededAttempts: null })] })} isLoading={false} isError={false} isFetching={false} onRefresh={noop} />,
    );
    let row = screen.getByRole("row", { name: /Requests/ });
    expect(within(row).getByTitle(/blocked attempts not reported/i)).toHaveTextContent("—");
    unmount();

    // 0 → shows "0" (a real reported zero).
    const { unmount: unmount2 } = render(
      <GeminiProviderQuotaCard data={resp({ dimensions: [dim({ exceededAttempts: 0 })] })} isLoading={false} isError={false} isFetching={false} onRefresh={noop} />,
    );
    row = screen.getByRole("row", { name: /Requests/ });
    expect(within(row).getByText("0")).toBeInTheDocument();
    unmount2();

    // positive → shows the value.
    render(
      <GeminiProviderQuotaCard data={resp({ dimensions: [dim({ exceededAttempts: 7 })] })} isLoading={false} isError={false} isFetching={false} onRefresh={noop} />,
    );
    row = screen.getByRole("row", { name: /Requests/ });
    expect(within(row).getByText("7")).toBeInTheDocument();
  });

  it("renders the unavailable state on isError", () => {
    render(<GeminiProviderQuotaCard data={null} isLoading={false} isError={true} isFetching={false} onRefresh={noop} />);
    expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument();
  });

  it("renders the unavailable state with the server message when status is unavailable", () => {
    render(
      <GeminiProviderQuotaCard
        data={resp({ status: "unavailable", dimensions: [], message: "Monitoring credentials absent." })}
        isLoading={false}
        isError={false}
        isFetching={false}
        onRefresh={noop}
      />,
    );
    expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/credentials absent/i)).toBeInTheDocument();
  });

  it("states the approximate / lagging / Pacific-reset / observational caveats", () => {
    render(<GeminiProviderQuotaCard data={resp()} isLoading={false} isError={false} isFetching={false} onRefresh={noop} />);
    expect(screen.getByText(/approximate/i)).toBeInTheDocument();
    expect(screen.getByText(/lag/i)).toBeInTheDocument();
    expect(screen.getByText(/pacific-time boundary/i)).toBeInTheDocument();
    expect(screen.getByText(/observational only/i)).toBeInTheDocument();
  });

  it("fires onRefresh when the refresh button is clicked, and disables it while fetching", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      <GeminiProviderQuotaCard data={resp()} isLoading={false} isError={false} isFetching={false} onRefresh={onRefresh} />,
    );
    const btn = screen.getByRole("button", { name: /refresh provider quota/i });
    fireEvent.click(btn);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(<GeminiProviderQuotaCard data={resp()} isLoading={false} isError={false} isFetching={true} onRefresh={onRefresh} />);
    expect(screen.getByRole("button", { name: /refresh provider quota/i })).toBeDisabled();
  });

  it("shows a loading placeholder while loading", () => {
    render(<GeminiProviderQuotaCard data={null} isLoading={true} isError={false} isFetching={true} onRefresh={noop} />);
    expect(screen.getByLabelText("Loading provider quota")).toBeInTheDocument();
  });
});
