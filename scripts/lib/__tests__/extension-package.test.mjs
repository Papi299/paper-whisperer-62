/**
 * The package contract's own tests.
 *
 * `findPackageViolations` is the only thing standing between a mis-assembled
 * archive and the Chrome Web Store, and a validator that silently passes
 * everything looks exactly like a validator that works. So every check is
 * exercised twice: once against a package that satisfies the contract, and once
 * against a package deliberately broken in that one way. A check that stopped
 * firing would fail here rather than passing quietly on the real artefact.
 *
 * This is the same discipline `extension/src/__tests__/support/remoteReferences.ts`
 * was extracted for — security-relevant test logic needs its own tests, because
 * there is otherwise no way to feed it a hostile example without breaking the
 * production artefact to do it.
 */

import { describe, it, expect } from "vitest";

import {
  findPackageViolations,
  manifestReferencedPaths,
  MAX_PACKAGE_ENTRIES,
  MAX_PACKAGE_BYTES,
  MAX_DESCRIPTION_LENGTH,
  FORBIDDEN_MANIFEST_KEYS,
  EXPECTED_PACKAGE_ENTRIES,
  REQUIRED_ICON_SIZES,
  iconPathForSize,
} from "../extension-package.mjs";

const encoder = new TextEncoder();

/**
 * A PNG carrying a real IHDR and nothing else.
 *
 * The icon checks read the 26-byte header and stop, so a fixture only has to be
 * truthful about that header — and a *header-only* fixture is what lets a test
 * claim "this file says it is 16×16" without shipping a real 128×128 image into
 * the suite to say the opposite. The genuine artefact is validated against the
 * genuine PNGs by `scripts/package-extension.mjs`, which reads them off disk.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} colorType 6 is RGBA; 2 (truecolour, no alpha) is the flattened case.
 */
