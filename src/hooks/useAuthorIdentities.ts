import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/queryKeys";
import { useToast } from "@/hooks/use-toast";
import { isAuthorIdentitySchemaMissing } from "@/lib/authorIdentityAvailability";
import { fetchAllPagesInChunks } from "@/lib/fetchAllPagesInChunks";
import type { RangeableQuery } from "@/lib/fetchAllPages";
import {
  EMPTY_AUTHOR_IDENTITY_DATASET,
  type AuthorIdentityAliasRecord,
  type AuthorIdentityDataset,
  type AuthorIdentityLinkRecord,
  type AuthorIdentityMergeRecord,
  type AuthorIdentityPaper,
  type AuthorIdentityRecord,
  type AuthorResolutionBasis,
} from "@/lib/authorIdentity";

/**
 * The only paper columns identity evidence needs.
 *
 * `authors` supplies the spellings and validates each link's snapshot;
 * `author_provenance` supplies the ORCID and the collective flag; the rest is
 * the context a user reads to recognise the paper. Nothing here is large — in
 * particular `abstract` is absent, which is what keeps this from becoming a
 * second copy of the library.
 */
const IDENTITY_EVIDENCE_SELECT = "id, title, authors, author_provenance, year, journal";

/** What one identity read produced, as one indivisible unit. */
interface AuthorIdentityQueryResult {
  dataset: AuthorIdentityDataset;
  linkedPapers: AuthorIdentityPaper[];
}

/**
 * One shared empty array for the not-loaded-yet case.
 *
 * A fresh `[]` per render would change identity every time, and consumers
 * memoize the whole resolution on it — so the entire identity graph would be
 * rebuilt on every render for as long as the query is in flight.
 */
const NO_LINKED_PAPERS: readonly AuthorIdentityPaper[] = [];

/**
 * The data layer for AUTHOR-IDENTITY-RESOLUTION-001C.
 *
 * READS are four plain `select`s under RLS, fetched as one unit. They are only
 * meaningful together — a link is uninterpretable without the merge graph that
 * says which identity it effectively belongs to — so a partially refreshed cache
 * could render one person as two, or two as one, for the length of a render.
 * One query key, one refresh, no intermediate state.
 *
 * WRITES all go through RPCs, never through row writes, because every one of
 * them is a decision that must be validated against CURRENT paper state
 * (ownership, index bounds, the expected author string, explicitly collective
 * provenance) or against the merge graph (cycles, one outgoing edge) and
 * committed atomically. The one exception is aliases: an alias is an inert
 * assertion that links nothing, so it is a direct insert/delete guarded by RLS
 * and a composite foreign key.
 *
 * `dataset` is `null` — not empty — when the 001C schema is absent from this
 * environment. The distinction is the whole compatibility story: `null` means
 * "cannot know", and every consumer degrades to 001A behaviour, while an empty
 * dataset means "installed, and this user has decided nothing yet". A Vercel
 * Preview built from this branch against a Production database that predates the
 * migration takes the first path and keeps working.
 */

/** What the caller needs to know about a mutation that failed. */
export class AuthorIdentityError extends Error {
  /** True when the failure is the environment lacking the 001C schema. */
  readonly schemaMissing: boolean;
  /** The underlying failure, kept for diagnosis. The compile target predates the
   *  standard `cause` option, so it is attached explicitly — as
   *  `AccountExportError` does. */
  readonly cause?: unknown;

  constructor(message: string, options: { schemaMissing: boolean; cause?: unknown }) {
    super(message);
    this.name = "AuthorIdentityError";
    this.schemaMissing = options.schemaMissing;
    this.cause = options.cause;
  }
}

/**
 * What the identity read currently knows, as five states that must never be
 * confused for one another.
 *
 *   `loading`      the query has not resolved.
 *   `unavailable`  the precise, expected compatibility case: this environment
 *                  predates the 001C migration. Consumers fall back to 001A
 *                  grouping, and no error language is warranted.
 *   `ready`        installed and healthy.
 *   `failed`       a REAL read failure with no usable dataset — permission,
 *                  RLS, network, malformed query, or the linked-paper evidence
 *                  read.
 *   `stale`        a real refetch failure over a dataset that HAD loaded. The
 *                  last known-good graph is still shown, and said to be stale.
 *
 * The distinction that matters most is `unavailable` versus `failed`. Both leave
 * a consumer without identity data, and it is tempting to treat them alike — but
 * one means "this user has no identity subsystem", and the other means "we could
 * not read this user's identity decisions". Collapsing them silently regroups a
 * user's resolved people back into separate 001A mentions and tells them
 * nothing, which is worse than an error: the screen looks correct and is wrong.
 */
