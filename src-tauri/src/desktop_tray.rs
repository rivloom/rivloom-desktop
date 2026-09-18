//! Closing the workspace keeps its owned runtime alive; only explicit quit stops it.
use std::{fs, path::Path, sync::atomic::Ordering, thread};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use crate::{native_text, DesktopState};

const ACKNOWLEDGEMENT: &str = "close-to-tray-acknowledged.txt";

struct TrayState {
    _icon: TrayIcon,
    open: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

fn acknowledged(data_dir: &Path) -> bool {
    let path = data_dir.join(ACKNOWLEDGEMENT);
    fs::metadata(&path).is_ok_and(|meta| meta.is_file() && meta.len() <= 8)
        && fs::read_to_string(path).is_ok_and(|value| value.trim() == "1")
}

fn acknowledge(data_dir: &Path) -> std::io::Result<()> {
    let temporary = data_dir.join("close-to-tray-acknowledged.tmp");
    fs::write(&temporary, "1\n")?;
    fs::rename(temporary, data_dir.join(ACKNOWLEDGEMENT))
}

pub fn show_workspace(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let desktop = app.state::<DesktopState>();
    let open = MenuItem::with_id(
        app,
        "tray-open",
        native_text(&desktop.data_dir, "打开 Rivloom"),
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "tray-quit",
        native_text(&desktop.data_dir, "退出 Rivloom"),
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
    let icon = TrayIconBuilder::with_id("rivloom-tray")
        .icon(
            app.default_window_icon()
                .expect("Bundled Rivloom icon")
                .clone(),
        )
        .tooltip(app.config().product_name.as_deref().unwrap_or("Rivloom"))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-open" => show_workspace(app),
            "tray-quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show_workspace(tray.app_handle());
            }
        })
        .build(app)?;
    app.manage(TrayState {
        _icon: icon,
        open,
        quit,
    });
    Ok(())
}

pub fn update_language(app: &AppHandle) -> tauri::Result<()> {
    let desktop = app.state::<DesktopState>();
    if let Some(tray) = app.try_state::<TrayState>() {
        tray.open
            .set_text(native_text(&desktop.data_dir, "打开 Rivloom"))?;
        tray.quit
            .set_text(native_text(&desktop.data_dir, "退出 Rivloom"))?;
    }
    Ok(())
}

// Keep the same guard as explicit quit and updater installation: no overlapping
// native dialogs, runtime shutdown, or update backup while a decision is pending.
pub fn request_hide(app: &AppHandle) {
    let desktop = app.state::<DesktopState>();
    if desktop.closing.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        desktop.closing.store(false, Ordering::SeqCst);
        return;
    };
    if acknowledged(&desktop.data_dir) {
        hide_workspace(app);
        return;
    }
    let callback_app = app.clone();
    app.dialog()
        .message(native_text(&desktop.data_dir, "关闭窗口后，Rivloom 会留在任务栏右下角的系统托盘，任务继续在后台运行。点击托盘图标可重新打开；如需退出，请右键点击托盘图标，选择“退出 Rivloom”。点击“知道了”后不再提示。"))
        .title(native_text(&desktop.data_dir, "关闭后仍在后台运行"))
        .parent(&window)
        .buttons(MessageDialogButtons::OkCancelCustom(native_text(&desktop.data_dir, "知道了"), native_text(&desktop.data_dir, "留在工作区")))
        .show(move |confirmed| {
            let desktop = callback_app.state::<DesktopState>();
            if !confirmed {
                desktop.closing.store(false, Ordering::SeqCst);
            } else if acknowledge(&desktop.data_dir).is_err() {
                show_error(&callback_app, "提示设置未能保存，请重试。");
            } else {
                hide_workspace(&callback_app);
            }
        });
}

fn hide_workspace(app: &AppHandle) {
    let desktop = app.state::<DesktopState>();
    if let Some(window) = app.get_webview_window("main") {
        if window.hide().is_err() {
            show_error(app, "窗口未能隐藏到系统托盘，请重试。");
            return;
        }
    }
    desktop.closing.store(false, Ordering::SeqCst);
}

fn show_error(app: &AppHandle, message: &str) {
    let desktop = app.state::<DesktopState>();
    let callback_app = app.clone();
    let mut dialog = app
        .dialog()
        .message(native_text(&desktop.data_dir, message))
        .title("Rivloom");
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    dialog.show(move |_| {
        callback_app
            .state::<DesktopState>()
            .closing
            .store(false, Ordering::SeqCst);
    });
}

fn request_quit(app: &AppHandle) {
    let desktop = app.state::<DesktopState>();
    if desktop.closing.swap(true, Ordering::SeqCst) {
        return;
    }
    // Selecting Quit in the tray is already an explicit exit request.
    let callback_app = app.clone();
    thread::spawn(move || {
        if let Ok(mut runtime) = callback_app.state::<DesktopState>().runtime.lock() {
            runtime.stop();
        }
        callback_app.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notice_is_required_until_acknowledgement_is_saved_and_survives_restarts() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("rivloom-tray-{}-{suffix}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let identity = root.join("identity-sentinel.txt");
        fs::write(&identity, "unchanged").unwrap();
        assert!(!acknowledged(&root));
        for invalid in ["", "0", "true", "corrupted", "111111111"] {
            fs::write(root.join(ACKNOWLEDGEMENT), invalid).unwrap();
            assert!(!acknowledged(&root));
        }
        acknowledge(&root).unwrap();
        // Re-read from disk, with no process-local cache.
        assert!(acknowledged(&root));
        acknowledge(&root).unwrap();
        assert!(acknowledged(&root));
        assert!(!root.join("close-to-tray-acknowledged.tmp").exists());
        assert_eq!(fs::read_to_string(&identity).unwrap(), "unchanged");
        fs::remove_file(root.join(ACKNOWLEDGEMENT)).unwrap();
        fs::remove_file(identity).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn failed_save_does_not_acknowledge_the_notice() {
        let root = std::env::temp_dir()
            .join(format!("rivloom-tray-missing-{}", std::process::id()))
            .join("absent");
        assert!(acknowledge(&root).is_err());
        assert!(!acknowledged(&root));
    }
}
