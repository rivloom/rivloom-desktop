//! Platform-specific launch details for the single owned backend process.
use std::{path::{Path, PathBuf}, process::{Child, Command}};

pub fn node_program(root: &Path) -> PathBuf {
    root.join(if cfg!(windows) { "node.exe" } else { "node" })
}

fn allowed_environment(key: &str) -> bool {
    const COMMON: &[&str] = &["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PSModulePath",
        "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
        "PROGRAMFILES(X86)", "SYSTEMDRIVE", "TEMP", "TMP", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
    // vars_os preserves the original spelling (for example ComSpec and windir).
    // Windows variable names are case insensitive, just like the previous
    // var_os("COMSPEC") lookups; Unix names must remain case sensitive.
    COMMON.iter().any(|name| if cfg!(windows) { key.eq_ignore_ascii_case(name) } else { key == *name })
        || (cfg!(target_os = "macos") && matches!(key, "HOME" | "USER" | "LOGNAME"
            | "TMPDIR" | "LANG" | "LC_ALL" | "LC_CTYPE" | "SSH_AUTH_SOCK"))
}

pub fn configure(command: &mut Command, root: &Path, preview: bool) -> Result<(), String> {
    command.env_clear();
    for (key, value) in std::env::vars_os() {
        if key.to_str().is_some_and(allowed_environment) { command.env(key, value); }
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![root.to_path_buf()];
    paths.extend(std::env::split_paths(&path).filter(|path| !cfg!(target_os = "macos") || path.is_absolute()));
    #[cfg(target_os = "macos")]
    for path in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        let path = PathBuf::from(path);
        if !paths.contains(&path) { paths.push(path); }
    }
    command.env("PATH", std::env::join_paths(paths).map_err(|_| "后台程序搜索路径无效。")?);
    // Test discovery isolation is available only in separately identified previews.
    if preview {
        for key in ["RIVLOOM_DISCOVERY_PORT", "RIVLOOM_MDNS_NETWORK", "RIVLOOM_DISCOVERY_FALLBACK"] {
            if let Some(value) = std::env::var_os(key) { command.env(key, value); }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    Ok(())
}

pub fn force_stop(child: &mut Child) {
    // A live, unreaped Child handle pins its PID. Never signal a remembered PID
    // after try_wait has reaped it, or a process group not created by configure.
    if !matches!(child.try_wait(), Ok(None)) { return; }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Stdio;
        let _ = Command::new("taskkill.exe")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x08000000).stdin(Stdio::null())
            .stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" { fn kill(pid: i32, signal: i32) -> i32; }
        if let Ok(pid) = i32::try_from(child.id()) {
            if pid > 1 { unsafe { kill(-pid, 9); } }
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    { let _ = child.kill(); }
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    #[test]
    fn runtime_does_not_inherit_code_injection_or_provider_secrets() {
        for key in ["NODE_OPTIONS", "NODE_PATH", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "RIVLOOM_DATA_DIR"] {
            assert!(!allowed_environment(key), "{key}");
        }
        assert!(allowed_environment("HTTPS_PROXY"));
        assert!(allowed_environment("NO_PROXY"));
    }
    #[cfg(windows)]
    #[test]
    fn windows_environment_preserves_case_insensitive_system_variable_names() {
        for key in ["ComSpec", "ProgramFiles", "ProgramFiles(x86)", "SystemDrive", "windir", "SYSTEMROOT", "PsModulePath", "https_proxy"] {
            assert!(allowed_environment(key), "{key}");
        }
        for key in ["Node_Options", "node_path", "OpenAi_Api_Key"] { assert!(!allowed_environment(key)); }
    }
    #[test]
    fn configure_keeps_the_bundled_runtime_first_without_a_shell() {
        let root = std::env::current_dir().unwrap();
        let mut command = Command::new(node_program(&root));
        configure(&mut command, &root, false).unwrap();
        let environment: Vec<(OsString, Option<OsString>)> = command.get_envs().map(|(k,v)| (k.into(), v.map(Into::into))).collect();
        let path = environment.iter().find(|(key,_)| key == "PATH").unwrap().1.as_ref().unwrap();
        assert_eq!(std::env::split_paths(path).next().unwrap(), root);
        assert!(environment.iter().all(|(key,_)| !key.to_string_lossy().starts_with("RIVLOOM_")));
        assert_eq!(Path::new(command.get_program()).parent(), Some(root.as_path()));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn mac_user_and_temporary_locations_survive_the_restricted_environment() {
        for key in ["HOME", "USER", "TMPDIR", "LANG", "SSH_AUTH_SOCK"] { assert!(allowed_environment(key)); }
        assert_eq!(node_program(Path::new("/Applications/Test.app/Contents/Resources/runtime")), Path::new("/Applications/Test.app/Contents/Resources/runtime/node"));
    }
}
