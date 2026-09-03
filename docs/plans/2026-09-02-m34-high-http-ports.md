# M3.4 High HTTP Ports Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the observed random-port 1719 startup failure and keep all automatically allocated Rivloom HTTP listeners in 49152–65535.

**Architecture:** A shared Rivloom-owned allocator binds explicit random high ports and retries only address-in-use/access-denied bind errors, with a bounded attempt count. Apply it to the application HTTP server, Node peer HTTP server and the wrapper that launches official OpenCode. Keep loopback/LAN bind addresses, authentication, origins, identities, UDP discovery and all Brain rules unchanged.

**Tech Stack:** Node 24 TCP/HTTP, TypeScript, existing official OpenCode CLI/SDK 1.18.25, Tauri/NSIS.

---

## Authorization and boundaries

- User explicitly requested the fix and larger ports. This authorizes implementation, targeted/full verification, continuing the failed isolated lifecycle regression and preparing a distinguishable 0.1.3 package; do not install it or restart existing physical desktops/Worker automatically.
- Range 49152–65535 is the [IANA dynamic/private range](https://www.iana.org/assignments/service-names-port-numbers/service-names-port-numbers.xhtml). Validate explicit ports against the [Fetch blocked-port list](https://fetch.spec.whatwg.org/#port-blocking); known-safe explicit development ports such as 4310 remain supported. Zero means Rivloom selects a high port, never direct OS allocation.
- No firewall, OS dynamic-range, browser security, OpenCode source/binary, project Git, file snapshot/hash, identity/trust or business-data changes. Existing desktop packaging's official binary integrity checks are unchanged; no project-content hashing is added.
- This is an implementation correction, not a new Brain/Project architecture decision. Work in the current dirty workspace, preserve prior changes and do not create a branch, commit or subagent.

### Task 1: Deterministic failing tests and allocator

**Files:** Create `tests/http-ports.test.ts`, `server/http-ports.ts`; modify `package.json` test command.

1. Write tests for default high range, exact boundaries, blocked/invalid fixed ports, rejecting low auto candidates, real HTTP Fetch success, deterministic occupied-port retry, access-denied retry, retry limit, fixed-port no-fallback, unexpected errors and listener cleanup.
2. Run the targeted tests before the module exists; retain the expected missing-module failure as the red baseline.
3. Implement `withHttpPort(open, port=0, nextPort)` and `listenHttp(server, host, port=0, nextPort)`. The candidate source is injected only as a function for tests, never through a production test environment switch. Use up to 64 high-range candidates. Explicit occupied ports fail without silently changing configuration.
4. Run targeted tests and TypeScript; update test fixtures' local model HTTP listener to the same allocator so the fixture itself cannot hit a Fetch bad port.

### Task 2: Apply the fix to all owned HTTP entry points

**Files:** Modify `server/index.ts`, `server/node-network.ts`, `server/engine.ts`, `scripts/m34-fixtures.ts`; add `tests/engine-ports.test.ts`.

1. Create the application HTTP server explicitly, await a successful high-port bind, then publish the actual URL and update exact Host/Origin allowlists. Preserve localhost-only binding.
2. Use the allocator for the peer HTTP server while retaining its LAN bind address and unchanged UDP/mDNS discovery settings. Reject configured invalid/blocked HTTP ports before advertising.
3. For official OpenCode, probe the exact high candidate, close only that probe, then pass its number to the unchanged official CLI. This handoff cannot reserve a port across processes, so validate the reported URL/port and retry recognized bind collisions; never fall back to an unexpected service URL or use lower ports. On startup/health failure, close only the owned child before returning/retrying; non-bind failures do not loop.
4. Verify explicit busy engine ports are rejected, and actual backend/peer/engine addresses use high ports. Keep credentials out of logs/reports.

### Task 3: Package and rerun the incomplete lifecycle

**Files:** Modify `scripts/m34-fresh-brain-check.ts`, package/Cargo/Tauri version metadata, verification and handoff documents.

1. Strengthen lifecycle assertions to inspect application and peer port ranges on every start/restart. Add official engine port checks from the test's own public startup log only; do not expose passwords or copy auth data. Compare the tested runtime version against repository metadata rather than hardcoding 0.1.2.
2. Bump to 0.1.3, run targeted/full tests, TypeScript/Vite, Cargo checks and build the new NSIS package using the existing verified packaging workflow. Never overwrite the installed 0.1.2 runtime used by the physical instances.
3. Run the full fresh-Brain lifecycle against the newly prepared package runtime: automatic formation, 90 seconds, contention, review, Project placement, Master stop/restart, retained Task ownership and queue continuation. Preserve previous failed reports unchanged.
4. Record actual passing/failing assertions, ports, process cleanup, test scope and artifact path. Recheck existing physical nodes and their accepted Task read-only. Physical dual-Brain acceptance remains separate; no MVP completion declaration.

## Commands and expected results

- `node --test tests/http-ports.test.ts`: initial missing-module failure, then all deterministic port cases pass.
- `node --test tests/security.test.ts tests/node-network.test.ts tests/remote-task-clock.test.ts tests/http-ports.test.ts tests/engine-ports.test.ts`: all existing and new tests pass in the normal Windows context required by DPAPI.
- `cargo test --manifest-path src-tauri/Cargo.toml --bin rivloom-desktop`: native runtime URL boundary test passes.
- `node node_modules/typescript/bin/tsc --noEmit`, `npm.cmd run build`, `cargo fmt --check`, `cargo clippy -- -D warnings`, `git diff --check`: no errors.
- `npm.cmd run desktop:build`: new 0.1.3 installer, existing installed services untouched.
- `node scripts/m34-fresh-brain-check.ts --runtime-directory=C:/project/rivloom-opencode/src-tauri/resources/runtime`: complete isolated lifecycle and high-port assertions pass, with a fresh report and owned child cleanup.

## Status

Tasks 1–3 completed: implementation, full verification and 0.1.3 packaging passed. The 0.1.2 failed reports remain unchanged; no system settings or physical tasks changed. This completes the port fix, not physical M3.4 MVP acceptance.

- Red baseline: the newly added allocator tests initially fail with missing `server/http-ports.ts`. After implementation, two test assertions initially assumed Node HTTP had no existing `listening` listener; corrected to assert preservation of its original listener instead. Final allocator tests: **10/10 pass**.
- Real official OpenCode probe exposed generic `ServeError` rather than the expected explicit bind text. Initial full run: 54/55 pass (52,251.6812 ms), failed only this test assumption. The wrapper now re-probes the candidate after its failed child exits and retries only a real `EADDRINUSE`/`EACCES`; no broad ServeError retry or stderr wording dependency. Added two real-engine tests: busy/bad port rejection, generic CLI failure paired with actual OS conflict, high-port start, exact engine version and unauthenticated health rejected with 401. No model requests.
- Final full suite: **55/55 pass, zero skipped, 54,548.0482 ms**. Native URL test **1/1 pass**, rejects low/bad/non-loopback/non-HTTP URLs and accepts both high-range bounds. TypeScript, Vite, Prettier, Cargo fmt/clippy and diff checks pass. The first formatting write hit a transient Windows mapped-file error; file remained intact and one retry succeeded. Initial Cargo test used the display binary name rather than Cargo's target name; rerun against `rivloom-desktop` passed.
- Version metadata is 0.1.3. Newly prepared bundle runtime contains the fix; installed 0.1.2 remains unchanged. Native startup additionally refuses a low-port backend URL. Model test fixture uses the same high-port allocator; UDP discovery remains unchanged.

### Complete service regression passed

- Run `bd24ebd5-73b6-423c-860a-12a73b41ffa3`, **07:50:07.800Z–07:52:43.820Z**, from `src-tauri/resources/runtime` version **0.1.3**. Report `.data/verification/m34-fresh-brains-bd24ebd5-73b6-423c-860a-12a73b41ffa3.json`: **11 assertions passed**, all owned children exited, isolated evidence retained.
- Observed real fresh provisional → established formation of two independent Brains, shared Worker, **90,285 ms** stable channels/resource reports (**167 samples**, maximum report age **4,997 ms**), same-name Project rejection, simultaneous single-slot competition, review occupancy, Project-pinned execution while another Master is stopped, same-identity restart, retained queued Task/Execution history and queue continuation without takeover.
- The formerly queued Task `65c25c94-da9d-45ac-87d1-4549f0add92f` stays with Brain `c14d5f0c-2481-42d4-97eb-6bc75f2437d5`, resumes with attempt 2 / Execution `ae13ad0a-e1ff-4e05-910e-791b695bf83f` and completes. The other Brain `8ab0f121-3afb-4285-bd55-978d58f31ceb` retains its own two Tasks; all three are completed after explicit test-only acceptance.
- Exactly **3 accepted business Tasks, 3 official sessions, 3 local fixture model requests, 0 tool parts**. Dedicated Project and Portable folders are empty ordinary folders with no `.git`; no snapshot/hash/file-copy mechanism. This is not live AI coding or physical dual-host acceptance.

| Start/checkpoint | Application HTTP | Peer HTTP | Official OpenCode HTTP |
| --- | --- | --- | --- |
| B independently forms | 62985 | 62898 | 55624 |
| A independently forms | 51420 | 61989 | 63368 |
| B joins common test domain | 55655 | 53360 | 59507 |
| A joins common test domain | 54419 | 50734 | 52423 |
| Fresh Worker joins | 55255 | 58127 | 52674 |
| B restarts with unchanged data | 56291 | 53755 | 51767 |

- These are observed values, not fixed product ports. All 18 allocations satisfy 49152–65535; no OS ephemeral-port setting was altered.
- At **07:53:35Z**, read-only checks of the still-installed 0.1.2 show all original 5.20/5.33/Worker trust channels online/ready, original Task `45b70f73` still completed, original Worker business Task `503ce474` accepted, one free Worker slot. No installed process/data was replaced. Original Worker remains running with its model already released and completed data; its old zero-task resume guard must not be used blindly after stopping it.
- `npm.cmd run desktop:build` succeeded. Installer: `src-tauri/target/release/bundle/nsis/Rivloom_0.1.3_x64-setup.exe`, **71,083,411 bytes**, written 2026-09-02 15:54:19 local time. Release EXE: **10,266,624 bytes**, ProductVersion **0.1.3**. Old packages remain available. No installer execution, native UI smoke run or identity-preserving physical upgrade was performed in this turn.
