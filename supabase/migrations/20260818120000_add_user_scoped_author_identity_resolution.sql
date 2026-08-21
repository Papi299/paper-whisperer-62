-- AUTHOR-IDENTITY-RESOLUTION-001C — user-scoped author identity resolution.
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────────────────────────────────────────────────────────
-- The author objective has three deliberately separate layers, and this is the
-- third and last of them:
--
--   001A  `authorMentionKey` — are two author *strings* the same mention written
--         differently? A textual fold. Never a person.
--   001B  `papers.author_provenance` — what did the bibliographic source
--         actually *state* about this mention? Given/family components,
--         affiliations, a checksum-valid ORCID. Still never a person: a
--         matching ORCID is a value two sources supplied, not a claim that
--         Paperlume resolved a human.
--   001C  this migration — has THIS user explicitly decided that one or more
--         authorship mentions are the same person?
--
-- 001C is therefore the first layer permitted to create a durable person-level
-- grouping, and the single rule it is built around is:
--
--     Paperlume may SUGGEST an identity relationship from deterministic
--     evidence. It must never silently ASSERT one.
--
-- Everything below follows from that sentence. There is no backfill, no
-- import-time resolution, no background linker, no probabilistic score, and no
-- path by which an identity row can come into existence except an explicit user
-- action taken after this migration is deployed. A fresh replay and Production
-- alike start with four empty tables.
--
-- USER-SCOPED, NOT A RESEARCHER GRAPH
-- ─────────────────────────────────────────────────────────────────────────────
-- An identity belongs to exactly one Paperlume user. Two users may reach
-- different, equally valid conclusions about the same ORCID or the same name,
-- and neither may observe or influence the other's decision. So there is no
-- global uniqueness on a name, no global uniqueness on an ORCID, no shared
-- person record, and no cross-user candidate generation. The `user_id` column
-- is not decoration: every foreign key below is COMPOSITE on `(user_id, …)`,
-- which makes a cross-user edge structurally unrepresentable rather than merely
-- forbidden by policy. That claim covers all five edges in the graph —
--
--     alias  → identity          (user_id, identity_id)
--     link   → identity          (user_id, identity_id)
--     link   → paper             (user_id, paper_id)
--     merge  → source identity   (user_id, source_identity_id)
--     merge  → target identity   (user_id, target_identity_id)
--
-- — and the third of them is why section 0 below exists.
--
-- WHAT IS NOT MODELLED HERE
-- ─────────────────────────────────────────────────────────────────────────────
--   * No normalized row per authorship mention. `papers.authors` and
--     `papers.author_provenance` remain THE source of mentions; 001C stores
--     only the user's decisions *about* them.
--   * No ORCID column on the identity row. An identity's ORCID evidence is
--     derived at read time from its currently linked mentions, so it can never
--     drift from, or outlive, the provenance it came from.
--   * No affiliation, biography, profile, confidence score or AI field.
--   * No external person record and no provider lookup.
--
-- EXPAND-FIRST / ROLLOUT SAFETY
-- ─────────────────────────────────────────────────────────────────────────────
-- Additive. Four new tables, one new unique constraint on `papers`, one new
-- trigger on `papers`, and eight new functions. No existing table, column,
-- constraint, policy, grant, function or row is altered or dropped, and no
-- historical migration is touched. The migration may therefore be applied to
-- Production BEFORE the frontend that uses it is merged: the current frontend
-- neither reads nor writes any of it, and the one behavioural change visible to
-- old code — the author-change trigger — can only delete rows in a table that
-- did not exist a moment ago and is empty.
--
-- The one lock worth naming is in section 0. `ALTER TABLE public.papers ADD
-- CONSTRAINT … UNIQUE` takes ACCESS EXCLUSIVE on `papers` and builds an index
-- under it, so writes to `papers` wait for the duration of one index build.
-- `CREATE UNIQUE INDEX CONCURRENTLY` would avoid that but cannot run inside a
-- transaction, and a migration that half-applies is a worse problem than a brief
-- pause. Apply it like any other index-building migration: off peak, and expect
-- the wait to scale with the row count.

