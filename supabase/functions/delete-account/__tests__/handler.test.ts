import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  GENERIC_FAILURE,
  handleDeleteAccountRequest,
  readBearerToken,
  type AdminClient,
  type DeleteAccountDeps,
} from "../handler.ts";
import {
  ACCOUNT_DELETION_CONFIRMATION,
  type StorageListEntry,
} from "../../_shared/accountDeletion.ts";

/**
 * Security/integration coverage for the ACTUAL delete-account request path.
 *
 * `handler.ts` is the code the deployed function runs — `index.ts` only injects
 * the real Supabase clients — so these tests exercise the real method gating,
 * the real token handling, the real confirmation enforcement, the real
 * Storage-before-Auth ordering and the real deletion-target derivation, with
 * fake clients standing in for the network.
 */

const AUTH_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = "header.payload.signature";
const URL = "https://local.test/functions/v1/delete-account";

function file(name: string): StorageListEntry {
  return { name, id: `obj-${name}` };
}
function folder(name: string): StorageListEntry {
  return { name, id: null };
}

interface Harness {
  deps: DeleteAccountDeps;
  removed: string[][];
  listedPaths: string[];
  bucketsUsed: string[];
  deleteUserCalls: Array<[string, boolean]>;
  logs: string[];
  errors: string[];
}

function harness(
  options: {
    tree?: Record<string, StorageListEntry[]>;
    authUser?: string | null;
    authError?: unknown;
    listError?: { message: string };
    removeError?: { message: string };
    deleteError?: unknown;
    noAdminClient?: boolean;
  } = {},
): Harness {
  const tree = options.tree ?? { [AUTH_USER]: [] };
  const removed: string[][] = [];
  const listedPaths: string[] = [];
  const bucketsUsed: string[] = [];
  const deleteUserCalls: Array<[string, boolean]> = [];
  const logs: string[] = [];
  const errors: string[] = [];

  const admin: AdminClient = {
    storage: {
      from(bucket) {
        bucketsUsed.push(bucket);
        return {
          async list(prefix, { limit, offset }) {
            listedPaths.push(prefix);
            if (options.listError) return { data: null, error: options.listError };
            const entries = tree[prefix] ?? [];
            return { data: entries.slice(offset, offset + limit), error: null };
          },
          async remove(paths) {
            removed.push([...paths]);
            if (options.removeError) return { data: null, error: options.removeError };
            return { data: paths.map((p) => ({ name: p })), error: null };
          },
        };
      },
    },
    auth: {
      admin: {
        async deleteUser(userId, shouldSoftDelete) {
          deleteUserCalls.push([userId, shouldSoftDelete]);
          return { error: options.deleteError ?? null };
        },
      },
    },
  };

  const authUser = options.authUser === undefined ? AUTH_USER : options.authUser;

  return {
    removed,
    listedPaths,
    bucketsUsed,
    deleteUserCalls,
    logs,
    errors,
    deps: {
      createCallerClient() {
        return {
          auth: {
            async getUser() {
              return {
                data: { user: authUser === null ? null : { id: authUser } },
                error: options.authError ?? null,
              };
            },
          },
        };
      },
      createAdminClient() {
        return options.noAdminClient ? null : admin;
      },
      logger: {
        log: (m) => logs.push(m),
        error: (m) => errors.push(m),
      },
    },
  };
}

function request(
  init: {
    method?: string;
    auth?: string | null;
    body?: unknown;
    rawBody?: string;
    query?: string;
  } = {},
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  const auth = init.auth === undefined ? `Bearer ${TOKEN}` : init.auth;
  if (auth !== null) headers.set("Authorization", auth);
  const method = init.method ?? "POST";
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  return new Request(`${URL}${init.query ?? ""}`, {
    method,
    headers,
    body: hasBody
      ? (init.rawBody ?? JSON.stringify(init.body ?? { confirmation: ACCOUNT_DELETION_CONFIRMATION }))
      : undefined,
  });
}

