use std::{
    fs,
    path::{Component, Path},
};

fn validate(path: &Path) -> Result<(), String> {
    validate_kind(path, false)
}

fn validate_kind(path: &Path, directory: bool) -> Result<(), String> {
    if !path.is_absolute()
        || path.as_os_str().to_string_lossy().chars().any(char::is_control)
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("文件路径无效。".into());
    }
    #[cfg(windows)]
    if !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_)))
        || path.components().any(|part| matches!(part, Component::Normal(name) if name.to_string_lossy().contains(':'))) {
        return Err("文件路径无效。".into());
    }
    let info = fs::symlink_metadata(path).map_err(|_| "文件不存在，请刷新后重试。")?;
    if (directory && !info.is_dir()) || (!directory && !info.is_file()) || info.is_symlink() {
        return Err("文件路径无效。".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if info.file_attributes() & 0x400 != 0 { return Err("文件路径无效。".into()); }
    }
    Ok(())
}

/// Pass a validated local path directly to the Windows file association API.
/// The operation is fixed to open; no user-controlled command line or verb is used.
#[cfg(windows)]
pub fn open(path: &str, directory: bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{core::{w, PCWSTR}, Win32::{System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE},
        UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL}}};
    let path = Path::new(path);
    validate_kind(path, directory)?;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let failure = if directory { "无法打开文件夹，请检查目录是否存在。" } else { "无法打开文件，请检查默认应用或另存后打开。" };
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).ok().map_err(|_| failure)?;
        let result = ShellExecuteW(None, w!("open"), PCWSTR(wide.as_ptr()), None, None, SW_SHOWNORMAL);
        CoUninitialize();
        if result.0 as isize <= 32 { Err(failure.into()) } else { Ok(()) }
    }
}

#[cfg(not(windows))]
pub fn open(_path: &str, _directory: bool) -> Result<(), String> {
    Err("无法打开文件，请检查默认应用或另存后打开。".into())
}

/// Select the file in Explorer; never run the file or interpolate it into a shell command.
#[cfg(windows)]
pub fn reveal(path: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::{
            System::Com::{
                CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
            },
            UI::Shell::{SHOpenFolderAndSelectItems, SHParseDisplayName},
        },
    };
    let path = Path::new(path);
    validate(path)?;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    if wide[..wide.len() - 1].contains(&0) {
        return Err("文件路径无效。".into());
    }
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|_| "无法打开文件所在文件夹。")?;
        let mut item = std::ptr::null_mut();
        let result = SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut item, 0, None)
            .and_then(|_| SHOpenFolderAndSelectItems(item, None, 0));
        if !item.is_null() {
            CoTaskMemFree(Some(item.cast()));
        }
        CoUninitialize();
        result.map_err(|_| "无法打开文件所在文件夹。".into())
    }
}

#[cfg(not(windows))]
pub fn reveal(_path: &str) -> Result<(), String> {
    Err("无法打开文件所在文件夹。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_non_file_locations() {
        assert!(validate(Path::new("relative.txt")).is_err());
        assert!(validate(&std::env::current_dir().unwrap()).is_err());
        assert!(validate(&std::env::current_dir().unwrap().join("../Cargo.toml")).is_err());
        assert!(validate(&std::env::current_dir().unwrap().join("Cargo.toml")).is_ok());
    }
    #[test]
    fn open_actions_require_the_correct_kind_and_reject_urls_devices_and_missing_paths() {
        let directory = std::env::current_dir().unwrap();
        assert!(validate_kind(&directory, true).is_ok());
        assert!(validate_kind(&directory.join("Cargo.toml"), true).is_err());
        assert!(validate_kind(&directory, false).is_err());
        assert!(validate_kind(&directory.join("missing-context-menu-fixture"), false).is_err());
        for path in ["https://example.com/file", "file:///C:/test.txt", "C:relative.txt", "shell:AppsFolder", "C:\\file\0.txt", "\\\\.\\NUL", "\\\\server\\share\\file.txt", "C:\\file.txt:stream"] {
            assert!(validate_kind(Path::new(path), false).is_err(), "{path}");
            assert!(validate_kind(Path::new(path), true).is_err(), "{path}");
        }
    }
    #[test]
    #[ignore = "Opens Explorer on an explicitly supplied synthetic fixture"]
    fn reveal_fixture_in_explorer() {
        reveal(&std::env::var("RIVLOOM_REVEAL_FIXTURE").expect("Provide a synthetic fixture path"))
            .unwrap();
    }
}
