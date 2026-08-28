#!/usr/bin/env node
/**
 * Rasterise the PaperLume symbol to the canonical transparent PNG sizes.
 *
 * The SVGs in `assets/brand/svg/` are the masters; the PNGs beside them are
 * generated, and this script is the only thing that should generate them. They
 * are committed rather than built on demand because Chrome reads icon files
 * from a packaged extension and a store listing takes uploads — neither can run
 * a build step — but a committed binary with no reproducible origin is exactly
 * the kind of asset that quietly drifts from its source.
 *
 * ## Why Playwright's Chromium and not an image library
 *
 * No rasteriser is installed on a clean machine here (no rsvg-convert, no
 * ImageMagick, no Inkscape), and the repository keeps a single, deliberately
 * small root dependency graph — see `docs/dependency-security.md`. Playwright is
 * already a devDependency, and its Chromium is the *same renderer Chrome uses*,
 * so what this writes is what the browser will draw from the same SVG. Adding
 * sharp or an SVG rasteriser to produce five small PNGs would buy a second
 * rendering engine and a native build.
 *
 * `omitBackground: true` is what makes the alpha channel survive; the page is
 * given no background of its own so nothing composites behind the mark.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BRAND_DIR = path.join(REPO_ROOT, "assets", "brand");
const SVG_SOURCE = path.join(BRAND_DIR, "svg", "paperlume-symbol.svg");
const PNG_DIR = path.join(BRAND_DIR, "png");

/**
 * The sizes Chrome and the Store actually ask for.
 *
 * 16/32/48/128 are the Chrome extension `icons` sizes; 1024 is the master from
 * which any larger listing asset is produced. Every one is a power-of-two
 * fraction or multiple of the 64-unit viewBox, so each export is a clean
 * uniform scale of the same vectors — never a resample of a bigger bitmap.
 */
const SIZES = [16, 32, 48, 128, 1024];

const svg = readFileSync(SVG_SOURCE, "utf-8");
mkdirSync(PNG_DIR, { recursive: true });

const browser = await chromium.launch();
try {
  for (const size of SIZES) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><html><head><style>
         html,body{margin:0;padding:0;background:transparent;}
         svg{display:block;width:${size}px;height:${size}px;}
       </style></head><body>${svg}</body></html>`,
    );
    const buffer = await page.screenshot({ omitBackground: true });
    const target = path.join(PNG_DIR, `paperlume-${size}.png`);
    writeFileSync(target, buffer);
    await page.close();
    process.stdout.write(`  ✓ assets/brand/png/paperlume-${size}.png (${size}×${size}, ${buffer.length} bytes)\n`);
  }
} finally {
  await browser.close();
}

process.stdout.write("\n  Regenerate with `npm run brand:png` after editing paperlume-symbol.svg.\n\n");
