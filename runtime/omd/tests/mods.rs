use codex_omd::MOD_API_VERSION;
const CURRENT_API: &str = MOD_API_VERSION;
use codex_omd::MOD_HOST_FEATURES;
use codex_omd::MOD_PACKAGE_SCHEMA_VERSION;
use codex_omd::MOD_STATE_STORAGE_SCHEMA_VERSION;
use codex_omd::ModHost;
use codex_omd::ModStore;
use codex_omd::OMD_HOST_RELEASE;
use serde_json::Value;
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use tempfile::TempDir;

fn package(root: &std::path::Path, id: &str, source: &str, capabilities: &[&str]) -> PathBuf {
    packaged(root, id, id, source, capabilities, &[])
}

fn packaged(
    root: &std::path::Path,
    directory: &str,
    id: &str,
    source: &str,
    capabilities: &[&str],
    requires: &[&str],
) -> PathBuf {
    let path = root.join(directory);
    std::fs::create_dir(&path).unwrap();
    let mut manifest = json!({"schema":1,"id":id,"version":"1.0.0",
        "api":CURRENT_API,"state_version":1,"capabilities":capabilities});
    if !requires.is_empty() {
        manifest["requires"] = json!(requires);
    }
    std::fs::write(
        path.join("mod.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(path.join("index.ts"), source).unwrap();
    path
}

fn service_package(
    root: &std::path::Path,
    id: &str,
    source: &str,
    services: Value,
    capabilities: &[&str],
) -> PathBuf {
    let path = root.join(id);
    std::fs::create_dir(&path).unwrap();
    let manifest = json!({"schema":1,"id":id,"version":"1.0.0",
        "api":CURRENT_API,"state_version":1,"capabilities":capabilities,
        "services":services});
    std::fs::write(
        path.join("mod.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(path.join("index.ts"), source).unwrap();
    path
}

fn node() -> PathBuf {
    PathBuf::from(
        std::env::var_os("OMD_TEST_NODE")
            .expect("set OMD_TEST_NODE to Node 24.18.0; sandbox tests must actually execute"),
    )
}

fn fixture(source: &str, capabilities: &[&str]) -> (TempDir, ModStore, PathBuf) {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    let path = package(&root, "fixture", source, capabilities);
    trust(&store, &path, capabilities);
    (temp, store, path)
}

fn trust(store: &ModStore, path: &std::path::Path, capabilities: &[&str]) {
    trust_scoped(store, path, capabilities, "user");
}

fn trust_scoped(store: &ModStore, path: &std::path::Path, capabilities: &[&str], scope: &str) {
    let inspected = ModStore::inspect_package(path).unwrap();
    let granted: Vec<String> = capabilities.iter().map(|value| value.to_string()).collect();
    let sha256 = inspected["sha256"].as_str().unwrap();
    contended(|| store.trust(path.to_path_buf(), sha256, granted.clone(), scope));
    contended(|| store.enable(path, true));
}

fn activation_error(temp: &TempDir, id: &str) -> String {
    let runtime = ModHost::open(temp.path().canonicalize().unwrap().join("store")).unwrap();
    runtime.status()["mods"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == id)
        .and_then(|m| m["error"].as_str())
        .unwrap_or_default()
        .to_string()
}

fn contended<T>(mut operation: impl FnMut() -> std::io::Result<T>) -> T {
    for _ in 0..200 {
        match operation() {
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            result => return result.unwrap(),
        }
    }
    panic!("store lock stayed contended")
}

fn host(temp: &TempDir) -> ModHost {
    ModHost::open(temp.path().canonicalize().unwrap().join("store")).unwrap()
}

const COUNTER: &str = "export default api => api.command('count', () => { api.state.set(Number(api.state.get() ?? 0)+1); return api.state.get(); })";

#[test]
fn mod_state_refreshes_per_call_and_racing_writers_fail_without_lost_updates() {
    let source = "export default api => { api.command('count', () => { api.state.set(Number(api.state.get() ?? 0)+1); return api.state.get(); }); api.command('slow', () => { const value = Number(api.state.get() ?? 0); const end = Date.now() + 500; while (Date.now() < end) {} api.state.set(value + 100); return value; }); }";
    let (temp, _, _) = fixture(source, &["commands", "store"]);
    let mut first = host(&temp);
    let mut second = host(&temp);
    let invoke = |runtime: &mut ModHost, name: &str| {
        let generation = runtime.generation();
        runtime.invoke("fixture", generation, "command", name, Value::Null)
    };
    assert_eq!(invoke(&mut first, "count").unwrap(), json!(1));
    assert_eq!(invoke(&mut second, "count").unwrap(), json!(2));
    assert_eq!(invoke(&mut first, "count").unwrap(), json!(3));
    let racing = std::thread::spawn(move || {
        let result = invoke(&mut first, "slow");
        (first, result)
    });
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert_eq!(invoke(&mut second, "count").unwrap(), json!(4));
    let (mut first, result) = racing.join().unwrap();
    assert!(result.unwrap_err().to_string().contains("state_conflict"));
    assert_eq!(invoke(&mut first, "count").unwrap(), json!(5));
    let mut resumed = host(&temp);
    assert_eq!(invoke(&mut resumed, "count").unwrap(), json!(6));
}

#[test]
fn mod_reload_is_transactional_and_stale_calls_are_rejected() {
    let (temp, store, path) = fixture(COUNTER, &["commands", "store"]);
    let mut runtime = host(&temp);
    let generation = runtime.generation();
    std::fs::write(
        path.join("index.ts"),
        "export default () => { throw new Error('broken') }",
    )
    .unwrap();
    trust(&store, &path, &["commands", "store"]);
    assert!(runtime.reload().is_err());
    assert_eq!(
        runtime
            .invoke("fixture", generation, "command", "count", Value::Null)
            .unwrap(),
        json!(1)
    );
    store.enable(&path, false).unwrap();
    runtime.reload().unwrap();
    assert!(
        runtime
            .invoke("fixture", generation, "command", "count", Value::Null)
            .is_err()
    );
    assert!(runtime.status()["mods"].as_array().unwrap().is_empty());
}

#[test]
fn mod_capabilities_source_tamper_and_symlinks_are_rejected() {
    let (temp, store, path) = fixture(
        "export default api => api.command('bad', () => api.state.set(1))",
        &["commands"],
    );
    let mut runtime = host(&temp);
    assert!(
        runtime
            .invoke(
                "fixture",
                runtime.generation(),
                "command",
                "bad",
                Value::Null
            )
            .unwrap_err()
            .to_string()
            .contains("capability_denied")
    );
    std::fs::write(path.join("index.ts"), COUNTER).unwrap();
    assert!(store.enable(&path, true).is_err());
    std::fs::remove_file(path.join("index.ts")).unwrap();
    std::os::unix::fs::symlink("mod.json", path.join("index.ts")).unwrap();
    assert!(ModStore::inspect_package(&path).is_err());
}

#[test]
fn mod_cancellation_discards_state_and_explicit_reload_recovers() {
    let (temp, store, _) = fixture(COUNTER, &["commands", "store"]);
    let mut runtime = host(&temp);
    let calls = AtomicUsize::new(0);
    let result = runtime.invoke_guarded(
        "fixture",
        runtime.generation(),
        "command",
        "count",
        Value::Null,
        || calls.fetch_add(1, Ordering::Relaxed) == 0,
    );
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("callback_cancelled")
    );
    store.reload().unwrap();
    runtime.reload().unwrap();
    assert_eq!(
        runtime
            .invoke(
                "fixture",
                runtime.generation(),
                "command",
                "count",
                Value::Null
            )
            .unwrap(),
        json!(1)
    );
}

#[test]
fn mod_context_is_bounded_and_callback_failure_is_isolated() {
    let (temp, store, _) = fixture(
        "export default api => api.on('context', () => ({text:'x'.repeat(1025)}))",
        &["context"],
    );
    let root = temp.path().canonicalize().unwrap();
    let other = package(
        &root,
        "healthy",
        "export default api => api.on('context', () => ({text:'hello'}))",
        &["context"],
    );
    trust(&store, &other, &["context"]);
    let mut runtime = host(&temp);
    let results = runtime.event("context", Value::Null);
    assert!(
        results[0]
            .1
            .as_ref()
            .unwrap_err()
            .to_string()
            .contains("context_limit")
    );
    assert_eq!(*results[1].1.as_ref().unwrap(), json!({"text":"hello"}));
    assert_eq!(runtime.event("context", Value::Null).len(), 1);
}

#[test]
fn mod_pending_callback_has_a_host_deadline() {
    let (temp, _, _) = fixture(
        "export default api => api.command('hang', () => new Promise(() => { function spin() { Promise.resolve().then(spin) }; spin(); }))",
        &["commands"],
    );
    let mut runtime = host(&temp);
    let start = std::time::Instant::now();
    assert!(
        runtime
            .invoke(
                "fixture",
                runtime.generation(),
                "command",
                "hang",
                Value::Null
            )
            .is_err()
    );
    assert!(start.elapsed() < std::time::Duration::from_secs(6));
}

#[test]
fn mod_capability_revocation_survives_failed_reactivation() {
    let (temp, _, _) = fixture(COUNTER, &["commands", "store"]);
    let mut runtime = host(&temp);
    let path = temp.path().join("store/mods.json");
    let mut configuration: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    configuration["mods"][0]["capabilities"] = json!(["commands"]);
    std::fs::write(&path, serde_json::to_vec(&configuration).unwrap()).unwrap();
    assert!(
        runtime
            .reload()
            .unwrap_err()
            .to_string()
            .contains("capability_denied")
    );
    assert!(runtime.status()["mods"].as_array().unwrap().is_empty());
    assert!(
        runtime
            .invoke(
                "fixture",
                runtime.generation(),
                "command",
                "count",
                Value::Null
            )
            .is_err()
    );
}

#[test]
fn mod_duplicate_id_cannot_replace_an_active_package() {
    let (temp, store, _) = fixture(COUNTER, &["commands", "store"]);
    let mut runtime = host(&temp);
    let other = package(
        &temp.path().canonicalize().unwrap(),
        "other",
        "export default () => {}",
        &[],
    );
    let manifest_path = other.join("mod.json");
    let mut manifest: Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    manifest["id"] = json!("fixture");
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    trust(&store, &other, &[]);
    assert!(
        runtime
            .reload()
            .unwrap_err()
            .to_string()
            .contains("mod_conflict")
    );
    assert_eq!(
        runtime
            .invoke(
                "fixture",
                runtime.generation(),
                "command",
                "count",
                Value::Null
            )
            .unwrap(),
        json!(1)
    );
}

#[test]
fn native_host_bridge_preserves_once_only_effects_and_rust_capability_checks() {
    let source = "export default api => api.command('run', () => { const a = api.host.call('task.status',null); api.state.set(a); return api.host.call('contract.status',{a}); })";
    let (temp, _, _) = fixture(source, &["commands", "store", "agents", "contracts"]);
    let mut runtime = host(&temp);
    let mut calls = Vec::new();
    let value = runtime
        .invoke_with(
            "fixture",
            runtime.generation(),
            "command",
            "run",
            Value::Null,
            || true,
            |call| {
                calls.push(call.operation);
                Ok(json!(calls.len()))
            },
        )
        .unwrap();
    assert_eq!(value, json!(2));
    assert_eq!(calls, vec!["task.status", "contract.status"]);
    let state: Value = serde_json::from_slice(
        &std::fs::read(temp.path().join("store/state-fixture.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(state["value"], json!(1));
    let (denied, _, _) = fixture(source, &["commands", "store"]);
    assert!(activation_error(&denied, "fixture").contains("undeclared_operation_use"));
}

#[test]
fn lifecycle_route_registration_resumes_across_two_host_calls() {
    let source = "export default api => api.on('turn_start', () => { const routes = api.host.call('routes.list', null); if (routes.length) api.host.call('providers.register', {id:'fixture'}); })";
    let (temp, _, _) = fixture(source, &["lifecycle", "model"]);
    let mut runtime = host(&temp);
    let mut operations = Vec::new();
    let results = runtime.event_guarded_with(
        "turn_start",
        Value::Null,
        || true,
        |_, call| {
            operations.push(call.operation.clone());
            if call.operation == "routes.list" {
                Ok(json!([{"provider":"fixture","model":"model"}]))
            } else {
                Ok(Value::Null)
            }
        },
    );
    assert!(results.iter().all(|(_, result)| result.is_ok()));
    assert_eq!(operations, vec!["routes.list", "providers.register"]);
    operations.clear();
    let results = runtime.event_guarded_with(
        "turn_start",
        Value::Null,
        || true,
        |_, call| {
            operations.push(call.operation.clone());
            Ok(json!([]))
        },
    );
    assert!(results.iter().all(|(_, result)| result.is_ok()));
    assert_eq!(operations, vec!["routes.list"]);
}

#[test]
fn migration_is_explicit_bounded_and_preserves_previous_state() {
    let (temp, store, path) = fixture(COUNTER, &["commands", "store"]);
    let mut runtime = host(&temp);
    runtime
        .invoke(
            "fixture",
            runtime.generation(),
            "command",
            "count",
            Value::Null,
        )
        .unwrap();
    let manifest_path = path.join("mod.json");
    let mut manifest: Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    manifest["state_version"] = json!(2);
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    std::fs::write(path.join("index.ts"), "export default api => api.on('migrate', ({from,to}) => { api.state.set({count:api.state.get(),from,to}); })").unwrap();
    let sha = ModStore::inspect_package(&path).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    store
        .trust(
            path.clone(),
            &sha,
            vec!["commands".into(), "store".into()],
            "user",
        )
        .unwrap();
    let receipt = store.migrate(&path).unwrap();
    let backup: Value =
        serde_json::from_slice(&std::fs::read(receipt["backup"].as_str().unwrap()).unwrap())
            .unwrap();
    assert_eq!(backup, json!({"schema":1,"version":1,"value":1}));
    assert!(
        runtime
            .invoke(
                "fixture",
                runtime.generation(),
                "command",
                "count",
                Value::Null
            )
            .is_err()
    );
    store.enable(&path, true).unwrap();
    let resumed = host(&temp);
    assert_eq!(resumed.status()["mods"][0]["error"], Value::Null);
    assert!(
        store
            .migrate(&path)
            .unwrap_err()
            .to_string()
            .contains("disabled")
    );
}

#[test]
fn retired_api_packages_are_rejected_before_trust_or_activation() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let path = package(&root, "retired", "export default () => {}", &[]);
    for version in 4..=9 {
        let retired = format!("0.1.0-experimental.{version}");
        let manifest_path = path.join("mod.json");
        let mut manifest: Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest["api"] = json!(retired);
        std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let error = ModStore::inspect_package(&path).unwrap_err().to_string();
        assert!(error.contains(&retired), "{error}");
        assert!(error.contains(MOD_API_VERSION), "{error}");
    }
}

#[test]
fn incompatible_host_schema_api_and_features_are_rejected_before_activation() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let path = package(&root, "incompatible", "export default () => {}", &[]);
    let manifest_path = path.join("mod.json");
    let base: Value = serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    for (field, value, expected) in [
        ("api", json!("9.0.0"), "Supported package APIs"),
        ("schema", json!(99), "supports package schema"),
        (
            "compatibility",
            json!({"releases":["9.0.0"]}),
            "this host is",
        ),
        (
            "compatibility",
            json!({"required_features":["future_required_v1"]}),
            "provides",
        ),
    ] {
        let mut manifest = base.clone();
        manifest[field] = value;
        std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let error = ModStore::inspect_package(&path).unwrap_err().to_string();
        assert!(error.contains(expected), "{field}: {error}");
        assert!(
            error.contains("package") || error.contains("host"),
            "{error}"
        );
    }
}

#[test]
fn host_versions_and_storage_schemas_are_reported_independently() {
    let (temp, _, _) = fixture("export default () => {}", &[]);
    let status = host(&temp).status();
    assert_eq!(status["host"]["omd"], OMD_HOST_RELEASE);
    assert_eq!(status["host"]["package_schema"], MOD_PACKAGE_SCHEMA_VERSION);
    assert_eq!(
        status["host"]["state_storage_schema"],
        MOD_STATE_STORAGE_SCHEMA_VERSION
    );
    assert_eq!(status["host"]["features"], json!(MOD_HOST_FEATURES));
    assert_ne!(status["host"]["omd"], status["api"]);
}

#[test]
fn interrupted_migration_and_explicit_rollback_preserve_source_settings_and_state() {
    let (temp, store, path) = fixture(COUNTER, &["commands", "store"]);
    store
        .settings(&path, [("label".into(), json!("kept"))].into())
        .unwrap();
    let original_manifest = std::fs::read(path.join("mod.json")).unwrap();
    let original_source = std::fs::read(path.join("index.ts")).unwrap();
    let mut runtime = host(&temp);
    runtime
        .invoke(
            "fixture",
            runtime.generation(),
            "command",
            "count",
            Value::Null,
        )
        .unwrap();
    let state_path = temp.path().join("store/state-fixture.json");
    let state_v1 = std::fs::read(&state_path).unwrap();

    let mut manifest: Value = serde_json::from_slice(&original_manifest).unwrap();
    manifest["state_version"] = json!(2);
    std::fs::write(
        path.join("mod.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let failing_source = b"export default api => api.on('migrate', () => { throw new Error('INTERRUPTED_MIGRATION') })";
    std::fs::write(path.join("index.ts"), failing_source).unwrap();
    let sha = ModStore::inspect_package(&path).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    store
        .trust(
            path.clone(),
            &sha,
            vec!["commands".into(), "store".into()],
            "user",
        )
        .unwrap();
    let error = store.migrate(&path).unwrap_err().to_string();
    assert!(error.contains("INTERRUPTED_MIGRATION"), "{error}");
    assert_eq!(std::fs::read(&state_path).unwrap(), state_v1);
    assert_eq!(
        std::fs::read(path.join("index.ts")).unwrap(),
        failing_source
    );
    assert_eq!(
        store.configuration().unwrap().mods[0].settings["label"],
        "kept"
    );

    std::fs::write(path.join("index.ts"), "export default api => api.on('migrate', ({from,to}) => api.state.set({count:api.state.get(),from,to}))").unwrap();
    let sha = ModStore::inspect_package(&path).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    store
        .trust(
            path.clone(),
            &sha,
            vec!["commands".into(), "store".into()],
            "user",
        )
        .unwrap();
    let migrated = store.migrate(&path).unwrap();
    let state_v2 = std::fs::read(&state_path).unwrap();
    assert_ne!(state_v2, state_v1);
    let backup_path = std::path::Path::new(migrated["backup"].as_str().unwrap());
    let backup_bytes = std::fs::read(backup_path).unwrap();
    std::fs::write(backup_path, b"{\"schema\":1,\"version\":1,\"value\":99}").unwrap();
    assert!(
        store
            .rollback(&path, backup_path)
            .unwrap_err()
            .to_string()
            .contains("digest_mismatch")
    );
    assert_eq!(std::fs::read(&state_path).unwrap(), state_v2);
    std::fs::write(backup_path, backup_bytes).unwrap();
    let rollback = store.rollback(&path, backup_path).unwrap();
    assert_eq!(std::fs::read(&state_path).unwrap(), state_v1);
    assert_eq!(
        std::fs::read(rollback["recovery"].as_str().unwrap()).unwrap(),
        state_v2
    );
    assert_eq!(
        store.configuration().unwrap().mods[0].settings["label"],
        "kept"
    );

    std::fs::write(path.join("mod.json"), &original_manifest).unwrap();
    std::fs::write(path.join("index.ts"), &original_source).unwrap();
    let sha = ModStore::inspect_package(&path).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    store
        .trust(
            path.clone(),
            &sha,
            vec!["commands".into(), "store".into()],
            "user",
        )
        .unwrap();
    store.enable(&path, true).unwrap();
    let mut rolled_back = host(&temp);
    assert_eq!(
        rolled_back
            .invoke(
                "fixture",
                rolled_back.generation(),
                "command",
                "count",
                Value::Null
            )
            .unwrap(),
        json!(2)
    );
    assert_eq!(
        std::fs::read(path.join("index.ts")).unwrap(),
        original_source
    );
    assert_eq!(
        store.configuration().unwrap().mods[0].settings["label"],
        "kept"
    );
}

#[test]
fn host_error_receipts_are_catchable_without_repeating_operations() {
    let source = "export default api => api.command('run', () => { let value; try { value = api.host.call('task.status'); } catch(e) { if (e instanceof Error) return {failed:true}; throw e; } return value; })";
    let (temp, _, _) = fixture(source, &["commands", "agents"]);
    let mut runtime = host(&temp);
    let mut calls = 0;
    assert_eq!(
        runtime
            .invoke_with(
                "fixture",
                runtime.generation(),
                "command",
                "run",
                Value::Null,
                || true,
                |_| {
                    calls += 1;
                    Err(std::io::Error::other("native_denial"))
                }
            )
            .unwrap(),
        json!({"failed":true})
    );
    assert_eq!(calls, 1);
}

#[test]
fn callback_budget_errors_fail_the_call_without_disabling_the_mod() {
    let source = "export default api => api.command('run', arg => { if (arg === 'small') return 'ok'; api.host.call('task.status'); api.host.call('task.status'); return 'unreachable'; })";
    let (temp, _, _) = fixture(source, &["commands", "agents"]);
    let mut runtime = host(&temp);
    let generation = runtime.generation();
    let error = runtime
        .invoke_with(
            "fixture",
            generation,
            "command",
            "run",
            json!("large"),
            || true,
            |_| Ok(json!({"text": "x".repeat(140_000)})),
        )
        .unwrap_err();
    assert!(
        error.to_string().starts_with("Error: host_result_limit"),
        "{error}"
    );
    assert_eq!(
        runtime
            .invoke_with(
                "fixture",
                generation,
                "command",
                "run",
                json!("small"),
                || true,
                |_| { Ok(Value::Null) }
            )
            .unwrap(),
        json!("ok")
    );
}

#[test]
fn exclusive_replacement_conflicts_fail_before_activation() {
    let source = "export default api => api.replace('routing', () => ({route:'sol'}))";
    let (temp, store, _) = fixture(source, &["model"]);
    let mut runtime = host(&temp);
    let other = package(
        &temp.path().canonicalize().unwrap(),
        "other",
        source,
        &["model"],
    );
    trust(&store, &other, &["model"]);
    assert!(
        runtime
            .reload()
            .unwrap_err()
            .to_string()
            .contains("replacement_conflict")
    );
    let results = runtime.event("routing", Value::Null);
    assert_eq!(results.len(), 1);
    assert_eq!(*results[0].1.as_ref().unwrap(), json!({"route":"sol"}));
}

#[test]
fn terminal_validation_rejects_control_sequences_reserved_keys_and_unbounded_views() {
    for value in [
        json!({"keybindings":{"Ctrl+C":"ignore"}}),
        json!({"keybindings":{"Ctrl+c":"ignore"}}),
        json!({"keybindings":{"Ctrl+m":{"submit":"enter"}}}),
        json!({"keybindings":{"Shift+a":"ignore"}}),
        json!({"keybindings":{"F1":"help"}}),
        json!({"keybindings":{"F6":{"submit":"a","insert":"b"}}}),
        json!({"keybindings":{"F6":{"command":"Bad:Name"}}}),
        json!({"keybindings":{"F6":{"submit":"\u{1b}[2J"}}}),
        json!({"panels":[{"title":"bad","lines":["\u{1b}[2J"]}]}),
        json!({"message_template":"hide original output"}),
        json!({"sidebar_width":1000}),
        json!({"sidebar_side":"top"}),
        json!({"header":{"title":"h","lines":["1","2","3","4"]}}),
        json!({"footer":{"title":"f","lines":["\u{7}"]}}),
        json!({"status":["a","b","c","d","e"]}),
        json!({"status":["x".repeat(41)]}),
        json!({"status":[""]}),
        json!({"theme":{"accent":256}}),
        json!({"theme":{"accent":"#12345"}}),
        json!({"theme":{"accent":"blue"}}),
        json!({"theme":{"syntax":""}}),
        json!({"theme":{"border":81}}),
        json!({"sites":{"sidebar":{"components":[{"type":"text","id":"bad-id","label":"Bad","text":"bad"}]}}}),
        json!({"sites":{"sidebar":{"components":[{"type":"slot"}]}}}),
        json!({"sites":{"sidebar":{"components":[{"type":"text","id":"same","label":"One","text":"one"},{"type":"text","id":"same","label":"Two","text":"two"}]}}}),
    ] {
        assert!(codex_omd::ModView::parse(value.clone()).is_err(), "{value}");
    }
    let value = json!({"message_template":"│ {text}","tool_template":"→ {text}","foreground":81,"keybindings":{"F6":"Review current work"}});
    assert!(codex_omd::ModView::parse(value).is_ok());
    let view = codex_omd::ModView::parse(json!({
        "sidebar_side":"left","sidebar_width":24,
        "header":{"title":"Header","lines":["one"]},
        "footer":{"title":"Footer","lines":["two","three"]},
        "status":["build ok","2 agents"],
        "theme":{"accent":81,"user_message_background":"#202830","syntax":"github","success":"#00FF00","attention":214,"failure":196,"diff_added":46,"diff_removed":196,"muted":244,"border":"rounded","density":"compact","icons":"ascii"},
        "sites":{
            "sidebar":{"components":[{
                "type":"box","id":"root_box","label":"Root box","title":"Components","children":[
                    {"type":"text","id":"plain_text","label":"Plain text","text":"plain","tone":"accent"},
                    {"type":"button","id":"run_button","label":"Run button","text":"Run","action":{"command":"counter:reset"}},
                    {"type":"input","id":"review_input","label":"Review input","placeholder":"Review","action":{"command":"counter:review"}},
                    {"type":"select","id":"side_select","label":"Side","value":"left","options":[{"value":"left","label":"Left"},{"value":"right","label":"Right"}],"action":{"command":"counter:side"}},
                    {"type":"markdown","id":"help_markdown","label":"Help","text":"**help**"},
                    {"type":"code","id":"code_sample","label":"Code","text":"let ok = true;","language":"typescript"},
                    {"type":"pane","id":"detail_pane","label":"Details","title":"Details","children":[]}
                ]
            }]},
            "dialog":{"components":[{"type":"dialog","id":"settings_dialog","label":"Settings","title":"Settings","children":[]}]}
        },
        "keybindings":{"F6":"draft","F7":{"insert":"inserted"},"F8":{"focus":"review_input"},"F9":{"copy":"copy me","label":"fixture text"},"Ctrl+r":{"submit":"Run the tests"},"Alt+x":{"command":"counter:reset","args":"now"},"Alt+y":{"command":"reset"}}
    }))
    .unwrap();
    assert_eq!(view.sidebar_side, codex_omd::ModSidebarSide::Left);
    assert_eq!(
        view.theme.success,
        Some(codex_omd::ModColor::Rgb(0, 255, 0))
    );
    assert_eq!(
        view.keybindings["Alt+x"],
        codex_omd::ModKeyAction::Command {
            command: "counter:reset".into(),
            args: "now".into()
        }
    );
    assert_eq!(
        serde_json::to_value(&view.theme).unwrap()["user_message_background"],
        json!("#202830")
    );
    assert!(
        codex_omd::ModViewPatch::parse(
            json!({"sites":{"sidebar":{"mode":"wrap","components":[]}}})
        )
        .is_err()
    );
    assert!(
        codex_omd::ModViewPatch::parse(
            json!({"sites":{"sidebar":{"mode":"wrap","components":[{"type":"slot"}]}}})
        )
        .is_ok()
    );
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("mod-view.json");
    let mut snapshot = codex_omd::ModViewSnapshot {
        epoch: 7,
        view,
        owner: Some("terminal".into()),
        progress: Some(codex_omd::ModPanel {
            title: "Echo".into(),
            lines: vec!["halfway".into()],
        }),
        activity: vec![codex_omd::ModActivity {
            sequence: 1,
            mod_id: "fixture".into(),
            tool: "mod_fixture_echo".into(),
            label: "Echo".into(),
            status: "completed".into(),
        }],
        diagnostics: vec!["keybinding dropped".into()],
        ..Default::default()
    };
    std::fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    assert_eq!(codex_omd::ModViewSnapshot::read(&path).unwrap(), snapshot);
    snapshot.activity[0].label = "bad\u{1b}".into();
    std::fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    assert!(codex_omd::ModViewSnapshot::read(&path).is_err());
}

#[test]
fn terminal_components_compose_in_dependency_order_and_observers_contribute_status() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    let workspace = packaged(
        &root,
        "workspace",
        "workspace",
        "export default api => api.replace('terminal',()=>({title:'Workspace',sites:{sidebar:{components:[{type:'text',id:'base_text',label:'Base text',text:'base'}]}},status:['workspace'],keybindings:{F8:{focus:'base_text'}}}))",
        &["terminal"],
        &[],
    );
    trust(&store, &workspace, &["terminal"]);
    let focus = packaged(
        &root,
        "focus",
        "focus",
        "export default api => api.on('terminal',()=>({sites:{sidebar:{mode:'wrap',components:[{type:'box',id:'focus_box',label:'Focus box',children:[{type:'text',id:'focus_text',label:'Focus text',text:'focus'},{type:'slot'}]}]}},completed_tools:'compact',status:['focus'],keybindings:{F9:{command:'focus:toggle'}}}))",
        &["terminal"],
        &["workspace"],
    );
    trust(&store, &focus, &["terminal"]);
    let theme = packaged(
        &root,
        "theme",
        "theme",
        "export default api => api.on('terminal',()=>({theme:{accent:'#7dd3fc',border:'rounded',density:'compact',icons:'ascii'},status:['theme'],keybindings:{F10:{copy:'palette',label:'palette'}}}))",
        &["terminal"],
        &["workspace"],
    );
    trust(&store, &theme, &["terminal"]);
    let mut runtime = host(&temp);
    let terminal = runtime.terminal_view(json!({"event":"draw","checkpoint":null}), || true);
    assert_eq!(
        terminal.owner.as_deref(),
        Some("workspace"),
        "{}",
        runtime.status()
    );
    assert_eq!(terminal.contributors, vec!["focus", "theme"]);
    assert!(
        terminal.diagnostics.is_empty(),
        "{:?}",
        terminal.diagnostics
    );
    assert_eq!(terminal.view.status, vec!["workspace", "focus", "theme"]);
    assert_eq!(
        terminal.view.completed_tools,
        codex_omd::ModCompletedTools::Compact
    );
    assert_eq!(terminal.view.theme.border, codex_omd::ModBorder::Rounded);
    let sidebar = serde_json::to_value(&terminal.view.sites["sidebar"]).unwrap();
    assert_eq!(sidebar["components"][0]["id"], "focus_box");
    assert_eq!(sidebar["components"][0]["children"][1]["id"], "base_text");

    let observer = package(
        &root,
        "observer",
        "export default api => api.on('terminal',()=>({status:['observer']}))",
        &["terminal"],
    );
    trust(&store, &observer, &["terminal"]);
    runtime.reload().unwrap();
    let terminal = runtime.terminal_view(json!({"event":"draw","checkpoint":null}), || true);
    assert!(
        terminal.diagnostics.is_empty(),
        "{:?}",
        terminal.diagnostics
    );
    assert!(terminal.contributors.contains(&"observer".to_owned()));
    assert!(terminal.view.status.contains(&"observer".to_owned()));
}

#[test]
fn a_failed_terminal_patch_is_transactional() {
    let mut view = codex_omd::ModView::parse(json!({"title":"Base","sites":{"sidebar":{"components":[{"type":"text","id":"base","label":"Base","text":"base"}]}}})).unwrap();
    let first = codex_omd::ModViewPatch::parse(json!({"title":"First","sites":{"sidebar":{"components":[{"type":"text","id":"first","label":"First","text":"first"}]}}})).unwrap();
    let second = codex_omd::ModViewPatch::parse(json!({"title":"Leaked","sites":{"sidebar":{"components":[{"type":"text","id":"second","label":"Second","text":"second"}]}}})).unwrap();
    let mut sites = std::collections::BTreeSet::new();
    let mut completed_tools = false;
    first
        .apply(&mut view, &mut sites, &mut completed_tools)
        .unwrap();
    assert!(
        second
            .apply(&mut view, &mut sites, &mut completed_tools)
            .is_err()
    );
    assert_eq!(view.title.as_deref(), Some("First"));
    assert_eq!(
        serde_json::to_value(&view.sites["sidebar"]).unwrap()["components"][0]["id"],
        "first"
    );
}

#[test]
fn command_outcomes_and_input_decisions_are_validated() {
    use codex_omd::ModCommandOutcome;
    use codex_omd::ModInputDecision;
    assert_eq!(
        ModCommandOutcome::parse(&json!({"display":"shown","submit":"send this"})).unwrap(),
        ModCommandOutcome {
            display: Some("shown".into()),
            insert: None,
            submit: Some("send this".into())
        }
    );
    assert_eq!(
        ModCommandOutcome::parse(&json!("plain")).unwrap().display,
        Some("plain".into())
    );
    assert_eq!(
        ModCommandOutcome::parse(&json!({"count":2}))
            .unwrap()
            .display,
        Some("{\n  \"count\": 2\n}".into())
    );
    assert_eq!(
        ModCommandOutcome::parse(&Value::Null).unwrap(),
        ModCommandOutcome::default()
    );
    for invalid in [
        json!({"insert":"a","submit":"b"}),
        json!({"submit":""}),
        json!({"submit":"\u{1b}[2J"}),
        json!({"display":7}),
    ] {
        assert!(ModCommandOutcome::parse(&invalid).is_err(), "{invalid}");
    }
    assert_eq!(
        ModInputDecision::parse(&Value::Null).unwrap(),
        ModInputDecision::Keep
    );
    assert_eq!(
        ModInputDecision::parse(&json!({"text":"rewritten"})).unwrap(),
        ModInputDecision::Rewrite("rewritten".into())
    );
    assert_eq!(
        ModInputDecision::parse(&json!({"deny":"blocked"})).unwrap(),
        ModInputDecision::Deny("blocked".into())
    );
    for invalid in [
        json!({"text":"a","deny":"b"}),
        json!("text"),
        json!({"text":""}),
        json!({"deny":"x".repeat(513)}),
    ] {
        assert!(ModInputDecision::parse(&invalid).is_err(), "{invalid}");
    }
}

#[test]
fn typed_services_are_host_routed_versioned_and_generate_installed_types() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    let contract = json!({"name":"example.echo","version":"1.1.0",
        "methods":{"echo":{"input":"string","output":"string"}}});
    let provider = service_package(
        &root,
        "provider",
        "export default api => api.provide({name:'example.echo',version:'1.1.0',methods:{echo:{input:'string',output:'string'}}},{echo:value=>'provider:'+value})",
        json!({"exports":[contract]}),
        &["services"],
    );
    let consumer = service_package(
        &root,
        "consumer",
        "export default api => api.command('call',()=>api.services.call('example.echo','echo','hello'))",
        json!({"imports":[{"name":"example.echo","version":"^1.0.0"}]}),
        &["commands", "services"],
    );
    trust(&store, &provider, &["services"]);
    trust(&store, &consumer, &["commands", "services"]);
    let mut runtime = host(&temp);
    assert_eq!(runtime.status()["order"], json!(["provider", "consumer"]));
    assert_eq!(
        runtime
            .invoke(
                "consumer",
                runtime.generation(),
                "command",
                "call",
                Value::Null,
            )
            .unwrap(),
        json!("provider:hello")
    );
    let types = std::fs::read_to_string(root.join("store/installed-contracts.d.ts")).unwrap();
    assert!(types.contains("InstalledContractTypesVersion = 1"));
    assert!(types.contains("InstalledHostRelease = '0.1.0'"));
    assert!(types.contains("'example.echo@1.1.0'"));
    assert!(types.contains("echo(input: string): string"));
    assert_eq!(runtime.status()["service_calls"][0]["provider"], "provider");
}

#[test]
fn service_host_operations_keep_provider_identity_and_grants() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    let contract = json!({"name":"example.owned","version":"1.0.0",
        "methods":{"read":{"input":"null","output":"object"}}});
    let provider = service_package(
        &root,
        "provider",
        "export default api => api.provide({name:'example.owned',version:'1.0.0',methods:{read:{input:'null',output:'object'}}},{read:()=>api.host.call('store.get',{key:'owned'})})",
        json!({"exports":[contract]}),
        &["services", "store"],
    );
    let consumer = service_package(
        &root,
        "consumer",
        "export default api => api.command('read',()=>api.services.call('example.owned','read',null))",
        json!({"imports":[{"name":"example.owned","version":"1.0.0"}]}),
        &["commands", "services"],
    );
    for source in [&provider, &consumer] {
        let path = source.join("mod.json");
        let mut manifest: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        manifest["api"] = json!(MOD_API_VERSION);
        std::fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    }
    trust(&store, &provider, &["services", "store"]);
    trust(&store, &consumer, &["commands", "services"]);
    let mut runtime = host(&temp);
    let mut observed = Vec::new();
    let result = runtime
        .invoke_scoped_with(
            "consumer",
            runtime.generation(),
            "command",
            "read",
            Value::Null,
            || true,
            |caller, call| {
                observed.push(caller.to_owned());
                assert_eq!(call.operation, "store.get");
                assert_eq!(call.arguments, json!({"key":"owned"}));
                Ok(json!({"value":"provider-owned"}))
            },
        )
        .unwrap();
    assert_eq!(result, json!({"value":"provider-owned"}));
    assert_eq!(observed, ["provider"]);
    assert_eq!(runtime.status()["service_calls"][0]["provider"], "provider");
    let active = std::cell::Cell::new(true);
    let cancelled = runtime
        .invoke_scoped_with(
            "consumer",
            runtime.generation(),
            "command",
            "read",
            Value::Null,
            || active.get(),
            |caller, _| {
                assert_eq!(caller, "provider");
                active.set(false);
                Ok(json!({"value":"cancelled"}))
            },
        )
        .unwrap_err();
    assert!(
        cancelled.to_string().contains("callback_cancelled"),
        "{cancelled}"
    );
    assert_eq!(error_of(&runtime, "provider"), "");
}

#[test]
fn missing_incompatible_optional_cyclic_and_colliding_services_fail_independently() {
    let contract = |name: &str, version: &str| json!({"name":name,"version":version,"methods":{"call":{"input":"null","output":"null"}}});
    let source = |name: &str, version: &str| {
        format!(
            "export default api => api.provide({{name:'{name}',version:'{version}',methods:{{call:{{input:'null',output:'null'}}}}}},{{call:()=>null}})"
        )
    };
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    let first = service_package(
        &root,
        "first",
        &source("shared.service", "1.0.0"),
        json!({"exports":[contract("shared.service","1.0.0")]}),
        &["services"],
    );
    let second = service_package(
        &root,
        "second",
        &source("shared.service", "1.0.0"),
        json!({"exports":[contract("shared.service","1.0.0")]}),
        &["services"],
    );
    let missing = service_package(
        &root,
        "missing",
        "export default api => {}",
        json!({"imports":[{"name":"absent.service","version":"1.0.0"}]}),
        &["services"],
    );
    let optional = service_package(
        &root,
        "optional",
        "export default api => api.command('probe',()=>{try{return api.services.call('optional.service','call',null)}catch(error){if(error instanceof Error)return String(error);throw error}})",
        json!({"imports":[{"name":"optional.service","version":"1.0.0","optional":true}]}),
        &["commands", "services"],
    );
    let versioned = service_package(
        &root,
        "versioned",
        &source("versioned.service", "1.0.0"),
        json!({"exports":[contract("versioned.service","1.0.0")]}),
        &["services"],
    );
    let incompatible = service_package(
        &root,
        "incompatible",
        "export default api => {}",
        json!({"imports":[{"name":"versioned.service","version":"2.0.0"}]}),
        &["services"],
    );
    trust(&store, &first, &["services"]);
    trust(&store, &second, &["services"]);
    trust(&store, &missing, &["services"]);
    trust(&store, &optional, &["commands", "services"]);
    trust(&store, &versioned, &["services"]);
    trust(&store, &incompatible, &["services"]);
    let runtime = host(&temp);
    let status = runtime.status();
    let errors = status["mods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| (entry["id"].as_str().unwrap(), entry["error"].as_str()))
        .collect::<std::collections::BTreeMap<_, _>>();
    assert!(
        errors["first"]
            .unwrap()
            .contains("service_provider_collision")
    );
    assert!(
        errors["second"]
            .unwrap()
            .contains("service_provider_collision")
    );
    assert!(
        errors["missing"]
            .unwrap()
            .contains("service_provider_missing")
    );
    assert_eq!(errors["optional"], None);
    assert!(
        errors["incompatible"]
            .unwrap()
            .contains("service_version_incompatible")
    );
    let mut runtime = runtime;
    assert!(
        runtime
            .invoke(
                "optional",
                runtime.generation(),
                "command",
                "probe",
                Value::Null,
            )
            .unwrap()
            .as_str()
            .unwrap()
            .contains("optional_service_unavailable")
    );

    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    let a = service_package(
        &root,
        "a",
        &source("cycle.a", "1.0.0"),
        json!({"exports":[contract("cycle.a","1.0.0")],"imports":[{"name":"cycle.b","version":"1.0.0"}]}),
        &["services"],
    );
    let b = service_package(
        &root,
        "b",
        &source("cycle.b", "1.0.0"),
        json!({"exports":[contract("cycle.b","1.0.0")],"imports":[{"name":"cycle.a","version":"1.0.0"}]}),
        &["services"],
    );
    trust(&store, &a, &["services"]);
    trust(&store, &b, &["services"]);
    let status = host(&temp).status();
    assert!(status["mods"].as_array().unwrap().iter().all(|entry| {
        entry["error"]
            .as_str()
            .is_some_and(|error| error.contains("dependency_cycle"))
    }));
    let own = service_package(
        &root,
        "own",
        &source("own.service", "1.0.0"),
        json!({"exports":[contract("own.service","1.0.0")],"imports":[{"name":"own.service","version":"1.0.0"}]}),
        &["services"],
    );
    assert!(
        ModStore::inspect_package(&own)
            .unwrap_err()
            .to_string()
            .contains("service_self_import")
    );
}

#[test]
fn request_and_stream_middleware_preserve_authority_and_provenance() {
    let source = "export default api => { api.middleware('model_request',()=>({route:'astra'})); api.middleware('response_stream',event=>event.protected?null:{text:String(event.text).toUpperCase()}); api.middleware('tool_result',()=>({forged:true})); }";
    let (temp, _, _) = fixture(source, &["middleware"]);
    let mut runtime = host(&temp);
    let routed = runtime
        .model_request(
            json!({"request_id":"r1","scope":{"kind":"main"},
                "routes":[{"name":"sol","model":"s","provider":"openai","reasoning":"medium"},{"name":"astra","model":"a","provider":"openai","reasoning":"high"}],
                "original":{"name":"sol","model":"s","provider":"openai","reasoning":"medium"},
                "effective":{"name":"sol","model":"s","provider":"openai","reasoning":"medium"},"provenance":[]}),
            || true,
        )
        .unwrap();
    assert_eq!(routed["effective"]["name"], "astra", "{}", runtime.status());
    assert_eq!(routed["provenance"][0]["tier"], "user");
    let stream = runtime
        .response_stream(
            json!({"kind":"response.output_text.delta","raw_sha256":"00","raw_usage":null,
                "opaque_reasoning":false,"protected":false,"text":"hello"}),
            || true,
        )
        .unwrap();
    assert_eq!(stream["original"], "hello");
    assert_eq!(stream["effective"], "HELLO");
    let tool = runtime.event(
        "tool_result",
        json!({"call_id":"c","tool":"x","outcome":"ok"}),
    );
    assert!(
        tool[0]
            .1
            .as_ref()
            .unwrap_err()
            .to_string()
            .contains("observe_only")
    );
}

#[test]
fn task_scoped_tools_follow_owned_step_selection_and_fail_closed() {
    let source = r#"export default api => {
      const parameters = {type:'object',properties:{}};
      api.tool({name:'always',description:'Always available',parameters},()=>true);
      api.tool({name:'inspect',description:'Inspect this task',parameters,task_scoped:true},()=>true);
      api.on('tool_exposure',event=>({enable:event.ledger?.kind==='inspect'?['inspect']:[]}));
    }"#;
    let (temp, _, _) = fixture(source, &["tools"]);
    let mut runtime = host(&temp);
    let hidden = runtime.tools_for_step(Some("thread".into()), json!({"kind":"edit"}), || true);
    assert_eq!(
        hidden
            .iter()
            .map(|(_, _, tool)| tool.name.as_str())
            .collect::<Vec<_>>(),
        ["always"],
        "{}",
        runtime.status()
    );
    let shown = runtime.tools_for_step(Some("thread".into()), json!({"kind":"inspect"}), || true);
    assert_eq!(
        shown
            .iter()
            .map(|(_, _, tool)| tool.name.as_str())
            .collect::<Vec<_>>(),
        ["always", "inspect"]
    );
    assert!(runtime.status()["mods"][0]["error"].is_null());

    let invalid = source.replace("['inspect']:[]", "['always']:[]");
    let (temp, _, _) = fixture(&invalid, &["tools"]);
    let mut runtime = host(&temp);
    assert!(
        runtime
            .tools_for_step(None, json!({"kind":"inspect"}), || true)
            .is_empty()
    );
    assert!(
        runtime.status()["mods"][0]["error"]
            .as_str()
            .unwrap()
            .contains("invalid_tool_exposure")
    );
}

#[test]
fn task_scoped_tool_decisions_cannot_select_another_mod_or_hide_unscoped_tools() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    let parameters = "{type:'object',properties:{}}";
    let first = package(
        &root,
        "first",
        &format!(
            "export default api => {{ api.tool({{name:'one',description:'One',parameters:{parameters},task_scoped:true}},()=>1); api.on('tool_exposure',()=>({{enable:['one']}})); }}"
        ),
        &["tools"],
    );
    let second = package(
        &root,
        "second",
        &format!(
            "export default api => {{ api.tool({{name:'two',description:'Two',parameters:{parameters},task_scoped:true}},()=>2); api.on('tool_exposure',()=>({{enable:['one']}})); }}"
        ),
        &["tools"],
    );
    let old = package(
        &root,
        "old",
        &format!(
            "export default api => api.tool({{name:'legacy',description:'Legacy',parameters:{parameters}}},()=>3)"
        ),
        &["tools"],
    );
    for path in [&first, &second, &old] {
        trust(&store, path, &["tools"]);
    }
    let mut runtime = host(&temp);
    let tools = runtime.tools_for_step(None, Value::Null, || true);
    assert_eq!(
        tools
            .iter()
            .map(|(id, _, tool)| format!("{id}:{}", tool.name))
            .collect::<Vec<_>>(),
        ["first:one", "old:legacy"]
    );
    assert!(
        runtime.status()["mods"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == "second"
                && entry["error"]
                    .as_str()
                    .unwrap_or("")
                    .contains("invalid_tool_exposure"))
    );
}

#[test]
fn source_use_rejects_undeclared_authority_and_reports_unused_grants() {
    let (temp, _, _) = fixture(
        "export default api => api.command('status',()=>api.host.call('task.status',null))",
        &["commands"],
    );
    assert!(activation_error(&temp, "fixture").contains("undeclared_operation_use"));
    let (temp, _, _) = fixture(
        "export default api => api.command('idle',()=>null)",
        &["commands", "agents"],
    );
    let status = host(&temp).status();
    assert_eq!(status["mods"][0]["unused_grants"], json!(["agents"]));
    let policies = &status["field_policies"];
    assert_eq!(policies["response_stream"]["raw_usage"], "observe_only");
    assert_eq!(policies["model_request"]["effective"], "alterable");
    assert_eq!(policies["tool_before"]["arguments"], "replaceable");
}

#[test]
fn input_rewrite_requires_exclusive_replacement_while_observers_may_deny() {
    let (temp, _, _) = fixture(
        "export default api => api.on('input', ({text}) => ({text: text + ' rewritten'}))",
        &["input"],
    );
    let mut runtime = host(&temp);
    let results = runtime.event("input", json!({"text":"hello","attachments":0}));
    assert!(
        results[0]
            .1
            .as_ref()
            .unwrap_err()
            .to_string()
            .contains("exclusive_replacement_registration_required")
    );
    let (temp, _, _) = fixture(
        "export default api => api.replace('input', ({text}) => text.includes('secret') ? {deny:'contains secret'} : {text: text.toUpperCase()})",
        &["input"],
    );
    let mut runtime = host(&temp);
    assert_eq!(
        *runtime.event("input", json!({"text":"hello","attachments":0}))[0]
            .1
            .as_ref()
            .unwrap(),
        json!({"text":"HELLO"})
    );
    assert_eq!(
        *runtime.event("input", json!({"text":"a secret","attachments":0}))[0]
            .1
            .as_ref()
            .unwrap(),
        json!({"deny":"contains secret"})
    );
    let (temp, _, _) = fixture(
        "export default api => api.on('input', () => ({deny:'observer denial'}))",
        &["input"],
    );
    let mut runtime = host(&temp);
    assert_eq!(
        *runtime.event("input", json!({"text":"x","attachments":0}))[0]
            .1
            .as_ref()
            .unwrap(),
        json!({"deny":"observer denial"})
    );
    let (temp, _, _) = fixture(
        "export default api => api.on('input', () => null)",
        &["lifecycle"],
    );
    assert!(activation_error(&temp, "fixture").contains("capability_denied: input"));
}

#[test]
fn command_descriptions_tool_labels_and_lifecycle_events_register() {
    let source = "export default api => { api.command('reset', () => null, {description:'Reset the counter'}); api.command('plain', () => null); api.tool({name:'echo',label:'Echo text',description:'Echo',parameters:{type:'object',properties:{}}}, () => null); for (const e of ['turn_start','turn_end','compaction_start','compaction_end','agent_end']) api.on(e, () => null); }";
    let (temp, _, _) = fixture(source, &["commands", "tools", "lifecycle"]);
    let runtime = host(&temp);
    let commands = runtime.commands();
    assert_eq!(commands.len(), 2);
    let description = |name: &str| {
        commands
            .iter()
            .find(|(_, command)| command.name == name)
            .map(|(_, command)| command.description.clone())
            .unwrap()
    };
    assert_eq!(description("reset").as_deref(), Some("Reset the counter"));
    assert_eq!(description("plain"), None);
    assert_eq!(runtime.tools()[0].2.label.as_deref(), Some("Echo text"));
    for event in [
        "turn_start",
        "turn_end",
        "compaction_start",
        "compaction_end",
        "agent_end",
    ] {
        assert!(runtime.registered("fixture", event), "{event}");
    }
    for (source, capabilities) in [
        (
            "export default api => api.command('reset', () => null, {description:'bad\\u0007'})",
            &["commands"][..],
        ),
        (
            "export default api => api.tool({name:'echo',label:'x'.repeat(65),description:'Echo',parameters:{type:'object',properties:{}}}, () => null)",
            &["tools"][..],
        ),
    ] {
        let (temp, _, _) = fixture(source, capabilities);
        assert!(
            activation_error(&temp, "fixture").contains("invalid"),
            "{source}"
        );
    }
    let (temp, _, _) = fixture(
        "export default api => api.on('turn_start', () => null)",
        &["commands"],
    );
    assert!(activation_error(&temp, "fixture").contains("capability_denied"));
}

#[test]
fn tool_progress_is_forwarded_once_across_host_call_replay() {
    let source = "export default api => { api.tool({name:'work',description:'Work',parameters:{type:'object',properties:{}}}, () => { api.progress('started'); const status = api.host.call('task.status', null); api.progress('finished'); return status; }); api.command('bad', () => api.progress('nope')); }";
    let (temp, _, _) = fixture(source, &["tools", "commands", "agents"]);
    let mut runtime = host(&temp);
    let generation = runtime.generation();
    let mut updates = Vec::new();
    let value = runtime
        .invoke_streaming(
            "fixture",
            generation,
            "tool",
            "work",
            json!({}),
            || true,
            |_| Ok(json!({"ok":true})),
            |update| updates.push(update),
        )
        .unwrap();
    assert_eq!(value, json!({"ok":true}));
    assert_eq!(updates, vec!["started".to_string(), "finished".to_string()]);
    assert!(
        runtime
            .invoke("fixture", generation, "command", "bad", Value::Null)
            .unwrap_err()
            .to_string()
            .contains("progress_outside_tool")
    );
}

#[test]
fn host_call_replay_is_not_charged_against_the_per_evaluation_hook_budget() {
    let source = "export default api => api.tool({name:'work',description:'Work',parameters:{type:'object',properties:{}}}, () => { let seen = 0; for (let index = 0; index < 16; index += 1) { api.host.call('task.status', null); seen += 1; } return seen; })";
    let (temp, _, path) = fixture(source, &["tools", "agents"]);
    let manifest = path.join("mod.json");
    let mut package: Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    package["hook_budget_ms"] = json!(250);
    std::fs::write(&manifest, serde_json::to_vec_pretty(&package).unwrap()).unwrap();
    trust(
        &ModStore::open(temp.path().canonicalize().unwrap().join("store")).unwrap(),
        &path,
        &["tools", "agents"],
    );
    let mut runtime = host(&temp);
    let generation = runtime.generation();
    let started = std::time::Instant::now();
    let value = runtime
        .invoke_with(
            "fixture",
            generation,
            "tool",
            "work",
            json!({}),
            || true,
            |_| Ok(json!({"status": "active"})),
        )
        .unwrap();
    assert_eq!(value, json!(16));
    assert!(
        started.elapsed()
            < std::time::Duration::from_millis(codex_omd::MOD_CALLBACK_TOTAL_BUDGET_MS)
    );
}

#[test]
fn native_discovery_prefers_project_packages_without_trust() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let user = root.join("user");
    let project = root.join("project");
    std::fs::create_dir_all(&user).unwrap();
    std::fs::create_dir_all(&project).unwrap();
    package(&user, "shared", "export default () => {}", &[]);
    package(&project, "shared", "export default () => {}", &[]);
    let catalog = ModStore::discover(&user, &project).unwrap();
    assert_eq!(catalog["packages"].as_array().unwrap().len(), 1);
    assert_eq!(catalog["packages"][0]["scope"], json!("project"));
    assert_eq!(catalog["packages"][0]["trusted"], json!(false));
}

#[test]
fn disabling_during_native_work_preserves_inflight_source_and_revokes_next_generation() {
    let (temp, store, path) = fixture(
        "export default api => api.command('run', () => api.host.call('task.status',null))",
        &["commands", "agents"],
    );
    let mut runtime = host(&temp);
    let generation = runtime.generation();
    let result = runtime
        .invoke_with(
            "fixture",
            generation,
            "command",
            "run",
            Value::Null,
            || true,
            |_| {
                store.enable(&path, false)?;
                Ok(json!({"completed":true}))
            },
        )
        .unwrap();
    assert_eq!(result, json!({"completed":true}));
    runtime.turn_boundary();
    assert!(
        runtime
            .invoke("fixture", generation, "command", "run", Value::Null)
            .unwrap_err()
            .to_string()
            .contains("stale_mod_generation")
    );
    assert!(runtime.status()["mods"].as_array().unwrap().is_empty());
}

#[test]
fn native_schema_validation_applies_to_reload_before_activation() {
    let source = "export default api => api.tool({name:'probe',description:'probe',parameters:{type:'object',properties:{}}},()=>null)";
    let (temp, store, path) = fixture(source, &["tools"]);
    let mut runtime = ModHost::open_validated(
        temp.path().canonicalize().unwrap().join("store"),
        |schema| {
            if schema["properties"].get("invalid").is_some() {
                Err(std::io::Error::other("native_schema_rejected"))
            } else {
                Ok(())
            }
        },
    )
    .unwrap();
    let generation = runtime.generation();
    std::fs::write(
        path.join("index.ts"),
        source.replace("properties:{}", "properties:{invalid:{type:'null'}}"),
    )
    .unwrap();
    trust(&store, &path, &["tools"]);
    runtime.turn_boundary();
    assert_eq!(runtime.generation(), generation);
    assert!(
        runtime.status()["reload_error"]
            .as_str()
            .unwrap()
            .contains("native_schema_rejected")
    );
    assert_eq!(runtime.tools().len(), 1);
}

const CONTRACT: &str = r#"export default api => api.contract({ schema: 2, id: 'paired_review', version: 1, description: 'Review', assurance: 'fixture-checked', gates: {} })"#;

#[test]
fn a_mod_registers_a_current_contract_document_with_package_provenance() {
    let (temp, _, path) = fixture(CONTRACT, &["contracts"]);
    let runtime = host(&temp);
    let contracts = runtime.contract_documents();
    assert_eq!(contracts.len(), 1);
    let (contract, owner) = &contracts[0];
    assert_eq!(contract.id, "paired_review");
    assert_eq!(contract.schema, 2);
    assert_eq!(owner.id, "fixture");
    assert_eq!(owner.source, path.display().to_string());
}

#[test]
fn a_contract_registration_requires_the_current_capability() {
    let (temp, _, _) = fixture(CONTRACT, &[]);
    assert!(activation_error(&temp, "fixture").contains("capability_denied"));
}

#[test]
fn two_mods_may_not_own_the_same_contract_document() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    for id in ["first", "second"] {
        let path = package(&root, id, CONTRACT, &["contracts"]);
        trust(&store, &path, &["contracts"]);
    }
    let runtime = ModHost::open(root.join("store")).unwrap();
    let status = runtime.status();
    for id in ["first", "second"] {
        let error = status["mods"]
            .as_array()
            .unwrap()
            .iter()
            .find(|mod_status| mod_status["id"] == id)
            .unwrap()["error"]
            .as_str()
            .unwrap_or_default();
        assert!(error.contains("contract_conflict"), "{id}: {error}");
    }
    assert!(runtime.contract_documents().is_empty());
}

