import { readFileSync } from "fs";
import path from "path";
import { defineConfig, type Plugin } from "vite";

/**
 * Build configuration for the PaperLume Chrome extension.
 *
 * Separate from `vite.config.ts` on purpose: the two produce different
 * artefacts, for different runtimes, deployed by different means. The web app
 * builds to `dist/` and is deployed by Vercel; the extension builds to
 * `dist-extension/` and is loaded unpacked (and, from a later phase, packaged
 * for the Chrome Web Store). Neither config reads the other, and `npm run build`
 * is unchanged — so the Vercel artefact is exactly what it was before the
 * extension existed.
 */

const EXTENSION_ROOT = path.resolve(__dirname, "extension");
const MANIFEST_PATH = path.resolve(EXTENSION_ROOT, "manifest.json");
const BRAND_PNG_DIR = path.resolve(__dirname, "assets", "brand", "png");

/**
 * The Chrome `icons` sizes, and where each one comes from.
 *
 * Key is the packaged path the manifest names; value is the canonical brand
 * export it is copied from, byte for byte.
 */
const ICON_SOURCES: ReadonlyMap<string, string> = new Map(
  [16, 32, 48, 128].map((size) => [`icons/icon-${size}.png`, path.join(BRAND_PNG_DIR, `paperlume-${size}.png`)]),
);

/**
 * Copy `extension/manifest.json` into the build output verbatim.
 *
 * The manifest is a committed, hand-written file rather than something this
 * config generates, because it is the extension's permission contract: it has to
 * be reviewable in a diff and assertable by a test, and neither is true of a
 * value assembled at build time. This plugin therefore only moves bytes — it
 * never edits, merges or templates the manifest — so what a test asserts about
 * the source file is also true of what ships.
 *
 * The parse is a validity gate only; its result is discarded. A malformed
 * manifest fails the build here rather than at `chrome://extensions`.
 */
function copyExtensionManifest(): Plugin {
  return {
    name: "paperlume-extension-manifest",
    generateBundle() {
      const source = readFileSync(MANIFEST_PATH, "utf-8");
      JSON.parse(source);
      this.emitFile({ type: "asset", fileName: "manifest.json", source });
    },
  };
}

/**
 * Copy the production icon set into the build output from the brand pack.
 *
 * The icons are **not** committed under `extension/`. `assets/brand/png/` is the
 * canonical source of the PaperLume mark — generated from
 * `assets/brand/svg/paperlume-symbol.svg` by `npm run brand:png`, and held to
 * the mark's geometry by `scripts/lib/__tests__/brand-assets.test.mjs` — and a
 * second committed copy of the same four PNGs beside the manifest would be a
 * binary that can silently stop being the logo. Chrome reads icons from the
 * *package*, and the package is a build output, so the copy is made here, at
 * the one moment it is actually needed.
 *
 * Bytes only: nothing is resized, recompressed, or recoloured. What ships is
 * the canonical export, so every assertion the brand suite makes about
 * `paperlume-128.png` is also true of `icons/icon-128.png`.
 *
 * A missing source fails the build rather than producing a package whose
 * manifest names an icon that is not there — which Chrome loads with a warning
 * and a blank toolbar button, and which no amount of reading the manifest
 * reveals.
 */
function copyExtensionIcons(): Plugin {
  return {
    name: "paperlume-extension-icons",
    generateBundle() {
      for (const [fileName, source] of ICON_SOURCES) {
        this.emitFile({ type: "asset", fileName, source: readFileSync(source) });
      }
    },
  };
}

export default defineConfig({
  root: EXTENSION_ROOT,
  // No `public/` directory: every file that reaches the output is either an
  // entry point or something a plugin emitted deliberately.
  publicDir: false,
  resolve: {
    // The extension shares the application's bundling domain, so it imports the
    // application's pure identifier modules directly instead of copying them.
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: {
    outDir: path.resolve(__dirname, "dist-extension"),
    emptyOutDir: true,
    // Chrome 116 is the floor the phase's platform research assumes.
    target: "chrome116",
    // Deterministic, reviewable output: no content hashes, so `dist-extension/`
    // is diffable between builds and the manifest can name files literally.
    // Nothing here is cache-busted by a CDN, so hashes buy nothing.
    modulePreload: false,
    sourcemap: false,
    rollupOptions: {
      input: { popup: path.resolve(EXTENSION_ROOT, "popup.html") },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
      },
    },
  },
  plugins: [copyExtensionManifest(), copyExtensionIcons()],
});
