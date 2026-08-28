/**
 * CHROME-EXTENSION-IMPORT-001C1-CORRECTION-01 — `normalizationPoolsStatus`.
 *
 * The defect this file exists to keep closed: readiness used to be `!loading`,
 * and a pool query that had exhausted its retries settles at
 *
 *   isLoading === false      data === []      (the destructuring default)
 *
 * which is byte-identical to a successful read of a pool the user genuinely
 * left empty. A failed read therefore presented as a valid — merely small —
 * normalization configuration, and the confirm control it gated became enabled.
 *
 * These tests run the REAL hooks and the REAL React Query state machine. Only
 * the PostgREST boundary is stubbed, one table at a time, so what is asserted is
 * the derivation as it actually resolves rather than a hand-written constant.
 * The first test also pins the root cause itself: on failure the arrays really
 * are empty and `loading` really is false, so nothing downstream could have
 * distinguished the two without this status.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/** Tables the provider's four queries touch. */
type PoolTable =
  | "keyword_pool"
  | "study_type_pool"
  | "synonym_pool"
  | "keyword_exclusion_pool"
  | "study_type_exclusion_pool";

/** Tables whose read must currently fail, and how many reads each table saw. */
const failingTables = new Set<PoolTable>();
const readCounts = new Map<PoolTable, number>();

/**
 * A PostgREST builder stub.
 *
 * Every chained method returns the same object and the object is thenable, so
 * `.select().eq().order()` resolves exactly as supabase-js does — including the
 * `{ data, error }` envelope, which is what makes the hooks' own
 * `if (error) throw error` the thing under test.
 */
function builderFor(table: PoolTable) {
  readCounts.set(table, (readCounts.get(table) ?? 0) + 1);
  const settled = failingTables.has(table)
    ? { data: null, error: { message: `stubbed read failure on ${table}` } }
    : { data: [], error: null };

  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    then: (
      resolve: (value: typeof settled) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(settled).then(resolve, reject),
  };
  return builder;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (table: PoolTable) => builderFor(table) },
}));

import { PoolsProvider, usePools } from "@/contexts/PoolsContext";

const USER_ID = "00000000-0000-4000-8000-000000000001";

/** Renders the derived status, the arrays it was derived from, and the retry. */
function StatusProbe() {
  const {
    normalizationPoolsStatus,
    retryNormalizationPools,
    poolKeywords,
    poolStudyTypes,
    synonymGroups,
  } = usePools();
  return (
    <div>
      <span data-testid="status">{normalizationPoolsStatus}</span>
      <span data-testid="sizes">
        {poolKeywords.length}/{poolStudyTypes.length}/{synonymGroups.length}
      </span>
      <button onClick={retryNormalizationPools}>retry</button>
    </div>
  );
}

function renderProvider(client: QueryClient, children: ReactNode = <StatusProbe />) {
  return render(
    <QueryClientProvider client={client}>
      <PoolsProvider userId={USER_ID}>{children}</PoolsProvider>
    </QueryClientProvider>,
  );
}

/** No retries: the point is the settled state, not React Query's backoff. */
function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const status = () => screen.getByTestId("status").textContent;

beforeEach(() => {
  failingTables.clear();
  readCounts.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizationPoolsStatus — a failed read is never ready", () => {
  const NORMALIZATION_TABLES: PoolTable[] = [
    "keyword_pool",
    "study_type_pool",
    "synonym_pool",
  ];

  it.each(NORMALIZATION_TABLES)(
    "reports error when the %s read fails, and does so while its array is empty",
    async (table) => {
      failingTables.add(table);
      renderProvider(newClient());

      await waitFor(() => expect(status()).toBe("error"));

      // The root cause, pinned: the failure presents as three empty arrays. Any
      // consumer reading only the data would see a perfectly valid, merely
      // minimal, configuration — which is precisely why `!loading` was wrong.
      expect(screen.getByTestId("sizes")).toHaveTextContent("0/0/0");
    },
  );

  it("reports error when every normalization pool fails at once", async () => {
    for (const table of NORMALIZATION_TABLES) failingTables.add(table);
    renderProvider(newClient());

    await waitFor(() => expect(status()).toBe("error"));
  });
});

describe("normalizationPoolsStatus — a genuinely empty pool is ready", () => {
  it("is ready when all three pools load and all three are empty", async () => {
    // The case that must NOT be mistaken for a failure: a user who has added no
    // keywords, study types or synonyms has a valid normalization configuration
    // and is entitled to import.
    renderProvider(newClient());

    await waitFor(() => expect(status()).toBe("ready"));
    expect(screen.getByTestId("sizes")).toHaveTextContent("0/0/0");
  });

  it("ignores an exclusion-pool failure, which feeds no normalization", async () => {
    // Exclusion pools are display filters. Failing one must not block an import,
    // or the status would be over-broad in the other direction.
    failingTables.add("keyword_exclusion_pool");
    renderProvider(newClient());

    await waitFor(() => expect(status()).toBe("ready"));
  });
});

describe("normalizationPoolsStatus — loading is checked before failure", () => {
  it("stays loading while any pool is still in flight", async () => {
    // Rendered before anything resolves: the very first paint must be `loading`,
    // never `ready` and never `error`.
    renderProvider(newClient());
    expect(status()).toBe("loading");
  });

  it("never reports ready at any point when a pool fails", async () => {
    failingTables.add("study_type_pool");

    const seen: string[] = [];
    const client = newClient();
    const view = renderProvider(client);
    seen.push(status()!);

    await waitFor(() => expect(status()).toBe("error"));
    seen.push(status()!);

    view.unmount();
    expect(seen).not.toContain("ready");
  });
});

describe("retryNormalizationPools", () => {
  it("re-reads the three pools and recovers when the failure clears", async () => {
    failingTables.add("synonym_pool");
    renderProvider(newClient());
    await waitFor(() => expect(status()).toBe("error"));

    const before = readCounts.get("synonym_pool") ?? 0;
    failingTables.delete("synonym_pool");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "retry" }));
    });

    await waitFor(() => expect(status()).toBe("ready"));
    expect(readCounts.get("synonym_pool") ?? 0).toBeGreaterThan(before);
  });

  it("re-reads every normalization pool, not only the one that failed", async () => {
    failingTables.add("keyword_pool");
    renderProvider(newClient());
    await waitFor(() => expect(status()).toBe("error"));

    const before = {
      keyword: readCounts.get("keyword_pool") ?? 0,
      studyType: readCounts.get("study_type_pool") ?? 0,
      synonym: readCounts.get("synonym_pool") ?? 0,
    };
    failingTables.delete("keyword_pool");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "retry" }));
    });
    await waitFor(() => expect(status()).toBe("ready"));

    expect(readCounts.get("keyword_pool") ?? 0).toBeGreaterThan(before.keyword);
    expect(readCounts.get("study_type_pool") ?? 0).toBeGreaterThan(before.studyType);
    expect(readCounts.get("synonym_pool") ?? 0).toBeGreaterThan(before.synonym);
  });
});