function pngHeader(width, height, colorType = 6) {
  const bytes = new Uint8Array(26);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR length
  bytes.set(encoder.encode("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8; // bit depth
  bytes[25] = colorType;
  return bytes;
}

/** The icon set a valid package ships, keyed by packaged path. */
const VALID_ICON_FILES = Object.fromEntries(
  REQUIRED_ICON_SIZES.map((size) => [iconPathForSize(size), pngHeader(size, size)]),
);

/** The icon map both `icons` and `action.default_icon` must carry. */
const VALID_ICON_MAP = Object.fromEntries(REQUIRED_ICON_SIZES.map((size) => [String(size), iconPathForSize(size)]));

/** The manifest the extension actually ships, as an object to vary from. */
const VALID_MANIFEST = {
  manifest_version: 3,
  name: "PaperLume",
  version: "0.1.0",
  description: "Identify the scientific paper on the page you are viewing.",
  icons: VALID_ICON_MAP,
  permissions: ["activeTab"],
  action: { default_title: "PaperLume", default_popup: "popup.html", default_icon: VALID_ICON_MAP },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self';" },
};

/**
 * A package that satisfies the contract, with per-file overrides.
 *
 * `manifest` is merged over the valid one; `files` adds or replaces entries.
 * Passing `null` as a file's content deletes it.
 */
function buildPackage({ manifest = {}, files = {} } = {}) {
  const merged = { ...VALID_MANIFEST, ...manifest };
  for (const [key, value] of Object.entries(manifest)) {
    if (value === undefined) delete merged[key];
  }

  const entries = new Map([
    ["manifest.json", encoder.encode(JSON.stringify(merged, null, 2))],
    ["popup.html", encoder.encode('<!doctype html><html><body><script type="module" src="./popup.js"></script></body></html>')],
    ["popup.js", encoder.encode('const u="https://app.paperlume.app";chrome.tabs.query({});chrome.tabs.create({url:u});')],
    ["popup.css", encoder.encode(".popup{color:#111}")],
    ...Object.entries(VALID_ICON_FILES),
  ]);

  for (const [path, content] of Object.entries(files)) {
    if (content === null) entries.delete(path);
    else entries.set(path, typeof content === "string" ? encoder.encode(content) : content);
  }

  return entries;
}

/** Assert at least one violation mentions `fragment`, with a legible failure. */
function expectViolation(files, fragment) {
  const violations = findPackageViolations(files);
  const matched = violations.filter((v) => v.includes(fragment));
  expect(
    matched.length,
    `expected a violation containing ${JSON.stringify(fragment)}, got: ${JSON.stringify(violations, null, 2)}`,
  ).toBeGreaterThan(0);
}

describe("package contract — the valid package", () => {
  it("reports no violations", () => {
    expect(findPackageViolations(buildPackage())).toEqual([]);
  });
});

describe("package contract — archive shape", () => {
  it("rejects a manifest that is not at the archive root", () => {
    const files = buildPackage({ files: { "manifest.json": null } });
    files.set("dist-extension/manifest.json", encoder.encode(JSON.stringify(VALID_MANIFEST)));
    expectViolation(files, "manifest.json is not at the archive root");
  });

  it("rejects a nested second manifest even when the root one is present", () => {
    expectViolation(
      buildPackage({ files: { "nested/manifest.json": JSON.stringify(VALID_MANIFEST) } }),
      "a second manifest is nested",
    );
  });

  it("rejects an entry with an absolute path", () => {
    expectViolation(buildPackage({ files: { "/etc/passwd": "x" } }), "absolute path");
  });

  it("rejects an entry that escapes the archive root", () => {
    expectViolation(buildPackage({ files: { "../outside.js": "x" } }), "escapes the archive root");
  });

  it("rejects an empty packaged file", () => {
    expectViolation(buildPackage({ files: { "empty.txt": new Uint8Array(0) } }), "packaged file is empty");
  });

  it("rejects a package with too many entries", () => {
    const files = buildPackage();
    for (let i = 0; i < MAX_PACKAGE_ENTRIES + 1; i += 1) files.set(`filler-${i}.txt`, encoder.encode("x"));
    expectViolation(files, `over the ${MAX_PACKAGE_ENTRIES} bound`);
  });

  it("rejects a package over the byte bound", () => {
    expectViolation(
      buildPackage({ files: { "big.txt": "x".repeat(MAX_PACKAGE_BYTES + 1) } }),
      `over the ${MAX_PACKAGE_BYTES} bound`,
    );
  });
});

describe("package contract — excluded content", () => {
  it.each([
    ["popup.ts", "TypeScript source"],
    ["popup.js.map", "source map"],
    ["src/__tests__/popup.test.js", "test directory"],
    ["popup.spec.js", "test file"],
    [".gitignore", "git metadata"],
    ["node_modules/left-pad/index.js", "dependency tree"],
    ["package.json", "package manager metadata"],
    ["tsconfig.extension.json", "compiler configuration"],
    [".env.local", "environment file"],
    ["README.md", "documentation"],
    ["test-results/trace.txt", "Playwright artefact"],
    ["User Data/Default/Cookies", "browser profile directory"],
    ["signing.pem", "signing or secret material"],
    [".DS_Store", "editor or OS metadata"],
  ])("rejects %s", (path, reason) => {
    expectViolation(buildPackage({ files: { [path]: "content" } }), `package contains ${reason}`);
  });
});

describe("package contract — manifest", () => {
  it("rejects malformed JSON", () => {
    expectViolation(buildPackage({ files: { "manifest.json": "{ not json" } }), "not valid JSON");
  });

  it("rejects a manifest that is not an object", () => {
    expectViolation(buildPackage({ files: { "manifest.json": "[]" } }), "not a JSON object");
  });

  it("rejects Manifest V2", () => {
    expectViolation(buildPackage({ manifest: { manifest_version: 2 } }), "expected 3");
  });

  it("rejects a different extension name", () => {
    expectViolation(buildPackage({ manifest: { name: "Paper Whisperer" } }), "expected \"PaperLume\"");
  });

  it.each([
    ["", "empty"],
    ["1.2.3.4.5", "five components"],
    ["1.x", "non-numeric component"],
    ["1.-1", "negative component"],
    ["70000", "over 65535"],
    ["1.70000", "over 65535 in a later component"],
    ["v1.0", "prefixed"],
    ["1.", "trailing dot"],
    [".1", "leading dot"],
    ["1..2", "empty component"],
    // Rejected twice over — the pattern refuses the padded `00`, and the
    // all-zero rule refuses the value — so it is a control for neither rule
    // and belongs in this general block rather than under either heading.
    ["0.00", "padded and all zero"],
  ])("rejects invalid Chrome version syntax %j (%s)", (version) => {
    expectViolation(buildPackage({ manifest: { version } }), "not valid Chrome manifest version syntax");
  });

  // NEGATIVE CONTROL for Chrome's leading-zero rule: "Non-zero integers can't
  // start with 0. For example, 032 is invalid because it begins with a zero."
  //
  // Every one of these passes a naive `/^\d+$/` + `Number(part) <= 65535`
  // check — `Number("032")` is 32 — so this block is precisely what fails if
  // the rule is dropped from `isValidChromeVersion`. It is the reason the
  // helper cannot go back to range-checking alone.
  it.each(["032", "1.032", "00.1", "01.2.3", "0001", "1.00", "1.0.01"])(
    "rejects %j — a non-zero integer may not begin with 0",
    (version) => {
      expectViolation(buildPackage({ manifest: { version } }), "not valid Chrome manifest version syntax");
    },
  );

  // NEGATIVE CONTROL for Chrome's all-zero rule: "They must not be all zero.
  // For example, 0 and 0.0.0.0 are invalid while 0.1.0.0 is valid."
  //
  // Each of these is structurally well-formed and in range, so only the
  // explicit all-zero check rejects them. Removing that check makes this block
  // fail and nothing else.
  it.each(["0", "0.0", "0.0.0", "0.0.0.0"])(
    "rejects %j — a version may not be all zero",
    (version) => {
      expectViolation(buildPackage({ manifest: { version } }), "not valid Chrome manifest version syntax");
    },
  );

  it.each([
    "1",
    "1.0",
    "1.0.0",
    "0.1",
    "0.1.0",
    // Chrome's own counter-example to the all-zero rule: zero components are
    // fine as long as they are not *all* zero.
    "0.1.0.0",
    "65535.65535.65535.65535",
    "2.10.2",
    "3.1.2.4567",
  ])("accepts valid Chrome version syntax %j", (version) => {
    expect(findPackageViolations(buildPackage({ manifest: { version } }))).toEqual([]);
  });

  it("accepts the version the extension currently ships", () => {
    expect(findPackageViolations(buildPackage({ manifest: { version: "0.1.0" } }))).toEqual([]);
  });

  it("rejects a missing description", () => {
    expectViolation(buildPackage({ manifest: { description: undefined } }), "description is missing");
  });

  it("rejects an empty description", () => {
    expectViolation(buildPackage({ manifest: { description: "" } }), "description is missing or empty");
  });

  it("rejects a non-string description", () => {
    expectViolation(buildPackage({ manifest: { description: 42 } }), "description is missing or empty");
  });

  it("accepts the description the extension currently ships", () => {
    // Guards against the limit being set below what already ships, which would
    // fail the real package rather than a hypothetical one.
    expect(VALID_MANIFEST.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(findPackageViolations(buildPackage())).toEqual([]);
  });

  it(`accepts a description of exactly ${MAX_DESCRIPTION_LENGTH} characters`, () => {
    const description = "d".repeat(MAX_DESCRIPTION_LENGTH);
    expect(findPackageViolations(buildPackage({ manifest: { description } }))).toEqual([]);
  });

  it(`rejects a description of ${MAX_DESCRIPTION_LENGTH + 1} characters`, () => {
    // The boundary is asserted from both sides, one character apart, so an
    // off-by-one in either direction fails rather than passing silently.
    const description = "d".repeat(MAX_DESCRIPTION_LENGTH + 1);
    expectViolation(
      buildPackage({ manifest: { description } }),
      `description is ${MAX_DESCRIPTION_LENGTH + 1} characters, over Chrome's ${MAX_DESCRIPTION_LENGTH}-character manifest limit`,
    );
  });

  it.each([
    [["activeTab", "tabs"], "an added permission"],
    [["tabs"], "a substituted permission"],
    [[], "an empty permission list"],
    [["storage", "activeTab"], "a reordered widened list"],
    ["activeTab", "a non-array permissions value"],
  ])("rejects %j — %s", (permissions) => {
    expectViolation(buildPackage({ manifest: { permissions } }), "expected exactly [\"activeTab\"]");
  });

  it.each(FORBIDDEN_MANIFEST_KEYS)("rejects the forbidden manifest key %s", (key) => {
    const value = key === "background" ? { service_worker: "sw.js" } : "value";
    expectViolation(buildPackage({ manifest: { [key]: value } }), `forbidden key: ${key}`);
  });

  it("rejects a manifest that names a file the package does not contain", () => {
    expectViolation(
      buildPackage({ files: { [iconPathForSize(128)]: null } }),
      "manifest references a file the package does not contain: icons/icon-128.png",
    );
  });

  it("accepts a manifest whose referenced files are all present", () => {
    expect(findPackageViolations(buildPackage())).toEqual([]);
  });
});

describe("package contract — the exact inventory", () => {
  it("rejects a file nobody thought to forbid", () => {
    // Deliberately innocuous, and deliberately not matched by any excluded-path
    // pattern: a licence banner a bundler decided to emit. Only the inventory
    // check can see it.
    expectViolation(buildPackage({ files: { "popup.js.LICENSE.txt": "/* MIT */" } }), "an unexpected file");
  });

  it("rejects an icon at a size the manifest does not declare", () => {
    expectViolation(buildPackage({ files: { "icons/icon-64.png": pngHeader(64, 64) } }), "an unexpected file");
  });

  it.each(["popup.css", "popup.js", "popup.html"])("rejects a package missing %s", (path) => {
    expectViolation(buildPackage({ files: { [path]: null } }), `missing a required file: ${path}`);
  });

  it("lists exactly the entries the real package ships", () => {
    expect([...buildPackage().keys()].sort()).toEqual(EXPECTED_PACKAGE_ENTRIES);
  });
});

describe("package contract — icons", () => {
  it.each(REQUIRED_ICON_SIZES)("rejects a package with no %ipx icon file", (size) => {
    expectViolation(buildPackage({ files: { [iconPathForSize(size)]: null } }), `missing a required file: ${iconPathForSize(size)}`);
  });

  it.each([
    ["icons", (map) => ({ icons: map })],
    ["action.default_icon", (map) => ({ action: { ...VALID_MANIFEST.action, default_icon: map } })],
  ])("rejects a manifest whose %s map is missing a size", (label, build) => {
    const incomplete = { ...VALID_ICON_MAP };
    delete incomplete["32"];
    expectViolation(buildPackage({ manifest: build(incomplete) }), `${label}["32"] is undefined`);
  });

  it.each([
    ["icons", () => ({ icons: undefined })],
    ["action.default_icon", () => ({ action: { default_title: "PaperLume", default_popup: "popup.html" } })],
  ])("rejects a manifest with no %s map at all", (label, build) => {
    // Chrome falls back to `icons` when `action.default_icon` is absent, so a
    // package missing the action map still shows an icon — which is exactly why
    // its absence has to be a violation rather than something review catches.
    expectViolation(buildPackage({ manifest: build() }), `${label} is missing or is not an object`);
  });

  it("rejects an icon map that declares a size outside the contract", () => {
    expectViolation(
      buildPackage({
        manifest: { icons: { ...VALID_ICON_MAP, 512: "icons/icon-512.png" } },
        files: { "icons/icon-512.png": pngHeader(512, 512) },
      }),
      "icons declares an unexpected size: 512",
    );
  });

  it("rejects an icon map pointing at a path outside icons/", () => {
    expectViolation(
      buildPackage({ manifest: { icons: { ...VALID_ICON_MAP, 48: "logo.png" } } }),
      'icons["48"] is "logo.png"',
    );
  });

  it("rejects an icon whose real dimensions are not the declared size", () => {
    // The failure this catches: one file copied into every slot. Every path
    // exists, every reference resolves, and Chrome renders a blurred toolbar
    // button from a 16px source scaled to 128.
    expectViolation(
      buildPackage({ files: { [iconPathForSize(128)]: pngHeader(16, 16) } }),
      "icons/icon-128.png is 16×16, expected 128×128",
    );
  });

  it("rejects a non-square icon of the right nominal width", () => {
    expectViolation(
      buildPackage({ files: { [iconPathForSize(48)]: pngHeader(48, 32) } }),
      "icons/icon-48.png is 48×32, expected 48×48",
    );
  });

  it("rejects an icon file that is not a PNG", () => {
    expectViolation(
      buildPackage({ files: { [iconPathForSize(32)]: "GIF89a not really a png" } }),
      "icons/icon-32.png is not a PNG file",
    );
  });

  it("rejects an icon whose transparency was flattened at export", () => {
    // Colour type 2 is truecolour with no alpha. It is a perfectly valid PNG of
    // exactly the right size, and it puts a white rectangle behind the mark on
    // every dark Chrome theme.
    expectViolation(
      buildPackage({ files: { [iconPathForSize(16)]: pngHeader(16, 16, 2) } }),
      "icons/icon-16.png has PNG colour type 2, which carries no alpha channel",
    );
  });

  it("accepts greyscale-plus-alpha as well as RGBA", () => {
    // The contract is "carries alpha", not "is RGBA". Colour type 4 does.
    expect(
      findPackageViolations(buildPackage({ files: { [iconPathForSize(16)]: pngHeader(16, 16, 4) } })),
    ).toEqual([]);
  });
});

describe("package contract — file contents", () => {
  it("rejects a disallowed external origin in packaged JavaScript", () => {
    expectViolation(
      buildPackage({ files: { "popup.js": 'fetch("https://evil.example/x");' } }),
      "names a disallowed external origin: https://evil.example",
    );
  });

  it("rejects a disallowed origin written in a comment, because a comment ships too", () => {
    // The scanner strips nothing; see the module comment on why that is right
    // for a package scan and wrong for a source scan.
    expectViolation(
      buildPackage({ files: { "popup.js": "// see https://tracker.example/beacon\nchrome.tabs.query({});" } }),
      "names a disallowed external origin: https://tracker.example",
    );
  });

  it("rejects a remote script tag in packaged markup", () => {
    expectViolation(
      buildPackage({ files: { "popup.html": '<script src="https://cdn.example/lib.js"></script>' } }),
      "loads a remote resource",
    );
  });

  it("rejects an unquoted remote src attribute", () => {
    expectViolation(
      buildPackage({ files: { "popup.html": "<script src=https://cdn.example/lib.js></script>" } }),
      "loads a remote resource",
    );
  });

  it("rejects a remote stylesheet import", () => {
    expectViolation(
      buildPackage({ files: { "popup.css": '@import url("https://fonts.example/f.css");' } }),
      "imports a remote stylesheet",
    );
  });

  it("rejects a remote CSS url()", () => {
    expectViolation(
      buildPackage({ files: { "popup.css": ".a{background:url('https://cdn.example/bg.png')}" } }),
      "loads a remote resource",
    );
  });

  it("rejects a sourceMappingURL annotation", () => {
    expectViolation(
      buildPackage({ files: { "popup.js": "chrome.tabs.query({});\n//# sourceMappingURL=popup.js.map" } }),
      "sourceMappingURL",
    );
  });

  it.each([
    "chrome.storage.local",
    "chrome.scripting",
    "chrome.cookies",
    "chrome.identity",
    "chrome.runtime.sendMessage",
    "chrome.webRequest",
    "chrome.tabs.executeScript",
    "chrome.tabs.update",
  ])("rejects the out-of-contract Chrome API %s", (member) => {
    expectViolation(buildPackage({ files: { "popup.js": `${member}({});` } }), "outside the declared surface");
  });

  it("accepts the two declared Chrome members and the namespace itself", () => {
    expect(
      findPackageViolations(
        buildPackage({ files: { "popup.js": "const t=chrome.tabs;chrome.tabs.query({});chrome.tabs.create({});" } }),
      ),
    ).toEqual([]);
  });

  it("allows the PaperLume origin", () => {
    expect(
      findPackageViolations(
        buildPackage({ files: { "popup.js": 'const u="https://app.paperlume.app/extension-import?kind=pmid&value=1";' } }),
      ),
    ).toEqual([]);
  });

  it("rejects a lookalike origin", () => {
    expectViolation(
      buildPackage({ files: { "popup.js": 'const u="https://app.paperlume.app.evil.example/x";' } }),
      "names a disallowed external origin",
    );
  });

  it("rejects plain-http PaperLume", () => {
    expectViolation(
      buildPackage({ files: { "popup.js": 'const u="http://app.paperlume.app/x";' } }),
      "names a disallowed external origin: http://app.paperlume.app",
    );
  });
});

describe("manifestReferencedPaths", () => {
  it("collects the popup and every icon size, normalising leading ./", () => {
    expect(
      manifestReferencedPaths({
        action: { default_popup: "./popup.html", default_icon: { 16: "icons/a16.png" } },
        icons: { 48: "icons/a48.png", 128: "/icons/a128.png" },
      }).sort(),
    ).toEqual(["icons/a128.png", "icons/a16.png", "icons/a48.png", "popup.html"]);
  });

  it("returns nothing for a manifest that references no files", () => {
    expect(manifestReferencedPaths({})).toEqual([]);
  });
});
