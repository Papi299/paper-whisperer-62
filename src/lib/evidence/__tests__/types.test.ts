import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { Database } from "@/integrations/supabase/types";
import type { FieldKey, StudyFieldKey } from "../fieldDictionary";
import { toPaperId, toStudyId, type PaperId, type StudyId } from "../ids";
import type { EvidenceRpcClient } from "../lifecycleClient";
import type { CreateStudyArgs, DeleteStudyArgs, SetLinkArgs, UpdateStudyArgs } from "../lifecycleRequests";
import { locateQuote, type QuoteOccurrence } from "../matcher";
import type { CodePointOffset, Utf16Offset } from "../normalization";
import type { EvidenceFieldValueRow, Narrow, ServerAttestedMatch } from "../types";

/**
 * Type-level contracts. Checked by `npm run typecheck` (tsconfig.app.json
 * includes test files): each `@ts-expect-error` must still be an error, or the
 * typecheck fails with TS2578, so these are tested in both directions.
 */

type Functions = Database["public"]["Functions"];

describe("type-level contracts", () => {
  it("keeps a study, a paper and a plain string apart", () => {
    const study = toStudyId("50000000-0000-4000-8000-000000000001") as StudyId;
    const paper = toPaperId("a0000000-0000-4000-8000-000000000001") as PaperId;
    const takesStudy = (id: StudyId) => id;
    expect(takesStudy(study)).toBe(study);
    // @ts-expect-error a paper id is not a study id
    takesStudy(paper);
    // @ts-expect-error an unchecked string is not a study id
    takesStudy("50000000-0000-4000-8000-000000000001");
  });

  it("keeps code point offsets and UTF-16 offsets apart", () => {
    const takesCodePoints = (offset: CodePointOffset) => offset;
    const utf16 = 3 as Utf16Offset;
    // @ts-expect-error a UTF-16 index is not a PostgreSQL character offset
    takesCodePoints(utf16);
    // @ts-expect-error a bare number has no unit
    takesCodePoints(3);
    expect(takesCodePoints(3 as CodePointOffset)).toBe(3);
  });

  it("never lets an advisory browser match pass as a server-attested one", () => {
    const match = locateQuote("type 2 diabetes", "Adults with type 2 diabetes.");
    const takesServerMatch = (m: ServerAttestedMatch) => m;
    expectTypeOf<QuoteOccurrence>().not.toExtend<ServerAttestedMatch>();
    if (match.kind === "unique") {
      // @ts-expect-error an advisory occurrence is not a server match
      takesServerMatch(match.occurrences[0]);
    }
    expect(match.attestation).toBe("browser_advisory");
  });

  it("uses the generated RPC argument types, widening only p_notes", () => {
    expectTypeOf<CreateStudyArgs>().toEqualTypeOf<Functions["evidence_create_study_from_paper"]["Args"]>();
    expectTypeOf<SetLinkArgs>().toEqualTypeOf<Functions["evidence_set_link"]["Args"]>();
    expectTypeOf<DeleteStudyArgs>().toEqualTypeOf<Functions["evidence_delete_study"]["Args"]>();
    expectTypeOf<Omit<UpdateStudyArgs, "p_notes">>().toEqualTypeOf<Omit<Functions["evidence_update_study"]["Args"], "p_notes">>();
    expectTypeOf<UpdateStudyArgs["p_notes"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Functions["evidence_update_study"]["Args"]["p_notes"]>().toEqualTypeOf<string>();
  });

  it("accepts the real Supabase client as the injected one, and nothing without rpc", () => {
    expectTypeOf<SupabaseClient<Database>>().toExtend<EvidenceRpcClient>();
    expectTypeOf<{ from: () => void }>().not.toExtend<EvidenceRpcClient>();
    expectTypeOf<{ rpc: (fn: "search_papers", args: object) => PromiseLike<unknown> }>().not.toExtend<EvidenceRpcClient>();
  });

  it("narrows generated rows, refusing unknown columns and widening", () => {
    expectTypeOf<EvidenceFieldValueRow["field_key"]>().toEqualTypeOf<FieldKey>();
    type Row = { a: string; b: number };
    expectTypeOf<Narrow<Row, { a: "x" }>>().toEqualTypeOf<{ b: number } & { a: "x" }>();
    // @ts-expect-error an override must name an existing column
    type Unknown = Narrow<Row, { c: string }>;
    // @ts-expect-error an override must narrow, not widen
    type Widened = Narrow<Row, { b: number | string }>;
    expect(true).toBe(true);
  });

  it("derives the scope unions from the dictionary", () => {
    expectTypeOf<"n_randomized">().toExtend<StudyFieldKey>();
    expectTypeOf<"duration">().not.toExtend<StudyFieldKey>();
    expectTypeOf<"n_randomized_arm">().not.toExtend<FieldKey>();
  });
});
