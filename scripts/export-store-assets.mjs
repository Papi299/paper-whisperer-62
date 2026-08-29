#!/usr/bin/env node
/**
 * Generate the Chrome Web Store listing images.
 *
 *   build check → capture the real popup → compose → validate → write
 *
 * Nothing here uploads, publishes or submits anything. It writes five PNGs into
 * `assets/store/` and prints what it put in them.
 *
 * ## The screenshots contain real pixels from the real extension
 *
 * This is the whole reason the script is more than a rasteriser. A Chrome Web
 * Store screenshot is a factual claim about what the extension does, and the
 * cheap way to produce one — draw the popup you *meant* to ship in HTML and
 * screenshot that — produces a picture that is a drawing of an intention. So
 * the popup in these images is captured from `dist-extension/` loaded as a real
 * unpacked MV3 extension in a real Chromium, served from its own
 * `chrome-extension://` origin, with the real built classifier deciding what to
 * display. The composition around it is marketing layout: a caption panel and a
 * brand background, with no invented browser chrome and no invented UI.
 *
 * The one thing that is injected is the *active tab's URL*, because Chrome
 * populates `Tab.url` only after a real toolbar click and nothing can simulate
 * that grant. That is the same, single, documented test double the real-browser
 * lane uses (`e2e-extension/support/extensionHarness.ts`), and the string it
 * injects is fed to the genuine classifier — so what the popup displays is
 * still the extension's own answer, not a caption written here.
 *
 * ## Why the extension ID is derived rather than discovered
 *
 * The extension has no service worker, deliberately, so Playwright's documented
 * "read the ID off the service worker URL" trick does not apply. Chrome derives
 * an unpacked extension's ID from its `key` manifest field, so a throwaway RSA
 * key is generated, written into a *staged copy* outside the repository, and
 * the resulting ID computed. The derivation is then checked against
 * `chrome.runtime.id` from inside the browser: a wrong derivation aborts rather
 * than quietly screenshotting a 404 page.
 *
 * The staged copy is the only artefact that ever carries `key`. It lives in a
 * `mkdtemp` directory, is deleted afterwards, and `key` is on the release
 * package's forbidden-key list — so nothing here can put one into a shipped
 * package.
 *
 * ## Determinism, stated honestly
 *
 * Every geometric element is vector: the mark, the wordmark, the gradients, the
 * layout. Those render identically anywhere Chromium runs. The *type* in the
 * caption panels, and the type inside the captured popup, use the host's UI
 * font stack — the same `system-ui` stack the popup itself ships with — so the
 * files are reproducible on a given platform and are not byte-identical across
 * platforms. That is a property of screenshotting real UI, not a defect of this
 * script; a screenshot rendered in a font no user has would be less truthful,
 * not more.
 *
 * ## No new dependency
 *
 * Playwright's Chromium is already a devDependency and is already how
 * `scripts/export-brand-png.mjs` rasterises the brand pack. It is also the
 * renderer Chrome uses, so what this writes is what a reviewer's browser draws.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { readPngHeader } from "./lib/png.mjs";
import { CAPTURE_URLS, MARK_BOUNDS, STORE_ASSETS, STORE_ASSET_DIR, STORE_ICON } from "./lib/store-assets.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD_DIR = path.join(REPO_ROOT, "dist-extension");
const SVG_DIR = path.join(REPO_ROOT, "assets", "brand", "svg");
const OUT_DIR = path.join(REPO_ROOT, STORE_ASSET_DIR);

/** The UI font stack, matching `extension/src/popup.css`. See the module comment. */
const UI_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function fail(message) {
  process.stderr.write(`\nstore assets: ${message}\n\n`);
  process.exit(1);
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

// ---- Brand sources ----------------------------------------------------------

const symbolSvg = readFileSync(path.join(SVG_DIR, "paperlume-symbol.svg"), "utf-8");
const lockupSvg = readFileSync(path.join(SVG_DIR, "paperlume-logo-horizontal.svg"), "utf-8");

/**
 * The lockup as the brand spec prescribes it for dark grounds.
 *
 * *"On dark backgrounds `Paper` becomes `#FFFFFF` and `Lume` stays `#7B5CFF`"*
 * — `assets/brand/brand-spec.md` §5a, and the same instruction is written in a
 * comment inside the lockup file itself. This is that rule applied literally: a
 * single fill value, on the identical outlined path geometry. No path data is
 * touched, so the dark lockup is the same wordmark, not a second one.
 *
 * The occurrence count is asserted because the substitution is only safe while
 * exactly one element carries that fill. If the file ever gains a second navy
 * fill, recolouring both would silently repaint something that is not the
 * wordmark.
 */
function darkLockup() {
  const occurrences = lockupSvg.match(/fill="#0B1220"/g) ?? [];
  if (occurrences.length !== 1) {
    fail(
      `expected exactly one #0B1220 fill in paperlume-logo-horizontal.svg (the "Paper" wordmark), found ` +
        `${occurrences.length}. The dark-ground recolour is only safe while that is the wordmark and nothing else.`,
    );
  }
  return lockupSvg.replace('fill="#0B1220"', 'fill="#FFFFFF"');
}

// ---- The real popup captures ------------------------------------------------

/** Chrome's unpacked-extension ID derivation; `a-p` because an ID is a DNS label. */
function deriveExtensionId(publicKeyDer) {
  return [...createHash("sha256").update(publicKeyDer).digest().subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .split("")
    .map((nibble) => String.fromCharCode(parseInt(nibble, 16) + 0x61))
    .join("");
}

/**
 * Screenshot `.popup` for each named tab URL, from the real built extension.
 *
 * @param {Record<string, string>} urls state name → the URL to classify
 * @returns {Promise<Record<string, Buffer>>} state name → PNG bytes at 2× scale
 */
async function capturePopups(urls) {
  if (!existsSync(path.join(BUILD_DIR, "manifest.json"))) {
    fail(
      "dist-extension/manifest.json is missing. These screenshots are taken from the BUILT extension, " +
        "never from the TypeScript source. Run `npm run build:extension` (or `npm run package:extension`) first.",
    );
  }

  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const extensionId = deriveExtensionId(publicKeyDer);

  const stagingDir = mkdtempSync(path.join(tmpdir(), "paperlume-store-ext-"));
  const profileDir = mkdtempSync(path.join(tmpdir(), "paperlume-store-profile-"));

  cpSync(BUILD_DIR, stagingDir, { recursive: true });
  const stagedManifestPath = path.join(stagingDir, "manifest.json");
  const stagedManifest = JSON.parse(readFileSync(stagedManifestPath, "utf-8"));
  stagedManifest.key = publicKeyDer.toString("base64");
  writeFileSync(stagedManifestPath, JSON.stringify(stagedManifest, null, 2));

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    // 2× so the popup can be shown at twice its natural size in a 1280×800
    // frame without resampling a 1× capture.
    deviceScaleFactor: 2,
    // Pinned, not inherited: the popup follows `prefers-color-scheme`, and a
    // listing image that changed theme with the machine that built it would not
    // be reproducible at all.
    colorScheme: "light",
    args: [
      `--disable-extensions-except=${stagingDir}`,
      `--load-extension=${stagingDir}`,
      // Black-hole every non-loopback name, exactly as the real-browser lane
      // does. Nothing here needs the network, and a screenshot script must not
      // be the one thing in the repository that can reach Production.
      "--host-resolver-rules=MAP * 127.0.0.1:1, EXCLUDE localhost",
    ],
  });

  const captures = {};
  try {
    for (const [name, activeTabUrl] of Object.entries(urls)) {
      const page = await context.newPage();
      await page.addInitScript((url) => {
        chrome.tabs.query = async () => [{ url }];
      }, activeTabUrl);
      await page.goto(`chrome-extension://${extensionId}/popup.html`);

      const assignedId = await page.evaluate(() => chrome.runtime.id);
      if (assignedId !== extensionId) {
        fail(
          `derived extension ID ${extensionId} but Chrome assigned ${assignedId} — every capture would be a 404 page.`,
        );
      }

      // Wait for the classifier to have replaced the initial "checking" state,
      // so nothing is captured mid-flight.
      await page.locator('.state[data-state="checking"]').waitFor({ state: "hidden" });
      captures[name] = await page.locator(".popup").screenshot();
      await page.close();
    }
  } finally {
    await context.close();
    for (const dir of [stagingDir, profileDir]) rmSync(dir, { recursive: true, force: true });
  }

  return captures;
}

