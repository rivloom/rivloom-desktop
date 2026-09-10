# Collaborative Task Flow Implementation Plan

> Execute this plan task by task using the executing-plans workflow. The user authorized development in this conversation; continue through implementation and verification without renewed phase approvals. No delegation, commits, installation, publication or previously deferred physical checks are authorized by this plan.

**Goal:** Deliver proactive resource registration after directory selection, bounded resource queries, automatic task planning with dependency/parallel graphs, preferred/locked Node targeting and recoverable execution handoff within one original conversation.

**Architecture:** Keep existing authenticated Node transport, task admission, persistent queues and official OpenCode execution. Add versioned resource catalog records and a separate persistent workflow coordinator whose logical steps reference existing local/remote executions. Resource queries are bounded data operations; planning and execution remain real queued model work. Typed, validated planning/execution results drive graph changes and handoff; an unknown or still-running execution is never dispatched a second time.

**Tech Stack:** Existing TypeScript, SQLite, Node filesystem APIs, React/CSS and official OpenCode SDK. Reuse existing file integrity/resume mechanisms and current queue controls. No new framework or external service is required.

## Accepted scope and boundaries

The user approved the [brief](2026-09-09-collaborative-task-flow-brief.md) and its four refinements: pairing → user chooses work directory → registration; analyze/decompose regardless of `@`; `@Node` preferred and `@@Node` locked; automatically execute eligible planned work, retaining tool approvals and the queue threshold confirmation. The machine chooser must expose both modes and retain visible, editable target labels.

The work is complete only when registration/query, real planning/execution, graph UI and reliable transfer are integrated and checked. A partial catalog or a mocked graph is not completion. Keep previous installed/physical/performance checks deferred; use isolated services and fixtures for this implementation. A concrete executor's saved business outputs can be handed off; do not claim generic GPU/process memory migration.

## Task 1: Shared contracts and compatibility

**Files:** Create `shared/collaboration.ts`, `shared/resources.ts`, `shared/workflows.ts`; tests `tests/resources.test.ts`, `tests/workflows.test.ts`. Modify `shared/types.ts`, `scripts/ci-test-suites.ts`, `package.json` as features integrate.

1. Define one negotiated `collaboration-v1` capability for the new protocol family. Current peers permit at most 12 advertised capabilities and already advertise 11; do not break old handshakes by adding multiple capabilities.
2. Define exact, bounded metadata shapes for resource snapshots/deltas/query/results and task-scoped execution metadata/outcomes. Use stable resource/workspace/Node IDs; never accept client-provided absolute resource paths.
3. Define workflow target `automatic | preferred(nodeID) | locked(nodeID)`, plan steps, dependencies, resource references, execution attempts, graph versions, events and pending confirmations. Validate Node IDs, sizes, cycles, duplicate IDs, cross-step references and incompatible locked assignments.
4. Add meaningful failing tests for invalid/unknown fields, stale versions, traversal and cycles, then implement validators. Run focused tests with `node --test tests/resources.test.ts tests/workflows.test.ts`.

## Task 2: Local resource catalog

**Files:** Create `server/resource-catalog.ts`, `server/resource-capabilities.ts`; tests `tests/resource-catalog.test.ts`. Modify execution-policy integration in `server/index.ts`.

1. Build an injected, independently testable catalog store with versioned snapshots, retained deltas, status and bounded indexed search. Scan only the selected configured directory, after selection; never infer a directory from pairing alone.
2. Use asynchronous, batched traversal with cancellation/generation checks. Exclude credentials, dependency/cache directories, symlinks/reparse escapes and private app data; index metadata, not full document uploads. Treat initial incomplete/truncated scans explicitly.
3. Probe relevant tools using fixed executable/argument adapters with timeouts and no workspace command execution; report software/model evidence and timestamps separately from hardware/load.
4. Merge filesystem changes into a delayed refresh, periodically reconcile, and avoid resending unchanged catalogs. Directory changes immediately retire old discovery scope. Preserve last-known data with truthful freshness.
5. Test add/change/delete/rename, cancellation, large/incomplete directories, scope removal, links, stale versions, tool failures and restart. Ensure scans yield to other work.

