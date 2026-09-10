//! Official Tauri updater behind exact-origin native commands. The renderer never
//! receives an executable path, a signature handle, or authority to choose a URL.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};
use crate::{authorize, native_async, update_backup, DesktopState};

pub const PUBLIC_KEY: &str = include_str!("../updater.pub");
const ENDPOINT: &str = "https://downloads.rivloom.com/updates/stable/latest.json";
const MAX_DOWNLOAD: u64 = 1024 * 1024 * 1024;
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Blockers {
    tasks: u64, queues: u64, workflows: u64, remote_tasks: u64,
    brain_tasks: u64, transfers: u64, operations: u64, model_checks: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release { version: String, notes: String, published_at: Option<String> }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    phase: String, current_version: String, release: Option<Release>, skipped_version: Option<String>,
    last_checked_at: Option<u64>, downloaded_bytes: u64, total_bytes: Option<u64>,
    error: Option<String>, blockers: Option<Blockers>, revision: u64,
    backup: Option<update_backup::BackupProgress>,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preferences { skipped_version: Option<String>, last_checked_at: Option<u64>, installation_error: Option<String> }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingInstall { from_version: String, to_version: String, backup: String }

fn recover_install(data_dir: &Path, current: &str, preferences: &mut Preferences) -> Result<(), String> {
    let pending_path = data_dir.join(".updates/pending-install.json");
    if !pending_path.exists() { return Ok(()); }
    update_backup::private_state_directory(data_dir)?;
    let pending: PendingInstall = fs::metadata(&pending_path).ok().filter(|m| m.len() <= 4096)
        .and_then(|_| fs::read(&pending_path).ok()).and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(|p: &PendingInstall| newer(&p.to_version, &p.from_version) &&
            !p.backup.is_empty() && p.backup.len() < 160 && p.backup.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-'))
        .ok_or("update_save_failed")?;
    if current == pending.to_version || newer(current, &pending.to_version) {
        preferences.installation_error = None;
    } else if preferences.installation_error.is_none() {
        preferences.installation_error = Some("update_install_incomplete".into());
    }
    // Save the outcome before consuming the marker so a failed write is recoverable.
    update_backup::atomic_json(&data_dir.join(".updates/preferences.json"), preferences)?;
    fs::remove_file(pending_path).map_err(|_| "update_save_failed".into())
}

/// Signed separately from the installer, binding its bytes to version and URL.
/// An old valid package signature cannot be relabelled as a newer release.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Metadata {
    pub schema_version: u32, pub product: String, pub version: String, pub published_at: String, pub notes: String,
    pub url: String, pub signature: String, pub bytes: u64, pub sha256: String,
}
struct Inner { snapshot: Snapshot, preferences: Preferences, update: Option<Update>, metadata: Option<Metadata>, bytes: Option<Arc<Vec<u8>>> }
pub struct UpdateState { inner: Mutex<Inner>, operation: Arc<AtomicBool>, cancel: AtomicBool, preferences_path: PathBuf, enabled: bool }
struct Operation(Arc<AtomicBool>);
impl Drop for Operation { fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); } }

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|v| v.as_millis() as u64).unwrap_or(0) }
fn stable_version(value: &str) -> bool {
    value.len() <= 80 && semver::Version::parse(value).is_ok_and(|v| v.pre.is_empty() && v.build.is_empty() && v.to_string() == value)
}
fn newer(version: &str, current: &str) -> bool {
    stable_version(version) && stable_version(current) && semver::Version::parse(version).unwrap() > semver::Version::parse(current).unwrap()
}
fn text_from_base64(value: &str, limit: usize) -> Result<String, String> {
    if value.len() > limit * 2 { return Err("update_manifest_invalid".into()); }
    let bytes = STANDARD.decode(value).map_err(|_| "update_manifest_invalid")?;
    if bytes.len() > limit { return Err("update_manifest_invalid".into()); }
    String::from_utf8(bytes).map_err(|_| "update_manifest_invalid".into())
}
fn verify(data: &[u8], signature: &str, public_key: &str) -> Result<(), String> {
    let key = PublicKey::decode(&text_from_base64(public_key.trim(), 512)?).map_err(|_| "update_signature_invalid")?;
    let signature = Signature::decode(&text_from_base64(signature, 4096)?).map_err(|_| "update_signature_invalid")?;
    key.verify(data, &signature, false).map_err(|_| "update_signature_invalid".into())
}
fn official_installer(url: &str, version: &str) -> bool {
    let Ok(parsed) = tauri::Url::parse(url) else { return false; };
    if parsed.scheme() != "https" || parsed.host_str() != Some("downloads.rivloom.com") ||
        !parsed.username().is_empty() || parsed.password().is_some() || parsed.port().is_some() ||
        parsed.query().is_some() || parsed.fragment().is_some() || parsed.as_str() != url { return false; }
    let parts: Vec<_> = parsed.path().split('/').collect();
    if parts.len() != 4 || parts[1] != "releases" || parts[3] != format!("Rivloom_{version}_x64-setup.exe") { return false; }
    let prefix = format!("v{version}-");
    let Some(tag) = parts[2].strip_prefix(&prefix) else { return false; };
    let tag: Vec<_> = tag.split('-').collect();
    tag.len() == 2 && tag[0].len() == 12 && tag[0].bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) &&
        tag[1].len() <= 16 && tag[1].parse::<u64>().is_ok_and(|id| id > 0 && id.to_string() == tag[1])
}
pub(crate) fn metadata_from_manifest(raw: &serde_json::Value, public_key: &str) -> Result<Metadata, String> {
    if raw.to_string().len() > 64 * 1024 { return Err("update_manifest_invalid".into()); }
    let payload = text_from_base64(raw["rivloom"]["payload"].as_str().ok_or("update_manifest_invalid")?, 32 * 1024)?;
    let signature = raw["rivloom"]["signature"].as_str().ok_or("update_manifest_invalid")?;
    verify(payload.as_bytes(), signature, public_key)?;
    let value: Metadata = serde_json::from_str(&payload).map_err(|_| "update_manifest_invalid")?;
    if value.schema_version != 1 || value.product != "com.rivloom.desktop" || !stable_version(&value.version) ||
        !official_installer(&value.url, &value.version) || value.bytes == 0 || value.bytes > MAX_DOWNLOAD ||
        value.notes.len() > 12_000 || value.sha256.len() != 64 || !value.sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) ||
        raw["version"].as_str() != Some(value.version.as_str()) || raw["notes"].as_str() != Some(value.notes.as_str()) ||
        raw["pub_date"].as_str() != Some(value.published_at.as_str()) ||
        raw["platforms"]["windows-x86_64"]["url"].as_str() != Some(value.url.as_str()) ||
        raw["platforms"]["windows-x86_64"]["signature"].as_str() != Some(value.signature.as_str()) ||
        raw["platforms"].as_object().is_none_or(|p| p.len() != 1) {
        return Err("update_manifest_invalid".into());
    }
    // Reject a malformed package signature before presenting the offer.
    Signature::decode(&text_from_base64(&value.signature, 4096)?).map_err(|_| "update_manifest_invalid")?;
    Ok(value)
}
fn verify_bytes(bytes: &[u8], metadata: &Metadata, key: &str) -> Result<(), String> {
    if bytes.len() as u64 != metadata.bytes || format!("{:x}", Sha256::digest(bytes)) != metadata.sha256 {
        return Err("update_signature_invalid".into());
    }
    verify(bytes, &metadata.signature, key)
}

