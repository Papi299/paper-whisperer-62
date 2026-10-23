// @ts-nocheck
/**
 * Disposable accounts for the EVIDENCE-RECORDS-001C1 Study Record E2E
 * (`e2e/study-records.spec.ts`).
 *
 * The Study Record UI is gated by the owner-only pilot: the server's
 * `evidence_records_assert_writable()` reads the caller's role from
 * `internal_user_access` on every create, edit and link call. The seeded
 * users hold no role, so — like the entitled model fixture — this module
 * creates SEPARATE disposable users per run and grants the role the way
 * Production's operator does: a server-side row in `internal_user_access`,
 * written as the local database owner. No seed identity is touched, nothing is
 * granted from client code, a JWT claim or an email address, and no Production
 * setting is involved: the target is a validated loopback stack.
 *
 *   * OWNER — role `owner` for the whole run. Six synthetic `SR-E2E` papers:
 *       - the main paper, whose abstract carries thin spaces, superscripts and
 *         one phrase twice (Requirements-001's E2E fixture);
 *       - a delete-race paper with one Project, one Tag and one attachment,
 *         unlinked until the spec links it mid-confirmation;
 *       - a duplicate pair (DOI and the same DOI with a trailing space — one
 *         duplicate group, two rows the per-user DOI index allows), the sparser
 *         one holding a study record created through the real RPC;
 *       - a merge-race pair (same DOI rule), the discard with one Project, one
 *         Tag and one attachment, unlinked until the spec links it.
 *   * FORMER — granted `owner`, given one study record through the real RPC,
 *     then demoted to `manager`: a manager is not an owner, and a former owner
 *     keeps View and Delete for the records they hold. One paper with that
 *     record, one without.
 *
 * Access levels, deliberately separate (as in the other fixtures): the local
 * secret key does Auth administration and Storage cleanup only; roles are
 * written through `ownerSql` (postgres on the container socket, because
 * service_role holds no application-table privilege since C57); everything a
 * user owns — papers, Projects, Tags, attachments, study records — is written
 * as that user, through the same paths the app uses.
 *
 * After Playwright, `assertStudyRecordOutcomeAndRemove` re-checks as the
 * database owner what only it can see: the papers the spec could not delete or
 * merge still hold every Project/Tag assignment and attachment, no cleanup job
 * was queued for them, and the records the spec deleted are gone while their
 * papers stay. Then both accounts are removed.
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

const OWNER_PREFIX = "e2e-disposable-study-owner-";
const FORMER_PREFIX = "e2e-disposable-study-former-";
const BUCKET = "attachments";

// Built from code points so the characters reach the database exactly.
const THIN_SPACE = String.fromCodePoint(0x2009);
const SUPERSCRIPT_TWO = String.fromCodePoint(0x00b2);
const SUPERSCRIPT_NINE = String.fromCodePoint(0x2079);
const GREATER_EQUAL = String.fromCodePoint(0x2265);
const TIMES = String.fromCodePoint(0x00d7);

/** The phrase the main abstract holds twice. The spec types it to require a choice of occurrence. */
export const REPEATED_PHRASE = "body weight was measured";

export const MAIN_ABSTRACT = [
  `Background: Adults with type 2 diabetes and obesity (BMI ${GREATER_EQUAL}30${THIN_SPACE}kg/m${SUPERSCRIPT_TWO}) were randomized 1:1 to metformin or placebo.`,
  `Methods: 120 participants were followed for 12${THIN_SPACE}weeks; ${REPEATED_PHRASE} at baseline and ${REPEATED_PHRASE} again at week 12.`,
  `Results: Leukocytes stayed at 6.1${TIMES}10${SUPERSCRIPT_NINE}/L; HbA1c fell by 0.8${THIN_SPACE}% (p${THIN_SPACE}<${THIN_SPACE}0.001).`,
].join("\n");

export const TITLES = Object.freeze({
  main: "SR-E2E Metformin trial",
  deleteRace: "SR-E2E Delete race",
  duplicateKept: "SR-E2E Duplicate pair (complete)",
  duplicateHeld: "SR-E2E Duplicate pair (has a study record)",
  mergeKept: "SR-E2E Merge race (complete)",
  mergeDiscard: "SR-E2E Merge race (sparse)",
  formerHeld: "SR-E2E Former owner's paper",
  formerFree: "SR-E2E Paper without a record",
});

const EMPTY_LISTS = { keywords: [], raw_keywords: [], mesh_terms: [], substances: [] };

