import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StorageUsageSection } from "../StorageUsageSection";
import type { StorageUsageStatus } from "@/hooks/useStorageUsage";

const MB = 1024 * 1024;

function status(overrides: Partial<StorageUsageStatus> = {}): StorageUsageStatus {
  return {
    usedBytes: 124 * MB,
    quotaBytes: 500 * MB,
    remainingBytes: 376 * MB,
    percentUsed: 25,
    isAtOrOverQuota: false,
    ...overrides,
  };
}

describe("StorageUsageSection", () => {
  it("renders a small scoped loading placeholder, not the usage text", () => {
    render(<StorageUsageSection status={null} isLoading={true} isError={false} />);
    // The section heading stays put so the dialog does not jump.
    expect(screen.getByRole("heading", { name: "Storage" })).toBeInTheDocument();
    expect(screen.getByLabelText("Loading storage usage")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("renders formatted used / quota / remaining in binary units", () => {
    render(<StorageUsageSection status={status()} isLoading={false} isError={false} />);
    expect(screen.getByText("124 MB of 500 MB used")).toBeInTheDocument();
    expect(screen.getByText("376 MB remaining")).toBeInTheDocument();
    // No raw byte integers are ever shown.
    expect(screen.queryByText(/\b\d{7,}\b/)).toBeNull();
  });

  it("gives the Progress element an accessible name and value text", () => {
    render(<StorageUsageSection status={status()} isLoading={false} isError={false} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-label", "Storage usage");
    expect(bar).toHaveAttribute("aria-valuetext", "124 MB of 500 MB used");
    expect(bar).toHaveAttribute("aria-valuenow", "25");
  });

  it("shows an actionable limit-reached state at exactly the cap — with no upgrade CTA", () => {
    render(
      <StorageUsageSection
        status={status({
          usedBytes: 500 * MB,
          remainingBytes: 0,
          percentUsed: 100,
          isAtOrOverQuota: true,
        })}
        isLoading={false}
        isError={false}
      />,
    );
    expect(screen.getByText("500 MB of 500 MB used")).toBeInTheDocument();
    expect(
      screen.getByText("Storage limit reached. Delete attachments to free space."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/remaining/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/upgrade|checkout|pricing|billing|plan|pay/i);
  });

  it("keeps historical overage truthful: real used/quota text, clamped bar", () => {
    render(
      <StorageUsageSection
        status={status({
          usedBytes: 512 * MB,
          quotaBytes: 500 * MB,
          remainingBytes: 0,
          percentUsed: 100,
          isAtOrOverQuota: true,
        })}
        isLoading={false}
        isError={false}
      />,
    );
    // Usage is NOT rewritten down to the quota.
    expect(screen.getByText("512 MB of 500 MB used")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(
      screen.getByText("Storage limit reached. Delete attachments to free space."),
    ).toBeInTheDocument();
  });

  it("renders the zero state for a user with no attachments yet", () => {
    render(
      <StorageUsageSection
        status={status({ usedBytes: 0, remainingBytes: 500 * MB, percentUsed: 0 })}
        isLoading={false}
        isError={false}
      />,
    );
    expect(screen.getByText("0 B of 500 MB used")).toBeInTheDocument();
    expect(screen.getByText("500 MB remaining")).toBeInTheDocument();
  });

  it("fails soft on a read error — a neutral line, never a raw Postgres message", () => {
    render(<StorageUsageSection status={null} isLoading={false} isError={true} />);
    expect(screen.getByText("Storage usage unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("fails soft when the entitlement is missing (status null, no error)", () => {
    render(<StorageUsageSection status={null} isLoading={false} isError={false} />);
    expect(screen.getByText("Storage usage unavailable.")).toBeInTheDocument();
    // No fabricated Free baseline is shown.
    expect(screen.queryByText(/500 MB/)).toBeNull();
  });
});