impl UpdateState {
    pub fn new(data_dir: &Path, enabled: bool) -> Self {
        let enabled = enabled && cfg!(all(windows, target_arch = "x86_64")) && stable_version(env!("CARGO_PKG_VERSION"));
        let preferences_path = data_dir.join(".updates/preferences.json");
        let mut error = None;
        let mut preferences: Preferences = if enabled && preferences_path.exists() {
            fs::metadata(&preferences_path).ok().filter(|m| m.len() <= 4096).and_then(|_| fs::read(&preferences_path).ok())
                .and_then(|bytes| serde_json::from_slice(&bytes).ok()).filter(|p: &Preferences| p.skipped_version.as_ref().is_none_or(|v| stable_version(v)))
                .unwrap_or_else(|| { error = Some("update_save_failed".into()); Preferences::default() })
        } else { Preferences::default() };
        if enabled {
            if let Err(code) = recover_install(data_dir, env!("CARGO_PKG_VERSION"), &mut preferences) { error = Some(code); }
        }
        if error.is_none() { error = preferences.installation_error.clone(); }
        Self { inner: Mutex::new(Inner { snapshot: Snapshot { phase: if !enabled { "disabled" } else if error.is_some() { "error" } else { "idle" }.into(),
            current_version: env!("CARGO_PKG_VERSION").into(), release: None, skipped_version: preferences.skipped_version.clone(), last_checked_at: preferences.last_checked_at,
            downloaded_bytes: 0, total_bytes: None, error, blockers: None, revision: 0, backup: None }, preferences, update: None, metadata: None, bytes: None }),
            operation: Arc::new(AtomicBool::new(false)), cancel: AtomicBool::new(false), preferences_path, enabled }
    }
    fn snapshot(&self) -> Snapshot { self.inner.lock().unwrap().snapshot.clone() }
    fn change(&self, operation: impl FnOnce(&mut Inner)) -> Snapshot {
        let mut inner = self.inner.lock().unwrap(); operation(&mut inner); inner.snapshot.revision += 1; inner.snapshot.clone()
    }
    fn acquire(&self) -> Result<Operation, String> {
        if !self.enabled { return Err("update_disabled".into()); }
        if self.operation.swap(true, Ordering::SeqCst) { return Err("update_busy".into()); }
        Ok(Operation(self.operation.clone()))
    }
    fn save(&self, preferences: &Preferences) -> Result<(), String> {
        let data_dir = self.preferences_path.parent().and_then(Path::parent).ok_or("update_save_failed")?;
        update_backup::private_state_directory(data_dir).map_err(|_| "update_save_failed")?;
        update_backup::atomic_json(&self.preferences_path, preferences)
    }
    fn fail(&self, code: &str, phase: &str) -> Snapshot {
        self.change(|inner| { inner.snapshot.phase = phase.into(); inner.snapshot.error = Some(code.into()); })
    }
    fn installation_failure(&self, code: &str) {
        self.change(|inner| { inner.preferences.installation_error = Some(code.into()); let _ = self.save(&inner.preferences);
            inner.snapshot.phase = "error".into(); inner.snapshot.error = Some(code.into()); });
    }
}

