use std::{ffi::c_void, io};

#[link(name = "user32")]
extern "system" {
    fn SendMessageW(window: *mut c_void, message: u32, wparam: usize, lparam: isize) -> isize;
}

const WM_GETICON: u32 = 0x007f;
const WM_SETICON: u32 = 0x0080;
const ICON_SMALL: usize = 0;
const ICON_BIG: usize = 1;

/// Tao's window icon setter only fills ICON_SMALL on Windows. Give the taskbar
/// the same supplied artwork instead of falling back to a cached executable icon.
pub fn apply(window: &tauri::WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    let hwnd = window.hwnd()?.0;
    // SAFETY: setup runs on the window thread and hwnd belongs to this live
    // window. Tauri/Tao owns the HICON until the window is destroyed. We borrow
    // it for the second slot; do not destroy or replace the framework's owner.
    let icon = unsafe { SendMessageW(hwnd, WM_GETICON, ICON_SMALL, 0) };
    if icon == 0 {
        return Err(io::Error::other("Rivloom window icon is unavailable").into());
    }
    unsafe { SendMessageW(hwnd, WM_SETICON, ICON_BIG, icon) };
    Ok(())
}
