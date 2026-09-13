-- AI-MULTI-PROVIDER-001D suite 017: provider-usage telemetry.
--
-- Owns the database half of migration 20260913120000:
--
--   * who can reach `ai_provider_usage_events` — no browser role at all, and
--     service_role INSERT alone — asserted as exact grants AND as real attempts,
--     so a policy or grant added later is caught by behaviour as well as by
--     catalog;
--   * that a browser cannot forge an event, read its own or another user's
--     events, or rewrite and delete them;
--   * that the one intended writer can append, and nothing more — not read back,
--     not update, not delete, not truncate;
--   * that the table's constraints refuse the lies telemetry must never tell:
--     unknown stored as zero, an estimate without usage, a subset larger than its
--     parent, an amount its own tokens and rates do not prove, another model's
--     price record, a success the provider did not complete, and any string
--     shaped like content;
--   * that no sequence, function, trigger or policy came with it.
--
-- The account-deletion cascade is pinned by suite 008 and the full client-role
-- matrix by suite 015; this suite does not repeat them.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials; no provider request. Everything rolls
-- back with the transaction.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers (same shape as 011/012/016) ─────────────────────────────────────
CREATE FUNCTION pg_temp.errcode_as(p_role text, p_claims text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  BEGIN
    EXECUTE p_sql;
    v_state := '00000';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_state;
END;
$hlp$;

-- The SQLSTATE of a statement run as the table owner.
CREATE FUNCTION pg_temp.errcode(p_sql text) RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_state text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    v_state := '00000';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  RETURN v_state;
END;
$hlp$;

-- The constraint a statement violated, or 'none' if it succeeded.
CREATE FUNCTION pg_temp.violated(p_sql text) RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_name text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    RETURN 'none';
  EXCEPTION WHEN check_violation OR not_null_violation OR foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_name = CONSTRAINT_NAME;
    RETURN COALESCE(v_name, 'unnamed');
  END;
END;
$hlp$;

CREATE FUNCTION pg_temp.claims(p_uid text) RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT '{"sub":"' || p_uid || '","role":"authenticated"}';
$hlp$;

-- A valid, fully estimated Gemini 3.6 Flash event for one user, with any column
-- overridden by `p_set` (a comma-separated list of `column = expression`). The
-- baseline row is exactly what the runtime builds for 1,200 input tokens (300
-- cached) and 190 output tokens (40 reasoning) at the 2026 list price.
CREATE FUNCTION pg_temp.event_sql(p_uid text, p_set text DEFAULT '') RETURNS text LANGUAGE sql IMMUTABLE AS $hlp$
  SELECT format($f$
    WITH base AS (
      SELECT '2026-10-01T12:00:00Z'::timestamptz AS occurred_at,
             %L::uuid AS user_id, 1::smallint AS telemetry_version,
             'analyze'::text AS operation, 'google'::text AS provider,
             'gemini-3.6-flash'::text AS provider_model,
             'system_default'::text AS model_selection_source,
             'automatic'::text AS reasoning_source, 'minimal'::text AS resolved_reasoning_level,
             'completed'::text AS provider_outcome, NULL::smallint AS provider_http_status,
             1::smallint AS provider_attempts, 'succeeded'::text AS operation_outcome,
             'reported'::text AS usage_status,
             1200 AS input_tokens, 300 AS cached_input_tokens, NULL::integer AS cache_write_input_tokens,
             190 AS output_tokens, 40 AS reasoning_output_tokens, 1390 AS provider_total_tokens,
             false AS has_unmodeled_usage,
             'estimated'::text AS cost_status, 0.001410000000000::numeric AS list_price_estimate_usd,
             'google/gemini-3.6-flash@2026-09-13'::text AS price_record_id,
             0.75::numeric AS input_usd_per_mtok, 0.075::numeric AS cached_input_usd_per_mtok,
             NULL::numeric AS cache_write_input_usd_per_mtok, 3.75::numeric AS output_usd_per_mtok
    ), row AS (SELECT * FROM base)
    INSERT INTO public.ai_provider_usage_events
      (occurred_at, user_id, telemetry_version, operation, provider, provider_model,
       model_selection_source, reasoning_source, resolved_reasoning_level,
       provider_outcome, provider_http_status, provider_attempts, operation_outcome,
       usage_status, input_tokens, cached_input_tokens, cache_write_input_tokens,
       output_tokens, reasoning_output_tokens, provider_total_tokens, has_unmodeled_usage,
       cost_status, list_price_estimate_usd, price_record_id, input_usd_per_mtok,
       cached_input_usd_per_mtok, cache_write_input_usd_per_mtok, output_usd_per_mtok)
    SELECT occurred_at, user_id, telemetry_version, operation, provider, provider_model,
           model_selection_source, reasoning_source, resolved_reasoning_level,
           provider_outcome, provider_http_status, provider_attempts, operation_outcome,
           usage_status, input_tokens, cached_input_tokens, cache_write_input_tokens,
           output_tokens, reasoning_output_tokens, provider_total_tokens, has_unmodeled_usage,
           cost_status, list_price_estimate_usd, price_record_id, input_usd_per_mtok,
           cached_input_usd_per_mtok, cache_write_input_usd_per_mtok, output_usd_per_mtok
      FROM (SELECT %s FROM row) AS r
  $f$, p_uid,
  -- Build the projection: every base column, with overrides replacing theirs.
  (SELECT string_agg(
            COALESCE((SELECT btrim(split_part(o, '=', 2)) || ' AS ' || c
                        FROM unnest(string_to_array(p_set, ';')) o
                       WHERE btrim(split_part(o, '=', 1)) = c
                       LIMIT 1),
                     c), ', ')
     FROM unnest(ARRAY[
       'occurred_at','user_id','telemetry_version','operation','provider','provider_model',
       'model_selection_source','reasoning_source','resolved_reasoning_level',
       'provider_outcome','provider_http_status','provider_attempts','operation_outcome',
       'usage_status','input_tokens','cached_input_tokens','cache_write_input_tokens',
       'output_tokens','reasoning_output_tokens','provider_total_tokens','has_unmodeled_usage',
       'cost_status','list_price_estimate_usd','price_record_id','input_usd_per_mtok',
       'cached_input_usd_per_mtok','cache_write_input_usd_per_mtok','output_usd_per_mtok']) AS c));
$hlp$;

SELECT plan(61);

-- A note on how section 5 is written. PostgreSQL evaluates a table's CHECK
-- constraints in NAME order and reports the first that fails, so each negative
-- row below breaks exactly ONE rule — where another rule would also object, the
-- row is first made legitimate in that respect (typically by marking it
-- unpriced). That is what lets each assertion name the constraint it proves.
-- Shorthand used by those rows: `UNPRICED` below means no amount, no record and
-- no rates.

-- ── Fixtures ────────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
  ('e4000000-0000-0000-0000-000000000001', 't017-alice@paperlume.test'),
  ('e4000000-0000-0000-0000-000000000002', 't017-bob@paperlume.test');

-- ════════════════════════════════════════════════════════════════════════════
-- 1. The object, and what came with it
-- ════════════════════════════════════════════════════════════════════════════

SELECT has_table('public', 'ai_provider_usage_events', 'ai_provider_usage_events exists');

SELECT is(
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
    WHERE oid = 'public.ai_provider_usage_events'::regclass),
  true, 'RLS is enabled AND forced');

