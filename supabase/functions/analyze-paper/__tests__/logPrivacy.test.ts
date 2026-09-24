// @vitest-environment node
//
// EDGE-LOG-PRIVACY-HARDENING-001 — analyze-paper may not log arbitrary
// throwable text.
//
// Two layers, because neither alone is enough:
//
//   1. BEHAVIOURAL. The log lines are built by `./logging.ts`, which is shipped
//      code bundled into the deployed function. Each case calls it with a
//      throwable carrying generated content, a malformed answer, a token or a
//      URL, and asserts none of it appears in the line.
//   2. SOURCE GUARD. The behavioural layer proves the formatter is safe; it
//      cannot prove `index.ts` still uses it. The Deno shell cannot be imported
//      here (remote `https://esm.sh/…` imports, `Deno.serve`), so the wiring is
//      pinned by reading the committed source — the repository's existing
//      convention for this file. Supplementary, never a substitute.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BOUNDED_ERROR_NAMES } from "../../_shared/boundedLogging.ts";
import {
  analyzeEnvMissingLog,
  analyzeProviderFailureLog,
  analyzeRequestFailureLog,
  type AnalyzeProviderFailureReason,
} from "../logging.ts";

const SOURCE = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");

/**
 * The shipped source with comments removed — the same view `modelRouting.test.ts`
 * uses, and for the same reason: a comment explaining that a message is no
 * longer logged must not read as evidence that it still is.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

const SECRETS = {
  titleFragment: "Synthetic Sleep and Memory Study",
  abstractFragment: "Sleep deprivation impairs memory consolidation",
  malformedAnswer: '{"tldr": Sleep deprivation impairs',
  bearerToken: "eyJhbGciOiJIUzI1NiJ9.ZmFrZS1wYXlsb2Fk.fake-signature",
  urlWithQuery:
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=SECRET_VALUE",
  apiKey: "SECRET_VALUE",
} as const;

function expectNoContent(line: string): void {
  for (const [label, secret] of Object.entries(SECRETS)) {
    expect(line, `leaked ${label}`).not.toContain(secret);
  }
}

describe("analyze-paper log lines carry no throwable text", () => {
  it("reduces every content-bearing throwable to an allow-listed name", () => {
    const throwables: unknown[] = [
      new Error(SECRETS.abstractFragment),
      new SyntaxError(`Unexpected token 'S', "${SECRETS.malformedAnswer}"... is not valid JSON`),
      new TypeError(`error sending request for url (${SECRETS.urlWithQuery})`),
      new Error(`Authorization: Bearer ${SECRETS.bearerToken}`),
      new Error("wrapped", { cause: new Error(SECRETS.titleFragment) }),
      SECRETS.abstractFragment,
      { name: "TimeoutError", message: SECRETS.urlWithQuery },
    ];
    for (const throwable of throwables) {
      const line = analyzeRequestFailureLog(throwable);
      expectNoContent(line);
      expect(line).toMatch(/^analyze-paper request_failed error=[A-Za-z_]+$/);
      expect(BOUNDED_ERROR_NAMES).toContain(line.split("error=")[1]);
    }
  });

  it("reduces a REAL V8 parse failure of a generated answer", () => {
    // The exact mechanism the old `gemini_parse_failed: <message>` throw
    // carried into the provider-failure log.
    const malformed = `{"tldr": ${SECRETS.abstractFragment}}`;
    let caught: unknown;
    try {
      JSON.parse(malformed);
    } catch (error) {
      caught = error;
    }
    // V8 quotes a ~20-character window of the input, so the message carries a
    // fragment of the generated answer.
    expect((caught as Error).message).toContain(malformed.slice(0, 12));
    expectNoContent(analyzeRequestFailureLog(caught));
  });

  it("builds the provider-failure line from bounded parts only", () => {
    const reasons: AnalyzeProviderFailureReason[] = [
      "provider_http_429",
      "provider_http_503",
      "provider_http_unknown",
      "provider_network",
      "provider_timeout",
      "provider_unreadable_response",
      "provider_incomplete_response",
      "provider_empty_response",
      "provider_no_json",
      "provider_json_parse_failed",
      "provider_unknown",
    ];
    for (const reason of reasons) {
      const line = analyzeProviderFailureLog("provider_unavailable", reason);
      expect(line).toBe(`analyze-paper provider_failure class=provider_unavailable reason=${reason}`);
      expectNoContent(line);
      // No free text can reach the line: it is label + class + one literal.
      expect(line.split(" ")).toHaveLength(4);
    }
  });

  it("stays total when the throwable's `name` getter throws", () => {
    // EDGE-LOG-PRIVACY-HARDENING-001A. Reading `.name` runs code, so a hostile
    // throwable could make the reducer throw — inside the outer catch, which
    // would abandon this log line and propagate the getter's own message.
    // Asserted here, at the shipped formatter, not only on the helper.
    const hostile = {};
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error(`${SECRETS.urlWithQuery} ${SECRETS.abstractFragment}`);
      },
    });

    expect(() => analyzeRequestFailureLog(hostile)).not.toThrow();
    const line = analyzeRequestFailureLog(hostile);
    expect(line).toBe("analyze-paper request_failed error=unknown_error_name");
    expectNoContent(line);
  });

  it("stays total when a Proxy trap throws on every read", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(SECRETS.bearerToken);
        },
      },
    );
    expect(() => analyzeRequestFailureLog(hostile)).not.toThrow();
    expect(analyzeRequestFailureLog(hostile)).toBe(
      "analyze-paper request_failed error=unknown_error_name",
    );
  });

  it("names a missing variable without quoting the thrown message", () => {
    expect(analyzeEnvMissingLog("SUPABASE_URL")).toBe("analyze-paper env_missing env=SUPABASE_URL");
    expect(analyzeEnvMissingLog("SUPABASE_ANON_KEY")).toBe(
      "analyze-paper env_missing env=SUPABASE_ANON_KEY",
    );
  });
});

describe("analyze-paper source keeps the boundary wired (guard)", () => {
  it("passes no `.message` to any logger call", () => {
    const offenders = CODE.split("\n").filter(
      (line) => /console\.(log|warn|error)\(/.test(line) && /\.message/.test(line),
    );
    expect(offenders).toEqual([]);
  });

  it("never stringifies a throwable anywhere", () => {
    expect(CODE).not.toMatch(/String\(\s*(err|error|refundErr|parseErr|geminiErr)\b/);
    expect(CODE).not.toMatch(/JSON\.stringify\(\s*(err|error)\b/);
    expect(CODE).not.toMatch(/\.stack\b/);
    // `cause` is never read; the formatter does not look at it either.
    expect(CODE).not.toMatch(/\bcause\b/);
  });

  it("routes both failure logs through the tested formatters", () => {
    expect(CODE).toContain("console.error(analyzeProviderFailureLog(providerErrorClass, failureReason));");
    expect(CODE).toContain("console.error(analyzeRequestFailureLog(err));");
    expect(CODE).toContain('from "./logging.ts"');
  });

  it("discards the JSON parse exception rather than binding it", () => {
    // `catch {` with no binding is the structural version of "this value is
    // not used": re-introducing `catch (parseErr)` to log it would fail the
    // `.message` guard above, and this pins the shape that makes that hard.
    const parseBlock = CODE.slice(CODE.indexOf("parsed = JSON.parse(cleanText);"));
    expect(parseBlock).toContain("} catch {");
    expect(parseBlock.slice(0, 400)).toContain('failureReason = "provider_json_parse_failed"');
    expect(CODE).not.toContain("gemini_parse_failed");
  });

  it("binds no throwable in the provider-failure catch", () => {
    expect(CODE).not.toContain("} catch (geminiErr) {");
    expect(CODE).toMatch(/}\s*catch\s*{\s*\n[\s\S]{0,200}if \(!classified\)/);
  });

  it("keeps the quota RPC failures bounded too", () => {
    // Since C47 the refund's bounded failure lines are written by the shared
    // server-only refund module under this function's label — the same module
    // and spelling `suggest-paper-organization` uses — and the executed suite
    // `quotaRefundAuthority.test.ts` asserts the exact lines this function emits.
    expect(CODE).toContain("await refundAiQuotaUnit(userId, {");
    expect(CODE).toContain('label: "analyze-paper",');
    expect(CODE).toContain("logger: console,");
    expect(CODE).not.toMatch(/refund_failed/);
    expect(CODE).toContain('console.error("3c. analyze-paper quota_rpc_error");');
  });

  it("still names the missing credential variable, and never its value", () => {
    expect(CODE).toContain("console.error(`analyze-paper provider_key_missing env=${credential.envName}`);");
    expect(CODE).not.toMatch(/credential\.apiKey[\s\S]{0,40}console\./);
  });

  it("logs no provider-specific label for a failure any provider can produce", () => {
    // AI-MULTI-PROVIDER-001C registered three providers; a Claude or OpenAI
    // failure must not be reported as a Gemini one. Checked on the log and
    // throw strings this task hardened, not on the whole file.
    const loggedOrThrown = CODE.split("\n").filter(
      (line) => /console\.(log|warn|error)\(|throw new Error\(|failureReason =/.test(line),
    );
    for (const line of loggedOrThrown) {
      expect(line.toLowerCase(), `provider-specific label: ${line.trim()}`).not.toMatch(/gemini|google/);
    }
  });
});
