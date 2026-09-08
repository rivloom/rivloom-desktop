// Manual Windows shell regression fixture. It uses a distinct test identity;
// registration is explicit in the companion verification setup, never automatic.
#![cfg_attr(windows, windows_subsystem = "windows")]

#[path = "../src/notification_target.rs"]
mod notification_target;
#[path = "../src/windows_notifications.rs"]
mod windows_notifications;

use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::core::GUID;
use windows_notifications::NotificationService;

const APP_ID: &str = "com.rivloom.notificationcheck.20260907";
const CLSID: GUID = GUID::from_u128(0x3701a8ed_f08e_49e4_905b_b8c9288cb28f);
const CLSID_TEXT: &str = "{3701A8ED-F08E-49E4-905B-B8C9288CB28F}";
const TARGET: &str = "remote:75f9d013-96d5-4906-8b7e-a901a751478f";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let executable = std::env::current_exe()?;
    let root = executable.parent().unwrap().join("notification-evidence");
    fs::create_dir_all(&root)?;
    let mode = std::env::args().nth(1).unwrap_or_else(|| "--show".into());
    if !["--show", "--show-and-exit", "-ToastActivated"].contains(&mode.as_str()) {
        return Err("Expected --show, --show-and-exit or -ToastActivated".into());
    }
    if !windows_notifications::registered_for(&executable, APP_ID, CLSID_TEXT) {
        return Err("Register this isolated verification executable first".into());
    }
    let activated = Arc::new(AtomicBool::new(false));
    let received = activated.clone();
    let callback_root = root.clone();
    let callback_mode = mode.clone();
    let service = NotificationService::start(APP_ID, CLSID, move |target| {
        let record = serde_json::json!({
            "at": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis(),
            "pid": std::process::id(), "mode": callback_mode, "target": target,
            "matched": target == TARGET,
        });
        fs::write(
            callback_root.join(format!("activated-{}.json", std::process::id())),
            serde_json::to_vec_pretty(&record).unwrap(),
        )
        .unwrap();
        received.store(true, Ordering::SeqCst);
    })?;
    fs::write(
        root.join(format!("ready-{}.json", std::process::id())),
        serde_json::to_vec_pretty(
            &serde_json::json!({"pid":std::process::id(),"mode":mode,"target":TARGET}),
        )?,
    )?;
    if mode != "-ToastActivated" {
        service.show(
            TARGET,
            "Rivloom 通知点击验证（独立）",
            "请点击这条测试通知，验证原生任务定位回调。",
        )?;
    }
    if mode == "--show-and-exit" {
        thread::sleep(Duration::from_secs(2));
    } else {
        let deadline = Instant::now() + Duration::from_secs(600);
        while !activated.load(Ordering::SeqCst)
            && Instant::now() < deadline
            && !root.join("stop").exists()
        {
            thread::sleep(Duration::from_millis(100));
        }
    }
    service.shutdown();
    Ok(())
}
