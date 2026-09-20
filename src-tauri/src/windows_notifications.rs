// Unpackaged desktop notifications need a COM activator for Notification Center.
// The old ToastNotification::Activated callback only covered transient toasts.
use crate::notification_target;
use std::{
    ffi::c_void,
    path::Path,
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::Duration,
};
use windows::{
    core::{implement, IUnknown, Interface, Ref, Result, BOOL, GUID, HSTRING, PCWSTR},
    Data::Xml::Dom::XmlDocument,
    Win32::{
        Foundation::{CLASS_E_NOAGGREGATION, E_INVALIDARG, E_POINTER},
        System::{
            Com::{
                CoInitializeEx, CoRegisterClassObject, CoRevokeClassObject, CoUninitialize,
                IClassFactory, IClassFactory_Impl, CLSCTX_LOCAL_SERVER, COINIT_MULTITHREADED,
                REGCLS_MULTIPLEUSE,
            },
            Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ},
        },
        UI::Notifications::{
            INotificationActivationCallback, INotificationActivationCallback_Impl,
            NOTIFICATION_USER_INPUT_DATA,
        },
    },
    UI::Notifications::{ToastNotification, ToastNotificationManager},
};

pub const APP_ID: &str = "com.rivloom.desktop";
pub const ACTIVATOR_ID: GUID = GUID::from_u128(0x64d03dbd_aec3_4d61_97b8_e0ac5b9d0734);
pub const ACTIVATOR_ID_TEXT: &str = "{64D03DBD-AEC3-4D61-97B8-E0AC5B9D0734}";

type Activate = Arc<dyn Fn(String) + Send + Sync>;

#[implement(INotificationActivationCallback)]
struct Activator {
    app_id: String,
    activate: Activate,
}

impl INotificationActivationCallback_Impl for Activator_Impl {
    fn Activate(
        &self,
        app_id: &PCWSTR,
        arguments: &PCWSTR,
        _data: *const NOTIFICATION_USER_INPUT_DATA,
        _count: u32,
    ) -> Result<()> {
        // COM marshals these strings. Bound the read before allocating, and do
        // not interpret notification input fields as actions or command text.
        let app_id = unsafe { bounded_string(*app_id, 128) };
        let arguments = unsafe { bounded_string(*arguments, 64) };
        if let (Some(app_id), Some(arguments)) = (app_id, arguments) {
            if let Some(target) =
                notification_target::activated_target(&self.app_id, &app_id, &arguments)
            {
                (self.activate)(target);
            }
        }
        Ok(())
    }
}

unsafe fn bounded_string(value: PCWSTR, limit: usize) -> Option<String> {
    if value.is_null() {
        return Some(String::new());
    }
    for length in 0..=limit {
        if unsafe { *value.0.add(length) } == 0 {
            return String::from_utf16(unsafe { std::slice::from_raw_parts(value.0, length) }).ok();
        }
    }
    None
}

#[implement(IClassFactory)]
struct ActivatorFactory {
    app_id: String,
    activate: Activate,
}

impl IClassFactory_Impl for ActivatorFactory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<IUnknown>,
        iid: *const GUID,
        object: *mut *mut c_void,
    ) -> Result<()> {
        if object.is_null() || iid.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe { *object = std::ptr::null_mut() };
        if !outer.is_null() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let callback: INotificationActivationCallback = Activator {
            app_id: self.app_id.clone(),
            activate: self.activate.clone(),
        }
        .into();
        unsafe { callback.query(iid, object).ok() }
    }

    fn LockServer(&self, _lock: BOOL) -> Result<()> {
        Ok(())
    }
}

enum Command {
    Show {
        target: String,
        title: String,
        body: String,
        silent: bool,
        reply: mpsc::Sender<std::result::Result<(), String>>,
    },
    Shutdown,
}

// Owns a dedicated MTA apartment for both COM registration and WinRT calls.
// Keeping the registration alive lets Windows deliver clicks after the banner
// disappears, or after Windows starts a new installed process for an old toast.
pub struct NotificationService {
    sender: mpsc::Sender<Command>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl NotificationService {
    pub fn start(
        app_id: &str,
        clsid: GUID,
        activate: impl Fn(String) + Send + Sync + 'static,
    ) -> std::result::Result<Self, String> {
        let (sender, receiver) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let app_id = app_id.to_owned();
        let activate: Activate = Arc::new(activate);
        let thread = thread::spawn(move || {
            if let Err(error) = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() } {
                let _ = ready_tx.send(Err(error.to_string()));
                return;
            }
            let factory: IClassFactory = ActivatorFactory {
                app_id: app_id.clone(),
                activate,
            }
            .into();
            let registration = unsafe {
                CoRegisterClassObject(&clsid, &factory, CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE)
            };
            match registration {
                Err(error) => {
                    let _ = ready_tx.send(Err(error.to_string()));
                }
                Ok(cookie) => {
                    let _ = ready_tx.send(Ok(()));
                    while let Ok(command) = receiver.recv() {
                        match command {
                            Command::Show {
                                target,
                                title,
                                body,
                                silent,
                                reply,
                            } => {
                                let _ = reply.send(
                                    show(&app_id, &target, &title, &body, silent)
                                        .map_err(|error| error.to_string()),
                                );
                            }
                            Command::Shutdown => break,
                        }
                    }
                    let _ = unsafe { CoRevokeClassObject(cookie) };
                }
            }
            drop(factory);
            unsafe { CoUninitialize() };
        });
        match ready_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => Ok(Self {
                sender,
                thread: Mutex::new(Some(thread)),
            }),
            other => {
                // Dropping the sender also ends a delayed successful startup.
                drop(sender);
                match other {
                    Ok(Err(error)) => Err(error),
                    _ => Err("Windows notification activator did not start".into()),
                }
            }
        }
    }

    pub fn show(&self, target: &str, title: &str, body: &str, silent: bool) -> std::result::Result<(), String> {
        if !notification_target::valid(target) {
            return Err("Invalid notification target".into());
        }
        let (reply, result) = mpsc::channel();
        self.sender
            .send(Command::Show {
                target: target.into(),
                title: title.into(),
                body: body.into(),
                silent,
                reply,
            })
            .map_err(|_| "Windows notification activator is unavailable".to_string())?;
        result
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "Windows notification timed out".to_string())?
    }

    pub fn shutdown(&self) {
        let _ = self.sender.send(Command::Shutdown);
        if let Ok(mut handle) = self.thread.lock() {
            if let Some(thread) = handle.take() {
                let _ = thread.join();
            }
        }
    }
}

