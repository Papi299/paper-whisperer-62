/**
 * A fake of the PostgREST reads the study-record layer makes: `.from().select()`
 * with `eq`, `in`, `order`, `range` and `abortSignal`, answered from in-memory
 * rows with PostgREST's 1,000-row page. Every request is recorded, so a test
 * can assert what was asked (the user filter, the chunking) as well as what
 * came back. Writes do not exist here: a call to anything else throws.
 */

import type { StudyRecordClient } from "../read";

export interface RecordedRequest {
  readonly table: string;
  readonly columns: string;
  readonly eq: readonly [string, unknown][];
  readonly in: readonly [string, readonly unknown[]][];
  readonly order: readonly string[];
  readonly range: readonly [number, number] | null;
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
}

export function fakeSupabase({ tables, failures = {}, maxRows = 1000 }: FakeOptions) {
  const requests: RecordedRequest[] = [];

  function builder(table: string) {
    const state = { columns: "", eq: [] as [string, unknown][], in: [] as [string, unknown[]][], order: [] as string[], range: null as [number, number] | null, signal: false };
    const run = async () => {
      requests.push({ table, columns: state.columns, eq: [...state.eq], in: [...state.in], order: [...state.order], range: state.range, signal: state.signal });
      const failure = failures[table];
      if (failure === "throw") throw new TypeError("Failed to fetch");
      if (failure) return { data: null, error: failure.error, status: failure.status ?? 400 };
      let rows = (tables[table] ?? []).filter(
        (row) => state.eq.every(([column, value]) => row[column] === value) && state.in.every(([column, values]) => values.includes(row[column])),
      );
      for (const column of [...state.order].reverse()) {
        rows = [...rows].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0));
      }
      const [from, to] = state.range ?? [0, maxRows - 1];
      const page = rows.slice(from, Math.min(to + 1, from + maxRows));
      return { data: page, error: null, status: 200 };
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
      order(column: string) {
        state.order.push(column);
        return chain;
      },
      range(from: number, to: number) {
        state.range = [from, to];
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
