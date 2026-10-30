// @ts-nocheck
/**
 * Disposable accounts for the EVIDENCE-RECORDS-001C2C-B rebase E2E
 * (`e2e/study-records-rebase.spec.ts`): "Use current abstract" against the
 * installed `evidence_rebase_source`.
 *
 * Its own accounts, papers, study records and proof — nothing is shared with
 * the C1, C2A, C2B or C2C-A fixtures, so the five specs can run alone,
 * together, and in any order. The pilot owner role is granted the way
 * Production's operator grants it: a server-side row in the LOCAL
 * `internal_user_access`, written as the local database owner, for disposable
 * users only — never a seed identity, never a client-side flag.
 *
 *   * OWNER (`e2e-disposable-srrb-owner-…`), role `owner` for the whole run:
 *       - "SRRB-E2E Changed trial": copy 1 at creation; four quoted values and
 *         one from the full text saved; the population confirmed; the library
 *         revised and copy 2 saved by the installed rebase (every quote found,
 *         the population sent to Needs re-review); then the condition and the
 *         full-text value confirmed, the setting flagged, and the library
 *         revised again. The spec adopts that revision through the UI: of the
 *         four quotes on copy 2, two are found exactly once and move, one is
 *         gone and one is there twice — both stay on copy 2.
 *       - "SRRB-E2E New abstract trial": created without an abstract; its
 *         condition says the abstract couldn't be checked, and is confirmed;
 *         the paper has an abstract now. The spec saves the first copy.
 *       - "SRRB-E2E Retry trial": a revised library abstract; the spec's first
 *         attempt is applied but its answer lost, and Try again is replayed.
 *       - "SRRB-E2E Stale trial": a revised library abstract the spec revises
 *         again "in another tab" while its confirmation is open.
 *       - "SRRB-E2E Typography trial", "SRRB-E2E Holds trial", "SRRB-E2E
 *         Phone trial": nothing may be written to them.
 *       - "SRRB-E2E Unchanged trial": the library abstract is the saved copy;
 *         the spec's direct rebase answers `unchanged` and writes nothing.
 *   * FORMER (`e2e-disposable-srrb-former-…`): granted `owner`, given a
 *     record with a quoted value and a revised library abstract, then set to
 *     `manager`. Comparing stays theirs; no write is offered, and the server
 *     refuses one sent directly.
 *
 * Every evidence row is written by the installed RPCs, as its own user —
 * create, save, review and rebase — and every library change is the owner's
 * own `papers` update under RLS; nothing is inserted directly. Access levels
 * stay separate: the local secret key does Auth administration only; roles and
 * every verification query go through `ownerSql` (postgres on the container
 * socket).
 *
 * After Playwright, `assertRebaseOutcomeAndRemove` checks as the database owner
 * what only the database can see: each rebased record's version, its copies
 * (the earlier ones byte for byte as they were), each quote's copy and offsets
 * (a moved quote's offsets locate it in the new copy), each value's review,
 * and the rebase's events — one request, its changes in order, the server's
 * own counts; every other record exactly as provisioned; the library as
 * provisioned but for the spec's own edit. Then it removes both accounts and
 * VERIFIES that no account with this module's prefixes and no row of theirs
 * remains.
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

export const OWNER_PREFIX = "e2e-disposable-srrb-owner-";
export const FORMER_PREFIX = "e2e-disposable-srrb-former-";

export const REBASE_TITLES = Object.freeze({
  changed: "SRRB-E2E Changed trial",
  added: "SRRB-E2E New abstract trial",
  retry: "SRRB-E2E Retry trial",
  stale: "SRRB-E2E Stale trial",
  typography: "SRRB-E2E Typography trial",
  holds: "SRRB-E2E Holds trial",
  phone: "SRRB-E2E Phone trial",
  unchanged: "SRRB-E2E Unchanged trial",
  former: "SRRB-E2E Former owner's trial",
});

const NBSP = String.fromCodePoint(0x00a0);
const EN_DASH = String.fromCodePoint(0x2013);
const LEFT_QUOTE = String.fromCodePoint(0x201c);
const RIGHT_QUOTE = String.fromCodePoint(0x201d);

const CHANGED_FIRST =
  "Background: A synthetic trial of metformin in adults with type 2 diabetes at three hospitals.\nMethods: Participants aged 40 to 70 years were randomized to metformin or placebo for 24 weeks.\nResults: HbA1c fell by 0.8 % with metformin.";

export const REBASE_TEXTS = Object.freeze({
  changedFirst: CHANGED_FIRST,
  // Copy 2, saved by the fixture's own rebase: every quote of copy 1 is in it once.
  changedSecond: `${CHANGED_FIRST}\nConclusions: Metformin lowered HbA1c.`,
  // What the spec adopts: the condition and the demographics found once, the setting gone, the population twice.
  changedLibrary:
    "Background: A synthetic trial of metformin in adults with type 2 diabetes at four hospitals.\nMethods: Participants aged 40 to 70 years were randomized to metformin or placebo for 26 weeks; in a second phase they were randomized to metformin or placebo again.\nResults: HbA1c fell by 0.8 % with metformin.\nConclusions: Metformin lowered HbA1c.",
  added: "Background: A synthetic trial of tai chi in older adults.\nMethods: 70 participants were randomized to tai chi or usual care.",
  retrySaved: "Background: A synthetic trial of a low-salt diet in adults with heart failure.\nMethods: 80 participants were randomized.",
  retryLibrary: "Background: A synthetic trial of a low-salt diet in adults with heart failure.\nMethods: 84 participants were randomized at four hospitals.",
  staleSaved: "Background: A synthetic trial of daily walking in adults with hypertension.\nMethods: 90 participants were randomized.",
  staleLibrary: "Background: A synthetic trial of daily walking in adults with hypertension.\nMethods: 92 participants were randomized.",
  // What the spec writes to the Stale trial's paper "in another tab", while the confirmation is open.
  staleEdited: "Background: A synthetic trial of daily walking in adults with hypertension.\nMethods: 94 participants were randomized for 16 weeks.",
  typographySaved: 'Background: A synthetic trial of "standing desks" in office workers.\nMethods: 60 participants were randomized for 12-14 weeks.',
  typographyLibrary: `Background: A synthetic trial of ${LEFT_QUOTE}standing desks${RIGHT_QUOTE} in office workers.\nMethods: 60${NBSP}participants were randomized for 12${EN_DASH}14 weeks.`,
  holdsSaved: "Background: A synthetic trial of yoga for chronic back pain.\nMethods: 50 participants were randomized.",
  holdsLibrary: "Background: A synthetic trial of yoga for chronic back pain.\nMethods: 52 participants were randomized.",
  phoneSaved: "Background: A synthetic trial of a sleep app in shift workers.\nMethods: 30 participants were randomized.",
  phoneLibrary: "Background: A synthetic trial of a sleep app in shift workers.\nMethods: 36 participants were randomized for eight weeks.",
  unchanged: "Background: A synthetic trial of mindfulness in nurses.\nMethods: 40 participants were randomized.",
  formerSaved: "Background: A synthetic trial of music therapy after surgery.\nMethods: 44 participants were randomized.",
  formerLibrary: "Background: A synthetic trial of music therapy after surgery.\nMethods: 48 participants were randomized.",
});

/** The quotes of the Changed trial's values, on copies 1 and 2. */
export const REBASE_QUOTES = Object.freeze({
  condition: "adults with type 2 diabetes",
  setting: "at three hospitals",
  population: "were randomized to metformin or placebo",
  demographics: "aged 40 to 70 years",
  holds: "chronic back pain",
  former: "music therapy after surgery",
});