## Task 3: Authenticated catalog exchange and light queries

**Files:** Create `server/resource-network.ts`; modify `server/node-network.ts`, `server/index.ts`, shared contracts; tests `tests/resource-network.test.ts` and protocol cases in `tests/node-network.test.ts`.

1. Add a negotiated extension request/response entry point over the existing serialized encrypted channel, preserving request ID and sequence checks. Keep legacy message shapes unchanged unless the feature is negotiated.
2. Exchange catalog versions, then pages/deltas after pairing/directory changes and reconnect. Persist accepted data by authenticated owner. Reject stale/cross-owner replies; invalidate discovery visibility on revocation.
3. Search the Brain/coordinator's catalog first; bounded parallel confirmation/fanout only for missing/stale/uncertain facts. Return partial/offline/no-match distinctly; deduplicate and cache by requester scope/version.
4. Expose owner-authorized UI query/catalog endpoints, with independent concurrency/deadline/result limits. No Task, Execution, OpenCode session or execution slot is created by ordinary discovery.
5. Support task-scoped material retrieval from validated resource references using existing file storage/chunk validation, preserving size/quota and restart identity. Actual file access revalidates scope, file identity/version and canonical path. Do not convert pairing into unrestricted file export.
6. Verify with isolated paired services, old/new capability compatibility, lost replies, duplicate requests, revocation and zero model/session creation for discovery.

## Task 4: Persistent workflow coordinator

**Files:** Create `server/workflows.ts`, `server/workflow-service.ts`, `server/workflow-api.ts`; tests `tests/workflow-service.test.ts`. Modify `server/index.ts`, `server/store.ts`/query integration and shared types only as needed.

1. Persist one stable workflow per user request ID, its creator, target policy, input bindings, plan version, steps, events and all execution IDs. Keep content identity independent of target-specific queue confirmation flags.
2. Create child execution intents before enqueue/send; retries reuse the same IDs. Reference existing local/remote task mechanisms and gate every execution through current Node admission. Hide child records as separate origin-side history entries while keeping execution details and receiving-side ownership reachable.
3. Support ready/waiting/running/completed/failed/cancelled states, all-required-predecessor joins, independent parallel branches, pause/root stop and unknown-stop states. Confirm queue threshold at the original submitter for each new actual target.
4. Maintain attempt generations and terminal events. Late old results remain history; no implicit redispatch on timeout. Failed dependencies block descendants while independent work can continue.
5. Test stable creation, queue replays, parallel joins, cancellation races, crashes before/after dispatch, stale results, target confirmation changes and locked invariants using injected execution adapters.

## Task 5: Real planner and execution outcomes

**Files:** Create `server/workflow-prompts.ts`; modify `server/task-service.ts`, `server/remote-tasks.ts`, `server/node-network.ts` and shared outcome contracts. Tests `tests/workflow-planning.test.ts` plus isolated official-engine service checks.

