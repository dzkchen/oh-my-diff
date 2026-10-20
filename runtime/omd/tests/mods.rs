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


fn fixture(source: &str, capabilities: &[&str]) -> (TempDir, ModStore, PathBuf) {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
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
fn mod_state_refreshes_per_call_and_racing_writers_retry_without_lost_updates() {
    let source = "export default api => { api.command('count', () => { api.state.set(Number(api.state.get() ?? 0)+1); return api.state.get(); }); api.command('slow', () => { const value = Number(api.state.get() ?? 0); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); api.state.set(value + 100); return value; }); }";
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
    assert_eq!(result.unwrap(), json!(4));
    assert_eq!(invoke(&mut first, "count").unwrap(), json!(105));
    let mut resumed = host(&temp);
    assert_eq!(invoke(&mut resumed, "count").unwrap(), json!(106));
}

#[test]
fn conflict_retries_replay_host_results_and_refuse_divergent_callbacks() {
    let source = "export default api => { api.command('count', () => { api.state.set(Number(api.state.get() ?? 0)+1); return api.state.get(); }); api.command('slow', key => { const value = Number(api.state.get() ?? 0); const read = key === 'write' ? api.host.tryCall('store.put', { key: `k${value}`, value: 1, expected_revision: null }) : key === 'os' ? api.host.tryCall('exec.run', { program: '/bin/echo', argv: [`${value}`], sandbox: 'none' }) : api.host.tryCall('store.get', { key: key === 'state' ? `k${value}` : 'fixed' }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); api.state.set(value + 100); return read.ok; }); }";
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let capabilities = ["commands", "store", "exec", "os"];
    let path = package(&root, "fixture", source, &capabilities);
    let mut manifest: Value =
        serde_json::from_slice(&std::fs::read(path.join("mod.json")).unwrap()).unwrap();
    manifest["os_access"] = json!({"programs": ["/bin/echo"]});
    std::fs::write(
        path.join("mod.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    trust(&store, &path, &capabilities);
    let mut first = host(&temp);
    let mut second = host(&temp);
    let count = |runtime: &mut ModHost| {
        let generation = runtime.generation();
        runtime.invoke("fixture", generation, "command", "count", Value::Null)
    };
    let race = |first: &mut ModHost, second: &mut ModHost, key: &str| {
        let calls = AtomicUsize::new(0);
        let result = std::thread::scope(|scope| {
            let slow = scope.spawn(|| {
                let generation = first.generation();
                first.invoke_with(
                    "fixture",
                    generation,
                    "command",
                    "slow",
                    json!(key),
                    || true,
                    |_| {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(Value::Null)
                    },
                )
            });
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while calls.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            count(second).unwrap();
            slow.join().unwrap()
        });
        (result, calls.load(Ordering::SeqCst))
    };
    assert_eq!(count(&mut second).unwrap(), json!(1));
    let (result, calls) = race(&mut first, &mut second, "fixed");
    assert_eq!((result.unwrap(), calls), (json!(true), 1));
    assert_eq!(count(&mut second).unwrap(), json!(103));
    let (result, calls) = race(&mut first, &mut second, "state");
    assert_eq!((result.unwrap(), calls), (json!(true), 2));
    assert_eq!(count(&mut second).unwrap(), json!(205));
    let (result, calls) = race(&mut first, &mut second, "write");
    assert!(
        result
            .unwrap_err()
            .to_string()
            .starts_with("state_conflict")
    );
    assert_eq!(calls, 1);
    assert_eq!(count(&mut second).unwrap(), json!(207));
    let (result, calls) = race(&mut first, &mut second, "os");
    assert!(
        result
            .unwrap_err()
            .to_string()
            .starts_with("state_conflict")
    );
    assert_eq!(calls, 1);
    assert_eq!(count(&mut second).unwrap(), json!(209));
    assert!(first.status()["mods"][0]["error"].is_null());
}

#[test]
fn scoped_state_follows_the_session_thread_or_the_git_checkout() {
    let source = "export default api => { api.command('count', () => { api.state.set(Number(api.state.get() ?? 0)+1); return api.state.get(); }); api.command('fill', size => { api.state.set('x'.repeat(Number(size))); return null; }); }";
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let checkout = root.join("checkout");
    std::fs::create_dir_all(checkout.join(".git")).unwrap();
    std::fs::create_dir_all(checkout.join("sub")).unwrap();
    let linked = root.join("linked");
    std::fs::create_dir_all(checkout.join(".git/worktrees/linked")).unwrap();
    std::fs::create_dir(&linked).unwrap();
    std::fs::write(
        linked.join(".git"),
        format!(
            "gitdir: {}\n",
            checkout.join(".git/worktrees/linked").display()
        ),
    )
    .unwrap();
    let scoped = |id: &str, scope: &str| {
        let path = package(&root, id, source, &["commands", "store"]);
        let mut manifest: Value =
            serde_json::from_slice(&std::fs::read(path.join("mod.json")).unwrap()).unwrap();
        manifest["state_scope"] = json!(scope);
        std::fs::write(
            path.join("mod.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        path
    };
    let (threaded, shared, invalid) = (
        scoped("threaded", "thread"),
        scoped("shared", "checkout"),
        scoped("invalid", "global"),
    );
    let first = ModStore::create(root.join("first")).unwrap();
    let second = ModStore::create(root.join("second")).unwrap();
    for path in [&threaded, &shared] {
        trust(&first, path, &["commands", "store"]);
    }
    trust(&second, &shared, &["commands", "store"]);
    assert!(
        ModStore::inspect_package(&invalid)
            .unwrap_err()
            .to_string()
            .contains("state_scope")
    );
    let invoke = |runtime: &mut ModHost, id: &str, name: &str, payload: Value| {
        let generation = runtime.generation();
        runtime.invoke(id, generation, "command", name, payload)
    };
    let mut one = ModHost::open(root.join("first")).unwrap();
    let mut two = ModHost::open(root.join("second")).unwrap();
    one.set_checkout(&checkout.join("sub"));
    two.set_checkout(&checkout);

    {
        let _thread = codex_omd::StateThread::enter(Some("t1".into()));
        assert_eq!(
            invoke(&mut one, "threaded", "count", Value::Null).unwrap(),
            json!(1)
        );
        assert_eq!(
            invoke(&mut one, "threaded", "count", Value::Null).unwrap(),
            json!(2)
        );
    }
    {
        let _thread = codex_omd::StateThread::enter(Some("t2".into()));
        assert_eq!(
            invoke(&mut one, "threaded", "count", Value::Null).unwrap(),
            json!(1)
        );
    }
    assert_eq!(
        invoke(&mut one, "threaded", "count", json!({"thread_id": "t1"})).unwrap(),
        json!(3)
    );
    assert!(
        invoke(&mut one, "threaded", "count", Value::Null)
            .unwrap_err()
            .to_string()
            .contains("state_thread_unavailable")
    );
    assert!(codex_omd::data_store::fork_thread_data(&root.join("first"), "t1", "t3").unwrap());
    assert_eq!(
        invoke(&mut one, "threaded", "count", json!({"thread_id": "t3"})).unwrap(),
        json!(4)
    );
    assert!(codex_omd::data_store::remove_thread_data(&root.join("first"), "t1").unwrap());
    assert_eq!(
        invoke(&mut one, "threaded", "count", json!({"thread_id": "t1"})).unwrap(),
        json!(1)
    );
    assert!(!root.join("first/state-threaded.json").exists());

    assert_eq!(
        invoke(&mut one, "shared", "count", Value::Null).unwrap(),
        json!(1)
    );
    assert_eq!(
        invoke(&mut two, "shared", "count", Value::Null).unwrap(),
        json!(2)
    );
    assert_eq!(
        invoke(&mut one, "shared", "count", Value::Null).unwrap(),
        json!(3)
    );
    assert!(checkout.join(".git/omd/state/shared.json").is_file());
    let mut linked_host = ModHost::open(root.join("second")).unwrap();
    linked_host.set_checkout(&linked);
    assert_eq!(
        invoke(&mut linked_host, "shared", "count", Value::Null).unwrap(),
        json!(1)
    );
    let plain = root.join("plain");
    std::fs::create_dir(&plain).unwrap();
    let mut outside = ModHost::open(root.join("second")).unwrap();
    outside.set_checkout(&plain);
    let refused = invoke(&mut outside, "shared", "count", Value::Null).unwrap_err();
    assert!(
        refused.to_string().contains("state_checkout_unavailable"),
        "{refused}"
    );
    assert!(!plain.join(".omd").exists());
    let reader = scoped("reader", "checkout");
    std::fs::write(reader.join("index.ts"), "export default api => { const seen = api.state.get() !== null; api.command(seen ? 'seen' : 'fresh', () => { api.state.set(true); return seen; }); }").unwrap();
    trust(&second, &reader, &["commands", "store"]);
    let mut opened = ModHost::open_in(root.join("second"), |_| Ok(()), &checkout).unwrap();
    assert_eq!(
        invoke(&mut opened, "reader", "fresh", Value::Null).unwrap(),
        json!(false)
    );
    let mut reopened = ModHost::open_in(root.join("second"), |_| Ok(()), &checkout).unwrap();
    assert_eq!(
        invoke(&mut reopened, "reader", "seen", Value::Null).unwrap(),
        json!(true)
    );
    let mut unscoped = ModHost::open(root.join("first")).unwrap();
    assert!(
        invoke(&mut unscoped, "shared", "count", Value::Null)
            .unwrap_err()
            .to_string()
            .contains("state_checkout_unavailable")
    );
    assert!(
        unscoped.status()["mods"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["error"].is_null())
    );

    let _thread = codex_omd::StateThread::enter(Some("t2".into()));
    assert_eq!(
        invoke(&mut one, "threaded", "fill", json!(150_000)).unwrap(),
        Value::Null
    );
    assert!(
        invoke(&mut one, "threaded", "fill", json!(200_000))
            .unwrap_err()
            .to_string()
            .contains("state_limit")
    );
}

#[test]
fn mod_reload_is_transactional_and_stale_calls_are_rejected() {
    let (temp, store, path) = fixture(COUNTER, &["commands", "store"]);
    let mut runtime = host(&temp);
    let generation = runtime.generation();
    runtime
        .invoke("fixture", generation, "command", "count", Value::Null)
        .unwrap();
    std::fs::write(
        path.join("index.ts"),
        "export default () => { throw new Error('broken') }",
    )
    .unwrap();
    assert!(
        runtime
            .invoke("fixture", generation, "command", "count", Value::Null)
            .unwrap_err()
            .to_string()
            .contains("untrusted_source")
    );
    trust(&store, &path, &["commands", "store"]);
    assert!(runtime.reload().is_err());
    assert_eq!(runtime.generation(), generation);
    assert!(
        runtime
            .invoke("fixture", generation, "command", "count", Value::Null)
            .unwrap_err()
            .to_string()
            .contains("callback_authority_changed")
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
fn service_launch_uses_admitted_helpers_after_unchanged_configuration_reload() {
    let (temp, store, path) = fixture("export default () => {};", &[]);
    let manifest_path = path.join("mod.json");
    let mut manifest: Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    manifest["assets"] = json!(["helper.mjs"]);
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    std::fs::write(path.join("helper.mjs"), "admitted helper").unwrap();
    trust(&store, &path, &[]);
    let mut runtime = host(&temp);
    let generation = runtime.generation();
    std::fs::write(path.join("helper.mjs"), "changed helper").unwrap();
    runtime.reload().unwrap();
    assert_eq!(runtime.generation(), generation);
    let (_, files) = runtime.launch_sources("fixture", generation).unwrap();
    assert_eq!(files[&path.join("helper.mjs")], b"admitted helper");
    store.enable(&path, false).unwrap();
    runtime.reload().unwrap();
    assert!(runtime.launch_sources("fixture", generation).is_err());
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
fn late_host_calls_fail_their_own_callback_and_never_reach_another_mod() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let leaving = package(
        &root,
        "leaving",
        "export default api => api.command('leave', () => { (async () => { for (let i = 0; i < 1000; i++) await null; api.host.call('workspace.read', {path:'file'}); })(); return 'left'; });",
        &["commands", "fs.read"],
    );
    trust(&store, &leaving, &["commands", "fs.read"]);
    let other = package(
        &root,
        "other",
        "export default api => api.command('run', () => 'ran');",
        &["commands"],
    );
    trust(&store, &other, &["commands"]);
    let mut host = ModHost::open(root.join("store")).unwrap();
    let generation = host.generation();
    assert!(
        host.invoke("leaving", generation, "command", "leave", Value::Null)
            .is_err()
    );
    assert_eq!(
        host.invoke("other", generation, "command", "run", Value::Null)
            .unwrap(),
        "ran"
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
    for _ in 1..5 {
        assert_eq!(runtime.event("context", Value::Null).len(), 2);
    }
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
    let generation = runtime.generation();
    assert!(
        runtime
            .invoke("fixture", generation, "command", "count", Value::Null)
            .unwrap_err()
            .to_string()
            .contains("mod_conflict")
    );
    store.enable(&other, false).unwrap();
    runtime.reload().unwrap();
    let generation = runtime.generation();
    assert_eq!(
        runtime
            .invoke("fixture", generation, "command", "count", Value::Null)
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
    manifest["assets"] = json!(["helper.ts"]);
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    std::fs::write(
        path.join("helper.ts"),
        "export const migrate = (count, from, to) => ({count,from,to});",
    )
    .unwrap();
    std::fs::write(path.join("index.ts"), "import {migrate} from './helper.ts'; export default api => api.on('migrate', ({from,to}) => { api.state.set(migrate(api.state.get(),from,to)); })").unwrap();
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
    let migrated: Value = serde_json::from_slice(
        &std::fs::read(temp.path().join("store/state-fixture.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(migrated["value"], json!({"count":1,"from":1,"to":2}));
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
            .contains("migration_requires_different_state_version")
    );
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
        if field == "api" {
            assert!(error.contains("9.0.0"), "{error}");
            assert!(error.contains(MOD_API_VERSION), "{error}");
        }
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
    assert_eq!(status["api"], MOD_API_VERSION);
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
fn callback_budget_errors_fail_the_call_without_disabling_the_mod() {
    let source = "export default api => api.command('run', arg => { if (arg === 'small') return 'ok'; if (arg === 'recover') { try { api.host.call('task.status'); } catch {} return api.host.call('task.status'); } api.host.call('task.status'); api.host.call('task.status'); return 'unreachable'; })";
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
    let mut calls = 0;
    let error = runtime
        .invoke_with(
            "fixture",
            generation,
            "command",
            "run",
            json!("cumulative"),
            || true,
            |_| {
                calls += 1;
                Ok(json!({"text": "x".repeat(70_000)}))
            },
        )
        .unwrap_err();
    assert_eq!(calls, 2);
    assert!(
        error.to_string().starts_with("Error: host_result_limit"),
        "{error}"
    );
    let mut calls = 0;
    let recovered = runtime
        .invoke_with(
            "fixture",
            generation,
            "command",
            "run",
            json!("recover"),
            || true,
            |_| {
                calls += 1;
                Ok(if calls == 1 {
                    json!({"text": "x".repeat(140_000)})
                } else {
                    json!("recovered")
                })
            },
        )
        .unwrap();
    assert_eq!(calls, 2);
    assert_eq!(recovered, json!("recovered"));
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
        json!({"sites":{"sidebar":{"components":[{"type":"native"}]}}}),
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
    let value = json!({"foreground":81,"keybindings":{"F6":"Review current work"}});
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
        contributors: (0..40).map(|index| format!("mod_{index}")).collect(),
        ..Default::default()
    };
    std::fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    assert_eq!(codex_omd::ModViewSnapshot::read(&path).unwrap(), snapshot);
    snapshot.activity[0].label = "bad\u{1b}".into();
    std::fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    assert!(codex_omd::ModViewSnapshot::read(&path).is_err());
}

#[test]
fn startup_terminal_preview_rejects_native_task_operations_at_host_boundary() {
    for (call, capability) in [
        ("api.host.call('task.status', null)", "agents"),
        (
            "api.host.call('model.complete', {route:'fixture',prompt:'offline'})",
            "agents",
        ),
        (
            "api.host.call('app.request', {method:'account/read',params:{}})",
            "account",
        ),
        (
            "api.host.call('terminal.notify', {title:'fixture'})",
            "terminal",
        ),
    ] {
        let source = format!("export default api => api.on('terminal', () => {call})");
        let capabilities = if capability == "terminal" {
            vec!["terminal"]
        } else {
            vec!["terminal", capability]
        };
        eprintln!("startup preview denial fixture: {call}, capabilities={capabilities:?}");
        let (temp, _, _) = fixture(&source, &capabilities);
        let mut runtime = host(&temp);
        let terminal = runtime.terminal_view(
            json!({"event":"startup","ledger":null,
                "presentation":{"thread_id":null,"phase":"fresh"}}),
            || true,
        );
        assert_eq!(
            terminal.diagnostics.len(),
            1,
            "{call}: {:?}",
            terminal.diagnostics
        );
        assert!(
            terminal.diagnostics[0].contains("host_operation_unavailable: requires a native task"),
            "{call}: {:?}",
            terminal.diagnostics
        );
        assert!(terminal.contributors.is_empty());
    }
}

#[test]
fn terminal_components_compose_in_dependency_order_and_observers_contribute_status() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let workspace = packaged(
        &root,
        "workspace",
        "workspace",
        "export default api => api.on('terminal',()=>({title:'Workspace',sites:{sidebar:{components:[{type:'text',id:'base_text',label:'Base text',text:'base'}]}},status:['workspace'],keybindings:{F8:{focus:'base_text'}}}))",
        &["terminal"],
        &[],
    );
    trust(&store, &workspace, &["terminal"]);
    let focus = packaged(
        &root,
        "focus",
        "focus",
        "export default api => api.on('terminal',()=>({sites:{sidebar:{mode:'wrap',components:[{type:'box',id:'focus_box',label:'Focus box',children:[{type:'text',id:'focus_text',label:'Focus text',text:'focus'},{type:'slot'}]}]}},status:['focus'],keybindings:{F9:{command:'focus:toggle'}}}))",
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
        terminal.contributors,
        vec!["workspace", "focus", "theme"],
        "{}",
        runtime.status()
    );
    assert!(
        terminal.diagnostics.is_empty(),
        "{:?}",
        terminal.diagnostics
    );
    assert_eq!(terminal.view.status, vec!["workspace", "focus", "theme"]);
    assert_eq!(terminal.view.theme.border, codex_omd::ModBorder::Rounded);
    let sidebar = serde_json::to_value(&terminal.view.sites["sidebar"]).unwrap();
    assert_eq!(sidebar["components"][0]["id"], "focus_box");
    assert_eq!(sidebar["components"][0]["children"][1]["id"], "base_text");

    let observer = package(
        &root,
        "observer",
        "export default api => api.on('terminal',()=>({status:['observer'],keybindings:{F8:'stolen'}}))",
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
    assert_eq!(
        terminal.view.keybindings["F8"],
        codex_omd::ModKeyAction::Draft("stolen".into())
    );
    assert_eq!(
        terminal.conflicts,
        vec![codex_omd::ModViewConflict {
            field: "keybindings.F8".into(),
            owner: "observer".into(),
            rejected: "workspace".into(),
            origin: "draw".into(),
        }]
    );

    let cancelled =
        runtime.terminal_view(json!({"event":"interrupted","checkpoint":null}), || false);
    assert!(
        cancelled.diagnostics.is_empty(),
        "{:?}",
        cancelled.diagnostics
    );
    assert_eq!(cancelled.view.status, terminal.view.status);
}

#[test]
fn ui_state_invalidates_render_hooks_without_durable_reads() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let frame = package(
        &root,
        "frame",
        "export default api => { \
         api.intercept('render', {match:{component:'notice'}}, () => ({tree:[{type:'text',id:'label',label:'Label',text:String(api.uiState.get()) + ':' + Math.random()}]})); \
         api.command('label', value => { api.uiState.set(value); return null; }); }",
        &["terminal", "commands"],
    );
    trust(&store, &frame, &["terminal", "commands"]);
    let runtime = std::sync::Mutex::new(host(&temp));
    let render = || {
        codex_omd::render_shared(
            &runtime,
            json!({"component":"notice","id":"notice-1","surface":"fullscreen","viewport":{"columns":80,"rows":24},
                "lifecycle":"final","owner":null,"props":{"text":"hello"}}),
            || true,
        )
        .unwrap()
        .result
    };
    render();
    let first = render();
    assert_eq!(render(), first);
    {
        let mut runtime = runtime.lock().unwrap();
        let generation = runtime.generation();
        runtime
            .invoke_with(
                "frame",
                generation,
                "command",
                "label",
                json!("changed"),
                || true,
                |_| Ok(Value::Null),
            )
            .unwrap();
    }
    let changed = render();
    assert!(
        changed["tree"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("changed:")
    );
    assert_eq!(render(), changed);
}

#[test]
fn render_hooks_compose_rewrite_props_and_rerender_only_when_read_keys_change() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let frame = package(
        &root,
        "frame",
        "export default api => { const label = api.atom('label', 'frame'); \
         api.intercept('render', {match:{component:'tool_call'}}, async (e, next) => { const inner = await next(e); \
           return {tree:[{type:'text',id:'top',label:'Top',text:label.get() + ':' + Math.random()}, ...inner.tree]}; }); \
         api.intercept('render', {match:{component:'notice'}}, () => ({tree:[]})); \
         api.intercept('render', {match:{component:'spinner'}}, (e, next) => next({...e, props:{...e.props, header:'Thinking'}})); \
         api.intercept('render', {match:{component:'turn_duration'}}, (e, next) => next({...e, props:{...e.props, seconds:1}})); \
         api.intercept('render', {match:{component:'question'}}, (e, next) => { label.set('leaked'); return next(e); }); \
         api.intercept('render', {match:{component:'composer_hint'}}, (e, next) => next(e)); \
         api.command('relabel', name => { if (name) label.set(name); else api.atom('other', 0).set(1); return null; }); }",
        &["terminal", "store", "commands"],
    );
    trust(&store, &frame, &["terminal", "store", "commands"]);
    let tint = package(
        &root,
        "tint",
        "export default api => api.intercept('render', {match:{component:['tool_call','question']}}, async (e, next) => { \
           const inner = await next(e); return {tree: inner.tree.map(node => node.type === 'native' ? {...node, style:{bold:true}} : node)}; })",
        &["terminal"],
    );
    trust(&store, &tint, &["terminal"]);
    let runtime = std::sync::Mutex::new(host(&temp));
    let render = |component: &str, props: Value| {
        codex_omd::render_shared(
            &runtime,
            json!({"component":component,"id":"call-1","surface":"fullscreen","viewport":{"columns":80,"rows":24},
                "lifecycle":"final","owner":null,"props":props}),
            || true,
        )
        .unwrap()
    };
    let tool = || render("tool_call", json!({"tool":"shell","call_id":"call-1"}));
    let first = tool();
    let text = first.result["tree"][0]["text"].as_str().unwrap().to_owned();
    assert!(text.starts_with("frame:"), "{}", first.result);
    assert_eq!(
        first.result["tree"][1],
        json!({"type":"native","style":{"bold":true}})
    );
    assert_eq!(first.reads["frame"], ["label".to_owned()].into());
    assert_eq!(tool().result["tree"][0]["text"], text);
    let relabel = |name: Value| {
        let mut runtime = runtime.lock().unwrap();
        let generation = runtime.generation();
        runtime
            .invoke_with(
                "frame",
                generation,
                "command",
                "relabel",
                name,
                || true,
                |_| Ok(Value::Null),
            )
            .unwrap();
    };
    relabel(Value::Null);
    assert_eq!(tool().result["tree"][0]["text"], text);
    relabel(json!("renamed"));
    assert!(
        tool().result["tree"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("renamed:")
    );

    assert_eq!(
        render("notice", json!({"kind":"info","text":"hi"})).result,
        json!({"tree":[]})
    );
    let spinner = render("spinner", json!({"header":"Working","elapsed_ms":5}));
    assert_eq!(spinner.input["props"]["header"], "Thinking");
    assert_eq!(spinner.result, json!({"tree":[{"type":"native"}]}));
    let duration = render("turn_duration", json!({"seconds":3}));
    assert_eq!(duration.input["props"]["seconds"], 3);
    assert_eq!(duration.result, json!({"tree":[{"type":"native"}]}));
    let hint = render("composer_hint", json!({"placeholder":"x".repeat(2000)}));
    assert!(
        hint.trace.iter().all(|entry| entry["reason"].is_null()),
        "{:?}",
        hint.trace
    );
    let question = render("question", json!({"questions":1}));
    assert_eq!(
        question.result,
        json!({"tree":[{"type":"native","style":{"bold":true}}]})
    );
    assert!(
        question.trace.iter().any(|entry| entry["mod"] == "frame"
            && entry["reason"]
                .as_str()
                .is_some_and(|reason| reason.contains("render_side_effect_refused"))),
        "{:?}",
        question.trace
    );

    std::fs::write(
        tint.join("index.ts"),
        "export default api => api.intercept('render', {match:{component:'tool_call'}}, async (e, next) => \
           ({tree: (await next(e)).tree.map(node => node.type === 'native' ? {...node, style:{italic:true}} : node)}))",
    )
    .unwrap();
    trust(&store, &tint, &["terminal"]);
    runtime.lock().unwrap().reload().unwrap();
    assert_eq!(
        tool().result["tree"][1],
        json!({"type":"native","style":{"italic":true}})
    );
    contended(|| store.enable(&frame, false));
    contended(|| store.enable(&tint, false));
    runtime.lock().unwrap().reload().unwrap();
    assert_eq!(tool().result, json!({"tree":[{"type":"native"}]}));
}

#[test]
fn a_failed_terminal_patch_is_transactional() {
    let mut view = codex_omd::ModView::parse(json!({"title":"Base","sites":{"sidebar":{"components":[{"type":"text","id":"base","label":"Base","text":"base"}]}}})).unwrap();
    let first = codex_omd::ModViewPatch::parse(json!({"title":"First","sites":{"sidebar":{"components":[{"type":"text","id":"first","label":"First","text":"first"}]}}})).unwrap();
    let second = codex_omd::ModViewPatch::parse(json!({"title":"Leaked","sites":{"sidebar":{"mode":"wrap","components":[{"type":"text","id":"first","label":"Second","text":"second"},{"type":"slot"}]}}})).unwrap();
    let mut claims = std::collections::BTreeMap::new();
    first
        .apply(&mut view, &mut claims, "first", "idle")
        .unwrap();
    assert!(
        second
            .apply(&mut view, &mut claims, "second", "idle")
            .is_err()
    );
    assert_eq!(view.title.as_deref(), Some("First"));
    assert_eq!(
        serde_json::to_value(&view.sites["sidebar"]).unwrap()["components"][0]["id"],
        "first"
    );
}

#[test]
fn command_outcomes_are_validated() {
    use codex_omd::ModCommandOutcome;
    assert_eq!(
        ModCommandOutcome::parse(&json!({"display":"shown","submit":"send this"})).unwrap(),
        ModCommandOutcome {
            display: Some("shown".into()),
            insert: None,
            submit: Some("send this".into()),
            terminal: None,
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
}

#[test]
fn ui_state_is_shared_per_session_isolated_and_cleared_on_reload() {
    let source = "export default api => { api.command('write', value => { api.uiState.set(value); return null; }); api.command('lone', where => { const lone = String.fromCharCode(0xd800); api.uiState.set(where === 'key' ? {[lone]: 1} : ['ok', lone]); return null; }); api.command('read', () => api.uiState.get()); api.command('race', () => { const before = api.uiState.get() ?? 0; api.host.call('workspace.read', {path:'file'}); api.uiState.set(before + 1); return before + 1; }); api.on('terminal', () => ({title:String(api.uiState.get() ?? 'empty')})); };";
    let (temp, store, path) = fixture(source, &["commands", "terminal", "fs.read"]);
    let mut first = host(&temp);
    let mut second = host(&temp);
    let invoke = |host: &mut ModHost, name: &str, value| {
        host.invoke("fixture", host.generation(), "command", name, value)
            .unwrap()
    };
    assert!(invoke(&mut first, "read", Value::Null).is_null());
    invoke(&mut first, "write", json!(2));
    assert!(!first.refresh_guarded(&|| true).unwrap());
    assert!(!second.refresh_guarded(&|| true).unwrap());
    assert_eq!(invoke(&mut second, "read", Value::Null), 2);
    assert!(first.state("fixture").unwrap().is_null());
    let mut raced = false;
    let value = first
        .invoke_with(
            "fixture",
            first.generation(),
            "command",
            "race",
            Value::Null,
            || true,
            |_| {
                assert!(!raced);
                raced = true;
                invoke(&mut second, "write", json!(10));
                Ok(json!("contents"))
            },
        )
        .unwrap();
    assert_eq!(value, 11);
    assert_eq!(invoke(&mut second, "read", Value::Null), 11);
    store.enable(&path, false).unwrap();
    first.turn_boundary();
    assert!(
        second
            .invoke(
                "fixture",
                second.generation(),
                "command",
                "read",
                Value::Null
            )
            .is_err()
    );
    store.enable(&path, true).unwrap();
    first.reload().unwrap();
    invoke(&mut first, "write", json!(4));
    store.reload().unwrap();
    assert!(invoke(&mut second, "read", Value::Null).is_null());
    invoke(&mut first, "write", json!(5));
    first.turn_boundary();
    {
        let _thread = codex_omd::StateThread::enter(Some("another".into()));
        assert!(invoke(&mut first, "read", Value::Null).is_null());
    }
    assert_eq!(invoke(&mut second, "read", Value::Null), 5);
    assert_eq!(invoke(&mut first, "read", Value::Null), 5);
    for value in [
        json!([1e-7, "a".repeat(65_527)]),
        json!("界".repeat(21_844) + "aa"),
    ] {
        invoke(&mut first, "write", value.clone());
        assert_eq!(invoke(&mut second, "read", Value::Null), value);
    }
    let error = first
        .invoke(
            "fixture",
            first.generation(),
            "command",
            "write",
            json!("x".repeat(65_537)),
        )
        .unwrap_err();
    assert!(error.to_string().contains("ui_state_limit"));
    let escaped = json!(["\\ud800", "\\\\ud800", "😀"]);
    invoke(&mut first, "write", escaped.clone());
    assert_eq!(invoke(&mut second, "read", Value::Null), escaped);
    for place in ["key", "value"] {
        let error = first
            .invoke(
                "fixture",
                first.generation(),
                "command",
                "lone",
                json!(place),
            )
            .unwrap_err();
        assert!(
            error.to_string().contains("ui_state_invalid_json"),
            "{error}"
        );
    }
}

#[test]
fn ui_state_command_views_validate_ownership_and_preserve_other_contributions() {
    let source = "export default api => { api.command('view', () => { api.uiState.set('open'); return {terminal:{sites:{dialog:{mode:'replace',components:[{type:'text',id:'own',label:'Own',text:'Visible'}]}}}}; }); api.command('close', () => ({terminal:null})); api.command('change', () => api.uiState.set('changed')); api.command('durable', () => api.state.set('changed')); api.command('bad', () => { api.uiState.set('bad'); return {terminal:{title:'x'.repeat(10000)}}; }); api.on('terminal', () => ({title:'First'})); };";
    let (temp, store, _) = fixture(source, &["commands", "terminal", "store"]);
    let root = temp.path().canonicalize().unwrap();
    let other = package(
        &root,
        "other",
        "export default api => { api.command('change', () => api.uiState.set('Changed')); api.on('terminal', () => ({status:[api.uiState.get() ?? 'Other']})); };",
        &["commands", "terminal"],
    );
    trust(&store, &other, &["commands", "terminal"]);
    let mut runtime = host(&temp);
    runtime.terminal_view(json!({}), || true);
    let value = runtime
        .invoke(
            "fixture",
            runtime.generation(),
            "command",
            "view",
            Value::Null,
        )
        .unwrap();
    let view = runtime
        .command_view(
            "fixture",
            runtime.generation(),
            value["terminal"].clone(),
            &json!({}),
        )
        .unwrap();
    assert_eq!(view.component_owners["own"], "fixture");
    assert_eq!(view.view.status, ["Other"]);
    runtime
        .invoke(
            "other",
            runtime.generation(),
            "command",
            "change",
            Value::Null,
        )
        .unwrap();
    let refreshed = runtime.terminal_view(json!({}), || true);
    assert_eq!(refreshed.component_owners["own"], "fixture");
    assert_eq!(refreshed.view.status, ["Changed"]);
    assert!(
        runtime
            .command_view("missing", runtime.generation(), json!({}), &json!({}))
            .is_err()
    );
    assert!(
        runtime
            .command_view("fixture", runtime.generation() + 1, json!({}), &json!({}))
            .is_err()
    );
    assert!(
        runtime
            .invoke(
                "fixture",
                runtime.generation(),
                "command",
                "bad",
                Value::Null
            )
            .is_err()
    );
    let closed = runtime
        .invoke(
            "fixture",
            runtime.generation(),
            "command",
            "close",
            Value::Null,
        )
        .unwrap();
    assert!(
        !runtime
            .command_view(
                "fixture",
                runtime.generation(),
                closed["terminal"].clone(),
                &json!({})
            )
            .unwrap()
            .view
            .sites
            .contains_key("dialog")
    );
    assert!(
        runtime
            .terminal_view(json!({}), || true)
            .view
            .title
            .is_none()
    );
    std::thread::sleep(std::time::Duration::from_millis(1100));
    assert_eq!(
        runtime
            .terminal_view(json!({}), || true)
            .view
            .title
            .as_deref(),
        Some("First")
    );
    for change in ["change", "durable"] {
        let value = runtime
            .invoke(
                "fixture",
                runtime.generation(),
                "command",
                "view",
                Value::Null,
            )
            .unwrap();
        runtime
            .invoke(
                "fixture",
                runtime.generation(),
                "command",
                change,
                Value::Null,
            )
            .unwrap();
        runtime
            .command_view(
                "fixture",
                runtime.generation(),
                value["terminal"].clone(),
                &json!({}),
            )
            .unwrap();
        assert_eq!(
            runtime
                .terminal_view(json!({}), || true)
                .view
                .title
                .as_deref(),
            Some("First")
        );
    }
    let value = {
        let _thread = codex_omd::StateThread::enter(Some("thread-a".into()));
        runtime
            .invoke(
                "fixture",
                runtime.generation(),
                "command",
                "view",
                Value::Null,
            )
            .unwrap()
    };
    let payload = json!({"ledger":{"thread_id":"thread-b"}});
    runtime
        .command_view(
            "fixture",
            runtime.generation(),
            value["terminal"].clone(),
            &payload,
        )
        .unwrap();
    assert_eq!(
        runtime
            .terminal_view(payload, || true)
            .view
            .title
            .as_deref(),
        Some("First")
    );
}

#[test]
fn typed_services_are_host_routed_versioned_and_generate_installed_types() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
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
    assert!(types.contains("'example.echo@1.1.0'"));
    assert!(types.contains("echo(input: string): string"));
    assert_eq!(runtime.status()["service_calls"][0]["provider"], "provider");
}

#[test]
fn service_host_operations_keep_provider_identity_and_grants() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
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
    let store = ModStore::create(root.join("store")).unwrap();
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
    let sha256 = ModStore::inspect_package(&missing).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    store
        .trust(missing.clone(), &sha256, vec!["services".into()], "user")
        .unwrap();
    assert!(
        store
            .enable(&missing, true)
            .unwrap_err()
            .to_string()
            .contains("service_provider_missing: missing needs the absent.service service")
    );
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
    let store = ModStore::create(root.join("store")).unwrap();
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
    let sha256 = ModStore::inspect_package(&a).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    store
        .trust(a.clone(), &sha256, vec!["services".into()], "user")
        .unwrap();
    trust(&store, &b, &["services"]);
    store.enable(&a, true).unwrap();
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
fn request_and_stream_interceptors_compose_and_keep_observers_observe_only() {
    let source = "export default api => { api.intercept('model_request', (e, next) => next({...e, route: 'astra', effort: 'low'})); \
         api.intercept('response_stream', {match: {kind: 'text'}}, (e, next) => next({...e, text: e.text.toUpperCase()})); \
         api.intercept('response_stream', {match: {kind: 'reasoning'}}, () => ({chunks: []})); \
         api.middleware('tool_result', () => ({forged: true})); }";
    let (temp, _, _) = fixture(source, &["middleware"]);
    let runtime = std::sync::Mutex::new(host(&temp));
    let run = |surface: &str, input: Value, core: fn(Value) -> Value| {
        codex_omd::intercept_shared(
            &runtime,
            surface,
            false,
            input,
            json!({"caller":"engine"}),
            || true,
            |_, _| Err(std::io::Error::other("unexpected host call")),
            |input| Ok(core(input)),
        )
        .unwrap()
    };
    let request = run(
        "model_request",
        json!({"request_id":"r1","route":"sol","routes":[{"name":"sol"},{"name":"astra"}],"effort":"high","sections":[]}),
        |input| json!({"route": input["route"], "effort": input["effort"]}),
    );
    assert_eq!(request.result, json!({"route":"astra","effort":"low"}));
    let stream = run(
        "response_stream",
        json!({"kind":"text","index":0,"text":"hello","protected":false}),
        |input| json!({"chunks": [input]}),
    );
    assert_eq!(stream.result["chunks"][0]["text"], "HELLO");
    let reasoning = json!({"kind":"reasoning","index":1,"protected":true});
    let kept = run(
        "response_stream",
        reasoning.clone(),
        |input| json!({"chunks": [input]}),
    );
    assert_eq!(
        kept.result,
        json!({"chunks": [reasoning]}),
        "protected chunks cannot be dropped"
    );
    let tool = runtime.lock().unwrap().event(
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
fn source_use_rejects_undeclared_authority_and_reports_unused_grants() {
    for capabilities in [
        vec!["commands", "agents"],
        vec!["commands", "agents", "sessions"],
    ] {
        let (temp, _, _) = fixture(
            "export default api => api.command('forkprobe',()=>api.host.call('model.fork',{prompt:'p'}))",
            &capabilities,
        );
        let error = activation_error(&temp, "fixture");
        assert!(
            error.contains("undeclared_operation_use: model.fork"),
            "{error}"
        );
    }
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
    let (temp, _, _) = fixture(
        "export default api => api.command('ping',()=>api.host.call('exec.run',{program:'env',unix_sockets:['S']}))",
        &["commands", "exec", "unix_sockets"],
    );
    assert_eq!(host(&temp).status()["mods"][0]["unused_grants"], json!([]));
    let (temp, _, _) = fixture(
        "export default api => api.command('ping',()=>api.host.call('exec.run',{program:'env',unix_sockets:['S']}))",
        &["commands", "exec", "network", "unix_sockets"],
    );
    assert_eq!(
        host(&temp).status()["mods"][0]["unused_grants"],
        json!(["network"])
    );
    let (temp, _, _) = fixture(
        "export default api => api.command('ping',()=>api.host.call('exec.run',{program:'env',write:true}))",
        &["commands", "exec", "fs.write"],
    );
    assert_eq!(host(&temp).status()["mods"][0]["unused_grants"], json!([]));
    let (temp, _, _) = fixture(
        "export default (api: any) => api.command('count',()=>{ api.atom<number>('n', 0).set(1); return null; })",
        &["commands", "store"],
    );
    assert_eq!(host(&temp).status()["mods"][0]["unused_grants"], json!([]));
    let (temp, _, _) = fixture(
        "export default (api: any) => api.command('spawn',()=>api.host.call('agents.spawn',{role:'worker',prompt:'p',parent_history:true}))",
        &["commands", "agents", "sessions", "sessions_tools"],
    );
    assert_eq!(host(&temp).status()["mods"][0]["unused_grants"], json!([]));
    let (temp, _, _) = fixture(
        "export default api => api.command('forkprobe',()=>api.host.call('model.fork',{prompt:'p'}))",
        &["commands", "agents", "sessions", "sessions_tools"],
    );
    assert_eq!(host(&temp).status()["mods"][0]["unused_grants"], json!([]));
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
fn disabling_during_native_work_rejects_completion_and_next_generation() {
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
        .unwrap_err();
    assert!(result.to_string().contains("callback_authority_changed"));
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
fn a_contract_registration_requires_the_current_capability() {
    let (temp, _, _) = fixture(CONTRACT, &[]);
    assert!(activation_error(&temp, "fixture").contains("capability_denied"));
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
    assert!(error.contains("fixture/index.ts:1:"), "{error}");
    assert!(!error.contains(root.to_str().unwrap()), "{error}");
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
fn codex_config_is_allowlisted_and_reported_for_active_mods() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let write = |directory: &str, extra: Value| {
        let path = packaged(
            &root,
            directory,
            directory,
            "export default () => {}",
            &[],
            &[],
        );
        let mut manifest: Value =
            serde_json::from_slice(&std::fs::read(path.join("mod.json")).unwrap()).unwrap();
        manifest
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        std::fs::write(
            path.join("mod.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        path
    };
    let feature = json!({"compatibility":{"required_features":["codex_config_v1"]}});
    let planner = write(
        "planner",
        json!({"codex_config":{"tools.update_plan.enabled":true},"compatibility":feature["compatibility"]}),
    );
    trust(&store, &planner, &[]);
    for (directory, extra) in [
        (
            "unlisted",
            json!({"codex_config":{"model":true},"compatibility":feature["compatibility"]}),
        ),
        (
            "disabled",
            json!({"codex_config":{"tools.update_plan.enabled":false},"compatibility":feature["compatibility"]}),
        ),
        (
            "undeclared",
            json!({"codex_config":{"tools.update_plan.enabled":true}}),
        ),
    ] {
        let error = ModStore::inspect_package(&write(directory, extra))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("invalid_codex_config"),
            "{directory}: {error}"
        );
    }
    let plain = write("plain", json!({}));
    trust(&store, &plain, &[]);
    let mut runtime = ModHost::open(root.join("store")).unwrap();
    let published = runtime.codex_config();
    assert_eq!(
        published.lock().unwrap().iter().collect::<Vec<_>>(),
        ["tools.update_plan.enabled"]
    );
    let planner_status = runtime.status()["mods"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == "planner")
        .unwrap()["authority"]["codex_config"]
        .clone();
    assert_eq!(planner_status, json!({"tools.update_plan.enabled": true}));
    store.enable(&planner, false).unwrap();
    runtime.reload().unwrap();
    assert!(published.lock().unwrap().is_empty());
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
    let store = ModStore::create(root.join("store")).unwrap();
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
    let store = ModStore::create(root.join("store")).unwrap();
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
fn a_shadowed_request_policy_is_enforced_by_its_project_copy() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let source =
        "export default api => api.intercept('model_send', {required: true}, (e, next) => next(e))";
    let capabilities = ["middleware", "request_policy"];
    let user = packaged(&root, "user-copy", "policy", source, &capabilities, &[]);
    let project = packaged(
        &root,
        "project-copy",
        "policy",
        &format!("{source};\n"),
        &capabilities,
        &[],
    );
    trust_scoped(&store, &user, &capabilities, "user");
    trust_scoped(&store, &project, &capabilities, "project");
    let runtime = host(&temp);
    assert_eq!(runtime.send_policy().unwrap().unavailable, None);
}

#[test]
fn two_selections_of_one_id_in_the_same_scope_both_fail_closed() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
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
    let store = ModStore::create(root.join("store")).unwrap();
    for id in ["first", "second"] {
        let path = packaged(
            &root,
            id,
            id,
            "export default api => api.replace('compaction', () => 16000)",
            &["compaction"],
            &[],
        );
        trust(&store, &path, &["compaction"]);
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
                .contains("replacement_conflict: compaction claimed by first, second"),
            "{id}: {}",
            error_of(&runtime, id)
        );
    }
    assert_eq!(runtime.status()["order"], json!(["healthy"]));
    assert_eq!(runtime.replacement_owner("compaction"), None);
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
    assert!(runtime.status()["mods"][0]["error"].is_null());
    assert_eq!(runtime.status()["mods"][0]["telemetry"]["faults"], 1);
    for _ in 1..5 {
        let _ = runtime.event("routing", json!({}));
    }
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
    assert!(store.join("active-host.d.ts").is_file());
    assert!(store.join("installed-contracts.d.ts").is_file());
    let bundle = runtime.diagnostic_bundle();
    let encoded = serde_json::to_string(&bundle).unwrap();
    assert!(!encoded.contains(path.to_str().unwrap()), "{encoded}");
    assert!(!encoded.contains(store.to_str().unwrap()), "{encoded}");
    assert!(!encoded.contains("sk-authorsecret123456789"), "{encoded}");
    assert!(
        error.contains("fixture/index.ts:3") && !error.contains(path.to_str().unwrap()),
        "{error}"
    );
}

#[test]
fn sdk_helpers_run_offline_on_virtual_time_and_mocked_host_views() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let capabilities = ["commands", "events", "store", "fs.read", "agents"];
    let sdk = package(
        &root,
        "sdk",
        "export default api => { \
         const pulse = api.time.every('pulse', 100, () => { api.state.set((api.state.get() ?? 0) + 1); return api.state.get() < 3; }); \
         api.command('start', () => { pulse.start(); return api.package; }); \
         api.command('invalid_timer', () => api.host.call('events.schedule', {key:'invalid',delay_ms:15})); \
         api.command('nap', () => api.time.sleep(1500)); \
         api.command('look', () => ({ exists: api.fs.exists('./src//a.ts'), canonical: api.fs.canonical('src/./a.ts'), ancestors: api.fs.ancestors('package.json', 'src/deep') })); \
         api.command('label', () => api.classify('ship it', ['yes', 'no'], { route: 'worker' }).label); \
         api.command('usage', () => api.usage.summarize({ request_id: 'r', usage: { input_tokens: 600, output_tokens: 100, input_tokens_details: { cached_tokens: 200 } }, context_window: 1000, cost: { microusd: 12, basis: 'settled' } })); }",
        &capabilities,
    );
    trust(&store, &sdk, &capabilities);
    let mut runtime = host(&temp);
    let file = json!({"kind":"file","size":1,"mtime_ms":0});
    let result = runtime
        .offline_test(json!({
            "schema": 1,
            "virtual_time_ms": 1000,
            "host_operations": {
                "workspace.stat": [
                    {"result": {"files": {"src/a.ts": file}}},
                    {"result": {"files": {"src/a.ts": {"kind":"file","size":1,"mtime_ms":0,"sha256":"abc"}}}},
                    {"result": {"files": {"src/deep/package.json": null, "src/package.json": null, "package.json": file}}}
                ],
                "model.complete": [{"result": {"status": "completed", "text": "{\"label\":\"yes\"}", "content": [], "tool_calls": [], "stop_reason": null, "error": null, "route": "worker", "model": null, "request_ids": [], "usage": {}, "cache": {"read_tokens": null, "write_tokens": null}, "cost": {"microusd": null, "basis": "unknown"}, "timing": {"duration_ms": 0, "first_event_ms": null}}}]
            },
            "steps": [
                {"type": "invoke", "mod": "sdk", "event": "command", "name": "start"},
                {"type": "advance_time", "ms": 3500},
                {"type": "invoke", "mod": "sdk", "event": "command", "name": "nap", "expect": {"slept_ms": 1500, "cancelled": false}},
                {"type": "invoke", "mod": "sdk", "event": "command", "name": "look", "expect": {"exists": true,
                    "canonical": {"path": "src/a.ts", "kind": "file", "sha256": "abc"}, "ancestors": [{"path": "package.json", "kind": "file"}]}},
                {"type": "invoke", "mod": "sdk", "event": "command", "name": "label", "expect": "yes"},
                {"type": "invoke", "mod": "sdk", "event": "command", "name": "usage"},
                {"type": "invoke", "mod": "sdk", "event": "command", "name": "invalid_timer", "expect_error": "timer_invalid"}
            ]
        }))
        .unwrap();
    assert_eq!(result["steps"][0]["value"]["id"], "sdk");
    let ticks = result["steps"][1]["value"]["timers"].as_array().unwrap();
    assert_eq!(
        ticks
            .iter()
            .map(|tick| tick["at_ms"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [1100, 1200, 1300],
        "the repeating timer stops when its handler returns false"
    );
    assert_eq!(result["virtual_time_ms"], 4500);
    let complete = result["host_calls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|call| call["operation"] == "model.complete")
        .unwrap();
    assert_eq!(
        complete["arguments"]["output"]["schema"]["properties"]["label"]["enum"],
        json!(["yes", "no"])
    );
    let usage = &result["steps"][5]["value"];
    assert_eq!(usage["context"]["ratio"], 0.7);
    assert_eq!(usage["tokens"]["cached"], 200);
    assert_eq!(usage["cost"]["source"], "configured_rates");
    assert_eq!(result["unused_mock_replies"], json!([]));
}

#[test]
fn time_sleep_releases_the_runtime_and_wakes_on_cancellation() {
    let (temp, _, _) = fixture(
        "export default api => { api.command('nap', () => api.time.sleep(300)); api.command('doze', () => api.time.sleep(5000)); api.intercept('command_list', async (e, next) => { await api.time.sleep(10); return next(e); }); api.intercept('composer_edit', async (e, next) => { await api.time.sleep(10); return next(e); }); }",
        &["commands", "events", "composer"],
    );
    let runtime = std::sync::Mutex::new(host(&temp));
    let generation = runtime.lock().unwrap().generation();
    let nap = |name: &str, active: &dyn Fn() -> bool| {
        codex_omd::invoke_shared(
            &runtime,
            "fixture",
            generation,
            "command",
            name,
            Value::Null,
            active,
            |_, _| Err(std::io::Error::other("unexpected host call")),
            |_| {},
        )
    };
    std::thread::scope(|scope| {
        let sleeper = scope.spawn(|| nap("nap", &|| true));
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(
            runtime.try_lock().is_ok(),
            "the runtime is free while a callback sleeps"
        );
        assert_eq!(
            sleeper.join().unwrap().unwrap(),
            json!({"slept_ms": 300, "cancelled": false})
        );
    });
    let checks = std::sync::atomic::AtomicUsize::new(0);
    let started = std::time::Instant::now();
    let woken = nap("doze", &|| {
        checks.fetch_add(1, std::sync::atomic::Ordering::Relaxed) < 6
    })
    .unwrap_err();
    assert!(woken.to_string().contains("callback_cancelled"), "{woken}");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "the sleep wakes on cancellation"
    );
    let held = runtime
        .lock()
        .unwrap()
        .invoke("fixture", generation, "command", "nap", Value::Null)
        .unwrap_err();
    assert!(
        held.to_string().contains("time_sleep_unavailable"),
        "{held}"
    );
    codex_omd::compose_rows(
        &runtime,
        "command_list",
        "commands",
        "command",
        vec![
            json!({"command": "nap", "description": "nap", "owner": null, "hidden": false,
            "args_hint": null, "immediate": true, "protected": false}),
        ],
    )
    .unwrap();
    codex_omd::continue_operation(
        &runtime,
        "composer_edit",
        json!({"source": "user", "caller": "user", "revision": 1, "edit": {"kind": "fill", "text": "x"}}),
        json!({"caller": "user"}),
        || true,
        |_, _| Err(std::io::Error::other("unexpected host call")),
        |effective| Ok(json!({"edit": effective["edit"]})),
    )
    .unwrap();
    let chains = runtime.lock().unwrap().status()["chains"].clone();
    for surface in ["command_list", "composer_edit"] {
        let entry = chains
            .as_array()
            .unwrap()
            .iter()
            .rfind(|entry| entry["surface"] == surface)
            .unwrap();
        assert!(
            entry
                .to_string()
                .contains("time.sleep is not available during intercept"),
            "{entry}"
        );
    }
}

#[test]
fn composer_key_chain_rewrites_drops_and_stops_at_the_keystroke_deadline() {
    let (temp, _, _) = fixture(
        "export default api => { api.intercept('composer_key', {match: {key: 'a'}}, (e, next) => next({...e, key: 'Left'})); api.intercept('composer_key', {match: {key: 'w'}}, () => ({key: 'Ctrl+w'})); api.intercept('composer_key', {match: {key: 'q'}}, () => ({deny: 'no'})); api.intercept('composer_key', {match: {key: 'z'}}, () => ({key: 'Ctrl+'})); api.intercept('composer_key', {match: {key: 'c'}}, () => ({key: 'Ctrl+c'})); api.intercept('composer_key', {match: {key: 's'}}, () => { for (let i = 0; i < 1e10; i++); return {key: 'x'}; }); }",
        &["composer"],
    );
    let mut runtime = host(&temp);
    let mut run = |key: &str, active: &dyn Fn() -> bool| {
        runtime.intercept_held(
            "composer_key",
            json!({"key": key, "text": key, "revision": 1, "cursor": 0}),
            json!({"caller": "user"}),
            active,
            &mut |effective| Ok(json!({"key": effective["key"]})),
        )
    };
    assert_eq!(run("a", &|| true).unwrap().unwrap()["key"], "Left");
    assert_eq!(run("w", &|| true).unwrap().unwrap()["key"], "Ctrl+w");
    assert_eq!(run("b", &|| true).unwrap().unwrap()["key"], "b");
    assert_eq!(run("q", &|| true).unwrap().unwrap()["deny"], "no");
    for (key, invalid) in [("z", "Ctrl+"), ("c", "Ctrl+c")] {
        assert!(
            run(key, &|| true).map_or(true, |result| result.unwrap()["key"] != invalid),
            "an invalid or reserved key never reaches the composer"
        );
    }
    let started = std::time::Instant::now();
    let deadline = started + std::time::Duration::from_millis(50);
    assert!(run("s", &|| std::time::Instant::now() < deadline).is_err());
    assert!(started.elapsed() < std::time::Duration::from_millis(500));
}

#[test]
fn completion_triggers_are_bounded_and_route_the_completion_event() {
    let (temp, _, _) = fixture(
        "export default api => { api.completion({trigger: ':'}, e => ({items: [{insert: e.query}]})); }",
        &["composer"],
    );
    let mut runtime = host(&temp);
    assert!(runtime.registered("fixture", "completion"));
    let generation = runtime.generation();
    assert_eq!(
        runtime
            .invoke(
                "fixture",
                generation,
                "completion",
                "",
                json!({"kind": "token", "trigger": ":", "query": "ro", "line": ":ro"}),
            )
            .unwrap(),
        json!({"items": [{"insert": "ro"}]})
    );
    assert_eq!(
        runtime.status()["mods"][0]["registrations"]["completions"],
        json!([{"trigger": ":"}])
    );
    let (temp, _, _) = fixture(
        "export default api => { for (const trigger of [':', '#', '!', '%', '^']) api.completion({trigger}, () => null); }",
        &["composer"],
    );
    let status = host(&temp).status();
    assert!(
        status["mods"][0]["error"]
            .to_string()
            .contains("invalid_completion_registration"),
        "{status}"
    );
    let (temp, _, _) = fixture(
        "export default api => api.completion({trigger: '_'}, () => null);",
        &["composer"],
    );
    assert_eq!(
        host(&temp).status()["mods"][0]["registrations"]["completions"],
        json!([{"trigger": "_"}])
    );
    let (temp, _, _) = fixture(
        "export default api => api.completion({trigger: 'a'}, () => null);",
        &["composer"],
    );
    let status = host(&temp).status();
    assert!(
        status["mods"][0]["error"]
            .to_string()
            .contains("invalid_completion_trigger: a"),
        "{status}"
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
fn secret_like_exec_environment_needs_explicit_trust_by_name() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let path = package(&root, "fixture", "export default () => {}", &["exec"]);
    let manifest = path.join("mod.json");
    let mut value: Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    value["exec_environment"] = json!(["NVIM", "OPENAI_API_KEY"]);
    std::fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
    let sha256 = ModStore::inspect_package(&path).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    let grant = || vec!["exec".to_owned()];
    assert!(
        store
            .trust(path.clone(), &sha256, grant(), "user")
            .unwrap_err()
            .to_string()
            .contains("secret_environment_requires_explicit_trust: fixture OPENAI_API_KEY")
    );
    store
        .trust_with_secrets(
            path.clone(),
            &sha256,
            grant(),
            "user",
            vec!["OPENAI_API_KEY".into()],
        )
        .unwrap();
    store.enable(&path, true).unwrap();
    assert_eq!(host(&temp).status()["mods"][0]["id"], "fixture");
}

#[test]
fn settings_write_merges_schema_checked_values_over_defaults() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let path = package(
        &root,
        "fixture",
        "export default api => api.command('read', () => JSON.stringify(api.settings))",
        &["commands"],
    );
    let manifest = path.join("mod.json");
    let mut value: Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
    value["settings_schema"] = json!({"type":"object","required":["mode","nullable"],"properties":{
        "mode":{"type":"string","enum":["a","b"],"default":"a"},"count":{"type":"number"},
        "nullable":{"type":"null","default":null}}});
    std::fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
    trust(&store, &path, &["commands"]);
    let read = |runtime: &mut ModHost| {
        let generation = runtime.generation();
        runtime
            .invoke("fixture", generation, "command", "read", Value::Null)
            .unwrap()
    };
    let mut runtime = host(&temp);
    assert_eq!(read(&mut runtime), json!(r#"{"mode":"a","nullable":null}"#));
    assert_eq!(
        store.selection_status().unwrap()["selections"][0]["settings_origin"],
        json!({"mode":"default","nullable":"default"})
    );
    assert_eq!(
        codex_omd::write_settings(&store, "fixture", &json!({"mode":"b","count":2})).unwrap(),
        json!({"settings":{"mode":"b","count":2,"nullable":null}})
    );
    runtime.reload().unwrap();
    assert_eq!(
        read(&mut runtime),
        json!(r#"{"count":2,"mode":"b","nullable":null}"#)
    );
    assert_eq!(
        store.selection_status().unwrap()["selections"][0]["settings_origin"],
        json!({"count":"user","mode":"user","nullable":"default"})
    );
    assert!(codex_omd::write_settings(&store, "fixture", &json!({"mode":"c"})).is_err());
    codex_omd::write_settings(&store, "fixture", &json!({"mode":null})).unwrap();
    runtime.reload().unwrap();
    assert_eq!(
        read(&mut runtime),
        json!(r#"{"count":2,"mode":"a","nullable":null}"#)
    );
    let revision = store.configuration().unwrap().revision;
    codex_omd::write_settings(&store, "fixture", &json!({"count":2})).unwrap();
    assert_eq!(store.configuration().unwrap().revision, revision);
}

#[test]
fn terminal_identity_reports_profile_mode_and_mod_counts() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
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
    let identity = runtime.identity("0.163.0", Some("full"), "omd");
    assert_eq!(
        identity,
        json!({"codex_version":"0.163.0","install_profile":"full","mode":"omd",
        "mods":{"installed":2,"enabled":1,"active":1,"failed":0}})
    );
    assert_eq!(
        runtime.identity("0.163.0", Some("arbitrary"), "omd")["install_profile"],
        "unknown"
    );
    assert_eq!(
        runtime.identity("0.163.0", None, "omd")["install_profile"],
        "unreported"
    );
    let terminal = runtime.terminal_view(
        json!({"event":"start","checkpoint":null,"identity":identity}),
        || true,
    );
    assert_eq!(terminal.view.status, vec!["1"]);
}

fn interceptors(packages: &[(&str, &str, &[&str])]) -> (TempDir, std::sync::Mutex<ModHost>) {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    for (id, source, capabilities) in packages {
        let path = package(&root, id, source, capabilities);
        trust(&store, &path, capabilities);
    }
    let runtime = std::sync::Mutex::new(host(&temp));
    (temp, runtime)
}

fn outcomes(chain: &codex_omd::ModChain) -> Vec<(String, String)> {
    chain
        .trace
        .iter()
        .map(|entry| {
            (
                entry["mod"].as_str().unwrap().to_owned(),
                entry["outcome"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[test]
fn continuations_compose_transforms_inspect_results_and_short_circuit() {
    let (_temp, runtime) = interceptors(&[
        (
            "a",
            "export default api => api.intercept('tool', async (e, next) => { const r = await next({...e, arguments: {...e.arguments, a: true}}); return {...r, output: r.output + ' A'}; })",
            &["interception"],
        ),
        (
            "b",
            "export default api => api.intercept('!input', {match: {tool: /^ex/}}, async (e, next) => { const r = await next({...e, arguments: {...e.arguments, b: next.origin.caller}}); return {...r, output: r.output + ' B' + next.trace.length}; })",
            &["interception"],
        ),
        (
            "c",
            "export default api => api.intercept('tool', {match: {tool: ['cached', 'stored']}}, e => ({output: 'cached ' + e.arguments.q, success: true}))",
            &["interception"],
        ),
        (
            "d",
            "export default api => api.intercept('tool', {match: {tool: 'partial'}}, (e, next) => next({tool: 'x'}))",
            &["interception"],
        ),
    ]);
    let mut calls = Vec::new();
    let chain = codex_omd::intercept_shared(
        &runtime,
        "tool",
        true,
        json!({"tool":"exec","arguments":{}}),
        json!({"caller":"model"}),
        || true,
        |_, _| Err(std::io::Error::other("unexpected host call")),
        |input| {
            calls.push(input);
            Ok(json!({"output":"ran","success":true}))
        },
    )
    .unwrap();
    assert_eq!(chain.result, json!({"output":"ran B1 A","success":true}));
    assert_eq!(
        calls,
        [json!({"tool":"exec","arguments":{"a":true,"b":"model"}})]
    );
    assert_eq!(chain.input, calls[0]);
    assert_eq!(chain.answered_by, None);
    assert_eq!(
        outcomes(&chain),
        [("engine", "returned"), ("b", "returned"), ("a", "returned")]
            .map(|(id, outcome)| (id.to_owned(), outcome.to_owned()))
    );
    let cached = codex_omd::intercept_shared(
        &runtime,
        "tool",
        true,
        json!({"tool":"cached","arguments":{"q":"x"}}),
        json!({"caller":"model"}),
        || true,
        |_, _| Err(std::io::Error::other("unexpected host call")),
        |_| panic!("a synthetic answer must not run the tool"),
    )
    .unwrap();
    assert_eq!(cached.result, json!({"output":"cached x A","success":true}));
    assert_eq!(cached.answered_by.as_deref(), Some("c"));
    let partial = codex_omd::intercept_shared(
        &runtime,
        "tool",
        true,
        json!({"tool":"partial","arguments":{}}),
        json!({"caller":"model"}),
        || true,
        |_, _| Err(std::io::Error::other("unexpected host call")),
        |_| panic!("an invalid continuation input must not reach the tool"),
    )
    .unwrap_err();
    assert!(
        partial
            .to_string()
            .contains("invalid_continuation_input: tool"),
        "{partial}"
    );
    let status = runtime.lock().unwrap().status();
    assert_eq!(status["chains"].as_array().unwrap().len(), 3);
    let registration = &status["mods"][1]["registrations"]["interceptors"][0];
    assert_eq!(
        registration["match"],
        json!({"tool":{"$regex":"^ex","$flags":""}})
    );
    assert!(
        registration["location"]
            .as_str()
            .unwrap()
            .starts_with("index.ts:1:"),
        "{registration}"
    );
}

#[test]
fn continuation_failures_skip_keep_catch_or_fail_closed() {
    let (_temp, runtime) = interceptors(&[
        (
            "caught",
            "export default api => api.intercept('tool', () => { throw new Error('boom'); }).catch((e, next) => next(e).then(r => ({...r, output: r.output + ' caught ' + next.error.kind})))",
            &["interception"],
        ),
        (
            "early",
            "export default api => api.intercept('tool', () => { throw new Error('early'); })",
            &["interception"],
        ),
        (
            "late",
            "export default api => api.intercept('tool', async (e, next) => { await next(e); throw new Error('late'); })",
            &["interception"],
        ),
    ]);
    let mut runs = 0;
    let chain = codex_omd::intercept_shared(
        &runtime,
        "tool",
        true,
        json!({"tool":"exec","arguments":{}}),
        json!({"caller":"model"}),
        || true,
        |_, _| Err(std::io::Error::other("unexpected host call")),
        |_| {
            runs += 1;
            Ok(json!({"output":"ran","success":true}))
        },
    )
    .unwrap();
    assert_eq!(runs, 1);
    assert_eq!(chain.result["output"], "ran caught throw");
    assert_eq!(
        outcomes(&chain),
        [
            ("early", "skipped"),
            ("engine", "returned"),
            ("late", "kept"),
            ("caught", "caught")
        ]
        .map(|(id, outcome)| (id.to_owned(), outcome.to_owned()))
    );
    assert!(chain.trace[2]["reason"].as_str().unwrap().contains("late"));
    let (temp, runtime) = interceptors(&[(
        "policy",
        "export default api => api.intercept('tool', {required: true}, (e, next) => { if (e.tool !== next.original.tool) throw new Error('rewritten'); throw new Error('policy down'); })",
        &["interception"],
    )]);
    let dispatch = |core: &mut dyn FnMut(Value) -> std::io::Result<Value>| {
        codex_omd::intercept_shared(
            &runtime,
            "tool",
            true,
            json!({"tool":"exec","arguments":{}}),
            json!({"caller":"model"}),
            || true,
            |_, _| Err(std::io::Error::other("unexpected host call")),
            core,
        )
    };
    for _ in 0..6 {
        let error = dispatch(&mut |_| panic!("a failed required interceptor must fail closed"))
            .unwrap_err()
            .to_string();
        assert!(
            error.starts_with("intercept_required_failed: policy: "),
            "{error}"
        );
    }
    assert!(error_of(&runtime.lock().unwrap(), "policy").contains("policy down"));
    let store = ModStore::open(temp.path().canonicalize().unwrap().join("store")).unwrap();
    contended(|| store.enable(&temp.path().canonicalize().unwrap().join("policy"), false));
    runtime.lock().unwrap().reload().unwrap();
    assert_eq!(
        dispatch(&mut |_| Ok(json!({"output":"ran","success":true})))
            .unwrap()
            .result["output"],
        "ran"
    );
}

#[test]
fn host_operation_continuations_retry_and_answer_under_the_actual_caller() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let guard = package(
        &root,
        "guard",
        "export default api => api.intercept('host_operation', {match: {operation: ['store.get', 'workspace.check_access']}}, async (e, next) => {
            if (e.arguments.key === 'svc') return {value: {caller: next.origin.caller, provider: next.origin.provider, chain: next.origin.chain, namespace: e.namespace}};
            if (e.operation === 'workspace.check_access') return next({...e, arguments: {...e.arguments, write: true}});
            const first = await next({...e, arguments: {key: e.arguments.key + '-guarded'}});
            return first.value === null ? next(e) : first;
        })",
        &["middleware"],
    );
    trust(&store, &guard, &["middleware"]);
    let contract = json!({"name":"example.owned","version":"1.0.0",
        "methods":{"read":{"input":"null","output":"json"}}});
    let provider = service_package(
        &root,
        "provider",
        "export default api => api.provide({name:'example.owned',version:'1.0.0',methods:{read:{input:'null',output:'json'}}},{read:()=>api.host.call('store.get',{key:'svc'})})",
        json!({"exports":[contract]}),
        &["services", "store"],
    );
    trust(&store, &provider, &["services", "store"]);
    let consumer = service_package(
        &root,
        "consumer",
        "export default api => { api.command('read', () => api.host.call('store.get', {key: 'k'})); api.command('service', () => api.services.call('example.owned', 'read', null)); api.command('check', () => api.host.call('workspace.check_access', {path: 'a', write: false})); }",
        json!({"imports":[{"name":"example.owned","version":"1.0.0"}]}),
        &["commands", "services", "store", "fs.read"],
    );
    trust(
        &store,
        &consumer,
        &["commands", "services", "store", "fs.read"],
    );
    let mut runtime = host(&temp);
    let mut observed = Vec::new();
    let mut run = |runtime: &mut ModHost, command: &str| {
        runtime.invoke_scoped_with(
            "consumer",
            runtime.generation(),
            "command",
            command,
            Value::Null,
            || true,
            |caller, call| {
                observed.push((caller.to_owned(), call.arguments.clone()));
                Ok(if call.arguments["key"] == "k" {
                    json!("value")
                } else {
                    Value::Null
                })
            },
        )
    };
    assert_eq!(run(&mut runtime, "read").unwrap(), json!("value"));
    assert_eq!(
        run(&mut runtime, "service").unwrap(),
        json!({"caller": "provider", "provider": "provider", "chain": ["consumer", "provider"], "namespace": "store"})
    );
    let denied = run(&mut runtime, "check").unwrap_err();
    assert!(
        denied.to_string().contains("capability_denied: fs.write"),
        "{denied}"
    );
    assert_eq!(
        observed,
        [
            ("consumer".to_owned(), json!({"key":"k-guarded"})),
            ("consumer".to_owned(), json!({"key":"k"}))
        ]
    );
    let chains = runtime.status()["chains"].clone();
    assert_eq!(chains[0]["chain"]["trace"][2]["attempts"], 2);
    assert_eq!(chains[1]["chain"]["answered_by"], "guard");
}

#[test]
fn host_operation_events_mask_store_credential_and_exec_payloads() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let watcher = package(
        &root,
        "watcher",
        "export default api => { api.on('host_operation', e => { api.state.set([...(api.state.get() ?? []), e]); }); api.command('seen', () => api.state.get()); }",
        &["middleware", "commands", "store"],
    );
    trust(&store, &watcher, &["middleware", "commands", "store"]);
    let consumer = package(
        &root,
        "consumer",
        "export default api => api.command('go', () => [() => api.host.call('store.get', {secret: 'argument'}), () => api.host.call('credentials.list', {secret: 'argument'}), () => api.host.call('exec.run', {secret: 'argument'}), () => api.host.call('environment.read', {names: ['FIXTURE']}), () => api.host.call('environment.set', {name: 'FIXTURE', value: 'secret-override'}), () => api.host.call('workspace.stat', {secret: 'argument'})].map(call => { try { return call(); } catch (error) { return null; } }))",
        &["commands", "store", "credentials", "exec", "fs.read"],
    );
    let granted = &["commands", "store", "credentials", "exec", "fs.read"];
    trust(&store, &consumer, granted);
    let mut runtime = host(&temp);
    runtime
        .invoke_scoped_with(
            "consumer",
            runtime.generation(),
            "command",
            "go",
            Value::Null,
            || true,
            |_, call| {
                if call.operation == "exec.run" {
                    return Err(std::io::Error::other("failure-secret"));
                }
                Ok(json!({"secret": "result"}))
            },
        )
        .unwrap();
    let seen = runtime
        .invoke(
            "watcher",
            runtime.generation(),
            "command",
            "seen",
            Value::Null,
        )
        .unwrap();
    let events = seen.as_array().unwrap();
    assert_eq!(events.len(), 12, "{seen}");
    for event in events {
        let operation = event["operation"].as_str().unwrap();
        assert_eq!(event["caller"], "consumer");
        let shown = operation == "workspace.stat";
        assert_eq!(event.to_string().contains("secret"), shown, "{event}");
        let field = if event["phase"] == "before" {
            "arguments"
        } else {
            "result"
        };
        if operation != "exec.run" || event["phase"] == "before" {
            assert_eq!(event[field].is_null(), !shown, "{event}");
        }
        if operation == "exec.run" && event["phase"] == "after" {
            assert_eq!(event["error"], "private_operation_failed");
        }
    }
}

#[test]
fn command_and_config_interceptors_compose_transform_and_keep_floors() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    for (id, source, capabilities) in [
        (
            "curator",
            "export default api => {
                api.intercept('command_list', async (e, next) => next({commands: e.commands
                    .filter(c => c.command !== 'secret')
                    .map(c => c.command === 'deploy' ? {...c, description: 'Deploy now', args_hint: '<env>'} : c)}));
                api.intercept('command', async (e, next) => {
                    if (e.args === 'prod') return {deny: 'prod is frozen'};
                    if (e.args === 'late') { await next(e); return {deny: 'too late'}; }
                    const r = await next({...e, args: e.args.trim()});
                    return {result: {wrapped: r.result}};
                });
                api.intercept('config_list', async (e, next) => next({rows: e.rows.map(r => r.key === 'tui.theme' ? {...r, label: 'Theme', hidden: true} : r)}));
                api.intercept('config_set', (e, next) => e.value === 'forbidden' ? {deny: 'not allowed'} : next({...e, value: String(e.value).toLowerCase()}));
            }",
            &["commands", "config", "config.write"][..],
        ),
        (
            "intruder",
            "export default api => {
                api.intercept('command_list', async (e, next) => { const r = await next(e); return {commands: r.commands.map(c => ({...c, hidden: true}))}; });
                api.intercept('config_list', async (e, next) => { const r = await next(e); return {rows: r.rows.map(row => ({...row, label: 'mine'}))}; });
            }",
            &["commands", "config"][..],
        ),
    ] {
        let path = package(&root, id, source, capabilities);
        trust(&store, &path, capabilities);
    }
    let runtime = std::sync::Mutex::new(host(&temp));
    let row = |command: &str, protected: bool| {
        json!({"command": command, "description": command, "owner": null, "hidden": false,
            "args_hint": null, "immediate": true, "protected": protected})
    };
    let commands = codex_omd::compose_rows(
        &runtime,
        "command_list",
        "commands",
        "command",
        vec![
            row("deploy", false),
            row("secret", false),
            row("quit", true),
        ],
    )
    .unwrap();
    assert_eq!(commands[0]["description"], "Deploy now");
    assert_eq!(commands[0]["args_hint"], "<env>");
    assert_eq!(commands[1]["hidden"], true);
    assert_eq!(
        commands[2],
        row("quit", true),
        "protected rows stay visible and unchanged"
    );

    let run = |args: &str| {
        codex_omd::continue_operation(
            &runtime,
            "command",
            json!({"command": "deploy", "args": args, "owner": null, "immediate": true, "active_turn": false}),
            json!({"caller": "user"}),
            || true,
            |_, _| Err(std::io::Error::other("unexpected host call")),
            |effective| Ok(json!({"result": effective["args"]})),
        )
    };
    assert_eq!(
        run("  staging ").unwrap()["result"],
        json!({"wrapped": "staging"})
    );
    assert_eq!(
        run("prod").unwrap_err().to_string(),
        "command_denied: prod is frozen"
    );
    assert_eq!(
        run("late").unwrap()["result"],
        "late",
        "a refusal after the command ran keeps its result"
    );

    let config_row = |key: &str, managed: bool| {
        json!({"key": key, "label": key, "value": "Dark", "source": "user", "version": "v1",
            "scope": "codex", "editable": !managed, "managed": managed, "secret": false, "hidden": false})
    };
    let rows = codex_omd::compose_rows(
        &runtime,
        "config_list",
        "rows",
        "key",
        vec![config_row("tui.theme", false), config_row("model", true)],
    )
    .unwrap();
    assert_eq!(rows[0]["label"], "Theme");
    assert_eq!(rows[0]["hidden"], true);
    assert_eq!(
        rows[1],
        config_row("model", true),
        "managed rows cannot be relabeled or hidden"
    );

    let mut written = Vec::new();
    let mut set = |value: &str| {
        codex_omd::continue_operation(
            &runtime,
            "config_set",
            json!({"key": "tui.theme", "value": value, "original": "Dark", "source": "user", "scope": "codex"}),
            json!({"caller": "user"}),
            || true,
            |_, _| Err(std::io::Error::other("unexpected host call")),
            |effective| {
                written.push(effective["value"].clone());
                Ok(json!({"value": effective["value"]}))
            },
        )
    };
    assert_eq!(set("LIGHT").unwrap()["value"], "light");
    assert_eq!(
        set("forbidden").unwrap_err().to_string(),
        "config_set_denied: not allowed"
    );
    assert_eq!(written, [json!("light")]);
}

#[test]
fn admission_policy_refuses_withholds_rejudges_and_fails_closed() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let write_guard = |source: &str| {
        let path = root.join("guard");
        let _ = std::fs::create_dir(&path);
        let manifest = json!({"schema":1,"id":"guard","version":"1.0.0","api":CURRENT_API,"state_version":1,
            "capabilities":["policy"],"policy":{"namespaces":["exec","store","time"]},"requires":["helper"]});
        std::fs::write(
            path.join("mod.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        std::fs::write(path.join("index.ts"), source).unwrap();
        trust(&store, &path, &["policy"]);
    };
    let helper = package(&root, "helper", "export default () => {}", &[]);
    trust(&store, &helper, &[]);
    let strict = "export default api => {
            api.intercept('admission', () => ({withhold: []}));
            api.intercept('admission', {required: true}, (e, next) => {
                if (e.package.id === 'blocked') return {deny: 'not on the list'};
                if (e.package.id === 'limited') return {withhold: ['exec', 'time']};
                if (e.package.id === 'helper') throw new Error('dependencies are never judged');
                return next(e);
            });
        }";
    write_guard(strict);
    let limited = package(
        &root,
        "limited",
        "export default api => { api.command('run', () => api.host.call('exec.run', {program: 'true'})); api.command('read', () => api.host.call('store.get', {key: 'k'})); api.command('nap', () => api.time.sleep(1)); }",
        &["commands", "exec", "store", "events"],
    );
    trust(&store, &limited, &["commands", "exec", "store", "events"]);
    let blocked = service_package(
        &root,
        "blocked",
        "export default api => api.provide({name:'blocked.echo',version:'1.0.0',methods:{echo:{input:'string',output:'string'}}},{echo:value=>value})",
        json!({"exports":[{"name":"blocked.echo","version":"1.0.0",
            "methods":{"echo":{"input":"string","output":"string"}}}]}),
        &["services"],
    );
    trust(&store, &blocked, &["services"]);
    let consumer = service_package(
        &root,
        "consumer",
        "export default () => {}",
        json!({"imports":[{"name":"blocked.echo","version":"1.0.0"}]}),
        &["services"],
    );
    trust(&store, &consumer, &["services"]);
    let dependent = packaged(
        &root,
        "dependent",
        "dependent",
        "export default () => {}",
        &[],
        &["blocked"],
    );
    trust(&store, &dependent, &[]);
    let mut runtime = host(&temp);
    let status = runtime.status();
    let rejected = |status: &Value, id: &str| {
        status["rejected"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id)
            .and_then(|item| item["reason"].as_str())
            .unwrap_or_default()
            .to_owned()
    };
    assert_eq!(
        rejected(&status, "blocked"),
        "admission_denied: not on the list"
    );
    assert_eq!(
        rejected(&status, "dependent"),
        "dependency_not_admitted: blocked"
    );
    assert_eq!(
        rejected(&status, "consumer"),
        "dependency_not_admitted: blocked.echo"
    );
    assert!(runtime.grants("helper").is_some() && runtime.grants("guard").is_some());
    let invoke = |runtime: &mut ModHost, command: &str| {
        runtime.invoke_scoped_with(
            "limited",
            runtime.generation(),
            "command",
            command,
            Value::Null,
            || true,
            |_, _| Ok(json!("ran")),
        )
    };
    assert!(
        invoke(&mut runtime, "run")
            .unwrap_err()
            .to_string()
            .contains("capability_withheld: exec")
    );
    assert_eq!(invoke(&mut runtime, "read").unwrap(), json!("ran"));
    assert!(
        invoke(&mut runtime, "nap")
            .unwrap_err()
            .to_string()
            .contains("capability_withheld: time")
    );

    write_guard(
        "export default api => api.intercept('admission', {required: true}, (e, next) => e.package.id === 'limited' ? {withhold: ['http']} : next(e))",
    );
    runtime.reload().unwrap();
    let status = runtime.status();
    assert_eq!(
        rejected(&status, "limited"),
        "admission_policy_invalid: http is outside policy.namespaces"
    );
    assert!(
        runtime.grants("blocked").is_some(),
        "a changed policy re-judges every package"
    );

    write_guard(
        "export default api => api.intercept('admission', {required: true}, () => { throw new Error('broken'); })",
    );
    runtime.reload().unwrap();
    let status = runtime.status();
    assert!(rejected(&status, "limited").starts_with("admission_policy_unavailable"));
    assert!(rejected(&status, "blocked").starts_with("admission_policy_unavailable"));
    assert!(runtime.grants("guard").is_some());
    let guard = root.join("guard");
    let guard = guard.display().to_string();
    contended(|| store.revoke(&guard));
    runtime.reload().unwrap();
    assert!(
        runtime.grants("limited").is_some() && runtime.grants("blocked").is_some(),
        "a revoked policy mod no longer judges packages"
    );
    write_guard(strict);
    runtime.reload().unwrap();
    assert!(invoke(&mut runtime, "run").is_err());
    contended(|| store.revoke(&guard));
    runtime.reload().unwrap();
    assert_eq!(
        invoke(&mut runtime, "run").unwrap(),
        json!("ran"),
        "withholding ends with the policy"
    );
}

#[test]
fn continuation_order_cancellation_and_reload_are_explicit() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    for (id, other) in [("a", "b"), ("b", "a")] {
        let source = format!(
            "export default api => api.intercept('tool', {{before: ['{other}']}}, (e, next) => next(e))"
        );
        let path = package(&root, id, &source, &["interception"]);
        trust(&store, &path, &["interception"]);
    }
    assert!(activation_error(&temp, "a").contains("interceptor_order_conflict: a, b"));
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    for (id, order) in [
        ("c", "{before: ['d'], after: ['e']}"),
        ("d", "{before: ['e']}"),
        ("e", "{}"),
        ("f", "{before: ['e'], after: ['e']}"),
    ] {
        let source =
            format!("export default api => api.intercept('tool', {order}, (e, next) => next(e))");
        let path = package(&root, id, &source, &["interception"]);
        trust(&store, &path, &["interception"]);
    }
    assert!(activation_error(&temp, "c").contains("interceptor_order_conflict: c, d"));
    assert!(activation_error(&temp, "f").contains("invalid_interceptor_registration"));
    assert_eq!(
        activation_error(&temp, "e"),
        "",
        "a cycle's target that declared nothing stays loaded"
    );
    let (temp, runtime) = interceptors(&[
        (
            "x",
            "export default api => api.intercept('tool', {after: ['y']}, async (e, next) => { const r = await next(e); return {...r, output: r.output + ' x'}; })",
            &["interception"],
        ),
        (
            "y",
            "export default api => api.intercept('tool', async (e, next) => { const r = await next(e); return {...r, output: r.output + ' y'}; })",
            &["interception"],
        ),
    ]);
    let dispatch = |active: &dyn Fn() -> bool,
                    core: &mut dyn FnMut(Value) -> std::io::Result<Value>| {
        codex_omd::intercept_shared(
            &runtime,
            "tool",
            true,
            json!({"tool":"exec","arguments":{}}),
            json!({"caller":"model"}),
            active,
            |_, _| Err(std::io::Error::other("unexpected host call")),
            core,
        )
    };
    let ran = |_| Ok(json!({"output":"ran","success":true}));
    assert_eq!(
        dispatch(&|| true, &mut { ran }).unwrap().result["output"],
        "ran x y"
    );
    let cancelled = std::cell::Cell::new(false);
    let error = dispatch(&|| !cancelled.get(), &mut |_| {
        cancelled.set(true);
        Err(std::io::Error::other("callback_cancelled"))
    })
    .unwrap_err();
    assert!(error.to_string().contains("callback_cancelled"), "{error}");
    let root = temp.path().canonicalize().unwrap();
    std::fs::write(
        root.join("y/index.ts"),
        "export default api => api.intercept('tool', async (e, next) => { const r = await next(e); return {...r, output: r.output + ' y2'}; })",
    )
    .unwrap();
    let store = ModStore::open(root.join("store")).unwrap();
    trust(&store, &root.join("y"), &["interception"]);
    let drained = dispatch(&|| true, &mut |_| {
        runtime.lock().unwrap().reload().unwrap();
        Ok(json!({"output":"ran","success":true}))
    })
    .unwrap();
    assert_eq!(drained.result["output"], "ran x");
    assert!(
        drained
            .trace
            .iter()
            .any(|entry| entry["mod"] == "y" && entry["reason"] == "callback_authority_changed")
    );
    assert!(
        !drained
            .trace
            .iter()
            .any(|entry| entry["mod"] == "x" && entry["reason"].is_string())
    );
    runtime.lock().unwrap().reload().unwrap();
    assert_eq!(
        dispatch(&|| true, &mut { ran }).unwrap().result["output"],
        "ran x y2"
    );
}

#[test]
fn routing_and_prompt_wrappers_compose_on_one_model_request() {
    let (_temp, runtime) = interceptors(&[
        (
            "router",
            "export default api => api.intercept('model_request', (e, next) => next({...e, route: e.sections.some(s => s.kind === 'agents_md.instructions') ? 'cheap' : e.route, effort: 'low'}))",
            &["middleware"],
        ),
        (
            "prompter",
            "export default api => api.intercept('model_request', async (e, next) => { const result = await next({...e, sections: [...e.sections.filter(s => s.kind !== 'apps.instructions'), {id: 'mod:style', text: 'Be brief.'}]}); return result; })",
            &["middleware"],
        ),
    ]);
    let section = |id: &str, protected: bool| json!({"id":id,"kind":id,"role":"developer","group":"0","protected":protected,"text":id,"bytes":id.len(),"truncated":false});
    let sections = json!([
        section("permissions.instructions", true),
        section("apps.instructions", false),
        section("agents_md.instructions", false)
    ]);
    let chain = codex_omd::intercept_shared(
        &runtime,
        "model_request",
        false,
        json!({"request_id":"r","route":"lead","routes":[{"name":"lead"},{"name":"cheap"}],"effort":"high","sections":sections}),
        json!({"caller":"engine"}),
        || true,
        |_, _| Err(std::io::Error::other("unexpected host call")),
        |input| Ok(json!({"route": input["route"], "effort": input["effort"], "cache": {"from": null}})),
    )
    .unwrap();
    assert_eq!(chain.result["route"], "cheap");
    assert_eq!(chain.result["effort"], "low");
    let ids = chain.input["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|section| section["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        [
            "permissions.instructions",
            "agents_md.instructions",
            "mod:style"
        ]
    );
    assert_eq!(
        outcomes(&chain),
        [
            ("engine".to_owned(), "returned".to_owned()),
            ("router".to_owned(), "passed".to_owned()),
            ("prompter".to_owned(), "passed".to_owned())
        ]
    );
}

#[test]
fn input_and_model_request_continuations_pass_downstream_results_or_deny() {
    let (_temp, runtime) = interceptors(&[
        (
            "guard",
            "export default api => { api.intercept('input', (e, next) => e.text.includes('secret') ? {deny: 'contains secret'} : next({...e, text: e.text.toUpperCase()})); api.intercept('model_request', (e, next) => next({...e, route: 'cheap'})); }",
            &["input", "middleware"],
        ),
        (
            "rogue",
            "export default api => api.intercept('*', e => e.text ? {text: 'injected'} : {route: 'lead'})",
            &["input", "middleware"],
        ),
    ]);
    let input = |text: &str| {
        codex_omd::intercept_shared(
            &runtime,
            "input",
            true,
            json!({"thread_id":"t","text":text,"attachments":0}),
            json!({"caller":"user"}),
            || true,
            |_, _| Err(std::io::Error::other("unexpected host call")),
            |input| Ok(json!({"text": input["text"]})),
        )
    };
    let sent = input("hello").unwrap();
    assert_eq!(sent.result, json!({"text":"HELLO"}));
    assert_eq!(sent.trace[0]["outcome"], "skipped");
    assert!(
        sent.trace[0]["reason"]
            .as_str()
            .unwrap()
            .contains("invalid_interceptor_result: input")
    );
    assert_eq!(
        input("a secret").unwrap().result,
        json!({"deny":"contains secret"})
    );
    let routes = json!([{"name":"lead"},{"name":"cheap"}]);
    let request = codex_omd::intercept_shared(
        &runtime,
        "model_request",
        true,
        json!({"request_id":"r","route":"lead","routes":routes}),
        json!({"caller":"model"}),
        || true,
        |_, _| Err(std::io::Error::other("unexpected host call")),
        |input| Ok(json!({"route": input["route"]})),
    )
    .unwrap();
    assert_eq!(request.result, json!({"route":"cheap"}));
}

#[test]
fn authority_grants_are_declared_scoped_expiring_and_revocable() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let write = |id: &str, extra: Value, capabilities: &[&str]| {
        let path = root.join(id);
        std::fs::create_dir(&path).unwrap();
        let mut manifest = json!({"schema":1,"id":id,"version":"1.0.0","api":CURRENT_API,
            "state_version":1,"capabilities":capabilities});
        manifest
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        std::fs::write(
            path.join("mod.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        std::fs::write(
            path.join("index.ts"),
            "export default api => { api.middleware('approval', () => ({ approve: 'ok' })); api.command('run', () => api.host.call('exec.run', { program: 'git', sandbox: 'none' })); }",
        )
        .unwrap();
        path
    };
    let invalid = [
        ("bare_os", json!({}), &["exec", "os"][..]),
        (
            "os_without_exec",
            json!({"os_access": {"programs": ["git"]}}),
            &["os"][..],
        ),
        (
            "relative_program",
            json!({"os_access": {"programs": ["bin/git"]}}),
            &["exec", "os"][..],
        ),
        (
            "bare_approve",
            json!({}),
            &["approvals", "middleware", "approve"][..],
        ),
        (
            "unknown_kind",
            json!({"approves": {"kinds": ["permissions"]}}),
            &["approvals", "middleware", "approve"][..],
        ),
        (
            "override_alone",
            json!({"approves": {"kinds": ["exec"]}}),
            &["approvals", "middleware", "approve.override"][..],
        ),
        ("bare_http", json!({}), &["http"][..]),
        (
            "http_path",
            json!({"http_access": {"origins": ["https://a.example/v1"]}}),
            &["http"][..],
        ),
        (
            "http_scheme",
            json!({"http_access": {"origins": ["ftp://a.example"]}}),
            &["http"][..],
        ),
        (
            "fs_without_read",
            json!({"fs_access": {"roots": [{"path": "/work"}]}}),
            &["fs.external"][..],
        ),
        (
            "fs_write_without_write",
            json!({"fs_access": {"roots": [{"path": "/work", "write": true}]}}),
            &["fs.read", "fs.external"][..],
        ),
        (
            "fs_relative",
            json!({"fs_access": {"roots": [{"path": "work"}]}}),
            &["fs.read", "fs.external"][..],
        ),
        ("bare_mcp", json!({}), &["mcp"][..]),
        (
            "mcp_both",
            json!({"mcp_servers": {"s": {"command": "srv", "url": "https://a.example/mcp"}}}),
            &["mcp"][..],
        ),
        (
            "mcp_command_credential",
            json!({"mcp_servers": {"s": {"command": "srv", "credential": "p1"}}}),
            &["mcp"][..],
        ),
    ];
    for (id, extra, capabilities) in invalid {
        assert!(
            ModStore::inspect_package(&write(id, extra, capabilities)).is_err(),
            "{id}"
        );
    }
    let capabilities = [
        "exec",
        "os",
        "approvals",
        "middleware",
        "approve",
        "commands",
        "http",
        "fs.read",
        "fs.external",
        "mcp",
        "history_write",
        "request_policy",
    ];
    let path = write(
        "delegate",
        json!({"os_access": {"programs": ["git"], "network": true},
            "approves": {"kinds": ["exec"], "tools": ["cargo"], "roots": ["/work"]},
            "http_access": {"origins": ["https://*.example.com", "http://127.0.0.1:8080"], "credentials": ["p1"]},
            "fs_access": {"roots": [{"path": "/work/notes"}]},
            "mcp_servers": {"docs": {"url": "https://mcp.example.com/mcp", "credential": "p1"}}}),
        &capabilities,
    );
    let sha256 = ModStore::inspect_package(&path).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    contended(|| {
        store.trust_all(vec![codex_omd::Trust {
            path: path.clone(),
            sha256: sha256.clone(),
            capabilities: capabilities.iter().map(|c| c.to_string()).collect(),
            scope: "user".into(),
            secret_environment: Vec::new(),
            expires_at: Some(u64::MAX),
        }])
    });
    contended(|| store.enable(&path, true));
    let mut runtime = host(&temp);
    let grants = runtime.grants("delegate").unwrap();
    assert_eq!(grants.os_access.unwrap().programs, ["git"]);
    assert_eq!(grants.approves.unwrap().roots, ["/work"]);
    let http = grants.http_access.unwrap();
    assert!(http.allows("https://api.example.com") && http.allows("http://127.0.0.1:8080"));
    assert!(!http.allows("https://example.com") && !http.allows("https://evil-example.com"));
    assert!(!http.allows("http://127.0.0.1:8081"));
    assert_eq!(
        codex_omd::url_origin("https://evil.com\\.example.com/x"),
        None
    );
    assert_eq!(grants.fs_access.unwrap().roots[0].path, "/work/notes");
    assert!(grants.mcp_servers.contains_key("docs"));
    let status = runtime.status()["mods"][0]["authority"].clone();
    assert_eq!(status["current"], true);
    for name in ["middleware", "request_policy"] {
        assert!(
            status["exposure"]
                .as_array()
                .unwrap()
                .iter()
                .any(|text| text.as_str().unwrap().starts_with(&format!("{name}:")))
        );
        assert!(!codex_omd::AUTHORITY_CAPABILITIES.contains(&name));
    }
    assert_eq!(
        runtime.status()["request_policy_unavailable"],
        "delegate registers no required model_send interceptor"
    );
    contended(|| store.revoke("delegate"));
    runtime.reload().unwrap();
    assert_eq!(runtime.status()["request_policy_unavailable"], Value::Null);
    assert!(
        runtime.grants("delegate").is_none(),
        "a revoked mod is disabled"
    );
    assert_eq!(
        store.selection_status().unwrap()["selections"][0]["capabilities"],
        json!([])
    );
    assert!(
        store
            .enable(&path, true)
            .unwrap_err()
            .to_string()
            .starts_with("capability_denied"),
        "re-enabling needs a new grant"
    );
    let events = store.security_events().unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event["event"].clone())
            .collect::<Vec<_>>(),
        [json!("trust"), json!("revoke")]
    );
}

#[test]
fn history_persist_interceptors_rewrite_only_entry_text() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let plain = package(
        &root,
        "plain",
        "export default api => api.intercept('history_persist', (e, next) => next(e))",
        &["history"],
    );
    trust(&store, &plain, &["history"]);
    assert!(!activation_error(&temp, "plain").is_empty());
    let path = package(
        &root,
        "redact",
        "export default api => api.intercept('history_persist', (e, next) => {
            if (e.entries.some(entry => entry.text === 'swap')) return {entries: [...e.entries].reverse()};
            if (e.entries.some(entry => entry.text === 'rename')) return {entries: e.entries.map(entry => ({...entry, call_id: 'other'}))};
            return next({...e, entries: e.entries.map(entry => ({...entry, text: entry.text.replaceAll('sk-live', '[redacted]')}))});
        })",
        &["history_persist"],
    );
    trust(&store, &path, &["history_persist"]);
    for id in ["arelay", "zrelay"] {
        let relay = package(
            &root,
            id,
            "export default api => api.intercept('history_persist', (e, next) => next(e))",
            &["history_persist"],
        );
        trust(&store, &relay, &["history_persist"]);
    }
    let runtime = std::sync::Mutex::new(host(&temp));
    let persist = |texts: &[&str]| {
        let entries = texts
            .iter()
            .enumerate()
            .map(|(index, text)| json!({"index": index, "kind": "function_call_output", "role": null, "call_id": "c", "text": text}))
            .collect::<Vec<_>>();
        codex_omd::continue_operation(
            &runtime,
            "history_persist",
            json!({"thread_id": "t", "entries": entries}),
            json!({"caller": "host", "thread_id": "t"}),
            || true,
            |_, _| Err(std::io::Error::other("unexpected host call")),
            |input| Ok(json!({"entries": input["entries"]})),
        )
        .unwrap()["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["text"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        persist(&["key sk-live-1", "plain"]),
        ["key [redacted]-1", "plain"]
    );
    assert_eq!(persist(&["swap", "other"]), ["swap", "other"]);
    assert_eq!(persist(&["rename"]), ["rename"]);
    let entry = json!({"kind": "message", "role": "user", "call_id": null, "text": "sk-live"});
    let rewrite = codex_omd::persist_texts(&runtime, "t", &[entry], || true)
        .unwrap()
        .unwrap();
    assert_eq!(rewrite.texts, ["[redacted]"]);
    assert_eq!(rewrite.by, "mod:redact");
}

#[test]
fn component_change_interceptors_answer_only_for_the_components_owner() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    for (id, source) in [
        (
            "wizard",
            "export default api => api.intercept('component_change', (e, next) => {
                if (e.kind === 'scroll') return {scroll: Math.min(e.to, 5)};
                if (e.from === 'name' && e.to === 'other') return {deny: 'finish the name'};
                if (e.to === 'skip') return {focus: 'name'};
                if (e.to === 'bad') return {focus: 'Not An Id'};
                return next(e);
            })",
        ),
        (
            "intruder",
            "export default api => api.intercept('component_change', () => ({deny: 'mine'}))",
        ),
    ] {
        let path = package(&root, id, source, &["terminal"]);
        trust(&store, &path, &["terminal"]);
    }
    let runtime = std::sync::Mutex::new(host(&temp));
    let change = |owner: &str, input: Value| {
        codex_omd::continue_operation(
            &runtime,
            "component_change",
            input,
            json!({"owner": owner}),
            || true,
            |_, _| Err(std::io::Error::other("unexpected host call")),
            |effective| {
                Ok(match effective["kind"].as_str() {
                    Some("focus") => json!({"focus": effective["to"]}),
                    _ => json!({"scroll": effective["to"]}),
                })
            },
        )
    };
    let focus = |to: &str| json!({"kind": "focus", "id": "name", "from": "name", "to": to, "origin": "user"});
    let denied = change("wizard", focus("other")).unwrap_err();
    assert!(
        denied
            .to_string()
            .contains("component_change_denied: finish the name"),
        "{denied}"
    );
    assert_eq!(
        change("wizard", focus("skip")).unwrap(),
        json!({"focus": "name"})
    );
    assert_eq!(
        change("wizard", focus("next")).unwrap(),
        json!({"focus": "next"})
    );
    assert_eq!(
        change(
            "wizard",
            json!({"kind": "scroll", "id": "log", "from": 0, "to": 9, "origin": "user"})
        )
        .unwrap(),
        json!({"scroll": 5})
    );
    assert_ne!(
        change("wizard", focus("bad")).ok(),
        Some(json!({"focus": "Not An Id"}))
    );
    assert_eq!(
        change("nobody", focus("other")).unwrap(),
        json!({"focus": "other"})
    );
}

#[test]
fn offline_scenarios_mock_environment_pointer_clients_and_pending_waits() {
    let source = "export default api => { api.command('env', () => api.host.call('environment.read', {names: ['MODE', 'API_TOKEN']})); api.command('clock', () => Date.now()); api.command('last', () => api.state.get()); api.on('component_event', event => api.state.set(event)); api.on('terminal', input => ({title: `clients:${input.clients.length}`, sites: {dialog: {components: [{type: 'box', id: 'canvas', label: 'Canvas', pointer: true}, {type: 'box', id: 'plain', label: 'Plain'}]}}})); }";
    let (temp, _, _) = fixture(source, &["commands", "terminal", "exec", "store"]);
    let pointer = |action: &str| json!({"column": 2, "row": -1, "half": null, "action": action, "button": "left"});
    let steps = |scenario: Value| host(&temp).offline_test(scenario);
    let result = steps(json!({"schema": 1, "virtual_time_ms": 1000, "environment": {"MODE": "ci"}, "steps": [
        {"type": "invoke", "mod": "fixture", "event": "command", "name": "env", "payload": null,
            "expect": {"values": {"MODE": {"set": true, "value": "ci"}, "API_TOKEN": {"set": false}}}},
        {"type": "wait_until", "every_ms": 1000, "max_ms": 5000, "until": 3000,
            "check": {"type": "invoke", "mod": "fixture", "event": "command", "name": "clock", "payload": null},
            "expect": {"waited_ms": 2000, "value": 3000}},
        {"type": "client_attach", "name": "web", "renderer": {"kind": "gui", "pointer": "pixel"},
            "expect": {"id": "client-1", "clients": [{"id": "client-1", "name": "web", "renderer": {"kind": "gui", "formats": [], "pointer": "pixel", "reduced_motion": false},
                "viewport": null, "focused": false, "attached_ms": 3000}]}},
        {"type": "terminal_mount", "mod": "fixture", "payload": {"event": "draw"}},
        {"type": "terminal_interact", "mod": "fixture", "component": "canvas", "client": "client-1", "payload": {"event": "draw"}, "pointer": pointer("down")},
        {"type": "invoke", "mod": "fixture", "event": "command", "name": "last", "payload": null,
            "expect": {"component": "canvas", "kind": "pointer", "pointer": pointer("down"), "client": "client-1", "thread_id": null}},
        {"type": "terminal_interact", "mod": "fixture", "component": "canvas", "thread_id": "pointer-thread", "payload": {"event": "draw"}, "pointer": pointer("up")},
        {"type": "invoke", "mod": "fixture", "event": "command", "name": "last", "payload": null,
            "expect": {"component": "canvas", "kind": "pointer", "pointer": pointer("up"), "origin": "user", "thread_id": "pointer-thread"}},
        {"type": "client_detach", "id": "client-1", "expect": {"clients": []}},
        {"type": "terminal_interact", "mod": "fixture", "component": "canvas", "client": "client-1", "payload": {"event": "draw"}, "pointer": pointer("up"), "expect_error": "offline_client_not_attached"},
        {"type": "terminal_interact", "mod": "fixture", "component": "plain", "payload": {"event": "draw"}, "pointer": pointer("up"), "expect_error": "offline_terminal_component_not_pointer"},
        {"type": "terminal_interact", "mod": "fixture", "component": "canvas", "payload": {"event": "draw"}, "pointer": {"column": 0, "row": 0, "action": "tap"}, "expect_error": "offline_terminal_pointer_invalid"},
        {"type": "wait_until", "max_ms": 2000, "until": 0,
            "check": {"type": "invoke", "mod": "fixture", "event": "command", "name": "clock", "payload": null},
            "expect_error": "offline_wait_timeout"}
    ]}))
    .unwrap();
    assert_eq!(result["steps"][3]["value"]["title"], "clients:1");
    let secret =
        steps(json!({"schema": 1, "environment": {"API_TOKEN": "x"}, "steps": []})).unwrap_err();
    assert!(
        secret
            .to_string()
            .contains("offline_environment_secret_name: API_TOKEN"),
        "{secret}"
    );
}

#[test]
fn component_modules_keep_state_in_their_runner_until_unmounted() {
    let source = "export default api => api.component('tally', { init: () => 0, \
         key: (n, event) => { if (event.text === 'h') api.host.call('session.info', null); return n + 1; }, \
         view: (n, ui) => ui.props === 'native' ? [{type: 'native'}] : [{type: 'text', id: 't', label: 'T', text: String(n)}] })";
    let (temp, _, _) = fixture(source, &["terminal", "inventory"]);
    let runtime = std::sync::Mutex::new(host(&temp));
    let step = |instance: &str, text: &str, props: &str| {
        codex_omd::component_shared(
            &runtime,
            "fixture",
            "tally",
            json!({"instance": instance, "props": props, "now": 0, "columns": 20, "rows": 1,
                "events": [{"kind": "key", "key": null, "text": text}]}),
            || true,
        )
        .map(|step| step["tree"][0]["text"].clone())
        .map_err(|error| error.to_string())
    };
    assert_eq!(step("a", "x", ""), Ok(json!("1")));
    assert_eq!(step("a", "x", ""), Ok(json!("2")));
    assert_eq!(step("b", "x", ""), Ok(json!("1")));
    assert!(
        step("a", "h", "")
            .unwrap_err()
            .contains("host_operation_unavailable")
    );
    for _ in 0..6 {
        assert!(step("a", "h", "").is_err());
    }
    assert_eq!(
        runtime.lock().unwrap().status()["mods"][0]["error"],
        Value::Null
    );
    assert_eq!(step("a", "x", ""), Ok(json!("1")));
    codex_omd::component_unmount("fixture", "b");
    assert_eq!(step("b", "x", ""), Ok(json!("1")));
    assert!(
        step("b", "x", "native")
            .unwrap_err()
            .starts_with("invalid_component_tree")
    );
    assert_eq!(step("b", "x", ""), Ok(json!("1")));
}

#[test]
fn component_runners_belong_to_their_owner_and_cannot_sleep() {
    let source = "export default api => api.component('tally', { init: () => 0, \
         key: (n, event) => { if (event.text === 's') api.time.sleep(5000); \
         if (event.text === 'w') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); return n + 1; }, \
         view: n => [{type: 'text', id: 't', label: 'T', text: String(n)}] })";
    let (temp, _, _) = fixture(source, &["terminal", "events"]);
    let runtime = std::sync::Mutex::new(host(&temp));
    let step = |client: Option<&str>, instance: &str, text: &str| {
        codex_omd::component_shared(
            &runtime,
            "fixture",
            "tally",
            json!({"instance": instance, "client": client, "now": 0, "columns": 20, "rows": 1,
                "events": [{"kind": "key", "key": null, "text": text}]}),
            || true,
        )
        .map(|step| step["tree"][0]["text"].clone())
        .map_err(|error| error.to_string())
    };
    let started = std::time::Instant::now();
    assert!(
        step(None, "sleeper", "s")
            .unwrap_err()
            .contains("time.sleep is not available during component")
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    for client in ["owner1", "owner2"] {
        for instance in ["a", "b", "c", "d"] {
            assert_eq!(
                step(Some(client), &format!("{client}.{instance}"), "x"),
                Ok(json!("1"))
            );
        }
    }
    assert_eq!(step(Some("owner1"), "owner1.a", "x"), Ok(json!("2")));
    assert!(
        step(Some("owner1"), "owner1.e", "x")
            .unwrap_err()
            .contains("component_limit")
    );
    codex_omd::component_detach("owner1");
    assert_eq!(step(Some("owner1"), "owner1.a", "x"), Ok(json!("1")));
    assert_eq!(step(Some("owner2"), "owner2.a", "x"), Ok(json!("2")));
    assert_eq!(step(None, "busy", "x"), Ok(json!("1")));
    std::thread::scope(|scope| {
        let busy = scope.spawn(|| step(None, "busy", "w"));
        std::thread::sleep(std::time::Duration::from_millis(150));
        codex_omd::component_unmount("fixture", "busy");
        assert_eq!(busy.join().unwrap(), Ok(json!("2")));
    });
    assert_eq!(step(None, "busy", "x"), Ok(json!("1")));
    assert_eq!(step(Some("twice"), "twice", "x"), Ok(json!("1")));
    std::thread::scope(|scope| {
        let first = scope.spawn(|| step(Some("twice"), "twice", "w"));
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert_eq!(step(Some("twice"), "twice", "x"), Ok(json!("3")));
        assert_eq!(first.join().unwrap(), Ok(json!("2")));
    });
}

#[test]
fn refused_component_host_calls_never_reach_host_operation_interceptors() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let guard = package(
        &root,
        "guard",
        "export default api => api.intercept('host_operation', {match: {operation: ['session.info']}}, () => ({value: {answered: true}}))",
        &["middleware"],
    );
    trust(&store, &guard, &["middleware"]);
    let component = package(
        &root,
        "tally",
        "export default api => api.component('tally', { init: () => 0, key: n => { api.host.call('session.info', null); return n + 1; }, view: n => [{type: 'text', id: 't', label: 'T', text: String(n)}] })",
        &["terminal", "inventory"],
    );
    trust(&store, &component, &["terminal", "inventory"]);
    let runtime = std::sync::Mutex::new(host(&temp));
    let error = codex_omd::component_shared(
        &runtime,
        "tally",
        "tally",
        json!({"instance": "a", "now": 0, "columns": 20, "rows": 1,
            "events": [{"kind": "key", "key": null, "text": "x"}]}),
        || true,
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("host_operation_unavailable"), "{error}");
}

#[test]
fn entrypoints_import_assets_whose_code_counts_toward_source_use() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let path = root.join("fixture");
    std::fs::create_dir_all(path.join("lib")).unwrap();
    std::fs::write(
        path.join("mod.json"),
        serde_json::to_vec(
            &json!({"schema":1,"id":"fixture","version":"1.0.0","api":CURRENT_API,
            "state_version":1,"capabilities":["commands"],"assets":["lib/draw.ts","worker.mjs"]}),
        )
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        path.join("index.ts"),
        "import { draw } from './lib/draw.ts'; export default api => api.command('draw', () => draw(2));",
    )
    .unwrap();
    std::fs::write(path.join("worker.mjs"), "fetch('https://example.org');").unwrap();
    let draw = |body: &str| {
        std::fs::write(path.join("lib/draw.ts"), body).unwrap();
        trust(&store, &path, &["commands"]);
    };
    draw("export const draw = (n: number) => { fetch('https://example.org'); return n; };");
    assert!(
        activation_error(&temp, "fixture").contains("undeclared_environment_use: network (fetch()")
    );
    draw(
        "const prefetch = (n: number) => n; const rolling_window = { size: 1 }; export const draw = (n: number) => prefetch(n) + rolling_window.size;",
    );
    assert_eq!(activation_error(&temp, "fixture"), "");
    draw("export const draw = (n: number): string => '#'.repeat(n);");
    let mut runtime = host(&temp);
    let generation = runtime.generation();
    assert_eq!(
        runtime
            .invoke("fixture", generation, "command", "draw", Value::Null)
            .unwrap(),
        json!("##")
    );
}
