use codex_omd::data_store::{DataStore, Origin, StoreProvenance};
use codex_omd::scoped_data::{ScopedDataHost, ScopedDataHosts};
use codex_omd::{ModHost, ModStore};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

fn dispatch(
    data: &mut ScopedDataHost,
    stored: &DataStore<'_>,
    repo: &Path,
    operation: &str,
    arguments: Value,
    readable: bool,
) -> std::io::Result<Value> {
    match operation {
        "workspace.read" if readable => {
            let bytes = fs::read(repo.join("fact.txt"))?;
            Ok(
                json!({"files":{"fact.txt":{"text":String::from_utf8(bytes.clone()).unwrap(),"sha256":codex_omd::resource_data::hash(&bytes)}}}),
            )
        }
        "workspace.read" => Err(std::io::Error::other("workspace_read_denied")),
        operation if operation.starts_with("store.") => stored.call(operation, arguments),
        _ => data.call(operation, arguments, || true),
    }
}

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
    let repository_key = codex_omd::resource_data::hash(repo.as_os_str().as_encoded_bytes());
    let stored = DataStore {
        root: &store_path,
        repository_key: &repository_key,
        owner: "example_scoped_data",
        provenance: StoreProvenance {
            r#mod: "example_scoped_data".into(),
            source_sha256: hash.to_owned(),
            thread_id: Some("user-command".into()),
            origin: Origin::UserCommand,
            at: 1,
        },
    };
    let generation = host.generation();
    let retained = host
        .invoke_with(
            "example_scoped_data",
            generation,
            "command",
            "retain",
            Value::Null,
            || true,
            |call| {
                dispatch(
                    &mut data,
                    &stored,
                    &repo,
                    &call.operation,
                    call.arguments,
                    true,
                )
            },
        )
        .unwrap();
    assert_eq!(retained["revision"], 1);
    let frozen = host
        .invoke_with(
            "example_scoped_data",
            generation,
            "command",
            "freeze",
            Value::Null,
            || true,
            |call| {
                dispatch(
                    &mut data,
                    &stored,
                    &repo,
                    &call.operation,
                    call.arguments,
                    true,
                )
            },
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
            |call| {
                dispatch(
                    &mut data,
                    &stored,
                    &repo,
                    &call.operation,
                    call.arguments,
                    true,
                )
            },
        )
        .unwrap();
    assert!(context["text"].as_str().unwrap().contains("A scoped fact."));
    let snapshot = json!({"reference":codex_omd::resource_data::hash(b"snapshot"),"sha256":codex_omd::resource_data::hash(b"snapshot")});
    let worker = host.invoke_with(
        "example_scoped_data", generation, "tool", "worker", json!({}), || true,
        |call| match call.operation.as_str() {
            "workspace.snapshot" => Ok(json!({"snapshot":snapshot,"candidate_sha256":snapshot["sha256"]})),
            "routes.list" => Ok(json!([{"name":"reviewer","roles":["worker"],"available":true}])),
            "agents.spawn" => {
                assert_eq!(call.arguments["workspace"], "read_only");
                assert_eq!(call.arguments["snapshot"], snapshot);
                Ok(json!({"handle":"fixture-worker","route":"reviewer","permissions":"read_only"}))
            }
            "agents.wait" => {
                assert_eq!(call.arguments["consume"], true);
                Ok(json!({"status":"completed","text":"A scoped fact.","consumed":true,
                    "evidence":{"reference":"native-thread:fixture-worker","sha256":codex_omd::resource_data::hash(b"A scoped fact.")}}))
            }
            _ => dispatch(&mut data, &stored, &repo, &call.operation, call.arguments, true),
        },
    ).unwrap();
    assert_eq!(worker["worker"]["status"], "completed");
    let mut denied_calls = Vec::new();
    let denied = host.invoke_with(
        "example_scoped_data",
        generation,
        "command",
        "retain",
        Value::Null,
        || true,
        |call| {
            denied_calls.push(call.operation.clone());
            dispatch(
                &mut data,
                &stored,
                &repo,
                &call.operation,
                call.arguments,
                false,
            )
        },
    );
    assert!(denied.is_err());
    assert_eq!(denied_calls, ["workspace.read"]);
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
            |call| {
                dispatch(
                    &mut data,
                    &stored,
                    &repo,
                    &call.operation,
                    call.arguments,
                    true,
                )
            },
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
        data.call("evidence.read", json!({"reference":frozen}), || true)
            .is_err()
    );
    assert!(!run().status.success());
    store.enable(&component, true).unwrap();
    let bound = data.binding.generation;
    let listing = json!({"limit": 1});
    let mut listed = 0;
    let mut bytes = 0;
    while bytes <= 1_048_576 {
        let page = data
            .call("sessions.list", listing.clone(), || true)
            .unwrap();
        bytes += serde_json::to_vec(&page).unwrap().len();
        listed += 1;
    }
    assert!(listed > 1 && data.binding.generation > bound);
    let mut hosts = ScopedDataHosts::new(
        store_path.clone(),
        repo.clone(),
        Some(home.join("sessions")),
        None,
        "user-command".into(),
    );
    let owner = "example_scoped_data";
    hosts
        .call(owner, hash, "sessions.list", listing.clone(), || true)
        .unwrap();
    let stale = "0".repeat(64);
    let error = hosts
        .call(owner, &stale, "sessions.list", listing.clone(), || true)
        .unwrap_err();
    assert_eq!(error.to_string(), "data_source_not_selected");
    hosts
        .call(owner, hash, "sessions.list", listing.clone(), || true)
        .unwrap();
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
            .call("evidence.read", json!({"reference":frozen}), || true)
            .is_err()
    );
    fs::write(component.join("index.ts"), "changed").unwrap();
    assert!(codex_omd::plugin_component::inspect(&plugin).is_err());
    fs::remove_dir_all(&component).unwrap();
    std::os::unix::fs::symlink(&repo, &component).unwrap();
    assert!(codex_omd::plugin_component::inspect(&plugin).is_err());
}