// ---- Composition ------------------------------------------------------------

const dataUri = (png) => `data:image/png;base64,${png.toString("base64")}`;

/**
 * Render one HTML document to a PNG of an exact size.
 *
 * `omitBackground` is passed through so the Store icon keeps its alpha channel
 * while the full-bleed images stay opaque.
 */
async function render(browser, { html, width, height, omitBackground = false }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html);
  const png = await page.screenshot({ omitBackground });
  await page.close();
  return png;
}

/**
 * The Store icon: the canonical symbol, fitted to the documented content box.
 *
 * The mark is scaled so its taller axis is exactly `contentBox` px, then
 * centred. Because the mark is centred within its own 64-unit viewBox, centring
 * the *viewBox* centres the mark — so the whole transform is one uniform scale
 * and one offset, and the geometry is untouched.
 */
function storeIconHtml() {
  const { canvas, contentBox } = STORE_ICON;
  // The rendered SVG box that puts the mark's height at exactly `contentBox`.
  const svgSize = (contentBox * MARK_BOUNDS.grid) / MARK_BOUNDS.height;
  const offset = (canvas - svgSize) / 2;
  return `<!doctype html><html><head><style>
      html,body{margin:0;padding:0;background:transparent;}
      .canvas{position:relative;width:${canvas}px;height:${canvas}px;}
      .mark{position:absolute;left:${offset}px;top:${offset}px;width:${svgSize}px;height:${svgSize}px;}
      .mark svg{display:block;width:100%;height:100%;}
    </style></head><body><div class="canvas"><div class="mark">${symbolSvg}</div></div></body></html>`;
}