#[test]
fn a_mod_that_throws_while_activating_is_disabled_with_a_source_located_error() {
    let (temp, store, broken_path) = fixture(
        "export default api => { throw new Error('ACTIVATION_SENTINEL') }",
        &["context"],
    );
    let root = temp.path().canonicalize().unwrap();
    let healthy = package(
        &root,
        "healthy",
        "export default api => api.on('context', () => ({text:'hello'}))",
        &["context"],
    );
    trust(&store, &healthy, &["context"]);
    let mut runtime = host(&temp);
    let status = runtime.status();
    let broken = status["mods"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "fixture")
        .unwrap();
    let error = broken["error"].as_str().unwrap();
    assert!(error.contains("ACTIVATION_SENTINEL"), "{error}");
    assert!(error.contains("index.ts:2:"), "{error}");
    let results = runtime.event("context", Value::Null);
    assert_eq!(results.len(), 1);
    assert_eq!(*results[0].1.as_ref().unwrap(), json!({"text":"hello"}));
    let selections = store.selection_status().unwrap();
    assert_eq!(selections["selections"][0]["id"], "fixture");
    store.enable(&broken_path, false).unwrap();
    let recovered = host(&temp);
    assert!(
        recovered.status()["mods"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["id"] != "fixture")
    );
}

