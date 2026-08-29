// @vitest-environment node
/**
 * The committed Chrome Web Store listing images are what they claim to be.
 *
 * These five PNGs are uploaded by hand into a form that accepts them, tells you
 * nothing, and then shows them to every visitor of the listing. Nothing else in
 * the repository looks at them: they are not imported, not built, not served,
 * and not covered by any other suite. A wrong-sized promo tile, a screenshot
 * regenerated at the wrong scale, or an icon whose transparent padding was lost
 * would all sit in the tree indefinitely looking exactly like a correct one.
 *
 * The assertions are structural, like the brand suite's. They cannot tell you
 * the images look good; they tell you the files still satisfy the dimensions
 * and the transparency Chrome documents, and that the set on disk is the set
 * the contract declares.
 *
 * What the *pixels* contain is checked where it can actually be checked — in a
 * browser, by `scripts/export-store-assets.mjs`, which decodes every image it
 * produces and refuses to write one whose corners, padding or colour count are
 * wrong. Re-running that check here would mean decoding PNGs in Node, which
 * means an image decoder, which is a dependency this repository does not want
 * for the sake of restating a check the generator already fails on.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { ALPHA_COLOR_TYPES, readPngHeader } from "../png.mjs";
import {
  MARK_BOUNDS,
  MAX_NAME_LENGTH,
  MAX_SHORT_DESCRIPTION_LENGTH,
  SCREENSHOT,
  STORE_ASSETS,
  STORE_ASSET_DIR,
  STORE_ICON,
} from "../store-assets.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const ASSET_DIR = path.join(REPO_ROOT, STORE_ASSET_DIR);
const readAsset = (file) => new Uint8Array(readFileSync(path.join(ASSET_DIR, file)));

/** The canonical policy URL. It is the exact string a human pastes into the Dashboard. */
const PRIVACY_POLICY_URL = "https://app.paperlume.app/privacy";

const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "extension", "manifest.json"), "utf-8"));
const listingDoc = readFileSync(path.join(REPO_ROOT, "docs", "chrome-web-store-listing.md"), "utf-8");

describe("store assets — every declared image is present and correctly sized", () => {
  it.each(STORE_ASSETS)("$file is a $width×$height PNG", (asset) => {
    const header = readPngHeader(readAsset(asset.file));
    expect(header, `${asset.file} is not a PNG`).not.toBeNull();
    expect(header.width).toBe(asset.width);
    expect(header.height).toBe(asset.height);
    expect(header.bitDepth).toBe(8);
  });

  it("contains exactly the declared set, and nothing else", () => {
    // An orphaned image left behind by a renamed asset is uploaded by whoever
    // reads the directory rather than the contract.
    expect(readdirSync(ASSET_DIR).sort()).toEqual(STORE_ASSETS.map((asset) => asset.file).sort());
  });
});

describe("store assets — the Store-icon candidate", () => {
  const icon = STORE_ASSETS.find((asset) => asset.role === "Store icon");

  it("is recorded as a candidate, not as the guaranteed store icon", () => {
    // The 128px icon first-party documentation guarantees is used ships inside
    // the package. Whether the Dashboard also takes a separate upload is
    // unresolved, and this file must not start implying that it does.
    expect(icon.submissionPath).toContain("candidate");
    expect(icon.submissionPath).toContain("icons/icon-128.png");
  });

  it("is the canvas size Chrome documents", () => {
    expect([icon.width, icon.height]).toEqual([STORE_ICON.canvas, STORE_ICON.canvas]);
  });

  it("keeps an alpha channel, because the padding has to be transparent", () => {
    // Colour type without alpha means the padding was flattened onto some
    // colour at export — which is invisible until the Store renders it on a
    // background that is not that colour.
    expect(ALPHA_COLOR_TYPES).toContain(readPngHeader(readAsset(icon.file)).colorType);
  });

  it("reserves the documented padding inside the canvas", () => {
    // 96 + 16 + 16 = 128. Stated as arithmetic rather than as three constants
    // that happen to be consistent today.
    expect(STORE_ICON.contentBox + 2 * STORE_ICON.minPadding).toBe(STORE_ICON.canvas);
  });

  it("describes a mark that is taller than it is wide, so the fit is height-driven", () => {
    // The fit maths in the generator scales the *taller* axis to the content
    // box. If the mark ever became landscape, that would silently overflow the
    // canvas horizontally instead.
    expect(MARK_BOUNDS.height).toBeGreaterThan(MARK_BOUNDS.width);
    expect(MARK_BOUNDS.x + MARK_BOUNDS.width).toBeLessThanOrEqual(MARK_BOUNDS.grid);
    expect(MARK_BOUNDS.y + MARK_BOUNDS.height).toBeLessThanOrEqual(MARK_BOUNDS.grid);
  });
});

