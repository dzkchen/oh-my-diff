use super::*;

fn profiles() -> (tempfile::TempDir, CredentialProfiles) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let profiles = CredentialProfiles::local(&root).unwrap();
    (temp, profiles)
}

#[test]
fn profiles_get_private_homes_and_one_default() {
    let (_temp, profiles) = profiles();
    let work = profiles.create("work", "chatgpt", None, None).unwrap();
    let key = profiles
        .create(
            "openrouter",
            "provider",
            Some("openrouter"),
            Some("https://OpenRouter.ai:443/api/v1"),
        )
        .unwrap();
    assert_eq!(
        (work.id.as_str(), work.default, key.default),
        ("p1", true, false)
    );
    assert_eq!(key.destination(), Some("https://openrouter.ai"));
    let home = profiles.home(&key.id).unwrap();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(&home).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_ne!(home, profiles.home(&work.id).unwrap());
    profiles.set_default(&key.id).unwrap();
    let listed = profiles.list().unwrap();
    assert_eq!(
        listed
            .iter()
            .filter(|p| p.default)
            .map(|p| p.id.as_str())
            .collect::<Vec<_>>(),
        ["p2"]
    );
    assert!(!serde_json::to_string(&listed).unwrap().contains("token"));
}

#[test]
fn secrets_read_api_keys_and_refuse_expired_or_missing_tokens() {
    use base64::Engine;
    let (_temp, profiles) = profiles();
    let key = profiles.create("key", "api_key", None, None).unwrap();
    let chat = profiles.create("chat", "chatgpt", None, None).unwrap();
    assert!(
        profiles
            .secret(&key.id, "https://api.openai.com", None)
            .unwrap_err()
            .to_string()
            .starts_with("credential_not_enrolled")
    );
    profiles
        .store_auth(&key.id, r#"{"OPENAI_API_KEY":"sk-test"}"#)
        .unwrap();
    let secret = profiles
        .secret(&key.id, "https://api.openai.com", None)
        .unwrap();
    assert!(!format!("{secret:?}").contains("sk-test"));
    assert_eq!(
        (secret.token.as_str(), secret.account_id),
        ("sk-test", None)
    );
    assert_eq!(
        profiles
            .secret(&key.id, "https://evil.example", None)
            .unwrap_err()
            .to_string(),
        "credential_origin_mismatch: p1"
    );
    let jwt = |exp: u64| {
        let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::json!({"exp": exp}).to_string());
        format!("h.{claims}.s")
    };
    let write = |token: String| {
        fs::write(
            profiles.home(&chat.id).unwrap().join("auth.json"),
            serde_json::json!({"tokens": {"access_token": token, "account_id": "acct"}})
                .to_string(),
        )
        .unwrap();
    };
    write(jwt(1));
    assert!(
        profiles
            .secret(&chat.id, "https://chatgpt.com", None)
            .unwrap_err()
            .to_string()
            .starts_with("credential_expired")
    );
    write(jwt(u64::MAX / 2));
    let secret = profiles
        .secret(&chat.id, "https://chatgpt.com", None)
        .unwrap();
    assert_eq!(secret.account_id.as_deref(), Some("acct"));
    assert!(profiles.secret("p99", "https://chatgpt.com", None).is_err());
}

#[test]
fn secrets_are_origin_bound_and_readable_only_by_their_owner() {
    let (_temp, profiles) = profiles();
    assert!(
        profiles
            .create_secret("site", "https://example.com/login", "vault")
            .is_err()
    );
    assert!(
        profiles
            .create_secret("site", "ftp://example.com", "vault")
            .is_err()
    );
    let secret = profiles
        .create_secret("site", "https://example.com:8443", "vault")
        .unwrap();
    assert!(!secret.default);
    assert!(profiles.owned_secret(&secret.id, "vault").is_err());
    assert_eq!(
        profiles.visible("vault").unwrap()[0]["status"],
        "not_enrolled"
    );
    profiles.store_secret(&secret.id, "hunter2").unwrap();
    assert_eq!(profiles.visible("vault").unwrap()[0]["status"], "ready");
    assert!(profiles.visible("other").unwrap().is_empty());
    assert_eq!(
        profiles.owned_secret(&secret.id, "vault").unwrap()["value"],
        "hunter2"
    );
    assert!(profiles.owned_secret(&secret.id, "other").is_err());
    for owner in [Some("vault"), None] {
        assert_eq!(
            profiles
                .secret(&secret.id, "https://example.com:8443", owner)
                .unwrap()
                .token,
            "hunter2"
        );
    }
    assert_eq!(
        profiles
            .secret(&secret.id, "https://example.com:8443", Some("other"))
            .unwrap_err()
            .to_string(),
        format!("credential_secret_not_owned: {}", secret.id)
    );
    assert!(
        profiles
            .secret(&secret.id, "https://example.com", Some("vault"))
            .is_err()
    );
}

#[test]
fn credential_files_are_replaced_privately_and_atomically() {
    use std::os::unix::fs::PermissionsExt;
    let (_temp, profiles) = profiles();
    let secret = profiles
        .create_secret("site", "https://example.com", "vault")
        .unwrap();
    let key = profiles
        .create(
            "key",
            "provider",
            Some("p"),
            Some("https://api.example.com"),
        )
        .unwrap();
    let tokens = ["a".repeat(64), "b".repeat(4000)];
    for (id, origin, owner, file) in [
        (&secret.id, "https://example.com", Some("vault"), "secret"),
        (&key.id, "https://api.example.com", None, "auth.json"),
    ] {
        let store = |token: &str| {
            if file == "secret" {
                profiles.store_secret(id, token)
            } else {
                profiles.store_auth(
                    id,
                    &serde_json::json!({"OPENAI_API_KEY": token}).to_string(),
                )
            }
        };
        let read = || profiles.secret(id, origin, owner).unwrap().token;
        let home = profiles.root.join(id);
        store(&tokens[0]).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o500)).unwrap();
        let staged = store(&tokens[1]);
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(staged.is_err());
        assert_eq!(read(), tokens[0]);
        assert_eq!(fs::read_dir(&home).unwrap().count(), 1);
        let done = std::sync::atomic::AtomicBool::new(false);
        std::thread::scope(|scope| {
            let reader = scope.spawn(|| {
                let mut reads = 0;
                while !done.load(std::sync::atomic::Ordering::Acquire) {
                    assert!(tokens.contains(&read()));
                    reads += 1;
                }
                reads
            });
            for round in 0..200 {
                store(&tokens[round % 2]).unwrap();
            }
            done.store(true, std::sync::atomic::Ordering::Release);
            assert!(reader.join().unwrap() > 0);
        });
        let path = home.join(file);
        assert_eq!(
            fs::symlink_metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(home.join("elsewhere"), &path).unwrap();
        assert!(store(&tokens[0]).is_err());
        assert!(fs::symlink_metadata(home.join("elsewhere")).is_err());
    }
}
