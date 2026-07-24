import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AiQuotaIndicator } from "../AiQuotaIndicator";
import type { AiQuotaStatus } from "@/hooks/useAiQuota";

function status(overrides: Partial<AiQuotaStatus> = {}): AiQuotaStatus {
  return { allowed: true, reason: "ok", plan: "free", planStatus: "active", periodType: "lifetime", used: 3, quota: 15, remaining: 12, resetAt: null, ...overrides };
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