export const FLAG_NOTE = "Check the hospitals";

const EMPTY_LISTS = { keywords: [], raw_keywords: [], mesh_terms: [], substances: [] };

function assertDisposableEmail(email) {
  if (typeof email !== "string" || !email.endsWith("@paperlume.test")) {
    throw new Error("Rebase fixture refused: disposable email must be a .test address.");
  }
  if (email === PRIMARY_EMAIL || email === SECONDARY_EMAIL) {
    throw new Error("Rebase fixture refused: will not target a deterministic seed identity.");
  }
  if (!email.startsWith(OWNER_PREFIX) && !email.startsWith(FORMER_PREFIX)) {
    throw new Error("Rebase fixture refused: disposable email must carry this module's prefix.");
  }
  return email;
}

function makeEphemeralPassword() {
  return `Aa1!${randomBytes(24).toString("base64url")}`;
}

/** The SHA-256 of the UTF-8 bytes, lowercase hex: what the rebase compares with the abstract it reads. */
export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
const md5 = (text) => (text === null ? null : createHash("md5").update(text, "utf8").digest("hex"));
const canonical = (value) => JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

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
  if (result.length !== 1 || result[0] !== role) throw new Error(`rebase fixture: role ${role} did not take effect.`);
}

async function createAccount(admin, prefix) {
  const email = assertDisposableEmail(`${prefix}${randomUUID()}@paperlume.test`);
  const password = makeEphemeralPassword();
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(`rebase fixture createUser failed: ${created.error.message}`);
  return { email, password, userId: created.data.user.id };
}

async function signedIn(apiUrl, anonKey, account) {
  const client = createClient(apiUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email: account.email, password: account.password });
  if (signIn.error) throw new Error(`rebase fixture sign-in failed: ${signIn.error.message}`);
  return client;
}

