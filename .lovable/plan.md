

# Plan: Specificity Weight System for Study Types

## 1. Database Migration

Add `specificity_weight` column to `study_type_pool` and add an UPDATE RLS policy (currently missing):

```sql
ALTER TABLE public.study_type_pool
  ADD COLUMN specificity_weight INTEGER NOT NULL DEFAULT 1;

CREATE POLICY "Users can update own study type pool"
  ON public.study_type_pool FOR UPDATE
  USING (auth.uid() = user_id);
```

## 2. Hook: `useStudyTypePool.ts`

- Update `PoolStudyType` interface to include `specificity_weight: number`
- Add `updateStudyTypeWeight(id: string, weight: number)` method that calls `.update({ specificity_weight })` on the table
- Update `findMatchingStudyTypes` to return `{ study_type: string, specificity_weight: number }[]` instead of `string[]`
- Use regex word boundary matching (`new RegExp('\\b' + escapeRegex(st) + '\\b', 'i')`) instead of simple `includes()`
- Update `addStudyType` to accept optional weight parameter

## 3. UI: `StudyTypePoolSection.tsx`

- Add a small number input (width ~50px) next to each study type badge showing its `specificity_weight`
- On change, call the new `updateStudyTypeWeight` method
- Add `onUpdateStudyTypeWeight` prop to the component

## 4. Business Logic: `PaperList.tsx`

Replace `deduplicateBySpecificity()` with weight-based logic:

- Update `findMatchingStudyTypes` prop type to return `{ study_type: string, specificity_weight: number }[]`
- For Publication Types from the API, assign default weight of 1 unless they exactly match a pool term (use pool's weight)
- For title matches, use the pool's `specificity_weight`
- **Override rule**: Group by normalized name. If a title match has higher weight than an API type, replace API type with title match
- **Sort**: By `specificity_weight` descending, then alphabetical
- Keep existing quick-exclude buttons, tooltip, and styling intact

## 5. Dashboard.tsx

- Pass new `updateStudyTypeWeight` to Sidebar → StudyTypePoolSection
- Update `findMatchingStudyTypes` usage (now returns objects with weights)

## Files Modified

| File | Change |
|------|--------|
| `study_type_pool` table | Add `specificity_weight` column + UPDATE policy |
| `src/hooks/useStudyTypePool.ts` | Add weight field, update method, regex matching, return weighted objects |
| `src/components/study-types/StudyTypePoolSection.tsx` | Add weight input per badge, new prop |
| `src/components/papers/PaperList.tsx` | Weight-based override & sorting logic |
| `src/pages/Dashboard.tsx` | Wire new props through |
| `src/components/layout/Sidebar.tsx` | Pass through new weight update prop |