SELECT is(
  (SELECT count(*)::int FROM pg_policy WHERE polrelid = 'public.ai_provider_usage_events'::regclass),
  0, 'no policy of any kind — no browser read path, no browser write path');

SELECT is(
  (SELECT count(*)::int FROM pg_trigger
    WHERE tgrelid = 'public.ai_provider_usage_events'::regclass AND NOT tgisinternal),
  0, 'no trigger');

SELECT is(
  (SELECT count(*)::int FROM pg_depend d JOIN pg_class s ON s.oid = d.objid
    WHERE d.refobjid = 'public.ai_provider_usage_events'::regclass AND s.relkind = 'S'),
  0, 'no sequence — ids are gen_random_uuid(), so there is no sequence grant to leak');

SELECT is(
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosrc ILIKE '%ai_provider_usage_events%'),
  0, 'no function in public touches the table — no RPC writer exists to be granted by mistake');

SELECT is(
  (SELECT string_agg(indexdef, ' | ' ORDER BY indexname) FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'ai_provider_usage_events'),
  'CREATE UNIQUE INDEX ai_provider_usage_events_pkey ON public.ai_provider_usage_events USING btree (id) | '
  || 'CREATE INDEX idx_ai_provider_usage_events_occurred_at ON public.ai_provider_usage_events USING btree (occurred_at) | '
  || 'CREATE INDEX idx_ai_provider_usage_events_user_occurred ON public.ai_provider_usage_events USING btree (user_id, occurred_at)',
  'exactly the primary key and the two justified indexes');

