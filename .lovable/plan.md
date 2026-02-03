

# Implementation Plan: Quick-Exclude Keywords, Edit Projects/Tags, Study Type Pool with Title Matching

## Summary

This plan addresses four features:
1. **Quick-exclude button for keywords** - Add an "X" button to each keyword badge (similar to study types)
2. **Fix Edit functionality for Projects and Tags** - Create missing edit dialogs that are triggered but never rendered
3. **Study Type Interest Pool** - A new pool for manually adding study types of interest
4. **Title-based Study Type Detection** - Match study types from the pool against paper titles and combine with Publication Types

---

## Issue 1: Projects/Tags Edit Not Working

### Root Cause
In `Dashboard.tsx`, clicking "Edit" on a project or tag sets state:
- `setEditingProject(p)` / `setEditingTag(t)`

However, **no edit dialogs exist** to consume these states. The states are set but never rendered anywhere in the UI.

### Solution
Create `EditProjectDialog` and `EditTagDialog` components, and render them in Dashboard.

---

## Issue 2: Quick-Exclude Button for Keywords

### Current State
Keywords are displayed as badges without any quick-exclude functionality. Users must go to the sidebar exclusion pool to type in keywords manually.

### Solution
Add an "X" button to each keyword badge (matching the study type pattern), passing `onExcludeKeyword` prop from Dashboard.

---

## Issue 3: Study Type Interest Pool

### Requirements
1. Create a new pool for "Study Types of Interest" (similar to Keyword Pool)
2. Store in a new database table: `study_type_pool`
3. Match study types from the pool against paper **titles**
4. Combine detected study types with existing Publication Types
5. Handle duplicates: show each study type only once
6. Handle specificity: if title has "Systematic Review of Randomized Controlled Trials" and Publication Type has "Systematic Review", show the more specific one from the title

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/components/projects/EditProjectDialog.tsx` | Dialog to edit project name, description, color |
| `src/components/tags/EditTagDialog.tsx` | Dialog to edit tag name and color |
| `src/components/study-types/StudyTypePoolSection.tsx` | Sidebar section for managing study type interest pool |
| `src/hooks/useStudyTypePool.ts` | Hook for CRUD operations on study type pool |

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/pages/Dashboard.tsx` | Render EditProjectDialog, EditTagDialog; pass keyword exclusion to PaperList; integrate study type pool |
| `src/components/papers/PaperList.tsx` | Add quick-exclude button to keywords; integrate title-based study type detection |
| `src/components/layout/Sidebar.tsx` | Add StudyTypePoolSection |

---

## Database Migration

Create `study_type_pool` table:

```sql
CREATE TABLE public.study_type_pool (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  study_type TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.study_type_pool ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Users can view own study type pool"
  ON public.study_type_pool FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own study type pool"
  ON public.study_type_pool FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own study type pool"
  ON public.study_type_pool FOR DELETE
  USING (auth.uid() = user_id);

-- Unique constraint
CREATE UNIQUE INDEX study_type_pool_user_study_type_idx
  ON public.study_type_pool (user_id, lower(study_type));
```

---

## Technical Details

### 1. Quick-Exclude for Keywords

**PaperList.tsx changes:**
- Add `onExcludeKeyword: (keyword: string) => Promise<boolean>` to props
- Wrap each keyword badge with a group/hover button similar to study types:

```text
<Badge className="group/badge hover:pr-1">
  {displayName}
  <button
    onClick={() => onExcludeKeyword(keyword)}
    className="ml-1 opacity-0 group-hover/badge:opacity-100"
  >
    <X className="h-3 w-3" />
  </button>
</Badge>
```

### 2. EditProjectDialog

Simple dialog with:
- Name input (required)
- Description textarea (optional)
- Color picker (hex input or preset colors)
- Save/Cancel buttons
- Calls `updateProject(projectId, { name, description, color })`

### 3. EditTagDialog

Simple dialog with:
- Name input (required)
- Color picker
- Save/Cancel buttons
- Calls `updateTag(tagId, { name, color })`

### 4. Study Type Pool Hook (`useStudyTypePool.ts`)

```text
interface PoolStudyType {
  id: string;
  user_id: string;
  study_type: string;
  created_at: string;
}

Returns:
- poolStudyTypes: PoolStudyType[]
- addStudyType(studyType: string): Promise<boolean>
- addMultipleStudyTypes(studyTypes: string[]): Promise<number>
- deleteStudyType(id: string): Promise<void>
- deleteAllStudyTypes(): Promise<void>
- findMatchingStudyTypes(title: string): string[]
```

### 5. Title-Based Study Type Detection

**Logic in PaperList.tsx:**

