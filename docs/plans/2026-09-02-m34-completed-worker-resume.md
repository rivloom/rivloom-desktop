# M3.4 Completed Worker Resume Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore the original physical test Worker using installed 0.1.3 without changing its identity, replaying accepted work, or losing either Project and the two existing Executions.

**Architecture:** Extend only the existing physical-test helper's read-only preflight and post-start assertions. Accept an empty history or strictly matched, already accepted fixture tasks; reject active/unknown tasks, pending deliveries, mismatched owners and unrelated project paths. Use the existing official runtime and normal authenticated APIs; no product or OpenCode changes.

**Tech Stack:** Node 24, TypeScript, node:test, read-only SQLite, existing ServiceClient/modelFixture.

---

## Baseline and limits

- User reported both upgraded desktops running and authorized continuing. At 10:56:22Z, local installed 0.1.3 has Node `tRCQ1_OopLOZTbZpU-vnFboWPwj69ob7`, Brain `0ed79cba-4ed8-4373-ad3f-1dfc4a695800`, application port 57350 and peer port 64916. Peer 5.20 retains Node `As64SUH5wlu5deeBDPuHLsE47DWempcQ`, port 59725, trusted/ready. Its exact executable version has not been independently read remotely.
- Brain Task `45b70f73-e911-4f65-8e75-db31c3efa2fa` remains completed with original Execution `2414f24a-a968-4e19-8b5d-24b493e7db4e`. No re-pairing or new task is required to verify retention.
- Original stopped Worker root: `.data/m34-physical/a4530002-0690-40f6-a232-b632fefc5148`; Node `t9MUCFG44Q3nM4txwjG3UPI7mbwePMsM`. It has one accepted business Task, its official session, one authorized Project and one Portable Project, plus an old failed/unbound Execution. The previous zero-task/single-project guard intentionally cannot resume this history.
- No model credentials or real quota, no file snapshots/hashes/Git requirement, no identity/topology writes, no firewall/security/clock changes. Keep the dirty worktree at f5ce9ed. No new worktree, commit, agent delegation, installation or installer rebuild.
- Existing two desktops currently share one Brain by design. This continuation must not label restoration/stability as two-physical-Brain acceptance. Another independently formed test Brain on 5.20 requires a user-operated isolated helper; ask for that coordination separately.

### Task 1: Specify and test allowed preserved history

**Files:** Create `tests/physical-resume.test.ts`; modify `scripts/m34-physical-resume.ts`.

1. Add focused tests for empty history and accepted Portable/Project fixture tasks. Assert exact retained Task/Project/session/Execution IDs.
2. Cover rejection of running/review/ready/unknown tasks, missing sessions, non-fixture models, mismatched owner/Brain/Worker, duplicate task bindings, pending deliveries, replayable unbound acceptance and unrelated/out-of-root Project paths.
3. First run the tests and record the expected unsupported/new-helper failure. Implement the smallest metadata validator; keep the existing root/realpath/lock/identity/config checks.
4. Read SQLite in read-only mode; verify all Project paths are the authorized folder or the exact existing Portable Execution folder, with no links. Check official session IDs match retained accepted Tasks. Do not scan or hash project files.

### Task 2: Resume with preservation assertions

**Files:** Modify `scripts/m34-physical-worker.ts`.

1. Replace zero-task and single-project post-start assumptions with the preflight's retained ID/state/session/owner summaries. Keep local execution policy and original identity unchanged.
2. Record only safe application/peer/engine ports and helper process IDs; require all new HTTP ports in 49152–65535. Never print authentication material.
3. Run `& 'C:/Users/x/AppData/Local/Rivloom/runtime/node.exe' --test tests/physical-resume.test.ts`, TypeScript and formatting checks. Run read-only preflight on the stopped original root before launching anything.
4. Start the existing physical helper with `--resume-root=C:/project/rivloom-opencode/.data/m34-physical/a4530002-0690-40f6-a232-b632fefc5148 --expect-node=t9MUCFG44Q3nM4txwjG3UPI7mbwePMsM` and the two original desktop Node IDs, using the installed runtime in the normal Windows context. The model fixture starts unreleased; startup must produce zero model requests.

### Task 3: Observe and document

