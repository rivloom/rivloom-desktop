# Conversation Recycle Bin Implementation Plan

> Execute with the installed executing-plans workflow in the current authorized session.

**Goal:** Restore conversation deletion, add a recoverable three-calendar-month recycle bin with permanent and bulk deletion, group history by working directory, and publish Rivloom 0.1.6 through the signed updater.

**Architecture:** Share the stable conversation resolver between the UI and server. Store recycle-bin membership and minimal replay tombstones in SQLite, fence retired executions, and remove only associated application records and unshared managed file copies. Keep project files intact. Publish only after isolated checks and release gates pass.

**Tech Stack:** TypeScript, React, Express, SQLite, existing JSON network stores, Tauri, GitHub Actions.

## 1. Durable conversation lifecycle

- Create `shared/conversation-history.ts` for membership, calendar expiry, and directory grouping; extract the resolver into `shared/conversations.ts`.
- Create `server/conversation-history.ts` with persistent trash, restore, purge journal, and identifier tombstones. Bump the workspace format to 4 so old builds cannot reopen retired executions.
- Verify calendar boundaries, restoration across restart, complete workflow membership, and terminal-state eligibility in `tests/conversation-history.test.ts`.

## 2. Server integration and cleanup

- Integrate owner-only history routes and bootstrap filtering in `server/index.ts`; enforce retirement on task/workflow/network mutations and idempotent request replay.
- Add bounded cleanup to network stores and managed attachments. Keep shared attachments and all project originals. Journal purges for retry after interrupted cleanup.
- Run an isolated service check covering authentication, grouping membership, restore, manual/bulk purge, expiry, and replay fences; add it to the existing Windows service matrix.

## 3. Interface

- Add row deletion, collapsible working-directory groups, recycle-bin navigation, restore, permanent deletion, and confirmed empty-bin actions in `src/conversation-workspace.tsx` and styles.
- Add English translations. Clear selection when its conversation is removed and preserve existing search/status/source filters.
- Verify desktop/mobile Chinese and English layouts with fixtures, including long paths and empty states.

## 4. Release 0.1.6

- Update version sources and release documentation. Run typecheck, build, logic/protocol tests, and relevant isolated service checks.
- Push the authorized release; wait for all CI, isolated installer, publishing, and updater gates.
- Verify the public installer hash/signature and the signed 0.1.5-to-0.1.6 manifest. Update and publish the website release notes and verify production.
- Do not install into the user's active desktop workspace or invoke real paid models.
