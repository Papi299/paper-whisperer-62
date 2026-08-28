/**
 * The Chrome Web Store package contract.
 *
 * These are the properties the *shipped artefact* must have — not the source it
 * was built from. `extension/src/__tests__/manifest.test.ts` already asserts the
 * committed `extension/manifest.json`; this module asserts what actually reaches
 * a reviewer, which is a different question with a different failure mode. A
 * build step, a stray file in `dist-extension/`, or an archive assembled from
 * the wrong directory can all satisfy every source-level assertion and still
 * produce a package that widens the extension's surface.
 *
 * ## Plain `.mjs`, and why
 *
 * `scripts/` is Node tooling and is already `.mjs` (`e2e-local.mjs` and
 * friends). Keeping this module in the same dialect lets `package-extension.mjs`
 * import it directly, with no loader, no build step, and no new dependency —
 * while Vitest still collects `__tests__/extension-package.test.mjs`, so every
 * check below is exercised against hostile fixtures rather than only against the
 * one artefact that happens to be correct today.
 *
 * ## The scanners deliberately do not strip anything
 *
 * `extension/src/__tests__/support/remoteReferences.ts` documents a defect where
 * a *source* scan stripped string literals before looking for remote references,
 * which removed the very text it was searching for. The checks here avoid that
 * class of mistake by construction: they scan raw packaged bytes and strip
 * nothing at all — not comments, not string literals.
 *
 * That is right for a *package* scan specifically, and it is the opposite of the
 * right answer for a source scan. A comment in a source file explains why a URL
 * is absent; a comment in a packaged file *is shipped*, so a remote origin
 * written there is a remote origin in the artefact a reviewer downloads. There
 * is no text in a package that is exempt from being part of the package.
 *
 * Every function here is pure over an in-memory file map, so nothing below
 * depends on a build having run.
 */

/** The complete permission set the extension may ship with. */
export const EXPECTED_PERMISSIONS = ["activeTab"];

/** The name Chrome must show, matching the committed manifest. */
export const EXPECTED_NAME = "PaperLume";

/**
 * The only external origin any packaged file may name.
 *
 * The extension navigates a tab here and does nothing else with it; see
 * `extension/src/paperLumeHandoff.ts`. An origin outside this list in a shipped
 * file is either a remote resource or a second destination, and both are
 * contract changes.
 */
export const ALLOWED_EXTERNAL_ORIGINS = ["https://app.paperlume.app"];

/** The complete privileged Chrome API surface, matching `extension/src/chrome.d.ts`. */
export const ALLOWED_CHROME_MEMBERS = ["chrome.tabs.create", "chrome.tabs.query"];

/**
 * Manifest keys that would grant power this extension does not have.
 *
 * `key` is included: it pins an extension ID, and the real-browser harness
 * injects one into a throwaway copy to obtain a deterministic ID. A `key` in a
 * release package would mean that harness wrote into the artefact that ships.
 */
export const FORBIDDEN_MANIFEST_KEYS = [
  "host_permissions",
  "optional_permissions",
  "optional_host_permissions",
  "background",
  "content_scripts",
  "web_accessible_resources",
  "externally_connectable",
  "chrome_url_overrides",
  "devtools_page",
  "omnibox",
  "commands",
  "side_panel",
  "key",
];

/** Path patterns that must never appear in a Store package. */
const EXCLUDED_PATH_PATTERNS = [
  { pattern: /\.tsx?$/i, reason: "TypeScript source" },
  { pattern: /\.map$/i, reason: "source map" },
  { pattern: /(^|\/)__tests__(\/|$)/i, reason: "test directory" },
  { pattern: /\.(test|spec)\.[cm]?[jt]sx?$/i, reason: "test file" },
  { pattern: /(^|\/)\.git/i, reason: "git metadata" },
  { pattern: /(^|\/)node_modules(\/|$)/i, reason: "dependency tree" },
  { pattern: /(^|\/)package(-lock)?\.json$/i, reason: "package manager metadata" },
  { pattern: /(^|\/)tsconfig[^/]*\.json$/i, reason: "compiler configuration" },
  { pattern: /(^|\/)\.env/i, reason: "environment file" },
  { pattern: /\.md$/i, reason: "documentation" },
  { pattern: /(^|\/)(test-results|playwright-report)(\/|$)/i, reason: "Playwright artefact" },
  { pattern: /(^|\/)(User Data|user-data-dir)(\/|$)/i, reason: "browser profile directory" },
  { pattern: /\.(pem|key|p12|crx)$/i, reason: "signing or secret material" },
  { pattern: /(^|\/)\.DS_Store$/i, reason: "editor or OS metadata" },
];

