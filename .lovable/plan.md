

# Implementation Plan: Quick-Exclude Buttons, Full Keywords Display, and PubMed Keywords Integration

## Summary

This plan covers three related improvements:

1. **Quick-exclude button for study types** - Add a small button next to each study type in the table that instantly adds it to the exclusion pool
2. **Display all keywords alphabetically** - Show all keywords in the row instead of truncating to 4, organized alphabetically
3. **Combine PubMed Keywords with MeSH Terms and Substances** - The database already has a `keywords` field (from PubMed's dedicated Keywords section), but it's not being displayed. We'll include these alongside MeSH Terms and Substances

---

## Change 1: Quick-Exclude Button for Study Types

### Current Behavior
Study types are displayed as text. Users must manually type them into the sidebar exclusion input to exclude them.

### New Behavior
Each study type token will have a small "X" button that instantly excludes it when clicked.

### Technical Changes

**File: `src/pages/Dashboard.tsx`**
- Pass `addExcludedStudyType` to `PaperList` as a new prop `onExcludeStudyType`

**File: `src/components/papers/PaperList.tsx`**
- Add `onExcludeStudyType: (studyType: string) => Promise<boolean>` to props interface
- Render each study type token as a `Badge` with an "X" button (using `Ban` or `X` icon from lucide-react)
- Clicking the button calls `onExcludeStudyType(token)` and the UI updates automatically

---

## Change 2: Display All Keywords Alphabetically

### Current Behavior
Only 4 keywords are shown in the cell, with a "+X more" badge for overflow. Keywords are sorted by source priority (pool > mesh > substance).

### New Behavior
Show all keywords in the cell (no truncation), sorted alphabetically by display name.

### Technical Changes

**File: `src/components/papers/PaperList.tsx`**
- Modify `getCombinedKeywords` to sort results alphabetically by `displayName`
- Remove the `.slice(0, 4)` truncation in the cell rendering
- Keep the tooltip for hover to show all keywords in a larger, more readable format
- Add `flex-wrap` styling to allow keywords to flow across multiple lines in the cell

---

## Change 3: Combine PubMed Keywords with MeSH Terms and Substances

### Current State
The database already stores `keywords` (from PubMed's "Keywords:" section), `mesh_terms`, and `substances` as separate arrays. However, the display logic in `getCombinedKeywords` only uses:
- Matched pool keywords (from abstract matching)
- MeSH Terms
- Substances

The `paper.keywords` field is not being included!

### New Behavior
Include `paper.keywords` in the combined display, treating them the same as MeSH Terms with a distinct visual style (purple color).

### Technical Changes

**File: `src/components/papers/PaperList.tsx`**
- Update `getCombinedKeywords` to add a fourth source: `'pubmed'` for keywords from `paper.keywords`
- Add these after pool keywords but before MeSH terms (they're author-designated, so higher priority than MeSH)
- Apply distinct styling: purple color (`border-purple-500/50 text-purple-600 dark:text-purple-400`)

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/pages/Dashboard.tsx` | Pass `addExcludedStudyType` as `onExcludeStudyType` prop to `PaperList` |
| `src/components/papers/PaperList.tsx` | Add quick-exclude buttons, show all keywords alphabetically, include `paper.keywords` in combined display |

---

## Visual Design

### Study Type Cell (with quick-exclude)
```
[Randomized Controlled Trial ×] [Multicenter Study ×]
```
Each token is a badge with a small "×" button. Clicking "×" adds that study type to the exclusion pool.

### Keywords Cell (all keywords, alphabetical)
```
[Cholesterol] [Diabetes] [GLP-1 ★] [HDL] [Insulin] [LDL] [Obesity] ...
```
- Pool keywords: amber with sparkle icon (★)
- PubMed keywords: purple
- MeSH terms: blue
- Substances: green

All displayed in alphabetical order.

---

## Technical Details

### Updated PaperListProps Interface
```text
interface PaperListProps {
  ...existing props...
  onExcludeStudyType: (studyType: string) => Promise<boolean>;
}
```

### Updated getCombinedKeywords Sources
```text
sources (in order of deduplication priority):
1. 'pool' - Matched from keyword pool (amber, sparkle icon)
2. 'pubmed' - From paper.keywords array (purple, new!)
3. 'mesh' - From paper.mesh_terms (blue)
4. 'substance' - From paper.substances (green)
```

### Sorting Logic
After collecting all keywords, sort alphabetically:
```text
result.sort((a, b) => a.displayName.localeCompare(b.displayName))
```

---

## Acceptance Criteria

1. **Quick-exclude study type**
   - Hover over a study type shows a small "×" button
   - Clicking "×" immediately adds that study type to the exclusion pool
   - The study type disappears from the display (but the paper stays visible)

2. **All keywords displayed alphabetically**
   - No "+X more" truncation in the keyword cell
   - Keywords are sorted A-Z by display name
   - Colors remain distinct by source type

3. **PubMed keywords included**
   - Keywords from the dedicated "Keywords:" section in PubMed appear in the combined list
   - They display in purple color to distinguish from MeSH/Substances
   - They are deduplicated against other sources using normalization

---

## Test Checklist

- Add a paper with known keywords from PubMed's Keywords section
- Verify purple-colored keyword badges appear for PubMed keywords
- Verify all keywords are shown (no truncation)
- Verify alphabetical sorting works
- Click "×" on a study type and verify it gets excluded
- Verify the sidebar exclusion badge count increases
- Verify the excluded study type disappears from the paper row