1. Use official OpenCode queued executions for planning, with a read-only planning policy and a validated output schema, never a text-length/`@` heuristic. The locked OpenCode 1.18.25 engine fails to serialize stored `format: json_schema` messages (upstream issue [40169](https://github.com/anomalyco/opencode/issues/40169)); reproduced against the actual engine. The implementation therefore supplies the schema in the prompt, parses one complete final JSON object, validates it and binds it to session/run/attempt. It also accepts a native structured field when available. It does not send the broken `format` parameter or fabricate a plan after invalid output.
2. Supply task requirements, bounded catalog/query evidence, input descriptors and target rules. Validate the returned plan; a single meaningful step retains simple conversation UI, multiple steps/dependencies/parallel branches produce the graph even on one machine.
3. Planning may request bounded resource queries before finalizing. Execution outcomes distinguish completion, resource request, handoff request and a validated expansion of remaining work. Query actions themselves do not create extra model work on each queried Node.
4. Bind outcomes to the exact current local/remote session and execution generation. Preserve ordinary tool approvals, questions and final artifacts. Invalid plans/outcomes are actionable failures, not fabricated successful execution.
5. Test with official OpenCode and deterministic local model replies for simple work, script/material/edit dependencies, parallel work, resource gaps, invalid JSON/cycles and rejected locked targets. Use no real credentials or paid requests during verification.

## Task 6: Handoff, inputs and results

**Files:** Extend workflow coordinator/service, resource/file adapters and existing remote controls; handoff cases are included in `tests/workflow-service.test.ts`, `tests/workflow-planning.test.ts` and `scripts/workflow-service-check.ts`.

1. Choose between material retrieval, explicit local-at-data substeps and whole-step transfer; selection considers resources/software/hardware, not merely load.
2. Persist handoff ID, old/new attempts, reason, materials and phase. Target checks eligibility; old execution must be safely ended/stopped; complete verified materials and accepted target queue precede new execution.
3. Preserve useful outputs/context for the next execution. Only supported, verified business-step checkpoints can continue computation; uncertain external/background processes block automatic transfer until stoppage is established.
4. Record distinct dependency and handoff edges, bound transfers, detect cycles/repeated targets and preserve original conversation/result ownership. Locked execution cannot delegate a substep to escape its target.
5. Verify resource-in-B, missing-tool, GPU mismatch and running-step handoff using controlled service fixtures; include dropped ACKs, late results, source/target/coordinator restart and file integrity.

## Task 7: Composer targeting and automatic routing

**Files:** Modify `src/node-mentions.ts`, `src/conversation-drafts.ts`, `src/conversation-workspace.tsx`, relevant CSS/locales; tests existing mention/draft suites and new routing cases.

1. Parse single/double `@` without breaking names, email/code text, caret position or IME composition. Bind selected Node by stable ID and store target mode with drafts and creation identity.
2. Implement visible `@ 首选 / @@ 锁定` chooser modes, explanation, clickable hints and persistent target chip. Keyboard/touch must have equivalent operations. Preserve old draft semantics and request IDs when only display names change.
3. Route new collaboration requests through workflow planning; no `@` does not force local execution. Keep existing conversations/legacy endpoints functional and member access correctly bounded.
4. Verify cancellation, retries, mode switching, duplicate names, offline locked Node, long names, draft restoration and existing sidebar density.

## Task 8: Task graph and resource UI

**Files:** Create `src/workflow-view.tsx`, `src/workflow-graph.tsx`, `src/workflow.css`, `src/resource-discovery.tsx`; modify conversations, filters, attention/notifications, main/bootstrap and locales where required.

1. Show one origin conversation with real status, compact query events and a collapsible graph when needed. Cards identify step/Node/attempt; distinct dependency/handoff lines display artifact/reason.
2. Render responsive automatic layout with stable positions, selected execution detail, inputs/results, pending queue/tool/question actions and unstarted-step editing. Avoid decorative motion; honor reduced motion and focus.
3. Surface selected-directory indexing status and useful resource query results in the existing Devices & Models area/related task flow. Do not introduce arbitrary dashboards.
4. Check desktop/narrow/mobile, both locales, old history styling, independent scroll, keyboard, touch, line geometry and real state transitions with isolated production UI fixtures.

## Task 9: Integration and delivery

1. Register all persistent tests in existing CI lanes. Run targeted suites as modules land, then final logic/protocol and relevant real-service checks, localization, TypeScript and Vite build. Use explicit Node CLI paths because the local npm shim is broken.
2. Run production UI regressions and new graph/targeting/resource scenarios. Link final evidence to the same product source used for packaging. Do not repeat checks without new changes/failures.
3. Prepare runtime, freeze source, build a local NSIS installer, extract and compare runtime/application bytes and installer script changes using the established candidate workflow.
4. Update HANDOFF, PROGRESS, UI-HANDOFF, accepted ADR/brief and this plan with actual results and remaining physical verification. Deliver the local installer without executing it, publishing, committing or pushing.

## Execution log

- 2026-09-09: user authorized development after approving the `@`/`@@` interaction. Reviewed current code and preserved the existing dirty worktree. No product edits before this plan. Initial implementation starts with shared resource/workflow contracts and the local catalog.
- 2026-09-09: shared contracts and selected-directory catalog implemented. Authenticated directory pages/deltas, query fanout, persistent cursors and task-scoped material transfer are connected to the local service. Resource traffic has an independent bounded endpoint; authenticated data replies bind to their request without consuming the opposite request stream. Focused metadata/file tests and real isolated modern/legacy protocol checks pass. Workflow execution and the product UI remain in development; this is not a completed delivery.
- 2026-09-09: Tasks 1–8 integrated. The persistent coordinator runs a real read-only planner for every new request, validates plans, handles dependency joins, independent branches, bounded queries/expansion and checkpoint handoff. Local and remote attempts retain durable identities, approval gates and verified files. Pausing stops new dispatch; queued work continues. Unknown execution is never replayed automatically. Locked execution may fetch other nodes' resources but cannot transfer execution or substeps. Editing during material retrieval discards stale preparation.
- 2026-09-09: The production UI now shows one originating conversation, responsive dependency/handoff cards, current and historical results, root queue confirmations, tool approvals and version-checked editing of unstarted steps. Queries and same-Node continuations retain their full attempt history without redundant graph cards. `@`/`@@` selection, manual mode changes, automatic defaults and resource discovery are connected to the actual APIs. Receiving nodes retain their own incoming task records.
- 2026-09-09: Final logic lane passes 300/300; protocol lane 13/13; official two-service workflow check 12/12; existing sidebar production UI 60/60; new production UI 20/20 including resource page layouts. TypeScript, 976 UI/native translations, 552 system translations and Vite build pass. The engine check includes selected-directory registration without model work, real planning, parallel/join work, invalid plans, material retrieval under a hard lock, actual approved file write, checkpoint handoff, coordinator restart, target restart preserving an interrupted attempt/session, and confirmed root stopping. Evidence: `.data/verification/collaboration-development/`, `.data/workflow-service/1788922881182/result.json` and the CI lane reports. Local NSIS preparation and final delivery verification follow; installed/physical/performance checks remain deferred.
- 2026-09-09: Task 9 completed. Frozen source and prepared runtime remained unchanged during Release/NSIS build. The installer was extracted without running it; all 7,662 runtime files match the prepared bytes. The Windows x64 application matches the native build except the verified three-byte Tauri NSIS bundle marker. Static installer comparison permits only the 17 new runtime modules' File/Delete entries, generated frontend names and estimated size. No dependency versions, installation identity or other installer commands changed.

## Local delivery

- Installer: `.data/verification/collaboration-candidate-final-20260909/delivery/Rivloom_0.1.4_collaboration_20260909_785a8157_x64-setup.exe`
- Size: **79,954,851 bytes**. SHA-256: `5a7710352ab94e680516edfe26b1ee4e633f7c60e24e56865f10414b9b9e9e0c`.
- Source snapshot: `785a8157c0c9395961eacde47da8fadc62635b1c7c1b314c5d17bb5249d11eee`, 1131 files, local uncommitted worktree based on `cad78d38a26cebc95909531870bf6b38cf58cac1`. All previous requested changes are retained.
- Evidence directory: `.data/verification/collaboration-candidate-final-20260909/`. `ui-source-link.json` binds the 300 logic, 13 protocol, 12 official-service and 80 UI checks to the product source and packaged frontend; `extraction-result.json` and `installer-static-review.json` record byte and command comparisons; `delivery-result.json` records the final artifact and permitted documentation-only updates.
- UI screenshots: `.data/verification/collaboration-development/ui/`, including `locked-composer.png`, `graph-detail-390.png` and `resources-en-390.png`. Test fixtures are explicitly synthetic for UI layout, while the separate workflow service check runs real official OpenCode sessions and two authenticated local services.
- Installer has **not been executed**, signed or published. No commit or push was performed. Participating nodes need this collaboration capability; old protocol compatibility does not make an old node eligible for the new workflow. Previously deferred installed, physical-device and performance checks remain deferred.
