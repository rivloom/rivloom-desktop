#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::AtomicBool,
        mpsc, Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

mod native_async;
mod lan_firewall;
mod task_file_location;
mod desktop_update;
mod desktop_tray;
mod update_backup;
#[cfg(windows)]
mod windows_taskbar_icon;
mod notification_target;
#[cfg(windows)]
mod windows_notifications;

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
    fn wait_for_update_exit(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => return if status.success() { Ok(()) } else { Err("update_shutdown_failed".into()) },
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
                _ => return Err("update_shutdown_failed".into()),
            }
        }
    }
}
impl Drop for RuntimeProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

struct DesktopState {
    runtime: Mutex<RuntimeProcess>,
    runtime_program: PathBuf,
    origin: String,
    data_dir: PathBuf,
    closing: AtomicBool,
    notification_target: Arc<Mutex<Option<String>>>,
    last_notification: Mutex<Option<Instant>>,
    #[cfg(windows)]
    notifications: Result<windows_notifications::NotificationService, String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInfo {
    version: String,
    data_directory: String,
    desktop_token: String,
    locale: String,
}

fn read_locale(data_dir: &Path) -> &'static str {
    let path = data_dir.join("ui-language.txt");
    if fs::metadata(&path).map(|m| m.len() <= 64).unwrap_or(false)
        && fs::read_to_string(path).map(|v| v.trim() == "en").unwrap_or(false) {
        "en"
    } else { "zh-CN" }
}

fn native_translation(locale: &str, source: &str) -> String {
    static ENGLISH: OnceLock<serde_json::Value> = OnceLock::new();
    if locale == "en" {
        let catalog = ENGLISH.get_or_init(|| serde_json::from_str(include_str!("../../shared/locales/en.json")).expect("Valid bundled locale catalog"));
        catalog.get(source).and_then(|value| value.as_str()).unwrap_or(source).to_string()
    } else { source.to_string() }
}

fn native_text(data_dir: &Path, source: &str) -> String {
    native_translation(read_locale(data_dir), source)
}

fn save_locale(data_dir: &Path, locale: &str) -> Result<(), String> {
    if !["zh-CN", "en"].contains(&locale) { return Err(native_text(data_dir, "不支持的界面语言")); }
    let temporary = data_dir.join("ui-language.tmp");
    fs::write(&temporary, locale).and_then(|_| fs::rename(&temporary, data_dir.join("ui-language.txt")))
        .map_err(|_| native_text(data_dir, "语言设置未能保存，请重试。"))
}

#[tauri::command]
fn set_desktop_language(window: WebviewWindow, state: tauri::State<DesktopState>, locale: String) -> Result<(), String> {
    authorize(&window, &state)?;
    save_locale(&state.data_dir, &locale)?;
    let _ = window.set_title("Rivloom");
    desktop_tray::update_language(window.app_handle())
        .map_err(|_| native_text(&state.data_dir, "无法更新托盘菜单，请重试。"))?;
    Ok(())
}

fn authorize(window: &WebviewWindow, state: &DesktopState) -> Result<(), String> {
    let url = window.url().map_err(|_| native_text(&state.data_dir, "无法确认桌面窗口"))?;
    if window.label() != "main" || url.origin().ascii_serialization() != state.origin {
        return Err(native_text(&state.data_dir, "拒绝来自非应用窗口的原生操作"));
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
        locale: read_locale(&state.data_dir).into(),
        data_directory: state.data_dir.display().to_string(),
        desktop_token: fs::read_to_string(state.data_dir.join("desktop-auth-token.txt"))
            .map_err(|_| native_text(&state.data_dir, "桌面认证信息不可用，请重启客户端"))?
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
    let dialog = app
        .dialog()
        .file()
        .set_title(native_text(&state.data_dir, "选择可信的普通项目文件夹"))
        .set_parent(&window);
    let selected = native_async::callback(move |reply| dialog.pick_folder(reply))
        .await
        .map_err(|_| native_text(&state.data_dir, "请求失败"))?;
    selected
        .map(|p| {
            p.into_path()
                .map(|p| p.display().to_string())
                .map_err(|_| native_text(&state.data_dir, "不支持的目录类型"))
        })
        .transpose()
}

#[tauri::command]
async fn choose_task_file_destination(window: WebviewWindow, app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>, name: String) -> Result<Option<String>, String> {
    authorize(&window, &state)?;
    if name.is_empty() || name.len()>720 || name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) {
        return Err(native_text(&state.data_dir, "保存文件名无效"));
    }
    let dialog = app.dialog().file().set_title(native_text(&state.data_dir, "另存任务文件（请选择未使用的文件名）")).set_parent(&window)
        .set_file_name(&name);
    native_async::callback(move |reply| dialog.save_file(reply)).await
        .map_err(|_| native_text(&state.data_dir, "请求失败"))?
        .map(|p| p.into_path().map(|p| p.display().to_string())
        .map_err(|_| native_text(&state.data_dir, "不支持的保存路径"))).transpose()
}

