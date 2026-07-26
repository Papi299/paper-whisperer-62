/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />
//
// get-gemini-provider-quota — manager-only view of the SHARED Google Gemini
// provider quota (Part C). OBSERVATIONAL ONLY — never the enforcement boundary.
//
// Authorization (server-side, never trusts a client role claim):
//   1. require an Authorization header;
//   2. authenticate with auth.getUser() using the caller's JWT;
//   3. call the SECURITY DEFINER get_current_user_access() RPC AS THE CALLER;
//   4. allow only role owner|manager (can_view_provider_quota); else 403.
//
// Google auth uses backend-only Monitoring credentials (service account) via
// Edge secrets and the narrow monitoring.read scope. It NEVER returns/logs
// service-account credentials, tokens, private keys, or raw Google bodies.
//
// All request-planning + normalization live in the pure, Node-tested
// _shared/geminiMonitoring.ts (one metric type per request, page-followed,
// day-sum vs newest-complete-minute). This file supplies only the Deno glue:
// OAuth, the HTTP fetcher, the DST-safe day boundary, and identity-keyed caches.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireEdgeEnv } from "../_shared/env.ts";
import { resolveGeminiModel } from "../_shared/geminiModel.ts";
import { pacificDayStartIso } from "../_shared/pacificTime.ts";
import {
  buildTimeSeriesQueryParams,
  classifyFetchFailure,
  collectProviderQuota,
  MonitoringCollectionError,
  parseTimeSeriesPage,
  unavailableProviderQuota,
  type GeminiProviderQuotaResponse,
  type ProviderQuotaFailure,
  type TimeSeriesFetcher,
  type TimeSeriesPage,
} from "../_shared/geminiMonitoring.ts";
import {
  buildCredentialIdentity,
  buildProviderConfigIdentity,
  isCachedResponseUsable,
  isCachedTokenUsable,
  type CachedResponse,
  type CachedToken,
} from "../_shared/providerCache.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const METRICS_MAY_LAG_SECONDS = 240;
const MONITORING_SCOPE = "https://www.googleapis.com/auth/monitoring.read";
const MINUTE_LOOKBACK_MS = 300_000; // 5-min lookback so a complete 60s bucket exists
const SERVER_CACHE_TTL_MS = 120_000;
const UNAVAILABLE_MESSAGE = "Gemini provider quota is temporarily unavailable.";

// In-memory caches, both keyed by a non-sensitive identity so a credential /
// project / model change is never silently served from a stale entry.
let tokenCache: CachedToken | null = null;
let responseCache: CachedResponse<GeminiProviderQuotaResponse> | null = null;

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

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mint (and cache, keyed by credential identity) a Monitoring access token. */
async function getMonitoringToken(
  clientEmail: string,
  projectId: string,
  privateKeyPem: string,
  privateKeyFingerprint: string,
): Promise<string> {
  // Identity is keyed by the fingerprint the caller already computed (the raw key
  // is never a cache key and is never logged).
  const identity = buildCredentialIdentity(clientEmail, projectId, privateKeyFingerprint);
  const nowSec = Math.floor(Date.now() / 1000);
  if (isCachedTokenUsable(tokenCache, identity, nowSec)) {
    return tokenCache!.token;
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
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`oauth_token_error status=${res.status}`);
  const data = await res.json();
  const token = data?.access_token;
  if (typeof token !== "string" || token.length === 0) throw new Error("oauth_token_missing");
  tokenCache = { identity, token, expiresAtEpochSec: nowSec + (Number(data?.expires_in) || 3600) };
  return token;
}

