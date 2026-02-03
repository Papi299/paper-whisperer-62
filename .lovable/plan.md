
## What’s happening (root cause)
Right now the Study Type cell logic works like this:
- Take the full `paper.study_type` string (often a comma-separated list)
- If it contains any excluded study type term, the UI replaces the entire Study Type cell with `"-"`

So when you exclude **“Journal Article”**, and a paper has:
- `Journal Article, Randomized Controlled Trial, Multicenter Study`

…the code detects the excluded term and hides the whole Study Type field, instead of removing only that one item.

## Goal
Make study type exclusions **display-level and item-level**:
- Only remove the excluded study type(s) from the displayed list
- Keep the remaining study types visible
- Keep the hover tooltip showing the full remaining (non-excluded) list

Example:
- Excluded: `Journal Article`
- Paper study types: `Journal Article, Randomized Controlled Trial, Multicenter Study`
- Display: `Randomized Controlled Trial, Multicenter Study`

If all study types are excluded, display `"-"`.

---

## Implementation approach (no backend/schema changes)
### 1) Update Study Type display logic in `src/components/papers/PaperList.tsx`
Replace the current “if any excluded term exists => show '-'” logic with:
1. Parse the study type string into individual items (tokens)
   - Split on commas and semicolons: `/,|;/` (more robust: `/[,;]+/`)
   - Trim whitespace
   - Remove empty tokens
2. Filter tokens against excluded study types (case-insensitive)
   - Preferred behavior: exclude token when it matches an excluded term exactly
   - Add a safe fallback: also exclude token if it *contains* an excluded term (helps with cases like parentheses or extra text), but still only removes that token, not the whole field
3. Join remaining tokens back into a string for display: `kept.join(", ")`
4. Render:
   - If result is empty => `"-"`
   - Else show truncated display + tooltip containing the full kept string

Proposed helper (inside `PaperList.tsx`, near `getCombinedKeywords`):
- `getDisplayStudyType(studyType: string | null | undefined): string | null`
  - returns the filtered string or `null` if nothing should display

### 2) Keep tooltip behavior, but show filtered (remaining) study types
Update tooltip content + trigger text to use:
- `displayStudyType` (filtered)
instead of:
- `paper.study_type` (original)

This ensures the tooltip matches what’s actually displayed.

---

## Edge cases to handle
- `paper.study_type` is `null`/empty → show `"-"`
- Excluded set is empty → show original study type string unchanged
- Study type string has no commas/semicolons (single type) → treat as one token
- Extra spacing variations → normalization via `trim()` + lowercase comparison
- If excluded term is a substring of another token:
  - We will only remove tokens that match exactly, plus optional fallback `includes` matching for “token contains excluded term” (still token-level only)

If you want *only exact matches* and never substring matching, we can set it to exact-only; I’ll implement it with exact-first + substring fallback to be resilient, but I’ll keep it clearly isolated so it’s easy to adjust.

---

## Files to change
- `src/components/papers/PaperList.tsx`
  - Replace the current Study Type exclusion IIFE logic with token-based filtering
  - Tooltip uses filtered string

No changes needed in:
- `src/hooks/useExclusionPools.ts` (already provides `getExcludedStudyTypeSet()` as lowercase)
- `src/pages/Dashboard.tsx` (already passes the set into `PaperList`)

---

## Acceptance criteria (what you should see)
1. Add excluded study type: `Journal Article`
2. A paper with `Journal Article, Randomized Controlled Trial, Multicenter Study` shows:
   - `Randomized Controlled Trial, Multicenter Study` (not `"-"`)
3. Hovering over Study Type shows tooltip with the full remaining list (non-truncated)
4. If a paper has only `Journal Article`, it becomes `"-"`

---

## Quick test checklist (end-to-end)
- Add an excluded study type
- Confirm the sidebar exclusion badge appears
- Confirm the table updates immediately (no refresh needed)
- Confirm only the excluded token disappears, not the entire Study Type field
- Confirm tooltip shows the remaining list