function ownerPapers(userId) {
  const complete = (title, doi, abstract) => ({
    ...EMPTY_LISTS,
    user_id: userId,
    title,
    authors: ["Doe J", "Roe R"],
    year: 2024,
    journal: "Journal of Study Record Fixtures",
    doi,
    abstract,
    study_type: "Randomized Controlled Trial",
  });
  const sparse = (title, doi) => ({ ...EMPTY_LISTS, user_id: userId, title, authors: [], year: null, journal: null, doi });
  return [
    complete(TITLES.main, "10.5555/sr-e2e.0001", MAIN_ABSTRACT),
    complete(TITLES.deleteRace, "10.5555/sr-e2e.0002", "Synthetic abstract for the delete race: adults received the intervention for six weeks."),
    complete(TITLES.duplicateKept, "10.5555/sr-e2e.0003", "Synthetic abstract for the duplicate pair."),
    sparse(TITLES.duplicateHeld, "10.5555/sr-e2e.0003 "),
    complete(TITLES.mergeKept, "10.5555/sr-e2e.0005", "Synthetic abstract for the merge race."),
    sparse(TITLES.mergeDiscard, "10.5555/sr-e2e.0005 "),
  ];
}

function formerPapers(userId) {
  return [
    {
      ...EMPTY_LISTS,
      user_id: userId,
      title: TITLES.formerHeld,
      authors: ["Former F"],
      year: 2021,
      journal: "Journal of Study Record Fixtures",
      doi: "10.5555/sr-e2e.0101",
      abstract: "Synthetic abstract for the former owner's study record: older adults walked daily for a year.",
    },
    {
      ...EMPTY_LISTS,
      user_id: userId,
      title: TITLES.formerFree,
      authors: ["Former F"],
      year: 2020,
      journal: null,
      doi: "10.5555/sr-e2e.0102",
      // An abstract, so the row has its expander: the spec proves that a paper
      // without a record offers this user nothing even when expanded.
      abstract: "Synthetic abstract for a paper the former owner never recorded.",
    },
  ];
}

function assertDisposableEmail(email) {
  if (typeof email !== "string" || !email.endsWith("@paperlume.test")) {
    throw new Error("Study record fixture refused: disposable email must be a .test address.");
  }
  if (email === PRIMARY_EMAIL || email === SECONDARY_EMAIL) {
    throw new Error("Study record fixture refused: will not target a deterministic seed identity.");
  }
  if (!email.startsWith(OWNER_PREFIX) && !email.startsWith(FORMER_PREFIX)) {
    throw new Error("Study record fixture refused: disposable email must carry this module's prefix.");
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
  if (result.length !== 1 || result[0] !== role) throw new Error(`study record fixture: role ${role} did not take effect.`);
}

async function createAccount(admin, prefix) {
  const email = assertDisposableEmail(`${prefix}${randomUUID()}@paperlume.test`);
  const password = makeEphemeralPassword();
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(`study record fixture createUser failed: ${created.error.message}`);
  return { email, password, userId: created.data.user.id };
}

async function signedIn(apiUrl, anonKey, account) {
  const client = createClient(apiUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email: account.email, password: account.password });
  if (signIn.error) throw new Error(`study record fixture sign-in failed: ${signIn.error.message}`);
  return client;
}

async function insertPapers(client, rows) {
  const inserted = await client.from("papers").insert(rows).select("id, title");
  if (inserted.error) throw new Error(`study record fixture paper insert failed: ${inserted.error.message}`);
  const byTitle = {};
  for (const row of inserted.data) byTitle[row.title] = row.id;
  return byTitle;
}

/** One study record through the real lifecycle RPC, as the signed-in user. */
async function createStudy(client, paperId, label) {
  const { data, error } = await client.rpc("evidence_create_study_from_paper", {
    p_paper_id: paperId,
    p_label: label,
    p_design_profile: "rct_parallel",
    p_link_status: "user_confirmed",
    p_request_id: randomUUID(),
  });
  if (error) throw new Error(`study record fixture study creation failed: ${error.message}`);
  if (!data || data.status !== "applied") throw new Error("study record fixture: study creation was not applied.");
  return data.study_id;
}

/** One Project, one Tag, and one attachment for each of `paperIds`, the way the app writes them. */
async function decorate(client, userId, paperIds) {
  const project = await client.from("projects").insert({ user_id: userId, name: "SR-E2E Project" }).select("id").single();
  if (project.error) throw new Error(`study record fixture project insert failed: ${project.error.message}`);
  const tag = await client.from("tags").insert({ user_id: userId, name: "SR-E2E Tag" }).select("id").single();
  if (tag.error) throw new Error(`study record fixture tag insert failed: ${tag.error.message}`);
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
  const paths = {};
  for (const paperId of paperIds) {
    for (const [fn, args] of [
      ["set_paper_projects", { p_paper_id: paperId, p_project_ids: [project.data.id] }],
      ["set_paper_tags", { p_paper_id: paperId, p_tag_ids: [tag.data.id] }],
    ]) {
      const { error } = await client.rpc(fn, args);
      if (error) throw new Error(`study record fixture ${fn} failed: ${error.message}`);
    }
    const path = `${userId}/${paperId}/sr-e2e-attachment.pdf`;
    const upload = await client.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: false });
    if (upload.error) throw new Error(`study record fixture upload failed: ${upload.error.message}`);
    const meta = await client.rpc("finalize_attachment_upload", {
      p_paper_id: paperId,
      p_file_path: path,
      p_file_name: "sr-e2e-attachment.pdf",
      p_file_type: "application/pdf",
      p_size_bytes: bytes.length,
    });
    if (meta.error || (meta.data ?? [])[0]?.status !== "metadata_committed") {
      throw new Error("study record fixture: attachment metadata was not committed.");
    }
    paths[paperId] = path;
  }
  return { projectId: project.data.id, tagId: tag.data.id, paths };
}

