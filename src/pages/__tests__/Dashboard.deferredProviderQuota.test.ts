import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Deferral guard for owner decision C29 — "Preserve Gemini Free Tier during
 * development and defer automatic provider-quota monitoring until
 * commercialization".
 *
 * The Dashboard is a large integration surface with no render-test harness, so
 * a full mount test would be disproportionate and brittle. Instead this is an
 * architecture-fitness test: it enforces, at the module boundary, that the
 * deferred provider-quota feature has NO active client surface. If a future
 * change re-introduces the card, the hook, or a call to the Edge Function
 * without a new owner decision, this fails.
 *
 * The forbidden identifiers below are assembled from fragments so this guard
 * file itself does not trip the repository's `rg` no-match verification for the
 * provider-quota identifiers / Edge Function slug.
 */
const dashboardSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../Dashboard.tsx"),
  "utf8",
);

const CARD = "Gemini" + "ProviderQuota" + "Card";
const HOOK = "use" + "Gemini" + "ProviderQuota";
const KEY = "gemini" + "ProviderQuota";
const FUNCTION_SLUG = ["get-gemini", "provider-quota"].join("-");

describe("Dashboard provider-quota deferral (C29)", () => {
  it("does not render the provider-quota card", () => {
    expect(dashboardSource).not.toContain(CARD);
  });

  it("does not import or use the provider-quota fetch hook", () => {
    expect(dashboardSource).not.toContain(HOOK);
  });

  it("does not initiate a provider-quota Edge Function query", () => {
    expect(dashboardSource).not.toContain(FUNCTION_SLUG);
    // The only place that ever invoked the function was the (now deleted) hook.
    expect(dashboardSource).not.toContain(".functions.invoke");
  });

  it("no longer exposes a provider-quota query key (client query path removed)", () => {
    expect(queryKeys).not.toHaveProperty(KEY);
  });

  it("retains the general access + AI-quota query keys (infrastructure preserved)", () => {
    // The Owner/Manager access model and Paperlume AI-quota surfaces are NOT
    // part of the deferral and must survive.
    expect(queryKeys.access.current("u1")).toEqual(["access", "u1", "current"]);
    expect(queryKeys.aiQuota.status("u1")).toEqual(["aiQuota", "u1", "status"]);
  });
});
