// suggest-paper-organization — AI-PROJECT-TAG-SUGGESTIONS-001A.
//
// Advisory only. It answers "which of this user's existing Projects/Tags fit
// this paper, and is anything new genuinely worth creating?" and returns
// suggestions. It creates nothing, assigns nothing and persists nothing: the
// user accepts or rejects each suggestion later, and the existing Project/Tag
// mutation paths remain the sole authority for any change to the library. The
// only writes it performs are the two pre-existing AI-quota RPCs
// (`consume_ai_quota` / `refund_ai_quota`) — this feature adds no second quota
// system, no new table and no migration.
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
//                   consumption/refund, the bounded provider retry budget
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
import { resolveGeminiModel } from "../_shared/geminiModel.ts";
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
      // see the caller's auth.uid(). No elevated key exists in this function.
      return createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      }) as unknown as CallerClient;
    },
    fetchImpl: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // Read at request time, not module load, so a missing secret surfaces as a
    // 500 response rather than a worker that cannot boot.
    getGeminiApiKey: () => Deno.env.get("GEMINI_API_KEY") ?? null,
    // The shared resolver, so this function and analyze-paper can never
    // silently disagree about which model is in use.
    getGeminiModel: () => resolveGeminiModel(Deno.env.get("GEMINI_MODEL")),
  }),
);