**Files:** Update this plan, `docs/HANDOFF.md`, `docs/PROGRESS.md`, `docs/VERIFICATION.md`, `docs/plans/m34-physical-acceptance.md`; write a scoped `.data/verification` report through the verification script.

1. Observe restored desktop–Worker channels, original Brain membership, hardware/load refresh and one free slot for at least 90 seconds, with no new model call, Task or official session.
2. Compare the original completed Master Task and Worker Task/session/Execution after observation. Preserve old failed/unbound history without retrying it.
3. Record exact version provenance, ports, IDs and results. If a real assertion fails, retain the failure and stop the relevant test flow; do not create replacement identities or relabel the topology.
4. Report this batch as upgrade retention/Worker recovery, not MVP sign-off; next physical dual-Brain test depends on a separately started isolated instance on 5.20.

## Execution status

- Baseline read-only check passed. Added 13 metadata-validation tests and implemented accepted-task/Portable-Project preservation. The expected first run failed because the new validator was not exported yet. One later test failed because its malformed Execution ID first triggered the ownership check; adjusted only that test's input to exercise ID validation, then 13/13 passed.
- Full suite **68/68 passed**, zero skipped, 52,590.3439 ms; TypeScript and formatting passed. Original stopped root passed read-only preflight with one accepted task, two Projects and one existing official session.
- At 11:03:53Z, installed 0.1.3 restored the original Worker: session 38378, helper PID 39992, Worker PID 25020; app/peer/engine ports 62388/53946/61627. Same Node, Projects, business Task/session and old/new Executions, no pairing or task replay, zero model calls.
- Live observation 11:05:17.600Z–11:06:47.708Z passed: 90,090 ms, 87 samples, 19 resource updates, maximum report age 4,928 ms. Both original peer edges on the Worker and desktop Master are trusted/ready; original Task remains completed, Worker slot 1. `status` at 11:07:36.555Z confirms model calls remain 0. See `.data/verification/m34-physical-upgrade-0.1.3.json`.

### Task 4: Prepare a separate physical Master helper for 5.20

**Files:** Create `scripts/m34-physical-master.ts`, `support/m34-master-helper/start-master.cmd`, `support/m34-master-helper/README.md`, `support/m34-master-helper/package.json`; package these with `scripts/m34-fixtures.ts`, `server/http-ports.ts` and type declarations in `.data/distribution`.

1. User clarified only the original Rivloom window is running. Prepare a separate, explicit test helper; do not make the original joining Node become a Master.
2. The helper uses installed 0.1.3, no downloaded dependencies or model credentials. First launch uses a fresh helper-owned directory and isolated discovery to observe automatic Brain formation, then rejoins normal discovery with the unchanged Node/Brain. No identity or topology seeding.
3. Keep local execution disabled. Commands only inspect status, pair the exact existing Worker, submit/accept one clearly labelled deterministic text Task, or stop/resume this helper's own service. Default startup does not pair, submit or accept anything. Keep helper data for same-directory restart.
4. Smoke-test fresh formation, normal-network rejoin, offline/online and same-directory relaunch locally, without pairing or creating work. Record this as a local helper check, not physical dual-Brain acceptance. Zip only helper source/runtime-independent code, never `.data`, identities or credentials.
5. Hand the user the zip and a single launch action on 5.20. Actual new identity and pairing confirmation require the user's next response; do not fabricate a completed remote launch.

Task 4 local result: helper automatically formed Node `e8n8VINNZTlYseN-Bg1N7bP50vOLYCqc` / Brain `3c0057aa-7fda-4858-954b-1a261d3ad1cc` without seeding. Fresh rejoin (11:12:05Z), offline/online (11:12:30Z) and actual CMD relaunch from the same data (11:13:21Z) preserved identity, with no pairing, Task or model request. Both runs shut down normally. A TypeScript check caught a status-display field mismatch (`workerNodeID` vs `selectedWorkerID`) before launch; corrected only the helper. Final TypeScript/formatting pass. Zip `.data/distribution/Rivloom_M3.4_Master_Helper_0.1.3.zip` is 13,488 bytes and contains only the 7 selected source/README/launcher files; no test data or credentials. Pair/submit/accept commands and the actual 5.20 launch remain unverified until the user starts the remote helper. Original Worker session 38378 stays running; original completed Task remains unchanged.
