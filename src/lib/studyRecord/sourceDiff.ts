/**
 * A bounded word-level comparison of two abstracts (EVIDENCE-RECORDS-001C2C-A):
 * a study record's saved copy and the abstract in the library now. For reading
 * only. It decides nothing — not whether the two say the same thing, not where
 * a quote would be found — and nothing is sent because of it.
 *
 * Both texts are split into tokens: runs of white space, runs of letters,
 * marks and digits (a combining accent stays with its letter), and every other
 * character with the marks that follow it. Joining the tokens gives the text
 * back exactly, so the comparison can always be checked against the originals:
 * the saved copy is every unchanged part plus every removed one, in order, and
 * the library abstract every unchanged part plus every added one.
 *
 * The common start and end are set aside; the middle goes through Myers'
 * O(ND) shortest edit (1986), with a fixed budget: at most `DIFF_MAX_EDITS`
 * tokens inserted or deleted, and at most `DIFF_MAX_STEPS` steps of work in
 * all. Past either, the answer is `too_different`, and the caller shows the
 * two texts in full instead. Two unrelated abstracts have no useful word-level
 * comparison, and the bound keeps the main thread free whatever the input:
 * the measurements behind the numbers are in
 * `docs/evidence-records-study-record-ui.md` §18.
 */

/**
 * The most tokens one comparison inserts or deletes before it gives up: about
 * 750 changed words, far more than a revised abstract shows usefully.
 */
export const DIFF_MAX_EDITS = 1_500;
/**
 * The most steps of work one comparison takes before it gives up: diagonals
 * visited and tokens matched. Measured at 13–19 ms for the slowest inputs (two
 * unrelated 50,000-character abstracts) on a desktop; a phone is a few times
 * slower, and the comparison runs only when the user opens it.
 */
export const DIFF_MAX_STEPS = 1_000_000;

/** White space, a run of letters, marks and digits, or one other character with its marks — every character is in exactly one. */
const TOKEN = /\p{White_Space}+|[\p{L}\p{M}\p{N}\p{Pc}]+|[^\p{White_Space}\p{L}\p{M}\p{N}\p{Pc}]\p{M}*/gu;
const WORD = /^[\p{L}\p{N}]/u;

