// @ts-nocheck
/**
 * Disposable, model-selection-ENTITLED local account for the
 * AI-MODEL-SELECTION-001C Settings E2E.
 *
 * The deterministic seed users are both Free, and `handle_new_user` writes
 * `ai_model_selection_enabled = false` by default — which is exactly the state
 * the spec's *non-entitled* cases need, so the seed is deliberately left alone.
 * The entitled cases need the other side of the gate, so this module creates a
 * separate disposable user per run and grants the capability the same way
 * Production would: a **server-side write to the entitlement flag**, using the
 * local elevated key. Nothing is granted from client code, from a plan name, or
 * from an email allowlist — that is the whole point of owner decision C33.
 *
 * The account is removed again after the run, so the local stack is left in the
 * same deterministic state it started in. The spec writes and clears a real
 * preference row belonging to this account only; no seeded identity ever holds
 * a `user_ai_preferences` row.
 *
 * **Two different levels of access, deliberately.** Fixture *administration*
 * uses the local elevated (service-role) client, because only it can do those
 * things: creating and deleting the disposable Auth user, and writing the
 * account's `user_entitlements.ai_model_selection_enabled` flag. Preference
 * *verification* does not, and must not: migration `20260902120000` revokes
 * every privilege on `user_ai_preferences` from `service_role` on purpose, so
 * both the before and after checks sign in as the disposable account with the
 * local anon client and read that account's own row through the ordinary
 * authenticated SELECT-own RLS path (`readOwnPreference`). Granting
 * `service_role` back to make this easier would undo a real security property.
 *
 * Hard safety rules (mirroring scripts/e2e-local-delete-fixture.mjs):
 *   - only ever runs against a validated loopback Supabase API URL, checked
 *     before any credential is used and before any user is created;
 *   - the Production project ref may not appear anywhere in the target;
 *   - it can only ever create and mutate its own `.test` identity — the
 *     deterministic primary/secondary fixtures are explicitly refused;
 *   - it generates a fresh ephemeral password per run and never logs or
 *     persists any password, key, token, or JWT.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { PRIMARY_EMAIL, SECONDARY_EMAIL } from "./e2e-local-seed.mjs";
import { assertLoopbackApiUrl } from "./e2e-local-delete-fixture.mjs";

/** Prefix that marks an identity this module is allowed to touch. */
const DISPOSABLE_PREFIX = "e2e-disposable-model-";

/**
 * Refuse any identity that is not this run's disposable entitled account. The
 * two deterministic seed users must never be granted an entitlement or have one
 * revoked; naming one here is a programming error, not a recoverable condition.
 */
function assertDisposableEmail(email) {
  if (typeof email !== "string" || !email.endsWith("@paperlume.test")) {
    throw new Error("Model fixture refused: disposable email must be a .test address.");
  }
  if (email === PRIMARY_EMAIL || email === SECONDARY_EMAIL) {
    throw new Error("Model fixture refused: will not target a deterministic seed identity.");
  }
  if (!email.startsWith(DISPOSABLE_PREFIX)) {
    throw new Error("Model fixture refused: disposable email must carry the disposable prefix.");
  }
  return email;
}

/** Strong ephemeral password. Never logged or persisted. */
function makeEphemeralPassword() {
  return `Aa1!${randomBytes(24).toString("base64url")}`;
}

/**
 * Read the account's own preference row through the product's real read path.
 *
 * Deliberately NOT read with the elevated key: migration `20260902120000`
 * revokes every privilege on `user_ai_preferences` from `service_role` on
 * purpose, so that a leaked secret key cannot read or rewrite anyone's saved
 * model. The row is readable only by its owner, under the SELECT-own policy —
 * so the fixture signs in as the account and reads it exactly as the app does.
 *
 * @returns the saved model id, or `null` when the account is on the default.
 */