-- No column exists that could hold content.
SELECT is(
  (SELECT string_agg(attname, ',' ORDER BY attname) FROM pg_attribute
    WHERE attrelid = 'public.ai_provider_usage_events'::regclass AND attnum > 0 AND NOT attisdropped
      -- Whole underscore-delimited words, so `reasoning_source` is not a `reason`.
      AND attname ~* '(^|_)(title|abstract|keyword|keywords|project|tag|prompt|text|content|body|message|error|email|key|secret|session|url|note|reason|detail|details)(_|$)'),
  NULL, 'no column name suggests content, credentials or free text');

SELECT is(
  (SELECT count(*)::int FROM pg_attribute
    WHERE attrelid = 'public.ai_provider_usage_events'::regclass AND attnum > 0 AND NOT attisdropped
      AND atttypid IN ('json'::regtype, 'jsonb'::regtype, 'bytea'::regtype)),
  0, 'no JSON or binary column — no arbitrary provider payload can be stored');

SELECT is(
  (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
    WHERE attrelid = 'public.ai_provider_usage_events'::regclass AND attname = 'list_price_estimate_usd'),
  'numeric(24,15)', 'the estimate is exact decimal, never floating point');

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Exact privileges
-- ════════════════════════════════════════════════════════════════════════════

SELECT is(
  (SELECT coalesce(string_agg(
            CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type,
            ',' ORDER BY a.grantee::text, a.privilege_type), '')
     FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r'::"char", c.relowner))) a
    WHERE c.oid = 'public.ai_provider_usage_events'::regclass AND a.grantee <> c.relowner),
  'service_role:INSERT',
  'the whole non-owner ACL is service_role INSERT — every other grantee, named or not, holds nothing');

SELECT is(
  (SELECT count(*)::int FROM pg_attribute
    WHERE attrelid = 'public.ai_provider_usage_events'::regclass AND attacl IS NOT NULL),
  0, 'no column-level grant');

SELECT ok(
  NOT has_table_privilege('anon', 'public.ai_provider_usage_events', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
  'anon holds no effective privilege, PUBLIC inheritance included');
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.ai_provider_usage_events', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
  'authenticated holds no effective privilege, PUBLIC inheritance included');
