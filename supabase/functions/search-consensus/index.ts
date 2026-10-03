// search-consensus — CONSENSUS-SEARCH-MVP-001A owner-only Consensus discovery.
//
// Read-only. It answers "which papers does Consensus suggest for this research
// question?" and nothing else: no insert, no update, no Project/Tag mutation
// and no AI call. Consensus results are display-only discovery data; the only
// value that may reach the library is a validated DOI, which the owner imports
// afterwards through the existing canonical path (`fetch-paper-metadata` →
// PubMed/Crossref provenance checks → normalization → duplicate handling →
// `safe_bulk_insert_papers`). Consensus is never a metadata authority.
//
// This file is only the Deno shell — it builds the caller-scoped Supabase
// client, exposes the server-side CONSENSUS_API_KEY reader and `fetch`, and
// serves the handler. Every decision that matters lives in the pure,
// Node-tested ./handler.ts (CORS before auth, method gating, the authoritative
// getUser() check, the owner-only role check, request validation, the key read
// after authorization, the single un-retried upstream call, safe error mapping,
// bounded logging) and ../_shared/consensusSearch.ts (validation bounds, URL
// construction, the DOI and link boundaries, response parsing).
//
// verify_jwt = false at the gateway is intentional and matches the
// repository's other functions: the bearer token is validated in-body instead,
// so a CORS preflight and a stale/refreshing token are handled by the
// function's own logic rather than refused before it runs. It does NOT mean
// anonymous access — auth.getUser() is the authentication boundary, and the
// owner role is re-checked server-side on every request.
//
// CONSENSUS_API_KEY is a Supabase Edge secret read server-side only. It is
// never logged, never returned and never placed in a URL; the browser never
// sees it. It is read lazily, by the handler, only after the caller has been
// authorized as the owner — so an unauthenticated or non-owner request never
// even touches it.
//
// There is deliberately no `/// <reference types=".../edge-runtime.d.ts" />`
// directive here or in the modules this imports — see the note at the top of
// ../_shared/env.ts.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireEdgeEnv } from "../_shared/env.ts";
import { handleSearchConsensusRequest, type CallerClient } from "./handler.ts";

Deno.serve((req) =>
  handleSearchConsensusRequest(req, {
    createCallerClient(authHeader: string): CallerClient {
      // Fail fast with an actionable error if either runtime-required value is
      // missing. Auto-injected by the Supabase Edge runtime in production.
      const supabaseUrl = requireEdgeEnv("SUPABASE_URL");
      const supabaseAnonKey = requireEdgeEnv("SUPABASE_ANON_KEY");
      // Anon key + the caller's own Authorization header: the role check runs
      // AS THE CALLER, and no elevated key exists anywhere in this function.
      return createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      }) as unknown as CallerClient;
    },
    readApiKey: () => Deno.env.get("CONSENSUS_API_KEY"),
    fetchImpl: (url, init) => fetch(url, init),
  }),
);