/** Nothing destructive ran. */
function expectNoMutation(h: Harness) {
  expect(h.removed).toEqual([]);
  expect(h.deleteUserCalls).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("method + CORS handling", () => {
  it("answers the CORS preflight without touching anything", async () => {
    const h = harness();
    const res = await handleDeleteAccountRequest(request({ method: "OPTIONS" }), h.deps);

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expectNoMutation(h);
    expect(h.listedPaths).toEqual([]);
  });

  it.each(["GET", "PUT", "PATCH", "DELETE", "HEAD"])(
    "rejects %s with 405 and mutates nothing",
    async (method) => {
      const h = harness();
      const res = await handleDeleteAccountRequest(request({ method }), h.deps);

      expect(res.status).toBe(405);
      expectNoMutation(h);
      expect(h.listedPaths).toEqual([]);
    },
  );

  it("rejects an unsupported method even with a valid token and confirmation", async () => {
    const h = harness();
    const res = await handleDeleteAccountRequest(request({ method: "GET" }), h.deps);
    expect(res.status).toBe(405);
    expect(await res.json()).toMatchObject({ error: "method_not_allowed" });
    expectNoMutation(h);
  });
});

describe("authentication", () => {
  it("rejects a request with no Authorization header", async () => {
    const h = harness();
    const res = await handleDeleteAccountRequest(request({ auth: null }), h.deps);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
    expectNoMutation(h);
  });

  it.each(["", "Bearer", "Bearer ", "Basic abc", "Token abc", TOKEN])(
    "rejects the malformed Authorization value %j",
    async (value) => {
      const h = harness();
      const res = await handleDeleteAccountRequest(request({ auth: value }), h.deps);
      expect(res.status).toBe(401);
      expectNoMutation(h);
    },
  );

  it("rejects a token the Auth service refuses", async () => {
    const h = harness({ authError: { message: "invalid JWT" }, authUser: null });
    const res = await handleDeleteAccountRequest(request(), h.deps);

    expect(res.status).toBe(401);
    expectNoMutation(h);
  });

  it("rejects a token for a user that no longer exists", async () => {
    // The retry case: an earlier attempt already removed the Auth user, so the
    // still-cached token authenticates to nothing.
    const h = harness({ authUser: null });
    const res = await handleDeleteAccountRequest(request(), h.deps);

    expect(res.status).toBe(401);
    expectNoMutation(h);
  });

  it("validates the exact bearer token from the header", async () => {
    const seen: string[] = [];
    const h = harness();
    const deps: DeleteAccountDeps = {
      ...h.deps,
      createCallerClient(token) {
        seen.push(token);
        return {
          auth: {
            async getUser(passed) {
              seen.push(passed);
              return { data: { user: { id: AUTH_USER } }, error: null };
            },
          },
        };
      },
    };

    await handleDeleteAccountRequest(request(), deps);
    expect(seen).toEqual([TOKEN, TOKEN]);
  });
});

describe("readBearerToken", () => {
  it.each([
    [`Bearer ${TOKEN}`, TOKEN],
    [`bearer ${TOKEN}`, TOKEN],
    [`  Bearer ${TOKEN}  `, TOKEN],
    [`Bearer   ${TOKEN}`, TOKEN],
  ])("accepts %j", (header, expected) => {
    expect(readBearerToken(header)).toBe(expected);
  });

  it.each([null, undefined, "", "Bearer", "Bearer ", "Bearer a b", "Basic abc", TOKEN])(
    "refuses %j",
    (header) => {
      expect(readBearerToken(header as string | null)).toBeNull();
    },
  );
});

describe("server-side confirmation enforcement", () => {
  it.each([
    ["a missing body", "" as string],
    ["malformed JSON", "{not json"],
    ["a JSON array", "[]"],
    ["a bare string", '"DELETE MY ACCOUNT"'],
  ])("rejects %s before any privileged mutation", async (_label, rawBody) => {
    const h = harness();
    const res = await handleDeleteAccountRequest(request({ rawBody }), h.deps);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_confirmation" });
    expectNoMutation(h);
  });

  it.each([
    ["no confirmation field", {}],
    ["a boolean flag", { confirmed: true }],
    ["the wrong phrase", { confirmation: "DELETE" }],
    ["the phrase in lower case", { confirmation: "delete my account" }],
    ["a padded phrase", { confirmation: " DELETE MY ACCOUNT " }],
  ])("rejects %s and deletes nothing", async (_label, body) => {
    const h = harness({ tree: { [AUTH_USER]: [file("a.pdf")] } });
    const res = await handleDeleteAccountRequest(request({ body }), h.deps);

    expect(res.status).toBe(400);
    expectNoMutation(h);
  });

  it("accepts the exact phrase", async () => {
    const h = harness();
    const res = await handleDeleteAccountRequest(request(), h.deps);
    expect(res.status).toBe(200);
  });
});

describe("deletion target — the authenticated UUID and nothing else", () => {
  it("passes the authenticated id to the admin deletion call", async () => {
    const h = harness();
    await handleDeleteAccountRequest(request(), h.deps);
    expect(h.deleteUserCalls).toEqual([[AUTH_USER, false]]);
  });

  it("uses a hard delete, never a soft delete", async () => {
    const h = harness();
    await handleDeleteAccountRequest(request(), h.deps);
    const [, shouldSoftDelete] = h.deleteUserCalls[0];
    expect(shouldSoftDelete).toBe(false);
  });

  it("ignores a user_id supplied in the request body", async () => {
    const h = harness({
      tree: {
        [AUTH_USER]: [file("mine.pdf")],
        [OTHER_USER]: [file("theirs.pdf")],
      },
    });

    const res = await handleDeleteAccountRequest(
      request({
        body: {
          confirmation: ACCOUNT_DELETION_CONFIRMATION,
          user_id: OTHER_USER,
          userId: OTHER_USER,
          id: OTHER_USER,
        },
      }),
      h.deps,
    );

    expect(res.status).toBe(200);
    expect(h.deleteUserCalls).toEqual([[AUTH_USER, false]]);
    expect(h.removed.flat()).toEqual([`${AUTH_USER}/mine.pdf`]);
    expect(JSON.stringify(h.removed)).not.toContain(OTHER_USER);
  });

  it("ignores a user id supplied in the query string", async () => {
    const h = harness({
      tree: { [AUTH_USER]: [file("mine.pdf")], [OTHER_USER]: [file("theirs.pdf")] },
    });

    const res = await handleDeleteAccountRequest(
      request({ query: `?user_id=${OTHER_USER}&id=${OTHER_USER}` }),
      h.deps,
    );

    expect(res.status).toBe(200);
    expect(h.deleteUserCalls).toEqual([[AUTH_USER, false]]);
    expect(h.listedPaths.every((p) => p === AUTH_USER || p.startsWith(`${AUTH_USER}/`))).toBe(true);
  });

  it("roots Storage cleanup at the same authenticated UUID", async () => {
    const h = harness({
      tree: {
        [AUTH_USER]: [folder("p1")],
        [`${AUTH_USER}/p1`]: [file("a.pdf")],
        [OTHER_USER]: [file("theirs.pdf")],
      },
    });

    await handleDeleteAccountRequest(request(), h.deps);

    const [deletedId] = h.deleteUserCalls[0];
    for (const path of h.removed.flat()) {
      expect(path.startsWith(`${deletedId}/`)).toBe(true);
    }
    expect(h.listedPaths.some((p) => p.includes(OTHER_USER))).toBe(false);
  });

  it("reads attachments from the private bucket", async () => {
    const h = harness();
    await handleDeleteAccountRequest(request(), h.deps);
    expect(h.bucketsUsed).toEqual(["attachments"]);
  });
});

describe("Storage-before-Auth ordering and partial failure", () => {
  it("deletes Storage objects before the Auth user", async () => {
    const order: string[] = [];
    const h = harness({ tree: { [AUTH_USER]: [file("a.pdf")] } });
    const admin = h.deps.createAdminClient()!;
    const deps: DeleteAccountDeps = {
      ...h.deps,
      createAdminClient() {
        return {
          storage: {
            from(bucket) {
              const ns = admin.storage.from(bucket);
              return {
                list: ns.list,
                async remove(paths) {
                  order.push("storage.remove");
                  return ns.remove(paths);
                },
              };
            },
          },
          auth: {
            admin: {
              async deleteUser(id, soft) {
                order.push("auth.deleteUser");
                return admin.auth.admin.deleteUser(id, soft);
              },
            },
          },
        };
      },
    };

    await handleDeleteAccountRequest(request(), deps);
    expect(order).toEqual(["storage.remove", "auth.deleteUser"]);
  });

  it("leaves the Auth user intact when Storage listing fails", async () => {
    const h = harness({ listError: { message: "bucket unavailable" } });
    const res = await handleDeleteAccountRequest(request(), h.deps);

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "storage_cleanup_failed" });
    expect(h.deleteUserCalls).toEqual([]);
  });

  it("leaves the Auth user intact when Storage removal fails", async () => {
    const h = harness({
      tree: { [AUTH_USER]: [file("a.pdf")] },
      removeError: { message: "storage unavailable" },
    });
    const res = await handleDeleteAccountRequest(request(), h.deps);

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "storage_cleanup_failed" });
    expect(h.deleteUserCalls).toEqual([]);
  });

  it("does not report success when Auth deletion fails after a clean Storage pass", async () => {
    const h = harness({
      tree: { [AUTH_USER]: [file("a.pdf")] },
      deleteError: { message: "auth service unavailable" },
    });
    const res = await handleDeleteAccountRequest(request(), h.deps);

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "account_deletion_failed" });
    // Storage cleanup really did run — the operation is left safely retryable.
    expect(h.removed.flat()).toEqual([`${AUTH_USER}/a.pdf`]);
  });

  it("proceeds straight to Auth deletion when the namespace is already empty", async () => {
    // The retry shape: a previous attempt cleaned Storage but failed at Auth.
    const h = harness({ tree: { [AUTH_USER]: [] } });
    const res = await handleDeleteAccountRequest(request(), h.deps);

    expect(res.status).toBe(200);
    expect(h.removed).toEqual([]);
    expect(h.deleteUserCalls).toEqual([[AUTH_USER, false]]);
  });

  it("fails safe when the runtime provides no elevated key", async () => {
    const h = harness({ noAdminClient: true });
    const res = await handleDeleteAccountRequest(request(), h.deps);

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "account_deletion_failed" });
    expectNoMutation(h);
  });

  it("returns a safe failure when an unexpected error escapes", async () => {
    const h = harness();
    const deps: DeleteAccountDeps = {
      ...h.deps,
      createCallerClient() {
        throw new Error("boom: postgres://user:password@host/db");
      },
    };

    const res = await handleDeleteAccountRequest(request(), deps);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "account_deletion_failed", message: GENERIC_FAILURE });
    expectNoMutation(h);
  });
});

