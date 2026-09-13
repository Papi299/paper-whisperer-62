-- AI-MULTI-PROVIDER-001D — provider usage, token and cost-estimate telemetry.
--
-- One additive migration: a single append-only, server-written table that
-- records, for every PaperLume AI operation that reached a provider, which
-- provider and model served it, how many real provider requests it made, what
-- the provider itself reported about its token usage, and a list-price cost
-- estimate together with the exact rates that produced it.
--
-- What it deliberately does NOT do:
--   * It stores no content. No prompt, title, abstract, keyword, Project, Tag,
--     generated text, provider body, provider error, email, token or key has a
--     column here, and every free-form-looking column is shape-constrained so
--     one cannot be smuggled in.
--   * It is not a price table and not an invoice. The only money column is a
--     list-price ESTIMATE; the rates that produced it are copied onto the row,
--     so no later price change can re-price history (see section 2).
--   * It changes no quota. One successful AI invocation is still one PaperLume
--     AI request, whatever it cost; provider cost and PaperLume quota are
--     different ledgers and nothing here reads or writes `usage_counters`.
--   * It adds no catalog row, no provider, no credential, no function and no
--     client-facing surface. Browsers can neither read nor write it.
--   * It mutates no existing table and backfills nothing.
--
-- Conventions reused:
--   * ENABLE + FORCE ROW LEVEL SECURITY (20260412030000).
--   * Data API privileges stated, never inherited — REVOKE by role, then GRANT
--     the exact surface (D2 / C38, 20260910212202), asserted below.
--   * ON DELETE CASCADE from auth.users, so account deletion removes a user's
--     telemetry with everything else they own (suite 008).


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. ai_provider_usage_events
-- ═════════════════════════════════════════════════════════════════════════════
--
-- One row per provider-call SEQUENCE (one PaperLume operation that reached a
-- provider), not per HTTP request: `provider_attempts` counts the real requests
-- inside it, so the schema stays correct whether a transport retries or not.
--
-- NULL means NOT KNOWN — never zero. A token column is NULL when the provider
-- did not report that dimension, or when its protocol has no such dimension;
-- `usage_status` says which (under 'reported', a NULL can only be the latter).
-- A cost column is NULL whenever `cost_status` says no estimate exists.

