import { describe, it, expect, vi } from "vitest";
import {
  ACCOUNT_DELETION_CONFIRMATION,
  ATTACHMENTS_BUCKET,
  checkDeletionConfirmation,
  chunkPaths,
  collectUserStorageObjects,
  deleteUserStorageObjects,
  selectEdgeSecretKey,
  STORAGE_LIST_PAGE_SIZE,
  STORAGE_REMOVE_BATCH_SIZE,
  StorageCleanupError,
  userStoragePrefix,
  type StorageListEntry,
  type StorageNamespaceClient,
} from "../accountDeletion.ts";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

/** A file entry as Storage returns it (real object → non-null id). */
function file(name: string): StorageListEntry {
  return { name, id: `obj-${name}` };
}
/** A prefix entry as Storage returns it (folder → null id). */
function folder(name: string): StorageListEntry {
  return { name, id: null };
}

/**
 * In-memory Storage double built from a flat map of `listPath → entries`,
 * paginated exactly the way the real API is: `limit`/`offset` over the entries
 * for that path.
 */
function fakeStorage(tree: Record<string, StorageListEntry[]>) {
  const removed: string[][] = [];
  const listCalls: Array<{ path: string; offset: number; limit: number }> = [];
  const client: StorageNamespaceClient = {
    async list(prefix, { limit, offset }) {
      listCalls.push({ path: prefix, offset, limit });
      const entries = tree[prefix] ?? [];
      return { data: entries.slice(offset, offset + limit), error: null };
    },
    async remove(paths) {
      removed.push([...paths]);
      return { data: paths.map((p) => ({ name: p })), error: null };
    },
  };
  return { client, removed, listCalls };
}

describe("confirmation contract (server-enforced)", () => {
  it("pins the exact phrase", () => {
    expect(ACCOUNT_DELETION_CONFIRMATION).toBe("DELETE MY ACCOUNT");
  });

  it("accepts exactly the confirmation phrase", () => {
    expect(checkDeletionConfirmation({ confirmation: "DELETE MY ACCOUNT" })).toEqual({ ok: true });
  });

  it.each([
    ["a missing body", null],
    ["undefined", undefined],
    ["an array body", [{ confirmation: "DELETE MY ACCOUNT" }]],
    ["a string body", "DELETE MY ACCOUNT"],
    ["a number body", 7],
  ])("rejects %s", (_label, body) => {
    const result = checkDeletionConfirmation(body);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "malformed_body" });
  });

  it("rejects a body with no confirmation field", () => {
    expect(checkDeletionConfirmation({})).toEqual({
      ok: false,
      reason: "missing_confirmation",
    });
  });

  it("rejects a boolean flag as the destructive proof", () => {
    expect(checkDeletionConfirmation({ confirmed: true }).ok).toBe(false);
    expect(checkDeletionConfirmation({ confirmation: true }).ok).toBe(false);
  });

  it.each([
    "DELETE",
    "delete my account",
    "Delete My Account",
    "DELETE MY ACCOUNT ",
    " DELETE MY ACCOUNT",
    "DELETE  MY ACCOUNT",
    "DELETE MY ACCOUNT!",
    "",
  ])("rejects the near-miss phrase %j", (phrase) => {
    expect(checkDeletionConfirmation({ confirmation: phrase }).ok).toBe(false);
  });

  it("ignores every other field, including a user id", () => {
    // A supplied user_id must not make the request invalid *or* meaningful —
    // it is simply not part of the contract.
    expect(
      checkDeletionConfirmation({
        confirmation: ACCOUNT_DELETION_CONFIRMATION,
        user_id: USER_B,
        userId: USER_B,
      }),
    ).toEqual({ ok: true });
  });
});

describe("userStoragePrefix", () => {
  it("scopes to the user's own namespace with an explicit separator", () => {
    expect(userStoragePrefix(USER_A)).toBe(`${USER_A}/`);
  });

  it.each([
    ["blank", ""],
    ["whitespace-padded", ` ${USER_A} `],
    ["a path fragment", `${USER_A}/../${USER_B}`],
    ["a wildcard", "*"],
    ["a non-UUID", "not-a-uuid"],
    ["a UUID prefix only", USER_A.slice(0, 8)],
  ])("refuses %s user ids", (_label, value) => {
    expect(() => userStoragePrefix(value)).toThrow(StorageCleanupError);
  });
});

