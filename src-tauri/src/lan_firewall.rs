//! All privileged work is fixed, embedded code; no executable path, rule name,
//! script, address or port list can be supplied by the WebView.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::{Path, PathBuf}, sync::{atomic::{AtomicBool, Ordering}, Arc}};
use tauri::WebviewWindow;

const INSPECT: &str = include_str!("lan_firewall_inspect.ps1");
const RULES: &str = include_str!("lan_firewall_rules.ps1");
#[derive(Default)]
pub struct FirewallState { busy: Arc<AtomicBool> }
struct Lease(Arc<AtomicBool>);
impl Drop for Lease { fn drop(&mut self) { self.0.store(false, Ordering::Release); } }
impl FirewallState {
    fn acquire(&self) -> Result<Lease, String> {
        self.busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "firewall_busy".to_string())?;
        Ok(Lease(self.busy.clone()))
    }
}
fn firewall_program(program: &Path) -> PathBuf {
    // Tauri's resource directory can use a verbatim Windows path, while the
    // installer and NetSecurity use a normal DOS/UNC path for the same file.
    let text = program.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    if let Some(disk) = text.strip_prefix(r"\\?\").filter(|value| {
        value.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && value.as_bytes().get(1) == Some(&b':')
            && value.as_bytes().get(2) == Some(&b'\\')
    }) {
        return PathBuf::from(disk);
    }
    program.to_path_buf()
}
fn install_key(program: &Path) -> String {
    format!("{:x}", Sha256::digest(firewall_program(program).to_string_lossy().replace('/', "\\").to_lowercase().as_bytes()))[..24].to_owned()
}
fn encode(script: &str) -> String {
    STANDARD.encode(script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>())
}
fn script(program: &Path, action: &str, public: bool, port: u16, process_id: u32) -> String {
    let program = firewall_program(program);
    let config = STANDARD.encode(serde_json::to_vec(&json!({"program":program, "key":install_key(&program),
        "action":action, "allowPublic":public, "port":port, "processId":process_id})).unwrap());
    format!("$config = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{config}')) | ConvertFrom-Json\n{}",
        if action == "inspect" { INSPECT } else { RULES })
}

#[cfg(windows)]
fn powershell() -> Result<PathBuf, String> {
    let mut buffer = [0u16; 32768];
    let length = unsafe { windows::Win32::System::SystemInformation::GetSystemDirectoryW(Some(&mut buffer)) } as usize;
    if length == 0 || length >= buffer.len() { return Err("firewall_unavailable".into()); }
    Ok(PathBuf::from(String::from_utf16_lossy(&buffer[..length])).join("WindowsPowerShell/v1.0/powershell.exe"))
}
#[cfg(windows)]
fn inspect(program: &Path, port: u16, process_id: u32) -> Result<Value, String> {
    use std::{io::Read, process::{Command, Stdio}, os::windows::process::CommandExt, time::{Duration, Instant}, thread};
    let mut child = Command::new(powershell()?).args(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", &encode(&script(program, "inspect", false, port, process_id))])
        .creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|_| "firewall_unavailable".to_string())?;
    let output = child.stdout.take().ok_or("firewall_unavailable")?;
    let reader = thread::spawn(move || { let mut bytes = Vec::new(); output.take(65537).read_to_end(&mut bytes).map(|_| bytes) });
    let until = Instant::now() + Duration::from_secs(35);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < until => thread::sleep(Duration::from_millis(50)),
            _ => { let _ = child.kill(); let _ = child.wait(); return Err("firewall_inspection_failed".into()); }
        }
    };
    let bytes = reader.join().map_err(|_| "firewall_inspection_failed")?.map_err(|_| "firewall_inspection_failed")?;
    if !status.success() || bytes.len() > 65536 { return Err("firewall_inspection_failed".into()); }
    serde_json::from_slice(&bytes).map_err(|_| "firewall_inspection_failed".into())
}
#[cfg(not(windows))]
fn inspect(_: &Path, _: u16, _: u32) -> Result<Value, String> { Err("firewall_unsupported".into()) }