export type AuthorIdentityReadState =
  | "loading"
  | "unavailable"
  | "ready"
  | "failed"
  | "stale";

export interface AuthorIdentitiesState {
  /**
   * The user's identity decisions, or `null` when there are none to show —
   * either because the subsystem is not installed here, or because the read
   * failed. `readState` is what says which, and consumers must consult it
   * rather than inferring from this being null.
   */
  dataset: AuthorIdentityDataset | null;
  /** Which of the five read states this is. See `AuthorIdentityReadState`. */
  readState: AuthorIdentityReadState;
  /**
   * Whether identity decisions may be written right now.
   *
   * False for every state except `ready`. A mutation validates against the
   * CURRENT graph, and a caller that could not read the graph cannot know what
   * it is about to displace — so the controls are disabled rather than offered
   * and allowed to fail.
   */
  canMutate: boolean;
  /** Re-run the identity read. The user's own retry, never automatic. */
  retry: () => void;
  /**
   * The papers the identity graph actually links to — USER-WIDE, and pointedly
   * not the papers Analytics happens to be showing.
   *
   * What an existing person *is* — the spellings the user accepted for them, the
   * ORCIDs their linked papers state, whether they have anything attached at all
   * — is durable account state. Deriving it from the filtered Analytics
   * collection, as the first implementation did, let a dropdown redefine the
   * identity graph: filter to one paper and a person's ORCID evidence
   * disappears, taking with it the exact-ORCID candidate that person exists to
   * produce, their findability by linked spelling, and the duplicate pairing
   * that spotted them in the first place.
   *
   * Fetched as a minimal projection — no abstract, no keywords, no MeSH terms —
   * because identity evidence needs six columns and this must not become a
   * whole-library read. Empty when nothing is linked yet, which is the common
   * case and costs one skipped request.
   */
  linkedPapers: readonly AuthorIdentityPaper[];
  isLoading: boolean;
  /** True when reads failed specifically because the 001C schema is absent. */
  isUnavailable: boolean;
  /** A real read failure — never the unavailable case, which is not an error. */
  error: Error | null;
  refresh: () => void;
}

export interface CreateIdentityFromMentionInput {
  paperId: string;
  authorIndex: number;
  /** The author string EXACTLY as currently stored. The server compares it. */
  expectedAuthor: string;
  /** The label the user confirmed. Blank falls back to the current author string. */
  preferredName?: string;
  /**
   * Displace a saved link at this position that the SERVER can prove is stale.
   *
   * Not a general overwrite. The database re-reads the stored snapshot against
   * the paper's current text and refuses if they still match, so this can only
   * ever repair a row that no longer describes its mention — never overwrite a
   * decision the user actually made.
   */
  replaceStaleExisting?: boolean;
}

export interface LinkMentionInput {
  paperId: string;
  authorIndex: number;
  expectedAuthor: string;
  identityId: string;
  resolutionBasis: Exclude<AuthorResolutionBasis, "created_from_mention">;
  /** Must be explicitly true to displace a link the user already made. */
  replaceExisting?: boolean;
}

/**
 * Turn any Supabase failure into an `AuthorIdentityError`, classifying the
 * expected "not installed here" case without swallowing anything else.
 */
function toIdentityError(message: string, cause: unknown): AuthorIdentityError {
  return new AuthorIdentityError(message, {
    schemaMissing: isAuthorIdentitySchemaMissing(cause),
    cause,
  });
}

