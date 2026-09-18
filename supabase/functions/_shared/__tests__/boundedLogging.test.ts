// @vitest-environment node
//
// EDGE-LOG-PRIVACY-HARDENING-001 — the shared throwable→log boundary.
//
// These are behavioural tests of shipped code, not source assertions: every
// case feeds `boundedErrorName` a throwable carrying exactly the material the
// hardening exists to keep out of Edge logs, and asserts the returned value
// contains none of it.
//
// Node, not jsdom: these suites read committed source files and exercise
// platform APIs (`AbortSignal`, real `JSON.parse` messages) that jsdom
// substitutes or lacks.
import { describe, it, expect } from "vitest";
import {
  BOUNDED_ERROR_NAMES,
  boundedErrorName,
  type BoundedErrorName,
} from "../boundedLogging.ts";

/**
 * Content that must never reach a log. Each string stands for one of the
 * real leak mechanisms named in the module's own documentation.
 */
const SECRETS = {
  titleFragment: "Synthetic Sleep and Memory Study",
  abstractFragment: "Sleep deprivation impairs memory consolidation",
  bearerToken: "eyJhbGciOiJIUzI1NiJ9.ZmFrZS1wYXlsb2Fk.fake-signature",
  apiKeyUrl:
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=12345678&api_key=SECRET_VALUE",
  apiKey: "SECRET_VALUE",
  doiUrl: "https://api.crossref.org/works/10.1000%2Fxyz123",
  doi: "10.1000/xyz123",
} as const;

function expectNoContent(line: string): void {
  for (const [label, secret] of Object.entries(SECRETS)) {
    expect(line, `leaked ${label}`).not.toContain(secret);
  }
}

describe("boundedErrorName returns only allow-listed literals", () => {
  it("never returns anything outside the frozen list", () => {
    const inputs: unknown[] = [
      new Error(SECRETS.abstractFragment),
      new TypeError(SECRETS.apiKeyUrl),
      new SyntaxError(SECRETS.titleFragment),
      new RangeError(SECRETS.bearerToken),
      { name: "TimeoutError", message: SECRETS.doiUrl },
      { name: SECRETS.titleFragment, message: SECRETS.abstractFragment },
      SECRETS.apiKeyUrl,
      42,
      null,
      undefined,
      Symbol("x"),
      [SECRETS.doi],
      () => SECRETS.apiKey,
    ];
    for (const input of inputs) {
      const name: BoundedErrorName = boundedErrorName(input);
      expect(BOUNDED_ERROR_NAMES).toContain(name);
      expectNoContent(name);
    }
  });

  it("drops a message that quotes a paper's content", () => {
    expect(boundedErrorName(new Error(SECRETS.abstractFragment))).toBe("Error");
  });

  it("drops a fetch error that embeds the URL, its query and the API key", () => {
    // The shape a runtime `fetch` failure takes: the URL is inside the message.
    const error = new TypeError(`error sending request for url (${SECRETS.apiKeyUrl})`);
    const name = boundedErrorName(error);
    expect(name).toBe("TypeError");
    expectNoContent(name);
  });

  it("drops a REAL V8 JSON.parse message, which quotes the input", () => {
    // Not a hand-written imitation: this is the actual mechanism. The
    // assertion on `caught.message` documents why logging it was unsafe.
    const malformed = `{"tldr": ${SECRETS.abstractFragment}}`;
    let caught: unknown;
    try {
      JSON.parse(malformed);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SyntaxError);
    // V8 quotes a ~20-character window of the input it choked on, so the
    // message carries a fragment of the paper's own text. Asserted against a
    // slice of the input rather than a hand-copied literal, so this stays true
    // if the window size changes.
    expect((caught as Error).message).toContain(malformed.slice(0, 12));
    const name = boundedErrorName(caught);
    expect(name).toBe("SyntaxError");
    expectNoContent(name);
  });

  it("never reads `cause`, where a wrapped error hides its content", () => {
    const inner = new TypeError(`error sending request for url (${SECRETS.apiKeyUrl})`);
    const outer = new Error("fetch failed", { cause: inner });
    expectNoContent(boundedErrorName(outer));
  });

  it("never reads `stack`", () => {
    const error = new Error("boom");
    Object.defineProperty(error, "stack", { value: `at ${SECRETS.titleFragment}` });
    expectNoContent(boundedErrorName(error));
  });

  it("collapses a hostile or unknown `name` instead of echoing it", () => {
    expect(boundedErrorName({ name: SECRETS.apiKeyUrl })).toBe("unknown_error_name");
    expect(boundedErrorName({ name: "SomeLibraryError" })).toBe("unknown_error_name");
    expect(boundedErrorName({ name: 12345 })).toBe("unknown_error_name");
  });

  it("names a thrown non-object without stringifying it", () => {
    expect(boundedErrorName(SECRETS.apiKeyUrl)).toBe("non_error");
    expect(boundedErrorName(null)).toBe("non_error");
    expect(boundedErrorName(undefined)).toBe("non_error");
  });

  it("keeps the diagnostic distinctions that make the log useful", () => {
    // The point of an allowlist rather than a constant: these still differ.
    expect(boundedErrorName(new SyntaxError("x"))).toBe("SyntaxError");
    expect(boundedErrorName(new TypeError("x"))).toBe("TypeError");
    expect(boundedErrorName({ name: "TimeoutError" })).toBe("TimeoutError");
    expect(boundedErrorName({ name: "AbortError" })).toBe("AbortError");
  });

  it("survives a value thrown across a realm boundary", () => {
    // `instanceof Error` is false here; the structural read still names it.
    const crossRealm = Object.assign(Object.create(null), {
      name: "TypeError",
      message: SECRETS.apiKeyUrl,
    });
    expect(boundedErrorName(crossRealm)).toBe("TypeError");
  });

  it("exposes a frozen list, so a widening cannot happen by mutation", () => {
    expect(Object.isFrozen(BOUNDED_ERROR_NAMES)).toBe(true);
  });
});

