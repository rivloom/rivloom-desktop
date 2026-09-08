# Small Usability Improvements Implementation Plan

> Implementation workflow: execute these tasks within the user's authorization using the existing Code and executing-plans guidance. Preserve current uncommitted work and keep Git publication subject to the existing restriction.

**Goal:** Add five requested improvements: copy displayed conversation content, return to latest messages, filter conversation history, inspect actual installed versions, and copy/verify website download hashes.

**Architecture:** Keep desktop changes in the existing React presentation layer, using current task metadata and Tauri version information. Small shared helpers cover content selection and state classification; no task execution or transport protocol changes. The separate Astro website uses a progressively enhanced copy control and documented local PowerShell verification without changing the approved download catalog.

**Tech Stack:** React, TypeScript, existing i18next catalogs, Tauri APIs, Astro static pages, Node tests and existing isolated UI fixtures.

### 1. Conversation copy and scrolling

- Add `src/copy-button.tsx` with accessible success/failure feedback, disable empty content, and copy only the visible text supplied by its caller.
- Update `src/conversation-workspace.tsx` and `.css`: copy actions for displayed messages, tool output and remote summaries; retain first-user envelope stripping and current output truncation.
- Show a return-to-latest control only while the transcript can scroll and the user has left the bottom. Resume following after activation; switching conversation resets scroll state and new content must not pull a reader away from older messages.
- Verify long messages, streaming updates, clipboard rejection, empty output and Chinese/English labels in an isolated browser fixture.

### 2. History filters

- Add a typed state/source filter helper beside `src/conversations.ts`, plus meaningful tests covering local, remote and Brain task states.
- Combine filters with existing search. Keep current selection and drafts intact, show filtered/total counts, and provide a clear empty-state reset.
- Verify failures/interruption, review/completion, incoming/outgoing classification and simultaneous search/filter use without comparing translated labels.

### 3. Actual version and About

- Add an About component and a minimal allowlisted display model. Use `desktop_info.version` in native mode and explicitly identify browser preview; display the available OpenCode version.
- Never render/copy the raw desktop-info object, which also contains authentication information. Handle loading, unavailable values and retry without falling back to a hardcoded product version.
- Replace the sidebar's fixed version with the About entry; support copying the displayed version summary and both languages.

### 4. Website download verification

- In `C:/project/rivloom-website`, add an Astro copy component used by every existing approved SHA-256 value. Show manual-selection fallback when copying fails and keep hash text usable without JavaScript.
- Expand the download FAQ with read-only `Get-FileHash -Algorithm SHA256 -LiteralPath` guidance and comparison instructions. Use placeholder paths that readers replace, and keep hash/signature distinctions accurate.
- Preserve native static routes, locale catalogs, strict release checks and public artifact identity. Verify clipboard success/rejection, desktop/mobile, no-JavaScript content and the existing build/tests.

### 5. Delivery

- Update both language catalogs and concise project documentation. Run desktop type/build, relevant filter/content tests and required CI test inventory; run website tests/build.
- Use isolated test data to review all new controls in both languages. Produce a fresh native installer containing the changes, retaining existing language/brand/collaboration functionality and verifying packaged runtime resources.
- Leave formal user data and installed app untouched. Clearly distinguish local verification/installer delivery from native user testing and website deployment.

### Implementation checkpoint

All five source changes are implemented. Desktop logic checks passed 221/221 with no skips; type/build, formatting and language coverage passed. Twelve isolated browser checks cover real clipboard success/failure, displayed content, combined filters and draft retention, small/large incoming replies, responsive Chinese/English layouts and simulated native version success/failure/retry. QA found and fixed a large-reply follow race using a layout effect before resize observation, plus truncated narrow sidebar controls. Build/runtime/installer evidence is saved separately under the ignored local usability candidate directory. No formal app/data/model access or Git publication was performed.
