# Desktop Workflow Simplification Implementation Plan

**Goal:** Remove manual task acceptance, simplify device/model navigation, add confirmed device removal, make running activity visible, support 200 MiB × 5 attachment batches, and present machine backlog against a soft threshold of 10 with confirmation before adding more. Explore dependent/parallel work visually.

**Architecture:** Preserve stable task IDs, authenticated collaboration, execution approvals, queue admission and existing persisted/wire state codes. Successful engine completion becomes the existing terminal `accepted` code with no human accepter; previously finished `review` records migrate to completion. Keep legacy decoders/records usable. A queue's backlog and warning threshold are distinct from concurrent execution capacity. UI removal reuses trust revocation with an explicit confirmation modal. Models and local execution share one settings area; connectivity/Brain remain reachable within that area.

**Tech Stack:** Existing React/TypeScript/CSS, Express/SQLite and authenticated Node transport. No new product dependency. A separate interactive conversation mockup explores workflow cards/edges without claiming to implement dependency scheduling.

## Confirmed user decisions

- 10 is a queue backlog reminder threshold, not default concurrency. On reaching it, the submitting user confirms additional work; exceeding it remains allowed.
- Attachments: 200 MiB each, at most five per new submission, about 1 GiB per batch. Raise staging capacity accordingly while retaining bounded storage and integrity/resume behavior.
- Remove human acceptance after successful execution; preserve permission approvals and model questions.
- Device deletion must show a second confirmation dialog. It removes the pairing using the existing authenticated revocation behavior.

## Steps and checks

1. Finish successful local tasks automatically, preserve artifacts, publish terminal remote/Brain state, release the queue; migrate known finished reviews without treating interrupted work as completed. Remove acceptance/rejection UI and approval-like completion notifications. Test completion vs permission/question/error/interruption, legacy reads and queue release.
2. Add a hover/focus device delete action and modal naming the device and revocation consequence. Cancel is inert; confirm calls the existing endpoint once. Keep local remark editing.
3. Merge navigation into Devices & Models with Models & Execution and Nodes & Brain panels. Move execution configuration next to models; remove only the model-operation history panel. Place Connection Diagnostics last among feature entries. Verify all retained actions and diagnostics deep links.
4. Replace the tiny running pulse with a restrained but visible small rotating ring, only for actual running state and static under reduced motion. Increase attachment limits through the UI/API/storage/transfer validators, retain legacy record compatibility and explicitly negotiate larger transfers where old peers cannot accept them. Test real large-file boundaries, integrity and interrupted resume without touching installed data.
5. Display queue backlog / 10 on machine rows, true running count inside, separate concurrency in details. Confirm extra submissions at 10 on the submitting machine, bound to the actual target/request, preserve drafts and creation idempotency across cancellation/retries. Check local/directed/automatic entry points and unknown reports without fabricating counts.
6. Create a focused interactive workflow mockup: requirement output from Node A, implementation on Node B, parallel branch and join. Show dependencies and handoff artifacts, waiting/running/completed states and a local step-through interaction. Record implementation boundaries and a concrete suggested first product version.
7. Run relevant logic/protocol/service and production UI regression, type/localization/build, then prepare a frozen-source local installer and verify extracted runtime. Do not install, publish, push or resume previously deferred physical/performance checks. Record results and update handoff.

## Implementation and verification

Steps 1–5 are implemented. The queue reminder counts waiting/held work plus occupied execution/reservations, using fresh authenticated public statistics; the fill stops at 100% but the actual count can exceed 10. Confirmation metadata is excluded from task content identity and bound to the target. Local and paired-node creation, cancellation and retry were exercised against isolated real services. Permission approvals and model questions remain separate from automatic completion.

New uploads are limited to five files, 200 MiB each and 1000 MiB combined; existing ten-file manifests remain readable. Staging has a 5 GiB bound. Large files/batches negotiate `task-files-large-v1`; the existing 32 KiB encrypted chunks, integrity checks and restart resume remain. A real 209,715,200-byte local upload completed in 6,400 chunks with a deliberately lost acknowledgement and a restarted file store; the final SHA-256 matched. This is correctness evidence, not a LAN throughput benchmark.

Production UI checks cover removal confirmation, merged navigation, local execution settings, visible 9px running rings, reduced motion, queue confirmation and draft identity, attachment limits, English/narrow layouts, machine hover/focus/touch panels, stale readings and existing sidebar resizing/drafts. Tests also exercise successful engine completion vs approval/question/error/old-result/busy/restart states and old/new peer protocol compatibility. Active queue and attachment service checks were updated for automatic completion and passed with official OpenCode and deterministic loopback responses. No paid model request or physical-device test was used.

The task-flow interaction is a separate concept, not a dependency engine in this installer. It uses task cards with machine assignment, artifact-labelled dependencies, parallel branches and an all-upstreams join. A first product implementation should persist a workflow and dependency graph, reject cycles, dispatch only after upstream success and required artifacts are ready, block downstream work on failure, and reuse existing queue/admission/request identity. It should retain results per execution instead of silently rerunning downstream work after an upstream change. Same-machine tasks still obey actual concurrency. The concept is checked at 736px/360px in light/dark appearances.

Evidence is under `.data/verification/workflow-simplification-20260908/`. Final logic 265/265, protocol 12/12, production UI 87/87 (12 workflow, 60 sidebar, 15 machines), new isolated service 4/4, Node P0 12/12 and collaboration-file 6/6 checks passed. Type/localization/production build passed; the existing Vite chunk-size advisory remains. No assertion is made about physical LAN throughput or installed-app responsiveness.

## Verified local installer

- Path: `C:\project\rivloom-opencode\.data\verification\workflow-candidate-20260908\delivery\Rivloom_0.1.4_workflow_20260908_a152322c_x64-setup.exe`.
- Size: 79,849,157 bytes. SHA-256: `c56dff1c56086c7bc2aa66c4bf744a697a3ad88f616ea6d47642b65722b7e69f`.
- Frozen source: `a152322c6490d816b670c2c7820c8990589888a8af8d398d5aeae505c91a0d8b`, 1,093 files, uncommitted working tree based on `cad78d38a26cebc95909531870bf6b38cf58cac1`.
- Release/NSIS build and before/after source/runtime gates passed. All 7,645 extracted runtime files equal prepared bytes. The x64 application matches the native build except the verified three-byte Tauri NSIS marker.
- The 42 changed product/test/config paths relative to `50011c3d` are enumerated in `ui-source-link.json`; every other product file is unchanged. Production UI bytes match the packaged runtime. The installer script comparison allows generated CSS/JS filenames, estimated size and the exact File/Delete entries for `server/queue-confirmation.ts` and `shared/queue-backlog.ts`; all other commands and resource directory sets match.
- `build-result.json`, `extraction-result.json`, `ui-source-link.json`, `installer-static-review.json` and final `delivery-result.json` are in `.data/verification/workflow-candidate-20260908/`. The four handoff/plan documents may be updated after the frozen build; product source remains unchanged.
- No installer execution, signing, commit, push or publication. Previously deferred installed/physical/performance checks remain deferred. Larger peer transfers require both sides to support `task-files-large-v1`; old small-file transfer remains compatible.

The interactive concept is saved in the thread's task-flow visual and is separate from the installer. Its four responsive/theme checks are in `visual-proof.json`. User discussion can now focus on dependency editing, artifact handoff and failure/retry behavior; implementing that scheduler is future work.
