// delete-account — PFA-C04 self-service, permanent account deletion.
//
// This is the ONLY privileged boundary in the feature. It is deliberately not a
// database RPC: the operation spans Auth *and* Storage, Storage binaries must be
// removed through the Storage API rather than by touching `storage.objects`, and
// the elevated key that authorizes Auth administration must never reach the
// browser or PostgREST.
//
// This file is only the Deno shell — it builds the two real Supabase clients and
// serves them to the handler. Every security decision (method gating, bearer
// extraction, the authoritative getUser(token) check, the server-side
// confirmation contract, Storage-before-Auth ordering, and the rule that the
// deletion target comes solely from the authenticated user) lives in the pure,
// Node-tested ./handler.ts, and the Storage enumeration/batching lives in the
// pure, Node-tested ../_shared/accountDeletion.ts.
//
// verify_jwt = false at the gateway is intentional and matches the repository's
// three existing functions: the bearer token is validated in-body instead.
//
// There is deliberately no `/// <reference types=".../edge-runtime.d.ts" />`
// directive here or in the modules this imports — see the note at the top of
// ../_shared/env.ts. Deno resolves type-only references when it builds the
// module graph, and the copy esm.sh currently serves pulls in a package whose
// type graph does not resolve, which prevents the worker from booting on the
// local Edge runtime. PFA-C04's destructive E2E has to invoke this function for
// real, so the graph is kept free of it.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireEdgeEnv } from "../_shared/env.ts";
import { selectEdgeSecretKey } from "../_shared/accountDeletion.ts";
import {
  handleDeleteAccountRequest,
  type AdminClient,
  type CallerAuthClient,
} from "./handler.ts";

Deno.serve((req) =>
  handleDeleteAccountRequest(req, {
    createCallerClient(token: string): CallerAuthClient {
      return createClient(
        requireEdgeEnv("SUPABASE_URL"),
        requireEdgeEnv("SUPABASE_ANON_KEY"),
        {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        },
      ) as unknown as CallerAuthClient;
    },

    createAdminClient(): AdminClient | null {
      // Prefer the current secret-key mechanism (`SUPABASE_SECRET_KEYS`, a JSON
      // dictionary keyed by key name) and fall back to the legacy
      // `SUPABASE_SERVICE_ROLE_KEY`. Both are auto-provided by the Edge runtime,
      // so no manually managed Production secret is required either way. The
      // key is never returned to the client, never placed in a response, and
      // never logged.
      const secretKey = selectEdgeSecretKey(
        Deno.env.get("SUPABASE_SECRET_KEYS"),
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
      );
      if (!secretKey) return null;

      return createClient(requireEdgeEnv("SUPABASE_URL"), secretKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as AdminClient;
    },
  }),
);
