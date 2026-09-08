// Read-only Windows notification diagnostic for an explicitly supplied install.
// Does not register a class, send a toast, invoke Activate, or change the app.
#![windows_subsystem = "windows"]
#[path = "../src/notification_target.rs"]
#[allow(dead_code)]
mod notification_target;
#[path = "../src/windows_notifications.rs"]
#[allow(dead_code)]
mod windows_notifications;

use std::path::PathBuf;
use windows::Win32::System::Com::{
    CoGetClassObject, CoInitializeEx, CoUninitialize, IClassFactory, CLSCTX_LOCAL_SERVER,
    COINIT_MULTITHREADED,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let own_directory = std::env::current_exe()?
        .parent()
        .ok_or("Missing directory")?
        .to_path_buf();
    let desktop_context = std::env::args().nth(1).is_none();
    let executable = if let Some(path) = std::env::args().nth(1) {
        PathBuf::from(path)
    } else {
        // A fixed request file lets the same read-only probe run without a
        // terminal, in the desktop launcher's Windows context.
        let request: serde_json::Value = serde_json::from_slice(&std::fs::read(
            own_directory.join("notification-inspect-request.json"),
        )?)?;
        PathBuf::from(request["executable"].as_str().ok_or("Expected EXE path")?)
    };
    if !executable.is_absolute() || !executable.is_file() {
        return Err("Expected an existing absolute EXE path".into());
    }
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
    let registered = windows_notifications::registered_for(
        &executable,
        windows_notifications::APP_ID,
        windows_notifications::ACTIVATOR_ID_TEXT,
    );
    let factory: windows::core::Result<IClassFactory> = unsafe {
        CoGetClassObject(
            &windows_notifications::ACTIVATOR_ID,
            CLSCTX_LOCAL_SERVER,
            None,
        )
    };
    let factory_status = match &factory {
        Ok(_) => serde_json::json!({"available": true}),
        Err(error) => {
            serde_json::json!({"available": false, "hresult": format!("{:08X}", error.code().0 as u32)})
        }
    };
    let result = serde_json::json!({"registeredForInstalledExecutable":registered,"classFactory":factory_status});
    if desktop_context {
        std::fs::write(
            own_directory.join("notification-inspect-result.json"),
            serde_json::to_vec_pretty(&result)?,
        )?;
    } else {
        println!("{result}");
    }
    drop(factory);
    unsafe { CoUninitialize() };
    Ok(())
}