#[tauri::command]
async fn reveal_task_file(window: WebviewWindow, app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>, path: String) -> Result<(), String> {
    authorize(&window, &state)?;
    let locale = read_locale(&state.data_dir);
    native_async::blocking(move || task_file_location::reveal(&path)).await
        .map_err(|_| native_text(&app.state::<DesktopState>().data_dir, "无法打开文件所在文件夹。"))?
        .map_err(|message| native_translation(locale, &message))
}

#[tauri::command]
async fn open_task_file(window: WebviewWindow, app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>, path: String) -> Result<(), String> {
    authorize(&window, &state)?;
    let locale = read_locale(&state.data_dir);
    native_async::blocking(move || task_file_location::open(&path, false)).await
        .map_err(|_| native_text(&app.state::<DesktopState>().data_dir, "无法打开文件，请检查默认应用或另存后打开。"))?
        .map_err(|message| native_translation(locale, &message))
}

#[tauri::command]
async fn open_project_directory(window: WebviewWindow, app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>, path: String) -> Result<(), String> {
    authorize(&window, &state)?;
    let locale = read_locale(&state.data_dir);
    native_async::blocking(move || task_file_location::open(&path, true)).await
        .map_err(|_| native_text(&app.state::<DesktopState>().data_dir, "无法打开文件夹，请检查目录是否存在。"))?
        .map_err(|message| native_translation(locale, &message))
}

fn valid_runtime_url(parsed: &tauri::Url) -> bool {
    parsed.scheme() == "http"
        && parsed.host_str() == Some("127.0.0.1")
        && parsed
            .port()
            .is_some_and(|port| (49152..=65535).contains(&port))
        && parsed.path() == "/"
}

fn valid_notification_target(target: &str) -> bool {
    notification_target::valid(target)
}

#[tauri::command]
fn take_notification_target(window: WebviewWindow, state: tauri::State<DesktopState>) -> Result<Option<String>, String> {
    authorize(&window, &state)?;
    Ok(state.notification_target.lock().map_err(|_| native_text(&state.data_dir, "通知状态暂时不可用"))?.take())
}

// #[command(async)] uses the async executor, not its blocking pool. Keep both
// the notification mutex and the Windows/WinRT wait off that executor as well.
#[tauri::command]
async fn notify_attention(window: WebviewWindow, app: tauri::AppHandle,
    target: String, kind: String, count: u32) -> Result<bool, String> {
    let worker_app = app.clone();
    native_async::blocking(move || notify_attention_blocking(window, worker_app, target, kind, count))
        .await
        .map_err(|_| native_text(&app.state::<DesktopState>().data_dir, "通知状态暂时不可用"))?
}

