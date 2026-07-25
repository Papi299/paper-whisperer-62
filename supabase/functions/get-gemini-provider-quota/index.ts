/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />
//
// get-gemini-provider-quota — manager-only view of the SHARED Google Gemini
// provider quota (Part C). This is OBSERVATIONAL ONLY and must never become the
// enforcement boundary for user analyses.
//
// Authorization (server-side, never trusts client role claims):
//   1. require an Authorization header;
//   2. authenticate with auth.getUser() using the caller's JWT;
//   3. call the SECURITY DEFINER get_current_user_access() RPC AS THE CALLER;
//   4. allow only role owner|manager (can_view_provider_quota); else 403.
//
// Google auth uses backend-only Monitoring credentials (service account) via
// Edge secrets, the narrow monitoring.read scope, and reads projects.timeSeries.
// It NEVER returns service-account credentials, tokens, private keys, or raw
// Google error bodies, and NEVER logs key material / assertions / tokens.
//
// Fails soft: missing creds, disabled API, 403, no metrics, or timeout all
// yield a bounded { status: "unavailable" } response (HTTP 200), not a 500.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireEdgeEnv } from "../_shared/env.ts";
import { resolveGeminiModel } from "../_shared/geminiModel.ts";
import {
  GEMINI_QUOTA_METRIC_FAMILIES,
  normalizeMonitoringTimeSeries,
  mergeWindowedProviderQuota,
  unavailableProviderQuota,
  type GeminiProviderQuotaResponse,
  type RawTimeSeries,
} from "../_shared/geminiMonitoring.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

// Observational metadata: Google Monitoring quota metrics lag; surface it.
const METRICS_MAY_LAG_SECONDS = 240;
const MONITORING_SCOPE = "https://www.googleapis.com/auth/monitoring.read";

// Short best-effort in-memory caches. The provider quota is a shared,
// project-level metric, so one cache is correct for all managers. Only
// successful ("ok") results are cached; "unavailable" is not, so a fixed
// misconfiguration recovers on the next request.
const SERVER_CACHE_TTL_MS = 120_000;
let responseCache: { at: number; body: GeminiProviderQuotaResponse } | null = null;
let tokenCache: { token: string; expiresAtEpoch: number } | null = null;

