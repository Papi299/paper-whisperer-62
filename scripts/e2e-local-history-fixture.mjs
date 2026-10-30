// @ts-nocheck
/**
 * Disposable accounts for the EVIDENCE-RECORDS-001C2B History E2E
 * (`e2e/study-records-history.spec.ts`).
 *
 * Its own accounts, papers, study records and proof — nothing is shared with
 * the C1 fixture (`e2e-local-evidence-fixture.mjs`) or the C2A fixture
 * (`e2e-local-review-fixture.mjs`), so the three specs can run alone,
 * together, and in any order. The pilot owner role is granted the way
 * Production's operator grants it: a server-side row in the LOCAL
 * `internal_user_access`, written as the local database owner, for disposable
 * users only — never a seed identity, never a client-side flag.
 *
 *   * OWNER (`e2e-disposable-srh-owner-…`), role `owner` for the whole run.
 *       - "SRH-E2E History trial" with one study record and twelve committed
 *         operations: the create, a save of two groups, an outcome with a
 *         long unbroken name and three values, a Confirm, a Flag, an edit that
 *         resets that Confirm, the study notes, the link marked provisional
 *         and back, and four one-value saves — two pages of History. The spec
 *         adds five operations of its own.
 *       - "SRH-E2E Creation trial", with no study record: the spec creates one
 *         in the browser and opens its History.
 *   * FORMER (`e2e-disposable-srh-former-…`): granted `owner`, given a study
 *     record with four operations — the last one save of 52 changes (20
 *     groups and 32 outcomes), more than one page of an operation's details —
 *     then set to `manager`. History stays theirs to read; nothing of it can
 *     be written.
 *
 * Every event is written by the installed RPCs, as the event's own user
 * (`evidence_create_study_from_paper`, `evidence_save_changes`,
 * `evidence_review_fields`, `evidence_update_study`, `evidence_set_link`) —
 * never inserted into `evidence_events` directly, and never by the source
 * rebase, which stays C2C's. Access levels stay separate: the local secret
 * key does Auth administration only; roles and every verification query go
 * through `ownerSql` (postgres on the container socket).
 *
 * After Playwright, `assertStudyHistoryOutcomeAndRemove` checks as the
 * database owner what only the database can see — every committed operation
 * of the history study, version by version, with its change events in order:
 * the fixture's twelve and exactly the five the spec made, so nothing the
 * History viewer did wrote anything; the record created in the browser; and
 * the former owner's record unchanged — then removes both accounts and
 * VERIFIES that no account with this module's prefixes and no row of theirs
 * remains.
 *
 * Hard safety rules (mirroring the other fixture modules): loopback target
 * only, checked before any credential is used; only `.test` identities with
 * this module's prefixes; fresh ephemeral passwords, never logged or
 * persisted; no key, token or password is ever printed.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { PRIMARY_EMAIL, SECONDARY_EMAIL, assertOwnerSql, assertUuid, sqlLiteral } from "./e2e-local-seed.mjs";
import { assertLoopbackApiUrl } from "./e2e-local-delete-fixture.mjs";

export const OWNER_PREFIX = "e2e-disposable-srh-owner-";
export const FORMER_PREFIX = "e2e-disposable-srh-former-";

export const HISTORY_TITLES = Object.freeze({
  history: "SRH-E2E History trial",
  creation: "SRH-E2E Creation trial",
  former: "SRH-E2E Former owner's trial",
});

export const HISTORY_ABSTRACT = [
  "Background: We randomized adults with type 2 diabetes and obesity to metformin or placebo in outpatient clinics.",
  "Methods: 120 participants were randomized 1:1, and body weight was measured at baseline and at week 12.",
  "Results: HbA1c fell by 0.8 % with metformin; adverse events were mild.",
].join("\n");
const CREATION_ABSTRACT = "Background: A synthetic trial of morning walks in older adults.\nMethods: 80 participants were randomized.";
const FORMER_ABSTRACT = "Background: A synthetic trial of daily stretching in office workers.\nMethods: 40 participants were randomized.";

/** The former owner's large save: the group and outcome limits are 20 and 50 (PR-A3). */
const FORMER_GROUPS = 20;
const FORMER_OUTCOMES = 32;