describe("collectUserStorageObjects — enumeration", () => {
  it("returns nothing for an empty namespace", async () => {
    const { client } = fakeStorage({ [USER_A]: [] });
    await expect(collectUserStorageObjects(client, USER_A)).resolves.toEqual([]);
  });

  it("finds a single object", async () => {
    const { client } = fakeStorage({
      [USER_A]: [folder("paper-1")],
      [`${USER_A}/paper-1`]: [file("scan.pdf")],
    });
    await expect(collectUserStorageObjects(client, USER_A)).resolves.toEqual([
      `${USER_A}/paper-1/scan.pdf`,
    ]);
  });

  it("walks many paper directories and many files per directory", async () => {
    const { client } = fakeStorage({
      [USER_A]: [folder("p1"), folder("p2"), folder("p3")],
      [`${USER_A}/p1`]: [file("a.pdf"), file("b.pdf")],
      [`${USER_A}/p2`]: [file("c.png")],
      [`${USER_A}/p3`]: [file("d.pdf"), file("e.pdf"), file("f.pdf")],
    });
    const paths = await collectUserStorageObjects(client, USER_A);
    expect(paths).toHaveLength(6);
    expect(paths).toContain(`${USER_A}/p1/b.pdf`);
    expect(paths).toContain(`${USER_A}/p3/f.pdf`);
  });

  it("paginates past a full page rather than trusting one response", async () => {
    // One directory holding more than a single list page.
    const many = Array.from({ length: STORAGE_LIST_PAGE_SIZE * 2 + 7 }, (_, i) =>
      file(`f${String(i).padStart(4, "0")}.pdf`),
    );
    const { client, listCalls } = fakeStorage({
      [USER_A]: [folder("bulk")],
      [`${USER_A}/bulk`]: many,
    });

    const paths = await collectUserStorageObjects(client, USER_A);

    expect(paths).toHaveLength(many.length);
    // Three pages for the directory (100 + 100 + 7), each with a distinct offset.
    const bulkCalls = listCalls.filter((c) => c.path === `${USER_A}/bulk`);
    expect(bulkCalls.map((c) => c.offset)).toEqual([0, STORAGE_LIST_PAGE_SIZE, STORAGE_LIST_PAGE_SIZE * 2]);
  });

  it("discovers an orphan object that has no paper_attachments row", async () => {
    // The helper never reads metadata — everything it deletes comes from
    // Storage itself, so an orphan is indistinguishable from a tracked file.
    const { client } = fakeStorage({
      [USER_A]: [folder("orphaned-paper"), file("stray-at-root.pdf")],
      [`${USER_A}/orphaned-paper`]: [file("leftover.pdf")],
    });
    const paths = await collectUserStorageObjects(client, USER_A);
    expect(paths).toEqual(
      expect.arrayContaining([
        `${USER_A}/stray-at-root.pdf`,
        `${USER_A}/orphaned-paper/leftover.pdf`,
      ]),
    );
  });

  it("collects identical file names living under different papers", async () => {
    const { client } = fakeStorage({
      [USER_A]: [folder("p1"), folder("p2")],
      [`${USER_A}/p1`]: [file("report.pdf")],
      [`${USER_A}/p2`]: [file("report.pdf")],
    });
    await expect(collectUserStorageObjects(client, USER_A)).resolves.toEqual([
      `${USER_A}/p1/report.pdf`,
      `${USER_A}/p2/report.pdf`,
    ]);
  });

  it("de-duplicates a path repeated across shifting pages", async () => {
    let call = 0;
    const client: StorageNamespaceClient = {
      async list(_prefix, { limit }) {
        call += 1;
        if (call === 1) {
          return { data: Array.from({ length: limit }, () => file("same.pdf")), error: null };
        }
        return { data: [file("same.pdf")], error: null };
      },
      async remove() {
        return { data: [], error: null };
      },
    };
    await expect(collectUserStorageObjects(client, USER_A)).resolves.toEqual([
      `${USER_A}/same.pdf`,
    ]);
  });

  it.each([
    ["an entry with no name", { id: "x" }],
    ["an entry whose name is not a string", { name: 42, id: "x" }],
    ["an entry with an empty name", { name: "", id: "x" }],
    ["an entry whose name embeds a separator", { name: "a/b", id: "x" }],
    ["a parent-traversal name", { name: "..", id: "x" }],
    ["a null entry", null],
    ["a primitive entry", "surprise"],
  ])("aborts on %s rather than guessing", async (_label, entry) => {
    const { client } = fakeStorage({ [USER_A]: [entry as StorageListEntry] });
    await expect(collectUserStorageObjects(client, USER_A)).rejects.toMatchObject({
      code: "malformed_listing",
    });
  });

  it("aborts on a non-array listing payload", async () => {
    const client: StorageNamespaceClient = {
      async list() {
        return { data: { nope: true } as unknown as StorageListEntry[], error: null };
      },
      async remove() {
        return { data: [], error: null };
      },
    };
    await expect(collectUserStorageObjects(client, USER_A)).rejects.toMatchObject({
      code: "malformed_listing",
    });
  });

  it("aborts when the namespace nests deeper than the supported bound", async () => {
    // Every level reports exactly one folder, so the walk never terminates
    // naturally — the depth bound must stop it.
    const client: StorageNamespaceClient = {
      async list(_prefix, { offset }) {
        return { data: offset === 0 ? [folder("deeper")] : [], error: null };
      },
      async remove() {
        return { data: [], error: null };
      },
    };
    await expect(collectUserStorageObjects(client, USER_A)).rejects.toMatchObject({
      code: "listing_too_deep",
    });
  });

  it("surfaces a listing failure as a distinct code", async () => {
    const client: StorageNamespaceClient = {
      async list() {
        return { data: null, error: { message: "bucket unavailable" } };
      },
      async remove() {
        return { data: [], error: null };
      },
    };
    await expect(collectUserStorageObjects(client, USER_A)).rejects.toMatchObject({
      code: "listing_failed",
    });
  });

  it("only ever lists inside the caller's own namespace", async () => {
    const { client, listCalls } = fakeStorage({
      [USER_A]: [folder("p1")],
      [`${USER_A}/p1`]: [file("x.pdf")],
      // Present in the bucket but belonging to someone else.
      [USER_B]: [file("secret.pdf")],
    });
    await collectUserStorageObjects(client, USER_A);
    expect(listCalls.length).toBeGreaterThan(0);
    for (const call of listCalls) {
      expect(call.path === USER_A || call.path.startsWith(`${USER_A}/`)).toBe(true);
    }
    expect(listCalls.some((c) => c.path.includes(USER_B))).toBe(false);
  });
});

