import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AiQuotaIndicator } from "../AiQuotaIndicator";
import type { AiQuotaStatus } from "@/hooks/useAiQuota";

function status(overrides: Partial<AiQuotaStatus> = {}): AiQuotaStatus {
  return { allowed: true, reason: "ok", plan: "free", planStatus: "active", periodType: "lifetime", used: 3, quota: 15, remaining: 12, resetAt: null, isExempt: false, ...overrides };
}

describe("AiQuotaIndicator", () => {
  it("renders remaining and total for a lifetime allowance", () => {
    render(<AiQuotaIndicator status={status()} isLoading={false} isError={false} />);
    const el = screen.getByRole("status");
    expect(el).toHaveTextContent("AI analyses:");
    expect(el).toHaveTextContent("12");
    expect(el).toHaveTextContent("15");
    expect(el).toHaveTextContent("Lifetime");
    // Accessible supporting text is present and non-commercial.
    expect(el.getAttribute("aria-label")).toMatch(/12 of 15 remaining/);
    expect(el.getAttribute("aria-label")).not.toMatch(/upgrade|pay|billing/i);
  });

  it("renders a clear zero state (not color-only)", () => {
    render(<AiQuotaIndicator status={status({ remaining: 0, used: 15 })} isLoading={false} isError={false} />);
    const el = screen.getByRole("status");
    expect(el).toHaveTextContent("none left");
    expect(el).toHaveTextContent("0");
  });

  it("shows monthly reset context in the accessible supporting text", () => {
    render(
      <AiQuotaIndicator
        status={status({ periodType: "monthly", quota: 350, remaining: 340, resetAt: "2026-08-01T00:00:00Z" })}
        isLoading={false}
        isError={false}
      />,
    );
    const el = screen.getByRole("status");
    expect(el).toHaveTextContent("This month");
    expect(el.getAttribute("aria-label")).toMatch(/Resets/);
    // Reset date is rendered in UTC (Aug 1), not shifted to Jul 31.
    const aug1 = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 7, 1)));
    expect(el.getAttribute("aria-label")).toContain(aug1);
  });

  it("renders 'Unlimited' (never a fabricated number) for an exempt internal user", () => {
    // Exempt owner past the nominal cap: used > quota, remaining 0.
    render(
      <AiQuotaIndicator
        status={status({ isExempt: true, reason: "quota_exempt", plan: "pro", periodType: "monthly", used: 412, quota: 350, remaining: 0 })}
        isLoading={false}
        isError={false}
      />,
    );
    const el = screen.getByRole("status");
    expect(el).toHaveTextContent("Unlimited");
    // No fabricated number and no commercial/Labs wording.
    expect(el).not.toHaveTextContent("350");
    expect(el).not.toHaveTextContent("412");
    expect(el.textContent).not.toMatch(/upgrade|pay|billing|labs|team/i);
    // Accessible description explains internal access + still-recorded usage.
    expect(el.getAttribute("aria-label")).toMatch(/internal owner access/i);
    expect(el.getAttribute("aria-label")).toMatch(/recorded/i);
  });

  it("renders an unavailable state when there is no active AI bucket", () => {
    render(<AiQuotaIndicator status={status({ periodType: null, quota: 0, remaining: 0, allowed: false, reason: "inactive_entitlement" })} isLoading={false} isError={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("unavailable");
  });

  it("renders a fixed-size loading placeholder (no content, no layout shift)", () => {
    render(<AiQuotaIndicator status={null} isLoading={true} isError={false} />);
    expect(screen.getByLabelText("Loading AI analysis quota")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("fails soft: renders nothing on error", () => {
    const { container } = render(<AiQuotaIndicator status={null} isLoading={false} isError={true} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("fails soft: renders nothing when status is null and not loading", () => {
    const { container } = render(<AiQuotaIndicator status={null} isLoading={false} isError={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