-- ═════════════════════════════════════════════════════════════════════════════
-- 0. papers (user_id, id) — the ownership key the link table references
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `papers.id` is already globally unique, so this constraint forbids nothing
-- that was previously legal and accepts every row that already exists. It is not
-- here to constrain `papers`. It is here because a composite foreign key needs a
-- composite key to point at, and without one the identity→paper edge cannot be
-- made user-scoped.
--
-- WHY THAT MATTERS. `author_identity_links` carries `user_id`, `identity_id` and
-- `paper_id`. The identity side is already composite, so a link can never name
-- another user's identity. The paper side, referencing `papers(id)` alone, was
-- not — which left this state STORABLE by a privileged or direct write:
--
--     user_id     = User A
--     identity_id = User A's identity      ✓ same account
--     paper_id    = User B's paper         ✗ different account
--
-- The RPCs reject it, RLS hides it, and no application path produces it. But
-- "the application will not write it" is a weaker guarantee than "the database
-- cannot hold it", and the header above claims the stronger one. Pointing the
-- edge at `papers (user_id, id)` makes the claim literally true: the row is
-- rejected with a foreign-key violation before any policy is consulted, whoever
-- is writing and whatever they have bypassed.
ALTER TABLE public.papers
    ADD CONSTRAINT papers_user_id_id_key UNIQUE (user_id, id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. author_identities — the user's own person record
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `preferred_name` is deliberately NOT unique, not even per user. Two people
-- genuinely share a name, and a uniqueness rule here would force the user to
-- disambiguate a display label before they have decided anything about the
-- people — exactly the silent assertion this feature exists to avoid.
CREATE TABLE public.author_identities (
    id             UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    preferred_name TEXT NOT NULL,
    created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

    -- A blank display label is not a person the user can recognise later.
    CONSTRAINT author_identities_preferred_name_nonblank
        CHECK (btrim(preferred_name) <> ''),

    -- Redundant against the primary key on its own, and load-bearing anyway:
    -- it is the target every composite `(user_id, identity_id)` foreign key
    -- below points at. That is what makes an alias, a link or a merge edge
    -- reaching across two accounts impossible to *store*, not merely impossible
    -- to reach through the API. It also indexes `user_id` as its leading
    -- column, so no separate per-user index is needed.
    CONSTRAINT author_identities_user_id_id_key UNIQUE (user_id, id)
);

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. author_identity_aliases — additional names the USER asserts
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Aliases are user assertions, never derived data. The spellings of the mentions
-- already linked to an identity are available from `author_identity_links` +
-- `papers` and are deliberately NOT duplicated here; an alias row exists only
-- for a name the user typed that no linked mention supplies.
--
-- Not unique, globally or per identity: the same alias may legitimately belong
-- to two different people, and forbidding that would encode a one-name-one-
-- person rule this feature exists to reject. Adding an alias never links
-- anything — it can only make a deterministic *suggestion* appear.
CREATE TABLE public.author_identity_aliases (
    id          UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    identity_id UUID NOT NULL,
    alias       TEXT NOT NULL,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

    CONSTRAINT author_identity_aliases_alias_nonblank
        CHECK (btrim(alias) <> ''),

    -- Composite: the alias and the identity it names must belong to the SAME
    -- account. With the RLS WITH CHECK below pinning `user_id` to `auth.uid()`,
    -- a user cannot attach an alias to anyone else's identity even with a
    -- direct API write.
    CONSTRAINT author_identity_aliases_identity_fk
        FOREIGN KEY (user_id, identity_id)
        REFERENCES public.author_identities (user_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_author_identity_aliases_user_identity
    ON public.author_identity_aliases (user_id, identity_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. author_identity_links — the explicit resolution decision
-- ═════════════════════════════════════════════════════════════════════════════
--
-- One row is the user's statement: "the author at this exact position on this
-- paper is this person."
--
-- The link is bound to `paper_id + author_index + author_name_snapshot`.
-- `author_index` is 0-based to match `papers.authors` (a jsonb array) and the
-- application arrays built from it, so `authors->>author_index` is the mention
-- this row is about with no off-by-one translation anywhere.
--
-- `author_name_snapshot` records what that mention SAID when the user decided.
-- It is evidence about the decision, not a canonical person name: the person's
-- name is `author_identities.preferred_name`, and renaming that never touches
-- this. The snapshot is what makes a stale link detectable rather than silently
-- wrong.
--
-- `resolution_basis` is a small closed set describing the UI path the user came
-- through. It is provenance for the *decision*, deliberately not a score: there
-- is no confidence, no probability and no AI field here, because the decision
-- was made by a person and is either right or wrong, not 0.87.
CREATE TABLE public.author_identity_links (
    id                   UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    identity_id          UUID NOT NULL,
    -- No single-column REFERENCES here: the paper edge is composite, below.
    paper_id             UUID NOT NULL,
    author_index         INTEGER NOT NULL,
    author_name_snapshot TEXT NOT NULL,
    resolution_basis     TEXT NOT NULL,
    created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

    CONSTRAINT author_identity_links_author_index_nonnegative
        CHECK (author_index >= 0),

    CONSTRAINT author_identity_links_snapshot_nonblank
        CHECK (btrim(author_name_snapshot) <> ''),

    -- Closed set. A basis this migration does not know about is a bug in a
    -- caller, not data to store.
    CONSTRAINT author_identity_links_resolution_basis_allowed
        CHECK (resolution_basis IN (
            'created_from_mention',
            'manual',
            'orcid_candidate',
            'name_candidate'
        )),

    -- Same-account composite, as for aliases.
    CONSTRAINT author_identity_links_identity_fk
        FOREIGN KEY (user_id, identity_id)
        REFERENCES public.author_identities (user_id, id) ON DELETE CASCADE,

    -- And the same for the paper. A link names one person and one paper, and
    -- BOTH endpoints must belong to the account named in `user_id` — otherwise a
    -- privileged write could attach this user's person to another user's paper
    -- and the row would sit there, invisible to RLS and to every RPC, describing
    -- a relationship across an account boundary.
    --
    -- Cascade because a deleted paper takes its links with it, exactly as the
    -- single-column reference did. The absent ON UPDATE is deliberate: nothing
    -- reassigns a paper to a different owner, and if anything ever tried, this
    -- constraint should stop it rather than quietly follow it.
    CONSTRAINT author_identity_links_paper_fk
        FOREIGN KEY (user_id, paper_id)
        REFERENCES public.papers (user_id, id) ON DELETE CASCADE,

    -- At most one identity per authorship position. Two people cannot occupy
    -- one slot, and this is also the concurrency boundary: two tabs racing to
    -- resolve the same mention produce one winner and one 23505, never a
    -- last-write-wins overwrite of someone's decision.
    --
    -- `paper_id` leads, which is also the useful order for looking a paper's
    -- links up directly. The reverse direction — several mentions on ONE paper
    -- resolving to the SAME identity — stays legal, because a paper may
    -- genuinely list a person twice.
    CONSTRAINT author_identity_links_paper_author_index_key
        UNIQUE (paper_id, author_index)
);

CREATE INDEX idx_author_identity_links_user_identity
    ON public.author_identity_links (user_id, identity_id);

-- Serves the composite paper cascade. Deleting a paper now searches this table
-- on `(user_id, paper_id)`, and the unique constraint above leads with
-- `paper_id` alone — usable, but only by scanning every link the user has for
-- that paper's id across the index. This is the exact key the cascade uses.
CREATE INDEX idx_author_identity_links_user_paper
    ON public.author_identity_links (user_id, paper_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. author_identity_merges — a REVERSIBLE graph edge, not a reassignment
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `source_identity_id → target_identity_id` means: "for person-level grouping,
-- resolve the source through the target."
--
-- Nothing is moved. The source identity, its aliases and its links all stay
-- exactly where they are, which is the whole point:
--
--   * undo is deleting one row, not reconstructing a prior state;
--   * no alias or link can be lost to a merge;
--   * there is no merge history to keep, because no history was destroyed;
--   * unmerging A from B leaves B → C untouched, so a partial undo means what
--     the user expects.
--
-- A destructive merge that rewrote `identity_id` on every link would be simpler
-- to query and impossible to reverse honestly. The edge is worth the join.
--
-- `source_identity_id` is the PRIMARY KEY, and that single choice enforces the
-- "at most one outgoing edge per identity" rule structurally — no trigger, no
-- check, no race. Many sources may still point at one target.
CREATE TABLE public.author_identity_merges (
    user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    source_identity_id UUID NOT NULL PRIMARY KEY,
    target_identity_id UUID NOT NULL,
    created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

    -- The one cycle short enough to catch declaratively. Longer cycles are
    -- prevented by root resolution in merge_author_identities().
    CONSTRAINT author_identity_merges_source_not_target
        CHECK (source_identity_id <> target_identity_id),

    CONSTRAINT author_identity_merges_source_fk
        FOREIGN KEY (user_id, source_identity_id)
        REFERENCES public.author_identities (user_id, id) ON DELETE CASCADE,

    -- Both ends composite against the same `user_id`, so an edge from one
    -- account's identity into another's cannot be stored at all.
    CONSTRAINT author_identity_merges_target_fk
        FOREIGN KEY (user_id, target_identity_id)
        REFERENCES public.author_identities (user_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_author_identity_merges_user_target
    ON public.author_identity_merges (user_id, target_identity_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. updated_at maintenance
-- ═════════════════════════════════════════════════════════════════════════════
-- Reuses the existing function from 20260203072053, as filter_presets does.
-- `author_identities` is the only one of the four with a mutable field
-- (`preferred_name`); aliases, links and merge edges are created and deleted,
-- never edited, so they carry `created_at` alone.
CREATE TRIGGER update_author_identities_updated_at
    BEFORE UPDATE ON public.author_identities
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. Row Level Security
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ENABLE + FORCE on all four, matching the canonical pattern re-established in
-- 20260412030000_fix_rls_all_tables.sql. FORCE removes the table owner's
-- exemption; the SECURITY DEFINER functions below still reach these tables
-- because their owner (postgres) holds BYPASSRLS, which is exactly why every one
-- of them carries an explicit `auth.uid()` predicate as its real authorization
-- boundary rather than leaning on RLS.
--
-- Policies are written for EXACTLY the operations a client role is granted in
-- section 7, and deliberately for no others. An ungranted operation is
-- unreachable twice over: no privilege, and no policy that would admit it.
ALTER TABLE public.author_identities        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.author_identities        FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.author_identity_aliases  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.author_identity_aliases  FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.author_identity_links    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.author_identity_links    FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.author_identity_merges   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.author_identity_merges   FORCE  ROW LEVEL SECURITY;

-- ── author_identities ───────────────────────────────────────────────────────
CREATE POLICY "Users can view their own author identities"
    ON public.author_identities FOR SELECT
    USING (auth.uid() = user_id);

-- Renaming is a plain field edit with no cross-row consequence, so it needs no
-- RPC. WITH CHECK as well as USING: without it a client could re-own the row to
-- another account in the same statement that renamed it. The matching column
-- grant in section 7 narrows this further to `preferred_name` alone, so `id`,
-- `user_id`, `created_at` and `updated_at` are not writable through the API at
-- all.
CREATE POLICY "Users can rename their own author identities"
    ON public.author_identities FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- No INSERT policy: identities are created only by
-- create_author_identity_from_mention(), so an identity always arrives with the
-- link that justifies it, in one transaction.
--
-- No DELETE policy: deletion goes through delete_empty_author_identity(), which
-- refuses an identity that still carries links, aliases or merge edges. A direct
-- DELETE would cascade all of them away silently — turning "delete identity"
-- into an implicit mass unlink — which section 13 of the task forbids.

-- ── author_identity_aliases ─────────────────────────────────────────────────
CREATE POLICY "Users can view their own author identity aliases"
    ON public.author_identity_aliases FOR SELECT
    USING (auth.uid() = user_id);

-- Direct INSERT/DELETE are safe here and need no RPC: an alias is an inert
-- assertion. It links nothing, resolves nothing, and can only influence which
-- deterministic suggestions the UI offers. The composite FK guarantees the named
-- identity belongs to the same `user_id`, and this WITH CHECK pins that
-- `user_id` to the caller — so the pair cannot straddle two accounts.
CREATE POLICY "Users can add aliases to their own author identities"
    ON public.author_identity_aliases FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can remove their own author identity aliases"
    ON public.author_identity_aliases FOR DELETE
    USING (auth.uid() = user_id);

-- No UPDATE policy: an alias is created and removed, never edited. Editing one
-- in place would silently change what a past suggestion was based on.

-- ── author_identity_links ───────────────────────────────────────────────────
-- Read-only to clients. Every write is a resolution decision that must be
-- validated against CURRENT paper state (ownership, index bounds, the expected
-- author string, and explicitly collective provenance) and committed
-- atomically, which a PostgREST row write cannot do.
CREATE POLICY "Users can view their own author identity links"
    ON public.author_identity_links FOR SELECT
    USING (auth.uid() = user_id);

-- ── author_identity_merges ──────────────────────────────────────────────────
-- Read-only to clients, so no direct write can bypass cycle detection or the
-- one-outgoing-edge rule.
CREATE POLICY "Users can view their own author identity merges"
    ON public.author_identity_merges FOR SELECT
    USING (auth.uid() = user_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. Data API grants — explicit, least-privilege, opt-in
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 20260731162729_reconcile_data_api_grants.sql established that this repository
-- states its Data API surface explicitly rather than inheriting one. These are
-- 001C's grants, and they are the narrowest set the feature actually needs.
--
-- REVOKE FIRST, and this is not defensive boilerplate — it is load-bearing. The
-- Supabase database template ships `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
-- TABLES TO anon, authenticated, service_role` for the role that owns these
-- migrations, so a table created here arrives with ALL privileges already
-- granted to all three API roles. Additive GRANTs on top of that would describe
-- an intent the database does not have: `anon` could read every user's identity
-- decisions, and `authenticated` could DELETE an identity directly and cascade
-- away every link and alias it carried. The verify block at the end of this
-- migration asserts the revocation actually took, so a future platform default
-- change in either direction is caught at replay rather than in production.
--
-- The resulting surface, and why each line is what it is:
--   * `anon` gets nothing. Identity decisions are private user data and there is
--     no unauthenticated path to any of them. PUBLIC gets nothing.
--   * `authenticated` gets SELECT everywhere — the frontend resolves merge roots
--     and builds candidates locally, so it must read all four tables.
--   * `author_identities`: UPDATE is granted on `preferred_name` ALONE. Renaming
--     needs no RPC, but `id`, `user_id`, `created_at` and `updated_at` must not
--     be writable through the API; a column-level grant is how that is stated.
--     No INSERT (identities are born with their link, in one transaction) and no
--     DELETE (the emptiness rule of section 16 would be bypassed by a cascade).
--   * `author_identity_aliases`: INSERT/DELETE are safe directly — an alias is
--     an inert assertion — but not UPDATE, which would rewrite the basis of a
--     suggestion already made.
--   * `author_identity_links` and `author_identity_merges`: read-only. Every
--     write is a decision needing validation against current paper state, or
--     cycle detection, and neither is expressible as a row write.
--   * `service_role` gets nothing, deliberately rather than by omission: no Edge
--     Function, worker or server job in this repository touches identity data,
--     and 001C introduces none. `delete-account` removes Storage objects and the
--     Auth user and enumerates no tables, so account deletion runs entirely
--     through the FK cascades declared above — foreign-key enforcement is
--     performed internally and does not consult the deleting role's privileges.
--     Granting a server role access it has no caller for would only widen the
--     blast radius of a leaked secret key.
REVOKE ALL ON TABLE public.author_identities
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.author_identity_aliases
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.author_identity_links
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.author_identity_merges
    FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT                  ON TABLE public.author_identities       TO authenticated;
GRANT UPDATE (preferred_name) ON TABLE public.author_identities       TO authenticated;
GRANT SELECT, INSERT, DELETE  ON TABLE public.author_identity_aliases TO authenticated;
GRANT SELECT                  ON TABLE public.author_identity_links   TO authenticated;
GRANT SELECT                  ON TABLE public.author_identity_merges  TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. Stale-link invalidation — a link is only as valid as the text it names
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A link means "the author at index i of this paper is this person". It is
-- therefore bound to three things: the paper, the position, and the string that
-- stood at that position. Change the `authors` array and the third is gone: an
-- insertion or a reorder silently re-points every later index at a different
-- human, and an identity left attached by index to a name the user rewrote is
-- the same class of false claim about a person that 001B's provenance-
-- replacement rule exists to prevent.
--
-- So any real change to `authors` clears ALL of that paper's links, in the SAME
-- transaction as the change. Not a frontend cleanup pass — a frontend that
-- crashes, is closed, or is an older deployment would leave the false claim
-- standing.
--
-- Deliberately conservative and whole-paper. It would be possible to try to work
-- out which links could survive a given edit, but that means re-deciding name
-- equivalence in SQL — duplicating 001A's JavaScript fold in a second language,
-- where it would drift. Clearing everything for the changed paper costs the user
-- a re-link they can see and redo, and cannot produce a wrong answer.
--
-- What does NOT invalidate:
--   * any other column — title, abstract, year, journal, notes, keywords, tags,
--     projects — because `UPDATE OF authors` plus the WHEN clause never fires;
--   * `author_provenance` changing on its own. Provenance is what a source
--     stated; a link is what the USER decided. Re-fetching metadata must not
--     silently discard a human decision;
--   * an UPDATE that assigns `authors` its existing value. `IS DISTINCT FROM`
--     is what makes that a no-op, and it matters: the paper edit path submits
--     the authors array on every save, and merge_exact_duplicates re-assigns it
--     unconditionally when it keeps a paper whose author list already won.
--
-- Paper deletion is not handled here at all — `author_identity_links.paper_id`
-- cascades, which is both cheaper and impossible to forget.
CREATE OR REPLACE FUNCTION public.clear_author_identity_links_on_authors_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- SECURITY DEFINER because `authenticated` holds no DELETE privilege on
  -- author_identity_links (section 7) — clients must go through the unlink RPC.
  -- The trigger needs to remove rows anyway, and its authority is bounded to
  -- exactly that: one DELETE, keyed on the row being updated, with no
  -- caller-supplied input. The caller could only reach this row by passing
  -- `papers`' own RLS, so it is already proven to be their paper.
  DELETE FROM public.author_identity_links WHERE paper_id = NEW.id;
  RETURN NULL;  -- AFTER trigger: the return value is ignored.
END;
$$;

ALTER FUNCTION public.clear_author_identity_links_on_authors_change() OWNER TO postgres;

-- A trigger function is invoked by the trigger, never called directly, so no
-- role needs EXECUTE on it. Revoking closes the door on it being used as a
-- general-purpose privileged DELETE.
REVOKE ALL ON FUNCTION public.clear_author_identity_links_on_authors_change()
    FROM PUBLIC, anon, authenticated, service_role;

-- `UPDATE OF authors` narrows this to statements that mention the column at
-- all; the WHEN clause narrows it again to statements that actually change its
-- value. Together they mean the common case — saving an edit to notes or year —
-- never enters the function body.
CREATE TRIGGER papers_clear_author_identity_links_on_authors_change
    AFTER UPDATE OF authors ON public.papers
    FOR EACH ROW
    WHEN (NEW.authors IS DISTINCT FROM OLD.authors)
    EXECUTE FUNCTION public.clear_author_identity_links_on_authors_change();

-- ═════════════════════════════════════════════════════════════════════════════
-- 9. Merge-root resolution — the shared internal helper
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Follows outgoing merge edges to the terminal identity. `A → B`, `B → C` makes
-- C the effective root of A, B and C alike.
--
-- Not reachable by any client role: the frontend resolves roots in JavaScript
-- from the merge rows it already reads, so this exists purely so the write paths
-- below agree with it. One definition of "effective identity", used by every
-- mutation that depends on the answer.
--
-- The step ceiling is defence in depth, not the cycle defence. Cycles are
-- prevented at write time by merge_author_identities(), and the PRIMARY KEY on
-- source_identity_id caps the graph at one outgoing edge per node — so a cycle
-- would require a bug elsewhere. If one ever existed, this raises instead of
-- spinning forever, which is the difference between a visible failure and a
-- hung connection. 64 is far beyond any plausible chain of hand-made merges.
CREATE OR REPLACE FUNCTION public.author_identity_effective_root(
  p_user_id     uuid,
  p_identity_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_current uuid := p_identity_id;
  v_next    uuid;
  v_steps   integer := 0;
BEGIN
  IF p_user_id IS NULL OR p_identity_id IS NULL THEN
    RAISE EXCEPTION 'author identity root resolution requires a user and an identity';
  END IF;

  LOOP
    SELECT m.target_identity_id
    INTO v_next
    FROM public.author_identity_merges m
    WHERE m.user_id = p_user_id
      AND m.source_identity_id = v_current;

    IF v_next IS NULL THEN
      RETURN v_current;
    END IF;

    v_steps := v_steps + 1;
    IF v_steps > 64 THEN
      RAISE EXCEPTION 'author identity merge graph is cyclic or deeper than 64 edges';
    END IF;

    v_current := v_next;
  END LOOP;
END;
$$;

ALTER FUNCTION public.author_identity_effective_root(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.author_identity_effective_root(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 10. Shared mention validation
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Both link-creating RPCs must answer the same four questions about a mention
-- before they may store a person decision about it, and must answer them against
-- CURRENT paper state rather than whatever the UI was showing:
--
--   1. does the caller own this paper?
--   2. does this author position exist, and is it non-blank?
--   3. is the string still the one the user was looking at when they decided?
--   4. did the SOURCE explicitly say this author is a collective?
--
-- (4) is the interesting one. An explicitly collective author — a consortium, a
-- study group, a committee, a named collaboration that the PROVIDER marked as
-- such — is not a person, and no amount of user intent makes it one. This checks
-- only `kind = 'collective'`, which 001B sets solely from source *structure* (a
-- PubMed <CollectiveName>, a Crossref organization entry). It never inspects the
-- text: a free-form string containing "Consortium" is `unknown`, and stays
-- manually resolvable, because guessing from wording is exactly the inference
-- 001B refused to make.
--
-- NULL provenance and `kind = 'unknown'` both mean the source never established
-- what this author is. Those remain resolvable by hand — that is most of the
-- historical library, and refusing it would make the feature useless on real
-- data — they simply never get resolved automatically.
--
-- Returns the validated current author string. Raises otherwise, before any
-- caller has written anything.
CREATE OR REPLACE FUNCTION public.validate_author_mention_for_identity(
  p_user_id         uuid,
  p_paper_id        uuid,
  p_author_index    integer,
  p_expected_author text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_authors    jsonb;
  v_provenance jsonb;
  v_current    text;
  v_kind       text;
BEGIN
  IF p_paper_id IS NULL THEN
    RAISE EXCEPTION 'Paper id is required';
  END IF;

  IF p_author_index IS NULL OR p_author_index < 0 THEN
    RAISE EXCEPTION 'Author index must be a non-negative integer';
  END IF;

  -- FOR UPDATE serializes this validation against a concurrent edit of the same
  -- paper. Without it, another tab could rewrite `authors` between the check and
  -- the insert, and the link would be born stale — the exact condition the
  -- expected-author guard exists to prevent.
  SELECT p.authors, p.author_provenance
  INTO v_authors, v_provenance
  FROM public.papers p
  WHERE p.id = p_paper_id
    AND p.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Paper not found or access denied';
  END IF;

  IF jsonb_typeof(v_authors) <> 'array'
     OR p_author_index >= jsonb_array_length(v_authors) THEN
    RAISE EXCEPTION 'Author index % is out of range for this paper', p_author_index;
  END IF;

  v_current := v_authors ->> p_author_index;

  IF v_current IS NULL OR btrim(v_current) = '' THEN
    RAISE EXCEPTION 'Author mention at index % is blank', p_author_index;
  END IF;

  -- Exact, byte-for-byte. Not the 001A fold: the point is to detect that the
  -- stored text moved under the user, and a punctuation-only edit moved it. The
  -- UI re-reads and re-offers rather than guessing that the change was harmless.
  IF p_expected_author IS NULL OR p_expected_author <> v_current THEN
    RAISE EXCEPTION 'Author mention changed since it was read; expected %, found %',
      COALESCE(p_expected_author, '<null>'), v_current;
  END IF;

  -- The column CHECK guarantees a non-null provenance array is exactly as long
  -- as `authors`, so this index is safe without a length test.
  IF v_provenance IS NOT NULL AND jsonb_typeof(v_provenance) = 'array' THEN
    v_kind := v_provenance -> p_author_index ->> 'kind';
    IF v_kind = 'collective' THEN
      RAISE EXCEPTION 'Author mention at index % is a collective author and cannot be resolved to a person',
        p_author_index;
    END IF;
  END IF;

  RETURN v_current;
END;
$$;

ALTER FUNCTION public.validate_author_mention_for_identity(uuid, uuid, integer, text)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.validate_author_mention_for_identity(uuid, uuid, integer, text)
    FROM PUBLIC, anon, authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 11. create_author_identity_from_mention
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The only way an identity is ever born: from one mention the user pointed at,
-- with the link that justifies it, in one transaction. There is no
-- create-an-empty-person path, because a person with no evidence is not a
-- decision.
--
-- `p_preferred_name` is the label the user confirmed. The UI defaults it to the
-- display-normalized current author string and lets them edit it before
-- confirming; blank falls back to the raw current string here so the RPC is
-- correct on its own. It is deliberately NOT synthesized from 001B's
-- given_name/family_name components even when those exist — assembling a
-- canonical person name out of source fields is Paperlume asserting how the
-- person is called, which is the user's call, not a parser's.
CREATE OR REPLACE FUNCTION public.create_author_identity_from_mention(
  p_paper_id        uuid,
  p_author_index    integer,
  p_expected_author text,
  p_preferred_name  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id     uuid := auth.uid();
  v_current     text;
  v_name        text;
  v_identity_id uuid;
  v_link_id     uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- Locks the paper and proves ownership, bounds, freshness and non-collective
  -- provenance. Every check precedes the first write, so a rejected call is
  -- provably side-effect free.
  v_current := public.validate_author_mention_for_identity(
    v_user_id, p_paper_id, p_author_index, p_expected_author);

  v_name := COALESCE(NULLIF(btrim(p_preferred_name), ''), v_current);

  INSERT INTO public.author_identities (user_id, preferred_name)
  VALUES (v_user_id, v_name)
  RETURNING id INTO v_identity_id;

  -- Unique (paper_id, author_index) turns a concurrent duplicate into 23505
  -- here, so the losing tab is told its decision conflicted instead of quietly
  -- creating a second identity for the same mention. The orphan identity the
  -- INSERT above would have produced is rolled back with the statement.
  INSERT INTO public.author_identity_links (
    user_id, identity_id, paper_id, author_index, author_name_snapshot, resolution_basis
  )
  VALUES (
    v_user_id, v_identity_id, p_paper_id, p_author_index, v_current, 'created_from_mention'
  )
  RETURNING id INTO v_link_id;

  RETURN jsonb_build_object(
    'identity_id',    v_identity_id,
    'link_id',        v_link_id,
    'preferred_name', v_name,
    'author_name_snapshot', v_current
  );
END;
$$;

ALTER FUNCTION public.create_author_identity_from_mention(uuid, integer, text, text)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_author_identity_from_mention(uuid, integer, text, text)
    FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION public.create_author_identity_from_mention(uuid, integer, text, text)
    TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 12. link_author_mention_to_identity
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Attaches an already-existing identity to a mention. The identity the caller
-- names is resolved to its effective root before the link is stored, so picking
-- a merged-away identity from a list does what the user means — the mention
-- joins the cluster — and the stored graph stays flat enough to reason about.
--
-- `p_replace_existing` is required to be explicitly true to displace an existing
-- link. A candidate suggestion, a search result or a stray double-click must
-- never silently overwrite a decision the user already made about that mention:
-- the default refuses and the UI has to ask. Replacement happens inside this one
-- transaction, so the mention is never momentarily unresolved.
CREATE OR REPLACE FUNCTION public.link_author_mention_to_identity(
  p_paper_id         uuid,
  p_author_index     integer,
  p_expected_author  text,
  p_identity_id      uuid,
  p_resolution_basis text DEFAULT 'manual',
  p_replace_existing boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id     uuid := auth.uid();
  v_current     text;
  v_root_id     uuid;
  v_existing_id uuid;
  v_replaced    boolean := false;
  v_link_id     uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_identity_id IS NULL THEN
    RAISE EXCEPTION 'Identity id is required';
  END IF;

  -- Only the three bases a user can arrive through here. 'created_from_mention'
  -- is reserved for the RPC above, so the basis on a link always names the path
  -- that actually produced it.
  IF p_resolution_basis IS NULL
     OR p_resolution_basis NOT IN ('manual', 'orcid_candidate', 'name_candidate') THEN
    RAISE EXCEPTION 'Unsupported resolution basis %', COALESCE(p_resolution_basis, '<null>');
  END IF;

  -- Ownership of the identity, checked explicitly rather than left to the
  -- composite FK: the FK would also reject a cross-user pair, but with a
  -- constraint violation rather than a message the UI can show.
  IF NOT EXISTS (
    SELECT 1 FROM public.author_identities
    WHERE id = p_identity_id AND user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Identity not found or access denied';
  END IF;

  v_current := public.validate_author_mention_for_identity(
    v_user_id, p_paper_id, p_author_index, p_expected_author);

  v_root_id := public.author_identity_effective_root(v_user_id, p_identity_id);

  SELECT id INTO v_existing_id
  FROM public.author_identity_links
  WHERE paper_id = p_paper_id
    AND author_index = p_author_index;

  IF v_existing_id IS NOT NULL THEN
    IF NOT COALESCE(p_replace_existing, false) THEN
      RAISE EXCEPTION 'Author mention at index % is already linked to an identity',
        p_author_index;
    END IF;
    DELETE FROM public.author_identity_links WHERE id = v_existing_id;
    v_replaced := true;
  END IF;

  INSERT INTO public.author_identity_links (
    user_id, identity_id, paper_id, author_index, author_name_snapshot, resolution_basis
  )
  VALUES (
    v_user_id, v_root_id, p_paper_id, p_author_index, v_current, p_resolution_basis
  )
  RETURNING id INTO v_link_id;

  RETURN jsonb_build_object(
    'identity_id',          v_root_id,
    'requested_identity_id', p_identity_id,
    'link_id',              v_link_id,
    'replaced',             v_replaced,
    'author_name_snapshot', v_current
  );
END;
$$;

ALTER FUNCTION public.link_author_mention_to_identity(uuid, integer, text, uuid, text, boolean)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.link_author_mention_to_identity(uuid, integer, text, uuid, text, boolean)
    FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION public.link_author_mention_to_identity(uuid, integer, text, uuid, text, boolean)
    TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 13. unlink_author_mention_identity
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Every explicit link must be reversible, and reversing one touches no paper
-- data: `authors` and `author_provenance` are not read or written here. Unlinking
-- returns the mention to unresolved 001A textual grouping, which is where it
-- started.
--
-- No expected-author guard. The user is withdrawing a decision, and there is no
-- state a stale read could corrupt — if the mention text has since changed, the
-- link is already gone (section 8) and this reports that honestly.
CREATE OR REPLACE FUNCTION public.unlink_author_mention_identity(
  p_paper_id     uuid,
  p_author_index integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_deleted integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_paper_id IS NULL OR p_author_index IS NULL THEN
    RAISE EXCEPTION 'Paper id and author index are required';
  END IF;

  -- `user_id` in the predicate is the authorization boundary: the owner of this
  -- function bypasses RLS, so a missing filter here would delete anyone's link.
  DELETE FROM public.author_identity_links
  WHERE user_id = v_user_id
    AND paper_id = p_paper_id
    AND author_index = p_author_index;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

ALTER FUNCTION public.unlink_author_mention_identity(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.unlink_author_mention_identity(uuid, integer)
    FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION public.unlink_author_mention_identity(uuid, integer)
    TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 14. merge_author_identities
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Records `source → root-of(target)`. Nothing is copied, nothing is moved,
-- nothing is deleted. The source keeps its links, its aliases and its row, which
-- is what makes section 15's undo a one-row delete rather than a restore.
--
-- Storing the target's ROOT rather than the target itself keeps every stored edge
-- pointing at an identity that was terminal when the edge was made, which is what
-- "merge A into B" means when B has itself already been merged into C: the user
-- is choosing the cluster, and the cluster's identity is C. Chains can still form
-- afterwards — merging B into C later leaves A → B → C — so readers must still
-- walk, and both this function and the frontend do.
--
-- Concurrency: a transaction-scoped advisory lock keyed on the account serializes
-- every merge and unmerge that account attempts. Two tabs racing to merge
-- A → B and B → A would each individually pass a cycle check evaluated against a
-- graph the other had not committed yet; the lock removes the interleaving rather
-- than trying to detect it afterwards. The lock is per user, so one account's
-- merges never wait on another's.
CREATE OR REPLACE FUNCTION public.merge_author_identities(
  p_source_identity_id uuid,
  p_target_identity_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id     uuid := auth.uid();
  v_target_root uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_source_identity_id IS NULL OR p_target_identity_id IS NULL THEN
    RAISE EXCEPTION 'Source and target identity ids are required';
  END IF;

  IF p_source_identity_id = p_target_identity_id THEN
    RAISE EXCEPTION 'An identity cannot be merged into itself';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('public.author_identity_merges'), hashtext(v_user_id::text));

  -- Both ends must be the caller's. Checked as one query so neither id's mere
  -- existence in another account is observable from the error.
  IF (SELECT count(*) FROM public.author_identities
      WHERE user_id = v_user_id
        AND id IN (p_source_identity_id, p_target_identity_id)) <> 2 THEN
    RAISE EXCEPTION 'Identity not found or access denied';
  END IF;

  -- One outgoing edge per identity. The PRIMARY KEY would reject the second one
  -- anyway; checking first turns a constraint violation into an explanation, and
  -- makes the rule visible where it is relied upon.
  IF EXISTS (
    SELECT 1 FROM public.author_identity_merges
    WHERE user_id = v_user_id AND source_identity_id = p_source_identity_id
  ) THEN
    RAISE EXCEPTION 'Identity is already merged into another identity; unmerge it first';
  END IF;

  v_target_root := public.author_identity_effective_root(v_user_id, p_target_identity_id);

  -- The cycle test. If the target already resolves through the source, this edge
  -- would close a loop and no identity in it would have a root.
  IF v_target_root = p_source_identity_id THEN
    RAISE EXCEPTION 'Merging these identities would create a cycle';
  END IF;

  INSERT INTO public.author_identity_merges (user_id, source_identity_id, target_identity_id)
  VALUES (v_user_id, p_source_identity_id, v_target_root);

  RETURN jsonb_build_object(
    'source_identity_id',    p_source_identity_id,
    'target_identity_id',    v_target_root,
    'requested_target_id',   p_target_identity_id
  );
END;
$$;

ALTER FUNCTION public.merge_author_identities(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_author_identities(uuid, uuid)
    FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION public.merge_author_identities(uuid, uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 15. unmerge_author_identity
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Deletes EXACTLY the source's own outgoing edge. Given A → B → C, unmerging A
-- restores A as its own identity and leaves B → C standing, because the two are
-- independent rows and always were.
--
-- The source's links and aliases reappear under it with no reconstruction — they
-- never left. That is the payoff for having modelled a merge as an edge instead
-- of a reassignment.
CREATE OR REPLACE FUNCTION public.unmerge_author_identity(
  p_source_identity_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_deleted integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_source_identity_id IS NULL THEN
    RAISE EXCEPTION 'Source identity id is required';
  END IF;

  -- Same lock as the merge path, so an undo cannot interleave with a merge that
  -- is still resolving roots against the edge being removed.
  PERFORM pg_advisory_xact_lock(
    hashtext('public.author_identity_merges'), hashtext(v_user_id::text));

  DELETE FROM public.author_identity_merges
  WHERE user_id = v_user_id
    AND source_identity_id = p_source_identity_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

ALTER FUNCTION public.unmerge_author_identity(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.unmerge_author_identity(uuid)
    FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION public.unmerge_author_identity(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 16. delete_empty_author_identity
-- ═════════════════════════════════════════════════════════════════════════════
--
-- An identity may be deleted only when it carries no resolution state at all: no
-- linked mentions, no aliases, no outgoing merge, no incoming merge.
--
-- Every one of those relationships is declared ON DELETE CASCADE, so a plain
-- `DELETE FROM author_identities` would succeed and take the user's decisions
-- with it — "Delete identity" would quietly become "unlink everything, discard
-- every alias, and dissolve the cluster". That is why `authenticated` holds no
-- DELETE privilege on the table (section 7) and this is the only way through.
-- The cascades remain as the correct behaviour for the one deletion that is not
-- a UI action: closing the account.
--
-- Refusing is not a dead end — the user unlinks, removes aliases and unmerges
-- explicitly, each of which is individually visible and individually reversible,
-- and then the identity is empty and goes.
CREATE OR REPLACE FUNCTION public.delete_empty_author_identity(
  p_identity_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_links   integer;
  v_aliases integer;
  v_out     integer;
  v_in      integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_identity_id IS NULL THEN
    RAISE EXCEPTION 'Identity id is required';
  END IF;

  -- Locking the identity row makes the emptiness checks below meaningful: without
  -- it, another tab could add a link between the count and the delete, and the
  -- cascade would silently remove it.
  PERFORM 1 FROM public.author_identities
  WHERE id = p_identity_id AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Identity not found or access denied';
  END IF;

  SELECT count(*) INTO v_links
  FROM public.author_identity_links
  WHERE user_id = v_user_id AND identity_id = p_identity_id;

  SELECT count(*) INTO v_aliases
  FROM public.author_identity_aliases
  WHERE user_id = v_user_id AND identity_id = p_identity_id;

  SELECT count(*) INTO v_out
  FROM public.author_identity_merges
  WHERE user_id = v_user_id AND source_identity_id = p_identity_id;

  SELECT count(*) INTO v_in
  FROM public.author_identity_merges
  WHERE user_id = v_user_id AND target_identity_id = p_identity_id;

  IF v_links > 0 OR v_aliases > 0 OR v_out > 0 OR v_in > 0 THEN
    RAISE EXCEPTION
      'Identity still has % linked mention(s), % alias(es), % outgoing and % incoming merge(s); remove them first',
      v_links, v_aliases, v_out, v_in;
  END IF;

  DELETE FROM public.author_identities
  WHERE id = p_identity_id AND user_id = v_user_id;

  RETURN true;
END;
$$;

ALTER FUNCTION public.delete_empty_author_identity(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_empty_author_identity(uuid)
    FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION public.delete_empty_author_identity(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 17. Table documentation, readable from the database itself
-- ═════════════════════════════════════════════════════════════════════════════
COMMENT ON TABLE public.author_identities IS
  'User-scoped person identities. One row is a person THIS user has explicitly '
  'decided exists; identities are never shared between users, never created by '
  'import or migration, and carry no ORCID column — an identity''s identifier '
  'evidence is derived at read time from its currently linked mentions.';

COMMENT ON TABLE public.author_identity_aliases IS
  'Additional names the user asserts for one of their identities. Never derived '
  'from source data, never globally unique, and never a link: adding an alias '
  'can only influence deterministic suggestions, never resolve a mention.';

COMMENT ON TABLE public.author_identity_links IS
  'The explicit resolution decision: the author at (paper_id, author_index) is '
  'this identity. author_index is 0-based against papers.authors. Cleared for '
  'the whole paper whenever papers.authors changes, because a link is bound to '
  'the text it names.';

COMMENT ON TABLE public.author_identity_merges IS
  'Reversible merge edges: source_identity_id resolves through '
  'target_identity_id for person-level grouping. Nothing is moved or copied, so '
  'unmerging is deleting one row. source_identity_id is the primary key, which '
  'enforces at most one outgoing edge per identity.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 18. Fail-closed self-check
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Asserts what this migration claims, in the same transaction that claims it, so
-- a replay that silently produced a weaker schema fails here instead of shipping.
-- Modelled on 20260817120000's verify block.
DO $verify$
DECLARE
  v_table   text;
  v_fn      text;
  v_sig     text;
  v_row     record;
  v_count   integer;
  v_all_fns text[];
  v_tables  text[] := ARRAY['author_identities', 'author_identity_aliases',
                            'author_identity_links', 'author_identity_merges'];
  -- Every function this migration creates, with its identity arguments, and
  -- whether a client role is meant to reach it.
  v_client_fns text[] := ARRAY[
    'create_author_identity_from_mention',
    'link_author_mention_to_identity',
    'unlink_author_mention_identity',
    'merge_author_identities',
    'unmerge_author_identity',
    'delete_empty_author_identity'];
  v_internal_fns text[] := ARRAY[
    'author_identity_effective_root',
    'validate_author_mention_for_identity',
    'clear_author_identity_links_on_authors_change'];
BEGIN
  v_all_fns := v_client_fns || v_internal_fns;

  -- ── Tables exist, with RLS enabled AND forced ──
  FOREACH v_table IN ARRAY v_tables LOOP
    SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO v_row
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_table AND c.relkind = 'r';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'author_identity: table public.% was not created', v_table;
    END IF;
    IF NOT v_row.relrowsecurity THEN
      RAISE EXCEPTION 'author_identity: RLS is not enabled on public.%', v_table;
    END IF;
    IF NOT v_row.relforcerowsecurity THEN
      RAISE EXCEPTION 'author_identity: RLS is not FORCED on public.%', v_table;
    END IF;

    -- No client role may reach a new table by accident, and anon may never
    -- reach it at all.
    IF has_table_privilege('anon', 'public.' || v_table,
                           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
      RAISE EXCEPTION 'author_identity: anon holds a privilege on public.%', v_table;
    END IF;
  END LOOP;

  -- ── Nothing was backfilled ──
  -- The whole point of 001C: an identity exists only because a user made one.
  -- A migration that manufactured identities from historical ORCIDs would be
  -- asserting people on their behalf.
  SELECT (SELECT count(*) FROM public.author_identities)
       + (SELECT count(*) FROM public.author_identity_aliases)
       + (SELECT count(*) FROM public.author_identity_links)
       + (SELECT count(*) FROM public.author_identity_merges)
  INTO v_count;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'author_identity: migration created % identity row(s); no backfill is permitted', v_count;
  END IF;

  -- ── The authenticated surface is exactly the intended one ──
  IF NOT has_table_privilege('authenticated', 'public.author_identities', 'SELECT') THEN
    RAISE EXCEPTION 'author_identity: authenticated cannot read author_identities';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.author_identities', 'preferred_name', 'UPDATE') THEN
    RAISE EXCEPTION 'author_identity: authenticated cannot rename an identity';
  END IF;
  IF has_column_privilege('authenticated', 'public.author_identities', 'user_id', 'UPDATE') THEN
    RAISE EXCEPTION 'author_identity: authenticated can rewrite author_identities.user_id';
  END IF;
  IF has_table_privilege('authenticated', 'public.author_identities', 'INSERT') THEN
    RAISE EXCEPTION 'author_identity: authenticated can insert an identity directly';
  END IF;
  IF has_table_privilege('authenticated', 'public.author_identities', 'DELETE') THEN
    RAISE EXCEPTION 'author_identity: authenticated can delete an identity directly, bypassing the emptiness rule';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.author_identity_aliases', 'SELECT, INSERT, DELETE') THEN
    RAISE EXCEPTION 'author_identity: authenticated is missing the alias surface';
  END IF;
  IF has_table_privilege('authenticated', 'public.author_identity_aliases', 'UPDATE') THEN
    RAISE EXCEPTION 'author_identity: aliases must not be editable in place';
  END IF;

  -- Links and merge edges are read-only to clients: every write must pass
  -- through an RPC that validates it.
  IF NOT has_table_privilege('authenticated', 'public.author_identity_links', 'SELECT') THEN
    RAISE EXCEPTION 'author_identity: authenticated cannot read author_identity_links';
  END IF;
  IF has_table_privilege('authenticated', 'public.author_identity_links', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'author_identity: authenticated can write author_identity_links directly';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.author_identity_merges', 'SELECT') THEN
    RAISE EXCEPTION 'author_identity: authenticated cannot read author_identity_merges';
  END IF;
  IF has_table_privilege('authenticated', 'public.author_identity_merges', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'author_identity: authenticated can write author_identity_merges directly, bypassing cycle validation';
  END IF;

  -- service_role deliberately holds nothing on all four (see section 7).
  FOREACH v_table IN ARRAY v_tables LOOP
    IF has_table_privilege('service_role', 'public.' || v_table,
                           'SELECT, INSERT, UPDATE, DELETE') THEN
      RAISE EXCEPTION 'author_identity: service_role holds a privilege on public.%', v_table;
    END IF;
  END LOOP;

  -- ── Every new function is hardened ──
  FOREACH v_fn IN ARRAY v_all_fns LOOP
    SELECT count(*)::integer INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_fn;

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'author_identity: expected exactly 1 overload of %, found %', v_fn, v_count;
    END IF;

    SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner
    INTO v_row
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_fn;

    IF NOT v_row.prosecdef THEN
      RAISE EXCEPTION 'author_identity: % is not SECURITY DEFINER', v_fn;
    END IF;
    IF v_row.proconfig IS DISTINCT FROM ARRAY['search_path=public'] THEN
      RAISE EXCEPTION 'author_identity: % has search_path %', v_fn, v_row.proconfig;
    END IF;
    IF v_row.owner <> 'postgres' THEN
      RAISE EXCEPTION 'author_identity: % is owned by %', v_fn, v_row.owner;
    END IF;
  END LOOP;

  -- ── EXECUTE is least-privilege in both directions ──
  FOREACH v_fn IN ARRAY v_client_fns LOOP
    SELECT p.oid::regprocedure::text INTO v_sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_fn;

    IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'author_identity: authenticated cannot execute %', v_fn;
    END IF;
    IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'author_identity: anon can execute %', v_fn;
    END IF;
    IF has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'author_identity: service_role can execute %', v_fn;
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY v_internal_fns LOOP
    SELECT p.oid::regprocedure::text INTO v_sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_fn;

    IF has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'author_identity: internal helper % is executable by authenticated', v_fn;
    END IF;
    IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'author_identity: internal helper % is executable by anon', v_fn;
    END IF;
  END LOOP;

  -- ── The invalidation trigger exists and stays narrow ──
  SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
  INTO v_row
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.papers'::regclass
    AND t.tgname = 'papers_clear_author_identity_links_on_authors_change'
    AND NOT t.tgisinternal;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'author_identity: the authors-change invalidation trigger was not created';
  END IF;
  IF v_row.def NOT LIKE '%UPDATE OF authors%' THEN
    RAISE EXCEPTION 'author_identity: the invalidation trigger is not scoped to UPDATE OF authors: %', v_row.def;
  END IF;
  IF v_row.def NOT LIKE '%IS DISTINCT FROM%' THEN
    RAISE EXCEPTION 'author_identity: the invalidation trigger lacks its IS DISTINCT FROM guard: %', v_row.def;
  END IF;

  -- ── 001B is untouched ──
  -- 001C must not have widened the provenance contract on its way past.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.papers'::regclass
      AND conname = 'papers_author_provenance_shape_check'
      AND contype = 'c'
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'author_identity: 001B''s provenance CHECK is missing or invalid';
  END IF;

  -- ── No global identifier or name uniqueness was introduced ──
  -- Two users must be able to reach different conclusions about the same ORCID,
  -- and two people may share a name. A unique index on either would silently
  -- turn this user-scoped feature into a global researcher registry.
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = ANY (v_tables)
      AND i.indisunique
      AND pg_get_indexdef(i.indexrelid) ILIKE '%preferred_name%'
  ) THEN
    RAISE EXCEPTION 'author_identity: preferred_name must not be unique — two people may share a name';
  END IF;

  -- ── Every identity relationship is structurally user-scoped ──
  -- The header claims a cross-account relationship is unrepresentable, not
  -- merely forbidden. This is that claim, checked rather than asserted: EVERY
  -- foreign key leaving the four 001C tables must carry `user_id` among its
  -- referencing columns, so both endpoints of every edge are pinned to one
  -- account by the key itself. A future edit that adds a convenient
  -- single-column reference fails the migration instead of silently reopening
  -- the hole this section closes.
  FOR v_row IN
    SELECT c.conname,
           ch.relname AS child,
           c.confdeltype,
           (SELECT array_agg(a.attname ORDER BY k.ord)
              FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a
                ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_cols
    FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_namespace chn ON chn.oid = ch.relnamespace
    WHERE c.contype = 'f'
      AND chn.nspname = 'public'
      AND ch.relname = ANY (v_tables)
  LOOP
    IF NOT ('user_id' = ANY (v_row.child_cols)) THEN
      RAISE EXCEPTION
        'author_identity: foreign key % on public.% is not user-scoped; referencing columns are %',
        v_row.conname, v_row.child, v_row.child_cols;
    END IF;
    IF v_row.confdeltype <> 'c' THEN
      RAISE EXCEPTION
        'author_identity: foreign key % on public.% does not cascade on delete',
        v_row.conname, v_row.child;
    END IF;
  END LOOP;

  -- The ownership key those composite references depend on.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.papers'::regclass
      AND conname = 'papers_user_id_id_key'
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (user_id, id)'
  ) THEN
    RAISE EXCEPTION 'author_identity: papers is missing the (user_id, id) ownership key';
  END IF;

  -- `papers.id` stays the primary key. The constraint above is additive; it
  -- must never have been mistaken for a replacement.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.papers'::regclass
      AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (id)'
  ) THEN
    RAISE EXCEPTION 'author_identity: papers no longer has its original PRIMARY KEY (id)';
  END IF;

  -- And the link edge itself, spelled out.
  SELECT pg_get_constraintdef(oid) INTO v_sig
  FROM pg_constraint
  WHERE conrelid = 'public.author_identity_links'::regclass
    AND conname = 'author_identity_links_paper_fk';

  IF v_sig IS DISTINCT FROM
     'FOREIGN KEY (user_id, paper_id) REFERENCES papers(user_id, id) ON DELETE CASCADE' THEN
    RAISE EXCEPTION
      'author_identity: the link→paper edge is not the expected user-scoped composite: %',
      COALESCE(v_sig, '<missing>');
  END IF;
END
$verify$;
