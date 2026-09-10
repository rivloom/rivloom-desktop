//! Consistent application-state copies made only after the owned runtime exits.
//! User project directories are references inside the database, never traversal roots.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, time::{Instant, SystemTime, UNIX_EPOCH}};

#[derive(Clone, Default, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgress { pub files: u64, pub total_files: u64, pub bytes: u64, pub total_bytes: u64 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupFile { path: String, bytes: u64, sha256: String }

fn excluded(relative: &Path) -> bool {
    let path = relative.to_string_lossy().replace('\\', "/");
    let root = path.split('/').next().unwrap_or("");
    matches!(root, ".updates" | "webview" | "app.lock" | "desktop-runtime.json" | "desktop-auth-token.txt" | "update-shutdown.json") ||
        path == "engine/cache" || path.starts_with("engine/cache/") ||
        path == "engine/temp" || path.starts_with("engine/temp/")
}

fn regular_metadata(path: &Path) -> Result<fs::Metadata, String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "update_backup_failed")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 { return Err("update_backup_failed".into()); }
    }
    if meta.file_type().is_symlink() || (!meta.is_file() && !meta.is_dir()) { return Err("update_backup_failed".into()); }
    Ok(meta)
}

pub fn private_state_directory(data_dir: &Path) -> Result<PathBuf, String> {
    if !regular_metadata(data_dir)?.is_dir() { return Err("update_backup_failed".into()); }
    let path = data_dir.join(".updates");
    if path.exists() { regular_metadata(&path)?; }
    else { fs::create_dir(&path).map_err(|_| "update_backup_failed")?; }
    Ok(path)
}

fn files_below(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|_| "update_backup_failed")? {
        let path = entry.map_err(|_| "update_backup_failed")?.path();
        let relative = path.strip_prefix(root).map_err(|_| "update_backup_failed")?;
        if excluded(relative) { continue; }
        let meta = regular_metadata(&path)?;
        if meta.is_dir() { files_below(root, &path, files)?; }
        else { files.push(relative.to_owned()); }
        if files.len() > 200_000 { return Err("update_backup_failed".into()); }
    }
    Ok(())
}

pub fn backup(data_dir: &Path, from: &str, to: &str, mut progress: impl FnMut(BackupProgress)) -> Result<PathBuf, String> {
    let stable = |value: &str| semver::Version::parse(value).is_ok_and(|v| v.pre.is_empty() && v.build.is_empty());
    if !stable(from) || !stable(to) { return Err("update_backup_failed".into()); }
    let state = private_state_directory(data_dir)?;
    let backups = state.join("backups");
    if backups.exists() { regular_metadata(&backups)?; }
    else { fs::create_dir(&backups).map_err(|_| "update_backup_failed")?; }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "update_backup_failed")?.as_nanos();
    let destination = backups.join(format!("{from}-to-{to}-{now}"));
    fs::create_dir(&destination).map_err(|_| "update_backup_failed")?;
    let mut paths = Vec::new();
    files_below(data_dir, data_dir, &mut paths)?;
    paths.sort();
    let mut status = BackupProgress { total_files: paths.len() as u64, ..Default::default() };
    for relative in &paths {
        status.total_bytes = status.total_bytes.checked_add(regular_metadata(&data_dir.join(relative))?.len()).ok_or("update_backup_failed")?;
    }
    progress(status.clone());
    let mut reported = Instant::now();
    let mut inventory = Vec::new();
    for relative in paths {
        let source = data_dir.join(&relative);
        let before = regular_metadata(&source)?;
        let target = destination.join(&relative);
        if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|_| "update_backup_failed")?; }
        let mut input = fs::File::open(&source).map_err(|_| "update_backup_failed")?;
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|_| "update_backup_failed")?;
        let mut digest = Sha256::new();
        let mut bytes = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = input.read(&mut buffer).map_err(|_| "update_backup_failed")?;
            if count == 0 { break; }
            output.write_all(&buffer[..count]).map_err(|_| "update_backup_failed")?;
            digest.update(&buffer[..count]); bytes += count as u64;
            status.bytes += count as u64;
            if reported.elapsed().as_millis() >= 200 { progress(status.clone()); reported = Instant::now(); }
        }
        output.sync_all().map_err(|_| "update_backup_failed")?;
        let after = regular_metadata(&source)?;
        if bytes != before.len() || bytes != after.len() || before.modified().ok() != after.modified().ok() {
            return Err("update_backup_failed".into());
        }
        inventory.push(BackupFile { path: relative.to_string_lossy().replace('\\', "/"), bytes, sha256: format!("{:x}", digest.finalize()) });
        status.files += 1;
        if status.files < status.total_files && reported.elapsed().as_millis() >= 200 { progress(status.clone()); reported = Instant::now(); }
    }
    // A completed manifest is the commit marker. A partial copy is never restored as a complete backup.
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({ "schemaVersion": 1, "complete": true,
        "fromVersion": from, "toVersion": to, "files": inventory })).map_err(|_| "update_backup_failed")?;
    let mut manifest = fs::OpenOptions::new().write(true).create_new(true).open(destination.join("backup-manifest.json")).map_err(|_| "update_backup_failed")?;
    manifest.write_all(&bytes).and_then(|_| manifest.sync_all()).map_err(|_| "update_backup_failed")?;
    progress(status);
    Ok(destination)
}

