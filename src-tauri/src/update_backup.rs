//! Consistent application-state copies made only after the owned runtime exits.
//! User project directories are references inside the database, never traversal roots.
use serde::{Deserialize, Serialize};
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

pub(crate) fn regular_metadata(path: &Path) -> Result<fs::Metadata, String> {
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

#[derive(Debug, Default, PartialEq)]
pub struct Cleanup { pub removed: usize, pub failed: usize, pub retained: usize }

pub(crate) fn backup_versions(name: &str) -> Option<(String, String)> {
    if name.len() > 160 { return None; }
    let (versions, stamp) = name.rsplit_once('-')?;
    let timestamp = stamp.parse::<u128>().ok()?;
    if timestamp == 0 || timestamp.to_string() != stamp { return None; }
    let (from, to) = versions.split_once("-to-")?;
    let stable = |text: &str| semver::Version::parse(text).ok().filter(|v| v.pre.is_empty() && v.build.is_empty() && v.to_string() == text);
    if stable(to)? <= stable(from)? { return None; }
    Some((from.to_owned(), to.to_owned()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupHeader { schema_version: u32, from_version: String, to_version: String }

fn check_backup_tree(root: &Path, path: &Path, count: &mut usize) -> Result<(), String> {
    *count += 1;
    if *count > 400_001 { return Err("update_backup_cleanup_failed".into()); }
    let metadata = regular_metadata(path)?;
    if !fs::canonicalize(path).map_err(|_| "update_backup_cleanup_failed")?.starts_with(root) { return Err("update_backup_cleanup_failed".into()); }
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|_| "update_backup_cleanup_failed")? {
            check_backup_tree(root, &entry.map_err(|_| "update_backup_cleanup_failed")?.path(), count)?;
        }
    }
    Ok(())
}

/// Called only after this installed version has a healthy runtime and rendered workspace.
/// Never use database project paths or manifest file paths as deletion targets.
pub fn cleanup_after_startup(data_dir: &Path, current: &str) -> Result<Cleanup, String> {
    let current = semver::Version::parse(current).ok().filter(|v| v.pre.is_empty() && v.build.is_empty() && v.to_string() == current).ok_or("update_backup_cleanup_failed")?;
    if !data_dir.is_absolute() { return Err("update_backup_cleanup_failed".into()); }
    let updates = data_dir.join(".updates");
    let backups = updates.join("backups");
    if !backups.try_exists().map_err(|_| "update_backup_cleanup_failed")? { return Ok(Cleanup::default()); }
    for path in [data_dir, updates.as_path(), backups.as_path()] {
        if !regular_metadata(path)?.is_dir() { return Err("update_backup_cleanup_failed".into()); }
    }
    let expected = fs::canonicalize(data_dir).map_err(|_| "update_backup_cleanup_failed")?.join(".updates").join("backups");
    let root = fs::canonicalize(&backups).map_err(|_| "update_backup_cleanup_failed")?;
    if root != expected { return Err("update_backup_cleanup_failed".into()); }
    let mut result = Cleanup::default();
    for entry in fs::read_dir(&backups).map_err(|_| "update_backup_cleanup_failed")? {
        let entry = entry.map_err(|_| "update_backup_cleanup_failed")?;
        let path = entry.path();
        let Some((from, to)) = entry.file_name().to_str().and_then(backup_versions) else { result.retained += 1; continue; };
        if semver::Version::parse(&to).map_err(|_| "update_backup_cleanup_failed")? > current { result.retained += 1; continue; }
        let remove = || -> Result<(), String> {
            if !regular_metadata(&path)?.is_dir() { return Err("update_backup_cleanup_failed".into()); }
            let resolved = fs::canonicalize(&path).map_err(|_| "update_backup_cleanup_failed")?;
            if !resolved.is_absolute() || resolved.parent() != Some(root.as_path()) { return Err("update_backup_cleanup_failed".into()); }
            let manifest = path.join("backup-manifest.json");
            if manifest.try_exists().map_err(|_| "update_backup_cleanup_failed")? {
                let metadata = regular_metadata(&manifest)?;
                if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 { return Err("update_backup_cleanup_failed".into()); }
                let header: BackupHeader = serde_json::from_slice(&fs::read(&manifest).map_err(|_| "update_backup_cleanup_failed")?).map_err(|_| "update_backup_cleanup_failed")?;
                if header.schema_version != 1 || header.from_version != from || header.to_version != to { return Err("update_backup_cleanup_failed".into()); }
            }
            // Also handles copies interrupted before their final manifest and retries
            // after a partial deletion. Every actual child is checked, never followed.
            check_backup_tree(&resolved, &path, &mut 0)?;
            if fs::canonicalize(&path).map_err(|_| "update_backup_cleanup_failed")? != resolved { return Err("update_backup_cleanup_failed".into()); }
            fs::remove_dir_all(&path).map_err(|_| "update_backup_cleanup_failed".into())
        };
        if remove().is_ok() { result.removed += 1; } else { result.failed += 1; }
    }
    Ok(result)
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

    #[test]
    fn successful_startup_deletes_all_past_backups_and_partial_copies_but_keeps_live_data_and_future_versions() {
        let root = root();
        fs::write(root.join("rivloom.sqlite"), b"current database").unwrap();
        fs::create_dir(root.join("project")).unwrap();
        fs::write(root.join("project/source.txt"), b"current project").unwrap();
        let first = backup(&root, "0.1.5", "0.1.6", |_| {}).unwrap();
        let second = backup(&root, "0.1.6", "0.1.7", |_| {}).unwrap();
        let latest = backup(&root, "0.1.7", "0.1.8", |_| {}).unwrap();
        let future = backup(&root, "0.1.8", "0.1.9", |_| {}).unwrap();
        let backups = root.join(".updates/backups");
        let partial = backups.join("0.1.6-to-0.1.7-123");
        fs::create_dir(&partial).unwrap(); fs::write(partial.join("partial.db"), b"partial").unwrap();
        let unknown = backups.join("my-files");
        fs::create_dir(&unknown).unwrap(); fs::write(unknown.join("keep.txt"), b"keep").unwrap();
        let result = cleanup_after_startup(&root, "0.1.8").unwrap();
        assert_eq!(result, Cleanup { removed: 4, failed: 0, retained: 2 });
        for path in [first, second, latest, partial] { assert!(!path.exists()); }
        assert!(future.join("backup-manifest.json").exists()); assert!(unknown.join("keep.txt").exists());
        assert_eq!(fs::read(root.join("rivloom.sqlite")).unwrap(), b"current database");
        assert_eq!(fs::read(root.join("project/source.txt")).unwrap(), b"current project");
        assert_eq!(cleanup_after_startup(&root, "0.1.8").unwrap().removed, 0);
        assert_eq!(cleanup_after_startup(&root, "0.1.9").unwrap().removed, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_rejects_unknown_names_mismatched_manifests_and_invalid_current_versions() {
        let root = root(); fs::write(root.join("rivloom.sqlite"), b"current").unwrap();
        let malformed = backup(&root, "0.1.7", "0.1.8", |_| {}).unwrap();
        fs::write(malformed.join("backup-manifest.json"), br#"{"schemaVersion":1,"fromVersion":"0.1.7","toVersion":"9.9.9"}"#).unwrap();
        for bad in ["v0.1.8", "0.1.8-beta", "0.1.8+other", "../outside"] { assert!(cleanup_after_startup(&root, bad).is_err()); }
        assert!(cleanup_after_startup(Path::new("relative"), "0.1.8").is_err());
        for bad in ["0.1.7-to-0.1.8-001", "0.1.8-to-0.1.7-123", "0.1.7-to-0.1.8-0", "../0.1.7-to-0.1.8-123"] { assert!(backup_versions(bad).is_none()); }
        assert_eq!(cleanup_after_startup(&root, "0.1.8").unwrap().failed, 1);
        assert!(malformed.join("rivloom.sqlite").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_refuses_junctions_at_the_root_backup_and_inside_a_copy() {
        use std::os::windows::process::CommandExt;
        fn junction(link: &Path, target: &Path) {
            let output = std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"])
                .arg(link.to_string_lossy().replace('/', "\\")).arg(target.to_string_lossy().replace('/', "\\"))
                .creation_flags(0x08000000).output().unwrap();
            assert!(output.status.success(), "Junction fixture failed: {} {}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        }
        let root = root(); let outside = root.with_extension("outside");
        fs::create_dir(&outside).unwrap(); fs::write(outside.join("keep.txt"), b"project data").unwrap();
        fs::create_dir(root.join(".updates")).unwrap(); junction(&root.join(".updates/backups"), &outside);
        assert!(cleanup_after_startup(&root, "0.1.8").is_err());
        fs::remove_dir(root.join(".updates/backups")).unwrap();
        let copy = backup(&root, "0.1.7", "0.1.8", |_| {}).unwrap();
        junction(&copy.join("linked-project"), &outside);
        junction(&root.join(".updates/backups/0.1.6-to-0.1.7-123"), &outside);
        assert_eq!(cleanup_after_startup(&root, "0.1.8").unwrap().failed, 2);
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"project data");
        assert!(copy.join("backup-manifest.json").exists());
        fs::remove_dir(copy.join("linked-project")).unwrap();
        fs::remove_dir(root.join(".updates/backups/0.1.6-to-0.1.7-123")).unwrap();
        fs::remove_dir_all(root).unwrap(); fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_locked_backup_is_retried_without_touching_live_files() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = root(); fs::write(root.join("rivloom.sqlite"), b"live data").unwrap();
        let copy = backup(&root, "0.1.7", "0.1.8", |_| {}).unwrap();
        let locked = fs::OpenOptions::new().read(true).share_mode(0).open(copy.join("rivloom.sqlite")).unwrap();
        assert_eq!(cleanup_after_startup(&root, "0.1.8").unwrap().failed, 1);
        assert_eq!(fs::read(root.join("rivloom.sqlite")).unwrap(), b"live data");
        drop(locked);
        assert_eq!(cleanup_after_startup(&root, "0.1.8").unwrap().removed, 1);
        assert!(!copy.exists()); fs::remove_dir_all(root).unwrap();
    }
}