/**
 * The 440×280 small promo tile.
 *
 * Held to Chrome's own guidance for this asset: *"Avoid text… Assume the image
 * will be on a light gray background. Use saturated colors if possible… Avoid
 * using a lot of white and light gray. Fill the entire region. Make sure the
 * edges are well defined."* Hence the saturated navy→indigo ground that reaches
 * every edge, and a single short line rather than a feature list.
 *
 * That line is a factual description of the extension's behaviour and not a
 * claim about capability: it names the two page kinds that are supported and
 * the destination, which is exactly what the extension does.
 */
function promoTileHtml() {
  return `<!doctype html><html><head><style>
      html,body{margin:0;padding:0;}
      .tile{
        width:440px;height:280px;box-sizing:border-box;
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;
        background:
          radial-gradient(120% 90% at 78% 8%, rgba(123,92,255,0.38) 0%, rgba(123,92,255,0) 62%),
          linear-gradient(146deg, #0B1220 0%, #1B1E63 58%, #2A2A8F 100%);
        font-family:${UI_FONT};
      }
      .lockup{width:296px;}
      .lockup svg{display:block;width:100%;height:auto;}
      .line{
        margin:0;font-size:19px;font-weight:500;letter-spacing:0.005em;color:#B7C6FF;
        text-align:center;
      }
    </style></head><body>
      <div class="tile">
        <div class="lockup">${darkLockup()}</div>
        <p class="line">From a PubMed or DOI page to PaperLume</p>
      </div>
    </body></html>`;
}

/**
 * The caption panel each screenshot pairs with a real popup capture.
 *
 * Every line here describes behaviour the shipped extension has, and the
 * `docs/chrome-web-store-listing.md` copy says the same things in the same
 * terms. Nothing implies automatic import, page scraping, background
 * monitoring, or in-popup library management, because the extension does none
 * of those.
 */
const SCREENSHOT_PANELS = {
  pubmed: {
    eyebrow: "PubMed record",
    headline: "Reads the PMID from the page you are on",
    body:
      "Click PaperLume in the Chrome toolbar. The extension reads that tab’s address — nothing else — " +
      "and shows you the PMID it recognised.",
    note: "No page content is read. Nothing is sent anywhere until you choose Continue.",
  },
  doi: {
    eyebrow: "DOI link",
    headline: "Recognises a doi.org address too",
    body:
      "The same single click shows the DOI. Continue in PaperLume opens PaperLume in a new tab, " +
      "carrying only that identifier.",
    note: "PaperLume asks you to sign in and to confirm the import. The extension imports nothing itself.",
  },
  unsupported: {
    eyebrow: "Anywhere else",
    headline: "Says so when there is no paper to send",
    body:
      "On a page whose address names no identifier PaperLume supports, it tells you plainly — " +
      "and offers no Continue button at all.",
    note: "No guessing from page titles, no page scraping, and nothing sent.",
  },
};

