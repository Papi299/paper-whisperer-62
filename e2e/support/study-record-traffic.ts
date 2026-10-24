/**
 * What a Study Record spec allows on the network while it watches the dialog
 * (CI-E2E-EVIDENCE-WATCH-001). Pure, shared by `e2e/study-records.spec.ts` and
 * `e2e/study-records-review.spec.ts`, and unit-tested without a browser in
 * `study-record-traffic.test.ts`.
 *
 * A watch opens right after a sign-in or a reload, so the dashboard's own
 * startup reads can land in it. They leave once per startup, within a few
 * milliseconds of each other, and locally always before the paper count shows;
 * on a loaded CI runner the count can render — and `waitForDashboard()`
 * return — before the last of them reaches the test. The review spec's R1
 * failed that way (Actions run 40123527645, attempt 1: `rpc
 * get_keyword_options`, `rpc get_ai_quota_status`). Whether a read lands in the
 * window is timing, and the app has no "startup finished" state to wait for;
 * what the read is does not change. So the classification makes room for them,
 * not the window: the three read-only RPCs the dashboard sends unprompted, by
 * exact name, and only with the arguments their audited definitions take.
 *
 * Everything refused before is still refused: an Edge Function call, a direct
 * table write (anything but GET, HEAD or OPTIONS under /rest/v1/), and any RPC
 * that is neither one of the spec's own study-record RPCs nor an audited read.
 * Auth and Storage requests are outside the watch, as they were.
 */

/** The part of a Playwright `Request` the watch reads. */
export interface WatchedRequest {
  method(): string;
  url(): string;
  postData(): string | null;
}

/** The part of a Playwright `Page` the watch uses. */
export interface WatchedPage {
  on(event: "request", listener: (request: WatchedRequest) => void): unknown;
  off(event: "request", listener: (request: WatchedRequest) => void): unknown;
}

interface ReadAudit {
  /** Every argument the audited definition takes. */
  readonly args: readonly string[];
  /** The arguments the dashboard always sends. */
  readonly required: readonly string[];
}

/**
 * The RPCs the dashboard sends on its own, each once per startup (sign-in or
 * reload). It sent nothing else unprompted — no other RPC, no table write, no
 * Edge Function — in the 32 local startups observed for this change (24
 * repeated, and every one in both specs). Each is audited against the
 * definition the migrations install:
 *
 *   * `get_current_user_access()`: STABLE SECURITY DEFINER, reads only the
 *     caller's own rows, by `auth.uid()` (20260902120000; search_path
 *     20260926202754);
 *   * `get_keyword_options(p_user_id, p_paper_ids, p_year_from, p_year_to,
 *     p_study_types)`: STABLE, refuses any `p_user_id` but the caller's
 *     (20260802025704; SECURITY INVOKER since 20260926152414);
 *   * `get_ai_quota_status(p_user_id)`: STABLE SECURITY DEFINER, refuses any
 *     `p_user_id` but the caller's (20260725090000; search_path
 *     20260926202754).
 *
 * STABLE is what makes them reads: PL/pgSQL refuses INSERT, UPDATE and DELETE
 * in a non-volatile function. Only `authenticated` may execute them. The
 * argument check keeps each allowance to that one signature: PostgREST picks a
 * function by the names of its arguments, so other names would reach another
 * function. `study-record-traffic.test.ts` re-reads each audit from the
 * migrations, and fails if one changes.
 */
export const AUDITED_READ_RPCS: Readonly<Record<string, ReadAudit>> = Object.freeze({
  get_current_user_access: Object.freeze({ args: Object.freeze([]), required: Object.freeze([]) }),
  get_keyword_options: Object.freeze({
    args: Object.freeze(["p_user_id", "p_paper_ids", "p_year_from", "p_year_to", "p_study_types"]),
    required: Object.freeze(["p_user_id"]),
  }),
  get_ai_quota_status: Object.freeze({ args: Object.freeze(["p_user_id"]), required: Object.freeze(["p_user_id"]) }),
});

export type TrafficVerdict =
  /** One of the spec's own study-record RPCs, with its JSON body when sent with POST. */
  | { readonly kind: "study-record"; readonly rpc: string; readonly body?: Record<string, unknown> }
  /** One of the dashboard's audited reads, sent as its audit allows. */
  | { readonly kind: "audited-read"; readonly rpc: string }
  /** Not the watch's business: a table read, Auth, Storage, the app's own files. */
  | { readonly kind: "pass" }
  /** What the dialog must never send, named by method and path or by RPC — never by query string or body. */
  | { readonly kind: "forbidden"; readonly what: string; readonly rpc?: string };