SELECT ok(
  has_table_privilege('service_role', 'public.ai_provider_usage_events', 'INSERT')
  AND NOT has_table_privilege('service_role', 'public.ai_provider_usage_events', 'SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
  'service_role holds INSERT and nothing else');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Browsers cannot forge, read, rewrite or erase telemetry
-- ════════════════════════════════════════════════════════════════════════════

-- Two events planted as the owner, one per user, so reads and rewrites have a
-- real target and a "denied" cannot pass merely because the table is empty.
SELECT is(pg_temp.errcode(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001')), '00000',
  'fixture: a valid event for alice is accepted');
SELECT is(pg_temp.errcode(pg_temp.event_sql('e4000000-0000-0000-0000-000000000002')), '00000',
  'fixture: a valid event for bob is accepted');

SELECT is(pg_temp.errcode_as('anon', NULL, pg_temp.event_sql('e4000000-0000-0000-0000-000000000001')),
  '42501', 'anon cannot insert an event');
SELECT is(pg_temp.errcode_as('anon', NULL, 'SELECT count(*) FROM public.ai_provider_usage_events'),
  '42501', 'anon cannot read events');
SELECT is(pg_temp.errcode_as('anon', NULL, 'UPDATE public.ai_provider_usage_events SET input_tokens = 0'),
  '42501', 'anon cannot update events');
SELECT is(pg_temp.errcode_as('anon', NULL, 'DELETE FROM public.ai_provider_usage_events'),
  '42501', 'anon cannot delete events');

SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('e4000000-0000-0000-0000-000000000001'),
    pg_temp.event_sql('e4000000-0000-0000-0000-000000000001')),
  '42501', 'an authenticated user cannot forge an event for themselves');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('e4000000-0000-0000-0000-000000000001'),
    pg_temp.event_sql('e4000000-0000-0000-0000-000000000002', 'list_price_estimate_usd = 0')),
  '42501', 'an authenticated user cannot forge an event for someone else');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('e4000000-0000-0000-0000-000000000001'),
    $q$SELECT count(*) FROM public.ai_provider_usage_events WHERE user_id = 'e4000000-0000-0000-0000-000000000001'$q$),
  '42501', 'an authenticated user cannot read even their own events');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('e4000000-0000-0000-0000-000000000001'),
    $q$SELECT count(*) FROM public.ai_provider_usage_events WHERE user_id = 'e4000000-0000-0000-0000-000000000002'$q$),
  '42501', 'an authenticated user cannot read another user''s events');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('e4000000-0000-0000-0000-000000000001'),
    $q$UPDATE public.ai_provider_usage_events SET output_tokens = 0 WHERE user_id = 'e4000000-0000-0000-0000-000000000001'$q$),
  '42501', 'an authenticated user cannot rewrite their token counts');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('e4000000-0000-0000-0000-000000000001'),
    $q$DELETE FROM public.ai_provider_usage_events WHERE user_id = 'e4000000-0000-0000-0000-000000000001'$q$),
  '42501', 'an authenticated user cannot delete their events');
SELECT is(
  pg_temp.errcode_as('authenticated', pg_temp.claims('e4000000-0000-0000-0000-000000000001'),
    'TRUNCATE public.ai_provider_usage_events'),
  '42501', 'an authenticated user cannot truncate the table (RLS would not have stopped it)');

-- ════════════════════════════════════════════════════════════════════════════
-- 4. The server writer appends, and does nothing else
-- ════════════════════════════════════════════════════════════════════════════

SELECT is(pg_temp.errcode_as('service_role', NULL, pg_temp.event_sql('e4000000-0000-0000-0000-000000000001')),
  '00000', 'service_role can insert a valid event');
SELECT is(pg_temp.errcode_as('service_role', NULL, 'SELECT count(*) FROM public.ai_provider_usage_events'),
  '42501', 'service_role cannot read events back');
SELECT is(pg_temp.errcode_as('service_role', NULL, 'UPDATE public.ai_provider_usage_events SET output_tokens = 0'),
  '42501', 'service_role cannot rewrite an event');
SELECT is(pg_temp.errcode_as('service_role', NULL, 'DELETE FROM public.ai_provider_usage_events'),
  '42501', 'service_role cannot delete an event');
SELECT is(pg_temp.errcode_as('service_role', NULL, 'TRUNCATE public.ai_provider_usage_events'),
  '42501', 'service_role cannot truncate the record');

SELECT is((SELECT count(*)::int FROM public.ai_provider_usage_events), 3,
  'exactly the three accepted events exist — every refused write left nothing behind');

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Constraints refuse the lies telemetry must never tell
-- ════════════════════════════════════════════════════════════════════════════