fn notify_attention_blocking(window: WebviewWindow, app: tauri::AppHandle,
    target: String, kind: String, count: u32) -> Result<bool, String> {
    let state = app.state::<DesktopState>();
    authorize(&window, &state)?;
    if !valid_notification_target(&target) || count == 0 || count > 10_000 {
        return Err(native_text(&state.data_dir, "通知目标无效"));
    }
    let label = match kind.as_str() {
        "approval" => "有任务等待审批", "input" => "有任务等待回答",
        "review" => "有任务等待验收", "interrupted" => "有任务执行中断",
        "failed" => "有任务需要检查", "completed" => "任务已确认完成",
        _ => return Err(native_text(&state.data_dir, "通知类型无效")),
    };
    if app.config().identifier != "com.rivloom.desktop" {
        return Err(native_text(&state.data_dir, "当前是独立预览，系统通知请在正式安装版验证"));
    }
    let mut last = state.last_notification.lock().map_err(|_| native_text(&state.data_dir, "通知状态暂时不可用"))?;
    if last.is_some_and(|at| at.elapsed() < Duration::from_secs(2)) { return Ok(false); }
    #[cfg(windows)]
    {
        let title = if count > 1 { native_text(&state.data_dir, "Rivloom · {{count}} 项任务有新进展").replace("{{count}}", &count.to_string()) } else { format!("Rivloom · {}", native_text(&state.data_dir, label)) };
        state.notifications.as_ref().map_err(|_| native_text(&state.data_dir, "Windows 通知暂不可用，请检查应用安装和系统通知设置"))?
            .show(&target, &title, &native_text(&state.data_dir, "打开工作区查看任务并处理。"))
            .map_err(|_| native_text(&state.data_dir, "Windows 通知暂不可用，请检查应用安装和系统通知设置"))?;
        *last = Some(Instant::now());
        Ok(true)
    }
    #[cfg(not(windows))]
    { let _ = (label, target); Err(native_text(&state.data_dir, "当前平台尚未提供系统通知")) }
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
        "PSModulePath",
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
    if let Some(code) = lan_firewall::lifecycle() { std::process::exit(code); }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            desktop_tray::show_workspace(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().pubkey(desktop_update::PUBLIC_KEY.trim()).build())
        .invoke_handler(tauri::generate_handler![desktop_info, set_desktop_language, choose_project_directory, choose_task_file_destination, reveal_task_file, open_task_file, open_project_directory, notify_attention, take_notification_target, lan_firewall::inspect_lan_firewall, lan_firewall::repair_lan_firewall,
            desktop_update::desktop_update_snapshot, desktop_update::check_desktop_update, desktop_update::skip_desktop_update,
            desktop_update::download_desktop_update, desktop_update::cancel_desktop_update, desktop_update::install_desktop_update,
            desktop_update::confirm_desktop_startup])
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
                    app.dialog().message(native_text(&data_dir, "Rivloom 无法启动：{{error}}").replace("{{error}}", &native_text(&data_dir, &error.to_string()))).title(native_text(&data_dir, "启动失败")).blocking_show();
                    return Err(error);
                }
            };
            let notification_target = Arc::new(Mutex::new(None));
            #[cfg(windows)]
            let notifications = {
                let installed = app.config().identifier == windows_notifications::APP_ID
                    && std::env::current_exe().is_ok_and(|path| windows_notifications::registered_for(
                        &path, windows_notifications::APP_ID, windows_notifications::ACTIVATOR_ID_TEXT));
                if installed {
                    let pending = notification_target.clone();
                    let callback_app = app.handle().clone();
                    windows_notifications::NotificationService::start(windows_notifications::APP_ID, windows_notifications::ACTIVATOR_ID, move |target| {
                        if let Ok(mut pending) = pending.lock() { *pending = Some(target); }
                        desktop_tray::show_workspace(&callback_app);
                    })
                } else { Err("Notification activation is not registered for this installed executable".into()) }
            };
            app.manage(DesktopState { runtime: Mutex::new(runtime), runtime_program: root.join("node.exe"), origin: url.clone(), data_dir: data_dir.clone(), closing: AtomicBool::new(false), notification_target, last_notification: Mutex::new(None), #[cfg(windows)] notifications });
            app.manage(lan_firewall::FirewallState::default());
            app.manage(desktop_update::UpdateState::new(&data_dir, !preview));
            desktop_update::start_background(app.handle().clone());
            let allowed_origin = url.clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Rivloom").inner_size(1280.0, 840.0).min_inner_size(960.0, 640.0)
                .visible(false)
                .data_directory(data_dir.join("webview"))
                .on_navigation(move |target| target.origin().ascii_serialization() == allowed_origin)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            #[cfg(windows)]
            windows_taskbar_icon::apply(&window)?;
            desktop_tray::setup(app.handle())?;
            window.show()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" { return; }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                desktop_tray::request_hide(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("Rivloom 桌面初始化失败");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(state) = handle.try_state::<DesktopState>() {
                #[cfg(windows)]
                if let Ok(notifications) = &state.notifications { notifications.shutdown(); }
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
    use super::{valid_runtime_url, valid_notification_target, read_locale, save_locale, native_translation};

    #[test]
    fn locale_persists_across_restarts_and_rejects_unsupported_values() {
        let suffix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("rivloom-locale-{}-{suffix}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let identity = root.join("identity-sentinel.txt");
        std::fs::write(&identity, "keep-existing-identity").unwrap();
        assert_eq!(read_locale(&root), "zh-CN");
        for locale in ["en", "zh-CN", "en"] {
            save_locale(&root, locale).unwrap();
            assert_eq!(read_locale(&root), locale);
        }
        assert!(save_locale(&root, "../fr").is_err());
        assert_eq!(read_locale(&root), "en");
        assert_eq!(std::fs::read_to_string(&identity).unwrap(), "keep-existing-identity");
        assert_eq!(native_translation("en", "退出 Rivloom"), "Quit Rivloom");
        assert_eq!(native_translation("zh-CN", "退出 Rivloom"), "退出 Rivloom");
        assert_eq!(native_translation("en", "unknown external error"), "unknown external error");
        std::fs::remove_file(identity).unwrap();
        std::fs::remove_file(root.join("ui-language.txt")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn notification_click_only_accepts_task_routes() {
        for target in ["attention", "local:75f9d013-96d5-4906-8b7e-a901a751478f", "remote:75f9d013-96d5-4906-8b7e-a901a751478f", "brain:75f9d013-96d5-4906-8b7e-a901a751478f"] {
            assert!(valid_notification_target(target));
        }
        for target in ["https://example.com", "file:///C:/Windows", "local:../../file", "attention?run=1", "cmd:75f9d013-96d5-4906-8b7e-a901a751478f", "local:75f9d013-96d5-4906-8b7e-a901a751478f/extra"] {
            assert!(!valid_notification_target(target));
        }
    }

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
