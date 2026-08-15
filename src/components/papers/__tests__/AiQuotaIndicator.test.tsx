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

  it("renders 'Unlimited' (never a fabricated number) for an active exempt owner", () => {
    // Exempt owner past the nominal cap: used > quota, remaining 0 — but the
    // server is authoritatively an active exemption.
    render(
      <AiQuotaIndicator
        status={status({ isExempt: true, allowed: true, reason: "quota_exempt", plan: "pro", periodType: "monthly", used: 412, quota: 350, remaining: 0 })}
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
    // Role-neutral wording + still-recorded usage note.
    expect(el.getAttribute("aria-label")).toMatch(/internal AI quota exemption/i);
    expect(el.getAttribute("aria-label")).not.toMatch(/owner/i);
    expect(el.getAttribute("aria-label")).toMatch(/recorded/i);
  });

  it("renders 'Unlimited' for an active explicitly-exempt manager (role-neutral)", () => {
    render(
      <AiQuotaIndicator
        status={status({ isExempt: true, allowed: true, reason: "quota_exempt", plan: "pro", periodType: "monthly", used: 10, quota: 350, remaining: 340 })}
        isLoading={false}
        isError={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Unlimited");
  });

  it("does NOT show Unlimited for an inactive entitlement even when isExempt is true", () => {
    // Server authority wins: inactive → not an active exemption → unavailable.
    render(
      <AiQuotaIndicator
        status={status({ isExempt: true, allowed: false, reason: "inactive_entitlement", periodType: null, quota: 0, remaining: 0 })}
        isLoading={false}
        isError={false}
      />,
    );
    const el = screen.getByRole("status");
    expect(el).not.toHaveTextContent("Unlimited");
    expect(el).toHaveTextContent("unavailable");
  });

  it("does NOT show Unlimited for a missing entitlement (isExempt false)", () => {
    render(
      <AiQuotaIndicator
        status={status({ isExempt: false, allowed: false, reason: "missing_entitlement", periodType: null, quota: 0, remaining: 0 })}
        isLoading={false}
        isError={false}
      />,
    );
    const el = screen.getByRole("status");
    expect(el).not.toHaveTextContent("Unlimited");
    expect(el).toHaveTextContent("unavailable");
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

/**
 * The compact variant exists so the indicator costs a phone roughly a glyph and
 * a ratio instead of a third of the line. It must shrink the VISIBLE text only:
 * the accessible name, the live-region role and the quota numbers themselves
 * stay exactly as the desktop presentation computes them.
 */
describe("AiQuotaIndicator (compact)", () => {
  it("shows a bare ratio but keeps the full accessible name", () => {
    render(<AiQuotaIndicator status={status()} isLoading={false} isError={false} variant="compact" />);
    const el = screen.getByRole("status");
    expect(el).toHaveTextContent("12/15");
    expect(el).not.toHaveTextContent("AI analyses:");
    expect(el.getAttribute("aria-label")).toMatch(/Lifetime AI analysis allowance: 12 of 15 remaining/);
    expect(el.getAttribute("title")).toMatch(/12 of 15 remaining/);
  });

  it("advertises an exemption without inventing a number", () => {
    render(
      <AiQuotaIndicator
        status={status({ isExempt: true, allowed: true, reason: "quota_exempt" })}
        isLoading={false}
        isError={false}
        variant="compact"
      />,
    );
    const el = screen.getByRole("status");
    expect(el).toHaveTextContent("∞");
    expect(el).not.toHaveTextContent("15");
    expect(el.getAttribute("aria-label")).toMatch(/Unlimited AI analyses/);
    expect(el.getAttribute("aria-label")).not.toMatch(/upgrade|pay|billing|checkout/i);
  });

  it("keeps the unavailable state legible", () => {
    render(
      <AiQuotaIndicator
        status={status({ periodType: null, quota: 0, remaining: 0, allowed: false, reason: "inactive_entitlement" })}
        isLoading={false}
        isError={false}
        variant="compact"
      />,
    );
    const el = screen.getByRole("status");
    expect(el).toHaveTextContent(/unavailable/i);
    expect(el.getAttribute("aria-label")).toBe("AI analyses unavailable");
  });

  it("computes the same numbers as the full variant", () => {
    const s = status({ used: 9, remaining: 6, quota: 15 });
    const { unmount } = render(<AiQuotaIndicator status={s} isLoading={false} isError={false} />);
    const fullLabel = screen.getByRole("status").getAttribute("aria-label");
    unmount();
    render(<AiQuotaIndicator status={s} isLoading={false} isError={false} variant="compact" />);
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(fullLabel);
  });

  it("still fails soft and still reserves loading space", () => {
    const { container, unmount } = render(
      <AiQuotaIndicator status={null} isLoading={false} isError={true} variant="compact" />,
    );
    expect(container).toBeEmptyDOMElement();
    unmount();
    render(<AiQuotaIndicator status={null} isLoading={true} isError={false} variant="compact" />);
    expect(screen.getByLabelText("Loading AI analysis quota")).toBeInTheDocument();
  });
});