describe("chunkPaths", () => {
  it("returns no batches for no paths", () => {
    expect(chunkPaths([])).toEqual([]);
  });

  it("batches at the documented Storage remove limit", () => {
    expect(STORAGE_REMOVE_BATCH_SIZE).toBe(1000);
    const paths = Array.from({ length: 2500 }, (_, i) => `${USER_A}/p/${i}.pdf`);
    const batches = chunkPaths(paths);
    expect(batches.map((b) => b.length)).toEqual([1000, 1000, 500]);
    expect(batches.flat()).toEqual(paths);
  });

  it("refuses a nonsensical batch size", () => {
    expect(() => chunkPaths([`${USER_A}/a`], 0)).toThrow(StorageCleanupError);
  });
});

describe("deleteUserStorageObjects", () => {
  it("performs no remove call for an empty namespace", async () => {
    const { client, removed } = fakeStorage({ [USER_A]: [] });
    await expect(deleteUserStorageObjects(client, USER_A)).resolves.toBe(0);
    expect(removed).toEqual([]);
  });

  it("removes every discovered object exactly once", async () => {
    const { client, removed } = fakeStorage({
      [USER_A]: [folder("p1"), file("root.pdf")],
      [`${USER_A}/p1`]: [file("a.pdf"), file("b.pdf")],
    });
    await expect(deleteUserStorageObjects(client, USER_A)).resolves.toBe(3);
    expect(removed).toHaveLength(1);
    expect(removed[0].sort()).toEqual(
      [`${USER_A}/p1/a.pdf`, `${USER_A}/p1/b.pdf`, `${USER_A}/root.pdf`].sort(),
    );
  });

  it("issues more than one remove batch above the limit", async () => {
    const many = Array.from({ length: 1200 }, (_, i) => file(`f${String(i).padStart(4, "0")}.pdf`));
    const { client, removed } = fakeStorage({
      [USER_A]: [folder("bulk")],
      [`${USER_A}/bulk`]: many,
    });
    await expect(deleteUserStorageObjects(client, USER_A)).resolves.toBe(1200);
    expect(removed.map((b) => b.length)).toEqual([1000, 200]);
  });

  it("never hands another user's prefix to remove()", async () => {
    const { client, removed } = fakeStorage({
      [USER_A]: [folder("p1")],
      [`${USER_A}/p1`]: [file("mine.pdf")],
      [USER_B]: [file("theirs.pdf")],
      [`${USER_B}/p9`]: [file("also-theirs.pdf")],
    });

    await deleteUserStorageObjects(client, USER_A);

    const everyPath = removed.flat();
    expect(everyPath).toEqual([`${USER_A}/p1/mine.pdf`]);
    for (const path of everyPath) {
      expect(path.startsWith(`${USER_A}/`)).toBe(true);
      expect(path).not.toContain(USER_B);
    }
  });

  it("refuses to remove a path that escaped the namespace", async () => {
    // A hostile listing that tries to smuggle a sibling namespace back in.
    const client: StorageNamespaceClient = {
      async list(_prefix, { offset }) {
        return { data: offset === 0 ? [{ name: `../${USER_B}`, id: "x" }] : [], error: null };
      },
      async remove() {
        throw new Error("remove must never be reached");
      },
    };
    await expect(deleteUserStorageObjects(client, USER_A)).rejects.toMatchObject({
      code: "malformed_listing",
    });
  });

  it("propagates a remove failure without swallowing it", async () => {
    const client: StorageNamespaceClient = {
      async list(_prefix, { offset }) {
        return { data: offset === 0 ? [file("a.pdf")] : [], error: null };
      },
      async remove() {
        return { data: null, error: { message: "storage unavailable" } };
      },
    };
    await expect(deleteUserStorageObjects(client, USER_A)).rejects.toMatchObject({
      code: "remove_failed",
    });
  });

  it("is safe to retry once the namespace is already empty", async () => {
    const tree: Record<string, StorageListEntry[]> = {
      [USER_A]: [folder("p1")],
      [`${USER_A}/p1`]: [file("a.pdf")],
    };
    const { client, removed } = fakeStorage(tree);
    await deleteUserStorageObjects(client, USER_A);

    // Second invocation after the objects are gone: no error, no remove call.
    tree[`${USER_A}/p1`] = [];
    tree[USER_A] = [];
    await expect(deleteUserStorageObjects(client, USER_A)).resolves.toBe(0);
    expect(removed).toHaveLength(1);
  });

  it("targets the private attachments bucket", () => {
    expect(ATTACHMENTS_BUCKET).toBe("attachments");
  });
});

