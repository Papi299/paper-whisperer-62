// @ts-nocheck
/**
 * Disposable accounts for the EVIDENCE-RECORDS-001C2A Review E2E
 * (`e2e/study-records-review.spec.ts`).
 *
 * Its own accounts, papers, study records and proof — nothing is shared with
 * the C1 fixture (`e2e-local-evidence-fixture.mjs`), so the two specs can run
 * alone, together, and in either order. The pilot owner role is granted the
 * way Production's operator grants it: a server-side row in the LOCAL
 * `internal_user_access`, written as the local database owner, for disposable
 * users only — never a seed identity, never a client-side flag.
 *
 *   * OWNER (`e2e-disposable-srr-owner-…`), role `owner` for the whole run.
 *       - "SRR-E2E Review trial" with one study record whose values cover what
 *         the spec reviews: quoted Reported values to confirm and to flag, a
 *         Reported value with no source and a design classification without
 *         support (Confirm blocked), a Not reported value with its examined
 *         saved copy, a group value, and one value already confirmed (to be
 *         edited and saved, which clears the review).
 *       - "SRR-E2E Conflict trial" with one quoted value, which the spec
 *         changes "in another tab" before pressing Confirm.
 *   * FORMER (`e2e-disposable-srr-former-…`): granted `owner`, given a study
 *     record with one value confirmed and one flagged, then set to `manager`.
 *     A manager is not an owner: Review shows the statuses and no action, and
 *     the server refuses a review sent directly.
 *
 * Every study record, value, quote and review is written as its user through
 * the real RPCs (`evidence_create_study_from_paper`, `evidence_save_changes`,
 * `evidence_review_fields`), so the server matched every quote and stamped
 * every review. Access levels stay separate: the local secret key does Auth
 * administration only; roles and every verification query go through
 * `ownerSql` (postgres on the container socket).
 *
 * After Playwright, `assertStudyReviewOutcomeAndRemove` checks as the database
 * owner what only the database can see — each value's review status, note and
 * versions, its review events (exactly one per recorded Confirm or Flag, none
 * for a refused or unsent one), the study versions, and the former owner's
 * record unchanged — then removes both accounts and VERIFIES that no account
 * with this module's prefixes and no row of theirs remains.
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

export const OWNER_PREFIX = "e2e-disposable-srr-owner-";
export const FORMER_PREFIX = "e2e-disposable-srr-former-";

export const REVIEW_TITLES = Object.freeze({
  review: "SRR-E2E Review trial",
  conflict: "SRR-E2E Conflict trial",
  former: "SRR-E2E Former owner's trial",
});

export const REVIEW_ABSTRACT = [
  "Background: We randomized adults with type 2 diabetes and obesity to metformin or placebo in outpatient clinics.",
  "Methods: 120 participants were randomized 1:1, and body weight was measured at baseline and at week 12.",
  "Results: HbA1c fell by 0.8 % with metformin; adverse events were mild.",
].join("\n");
const CONFLICT_ABSTRACT = "Background: Older adults walked daily for six months.\nMethods: 64 participants were randomized to walking or usual care.";
const FORMER_ABSTRACT = "Background: A synthetic trial of daily stretching in office workers.\nMethods: 40 participants were randomized.";

/** The notes the spec types into Flag; the proof expects the second, the update. */
export const FLAG_NOTES = Object.freeze({ first: "Check the methods", updated: "Check the methods and Table 1" });
const FORMER_FLAG_NOTE = "Check the full text";

const EMPTY_LISTS = { keywords: [], raw_keywords: [], mesh_terms: [], substances: [] };

function assertDisposableEmail(email) {
  if (typeof email !== "string" || !email.endsWith("@paperlume.test")) {
    throw new Error("Study review fixture refused: disposable email must be a .test address.");
  }
  if (email === PRIMARY_EMAIL || email === SECONDARY_EMAIL) {
    throw new Error("Study review fixture refused: will not target a deterministic seed identity.");
  }
  if (!email.startsWith(OWNER_PREFIX) && !email.startsWith(FORMER_PREFIX)) {
    throw new Error("Study review fixture refused: disposable email must carry this module's prefix.");
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
  if (result.length !== 1 || result[0] !== role) throw new Error(`study review fixture: role ${role} did not take effect.`);
}

async function createAccount(admin, prefix) {
  const email = assertDisposableEmail(`${prefix}${randomUUID()}@paperlume.test`);
  const password = makeEphemeralPassword();
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(`study review fixture createUser failed: ${created.error.message}`);
  return { email, password, userId: created.data.user.id };
}

async function signedIn(apiUrl, anonKey, account) {
  const client = createClient(apiUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email: account.email, password: account.password });
  if (signIn.error) throw new Error(`study review fixture sign-in failed: ${signIn.error.message}`);
  return client;
}

