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
fn removing_the_default_promotes_another_and_clears_its_home() {
    let (_temp, profiles) = profiles();
    profiles.create("a", "chatgpt", None, None).unwrap();
    profiles
        .create_secret("site", "https://example.com", "vault")
        .unwrap();
    profiles.create("b", "chatgpt", None, None).unwrap();
    let home = profiles.home("p1").unwrap();
    assert!(profiles.remove("p1").unwrap());
    assert!(!home.exists());
    let listed = profiles.list().unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|p| (p.id.as_str(), p.default))
            .collect::<Vec<_>>(),
        [("p2", false), ("p3", true)]
    );
    assert!(!profiles.remove("p1").unwrap());
    assert!(profiles.home("p1").is_err());
}

#[test]
fn invalid_profiles_and_limits_are_refused() {
    let (_temp, profiles) = profiles();
    assert!(profiles.create("", "chatgpt", None, None).is_err());
    assert!(profiles.create("x\n", "chatgpt", None, None).is_err());
    assert!(profiles.create("x", "oauth2", None, None).is_err());
    assert!(profiles.create("x", "provider", None, None).is_err());
    assert!(
        profiles
            .create("x", "provider", None, Some("http://example.com"))
            .is_err()
    );
    assert!(
        profiles
            .create("x", "api_key", None, Some("https://example.com"))
            .is_err()
    );
    profiles.create("x", "chatgpt", None, None).unwrap();
    assert!(profiles.create("x", "chatgpt", None, None).is_err());
    for n in 1..PROFILE_LIMIT {
        profiles
            .create(&format!("p{n}"), "api_key", None, None)
            .unwrap();
    }
    assert_eq!(
        profiles
            .create("overflow", "api_key", None, None)
            .unwrap_err()
            .to_string(),
        "credential_profile_limit"
    );
    assert!(profiles.set_default("p999").is_err());
}

#[test]
fn secrets_read_api_keys_and_refuse_expired_or_missing_tokens() {
    use base64::Engine;
    let (_temp, profiles) = profiles();
    let key = profiles.create("key", "api_key", None, None).unwrap();
    let chat = profiles.create("chat", "chatgpt", None, None).unwrap();
    assert!(
        profiles
            .secret(&key.id, "https://api.openai.com")
            .unwrap_err()
            .to_string()
            .starts_with("credential_not_enrolled")
    );
    profiles
        .store_auth(&key.id, r#"{"OPENAI_API_KEY":"sk-test"}"#)
        .unwrap();
    let secret = profiles.secret(&key.id, "https://api.openai.com").unwrap();
    assert!(!format!("{secret:?}").contains("sk-test"));
    assert_eq!(
        (secret.token.as_str(), secret.account_id),
        ("sk-test", None)
    );
    assert_eq!(
        profiles
            .secret(&key.id, "https://evil.example")
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
            .secret(&chat.id, "https://chatgpt.com")
            .unwrap_err()
            .to_string()
            .starts_with("credential_expired")
    );
    write(jwt(u64::MAX / 2));
    let secret = profiles.secret(&chat.id, "https://chatgpt.com").unwrap();
    assert_eq!(secret.account_id.as_deref(), Some("acct"));
    assert!(profiles.secret("p99", "https://chatgpt.com").is_err());
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
    assert_eq!(
        profiles
            .secret(&secret.id, "https://example.com:8443")
            .unwrap()
            .token,
        "hunter2"
    );
    assert!(profiles.secret(&secret.id, "https://example.com").is_err());
}