-- Unknown is not zero.
SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$usage_status = 'absent'::text; cost_status = 'usage_unavailable'::text; list_price_estimate_usd = NULL::numeric; price_record_id = NULL::text; input_usd_per_mtok = NULL::numeric; cached_input_usd_per_mtok = NULL::numeric; output_usd_per_mtok = NULL::numeric$s$)),
  'ai_provider_usage_events_no_usage_no_tokens',
  'absent usage cannot carry token numbers (not even zeros)');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$usage_status = 'absent'::text; input_tokens = NULL::integer; cached_input_tokens = NULL::integer; output_usd_per_mtok = 3.75::numeric; output_tokens = NULL::integer; reasoning_output_tokens = NULL::integer; provider_total_tokens = NULL::integer$s$)),
  'ai_provider_usage_events_estimate_needs_usage',
  'an estimate cannot exist without the usage it was computed from');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$list_price_estimate_usd = 0::numeric$s$)),
  'ai_provider_usage_events_amount_arithmetic',
  'a zero amount is refused when the row''s own tokens and rates prove otherwise');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$list_price_estimate_usd = 0.001410000000001::numeric$s$)),
  'ai_provider_usage_events_amount_arithmetic',
  'an amount off by one femto-dollar is refused — the check is exact');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$cost_status = 'usage_unavailable'::text$s$)),
  'ai_provider_usage_events_amount_iff_estimated',
  'an amount cannot sit under a no-estimate status');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$provider_attempts = 2::smallint$s$)),
  'ai_provider_usage_events_estimated_is_complete',
  'more than one attempt cannot be called a complete estimate');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$cost_status = 'estimated_lower_bound'::text$s$)),
  'ai_provider_usage_events_lower_bound_has_reason',
  'a lower bound must have a reason to be one');

-- No double counting.
SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$reasoning_output_tokens = 191$s$)),
  'ai_provider_usage_events_reasoning_subset', 'reasoning cannot exceed output — it is inside it');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$cached_input_tokens = 1201; cost_status = 'unpriced'::text; list_price_estimate_usd = NULL::numeric; price_record_id = NULL::text; input_usd_per_mtok = NULL::numeric; cached_input_usd_per_mtok = NULL::numeric; output_usd_per_mtok = NULL::numeric$s$)),
  'ai_provider_usage_events_input_subsets', 'cached input cannot exceed input');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$cache_write_input_tokens = 901; cost_status = 'unpriced'::text; list_price_estimate_usd = NULL::numeric; price_record_id = NULL::text; input_usd_per_mtok = NULL::numeric; cached_input_usd_per_mtok = NULL::numeric; output_usd_per_mtok = NULL::numeric$s$)),
  'ai_provider_usage_events_input_subsets', 'cache reads and cache writes together cannot exceed input');

-- The amount here is exactly what the arithmetic yields with the cached rate
-- read as zero (900 x 0.75 + 190 x 3.75, per million), so the ONLY rule broken
-- is pricing 300 cached tokens with no cached rate on the row.
SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$cached_input_usd_per_mtok = NULL::numeric; list_price_estimate_usd = 0.001387500000000::numeric$s$)),
  'ai_provider_usage_events_priced_classes', 'cached tokens cannot be estimated without a cached rate');

-- The price snapshot belongs to this row's model.
SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$price_record_id = 'google/gemini-3.5-flash@2026-09-13'::text$s$)),
  'ai_provider_usage_events_record_matches_model', 'another model''s price record cannot be attached');

-- Rates and cached tokens are cleared as well, since rates without a record and
-- cached tokens without a cached rate are refused by rules of their own.
SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$price_record_id = NULL::text; input_usd_per_mtok = NULL::numeric; cached_input_usd_per_mtok = NULL::numeric; output_usd_per_mtok = NULL::numeric; cached_input_tokens = 0$s$)),
  'ai_provider_usage_events_record_iff_estimated', 'an estimate must name the price record it used');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$price_record_id = NULL::text; list_price_estimate_usd = NULL::numeric; cost_status = 'unpriced'::text$s$)),
  'ai_provider_usage_events_rates_need_record', 'rates cannot be stored without the price record they came from');

