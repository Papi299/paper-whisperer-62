// search-pubmed — PUBMED-IN-APP-SEARCH-001 in-app PubMed discovery.
//
// Read-only. It answers "which PubMed records match this query?" and nothing
// else: no insert, no update, no Project/Tag mutation, no AI call and no quota
// consumption. The papers a user selects are imported afterwards by the
// existing canonical path (`fetch-paper-metadata` → normalization →
// `safe_bulk_insert_papers`), which stays the sole authority for persisted
// paper metadata. A discovery summary is never persisted.
//
// This file is only the Deno shell — it builds the caller-scoped Supabase
// client and serves it to the handler. Every decision that matters lives in the
// pure, Node-tested ./handler.ts (CORS before auth, method gating, the
// authoritative getUser() check, request validation, the server-side API-key
// read, the bounded upstream retry budget) and in the pure, Node-tested
// ../_shared/pubmedSearch.ts (validation bounds, URL construction, ESearch and
// ESummary parsing).
//
// verify_jwt = false at the gateway is intentional and matches the
// repository's four existing functions: the bearer token is validated in-body
// instead, so a stale/refreshing token and a CORS preflight are handled by the
// function's own logic rather than being refused before it runs. The in-code
// auth.getUser() remains authoritative.
//
// There is deliberately no `/// <reference types=".../edge-runtime.d.ts" />`
// directive here or in the modules this imports — see the note at the top of
// ../_shared/env.ts. Deno resolves type-only references when it builds the
// module graph, and the copy esm.sh currently serves pulls in a package whose
// type graph does not resolve, which prevents the worker from booting on the
// local Edge runtime.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireEdgeEnv } from "../_shared/env.ts";
import { handleSearchPubMedRequest, type CallerClient } from "./handler.ts";

Deno.serve((req) =>
  handleSearchPubMedRequest(req, {
    createCallerClient(authHeader: string): CallerClient {
      // Fail fast with an actionable error if either runtime-required value is
      // missing, rather than letting an empty string fall through into a broken
      // client. Auto-injected by the Supabase Edge runtime in production.
      const supabaseUrl = requireEdgeEnv("SUPABASE_URL");
      const supabaseAnonKey = requireEdgeEnv("SUPABASE_ANON_KEY");
      // Anon key + the caller's own Authorization header: every read this
      // function performs is subject to the caller's RLS, and no elevated key
      // exists anywhere in this function.
      return createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      }) as unknown as CallerClient;
    },
    fetchImpl: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }),
);
