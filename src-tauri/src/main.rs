#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

struct RuntimeProcess {
    child: Child,
}
impl RuntimeProcess {
    fn stop(&mut self) {
        if !matches!(self.child.try_wait(), Ok(None)) {
            return;
        }
        if let Some(mut stdin) = self.child.stdin.take() {
            let _ = stdin.write_all(b"shutdown\n");
        }
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            if !matches!(self.child.try_wait(), Ok(None)) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        // Only kill the process tree still owned by this live Child handle.
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill.exe")
                .args(["/PID", &self.child.id().to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        #[cfg(not(windows))]
        {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}
impl Drop for RuntimeProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

struct DesktopState {
    runtime: Mutex<RuntimeProcess>,
    origin: String,
    data_dir: PathBuf,
    closing: AtomicBool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInfo {
    version: String,
    data_directory: String,
    desktop_token: String,
}

fn authorize(window: &WebviewWindow, state: &DesktopState) -> Result<(), String> {
    let url = window.url().map_err(|_| "无法确认桌面窗口")?;
    if window.label() != "main" || url.origin().ascii_serialization() != state.origin {
        return Err("拒绝来自非应用窗口的原生操作".into());
    }
    Ok(())
}

#[tauri::command]
fn desktop_info(
    window: WebviewWindow,
    state: tauri::State<DesktopState>,
) -> Result<DesktopInfo, String> {
    authorize(&window, &state)?;
    Ok(DesktopInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        data_directory: state.data_dir.display().to_string(),
        desktop_token: fs::read_to_string(state.data_dir.join("desktop-auth-token.txt"))
            .map_err(|_| "桌面认证信息不可用，请重启客户端")?
            .trim()
            .into(),
    })
}

#[tauri::command]
async fn choose_project_directory(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<Option<String>, String> {
    authorize(&window, &state)?;
    let selected = app
        .dialog()
        .file()
        .set_title("选择可信的普通项目文件夹")
        .set_parent(&window)
        .blocking_pick_folder();
    selected
        .map(|p| {
            p.into_path()
                .map(|p| p.display().to_string())
                .map_err(|_| "不支持的目录类型".into())
        })
        .transpose()
}

fn valid_runtime_url(parsed: &tauri::Url) -> bool {
    parsed.scheme() == "http"
        && parsed.host_str() == Some("127.0.0.1")
        && parsed
            .port()
            .is_some_and(|port| (49152..=65535).contains(&port))
        && parsed.path() == "/"
}

fn start_runtime(
    root: &PathBuf,
    data_dir: &PathBuf,
    preview: bool,
) -> Result<(RuntimeProcess, String), Box<dyn std::error::Error>> {
    fs::create_dir_all(data_dir)?;
    let mut command = Command::new(root.join("node.exe"));
    command
        .arg("server/desktop-entry.mjs")
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    for key in [
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "SYSTEMDRIVE",
        "TEMP",
        "TMP",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    // Only the separately identified preview may join an isolated test discovery domain.
    // The installed product keeps its existing restricted runtime environment.
    if preview {
        for key in ["RIVLOOM_DISCOVERY_PORT", "RIVLOOM_MDNS_NETWORK", "RIVLOOM_DISCOVERY_FALLBACK"] {
            if let Some(value) = std::env::var_os(key) { command.env(key, value); }
        }
    }
    let mut paths = vec![root.clone()];
    paths.extend(std::env::split_paths(&path));
    command
        .env("PATH", std::env::join_paths(paths)?)
        .env("PORT", "0")
        .env("RIVLOOM_DESKTOP", "1")
        .env("RIVLOOM_DATA_DIR", data_dir);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut runtime = RuntimeProcess {
        child: command.spawn()?,
    };
    let stdout = runtime.child.stdout.take().ok_or("后台输出不可用")?;
    let mut stderr = runtime.child.stderr.take().ok_or("后台错误流不可用")?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(url) = line.strip_prefix("RIVLOOM_DESKTOP_READY ") {
                let _ = sender.send(url.to_string());
            }
        }
    });
    // Drain the pipe without persisting potentially sensitive runtime output.
    thread::spawn(move || {
        let mut buf = [0; 4096];
        while let Ok(n) = stderr.read(&mut buf) {
            if n == 0 {
                break;
            }
        }
    });
    let url = receiver
        .recv_timeout(Duration::from_secs(35))
        .map_err(|_| "本地服务未能启动。请确认没有其他实例占用数据目录，且安装文件完整。")?;
    let parsed: tauri::Url = url.parse()?;
    if !valid_runtime_url(&parsed) {
        return Err("本地服务地址校验失败".into());
    }
    // Local diagnostics contain no credentials. Useful for support and real process tests.
    fs::write(
        data_dir.join("desktop-runtime.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "desktopPID": std::process::id(), "backendPID": runtime.child.id(), "url": url,
            "version": env!("CARGO_PKG_VERSION")
        }))?,
    )?;
    Ok((runtime, url))
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.unminimize(); let _ = window.set_focus(); }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![desktop_info, choose_project_directory])
        .setup(|app| {
            let data_dir = match std::env::var_os("RIVLOOM_DATA_DIR") {
                Some(path) => PathBuf::from(path),
                None => app.path().app_local_data_dir()?.join("workspace"),
            };
            if !data_dir.is_absolute() { return Err("RIVLOOM_DATA_DIR 必须是绝对路径".into()); }
            let root = app.path().resource_dir()?.join("runtime");
            let preview = app.config().identifier == "com.rivloom.conversationpreview";
            let (runtime, url) = match start_runtime(&root, &data_dir, preview) {
                Ok(result) => result,
                Err(error) => {
                    app.dialog().message(format!("Rivloom 无法启动：{error}")).title("启动失败").blocking_show();
                    return Err(error);
                }
            };
            app.manage(DesktopState { runtime: Mutex::new(runtime), origin: url.clone(), data_dir: data_dir.clone(), closing: AtomicBool::new(false) });
            let allowed_origin = url.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Rivloom · 人与 AI 的任务工作区").inner_size(1280.0, 840.0).min_inner_size(960.0, 640.0)
                .data_directory(data_dir.join("webview"))
                .on_navigation(move |target| target.origin().ascii_serialization() == allowed_origin)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let state = window.state::<DesktopState>();
                if state.closing.swap(true, Ordering::SeqCst) { return; }
                let app = window.app_handle().clone();
                window.app_handle().dialog().message("退出后，执行中的 AI 任务会停止，已产生的文件不会撤销。下次启动需手动检查并继续任务。").title("退出 Rivloom？")
                    .buttons(MessageDialogButtons::OkCancelCustom("退出并停止执行".into(), "留在工作区".into()))
                    .show(move |confirmed| {
                        if confirmed {
                            thread::spawn(move || {
                                if let Ok(mut runtime) = app.state::<DesktopState>().runtime.lock() { runtime.stop(); }
                                app.exit(0);
                            });
                        } else { app.state::<DesktopState>().closing.store(false, Ordering::SeqCst); }
                    });
            }
        })
        .build(tauri::generate_context!())
        .expect("Rivloom 桌面初始化失败");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(state) = handle.try_state::<DesktopState>() {
                if let Ok(mut runtime) = state.runtime.lock() {
                    runtime.stop();
                }
                let _ = fs::remove_file(state.data_dir.join("desktop-runtime.json"));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::valid_runtime_url;

    #[test]
    fn runtime_url_requires_owned_loopback_and_high_http_port() {
        for url in ["http://127.0.0.1:49152", "http://127.0.0.1:65535"] {
            assert!(valid_runtime_url(&url.parse().unwrap()));
        }
        for url in [
            "http://127.0.0.1:1719",
            "http://127.0.0.1:49151",
            "http://127.0.0.1",
            "http://localhost:55000",
            "http://192.168.5.33:55000",
            "https://127.0.0.1:55000",
            "http://127.0.0.1:55000/unexpected",
        ] {
            assert!(!valid_runtime_url(&url.parse().unwrap()));
        }
    }
}
