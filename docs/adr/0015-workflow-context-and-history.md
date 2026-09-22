# ADR 0015: Sourced workflow state and on-demand history

Date: 2026-09-21. Updated: 2026-09-22. Status: implemented; the history foundation shipped in 0.1.19. The extensions in ADR 0016 target 0.1.20 with separate release acceptance.

## Context

One Rivloom conversation spans many independent Runtime sessions and may run on several Nodes. Runtime compaction cannot carry all business state across those sessions. Previously every continuation created another cumulative JSON transcript attachment. Repeated transcripts duplicated earlier rounds, and unstructured checkpoint truncation made missing detail hard to identify.

## Decision

Keep the pinned Runtime and the existing queues, workflow records, attachment verification and permission checks. Add a SQLite history index in the coordinating desktop, keyed by workflow, round, record and content revision. Index original requests, completion criteria, plan summaries, step outcomes and user clarifications. Completed rounds are indexed once; a late clarification explicitly refreshes its round. Retain changed record revisions so an admitted handoff reference remains readable after later progress.

Current goals come from the admitted user request. Progress and blockers come from workflow states. Bounded constraint/decision notes carry exact source quotes, revisions, author type and supersession links. Planning tools may write **inferred** notes using compare-and-swap state versions and idempotent request IDs. Only the authenticated conversation owner can confirm a note through the API. Inferred notes cannot replace confirmed notes. The latest user request takes precedence over conflicting historical material. Source validation proves a quote exists, not that a model's interpretation is correct.

Each admitted execution receives the complete current request plus a bounded structured handoff containing the state version, active notes, its own checkpoint, direct dependency references and file provenance. Shortened checkpoints are marked and retain a source reference. Active notes and original user constraints are not silently truncated: an oversized protected context fails preparation. An already-admitted attempt keeps its existing execution digest; new state is picked up by subsequent preparations or explicit tool reads.

The `rivloom_history` tool offers state, paginated keyword/round/step search and revision-pinned reads. `rivloom_context_note` is planning-only and does not write long-term Wiki memory. Both use an account-scoped private loopback credential and active task/session/directory binding. Tool arguments cannot select another workflow or account.

New Nodes advertise `workflow-history-v1`. It replaces the obsolete descriptive `brain` flag, keeping the signed handshake within the existing twelve-capability limit; `brain-task-v1` remains unchanged. Remote reads use the authenticated collaboration channel and bind the caller to the exact accepted, still-active target execution and its context digest. Wrong peers, ended/stopped executions, pending control, retired conversations and revoked trust are rejected. The receiver rechecks connectivity/trust and the reply identity before returning content. Offline history fails explicitly; earlier delivered content cannot be recalled from another Node.

New local and compatible remote executions no longer receive cumulative transcript attachments by default. A peer without the capability retains the previous completed-round JSON attachment path, generated when that peer is selected. Existing history files and visible conversation exports remain supported. This is a compatibility fallback, not a claim that old peers can use new tools.

## Tradeoffs and limits

- SQLite and the existing authenticated transport avoid new services, vector stores and unattended model calls. Exact substring search is predictable; semantic relevance and extraction quality remain model-dependent.
- History reads add tool round trips and require the coordinator to be reachable. Each read returns at most 32 KiB of serialized UTF-8 JSON, including metadata and JSON escaping. Offsets and totalCharacters remain UTF-16 units; callers must follow the returned nextOffset, since page character counts vary. Page boundaries preserve surrogate pairs. The existing request/response fields and capability remain compatible with older coordinators returning smaller pages. Searches return at most ten previews. The full active note set is bounded by count and serialized bytes.
- The 32 KiB budget fits below the pinned Runtime's default 50 KiB tool-output truncation threshold and the existing authenticated history reply limit; those limits are unchanged. It bounds each read, not total stored history or cumulative model context. User-input limits are separate and unchanged.
- Workflow records and Runtime messages remain authoritative and retained. This removes default duplicate transcript files; it does not solve all historical database growth or reclaim old files. New tables cascade with workflow deletion. [ADR 0016](0016-context-memory-and-runtime-retention.md) adds verified Runtime session cleanup to the existing recycle-bin policy.
- Existing workflow records migrate lazily into the index. Original records are not rewritten or discarded for this feature.
- These APIs and model tools provide the foundation for context viewing/editing and explicit project-memory promotion in [ADR 0016](0016-context-memory-and-runtime-retention.md), while keeping release acceptance separate.

## Validation

Logic tests cover pagination, source/version identity, note conflicts, user-confirmation boundaries, late clarifications, 500-round indexing, deletion, engine-account isolation, authenticated remote execution scopes and legacy file compatibility. `npm run test:workflow-history` and `npm run test:workflow-history:remote` exercise actual fixed Runtime processes with a local synthetic provider. `node scripts/ci-services.ts workflow` covers the existing workflow service behavior. These checks do not establish real-model recall quality, physical multi-machine acceptance, Linux-native execution or installation/release readiness.

Subsequent acceptance on three physical Windows Nodes exercised paged history and Wiki reads, explicit continuation and consecutive handoffs with synthetic content and a real provider. This verifies those observed cases, not general recall quality or all failure modes. The additional context, memory and recovery acceptance scope is recorded in [ADR 0016](0016-context-memory-and-runtime-retention.md); each new binary still requires its own platform and release gates.

## Alternatives

Always copying the full transcript provides simple offline access but keeps repeated growth. Summary-only state loses recoverable sources and can turn model guesses into apparent facts. Replacing Runtime or adopting a second agent framework would expand the deployment and authorization surface without resolving the workflow identity problem. The chosen design preserves sources and extends the existing architecture.
