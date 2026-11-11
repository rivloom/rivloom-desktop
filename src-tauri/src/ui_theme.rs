use std::{fs, path::Path};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preference { Light, Dark, System }
impl Preference {
    pub fn parse(value: &str) -> Option<Self> {
        match value { "light" => Some(Self::Light), "dark" => Some(Self::Dark), "system" => Some(Self::System), _ => None }
    }
    pub fn as_str(self) -> &'static str {
        match self { Self::Light => "light", Self::Dark => "dark", Self::System => "system" }
    }
}

pub fn read(directory: &Path) -> Preference {
    let path = directory.join("ui-theme.txt");
    if fs::metadata(&path).map(|value| value.len() <= 64).unwrap_or(false) {
        if let Ok(value) = fs::read_to_string(path) {
            if let Some(value) = Preference::parse(value.trim()) { return value; }
        }
    }
    Preference::System
}

pub fn save(directory: &Path, preference: Preference) -> std::io::Result<()> {
    let temporary = directory.join("ui-theme.tmp");
    fs::write(&temporary, preference.as_str())?;
    fs::rename(temporary, directory.join("ui-theme.txt"))
}

/// Only a validated enum enters JavaScript. The per-window key lets a page reload
/// retain a newer choice without allowing a previous launch's browser cache to
/// override the durable native preference.
pub fn initialization_script(preference: Preference, session: u128) -> String {
    format!("(() => {{ const key = 'rivloom.theme.session.{session}'; let value = '{}'; try {{ const cached = sessionStorage.getItem(key); if (['light','dark','system'].includes(cached)) value = cached; }} catch {{}} window.__RIVLOOM_THEME__ = value; window.__RIVLOOM_THEME_SESSION__ = key; }})();", preference.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn theme_survives_reopen_without_touching_other_preferences() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("rivloom-theme-{}-{stamp}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("ui-language.txt"), "en").unwrap();
        assert_eq!(read(&root), Preference::System);
        for preference in [Preference::Dark, Preference::Light, Preference::System] {
            save(&root, preference).unwrap(); assert_eq!(read(&root), preference);
        }
        fs::write(root.join("ui-theme.txt"), "<script>").unwrap();
        assert_eq!(read(&root), Preference::System);
        fs::write(root.join("ui-theme.txt"), "x".repeat(65)).unwrap();
        assert_eq!(read(&root), Preference::System);
        assert_eq!(fs::read_to_string(root.join("ui-language.txt")).unwrap(), "en");
        fs::remove_file(root.join("ui-theme.txt")).unwrap();
        fs::remove_file(root.join("ui-language.txt")).unwrap(); fs::remove_dir(root).unwrap();
    }
    #[test]
    fn input_is_a_closed_enum_and_script_contains_no_external_data() {
        for invalid in ["", "Dark", "../dark", "dark';alert(1)"] { assert!(Preference::parse(invalid).is_none()); }
        let script = initialization_script(Preference::Dark, 123);
        assert!(script.contains("let value = 'dark'"));
        assert!(script.contains("rivloom.theme.session.123"));
    }
}
