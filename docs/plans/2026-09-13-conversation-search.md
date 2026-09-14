# Conversation content search implementation plan

**Goal:** Find saved requirements and responses across conversation rounds, preview matching text, and open the corresponding message or workflow attempt.

**Architecture:** Search only the authenticated, history-filtered bootstrap already displayed by the client. Build an in-memory index of user-visible content, use literal case-insensitive matching, and carry stable round/step/attempt/message targets into the existing transcript. No filesystem crawling, remote file download, model request, database migration, or persistent secondary index.

**Tech stack:** Existing React/TypeScript, Markdown renderer, Node test runner, and isolated browser fixtures; no new dependencies.

## Scope and acceptance

- Retain title, directory/alias, device, status, and source filtering; add saved questions, responses, archived workflow rounds, pending messages, step results and previous attempt checkpoints.
- Exclude engine envelopes, tool payloads, model settings, hidden/deleted conversations, unsent drafts, and attachment contents. Search sees exactly the conversations in the current authorized bootstrap.
- Show one compact excerpt per matching conversation, matching segment count, highlighted literal terms, and previous/next matching segment controls in the opened conversation.
- A workflow match expands and selects its exact historical round/step/attempt. Navigation does not execute work, resume a queue, retrieve files, or disturb drafts.
- An empty query restores the normal compact list. Changing or removing data invalidates old matches; search does not keep deleted text in a persistent cache. Keyboard, IME, language switching and narrow layouts remain usable.

## Implementation

1. Add `src/conversation-search.ts` and `tests/conversation-search.test.ts`: pure index/match/excerpt/target helpers; cover archived rounds, old attempts, literal punctuation, long text, visibility and fresh snapshots. Keep existing requirement-only filter tests intact.
2. Add search display components and literal highlighting; extend `src/message-markdown.tsx` to mark rendered text safely while keeping Markdown and copied code intact.
3. Integrate search results into `src/conversation-workspace.tsx`; attach stable transcript targets and disable automatic scrolling while navigating search. Preserve status/source filters, normal row operations and drafts.
4. Extend `src/workflow-view.tsx` to select search-targeted rounds and attempts, with visible result anchors and no workflow control mutations.
5. Add bilingual strings/styles, classify new tests in `package.json` and `scripts/ci-test-suites.ts`.
6. Run meaningful unit regressions, the logic lane, type/i18n/version/coverage checks and production build. Use synthetic browser fixtures for search, navigation, updates/deletion, keyboard, mobile and language checks; inspect screenshots.
7. Prepare an isolated preview and a short Chinese acceptance guide. Update `docs/NEXT-SESSION.md`, `docs/HANDOFF.md` and `docs/VERIFICATION.md` with exact results and limits. Keep pre-existing R2 documentation edits. Leave formal release at 0.1.13 until a subsequent release request.

The user authorized choosing and implementing a useful feature for next-day acceptance. Proceed locally through implementation and verification without a further execution-choice prompt or subagent delegation. Previously paused installed-app, real-model and physical-device testing stays outside this scope.