pub fn start_background(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(12)).await;
        loop {
            let state = app.state::<UpdateState>();
            if !state.enabled { return; }
            if !app.state::<DesktopState>().closing.load(Ordering::SeqCst) { let _ = check(&app, false).await; }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

async fn check(app: &tauri::AppHandle, manual: bool) -> Result<Snapshot, String> {
    let state = app.state::<UpdateState>();
    let _operation = state.acquire()?;
    if state.inner.lock().unwrap().bytes.is_some() { return Ok(state.snapshot()); }
    if !manual && state.inner.lock().unwrap().preferences.installation_error.is_some() { return Ok(state.snapshot()); }
    state.change(|inner| { inner.snapshot.phase = "checking".into(); inner.snapshot.error = None; inner.snapshot.blockers = None; });
    let result = async {
        let updater = app.updater_builder().endpoints(vec![ENDPOINT.parse().map_err(|_| "update_manifest_invalid")?]).map_err(|_| "update_manifest_invalid")?
            .pubkey(PUBLIC_KEY.trim()).target("windows-x86_64").timeout(Duration::from_secs(20))
            .header("Cache-Control", "no-cache").map_err(|_| "update_manifest_invalid")?
            .configure_client(|client| client.redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(10)))
            .build().map_err(|_| "update_manifest_invalid")?;
        let checked = updater.check().await.map_err(|_| "update_check_failed")?;
        if let Some(mut update) = checked {
            let metadata = metadata_from_manifest(&update.raw_json, PUBLIC_KEY)?;
            if update.version != metadata.version || update.download_url.as_str() != metadata.url || update.signature != metadata.signature ||
                !newer(&update.version, env!("CARGO_PKG_VERSION")) { return Err("update_manifest_invalid".into()); }
            update.timeout = Some(Duration::from_secs(600));
            Ok(Some((update, metadata)))
        } else { Ok(None) }
    }.await;
    Ok(state.change(|inner| {
        inner.preferences.last_checked_at = Some(now());
        if manual { inner.preferences.installation_error = None; }
        inner.snapshot.last_checked_at = inner.preferences.last_checked_at;
        inner.snapshot.downloaded_bytes = 0; inner.snapshot.total_bytes = None;
        match result {
            Ok(Some((update, metadata))) => {
                inner.snapshot.release = Some(Release { version: metadata.version.clone(), notes: metadata.notes.clone(), published_at: Some(metadata.published_at.clone()) });
                inner.snapshot.phase = "available".into(); inner.update = Some(update); inner.metadata = Some(metadata);
            }
            Ok(None) => { inner.snapshot.phase = "idle".into(); inner.snapshot.release = None; inner.update = None; inner.metadata = None; }
            Err(code) => { inner.snapshot.phase = "error".into(); inner.snapshot.error = Some(code); }
        }
        if state.save(&inner.preferences).is_err() { inner.snapshot.error = Some("update_save_failed".into()); }
    }))
}