CREATE TABLE public.ai_provider_usage_events (
    id                             UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    occurred_at                    TIMESTAMPTZ NOT NULL,
    recorded_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id                        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    telemetry_version              SMALLINT NOT NULL,

    -- Routing and policy context: server-derived, bounded, public.
    operation                      TEXT NOT NULL,
    provider                       TEXT NOT NULL,
    provider_model                 TEXT NOT NULL,
    model_selection_source         TEXT NOT NULL,
    reasoning_source               TEXT NOT NULL,
    resolved_reasoning_level       TEXT,

    -- Outcome.
    provider_outcome               TEXT NOT NULL,
    provider_http_status           SMALLINT,
    provider_attempts              SMALLINT NOT NULL,
    operation_outcome              TEXT NOT NULL,

    -- Provider-reported usage, in PaperLume's canonical dimensions.
    usage_status                   TEXT NOT NULL,
    input_tokens                   INTEGER,
    cached_input_tokens            INTEGER,
    cache_write_input_tokens       INTEGER,
    output_tokens                  INTEGER,
    reasoning_output_tokens        INTEGER,
    provider_total_tokens          INTEGER,
    has_unmodeled_usage            BOOLEAN NOT NULL,

    -- List-price estimate, and the exact rates it used.
    cost_status                    TEXT NOT NULL,
    list_price_estimate_usd        NUMERIC(24, 15),
    price_record_id                TEXT,
    input_usd_per_mtok             NUMERIC(18, 9),
    cached_input_usd_per_mtok      NUMERIC(18, 9),
    cache_write_input_usd_per_mtok NUMERIC(18, 9),
    output_usd_per_mtok            NUMERIC(18, 9),

    -- ── Vocabulary ─────────────────────────────────────────────────────────
    CONSTRAINT ai_provider_usage_events_version
        CHECK (telemetry_version = 1),
    CONSTRAINT ai_provider_usage_events_operation
        CHECK (operation IN ('analyze', 'suggest')),
    -- Shapes, not lists: a fourth provider needs no migration here, and no
    -- string that could carry content (spaces, '@', quotes) fits either shape.
    CONSTRAINT ai_provider_usage_events_provider_shape
        CHECK (provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
    CONSTRAINT ai_provider_usage_events_provider_model_shape
        CHECK (provider_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
    CONSTRAINT ai_provider_usage_events_selection_source
        CHECK (model_selection_source IN ('system_default', 'user_preference')),
    CONSTRAINT ai_provider_usage_events_reasoning_source
        CHECK (reasoning_source IN ('automatic', 'manual', 'provider_default_fallback')),
    CONSTRAINT ai_provider_usage_events_reasoning_level
        CHECK (resolved_reasoning_level IS NULL OR resolved_reasoning_level IN
               ('minimal', 'off', 'none', 'low', 'medium', 'high', 'xhigh', 'max')),
    -- A level is recorded exactly when PaperLume's policy chose one; the
    -- provider-default fallback sends no reasoning parameter at all.
    CONSTRAINT ai_provider_usage_events_level_iff_policy
        CHECK ((reasoning_source = 'provider_default_fallback') = (resolved_reasoning_level IS NULL)),

    -- ── Outcome ────────────────────────────────────────────────────────────
    CONSTRAINT ai_provider_usage_events_provider_outcome
        CHECK (provider_outcome IN ('completed', 'http_error', 'network_error', 'timeout',
                                    'unreadable_response', 'empty_response', 'incomplete_response')),
    CONSTRAINT ai_provider_usage_events_http_status_range
        CHECK (provider_http_status IS NULL OR provider_http_status BETWEEN 100 AND 599),
    CONSTRAINT ai_provider_usage_events_http_status_iff_http_error
        CHECK ((provider_outcome = 'http_error') = (provider_http_status IS NOT NULL)),
    -- At least one: no row exists for a request that never reached a provider.
    CONSTRAINT ai_provider_usage_events_attempts
        CHECK (provider_attempts BETWEEN 1 AND 10),
    CONSTRAINT ai_provider_usage_events_operation_outcome
        CHECK (operation_outcome IN ('succeeded', 'failed')),
    CONSTRAINT ai_provider_usage_events_success_needs_completion
        CHECK (operation_outcome = 'failed' OR provider_outcome = 'completed'),

    -- ── Usage ──────────────────────────────────────────────────────────────
    CONSTRAINT ai_provider_usage_events_usage_status
        CHECK (usage_status IN ('reported', 'partial', 'absent', 'rejected')),
    CONSTRAINT ai_provider_usage_events_token_ranges
        CHECK (    (input_tokens             IS NULL OR input_tokens             BETWEEN 0 AND 100000000)
               AND (cached_input_tokens      IS NULL OR cached_input_tokens      BETWEEN 0 AND 100000000)
               AND (cache_write_input_tokens IS NULL OR cache_write_input_tokens BETWEEN 0 AND 100000000)
               AND (output_tokens            IS NULL OR output_tokens            BETWEEN 0 AND 100000000)
               AND (reasoning_output_tokens  IS NULL OR reasoning_output_tokens  BETWEEN 0 AND 100000000)
               AND (provider_total_tokens    IS NULL OR provider_total_tokens    BETWEEN 0 AND 100000000)),
    -- No usage means no numbers: an absent or rejected report is stored as
    -- unknown, never as zeros.
    CONSTRAINT ai_provider_usage_events_no_usage_no_tokens
        CHECK (usage_status IN ('reported', 'partial')
               OR (    input_tokens IS NULL AND cached_input_tokens IS NULL
                   AND cache_write_input_tokens IS NULL AND output_tokens IS NULL
                   AND reasoning_output_tokens IS NULL AND provider_total_tokens IS NULL
                   AND NOT has_unmodeled_usage)),
    -- Every provider has input and output, so a complete report has both.
    CONSTRAINT ai_provider_usage_events_reported_has_io
        CHECK (usage_status <> 'reported' OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL)),
    -- Cache reads and cache writes are DISJOINT subsets of input.
    CONSTRAINT ai_provider_usage_events_input_subsets
        CHECK (input_tokens IS NULL
               OR (    (cached_input_tokens IS NULL OR cached_input_tokens <= input_tokens)
                   AND (cache_write_input_tokens IS NULL OR cache_write_input_tokens <= input_tokens)
                   AND COALESCE(cached_input_tokens, 0) + COALESCE(cache_write_input_tokens, 0) <= input_tokens)),
    -- Reasoning is a subset of output, never an addition to it.
    CONSTRAINT ai_provider_usage_events_reasoning_subset
        CHECK (output_tokens IS NULL OR reasoning_output_tokens IS NULL
               OR reasoning_output_tokens <= output_tokens),

    -- ── Cost estimate ──────────────────────────────────────────────────────
    CONSTRAINT ai_provider_usage_events_cost_status
        CHECK (cost_status IN ('estimated', 'estimated_lower_bound',
                               'usage_unavailable', 'usage_incomplete', 'unpriced')),
    -- An amount, a price record and base rates exist together or not at all.
    CONSTRAINT ai_provider_usage_events_amount_iff_estimated
        CHECK ((cost_status IN ('estimated', 'estimated_lower_bound')) = (list_price_estimate_usd IS NOT NULL)),
    CONSTRAINT ai_provider_usage_events_record_iff_estimated
        CHECK ((cost_status IN ('estimated', 'estimated_lower_bound')) = (price_record_id IS NOT NULL)),
    CONSTRAINT ai_provider_usage_events_rates_need_record
        CHECK (price_record_id IS NOT NULL
               OR (    input_usd_per_mtok IS NULL AND cached_input_usd_per_mtok IS NULL
                   AND cache_write_input_usd_per_mtok IS NULL AND output_usd_per_mtok IS NULL)),
    CONSTRAINT ai_provider_usage_events_record_has_base_rates
        CHECK (price_record_id IS NULL OR (input_usd_per_mtok IS NOT NULL AND output_usd_per_mtok IS NOT NULL)),
    CONSTRAINT ai_provider_usage_events_rate_ranges
        CHECK (    (input_usd_per_mtok             IS NULL OR input_usd_per_mtok             BETWEEN 0 AND 100000)
               AND (cached_input_usd_per_mtok      IS NULL OR cached_input_usd_per_mtok      BETWEEN 0 AND 100000)
               AND (cache_write_input_usd_per_mtok IS NULL OR cache_write_input_usd_per_mtok BETWEEN 0 AND 100000)
               AND (output_usd_per_mtok            IS NULL OR output_usd_per_mtok            BETWEEN 0 AND 100000)),
    CONSTRAINT ai_provider_usage_events_amount_nonneg
        CHECK (list_price_estimate_usd IS NULL OR list_price_estimate_usd >= 0),
    CONSTRAINT ai_provider_usage_events_price_record_shape
        CHECK (price_record_id IS NULL
               OR price_record_id ~ '^[a-z][a-z0-9_-]{0,31}/[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}@[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    -- The price record must be THIS row's provider model: another model's
    -- rates can never be attached to an event.
    CONSTRAINT ai_provider_usage_events_record_matches_model
        CHECK (price_record_id IS NULL
               OR left(price_record_id, char_length(provider) + char_length(provider_model) + 2)
                  = provider || '/' || provider_model || '@'),
    -- An estimate needs the usage it was computed from.
    CONSTRAINT ai_provider_usage_events_estimate_needs_usage
        CHECK (cost_status NOT IN ('estimated', 'estimated_lower_bound')
               OR (usage_status IN ('reported', 'partial')
                   AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL)),
    -- Tokens in a rate class are never priced at a rate the row does not hold.
    CONSTRAINT ai_provider_usage_events_priced_classes
        CHECK (cost_status NOT IN ('estimated', 'estimated_lower_bound')
               OR (    (COALESCE(cached_input_tokens, 0) = 0 OR cached_input_usd_per_mtok IS NOT NULL)
                   AND (COALESCE(cache_write_input_tokens, 0) = 0 OR cache_write_input_usd_per_mtok IS NOT NULL))),
    -- The row proves its own amount. Exact numeric arithmetic, multiplied
    -- rather than divided so no rounding can enter:
    --   amount x 1,000,000 = uncached x input + cached x cached_input
    --                      + cache_write x cache_write_input + output x output
    -- Reasoning is inside output and the provider total is never used, so
    -- nothing is counted twice.
    CONSTRAINT ai_provider_usage_events_amount_arithmetic
        CHECK (list_price_estimate_usd IS NULL
               OR list_price_estimate_usd * 1000000
                  = (input_tokens - COALESCE(cached_input_tokens, 0) - COALESCE(cache_write_input_tokens, 0))
                        * input_usd_per_mtok
                    + COALESCE(cached_input_tokens, 0) * COALESCE(cached_input_usd_per_mtok, 0)
                    + COALESCE(cache_write_input_tokens, 0) * COALESCE(cache_write_input_usd_per_mtok, 0)
                    + output_tokens * output_usd_per_mtok),
    -- 'estimated' means nothing is known to be missing; a lower bound must say
    -- why it is one.
    CONSTRAINT ai_provider_usage_events_estimated_is_complete
        CHECK (cost_status <> 'estimated' OR (provider_attempts = 1 AND NOT has_unmodeled_usage)),
    CONSTRAINT ai_provider_usage_events_lower_bound_has_reason
        CHECK (cost_status <> 'estimated_lower_bound' OR provider_attempts > 1 OR has_unmodeled_usage)
);

COMMENT ON TABLE public.ai_provider_usage_events IS
    'One row per PaperLume AI operation that reached a provider (analyze or '
    'suggest): provider, public model, reasoning policy, bounded outcome, real '
    'provider attempt count, provider-REPORTED token usage in canonical '
    'dimensions, and a list-price cost ESTIMATE with the exact rates used. '
    'Server-written only (service_role INSERT, nothing else); unreadable and '
    'unwritable by browsers; content-free by construction; deleted with the '
    'account. NULL token/cost values mean NOT KNOWN, never zero. Not an invoice '
    'and not a quota ledger. AI-MULTI-PROVIDER-001D; see decisions C42.';

COMMENT ON COLUMN public.ai_provider_usage_events.occurred_at IS
    'When the provider-call sequence finished; also the instant the list price '
    'was looked up for.';
COMMENT ON COLUMN public.ai_provider_usage_events.provider_attempts IS
    'Real provider requests made inside this one operation (retries included). '
    'Always >= 1: requests refused before a provider call are not recorded.';
COMMENT ON COLUMN public.ai_provider_usage_events.operation_outcome IS
    'Whether the user received a result. Distinct from provider_outcome: a '
    'provider can complete and the answer still be unusable.';
COMMENT ON COLUMN public.ai_provider_usage_events.usage_status IS
    'reported = every dimension the provider protocol has was reported (a NULL '
    'token column is then a dimension that protocol lacks); partial = some were '
    'not; absent = no usage returned (network, timeout, HTTP error, unreadable '
    'or usage-less body); rejected = usage failed validation and none is kept.';
COMMENT ON COLUMN public.ai_provider_usage_events.input_tokens IS
    'All input the provider processed, INCLUDING cached_input_tokens and '
    'cache_write_input_tokens, which are disjoint subsets of it.';
COMMENT ON COLUMN public.ai_provider_usage_events.output_tokens IS
    'All output the provider billed, INCLUDING reasoning_output_tokens (a subset).';
COMMENT ON COLUMN public.ai_provider_usage_events.provider_total_tokens IS
    'The provider''s own total, exactly as reported. Informational only: never '
    'summed, never used to price anything.';
COMMENT ON COLUMN public.ai_provider_usage_events.has_unmodeled_usage IS
    'The provider reported billable work in a dimension these columns do not '
    'price (e.g. a 1-hour cache write, a server tool). Any estimate is then a '
    'lower bound.';
COMMENT ON COLUMN public.ai_provider_usage_events.list_price_estimate_usd IS
    'ESTIMATED cost in USD at the provider''s published standard paid-tier list '
    'price for the reported usage — NOT an invoice, charge or actual spend. May '
    'be non-zero for a request that cost nothing (e.g. on a provider free tier). '
    'Proven by the row''s own CHECK from its tokens and rates.';
COMMENT ON COLUMN public.ai_provider_usage_events.cost_status IS
    'estimated = exact list-price amount, nothing known missing; '
    'estimated_lower_bound = exact for what was reported, but more than one '
    'attempt or unmodeled usage means the true cost may be higher; '
    'usage_unavailable / usage_incomplete / unpriced = no amount, for that reason.';
COMMENT ON COLUMN public.ai_provider_usage_events.price_record_id IS
    'The list-price record the estimate used (<provider>/<model>@<date>, from '
    'supabase/functions/_shared/aiPriceBook.ts). The rates are copied onto the '
    'row, so a later price change never re-prices history.';

-- Time-range aggregation (cost or tokens by day, provider, model, operation).
CREATE INDEX idx_ai_provider_usage_events_occurred_at
    ON public.ai_provider_usage_events (occurred_at);

-- Per-user queries, and the lookup ON DELETE CASCADE performs when an account
-- is deleted.
CREATE INDEX idx_ai_provider_usage_events_user_occurred
    ON public.ai_provider_usage_events (user_id, occurred_at);

ALTER TABLE public.ai_provider_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_provider_usage_events FORCE ROW LEVEL SECURITY;

-- No policy of any kind. Browsers have no read path (there is no telemetry UI)
-- and must never have a write path: a policy proving user_id = auth.uid() would
-- prove ownership, not truthfulness, and would let any signed-in user forge
-- tokens, cost or provider. The one writer is service_role, which bypasses RLS
-- and is limited by the grant below instead.


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Data API privileges — REVOKE by role, then the exact surface
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Hosted Production's default privileges give a new table
-- service_role=arwdDxtm; a clean local replay gives it the TRUNCATE/REFERENCES/
-- TRIGGER/MAINTAIN residue. Neither is intended, so both are removed first.
--
--   * PUBLIC, anon, authenticated: nothing. No browser can read, insert,
--     update, delete or truncate a telemetry row.
--   * service_role: INSERT, and only INSERT. It is the credential the two
--     generation Edge Functions use for this one write. It cannot read the
--     table back, rewrite a row, delete one or truncate the table, so a leaked
--     key cannot erase or doctor the record either. Account deletion does not
--     need a grant: the FK cascade runs as the table owner.
--
-- Rows are therefore append-only for every role but the owner. Reading them is
-- an owner/operator activity (SQL as postgres), not an application path.

REVOKE ALL ON TABLE public.ai_provider_usage_events
    FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT ON TABLE public.ai_provider_usage_events TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Fail-closed self-check
-- ═════════════════════════════════════════════════════════════════════════════
DO $verify$
DECLARE
  v_rel        CONSTANT regclass := 'public.ai_provider_usage_events'::regclass;
  v_row        RECORD;
  v_text       TEXT;
  v_priv       TEXT;
BEGIN
  SELECT c.relrowsecurity, c.relforcerowsecurity INTO v_row
    FROM pg_class c WHERE c.oid = v_rel;
  IF NOT v_row.relrowsecurity OR NOT v_row.relforcerowsecurity THEN
    RAISE EXCEPTION 'ai_usage_telemetry: RLS is not enabled AND forced on ai_provider_usage_events';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_rel) THEN
    RAISE EXCEPTION 'ai_usage_telemetry: ai_provider_usage_events must have no policy';
  END IF;

  -- Allowlist over the whole ACL: only the owner and service_role may appear,
  -- and service_role may hold INSERT alone. A grantee nobody named fails here.
  SELECT coalesce(string_agg(
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type,
           ',' ORDER BY a.grantee::text, a.privilege_type), '')
    INTO v_text
    FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r'::"char", c.relowner))) a
   WHERE c.oid = v_rel
     AND a.grantee <> c.relowner
     AND NOT (a.grantee = to_regrole('service_role')::oid AND a.privilege_type = 'INSERT');
  IF v_text <> '' THEN
    RAISE EXCEPTION 'ai_usage_telemetry: unexpected privileges on ai_provider_usage_events: %', v_text;
  END IF;

  IF NOT has_table_privilege('service_role', v_rel, 'INSERT') THEN
    RAISE EXCEPTION 'ai_usage_telemetry: service_role cannot INSERT into ai_provider_usage_events';
  END IF;

  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
    IF has_table_privilege('anon', v_rel, v_priv) OR has_table_privilege('authenticated', v_rel, v_priv) THEN
      RAISE EXCEPTION 'ai_usage_telemetry: a browser role holds % on ai_provider_usage_events', v_priv;
    END IF;
    IF v_priv <> 'INSERT' AND has_table_privilege('service_role', v_rel, v_priv) THEN
      RAISE EXCEPTION 'ai_usage_telemetry: service_role holds % on ai_provider_usage_events', v_priv;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = v_rel AND attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'ai_usage_telemetry: ai_provider_usage_events carries a column-level grant';
  END IF;

  -- The account-deletion lifecycle: user_id cascades from auth.users.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.conrelid = v_rel AND c.contype = 'f' AND c.confrelid = 'auth.users'::regclass
       AND array_length(c.conkey, 1) = 1 AND a.attname = 'user_id' AND c.confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'ai_usage_telemetry: user_id does not cascade from auth.users';
  END IF;

  IF (SELECT count(*) FROM public.ai_provider_usage_events) <> 0 THEN
    RAISE EXCEPTION 'ai_usage_telemetry: the migration must not create any row';
  END IF;
END
$verify$;