#[test]
fn an_incompatible_package_names_the_host_and_package_api_versions() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let path = root.join("stale");
    std::fs::create_dir(&path).unwrap();
    std::fs::write(
        path.join("mod.json"),
        serde_json::to_vec(&json!({"schema":1,"id":"stale","version":"1.0.0",
        "api":"0.1.0-experimental.1","state_version":1,"capabilities":[]}))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(path.join("index.ts"), "export default () => {}").unwrap();
    let error = ModStore::inspect_package(&path).unwrap_err().to_string();
    assert!(error.contains(MOD_API_VERSION), "{error}");
    assert!(error.contains("0.1.0-experimental.1"), "{error}");
}

fn error_of(runtime: &ModHost, id: &str) -> String {
    runtime.status()["mods"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == id)
        .and_then(|m| m["error"].as_str())
        .unwrap_or_default()
        .to_string()
}

fn context_mod(id: &str) -> String {
    format!("export default api => api.on('context', () => ({{text:'{id}'}}))")
}

fn composed(temp: &TempDir, packages: &[(&str, &[&str])]) -> ModStore {
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    for (id, requires) in packages {
        let path = packaged(&root, id, id, &context_mod(id), &["context"], requires);
        trust(&store, &path, &["context"]);
    }
    store
}

#[test]
fn composition_order_is_declared_dependencies_first_then_mod_id() {
    let temp = TempDir::new().unwrap();
    composed(
        &temp,
        &[("alpha", &["gamma"]), ("beta", &[]), ("gamma", &[])],
    );
    let mut runtime = host(&temp);
    assert_eq!(
        runtime.status()["order"],
        json!(["beta", "gamma", "alpha"]),
        "{}",
        runtime.status()
    );
    let observed: Vec<String> = runtime
        .event(
            "context",
            json!({"thread_id":"t","turn_id":"u","checkpoint":null}),
        )
        .into_iter()
        .map(|(id, result)| {
            assert!(result.is_ok(), "{id}: {result:?}");
            id
        })
        .collect();
    assert_eq!(observed, ["beta", "gamma", "alpha"]);
}

