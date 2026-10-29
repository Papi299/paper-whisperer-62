/**
 * A fake of the PostgREST reads the study-record layer makes: `.from().select()`
 * with `eq`, `in`, `lt`, `gt`, `order` (ascending, or `{ ascending: false }`),
 * `range`, `limit` and `abortSignal`, answered from in-memory rows with
 * PostgREST's 1,000-row page. Numbers sort as numbers, everything else by its
 * text. Every request is recorded, so a test can assert what was asked (the
 * user filter, the chunking, a history cursor) as well as what came back.
 * Writes do not exist here: a call to anything else throws.
 */

import type { StudyRecordClient } from "../read";

export interface RecordedRequest {
  readonly table: string;
  readonly columns: string;
  readonly eq: readonly [string, unknown][];
  readonly in: readonly [string, readonly unknown[]][];
  readonly lt: readonly [string, unknown][];
  readonly gt: readonly [string, unknown][];
  /** Column names; a descending one as `"<column> desc"`. */
  readonly order: readonly string[];
  readonly range: readonly [number, number] | null;
  readonly limit: number | null;
  readonly signal: boolean;
}

export type TableAnswer = { readonly error: unknown; readonly status?: number } | "throw";

export interface FakeOptions {
  /** Rows per table. */
  readonly tables: Record<string, Record<string, unknown>[]>;
  /** A failure to answer with, per table (every request to it). */
  readonly failures?: Record<string, TableAnswer>;
  /** PostgREST's max_rows. */
  readonly maxRows?: number;
  /**
   * Answer with the selected columns only, as PostgREST does (`*` keeps every
   * column). Off by default: the C1 suites were written against whole rows.
   */
  readonly project?: boolean;
}

const compare = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;

export function fakeSupabase({ tables, failures = {}, maxRows = 1000, project = false }: FakeOptions) {
  const requests: RecordedRequest[] = [];

  function builder(table: string) {
    const state = {
      columns: "",
      eq: [] as [string, unknown][],
      in: [] as [string, unknown[]][],
      lt: [] as [string, unknown][],
      gt: [] as [string, unknown][],
      order: [] as { column: string; ascending: boolean }[],
      range: null as [number, number] | null,
      limit: null as number | null,
      signal: false,
    };
    const run = async () => {
      requests.push({
        table,
        columns: state.columns,
        eq: [...state.eq],
        in: [...state.in],
        lt: [...state.lt],
        gt: [...state.gt],
        order: state.order.map(({ column, ascending }) => (ascending ? column : `${column} desc`)),
        range: state.range,
        limit: state.limit,
        signal: state.signal,
      });
      const failure = failures[table];
      if (failure === "throw") throw new TypeError("Failed to fetch");
      if (failure) return { data: null, error: failure.error, status: failure.status ?? 400 };
      let rows = (tables[table] ?? []).filter(
        (row) =>
          state.eq.every(([column, value]) => row[column] === value) &&
          state.in.every(([column, values]) => values.includes(row[column])) &&
          state.lt.every(([column, value]) => compare(row[column], value) < 0) &&
          state.gt.every(([column, value]) => compare(row[column], value) > 0),
      );
      for (const { column, ascending } of [...state.order].reverse()) {
        rows = [...rows].sort((a, b) => (ascending ? 1 : -1) * compare(a[column], b[column]));
      }
      const [from, to] = state.range ?? [0, maxRows - 1];
      const end = Math.min(to + 1, from + maxRows, state.limit === null ? Infinity : from + state.limit);
      const page = rows.slice(from, end);
      const columns = state.columns.split(",").map((column) => column.trim());
      const projected = project && !columns.includes("*") ? page.map((row) => Object.fromEntries(columns.filter((column) => column in row).map((column) => [column, row[column]]))) : page;
      return { data: projected, error: null, status: 200 };
    };
    const chain = {
      select(columns: string) {
        state.columns = columns;
        return chain;
      },
      eq(column: string, value: unknown) {
        state.eq.push([column, value]);
        return chain;
      },
      in(column: string, values: readonly unknown[]) {
        state.in.push([column, [...values]]);
        return chain;
      },
      lt(column: string, value: unknown) {
        state.lt.push([column, value]);
        return chain;
      },
      gt(column: string, value: unknown) {
        state.gt.push([column, value]);
        return chain;
      },
      order(column: string, options?: { readonly ascending?: boolean }) {
        state.order.push({ column, ascending: options?.ascending ?? true });
        return chain;
      },
      range(from: number, to: number) {
        state.range = [from, to];
        return chain;
      },
      limit(count: number) {
        state.limit = count;
        return chain;
      },
      abortSignal() {
        state.signal = true;
        return chain;
      },
      then<T1, T2>(onFulfilled: (value: Awaited<ReturnType<typeof run>>) => T1, onRejected?: (reason: unknown) => T2) {
        return run().then(onFulfilled, onRejected);
      },
    };
    return chain;
  }

  const client = new Proxy(
    { from: (table: string) => builder(table) },
    {
      get(target, property) {
        if (property === "from") return target.from;
        throw new Error(`The study-record read layer must not use supabase.${String(property)}`);
      },
    },
  ) as unknown as StudyRecordClient;

  return { client, requests };
}

/** A PostgREST error saying an evidence table does not exist (the schema is not installed). */
export const missingTableError = (table: string) => ({
  code: "42P01",
  message: `relation "public.${table}" does not exist`,
});
