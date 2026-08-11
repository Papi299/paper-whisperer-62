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
 *   - Uses the local service-role key for Admin/seed writes and the local
 *     publishable (anon) key for the authenticated read-back verification.
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

/** The newest N primary papers (highest insert_order) are intentionally note-less. */
const PRIMARY_NOTELESS_TAIL = 5;

/** Clearly designated disposable / highest-order paper for later attribution work. */
export const DISPOSABLE_PAPER_TITLE =
  "E2E Primary Paper 120 — Disposable Highest-Order";

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

async function insertPapersInOrder(admin, rows, log, who) {
  // Insert in ascending order in bounded batches so insert_order increases with
  // the row index (the last row inserted becomes the newest / highest-order).
  const BATCH = 40;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await admin.from("papers").insert(batch);
    if (error) {
      throw new Error(`Failed inserting ${who} papers batch @${i}: ${error.message}`);
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

async function verifyTriggerRows(admin, userId, email) {
  // The signup trigger (handle_new_user) must have created a profile, a Free
  // entitlement, and a lifetime ai_analysis usage counter.
  const profile = await admin.from("profiles").select("user_id").eq("user_id", userId).maybeSingle();
  if (profile.error) throw new Error(`profiles read failed for ${email}: ${profile.error.message}`);
  if (!profile.data) throw new Error(`Trigger did not create a profile for ${email}.`);

  const ent = await admin
    .from("user_entitlements")
    .select("plan,plan_status,ai_lifetime_quota")
    .eq("user_id", userId)
    .maybeSingle();
  if (ent.error) throw new Error(`entitlement read failed for ${email}: ${ent.error.message}`);
  if (!ent.data) throw new Error(`Trigger did not create an entitlement for ${email}.`);
  if (ent.data.plan !== "free") throw new Error(`Expected Free plan for ${email}, got ${ent.data.plan}.`);

  const counter = await admin
    .from("usage_counters")
    .select("feature,period_type,used")
    .eq("user_id", userId)
    .eq("feature", "ai_analysis")
    .eq("period_type", "lifetime")
    .maybeSingle();
  if (counter.error) throw new Error(`usage_counter read failed for ${email}: ${counter.error.message}`);
  if (!counter.data) throw new Error(`Trigger did not create a lifetime usage counter for ${email}.`);
  if (counter.data.used !== 0) throw new Error(`Expected used=0 for ${email}, got ${counter.data.used}.`);
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
 * Seed the validated local stack. Returns the ephemeral primary/secondary
 * credentials in memory so the caller can hand them to Playwright without ever
 * writing them to disk. Never logs a password or key.
 *
 * @param {{ apiUrl: string, serviceRoleKey: string, anonKey: string, log?: (m: string) => void }} opts
 */
export async function seedLocalStack({ apiUrl, serviceRoleKey, anonKey, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  if (!serviceRoleKey || !anonKey) {
    throw new Error("Seed refused: missing local service-role or anon key.");
  }

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
  await verifyTriggerRows(admin, primaryId, PRIMARY_EMAIL);
  await verifyTriggerRows(admin, secondaryId, SECONDARY_EMAIL);
  log("  verified signup-trigger profile / entitlement / usage rows");

  // 3. Deterministic fixture libraries.
  const primaryPapers = buildPapers(primaryId, PRIMARY_PAPER_COUNT, "E2E Primary Paper", {
    disposableTitle: DISPOSABLE_PAPER_TITLE,
  });
  const secondaryPapers = buildPapers(secondaryId, SECONDARY_PAPER_COUNT, "E2E Secondary Paper");
  await insertPapersInOrder(admin, primaryPapers, log, "primary");
  await insertPapersInOrder(admin, secondaryPapers, log, "secondary");

  // 4. Authenticated read-back proves RLS isolation + read paths (both users).
  await verifyAuthenticatedIsolation({
    apiUrl,
    anonKey,
    email: PRIMARY_EMAIL,
    password: primaryPassword,
    expectedCount: PRIMARY_PAPER_COUNT,
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

  return {
    primary: {
      email: PRIMARY_EMAIL,
      password: primaryPassword,
      userId: primaryId,
      paperCount: PRIMARY_PAPER_COUNT,
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
