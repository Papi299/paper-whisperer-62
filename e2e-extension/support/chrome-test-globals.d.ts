/**
 * The Chrome surface this *lane* reads, which is wider than the extension's own.
 *
 * `extension/src/chrome.d.ts` declares exactly what the shipped extension may
 * call, and it must stay that narrow — it is the reviewable statement of the
 * product's privileged surface. These specs additionally *interrogate* the
 * browser (what did Chrome grant? what ID did it assign?), which needs members
 * the extension itself must never use.
 *
 * Keeping those here rather than widening the extension's declaration is the
 * point: adding `chrome.permissions` to `extension/src/chrome.d.ts` would make
 * the product able to call it, in order to let a test ask a question. This file
 * is not part of any build and is not in the extension's TypeScript project.
 */

declare namespace chrome {
  namespace runtime {
    const id: string;
    function getManifest(): Record<string, unknown>;
    function getURL(path: string): string;
  }

  namespace permissions {
    interface Permissions {
      readonly permissions?: string[];
      readonly origins?: string[];
    }
    function getAll(callback: (permissions: Permissions) => void): void;
  }

  namespace tabs {
    interface Tab {
      readonly url?: string;
    }
    function query(queryInfo: { readonly active?: boolean; readonly currentWindow?: boolean }): Promise<Tab[]>;
    function create(createProperties: { readonly url?: string }): Promise<Tab>;
  }
}