#[test]
fn a_dependency_cycle_is_rejected_before_activation_and_isolated() {
    let temp = TempDir::new().unwrap();
    composed(
        &temp,
        &[("alpha", &["beta"]), ("beta", &["alpha"]), ("healthy", &[])],
    );
    let runtime = host(&temp);
    for id in ["alpha", "beta"] {
        assert!(
            error_of(&runtime, id).contains("dependency_cycle: alpha -> beta"),
            "{id}: {}",
            error_of(&runtime, id)
        );
    }
    assert_eq!(runtime.status()["order"], json!(["healthy"]));
}

#[test]
fn an_unavailable_dependency_disables_only_the_dependent_chain() {
    let temp = TempDir::new().unwrap();
    composed(
        &temp,
        &[
            ("alpha", &["absent"]),
            ("beta", &["alpha"]),
            ("healthy", &[]),
        ],
    );
    let runtime = host(&temp);
    assert!(error_of(&runtime, "alpha").contains("dependency_unavailable: alpha requires absent"));
    assert!(error_of(&runtime, "beta").contains("dependency_unavailable: beta requires alpha"));
    assert_eq!(runtime.status()["order"], json!(["healthy"]));
}

#[test]
fn project_scope_takes_precedence_over_user_scope_without_sharing_state() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    let counter = "export default api => api.command('count', () => { api.state.set(Number(api.state.get() ?? 0)+1); return api.state.get(); })";
    let user = packaged(
        &root,
        "user-copy",
        "shared",
        counter,
        &["commands", "store"],
        &[],
    );
    let project = packaged(
        &root,
        "project-copy",
        "shared",
        &format!("{counter};\n"),
        &["commands", "store"],
        &[],
    );
    trust_scoped(&store, &user, &["commands", "store"], "user");
    trust_scoped(&store, &project, &["commands", "store"], "project");
    let mut runtime = host(&temp);
    let status = runtime.status();
    assert_eq!(status["order"], json!(["shared"]));
    assert_eq!(status["mods"][0]["scope"], "project");
    assert_eq!(status["rejected"][0]["id"], "shared");
    assert_eq!(status["rejected"][0]["scope"], "user");
    assert_eq!(status["rejected"][0]["path"], json!(user));
    assert!(
        status["rejected"][0]["reason"]
            .as_str()
            .unwrap()
            .starts_with("shadowed_by_project_scope"),
        "{status}"
    );
    let generation = runtime.generation();
    runtime
        .invoke("shared", generation, "command", "count", Value::Null)
        .unwrap();
    let store_root = root.join("store");
    assert!(store_root.join("state-shared.project.json").exists());
    assert!(!store_root.join("state-shared.json").exists());
}

