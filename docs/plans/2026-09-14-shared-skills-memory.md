# Shared Skills and Progressive Memory Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Nodes can explicitly publish skills and classified memories to a Brain, discover other nodes' shared knowledge through that Brain, and load verified current content on demand inside ordinary Rivloom tasks.

**Architecture:** A local SQLite knowledge library owns metadata, sharing grants, memory versions and skill source registrations. A Brain-mediated extension over the existing authenticated collaboration channel supplies bounded catalog pages and revision-checked content; an official OpenCode custom-tool adapter binds requests to active tasks. Local and project AGENTS.md instructions precede a progressively loaded Wiki; background organization is local and does not invoke paid models.

**Tech Stack:** Existing Node.js 24+, SQLite, official OpenCode 1.18.25 custom tools, Zod, Express, React, existing encrypted Node channel. No new npm dependency or engine fork.

---

User requested implementation in this workspace. Execute here, retain reviewable uncommitted changes, and report progress between batches without waiting for redundant approval. Existing Code/executing-plans guidance applies where compatible with that authorization. Do not publish, touch installed data, log in to real accounts or call real model quotas.

## Decisions and acceptance

- Skill origin remains the publishing Node. Sharing grants explicitly name Brain IDs; local UI shows grants and remote availability. Revocation and topology/trust changes prevent new reads, including cached content. Already delivered bytes cannot be remotely erased.
- Brain lists source metadata for Nodes attached to the same Brain; A can read B through the Brain without requiring A–B pairing. Only the authenticated Brain can query B's grants for that Brain. No cross-Brain forwarding.
- New loads verify the source's latest manifest. A running task pins an immutable revision; changed, offline or revoked sources produce explicit errors rather than silently substituting a stale version. Supporting files load on demand and can be materialized for normal permission-controlled execution.
- Local Skill registration reads an explicitly selected SKILL.md directory, including safe scripts/references/assets. No install hooks or automatic dependency installation. Bounded files, sizes and paths; reject symlinks/junctions, traversal and credential files.
- Wiki records have category paths, descriptions, body, source, scope, versions and explicit sharing. Directory listings never include full bodies. Node and project rules stay separate from shared memory facts; shared content cannot grant permissions.
- Tasks can search/read and record useful memory through managed tools. Read-only planners cannot write memory. Local memory organization periodically rebuilds category indexes and identifies exact duplicates, preserving original text/history and conflicts; semantic filing happens through the executing agent's memory tool, without extra background model calls.
- Visible management for own/shared Skills, Wiki tree, rules, revisions, share/unshare, refresh and organize.

## Task 1: Contracts and local library

Create `shared/knowledge.ts`, `server/knowledge-store.ts`, `tests/knowledge.test.ts`. Define validated catalog metadata, revision/file manifests, grant and scope rules. Add SQLite versions and durable memory CRUD, safe source registration/refresh, file reads, organization and rules access. Test sharing defaults, revision conflicts, file safety, progressive listings, deduplication and restart.

Run `node --test tests/knowledge.test.ts`; first establish failing behavior, then implement until all assertions pass.

## Task 2: Brain-mediated transport

Create `server/knowledge-network.ts`, `tests/knowledge-network.test.ts`; extend `shared/collaboration.ts` with one knowledge request family. Use topology and existing trust to authorize direct and relayed catalog/head/file operations. Bound pagination, payload, timeout and cache lifetime. Test A–Brain–B without direct pairing, fresh revision, revoked grants, offline origin, requester spoofing, separate Brains, topology changes and restart.

Run `node --test tests/knowledge-network.test.ts tests/collaboration-channel.test.ts`.

## Task 3: Official engine tools and task context

Create `server/knowledge-tools.ts`, `server/knowledge-engine.ts`, `tests/knowledge-tools.test.ts`; modify `server/engine.ts`, `server/task-service.ts`, `server/task-prompts.ts`, `server/workflow-prompts.ts`. Register uniquely named official custom tools backed by a private loopback bridge. Bind every call to the current session, project and live task; append scoped rule content before tasks and describe progressive search/load/save. Materialize only requested verified assets in a task-specific directory. Preserve approvals and prohibit uncontrolled native skill discovery/subagents.

Run targeted tests plus the existing engine-permission and workflow-planning suites. Verify with official engine and a deterministic local model service that the model can actually call the tools; fake driver checks alone are insufficient.

## Task 4: Application API/lifecycle

Create `server/knowledge-api.ts`; integrate in `server/index.ts` without altering existing resource/file/workflow dispatch. Start/stop private bridge and background maintenance with the application. Require owner access for registration, rules editing, sharing and library management; task tools have separately bound authorization. Add source-safe, versioned CRUD and HTTP error responses.

## Task 5: Management UI

Create `src/knowledge-library.tsx`, `src/knowledge-library.css`; integrate in `src/conversation-workspace.tsx`. Provide local/shared catalog, source and revision, share controls per Brain, folder registration, rules editing and Wiki tree/entry editing. Use the existing UI components and Chinese/English translations in `shared/locales/en.json` and `shared/locales/system-en.json`. Keep low-frequency management outside the composer.

## Task 6: Isolated integration and UI verification

Create reproducible isolated service/preview fixtures and tests, wire new test files into `scripts/ci-test-suites.ts` and package scripts. Verify real encrypted Node transport plus actual official tool calls against loopback models. Inspect rendered UI at normal and narrow widths; exercise errors, stale edits, sharing and cancellation. Do not access personal skill trees or installed application data in fixtures.

## Task 7: Full relevant verification

Run `npm run typecheck`, `npm run check:i18n`, version/test classification checks, complete logic suite and production build, plus targeted official-engine/network/service tests. Preserve failures and fix causes rather than weakening assertions. No release/installer work is in scope.

## Task 8: Handoff

Execution result (2026-09-14): Tasks 1–8 implemented in the current workspace. Validation: 413 logic tests, 13 protocol tests, 3 existing engine tests, 6 three-service checks, 65 CI self-tests, UI interaction, localization and build passed. The real-engine fixture made 8 loopback model requests. Locked local SDK preparation resolves the official plugin's initial dependency-install wait. Memory maintenance rebuilds indexes and flags exact duplicates; semantic filing happens through the user/running agent. User acceptance is next; no real-account, physical-device, installer or release work was performed.

Document architecture in `docs/adr/0010-shared-skills-memory.md`, behavior in `docs/KNOWLEDGE-LIBRARY.md`, actual checks in `docs/VERIFICATION.md`, and current unfinished/review state at the top of `docs/NEXT-SESSION.md` and `docs/HANDOFF.md`. Version remains 0.1.14 until a later release is chosen.