pub fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if path.exists() { regular_metadata(path)?; }
    let temporary = path.with_extension("tmp");
    if temporary.exists() { regular_metadata(&temporary)?; }
    let bytes = serde_json::to_vec(value).map_err(|_| "update_save_failed")?;
    let mut file = fs::OpenOptions::new().write(true).truncate(true).create(true).open(&temporary).map_err(|_| "update_save_failed")?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "update_save_failed")?;
    drop(file);
    fs::rename(temporary, path).map_err(|_| "update_save_failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf {
        let path = std::env::temp_dir().join(format!("rivloom-update-backup-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&path).unwrap(); path
    }
    #[test]
    fn backup_preserves_identity_databases_files_and_engine_state_without_following_projects() {
        let root = root();
        for file in ["rivloom.sqlite", "rivloom.sqlite-wal", "node-identity.json", "node-trust.json", "engine/data/opencode/auth.json", "engine/state/records.json", "task-files/blobs/file.blob", "resource-files/material.json", "webview/cache", "engine/cache/cache", ".updates/old-backup/secret", "app.lock"] {
            let path = root.join(file); fs::create_dir_all(path.parent().unwrap()).unwrap(); fs::write(path, file.as_bytes()).unwrap();
        }
        let copied = backup(&root, "0.1.4", "0.1.5", |_| {}).unwrap();
        for file in ["rivloom.sqlite", "rivloom.sqlite-wal", "node-identity.json", "node-trust.json", "engine/data/opencode/auth.json", "engine/state/records.json", "task-files/blobs/file.blob", "resource-files/material.json"] {
            assert_eq!(fs::read(copied.join(file)).unwrap(), file.as_bytes());
        }
        for file in ["webview", "engine/cache", ".updates", "app.lock"] { assert!(!copied.join(file).exists()); }
        let manifest: serde_json::Value = serde_json::from_slice(&fs::read(copied.join("backup-manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["complete"], true);
        assert!(root.join("node-identity.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn preference_writes_replace_atomically_and_reject_invalid_backup_versions() {
        let root = root(); let path = root.join("preferences.json");
        atomic_json(&path, &serde_json::json!({"skippedVersion":"0.1.5"})).unwrap();
        atomic_json(&path, &serde_json::json!({"skippedVersion":"0.1.6"})).unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&fs::read(path).unwrap()).unwrap()["skippedVersion"], "0.1.6");
        assert!(backup(&root, "../bad", "0.1.5", |_| {}).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn progress_counts_only_application_data_and_finishes_after_manifest_commit() {
        let root = root();
        fs::write(root.join("rivloom.sqlite"), b"database").unwrap();
        fs::write(root.join("node-identity.json"), b"identity").unwrap();
        fs::create_dir(root.join("webview")).unwrap();
        fs::write(root.join("webview/cache"), vec![0; 4096]).unwrap();
        let mut events = Vec::new();
        let copied = backup(&root, "0.1.6", "0.1.7", |event| {
            assert!(event.files <= event.total_files && event.bytes <= event.total_bytes);
            if event.files == event.total_files {
                assert!(fs::read_dir(root.join(".updates/backups")).unwrap().filter_map(Result::ok)
                    .any(|entry| entry.path().join("backup-manifest.json").is_file()));
            }
            events.push(event);
        }).unwrap();
        assert_eq!(events.first().unwrap(), &BackupProgress { files: 0, total_files: 2, bytes: 0, total_bytes: 16 });
        assert_eq!(events.last().unwrap(), &BackupProgress { files: 2, total_files: 2, bytes: 16, total_bytes: 16 });
        assert!(events.windows(2).all(|pair| pair[0].bytes <= pair[1].bytes && pair[0].files <= pair[1].files));
        assert!(!copied.join("webview").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