describe("selectEdgeSecretKey", () => {
  it("prefers the current secret-key mechanism", () => {
    expect(
      selectEdgeSecretKey(JSON.stringify({ default: "sb_secret_new" }), "legacy_service_role"),
    ).toBe("sb_secret_new");
  });

  it("reads the default-named key when several exist", () => {
    expect(
      selectEdgeSecretKey(
        JSON.stringify({ billing: "sb_secret_billing", default: "sb_secret_default" }),
        null,
      ),
    ).toBe("sb_secret_default");
  });

  it("falls back to the legacy auto-provided service-role key", () => {
    expect(selectEdgeSecretKey(undefined, "legacy_service_role")).toBe("legacy_service_role");
    expect(selectEdgeSecretKey("", "legacy_service_role")).toBe("legacy_service_role");
  });

  it.each([
    ["unparseable JSON", "{not json"],
    ["a JSON array", "[]"],
    ["a JSON string", '"sb_secret_x"'],
    ["an object without a default key", JSON.stringify({ other: "sb_secret_x" })],
    ["a default key that is blank", JSON.stringify({ default: "  " })],
  ])("falls back when the secret-key dictionary is %s", (_label, raw) => {
    expect(selectEdgeSecretKey(raw, "legacy_service_role")).toBe("legacy_service_role");
  });

  it("returns null when the runtime provided no elevated key at all", () => {
    expect(selectEdgeSecretKey(undefined, undefined)).toBeNull();
    expect(selectEdgeSecretKey(null, "")).toBeNull();
  });

  it("never throws on a malformed value, so nothing secret-bearing is echoed", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => selectEdgeSecretKey("{sb_secret_leaky", null)).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