/** Extensions whose bytes are inspected as text. */
const TEXT_FILE_PATTERN = /\.(js|mjs|cjs|html?|css|json|txt|svg)$/i;

/** Extensions treated as markup for the remote-reference check. */
const HTML_FILE_PATTERN = /\.html?$/i;
const CSS_FILE_PATTERN = /\.css$/i;

/** A package this small has no business being large; both bounds are generous. */
export const MAX_PACKAGE_ENTRIES = 24;
export const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: false });

/** Chrome accepts one to four dot-separated integers, each 0–65535. */
function isValidChromeVersion(value) {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every((part) => /^\d+$/.test(part) && Number(part) <= 65535);
}

/** Absolute `http(s)` URLs, scanned from raw text; see the module comment. */
const ABSOLUTE_URL_PATTERN = /https?:\/\/[^\s"'`)<>\\]+/gi;

/** `chrome.a` / `chrome.a.b` member expressions. */
const CHROME_MEMBER_PATTERN = /\bchrome\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?/g;

/** Remote `src` / `href`, quoted either way or unquoted. */
const REMOTE_ATTRIBUTE_PATTERN =
  /\b(?:src|href)\s*=\s*(?:"https?:\/\/[^"]*"|'https?:\/\/[^']*'|https?:\/\/[^\s>]+)/gi;

/** Remote `url(...)` and `@import`. */
const REMOTE_CSS_URL_PATTERN = /url\(\s*['"]?https?:\/\//gi;
const REMOTE_CSS_IMPORT_PATTERN = /@import\s+(?:url\(\s*)?['"]?https?:\/\//gi;

/**
 * Reduce a matched URL to its origin, or `null` when it does not parse.
 *
 * Trailing punctuation that a scan can pick up from surrounding syntax is
 * trimmed before parsing, so `…app.paperlume.app/x",` does not fail to parse and
 * silently pass.
 */
function originOf(match) {
  const trimmed = match.replace(/[.,;:!?'")\]}]+$/, "");
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

/**
 * Every violation of the package contract, as human-readable strings.
 *
 * @param {Map<string, Uint8Array>} files Archive-root-relative paths (`/`
 *   separated, no leading slash) to their bytes.
 * @returns {string[]} Empty when the package is valid.
 */
export function findPackageViolations(files) {
  const violations = [];
  const paths = [...files.keys()];

  // ---- Archive shape -------------------------------------------------------

  for (const p of paths) {
    if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
      violations.push(`entry has an absolute path: ${p}`);
    }
    if (p.split("/").includes("..")) {
      violations.push(`entry escapes the archive root: ${p}`);
    }
  }

  if (!files.has("manifest.json")) {
    violations.push(
      "manifest.json is not at the archive root — Chrome reads the manifest from the root, " +
        `so an archive that wraps the build directory is rejected (entries: ${paths.join(", ") || "none"})`,
    );
  }

  for (const p of paths) {
    if (p !== "manifest.json" && p.endsWith("/manifest.json")) {
      violations.push(`a second manifest is nested at ${p}`);
    }
  }

  if (paths.length > MAX_PACKAGE_ENTRIES) {
    violations.push(`package has ${paths.length} entries, over the ${MAX_PACKAGE_ENTRIES} bound`);
  }

  let totalBytes = 0;
  for (const [p, bytes] of files) {
    totalBytes += bytes.byteLength;
    if (bytes.byteLength === 0) violations.push(`packaged file is empty: ${p}`);
  }
  if (totalBytes > MAX_PACKAGE_BYTES) {
    violations.push(`package is ${totalBytes} bytes, over the ${MAX_PACKAGE_BYTES} bound`);
  }

  // ---- Excluded content ----------------------------------------------------

  for (const p of paths) {
    for (const { pattern, reason } of EXCLUDED_PATH_PATTERNS) {
      if (pattern.test(p)) violations.push(`package contains ${reason}: ${p}`);
    }
  }

  // ---- Manifest ------------------------------------------------------------

  const manifestBytes = files.get("manifest.json");
  let manifest = null;
  if (manifestBytes) {
    try {
      manifest = JSON.parse(decoder.decode(manifestBytes));
    } catch (error) {
      violations.push(`manifest.json is not valid JSON: ${error.message}`);
    }
    if (manifest !== null && (typeof manifest !== "object" || Array.isArray(manifest))) {
      violations.push("manifest.json is not a JSON object");
      manifest = null;
    }
  }

  if (manifest) {
    if (manifest.manifest_version !== 3) {
      violations.push(`manifest_version is ${JSON.stringify(manifest.manifest_version)}, expected 3`);
    }
    if (manifest.name !== EXPECTED_NAME) {
      violations.push(`name is ${JSON.stringify(manifest.name)}, expected ${JSON.stringify(EXPECTED_NAME)}`);
    }
    if (!isValidChromeVersion(manifest.version)) {
      violations.push(`version ${JSON.stringify(manifest.version)} is not valid Chrome manifest version syntax`);
    }
    if (typeof manifest.description !== "string" || manifest.description.length === 0) {
      violations.push("description is missing or empty");
    }

    const permissions = manifest.permissions;
    const permissionsMatch =
      Array.isArray(permissions) &&
      permissions.length === EXPECTED_PERMISSIONS.length &&
      EXPECTED_PERMISSIONS.every((expected, index) => permissions[index] === expected);
    if (!permissionsMatch) {
      violations.push(
        `permissions are ${JSON.stringify(permissions)}, expected exactly ${JSON.stringify(EXPECTED_PERMISSIONS)}`,
      );
    }

    for (const key of FORBIDDEN_MANIFEST_KEYS) {
      if (Object.prototype.hasOwnProperty.call(manifest, key)) {
        violations.push(`manifest declares forbidden key: ${key}`);
      }
    }

    // Every file the manifest names must actually be in the package. A manifest
    // that points at a missing icon or popup loads with a warning or a blank
    // surface, and neither is visible from the JSON alone.
    for (const referenced of manifestReferencedPaths(manifest)) {
      if (!files.has(referenced)) {
        violations.push(`manifest references a file the package does not contain: ${referenced}`);
      }
    }
  }

  // ---- Packaged file contents ---------------------------------------------

  for (const [p, bytes] of files) {
    if (!TEXT_FILE_PATTERN.test(p)) continue;
    const text = decoder.decode(bytes);

    for (const match of text.match(ABSOLUTE_URL_PATTERN) ?? []) {
      const origin = originOf(match);
      if (origin === null) {
        violations.push(`${p} contains an unparseable absolute URL: ${match}`);
      } else if (!ALLOWED_EXTERNAL_ORIGINS.includes(origin)) {
        violations.push(`${p} names a disallowed external origin: ${origin} (in ${match})`);
      }
    }

    if (/sourceMappingURL/i.test(text)) {
      violations.push(`${p} carries a sourceMappingURL annotation`);
    }

    if (HTML_FILE_PATTERN.test(p)) {
      for (const match of text.match(REMOTE_ATTRIBUTE_PATTERN) ?? []) {
        violations.push(`${p} loads a remote resource: ${match}`);
      }
    }

    if (CSS_FILE_PATTERN.test(p)) {
      for (const match of text.match(REMOTE_CSS_URL_PATTERN) ?? []) {
        violations.push(`${p} loads a remote resource: ${match}`);
      }
      for (const match of text.match(REMOTE_CSS_IMPORT_PATTERN) ?? []) {
        violations.push(`${p} imports a remote stylesheet: ${match}`);
      }
    }

    if (/\.(js|mjs|cjs)$/i.test(p)) {
      for (const match of text.match(CHROME_MEMBER_PATTERN) ?? []) {
        // `chrome.tabs` on its own is the namespace both allowed calls are
        // reached through, so it is not itself a widening.
        if (match === "chrome.tabs") continue;
        if (!ALLOWED_CHROME_MEMBERS.includes(match)) {
          violations.push(`${p} references a Chrome API outside the declared surface: ${match}`);
        }
      }
    }
  }

  return violations;
}

/**
 * The package-relative paths a manifest names.
 *
 * Only the keys this extension's manifest can legitimately contain are read.
 * Keys it must not contain at all are rejected above, so there is nothing to
 * resolve for them.
 */
export function manifestReferencedPaths(manifest) {
  const referenced = new Set();

  const add = (value) => {
    if (typeof value === "string" && value.length > 0) {
      referenced.add(value.replace(/^\.?\//, ""));
    }
  };

  add(manifest?.action?.default_popup);

  for (const source of [manifest?.icons, manifest?.action?.default_icon]) {
    if (source && typeof source === "object") {
      for (const value of Object.values(source)) add(value);
    }
  }

  return [...referenced];
}
