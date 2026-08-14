// @ts-nocheck
/**
 * Disposable local-only account fixture for the PFA-C04 destructive E2E.
 *
 * The account-deletion spec is the only Playwright spec that destroys an
 * account, so it never touches the deterministic seed identities. This module
 * creates a *separate, disposable* user per run, gives it enough real data to
 * make the deletion meaningful, and — after the spec has driven the UI — proves
 * from the Node side that the account, its rows and its Storage binaries are
 * actually gone.
 *
 * Why the verification lives here and not in the spec:
 *   proving the Auth user no longer exists requires an elevated local key. It
 *   already exists in this lifecycle process (the seed uses it); handing it to
 *   the Playwright process as well would widen its exposure to the spawned Vite
 *   dev server and to every spec, for no gain. The browser-observable half of
 *   the contract (redirect, cleared session, credentials rejected) is asserted
 *   in the spec, where it belongs; the privileged half is asserted here.
 *
 * Hard safety rules (mirroring scripts/e2e-local-seed.mjs):
 *   - only ever runs against a validated loopback Supabase API URL, checked
 *     before any credential is used, any user is created, any object is
 *     uploaded, and any deletion is verified;
 *   - the Production project ref may not appear anywhere in the target;
 *   - it can only ever create and inspect its own `.test` identity — the
 *     deterministic primary/secondary fixtures are explicitly refused;
 *   - it generates a fresh ephemeral password per run and never logs or
 *     persists any password, key, token, or JWT.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { PRIMARY_EMAIL, SECONDARY_EMAIL } from "./e2e-local-seed.mjs";

/** Production project ref — must never appear in a destructive-fixture target. */
export const PRODUCTION_SUPABASE_REF = "lioxtgiputfniqbktcsz";

/** The private bucket the product uploads attachments into. */
const BUCKET = "attachments";

/**
 * Validate a candidate API URL before ANY destructive helper touches it.
 * Exported so the guard has focused unit coverage of its own: this is a new
 * execution path that deletes an Auth user, so it must fail closed on a
 * Production/remote/malformed target before a credential is read.
 */
export function assertLoopbackApiUrl(apiUrl) {
  let url;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error("Account-deletion fixture refused: API URL is not a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Account-deletion fixture refused: API URL must be http(s), got ${url.protocol}`,
    );
  }
  if (url.href.toLowerCase().includes(PRODUCTION_SUPABASE_REF)) {
    throw new Error(
      "Account-deletion fixture refused: API URL references the Production project ref.",
    );
  }
  const host = url.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "[::1]" ||
    host === "::1";
  if (!isLoopback) {
    throw new Error(`Account-deletion fixture refused: API URL host "${host}" is not loopback.`);
  }
  return url;
}

/**
 * Refuse any identity that is not this run's disposable account. The two
 * deterministic seed users must survive every destructive run; naming one here
 * is a programming error, not a recoverable condition.
 */
function assertDisposableEmail(email) {
  if (typeof email !== "string" || !email.endsWith("@paperlume.test")) {
    throw new Error("Account-deletion fixture refused: disposable email must be a .test address.");
  }
  if (email === PRIMARY_EMAIL || email === SECONDARY_EMAIL) {
    throw new Error(
      "Account-deletion fixture refused: will not target a deterministic seed identity.",
    );
  }
  if (!email.startsWith("e2e-disposable-delete-")) {
    throw new Error(
      "Account-deletion fixture refused: disposable email must carry the disposable prefix.",
    );
  }
  return email;
}

/** Strong ephemeral password. Never logged or persisted. */
function makeEphemeralPassword() {
  return `Aa1!${randomBytes(24).toString("base64url")}`;
}

/** Eight deterministic bytes; enough to be a real object without being large. */
function fixtureBytes() {
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
}

/**
 * Create the disposable account and populate it with representative data:
 * a profile + entitlement (signup trigger), one paper, one attachment whose
 * metadata row exists, and one **orphan** Storage object with no metadata row —
 * the case that makes Storage-sourced enumeration necessary rather than
 * convenient.
 *
 * Storage uploads run through an authenticated client so ownership and the
 * `<userId>/<paperId>/<name>` path contract match the real product path.
 *
 * @param {{ apiUrl: string, anonKey: string, serviceRoleKey: string, log?: (m: string) => void }} opts
 */
