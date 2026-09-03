# M3.4 Fresh Brain Lifecycle Regression Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Verify two genuinely fresh Brains forming independently, sharing one Worker, preserving Project identity and surviving a Master stop/restart without Task takeover.

**Architecture:** Exercise the installed, unmodified 0.1.2 backend and official OpenCode through authenticated application APIs. Give each fresh Master a separate test discovery port with mDNS disabled, observe provisional → established, then restart its unchanged data on a common test discovery port. All instances and the deterministic model stay on 5.33; this is a complete-service regression, not physical dual-Brain acceptance.

**Tech Stack:** Node 24, TypeScript, existing ServiceClient/modelFixture, UDP discovery, read-only official OpenCode SQLite.

---

## Scope and evidence rules

Latest outcome: after the user authorized the high-port fix, the 0.1.3 package-runtime run **bd24ebd5-73b6-423c-860a-12a73b41ffa3 passed all 11 assertions**, including the previously incomplete Master restart/queue continuation and all 18 observed HTTP allocations in 49152–65535. See [high-port repair and evidence](2026-09-02-m34-high-http-ports.md). The two earlier 0.1.2 failures below remain historical evidence, not the current result. Physical dual-host acceptance remains open.

- User authorized continued testing after confirming the existing physical Task is 已验收. The two desktops, their trust and the original physical Worker remain running and unchanged.
- Never pre-create identities, edit topology, force an established state, or hide neighbors of the existing physical instances. Independent discovery domains are explicit initial conditions of these new test-only instances, not a fix for the unresolved unpaired-Master waiting boundary.
- No OpenCode modification, external model credentials, external quota, Git initialization, file copy/snapshot/hash, firewall changes or system clock changes.
- Use fresh `.data/m34-fresh-brains/<UUID>` data only. Test cleanup stops only child processes created by this run and retains evidence. Application API acceptance applies only to these deterministic text test tasks, not user MVP sign-off.
- No worktree, commit or delegated agent is needed for this scoped test continuation in the user's current workspace.

### Task 1: Support explicit discovery domains and safe same-client restart

**Files:** Modify `scripts/m34-fixtures.ts`; create `scripts/m34-fresh-brain-check.ts`.

1. Add a test that starts a fresh root and asserts its first hosted Brain is provisional, then becomes established with no nearby nodes. Record both observations and IDs.
2. Extend `ServiceClient.start` with a typed, validated `discovery: { port: number; mdns: boolean }` option. Pass only the existing `RIVLOOM_DISCOVERY_PORT`/`RIVLOOM_MDNS_NETWORK`/fallback environment controls to its own child.
3. Before restart, reject a still-running child and clear old URL/output/cookie. Reuse the unchanged root and verify the same Node and Brain IDs after restart. Do not write identity or topology files.
4. Run TypeScript before executing. The old helper has no discovery option, so the new call first requires this narrowly scoped helper extension; do not simulate a failing product run by manipulating product state.

### Task 2: Exercise the lifecycle with fresh isolated services

**Files:** Create `scripts/m34-fresh-brain-check.ts`.

1. Allocate unused discovery ports. Start two fresh Masters independently, wait for automatic settlement, stop only those children, then start both and a fresh Worker on their common test port. Pair only the two Master–Worker edges using the ordinary API.
2. Assert original Brain IDs remain distinct, Worker withdraws its provisional Brain, and both Master directories report the same single free Worker slot. Observe channels and resource reports continuously for at least 90 seconds.
3. Create ordinary same-name folders/projects on different Nodes with distinct Project IDs. Only the Worker exports its Project; Masters keep local execution disabled. A request for a non-exported same-name Project must not use the Worker's Project as a substitute.
4. Submit one Portable Task through each independent Master simultaneously. Hold the model reply; assert one running business Task/session, the other Brain's Task queued, and immutable ownership. Release the fixture; review must still occupy the slot.
5. Stop the queued Task's Master, observe its Brain offline without replacement, accept only the winning test Task, and submit a Project Task through the surviving Master. Assert it executes against the exact authorized Worker Project/directory, not a Portable folder or same-name Project.
6. Restart the stopped Master with the same root. Assert same Node/Brain/Task IDs, no takeover and no duplicate accepted execution. While the Project is in review the queued Task must wait; after test acceptance it resumes, reaches review and is accepted by its original Master.
7. Check all three accepted business Tasks have distinct official sessions, no tool parts, and empty dedicated execution folders. Stop all newly created children in finally; record failures as failures without relabeling test preconditions after the fact.

### Task 3: Verify and document the result

**Files:** Update this plan, `docs/VERIFICATION.md`, `docs/PROGRESS.md`, `docs/HANDOFF.md`, `docs/MILESTONES.md` and `docs/plans/m34-physical-acceptance.md`.

- Run `& 'C:/Users/x/AppData/Local/Rivloom/runtime/node.exe' node_modules/typescript/bin/tsc --noEmit`.
- Run `& 'C:/Users/x/AppData/Local/Rivloom/runtime/node.exe' scripts/m34-fresh-brain-check.ts --runtime-directory=C:/Users/x/AppData/Local/Rivloom/runtime` in the normal Windows context required by DPAPI and spawned test processes.
- Expect evidence in `.data/verification/m34-fresh-brains-<UUID>.json`, assertion-by-assertion output and explicit owned-process cleanup.
- Run existing automated tests and `git diff --check`; keep pre-existing dirty worktree changes.
- Record that this is one physical host, installed 0.1.2, custom test discovery domain, local deterministic model. Actual two-host competition and fault cases remain open until independently exercised; M3.4 MVP remains unaccepted.

