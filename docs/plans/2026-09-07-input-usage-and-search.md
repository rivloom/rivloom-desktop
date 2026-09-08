# Input Usage and Requirement Search Implementation Plan

> Execute within the user's selected items 2, 3 and 4 using the existing Code, writing-plans and executing-plans workflow. Keep the current checkout and all prior uncommitted work; the user plans overall testing and fixes before Git submission/publication.

**Goal:** Show conversation input capacity, show attachment count/size limits, and find conversations using their saved requirements.

**Architecture:** Add presentation state derived from the existing draft and attachment constants, preserving the current input, upload and task protocols. Search already-loaded user requirements alongside title and source, retaining existing status/source filters. All visible additions use the existing Chinese/English catalogs.

**Tech Stack:** React, TypeScript, i18next, existing Node test lanes, isolated Chromium UI fixture and current Windows/Tauri packaging.

### 1. Input capacity

- Modify `src/conversation-drafts.ts`, `tests/conversation-drafts.test.ts`, `src/conversation-workspace.tsx` and its CSS.
- Derive the current limit from the existing rule: new non-local tasks use 4,000; local or continued conversations use 12,000. Count using the same string-length convention as the existing input limit.
- Display current usage, a warning at 90%, and reached/exceeded feedback. Associate the description with the textarea and announce threshold changes without reading every character count aloud.
- Keep the original draft when changing to a smaller limit; block sending until the user reduces it. Verify boundary values, route changes, continuing conversations, Chinese input and emoji.

### 2. Attachment capacity

- Modify `src/task-files.tsx` and add a small dedicated stylesheet.
- Show single-file maximum, maximum count and total batch maximum before selection; show selected count and bytes afterward. Use the existing shared constants and formatter.
- Include failed files until removed. Reuse the same picker for task inputs and published results, keeping upload, remove, retry and publication behavior intact.
- Verify zero files, multiple/failed files, removal, capacity boundaries and narrow bilingual layouts with synthetic files.

### 3. Requirement search

- Modify `src/conversation-filters.ts` and `tests/conversation-filters.test.ts`.
- Search the user-supplied `description` already in each conversation, including saved supplements, alongside the current title/source fields.
- Do not index engine message envelopes, tool output, model settings or execution summaries. Verify that user-written literal text remains searchable even when it resembles an internal phrase.
- Check combined filters, local/remote/Brain conversations, case and whitespace handling, and selection/draft preservation in the UI.

### 4. Verification and delivery

- Merge new locale keys; run focused tests, existing logic lane, language coverage, formatting and type/build checks appropriate to these changes.
- Review the three additions in an isolated UI fixture in Chinese and English, including 960×640. No formal client/data or real model is needed.
- Update concise project records before freezing a new source snapshot. Prepare and build a fresh local installer, verify source/runtime consistency and extracted packaged resources, and provide the installer with checksum and usage notes.
- Retain earlier installers/evidence and the user's website preview; stop only temporary processes created for this task. No Git push or website changes are part of this selection.

### Implementation verification

All three selected changes are implemented. Focused draft/search tests passed 19/19 and the logic lane passed 226/226 with no skips. Type/build, formatting and locale coverage passed (774 UI/native keys, 531 system keys, 1,442 source phrases). Eleven isolated browser checks passed with no page errors: input counting/thresholds and route changes; no task mutation on oversized submit; attachment quantity/size/removal/failure boundaries; result picker; combined requirement search; live language switching and 960×640 layouts. Synthetic upload receipts were used only for UI behavior, with no real execution or publishing. Installer evidence is maintained separately in the ignored input-search candidate directory.