export function useAuthorIdentities(userId: string | undefined): AuthorIdentitiesState & {
  createIdentityFromMention: (input: CreateIdentityFromMentionInput) => Promise<string>;
  linkMention: (input: LinkMentionInput) => Promise<void>;
  unlinkMention: (paperId: string, authorIndex: number) => Promise<void>;
  renameIdentity: (identityId: string, preferredName: string) => Promise<void>;
  addAlias: (identityId: string, alias: string) => Promise<void>;
  removeAlias: (aliasId: string) => Promise<void>;
  mergeIdentities: (sourceIdentityId: string, targetIdentityId: string) => Promise<void>;
  unmergeIdentity: (sourceIdentityId: string) => Promise<void>;
  deleteIdentity: (identityId: string) => Promise<void>;
  isMutating: boolean;
} {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const query = useQuery<AuthorIdentityQueryResult | null, Error>({
    queryKey: userId ? queryKeys.authorIdentities.all(userId) : ["authorIdentities", "anon"],
    enabled: !!userId,
    queryFn: async () => {
      if (!userId) return { dataset: EMPTY_AUTHOR_IDENTITY_DATASET, linkedPapers: [] };

      // Explicit column lists, and an explicit `user_id` filter on top of RLS —
      // the same defence-in-depth every other owned-table read in this codebase
      // applies. Ordered so a render never reshuffles.
      const [identities, aliases, links, merges] = await Promise.all([
        supabase
          .from("author_identities")
          .select("id, preferred_name")
          .eq("user_id", userId)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }),
        supabase
          .from("author_identity_aliases")
          .select("id, identity_id, alias")
          .eq("user_id", userId)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }),
        supabase
          .from("author_identity_links")
          .select("id, identity_id, paper_id, author_index, author_name_snapshot, resolution_basis")
          .eq("user_id", userId)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }),
        supabase
          .from("author_identity_merges")
          .select("source_identity_id, target_identity_id")
          .eq("user_id", userId)
          .order("source_identity_id", { ascending: true }),
      ]);

      for (const result of [identities, aliases, links, merges]) {
        if (!result.error) continue;
        // The one expected condition: this environment predates the migration.
        // Reported as `null` rather than thrown, so consumers fall back to 001A
        // instead of showing a failure the user can do nothing about.
        if (isAuthorIdentitySchemaMissing(result.error)) return null;
        throw result.error;
      }

      const dataset: AuthorIdentityDataset = {
        identities: (identities.data ?? []) as AuthorIdentityRecord[],
        aliases: (aliases.data ?? []) as AuthorIdentityAliasRecord[],
        links: (links.data ?? []) as AuthorIdentityLinkRecord[],
        merges: (merges.data ?? []) as AuthorIdentityMergeRecord[],
      };

      /**
       * The evidence read, in the same unit as the decisions it explains.
       *
       * Sequential rather than parallel because it cannot be anything else: the
       * paper ids come from the links. Keeping it inside this one `queryFn`
       * keeps the pair atomic — a cache holding new links beside old papers
       * would show a person their evidence for one render, which is exactly the
       * inconsistency the single query key exists to prevent.
       *
       * Only papers that are actually linked are fetched, chunked so a long id
       * list cannot overflow the request URL and paginated so a large one cannot
       * be silently truncated at PostgREST's 1000-row default.
       */
      const linkedPaperIds = [...new Set(dataset.links.map((link) => link.paper_id))].sort();
      const linkedPapers = await fetchAllPagesInChunks<AuthorIdentityPaper>(
        linkedPaperIds,
        (chunk) =>
          supabase
            .from("papers")
            .select(IDENTITY_EVIDENCE_SELECT)
            .eq("user_id", userId)
            .in("id", chunk)
            .order("id", { ascending: true }) as unknown as RangeableQuery,
      );

      return { dataset, linkedPapers };
    },
    // Identity decisions change only when this user changes them, and every
    // mutation invalidates explicitly, so background refetching would be churn.
    staleTime: 5 * 60 * 1000,
  });

  const invalidate = useCallback(() => {
    if (!userId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.authorIdentities.all(userId) });
  }, [queryClient, userId]);

  const readError = query.error ?? null;
  const dataset = query.data?.dataset ?? null;

  /**
   * The five states, resolved in the one order that cannot mislead.
   *
   * A real error is classified BEFORE the schema-absence sentinel, because
   * TanStack keeps the last successful `data` alongside a failed refetch: a
   * query that once answered `null` (schema absent) and then hit a permission
   * error still has `data === null`, and reporting that as "not installed" would
   * dress a genuine failure up as the expected compatibility case.
   */
  const readState: AuthorIdentityReadState = query.isLoading
    ? "loading"
    : readError
      ? dataset === null
        ? "failed"
        : "stale"
      : query.data === null
        ? "unavailable"
        : dataset !== null
          ? "ready"
          : "loading";

  const isUnavailable = readState === "unavailable";
  const canMutate = readState === "ready";

  const retry = useCallback(() => {
    void query.refetch();
  }, [query]);


  /**
   * Surface a mutation failure without destroying anything.
   *
   * Errors are shown and the operation stops. Nothing is retried automatically:
   * a conflict here means another tab already made a decision about the same
   * mention, and retrying would overwrite it — the user re-reads and chooses.
   */
  const reportFailure = useCallback(
    (title: string, error: unknown) => {
      const identityError =
        error instanceof AuthorIdentityError ? error : toIdentityError(title, error);
      toast({
        title,
        description: identityError.schemaMissing
          ? "Author identities are not available in this environment yet."
          : identityError.message,
        variant: "destructive",
      });
    },
    [toast],
  );

  const createMutation = useMutation({
    mutationFn: async (input: CreateIdentityFromMentionInput): Promise<string> => {
      const { data, error } = await supabase.rpc("create_author_identity_from_mention", {
        p_paper_id: input.paperId,
        p_author_index: input.authorIndex,
        p_expected_author: input.expectedAuthor,
        p_preferred_name: input.preferredName ?? undefined,
        p_replace_stale_existing: input.replaceStaleExisting ?? false,
      });
      if (error) throw toIdentityError(error.message, error);
      const result = data as { identity_id?: string } | null;
      if (!result?.identity_id) {
        throw new AuthorIdentityError("The identity could not be created.", {
          schemaMissing: false,
        });
      }
      return result.identity_id;
    },
    onSuccess: invalidate,
  });

  const linkMutation = useMutation({
    mutationFn: async (input: LinkMentionInput) => {
      const { error } = await supabase.rpc("link_author_mention_to_identity", {
        p_paper_id: input.paperId,
        p_author_index: input.authorIndex,
        p_expected_author: input.expectedAuthor,
        p_identity_id: input.identityId,
        p_resolution_basis: input.resolutionBasis,
        p_replace_existing: input.replaceExisting ?? false,
      });
      if (error) throw toIdentityError(error.message, error);
    },
    onSuccess: invalidate,
  });

  const unlinkMutation = useMutation({
    mutationFn: async ({ paperId, authorIndex }: { paperId: string; authorIndex: number }) => {
      const { error } = await supabase.rpc("unlink_author_mention_identity", {
        p_paper_id: paperId,
        p_author_index: authorIndex,
      });
      if (error) throw toIdentityError(error.message, error);
    },
    onSuccess: invalidate,
  });

  const renameMutation = useMutation({
    mutationFn: async ({ identityId, preferredName }: { identityId: string; preferredName: string }) => {
      const trimmed = preferredName.trim();
      if (!trimmed) {
        throw new AuthorIdentityError("An identity needs a name.", { schemaMissing: false });
      }
      // A direct UPDATE: renaming has no cross-row consequence, and the column
      // grant means `preferred_name` is the only field this can touch. It changes
      // the display name and nothing else — not papers.authors, not provenance,
      // not aliases, not links.
      const { error } = await supabase
        .from("author_identities")
        .update({ preferred_name: trimmed })
        .eq("id", identityId)
        .eq("user_id", userId ?? "");
      if (error) throw toIdentityError(error.message, error);
    },
    onSuccess: invalidate,
  });

  const addAliasMutation = useMutation({
    mutationFn: async ({ identityId, alias }: { identityId: string; alias: string }) => {
      const trimmed = alias.trim();
      if (!trimmed) {
        throw new AuthorIdentityError("An alias needs some text.", { schemaMissing: false });
      }
      if (!userId) {
        throw new AuthorIdentityError("You need to be signed in.", { schemaMissing: false });
      }
      const { error } = await supabase
        .from("author_identity_aliases")
        .insert({ user_id: userId, identity_id: identityId, alias: trimmed });
      if (error) throw toIdentityError(error.message, error);
    },
    onSuccess: invalidate,
  });

  const removeAliasMutation = useMutation({
    mutationFn: async (aliasId: string) => {
      const { error } = await supabase
        .from("author_identity_aliases")
        .delete()
        .eq("id", aliasId)
        .eq("user_id", userId ?? "");
      if (error) throw toIdentityError(error.message, error);
    },
    onSuccess: invalidate,
  });

  const mergeMutation = useMutation({
    mutationFn: async ({ sourceIdentityId, targetIdentityId }: { sourceIdentityId: string; targetIdentityId: string }) => {
      const { error } = await supabase.rpc("merge_author_identities", {
        p_source_identity_id: sourceIdentityId,
        p_target_identity_id: targetIdentityId,
      });
      if (error) throw toIdentityError(error.message, error);
    },
    onSuccess: invalidate,
  });

  const unmergeMutation = useMutation({
    mutationFn: async (sourceIdentityId: string) => {
      const { error } = await supabase.rpc("unmerge_author_identity", {
        p_source_identity_id: sourceIdentityId,
      });
      if (error) throw toIdentityError(error.message, error);
    },
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async (identityId: string) => {
      const { error } = await supabase.rpc("delete_empty_author_identity", {
        p_identity_id: identityId,
      });
      if (error) throw toIdentityError(error.message, error);
    },
    onSuccess: invalidate,
  });

  /** Wrap a mutation so a failure reports itself and stops, rather than throwing on. */
  const guard = useCallback(
    <TInput, TResult>(title: string, run: (input: TInput) => Promise<TResult>) =>
      async (input: TInput): Promise<TResult> => {
        // Every mutation validates against the CURRENT graph. A caller that
        // could not read that graph does not know what it is about to displace,
        // so the write is refused here as well as disabled in the UI — a stale
        // render or a forgotten prop must not be the only thing standing
        // between a failed read and a decision written on top of it.
        if (!canMutate) {
          const message =
            readState === "unavailable"
              ? "Author identities are not available in this environment yet."
              : "Author identities could not be loaded, so this cannot be saved yet.";
          const refusal = new AuthorIdentityError(message, {
            schemaMissing: readState === "unavailable",
          });
          reportFailure(title, refusal);
          throw refusal;
        }
        try {
          return await run(input);
        } catch (error) {
          reportFailure(title, error);
          throw error;
        }
      },
    [reportFailure, canMutate, readState],
  );

  const createIdentityFromMention = useMemo(
    () => guard<CreateIdentityFromMentionInput, string>("Could not create the identity", (input) => createMutation.mutateAsync(input)),
    [guard, createMutation],
  );

  const linkMention = useMemo(
    () => guard<LinkMentionInput, void>("Could not link the author", (input) => linkMutation.mutateAsync(input)),
    [guard, linkMutation],
  );

  const unlinkMentionGuarded = useMemo(
    () => guard<{ paperId: string; authorIndex: number }, void>("Could not unlink the author", (input) => unlinkMutation.mutateAsync(input)),
    [guard, unlinkMutation],
  );

  const renameIdentityGuarded = useMemo(
    () => guard<{ identityId: string; preferredName: string }, void>("Could not rename the identity", (input) => renameMutation.mutateAsync(input)),
    [guard, renameMutation],
  );

  const addAliasGuarded = useMemo(
    () => guard<{ identityId: string; alias: string }, void>("Could not add the alias", (input) => addAliasMutation.mutateAsync(input)),
    [guard, addAliasMutation],
  );

  const removeAliasGuarded = useMemo(
    () => guard<string, void>("Could not remove the alias", (input) => removeAliasMutation.mutateAsync(input)),
    [guard, removeAliasMutation],
  );

  const mergeGuarded = useMemo(
    () => guard<{ sourceIdentityId: string; targetIdentityId: string }, void>("Could not merge the identities", (input) => mergeMutation.mutateAsync(input)),
    [guard, mergeMutation],
  );

  const unmergeGuarded = useMemo(
    () => guard<string, void>("Could not undo the merge", (input) => unmergeMutation.mutateAsync(input)),
    [guard, unmergeMutation],
  );

  const deleteGuarded = useMemo(
    () => guard<string, void>("Could not delete the identity", (input) => deleteMutation.mutateAsync(input)),
    [guard, deleteMutation],
  );

  return {
    dataset,
    // Withheld unless the graph they explain is trustworthy. Evidence beside a
    // dataset that failed to load would describe a person the caller cannot see.
    linkedPapers:
      readState === "ready" || readState === "stale"
        ? (query.data?.linkedPapers ?? NO_LINKED_PAPERS)
        : NO_LINKED_PAPERS,
    readState,
    canMutate,
    retry,
    isLoading: query.isLoading,
    isUnavailable,
    error: readError,
    refresh: invalidate,

    createIdentityFromMention,
    linkMention,
    unlinkMention: useCallback(
      (paperId: string, authorIndex: number) => unlinkMentionGuarded({ paperId, authorIndex }),
      [unlinkMentionGuarded],
    ),
    renameIdentity: useCallback(
      (identityId: string, preferredName: string) => renameIdentityGuarded({ identityId, preferredName }),
      [renameIdentityGuarded],
    ),
    addAlias: useCallback(
      (identityId: string, alias: string) => addAliasGuarded({ identityId, alias }),
      [addAliasGuarded],
    ),
    removeAlias: removeAliasGuarded,
    mergeIdentities: useCallback(
      (sourceIdentityId: string, targetIdentityId: string) => mergeGuarded({ sourceIdentityId, targetIdentityId }),
      [mergeGuarded],
    ),
    unmergeIdentity: unmergeGuarded,
    deleteIdentity: deleteGuarded,

    isMutating:
      createMutation.isPending ||
      linkMutation.isPending ||
      unlinkMutation.isPending ||
      renameMutation.isPending ||
      addAliasMutation.isPending ||
      removeAliasMutation.isPending ||
      mergeMutation.isPending ||
      unmergeMutation.isPending ||
      deleteMutation.isPending,
  };
}