## Execution status

- Existing physical baseline rechecked at 2026-09-02T07:17:42Z: both desktop peer channels and original Worker remain online/trusted, Task `45b70f73-e911-4f65-8e75-db31c3efa2fa` remains completed, original Worker has one free slot.
- First run `fd6d1d89-5081-4446-8ebe-2ad6f49c44d8` (07:22:31Z–07:25:10Z) failed in the **test reader**, not a product assertion: creation returns `NodeNetwork`, but the new helper initially read it as a single `BrainTask`, producing `Missing authoritative Task undefined`. Four preceding assertions passed, including actual provisional → established and 90,160 ms stability (169 samples, maximum report age 5,016 ms). The failed report and isolated data remain intact; its three child services exited. Do not count this run as competition/execution passing.
- Fixed the test helper to extract the single newly created owned Task from the actual response. TypeScript and Prettier checks pass after removing the obsolete type import.
- Existing automated suite rerun: 43/43 pass, zero skipped, 51,918.7842 ms. Normal Windows context; no new product code changes.

### Rerun: seven assertions pass; restart hits a blocked HTTP port

- Run `793f9de8-5d9f-4e31-b544-92d2524b7c77`, 07:25:29.976Z–07:28:12.948Z, installed runtime 0.1.2. **Overall failed**, not a completed lifecycle acceptance. Report `.data/verification/m34-fresh-brains-793f9de8-5d9f-4e31-b544-92d2524b7c77.json` retains the exact seven passing assertions and failure. All three owned child services exited, data retained.
- Automatic independent formation and joining pass. Brain A `e4707323-e118-4999-8aef-4e0fa87069ee` on Node `u_0H0_8GLcwCFxBJC63CvfHlKBsLhoHS`; Brain B `34751377-ffe2-4446-906f-da64591c9057` on Node `-XnFREpAe0wYO9_dUNlTsBn5EG7AiNdf`; shared Worker `gGd3W_sKEB3pedRJRfXKGNcmL5SSrSCk`. Stability 90,224 ms / 169 samples / maximum report age 4,988 ms. Different same-name Project IDs do not substitute for one another; non-exported Project submission returns 409 before creating a Task.
- Competition passes: A's Task `fc581eec-1033-4114-a8c6-7fe43a75f8b5` / Execution `72a20c8f-88f1-4e66-9ba8-5c99a1ac440a` runs; B's Task `66071477-c1cb-4c12-894b-dd3ec8ea80c2` stays queued after rejected Execution `65e6af03-7f88-4329-a788-d24c3be8dc05`. Exactly one initial business Task and official session; review keeps the slot occupied. The test-only first Task was then accepted via its owning Master.
- Master stop and Project placement pass: stop only B's child; Worker reports B offline, A online and no new hosted Brain. A runs Project Task `58d6c017-1385-496c-922a-17f4b707c5f2` / Execution `60a16fe0-72f0-4afe-b7b4-5fccfc3a6210` against exact Worker Project `6c25be1f-451b-4167-9cd1-3fe29bd79081` in its own `same-name-folder`. It reaches **review**, not final acceptance; A never owns B's queued Task.
- Restart then fails before authenticated state can be checked: B prints `RIVLOOM_DESKTOP_READY http://127.0.0.1:1719`; the test waits for engine health and times out with `TypeError: fetch failed`. Independent read-only reproduction with the same installed Node reports `cause.message = "bad port"` even after the child is stopped. Thus this failure does not establish an engine crash or corrupt Brain/Task data.
- Local source confirms the product path also uses OS-assigned `PORT=0`: `src-tauri/src/main.rs` passes it to the backend, and `server/index.ts` announces the assigned port without a browser-safe check. `netsh int ipv4 show dynamicport tcp` reports start 1024 / count 13977 on this machine, which includes 1719. No system setting was changed. Installed Node's bundled Undici bad-port table includes 1719; the [WHATWG Fetch port-blocking rule](https://fetch.spec.whatwg.org/#port-blocking) also explicitly lists it. **Inference:** the same product port-selection path poses a desktop startup risk; a native WebView2 window on this exact port has not been reproduced in this run.
- Remaining: same-identity restart through authenticated APIs, queued Task resumption after release, and the final three-task no-duplicate assertion were not reached. Do not silently retry random ports or replace Fetch to erase this failure. Proposed next step is a Rivloom-owned browser-safe port allocation fix and deterministic regression, subject to the user's confirmation; no product implementation or rebuild was done here.
- Post-cleanup read-only evidence: Worker business Task `d139e23a-8ea2-4d35-917b-8fbc9d0899c8` is accepted (session `ses_f9efc0c35ffeP22OHsHt8n6knM`); Project business Task `813bed8d-e5eb-4e2c-9cbd-44b8e267a062` remains review (session `ses_f9efc0412ffekkGkODNcd0VwM4`). Exactly two official sessions and zero tool parts; model requests 2. B's persisted Task remains queued. These records supplement, not replace, the failed authenticated restart check.
- At 07:29:38Z, original physical desktop Master `tRCQ1_`, joining Node `As64SU` and original Worker `t9MUCF` still have all three online/trusted/ready edges. The user's Task `45b70f73` remains completed and its Worker Task accepted; original Worker slot is 1. Existing desktop/Worker processes, trust, data and release state are unchanged.
