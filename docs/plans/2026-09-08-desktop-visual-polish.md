# Desktop Visual Polish Implementation Plan

> Implementation: apply the frontend-design and writing-plans guidance within the user's request, execute locally, and reuse the existing isolated UI checks.

**Goal:** Refine the complete desktop interface while preserving all existing functionality and interaction semantics.

**Architecture:** Keep the three-pane workspace, 40px single-line history, own/incoming source colors, sidebar resizing, native controls, keyboard behavior and independent scrolling. Refine existing CSS and reuse the original Rivloom brand assets; bundle a small Latin Manrope font from the website's existing licensed source without adding runtime dependencies or network requests.

**Tech Stack:** React 19, existing Lucide icons, CSS, Tauri 2 and Vite; existing deterministic loopback UI verification.

---

## 1. Capture the baseline

- Read current visual and compact/resizable-sidebar records, confirm the clean source baseline, and inspect existing screenshots.
- Run `npm run build` and the existing `.data/verification/sidebar-resize-20260908/sidebar-ui-check.mjs` against the current production output with `--label before`.
- Save the baseline under `.data/verification/desktop-visual-polish-20260908/`.

## 2. Refine the visual system and main workspace

- Modify `src/styles.css` and `src/conversation-workspace.css`: neutral paper surfaces, precise blue accents, consistent strokes and corner radii, clear text hierarchy, restrained shadows and readable state treatments.
- Add the original Manrope Latin variable WOFF2 in `src/assets/fonts/`, its full license in `docs/licenses/fonts/`, and an attribution in `THIRD_PARTY_NOTICES.md`.
- Refine identity/history, header, empty state, transcript/tool results, composer and paired-machine/queue presentation. Preserve row heights, sidebar constraints, compact settings, all content and action handlers.
- Apply the same visual vocabulary to attention, diagnostics, node/model settings, file panels and dialogs.
- Keep state colors meaningful and focus visible. Do not add animation loops, background blur, polling, new libraries or new interaction delays.

## 3. Verify and deliver

- Run the production build, relevant existing conversation/filter/sidebar/i18n tests and the existing 60-check isolated sidebar regression. Review CSS/asset-only implementation changes separately from documentation.
- Inspect production screenshots for Chinese/English, 1280×840 and 960×640 desktop, narrow sidebars and the existing mobile fallback. Confirm compact history density, no clipping, focus, resizing and draft/selection retention.
- Inspect the empty state, conversation, queue, attention, diagnostics, model/node settings and dialogs using isolated synthetic data; no formal client state or real model requests.
- Prepare a local NSIS candidate from frozen source, verify its runtime and extracted files, and provide it for the user to install. Do not run the installer or publish it to the website.
- Record actual passed checks, limitations and visual artifacts in this plan and the current handoff. This pass does not restart the previously deferred physical/long-running performance tests or install over the user's desktop.

## Follow-up requested by the user

After the visual work, remind the user to discuss the important desktop responsiveness and interaction points they want to raise. Keep that discussion separate from assumptions about performance being solved by visual changes.

## Visual verification completed

The implementation is limited to three CSS files, a 24,836-byte Manrope font and its license/notice. Application handlers, API/state/queue/approval logic and localization catalogs are unchanged. No new JavaScript dependency or background work was introduced; the modal backdrop no longer applies a blur filter.

Production/type/localization checks passed. The existing conversation, draft, filter, sidebar and language tests passed 36/36. The existing isolated sidebar regression passed 60/60 after final adjustments. All eight locale/window combinations retain their prior complete visible history counts: 1280×840 8/8; 960×640 4/4; 860×640 4/3; 390×700 4/4. History rows remain exactly 40px. The first font pass wrapped narrow English navigation and reduced one count; the final typography and identity spacing restore that count.

23 additional production UI scenes passed with synthetic data, zero browser exceptions and zero non-loopback requests. Screens include the empty workspace, conversation/tool output, queue, attention, diagnostics, node/model settings, profile/about dialogs, Node mentions, composer options and desktop/mobile English layouts. Low-height blank content now remains reachable from the top of its scroll area. Screenshots and reports are in `.data/verification/desktop-visual-polish-20260908/` (`verified-sidebar/` and `scenes-final/`). These are isolated Edge rendering checks, not installed-client or physical-device acceptance.

## Local installer completed

The local NSIS candidate is `.data/verification/visual-candidate-20260908/delivery/Rivloom_0.1.4_visual_20260908_b0a75891_x64-setup.exe`, 79,848,816 bytes, SHA-256 `2b08071e1152152d02ffcc4934c915a9834fbf5ab44eca82291a439fcde7dc92`. It retains Rivloom 0.1.4 and `com.rivloom.desktop`, and is for the user to install. It has not been executed, signed, committed, pushed or published in this pass.

The frozen source digest is `b0a75891704b15ca739188cb670af6b5f5e3a349b6e8aeaf1075c6d95c9ad4a4`, based on `cad78d38a26cebc95909531870bf6b38cf58cac1`, with 1,084 captured source files. Rust 1.98.1 Release and NSIS succeeded; source and prepared runtime remained unchanged during build. All 7,643 extracted runtime files match the prepared bytes and pass the runtime gate. The packaged x64 EXE matches the native build except the verified three-byte Tauri NSIS marker. Generated installer control flow matches the prior sidebar candidate after accounting for asset filenames, size and the new font/license resources.

The production JavaScript is byte-identical to the baseline despite its generated filename changing. CSS is 93,620 bytes (baseline 91,642), plus the 24,836-byte local font; there is no external font request. The entire production output matches the packaged runtime output, and the font plus full copyright/license text match source. These checks establish delivery consistency and do not establish a measured frame-rate, input latency or native window-drag improvement.

Evidence is in `.data/verification/visual-candidate-20260908/`: `source-context.json`, `build-result.json`, `extraction-result.json`, `ui-source-link.json`, `installer-static-review.json` and `delivery-result.json`. Final handoff edits occur after source capture and only update documentation; the packaged product source remains unchanged. The previously deferred installed-client and physical tests remain deferred. The next conversation should address the user's important desktop responsiveness and interaction points, as requested.
