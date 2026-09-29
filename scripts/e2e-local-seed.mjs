// @ts-nocheck
/**
 * Deterministic seed for the local Supabase E2E stack.
 *
 * Invoked by scripts/e2e-local.mjs after the local stack is up and the tracked
 * migration chain has replayed. It creates local-only Auth identities and a
 * deterministic fixture library sufficient for the default read-only Playwright
 * spec set (see `DEFAULT_SPECS` in scripts/e2e-local.mjs — the authoritative
 * list; do not restate its length here) and the later mutating/attribution
 * waves.
 *
 * Hard safety rules (enforced by the caller and re-asserted here):
 *   - Only ever runs against a validated loopback Supabase API URL.
 *   - Three levels of local access, each used for what it is for:
 *       · the local secret (service-role) key for Auth administration only —
 *         creating and deleting the seed users, exactly the kind of thing a
 *         secret key does in Production;
 *       · the local database-owner connection (`ownerSql`, supplied by the
 *         lifecycle: `postgres` over the local container's socket) for fixture
 *         rows and for verifying them. Since SERVICE-ROLE-LEAST-PRIVILEGE-
 *         HARDENING-001 (C57) `service_role` holds no privilege on any
 *         application table — locally, and in Production once C57 is
 *         applied — so this is seeding
 *         infrastructure, never a server path — and no grant is restored to
 *         make it convenient;
 *       · the local publishable (anon) key for the authenticated read-back
 *         verification.
 *   - Generates a fresh ephemeral password per run; never logs or persists
 *     any password, key, token, or JWT.
 *   - Uses only `.test` email identifiers; never a Production account.
 *
 * This file is a plain Node ESM module (not TypeScript) so the lifecycle can
 * import it without a compile step. It depends only on the already-installed
 * `@supabase/supabase-js` and Node built-ins.
 */

import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

/** Production project ref — must never appear in a seed target. */
const PRODUCTION_SUPABASE_REF = "lioxtgiputfniqbktcsz";

/** Local-only test identities. `.test` is a reserved, non-routable TLD. */
export const PRIMARY_EMAIL = "e2e-primary@paperlume.test";
export const SECONDARY_EMAIL = "e2e-secondary@paperlume.test";

/** Fixture sizing. 120 > PAGE_SIZE (100) so the eager-load branch is exercised. */
export const PRIMARY_PAPER_COUNT = 120;
export const SECONDARY_PAPER_COUNT = 5;

/** AUTHOR-IDENTITY-RESOLUTION-001C fixture papers, defined below. */
export const IDENTITY_PAPER_COUNT = 5;

/**
 * Everything the primary account actually holds: the generated library plus the
 * identity fixtures. `PRIMARY_PAPER_COUNT` stays the size of the GENERATED
 * library because the pagination and ordering fixtures are defined in terms of
 * it, so a spec asserting a whole-account total must use this instead.
 */
export const PRIMARY_TOTAL_PAPER_COUNT = PRIMARY_PAPER_COUNT + IDENTITY_PAPER_COUNT;

/** The newest N primary papers (highest insert_order) are intentionally note-less. */
const PRIMARY_NOTELESS_TAIL = 5;

/** Clearly designated disposable / highest-order paper for later attribution work. */
export const DISPOSABLE_PAPER_TITLE =
  "E2E Primary Paper 120 — Disposable Highest-Order";

/* ---------------------------------------------------------------------------
 * AUTHOR-IDENTITY-RESOLUTION-001C fixtures
 * ------------------------------------------------------------------------ */

/**
 * Four papers whose authorship deliberately reproduces the cases the identity
 * feature exists to handle, so the E2E flows need no live ORCID lookup and no
 * import.
 *
 *   IDENTITY-A / IDENTITY-B  the same person written two ways — `Stuart M
 *                            Phillips` and `S M Phillips` — carrying the SAME
 *                            checksum-valid ORCID. 001A keeps them apart and
 *                            001B does not merge them, so they start as two
 *                            authors and only an explicit link makes them one.
 *   IDENTITY-C / IDENTITY-D  001A-EQUIVALENT names carrying DIFFERENT valid
 *                            ORCIDs. Two real people who share a name, which is
 *                            why a name match must never override contradictory
 *                            identifier evidence.
 *
 * ORCIDs are real-format, checksum-valid values used as opaque fixtures; nothing
 * in the stack ever contacts orcid.org.
 */