function base64url(input: Uint8Array | string): string {
  let bin = "";
  if (typeof input === "string") {
    bin = input;
  } else {
    for (let i = 0; i < input.length; i++) bin += String.fromCharCode(input[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  // Normalize escaped newlines that survive env-var round-trips, then strip the
  // PEM armor and whitespace to recover the base64 DER body.
  const normalized = pem.replace(/\\n/g, "\n");
  const body = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/** Mint (and cache) a Monitoring access token via a signed service-account JWT. */
async function getMonitoringToken(clientEmail: string, privateKeyPem: string): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAtEpoch - 60 > nowSec) {
    return tokenCache.token;
  }

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: clientEmail,
    scope: MONITORING_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)),
  );
  const assertion = `${signingInput}.${base64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // Do not surface the raw Google body.
    throw new Error(`oauth_token_error status=${res.status}`);
  }
  const data = await res.json();
  const token = data?.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("oauth_token_missing");
  }
  tokenCache = { token, expiresAtEpoch: nowSec + (Number(data?.expires_in) || 3600) };
  return token;
}

/** OR-filter across all metric families × {limit,usage,exceeded}. */
function monitoringFilter(): string {
  const measures = ["limit", "usage", "exceeded"];
  const types = GEMINI_QUOTA_METRIC_FAMILIES.flatMap((f) => measures.map((m) => `${f}/${m}`));
  return types.map((t) => `metric.type = "${t}"`).join(" OR ");
}

async function fetchTimeSeries(
  projectId: string,
  token: string,
  startTimeIso: string,
  endTimeIso: string,
): Promise<RawTimeSeries[]> {
  const url = new URL(`https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries`);
  url.searchParams.set("filter", monitoringFilter());
  url.searchParams.set("interval.startTime", startTimeIso);
  url.searchParams.set("interval.endTime", endTimeIso);
  url.searchParams.set("view", "FULL");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`monitoring_error status=${res.status}`);
  }
  const data = await res.json();
  return Array.isArray(data?.timeSeries) ? (data.timeSeries as RawTimeSeries[]) : [];
}

/** UTC instant of the start of the current Pacific day (DST-correct). */
function pacificDayStartIso(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const num = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const elapsedSec = num("hour") * 3600 + num("minute") * 60 + num("second");
  return new Date(now.getTime() - elapsedSec * 1000).toISOString();
}

async function collectProviderQuota(configuredModel: string): Promise<GeminiProviderQuotaResponse> {
  const nowIso = new Date().toISOString();

  // Credentials are optional at the code level — absent → fail soft.
  const projectId = Deno.env.get("GOOGLE_CLOUD_PROJECT_ID");
  const clientEmail = Deno.env.get("GOOGLE_MONITORING_CLIENT_EMAIL");
  const privateKey = Deno.env.get("GOOGLE_MONITORING_PRIVATE_KEY");
  if (!projectId || !clientEmail || !privateKey) {
    return unavailableProviderQuota(
      configuredModel,
      nowIso,
      "Gemini provider quota is not configured (Monitoring credentials absent).",
    );
  }

  try {
    const token = await getMonitoringToken(clientEmail, privateKey);
    const now = new Date();
    // Daily window: start of the current Pacific day → now.
    const dayStart = pacificDayStartIso(now);
    // Minute window: a bounded recent interval (approximate; metrics lag).
    const minuteStart = new Date(now.getTime() - 120_000).toISOString();
    const endIso = now.toISOString();

    const [daySeries, minuteSeries] = await Promise.all([
      fetchTimeSeries(projectId, token, dayStart, endIso),
      fetchTimeSeries(projectId, token, minuteStart, endIso),
    ]);

    const opts = { configuredModel, collectedAt: endIso, metricsMayLagSeconds: METRICS_MAY_LAG_SECONDS };
    return mergeWindowedProviderQuota(
      normalizeMonitoringTimeSeries(daySeries, opts),
      normalizeMonitoringTimeSeries(minuteSeries, opts),
    );
  } catch (err) {
    // Bounded, non-sensitive reason only — never the raw Google body.
    const reason = err instanceof Error ? err.message : "unknown";
    console.error("get-gemini-provider-quota collect failed:", reason);
    return unavailableProviderQuota(
      configuredModel,
      nowIso,
      "Gemini provider quota is temporarily unavailable.",
    );
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Auth ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    const supabaseUrl = requireEdgeEnv("SUPABASE_URL");
    const supabaseAnonKey = requireEdgeEnv("SUPABASE_ANON_KEY");
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Auth failed" }), { status: 401, headers: jsonHeaders });
    }

    // ── Authorization: server-controlled role, never a client claim ──
    const { data: accessData, error: accessError } = await supabase.rpc("get_current_user_access");
    if (accessError) {
      console.error("get_current_user_access RPC error:", accessError.message);
      return new Response(JSON.stringify({ error: "Access check failed" }), { status: 500, headers: jsonHeaders });
    }
    const access = Array.isArray(accessData) ? accessData[0] : accessData;
    if (!access || access.can_view_provider_quota !== true) {
      // Ordinary users: 403. Do not reveal whether the feature exists beyond this.
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: jsonHeaders });
    }

    const configuredModel = resolveGeminiModel(Deno.env.get("GEMINI_MODEL"));

    // ── Serve short server cache (post-authorization) ──
    if (responseCache && Date.now() - responseCache.at < SERVER_CACHE_TTL_MS) {
      return new Response(JSON.stringify(responseCache.body), { status: 200, headers: jsonHeaders });
    }

    const body = await collectProviderQuota(configuredModel);
    // Cache only successful reads so a transient/config failure retries next time.
    if (body.status === "ok") {
      responseCache = { at: Date.now(), body };
    }

    return new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders });
  } catch (err) {
    console.error("get-gemini-provider-quota error:", err instanceof Error ? err.message : "unknown");
    return new Response(JSON.stringify({ error: "Provider quota unavailable" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});