async function insertPapers(client, rows) {
  const inserted = await client.from("papers").insert(rows).select("id, title");
  if (inserted.error) throw new Error(`study review fixture paper insert failed: ${inserted.error.message}`);
  const byTitle = {};
  for (const row of inserted.data) byTitle[row.title] = row.id;
  return byTitle;
}

function paper(userId, title, doi, abstract) {
  return { ...EMPTY_LISTS, user_id: userId, title, authors: ["Roe R"], year: 2025, journal: "Journal of Review Fixtures", doi, abstract, study_type: "Randomized Controlled Trial" };
}

/** One RPC as the signed-in user; the answer must be `status` and the next study version. */
async function rpc(client, fn, args, expected) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`study review fixture ${fn} failed: ${error.message}`);
  if (!data || data.status !== expected.status || (expected.version !== undefined && data.study_version !== expected.version)) {
    throw new Error(`study review fixture: ${fn} did not answer ${expected.status} at version ${expected.version}.`);
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
  if (!data.snapshot_id) throw new Error("study review fixture: the study has no saved copy of the abstract.");
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
const setValue = (fieldKey, state, content, references, target = { scope: "study" }) => ({
  op: "set_value",
  target,
  field_key: fieldKey,
  expected_value_version: null,
  value_state: state,
  state_reason: null,
  content,
  note: null,
  references,
});

/** The review study's values, in one atomic save (study version 1 → 2). */
function reviewChanges(paperId, snapshotId) {
  const q = (passage) => [quote(paperId, snapshotId, passage)];
  return [
    { op: "add_arm", ref: "metformin", arm_role: "intervention", display_label: "Metformin", position: 0 },
    setValue("design_as_reported", "reported", text("Randomized 1:1"), q("randomized 1:1")),
    setValue("design_classification", "reported", { shape: "code", code: "rct_parallel" }, []),
    setValue("setting", "reported", text("Outpatient clinics"), []),
    setValue("registration_ids", "not_reported", null, [{ purpose: "examined", source_kind: "abstract", paper_id: paperId, snapshot_id: snapshotId }]),
    setValue("population_description", "reported", text("Adults with type 2 diabetes and obesity"), q("type 2 diabetes and obesity")),
    setValue("condition", "reported", text("Type 2 diabetes and obesity"), q("adults with type 2 diabetes and obesity")),
    setValue("eligibility_criteria", "reported", text("Adults with type 2 diabetes"), q("adults with type 2 diabetes")),
    setValue("demographics", "reported", text("Adults"), q("We randomized adults")),
    setValue("n_randomized", "reported", { shape: "integer_with_reported_text", reported_text: "120 participants", value: 120 }, q("120 participants were randomized")),
    setValue("arm_name_as_reported", "reported", text("Metformin"), q("metformin or placebo"), { scope: "arm", arm_ref: "metformin" }),
  ];
}

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
  if (error) throw new Error(`study review fixture value read failed: ${error.message}`);
  return Object.fromEntries(data.map((row) => [row.field_key, { id: row.id, version: row.value_version }]));
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

/** Everything of one user's evidence rows and reviews, for an exact before/after comparison. */
async function fingerprint(ownerSql, userId) {
  const uid = sqlLiteral(assertUuid(userId));
  return ownerJson(
    ownerSql,
    "SELECT json_build_object(" +
      `'studies', (SELECT coalesce(json_agg(json_build_object('id', id, 'version', row_version, 'label', label) ORDER BY id), '[]'::json) FROM public.evidence_studies WHERE user_id = ${uid}), ` +
      `'values', (SELECT coalesce(json_agg(json_build_object('id', id, 'field', field_key, 'state', value_state, 'version', value_version, 'status', review_status, ` +
      `'note', review_note, 'reviewed_at', reviewed_at, 'reviewed_version', reviewed_version) ORDER BY id), '[]'::json) FROM public.evidence_field_values WHERE user_id = ${uid}), ` +
      `'anchors', (SELECT count(*) FROM public.evidence_field_anchors WHERE user_id = ${uid}), ` +
      `'events', (SELECT count(*) FROM public.evidence_events WHERE user_id = ${uid})` +
      ")::text;",
  );
}

/**
 * Create both accounts and everything they hold. Returns the credentials for
 * the Playwright environment and what the post-run proof compares against.
 * Nothing returned is printed.
 */
export async function provisionStudyReviewAccounts({ apiUrl, anonKey, serviceRoleKey, ownerSql, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  if (!serviceRoleKey || !anonKey) throw new Error("Study review fixture refused: missing local service-role or anon key.");
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
      paper(owner.userId, REVIEW_TITLES.review, "10.5555/srr-e2e.0001", REVIEW_ABSTRACT),
      paper(owner.userId, REVIEW_TITLES.conflict, "10.5555/srr-e2e.0002", CONFLICT_ABSTRACT),
    ]);

    const reviewPaper = owner.papers[REVIEW_TITLES.review];
    const reviewStudy = await createStudy(ownerClient, reviewPaper, "SRR Review trial");
    await saveChanges(ownerClient, reviewStudy.studyId, 1, reviewChanges(reviewPaper, reviewStudy.snapshotId));
    // Confirmed already: the spec edits and saves it, which must clear the review.
    await review(ownerClient, reviewStudy.studyId, 2, (await valuesOf(ownerClient, reviewStudy.studyId)).design_as_reported, "confirm", null);

    const conflictPaper = owner.papers[REVIEW_TITLES.conflict];
    const conflictStudy = await createStudy(ownerClient, conflictPaper, "SRR Conflict trial");
    await saveChanges(ownerClient, conflictStudy.studyId, 1, [
      setValue("condition", "reported", text("Older adults"), [quote(conflictPaper, conflictStudy.snapshotId, "Older adults walked daily")]),
    ]);
    await ownerClient.auth.signOut();
    owner.studies = { review: reviewStudy.studyId, conflict: conflictStudy.studyId };

    // ── The former owner, now a manager ──
    const former = await createAccount(admin, FORMER_PREFIX);
    accounts.push(former);
    await setRole(ownerSql, former.userId, "owner");
    const formerClient = await signedIn(apiUrl, anonKey, former);
    former.papers = await insertPapers(formerClient, [paper(former.userId, REVIEW_TITLES.former, "10.5555/srr-e2e.0101", FORMER_ABSTRACT)]);
    const formerPaper = former.papers[REVIEW_TITLES.former];
    const formerStudy = await createStudy(formerClient, formerPaper, "SRR Former owner's trial");
    await saveChanges(formerClient, formerStudy.studyId, 1, [
      setValue("setting", "reported", text("Offices"), [quote(formerPaper, formerStudy.snapshotId, "office workers")]),
      setValue("condition", "reported", text("Office workers"), [quote(formerPaper, formerStudy.snapshotId, "daily stretching in office workers")]),
    ]);
    const formerValues = await valuesOf(formerClient, formerStudy.studyId);
    await review(formerClient, formerStudy.studyId, 2, formerValues.condition, "confirm", null);
    await review(formerClient, formerStudy.studyId, 3, formerValues.setting, "flag", FORMER_FLAG_NOTE);
    await formerClient.auth.signOut();
    await setRole(ownerSql, former.userId, "manager");
    former.studyId = formerStudy.studyId;
    former.before = await fingerprint(ownerSql, former.userId);

    log("  provisioned study-review accounts: pilot owner (2 papers, 2 study records, 1 value confirmed) and former owner now manager (1 study record, 1 confirmed, 1 flagged)");
    return { owner, former };
  } catch (err) {
    await removeStudyReviewAccounts({ apiUrl, serviceRoleKey, ownerSql, accounts: { list: accounts }, log }).catch(() => {});
    throw err;
  }
}