async fn download(app: &tauri::AppHandle) -> Result<Snapshot, String> {
    let state = app.state::<UpdateState>();
    let _operation = state.acquire()?;
    let (update, metadata) = {
        let inner = state.inner.lock().unwrap();
        if inner.bytes.is_some() { return Ok(inner.snapshot.clone()); }
        (inner.update.clone().ok_or("update_manifest_invalid")?, inner.metadata.clone().ok_or("update_manifest_invalid")?)
    };
    state.cancel.store(false, Ordering::SeqCst);
    state.change(|inner| { inner.snapshot.phase = "downloading".into(); inner.snapshot.error = None; inner.snapshot.blockers = None;
        inner.snapshot.downloaded_bytes = 0; inner.snapshot.total_bytes = Some(metadata.bytes); });
    let too_large = AtomicBool::new(false);
    let operation = update.download(|chunk, total| {
        state.change(|inner| {
            inner.snapshot.downloaded_bytes += chunk as u64;
            if inner.snapshot.downloaded_bytes > metadata.bytes || total.is_some_and(|n| n != metadata.bytes || n > MAX_DOWNLOAD) {
                too_large.store(true, Ordering::SeqCst);
            }
        });
    }, || {});
    tokio::pin!(operation);
    let result = loop {
        tokio::select! {
            response = &mut operation => break response.map_err(|error| match error {
                tauri_plugin_updater::Error::Minisign(_) | tauri_plugin_updater::Error::Base64(_) => "update_signature_invalid",
                _ => "update_download_failed",
            }.to_string()),
            _ = tokio::time::sleep(Duration::from_millis(40)) => {
                if state.cancel.load(Ordering::SeqCst) { break Err("update_cancelled".into()); }
                if too_large.load(Ordering::SeqCst) { break Err("update_signature_invalid".into()); }
            }
        }
    };
    let result = match result {
        Ok(bytes) if !state.cancel.load(Ordering::SeqCst) => {
            let bytes = Arc::new(bytes); let verified = bytes.clone(); let expected = metadata.clone();
            match native_async::blocking(move || verify_bytes(&verified, &expected, PUBLIC_KEY)).await {
                Ok(Ok(())) if state.cancel.load(Ordering::SeqCst) => Err("update_cancelled".to_string()),
                Ok(Ok(())) => Ok(bytes), _ => Err("update_signature_invalid".to_string()),
            }
        }
        Ok(_) => Err("update_cancelled".into()), Err(code) => Err(code),
    };
    Ok(state.change(|inner| match result {
        Ok(_) if state.cancel.load(Ordering::SeqCst) => { inner.bytes = None; inner.snapshot.phase = "available".into(); inner.snapshot.error = Some("update_cancelled".into()); }
        Ok(bytes) => { inner.bytes = Some(bytes); inner.snapshot.phase = "ready".into(); inner.snapshot.error = None; }
        Err(code) => { inner.bytes = None; inner.snapshot.phase = "available".into(); inner.snapshot.error = Some(code); }
    }))
}