/** An outcome name of 200 characters without a space: the longest the schema allows, for the phone layout. */
export const LONG_OUTCOME = "Bodyweightchangefrombaseline".repeat(8).slice(0, 200);

const EMPTY_LISTS = { keywords: [], raw_keywords: [], mesh_terms: [], substances: [] };

function assertDisposableEmail(email) {
  if (typeof email !== "string" || !email.endsWith("@paperlume.test")) {
    throw new Error("Study history fixture refused: disposable email must be a .test address.");
  }
  if (email === PRIMARY_EMAIL || email === SECONDARY_EMAIL) {
    throw new Error("Study history fixture refused: will not target a deterministic seed identity.");
  }
  if (!email.startsWith(OWNER_PREFIX) && !email.startsWith(FORMER_PREFIX)) {
    throw new Error("Study history fixture refused: disposable email must carry this module's prefix.");
  }
  return email;
}

function makeEphemeralPassword() {
  return `Aa1!${randomBytes(24).toString("base64url")}`;
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
  if (result.length !== 1 || result[0] !== role) throw new Error(`study history fixture: role ${role} did not take effect.`);
}

async function createAccount(admin, prefix) {
  const email = assertDisposableEmail(`${prefix}${randomUUID()}@paperlume.test`);
  const password = makeEphemeralPassword();
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(`study history fixture createUser failed: ${created.error.message}`);
  return { email, password, userId: created.data.user.id };
}

async function signedIn(apiUrl, anonKey, account) {
  const client = createClient(apiUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email: account.email, password: account.password });
  if (signIn.error) throw new Error(`study history fixture sign-in failed: ${signIn.error.message}`);
  return client;
}

async function insertPapers(client, rows) {
  const inserted = await client.from("papers").insert(rows).select("id, title");
  if (inserted.error) throw new Error(`study history fixture paper insert failed: ${inserted.error.message}`);
  const byTitle = {};
  for (const row of inserted.data) byTitle[row.title] = row.id;
  return byTitle;
}

function paper(userId, title, doi, abstract) {
  return { ...EMPTY_LISTS, user_id: userId, title, authors: ["Roe R"], year: 2025, journal: "Journal of History Fixtures", doi, abstract, study_type: "Randomized Controlled Trial" };
}

/** One RPC as the signed-in user; the answer must be `status` at the next study version. */
async function rpc(client, fn, args, expected) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`study history fixture ${fn} failed: ${error.message}`);
  if (!data || data.status !== expected.status || (expected.version !== undefined && data.study_version !== expected.version)) {
    throw new Error(`study history fixture: ${fn} did not answer ${expected.status} at version ${expected.version}.`);
  }
  return data;
}

