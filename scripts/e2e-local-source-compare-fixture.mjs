// @ts-nocheck
/**
 * Disposable accounts for the EVIDENCE-RECORDS-001C2C-A source-comparison E2E
 * (`e2e/study-records-source-compare.spec.ts`).
 *
 * Its own accounts, papers, study records and proof — nothing is shared with
 * the C1, C2A or C2B fixtures, so the four specs can run alone, together, and
 * in any order. The pilot owner role is granted the way Production's operator
 * grants it: a server-side row in the LOCAL `internal_user_access`, written as
 * the local database owner, for disposable users only — never a seed
 * identity, never a client-side flag.
 *
 *   * OWNER (`e2e-disposable-srsc-owner-…`), role `owner` for the whole run,
 *     one study record per source state the banner tells apart:
 *       - "SRSC-E2E Same trial": the library abstract is the saved copy;
 *       - "SRSC-E2E Typography trial": the library abstract was retyped —
 *         curly quotes, an en dash, a no-break space — equal after v1 only;
 *       - "SRSC-E2E Changed trial": the library abstract was revised in three
 *         places after the copy was saved, and its condition is quoted;
 *       - "SRSC-E2E Removed trial": the library abstract was removed;
 *       - "SRSC-E2E New abstract trial": created without an abstract (no
 *         copy), and the paper has one now;
 *       - "SRSC-E2E Copies trial": two saved copies. Copy 1 was saved at
 *         creation; the abstract was revised and the installed rebase saved
 *         copy 2, moving the condition's quote (found once) and leaving the
 *         setting's (not found) on copy 1.
 *   * FORMER (`e2e-disposable-srsc-former-…`): granted `owner`, given a study
 *     record with two copies the same way and a revised abstract after them,
 *     then set to `manager`. Comparing and reading copies stay theirs;
 *     nothing can be written.
 *
 * Every evidence row is written by the installed RPCs, as its own user
 * (`evidence_create_study_from_paper`, `evidence_save_changes`,
 * `evidence_rebase_source`), and every library change is the owner's own
 * `papers` update under RLS — never a snapshot, anchor or event inserted
 * directly. Access levels stay separate: the local secret key does Auth
 * administration only; roles and every verification query go through
 * `ownerSql` (postgres on the container socket).
 *
 * After Playwright, `assertSourceCompareOutcomeAndRemove` checks as the
 * database owner what only the database can see: both users' evidence rows —
 * studies, links, copies (text by md5), values, quotes with their offsets,
 * events — exactly as provisioned, so nothing the comparison did wrote
 * anything; and every library abstract as provisioned except the one the spec
 * edits itself ("in another tab"). Then it removes both accounts and VERIFIES
 * that no account with this module's prefixes and no row of theirs remains.
 *
 * Hard safety rules (mirroring the other fixture modules): loopback target
 * only, checked before any credential is used; only `.test` identities with
 * this module's prefixes; fresh ephemeral passwords, never logged or
 * persisted; no key, token or password is ever printed.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { PRIMARY_EMAIL, SECONDARY_EMAIL, assertOwnerSql, assertUuid, sqlLiteral } from "./e2e-local-seed.mjs";
import { assertLoopbackApiUrl } from "./e2e-local-delete-fixture.mjs";

export const OWNER_PREFIX = "e2e-disposable-srsc-owner-";
export const FORMER_PREFIX = "e2e-disposable-srsc-former-";

export const SOURCE_TITLES = Object.freeze({
  same: "SRSC-E2E Same trial",
  typography: "SRSC-E2E Typography trial",
  changed: "SRSC-E2E Changed trial",
  removed: "SRSC-E2E Removed trial",
  added: "SRSC-E2E New abstract trial",
  copies: "SRSC-E2E Copies trial",
  former: "SRSC-E2E Former owner's trial",
});

const NBSP = String.fromCodePoint(0x00a0);
const EN_DASH = String.fromCodePoint(0x2013);
const LEFT_QUOTE = String.fromCodePoint(0x201c);
const RIGHT_QUOTE = String.fromCodePoint(0x201d);

export const SOURCE_TEXTS = Object.freeze({
  same: "Background: A synthetic trial of daily walking in adults with hypertension.\nMethods: 90 participants were randomized 1:1 to walking or usual care for 16 weeks.\nResults: Systolic blood pressure fell by 6 mmHg with walking.",
  // What the spec writes to the Same trial's paper "in another tab", before Check again.
  sameEdited:
    "Background: A synthetic trial of daily walking in adults with hypertension.\nMethods: 92 participants were randomized 1:1 to walking or usual care for 16 weeks.\nResults: Systolic blood pressure fell by 6 mmHg with walking.",
  typographySaved: 'Background: A synthetic trial of "standing desks" in office workers.\nMethods: 60 participants were randomized for 12-14 weeks.',
  typographyLibrary: `Background: A synthetic trial of ${LEFT_QUOTE}standing desks${RIGHT_QUOTE} in office workers.\nMethods: 60${NBSP}participants were randomized for 12${EN_DASH}14 weeks.`,
  changedSaved:
    "Background: A synthetic trial of metformin in adults with type 2 diabetes.\nMethods: 120 participants were randomized to metformin or placebo for 24 weeks.\nResults: HbA1c fell by 0.8 % with metformin.",
  changedLibrary:
    "Background: A synthetic trial of metformin in adults with type 2 diabetes.\nMethods: 118 participants were randomized to metformin or placebo for 26 weeks.\nResults: HbA1c fell by 0.8 % with metformin.\nConclusions: Metformin lowered HbA1c.",
  removedSaved: "Background: A synthetic trial of yoga for chronic back pain.\nMethods: 50 participants were randomized.",
  added: "Background: A synthetic trial of tai chi in older adults.\nMethods: 70 participants were randomized.",
  copiesFirst: "Background: A synthetic trial of a low-salt diet in adults with heart failure.\nMethods: 80 participants were randomized at three hospitals.\nResults: Readmissions fell.",
  copiesSecond: "Background: A synthetic trial of a low-salt diet in adults with heart failure.\nMethods: 80 participants were randomized at four hospitals.\nResults: Readmissions fell by a fifth.",
  formerFirst: "Background: A synthetic trial of mindfulness in nurses.\nMethods: 40 participants were randomized.",
  formerSecond: "Background: A synthetic trial of mindfulness in nurses and midwives.\nMethods: 44 participants were randomized.",
  formerLibrary: "Background: A synthetic trial of mindfulness in nurses and midwives.\nMethods: 44 participants were randomized.\nResults: Stress scores fell.",
});

/** The quotes the spec looks for: on copy 1 of the Copies trial (kept there by the rebase), and on the former owner's copy 1. */
export const SOURCE_QUOTES = Object.freeze({
  copiesMoved: "adults with heart failure",
  copiesKept: "at three hospitals",
  changed: "adults with type 2 diabetes",
  formerKept: "40 participants",
  formerMoved: "mindfulness in nurses",
});

