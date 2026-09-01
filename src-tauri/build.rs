fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["desktop_info", "choose_project_directory"]),
    ))
    .expect("Tauri build configuration failed");
}
