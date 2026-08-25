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
  plugins: [copyExtensionManifest()],
});
