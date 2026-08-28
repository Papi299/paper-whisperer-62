#!/usr/bin/env node
/**
 * Build a Chrome-Web-Store-ready extension package, and refuse to produce one
 * that violates the contract.
 *
 *   clean → build → validate dist-extension/ → write ZIP → validate the ZIP
 *
 * Nothing here uploads, publishes, tags or releases. It produces one local file
 * and tells you what is in it.
 *
 * ## Why the ZIP is re-read rather than trusted
 *
 * The unpacked directory and the archive are validated separately, and the
 * archive is validated by *unzipping what was just written* rather than by
 * inspecting the map that went in. The interesting failures of a packaging step
 * are exactly the ones that happen during packaging — a path prefixed with the
 * build directory, an entry silently dropped, a byte range mangled — and a check
 * that runs on the input cannot see any of them. `manifest.json` at the archive
 * root is the specific property Chrome rejects an upload for, and it is only
 * observable after the fact.
 *
 * ## No new dependency
 *
 * `fflate` is already a runtime dependency of the application (the account data
 * export uses it), and it both writes and reads ZIPs. The repository keeps a
 * single root dependency graph deliberately — see `docs/dependency-security.md`
 * — so reusing it beats adding an archiver, and beats shelling out to a `zip`
 * binary that is not guaranteed to exist on a CI runner or a developer's
 * machine.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { unzipSync, zipSync } from "fflate";

import { findPackageViolations } from "./lib/extension-package.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD_DIR = path.join(REPO_ROOT, "dist-extension");
const RELEASE_DIR = path.join(REPO_ROOT, "release");

/** Files an operating system or editor drops into a directory uninvited. */
const IGNORED_ENTRIES = new Set([".DS_Store", "Thumbs.db", ".gitkeep"]);

function fail(message) {
  process.stderr.write(`\nextension package: ${message}\n\n`);
  process.exit(1);
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** Read a directory tree into an archive-root-relative path → bytes map. */
function readTree(root, prefix = "") {
  const files = new Map();
  for (const entry of readdirSync(root).sort()) {
    const absolute = path.join(root, entry);
    const relative = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(absolute).isDirectory()) {
      for (const [nested, bytes] of readTree(absolute, relative)) files.set(nested, bytes);
    } else if (!IGNORED_ENTRIES.has(entry)) {
      files.set(relative, new Uint8Array(readFileSync(absolute)));
    }
  }
  return files;
}

function reportViolations(label, violations) {
  if (violations.length === 0) {
    log(`  ✓ ${label}: contract satisfied`);
    return;
  }
  process.stderr.write(`\n  ✗ ${label}: ${violations.length} violation(s)\n`);
  for (const violation of violations) process.stderr.write(`      - ${violation}\n`);
  fail(`${label} does not satisfy the Chrome Web Store package contract.`);
}

// ---- 1. Clean ---------------------------------------------------------------

log("\nPaperLume extension — release candidate package\n");

rmSync(BUILD_DIR, { recursive: true, force: true });
rmSync(RELEASE_DIR, { recursive: true, force: true });
log("  ✓ cleaned dist-extension/ and release/");

// ---- 2. Build ---------------------------------------------------------------

const build = spawnSync("npm", ["run", "build:extension"], {
  cwd: REPO_ROOT,
  stdio: ["ignore", "pipe", "inherit"],
  encoding: "utf-8",
});
if (build.status !== 0) fail("`npm run build:extension` failed.");
if (!existsSync(BUILD_DIR)) fail("the build produced no dist-extension/ directory.");
log("  ✓ built dist-extension/");

// ---- 3. Validate the unpacked artefact --------------------------------------

const unpacked = readTree(BUILD_DIR);
if (unpacked.size === 0) fail("dist-extension/ is empty.");
reportViolations("dist-extension/", findPackageViolations(unpacked));

// The manifest is only read now, after validation has confirmed it parses and
// carries a valid version.
const manifest = JSON.parse(new TextDecoder().decode(unpacked.get("manifest.json")));

// ---- 4. Write the ZIP -------------------------------------------------------

// Predictable, and marked as a release *candidate*: this file is a local build
// artefact for review, not a published release. The extension version is read
// from the manifest and never written to it — packaging locally must not bump a
// version, because the version is what installed copies update against.
const zipName = `paperlume-extension-${manifest.version}-rc.zip`;
const zipPath = path.join(RELEASE_DIR, zipName);

mkdirSync(RELEASE_DIR, { recursive: true });
writeFileSync(
  zipPath,
  zipSync(Object.fromEntries(unpacked), {
    // Fixed timestamp: two builds of the same input produce byte-identical
    // archives, so "did the package change?" is answerable by comparing hashes.
    // fflate writes MS-DOS times, whose epoch is 1980.
    mtime: new Date("1980-01-01T00:00:00Z"),
    level: 9,
  }),
);
log(`  ✓ wrote release/${zipName}`);

// ---- 5. Validate the ZIP as Chrome will read it -----------------------------

const repacked = new Map(Object.entries(unzipSync(new Uint8Array(readFileSync(zipPath)))));
reportViolations(`release/${zipName}`, findPackageViolations(repacked));

// The archive must contain exactly what the directory did — no more, no fewer,
// and byte for byte. A packaging step that drops or rewrites a file would
// otherwise be invisible to both validations above.
const unpackedNames = [...unpacked.keys()].sort();
const repackedNames = [...repacked.keys()].sort();
if (unpackedNames.join("\n") !== repackedNames.join("\n")) {
  fail(
    `archive contents differ from dist-extension/.\n  directory: ${unpackedNames.join(", ")}\n  archive:   ${repackedNames.join(", ")}`,
  );
}
for (const [name, bytes] of unpacked) {
  const archived = repacked.get(name);
  if (archived.length !== bytes.length || !archived.every((byte, index) => byte === bytes[index])) {
    fail(`archive entry ${name} does not match dist-extension/${name} byte for byte.`);
  }
}
log("  ✓ archive matches dist-extension/ byte for byte");

// ---- 6. Report --------------------------------------------------------------

const zipBytes = statSync(zipPath).size;
log("\n  Package contents (archive root):");
for (const name of repackedNames) log(`      ${name}  (${repacked.get(name).length} bytes)`);
log(
  [
    "",
    `  name        ${manifest.name}`,
    `  version     ${manifest.version}`,
    `  permissions ${JSON.stringify(manifest.permissions)}`,
    `  entries     ${repackedNames.length}`,
    `  archive     release/${zipName} (${zipBytes} bytes)`,
    "",
    "  Not uploaded, not published, not tagged. `release/` is gitignored.",
    "  Before submitting, complete the manual gate in",
    "  docs/chrome-web-store-readiness.md § Manual release acceptance checklist.",
    "",
  ].join("\n"),
);