describe("response and log safety", () => {
  it("returns only a status on success — no user record, email, or listing", async () => {
    const h = harness({ tree: { [AUTH_USER]: [file("a.pdf")] } });
    const res = await handleDeleteAccountRequest(request(), h.deps);
    const raw = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(raw)).toEqual({ status: "deleted" });
    expect(raw).not.toContain(AUTH_USER);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain("a.pdf");
  });

  it("uses one indistinguishable message for every internal failure", async () => {
    const cases = [
      harness({ listError: { message: "bucket unavailable" } }),
      harness({ tree: { [AUTH_USER]: [file("a.pdf")] }, removeError: { message: "nope" } }),
      harness({ deleteError: { message: "auth down" } }),
      harness({ noAdminClient: true }),
    ];

    for (const h of cases) {
      const res = await handleDeleteAccountRequest(request(), h.deps);
      const body = await res.json();
      expect(body.message).toBe(GENERIC_FAILURE);
      expect(JSON.stringify(body)).not.toMatch(/bucket unavailable|nope|auth down|sb_secret|service_role/);
    }
  });

  it("never logs the bearer token, a key, an object path, or the user id", async () => {
    const h = harness({
      tree: { [AUTH_USER]: [folder("p1")], [`${AUTH_USER}/p1`]: [file("private-scan.pdf")] },
    });

    await handleDeleteAccountRequest(request(), h.deps);

    const everything = [...h.logs, ...h.errors].join("\n");
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(AUTH_USER);
    expect(everything).not.toContain("private-scan.pdf");
    expect(everything).not.toMatch(/Bearer|apikey|service_role|sb_secret/i);
    // It does still carry useful, bounded operational context.
    expect(everything).toContain("storage cleanup removed 1 object(s)");
  });

  it("logs a bounded failure code, not the provider error text", async () => {
    const h = harness({ listError: { message: "SUPER SECRET bucket detail" } });
    await handleDeleteAccountRequest(request(), h.deps);

    const everything = [...h.logs, ...h.errors].join("\n");
    expect(everything).toContain("storage cleanup failed (listing_failed)");
    expect(everything).not.toContain("SUPER SECRET");
  });
});
