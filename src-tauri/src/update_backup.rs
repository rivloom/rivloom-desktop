//! Consistent application-state copies made only after the owned runtime exits.
//! User project directories are references inside the database, never traversal roots.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, io::{Read, Write}, path::{Path, PathBuf}, time::{Instant, SystemTime, UNIX_EPOCH}};

#[derive(Clone, Default, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgress { pub files: u64, pub total_files: u64, pub bytes: u64, pub total_bytes: u64 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupFile { path: String, bytes: u64, sha256: String }

const DEPENDENCY_MARKER: &str = ".rivloom-plugin-dependencies";
const DEPENDENCY_INVENTORY: &str = ".rivloom-plugin-dependencies-files.json";

// Both the shared engine and each account have their own cache/config/data roots.
// Do not apply these rules to similarly named folders in attachments or user data.
fn engine_relative(relative: &Path) -> Option<&Path> {
    let path = relative.strip_prefix("engine").ok()?;
    if let Ok(accounts) = path.strip_prefix("accounts") {
        let mut components = accounts.components();
        components.next()?;
        Some(components.as_path())
    } else { Some(path) }
}

fn excluded(relative: &Path) -> bool {
    let root = relative.components().next().and_then(|c| c.as_os_str().to_str()).unwrap_or("");
    matches!(root, ".updates" | "webview" | "app.lock" | "desktop-runtime.json" | "desktop-auth-token.txt" | "update-shutdown.json") ||
        engine_relative(relative).is_some_and(|path| path.starts_with("cache") || path.starts_with("temp"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DependencyInventory { schema_version: u32, fingerprint: String, files: Vec<DependencyFile> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DependencyFile { path: String, bytes: u64, sha256: String }

fn bounded_read(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let metadata = regular_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > limit { return None; }
    let mut bytes = Vec::new();
    fs::File::open(path).ok()?.take(limit + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

fn sha256_text(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

// A marker alone cannot prove that node_modules contains only shipped files.
// Keep the entire tree (and its marker) if a user added/changed a dependency,
// the inventory is absent/stale, or any file cannot be verified. Only a complete
// match can be rebuilt offline; omitting its marker then forces startup to seed it.
fn dependencies_are_regenerable(config: &Path) -> Option<()> {
    let inventory: DependencyInventory = serde_json::from_slice(&bounded_read(&config.join(DEPENDENCY_INVENTORY), 32 * 1024 * 1024)?).ok()?;
    if inventory.schema_version != 1 || !sha256_text(&inventory.fingerprint) || inventory.files.is_empty() || inventory.files.len() > 200_000 { return None; }
    if bounded_read(&config.join(DEPENDENCY_MARKER), 64)? != inventory.fingerprint.as_bytes() { return None; }
    let manifest: serde_json::Value = serde_json::from_slice(&bounded_read(&config.join("package.json"), 1024 * 1024)?).ok()?;
    let dependencies = manifest.get("dependencies")?.as_object()?;
    if dependencies.len() != 1 { return None; }
    let plugin_version = dependencies.get("@opencode-ai/plugin")?.as_str()?;
    for key in ["devDependencies", "optionalDependencies", "peerDependencies"] {
        if let Some(value) = manifest.get(key) { if !value.as_object()?.is_empty() { return None; } }
    }
    let mut files = HashMap::new();
    for file in inventory.files {
        if !file.path.starts_with("node_modules/") || file.path.contains(['\\', ':']) || file.path.chars().any(char::is_control) ||
            file.path.split('/').any(|part| matches!(part, "" | "." | "..")) || !sha256_text(&file.sha256) { return None; }
        if files.insert(file.path.clone(), file).is_some() { return None; }
    }
    if !files.contains_key("node_modules/@opencode-ai/plugin/dist/index.js") || !files.contains_key("node_modules/@opencode-ai/plugin/package.json") { return None; }
    let modules = config.join("node_modules");
    if !regular_metadata(&modules).ok()?.is_dir() { return None; }
    let mut directories = vec![modules];
    let mut visited = 0usize;
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(directory).ok()? {
            visited += 1;
            if visited > 400_001 { return None; }
            let path = entry.ok()?.path();
            let before = regular_metadata(&path).ok()?;
            if before.is_dir() { directories.push(path); continue; }
            let relative = path.strip_prefix(config).ok()?.to_str()?.replace('\\', "/");
            let expected = files.remove(&relative)?;
            if before.len() != expected.bytes { return None; }
            let mut input = fs::File::open(&path).ok()?;
            let mut digest = Sha256::new();
            let mut buffer = [0u8; 64 * 1024];
            let mut bytes = 0u64;
            loop {
                let count = input.read(&mut buffer).ok()?;
                if count == 0 { break; }
                bytes = bytes.checked_add(count as u64)?;
                if bytes > expected.bytes { return None; }
                digest.update(&buffer[..count]);
            }
            let after = regular_metadata(&path).ok()?;
            if bytes != expected.bytes || after.len() != before.len() || before.modified().ok() != after.modified().ok() ||
                format!("{:x}", digest.finalize()) != expected.sha256 { return None; }
        }
    }
    if !files.is_empty() { return None; }
    // Restoring a generated tree seeds the bundled exact version. Preserve a
    // user's custom version/range/file spec by keeping the original tree+marker.
    let plugin: serde_json::Value = serde_json::from_slice(&bounded_read(&config.join("node_modules/@opencode-ai/plugin/package.json"), 1024 * 1024)?).ok()?;
    (plugin.get("version")?.as_str()? == plugin_version).then_some(())
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
    let omit_dependencies = directory.strip_prefix(root).ok().and_then(engine_relative)
        .is_some_and(|path| path == Path::new("config/opencode")) && dependencies_are_regenerable(directory).is_some();
    for entry in fs::read_dir(directory).map_err(|_| "update_backup_failed")? {
        let path = entry.map_err(|_| "update_backup_failed")?.path();
        let relative = path.strip_prefix(root).map_err(|_| "update_backup_failed")?;
        if excluded(relative) { continue; }
        if omit_dependencies && path.file_name().and_then(|name| name.to_str())
            .is_some_and(|name| matches!(name, "node_modules" | DEPENDENCY_MARKER | DEPENDENCY_INVENTORY)) { continue; }
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
    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', "\\")).arg(target.to_string_lossy().replace('/', "\\"))
            .creation_flags(0x08000000).output().unwrap();
        assert!(output.status.success(), "Junction fixture failed: {} {}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }
    fn seed_dependencies(root: &Path, engine: &str) -> PathBuf {
        let config = root.join(engine).join("config/opencode");
        fs::create_dir_all(&config).unwrap();
        fs::write(config.join("package.json"), br#"{"dependencies":{"@opencode-ai/plugin":"1.0.0"}}"#).unwrap();
        fs::write(config.join("package-lock.json"), b"synthetic lock").unwrap();
        fs::write(config.join("opencode.json"), b"user configuration").unwrap();
        let mut files = Vec::new();
        for path in ["node_modules/@opencode-ai/plugin/package.json", "node_modules/@opencode-ai/plugin/dist/index.js", "node_modules/zod/index.js"] {
            let file = config.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            let contents: &[u8] = if path.ends_with("package.json") { br#"{"version":"1.0.0"}"# } else { path.as_bytes() };
            fs::write(file, contents).unwrap();
            files.push(serde_json::json!({"path": path, "bytes": contents.len(), "sha256": format!("{:x}", Sha256::digest(contents))}));
        }
        let fingerprint = "a".repeat(64);
        fs::write(config.join(DEPENDENCY_MARKER), &fingerprint).unwrap();
        fs::write(config.join(DEPENDENCY_INVENTORY), serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "fingerprint": fingerprint, "files": files,
        })).unwrap()).unwrap();
        config
    }

    #[test]
    fn backup_omits_verified_dependencies_and_caches_in_shared_and_account_engines() {
        let root = root();
        for engine in ["engine", "engine/accounts/first", "engine/accounts/second"] {
            seed_dependencies(&root, engine);
            for path in ["cache/cached.bin", "temp/temporary.bin", "data/opencode/auth.json", "state/session.json", "rivloom-providers.json"] {
                let file = root.join(engine).join(path);
                fs::create_dir_all(file.parent().unwrap()).unwrap();
                fs::write(file, path.as_bytes()).unwrap();
            }
        }
        // Similar names outside these exact managed paths remain user data.
        for path in ["task-files/cache/file", "task-files/node_modules/file", "engine/data/cache/file", "engine/accounts/first/data/temp/file", "engine/cache-backup/file"] {
            let file = root.join(path); fs::create_dir_all(file.parent().unwrap()).unwrap(); fs::write(file, path.as_bytes()).unwrap();
        }
        let mut events = Vec::new();
        let copied = backup(&root, "0.1.25", "0.1.26", |event| events.push(event)).unwrap();
        for engine in ["engine", "engine/accounts/first", "engine/accounts/second"] {
            for path in ["cache", "temp", "config/opencode/node_modules", "config/opencode/.rivloom-plugin-dependencies", "config/opencode/.rivloom-plugin-dependencies-files.json"] {
                assert!(!copied.join(engine).join(path).exists(), "{engine}/{path}");
                assert!(root.join(engine).join(path).exists(), "Live data must remain untouched: {engine}/{path}");
            }
            for path in ["data/opencode/auth.json", "state/session.json", "rivloom-providers.json", "config/opencode/package.json", "config/opencode/package-lock.json", "config/opencode/opencode.json"] {
                assert_eq!(fs::read(copied.join(engine).join(path)).unwrap(), fs::read(root.join(engine).join(path)).unwrap());
            }
        }
        for path in ["task-files/cache/file", "task-files/node_modules/file", "engine/data/cache/file", "engine/accounts/first/data/temp/file", "engine/cache-backup/file"] {
            assert_eq!(fs::read(copied.join(path)).unwrap(), path.as_bytes());
        }
        let manifest: serde_json::Value = serde_json::from_slice(&fs::read(copied.join("backup-manifest.json")).unwrap()).unwrap();
        let files = manifest["files"].as_array().unwrap();
        assert_eq!(files.len(), 23);
        let bytes: u64 = files.iter().map(|file| file["bytes"].as_u64().unwrap()).sum();
        assert_eq!(events.first().unwrap(), &BackupProgress { files: 0, total_files: 23, bytes: 0, total_bytes: bytes });
        assert_eq!(events.last().unwrap(), &BackupProgress { files: 23, total_files: 23, bytes, total_bytes: bytes });
        for file in files {
            let contents = fs::read(copied.join(file["path"].as_str().unwrap())).unwrap();
            assert_eq!(file["sha256"], format!("{:x}", Sha256::digest(contents)));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_modified_missing_or_unverifiable_dependencies_keep_the_whole_scope() {
        for scenario in ["extra", "modified", "missing", "no-inventory", "invalid-inventory", "stale", "custom-dependency", "custom-plugin-version", "traversal", "duplicate"] {
            let root = root();
            let config = seed_dependencies(&root, "engine/accounts/custom");
            let module = config.join("node_modules/zod/index.js");
            match scenario {
                "extra" => fs::write(config.join("node_modules/custom-plugin.js"), b"user plugin").unwrap(),
                "modified" => { let size = fs::metadata(&module).unwrap().len() as usize; fs::write(&module, vec![b'x'; size]).unwrap(); },
                "missing" => fs::remove_file(&module).unwrap(),
                "no-inventory" => fs::remove_file(config.join(DEPENDENCY_INVENTORY)).unwrap(),
                "invalid-inventory" => fs::write(config.join(DEPENDENCY_INVENTORY), b"{").unwrap(),
                "stale" => fs::write(config.join(DEPENDENCY_MARKER), "b".repeat(64)).unwrap(),
                "custom-dependency" => fs::write(config.join("package.json"), br#"{"dependencies":{"@opencode-ai/plugin":"1.0.0","custom-plugin":"1.0.0"}}"#).unwrap(),
                "custom-plugin-version" => fs::write(config.join("package.json"), br#"{"dependencies":{"@opencode-ai/plugin":"file:./custom-plugin"}}"#).unwrap(),
                "traversal" | "duplicate" => {
                    let mut inventory: serde_json::Value = serde_json::from_slice(&fs::read(config.join(DEPENDENCY_INVENTORY)).unwrap()).unwrap();
                    let mut item = inventory["files"][0].clone();
                    if scenario == "traversal" { item["path"] = "node_modules/../../data/auth.json".into(); }
                    inventory["files"].as_array_mut().unwrap().push(item);
                    fs::write(config.join(DEPENDENCY_INVENTORY), serde_json::to_vec(&inventory).unwrap()).unwrap();
                },
                _ => unreachable!(),
            }
            // A customized account does not prevent another engine from shrinking.
            seed_dependencies(&root, "engine");
            assert!(dependencies_are_regenerable(&config).is_none(), "{scenario}");
            let copied = backup(&root, "0.1.25", "0.1.26", |_| {}).unwrap();
            let kept = copied.join("engine/accounts/custom/config/opencode");
            assert!(!copied.join("engine/config/opencode/node_modules").exists());
            assert_eq!(fs::read(kept.join(DEPENDENCY_MARKER)).unwrap(), fs::read(config.join(DEPENDENCY_MARKER)).unwrap(), "{scenario}");
            assert_eq!(fs::read(kept.join("node_modules/@opencode-ai/plugin/dist/index.js")).unwrap(), b"node_modules/@opencode-ai/plugin/dist/index.js");
            if scenario != "missing" { assert_eq!(fs::read(kept.join("node_modules/zod/index.js")).unwrap(), fs::read(&module).unwrap(), "{scenario}"); }
            if scenario == "extra" { assert_eq!(fs::read(kept.join("node_modules/custom-plugin.js")).unwrap(), b"user plugin"); }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(windows)]
    #[test]
    fn generated_dependency_evidence_does_not_bypass_junction_rejection() {
        for entry in ["node_modules", "node_modules/zod", DEPENDENCY_MARKER, DEPENDENCY_INVENTORY] {
            let root = root();
            let config = seed_dependencies(&root, "engine");
            let outside = root.with_extension("outside");
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("private.txt"), b"outside must remain untouched").unwrap();
            let link = config.join(entry);
            fs::rename(&link, root.join("original-entry")).unwrap();
            junction(&link, &outside);
            assert!(dependencies_are_regenerable(&config).is_none(), "{entry}");
            assert!(backup(&root, "0.1.25", "0.1.26", |_| {}).is_err(), "{entry}");
            assert!(fs::read_dir(root.join(".updates/backups")).unwrap().filter_map(Result::ok)
                .all(|copy| !copy.path().join("backup-manifest.json").exists()));
            assert_eq!(fs::read(outside.join("private.txt")).unwrap(), b"outside must remain untouched");
            fs::remove_dir(link).unwrap();
            fs::remove_dir_all(root).unwrap();
            fs::remove_dir_all(outside).unwrap();
        }
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