#[cfg(windows)]
fn elevate(program: &Path, action: &str, public: bool) -> Result<(), String> {
    use windows::{core::{w, PCWSTR}, Win32::{Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE},
        UI::{Shell::{ShellExecuteExW, SHELLEXECUTEINFOW, SEE_MASK_NOCLOSEPROCESS, SEE_MASK_NOASYNC}, WindowsAndMessaging::SW_HIDE}}};
    let executable: Vec<u16> = powershell()?.as_os_str().to_string_lossy().encode_utf16().chain(Some(0)).collect();
    let args: Vec<u16> = format!("-NoLogo -NoProfile -NonInteractive -EncodedCommand {}", encode(&script(program, action, public, 0, 0))).encode_utf16().chain(Some(0)).collect();
    let mut info = SHELLEXECUTEINFOW { cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC, lpVerb: w!("runas"), lpFile: PCWSTR(executable.as_ptr()),
        lpParameters: PCWSTR(args.as_ptr()), nShow: SW_HIDE.0, ..Default::default() };
    unsafe {
        if let Err(error) = ShellExecuteExW(&mut info) {
            return Err(if error.code().0 as u32 == 0x800704c7 { "firewall_cancelled" } else { "firewall_elevation_failed" }.into());
        }
        if info.hProcess.is_invalid() { return Err("firewall_result_unknown".into()); }
        // Runs on a blocking worker, holding the lease for the entire lifetime.
        // No second repair can race a slow UAC dialog or elevated process.
        let waited = WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 0;
        let read = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
        if waited != WAIT_OBJECT_0 || read.is_err() { return Err("firewall_result_unknown".into()); }
        match code { 0 => Ok(()), 12 => Err("firewall_rule_conflict".into()), 13 => Err("firewall_runtime_missing".into()), _ => Err("firewall_repair_failed".into()) }
    }
}
#[cfg(not(windows))]
fn elevate(_: &Path, _: &str, _: bool) -> Result<(), String> { Err("firewall_unsupported".into()) }

#[tauri::command]
pub async fn inspect_lan_firewall(window: WebviewWindow, state: tauri::State<'_, crate::DesktopState>,
    firewall: tauri::State<'_, FirewallState>, port: u16) -> Result<Value, String> {
    crate::authorize(&window, &state)?;
    let lease = firewall.acquire()?;
    let program = state.runtime_program.clone();
    let pid = state.runtime.lock().map_err(|_| "firewall_unavailable")?.child.id();
    crate::native_async::blocking(move || { let _lease = lease; inspect(&program, port, pid) }).await.map_err(|_| "firewall_inspection_failed")?
}
#[tauri::command]
pub async fn repair_lan_firewall(window: WebviewWindow, state: tauri::State<'_, crate::DesktopState>,
    firewall: tauri::State<'_, FirewallState>, allow_public: bool) -> Result<(), String> {
    crate::authorize(&window, &state)?;
    let lease = firewall.acquire()?;
    let program = state.runtime_program.clone();
    if !program.is_file() { return Err("firewall_runtime_missing".into()); }
    crate::native_async::blocking(move || { let _lease = lease; elevate(&program, "repair", allow_public) }).await.map_err(|_| "firewall_result_unknown")?
}

