# Desktop Shortcut Icon Implementation Plan

**Goal:** Refresh an existing desktop shortcut after the supplied artwork replaces Rivloom's old green icon.

**Architecture:** Bundle a dedicated ICO whose installed filename includes its content digest. Update only the icon property of existing shortcuts targeting the current installation, preserving their other properties. Run the update both after installation and when the installer GUI closes, because Tauri can create the desktop shortcut on its final page.

**Tech Stack:** Existing brand exporter, Tauri resource mapping, NSIS IShellLink/IPersistFile and Windows shell notifications.

1. Diagnose the reported machine. User confirmed it is the other test computer; the old 0.1.3 installation on this development computer is unrelated and must remain untouched.
2. Extend brand export to produce a consistent hashed shell icon destination and NSIS definition. Add target-checked shortcut icon migration without recreating missing links or changing unrelated links.
3. Exercise the exact installer helper using real isolated `.lnk` files: old explicit icon, inherited EXE icon, already updated icon, missing/corrupt link and unrelated target. Verify arguments, working directory and AppUserModelID remain unchanged. Also verify the GUI finish callback updates a newly created link.
4. Freeze source, build a new package, validate the extra bundled icon and perform an isolated old-to-new installer upgrade. Preserve the current computer's desktop and installation metadata. Deliver the new installer for the other test computer; Git publication remains deferred.