const EMPTY_LISTS = { keywords: [], raw_keywords: [], mesh_terms: [], substances: [] };

function assertDisposableEmail(email) {
  if (typeof email !== "string" || !email.endsWith("@paperlume.test")) {
    throw new Error("Source compare fixture refused: disposable email must be a .test address.");
  }
  if (email === PRIMARY_EMAIL || email === SECONDARY_EMAIL) {
    throw new Error("Source compare fixture refused: will not target a deterministic seed identity.");
  }
  if (!email.startsWith(OWNER_PREFIX) && !email.startsWith(FORMER_PREFIX)) {
    throw new Error("Source compare fixture refused: disposable email must carry this module's prefix.");
  }
  return email;
}

function makeEphemeralPassword() {
  return `Aa1!${randomBytes(24).toString("base64url")}`;
}

/** The SHA-256 of the UTF-8 bytes, lowercase hex: what the rebase compares with the abstract it reads. */
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The last line of an owner-SQL answer, as JSON. */
async function ownerJson(ownerSql, sql) {
  const out = await ownerSql(sql);
  return JSON.parse(out.split("\n").pop());
}

async function setRole(ownerSql, userId, role) {
  const uid = sqlLiteral(assertUuid(userId));
  const result = await ownerJson(
    ownerSql,
    "WITH upserted AS (\n" +
      `  INSERT INTO public.internal_user_access (user_id, role) VALUES (${uid}, ${sqlLiteral(role)})\n` +
      "  ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role RETURNING role)\n" +
      "SELECT coalesce(json_agg(upserted.role), '[]'::json)::text FROM upserted;",
  );
  if (result.length !== 1 || result[0] !== role) throw new Error(`source compare fixture: role ${role} did not take effect.`);
}

