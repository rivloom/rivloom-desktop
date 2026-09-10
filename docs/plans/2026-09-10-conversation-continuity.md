# Conversation continuity implementation plan

**Goal:** Let users queue follow-up requests in one conversation, read Markdown responses, recover unsent drafts, and paste/drop/preview attachments.

**Architecture:** Keep the workflow ID and conversation preferences stable. Store immutable completed rounds and a FIFO of idempotent requests in the workflow JSON, under the existing SQLite compare-and-swap and history retirement fences. A successful, quiescent round automatically admits the next request; stopping/failure holds the queue until explicitly continued. Full prior requests/results travel as a generated attachment, with recent context in the prompt. Store local drafts per workspace/user, retaining upload descriptors and request identities. Use authenticated file preview routes and a safe React Markdown renderer.

**Tech stack:** TypeScript, React, SQLite, Express, existing task file store; react-markdown and remark-gfm.

## 1. Durable rounds and queue
- Extend `shared/workflows.ts`, `server/workflows.ts`, `server/workflow-service.ts` and `server/workflow-api.ts` with queue admission, cancellation, resume, round archiving and crash-safe FIFO advancement.
- Extend runtime materialization with full conversation context and prior result files; preserve execution authority, quiescence and quotas.
- Include archived attempts and queued requests in `shared/conversations.ts` and `shared/conversation-history.ts`; preserve stable titles, cleanup and replay fences.
- Verify FIFO/restart/idempotence, stopped/failed rounds, questions, stale callbacks, cancellation and history deletion.

## 2. Composer and transcript
- Enable the workflow composer after creation/completion in `src/conversation-workspace.tsx`; show prior rounds and pending messages, cancellation and queue continuation in `src/workflow-view.tsx`.
- Render assistant text with a shared Markdown component: tables, lists, fenced code with copy, safe links, no executable HTML or automatic remote image loads.
- Verify rendered behavior with the isolated UI fixture and a production build.

## 3. Draft recovery
- Persist draft text/routing/settings/request identity and completed attachment metadata; make incomplete uploads visibly recoverable without silently sending missing files.
- Scope storage by user/workspace, retain drafts on failed/uncertain submissions, clear only acknowledged sends, and avoid background upload callbacks resurrecting submitted drafts.
- Verify reload, conversation switching, request replay and storage failure behavior.

## 4. Attachments
- Share selection/upload logic across picker, paste and drop. Preserve quotas, hashing and ownership checks.
- Add safe image/text/audio/video previews for draft and conversation files, with bounded text reads and explicit unsupported formats.
- Verify access boundaries, active content handling, upload errors, drag/paste, previews and reload recovery.

## 5. Validation and delivery
- Run relevant new and existing logic/protocol tests, i18n checks and build. Use only isolated synthetic fixtures for runtime/UI tests.
- Review the complete diff, update release records/version, run the established release pipeline and synchronize public download records once the candidate passes.

## Architecture decision
Choose embedded rounds over child workflows: this preserves one durable identity, avoids orphan child conversations, and lets existing trash/purge transactions fence the entire queue. Archived rounds must never retain active attempts. Full transcript attachments avoid silently truncating prior user requirements to fit authenticated context limits. Draft storage is local and independent of model execution; file preview must use existing ownership and membership checks.

## Implementation status

Steps 1–4 implemented. FIFO, restart, idempotence, questions, cancellation, quotas, cleanup, notifications, draft recovery, safe preview and production Markdown rendering verified. Initial isolated browser checks covered Markdown, copy feedback, draft switching/reload, image paste, file picker and previews. The browser provider disconnected during final UI verification; subsequent restart/attachment/queue checks used the real isolated HTTP service. Native installation and public release checks follow the committed candidate pipeline.