function screenshotHtml(state, popupPng) {
  const panel = SCREENSHOT_PANELS[state];
  return `<!doctype html><html><head><style>
      html,body{margin:0;padding:0;}
      /*
       * Fixed columns that add up to the frame exactly: 72 + 536 + 56 + 544 + 72
       * = 1280. A flexible layout here would let one long headline push the
       * popup off the edge of a listing image, which is not something a later
       * glance at a 1280×800 PNG reliably catches.
       */
      .frame{
        width:1280px;height:800px;box-sizing:border-box;
        display:grid;grid-template-columns:536px 544px;column-gap:56px;align-items:center;
        padding:72px;
        background:
          radial-gradient(78% 62% at 88% 14%, rgba(123,92,255,0.16) 0%, rgba(123,92,255,0) 60%),
          radial-gradient(64% 58% at 4% 92%, rgba(79,102,255,0.12) 0%, rgba(79,102,255,0) 62%),
          linear-gradient(158deg, #FFFFFF 0%, #F2F4FB 100%);
        font-family:${UI_FONT};color:#0B1220;
      }
      .panel{display:flex;flex-direction:column;}
      .lockup{width:200px;margin-bottom:44px;}
      .lockup svg{display:block;width:100%;height:auto;}
      .eyebrow{
        margin:0 0 14px;font-size:13px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:#4F66FF;
      }
      .headline{margin:0 0 20px;font-size:39px;line-height:1.16;font-weight:650;letter-spacing:-0.018em;}
      .body{margin:0 0 24px;font-size:19px;line-height:1.55;color:#1A1F2B;}
      .note{
        margin:0;padding-left:15px;border-left:3px solid #B7C6FF;
        font-size:15px;line-height:1.5;color:#3A4356;
      }
      .shot{display:flex;flex-direction:column;align-items:center;gap:15px;}
      .shot__label{
        margin:0;font-size:12px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:#5C6B7F;
      }
      .shot__card{
        width:544px;border-radius:14px;overflow:hidden;background:#FFFFFF;
        border:1px solid rgba(11,18,32,0.10);
        box-shadow:0 24px 60px rgba(11,18,32,0.16), 0 3px 10px rgba(11,18,32,0.07);
      }
      .shot__card img{display:block;width:544px;height:auto;}
    </style></head><body>
      <div class="frame">
        <div class="panel">
          <div class="lockup">${lockupSvg}</div>
          <p class="eyebrow">${panel.eyebrow}</p>
          <h1 class="headline">${panel.headline}</h1>
          <p class="body">${panel.body}</p>
          <p class="note">${panel.note}</p>
        </div>
        <div class="shot">
          <p class="shot__label">Actual extension popup</p>
          <div class="shot__card"><img src="${dataUri(popupPng)}" alt=""></div>
        </div>
      </div>
    </body></html>`;
}

// ---- Validation -------------------------------------------------------------

/**
 * Decode a produced PNG in the browser and report what is actually in it.
 *
 * The header says how big the file claims to be; only decoding says whether the
 * corners are transparent, whether anything is clipped at the edge, and whether
 * the image is blank. A generator that silently produced a 1280×800 rectangle
 * of nothing would pass every header check ever written.
 */
async function inspect(browser, png) {
  const page = await browser.newPage();
  await page.setContent("<canvas id=c></canvas>");
  const result = await page.evaluate(async (src) => {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = src;
    });
    const canvas = document.getElementById("c");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    const alphaAt = (x, y) => data[(y * width + x) * 4 + 3];

    let opaquePixels = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    const colours = new Set();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        if (data[i + 3] > 8) {
          opaquePixels += 1;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        if (colours.size < 4096) colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      }
    }

    return {
      width,
      height,
      cornerAlphas: [alphaAt(0, 0), alphaAt(width - 1, 0), alphaAt(0, height - 1), alphaAt(width - 1, height - 1)],
      coverage: opaquePixels / (width * height),
      bounds: { minX, minY, maxX, maxY },
      distinctColours: colours.size,
    };
  }, dataUri(png));
  await page.close();
  return result;
}

