fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["desktop_info", "set_desktop_language", "choose_project_directory", "choose_task_file_destination", "notify_attention", "take_notification_target"]),
    ))
    .expect("Tauri build configuration failed");
}