async function createAccount(admin, prefix) {
  const email = assertDisposableEmail(`${prefix}${randomUUID()}@paperlume.test`);
  const password = makeEphemeralPassword();
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(`source compare fixture createUser failed: ${created.error.message}`);
  return { email, password, userId: created.data.user.id };
}

async function signedIn(apiUrl, anonKey, account) {
  const client = createClient(apiUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email: account.email, password: account.password });
  if (signIn.error) throw new Error(`source compare fixture sign-in failed: ${signIn.error.message}`);
  return client;
}

function paper(userId, title, doi, abstract) {
  return { ...EMPTY_LISTS, user_id: userId, title, authors: ["Roe R"], year: 2025, journal: "Journal of Comparison Fixtures", doi, abstract, study_type: "Randomized Controlled Trial" };
}

async function insertPapers(client, rows) {
  const inserted = await client.from("papers").insert(rows).select("id, title");
  if (inserted.error) throw new Error(`source compare fixture paper insert failed: ${inserted.error.message}`);
  const byTitle = {};
  for (const row of inserted.data) byTitle[row.title] = row.id;
  return byTitle;
}

/** The owner editing their own library abstract, as Edit Paper does: a `papers` update under RLS. */
async function setAbstract(client, paperId, abstract) {
  const updated = await client.from("papers").update({ abstract }).eq("id", paperId).select("id");
  if (updated.error || updated.data?.length !== 1) throw new Error("source compare fixture: a library abstract did not update.");
}

/** One RPC as the signed-in user; the answer must be `status` at the expected study version. */
async function rpc(client, fn, args, expected) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`source compare fixture ${fn} failed: ${error.message}`);
  if (!data || data.status !== expected.status || (expected.version !== undefined && data.study_version !== expected.version)) {
    throw new Error(`source compare fixture: ${fn} did not answer ${expected.status} at version ${expected.version}.`);
  }
  return data;
}

async function createStudy(client, paperId, label, { copy = true } = {}) {
  const data = await rpc(
    client,
    "evidence_create_study_from_paper",
    { p_paper_id: paperId, p_label: label, p_design_profile: "rct_parallel", p_link_status: "user_confirmed", p_request_id: randomUUID() },
    { status: "applied", version: 1 },
  );
  if (copy !== !!data.snapshot_id) throw new Error(`source compare fixture: the study ${copy ? "has no" : "has a"} saved copy of the abstract.`);
  return { studyId: data.study_id, snapshotId: data.snapshot_id };
}

const quote = (paperId, snapshotId, text) => ({
  purpose: "supports",
  source_kind: "abstract",
  paper_id: paperId,
  snapshot_id: snapshotId,
  quote_text: text,
  occurrence: null,
  expected_match_count: null,
});
const setValue = (fieldKey, content, references) => ({
  op: "set_value",
  target: { scope: "study" },
  field_key: fieldKey,
  expected_value_version: null,
  value_state: "reported",
  state_reason: null,
  content: { shape: "text", text: content },
  note: null,
  references,
});

async function saveChanges(client, studyId, expectedVersion, changes) {
  await rpc(
    client,
    "evidence_save_changes",
    { p_study_id: studyId, p_expected_version: expectedVersion, p_changes: changes, p_request_id: randomUUID() },
    { status: "applied", version: expectedVersion + 1 },
  );
}

/** The installed rebase, as the owner: a new copy of `abstract`, which must be the paper's abstract now. */
async function rebase(client, studyId, paperId, expectedVersion, abstract, expected) {
  const data = await rpc(
    client,
    "evidence_rebase_source",
    {
      p_study_id: studyId,
      p_paper_id: paperId,
      p_expected_version: expectedVersion,
      p_expected_abstract_sha256: sha256(abstract),
      p_request_id: randomUUID(),
    },
    { status: "applied", version: expectedVersion + 1 },
  );
  if (data.seq !== expected.seq || data.rematched !== expected.rematched || data.not_found !== expected.notFound) {
    throw new Error("source compare fixture: the rebase did not save the expected copy, or did not keep and move the expected quotes.");
  }
}