impl Drop for NotificationService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn toast_xml(target: &str, title: &str, body: &str, silent: bool) -> Result<String> {
    if !notification_target::valid(target) {
        return Err(E_INVALIDARG.into());
    }
    Ok(format!(
        "<toast launch=\"{}\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual>{}</toast>",
        escape_xml(target), escape_xml(title), escape_xml(body), if silent { "<audio silent=\"true\"/>" } else { "" }
    ))
}

fn show(app_id: &str, target: &str, title: &str, body: &str, silent: bool) -> Result<()> {
    let document = XmlDocument::new()?;
    document.LoadXml(&HSTRING::from(toast_xml(target, title, body, silent)?))?;
    let toast = ToastNotification::CreateToastNotification(&document)?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?.Show(&toast)
}

fn registry_string(key: &str, name: &str) -> Option<String> {
    let key = HSTRING::from(key);
    let name = HSTRING::from(name);
    let mut buffer = [0u16; 2048];
    let mut bytes = std::mem::size_of_val(&buffer) as u32;
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &key,
            &name,
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut bytes),
        )
        .ok()
        .ok()?;
    }
    let length = buffer.iter().position(|c| *c == 0)?;
    String::from_utf16(&buffer[..length]).ok()
}

// A source build with the formal identifier must not take over the installed
// app's COM class. The installer owns persistent registration; startup only reads.
pub fn registered_for(executable: &Path, app_id: &str, clsid: &str) -> bool {
    let expected = format!("\"{}\" -ToastActivated", executable.display());
    let command = registry_string(
        &format!("Software\\Classes\\CLSID\\{clsid}\\LocalServer32"),
        "",
    );
    let activator = registry_string(
        &format!("Software\\Classes\\AppUserModelId\\{app_id}"),
        "CustomActivator",
    );
    command.is_some_and(|value| value.eq_ignore_ascii_case(&expected))
        && activator.is_some_and(|value| value.eq_ignore_ascii_case(clsid))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::{core::w, Win32::System::Com::CoCreateInstance};

    #[test]
    fn com_activation_reaches_only_the_valid_task_and_stops_with_the_service() {
        let clsid = GUID::from_u128(0x1886f77e_9521_49bb_aaf8_f2dc4b0195d5);
        let (sender, receiver) = mpsc::channel();
        let service =
            NotificationService::start("com.rivloom.notification-unit", clsid, move |target| {
                sender.send(target).unwrap();
            })
            .unwrap();
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap() };
        let callback: INotificationActivationCallback =
            unsafe { CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER) }.unwrap();
        unsafe {
            callback
                .Activate(w!("wrong.app"), w!("attention"), &[])
                .unwrap();
            callback
                .Activate(
                    w!("com.rivloom.notification-unit"),
                    w!("https://example.com"),
                    &[],
                )
                .unwrap();
            callback
                .Activate(
                    w!("com.rivloom.notification-unit"),
                    w!("local:75f9d013-96d5-4906-8b7e-a901a751478f"),
                    &[],
                )
                .unwrap();
        }
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
            "local:75f9d013-96d5-4906-8b7e-a901a751478f"
        );
        assert!(receiver.try_recv().is_err());
        drop(callback);
        service.shutdown();
        let absent: Result<INotificationActivationCallback> =
            unsafe { CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER) };
        assert!(absent.is_err());
        unsafe { CoUninitialize() };
    }

    #[test]
    fn toast_generic_carries_a_valid_route_and_escapes_text() {
        let xml = toast_xml("attention", "Rivloom <\"任务\">", "A & B '✅'", false).unwrap();
        assert!(xml.contains("<toast launch=\"attention\">"));
        assert!(xml.contains("template=\"ToastGeneric\""));
        assert!(xml.contains("Rivloom &lt;&quot;任务&quot;&gt;"));
        assert!(xml.contains("A &amp; B &apos;✅&apos;"));
        assert!(toast_xml("attention\" activationType=\"protocol", "title", "body", false).is_err());
        assert!(!xml.contains("<audio"));
        assert!(toast_xml("attention", "title", "body", true).unwrap().contains("<audio silent=\"true\"/>"));
    }

    #[test]
    fn installer_and_runtime_share_the_same_activation_identity() {
        let installer = include_str!("../notification-activation.nsh");
        assert!(installer.contains(APP_ID));
        assert!(installer.contains(ACTIVATOR_ID_TEXT));
        assert_eq!(format!("{{{ACTIVATOR_ID:?}}}"), ACTIVATOR_ID_TEXT);
    }
}
