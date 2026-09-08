# Windows Taskbar Icon Implementation Plan

**Goal:** Ensure the running Windows taskbar button uses the supplied Rivloom artwork after an upgrade.

**Architecture:** Tauri 2.11.5 delegates its window icon to Tao 0.35.3, which sets only `ICON_SMALL`; its separate `ICON_BIG` is empty. Reuse the live, framework-owned icon for the large slot before showing the window. Notify the Windows shell about the updated executable after installation using a path-scoped `SHChangeNotify` event.

**Tech Stack:** Rust, Tauri, Win32 window messages, NSIS.

1. Inspect the previous packaged executable in an isolated data directory and record `WM_GETICON` for both slots. Do not operate the installed user workspace.
2. Add a Windows-only native helper, apply it before showing the main window, and add the installer notification hook. Preserve application identity, shortcuts and data paths.
3. Build the Windows package from a frozen source snapshot. Read both icon handles from the actual packaged process, save their rendered images, compare the large slot with the supplied icon, and validate packaged ICO resources.
4. Deliver a separate local installer with its hash and verification evidence. Git publication remains deferred until overall acceptance.