export const IDENTITY_FIXTURE_PREFIX = "E2E Identity";

const IDENTITY_ORCID_SHARED = "0000-0002-1825-0097";
const IDENTITY_ORCID_FIRST = "0000-0003-0945-2970";
const IDENTITY_ORCID_SECOND = "0000-0001-5109-3700";

export const IDENTITY_PAPERS = {
  sameOrcidFullName: `${IDENTITY_FIXTURE_PREFIX} A — Same ORCID, full name`,
  sameOrcidInitials: `${IDENTITY_FIXTURE_PREFIX} B — Same ORCID, initials`,
  conflictingFirst: `${IDENTITY_FIXTURE_PREFIX} C — Same name, first ORCID`,
  conflictingSecond: `${IDENTITY_FIXTURE_PREFIX} D — Same name, second ORCID`,
  /**
   * Reserved for the stale-link E2E, which rewrites the authors array and
   * therefore also replaces the paper's provenance with honest manual entries.
   * Its own paper, so A-D keep the source provenance the other flows depend on.
   *
   * The title deliberately avoids the substring "edit": every row control is
   * labelled "<action> <paper title>", so a title containing an action word makes
   * a name-matched locator ambiguous across five buttons in the same row.
   */
  editable: `${IDENTITY_FIXTURE_PREFIX} E — Rewritten authors`,
};

/** One `personal` provenance entry carrying a single ORCID identifier. */
function identityProvenance(sourceName, orcid) {
  return {
    source: "pubmed_api",
    source_field: "Author",
    kind: "personal",
    source_name: sourceName,
    given_name: null,
    family_name: null,
    initials: null,
    suffix: null,
    collective_name: null,
    affiliations: ["McMaster University"],
    identifiers: [{ scheme: "ORCID", value: orcid }],
    orcid,
    orcid_authenticated: null,
  };
}

/**
 * The identity fixture papers, ordered so their insert_order stays below the
 * disposable highest-order paper the other specs rely on.
 */
function buildIdentityPapers(userId) {
  const rows = [
    [IDENTITY_PAPERS.sameOrcidFullName, "Stuart M Phillips", IDENTITY_ORCID_SHARED],
    [IDENTITY_PAPERS.sameOrcidInitials, "S M Phillips", IDENTITY_ORCID_SHARED],
    [IDENTITY_PAPERS.conflictingFirst, "Alex R Mercer", IDENTITY_ORCID_FIRST],
    [IDENTITY_PAPERS.conflictingSecond, "Alex R. Mercer", IDENTITY_ORCID_SECOND],
    [IDENTITY_PAPERS.editable, "Dana Q Rewritten", IDENTITY_ORCID_SHARED],
  ];

  return rows.map(([title, author, orcid]) => ({
    user_id: userId,
    title,
    authors: [author],
    author_provenance: [identityProvenance(author, orcid)],
    year: 2019,
    journal: "Journal of Author Identity",
    keywords: ["epidemiology"],
    notes: null,
  }));
}

/** Deterministic keyword vocabulary so the keyword filter has stable options. */
const KEYWORD_VOCAB = [
  "oncology",
  "cardiology",
  "neurology",
  "immunology",
  "genetics",
  "epidemiology",
  "pharmacology",
  "radiology",
];

/** Deterministic study-type vocabulary (stored free-text on the paper). */
const STUDY_TYPES = [
  "Randomized Controlled Trial",
  "Cohort Study",
  "Case-Control Study",
  "Systematic Review",
  "Meta-Analysis",
];

function assertLoopbackApiUrl(apiUrl) {
  const url = new URL(apiUrl); // throws on malformed
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Seed refused: API URL must be http(s), got ${url.protocol}`);
  }
  if (url.href.toLowerCase().includes(PRODUCTION_SUPABASE_REF)) {
    throw new Error("Seed refused: API URL references the Production project ref.");
  }
  const host = url.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "[::1]" ||
    host === "::1";
  if (!isLoopback) {
    throw new Error(`Seed refused: API URL host "${host}" is not loopback.`);
  }
  return url;
}

/** Strong ephemeral password. Never logged or persisted. */
function makeEphemeralPassword() {
  // "Aa1!" guarantees upper/lower/digit/symbol regardless of policy; the rest
  // is 32 chars of URL-safe entropy.
  return `Aa1!${randomBytes(24).toString("base64url")}`;
}

/**
 * A SQL string literal for the local fixture connection. The lifecycle runs
 * every fixture script with `standard_conforming_strings = on`, so doubling
 * single quotes is the whole escaping rule; a NUL byte cannot be represented
 * and is refused.
 */
export function sqlLiteral(value) {
  const text = String(value);
  if (text.includes("\0")) throw new Error("Fixture SQL refused: a value contains a NUL byte.");
  return `'${text.replaceAll("'", "''")}'`;
}

