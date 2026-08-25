// @vitest-environment node
//
// Node rather than jsdom: this suite reads committed files from disk, and under
// jsdom `import.meta.url` is an `http://` URL that `fileURLToPath` refuses. The
// same reason the Edge handler suites opt in — `src/test/setup.ts` is already
// guarded for the no-`window` case.
/**
 * The manifest permission contract.
 *
 * `extension/manifest.json` is where the extension's power is declared, so it is
 * asserted here rather than reviewed by eye. The permission assertion is
 * deliberately an *exact* comparison, not a set of "does not contain" checks: a
 * new permission has to be added to this file to pass, which makes widening the
 * surface a visible, deliberate line in a diff instead of something that slips
 * through with the feature that wanted it.
 *
 * The individual "no `storage`", "no `scripting`" assertions below are therefore
 * redundant with the exact comparison. They are kept because they name the
 * specific permissions CHROME-EXTENSION-IMPORT-001B rules out, so a failure says
 * *which* boundary moved rather than only that one did.
 *
 * `vite.extension.config.ts` copies this file into the build output byte for
 * byte and never edits it, so everything asserted here is also true of what
 * ships.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

const MANIFEST_PATH = fileURLToPath(new URL("../../manifest.json", import.meta.url));
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as Record<string, unknown>;

/**
 * The complete permission set for this phase.
 *
 * `activeTab` and nothing else. It is granted only in response to the user
 * clicking the toolbar action, it covers only the tab they were looking at, it
 * is revoked when they navigate away, and it displays no install-time warning.
 * Reading `Tab.url` is exactly what it is for.
 */
const EXPECTED_PERMISSIONS = ["activeTab"] as const;

/** Permissions this phase's behaviour does not need, and must not request. */
const FORBIDDEN_PERMISSIONS = [
  "storage",
  "tabs",
  "scripting",
  "identity",
  "cookies",
  "webRequest",
  "webRequestBlocking",
  "declarativeNetRequest",
  "contextMenus",
  "notifications",
  "alarms",
  "sidePanel",
  "history",
  "bookmarks",
  "downloads",
  "unlimitedStorage",
  "background",
  "clipboardRead",
  "nativeMessaging",
] as const;

describe("manifest — Manifest V3", () => {
  it("declares manifest_version 3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("declares a name, a version and a description", () => {
    expect(manifest.name).toBe("PaperLume");
    // Chrome requires one to four dot-separated integers.
    expect(manifest.version).toMatch(/^\d+(\.\d+){0,3}$/);
    expect(typeof manifest.description).toBe("string");
    expect((manifest.description as string).length).toBeGreaterThan(0);
  });
});

describe("manifest — permission contract", () => {
  it("requests exactly the phase's permissions and no others", () => {
    expect(manifest.permissions).toEqual([...EXPECTED_PERMISSIONS]);
  });

  it.each(FORBIDDEN_PERMISSIONS)("does not request %s", (permission) => {
    expect(manifest.permissions).not.toContain(permission);
    expect(manifest.optional_permissions ?? []).not.toContain(permission);
  });

  it("declares no host permissions, optional or otherwise", () => {
    // A host permission is what would let the extension read or alter pages
    // without a user gesture. `activeTab` covers this phase's one read, so
    // there is nothing for a host pattern to add.
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
  });

  it("declares no <all_urls> or wildcard match pattern anywhere", () => {
    const serialised = JSON.stringify(manifest);
    expect(serialised).not.toContain("<all_urls>");
    expect(serialised).not.toContain("*://*/*");
    expect(serialised).not.toContain("http://*/*");
    expect(serialised).not.toContain("https://*/*");
  });
});

describe("manifest — no page access and no background execution", () => {
  it("registers no content scripts", () => {
    // Nothing is injected into any page in this phase. Detection reads the tab's
    // address, which needs no code running in the page at all.
    expect(manifest).not.toHaveProperty("content_scripts");
  });

  it("registers no background service worker", () => {
    // The popup performs the whole phase behaviour, and it runs only when the
    // user opens it. A service worker would be code that exists to run when the
    // user did not ask for anything.
    expect(manifest).not.toHaveProperty("background");
  });

  it("exposes no resource to web pages", () => {
    expect(manifest).not.toHaveProperty("web_accessible_resources");
  });

  it("registers no other automatic entry point", () => {
    for (const key of ["chrome_url_overrides", "devtools_page", "omnibox", "commands", "side_panel"]) {
      expect(manifest).not.toHaveProperty(key);
    }
  });
});

describe("manifest — user interaction surface", () => {
  it("uses a toolbar action with a popup", () => {
    expect(manifest.action).toEqual({
      default_title: "PaperLume",
      default_popup: "popup.html",
    });
  });
});

describe("manifest — no remote code", () => {
  it("pins the default Manifest V3 content security policy", () => {
    // Manifest V3 already enforces this as the minimum for extension pages;
    // stating it explicitly means a future attempt to loosen it has to edit a
    // line this test compares, rather than adding a key nobody notices.
    expect(manifest.content_security_policy).toEqual({
      extension_pages: "script-src 'self'; object-src 'self';",
    });
  });

  it("references no remote origin", () => {
    const serialised = JSON.stringify(manifest);
    expect(serialised).not.toMatch(/https?:\/\//);
  });

  it("declares no externally connectable surface", () => {
    // `externally_connectable` is what lets a web page message the extension.
    // Nothing may reach this extension from outside it.
    expect(manifest).not.toHaveProperty("externally_connectable");
  });
});