describe("store assets — screenshots", () => {
  const screenshots = STORE_ASSETS.filter((asset) => asset.role.startsWith("Screenshot"));

  it("provides between one and five, as the Store allows", () => {
    expect(screenshots.length).toBeGreaterThanOrEqual(SCREENSHOT.min);
    expect(screenshots.length).toBeLessThanOrEqual(SCREENSHOT.max);
  });

  it.each(screenshots)("$file uses the full 1280×800 frame", (asset) => {
    expect([asset.width, asset.height]).toEqual([SCREENSHOT.width, SCREENSHOT.height]);
  });

  it("records, for every screenshot, that its UI came from the real extension", () => {
    // The field exists so that "is this picture of something that exists?" has
    // a written answer per file rather than being re-derived from the generator
    // each time somebody asks.
    for (const asset of screenshots) {
      expect(asset.depicts, `${asset.file} does not say where its UI came from`).toContain("real popup");
      expect(asset.depicts).toContain("built extension");
    }
  });
});

describe("store listing copy — the limits Chrome publishes", () => {
  it("keeps the extension name within Chrome's 75-character limit", () => {
    expect(manifest.name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });

  it("keeps the manifest description within the 132-character summary limit", () => {
    // The Dashboard's summary field is prefilled from this string, so the
    // manifest limit and the listing limit are the same number for a reason.
    expect(manifest.description.length).toBeLessThanOrEqual(MAX_SHORT_DESCRIPTION_LENGTH);
  });

  it("keeps every drafted Store summary within the same limit", () => {
    // The drafts live in the listing document as blockquoted single lines under
    // the summary heading. Reading them here means a draft that grew past the
    // limit fails now rather than in the Dashboard.
    const section = listingDoc.split("## ").find((part) => part.startsWith("3. Summary"));
    expect(section, "the listing document has no summary section").toBeDefined();
    const drafts = [...section.matchAll(/^> (\S.*)$/gm)].map((match) => match[1].trim());
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(draft.length, `summary draft is ${draft.length} characters: ${draft}`).toBeLessThanOrEqual(
        MAX_SHORT_DESCRIPTION_LENGTH,
      );
    }
  });
});

describe("store listing copy — the privacy policy URL", () => {
  it("names the canonical policy URL", () => {
    expect(listingDoc).toContain(PRIVACY_POLICY_URL);
  });

  it("names no other PaperLume privacy route", () => {
    // A Store listing pointing at a policy that does not load, or at a second
    // policy nobody maintains, is a submission failure that reads as a typo.
    // Scoped to PaperLume's own origins: citations of Google's policy pages are
    // not candidate values for this field.
    const paperLumePrivacyUrls = new Set(
      [...listingDoc.matchAll(/https?:\/\/[^\s)"'`]+/gi)]
        .map((match) => match[0].replace(/[.,;:]+$/, ""))
        .filter((url) => /paperlume/i.test(url) && /privacy/i.test(url)),
    );
    expect([...paperLumePrivacyUrls]).toEqual([PRIVACY_POLICY_URL]);
  });
});