/** Build a single-metric, page-aware Monitoring fetcher bound to a bearer token. */
function makeFetcher(projectId: string, token: string): TimeSeriesFetcher {
  return async (req): Promise<TimeSeriesPage> => {
    const url = new URL(`https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries`);
    // Serialize EXACTLY the pure request plan: one metric type per request, and
    // the aligner it chose (ALIGN_SUM for minute usage/exceeded, none for GAUGE
    // limits) — never a hard-coded ALIGN_DELTA.
    for (const [k, v] of Object.entries(buildTimeSeriesQueryParams(req))) {
      url.searchParams.set(k, v);
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // Timeout (AbortSignal.timeout) vs other network failure — classified
      // structurally into a bounded code; no URL, header, or exception text kept.
      throw classifyFetchFailure(err);
    }
    // Non-2xx: bounded code + numeric status only, never the response body.
    if (!res.ok) throw new MonitoringCollectionError("monitoring_http", res.status);
    let rawBody: string;
    try {
      rawBody = await res.text();
    } catch (err) {
      throw classifyFetchFailure(err); // body read interrupted mid-stream
    }
    // Parse + validate structure in the pure module (bad JSON / shape →
    // invalid_monitoring_payload); the raw body is never retained on failure.
    return parseTimeSeriesPage(rawBody);
  };
}

/**
 * Emit exactly ONE bounded diagnostic line for a failed Monitoring collection.
 * A single string argument to console.error so Supabase Logs shows one event.
 * Contains only the fixed failure code and, for an HTTP failure, the numeric
 * status — never a URL, token, body, credential, or exception message.
 */
function logProviderQuotaFailure(failure: ProviderQuotaFailure): void {
  const line =
    failure.code === "monitoring_http" && typeof failure.status === "number"
      ? `provider_quota_collection_failed code=monitoring_http status=${failure.status}`
      : `provider_quota_collection_failed code=${failure.code}`;
  console.error(line);
}

async function buildProviderQuota(
  projectId: string,
  clientEmail: string,
  privateKey: string,
  privateKeyFingerprint: string,
  configuredModel: string,
): Promise<GeminiProviderQuotaResponse> {
  const now = new Date();
  const nowIso = now.toISOString();
  let token: string;
  try {
    token = await getMonitoringToken(clientEmail, projectId, privateKey, privateKeyFingerprint);
  } catch (err) {
    console.error("get-gemini-provider-quota token mint failed:", err instanceof Error ? err.message : "unknown");
    return unavailableProviderQuota(configuredModel, nowIso, UNAVAILABLE_MESSAGE);
  }
  return collectProviderQuota(
    makeFetcher(projectId, token),
    {
      configuredModel,
      collectedAtIso: nowIso,
      nowMs: now.getTime(),
      dayStartIso: pacificDayStartIso(now),
      minuteStartIso: new Date(now.getTime() - MINUTE_LOOKBACK_MS).toISOString(),
      endIso: nowIso,
      metricsMayLagSeconds: METRICS_MAY_LAG_SECONDS,
      unavailableMessage: UNAVAILABLE_MESSAGE,
    },
    logProviderQuotaFailure,
  );
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
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: jsonHeaders });
    }

    const configuredModel = resolveGeminiModel(Deno.env.get("GEMINI_MODEL"));
    const projectId = Deno.env.get("GOOGLE_CLOUD_PROJECT_ID");
    const clientEmail = Deno.env.get("GOOGLE_MONITORING_CLIENT_EMAIL");
    const privateKey = Deno.env.get("GOOGLE_MONITORING_PRIVATE_KEY");

    if (!projectId || !clientEmail || !privateKey) {
      return new Response(
        JSON.stringify(
          unavailableProviderQuota(
            configuredModel,
            new Date().toISOString(),
            "Gemini provider quota is not configured (Monitoring credentials absent).",
          ),
        ),
        { status: 200, headers: jsonHeaders },
      );
    }

    // ── Short server cache (post-authorization) ──
    // Fingerprint the private key (never the raw key) BEFORE the cache check, so a
    // rotated credential / changed service account misses the cache and is
    // exercised on this invocation rather than served a stale prior-credential
    // response. The response identity therefore includes the full credential.
    const fingerprint = await sha256Hex(privateKey);
    const configIdentity = buildProviderConfigIdentity(projectId, configuredModel, clientEmail, fingerprint);
    if (isCachedResponseUsable(responseCache, configIdentity, Date.now(), SERVER_CACHE_TTL_MS)) {
      return new Response(JSON.stringify(responseCache!.body), { status: 200, headers: jsonHeaders });
    }

    const body = await buildProviderQuota(projectId, clientEmail, privateKey, fingerprint, configuredModel);
    if (body.status === "ok") {
      responseCache = { identity: configIdentity, atMs: Date.now(), body };
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