#[derive(Deserialize)]
struct Preparation { ready: bool, lease: Option<String>, blockers: Blockers }
async fn local_request(app: &tauri::AppHandle, action: &str, body: serde_json::Value) -> Result<reqwest::Response, String> {
    let desktop = app.state::<DesktopState>();
    let token = fs::read_to_string(desktop.data_dir.join("desktop-auth-token.txt")).map_err(|_| "update_service_unavailable")?;
    // No proxies, redirects, browser cookies or remote host input on the privileged local hop.
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(12)).build()
        .map_err(|_| "update_service_unavailable")?.post(format!("{}/api/desktop-update/{action}", desktop.origin))
        .header("X-Rivloom-Request", "1").header("X-Rivloom-Desktop-Token", token.trim()).json(&body).send().await
        .map_err(|_| "update_service_unavailable".into())
}

async fn install(app: &tauri::AppHandle, _operation: Operation) -> Result<Snapshot, String> {
    let state = app.state::<UpdateState>();
    let (update, metadata, bytes) = {
        let inner = state.inner.lock().unwrap();
        (inner.update.clone().ok_or("update_manifest_invalid")?, inner.metadata.clone().ok_or("update_manifest_invalid")?, inner.bytes.clone().ok_or("update_download_failed")?)
    };
    let preparation = async {
        let response = local_request(app, "prepare", serde_json::json!({"version": metadata.version})).await?;
        if !response.status().is_success() { return Err("update_service_unavailable".to_string()); }
        response.json::<Preparation>().await.map_err(|_| "update_service_unavailable".to_string())
    }.await;
    let preparation = match preparation { Ok(value) => value, Err(code) => return Ok(state.fail(&code, "ready")) };
    if !preparation.ready {
        return Ok(state.change(|inner| { inner.snapshot.phase = "ready".into(); inner.snapshot.error = Some("update_tasks_pending".into()); inner.snapshot.blockers = Some(preparation.blockers); }));
    }
    let lease = preparation.lease.ok_or("update_service_unavailable")?;
    if lease.len() != 36 || !lease.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') { return Ok(state.fail("update_service_unavailable", "ready")); }
    let desktop = app.state::<DesktopState>();
    if desktop.closing.swap(true, Ordering::SeqCst) {
        let _ = local_request(app, "cancel", serde_json::json!({"lease": lease})).await;
        return Ok(state.fail("update_busy", "ready"));
    }
    let response = local_request(app, "commit", serde_json::json!({"lease": lease})).await;
    if response.as_ref().is_ok_and(|r| !r.status().is_success()) {
        desktop.closing.store(false, Ordering::SeqCst);
        let _ = local_request(app, "cancel", serde_json::json!({"lease": lease})).await;
        return Ok(state.fail("update_service_unavailable", "ready"));
    }
    // Even after an ambiguous HTTP result, require this exact lease's durable
    // clean-shutdown receipt and a successful exit. Never fall back to force-kill.
    state.change(|inner| { inner.snapshot.phase = "stopping".into(); });
    let app_for_backup = app.clone(); let target = metadata.version.clone();
    let stopped = native_async::blocking(move || {
        let desktop = app_for_backup.state::<DesktopState>();
        desktop.runtime.lock().map_err(|_| "update_shutdown_failed")?.wait_for_update_exit()?;
        let receipt = desktop.data_dir.join("update-shutdown.json");
        if fs::metadata(&receipt).map_err(|_| "update_shutdown_failed")?.len() > 1024 { return Err("update_shutdown_failed".to_string()); }
        let receipt: serde_json::Value = serde_json::from_slice(&fs::read(receipt).map_err(|_| "update_shutdown_failed")?).map_err(|_| "update_shutdown_failed")?;
        if receipt != serde_json::json!({"lease": lease, "version": target, "closed": true}) { return Err("update_shutdown_failed".to_string()); }
        let updates = app_for_backup.state::<UpdateState>();
        updates.change(|inner| { inner.snapshot.phase = "backing_up".into(); });
        update_backup::backup(&desktop.data_dir, env!("CARGO_PKG_VERSION"), &target, |progress| {
            updates.change(|inner| { inner.snapshot.backup = Some(progress); });
        })
    }).await;
    let backup = match stopped {
        Ok(Ok(path)) => path,
        failure => {
            let code = failure.ok().and_then(Result::err).unwrap_or_else(|| "update_backup_failed".into());
            state.installation_failure(&code);
            // Restart the existing binary only after its own backend has exited.
            let exited = desktop.runtime.lock().is_ok_and(|mut r| matches!(r.child.try_wait(), Ok(Some(_))));
            if exited && code != "update_shutdown_failed" { app.restart(); }
            desktop.closing.store(false, Ordering::SeqCst);
            return Ok(state.fail(&code, "ready"));
        }
    };
    state.change(|inner| { inner.preferences.installation_error = None; let _ = state.save(&inner.preferences); });
    let pending = desktop.data_dir.join(".updates/pending-install.json");
    if update_backup::atomic_json(&pending, &PendingInstall { from_version: env!("CARGO_PKG_VERSION").into(), to_version: metadata.version.clone(),
        backup: backup.file_name().and_then(|s| s.to_str()).unwrap_or_default().into() }).is_err() {
        state.installation_failure("update_backup_failed"); app.restart();
    }
    state.change(|inner| { inner.snapshot.phase = "installing".into(); });
    let install_app = app.clone();
    let result = native_async::blocking(move || {
        verify_bytes(&bytes, &metadata, PUBLIC_KEY)?;
        // Tauri verifies on download; the immutable retained bytes are verified
        // again above before its Windows NSIS installation lifecycle is invoked.
        #[cfg(windows)]
        if let Ok(notifications) = &install_app.state::<DesktopState>().notifications { notifications.shutdown(); }
        update.install(bytes.as_slice()).map_err(|_| "update_install_failed".to_string())
    }).await;
    // On Windows success exits inside the official updater. Only failure returns.
    let code = result.ok().and_then(Result::err).unwrap_or_else(|| "update_install_failed".into());
    state.installation_failure(&code); app.restart();
}