export async function provisionDisposableAccount({ apiUrl, anonKey, serviceRoleKey, log = () => {} }) {
  assertLoopbackApiUrl(apiUrl);
  if (!serviceRoleKey || !anonKey) {
    throw new Error("Account-deletion fixture refused: missing local service-role or anon key.");
  }

  const email = assertDisposableEmail(`e2e-disposable-delete-${randomUUID()}@paperlume.test`);
  const password = makeEphemeralPassword();

  const admin = createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) {
    throw new Error(`disposable createUser failed: ${created.error.message}`);
  }
  const userId = created.data.user.id;

  // Authenticated client — everything below is written the way the app writes it.
  const client = createClient(apiUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`disposable sign-in failed: ${signIn.error.message}`);

  const paper = await client
    .from("papers")
    .insert({
      user_id: userId,
      title: "Disposable paper for PFA-C04 account deletion",
      authors: ["Disposable Author"],
      year: 2026,
      journal: "Journal of Disposable Fixtures",
      notes: "This row must not survive the account deletion.",
    })
    .select("id")
    .single();
  if (paper.error) throw new Error(`disposable paper insert failed: ${paper.error.message}`);
  const paperId = paper.data.id;

  const bytes = fixtureBytes();
  const attachmentPath = `${userId}/${paperId}/disposable-attachment.pdf`;
  // No `paper_attachments` row for this one on purpose: an orphaned binary is
  // exactly what a metadata-driven cleanup would miss.
  const orphanPath = `${userId}/${paperId}/orphaned-binary.pdf`;

  for (const path of [attachmentPath, orphanPath]) {
    const upload = await client.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: "application/pdf", upsert: false });
    if (upload.error) throw new Error(`disposable upload failed: ${upload.error.message}`);
  }

  const meta = await client.from("paper_attachments").insert({
    paper_id: paperId,
    user_id: userId,
    file_path: attachmentPath,
    file_name: "disposable-attachment.pdf",
    file_type: "application/pdf",
    size_bytes: bytes.length,
  });
  if (meta.error) throw new Error(`disposable attachment metadata failed: ${meta.error.message}`);

  await client.auth.signOut();

  // Prove the fixture really exists before the spec runs, so a later
  // "everything is gone" assertion cannot pass because nothing was created.
  const present = await admin.storage.from(BUCKET).list(`${userId}/${paperId}`, { limit: 100 });
  if (present.error) throw new Error(`disposable storage probe failed: ${present.error.message}`);
  if ((present.data ?? []).length !== 2) {
    throw new Error(
      `disposable fixture expected 2 storage objects, found ${(present.data ?? []).length}.`,
    );
  }

  log(`  provisioned disposable deletion account (1 paper, 1 attachment, 1 orphan object)`);
  return { email, password, userId, paperId, attachmentPath, orphanPath };
}

/**
 * Authoritative post-run proof that the destructive E2E really destroyed the
 * account. Runs on fresh privileged connections AFTER Playwright has finished:
 * the Auth user must be gone, every owned row must be gone, and the account's
 * Storage namespace must be empty. Throws on any survivor.
 */
export async function assertDisposableAccountRemoved({
  apiUrl,
  serviceRoleKey,
  account,
  log = () => {},
}) {
  assertLoopbackApiUrl(apiUrl);
  assertDisposableEmail(account.email);

  const admin = createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const authUser = await admin.auth.admin.getUserById(account.userId);
  if (authUser.data?.user) {
    throw new Error("account-deletion E2E: the disposable Auth user still exists.");
  }

  const tables = [
    "profiles",
    "papers",
    "paper_attachments",
    "user_entitlements",
    "usage_counters",
    "user_storage_usage",
  ];
  for (const table of tables) {
    const { count, error } = await admin
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("user_id", account.userId);
    if (error) throw new Error(`account-deletion E2E: could not read ${table}: ${error.message}`);
    if (count !== 0) {
      throw new Error(`account-deletion E2E: ${count} ${table} row(s) survived the deletion.`);
    }
  }

  // Storage: walk the whole namespace, not just the known paths, so a forgotten
  // object anywhere under `<userId>/` fails the run.
  const remaining = await listStorageRecursively(admin, account.userId);
  if (remaining.length > 0) {
    throw new Error(
      `account-deletion E2E: ${remaining.length} Storage object(s) survived under the account namespace.`,
    );
  }

  log("  verified: Auth user, owned rows and Storage objects are all gone");
}

/** Recursive listing of everything under one user's Storage namespace. */
async function listStorageRecursively(admin, prefix, depth = 0) {
  if (depth > 8) throw new Error("account-deletion E2E: Storage namespace nested too deep.");
  const found = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await admin.storage.from(BUCKET).list(prefix, { limit: 100, offset });
    if (error) throw new Error(`account-deletion E2E: Storage list failed: ${error.message}`);
    const entries = data ?? [];
    if (entries.length === 0) break;
    for (const entry of entries) {
      const path = `${prefix}/${entry.name}`;
      if (entry.id === null || entry.id === undefined) {
        found.push(...(await listStorageRecursively(admin, path, depth + 1)));
      } else {
        found.push(path);
      }
    }
    if (entries.length < 100) break;
    offset += entries.length;
  }
  return found;
}

/**
 * Best-effort removal of a disposable account that survived a failed run, so a
 * debugging session with E2E_KEEP_LOCAL_STACK=1 does not accumulate residue.
 * Never throws — the caller is already reporting a failure.
 */
export async function cleanupDisposableAccount({ apiUrl, serviceRoleKey, account, log = () => {} }) {
  try {
    assertLoopbackApiUrl(apiUrl);
    assertDisposableEmail(account.email);
    const admin = createClient(apiUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const paths = await listStorageRecursively(admin, account.userId);
    if (paths.length > 0) await admin.storage.from(BUCKET).remove(paths);
    await admin.auth.admin.deleteUser(account.userId, false);
    log("  removed the leftover disposable deletion account.");
  } catch {
    /* best-effort only */
  }
}