#[test]
fn two_selections_of_one_id_in_the_same_scope_both_fail_closed() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    for directory in ["first-copy", "second-copy"] {
        let path = packaged(
            &root,
            directory,
            "shared",
            &format!("export default api => api.on('context', () => ({{text:'{directory}'}}))"),
            &["context"],
            &[],
        );
        trust(&store, &path, &["context"]);
    }
    let healthy = packaged(
        &root,
        "healthy",
        "healthy",
        &context_mod("healthy"),
        &["context"],
        &[],
    );
    trust(&store, &healthy, &["context"]);
    let runtime = host(&temp);
    assert_eq!(runtime.status()["order"], json!(["healthy"]));
    let rejected = runtime.status()["rejected"].clone();
    assert_eq!(rejected.as_array().unwrap().len(), 2, "{rejected}");
    for entry in rejected.as_array().unwrap() {
        assert!(
            entry["reason"]
                .as_str()
                .unwrap()
                .contains("mod_conflict: shared is enabled twice in the user scope"),
            "{entry}"
        );
    }
}

#[test]
fn contested_exclusive_replacement_disables_every_claimant_and_keeps_the_rest() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    for id in ["first", "second"] {
        let path = packaged(
            &root,
            id,
            id,
            &format!("export default api => api.replace('terminal', () => ({{title:'{id}'}}))"),
            &["terminal"],
            &[],
        );
        trust(&store, &path, &["terminal"]);
    }
    let healthy = packaged(
        &root,
        "healthy",
        "healthy",
        &context_mod("healthy"),
        &["context"],
        &[],
    );
    trust(&store, &healthy, &["context"]);
    let runtime = host(&temp);
    for id in ["first", "second"] {
        assert!(
            error_of(&runtime, id)
                .contains("replacement_conflict: terminal claimed by first, second"),
            "{id}: {}",
            error_of(&runtime, id)
        );
    }
    assert_eq!(runtime.status()["order"], json!(["healthy"]));
    assert_eq!(runtime.replacement_owner("terminal"), None);
}

