// Shared by notification creation and Windows activation. A click may only
// navigate to a workspace view; it must never become a URL or a command.
pub fn valid(target: &str) -> bool {
    if target == "attention" {
        return true;
    }
    let Some((kind, id)) = target.split_once(':') else {
        return false;
    };
    ["local", "remote", "brain"].contains(&kind)
        && id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

pub fn activated_target(expected_app_id: &str, app_id: &str, arguments: &str) -> Option<String> {
    if app_id != expected_app_id {
        return None;
    }
    // Clicking the app heading in Notification Center supplies no launch data.
    if arguments.is_empty() {
        return Some("attention".into());
    }
    valid(arguments).then(|| arguments.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_workspace_routes_from_the_expected_app() {
        for target in [
            "attention",
            "local:75f9d013-96d5-4906-8b7e-a901a751478f",
            "remote:75f9d013-96d5-4906-8b7e-a901a751478f",
            "brain:75f9d013-96d5-4906-8b7e-a901a751478f",
        ] {
            assert_eq!(
                activated_target("test.app", "test.app", target).as_deref(),
                Some(target)
            );
            assert_eq!(activated_target("test.app", "other.app", target), None);
        }
        assert_eq!(
            activated_target("test.app", "test.app", "").as_deref(),
            Some("attention")
        );
        for target in [
            "https://example.com",
            "file:///C:/Windows",
            "local:../../file",
            "attention?run=1",
            "cmd:75f9d013-96d5-4906-8b7e-a901a751478f",
            "local:75f9d013-96d5-4906-8b7e-a901a751478f/extra",
            "attention\0extra",
        ] {
            assert_eq!(activated_target("test.app", "test.app", target), None);
        }
        assert_eq!(
            activated_target("test.app", "test.app", &"a".repeat(100_000)),
            None
        );
    }
}
