# M3.4 Automatic Brains and Shared Workers Implementation Plan

> 按已确认的 ADR-0004 分步实施、验证并记录事实；不要重新引入每 Node 一个 Brain 或跨 Brain Task 委派。

**Goal:** Build the accepted M3.4 minimum loop in which stable automatic Brain masters share trusted Workers, receive real hardware/load reports, and schedule Brain-owned Tasks without cross-Brain delegation.

**Architecture:** Keep the existing authenticated node transport and official OpenCode execution path. Separate hosted Brain state from device identity, extend the encrypted Brain directory with Worker resource reports, compute Brain/Worker topology from trusted peers, and add deterministic two-stage scheduling with Node-side final admission. Preserve existing M3.3 records through migration and keep one fixed active Master Host per Brain.

**Tech Stack:** TypeScript 7, Node.js 24, Express 5, React 19, SQLite, Tauri 2, official OpenCode SDK 1.18.25, Node test runner.

**Current execution status (2026-09-03):** Tasks 1-6 are implemented and the scoped M3.4 MVP is closed after the physical Windows core loop passed and the user replied “好，下一步吧” to the results and remaining-limit disclosure. Physical evidence now includes two independent Brains sharing one Worker, real contention, review occupancy, original queued Task resumption, both owned Tasks completed and original history retained. Final report: `m34-physical-prepared-race-2ebbcc36.json`. This does not mean Task 7's entire regression suite is green: the latest full run remains 92/93 with the pure-mDNS test also failing alone; preserve that unresolved item and the untested physical failure boundaries. No HA, people identity or cross-Brain delegation has been added. Next product stage requires discussion and approval before implementation.

**Historical verification (2026-09-02):** 32 early automated tests, seven complete-service assertions, pending/accepted-offline fault injection and the native Release WebView2 submission → remote Master → shared Worker → review loop passed. Services and Release each passed a 90-second stability check. TypeScript, Vite, Cargo fmt/clippy and diff checks passed at that checkpoint. M3.4 task responses used an isolated deterministic loopback fixture, not user credentials or external quota. Later versioned checks and failures are recorded in `docs/VERIFICATION.md`; early passing counts do not override later results.

---

### Task 1: Record the accepted architecture

**Files:**

- Create: `docs/adr/0004-automatic-brain-masters-and-shared-workers.md`
- Modify: `docs/adr/0001-self-discovering-brain-network.md`
- Modify: `docs/MILESTONES.md`
- Modify: `docs/HANDOFF.md`

**Step 1: Mark stale decisions as superseded**

Change ADR-0001 so its discovery, trust and engine-boundary decisions remain valid while default-per-node Brain and Brain-to-Brain delegation are superseded.

**Step 2: Write ADR-0004**

Document automatic Brain formation, stable Brain IDs, fixed M3.4 Master Hosts, shared Workers, local Projects, Node-local model control, hardware/load reporting, Task/Execution separation, failure modes and rejected alternatives.

**Step 3: Define the minimum loop and acceptance criteria**

Add exact M3.4 scope and acceptance criteria to `docs/MILESTONES.md`, including explicit non-goals for people, HA elections, split-brain recovery and cross-Brain tasks.

**Step 4: Verify documentation consistency**

Run: `git diff --check`

Expected: no whitespace errors; no current document calls Brain A → Brain B delegation an accepted M3.4 requirement.

### Task 2: Add Worker resource reports and scheduling primitives

**Files:**

- Create: `server/worker-resources.ts`
- Modify: `shared/types.ts`
- Test: `tests/node-network.test.ts`

**Step 1: Write failing validation and ranking tests**

Cover sanitized static hardware, dynamic load samples, stale reports, OS/memory/CPU/GPU constraints, Project pinning, portable placement, load scoring and stable Node ID tie-breaking.

**Step 2: Run focused tests and confirm failure**

Run: `node --test --test-name-pattern="worker resource|worker scheduling" tests/node-network.test.ts`

Expected: FAIL because the resource collector and scheduler do not exist.

**Step 3: Implement hardware and load collection**

Collect scheduling-safe fields only: platform, architecture, CPU model/core counts, memory, GPU model/VRAM when available, disk totals, CPU/memory/disk load, execution slots and sample time. Never collect MAC addresses, hardware serials, usernames, paths or model data.