/**
 * What each value of the review study must hold after a full green run of
 * the spec, and its events by type: `value_saved` for each save that changed
 * it (the fixture's first save included), one review event per recorded
 * Confirm or Flag — none for a press that was blocked, unsent, unchanged or a
 * replay. Written from the spec's steps, not read back from a run.
 */
const EXPECTED_REVIEW_VALUES = Object.freeze({
  // R1: confirmed, persisted across reopening.
  condition: { status: "user_reviewed", note: null, version: 1, reviewed: 1, events: { value_saved: 1, review_confirmed: 1 } },
  // R2: Confirm blocked in the browser; nothing sent.
  setting: { status: "unreviewed", note: null, version: 1, reviewed: null, events: { value_saved: 1 } },
  design_classification: { status: "unreviewed", note: null, version: 1, reviewed: null, events: { value_saved: 1 } },
  // R3: a short note refused in the browser; flagged; the same note again unchanged; a new note flagged again.
  demographics: { status: "disputed", note: FLAG_NOTES.updated, version: 1, reviewed: null, events: { value_saved: 1, review_flagged: 2 } },
  // R4: edited but never saved; another value confirmed meanwhile.
  population_description: { status: "unreviewed", note: null, version: 1, reviewed: null, events: { value_saved: 1 } },
  n_randomized: { status: "user_reviewed", note: null, version: 1, reviewed: 1, events: { value_saved: 1, review_confirmed: 1 } },
  // R5: confirmed by the fixture, then edited and saved: back to Not reviewed at the next version.
  design_as_reported: { status: "unreviewed", note: null, version: 2, reviewed: null, events: { value_saved: 2, review_confirmed: 1 } },
  // R7: the answer was lost, and Try again replayed the same request: one Confirm.
  eligibility_criteria: { status: "user_reviewed", note: null, version: 1, reviewed: 1, events: { value_saved: 1, review_confirmed: 1 } },
  // On a phone: a Not reported claim confirmed with its saved copy shown beside it.
  registration_ids: { status: "user_reviewed", note: null, version: 1, reviewed: 1, events: { value_saved: 1, review_confirmed: 1 } },
  arm_name_as_reported: { status: "unreviewed", note: null, version: 1, reviewed: null, events: { value_saved: 1 } },
});
/** Fixture: create, save, confirm (3). Spec: R1, R3 ×2, R4, R5, R7, phone (7). */
const EXPECTED_REVIEW_STUDY_VERSION = 10;
/** Fixture: create, save (2). Spec: the change made "in another tab" (1); the refused Confirm adds none. */
const EXPECTED_CONFLICT_STUDY_VERSION = 3;

