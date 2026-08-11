import { describe, it, expect, vi, afterEach } from "vitest";
import {
  accountExportFileName,
  accountExportStatusText,
  triggerArchiveDownload,
} from "../downloadAccountExport";

describe("accountExportFileName", () => {
  it("is deterministic, UTC, and product-prefixed", () => {
    expect(accountExportFileName(new Date("2026-08-10T20:30:00.000Z"))).toBe(
      "paperlume-account-export-2026-08-10T20-30-00Z.zip",
    );
    // Same instant expressed in another zone yields the same name.
    expect(accountExportFileName(new Date("2026-08-10T23:30:00.000+03:00"))).toBe(
      "paperlume-account-export-2026-08-10T20-30-00Z.zip",
    );
  });

  it("uses only characters valid on Windows, macOS and Linux", () => {
    const name = accountExportFileName(new Date("2026-12-31T23:59:59.999Z"));
    for (const illegal of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
      expect(name).not.toContain(illegal);
    }
  });

  it("carries no email address or other personal identifier", () => {
    const name = accountExportFileName(new Date("2026-08-10T20:30:00.000Z"));
    expect(name).not.toContain("@");
    expect(name).toMatch(/^paperlume-account-export-[\d-T]+Z\.zip$/);
  });
});

describe("accountExportStatusText", () => {
  it("reports a bounded stage rather than an indefinite spinner", () => {
    expect(accountExportStatusText(null)).toBe("Preparing account data…");
    expect(accountExportStatusText({ stage: "collecting" })).toBe("Preparing account data…");
    expect(accountExportStatusText({ stage: "attachments", current: 2, total: 12 })).toBe(
      "Downloading attachments 3 of 12…",
    );
    expect(accountExportStatusText({ stage: "archiving" })).toBe("Creating archive…");
  });

  it("never reports a position beyond the total", () => {
    expect(accountExportStatusText({ stage: "attachments", current: 12, total: 12 })).toBe(
      "Downloading attachments 12 of 12…",
    );
  });
});

describe("triggerArchiveDownload", () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
  });

  it("downloads locally exactly once and releases the object URL", () => {
    const created: Blob[] = [];
    const revoked: string[] = [];
    URL.createObjectURL = ((blob: Blob) => {
      created.push(blob);
      return "blob:mock-url";
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      revoked.push(url);
    }) as typeof URL.revokeObjectURL;

    const clicks: HTMLAnchorElement[] = [];
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const element = realCreateElement(tag) as HTMLElement;
      if (tag === "a") {
        (element as HTMLAnchorElement).click = () => clicks.push(element as HTMLAnchorElement);
      }
      return element;
    });

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "application/zip" });
    triggerArchiveDownload(blob, "paperlume-account-export-2026-08-10T20-30-00Z.zip");

    expect(created).toEqual([blob]);
    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe("paperlume-account-export-2026-08-10T20-30-00Z.zip");
    expect(clicks[0].href).toContain("blob:mock-url");
    expect(revoked).toEqual(["blob:mock-url"]);
    // The anchor is not left behind in the document.
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });
});
