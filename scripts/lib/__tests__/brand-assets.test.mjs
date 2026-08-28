// @vitest-environment node
/**
 * The brand pack holds together.
 *
 * Five SVGs and five PNGs that are supposed to be one mark. Nothing but a test
 * stops them drifting: each SVG is independently editable by design, and a PNG
 * is opaque to review — you cannot see in a diff that someone re-exported it at
 * the wrong size, hand-edited it, or flattened its alpha onto white.
 *
 * These assertions are structural, not aesthetic. They cannot tell you the logo
 * looks right; they tell you every file still agrees about what the logo *is*.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  BEAM_INSET_SCALE,
  BEAM_PATH,
  FOLD_PATH,
  PAGE_PATH,
  PALETTE,
  PNG_SIZES,
  SVG_FILES,
  hexColors,
  pathData,
  readPngHeader,
} from "../brand-assets.mjs";

const BRAND_DIR = fileURLToPath(new URL("../../../assets/brand", import.meta.url));
const readSvg = (name) => readFileSync(path.join(BRAND_DIR, "svg", name), "utf-8");

/**
 * SVG with XML comments removed.
 *
 * Used only for the tag-balance check, which is a question about *markup
 * structure*, and a comment is not markup — `paperlume-logo-horizontal.svg`
 * explains itself with the word `<text>` in prose, and counting that as an
 * opened element is simply wrong.
 *
 * Note this is the opposite call from the package scanner in
 * `extension-package.mjs`, which strips nothing. The difference is what is
 * being asked. There, the question is "what does this shipped file contain?",
 * and a comment ships, so a URL in one counts. Here the question is "is this
 * document well-formed?", and the XML spec answers that comments are not.
 * Every other assertion in this file reads the raw text.
 */
const markupOf = (name) => readSvg(name).replace(/<!--[\s\S]*?-->/g, " ");
const readPng = (size) => readFileSync(path.join(BRAND_DIR, "png", `paperlume-${size}.png`));

/** The four files that render the symbol alone. */
const SYMBOL_FILES = SVG_FILES.filter((f) => f !== "paperlume-logo-horizontal.svg");

describe("brand pack — one mark, five files", () => {
  it.each(SVG_FILES)("%s carries the exact page outline", (name) => {
    expect(pathData(readSvg(name))).toContain(PAGE_PATH);
  });

  it.each(SVG_FILES)("%s carries the exact fold", (name) => {
    expect(pathData(readSvg(name))).toContain(FOLD_PATH);
  });

  it.each(SVG_FILES)("%s carries the exact beam", (name) => {
    expect(pathData(readSvg(name))).toContain(BEAM_PATH);
  });

  it.each(SVG_FILES)("%s holds the beam back from the page edge by the same inset", (name) => {
    // The inset is what keeps the silhouette unbroken on light backgrounds and
    // what stops the monochrome knockouts severing the page. A variant that
    // lost it would look subtly wrong only on the one background nobody tested.
    expect(readSvg(name)).toContain(`scale(${BEAM_INSET_SCALE})`);
  });
});

describe("brand pack — SVG sanity", () => {
  it.each(SVG_FILES)("%s is well-formed XML with a single root svg", (name) => {
    const svg = markupOf(name);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg.match(/<svg\b/g)).toHaveLength(1);
    // Every element that opens must close; a stray tag breaks silently in some
    // renderers and loudly in others.
    for (const tag of ["defs", "linearGradient", "clipPath", "mask", "g", "text"]) {
      const open = (svg.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length;
      const close = (svg.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
      expect(close, `${name}: <${tag}> opened ${open}, closed ${close}`).toBe(open);
    }
  });

  it.each(SVG_FILES)("%s declares the SVG namespace and a viewBox", (name) => {
    const svg = readSvg(name);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1];
    expect(viewBox).toBeDefined();
    const parts = viewBox.split(/\s+/).map(Number);
    expect(parts).toHaveLength(4);
    expect(parts.every((n) => Number.isFinite(n))).toBe(true);
    expect(parts[2]).toBeGreaterThan(0);
    expect(parts[3]).toBeGreaterThan(0);
  });

  it.each(SYMBOL_FILES)("%s is square on the 64-unit grid", (name) => {
    expect(readSvg(name)).toContain('viewBox="0 0 64 64"');
  });

  it.each(SVG_FILES)("%s embeds no raster image and no external reference", (name) => {
    const svg = readSvg(name);
    // A logo that depends on a fetch is not a logo file.
    expect(svg).not.toMatch(/<image\b/);
    expect(svg).not.toMatch(/data:image\//);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it.each(SVG_FILES)("%s uses only approved brand colours", (name) => {
    const approved = Object.values(PALETTE).map((c) => c.toUpperCase());
    // #000000 is legal only inside a mask, where it means "hide", not a colour.
    const masked = readSvg(name).includes("<mask");
    for (const color of hexColors(readSvg(name))) {
      if (masked && (color === "#000000" || color === "#FFFFFF")) continue;
      expect(approved, `${name} uses off-palette ${color}`).toContain(color);
    }
  });

  it("gives every gradient, clip and mask a file-unique id", () => {
    // These files get inlined together into one document. Colliding ids mean
    // one logo silently adopts another's gradient.
    const seen = new Map();
    for (const name of SVG_FILES) {
      for (const [, id] of readSvg(name).matchAll(/\sid="([^"]+)"/g)) {
        expect(seen.has(id), `id "${id}" appears in both ${seen.get(id)} and ${name}`).toBe(false);
        seen.set(id, name);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});

describe("brand pack — PNG exports", () => {
  it.each(PNG_SIZES)("paperlume-%i.png is exactly that many pixels square, RGBA", (size) => {
    const header = readPngHeader(readPng(size));
    expect(header, `paperlume-${size}.png is not a PNG`).not.toBeNull();
    expect(header.width).toBe(size);
    expect(header.height).toBe(size);
    expect(header.bitDepth).toBe(8);
    // Colour type 6 is RGBA. Anything else has no per-pixel alpha, which means
    // the transparent background was flattened somewhere.
    expect(header.colorType, `paperlume-${size}.png has no alpha channel`).toBe(6);
  });

  it("exports every Chrome icon size", () => {
    for (const chromeSize of [16, 32, 48, 128]) {
      expect(PNG_SIZES).toContain(chromeSize);
    }
  });
});
