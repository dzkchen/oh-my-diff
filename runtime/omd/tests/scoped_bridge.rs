use codex_omd::scoped_data::ScopedDataHost;
use codex_omd::{ModHost, ModStore};
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

#[test]
fn independent_component_uses_scoped_data_context_and_cli_dispatch() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let repo = root.join("repo");
    let home = root.join("home");
    let plugin = root.join("plugin");
    let component = plugin.join("component");
    for path in [
        &repo,
        &home.join("sessions"),
        &plugin.join(".codex-plugin"),
        &component,
    ] {
        fs::create_dir_all(path).unwrap();
    }
    fs::write(repo.join("fact.txt"), "A scoped fact.\n").unwrap();
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../mods/examples/scoped_data");
    for file in ["index.ts", "mod.json"] {
        fs::copy(source.join(file), component.join(file)).unwrap();
    }
    let node = PathBuf::from(std::env::var_os("OMD_TEST_NODE").expect("OMD_TEST_NODE required"));
    let store_path = root.join("store");
    let store = ModStore::create(store_path.clone(), node).unwrap();
    let inspected = ModStore::inspect_package(&component).unwrap();
    let hash = inspected["sha256"].as_str().unwrap();
    fs::write(
        plugin.join(".codex-plugin/omd.json"),
        json!({"schema":1,"component":"component","sha256":hash}).to_string(),
    )
    .unwrap();
    assert_eq!(
        codex_omd::plugin_component::inspect(&plugin).unwrap()["package"]["sha256"],
        hash
    );
    store
        .trust(
            component.clone(),
            hash,
            serde_json::from_value(inspected["manifest"]["capabilities"].clone()).unwrap(),
            "user",
        )
        .unwrap();
    store.enable(&component, true).unwrap();
    let mut host = ModHost::open(store_path.clone()).unwrap();
    assert_eq!(host.commands().len(), 4, "{}", host.status());
    let mut data = ScopedDataHost::new(
        store_path.clone(),
        repo.clone(),
        Some(home.join("sessions")),
        None,
        "example_scoped_data".into(),
        "user-command".into(),
        hash.to_owned(),
    )
    .unwrap();
    let generation = host.generation();
    let retained = host
        .invoke_with(
            "example_scoped_data",
            generation,
            "command",
            "retain",
            Value::Null,
            || true,
            |call| data.call(&call.operation, call.arguments, &|_| true, || true),
        )
        .unwrap();
    assert_eq!(retained["id"], "fixture-fact");
    let frozen = host
        .invoke_with(
            "example_scoped_data",
            generation,
            "command",
            "freeze",
            Value::Null,
            || true,
            |call| data.call(&call.operation, call.arguments, &|_| true, || true),
        )
        .unwrap();
    assert_eq!(frozen["sha256"].as_str().unwrap().len(), 64);
    let context = host
        .invoke_with(
            "example_scoped_data",
            generation,
            "context",
            "",
            json!({}),
            || true,
            |call| data.call(&call.operation, call.arguments, &|_| true, || true),
        )
        .unwrap();
    assert!(context["text"].as_str().unwrap().contains("A scoped fact."));
    let denied = host
        .invoke_with(
            "example_scoped_data",
            generation,
            "context",
            "",
            json!({}),
            || true,
            |call| data.call(&call.operation, call.arguments, &|_| false, || true),
        )
        .unwrap();
    assert!(denied.is_null());
    drop(host);
    let mut resumed = ModHost::open(store_path.clone()).unwrap();
    let mut data = ScopedDataHost::new(
        store_path.clone(),
        repo.clone(),
        Some(home.join("sessions")),
        None,
        "example_scoped_data".into(),
        "user-command".into(),
        hash.to_owned(),
    )
    .unwrap();
    let context = resumed
        .invoke_with(
            "example_scoped_data",
            resumed.generation(),
            "context",
            "",
            json!({}),
            || true,
            |call| data.call(&call.operation, call.arguments, &|_| true, || true),
        )
        .unwrap();
    assert!(context["text"].as_str().unwrap().contains("fixture-fact"));
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_omd"))
            .args([
                "example-sessions",
                "--repo",
                repo.to_str().unwrap(),
                "--store",
                store_path.to_str().unwrap(),
                "--home",
                home.to_str().unwrap(),
            ])
            .output()
            .unwrap()
    };
    let output = run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["sessions"], json!([]));
    store.enable(&component, false).unwrap();
    assert!(
        data.call(
            "context.deliver",
            json!({"snapshot":frozen}),
            &|_| true,
            || true
        )
        .is_err()
    );
    assert!(!run().status.success());
    store.enable(&component, true).unwrap();
    let mut changed_selection = ScopedDataHost::new(
        store_path.clone(),
        repo.clone(),
        Some(home.join("sessions")),
        None,
        "example_scoped_data".into(),
        "user-command".into(),
        hash.to_owned(),
    )
    .unwrap();
    assert!(
        changed_selection
            .call(
                "context.deliver",
                json!({"snapshot":frozen}),
                &|_| true,
                || true
            )
            .is_err()
    );
    fs::write(component.join("index.ts"), "changed").unwrap();
    assert!(codex_omd::plugin_component::inspect(&plugin).is_err());
    fs::remove_dir_all(&component).unwrap();
    std::os::unix::fs::symlink(&repo, &component).unwrap();
    assert!(codex_omd::plugin_component::inspect(&plugin).is_err());
}