const RPC_PREFIX = "/rest/v1/rpc/";
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The request's path, percent-decoded, without its query string. */
function pathOf(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split(/[?#]/)[0];
  }
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** A body that is a JSON object (an empty body is `{}`), or null for anything else. */
function jsonObject(postData: string | null): Record<string, unknown> | null {
  if (postData === null || postData === "") return {};
  try {
    const value: unknown = JSON.parse(postData);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Why a call to an audited read falls outside its audit, or null when it doesn't. A preflight carries no call. */
function outsideAudit(audit: ReadAudit, method: string, postData: string | null): string | null {
  if (method === "OPTIONS") return null;
  if (method !== "POST") return `sent with ${method}`;
  const body = jsonObject(postData);
  if (body === null) return "body is not a JSON object";
  const unexpected = Object.keys(body).filter((key) => !audit.args.includes(key));
  if (unexpected.length > 0) return `unexpected argument ${unexpected.sort().join(", ")}`;
  const missing = audit.required.filter((key) => !Object.prototype.hasOwnProperty.call(body, key));
  if (missing.length > 0) return `missing argument ${missing.join(", ")}`;
  return null;
}

/** Classify one request a watched page sent, for a spec whose own study-record RPCs are `studyRecordRpcs`. */
export function classifyStudyRecordRequest(request: WatchedRequest, studyRecordRpcs: ReadonlySet<string>): TrafficVerdict {
  const method = request.method();
  const path = pathOf(request.url());
  if (path.includes("/functions/v1/")) return { kind: "forbidden", what: `${method} ${path}` };
  const at = path.indexOf(RPC_PREFIX);
  if (at >= 0) {
    // The name is the whole last segment, matched exactly: no prefix, no pattern.
    const rpc = path.slice(at + RPC_PREFIX.length);
    if (rpc === "" || rpc.includes("/")) return { kind: "forbidden", what: `${method} ${path}` };
    if (studyRecordRpcs.has(rpc)) {
      if (method !== "POST") return { kind: "study-record", rpc };
      const body = jsonObject(request.postData());
      return body === null ? { kind: "forbidden", rpc, what: `rpc ${rpc} (body is not a JSON object)` } : { kind: "study-record", rpc, body };
    }
    if (Object.prototype.hasOwnProperty.call(AUDITED_READ_RPCS, rpc)) {
      const problem = outsideAudit(AUDITED_READ_RPCS[rpc], method, request.postData());
      return problem === null ? { kind: "audited-read", rpc } : { kind: "forbidden", rpc, what: `rpc ${rpc} (${problem})` };
    }
    return { kind: "forbidden", rpc, what: `rpc ${rpc}` };
  }
  if (path.includes("/rest/v1/") && !READ_METHODS.has(method)) return { kind: "forbidden", what: `${method} ${path}` };
  return { kind: "pass" };
}

export interface StudyRecordTraffic {
  /** Every RPC the page sent while watched, by name, in order — allowed or not. */
  readonly rpcs: string[];
  /** The audited reads among them, by name, in order: the dashboard's, kept apart from the study-record calls. */
  readonly reads: string[];
  /** Everything the dialog must never send, in order. */
  readonly forbidden: string[];
  /** The JSON bodies of one of the spec's study-record RPCs, as POSTed, in order — a live array. */
  bodiesOf(rpc: string): Record<string, unknown>[];
  /** Stop watching: later requests are not recorded. */
  stop(): void;
}

/** Watch what `page` sends, for a spec whose own study-record RPCs are `studyRecordRpcs`. */
export function watchStudyRecordTraffic(page: WatchedPage, studyRecordRpcs: readonly string[]): StudyRecordTraffic {
  const own = new Set(studyRecordRpcs);
  const rpcs: string[] = [];
  const reads: string[] = [];
  const forbidden: string[] = [];
  const bodies = new Map(studyRecordRpcs.map((rpc): [string, Record<string, unknown>[]] => [rpc, []]));
  const onRequest = (request: WatchedRequest) => {
    const verdict = classifyStudyRecordRequest(request, own);
    if (verdict.kind !== "pass" && verdict.rpc !== undefined) rpcs.push(verdict.rpc);
    if (verdict.kind === "audited-read") reads.push(verdict.rpc);
    if (verdict.kind === "study-record" && verdict.body) bodies.get(verdict.rpc)!.push(verdict.body);
    if (verdict.kind === "forbidden") forbidden.push(verdict.what);
  };
  page.on("request", onRequest);
  return {
    rpcs,
    reads,
    forbidden,
    bodiesOf: (rpc) => {
      const list = bodies.get(rpc);
      if (!list) throw new Error(`${rpc} is not one of this watch's study-record RPCs.`);
      return list;
    },
    stop: () => {
      page.off("request", onRequest);
    },
  };
}