```text
function getCombinedStudyTypes(paper, poolStudyTypes) {
  // 1. Get study types from Publication Types (existing)
  const publicationTypes = paper.study_type
    ?.split(/[,;]+/)
    .map(t => t.trim())
    .filter(Boolean) || [];

  // 2. Find matching study types from pool in title
  const titleMatches = poolStudyTypes
    .filter(st => paper.title.toLowerCase().includes(st.toLowerCase()))
    .map(st => st);

  // 3. Combine and deduplicate
  const allTypes = [...titleMatches, ...publicationTypes];
  
  // 4. Handle specificity - prefer longer/more specific matches
  const result = deduplicateBySpecificity(allTypes);
  
  return result;
}

function deduplicateBySpecificity(types) {
  // Sort by length descending (longer = more specific)
  const sorted = [...types].sort((a, b) => b.length - a.length);
  const result = [];
  
  for (const type of sorted) {
    const lowerType = type.toLowerCase();
    // Add if no existing result contains this type as a substring
    // AND this type doesn't contain any existing result as substring
    const isDuplicate = result.some(existing => {
      const lowerExisting = existing.toLowerCase();
      return lowerExisting.includes(lowerType) || lowerType.includes(lowerExisting);
    });
    if (!isDuplicate) {
      result.push(type);
    }
  }
  
  return result;
}
```

**Example:**
- Pool contains: `["Systematic Review", "Randomized Controlled Trial", "Meta-Analysis"]`
- Paper title: "Efficacy of GLP-1 Agonists: A Systematic Review of Randomized Controlled Trials"
- Publication Type: "Systematic Review"

Detection:
1. Title matches: "Systematic Review of Randomized Controlled Trials" (matched via "Systematic Review" and "Randomized Controlled Trial")
2. Wait - the pool items are individual terms. Let me refine:

**Refined Logic:**
- Match pool study types against the title
- For specificity: if both "Systematic Review" appears in title AND in Publication Type, keep the one that's part of a longer phrase

Actually, the specificity should work like this:
- Title: "...Systematic Review of Randomized Controlled Trials..."
- Publication Type: "Systematic Review"
- Pool: ["Systematic Review", "Randomized Controlled Trial"]

From title, we find "Systematic Review" and "Randomized Controlled Trial" as matches.
From Publication Type: "Systematic Review"

When combining:
- "Systematic Review" appears twice - dedupe to one
- "Randomized Controlled Trial" from title stays
- Result: ["Systematic Review", "Randomized Controlled Trial"]

For the case where title has MORE context (like "Systematic Review of Randomized Controlled Trials" as a continuous phrase), we'd need phrase matching. For simplicity, we'll match individual pool terms and deduplicate.

### 6. StudyTypePoolSection Component

Similar to KeywordPoolSection:
- Collapsible section in sidebar
- Add single study type
- Add multiple study types (bulk)
- Import from existing papers (extract unique Publication Types)
- Clear all
- Display as badges with delete buttons

---

## Visual Design

### Keywords Cell (with quick-exclude)
```
[Cholesterol x] [Diabetes x] [GLP-1 ★ x] [HDL x]
```
Each keyword now shows an "x" on hover to quick-exclude.

### Study Type Pool (sidebar)
```
[v] Study Type Pool (3)
    [Randomized Controlled Trial x]
    [Meta-Analysis x]
    [Cohort Study x]
```

### Study Type Cell (with title matches)
Study types from title detection are styled differently (e.g., with a "T" icon for "from title"):
```
[T: Randomized Controlled Trial ×] [Meta-Analysis ×]
```
- Pool matches from title: cyan/teal color with title indicator
- Publication Types: default outline style

---

## Acceptance Criteria

1. **Quick-exclude keywords**
   - Hover over a keyword shows "×" button
   - Clicking "×" adds keyword to exclusion pool
   - Keyword disappears from display

2. **Edit Projects**
   - Click Edit on project dropdown opens dialog
   - Can change name, description, color
   - Save updates the project

3. **Edit Tags**
   - Click Edit on tag dropdown opens dialog
   - Can change name and color
   - Save updates the tag

4. **Study Type Pool**
   - Can add study types of interest manually
   - Study types from pool matched against paper titles appear in Study Type column
   - Title matches combined with Publication Types
   - Duplicates are removed (prefer more specific versions)
   - Excluded study types still hidden from display

---

## Test Checklist

- Add a keyword exclusion via quick-exclude button
- Verify keyword disappears immediately
- Edit a project name and verify it updates in sidebar
- Edit a tag color and verify it updates
- Add "Randomized Controlled Trial" to study type pool
- Add a paper with that phrase in the title
- Verify the study type appears even if Publication Type is empty
- Add a paper with "Systematic Review" in Publication Type and "Systematic Review of RCTs" in title
- Verify only the more specific version appears