/** What a paper holds besides itself: assignments, attachments, queued cleanup, study links. */
async function paperState(ownerSql, userId, paperId, path) {
  const uid = sqlLiteral(assertUuid(userId));
  const pid = sqlLiteral(assertUuid(paperId));
  return ownerJson(
    ownerSql,
    "SELECT json_build_object(" +
      `'paper', (SELECT count(*) FROM public.papers WHERE id = ${pid} AND user_id = ${uid}), ` +
      `'projects', (SELECT coalesce(json_agg(project_id ORDER BY project_id), '[]'::json) FROM public.paper_projects WHERE paper_id = ${pid}), ` +
      `'tags', (SELECT coalesce(json_agg(tag_id ORDER BY tag_id), '[]'::json) FROM public.paper_tags WHERE paper_id = ${pid}), ` +
      `'attachments', (SELECT coalesce(json_agg(id ORDER BY id), '[]'::json) FROM public.paper_attachments WHERE paper_id = ${pid}), ` +
      `'queued', (SELECT count(*) FROM public.attachment_cleanup_queue WHERE user_id = ${uid} AND file_path = ${sqlLiteral(path)}), ` +
      `'links', (SELECT count(*) FROM public.evidence_study_reports WHERE user_id = ${uid} AND paper_id = ${pid})` +
      ")::text;",
  );
}

/**
 * Create both accounts and everything they hold. Returns the credentials for
 * the Playwright environment and the ids and "before" states the post-run
 * proof compares against. Nothing returned is printed.
 */
