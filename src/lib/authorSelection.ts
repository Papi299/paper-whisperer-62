/**
 * Keeping an Analytics author selection meaningful while the author graph moves
 * underneath it.
 *
 * THE PROBLEM
 * ─────────────────────────────────────────────────────────────────────────────
 * Analytics lets a user pick authors to compare. Before 001C an author was a
 * textual mention and nothing could change what it referred to. After 001C the
 * same screen can, in the same session, turn a mention into a person (Link),
 * turn two people into one (Merge), turn them back (Unmerge, Unlink), and
 * discover the whole identity graph late (the dataset finishing its first load
 * while the user is already selecting from the 001A fallback).
 *
 * A selection stored as a bare key survives none of that. Link a selected
 * mention and the stored `mention:…` names something that no longer exists.
 * Merge a selected identity into another and the stored `identity:A` points at
 * an identity that is no longer anybody's root. Both cases render the same way:
 * a badge that counts zero papers, sitting next to the option the user actually
 * meant. Neither is a filter result — it is the selection quietly losing its
 * referent.
 *
 * THE SHAPE OF THE FIX
 * ─────────────────────────────────────────────────────────────────────────────
 * Three things that were one string are separated here:
 *
 *   * the **stored key** — what the user picked, never rewritten;
 *   * the **effective entity key** — where that resolves right now;
 *   * the **label** — what a human reads.
 *
 * Reconciliation happens on READ, every render, from the current resolution.
 * Nothing is migrated in place, and that is the load-bearing decision: because
 * the stored key still says `identity:A`, undoing the merge that sent A into B
 * restores the selection to A by itself, with no undo bookkeeping anywhere. A
 * layer that rewrote state on merge would have had to remember what to put back.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────────────
 * It asserts no identity. Every transition it follows is one the USER already
 * made — a link they clicked, a merge they confirmed. It never decides that two
 * entities are the same person in order to keep a selection tidy; where a
 * transition is genuinely ambiguous it keeps every descendant instead of
 * choosing one. See `reconcileAuthorSelections`.
 *
 * Pure, no I/O, no React. Linear in selections plus mentions.
 */

import {
  identityEntityKey,
  mentionEntityKey,
  mentionSlotKey,
  toAuthorEntityKey,
  type AuthorEntity,
  type AuthorIdentityResolution,
} from "./authorIdentity";

/**
 * One author the user picked, as held in session state.
 *
 * The label is stored alongside the key for one narrow but non-negotiable
 * purpose: it is the last-resort way to describe a selection whose entity has
 * left the current view entirely. Internal keys (`identity:<uuid>`,
 * `mention:<001A key>`) must never reach the screen, and without a remembered
 * label a filtered-away mention would have nothing else to show.
 *
 * It is a fallback, never a source of truth. A live label always wins, which is
 * what makes a rename follow through to the badge.
 */
export interface AuthorTargetSelection {
  /** `identity:<id>` or `mention:<001A key>`. Stable; never rewritten. */
  key: string;
  /** The label at the moment of selection. */
  label: string;
}

/** One selection, resolved against the current author graph. */
export interface ReconciledAuthorSelection {
  /** Where this selection points right now. Matches an option's `value`. */
  entityKey: string;
  /** What to display. Guaranteed to be human-readable, never an internal key. */
  label: string;
  /**
   * Every stored key that resolves here. More than one when separate selections
   * converged — two identities the user later merged, say — and removing this
   * badge must remove all of them or it would reappear.
   */
  storedKeys: readonly string[];
  /** Papers in the CURRENT view for this entity. Zero when it is out of view. */
  documentCount: number;
  /** Whether anything in the current view still represents this entity. */
  present: boolean;
}

const IDENTITY_PREFIX = "identity:";
const MENTION_PREFIX = "mention:";

/** Current entity key for one authorship position: the person, else the text. */
function entityKeyForSlot(resolution: AuthorIdentityResolution, slot: string, mentionKey: string) {
  const link = resolution.linkBySlot.get(slot);
  if (!link) return mentionEntityKey(mentionKey);
  const root = resolution.rootOf.get(link.identity_id) ?? link.identity_id;
  return identityEntityKey(root);
}

/**
 * Where each 001A mention key currently lands, in first-encounter order.
 *
 * A single textual mention key can be spread across many papers, and the user
 * may have resolved some of those positions and not others. That makes the
 * link transition a one-to-MANY mapping, which is exactly why it needs a
 * documented policy rather than a lookup.
 */
function descendantsByMentionKey(
  resolution: AuthorIdentityResolution,
): Map<string, string[]> {
  const descendants = new Map<string, string[]>();
  for (const mention of resolution.mentions) {
    if (!mention.mentionKey) continue;
    const slot = mentionSlotKey(mention.paperId, mention.authorIndex);
    const entityKey = entityKeyForSlot(resolution, slot, mention.mentionKey);
    const list = descendants.get(mention.mentionKey);
    if (!list) descendants.set(mention.mentionKey, [entityKey]);
    else if (!list.includes(entityKey)) list.push(entityKey);
  }
  return descendants;
}

