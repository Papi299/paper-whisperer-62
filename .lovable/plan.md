

# Implementation Plan: Keyword Display Exclusion, Study Type Tooltip, and Manual Study Type Input

## Summary of Changes

This plan addresses three related improvements to the paper table and exclusion system:

1. **Change how keyword exclusion works** - Instead of hiding entire paper rows, only hide the excluded keywords from appearing in the Keywords column
2. **Add study type tooltip** - Show the full study type text when hovering over the badge
3. **Allow manual study type exclusion input** - Replace the dropdown with a text input field

---

## Change 1: Keyword Exclusion Displays Only (Not Row Filtering)

### Current Behavior
When you add a keyword to the exclusion pool, any paper containing that keyword is completely hidden from the table.

### New Behavior
Papers will remain visible, but excluded keywords will not appear in the Keywords column display.

### Technical Changes

**File: `src/hooks/useExclusionPools.ts`**
- Rename `shouldExcludePaper` to `shouldExcludeKeyword` 
- Add a new helper function `isKeywordExcluded(keyword: string)` that checks if a single keyword is in the exclusion list
- Keep the study type exclusion logic for hiding entire papers (since that still makes sense)

**File: `src/pages/Dashboard.tsx`**
- Remove the keyword exclusion check from the paper filtering logic
- Keep study type exclusion check (entire paper is hidden if study type is excluded)
- Pass the list of excluded keywords to PaperList for display filtering

**File: `src/components/papers/PaperList.tsx`**
- Add a new prop: `excludedKeywords: string[]`
- Filter out excluded keywords from `getCombinedKeywords` before displaying them
- Keywords that match the exclusion list will simply not appear in the cell or tooltip

---

## Change 2: Study Type Tooltip

### Technical Changes

**File: `src/components/papers/PaperList.tsx`**
- Wrap the study type cell content with `TooltipProvider`, `Tooltip`, `TooltipTrigger`, and `TooltipContent`
- When hovering over the study type badge, show the full untruncated text

---

## Change 3: Manual Study Type Exclusion Input

### Current Behavior
Users can only select study types from a predefined dropdown list.

### New Behavior
Users can type any study type text manually (similar to keyword exclusion input).

### Technical Changes

**File: `src/components/exclusions/ExclusionPoolsSection.tsx`**
- Replace the `Select` component with an `Input` component
- Add state for `newStudyType` text input
- Handle Enter key and button click to add the typed study type
- Remove the `STUDY_TYPES` constant and dropdown logic

---

## Technical Details

### Updated `useExclusionPools.ts` Logic

```text
// New helper function
isKeywordExcluded(keyword: string): boolean
  - Returns true if keyword (case-insensitive) is in excludedKeywords list

// Updated shouldExcludePaper - only checks study type now
shouldExcludePaper(studyType: string | null): boolean
  - Only returns true if the study type is in excludedStudyTypes
  - No longer checks keywords (keywords are filtered at display level)
```

### Updated PaperList Props

```text
interface PaperListProps {
  ...existing props...
  excludedKeywords: string[];  // New prop for display filtering
}
```

### Keyword Filtering in getCombinedKeywords

The function will filter out any keywords whose normalized lowercase form matches an excluded keyword before returning the display list.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/hooks/useExclusionPools.ts` | Add `isKeywordExcluded`, update `shouldExcludePaper` to only check study types |
| `src/pages/Dashboard.tsx` | Remove keyword check from filtering, pass `excludedKeywords` to PaperList |
| `src/components/papers/PaperList.tsx` | Add `excludedKeywords` prop, filter keywords in display, add study type tooltip |
| `src/components/exclusions/ExclusionPoolsSection.tsx` | Replace Select with Input for study type exclusion |

