/**
 * A recording PostgREST/Storage double for the account-export tests.
 *
 * It is deliberately behavioural rather than a bag of `vi.fn()`s: it applies
 * `.eq()` / `.in()` predicates and `.range()` windows to real fixture rows, so
 * a test can assert both *what was requested* (S2 scoping, the exact selected
 * columns) and *what the caller did with the answer* (pagination completeness,
 * ownership validation) without restating the query pipeline.
 */

export interface RecordedQuery {
  table: string;
  select: string;
  eq: [string, unknown][];
  in?: [string, string[]];
  orders: string[];
  range?: [number, number];
  single?: boolean;
}

export interface SupabaseMockOptions {
  /** Fixture rows per table. */
  tables: Record<string, Record<string, unknown>[]>;
  /** Tables whose reads must fail, and with what. */
  errors?: Record<string, Error>;
  /**
   * Tables where `.eq()` / `.in()` predicates are deliberately **not** applied,
   * simulating a backend that fails to filter (a misconfigured RLS policy).
   * Used to prove the export validates what it receives rather than trusting
   * that the predicate was honoured.
   */
  leakTables?: string[];
}

export interface SupabaseMock {
  from: (table: string) => unknown;
  queries: RecordedQuery[];
  /** Every query issued against `table`. */
  queriesFor: (table: string) => RecordedQuery[];
}

function matchesPredicates(row: Record<string, unknown>, query: RecordedQuery): boolean {
  for (const [column, value] of query.eq) {
    if (row[column] !== value) return false;
  }
  if (query.in) {
    const [column, values] = query.in;
    if (!values.includes(row[column] as string)) return false;
  }
  return true;
}

/**
 * Apply the PostgREST select projection, so a column the caller did not ask
 * for is genuinely absent from the response — the property the secret-exclusion
 * tests depend on.
 */
function project(row: Record<string, unknown>, select: string): Record<string, unknown> {
  if (select.trim() === "*") return { ...row };
  const columns = select.split(",").map((column) => column.trim()).filter(Boolean);
  const projected: Record<string, unknown> = {};
  for (const column of columns) {
    if (column in row) projected[column] = row[column];
  }
  return projected;
}

export function createSupabaseMock(options: SupabaseMockOptions): SupabaseMock {
  const queries: RecordedQuery[] = [];
  const errors = options.errors ?? {};
  const leakTables = new Set(options.leakTables ?? []);

  const from = (table: string) => ({
    select: (select: string) => {
      const query: RecordedQuery = { table, select, eq: [], orders: [] };

      const resolve = (windowed: boolean) => {
        queries.push({ ...query, eq: [...query.eq], orders: [...query.orders] });
        const error = errors[table];
        if (error) return { data: null, error };

        const source = options.tables[table] ?? [];
        const filtered = leakTables.has(table)
          ? source
          : source.filter((row) => matchesPredicates(row, query));
        const rows = filtered.map((row) => project(row, select));

        if (!windowed) return { data: rows[0] ?? null, error: null };

        const [start, end] = query.range ?? [0, rows.length - 1];
        return { data: rows.slice(start, end + 1), error: null };
      };

      const builder = {
        eq(column: string, value: unknown) {
          query.eq.push([column, value]);
          return builder;
        },
        in(column: string, values: string[]) {
          query.in = [column, values];
          return builder;
        },
        order(column: string) {
          query.orders.push(column);
          return builder;
        },
        range(start: number, end: number) {
          query.range = [start, end];
          return Promise.resolve(resolve(true));
        },
        maybeSingle() {
          query.single = true;
          return Promise.resolve(resolve(false));
        },
      };

      return builder;
    },
  });

  return {
    from,
    queries,
    queriesFor: (table: string) => queries.filter((query) => query.table === table),
  };
}

/** A Storage double returning fixed bytes per path, with per-path failures. */
export interface StorageMockOptions {
  objects: Record<string, Uint8Array>;
  errors?: Record<string, Error>;
  /** Called with every requested path, in request order. */
  onDownload?: (path: string) => void | Promise<void>;
}

export function createStorageMock(options: StorageMockOptions) {
  const requested: string[] = [];

  const from = (bucket: string) => ({
    bucket,
    download: async (path: string) => {
      requested.push(path);
      await options.onDownload?.(path);
      const error = options.errors?.[path];
      if (error) return { data: null, error };
      const bytes = options.objects[path];
      if (!bytes) return { data: null, error: new Error(`No such object: ${path}`) };
      return { data: bytesToBlob(bytes), error: null };
    },
  });

  return { from, requested };
}

/**
 * A minimal Blob stand-in exposing `arrayBuffer()`, which is all the export
 * path consumes. jsdom's own Blob does not implement it in every version.
 */
export function bytesToBlob(bytes: Uint8Array): Blob {
  return {
    size: bytes.length,
    type: "application/octet-stream",
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Blob;
}