async function createStudy(client, paperId, label) {
  const data = await rpc(
    client,
    "evidence_create_study_from_paper",
    { p_paper_id: paperId, p_label: label, p_design_profile: "rct_parallel", p_link_status: "user_confirmed", p_request_id: randomUUID() },
    { status: "applied", version: 1 },
  );
  if (!data.snapshot_id) throw new Error("study history fixture: the study has no saved copy of the abstract.");
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
const text = (value) => ({ shape: "text", text: value });
const setValue = (fieldKey, state, content, references, { target = { scope: "study" }, expected = null } = {}) => ({
  op: "set_value",
  target,
  field_key: fieldKey,
  expected_value_version: expected,
  value_state: state,
  state_reason: null,
  content,
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

/** A study's values as its user reads them: field key → { id, version }. */
async function valuesOf(client, studyId) {
  const { data, error } = await client.from("evidence_field_values").select("id, field_key, value_version").eq("study_id", studyId);
  if (error) throw new Error(`study history fixture value read failed: ${error.message}`);
  return Object.fromEntries(data.map((row) => [row.field_key, { id: row.id, version: row.value_version }]));
}

async function anchorsOf(client, valueId) {
  const { data, error } = await client.from("evidence_field_anchors").select("id").eq("value_id", valueId);
  if (error) throw new Error(`study history fixture anchor read failed: ${error.message}`);
  return data.map((row) => ({ anchor_id: row.id }));
}

async function review(client, studyId, expectedVersion, value, action, note) {
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

async function setLink(client, studyId, paperId, expectedVersion, action) {
  await rpc(
    client,
    "evidence_set_link",
    { p_study_id: studyId, p_paper_id: paperId, p_action: action, p_expected_version: expectedVersion, p_request_id: randomUUID() },
    { status: "applied", version: expectedVersion + 1 },
  );
}

/** The twelve operations of the history study (versions 1–12), each through its RPC. */
async function writeHistory(client, paperId) {
  const { studyId, snapshotId } = await createStudy(client, paperId, "SRH History trial"); // 1
  const q = (passage) => [quote(paperId, snapshotId, passage)];
  await saveChanges(client, studyId, 1, [
    { op: "add_arm", ref: "metformin", arm_role: "intervention", display_label: "Metformin", position: 0 },
    { op: "add_arm", ref: "placebo", arm_role: "comparator", display_label: "Placebo", position: 1 },
    { op: "add_outcome", ref: "weight", display_label: LONG_OUTCOME, position: 0 },
    setValue("condition", "reported", text("Type 2 diabetes and obesity"), q("adults with type 2 diabetes and obesity")),
    setValue("setting", "reported", text("Outpatient clinics"), q("outpatient clinics")),
    setValue("comparator_type", "reported", { shape: "code", code: "placebo" }, [], { target: { scope: "arm", arm_ref: "placebo" } }),
  ]); // 2
  let values = await valuesOf(client, studyId);
  await review(client, studyId, 2, values.condition, "confirm", null); // 3
  await review(client, studyId, 3, values.setting, "flag", "Check the setting"); // 4
  // An edit of the confirmed condition, keeping its quote: the save resets the review.
  await saveChanges(client, studyId, 4, [
    setValue("condition", "reported", text("Type 2 diabetes with obesity"), await anchorsOf(client, values.condition.id), { expected: values.condition.version }),
  ]); // 5
  await rpc(
    client,
    "evidence_update_study",
    {
      p_study_id: studyId,
      p_expected_version: 5,
      p_label: "SRH History trial",
      p_design_profile: "rct_parallel",
      p_notes: "Synthetic notes for the History E2E.",
      p_request_id: randomUUID(),
    },
    { status: "applied", version: 6 },
  ); // 6
  await setLink(client, studyId, paperId, 6, "mark_provisional"); // 7
  await setLink(client, studyId, paperId, 7, "confirm"); // 8
  await saveChanges(client, studyId, 8, [setValue("demographics", "reported", text("Adults"), q("We randomized adults"))]); // 9
  await saveChanges(client, studyId, 9, [setValue("eligibility_criteria", "reported", text("Adults with type 2 diabetes"), q("adults with type 2 diabetes"))]); // 10
  await saveChanges(client, studyId, 10, [setValue("population_description", "reported", text("Adults with type 2 diabetes and obesity"), q("type 2 diabetes and obesity"))]); // 11
  await saveChanges(client, studyId, 11, [setValue("design_as_reported", "reported", text("Randomized 1:1"), q("randomized 1:1"))]); // 12
  values = await valuesOf(client, studyId);
  return { studyId, values };
}

/** Everything of one user's evidence rows, for an exact before/after comparison. */
async function fingerprint(ownerSql, userId) {
  const uid = sqlLiteral(assertUuid(userId));
  return ownerJson(
    ownerSql,
    "SELECT json_build_object(" +
      `'studies', (SELECT coalesce(json_agg(json_build_object('id', id, 'version', row_version, 'label', label, 'notes', notes) ORDER BY id), '[]'::json) FROM public.evidence_studies WHERE user_id = ${uid}), ` +
      `'values', (SELECT coalesce(json_agg(json_build_object('id', id, 'field', field_key, 'version', value_version, 'status', review_status, 'note', review_note) ORDER BY id), '[]'::json) FROM public.evidence_field_values WHERE user_id = ${uid}), ` +
      `'links', (SELECT coalesce(json_agg(json_build_object('paper', paper_id, 'status', link_status) ORDER BY id), '[]'::json) FROM public.evidence_study_reports WHERE user_id = ${uid}), ` +
      `'events', (SELECT coalesce(json_agg(json_build_object('version', study_version, 'ordinal', ordinal, 'type', event_type) ORDER BY study_id, study_version, ordinal), '[]'::json) FROM public.evidence_events WHERE user_id = ${uid})` +
      ")::text;",
  );
}

/**
 * Create both accounts and everything they hold. Returns the credentials for
 * the Playwright environment and what the post-run proof compares against.
 * Nothing returned is printed.
 */
export async function provisionStudyHistoryAccounts({ apiUrl, anonKey, serviceRoleKey, ownerSql, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  if (!serviceRoleKey || !anonKey) throw new Error("Study history fixture refused: missing local service-role or anon key.");
  assertOwnerSql(ownerSql);

  const admin = createClient(apiUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const accounts = [];
  try {
    // ── The pilot owner ──
    const owner = await createAccount(admin, OWNER_PREFIX);
    accounts.push(owner);
    await setRole(ownerSql, owner.userId, "owner");
    const ownerClient = await signedIn(apiUrl, anonKey, owner);
    owner.papers = await insertPapers(ownerClient, [
      paper(owner.userId, HISTORY_TITLES.history, "10.5555/srh-e2e.0001", HISTORY_ABSTRACT),
      paper(owner.userId, HISTORY_TITLES.creation, "10.5555/srh-e2e.0002", CREATION_ABSTRACT),
    ]);
    const history = await writeHistory(ownerClient, owner.papers[HISTORY_TITLES.history]);
    await ownerClient.auth.signOut();
    owner.studyId = history.studyId;
    owner.valueIds = Object.fromEntries(Object.entries(history.values).map(([field, value]) => [field, value.id]));

    // ── The former owner, now a manager ──
    const former = await createAccount(admin, FORMER_PREFIX);
    accounts.push(former);
    await setRole(ownerSql, former.userId, "owner");
    const formerClient = await signedIn(apiUrl, anonKey, former);
    former.papers = await insertPapers(formerClient, [paper(former.userId, HISTORY_TITLES.former, "10.5555/srh-e2e.0101", FORMER_ABSTRACT)]);
    const formerPaper = former.papers[HISTORY_TITLES.former];
    const formerStudy = await createStudy(formerClient, formerPaper, "SRH Former owner's trial");
    await saveChanges(formerClient, formerStudy.studyId, 1, [
      setValue("setting", "reported", text("Offices"), [quote(formerPaper, formerStudy.snapshotId, "office workers")]),
      setValue("condition", "reported", text("Office workers"), [quote(formerPaper, formerStudy.snapshotId, "daily stretching in office workers")]),
    ]);
    await review(formerClient, formerStudy.studyId, 2, (await valuesOf(formerClient, formerStudy.studyId)).condition, "confirm", null);
    // One large save: its details take two pages (50 + 2).
    await saveChanges(formerClient, formerStudy.studyId, 3, [
      ...Array.from({ length: FORMER_GROUPS }, (_, i) => ({ op: "add_arm", ref: `g${i}`, arm_role: i === 0 ? "comparator" : "intervention", display_label: `Group ${i + 1}`, position: i })),
      ...Array.from({ length: FORMER_OUTCOMES }, (_, i) => ({ op: "add_outcome", ref: `o${i}`, display_label: `Outcome ${i + 1}`, position: i })),
    ]);
    await formerClient.auth.signOut();
    await setRole(ownerSql, former.userId, "manager");
    former.studyId = formerStudy.studyId;
    former.before = await fingerprint(ownerSql, former.userId);

    log(`  provisioned study-history accounts: pilot owner (2 papers, 1 study record with 12 committed operations) and former owner now manager (1 study record, 4 operations, the last of ${FORMER_GROUPS + FORMER_OUTCOMES} changes)`);
    return { owner, former };
  } catch (err) {
    await removeStudyHistoryAccounts({ apiUrl, serviceRoleKey, ownerSql, accounts: { list: accounts }, log }).catch(() => {});
    throw err;
  }
}

/**
 * Every committed operation of the history study after a full green run of
 * the spec: its op and its change events, in order — with the field of each
 * value event, and the review a value event recorded before and after.
 * Written from the fixture's and the spec's steps, not read back from a run.
 * Versions 13–17 are the spec's; the History viewer itself writes none.
 */
const EXPECTED_HISTORY = Object.freeze([
  [1, "create_study", [["study_created"], ["link_created"], ["source_captured"]]],
  [2, "save_changes", [["arm_added"], ["arm_added"], ["outcome_added"], ["value_saved", "condition", null, "unreviewed"], ["value_saved", "setting", null, "unreviewed"], ["value_saved", "comparator_type", null, "unreviewed"]]],
  [3, "review_fields", [["review_confirmed", "condition", "unreviewed", "user_reviewed"]]],
  [4, "review_fields", [["review_flagged", "setting", "unreviewed", "disputed"]]],
  [5, "save_changes", [["value_saved", "condition", "user_reviewed", "unreviewed"]]],
  [6, "update_study", [["study_updated"]]],
  [7, "set_link", [["link_status_changed"]]],
  [8, "set_link", [["link_status_changed"]]],
  [9, "save_changes", [["value_saved", "demographics", null, "unreviewed"]]],
  [10, "save_changes", [["value_saved", "eligibility_criteria", null, "unreviewed"]]],
  [11, "save_changes", [["value_saved", "population_description", null, "unreviewed"]]],
  [12, "save_changes", [["value_saved", "design_as_reported", null, "unreviewed"]]],
  // H3: the demographics text edited in the browser and saved.
  [13, "save_changes", [["value_saved", "demographics", "unreviewed", "unreviewed"]]],
  // H4: confirmed in Review.
  [14, "review_fields", [["review_confirmed", "demographics", "unreviewed", "user_reviewed"]]],
  // H5: the eligibility criteria flagged in Review.
  [15, "review_fields", [["review_flagged", "eligibility_criteria", "unreviewed", "disputed"]]],
  // H6: the confirmed demographics edited again: the save reset the review.
  [16, "save_changes", [["value_saved", "demographics", "user_reviewed", "unreviewed"]]],
  // H11: committed "in another tab" while History was open, then shown by Refresh.
  [17, "set_link", [["link_status_changed"]]],
]);
/** The record H2 creates in the browser: one operation, as the create RPC records it. */
const EXPECTED_CREATION = Object.freeze([[1, "create_study", [["study_created"], ["link_created"], ["source_captured"]]]]);

const canonical = (value) => JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

/** One study's committed operations, as the database holds them: [version, op, [[type, field, review before, review after], …]]. */
async function operationsOf(ownerSql, userId, studyId) {
  const uid = sqlLiteral(assertUuid(userId));
  const sid = sqlLiteral(assertUuid(studyId));
  return ownerJson(
    ownerSql,
    "SELECT json_build_object(" +
      `'version', (SELECT row_version FROM public.evidence_studies WHERE user_id = ${uid} AND id = ${sid}), ` +
      "'operations', (SELECT coalesce(json_agg(json_build_array(h.study_version, h.op, (" +
      "SELECT coalesce(json_agg(CASE WHEN c.field_key IS NULL THEN json_build_array(c.event_type) " +
      "ELSE json_build_array(c.event_type, c.field_key, c.before -> 'review' ->> 'status', c.after -> 'review' ->> 'status') END ORDER BY c.ordinal), '[]'::json) " +
      `FROM public.evidence_events c WHERE c.user_id = ${uid} AND c.study_id = ${sid} AND c.study_version = h.study_version AND c.ordinal > 0 AND c.request_id = h.request_id)) ` +
      "ORDER BY h.study_version), '[]'::json) " +
      `FROM public.evidence_events h WHERE h.user_id = ${uid} AND h.study_id = ${sid} AND h.ordinal = 0), ` +
      `'events', (SELECT count(*) FROM public.evidence_events e WHERE e.user_id = ${uid} AND e.study_id = ${sid}), ` +
      `'orphans', (SELECT count(*) FROM public.evidence_events c WHERE c.user_id = ${uid} AND c.study_id = ${sid} AND c.ordinal > 0 AND NOT EXISTS (` +
      `SELECT 1 FROM public.evidence_events h WHERE h.user_id = c.user_id AND h.study_id = c.study_id AND h.study_version = c.study_version AND h.ordinal = 0 AND h.request_id = c.request_id))` +
      ")::text;",
  );
}

/** The owner's study record on a paper, by title: its id, or null. */
async function studyOnPaper(ownerSql, userId, title) {
  const uid = sqlLiteral(assertUuid(userId));
  const rows = await ownerJson(
    ownerSql,
    "SELECT coalesce(json_agg(r.study_id), '[]'::json)::text FROM public.evidence_study_reports r JOIN public.papers p ON p.id = r.paper_id AND p.user_id = r.user_id " +
      `WHERE r.user_id = ${uid} AND p.title = ${sqlLiteral(title)};`,
  );
  if (rows.length > 1) throw new Error(`study-records-history E2E: ${rows.length} study records report "${title}"; expected at most 1.`);
  return rows[0] ?? null;
}

function expectOperations(label, actual, expected) {
  const total = expected.reduce((sum, [, , changes]) => sum + 1 + changes.length, 0);
  if (
    canonical(actual.operations) !== canonical(expected) ||
    actual.version !== expected.length ||
    actual.events !== total ||
    actual.orphans !== 0
  ) {
    throw new Error(`study-records-history E2E: ${label} holds ${canonical(actual)}; expected ${canonical({ version: expected.length, operations: expected, events: total, orphans: 0 })}.`);
  }
}

/**
 * Authoritative post-run proof, as the database owner, then removal — the
 * removal verified too. The spec asserts what the browser can see; this
 * asserts what only the database can.
 */
export async function assertStudyHistoryOutcomeAndRemove({ apiUrl, serviceRoleKey, ownerSql, accounts, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  assertOwnerSql(ownerSql);
  const { owner, former } = accounts;
  assertDisposableEmail(owner.email);
  assertDisposableEmail(former.email);

  // Every operation, exactly once, at its own version, with its own events — and none from the viewer.
  expectOperations("the history study", await operationsOf(ownerSql, owner.userId, owner.studyId), EXPECTED_HISTORY);

  // H2: the record created in the browser.
  const created = await studyOnPaper(ownerSql, owner.userId, HISTORY_TITLES.creation);
  if (!created) throw new Error("study-records-history E2E: no study record was created on the creation paper.");
  expectOperations("the record created in the browser", await operationsOf(ownerSql, owner.userId, created), EXPECTED_CREATION);

  // H10: the former owner — now a manager — changed nothing, though the spec sent a write directly.
  const after = await fingerprint(ownerSql, former.userId);
  if (canonical(after) !== canonical(former.before)) {
    throw new Error("study-records-history E2E: the former owner's study record changed.");
  }
  log("  verified: every committed operation of the history study, in order, with its own events — the fixture's 12 and the spec's 5, nothing from the viewer; the record created in the browser; the former owner's record unchanged");

  await removeStudyHistoryAccounts({ apiUrl, serviceRoleKey, ownerSql, accounts: { list: [owner, former] }, log });
}

/**
 * Remove both accounts — their papers, study records and history go with
 * them (every table cascades from `auth.users`) — then VERIFY, as the database
 * owner, that no account with this module's prefixes and no row of theirs
 * remains. Throws when anything does.
 */
export async function removeStudyHistoryAccounts({ apiUrl, serviceRoleKey, ownerSql, accounts, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  assertOwnerSql(ownerSql);
  const list = (accounts?.list ?? [accounts?.owner, accounts?.former]).filter(Boolean);
  const admin = createClient(apiUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  for (const account of list) {
    assertDisposableEmail(account.email);
    const removed = await admin.auth.admin.deleteUser(account.userId, false);
    if (removed.error && !/not.?found/i.test(removed.error.message)) {
      throw new Error(`study history fixture: removing an account failed: ${removed.error.message}`);
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
    throw new Error(`study history fixture: removal left rows behind (${left.map(([name, count]) => `${name}: ${count}`).join(", ")}).`);
  }
  if (list.length > 0) log("  removed the disposable study-history accounts; verified: no account with their prefixes and no row of theirs remains.");
}
