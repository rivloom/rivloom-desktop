# Chinese and English Localization Implementation Plan

> Implementation workflow: use the executing-plans skill task by task within the user's authorization.

**Goal:** Provide persistent Simplified Chinese/English switching in the desktop client, publish a bilingual website, and deliver a verified local Windows installer.

**Architecture:** Use i18next/react-i18next with checked-in catalogs for React and application-owned messages. Keep user content, model output, identifiers and protocol values intact. Native dialogs use the same checked-in translation resources and persist the desktop preference outside the random loopback origin. The separate Astro website uses built-in locale routing, shared templates and complete language catalogs, retaining Chinese URLs and adding `/en/` equivalents.

**Tech Stack:** React 19, i18next, react-i18next, TypeScript, Tauri 2/Rust, Astro 7 static i18n, existing Windows packaging and Cloudflare Pages workflows.

**Execution status (2026-09-07):** Tasks 1–3 complete. Task 4 is implemented and locally verified (37 tests, 18 pages); publication is blocked by automatic review requiring explicit permission to lift the earlier no-Git-push restriction. Task 5 has passed 206 logic, 11 protocol, 3 Rust tests, browser draft/file retention, live error translation and layout checks. Native preview built and started; Windows UI automation app approval timed out, so native clicks remain pending. The local unsigned installer is being finalized with source/runtime/extraction evidence retained under ignored verification files; this status does not claim public release or installation.

## Task 1: Catalogs and contracts

- Inspect all UI, shared display helpers, application-owned server messages and native dialogs; classify text versus user data/protocol values.
- Add `shared/locales/`, shared translation helpers, an extraction/coverage check, and an ADR documenting source-key catalogs, fallback, persistence and translation ownership.
- Validate English/Chinese key and interpolation parity, supported locale normalization and fallback. Unknown external/model text remains unchanged.

## Task 2: Client language lifecycle

- Add i18next/react-i18next production dependencies, initialize before rendering, and expose an accessible language switch in startup/auth and the workspace.
- Persist desktop language with the guarded native bridge, using browser storage only in Web debugging; update document language and locale-sensitive dates/numbers.
- Switching rerenders existing views without remounting tasks, losing draft/file selections or changing identities.

## Task 3: Full client surface

- Convert `src/main.tsx`, `src/ui.tsx`, workspace, node/Brain, model settings, queue receipts, attention, diagnostics and file UI to catalog-driven text.
- Localize generated display text and known application errors; use structured HTTP status for authentication handling instead of Chinese substring matching.
- Localize native confirmation, toast and file/folder picker text. Keep uploaded filenames, task content, AI output and peer/user names verbatim.

## Task 4: Website implementation and validation

- In the separate website repository, use Astro's i18n config and locale URL helper, shared page components and complete Chinese/English content.
- Preserve `/` and existing Chinese paths; add `/en/`, locale-preserving navigation, language selector, `lang`, canonical/hreflang, both locales in sitemap, and translated metadata/404/download safety wording.
- Translate all public pages without claiming unreleased client features are in the public download. Update locale-aware site checks and release-page assertions without weakening release eligibility.
- Run tests/build, inspect desktop/mobile layouts and switching, then publish the website through its existing Git/Cloudflare flow and verify live pages.

## Task 5: Desktop verification and delivery

- Run translation coverage, relevant logic/protocol/service tests, type/build and Rust checks. Exercise locale changes, restart persistence, drafts, dialogs and application errors in isolated fixtures without paid model calls or formal data changes.
- Refresh dependency notices, prepare desktop runtime, record an exact source snapshot, build the formal-identity unsigned NSIS test installer, and verify gates, extraction and packaged runtime.
- Keep only needed evidence and deliverable; remove redundant disposable caches after recording results. Retain prior baseline installers, formal backups and meaningful histories.
- Save detailed machine/session records under ignored `.data/handoff` and `.data/verification`. Do not push the desktop repository or install over the user's client. Return the live website and the new installer directory.
