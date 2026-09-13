// suggest-paper-organization — AI-PROJECT-TAG-SUGGESTIONS-001A.
//
// Advisory only. It answers "which of this user's existing Projects/Tags fit
// this paper, and is anything new genuinely worth creating?" and returns
// suggestions. It creates nothing, assigns nothing and persists nothing in the
// application domain: the user accepts or rejects each suggestion later, and
// the existing Project/Tag mutation paths remain the sole authority for any
// change to the library. Its writes are the two pre-existing AI-quota RPCs
// (`consume_ai_quota` / `refund_ai_quota`) and, since AI-MULTI-PROVIDER-001D,
// one content-free provider-usage telemetry row per provider call.
//
// There is deliberately no frontend caller yet. 001A ships and proves the
// backend contract; the Edit Paper experience that will use it is 001B, and the
// endpoint must be deployed and verified before that UI can ship (the same
// endpoint-before-UI rule `search-pubmed` follows — see docs/deployment.md).
//
// This file is only the Deno shell — it builds the caller-scoped Supabase
// client, reads the environment, and serves the handler. Every decision that
// matters lives in the pure, Node-tested modules beside it:
//   handler.ts    — CORS before auth, method gating, the authoritative
//                   getUser() check, paper ownership, taxonomy loading, quota
//                   consumption/refund, the bounded provider retry budget,
//                   and when a provider-usage event is recorded
//   validation.ts — request shape, bounds, and the eligibility rule
//   prompt.ts     — the privacy boundary: allow-listed provider fields and the
//                   ephemeral P1/T1 refs that replace database ids
//   parse.ts      — strict provider-response validation and ref→id mapping
//   contract.ts   — every bound and every type, as plain values
//
// verify_jwt = false at the gateway is intentional and matches the repository's
// five existing functions: the bearer token is validated in-body instead, so a
// stale/refreshing token and a CORS preflight are handled by the function's own
// logic rather than being refused before it runs. The in-code auth.getUser()
// remains authoritative, and no user id is ever read from the request body.
//
// There is deliberately no `/// <reference types=".../edge-runtime.d.ts" />`
// directive here or in the modules this imports — see the note at the top of
// ../_shared/env.ts. Deno resolves type-only references when it builds the
// module graph, and the copy esm.sh currently serves pulls in a package whose
// type graph does not resolve, which prevents the worker from booting on the
// local Edge runtime.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireEdgeEnv } from "../_shared/env.ts";
import { resolveSystemDefaultAiModel } from "../_shared/aiProviderRegistry.ts";
import { createAiUsageEventInsertClient } from "../_shared/aiUsageTelemetry.ts";
import { handleSuggestOrganizationRequest, type CallerClient } from "./handler.ts";

Deno.serve((req) =>
  handleSuggestOrganizationRequest(req, {
    createCallerClient(authHeader: string): CallerClient {
      // Fail fast with an actionable error if either runtime-required value is
      // missing, rather than letting an empty string fall through into a broken
      // client. Auto-injected by the Supabase Edge runtime in production.
      const supabaseUrl = requireEdgeEnv("SUPABASE_URL");
      const supabaseAnonKey = requireEdgeEnv("SUPABASE_ANON_KEY");
      // Anon key + the caller's own Authorization header: every read this
      // function performs is subject to the caller's RLS, and the quota RPCs
      // see the caller's auth.uid(). The one elevated client in this function
      // is the telemetry writer below, and it reads nothing.
      return createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      }) as unknown as CallerClient;
    },
    fetchImpl: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // Read at request time, not module load, so a missing secret surfaces as a
    // 500 response rather than a worker that cannot boot.
    //
    // The NAME comes from the handler, which gets it from the one reviewed
    // provider→credential mapping applied to the provider this request actually
    // resolved to (AI-MULTI-PROVIDER-001C). This glue does not choose it and
    // does not know which providers exist — it reads exactly the variable it is
    // asked for and nothing else, so a request routed to one provider can never
    // pick up another's secret here.
    getProviderCredential: (envName: string) => Deno.env.get(envName) ?? null,
    // Paperlume's SYSTEM DEFAULT, as provider + model metadata, through the one
    // shared resolver, so this function and analyze-paper can never disagree
    // about the default. It is the starting point and the safe fallback — the
    // handler re-checks the caller's entitlement and may route the request to
    // their saved preference instead (AI-MODEL-SELECTION-001B). That per-user
    // decision deliberately lives in the handler, not in this untested Deno
    // glue, and so does the choice of provider adapter
    // (AI-MULTI-PROVIDER-001A).
    getSystemDefaultModel: () => resolveSystemDefaultAiModel(Deno.env.get("GEMINI_MODEL")),
    // AI-MULTI-PROVIDER-001D. The provider-usage telemetry writer's client,
    // built lazily — only after a provider call happened — from the
    // platform-injected secret key. Its type allows one thing: INSERT into
    // `ai_provider_usage_events`, and the database grants that role nothing
    // else on it. It carries no caller header, never reaches the caller client,
    // the quota RPCs or a provider adapter, and a missing key only means the
    // event is not recorded (logged), never a failed request.
    createUsageEventClient: () =>
      createAiUsageEventInsertClient({
        supabaseUrl: requireEdgeEnv("SUPABASE_URL"),
        readEnv: (name) => Deno.env.get(name),
        createSupabaseClient: (url, key, options) => createClient(url, key, options),
      }),
  }),
);