/** A user id from GoTrue, checked before it is placed in fixture SQL. */
export function assertUuid(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("Fixture SQL refused: not a canonical UUID.");
  }
  return value;
}

/** The lifecycle-supplied local database-owner runner, or a refusal. */
export function assertOwnerSql(ownerSql) {
  if (typeof ownerSql !== "function") {
    throw new Error("Fixture refused: no local database-owner connection was supplied.");
  }
  return ownerSql;
}

function buildPapers(userId, count, titlePrefix, { disposableTitle } = {}) {
  const rows = [];
  for (let n = 1; n <= count; n++) {
    const isDisposable = disposableTitle && n === count;
    const title = isDisposable ? disposableTitle : `${titlePrefix} ${String(n).padStart(3, "0")}`;
    const kwCount = 1 + (n % 3); // 1..3 keywords
    const keywords = [];
    for (let k = 0; k < kwCount; k++) {
      keywords.push(KEYWORD_VOCAB[(n + k) % KEYWORD_VOCAB.length]);
    }
    // Newest PRIMARY_NOTELESS_TAIL rows (highest n → highest insert_order) get
    // no notes, so there are always ≥2 note-less papers among the newest rows.
    const noteless = n > count - PRIMARY_NOTELESS_TAIL;
    rows.push({
      user_id: userId,
      title,
      authors: [`Author A${n}`, `Author B${n}`],
      year: 2000 + (n % 25),
      journal: `Journal of E2E Studies, Vol ${1 + (n % 12)}`,
      abstract:
        `Deterministic abstract for ${title}. This fixture record exercises ` +
        `list rendering, filtering, and eager-loading without any external ` +
        `metadata lookup. Study type: ${STUDY_TYPES[n % STUDY_TYPES.length]}.`,
      keywords,
      notes: noteless ? null : `Deterministic note for ${title}.`,
    });
  }
  return rows;
}

/**
 * One ordered bulk INSERT of fixture papers, as the local table owner. The rows
 * are decoded by `jsonb_populate_recordset` — the same decoding PostgREST
 * applies to a JSON array body — and inserted in array order, so each row
 * draws its `insert_order` default in turn. Only the columns the rows carry are
 * named, so every other column keeps its default, as with a PostgREST insert.
 */
function insertPapersSql(rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  for (const column of columns) {
    if (!/^[a-z_]+$/.test(column)) throw new Error(`Fixture SQL refused: unexpected column name "${column}".`);
  }
  for (const row of rows) assertUuid(row.user_id);
  return (
    "WITH inserted AS (\n" +
    `  INSERT INTO public.papers (${columns.join(", ")})\n` +
    `  SELECT ${columns.map((c) => `r.${c}`).join(", ")}\n` +
    `    FROM jsonb_populate_recordset(NULL::public.papers, ${sqlLiteral(JSON.stringify(rows))}::jsonb) WITH ORDINALITY AS r\n` +
    "   ORDER BY r.ordinality\n" +
    "  RETURNING 1)\n" +
    "SELECT count(*) FROM inserted;"
  );
}