/** `text` as tokens; their concatenation is `text`. */
export function tokenizeSource(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

export type DiffSegment =
  /** Text in both, as it is in both. */
  | { readonly kind: "same"; readonly text: string }
  /** One changed passage: what only the saved copy has there, and what only the library abstract has. Either may be empty, not both. */
  | { readonly kind: "change"; readonly index: number; readonly removed: string; readonly added: string };

export type SourceDiff =
  | { readonly kind: "identical" }
  | {
      readonly kind: "changes";
      /** In text order. A change never directly follows another: a run of white space between two is part of both. */
      readonly segments: readonly DiffSegment[];
      readonly changeCount: number;
      /** Words (runs starting with a letter or a digit) only in the saved copy, and only in the library abstract. */
      readonly removedWords: number;
      readonly addedWords: number;
    }
  /** More changes than the budget allows, or more work: show the two texts in full. */
  | { readonly kind: "too_different" };

export interface DiffLimits {
  readonly maxEdits: number;
  readonly maxSteps: number;
}

const DEFAULT_LIMITS: DiffLimits = Object.freeze({ maxEdits: DIFF_MAX_EDITS, maxSteps: DIFF_MAX_STEPS });

const SAME = 0;
const REMOVED = 1;
const ADDED = 2;
const NONE = 3;

/**
 * The shortest edit from `a` to `b`, one operation per token in order —
 * SAME, REMOVED (a token of `a`) or ADDED (a token of `b`) — or null past the
 * limits. Greedy forward Myers, keeping each round's furthest points so the
 * path can be read back; a move off the edit grid is never taken.
 */
function shortestEdit(a: Int32Array, b: Int32Array, limits: DiffLimits): Uint8Array | null {
  const n = a.length;
  const m = b.length;
  const maxD = Math.min(n + m, limits.maxEdits);
  const offset = maxD + 1;
  // The furthest x on each diagonal k = x − y, at v[offset + k]; −1 where no path reaches.
  const v = new Int32Array(2 * maxD + 3).fill(-1);
  const rows: Int32Array[] = [];
  const moves: Uint8Array[] = [];
  let steps = 0;
  for (let d = 0; d <= maxD; d++) {
    const row = new Int32Array(d + 1);
    const move = new Uint8Array(d + 1);
    for (let i = 0, k = -d; k <= d; k += 2, i++) {
      let x: number;
      let how: number;
      if (d === 0) {
        x = 0;
        how = NONE;
      } else {
        // Down from diagonal k + 1 (a token of b added), or right from k − 1 (a token of a removed).
        const fromAbove = k < d ? v[offset + k + 1] : -1;
        const fromLeft = k > -d ? v[offset + k - 1] : -1;
        const down = fromAbove >= 0 && fromAbove - k <= m ? fromAbove : -1;
        const right = fromLeft >= 0 && fromLeft + 1 <= n ? fromLeft + 1 : -1;
        if (down < 0 && right < 0) {
          v[offset + k] = -1;
          row[i] = -1;
          move[i] = NONE;
          steps++;
          continue;
        }
        if (down >= right) {
          x = down;
          how = ADDED;
        } else {
          x = right;
          how = REMOVED;
        }
      }
      let y = x - k;
      const start = x;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      // One step for the diagonal, one for each token matched along it.
      steps += x - start + 1;
      if (steps > limits.maxSteps) return null;
      v[offset + k] = x;
      row[i] = x;
      move[i] = how;
      if (x === n && y === m) {
        rows.push(row);
        moves.push(move);
        return readBack(rows, moves, n, m);
      }
    }
    rows.push(row);
    moves.push(move);
  }
  return null;
}

/** The operations of the path that reached (n, m) in the last round of `rows`. */
function readBack(rows: readonly Int32Array[], moves: readonly Uint8Array[], n: number, m: number): Uint8Array {
  const out = new Uint8Array(n + m);
  let at = out.length;
  let x = n;
  let k = n - m;
  for (let d = rows.length - 1; d > 0; d--) {
    const how = moves[d][(k + d) / 2];
    const fromK = how === ADDED ? k + 1 : k - 1;
    const fromX = rows[d - 1][(fromK + d - 1) / 2];
    // After the move, the path stood at x = fromX (down) or fromX + 1 (right), then matched to x.
    const afterMove = how === ADDED ? fromX : fromX + 1;
    for (let s = x - afterMove; s > 0; s--) out[--at] = SAME;
    out[--at] = how;
    x = fromX;
    k = fromK;
  }
  for (let s = x; s > 0; s--) out[--at] = SAME;
  return out.subarray(at);
}

/**
 * Compare a saved copy with the library abstract, within `limits`. Pure and
 * deterministic: the same two texts always give the same answer.
 */
export function diffSourceText(saved: string, library: string, limits: DiffLimits = DEFAULT_LIMITS): SourceDiff {
  if (saved === library) return { kind: "identical" };
  const left = tokenizeSource(saved);
  const right = tokenizeSource(library);

  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;

  // Each distinct token as a number, so the edit compares integers.
  const ids = new Map<string, number>();
  const numbered = (tokens: readonly string[], from: number, to: number) => {
    const out = new Int32Array(to - from);
    for (let i = from; i < to; i++) {
      let id = ids.get(tokens[i]);
      if (id === undefined) {
        id = ids.size;
        ids.set(tokens[i], id);
      }
      out[i - from] = id;
    }
    return out;
  };
  const a = numbered(left, prefix, left.length - suffix);
  const b = numbered(right, prefix, right.length - suffix);
  const ops = shortestEdit(a, b, limits);
  if (ops === null) return { kind: "too_different" };

  const parts: { kind: "same" | "change"; same: string; removed: string; added: string }[] = [];
  const push = (kind: "same" | "change", token: string, side: "same" | "removed" | "added") => {
    const last = parts[parts.length - 1];
    const part = last && last.kind === kind ? last : { kind, same: "", removed: "", added: "" };
    if (part !== last) parts.push(part);
    part[side] += token;
  };
  let removedWords = 0;
  let addedWords = 0;
  for (let i = 0; i < prefix; i++) push("same", left[i], "same");
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    if (op === SAME) {
      push("same", left[prefix + ai], "same");
      ai++;
      bi++;
    } else if (op === REMOVED) {
      const token = left[prefix + ai++];
      if (WORD.test(token)) removedWords++;
      push("change", token, "removed");
    } else {
      const token = right[prefix + bi++];
      if (WORD.test(token)) addedWords++;
      push("change", token, "added");
    }
  }
  for (let i = left.length - suffix; i < left.length; i++) push("same", left[i], "same");

  // A run of white space alone between two changes joins them: both sides keep it, so both texts still read back.
  const merged: typeof parts = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const previous = merged[merged.length - 1];
    const next = parts[i + 1];
    if (part.kind === "same" && previous?.kind === "change" && next?.kind === "change" && /^\p{White_Space}+$/u.test(part.same)) {
      previous.removed += part.same + next.removed;
      previous.added += part.same + next.added;
      i++;
      continue;
    }
    merged.push(part);
  }

  let index = 0;
  const segments: DiffSegment[] = merged.map((part) =>
    part.kind === "same" ? Object.freeze({ kind: "same" as const, text: part.same }) : Object.freeze({ kind: "change" as const, index: index++, removed: part.removed, added: part.added }),
  );
  return { kind: "changes", segments: Object.freeze(segments), changeCount: index, removedWords, addedWords };
}

/** The saved copy (`side` "saved") or the library abstract ("library") read back from a comparison. */
export function readBackSide(segments: readonly DiffSegment[], side: "saved" | "library"): string {
  return segments.map((segment) => (segment.kind === "same" ? segment.text : side === "saved" ? segment.removed : segment.added)).join("");
}