#[test]
fn exclusive_decisions_require_a_replacement_registration_while_observers_compose() {
    let routes = json!({"routes":[{"name":"sol","model":"m","provider":"p","reasoning":"medium"}],
        "model":null,"provider":"p","reasoning":null});
    let (temp, _, _) = fixture(
        "export default api => api.on('routing', ({routes}) => routes[0].name)",
        &["model"],
    );
    let mut runtime = host(&temp);
    let error = runtime.event("routing", routes.clone())[0]
        .1
        .as_ref()
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("exclusive_replacement_registration_required"),
        "{error}"
    );

    let (temp, _, _) = fixture(
        "export default api => api.replace('routing', ({routes}) => ({route:routes[0].name}))",
        &["model"],
    );
    let mut runtime = host(&temp);
    assert_eq!(
        runtime.event("routing", routes)[0].1.as_ref().unwrap(),
        &json!({"route":"sol"})
    );
    assert_eq!(
        runtime.replacement_owner("routing").as_deref(),
        Some("fixture")
    );

    let routes = json!({"routes":[{"name":"sol","model":"m","provider":"p","reasoning":"medium"}],
        "model":null,"provider":"p","reasoning":null});
    let (temp, _, _) = fixture(
        "export default api => api.replace('routing', () => ({route:'sol'}))",
        &["model"],
    );
    let mut runtime = host(&temp);
    assert_eq!(
        runtime.event("routing", routes)[0].1.as_ref().unwrap(),
        &json!({"route":"sol"})
    );

    let (temp, _, _) = fixture(
        "export default api => api.replace('routing', () => ({preset:'unauthorized'}))",
        &["model"],
    );
    let mut runtime = host(&temp);
    assert!(
        runtime.event("routing", json!({}))[0]
            .1
            .as_ref()
            .unwrap_err()
            .to_string()
            .contains("invalid_routing_result")
    );
    assert!(runtime.status()["mods"][0]["error"].is_string());

    let temp = TempDir::new().unwrap();
    composed(&temp, &[("alpha", &[]), ("beta", &[])]);
    let mut runtime = host(&temp);
    let composed_context: Vec<Value> = runtime
        .event(
            "context",
            json!({"thread_id":"t","turn_id":"u","checkpoint":null}),
        )
        .into_iter()
        .map(|(_, result)| result.unwrap())
        .collect();
    assert_eq!(
        composed_context,
        [json!({"text":"alpha"}), json!({"text":"beta"})]
    );
    assert_eq!(runtime.replacement_owner("context"), None);
}

