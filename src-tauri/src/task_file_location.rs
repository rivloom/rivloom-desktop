use std::{
    fs,
    path::{Component, Path},
};

fn validate(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("文件路径无效。".into());
    }
    let info = fs::symlink_metadata(path).map_err(|_| "文件不存在，请刷新后重试。")?;
    if !info.is_file() || info.is_symlink() {
        return Err("文件路径无效。".into());
    }
    Ok(())
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
    #[ignore = "Opens Explorer on an explicitly supplied synthetic fixture"]
    fn reveal_fixture_in_explorer() {
        reveal(&std::env::var("RIVLOOM_REVEAL_FIXTURE").expect("Provide a synthetic fixture path"))
            .unwrap();
    }
}