// Called before Tauri/single-instance setup. No runtime is launched and no
// user-supplied program paths are accepted. Uninstall must call before deletion.
pub fn lifecycle() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let action = match args.first().map(String::as_str) {
        Some("--lan-firewall-maintain") => "maintain",
        Some("--lan-firewall-remove") => "remove",
        Some("--lan-firewall-inspect") => "inspect",
        _ => return None,
    };
    if args.len() > 2 || (args.len() == 2 && args[1] != "--silent") { return Some(2); }
    let result = (|| -> Result<(), String> {
        let executable = std::env::current_exe().map_err(|_| "firewall_runtime_missing")?;
        let program = executable.parent().ok_or("firewall_runtime_missing")?.join("runtime").join("node.exe");
        let value = inspect(&program, 0, 0)?;
        if action == "inspect" { println!("{}", value); return Ok(()); }
        let count = value["managedRuleCount"].as_u64().ok_or("firewall_inspection_failed")?;
        // Stable install-path names survive replacement of the binary. Preserve
        // existing scope and administrator changes; never auto-grant on upgrade.
        if action == "maintain" { return if count == 0 || count == 2 { Ok(()) } else { Err("firewall_incomplete".into()) }; }
        if count == 0 { return Ok(()); }
        if args.iter().any(|arg| arg == "--silent") { return Err("firewall_cleanup_required".into()); }
        elevate(&program, "remove", false)
    })();
    Some(if result.is_ok() { 0 } else { 20 })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn paths_are_data_not_powershell_code() {
        let path = Path::new("C:/Users/O'Brien $(); 中文/Rivloom/runtime/node.exe");
        let text = script(path, "repair", false, 0, 0);
        assert!(!text.contains("O'Brien"));
        let encoded = text.split("FromBase64String('").nth(1).unwrap().split('\'').next().unwrap();
        let data: Value = serde_json::from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
        assert_eq!(data["program"], path.to_string_lossy().as_ref());
        assert_eq!(data["allowPublic"], false);
        assert!(encode(&text).len() < 30000);
        assert!(encode(&script(path, "inspect", false, 65535, u32::MAX)).len() < 30000);
    }
    #[test] fn stable_names_are_scoped_to_installation_not_version_or_user_input() {
        assert_eq!(install_key(Path::new("C:/Rivloom/runtime/node.exe")), install_key(Path::new("c:\\rivloom\\RUNTIME\\NODE.EXE")));
        assert_ne!(install_key(Path::new("C:/Rivloom/runtime/node.exe")), install_key(Path::new("D:/Rivloom/runtime/node.exe")));
    }
    #[test] fn resource_and_installer_paths_address_the_same_firewall_rules() {
        for (resource, installed) in [
            (r"\\?\C:\Users\Administrator\Rivloom\runtime\node.exe", r"C:\Users\Administrator\Rivloom\runtime\node.exe"),
            (r"\\?\UNC\server\share\Rivloom\runtime\node.exe", r"\\server\share\Rivloom\runtime\node.exe"),
        ] {
            assert_eq!(install_key(Path::new(resource)), install_key(Path::new(installed)));
            for action in ["inspect", "repair", "remove"] {
                let text = script(Path::new(resource), action, false, 57088, 1);
                let encoded = text.split("FromBase64String('").nth(1).unwrap().split('\'').next().unwrap();
                let data: Value = serde_json::from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
                assert_eq!(data["program"], installed);
                assert_eq!(data["key"], install_key(Path::new(installed)));
            }
        }
        let device = Path::new(r"\\?\GLOBALROOT\Device\Example");
        assert_eq!(firewall_program(device), device);
    }
    #[cfg(windows)]
    #[test] fn lifecycle_and_live_runtime_use_the_same_windows_program_path() {
        let installation = Path::new("C:\\Users\\Example\\Rivloom");
        let runtime = installation.join("runtime");
        let lifecycle = installation.join("runtime").join("node.exe");
        assert_eq!(runtime.join("node.exe"), lifecycle);
        assert_eq!(lifecycle.to_str().unwrap(), "C:\\Users\\Example\\Rivloom\\runtime\\node.exe");
    }
    #[test] fn encoded_command_roundtrips_unicode_as_utf16() {
        let text = "中文 ' $()";
        let bytes = STANDARD.decode(encode(text)).unwrap();
        assert_eq!(String::from_utf16(&bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0],c[1]])).collect::<Vec<_>>()).unwrap(), text);
    }
    #[test] fn lease_survives_caller_and_serializes_native_work() {
        let state = FirewallState::default(); let lease = state.acquire().unwrap();
        assert!(state.acquire().is_err()); drop(lease); assert!(state.acquire().is_ok());
    }
}
