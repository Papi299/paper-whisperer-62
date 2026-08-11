import { describe, it, expect } from "vitest";
import {
  attachmentArchivePath,
  hasControlCharacter,
  isSafeArchivePath,
  sanitizeArchiveFilename,
} from "../sanitizeArchiveFilename";

const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);
const DEL = String.fromCharCode(127);

describe("sanitizeArchiveFilename", () => {
  it("reduces traversal-style names to a single safe segment", () => {
    // The canonical zip-slip payloads must never survive as path structure.
    expect(sanitizeArchiveFilename("../../secret.txt")).toBe("secret.txt");
    expect(sanitizeArchiveFilename("../paper.pdf")).toBe("paper.pdf");
    expect(sanitizeArchiveFilename("foo/bar.pdf")).toBe("bar.pdf");
    expect(sanitizeArchiveFilename("foo\\bar.pdf")).toBe("bar.pdf");
    expect(sanitizeArchiveFilename("/etc/passwd")).toBe("passwd");
    expect(sanitizeArchiveFilename("C:\\Windows\\system32\\config")).toBe("config");
  });

  it("falls back when nothing usable survives", () => {
    expect(sanitizeArchiveFilename("..")).toBe("attachment");
    expect(sanitizeArchiveFilename(".")).toBe("attachment");
    expect(sanitizeArchiveFilename("...")).toBe("attachment");
    expect(sanitizeArchiveFilename("")).toBe("attachment");
    expect(sanitizeArchiveFilename("   ")).toBe("attachment");
    expect(sanitizeArchiveFilename(null)).toBe("attachment");
    expect(sanitizeArchiveFilename(undefined)).toBe("attachment");
    expect(sanitizeArchiveFilename("../../")).toBe("attachment");
  });

  it("strips control characters", () => {
    expect(sanitizeArchiveFilename(`pa${NUL}per.pdf`)).toBe("paper.pdf");
    expect(sanitizeArchiveFilename(`pa${BELL}per.pdf`)).toBe("paper.pdf");
    expect(sanitizeArchiveFilename(`paper${DEL}.pdf`)).toBe("paper.pdf");
    expect(hasControlCharacter(`a${NUL}b`)).toBe(true);
    expect(hasControlCharacter("ab")).toBe(false);
  });

  it("neutralizes leading dots, trailing dots/spaces and illegal characters", () => {
    expect(sanitizeArchiveFilename(".hidden.pdf")).toBe("hidden.pdf");
    expect(sanitizeArchiveFilename("report.pdf.")).toBe("report.pdf");
    expect(sanitizeArchiveFilename("report.pdf ")).toBe("report.pdf");
    expect(sanitizeArchiveFilename('a<b>c:d"e|f?g*h.pdf')).toBe("a_b_c_d_e_f_g_h.pdf");
  });

  it("defuses Windows reserved device names", () => {
    expect(sanitizeArchiveFilename("CON.pdf")).toBe("_CON.pdf");
    expect(sanitizeArchiveFilename("nul")).toBe("_nul");
    expect(sanitizeArchiveFilename("COM1.txt")).toBe("_COM1.txt");
    // Not reserved — must be left alone.
    expect(sanitizeArchiveFilename("console.pdf")).toBe("console.pdf");
  });

  it("bounds the length while keeping the extension", () => {
    const long = `${"a".repeat(400)}.pdf`;
    const result = sanitizeArchiveFilename(long);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith(".pdf")).toBe(true);
  });

  it("preserves ordinary Unicode filenames", () => {
    expect(sanitizeArchiveFilename("מאמר.pdf")).toBe("מאמר.pdf");
    expect(sanitizeArchiveFilename("études cliniques.pdf")).toBe("études cliniques.pdf");
  });
});

describe("attachmentArchivePath", () => {
  it("namespaces by immutable ids so duplicate original names cannot collide", () => {
    const a = attachmentArchivePath({
      id: "11111111-1111-1111-1111-111111111111",
      paper_id: "paper-1",
      file_name: "study.pdf",
    });
    const b = attachmentArchivePath({
      id: "22222222-2222-2222-2222-222222222222",
      paper_id: "paper-1",
      file_name: "study.pdf",
    });

    expect(a).toBe("attachments/paper-1/11111111-1111-1111-1111-111111111111-study.pdf");
    expect(b).toBe("attachments/paper-1/22222222-2222-2222-2222-222222222222-study.pdf");
    expect(a).not.toBe(b);
  });

  it("keeps traversal payloads inside the attachments directory", () => {
    for (const fileName of [
      "../../secret.txt",
      "../paper.pdf",
      "foo/bar.pdf",
      "foo\\bar.pdf",
      "..",
      `evil${NUL}.pdf`,
    ]) {
      const path = attachmentArchivePath({ id: "att-1", paper_id: "paper-1", file_name: fileName });
      expect(path.startsWith("attachments/paper-1/")).toBe(true);
      expect(path.split("/")).not.toContain("..");
      expect(isSafeArchivePath(path)).toBe(true);
    }
  });
});

describe("isSafeArchivePath", () => {
  it("accepts the paths this exporter produces", () => {
    expect(isSafeArchivePath("manifest.json")).toBe(true);
    expect(isSafeArchivePath("data/papers.json")).toBe(true);
    expect(isSafeArchivePath("attachments/p1/a1-study.pdf")).toBe(true);
  });

  it("rejects absolute, traversal, backslash, drive-letter and control-char paths", () => {
    expect(isSafeArchivePath("")).toBe(false);
    expect(isSafeArchivePath("/etc/passwd")).toBe(false);
    expect(isSafeArchivePath("../secret")).toBe(false);
    expect(isSafeArchivePath("data/../../secret")).toBe(false);
    expect(isSafeArchivePath("data/./papers.json")).toBe(false);
    expect(isSafeArchivePath("data//papers.json")).toBe(false);
    expect(isSafeArchivePath("data\\papers.json")).toBe(false);
    expect(isSafeArchivePath("C:/data/papers.json")).toBe(false);
    expect(isSafeArchivePath(`data/pap${NUL}ers.json`)).toBe(false);
  });
});
