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

import { ALPHA_COLOR_TYPES, readPngHeader } from "./png.mjs";

/**
 * The complete permission set the extension may ship with, in manifest order.
 *
 * `activeTab` is granted only by a user gesture on the toolbar action and covers
 * only the tab they used it on. `scripting` is what
 * CHROME-EXTENSION-IMPORT-001E2-CORRECTION-01 added so that the DOI metadata
 * read can happen at all — Chrome's `activeTab` documentation is explicit that
 * `executeScript` on the granted tab requires *"the `scripting` permission"* to
 * be declared as well.
 *
 * The pair is checked as an exact ordered list rather than a membership test,
 * for the same reason it always was: widening it has to be a line in a diff.
 * Note that `scripting` alone reaches no page — the host half still comes from
 * `activeTab`, and `host_permissions` stays on the forbidden-key list below.
 */
export const EXPECTED_PERMISSIONS = ["activeTab", "scripting"];

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

/**
 * The complete privileged Chrome API surface, matching `extension/src/chrome.d.ts`.
 *
 * Scanned on the *packaged* bundle, so this is what a reviewer downloading the
 * ZIP would find rather than what the source says. `chrome.scripting.executeScript`
 * joined the list in CHROME-EXTENSION-IMPORT-001E2-CORRECTION-01; nothing else
 * did, and in particular `chrome.scripting.insertCSS`, `chrome.scripting.
 * registerContentScripts` and every `chrome.storage` member remain outside it.
 */
export const ALLOWED_CHROME_MEMBERS = [
  "chrome.scripting.executeScript",
  "chrome.tabs.create",
  "chrome.tabs.query",
];

/**
 * The icon sizes the package must ship, and the path each must live at.
 *
 * Chrome asks for 128 ("used during installation and by the Chrome Web Store"),
 * 48 ("used in the extensions management page") and 16 ("the favicon for an
 * extension's pages"); 32 is the size Windows commonly picks and Chrome's
 * scaling of a neighbouring size to reach it is visibly worse than shipping it.
 * All four are declared in both `icons` and `action.default_icon`, so a toolbar
 * button and an installation dialogue can never disagree about what the mark
 * is.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/icons
 */
export const REQUIRED_ICON_SIZES = [16, 32, 48, 128];

/** The packaged path for an icon size, as both manifest icon maps must name it. */
export const iconPathForSize = (size) => `icons/icon-${size}.png`;

/**
 * The complete file list of a valid package — an exact set, not a floor.
 *
 * Every other check here answers "is this file allowed?". This one answers "is
 * this the package?", which is a different and stricter question: it is the only
 * check that notices a file nobody thought to forbid. A build plugin that starts
 * emitting a stray chunk, a licence banner written to disk, or an icon left
 * behind by a size that was removed from the manifest all pass every pattern
 * above and fail here.
 *
 * The cost is that adding a shipping file means editing this line, in a diff a
 * reviewer reads. That is the intended cost — it is the same bargain the
 * permission list makes.
 */
export const EXPECTED_PACKAGE_ENTRIES = [
  ...REQUIRED_ICON_SIZES.map(iconPathForSize),
  "manifest.json",
  "popup.css",
  "popup.html",
  "popup.js",
].sort();

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

/**
 * Chrome's manifest `version` grammar, in full.
 *
 * Four rules, all of them load-bearing, and the last two are the ones a
 * "one-to-four numbers" reading silently drops:
 *
 *   1. one to four dot-separated integers;
 *   2. each integer between 0 and 65535 inclusive;
 *   3. *"Non-zero integers can't start with 0. For example, 032 is invalid
 *      because it begins with a zero."*
 *   4. *"They must not be all zero. For example, 0 and 0.0.0.0 are invalid
 *      while 0.1.0.0 is valid."*
 *
 * Rules 3 and 4 matter because a version Chrome rejects is not a cosmetic
 * problem: the Store refuses the upload, and an installed copy compares
 * versions to decide whether an update is newer. `032` parses as the number 32
 * under a `Number()` check, so a validator that only range-checks accepts a
 * string Chrome will not — which is exactly the failure this package contract
 * exists to catch before an upload does.
 *
 * The regex enforces rules 1–3 structurally: each component is either a bare
 * `0` or a non-zero leading digit followed by any digits. Rule 2's upper bound
 * and rule 4 are checked separately, because neither is expressible as a
 * readable pattern.
 *
 * One corner the published rules do not settle: a *zero* component written with
 * padding, as in `1.00`. Rule 3 is worded about non-zero integers, so it does
 * not name this case, and Chrome's documentation gives no example of it. The
 * pattern above rejects it — a zero component must be exactly `0`.
 *
 * That is deliberately the strict reading. The cost of being wrong is
 * asymmetric: accepting a version Chrome rejects means discovering it at
 * upload, while rejecting `1.00` means declining a version string nobody
 * writes and which no released extension has ever needed. If Chrome is ever
 * shown to accept it, the fix is one alternation in
 * `CHROME_VERSION_COMPONENT`. Note that the all-zero padded forms (`0.00`) are
 * invalid regardless, by rule 4.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/version
 */