/**
 * Everything of one user's evidence rows, for an exact before/after
 * comparison: studies and links, copies by sequence and text digest, values
 * with their reviews and versions, quotes with the copy and offsets they name,
 * and every event.
 */
async function evidenceFingerprint(ownerSql, userId) {
  const uid = sqlLiteral(assertUuid(userId));
  return ownerJson(
    ownerSql,
    "SELECT json_build_object(" +
      `'studies', (SELECT coalesce(json_agg(json_build_object('id', id, 'version', row_version, 'label', label, 'updated', updated_at) ORDER BY id), '[]'::json) FROM public.evidence_studies WHERE user_id = ${uid}), ` +
      `'links', (SELECT coalesce(json_agg(json_build_object('id', id, 'paper', paper_id, 'status', link_status, 'updated', updated_at) ORDER BY id), '[]'::json) FROM public.evidence_study_reports WHERE user_id = ${uid}), ` +
      `'copies', (SELECT coalesce(json_agg(json_build_object('id', id, 'paper', paper_id, 'seq', seq, 'chars', char_count, 'md5', md5(exact_text), 'sha', exact_sha256) ORDER BY id), '[]'::json) FROM public.evidence_source_snapshots WHERE user_id = ${uid}), ` +
      `'values', (SELECT coalesce(json_agg(json_build_object('id', id, 'field', field_key, 'version', value_version, 'status', review_status, 'reason', review_reason, 'updated', updated_at) ORDER BY id), '[]'::json) FROM public.evidence_field_values WHERE user_id = ${uid}), ` +
      `'anchors', (SELECT coalesce(json_agg(json_build_object('id', id, 'copy', snapshot_id, 'start', match_start, 'end', match_end, 'quote', quote_text) ORDER BY id), '[]'::json) FROM public.evidence_field_anchors WHERE user_id = ${uid}), ` +
      `'events', (SELECT coalesce(json_agg(json_build_object('study', study_id, 'version', study_version, 'ordinal', ordinal, 'type', event_type) ORDER BY study_id, study_version, ordinal), '[]'::json) FROM public.evidence_events WHERE user_id = ${uid})` +
      ")::text;",
  );
}

/** One user's library abstracts, by title, as digests (null for no abstract). */
async function abstractsOf(ownerSql, userId) {
  const uid = sqlLiteral(assertUuid(userId));
  return ownerJson(ownerSql, `SELECT coalesce(json_object_agg(title, md5(abstract) ORDER BY title), '{}'::json)::text FROM public.papers WHERE user_id = ${uid};`);
}

const md5 = (text) => (text === null ? null : createHash("md5").update(text, "utf8").digest("hex"));
const canonical = (value) => JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

/**
 * Create both accounts and everything they hold. Returns the credentials for
 * the Playwright environment and what the post-run proof compares against.
 * Nothing returned is printed.
 */