async function readOwnPreference({ apiUrl, anonKey, email, password, userId }) {
  const client = createClient(apiUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`model fixture preference sign-in failed: ${signIn.error.message}`);
  try {
    const { data, error } = await client
      .from("user_ai_preferences")
      .select("preferred_model_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(`model fixture preference read failed: ${error.message}`);
    return data?.preferred_model_id ?? null;
  } finally {
    await client.auth.signOut();
  }
}

/**
 * Create the disposable account, give it one paper so the dashboard renders its
 * normal authenticated shell, and grant model selection through the
 * server-controlled entitlement flag.
 *
 * Deliberately does NOT create a `user_ai_preferences` row: "no preference"
 * is the state the spec starts from, and manufacturing one would erase the
 * distinction between "follows the default" and "explicitly chose 3.5".
 *
 * @param {{ apiUrl: string, anonKey: string, serviceRoleKey: string, log?: (m: string) => void }} opts
 */
export async function provisionEntitledModelAccount({
  apiUrl,
  anonKey,
  serviceRoleKey,
  log = () => {},
}) {
  assertLoopbackApiUrl(apiUrl);
  if (!serviceRoleKey || !anonKey) {
    throw new Error("Model fixture refused: missing local service-role or anon key.");
  }

  const email = assertDisposableEmail(`${DISPOSABLE_PREFIX}${randomUUID()}@paperlume.test`);
  const password = makeEphemeralPassword();

  const admin = createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(`model fixture createUser failed: ${created.error.message}`);
  const userId = created.data.user.id;

  // One paper, written the way the app writes it, so the dashboard shows its
  // usual "N papers" header and Settings is reachable by the usual route.
  const client = createClient(apiUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`model fixture sign-in failed: ${signIn.error.message}`);
  const paper = await client.from("papers").insert({
    user_id: userId,
    title: "Disposable paper for the AI model settings E2E",
    authors: ["Disposable Author"],
    year: 2026,
    journal: "Journal of Disposable Fixtures",
  });
  if (paper.error) throw new Error(`model fixture paper insert failed: ${paper.error.message}`);
  await client.auth.signOut();

  // The grant: a server-side write to the explicit capability flag. The plan
  // stays 'free' on purpose — the spec then proves the UI gate follows the
  // FLAG and not the plan name.
  const grant = await admin
    .from("user_entitlements")
    .update({ ai_model_selection_enabled: true })
    .eq("user_id", userId)
    .select("plan, plan_status, ai_model_selection_enabled")
    .maybeSingle();
  if (grant.error) throw new Error(`model fixture entitlement grant failed: ${grant.error.message}`);
  if (!grant.data) throw new Error("model fixture: signup trigger created no entitlement row.");
  if (grant.data.ai_model_selection_enabled !== true) {
    throw new Error("model fixture: entitlement flag did not take effect.");
  }
  if (!["active", "trialing"].includes(grant.data.plan_status)) {
    throw new Error(
      `model fixture: plan_status ${grant.data.plan_status} would make the setter reject.`,
    );
  }

  // Prove the account really starts with NO saved preference, so the spec's
  // "Paperlume default" assertion cannot pass for the wrong reason.
  const startingPreference = await readOwnPreference({ apiUrl, anonKey, email, password, userId });
  if (startingPreference !== null) {
    throw new Error(
      `model fixture: account unexpectedly starts with preference "${startingPreference}".`,
    );
  }

  log(
    `  provisioned entitled model account (plan=${grant.data.plan}, ` +
      `ai_model_selection_enabled=true, no preference row)`,
  );
  return { email, password, userId };
}

/**
 * Authoritative post-run check plus teardown.
 *
 * The spec's last action resets the account to Paperlume's default, so the
 * preference row must be gone. The browser can only observe the rendered
 * control, so that claim is re-checked here against the database — but through
 * the account's OWN authenticated SELECT-own read (`readOwnPreference`), never
 * with the elevated key, which 001A deliberately revokes on this table. The
 * elevated key is used only afterwards, to delete the disposable Auth user.
 */
export async function assertModelAccountResetAndRemove({
  apiUrl,
  anonKey,
  serviceRoleKey,
  account,
  log = () => {},
}) {
  assertLoopbackApiUrl(apiUrl);
  assertDisposableEmail(account.email);

  const remaining = await readOwnPreference({
    apiUrl,
    anonKey,
    email: account.email,
    password: account.password,
    userId: account.userId,
  });
  if (remaining !== null) {
    throw new Error(
      `ai-model E2E: the spec left the preference "${remaining}" behind; reset did not take effect.`,
    );
  }
  log("  verified: the entitled model account ended on Paperlume's default (no preference row)");

  await removeModelAccount({ apiUrl, serviceRoleKey, account, log });
}

/**
 * Best-effort removal, also used when a run fails so a debugging session with
 * E2E_KEEP_LOCAL_STACK=1 does not accumulate residue. Never throws.
 */
export async function removeModelAccount({ apiUrl, serviceRoleKey, account, log = () => {} }) {
  try {
    assertLoopbackApiUrl(apiUrl);
    assertDisposableEmail(account.email);
    const admin = createClient(apiUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await admin.auth.admin.deleteUser(account.userId, false);
    log("  removed the disposable entitled model account.");
  } catch {
    /* best-effort only */
  }
}
