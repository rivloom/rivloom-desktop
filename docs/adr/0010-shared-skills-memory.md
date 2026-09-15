# ADR 0010: Brain-mediated Skills and progressive Wiki memory

Date: 2026-09-14. Status: implementing the user's requested scope; acceptance evidence pending.

## Context

Rivloom already schedules local/remote official OpenCode executions. Users now need Nodes to publish reusable Skills and structured memory to a Brain, discover peers' capabilities, retrieve current versions and load only relevant details. Existing global skill denial prevents uncontrolled discovery; ordinary resource catalogs intentionally exclude hidden configuration and credentials.

## Decision

Introduce a separate knowledge library, not an expansion of project-file scanning. A source Node registers selected skill folders and owns memory entries and explicit Brain sharing grants. Each Brain aggregates only grants addressed to itself. Its attached trusted Nodes can discover and read shared entries through the Brain's authenticated collaboration channel. Source paths and unshared data remain local. The Brain does not propagate entries into another Brain.

Discovery returns summaries/categories and content digests, never whole memories or scripts. Retrieval revalidates the source's grant and current revision. Task loads pin revisions and support bounded file-by-file retrieval. Cancellation of sharing blocks subsequent reads; prior delivery cannot be revoked from another machine's filesystem.

Node instructions live in the managed local AGENTS.md. The selected project supplies its own AGENTS.md (or agent.md when no AGENTS.md exists). Wiki entries carry project or Node scope, provenance and preserved versions. Shared memory is reference information, not authority over permissions. Only context-relevant summaries are listed, then individual bodies loaded via tools.

The engine integration uses the existing official custom-tool extension with Zod, a private authenticated loopback bridge and active-task/session/project binding. It retains the official agent loop, native tool approvals and subagent restrictions. Skills do not install software or execute themselves upon registration/download.

Local maintenance rebuilds category indexes and reports exact duplicate bodies without deleting source history; agents can file or revise facts during their already authorized task. No new unattended model calls are required for maintenance.

## Alternatives and tradeoffs

- Replicating every body to every Node is simpler to read offline but contradicts progressive loading and complicates revocation. Keep metadata discovery and source-verified fetch instead; offline sources cannot promise the latest revision.
- Direct A–B transfers require every pair to trust each other. Relay through the selected Brain supports the requested shared-library topology and keeps grants explicit, at the cost of two bounded hops.
- Globally enabling native Skill discovery is small but can load unrelated personal/project tools and cannot enforce the library's grants/version identity. Managed custom tools give exact provenance and task scope.
- AI-only background consolidation would introduce extra model charges and unpredictable deletion. Preserve originals and use deterministic maintenance plus context-aware filing inside normal tasks.

## Failure and operational requirements

Bound catalog pages, individual files, file counts, concurrent requests and timeouts; verify hashes and canonical containment; reject symlink/junction and secret-file imports. Check trust, Brain membership and sharing both before and after asynchronous reads. Preserve version conflicts and fail closed on unavailable/changed origins. Record sharing, revision and maintenance state for user inspection. Legacy peers remain usable for existing tasks and show knowledge unavailability independently.