#[test]
fn retired_worker_context_event_is_rejected() {
    let (temp, _, _) = fixture(
        "export default api => api.on('worker_context', () => ({mode:'parent_history'}))",
        &["context"],
    );
    assert!(activation_error(&temp, "fixture").contains("unsupported_event: worker_context"));
    let (temp, _, _) = fixture(
        "export default api => api.replace('worker_context', () => ({mode:'shared_task_packet'}))",
        &["context"],
    );
    assert!(
        activation_error(&temp, "fixture")
            .contains("unsupported_replacement_point: worker_context")
    );
}

#[test]
fn author_declarations_source_maps_telemetry_and_redacted_diagnostics_are_host_owned() {
    let source = "export default api => {\n  api.command('fail', () => {\n    throw new Error('INTENTIONAL_AUTHOR_FAILURE sk- sk-authorsecret123456789');\n  });\n}";
    let (temp, _, path) = fixture(source, &["commands"]);
    let mut runtime = host(&temp);
    assert_eq!(
        runtime.status()["mods"][0]["error"],
        Value::Null,
        "{}",
        runtime.status()
    );
    let error = runtime
        .invoke(
            "fixture",
            runtime.generation(),
            "command",
            "fail",
            Value::Null,
        )
        .unwrap_err()
        .to_string();
    assert!(error.contains("INTENTIONAL_AUTHOR_FAILURE"), "{error}");
    assert!(error.contains("index.ts:3"), "{error}");
    let status = runtime.status();
    assert_eq!(status["mods"][0]["telemetry"]["invocations"], 1);
    assert_eq!(
        status["mods"][0]["telemetry"]["logs"][0]["outcome"],
        "error"
    );
    let store = temp.path().join("store");
    let host_types = std::fs::read_to_string(store.join("active-host.d.ts")).unwrap();
    assert!(host_types.contains(&format!("ActiveModApi = '{MOD_API_VERSION}'")));
    assert!(host_types.contains("'agents.spawn'"));
    assert!(store.join("installed-contracts.d.ts").is_file());
    let bundle = runtime.diagnostic_bundle();
    let encoded = serde_json::to_string(&bundle).unwrap();
    assert!(!encoded.contains(path.to_str().unwrap()), "{encoded}");
    assert!(!encoded.contains(store.to_str().unwrap()), "{encoded}");
    assert!(!encoded.contains("sk-authorsecret123456789"), "{encoded}");
    assert!(encoded.contains("$MOD/fixture"));
    assert!(
        ModHost::capability_explanation("capability_denied: task")["fix"]
            .as_str()
            .unwrap()
            .contains("exact grant")
    );
}

