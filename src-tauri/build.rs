fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["desktop_info", "set_desktop_language", "choose_project_directory", "choose_task_file_destination", "reveal_task_file", "open_task_file", "open_project_directory", "notify_attention", "take_notification_target",
            "desktop_update_snapshot", "check_desktop_update", "skip_desktop_update", "download_desktop_update", "cancel_desktop_update", "install_desktop_update", "confirm_desktop_startup", "inspect_lan_firewall", "repair_lan_firewall"]),
    ))
    .expect("Tauri build configuration failed");
}