#[tauri::command]
pub fn desktop_update_snapshot(window: WebviewWindow, desktop: tauri::State<DesktopState>, state: tauri::State<UpdateState>) -> Result<Snapshot, String> {
    authorize(&window, &desktop)?; Ok(state.snapshot())
}
#[tauri::command]
pub async fn check_desktop_update(window: WebviewWindow, app: tauri::AppHandle) -> Result<Snapshot, String> {
    authorize(&window, &app.state::<DesktopState>())?; check(&app, true).await
}
#[tauri::command]
pub fn skip_desktop_update(window: WebviewWindow, desktop: tauri::State<DesktopState>, state: tauri::State<UpdateState>) -> Result<Snapshot, String> {
    authorize(&window, &desktop)?; let _operation = state.acquire()?;
    let version = state.snapshot().release.ok_or("update_manifest_invalid")?.version;
    Ok(state.change(|inner| {
        let preference = Preferences { skipped_version: Some(version.clone()), last_checked_at: inner.preferences.last_checked_at, installation_error: None };
        if state.save(&preference).is_err() { inner.snapshot.error = Some("update_save_failed".into()); return; }
        inner.preferences = preference; inner.snapshot.skipped_version = Some(version); inner.snapshot.error = None;
        inner.snapshot.phase = "available".into(); inner.snapshot.blockers = None; inner.bytes = None;
        inner.snapshot.downloaded_bytes = 0; inner.snapshot.total_bytes = None;
    }))
}
#[tauri::command]
pub async fn download_desktop_update(window: WebviewWindow, app: tauri::AppHandle) -> Result<Snapshot, String> {
    authorize(&window, &app.state::<DesktopState>())?; download(&app).await
}
#[tauri::command]
pub fn cancel_desktop_update(window: WebviewWindow, desktop: tauri::State<DesktopState>, state: tauri::State<UpdateState>) -> Result<Snapshot, String> {
    authorize(&window, &desktop)?;
    Ok(state.change(|inner| {
        if inner.snapshot.phase == "downloading" { state.cancel.store(true, Ordering::SeqCst); }
    }))
}
#[tauri::command]
pub async fn install_desktop_update(window: WebviewWindow, app: tauri::AppHandle) -> Result<Snapshot, String> {
    authorize(&window, &app.state::<DesktopState>())?;
    let state = app.state::<UpdateState>();
    let operation = state.acquire()?;
    {
        let inner = state.inner.lock().unwrap();
        if inner.update.is_none() || inner.metadata.is_none() { return Err("update_manifest_invalid".into()); }
        if inner.bytes.is_none() { return Err("update_download_failed".into()); }
    }
    let accepted = state.change(|inner| {
        inner.snapshot.phase = "preparing".into(); inner.snapshot.error = None;
        inner.snapshot.blockers = None; inner.snapshot.backup = None;
    });
    // Return the IPC acknowledgment immediately. The native worker owns the
    // operation until shutdown, backup and installation finish, independently
    // of the renderer and any open or dismissed dialog.
    tauri::async_runtime::spawn(async move {
        if let Err(code) = install(&app, operation).await { app.state::<UpdateState>().fail(&code, "ready"); }
    });
    Ok(accepted)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_preserves_skip_and_reports_interrupted_install_once() {
        let root = std::env::temp_dir().join(format!("rivloom-update-recovery-{}-{}", std::process::id(), now()));
        fs::create_dir(&root).unwrap();
        let directory = update_backup::private_state_directory(&root).unwrap();
        let mut prefs = Preferences { skipped_version: Some("0.1.9".into()), last_checked_at: Some(123), installation_error: None };
        let marker = PendingInstall { from_version: "0.1.4".into(), to_version: "0.1.5".into(), backup: "0.1.4-to-0.1.5-123".into() };
        for (current, failure) in [("0.1.4", true), ("0.1.5", false), ("0.1.6", false)] {
            update_backup::atomic_json(&directory.join("pending-install.json"), &marker).unwrap();
            recover_install(&root, current, &mut prefs).unwrap();
            assert_eq!(prefs.installation_error.is_some(), failure);
            assert!(!directory.join("pending-install.json").exists());
            let loaded: Preferences = serde_json::from_slice(&fs::read(directory.join("preferences.json")).unwrap()).unwrap();
            assert_eq!(loaded.skipped_version.as_deref(), Some("0.1.9"));
            assert_eq!(loaded.last_checked_at, Some(123));
            assert_eq!(loaded.installation_error, prefs.installation_error);
        }
        fs::write(directory.join("pending-install.json"), b"broken").unwrap();
        assert!(recover_install(&root, "0.1.5", &mut prefs).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn stable_versions_do_not_downgrade_or_accept_same_version_or_prereleases() {
        assert!(newer("0.1.10", "0.1.9"));
        assert!(!newer("0.1.9", "0.1.10")); assert!(!newer("0.1.4", "0.1.4"));
        for bad in ["0.1.5-beta.1", "0.1.5+fake", "01.2.3", "v0.1.5", "0.1.5\n"] { assert!(!newer(bad, "0.1.4")); }
    }
    #[test]
    fn installer_urls_are_exact_official_versioned_nsis_assets() {
        let good = "https://downloads.rivloom.com/releases/v0.1.5-0123456789ab-123/Rivloom_0.1.5_x64-setup.exe";
        assert!(official_installer(good, "0.1.5"));
        for bad in [good.replace("https:", "http:"), good.replace("downloads.rivloom.com", "evil.example"),
            format!("{good}?next=evil"), good.replace("0.1.5_x64", "0.1.4_x64"), good.replace("/releases/", "/previews/"),
            good.replace("https://", "https://name@"), good.replace("-123/", "-0123/")] { assert!(!official_installer(&bad, "0.1.5"), "{bad}"); }
    }
    #[test]
    fn operation_lock_releases_and_disabled_preview_cannot_install() {
        let state = UpdateState::new(&std::env::temp_dir(), true);
        let operation = state.acquire().unwrap(); assert!(state.acquire().is_err()); drop(operation);
        assert!(state.acquire().is_ok());
        assert!(UpdateState::new(&std::env::temp_dir(), false).acquire().is_err());
    }
    #[test]
    fn background_installation_keeps_its_lock_after_request_returns() {
        let state = Arc::new(UpdateState::new(&std::env::temp_dir(), true));
        let operation = state.acquire().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _operation = operation;
            started_tx.send(()).unwrap();
            finish_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(state.acquire().is_err(), "A returned request must not allow a second installer");
        assert_eq!(state.snapshot().phase, "idle", "Status reads remain available while the worker owns the operation");
        finish_tx.send(()).unwrap(); worker.join().unwrap();
        assert!(state.acquire().is_ok());
    }
    #[test]
    fn official_signer_fixture_and_metadata_validate_before_installation() {
        let key = include_str!("../../tests/fixtures/updater/public.pub");
        let raw: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/updater/manifest.json")).unwrap();
        let bytes = include_bytes!("../../tests/fixtures/updater/artifact.txt");
        let metadata = metadata_from_manifest(&raw, key).unwrap();
        verify_bytes(bytes, &metadata, key).unwrap();
        let mut corrupted = bytes.to_vec(); corrupted[0] ^= 1;
        assert!(verify_bytes(&corrupted, &metadata, key).is_err());
        assert!(metadata_from_manifest(&raw, PUBLIC_KEY).is_err(), "A fixture key must never be trusted by the product");
        for field in ["version", "notes", "pub_date"] {
            let mut changed = raw.clone(); changed[field] = "999.0.0".into();
            assert!(metadata_from_manifest(&changed, key).is_err());
        }
        let mut redirected = raw.clone(); redirected["platforms"]["windows-x86_64"]["url"] = "https://evil.example/update.exe".into();
        assert!(metadata_from_manifest(&redirected, key).is_err());
        let mut relabelled = metadata.clone(); relabelled.version = "999.0.0".into();
        let mut changed = raw.clone(); changed["rivloom"]["payload"] = STANDARD.encode(serde_json::to_vec(&relabelled).unwrap()).into();
        assert!(metadata_from_manifest(&changed, key).is_err());
    }
}