export async function provisionSourceCompareAccounts({ apiUrl, anonKey, serviceRoleKey, ownerSql, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  if (!serviceRoleKey || !anonKey) throw new Error("Source compare fixture refused: missing local service-role or anon key.");
  assertOwnerSql(ownerSql);

  const admin = createClient(apiUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const accounts = [];
  try {
    // ── The pilot owner ──
    const owner = await createAccount(admin, OWNER_PREFIX);
    accounts.push(owner);
    await setRole(ownerSql, owner.userId, "owner");
    const client = await signedIn(apiUrl, anonKey, owner);
    const t = SOURCE_TEXTS;
    owner.papers = await insertPapers(client, [
      paper(owner.userId, SOURCE_TITLES.same, "10.5555/srsc-e2e.0001", t.same),
      paper(owner.userId, SOURCE_TITLES.typography, "10.5555/srsc-e2e.0002", t.typographySaved),
      paper(owner.userId, SOURCE_TITLES.changed, "10.5555/srsc-e2e.0003", t.changedSaved),
      paper(owner.userId, SOURCE_TITLES.removed, "10.5555/srsc-e2e.0004", t.removedSaved),
      paper(owner.userId, SOURCE_TITLES.added, "10.5555/srsc-e2e.0005", null),
      paper(owner.userId, SOURCE_TITLES.copies, "10.5555/srsc-e2e.0006", t.copiesFirst),
    ]);
    const ids = owner.papers;

    await createStudy(client, ids[SOURCE_TITLES.same], "SRSC Same trial");

    await createStudy(client, ids[SOURCE_TITLES.typography], "SRSC Typography trial");
    await setAbstract(client, ids[SOURCE_TITLES.typography], t.typographyLibrary);

    const changed = await createStudy(client, ids[SOURCE_TITLES.changed], "SRSC Changed trial");
    await saveChanges(client, changed.studyId, 1, [setValue("condition", "Type 2 diabetes", [quote(ids[SOURCE_TITLES.changed], changed.snapshotId, SOURCE_QUOTES.changed)])]);
    await setAbstract(client, ids[SOURCE_TITLES.changed], t.changedLibrary);

    await createStudy(client, ids[SOURCE_TITLES.removed], "SRSC Removed trial");
    await setAbstract(client, ids[SOURCE_TITLES.removed], null);

    await createStudy(client, ids[SOURCE_TITLES.added], "SRSC New abstract trial", { copy: false });
    await setAbstract(client, ids[SOURCE_TITLES.added], t.added);

    const copiesPaper = ids[SOURCE_TITLES.copies];
    const copies = await createStudy(client, copiesPaper, "SRSC Copies trial");
    await saveChanges(client, copies.studyId, 1, [
      setValue("condition", "Heart failure", [quote(copiesPaper, copies.snapshotId, SOURCE_QUOTES.copiesMoved)]),
      setValue("setting", "Three hospitals", [quote(copiesPaper, copies.snapshotId, SOURCE_QUOTES.copiesKept)]),
    ]);
    await setAbstract(client, copiesPaper, t.copiesSecond);
    // Copy 2: the condition's quote is found once and moves; the setting's isn't found and stays on copy 1.
    await rebase(client, copies.studyId, copiesPaper, 2, t.copiesSecond, { seq: 2, rematched: 1, notFound: 1 });
    await client.auth.signOut();

    // ── The former owner, now a manager ──
    const former = await createAccount(admin, FORMER_PREFIX);
    accounts.push(former);
    await setRole(ownerSql, former.userId, "owner");
    const formerClient = await signedIn(apiUrl, anonKey, former);
    former.papers = await insertPapers(formerClient, [paper(former.userId, SOURCE_TITLES.former, "10.5555/srsc-e2e.0101", t.formerFirst)]);
    const formerPaper = former.papers[SOURCE_TITLES.former];
    const formerStudy = await createStudy(formerClient, formerPaper, "SRSC Former owner's trial");
    await saveChanges(formerClient, formerStudy.studyId, 1, [
      setValue("condition", "Nurses", [quote(formerPaper, formerStudy.snapshotId, SOURCE_QUOTES.formerMoved)]),
      setValue("setting", "Hospital wards", [quote(formerPaper, formerStudy.snapshotId, SOURCE_QUOTES.formerKept)]),
    ]);
    await setAbstract(formerClient, formerPaper, t.formerSecond);
    await rebase(formerClient, formerStudy.studyId, formerPaper, 2, t.formerSecond, { seq: 2, rematched: 1, notFound: 1 });
    await setAbstract(formerClient, formerPaper, t.formerLibrary);
    await formerClient.auth.signOut();
    await setRole(ownerSql, former.userId, "manager");

    owner.before = await evidenceFingerprint(ownerSql, owner.userId);
    former.before = await evidenceFingerprint(ownerSql, former.userId);
    log("  provisioned source-compare accounts: pilot owner (6 papers, 6 study records — one per source state, one with two saved copies) and former owner now manager (1 study record with two copies)");
    return { owner, former };
  } catch (err) {
    await removeSourceCompareAccounts({ apiUrl, serviceRoleKey, ownerSql, accounts: { list: accounts }, log }).catch(() => {});
    throw err;
  }
}

/**
 * Authoritative post-run proof, as the database owner, then removal — the
 * removal verified too. The spec asserts what the browser can see; this
 * asserts what only the database can: that comparing wrote nothing.
 */
export async function assertSourceCompareOutcomeAndRemove({ apiUrl, serviceRoleKey, ownerSql, accounts, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  assertOwnerSql(ownerSql);
  const { owner, former } = accounts;
  assertDisposableEmail(owner.email);
  assertDisposableEmail(former.email);

  // Not one evidence row changed, for either user: no copy, quote, value, review, link, version or event.
  for (const [label, account] of [
    ["the pilot owner", owner],
    ["the former owner", former],
  ]) {
    const after = await evidenceFingerprint(ownerSql, account.userId);
    if (canonical(after) !== canonical(account.before)) {
      throw new Error(`study-records-source-compare E2E: ${label}'s study records changed; comparing must write nothing.`);
    }
  }

  // The library: as provisioned, except the Same trial's abstract, which the spec edits "in another tab".
  const t = SOURCE_TEXTS;
  const expectedOwner = {
    [SOURCE_TITLES.same]: md5(t.sameEdited),
    [SOURCE_TITLES.typography]: md5(t.typographyLibrary),
    [SOURCE_TITLES.changed]: md5(t.changedLibrary),
    [SOURCE_TITLES.removed]: null,
    [SOURCE_TITLES.added]: md5(t.added),
    [SOURCE_TITLES.copies]: md5(t.copiesSecond),
  };
  const ownerAbstracts = await abstractsOf(ownerSql, owner.userId);
  if (canonical(ownerAbstracts) !== canonical(expectedOwner)) {
    throw new Error(`study-records-source-compare E2E: the pilot owner's library abstracts are ${canonical(Object.keys(ownerAbstracts))}, not as expected.`);
  }
  const formerAbstracts = await abstractsOf(ownerSql, former.userId);
  if (canonical(formerAbstracts) !== canonical({ [SOURCE_TITLES.former]: md5(t.formerLibrary) })) {
    throw new Error("study-records-source-compare E2E: the former owner's library abstract changed.");
  }
  log("  verified: both users' study records exactly as provisioned — no copy, quote, value, review, version or event written by comparing — and the library as provisioned but for the spec's own edit");

  await removeSourceCompareAccounts({ apiUrl, serviceRoleKey, ownerSql, accounts: { list: [owner, former] }, log });
}

/**
 * Remove both accounts — their papers, study records and history go with
 * them (every table cascades from `auth.users`) — then VERIFY, as the database
 * owner, that no account with this module's prefixes and no row of theirs
 * remains. Throws when anything does.
 */
export async function removeSourceCompareAccounts({ apiUrl, serviceRoleKey, ownerSql, accounts, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  assertOwnerSql(ownerSql);
  const list = (accounts?.list ?? [accounts?.owner, accounts?.former]).filter(Boolean);
  const admin = createClient(apiUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  for (const account of list) {
    assertDisposableEmail(account.email);
    const removed = await admin.auth.admin.deleteUser(account.userId, false);
    if (removed.error && !/not.?found/i.test(removed.error.message)) {
      throw new Error(`source compare fixture: removing an account failed: ${removed.error.message}`);
    }
  }
  const ids = list.map((account) => sqlLiteral(assertUuid(account.userId)));
  const inList = ids.length > 0 ? ids.join(", ") : "NULL";
  const tables = [
    "papers",
    "internal_user_access",
    "evidence_studies",
    "evidence_study_reports",
    "evidence_source_snapshots",
    "evidence_arms",
    "evidence_outcomes",
    "evidence_field_values",
    "evidence_field_anchors",
    "evidence_events",
  ];
  const residue = await ownerJson(
    ownerSql,
    "SELECT json_build_object(" +
      `'accounts', (SELECT count(*) FROM auth.users WHERE email LIKE ${sqlLiteral(`${OWNER_PREFIX}%`)} OR email LIKE ${sqlLiteral(`${FORMER_PREFIX}%`)}), ` +
      tables.map((table) => `'${table}', (SELECT count(*) FROM public.${table} WHERE user_id IN (${inList}))`).join(", ") +
      ")::text;",
  );
  const left = Object.entries(residue).filter(([, count]) => count !== 0);
  if (left.length > 0) {
    throw new Error(`source compare fixture: removal left rows behind (${left.map(([name, count]) => `${name}: ${count}`).join(", ")}).`);
  }
  if (list.length > 0) log("  removed the disposable source-compare accounts; verified: no account with their prefixes and no row of theirs remains.");
}