const canonical = (value) => JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

async function studyState(ownerSql, userId, studyId) {
  const uid = sqlLiteral(assertUuid(userId));
  const sid = sqlLiteral(assertUuid(studyId));
  return ownerJson(
    ownerSql,
    "SELECT json_build_object(" +
      `'version', (SELECT row_version FROM public.evidence_studies WHERE user_id = ${uid} AND id = ${sid}), ` +
      `'requests', (SELECT count(*) FROM public.evidence_events WHERE user_id = ${uid} AND study_id = ${sid} AND ordinal = 0), ` +
      `'request_versions', (SELECT count(DISTINCT study_version) FROM public.evidence_events WHERE user_id = ${uid} AND study_id = ${sid} AND ordinal = 0), ` +
      "'values', (SELECT coalesce(json_object_agg(v.field_key, json_build_object(" +
      "'status', v.review_status, 'note', v.review_note, 'version', v.value_version, 'reviewed', v.reviewed_version, " +
      "'reviewed_at', v.reviewed_at IS NOT NULL, " +
      "'events', (SELECT coalesce(json_object_agg(t.event_type, t.n), '{}'::json) FROM (" +
      `SELECT e.event_type, count(*) AS n FROM public.evidence_events e WHERE e.user_id = ${uid} AND e.study_id = ${sid} AND e.target_id = v.id GROUP BY e.event_type) t))), '{}'::json) ` +
      `FROM public.evidence_field_values v WHERE v.user_id = ${uid} AND v.study_id = ${sid})` +
      ")::text;",
  );
}

/**
 * Authoritative post-run proof, as the database owner, then removal — the
 * removal verified too. The spec asserts what the browser can see; this
 * asserts what only the database can.
 */