describe("the reducer is total: reading `name` is itself executable code", () => {
  // EDGE-LOG-PRIVACY-HARDENING-001A, from independent review of PR #288.
  //
  // `(error as {name?: unknown}).name` is a property ACCESS, and a property
  // access can run code: a getter or a Proxy `get` trap may throw. A throwable
  // that makes the logging reducer throw defeats the whole point of a
  // content-free failure path — the secondary exception escapes the catch block
  // that was trying to log safely, and carries its own message with it.
  //
  // These cases are the hostile inputs, not hypotheticals: each one throws an
  // Error whose message is exactly the material that must never be logged.

  it("does not throw, and leaks nothing, when the `name` getter throws", () => {
    const hostile = {};
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error(`${SECRETS.apiKeyUrl} ${SECRETS.abstractFragment}`);
      },
    });

    expect(() => boundedErrorName(hostile)).not.toThrow();
    const name = boundedErrorName(hostile);
    expect(name).toBe("unknown_error_name");
    expectNoContent(name);
  });

  it("does not throw, and leaks nothing, when a Proxy `get` trap throws", () => {
    const hostile = new Proxy(
      {},
      {
        get(_target, property) {
          throw new Error(`proxy trap read ${String(property)}: ${SECRETS.apiKeyUrl}`);
        },
      },
    );

    expect(() => boundedErrorName(hostile)).not.toThrow();
    const name = boundedErrorName(hostile);
    expect(name).toBe("unknown_error_name");
    expectNoContent(name);
  });

  it("survives a getter that throws a non-Error value", () => {
    const hostile = {};
    Object.defineProperty(hostile, "name", {
      get() {
        throw SECRETS.bearerToken;
      },
    });
    expect(() => boundedErrorName(hostile)).not.toThrow();
    expectNoContent(boundedErrorName(hostile));
  });

  it("still reads a well-behaved getter that returns an allow-listed name", () => {
    // The guard must not degrade the ordinary case into `unknown_error_name`:
    // a real `DOMException` exposes `name` as a prototype getter.
    const wellBehaved = {};
    Object.defineProperty(wellBehaved, "name", { get: () => "TimeoutError" });
    expect(boundedErrorName(wellBehaved)).toBe("TimeoutError");
  });

  it("is total across a hostile corpus — never throws, always an allow-listed literal", () => {
    const throwingGetter = {};
    Object.defineProperty(throwingGetter, "name", {
      get() {
        throw new Error(SECRETS.titleFragment);
      },
    });
    const corpus: unknown[] = [
      throwingGetter,
      new Proxy({}, { get() { throw new Error(SECRETS.doiUrl); } }),
      new Proxy({}, { get: () => SECRETS.apiKeyUrl }),
      Object.create(null),
      new Error(SECRETS.abstractFragment),
      SECRETS.apiKey,
      0,
      false,
      null,
      undefined,
    ];
    for (const value of corpus) {
      let result: string | undefined;
      expect(() => {
        result = boundedErrorName(value);
      }).not.toThrow();
      expect(BOUNDED_ERROR_NAMES).toContain(result);
      expectNoContent(String(result));
    }
  });
});