**Step 4: Implement pure matching and ranking**

Filter by Project and hard Task requirements, reject stale/non-accepting Workers, score remaining candidates by slots and live headroom, and use Node ID for deterministic ties.

**Step 5: Run focused tests**

Run: `node --test --test-name-pattern="worker resource|worker scheduling" tests/node-network.test.ts`

Expected: PASS.

### Task 3: Separate hosted Brain topology from Node identity

**Files:**

- Create: `server/brain-topology.ts`
- Modify: `server/node-identity.ts`
- Modify: `server/node-network.ts`
- Modify: `shared/types.ts`
- Test: `tests/node-network.test.ts`

**Step 1: Write failing automatic formation tests**

Test legacy Brain migration, a fresh provisional Brain, deterministic winner when two provisional nodes trust each other, adoption of an established remote Brain by an empty new Node, stable established Brain IDs and no automatic merge of two established Brains.

**Step 2: Verify the tests fail**

Run: `node --test --test-name-pattern="automatic brain|brain topology" tests/node-network.test.ts`

Expected: FAIL because Brain state is still embedded in `node-identity.json` semantics.

**Step 3: Implement the topology store**

Persist hosted Brain records independently, migrate the legacy `brainID` as established, mark brand-new identities as provisional, reconcile provisional nodes deterministically, and never merge established Brain records.

**Step 4: Expose master and registration semantics**

Add stable `masterNodeID`, hosted/provisional state and Brain topology snapshots. A Worker may register with multiple Brains while hosting none, one or more.

**Step 5: Run focused tests**

Run: `node --test --test-name-pattern="automatic brain|brain topology" tests/node-network.test.ts`

Expected: PASS.

### Task 4: Extend the encrypted directory with shared Workers

**Files:**

- Modify: `server/node-network.ts`
- Modify: `server/index.ts`
- Modify: `server/execution-policy.ts`
- Modify: `shared/types.ts`
- Test: `tests/node-network.test.ts`

**Step 1: Write failing three-node/two-Brain tests**

Start three isolated NodeNetwork instances, establish two Brain masters, trust a shared Worker, and assert the Worker appears in both Brain directories with the same sanitized static/dynamic resource report.

**Step 2: Verify the tests fail**

Run: `node --test --test-name-pattern="shared worker directory" tests/node-network.test.ts`

Expected: FAIL because directory messages only exchange one Brain and capability strings.

**Step 3: Extend directory request/response schemas**

Send hosted/registered Brain summaries plus a validated Worker report over the existing encrypted channel. Refresh dynamic load periodically through the per-peer send queue so channel sequence numbers remain ordered.

**Step 4: Build Brain topology snapshots**

For every established Brain, expose its fixed Master Host, online state, eligible shared Workers, their Projects, static hardware, dynamic load and report freshness. Model names, credentials and local paths remain absent.

**Step 5: Preserve trust and revocation boundaries**

Only trusted channel-ready peers contribute Worker records. Revocation or expiry immediately removes the Worker from affected Brain scheduling directories.

**Step 6: Run focused tests**

Run: `node --test --test-name-pattern="shared worker directory" tests/node-network.test.ts`

Expected: PASS.

### Task 5: Add automatic Brain/Worker task placement

**Files:**

- Modify: `server/remote-tasks.ts`
- Modify: `server/node-network.ts`
- Modify: `server/index.ts`
- Modify: `shared/types.ts`
- Test: `tests/node-network.test.ts`

**Step 1: Write failing placement and concurrency tests**

Cover automatic Brain choice, immutable Brain assignment, Project-pinned placement, portable placement, hardware rejection, lower-load preference, Node-side final admission, one active Execution per Task and two Brain masters competing for one Worker slot.

**Step 2: Verify the tests fail**

Run: `node --test --test-name-pattern="brain task placement|shared worker admission" tests/node-network.test.ts`

Expected: FAIL because tasks still target a peer Brain manually.

**Step 3: Extend Task offers**

Persist optional Project ID, structured hardware requirements, assigned Brain ID, selected Worker ID and Execution attempt sequence. Keep the same global Task ID across retries and reject duplicate active Execution assignments.

**Step 4: Implement deterministic scheduling**