/**
 * Resolve stored selections against the current author graph.
 *
 * THE POLICY, CASE BY CASE
 *
 * **Identity renamed.** The key is unchanged and the label is read live from the
 * cluster, so the badge follows the new name. Nothing special happens; this
 * already worked and keeps working.
 *
 * **Identity merged away.** `identity:A` with `A → B` resolves to `identity:B`,
 * because B is what A now *is* for grouping purposes. The stored key stays A.
 *
 * **Merge undone.** `A → B` disappears, so `identity:A` resolves to itself
 * again. This falls out of never rewriting the stored key; there is no separate
 * undo path to get wrong.
 *
 * **Mention linked.** `mention:k` resolves to wherever the positions spelling
 * `k` currently land. If the user linked all of them to one person, that is one
 * identity and the selection follows it cleanly.
 *
 * **Mention linked AMBIGUOUSLY — the case that needs a stated policy.** The same
 * spelling can occur on many papers, and the user may have linked some of those
 * positions to person X, others to person Y, and left the rest alone. The
 * previous selection meant "these papers". So the selection expands to EVERY
 * descendant — `identity:X`, `identity:Y` and the still-unresolved `mention:k` —
 * which preserves precisely the paper set the user had selected.
 *
 * Choosing one descendant instead would be this module deciding which person the
 * user meant, from evidence that says they meant more than one. That is the
 * silent assertion the whole feature refuses to make, so it is not made here to
 * tidy up a badge.
 *
 * **Identity dataset arriving late.** A selection made against the 001A fallback
 * is a `mention:` key, and the link case above reconciles it the moment real
 * data lands. No load-order special case exists because none is needed.
 *
 * **Entity out of view.** Filtered away, unlinked to nothing, or deleted: the
 * selection is kept so the user can still see and remove it, with
 * `documentCount: 0` and `present: false`. Its label comes from the live cluster
 * when there is one (an identity always has a name, whatever the filter shows)
 * and otherwise from the remembered label.
 *
 * **No label available at all.** Only reachable from state written by something
 * other than this module. The selection is dropped rather than rendered, because
 * the one thing that must never happen is a raw key appearing on screen.
 */
export function reconcileAuthorSelections(
  selections: readonly AuthorTargetSelection[],
  entities: readonly AuthorEntity[],
  resolution: AuthorIdentityResolution,
): ReconciledAuthorSelection[] {
  const entityByKey = new Map(entities.map((entity) => [entity.key, entity]));
  const descendants = descendantsByMentionKey(resolution);

  // Effective key → the entry being accumulated, so two stored keys that
  // converge produce one badge carrying both.
  const merged = new Map<string, { label: string; storedKeys: string[] }>();

  for (const selection of selections) {
    const stored = selection.key;
    // Folds a legacy raw author label — a value that predates entity keys — into
    // the mention key it always meant.
    const normalized = toAuthorEntityKey(stored);

    let targets: string[];
    if (normalized.startsWith(IDENTITY_PREFIX)) {
      const identityId = normalized.slice(IDENTITY_PREFIX.length);
      const root = resolution.rootOf.get(identityId) ?? identityId;
      targets = [identityEntityKey(root)];
    } else if (normalized.startsWith(MENTION_PREFIX)) {
      const mentionKey = normalized.slice(MENTION_PREFIX.length);
      // No position in view spells this any more; the selection stands where it
      // was rather than dissolving.
      targets = descendants.get(mentionKey) ?? [normalized];
    } else {
      targets = [normalized];
    }

    for (const entityKey of targets) {
      const existing = merged.get(entityKey);
      if (existing) {
        if (!existing.storedKeys.includes(stored)) existing.storedKeys.push(stored);
        continue;
      }
      merged.set(entityKey, { label: selection.label, storedKeys: [stored] });
    }
  }

  const reconciled: ReconciledAuthorSelection[] = [];

  for (const [entityKey, entry] of merged) {
    const entity = entityByKey.get(entityKey);

    // Live label first — that is what makes a rename, or a spelling change in
    // the representative mention, reach the badge. The remembered label is only
    // consulted when nothing current can supply one.
    let label = entity?.label ?? "";
    if (!label && entityKey.startsWith(IDENTITY_PREFIX)) {
      const rootId = entityKey.slice(IDENTITY_PREFIX.length);
      label = resolution.clusters.get(rootId)?.preferredName ?? "";
    }
    if (!label) label = entry.label ?? "";
    // A selection with nothing readable to show is not rendered. Displaying the
    // key instead is the one outcome that is never acceptable.
    if (!label.trim()) continue;

    reconciled.push({
      entityKey,
      label,
      storedKeys: entry.storedKeys,
      documentCount: entity?.documentCount ?? 0,
      present: entity !== undefined,
    });
  }

  return reconciled;
}

/**
 * Add or remove one author target, given what the selections currently resolve
 * to.
 *
 * Adding stores the entity key the user actually clicked, together with the
 * label they read. Removing deletes every stored key that resolves to the
 * removed entity — otherwise a converged selection would come straight back.
 *
 * The subtle half is the second loop. When a stored key has expanded into
 * several descendants (one spelling the user resolved two different ways), those
 * descendants share stored keys. Removing one badge would take its siblings with
 * it, so each surviving sibling is first pinned to its own explicit key. The
 * user removes what they pointed at and keeps what they did not, which is the
 * only behaviour that reads as correct from outside.
 */
export function toggleAuthorSelection(
  selections: readonly AuthorTargetSelection[],
  reconciled: readonly ReconciledAuthorSelection[],
  target: AuthorTargetSelection,
): AuthorTargetSelection[] {
  const hit = reconciled.find((entry) => entry.entityKey === target.key);
  if (!hit) return [...selections, { key: target.key, label: target.label }];

  const removing = new Set(hit.storedKeys);
  const kept = selections.filter((selection) => !removing.has(selection.key));

  const pinned: AuthorTargetSelection[] = [];
  for (const entry of reconciled) {
    if (entry.entityKey === hit.entityKey) continue;
    // Survives on its own already.
    if (entry.storedKeys.some((key) => !removing.has(key))) continue;
    pinned.push({ key: entry.entityKey, label: entry.label });
  }

  return [...kept, ...pinned];
}