#[test]
fn engine_offline_runner_covers_virtual_time_mocks_services_streams_and_terminal_interaction() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    let harness = package(
        &root,
        "harness",
        "export default api => { api.tool({name:'exercise',description:'exercise',parameters:{type:'object',properties:{}}},()=>{ const task=api.host.call('task.status',null); const agent=api.host.call('agents.spawn',{role:'worker',route:'sol',prompt:'offline'}); const result=api.host.call('agents.wait',{handle:agent.handle,consume:true}); const checkpoint=api.host.call('receipts.submit',{completed_acceptance:[],completed_steering:[],remaining_work:[],failed_hypotheses:[],candidate_versions:[],check_versions:[]}); return {task,agent,result,checkpoint}; }); api.command('clock',()=>Date.now()); api.command('ping',()=>{api.state.set(Number(api.state.get()??0)+1);return api.state.get()}); api.on('tool_result',()=>null); api.on('agent',()=>null); api.replace('terminal',()=>({title:'Offline UI',sites:{dialog:{components:[{type:'button',id:'ping_button',label:'Ping button',text:'Ping',action:{command:'harness:ping'}}]}},keybindings:{F2:{command:'harness:ping'}}})); }",
        &[
            "tools",
            "commands",
            "agents",
            "contracts",
            "store",
            "lifecycle",
            "middleware",
            "terminal",
        ],
    );
    trust(
        &store,
        &harness,
        &[
            "tools",
            "commands",
            "agents",
            "contracts",
            "store",
            "lifecycle",
            "middleware",
            "terminal",
        ],
    );
    let provider = service_package(
        &root,
        "provider",
        "export default api => api.provide({name:'example.echo',version:'1.0.0',methods:{echo:{input:'string',output:'string'}}},{echo:value=>value.toUpperCase()})",
        json!({"exports":[{"name":"example.echo","version":"1.0.0","methods":{"echo":{"input":"string","output":"string"}}}]}),
        &["services"],
    );
    trust(&store, &provider, &["services"]);
    let consumer = service_package(
        &root,
        "consumer",
        "export default api => api.command('call',()=>api.services.call('example.echo','echo','hello'))",
        json!({"imports":[{"name":"example.echo","version":"1.0.0"}]}),
        &["commands", "services"],
    );
    trust(&store, &consumer, &["commands", "services"]);
    let stream = package(
        &root,
        "stream",
        "export default api => api.middleware('response_stream',event=>event.protected?null:{text:String(event.text).toUpperCase()})",
        &["middleware"],
    );
    trust(&store, &stream, &["middleware"]);
    let mut runtime = host(&temp);
    let scenario = json!({
        "schema":1,
        "virtual_time_ms":1000,
        "host_operations":{
            "task.status":[{"result":{"status":"running"}}],
            "agents.spawn":[{"result":{"handle":"agent-1","route":"sol","permissions":"read_only"}}],
            "agents.wait":[{"result":{"status":"completed","text":"done","consumed":true}}],
            "receipts.submit":[{"result":{"saved":true}}]
        },
        "steps":[
            {"type":"invoke","mod":"harness","event":"command","name":"clock","expect":1000},
            {"type":"advance_time","ms":25,"expect":{"now_ms":1025}},
            {"type":"invoke","mod":"harness","event":"command","name":"clock","expect":1025},
            {"type":"invoke","mod":"harness","event":"tool","name":"exercise","expect":{"task":{"status":"running"},"agent":{"handle":"agent-1","route":"sol","permissions":"read_only"},"result":{"status":"completed","text":"done","consumed":true},"checkpoint":{"saved":true}}},
            {"type":"tool_outcome","payload":{"call_id":"call-1","agent_id":null,"tool":"exercise","outcome":{"status":"ok"}},"expect":[{"mod":"harness","value":null}]},
            {"type":"agent","payload":{"phase":"end","agent_id":"agent-1","parent_agent_id":null,"role":"worker","status":"completed"},"expect":[{"mod":"harness","value":null}]},
            {"type":"response_stream","payload":{"kind":"response.output_text.delta","raw_sha256":"00","raw_usage":null,"opaque_reasoning":false,"protected":false,"text":"hello"}},
            {"type":"invoke","mod":"consumer","event":"command","name":"call","expect":"HELLO"},
            {"type":"terminal_mount","mod":"harness","payload":{"event":"draw","checkpoint":null},"expect":{"title":"Offline UI","sites":{"dialog":{"components":[{"type":"button","id":"ping_button","label":"Ping button","text":"Ping","action":{"command":"harness:ping"}}]}},"keybindings":{"F2":{"command":"harness:ping"}}}},
            {"type":"terminal_interact","mod":"harness","key":"F2","payload":{"event":"draw","checkpoint":null},"expect":{"action":{"command":"harness:ping","args":""},"result":1}},
            {"type":"terminal_interact","mod":"harness","component":"ping_button","payload":{"event":"draw","checkpoint":null},"expect":{"action":{"command":"harness:ping","args":""},"result":2}},
            {"type":"reload"},
            {"type":"invoke","mod":"harness","event":"command","name":"clock","cancelled":true,"expect_error":"callback_cancelled"}
        ]
    });
    let result = runtime.offline_test(scenario).unwrap();
    assert_eq!(result["offline"], true);
    assert_eq!(result["paid_requests"], 0);
    assert_eq!(result["virtual_time_ms"], 1025);
    assert_eq!(result["host_calls"].as_array().unwrap().len(), 4);
    assert_eq!(result["steps"][6]["value"]["effective"], "HELLO");
    assert_eq!(result["steps"][11]["value"]["generation"], 2);
}

#[test]
fn offline_status_retains_conflicts_without_running_paid_work() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    for id in ["first", "second"] {
        let path = package(
            &root,
            id,
            &format!("export default api => api.replace('terminal',()=>({{title:'{id}'}}))"),
            &["terminal"],
        );
        trust(&store, &path, &["terminal"]);
    }
    let mut runtime = host(&temp);
    let result = runtime
        .offline_test(json!({"schema":1,"steps":[{"type":"status"}]}))
        .unwrap();
    assert_eq!(result["paid_requests"], 0);
    let errors = result["steps"][0]["value"]["mods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value["error"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();
    assert!(
        errors
            .iter()
            .all(|error| error.contains("replacement_conflict"))
    );
}

#[test]
fn rich_lines_and_boxes_are_bounded() {
    let valid = json!({"sites":{"header":{"components":[{"type":"box","id":"wide","label":"Wide","min_width":60,"max_width":500,"children":[
            {"type":"line","id":"mark","label":"Mark","spans":[{"text":"+ ","tone":"success"},{"text":"oh my diff","bold":true}]}]}]}}});
    codex_omd::ModView::parse(valid).unwrap();
    let spans = (0..13)
        .map(|index| json!({"text": format!("{index}")}))
        .collect::<Vec<_>>();
    for invalid in [
        json!({"theme":{"picker":{"layout":"compact"}}}),
        json!({"sites":{"header":{"components":[{"type":"box","id":"b","label":"B","min_width":70,"max_width":60}]}}}),
        json!({"sites":{"header":{"components":[{"type":"box","id":"b","label":"B","min_width":0}]}}}),
        json!({"sites":{"header":{"components":[{"type":"line","id":"l","label":"L","spans":spans}]}}}),
        json!({"sites":{"header":{"components":[{"type":"line","id":"l","label":"L","spans":[{"text":"x".repeat(257)}]}]}}}),
        json!({"sites":{"header":{"components":[{"type":"line","id":"l","label":"L","spans":[]}]}}}),
        json!({"sites":{"header":{"components":[{"type":"line","id":"l","label":"L","spans":[{"text":"\u{1b}[31m"}]}]}}}),
    ] {
        assert!(
            codex_omd::ModView::parse(invalid.clone()).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn terminal_identity_reports_profile_mode_and_mod_counts() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    let active = package(
        &root,
        "active",
        "export default api => api.on('terminal', input => ({status:[String(input.identity?.mods?.active)]}))",
        &["terminal"],
    );
    trust(&store, &active, &["terminal"]);
    let disabled = package(&root, "disabled", "export default () => {}", &["terminal"]);
    trust(&store, &disabled, &["terminal"]);
    contended(|| store.enable(&disabled, false));
    let mut runtime = host(&temp);
    let identity = runtime.identity("0.157.0", Some("platform_only"), "platform");
    assert_eq!(
        identity,
        json!({"codex_version":"0.157.0","install_profile":"platform_only","mode":"platform",
        "mods":{"installed":2,"enabled":1,"active":1}})
    );
    assert_eq!(
        runtime.identity("0.157.0", Some("arbitrary"), "enabled")["install_profile"],
        "unknown"
    );
    assert_eq!(
        runtime.identity("0.157.0", None, "enabled")["install_profile"],
        "unreported"
    );
    let terminal = runtime.terminal_view(
        json!({"event":"start","checkpoint":null,"identity":identity}),
        || true,
    );
    assert_eq!(terminal.view.status, vec!["1"]);
}

#[test]
fn retired_git_host_operations_are_rejected() {
    let source =
        "export default api => api.command('probe', () => api.host.call('git.status', null))";
    let (temp, _, _) = fixture(source, &["commands"]);
    let error = activation_error(&temp, "fixture");
    assert!(
        error.contains("unsupported_host_operation: git.status"),
        "{error}"
    );
}
