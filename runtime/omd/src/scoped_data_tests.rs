use super::*;
use serde_json::json;
use std::fs;
use std::os::unix::fs::MetadataExt;

#[test]
fn managed_data_selection_supports_evidence_and_sessions_and_rechecks_revocation() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let (repo, package, sessions) = (
        base.join("repo"),
        base.join("package"),
        base.join("sessions"),
    );
    for path in [&repo, &package, &sessions] {
        fs::create_dir(path).unwrap();
    }
    fs::write(
        package.join("mod.json"),
        json!({
            "schema": 1, "id": "managed_data", "version": "1.0.0", "api": crate::MOD_API_VERSION,
            "state_version": 1, "capabilities": ["store", "sessions", "sessions_tools"],
            "license": "MIT", "provenance": {"maintainer": "Fixture", "source": "fixture"}
        })
        .to_string(),
    )
    .unwrap();
    fs::write(package.join("index.ts"), "export default function () {}\n").unwrap();
    let source = crate::ModStore::inspect_package(&package).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    let policy = base.join("policy.json");
    let selected = json!({"schema": 1, "packages": [{
        "id": "managed_data", "source": package, "sha256": source,
        "capabilities": ["store", "sessions", "sessions_tools"]
    }]});
    fs::write(&policy, selected.to_string()).unwrap();
    let mut store = crate::ModStore::create(base.join("store")).unwrap();
    store.set_managed_policy(policy.clone(), fs::metadata(&base).unwrap().uid(), "alice");
    store.package_sync(false).unwrap();
    assert!(store.configuration().unwrap().mods.is_empty());
    let rows = [
        json!({"type": "session_meta", "payload": {"id": "session-a", "cwd": repo, "timestamp": "2026-11-07T12:00:00Z", "memory_mode": "enabled"}}),
        json!({"type": "turn_context", "payload": {"turn_id": "turn-a", "cwd": repo}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "visible message"}]}}),
    ];
    fs::write(
        sessions.join("a.jsonl"),
        rows.iter()
            .map(|row| format!("{row}\n"))
            .collect::<String>(),
    )
    .unwrap();
    let mut host = ScopedDataHost::with_store(
        store,
        repo,
        Some(sessions),
        None,
        "managed_data".into(),
        "thread-a".into(),
        source,
    )
    .unwrap();
    let evidence = host
        .call(
            "evidence.write",
            json!({"media_type": "text/plain", "content": "managed evidence"}),
            || true,
        )
        .unwrap();
    assert!(
        host.call("evidence.read", json!({"reference": evidence}), || true)
            .unwrap()
            .to_string()
            .contains("managed evidence")
    );
    let listed = host.call("sessions.list", json!({}), || true).unwrap();
    let summary = &listed["sessions"][0];
    assert_eq!(summary["session_id"], "session-a");
    let read = json!({"session_id": "session-a", "revision": summary["revision"], "handle": summary["handle"]});
    assert!(
        host.call("sessions.read", read.clone(), || true)
            .unwrap()
            .to_string()
            .contains("visible message")
    );
    let unrelated = base.join("unrelated");
    fs::create_dir(&unrelated).unwrap();
    fs::write(
        unrelated.join("mod.json"),
        json!({
            "schema": 1, "id": "unrelated", "version": "1.0.0", "api": crate::MOD_API_VERSION,
            "state_version": 1, "capabilities": ["store"]
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        unrelated.join("index.ts"),
        "export default function () {}\n",
    )
    .unwrap();
    let unrelated_source = crate::ModStore::inspect_package(&unrelated).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    host.store
        .trust(
            unrelated.clone(),
            &unrelated_source,
            vec!["store".into()],
            "user",
        )
        .unwrap();
    host.store.enable(&unrelated, true).unwrap();
    fs::write(unrelated.join("index.ts"), "export default () => null;\n").unwrap();
    host.call("sessions.list", json!({}), || true).unwrap();
    let configuration = fs::read(host.root.join("mods.json")).unwrap();
    fs::write(host.root.join("mods.json"), "broken").unwrap();
    host.call("sessions.list", json!({}), || true).unwrap();
    fs::write(host.root.join("mods.json"), configuration).unwrap();
    fs::write(&policy, json!({"schema": 1, "packages": []}).to_string()).unwrap();
    for (operation, arguments) in [
        ("evidence.read", json!({"reference": evidence})),
        (
            "evidence.write",
            json!({"media_type": "text/plain", "content": "revoked"}),
        ),
        ("sessions.list", json!({})),
        ("sessions.read", read),
    ] {
        assert_eq!(
            host.call(operation, arguments, || true)
                .unwrap_err()
                .to_string(),
            "data_source_not_selected"
        );
    }
    fs::write(&policy, selected.to_string()).unwrap();
    host.call("sessions.list", json!({}), || true).unwrap();
    let deployed = host
        .store
        .data_selection(
            &host.repository,
            "managed_data",
            &host.binding.source_sha256,
        )
        .unwrap()
        .1
        .path;
    fs::write(deployed.join("index.ts"), "export default () => null;\n").unwrap();
    assert_eq!(
        host.call("sessions.list", json!({}), || true)
            .unwrap_err()
            .to_string(),
        "data_source_not_selected"
    );
}

#[test]
fn user_data_selection_ignores_unrelated_packages_that_fail_inspection() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let repo = base.join("repo");
    fs::create_dir(&repo).unwrap();
    let store = crate::ModStore::create(base.join("store")).unwrap();
    let mut sources = Vec::new();
    for id in ["owner", "unrelated"] {
        let package = base.join(id);
        fs::create_dir(&package).unwrap();
        fs::write(
            package.join("mod.json"),
            json!({
                "schema": 1, "id": id, "version": "1.0.0", "api": crate::MOD_API_VERSION,
                "state_version": 1, "capabilities": ["store"]
            })
            .to_string(),
        )
        .unwrap();
        fs::write(package.join("index.ts"), "export default function () {}\n").unwrap();
        let source = crate::ModStore::inspect_package(&package).unwrap()["sha256"]
            .as_str()
            .unwrap()
            .to_owned();
        store
            .trust(package.clone(), &source, vec!["store".into()], "user")
            .unwrap();
        store.enable(&package, true).unwrap();
        sources.push((package, source));
    }
    fs::write(
        sources[1].0.join("index.ts"),
        "export default () => null;\n",
    )
    .unwrap();
    let mut host = ScopedDataHost::with_store(
        store,
        repo,
        None,
        None,
        "owner".into(),
        "thread-a".into(),
        sources[0].1.clone(),
    )
    .unwrap();
    let evidence = host
        .call(
            "evidence.write",
            json!({"media_type": "text/plain", "content": "kept"}),
            || true,
        )
        .unwrap();
    assert!(
        host.call("evidence.read", json!({"reference": evidence}), || true)
            .unwrap()
            .to_string()
            .contains("kept")
    );
    fs::write(
        sources[0].0.join("index.ts"),
        "export default () => null;\n",
    )
    .unwrap();
    assert_eq!(
        host.call("evidence.read", json!({"reference": evidence}), || true)
            .unwrap_err()
            .to_string(),
        "data_source_not_selected"
    );
}
