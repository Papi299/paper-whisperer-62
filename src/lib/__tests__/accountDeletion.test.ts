import { describe, it, expect } from "vitest";
import {
  ACCOUNT_DELETION_CONFIRMATION,
  accountDeletionMessage,
  DELETE_ACCOUNT_FUNCTION,
  GENERIC_DELETION_FAILURE,
  isDeletionConfirmed,
  POST_DELETION_PATH,
  readDeletionErrorCode,
} from "../accountDeletion";

describe("confirmation phrase (client copy)", () => {
  it("pins the same literal the Edge Function enforces", () => {
    // The deployed function and the bundled app are separate runtime domains,
    // so each holds its own constant. Both suites pin this exact literal; if
    // one side changes, the other's assertion fails.
    expect(ACCOUNT_DELETION_CONFIRMATION).toBe("DELETE MY ACCOUNT");
  });

  it("accepts only an exact match", () => {
    expect(isDeletionConfirmed("DELETE MY ACCOUNT")).toBe(true);
  });

  it.each([
    "",
    "DELETE",
    "delete my account",
    "Delete My Account",
    " DELETE MY ACCOUNT",
    "DELETE MY ACCOUNT ",
    "DELETE  MY ACCOUNT",
    "DELETE MY ACCOUNT!",
  ])("refuses the near miss %j", (value) => {
    expect(isDeletionConfirmed(value)).toBe(false);
  });
});

describe("invocation target", () => {
  it("names the dedicated Edge Function", () => {
    expect(DELETE_ACCOUNT_FUNCTION).toBe("delete-account");
  });

  it("returns a deleted user to the auth route", () => {
    expect(POST_DELETION_PATH).toBe("/auth");
  });
});

describe("accountDeletionMessage", () => {
  it("gives an actionable message for an expired session", () => {
    expect(accountDeletionMessage("unauthenticated")).toMatch(/sign in again/i);
  });

  it("gives an actionable message for a rejected confirmation", () => {
    expect(accountDeletionMessage("invalid_confirmation")).toMatch(/confirmation phrase/i);
  });

  it.each([
    "storage_cleanup_failed",
    "account_deletion_failed",
    "method_not_allowed",
    "some_unknown_future_code",
    null,
    undefined,
    42,
    { error: "nested" },
  ])("collapses %j to the generic message", (code) => {
    expect(accountDeletionMessage(code)).toBe(GENERIC_DELETION_FAILURE);
  });

  it("never surfaces raw backend detail", () => {
    const message = accountDeletionMessage(
      'permission denied for relation papers; apikey=sb_secret_leak',
    );
    expect(message).toBe(GENERIC_DELETION_FAILURE);
    expect(message).not.toContain("sb_secret");
    expect(message).not.toContain("permission denied");
  });
});

describe("readDeletionErrorCode", () => {
  it("reads the stable code from a FunctionsHttpError response", async () => {
    const error = {
      context: new Response(JSON.stringify({ error: "storage_cleanup_failed", message: "x" }), {
        status: 500,
      }),
    };
    await expect(readDeletionErrorCode(error)).resolves.toBe("storage_cleanup_failed");
  });

  it.each([
    ["no context", {}],
    ["a null error", null],
    ["a plain Error", new Error("network down")],
    ["a non-Response context", { context: { status: 500 } }],
  ])("returns null for %s", async (_label, error) => {
    await expect(readDeletionErrorCode(error)).resolves.toBeNull();
  });

  it("returns null when the body is not JSON", async () => {
    const error = { context: new Response("<html>gateway error</html>", { status: 502 }) };
    await expect(readDeletionErrorCode(error)).resolves.toBeNull();
  });

  it("returns null when the body carries no string code", async () => {
    const error = { context: new Response(JSON.stringify({ error: { nested: true } })) };
    await expect(readDeletionErrorCode(error)).resolves.toBeNull();
  });
});