export async function assertStudyReviewOutcomeAndRemove({ apiUrl, serviceRoleKey, ownerSql, accounts, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  assertOwnerSql(ownerSql);
  const { owner, former } = accounts;
  assertDisposableEmail(owner.email);
  assertDisposableEmail(former.email);

  const reviewStudy = await studyState(ownerSql, owner.userId, owner.studies.review);
  const values = reviewStudy.values;
  if (canonical(Object.keys(values).sort()) !== canonical(Object.keys(EXPECTED_REVIEW_VALUES).sort())) {
    throw new Error(`study-records-review E2E: the review study holds other values than the fixture saved (${Object.keys(values).sort().join(", ")}).`);
  }
  for (const [field, expected] of Object.entries(EXPECTED_REVIEW_VALUES)) {
    const { reviewed_at: reviewedAt, ...actual } = values[field];
    if (canonical(actual) !== canonical(expected) || reviewedAt !== (expected.status === "user_reviewed")) {
      throw new Error(`study-records-review E2E: ${field} is ${canonical(values[field])}, expected ${canonical(expected)}.`);
    }
  }
  // One committed request is one version: no request was applied twice, and none was lost.
  if (reviewStudy.version !== EXPECTED_REVIEW_STUDY_VERSION || reviewStudy.requests !== EXPECTED_REVIEW_STUDY_VERSION || reviewStudy.request_versions !== EXPECTED_REVIEW_STUDY_VERSION) {
    throw new Error(`study-records-review E2E: the review study is at version ${reviewStudy.version} with ${reviewStudy.requests} requests; expected ${EXPECTED_REVIEW_STUDY_VERSION}.`);
  }

  const conflictStudy = await studyState(ownerSql, owner.userId, owner.studies.conflict);
  const condition = conflictStudy.values.condition;
  // R6: the change made elsewhere is saved (version 2), and the Confirm sent against the older version recorded nothing.
  if (
    conflictStudy.version !== EXPECTED_CONFLICT_STUDY_VERSION ||
    conflictStudy.requests !== EXPECTED_CONFLICT_STUDY_VERSION ||
    !condition ||
    condition.status !== "unreviewed" ||
    condition.version !== 2 ||
    canonical(condition.events) !== canonical({ value_saved: 2 })
  ) {
    throw new Error(`study-records-review E2E: the conflict study is ${canonical(conflictStudy)}; the refused Confirm must record nothing.`);
  }

  // R8: the former owner — now a manager — changed nothing, though the spec sent a review directly.
  const after = await fingerprint(ownerSql, former.userId);
  if (canonical(after) !== canonical(former.before)) {
    throw new Error("study-records-review E2E: the former owner's study record changed.");
  }
  const formerValues = Object.fromEntries(after.values.map((value) => [value.field, value]));
  if (formerValues.condition?.status !== "user_reviewed" || formerValues.setting?.status !== "disputed" || formerValues.setting?.note !== FORMER_FLAG_NOTE) {
    throw new Error("study-records-review E2E: the former owner's reviews are not as the fixture recorded them.");
  }
  log("  verified: each value's review status, note, versions and review events; one version per request; the refused Confirm and the manager's review recorded nothing");

  await removeStudyReviewAccounts({ apiUrl, serviceRoleKey, ownerSql, accounts: { list: [owner, former] }, log });
}

/**
 * Remove both accounts — their papers, study records and history go with
 * them (every table cascades from `auth.users`) — then VERIFY, as the database
 * owner, that no account with this module's prefixes and no row of theirs
 * remains. Throws when anything does.
 */
export async function removeStudyReviewAccounts({ apiUrl, serviceRoleKey, ownerSql, accounts, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  assertOwnerSql(ownerSql);
  const list = (accounts?.list ?? [accounts?.owner, accounts?.former]).filter(Boolean);
  const admin = createClient(apiUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  for (const account of list) {
    assertDisposableEmail(account.email);
    const removed = await admin.auth.admin.deleteUser(account.userId, false);
    if (removed.error && !/not.?found/i.test(removed.error.message)) {
      throw new Error(`study review fixture: removing an account failed: ${removed.error.message}`);
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
    throw new Error(`study review fixture: removal left rows behind (${left.map(([name, count]) => `${name}: ${count}`).join(", ")}).`);
  }
  if (list.length > 0) log("  removed the disposable study-review accounts; verified: no account with their prefixes and no row of theirs remains.");
}
