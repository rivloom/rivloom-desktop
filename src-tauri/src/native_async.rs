//! Bridges native callbacks and bounded blocking work without occupying an
//! async command worker while a dialog or operating-system service is pending.

pub async fn callback<T: Send + 'static>(
    register: impl FnOnce(Box<dyn FnOnce(T) + Send>),
) -> Result<T, ()> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    register(Box::new(move |value| {
        // A closed window may already have dropped the waiting command.
        let _ = sender.try_send(value);
    }));
    receiver.recv().await.ok_or(())
}

pub async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> T + Send + 'static,
) -> tauri::Result<T> {
    tauri::async_runtime::spawn_blocking(operation).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::mpsc,
        thread,
        time::Duration,
    };

    #[test]
    fn callback_preserves_selection_and_user_cancellation() {
        let chosen = Some("C:/synthetic/project".to_owned());
        assert_eq!(
            tauri::async_runtime::block_on(callback(|reply| reply(chosen.clone()))),
            Ok(chosen)
        );
        assert_eq!(
            tauri::async_runtime::block_on(callback(|reply| reply(None::<String>))),
            Ok(None)
        );
        // A registration that drops its callback is a transport failure, not
        // a successful user cancellation.
        assert_eq!(
            tauri::async_runtime::block_on(callback::<Option<String>>(|_| {})),
            Err(())
        );
    }

    #[test]
    fn open_dialog_yields_and_a_late_callback_survives_a_dropped_command() {
        let (registered, callback_rx) = mpsc::channel();
        let pending = tauri::async_runtime::spawn(async move {
            callback::<Option<String>>(|reply| registered.send(reply).unwrap()).await
        });
        let reply = callback_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let (probe_tx, probe_rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move { probe_tx.send(()).unwrap() });
        let progressed = probe_rx.recv_timeout(Duration::from_secs(2));
        pending.abort();
        assert!(tauri::async_runtime::block_on(pending).is_err());
        reply(None);
        assert!(progressed.is_ok(), "Pending native dialog blocked async work");
    }

    #[test]
    fn blocking_native_wait_leaves_async_worker_available_and_preserves_result() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let pending = tauri::async_runtime::spawn(async move {
            blocking(move || {
                started_tx.send(thread::current().id()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                Err::<bool, _>("synthetic delivery failure")
            })
            .await
        });
        let blocking_thread = started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let (probe_tx, probe_rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = probe_tx.send(thread::current().id());
        });
        let progressed = probe_rx.recv_timeout(Duration::from_secs(2));
        // Release even on failure so the regression cannot strand a worker.
        release_tx.send(()).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(pending).unwrap().unwrap(),
            Err("synthetic delivery failure")
        );
        assert_ne!(
            progressed.expect("Blocking native wait starved the async executor"),
            blocking_thread
        );
    }
}