// ---- Run --------------------------------------------------------------------

log("\nPaperLume — Chrome Web Store listing assets\n");

const popups = await capturePopups(CAPTURE_URLS);
for (const [state, png] of Object.entries(popups)) {
  const header = readPngHeader(png);
  log(`  ✓ captured the real popup for ${state} (${header.width}×${header.height} at 2×)`);
}

const browser = await chromium.launch();
const produced = new Map();
try {
  produced.set("store-icon-128.png", await render(browser, {
    html: storeIconHtml(),
    width: STORE_ICON.canvas,
    height: STORE_ICON.canvas,
    omitBackground: true,
  }));
  produced.set("promo-tile-small-440x280.png", await render(browser, { html: promoTileHtml(), width: 440, height: 280 }));
  for (const [index, state] of ["pubmed", "doi", "unsupported"].entries()) {
    produced.set(`screenshot-${index + 1}-${state}-1280x800.png`, await render(browser, {
      html: screenshotHtml(state, popups[state]),
      width: 1280,
      height: 800,
    }));
  }

  // ---- Validate before anything reaches the repository ----------------------

  const problems = [];
  for (const asset of STORE_ASSETS) {
    const png = produced.get(asset.file);
    if (!png) {
      problems.push(`${asset.file} was not produced`);
      continue;
    }
    const found = await inspect(browser, png);

    if (found.width !== asset.width || found.height !== asset.height) {
      problems.push(`${asset.file} is ${found.width}×${found.height}, expected ${asset.width}×${asset.height}`);
    }
    if (asset.transparent) {
      if (found.cornerAlphas.some((alpha) => alpha !== 0)) {
        problems.push(`${asset.file} must have transparent corners, found alphas ${found.cornerAlphas.join(", ")}`);
      }
      const padding = Math.min(
        found.bounds.minX,
        found.bounds.minY,
        found.width - 1 - found.bounds.maxX,
        found.height - 1 - found.bounds.maxY,
      );
      if (padding < STORE_ICON.minPadding) {
        problems.push(
          `${asset.file} leaves only ${padding}px of transparent padding, under the ${STORE_ICON.minPadding}px the Store asks for`,
        );
      }
    } else {
      if (found.cornerAlphas.some((alpha) => alpha !== 255)) {
        problems.push(`${asset.file} must be full bleed, but a corner is not opaque`);
      }
      if (found.coverage !== 1) {
        problems.push(`${asset.file} must be full bleed, but ${Math.round((1 - found.coverage) * 100)}% is transparent`);
      }
    }
    // A blank frame decodes perfectly and says nothing. Two colours is a
    // gradient with nothing on it; the real assets carry hundreds.
    if (found.distinctColours < 64) {
      problems.push(`${asset.file} contains only ${found.distinctColours} distinct colours — it is probably blank`);
    }

    log(
      `  ✓ ${asset.file.padEnd(34)} ${found.width}×${found.height}  ` +
        `${found.distinctColours >= 4096 ? "4096+" : found.distinctColours} colours  ${asset.role}`,
    );
  }

  const unexpected = [...produced.keys()].filter((file) => !STORE_ASSETS.some((asset) => asset.file === file));
  for (const file of unexpected) problems.push(`produced a file the contract does not declare: ${file}`);

  if (problems.length > 0) {
    process.stderr.write("\n  ✗ nothing written; the contract in scripts/lib/store-assets.mjs is not satisfied:\n");
    for (const problem of problems) process.stderr.write(`      - ${problem}\n`);
    fail("store asset generation failed validation.");
  }

  mkdirSync(OUT_DIR, { recursive: true });
  for (const [file, png] of produced) writeFileSync(path.join(OUT_DIR, file), png);
} finally {
  await browser.close();
}

log(
  [
    "",
    `  Wrote ${produced.size} files to ${STORE_ASSET_DIR}/.`,
    "",
    "  Not uploaded and not submitted. A human uploads these in the Chrome Web Store",
    "  Developer Dashboard; see docs/chrome-web-store-listing.md.",
    "",
  ].join("\n"),
);