-- Outcome truthfulness.
SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$provider_outcome = 'timeout'::text$s$)),
  'ai_provider_usage_events_success_needs_completion', 'a user success requires a completed provider call');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$provider_attempts = 0::smallint$s$)),
  'ai_provider_usage_events_attempts', 'zero attempts is refused — no event exists without a provider call');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$provider_http_status = 503::smallint$s$)),
  'ai_provider_usage_events_http_status_iff_http_error', 'an HTTP status only accompanies an HTTP failure');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$resolved_reasoning_level = NULL::text$s$)),
  'ai_provider_usage_events_level_iff_policy', 'a policy-chosen reasoning source must record its level');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$output_tokens = -1; reasoning_output_tokens = NULL::integer; list_price_estimate_usd = NULL::numeric; cost_status = 'unpriced'::text; price_record_id = NULL::text; input_usd_per_mtok = NULL::numeric; cached_input_usd_per_mtok = NULL::numeric; output_usd_per_mtok = NULL::numeric$s$)),
  'ai_provider_usage_events_token_ranges', 'negative token counts are refused');

-- Nothing shaped like content fits a string column.
SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$provider_model = 'Protein timing and hypertrophy in trained adults'::text; cost_status = 'unpriced'::text; list_price_estimate_usd = NULL::numeric; price_record_id = NULL::text; input_usd_per_mtok = NULL::numeric; cached_input_usd_per_mtok = NULL::numeric; output_usd_per_mtok = NULL::numeric$s$)),
  'ai_provider_usage_events_provider_model_shape', 'a paper title cannot be stored as a model name');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$provider = 'someone@example.com'::text; cost_status = 'unpriced'::text; list_price_estimate_usd = NULL::numeric; price_record_id = NULL::text; input_usd_per_mtok = NULL::numeric; cached_input_usd_per_mtok = NULL::numeric; output_usd_per_mtok = NULL::numeric$s$)),
  'ai_provider_usage_events_provider_shape', 'an email cannot be stored as a provider');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$operation = 'export'::text$s$)),
  'ai_provider_usage_events_operation', 'only the two AI operations exist');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000001',
  $s$telemetry_version = 2::smallint$s$)),
  'ai_provider_usage_events_version', 'a semantics version the schema does not know is refused');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-00000000dead')),
  'ai_provider_usage_events_user_id_fkey', 'an event cannot name a user who does not exist');

-- The honest shapes are accepted.
SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000002',
  $s$provider_outcome = 'timeout'::text; operation_outcome = 'failed'::text; usage_status = 'absent'::text; input_tokens = NULL::integer; cached_input_tokens = NULL::integer; output_tokens = NULL::integer; reasoning_output_tokens = NULL::integer; provider_total_tokens = NULL::integer; cost_status = 'usage_unavailable'::text; list_price_estimate_usd = NULL::numeric; price_record_id = NULL::text; input_usd_per_mtok = NULL::numeric; cached_input_usd_per_mtok = NULL::numeric; output_usd_per_mtok = NULL::numeric$s$)),
  'none', 'a timeout with unknown usage and no amount is accepted');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000002',
  $s$provider = 'openai'::text; provider_model = 'gpt-5.6-terra'::text; reasoning_source = 'manual'::text; resolved_reasoning_level = 'xhigh'::text; provider_outcome = 'incomplete_response'::text; operation_outcome = 'failed'::text; usage_status = 'partial'::text; input_tokens = 300; cached_input_tokens = 0; output_tokens = 8192; reasoning_output_tokens = 8192; provider_total_tokens = 8492; cost_status = 'usage_incomplete'::text; list_price_estimate_usd = NULL::numeric; price_record_id = NULL::text; input_usd_per_mtok = NULL::numeric; cached_input_usd_per_mtok = NULL::numeric; output_usd_per_mtok = NULL::numeric$s$)),
  'none', 'an incomplete paid-provider generation keeps its usage without an amount');

SELECT is(pg_temp.violated(pg_temp.event_sql('e4000000-0000-0000-0000-000000000002',
  $s$provider_attempts = 3::smallint; cost_status = 'estimated_lower_bound'::text$s$)),
  'none', 'a multi-attempt call is accepted as a lower bound with the same exact amount');

SELECT * FROM finish();
ROLLBACK;
