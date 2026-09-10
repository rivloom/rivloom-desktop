fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["desktop_info", "set_desktop_language", "choose_project_directory", "choose_task_file_destination", "notify_attention", "take_notification_target",
            "desktop_update_snapshot", "check_desktop_update", "skip_desktop_update", "download_desktop_update", "cancel_desktop_update", "install_desktop_update"]),
    ))
    .expect("Tauri build configuration failed");
}