function paper(userId, title, doi, abstract) {
  return { ...EMPTY_LISTS, user_id: userId, title, authors: ["Roe R"], year: 2025, journal: "Journal of Rebase Fixtures", doi, abstract, study_type: "Randomized Controlled Trial" };
}

async function insertPapers(client, rows) {
  const inserted = await client.from("papers").insert(rows).select("id, title");
  if (inserted.error) throw new Error(`rebase fixture paper insert failed: ${inserted.error.message}`);
  const byTitle = {};
  for (const row of inserted.data) byTitle[row.title] = row.id;
  return byTitle;
}

/** The owner editing their own library abstract, as Edit Paper does: a `papers` update under RLS. */
async function setAbstract(client, paperId, abstract) {
  const updated = await client.from("papers").update({ abstract }).eq("id", paperId).select("id");
  if (updated.error || updated.data?.length !== 1) throw new Error("rebase fixture: a library abstract did not update.");
}

/** One RPC as the signed-in user; the answer must be `status` at the expected study version. */
async function rpc(client, fn, args, expected) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`rebase fixture ${fn} failed: ${error.message}`);
  if (!data || data.status !== expected.status || (expected.version !== undefined && data.study_version !== expected.version)) {
    throw new Error(`rebase fixture: ${fn} did not answer ${expected.status} at version ${expected.version}.`);
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
  if (copy !== !!data.snapshot_id) throw new Error(`rebase fixture: the study ${copy ? "has no" : "has a"} saved copy of the abstract.`);
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
const setValue = (fieldKey, state, content, references) => ({
  op: "set_value",
  target: { scope: "study" },
  field_key: fieldKey,
  expected_value_version: null,
  value_state: state,
  state_reason: null,
  content,
  note: null,
  references,
});
const text = (value) => ({ shape: "text", text: value });

async function saveChanges(client, studyId, expectedVersion, changes) {
  await rpc(
    client,
    "evidence_save_changes",
    { p_study_id: studyId, p_expected_version: expectedVersion, p_changes: changes, p_request_id: randomUUID() },
    { status: "applied", version: expectedVersion + 1 },
  );
}

/** A study's values as its user reads them: field key → { id, version }. */
async function valuesOf(client, studyId) {
  const { data, error } = await client.from("evidence_field_values").select("id, field_key, value_version").eq("study_id", studyId);
  if (error) throw new Error(`rebase fixture value read failed: ${error.message}`);
  return Object.fromEntries(data.map((row) => [row.field_key, { id: row.id, version: row.value_version }]));
}

async function review(client, studyId, expectedVersion, value, action, note = null) {
  await rpc(
    client,
    "evidence_review_fields",
    {
      p_study_id: studyId,
      p_expected_version: expectedVersion,
      p_value_id: value.id,
      p_expected_value_version: value.version,
      p_action: action,
      p_note: note,
      p_request_id: randomUUID(),
    },
    { status: "applied", version: expectedVersion + 1 },
  );
}

/** The installed rebase, as the owner: a new copy of `abstract`, which must be the paper's abstract now. */
async function rebase(client, studyId, paperId, expectedVersion, abstract, expected) {
  const data = await rpc(
    client,
    "evidence_rebase_source",
    { p_study_id: studyId, p_paper_id: paperId, p_expected_version: expectedVersion, p_expected_abstract_sha256: sha256(abstract), p_request_id: randomUUID() },
    { status: "applied", version: expectedVersion + 1 },
  );
  for (const [key, value] of Object.entries(expected)) {
    if (data[key] !== value) throw new Error(`rebase fixture: the provisioning rebase answered ${key} ${data[key]}, not ${value}.`);
  }
}

/**
 * Everything of one study, for an exact before/after comparison: its version,
 * its copies (text by md5 and SHA-256, never the text), its values with their
 * reviews and versions, its quotes with the copy and offsets they name, and
 * every event — the change events' `after` kept for the rebase's own.
 */
async function studyState(ownerSql, userId, studyId) {
  const uid = sqlLiteral(assertUuid(userId));
  const sid = sqlLiteral(assertUuid(studyId));
  return ownerJson(
    ownerSql,
    "SELECT json_build_object(" +
      `'version', (SELECT row_version FROM public.evidence_studies WHERE user_id = ${uid} AND id = ${sid}), ` +
      `'links', (SELECT coalesce(json_agg(json_build_object('id', id, 'paper', paper_id, 'status', link_status, 'updated', updated_at) ORDER BY id), '[]'::json) FROM public.evidence_study_reports WHERE user_id = ${uid} AND study_id = ${sid}), ` +
      `'copies', (SELECT coalesce(json_agg(json_build_object('id', id, 'paper', paper_id, 'seq', seq, 'kind', source_kind, 'chars', char_count, 'md5', md5(exact_text), 'sha', encode(exact_sha256, 'hex'), 'normalized_sha', encode(normalized_sha256, 'hex'), 'captured', captured_at) ORDER BY seq), '[]'::json) FROM public.evidence_source_snapshots WHERE user_id = ${uid} AND study_id = ${sid}), ` +
      `'values', (SELECT coalesce(json_object_agg(field_key, json_build_object('id', id, 'version', value_version, 'state', value_state, 'status', review_status, 'reason', review_reason, 'reviewed_at', reviewed_at, 'reviewed_version', reviewed_version, 'note_md5', md5(review_note), 'text_md5', md5(value_text)) ORDER BY field_key), '{}'::json) FROM public.evidence_field_values WHERE user_id = ${uid} AND study_id = ${sid}), ` +
      `'anchors', (SELECT coalesce(json_object_agg(v.field_key, json_build_object('id', a.id, 'copy', a.snapshot_id, 'purpose', a.purpose, 'kind', a.source_kind, 'start', a.match_start, 'end', a.match_end, 'occurrence', a.match_occurrence, 'count', a.match_count, 'quote', a.quote_text, 'matched_at', a.matched_at, 'locator', a.locator_text) ORDER BY v.field_key), '{}'::json) FROM public.evidence_field_anchors a JOIN public.evidence_field_values v ON v.id = a.value_id WHERE a.user_id = ${uid} AND a.study_id = ${sid}), ` +
      `'located', (SELECT coalesce(json_object_agg(v.field_key, substr(public.evidence_normalize_v1(c.exact_text), a.match_start + 1, a.match_end - a.match_start) = public.evidence_normalize_v1(a.quote_text) ORDER BY v.field_key), '{}'::json) FROM public.evidence_field_anchors a JOIN public.evidence_field_values v ON v.id = a.value_id JOIN public.evidence_source_snapshots c ON c.id = a.snapshot_id WHERE a.user_id = ${uid} AND a.study_id = ${sid} AND a.purpose = 'supports' AND a.source_kind = 'abstract'), ` +
      `'events', (SELECT coalesce(json_agg(json_build_object('version', study_version, 'ordinal', ordinal, 'type', event_type, 'op', op, 'request', request_id, 'target', target_id, 'field', field_key, 'after', CASE WHEN event_type IN ('source_captured', 'source_rebased', 'anchor_rematched', 'anchor_not_rematched') THEN after END) ORDER BY study_version, ordinal), '[]'::json) FROM public.evidence_events WHERE user_id = ${uid} AND study_id = ${sid})` +
      ")::text;",
  );
}

/** One user's library abstracts, by title, as digests (null for no abstract). */
async function abstractsOf(ownerSql, userId) {
  const uid = sqlLiteral(assertUuid(userId));
  return ownerJson(ownerSql, `SELECT coalesce(json_object_agg(title, md5(abstract) ORDER BY title), '{}'::json)::text FROM public.papers WHERE user_id = ${uid};`);
}

/**
 * Create both accounts and everything they hold. Returns the credentials for
 * the Playwright environment and what the post-run proof compares against.
 * Nothing returned is printed.
 */
export async function provisionRebaseAccounts({ apiUrl, anonKey, serviceRoleKey, ownerSql, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  if (!serviceRoleKey || !anonKey) throw new Error("Rebase fixture refused: missing local service-role or anon key.");
  assertOwnerSql(ownerSql);

  const admin = createClient(apiUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const accounts = [];
  try {
    // ── The pilot owner ──
    const owner = await createAccount(admin, OWNER_PREFIX);
    accounts.push(owner);
    await setRole(ownerSql, owner.userId, "owner");
    const client = await signedIn(apiUrl, anonKey, owner);
    const t = REBASE_TEXTS;
    const q = REBASE_QUOTES;
    owner.papers = await insertPapers(client, [
      paper(owner.userId, REBASE_TITLES.changed, "10.5555/srrb-e2e.0001", t.changedFirst),
      paper(owner.userId, REBASE_TITLES.added, "10.5555/srrb-e2e.0002", null),
      paper(owner.userId, REBASE_TITLES.retry, "10.5555/srrb-e2e.0003", t.retrySaved),
      paper(owner.userId, REBASE_TITLES.stale, "10.5555/srrb-e2e.0004", t.staleSaved),
      paper(owner.userId, REBASE_TITLES.typography, "10.5555/srrb-e2e.0005", t.typographySaved),
      paper(owner.userId, REBASE_TITLES.holds, "10.5555/srrb-e2e.0006", t.holdsSaved),
      paper(owner.userId, REBASE_TITLES.phone, "10.5555/srrb-e2e.0007", t.phoneSaved),
      paper(owner.userId, REBASE_TITLES.unchanged, "10.5555/srrb-e2e.0008", t.unchanged),
    ]);
    const ids = owner.papers;
    owner.studies = {};

    // The Changed trial: copy 1, five values, the population confirmed (v3); copy 2 by the installed rebase (v4);
    // the condition and the full-text value confirmed and the setting flagged (v5–v7); the library revised again.
    const changedPaper = ids[REBASE_TITLES.changed];
    const changed = await createStudy(client, changedPaper, "SRRB Changed trial");
    await saveChanges(client, changed.studyId, 1, [
      setValue("condition", "reported", text("Type 2 diabetes"), [quote(changedPaper, changed.snapshotId, q.condition)]),
      setValue("setting", "reported", text("Three hospitals"), [quote(changedPaper, changed.snapshotId, q.setting)]),
      setValue("population_description", "reported", text("Adults on metformin or placebo"), [quote(changedPaper, changed.snapshotId, q.population)]),
      setValue("demographics", "reported", text("Aged 40 to 70"), [quote(changedPaper, changed.snapshotId, q.demographics)]),
      setValue("eligibility_criteria", "reported", text("Adults with type 2 diabetes"), [
        { purpose: "supports", source_kind: "full_text", paper_id: changedPaper, locator_kind: "page", locator_text: "3" },
      ]),
    ]);
    let values = await valuesOf(client, changed.studyId);
    await review(client, changed.studyId, 2, values.population_description, "confirm");
    await setAbstract(client, changedPaper, t.changedSecond);
    await rebase(client, changed.studyId, changedPaper, 3, t.changedSecond, { seq: 2, rematched: 4, not_found: 0, ambiguous: 0, needs_rereview: 1 });
    values = await valuesOf(client, changed.studyId);
    await review(client, changed.studyId, 4, values.condition, "confirm");
    await review(client, changed.studyId, 5, values.setting, "flag", FLAG_NOTE);
    await review(client, changed.studyId, 6, values.eligibility_criteria, "confirm");
    await setAbstract(client, changedPaper, t.changedLibrary);
    owner.studies.changed = changed.studyId;

    // The New abstract trial: no copy; the condition couldn't check the abstract, and is confirmed (v3); the paper has one now.
    const addedPaper = ids[REBASE_TITLES.added];
    const added = await createStudy(client, addedPaper, "SRRB New abstract trial", { copy: false });
    await saveChanges(client, added.studyId, 1, [setValue("condition", "source_unavailable", null, [{ purpose: "unavailable", source_kind: "abstract", paper_id: addedPaper }])]);
    await review(client, added.studyId, 2, (await valuesOf(client, added.studyId)).condition, "confirm");
    await setAbstract(client, addedPaper, t.added);
    owner.studies.added = added.studyId;

    // The Retry, Stale, Typography and Phone trials: a copy, and a library that differs from it.
    for (const [key, saved, library, label] of [
      ["retry", t.retrySaved, t.retryLibrary, "SRRB Retry trial"],
      ["stale", t.staleSaved, t.staleLibrary, "SRRB Stale trial"],
      ["typography", t.typographySaved, t.typographyLibrary, "SRRB Typography trial"],
      ["phone", t.phoneSaved, t.phoneLibrary, "SRRB Phone trial"],
    ]) {
      const study = await createStudy(client, ids[REBASE_TITLES[key]], label);
      if (saved !== library) await setAbstract(client, ids[REBASE_TITLES[key]], library);
      owner.studies[key] = study.studyId;
    }

    // The Holds trial: a quoted value to flag, and a library that differs.
    const holdsPaper = ids[REBASE_TITLES.holds];
    const holds = await createStudy(client, holdsPaper, "SRRB Holds trial");
    await saveChanges(client, holds.studyId, 1, [setValue("condition", "reported", text("Chronic back pain"), [quote(holdsPaper, holds.snapshotId, q.holds)])]);
    await setAbstract(client, holdsPaper, t.holdsLibrary);
    owner.studies.holds = holds.studyId;

    // The Unchanged trial: the library abstract is the copy.
    owner.studies.unchanged = (await createStudy(client, ids[REBASE_TITLES.unchanged], "SRRB Unchanged trial")).studyId;
    await client.auth.signOut();

    // ── The former owner, now a manager ──
    const former = await createAccount(admin, FORMER_PREFIX);
    accounts.push(former);
    await setRole(ownerSql, former.userId, "owner");
    const formerClient = await signedIn(apiUrl, anonKey, former);
    former.papers = await insertPapers(formerClient, [paper(former.userId, REBASE_TITLES.former, "10.5555/srrb-e2e.0101", t.formerSaved)]);
    const formerPaper = former.papers[REBASE_TITLES.former];
    const formerStudy = await createStudy(formerClient, formerPaper, "SRRB Former owner's trial");
    await saveChanges(formerClient, formerStudy.studyId, 1, [setValue("condition", "reported", text("Pain after surgery"), [quote(formerPaper, formerStudy.snapshotId, q.former)])]);
    await setAbstract(formerClient, formerPaper, t.formerLibrary);
    await formerClient.auth.signOut();
    await setRole(ownerSql, former.userId, "manager");
    former.studies = { former: formerStudy.studyId };

    owner.before = {};
    for (const [key, studyId] of Object.entries(owner.studies)) owner.before[key] = await studyState(ownerSql, owner.userId, studyId);
    former.before = { former: await studyState(ownerSql, former.userId, formerStudy.studyId) };
    if (owner.before.changed.version !== 7 || owner.before.added.version !== 3 || owner.before.retry.version !== 1) {
      throw new Error("rebase fixture: a record was not provisioned at the version the spec expects.");
    }
    log("  provisioned rebase accounts: pilot owner (8 papers, 8 study records — two copies and five reviewed or flagged values on one) and former owner now manager (1 study record)");
    return { owner, former };
  } catch (err) {
    await removeRebaseAccounts({ apiUrl, serviceRoleKey, ownerSql, accounts: { list: accounts }, log }).catch(() => {});
    throw err;
  }
}

function fail(message) {
  throw new Error(`study-records-rebase E2E: ${message}`);
}

/** The paths at which two JSON values differ — never the values, so no text, quote or digest reaches a log. */
function differingPaths(actual, expected, path = "") {
  if (canonical(actual) === canonical(expected)) return [];
  const bothObjects = actual && expected && typeof actual === "object" && typeof expected === "object" && Array.isArray(actual) === Array.isArray(expected);
  if (!bothObjects) return [path || "(the whole value)"];
  if (Array.isArray(actual) && actual.length !== expected.length) return [`${path || "(list)"} has ${actual.length} items, not ${expected.length}`];
  const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
  return keys.flatMap((key) => differingPaths(actual[key], expected[key], path ? `${path}.${key}` : key));
}

function expectEqual(actual, expected, what) {
  const paths = differingPaths(actual, expected);
  if (paths.length > 0) fail(`${what} differs at ${paths.slice(0, 8).join(", ")}.`);
}

/**
 * One rebase recorded as the server records it: one request header at `version`
 * (op rebase_source) and its change events, ordinals 0..n in order, all of one
 * request id, nothing else at that version.
 */
function rebaseEvents(state, version, types, what) {
  const events = state.events.filter((event) => event.version === version);
  expectEqual(
    events.map((event) => [event.ordinal, event.type, event.op]),
    [[0, "request", "rebase_source"], ...types.map((type, index) => [index + 1, type, null])],
    `${what}: the events of version ${version}`,
  );
  if (new Set(events.map((event) => event.request)).size !== 1) fail(`${what}: version ${version}'s events are not one request.`);
  return events;
}

/** Everything of `before` but the events from `version` on, which must be the same. */
function earlierEventsKept(before, after, version, what) {
  expectEqual(
    after.events.filter((event) => event.version < version),
    before.events,
    `${what}: the events before version ${version}`,
  );
}

/**
 * Authoritative post-run proof, as the database owner, then removal — the
 * removal verified too. The spec asserts what the browser can see; this
 * asserts what only the database can: what each rebase wrote, and that
 * nothing else was written.
 */
export async function assertRebaseOutcomeAndRemove({ apiUrl, serviceRoleKey, ownerSql, accounts, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  assertOwnerSql(ownerSql);
  const { owner, former } = accounts;
  assertDisposableEmail(owner.email);
  assertDisposableEmail(former.email);
  const t = REBASE_TEXTS;
  const after = {};
  for (const [key, studyId] of Object.entries(owner.studies)) after[key] = await studyState(ownerSql, owner.userId, studyId);

  // ── The Changed trial: one rebase through the UI, version 7 → 8, copy 3 ──
  {
    const before = owner.before.changed;
    const now = after.changed;
    if (now.version !== 8) fail(`the Changed trial is at version ${now.version}, not 8.`);
    // Copies 1 and 2 byte for byte as they were; copy 3 is the library abstract adopted.
    expectEqual(now.copies.slice(0, 2), before.copies, "the Changed trial's copies 1 and 2");
    if (before.copies.map((copy) => copy.md5).join() !== [md5(t.changedFirst), md5(t.changedSecond)].join()) fail("the Changed trial's earlier copies were not the provisioned texts.");
    const copy3 = now.copies[2];
    if (now.copies.length !== 3 || copy3.seq !== 3 || copy3.md5 !== md5(t.changedLibrary) || copy3.sha !== sha256(t.changedLibrary) || copy3.chars !== Array.from(t.changedLibrary).length || copy3.kind !== "library_abstract") {
      fail("the Changed trial's copy 3 is not the library abstract the spec adopted.");
    }
    const copy2 = before.copies[1].id;
    // Quotes found exactly once moved to copy 3, at offsets that locate them there; the others stayed on copy 2, untouched.
    for (const field of ["condition", "demographics"]) {
      const anchor = now.anchors[field];
      if (anchor.copy !== copy3.id || anchor.occurrence !== 1 || anchor.count !== 1 || now.located[field] !== true) fail(`the ${field} quote did not move to copy 3 at its own offsets.`);
      if (anchor.quote !== before.anchors[field].quote) fail(`the ${field} quote's text changed.`);
    }
    for (const field of ["setting", "population_description", "eligibility_criteria"]) expectEqual(now.anchors[field], before.anchors[field], `the ${field} reference`);
    if (now.anchors.setting.copy !== copy2 || now.anchors.population_description.copy !== copy2 || now.located.setting !== true || now.located.population_description !== true) {
      fail("a quote not found exactly once did not stay on copy 2.");
    }
    // Reviews: the confirmed condition and the flagged setting need re-review (the flag's note kept); the population already
    // did and is untouched; the demographics stay not reviewed (their version moves with their quote); the full-text value stays reviewed.
    const v = now.values;
    const b = before.values;
    const needs = (field) => v[field].status === "needs_rereview" && v[field].reason === "source_changed" && v[field].reviewed_at === null && v[field].reviewed_version === null;
    if (b.condition.status !== "user_reviewed" || !needs("condition") || v.condition.version !== b.condition.version + 1) fail("the condition's review did not go to Needs re-review.");
    if (b.setting.status !== "disputed" || !needs("setting") || v.setting.version !== b.setting.version + 1 || v.setting.note_md5 !== md5(FLAG_NOTE) || b.setting.note_md5 !== md5(FLAG_NOTE)) {
      fail("the flagged setting did not go to Needs re-review with its note kept.");
    }
    expectEqual(v.population_description, b.population_description, "the population (already needing re-review)");
    if (b.population_description.status !== "needs_rereview") fail("the population was not provisioned as needing re-review.");
    if (v.demographics.status !== "unreviewed" || v.demographics.version !== b.demographics.version + 1 || v.demographics.reason !== null) fail("the demographics did not stay not reviewed.");
    expectEqual(v.eligibility_criteria, b.eligibility_criteria, "the full-text value");
    if (v.eligibility_criteria.status !== "user_reviewed") fail("the full-text value was not provisioned as reviewed.");
    // The events: everything earlier as it was, then one request — the copy, the four quotes in field order, the two reviews, the summary.
    earlierEventsKept(before, now, 8, "the Changed trial");
    const events = rebaseEvents(
      now,
      8,
      ["source_captured", "anchor_rematched", "anchor_rematched", "anchor_not_rematched", "anchor_not_rematched", "review_needs_rereview", "review_needs_rereview", "source_rebased"],
      "the Changed trial",
    );
    expectEqual(events.slice(2, 6).map((event) => event.field), ["condition", "demographics", "population_description", "setting"], "the Changed trial's quote events");
    expectEqual(events.slice(4, 6).map((event) => event.after.outcome), ["ambiguous", "not_found"], "the Changed trial's quotes kept");
    expectEqual(events.slice(6, 8).map((event) => event.field), ["condition", "setting"], "the Changed trial's review events");
    const captured = events[1].after;
    if (captured.seq !== 3 || captured.previous_snapshot_id !== copy2 || captured.exact_sha256 !== sha256(t.changedLibrary)) fail("the Changed trial's source_captured event doesn't describe copy 3.");
    expectEqual(
      events[8].after,
      { paper_id: owner.papers[REBASE_TITLES.changed], snapshot_id: copy3.id, previous_snapshot_id: copy2, quotes_rechecked: 4, rematched: 2, not_found: 1, ambiguous: 1, values_needing_rereview: 2, values_changed: 3 },
      "the Changed trial's source_rebased event",
    );
  }

  // ── The New abstract trial: a first copy, version 3 → 4 ──
  {
    const before = owner.before.added;
    const now = after.added;
    if (before.copies.length !== 0 || now.version !== 4 || now.copies.length !== 1) fail("the New abstract trial did not get exactly one copy at version 4.");
    const copy = now.copies[0];
    if (copy.seq !== 1 || copy.md5 !== md5(t.added) || copy.sha !== sha256(t.added)) fail("the New abstract trial's first copy is not the library abstract.");
    if (before.values.condition.status !== "user_reviewed" || now.values.condition.status !== "needs_rereview" || now.values.condition.version !== before.values.condition.version + 1) {
      fail("the New abstract trial's confirmed value did not go to Needs re-review.");
    }
    // Its "couldn't check" reference stays; nothing moved.
    expectEqual(now.anchors, before.anchors, "the New abstract trial's references");
    earlierEventsKept(before, now, 4, "the New abstract trial");
    const events = rebaseEvents(now, 4, ["source_captured", "review_needs_rereview", "source_rebased"], "the New abstract trial");
    if (events[1].after.previous_snapshot_id !== null || events[1].after.seq !== 1) fail("the New abstract trial's copy is not described as a first capture.");
    expectEqual(
      events[3].after,
      { paper_id: owner.papers[REBASE_TITLES.added], snapshot_id: copy.id, previous_snapshot_id: null, quotes_rechecked: 0, rematched: 0, not_found: 0, ambiguous: 0, values_needing_rereview: 1, values_changed: 1 },
      "the New abstract trial's source_rebased event",
    );
  }

  // ── The Retry trial: two attempts with one request — applied once, version 1 → 2 ──
  {
    const before = owner.before.retry;
    const now = after.retry;
    if (now.version !== 2 || now.copies.length !== 2) fail("the Retry trial was not rebased exactly once.");
    expectEqual(now.copies[0], before.copies[0], "the Retry trial's copy 1");
    if (now.copies[1].md5 !== md5(t.retryLibrary) || now.copies[1].seq !== 2) fail("the Retry trial's copy 2 is not the library abstract.");
    earlierEventsKept(before, now, 2, "the Retry trial");
    rebaseEvents(now, 2, ["source_captured", "source_rebased"], "the Retry trial");
    if (now.events.filter((event) => event.op === "rebase_source").length !== 1) fail("the Retry trial has more than one rebase request.");
  }

  // ── Everything else: exactly as provisioned ──
  for (const key of ["stale", "typography", "holds", "phone", "unchanged"]) expectEqual(after[key], owner.before[key], `the ${key} trial`);
  expectEqual(await studyState(ownerSql, former.userId, former.studies.former), former.before.former, "the former owner's record");

  // The library: as provisioned, except the Stale trial's abstract, which the spec edits "in another tab".
  const expectedOwner = {
    [REBASE_TITLES.changed]: md5(t.changedLibrary),
    [REBASE_TITLES.added]: md5(t.added),
    [REBASE_TITLES.retry]: md5(t.retryLibrary),
    [REBASE_TITLES.stale]: md5(t.staleEdited),
    [REBASE_TITLES.typography]: md5(t.typographyLibrary),
    [REBASE_TITLES.holds]: md5(t.holdsLibrary),
    [REBASE_TITLES.phone]: md5(t.phoneLibrary),
    [REBASE_TITLES.unchanged]: md5(t.unchanged),
  };
  expectEqual(await abstractsOf(ownerSql, owner.userId), expectedOwner, "the pilot owner's library abstracts");
  expectEqual(await abstractsOf(ownerSql, former.userId), { [REBASE_TITLES.former]: md5(t.formerLibrary) }, "the former owner's library abstract");
  log("  verified: three rebases as the server recorded them (versions, copies, offsets, reviews, one request each); every other record and the library as provisioned but for the spec's own edit");

  await removeRebaseAccounts({ apiUrl, serviceRoleKey, ownerSql, accounts: { list: [owner, former] }, log });
}

/**
 * Remove both accounts — their papers, study records and history go with
 * them (every table cascades from `auth.users`) — then VERIFY, as the database
 * owner, that no account with this module's prefixes and no row of theirs
 * remains. Throws when anything does.
 */
export async function removeRebaseAccounts({ apiUrl, serviceRoleKey, ownerSql, accounts, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  assertOwnerSql(ownerSql);
  const list = (accounts?.list ?? [accounts?.owner, accounts?.former]).filter(Boolean);
  const admin = createClient(apiUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  for (const account of list) {
    assertDisposableEmail(account.email);
    const removed = await admin.auth.admin.deleteUser(account.userId, false);
    if (removed.error && !/not.?found/i.test(removed.error.message)) {
      throw new Error(`rebase fixture: removing an account failed: ${removed.error.message}`);
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
    throw new Error(`rebase fixture: removal left rows behind (${left.map(([name, count]) => `${name}: ${count}`).join(", ")}).`);
  }
  if (list.length > 0) log("  removed the disposable rebase accounts; verified: no account with their prefixes and no row of theirs remains.");
}