export async function provisionStudyRecordAccounts({ apiUrl, anonKey, serviceRoleKey, ownerSql, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  if (!serviceRoleKey || !anonKey) throw new Error("Study record fixture refused: missing local service-role or anon key.");
  assertOwnerSql(ownerSql);

  const admin = createClient(apiUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const accounts = [];
  try {
    // ── The pilot owner ──
    const owner = await createAccount(admin, OWNER_PREFIX);
    accounts.push(owner);
    await setRole(ownerSql, owner.userId, "owner");
    const ownerClient = await signedIn(apiUrl, anonKey, owner);
    owner.papers = await insertPapers(ownerClient, ownerPapers(owner.userId));
    const decorated = await decorate(ownerClient, owner.userId, [owner.papers[TITLES.deleteRace], owner.papers[TITLES.mergeDiscard]]);
    owner.paths = decorated.paths;
    owner.heldStudyId = await createStudy(ownerClient, owner.papers[TITLES.duplicateHeld], "Duplicate pair study");
    await ownerClient.auth.signOut();

    // ── The former owner, now a manager ──
    const former = await createAccount(admin, FORMER_PREFIX);
    accounts.push(former);
    await setRole(ownerSql, former.userId, "owner");
    const formerClient = await signedIn(apiUrl, anonKey, former);
    former.papers = await insertPapers(formerClient, formerPapers(former.userId));
    former.studyId = await createStudy(formerClient, former.papers[TITLES.formerHeld], "Former owner's study");
    await formerClient.auth.signOut();
    await setRole(ownerSql, former.userId, "manager");

    // The states the spec must leave unchanged where it is refused.
    owner.before = {
      deleteRace: await paperState(ownerSql, owner.userId, owner.papers[TITLES.deleteRace], owner.paths[owner.papers[TITLES.deleteRace]]),
      mergeDiscard: await paperState(ownerSql, owner.userId, owner.papers[TITLES.mergeDiscard], owner.paths[owner.papers[TITLES.mergeDiscard]]),
    };
    for (const [name, state] of Object.entries(owner.before)) {
      if (state.paper !== 1 || state.projects.length !== 1 || state.tags.length !== 1 || state.attachments.length !== 1 || state.queued !== 0 || state.links !== 0) {
        throw new Error(`study record fixture: the ${name} paper is not decorated as expected (${JSON.stringify(state)}).`);
      }
    }

    log("  provisioned study-record accounts: pilot owner (6 papers, 2 decorated, 1 study record) and former owner now manager (2 papers, 1 study record)");
    return { owner, former };
  } catch (err) {
    await removeStudyRecordAccounts({ apiUrl, serviceRoleKey, accounts: { list: accounts }, log });
    throw err;
  }
}

/**
 * Authoritative post-run proof, as the database owner, then removal. The spec
 * asserts what the browser can see; this asserts what only the database can:
 *   * the delete-race and merge-race papers — refused by the NO ACTION key
 *     after the spec linked them mid-confirmation — still hold every Project,
 *     Tag and attachment, with no cleanup job queued, and are now linked;
 *   * the main paper is gone, after its study record was deleted first;
 *   * both duplicate pairs survived;
 *   * the former owner's record is gone and its paper stays.
 */
export async function assertStudyRecordOutcomeAndRemove({ apiUrl, serviceRoleKey, ownerSql, accounts, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  assertOwnerSql(ownerSql);
  const { owner, former } = accounts;
  assertDisposableEmail(owner.email);
  assertDisposableEmail(former.email);

  for (const [name, title] of [
    ["deleteRace", TITLES.deleteRace],
    ["mergeDiscard", TITLES.mergeDiscard],
  ]) {
    const paperId = owner.papers[title];
    const after = await paperState(ownerSql, owner.userId, paperId, owner.paths[paperId]);
    const before = owner.before[name];
    const unchanged =
      after.paper === 1 &&
      JSON.stringify(after.projects) === JSON.stringify(before.projects) &&
      JSON.stringify(after.tags) === JSON.stringify(before.tags) &&
      JSON.stringify(after.attachments) === JSON.stringify(before.attachments) &&
      after.queued === 0;
    if (!unchanged) {
      throw new Error(`study-records E2E: the refused ${name} changed the paper's assignments, attachments or cleanup queue (${JSON.stringify({ before, after })}).`);
    }
    if (after.links !== 1) throw new Error(`study-records E2E: the ${name} paper is not linked (the race was not exercised).`);
  }

  const uid = sqlLiteral(assertUuid(owner.userId));
  const fid = sqlLiteral(assertUuid(former.userId));
  const titles = (userId) =>
    `(SELECT coalesce(json_agg(title ORDER BY title), '[]'::json) FROM public.papers WHERE user_id = ${userId})`;
  const summary = await ownerJson(
    ownerSql,
    "SELECT json_build_object(" +
      `'owner_titles', ${titles(uid)}, ` +
      `'former_titles', ${titles(fid)}, ` +
      `'former_studies', (SELECT count(*) FROM public.evidence_studies WHERE user_id = ${fid}), ` +
      `'held_study', (SELECT count(*) FROM public.evidence_studies WHERE user_id = ${uid} AND id = ${sqlLiteral(assertUuid(owner.heldStudyId))})` +
      ")::text;",
  );
  const expectedOwnerTitles = [TITLES.deleteRace, TITLES.duplicateHeld, TITLES.duplicateKept, TITLES.mergeDiscard, TITLES.mergeKept].sort();
  if (JSON.stringify(summary.owner_titles) !== JSON.stringify(expectedOwnerTitles)) {
    throw new Error(`study-records E2E: unexpected owner library after the run (${JSON.stringify(summary.owner_titles)}).`);
  }
  if (JSON.stringify(summary.former_titles) !== JSON.stringify([TITLES.formerHeld, TITLES.formerFree].sort())) {
    throw new Error("study-records E2E: the former owner's papers changed.");
  }
  if (summary.former_studies !== 0) throw new Error("study-records E2E: the former owner's study record was not deleted.");
  if (summary.held_study !== 1) throw new Error("study-records E2E: the duplicate pair's study record changed.");
  log("  verified: refused delete and merge left assignments, attachments and the cleanup queue unchanged; deleted records are gone, papers stay");

  await removeStudyRecordAccounts({ apiUrl, serviceRoleKey, accounts: { list: [owner, former] }, log });
}

/** Best-effort removal of both accounts and their Storage objects. Never throws. */
export async function removeStudyRecordAccounts({ apiUrl, serviceRoleKey, accounts, log = () => {} }) {
  const list = accounts?.list ?? [accounts?.owner, accounts?.former].filter(Boolean);
  try {
    assertLoopbackApiUrl(apiUrl);
    const admin = createClient(apiUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
    for (const account of list) {
      assertDisposableEmail(account.email);
      const paths = Object.values(account.paths ?? {});
      if (paths.length > 0) await admin.storage.from(BUCKET).remove(paths);
      await admin.auth.admin.deleteUser(account.userId, false);
    }
    if (list.length > 0) log("  removed the disposable study-record accounts.");
  } catch {
    /* best-effort only */
  }
}
