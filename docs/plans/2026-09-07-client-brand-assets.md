# Client Brand Assets Implementation Plan

**Goal:** Apply the supplied Rivloom artwork consistently to the Windows application, installer and client brand surfaces, then deliver an updated local installer including the completed bilingual work.

**Architecture:** Preserve the supplied PNG artwork. Keep shared React brand components for the UI, and generate Windows/other existing Tauri icon resources from a square SVG composition of the original gradient symbol. A light rounded background keeps the dark-blue symbol legible on both taskbar themes. Use the supplied full wordmark for loading, sign-in and empty-conversation branding; preserve the existing small sidebar wordmark.

**Tech Stack:** React, CSS, SVG composition, official installed Tauri icon generator and existing NSIS packaging/runtime verification.

1. Inspect and compare the supplied originals with `src/assets/brand` and `src-tauri/icons`. Record artwork provenance and a reproducible icon export command; do not regenerate or redraw the logo.
2. Update shared brand presentation and favicon. Export application and installer icons at their native sizes. Check transparent margins, small-size contrast and existing light/dark surfaces.
3. Run existing localization/type/build checks and inspect the changed client surfaces at 960×640 and 1280×840. No behavior or protocol changes are intended, so avoid adding tests that merely duplicate asset declarations.
4. Prepare the production runtime, capture a new exact source snapshot, build the unsigned formal-identity NSIS installer and verify extraction/runtime resources. Keep the previous bilingual package and deliver the new standard installer directory. Do not install, push or publish automatically.