const CHROME_VERSION_COMPONENT = String.raw`(?:0|[1-9]\d*)`;
const CHROME_VERSION_PATTERN = new RegExp(
  `^${CHROME_VERSION_COMPONENT}(?:\\.${CHROME_VERSION_COMPONENT}){0,3}$`,
);

export function isValidChromeVersion(value) {
  if (typeof value !== "string") return false;

  // Rules 1 and 3: shape, component count, and no leading zero on a non-zero
  // component. `032`, `00.1` and `01.2.3` fail here.
  if (!CHROME_VERSION_PATTERN.test(value)) return false;

  const parts = value.split(".").map(Number);

  // Rule 2: upper bound. The lower bound and non-negativity come free from the
  // pattern, which admits no sign and no non-digit.
  if (parts.some((part) => part > 65535)) return false;

  // Rule 4: not all zero. `0`, `0.0` and `0.0.0.0` fail here; `0.1.0.0` passes.
  if (parts.every((part) => part === 0)) return false;

  return true;
}

/**
 * Chrome's manifest `description` limit.
 *
 * *"A plain text string (no HTML or other formatting; no more than 132
 * characters)"*. Chrome truncates or rejects past this, and the same string is
 * what the Store listing shows, so an over-long description is a listing defect
 * as well as a manifest one.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/description
 */
export const MAX_DESCRIPTION_LENGTH = 132;

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

  // The exact inventory. Reported as two lists rather than one diff so a
  // failure says which way the package moved.
  const sortedPaths = [...paths].sort();
  const unexpected = sortedPaths.filter((p) => !EXPECTED_PACKAGE_ENTRIES.includes(p));
  const missing = EXPECTED_PACKAGE_ENTRIES.filter((p) => !files.has(p));
  for (const p of unexpected) violations.push(`package contains an unexpected file: ${p}`);
  for (const p of missing) violations.push(`package is missing a required file: ${p}`);

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
    } else if (manifest.description.length > MAX_DESCRIPTION_LENGTH) {
      violations.push(
        `description is ${manifest.description.length} characters, over Chrome's ` +
          `${MAX_DESCRIPTION_LENGTH}-character manifest limit`,
      );
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

    // Both icon maps, and they must agree. Chrome falls back to `icons` when
    // `action.default_icon` is absent, so a package missing the action map
    // still shows *an* icon — which is exactly why its absence is easy to ship
    // and hard to notice.
    for (const [label, declared] of [
      ["icons", manifest.icons],
      ["action.default_icon", manifest.action?.default_icon],
    ]) {
      if (declared === null || typeof declared !== "object" || Array.isArray(declared)) {
        violations.push(`${label} is missing or is not an object`);
        continue;
      }
      for (const size of REQUIRED_ICON_SIZES) {
        const declaredPath = declared[String(size)];
        if (declaredPath !== iconPathForSize(size)) {
          violations.push(
            `${label}["${size}"] is ${JSON.stringify(declaredPath)}, expected ${JSON.stringify(iconPathForSize(size))}`,
          );
        }
      }
      for (const size of Object.keys(declared)) {
        if (!REQUIRED_ICON_SIZES.includes(Number(size))) {
          violations.push(`${label} declares an unexpected size: ${size}`);
        }
      }
    }
  }

  // ---- Icon files ----------------------------------------------------------

  // The manifest promises a 48×48 at `icons/icon-48.png`; nothing above reads
  // the file to find out whether it is one. A 16×16 copied into every slot, a
  // JPEG renamed `.png`, or an icon flattened onto white all satisfy every
  // check so far — and the first two produce a blurred toolbar button while the
  // third puts a white rectangle on a dark Chrome theme.
  for (const size of REQUIRED_ICON_SIZES) {
    const iconPath = iconPathForSize(size);
    const bytes = files.get(iconPath);
    if (!bytes) continue; // Already reported as missing above.

    const header = readPngHeader(bytes);
    if (header === null) {
      violations.push(`${iconPath} is not a PNG file`);
      continue;
    }
    if (header.width !== size || header.height !== size) {
      violations.push(`${iconPath} is ${header.width}×${header.height}, expected ${size}×${size}`);
    }
    if (!ALPHA_COLOR_TYPES.includes(header.colorType)) {
      violations.push(
        `${iconPath} has PNG colour type ${header.colorType}, which carries no alpha channel — ` +
          "the transparent background was flattened at export",
      );
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
        // A bare namespace is not itself a widening: it is how each allowed
        // member is reached, and a minifier may leave one standing alone where
        // it bound a method. What matters is that no *member* outside the list
        // above appears.
        if (match === "chrome.tabs" || match === "chrome.scripting") continue;
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