async function insertPapersInOrder(ownerSql, rows, log, who) {
  // Insert in ascending order in bounded batches so insert_order increases with
  // the row index (the last row inserted becomes the newest / highest-order).
  const BATCH = 40;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    let count;
    try {
      count = await ownerSql(insertPapersSql(batch));
    } catch (err) {
      throw new Error(`Failed inserting ${who} papers batch @${i}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (count !== String(batch.length)) {
      throw new Error(`Inserting ${who} papers batch @${i} wrote ${count} rows, expected ${batch.length}.`);
    }
    inserted += batch.length;
  }
  log(`  seeded ${inserted} ${who} papers`);
  return inserted;
}

async function deleteExistingUser(admin, email, log) {
  // Reset wipes auth.users, so this is normally a no-op; it keeps the seed
  // idempotent if invoked against an already-seeded stack.
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`listUsers failed: ${error.message}`);
  const existing = data.users.find((u) => u.email === email);
  if (existing) {
    const { error: delErr } = await admin.auth.admin.deleteUser(existing.id);
    if (delErr) throw new Error(`deleteUser failed: ${delErr.message}`);
    log(`  removed pre-existing user ${email}`);
  }
}

async function createConfirmedUser(admin, email, password) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
  return data.user.id;
}

async function verifyTriggerRows(ownerSql, userId, email) {
  // The signup trigger (handle_new_user) must have created a profile, a Free
  // entitlement, and a lifetime ai_analysis usage counter.
  const uid = sqlLiteral(assertUuid(userId));
  let rows;
  try {
    rows = JSON.parse(
      await ownerSql(
        "SELECT json_build_object(" +
          `'profiles', (SELECT count(*) FROM public.profiles WHERE user_id = ${uid}), ` +
          `'entitlements', (SELECT count(*) FROM public.user_entitlements WHERE user_id = ${uid}), ` +
          `'plan', (SELECT plan FROM public.user_entitlements WHERE user_id = ${uid}), ` +
          `'counters', (SELECT count(*) FROM public.usage_counters WHERE user_id = ${uid} ` +
          "AND feature = 'ai_analysis' AND period_type = 'lifetime'), " +
          `'used', (SELECT used FROM public.usage_counters WHERE user_id = ${uid} ` +
          "AND feature = 'ai_analysis' AND period_type = 'lifetime'))::text;",
      ),
    );
  } catch (err) {
    throw new Error(`signup-trigger row read failed for ${email}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (rows.profiles !== 1) throw new Error(`Trigger did not create a profile for ${email}.`);
  if (rows.entitlements !== 1) throw new Error(`Trigger did not create an entitlement for ${email}.`);
  if (rows.plan !== "free") throw new Error(`Expected Free plan for ${email}, got ${rows.plan}.`);
  if (rows.counters !== 1) throw new Error(`Trigger did not create a lifetime usage counter for ${email}.`);
  if (rows.used !== 0) throw new Error(`Expected used=0 for ${email}, got ${rows.used}.`);
}

async function verifyAuthenticatedIsolation({ apiUrl, anonKey, email, password, expectedCount, foreignTitlePrefix, expectHighestOrderTitle, log }) {
  // Prove, using a NORMAL authenticated client (not service-role), that RLS
  // scopes reads to the signed-in user and the entitlement/quota read paths work.
  const client = createClient(apiUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`sign-in failed for ${email}: ${signIn.error.message}`);
  const userId = signIn.data.user.id;

  const own = await client.from("papers").select("id", { count: "exact", head: true });
  if (own.error) throw new Error(`authenticated paper count failed for ${email}: ${own.error.message}`);
  if (own.count !== expectedCount) {
    throw new Error(`Expected ${expectedCount} papers for ${email}, saw ${own.count}.`);
  }

  const foreign = await client
    .from("papers")
    .select("id", { count: "exact", head: true })
    .ilike("title", `${foreignTitlePrefix}%`);
  if (foreign.error) throw new Error(`cross-user probe failed for ${email}: ${foreign.error.message}`);
  if (foreign.count !== 0) {
    throw new Error(`RLS breach: ${email} can see ${foreign.count} other-user papers.`);
  }

  const ent = await client.from("user_entitlements").select("plan").maybeSingle();
  if (ent.error) throw new Error(`entitlement read path broke for ${email}: ${ent.error.message}`);
  if (!ent.data || ent.data.plan !== "free") {
    throw new Error(`entitlement read path returned unexpected data for ${email}.`);
  }

  // Determinism proof: the newest paper (highest insert_order) must be the
  // designated disposable fixture. Because rows are inserted in ascending order
  // and insert_order auto-increments, this is stable across every reset/reseed.
  if (expectHighestOrderTitle) {
    const top = await client
      .from("papers")
      .select("title, insert_order")
      .order("insert_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (top.error) throw new Error(`highest-order probe failed for ${email}: ${top.error.message}`);
    if (!top.data || top.data.title !== expectHighestOrderTitle) {
      throw new Error(
        `Expected highest insert_order paper "${expectHighestOrderTitle}" for ${email}, got "${top.data?.title ?? "<none>"}".`,
      );
    }
    log(`  verified highest insert_order paper is the disposable fixture for ${email}`);
  }

  const quota = await client.rpc("get_ai_quota_status", { p_user_id: userId });
  if (quota.error) throw new Error(`quota-status read path broke for ${email}: ${quota.error.message}`);
  const row = Array.isArray(quota.data) ? quota.data[0] : quota.data;
  if (!row || row.plan !== "free" || row.allowed !== true) {
    throw new Error(`quota-status returned unexpected projection for ${email}.`);
  }

  const signOut = await client.auth.signOut();
  if (signOut.error) throw new Error(`sign-out failed for ${email}: ${signOut.error.message}`);
  log(`  verified authenticated isolation + read paths for ${email} (${expectedCount} papers)`);
}

/**
 * AUTHOR-IDENTITY-RESOLUTION-001C — cross-user isolation, proven over the real
 * Data API rather than only in pgTAP.
 *
 * The database suite already proves this at the SQL level. This probe exists
 * because the property that actually matters to a user is reached through
 * PostgREST with a real JWT, where a missing grant, a missing policy or a
 * mis-scoped RPC would show up as a leak that SQL-level tests cannot see.
 *
 * User A creates an identity from one of their own papers. User B must then be
 * unable to read it, to infer its name or its ORCID, or to attach their own
 * paper to it.
 *
 * Runs entirely on the loopback stack with `.test` identities and the local
 * publishable key. No Production account is involved.
 */
async function verifyIdentityIsolation({ apiUrl, anonKey, primary, secondary, log }) {
  const clientFor = async ({ email, password }) => {
    const client = createClient(apiUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`identity probe sign-in failed: ${signIn.error.message}`);
    return client;
  };

  const a = await clientFor(primary);
  const b = await clientFor(secondary);

  try {
    // A owns the identity fixtures, so this paper is theirs.
    const target = await a
      .from("papers")
      .select("id, authors")
      .eq("title", IDENTITY_PAPERS.sameOrcidFullName)
      .maybeSingle();
    if (target.error || !target.data) {
      throw new Error(`identity probe: fixture paper missing (${target.error?.message ?? "no row"})`);
    }

    const created = await a.rpc("create_author_identity_from_mention", {
      p_paper_id: target.data.id,
      p_author_index: 0,
      p_expected_author: target.data.authors[0],
      p_preferred_name: "E2E Isolation Person",
    });
    if (created.error) {
      throw new Error(`identity probe: A could not create an identity (${created.error.message})`);
    }
    const identityId = created.data?.identity_id;
    if (!identityId) throw new Error("identity probe: no identity id returned");

    // B must see nothing of it, through any of the four tables.
    for (const table of [
      "author_identities",
      "author_identity_aliases",
      "author_identity_links",
      "author_identity_merges",
    ]) {
      const seen = await b.from(table).select("*", { count: "exact", head: true });
      if (seen.error) throw new Error(`identity probe: B read of ${table} errored: ${seen.error.message}`);
      if ((seen.count ?? 0) !== 0) {
        throw new Error(`RLS breach: B can see ${seen.count} row(s) of A's ${table}.`);
      }
    }

    // B must not be able to attach their own paper to A's identity. The failure
    // must come from the server, not from the absence of a UI path.
    const bPaper = await b.from("papers").select("id, authors").limit(1).maybeSingle();
    if (bPaper.error || !bPaper.data) {
      throw new Error(`identity probe: B has no paper to test with (${bPaper.error?.message ?? "no row"})`);
    }
    const attach = await b.rpc("link_author_mention_to_identity", {
      p_paper_id: bPaper.data.id,
      p_author_index: 0,
      p_expected_author: bPaper.data.authors[0],
      p_identity_id: identityId,
      p_resolution_basis: "manual",
      p_replace_existing: false,
    });
    if (!attach.error) {
      throw new Error("RLS breach: B attached their paper to A's identity.");
    }

    // ...nor merge into it, nor delete it.
    const merge = await b.rpc("merge_author_identities", {
      p_source_identity_id: identityId,
      p_target_identity_id: identityId,
    });
    if (!merge.error) throw new Error("RLS breach: B merged A's identity.");

    const remove = await b.rpc("delete_empty_author_identity", { p_identity_id: identityId });
    if (!remove.error) throw new Error("RLS breach: B deleted A's identity.");

    // Leave the stack exactly as the specs expect to find it: no identity
    // decisions, so every E2E flow starts from the same unresolved state.
    const unlink = await a.rpc("unlink_author_mention_identity", {
      p_paper_id: target.data.id,
      p_author_index: 0,
    });
    if (unlink.error) throw new Error(`identity probe cleanup failed: ${unlink.error.message}`);
    const cleanup = await a.rpc("delete_empty_author_identity", { p_identity_id: identityId });
    if (cleanup.error) throw new Error(`identity probe cleanup failed: ${cleanup.error.message}`);

    log("  verified cross-user author-identity isolation over the Data API");
  } finally {
    await a.auth.signOut();
    await b.auth.signOut();
  }
}

/**
 * Seed the validated local stack. Returns the ephemeral primary/secondary
 * credentials in memory so the caller can hand them to Playwright without ever
 * writing them to disk. Never logs a password or key.
 *
 * @param {{ apiUrl: string, serviceRoleKey: string, anonKey: string, ownerSql: (sql: string) => Promise<string>, log?: (m: string) => void }} opts
 */
export async function seedLocalStack({ apiUrl, serviceRoleKey, anonKey, ownerSql, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  if (!serviceRoleKey || !anonKey) {
    throw new Error("Seed refused: missing local service-role or anon key.");
  }
  assertOwnerSql(ownerSql);

  const admin = createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const primaryPassword = makeEphemeralPassword();
  const secondaryPassword = makeEphemeralPassword();

  log("Seeding local Supabase stack (loopback)…");

  // 1. Fresh users (idempotent).
  await deleteExistingUser(admin, PRIMARY_EMAIL, log);
  await deleteExistingUser(admin, SECONDARY_EMAIL, log);
  const primaryId = await createConfirmedUser(admin, PRIMARY_EMAIL, primaryPassword);
  const secondaryId = await createConfirmedUser(admin, SECONDARY_EMAIL, secondaryPassword);
  log(`  created users: ${PRIMARY_EMAIL}, ${SECONDARY_EMAIL}`);

  // 2. Trigger-created rows must exist.
  await verifyTriggerRows(ownerSql, primaryId, PRIMARY_EMAIL);
  await verifyTriggerRows(ownerSql, secondaryId, SECONDARY_EMAIL);
  log("  verified signup-trigger profile / entitlement / usage rows");

  // 3. Deterministic fixture libraries.
  const primaryPapers = buildPapers(primaryId, PRIMARY_PAPER_COUNT, "E2E Primary Paper", {
    disposableTitle: DISPOSABLE_PAPER_TITLE,
  });
  const secondaryPapers = buildPapers(secondaryId, SECONDARY_PAPER_COUNT, "E2E Secondary Paper");
  // Identity fixtures go in FIRST so the disposable paper keeps the highest
  // insert_order, which the ordering specs depend on.
  await insertPapersInOrder(ownerSql, buildIdentityPapers(primaryId), log, "primary identity fixture");
  await insertPapersInOrder(ownerSql, primaryPapers, log, "primary");
  await insertPapersInOrder(ownerSql, secondaryPapers, log, "secondary");

  // 4. Authenticated read-back proves RLS isolation + read paths (both users).
  await verifyAuthenticatedIsolation({
    apiUrl,
    anonKey,
    email: PRIMARY_EMAIL,
    password: primaryPassword,
    expectedCount: PRIMARY_TOTAL_PAPER_COUNT,
    foreignTitlePrefix: "E2E Secondary Paper",
    expectHighestOrderTitle: DISPOSABLE_PAPER_TITLE,
    log,
  });
  await verifyAuthenticatedIsolation({
    apiUrl,
    anonKey,
    email: SECONDARY_EMAIL,
    password: secondaryPassword,
    expectedCount: SECONDARY_PAPER_COUNT,
    foreignTitlePrefix: "E2E Primary Paper",
    log,
  });

  // 5. AUTHOR-IDENTITY-RESOLUTION-001C cross-user isolation, over the real API.
  await verifyIdentityIsolation({
    apiUrl,
    anonKey,
    primary: { email: PRIMARY_EMAIL, password: primaryPassword },
    secondary: { email: SECONDARY_EMAIL, password: secondaryPassword },
    log,
  });

  return {
    primary: {
      email: PRIMARY_EMAIL,
      password: primaryPassword,
      userId: primaryId,
      paperCount: PRIMARY_TOTAL_PAPER_COUNT,
      disposableTitle: DISPOSABLE_PAPER_TITLE,
    },
    secondary: {
      email: SECONDARY_EMAIL,
      password: secondaryPassword,
      userId: secondaryId,
      paperCount: SECONDARY_PAPER_COUNT,
    },
  };
}