Choose an online established Brain with matching Workers, pin it before first delivery, let its fixed Master choose the best Worker, and retain the current M3.3 encrypted execution/control/result loop for the chosen Worker.

**Step 5: Enforce final admission locally**

Before starting OpenCode, recheck Project, execution policy, model availability and the Node-wide execution slot. Project Tasks wait for their specific Node; Portable Tasks may create a new attempt on another eligible Worker.

**Step 6: Run focused tests**

Run: `node --test --test-name-pattern="brain task placement|shared worker admission" tests/node-network.test.ts`

Expected: PASS with no duplicate local business task or OpenCode session.

### Task 6: Present topology and scheduling in the desktop UI

**Files:**

- Modify: `src/node-network.tsx`
- Modify: `src/main.tsx`
- Modify: `src/styles.css`
- Modify: `scripts/node-network-ui.ts`

**Step 1: Add deterministic UI assertions**

Update the Release WebView2 check to require Brain master labels, shared Worker membership, hardware/load timestamps, execution slots, Task Brain assignment and automatic scheduling explanation.

**Step 2: Implement Brain topology cards**

Show each Brain once, its fixed Master Host, online/paused state and Worker list. Show CPU, memory, GPU when available, disk, load, slots and stale-report status without exposing paths or models.

**Step 3: Replace manual target-Brain language**

Task creation requests describe goal, optional Project and optional hardware requirements. The UI displays the automatically selected Brain and Worker; it does not ask users to create/join Brain or manually choose a master.

**Step 4: Run static verification**

Run: `npm.cmd run typecheck`

Expected: PASS.

### Task 7: Full verification and factual documentation

**Files:**

- Modify: `docs/PROGRESS.md`
- Modify: `docs/VERIFICATION.md`
- Modify: `docs/HANDOFF.md`
- Modify: `docs/MILESTONES.md`

**Step 1: Run unit and build checks**

Run:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: all pass.

**Step 2: Run the independent multi-instance network check**

Run the targeted M3.4 test with two established Brain masters and two shared Workers. Verify distinct data roots, Node IDs, Brain IDs and task stores, then reject the first Execution and verify that the same Brain/Task creates a second Execution on the other Worker; do not use multiple views of one database.

**Step 3: Run full services and Release WebView2 verification**

Run `node scripts/m34-service-check.ts` after the network suite finishes. Use three complete services with separate databases and the unmodified official OpenCode, connected only to the deterministic loopback model. Verify 90-second channel/slot stability, two Brains competing for one real session, Portable folder isolation, review occupancy, correct Brain ownership and local-start admission. Do not run multiple discovery suites concurrently when collecting final acceptance evidence.

Prepare resources with `node scripts/desktop-prepare.ts` and rebuild Release. Run `node scripts/m34-desktop-fixture.ts`; it launches the actual Tauri window and two isolated services, pairs the three test nodes and checks the full-mesh topology for 90 seconds. In the native window inspect two formal Brains and the shared Worker, submit a Portable Task through the automatic-placement form, send `release` to the fixture, then verify the Task/Execution card reaches review. `status` records IDs/states; `stop` cleans up only this fixture's processes. The fixture model makes no tools calls or user-file edits and consumes no external model quota.

The historical `npm.cmd run test:node-network-ui` covers the broader M3.3 UI suite and may call a real model; it is not silently substituted for this new deterministic M3.4 proof. Use a real model only when explicitly authorized and record external model failures separately.

**Step 4: Update factual status**

Record exact automated and physical results. Do not mark M3.4 complete until its documented acceptance boundary actually passes, and do not claim HA, split-brain recovery, people identity or cross-Brain Task collaboration.

Follow `docs/plans/m34-physical-acceptance.md` for physical evidence. Historically, NSIS0.1.1 passed seven isolated fresh-install/0.1.0-upgrade assertions and metadata restoration. The actual devices have since been upgraded to0.1.3 and the core physical loop completed; do not repeat these historical install instructions. Physical execution and user scope acceptance remain distinct from same-machine fixtures, installer tests and the unresolved pure-mDNS regression.

**Step 5: Review the final diff**

Run:

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: only intended source, test and documentation changes; no `.data`, credentials, build products, snapshots or hashes.
