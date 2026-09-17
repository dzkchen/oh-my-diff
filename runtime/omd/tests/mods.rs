use codex_omd::MOD_API_VERSION;
use codex_omd::ModHost;
use codex_omd::ModStore;
use serde_json::Value;
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use tempfile::TempDir;

fn package(root: &std::path::Path, id: &str, source: &str, capabilities: &[&str]) -> PathBuf {
    let path = root.join(id);
    std::fs::create_dir(&path).unwrap();
    std::fs::write(
        path.join("mod.json"),
        serde_json::to_vec(&json!({"schema":1,"id":id,"version":"1.0.0",
        "api":MOD_API_VERSION,"state_version":1,"capabilities":capabilities}))
        .unwrap(),
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
    let inspected = ModStore::inspect_package(path).unwrap();
    store
        .trust(
            path.to_path_buf(),
            inspected["sha256"].as_str().unwrap(),
            capabilities.iter().map(|s| s.to_string()).collect(),
        )
        .unwrap();
    store.enable(path, true).unwrap();
}

fn host(temp: &TempDir) -> ModHost {
    ModHost::open(temp.path().canonicalize().unwrap().join("store")).unwrap()
}

const COUNTER: &str = "export default api => api.command('count', () => { api.state.set(Number(api.state.get() ?? 0)+1); return api.state.get(); })";

#[test]
fn mod_state_resumes_and_concurrent_writers_fail_without_lost_updates() {
    let (temp, _, _) = fixture(COUNTER, &["commands", "state"]);
    let mut first = host(&temp);
    let mut stale = host(&temp);
    assert_eq!(
        first
            .invoke(
                "fixture",
                first.generation(),
                "command",
                "count",
                Value::Null
            )
            .unwrap(),
        json!(1)
    );
    assert!(
        stale
            .invoke(
                "fixture",
                stale.generation(),
                "command",
                "count",
                Value::Null
            )
            .unwrap_err()
            .to_string()
            .contains("state_conflict")
    );
    let mut resumed = host(&temp);
    assert_eq!(
        resumed
            .invoke(
                "fixture",
                resumed.generation(),
                "command",
                "count",
                Value::Null
            )
            .unwrap(),
        json!(2)
    );
}

#[test]
fn mod_reload_is_transactional_and_stale_calls_are_rejected() {
    let (temp, store, path) = fixture(COUNTER, &["commands", "state"]);
    let mut runtime = host(&temp);
    let generation = runtime.generation();
    std::fs::write(
        path.join("index.ts"),
        "export default () => { throw new Error('broken') }",
    )
    .unwrap();
    trust(&store, &path, &["commands", "state"]);
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
    let (temp, store, _) = fixture(COUNTER, &["commands", "state"]);
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
    let (temp, _, _) = fixture(COUNTER, &["commands", "state"]);
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
    let (temp, store, _) = fixture(COUNTER, &["commands", "state"]);
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
