use codex_omd::MOD_API_VERSION;
const CURRENT_API: &str = MOD_API_VERSION;
use codex_omd::ModHost;
use codex_omd::ModStore;
use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::path::PathBuf;
use tempfile::TempDir;

fn node() -> PathBuf {
    PathBuf::from(
        std::env::var_os("OMD_TEST_NODE")
            .expect("set OMD_TEST_NODE to Node 24.18.0; sandbox tests must actually execute"),
    )
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

fn written(root: &Path, id: &str, source: &str, capabilities: &[&str], extra: Value) -> PathBuf {
    let path = root.join(id);
    if !path.exists() {
        std::fs::create_dir(&path).unwrap();
    }
    let mut manifest = json!({"schema":1,"id":id,"version":"1.0.0",
        "api":CURRENT_API,"state_version":1,"capabilities":capabilities});
    for (key, value) in extra.as_object().into_iter().flatten() {
        manifest[key] = value.clone();
    }
    std::fs::write(
        path.join("mod.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(path.join("index.ts"), source).unwrap();
    path
}

fn trust(store: &ModStore, path: &Path, capabilities: &[&str]) {
    let inspected = ModStore::inspect_package(path).unwrap();
    let granted: Vec<String> = capabilities.iter().map(|value| value.to_string()).collect();
    let sha256 = inspected["sha256"].as_str().unwrap().to_owned();
    contended(|| store.trust(path.to_path_buf(), &sha256, granted.clone(), "user"));
    contended(|| store.enable(path, true));
}

fn host(temp: &TempDir) -> ModHost {
    ModHost::open(temp.path().canonicalize().unwrap().join("store")).unwrap()
}

fn workspace(temp: &TempDir) -> (PathBuf, ModStore) {
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    (root, store)
}

fn error_of(runtime: &ModHost, id: &str) -> String {
    runtime.status()["mods"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == id)
        .and_then(|entry| entry["error"].as_str())
        .unwrap_or_default()
        .to_string()
}

fn active(runtime: &ModHost) -> Vec<String> {
    runtime.status()["order"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_owned())
        .collect()
}

fn tool(name: &str) -> String {
    format!(
        "export default api => api.tool({{name:'{name}',description:'{name}',parameters:{{type:'object',properties:{{}}}}}}, () => null)"
    )
}

fn echo_contract(version: &str) -> Value {
    json!({"name":"shared.echo","version":version,
        "methods":{"echo":{"input":"string","output":"string"}}})
}

#[test]
fn colliding_tool_slots_and_contested_replacements_disable_only_the_claimants() {
    let temp = TempDir::new().unwrap();
    let (root, store) = workspace(&temp);
    let alpha = written(&root, "alpha", &tool("beta_run"), &["tools"], json!({}));
    let alpha_beta = written(&root, "alpha_beta", &tool("run"), &["tools"], json!({}));
    let view = |threshold: u32| {
        format!("export default api => api.replace('compaction', () => {threshold})")
    };
    let first_ui = written(&root, "first_ui", &view(1000), &["compaction"], json!({}));
    let second_ui = written(&root, "second_ui", &view(2000), &["compaction"], json!({}));
    let helper = written(
        &root,
        "helper",
        "export default api => { api.tool({name:'run',description:'run',parameters:{type:'object',properties:{}}}, () => null); api.command('ping', () => 'pong'); }",
        &["tools", "commands"],
        json!({}),
    );
    for (path, capabilities) in [
        (&alpha, &["tools"][..]),
        (&alpha_beta, &["tools"][..]),
        (&first_ui, &["compaction"][..]),
        (&second_ui, &["compaction"][..]),
        (&helper, &["tools", "commands"][..]),
    ] {
        trust(&store, path, capabilities);
    }

    let mut runtime = host(&temp);
    for id in ["alpha", "alpha_beta"] {
        assert!(
            error_of(&runtime, id).contains("tool_name_conflict: mod_alpha_beta_run"),
            "{id}: {}",
            error_of(&runtime, id)
        );
    }
    for id in ["first_ui", "second_ui"] {
        assert!(
            error_of(&runtime, id).contains("replacement_conflict: compaction"),
            "{id}: {}",
            error_of(&runtime, id)
        );
    }
    assert_eq!(active(&runtime), ["helper"]);
    assert_eq!(runtime.replacement_owner("compaction"), None);
    let slots: Vec<String> = runtime
        .tools()
        .into_iter()
        .map(|(id, _, tool)| format!("mod_{id}_{}", tool.name))
        .collect();
    assert_eq!(slots, ["mod_helper_run"]);
    assert_eq!(
        runtime
            .invoke(
                "helper",
                runtime.generation(),
                "command",
                "ping",
                Value::Null
            )
            .unwrap(),
        json!("pong")
    );
}

#[test]
fn terminal_patches_bind_keys_that_may_target_another_mods_command() {
    let temp = TempDir::new().unwrap();
    let (root, store) = workspace(&temp);
    let ui = written(
        &root,
        "ui",
        "export default api => api.on('terminal', ({event}) => event === 'reserved' ? ({keybindings:{'Ctrl+c':'ignore'}}) : ({title:'Workspace',keybindings:{'F6':{command:'helper:ping'},'F7':{command:'ping'},'Alt+x':{insert:'note'}}}))",
        &["terminal"],
        json!({}),
    );
    let helper = written(
        &root,
        "helper",
        "export default api => api.command('ping', () => 'pong')",
        &["commands"],
        json!({}),
    );
    let observer = written(
        &root,
        "observer",
        "export default api => api.on('turn_start', () => null)",
        &["lifecycle"],
        json!({}),
    );
    trust(&store, &ui, &["terminal"]);
    trust(&store, &helper, &["commands"]);
    trust(&store, &observer, &["lifecycle"]);

    let mut runtime = host(&temp);
    let drawn = runtime.event("terminal", json!({"event":"draw","checkpoint":null}));
    assert_eq!(drawn.len(), 1);
    let view = codex_omd::ModView::parse(drawn[0].1.as_ref().unwrap().clone()).unwrap();
    assert_eq!(
        view.keybindings["F6"],
        codex_omd::ModKeyAction::Command {
            command: "helper:ping".into(),
            args: String::new()
        }
    );
    assert_eq!(
        view.keybindings["F7"],
        codex_omd::ModKeyAction::Command {
            command: "ping".into(),
            args: String::new()
        }
    );
    let commands: Vec<(String, String)> = runtime
        .commands()
        .into_iter()
        .map(|(id, command)| (id, command.name))
        .collect();
    assert_eq!(commands, [("helper".to_string(), "ping".to_string())]);
    assert_eq!(
        runtime
            .invoke(
                "helper",
                runtime.generation(),
                "command",
                "ping",
                Value::Null
            )
            .unwrap(),
        json!("pong")
    );
    let reserved = runtime.terminal_view(json!({"event":"reserved","checkpoint":null}), || true);
    assert!(
        reserved
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("invalid_terminal_patch")),
        "{:?}",
        reserved.diagnostics
    );
}

#[test]
fn disabling_a_shared_service_provider_stops_only_its_required_consumer() {
    let temp = TempDir::new().unwrap();
    let (root, store) = workspace(&temp);
    let provider = written(
        &root,
        "provider",
        "export default api => api.provide({name:'shared.echo',version:'1.0.0',methods:{echo:{input:'string',output:'string'}}},{echo:value=>'provider:'+value})",
        &["services"],
        json!({"services":{"exports":[echo_contract("1.0.0")]}}),
    );
    let required = written(
        &root,
        "required",
        "export default api => api.command('call', () => api.services.call('shared.echo','echo','hello'))",
        &["commands", "services"],
        json!({"services":{"imports":[{"name":"shared.echo","version":"^1.0.0"}]}}),
    );
    let optional = written(
        &root,
        "optional",
        "export default api => api.command('probe', () => { try { return api.services.call('shared.echo','echo','hello') } catch (error) { if (error instanceof Error) return String(error); throw error } })",
        &["commands", "services"],
        json!({"services":{"imports":[{"name":"shared.echo","version":"^1.0.0","optional":true}]}}),
    );
    let observer = written(
        &root,
        "observer",
        "export default api => api.on('context', () => ({text:'observer'}))",
        &["context"],
        json!({}),
    );
    trust(&store, &provider, &["services"]);
    trust(&store, &required, &["commands", "services"]);
    trust(&store, &optional, &["commands", "services"]);
    trust(&store, &observer, &["context"]);

    let mut runtime = host(&temp);
    let call = |runtime: &mut ModHost, id: &str, command: &str| {
        let generation = runtime.generation();
        runtime
            .invoke(id, generation, "command", command, Value::Null)
            .unwrap()
    };
    assert_eq!(
        call(&mut runtime, "required", "call"),
        json!("provider:hello")
    );
    assert_eq!(
        call(&mut runtime, "optional", "probe"),
        json!("provider:hello")
    );
    let types = root.join("store/installed-contracts.d.ts");
    assert!(
        std::fs::read_to_string(&types)
            .unwrap()
            .contains("'shared.echo@1.0.0'")
    );

    contended(|| store.enable(&provider, false));
    assert!(
        runtime
            .reload()
            .unwrap_err()
            .to_string()
            .contains("service_provider_missing: required requires shared.echo")
    );

    let mut reopened = host(&temp);
    assert!(
        error_of(&reopened, "required")
            .contains("service_provider_missing: required requires shared.echo"),
        "{}",
        error_of(&reopened, "required")
    );
    assert_eq!(active(&reopened), ["observer", "optional"]);
    assert!(
        call(&mut reopened, "optional", "probe")
            .as_str()
            .unwrap()
            .contains("optional_service_unavailable")
    );
    assert_eq!(
        reopened.event("context", Value::Null)[0]
            .1
            .as_ref()
            .unwrap(),
        &json!({"text":"observer"})
    );
    assert!(
        !std::fs::read_to_string(&types)
            .unwrap()
            .contains("'shared.echo@1.0.0'")
    );

    contended(|| store.enable(&provider, true));
    let mut restored = host(&temp);
    assert_eq!(
        active(&restored),
        ["observer", "provider", "optional", "required"]
    );
    assert_eq!(
        call(&mut restored, "required", "call"),
        json!("provider:hello")
    );
    assert!(
        std::fs::read_to_string(&types)
            .unwrap()
            .contains("'shared.echo@1.0.0'")
    );
}

#[test]
fn reloading_during_streamed_work_keeps_the_inflight_generation_and_swaps_the_next_one() {
    let temp = TempDir::new().unwrap();
    let (root, store) = workspace(&temp);
    let middleware =
        |text: &str| format!("export default api => api.on('context', () => ({{text: '{text}'}}))");
    let stream = written(
        &root,
        "stream",
        &middleware("HELLO"),
        &["context"],
        json!({}),
    );
    let worker = written(
        &root,
        "worker",
        "export default api => api.tool({name:'work',description:'work',parameters:{type:'object',properties:{}}}, () => { api.progress('started'); const status = api.host.call('task.status', null); api.progress('finished'); return status; })",
        &["tools", "agents"],
        json!({}),
    );
    let ui = written(
        &root,
        "ui",
        "export default api => api.replace('compaction', () => 16000)",
        &["compaction"],
        json!({}),
    );
    trust(&store, &stream, &["context"]);
    trust(&store, &worker, &["tools", "agents"]);
    trust(&store, &ui, &["compaction"]);

    let mut runtime = host(&temp);
    let generation = runtime.generation();
    let text = |runtime: &mut codex_omd::ModHost| {
        runtime
            .event("context", json!({}))
            .into_iter()
            .find(|(id, _)| id == "stream")
            .unwrap()
            .1
            .unwrap()["text"]
            .clone()
    };
    assert_eq!(text(&mut runtime), json!("HELLO"));

    let mut updates = Vec::new();
    let value = runtime
        .invoke_streaming(
            "worker",
            generation,
            "tool",
            "work",
            json!({}),
            || true,
            |_| {
                std::fs::write(stream.join("index.ts"), middleware("hello!"))?;
                trust(&store, &stream, &["context"]);
                Ok(json!({"task":"running"}))
            },
            |update| updates.push(update),
        )
        .unwrap();
    assert_eq!(value, json!({"task":"running"}));
    assert_eq!(updates, ["started".to_string(), "finished".to_string()]);
    assert_eq!(text(&mut runtime), json!("HELLO"));

    assert!(runtime.reload().unwrap());
    assert_ne!(runtime.generation(), generation);
    assert_eq!(text(&mut runtime), json!("hello!"));
    assert!(
        runtime
            .invoke("worker", generation, "tool", "work", json!({}))
            .unwrap_err()
            .to_string()
            .contains("stale_mod_generation")
    );
    assert_eq!(
        runtime.replacement_owner("compaction").as_deref(),
        Some("ui")
    );
    assert_eq!(active(&runtime), ["stream", "ui", "worker"]);
}

#[test]
fn mods_share_the_event_pipeline_and_the_store_without_crossing_boundaries() {
    let temp = TempDir::new().unwrap();
    let (root, store) = workspace(&temp);
    let alpha = written(
        &root,
        "alpha",
        "export default api => { api.on('context', () => ({text:'alpha'})); api.command('count', () => { api.state.set(Number(api.state.get() ?? 0)+1); return api.state.get(); }); }",
        &["context", "commands", "store"],
        json!({}),
    );
    let beta = written(
        &root,
        "beta",
        "export default api => { api.on('context', () => { throw new Error('beta failed') }); api.command('count', () => { api.state.set(Number(api.state.get() ?? 0)+10); return api.state.get(); }); }",
        &["context", "commands", "store"],
        json!({}),
    );
    let gamma = written(
        &root,
        "gamma",
        "export default api => api.on('context', () => ({text:'x'.repeat(1025)}))",
        &["context"],
        json!({}),
    );
    trust(&store, &alpha, &["context", "commands", "store"]);
    trust(&store, &beta, &["context", "commands", "store"]);
    trust(&store, &gamma, &["context"]);

    let mut runtime = host(&temp);
    assert_eq!(active(&runtime), ["alpha", "beta", "gamma"]);
    let results = runtime.event("context", Value::Null);
    let observed: Vec<(String, String)> = results
        .iter()
        .map(|(id, result)| {
            (
                id.clone(),
                match result {
                    Ok(value) => value["text"].as_str().unwrap_or_default().to_owned(),
                    Err(error) => error.to_string(),
                },
            )
        })
        .collect();
    assert_eq!(observed[0], ("alpha".to_string(), "alpha".to_string()));
    assert!(observed[1].1.contains("beta failed"), "{:?}", observed[1]);
    assert!(observed[2].1.contains("context_limit"), "{:?}", observed[2]);
    for _ in 1..5 {
        runtime.event("context", Value::Null);
    }
    let remaining = runtime.event("context", Value::Null);
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].0, "alpha");
    assert_eq!(remaining[0].1.as_ref().unwrap(), &json!({"text":"alpha"}));

    let generation = runtime.generation();
    assert_eq!(
        runtime
            .invoke("alpha", generation, "command", "count", Value::Null)
            .unwrap(),
        json!(1)
    );
    assert!(
        runtime
            .invoke("beta", generation, "command", "count", Value::Null)
            .is_err()
    );
    let state = |id: &str| root.join(format!("store/state-{id}.json"));
    let stored: Value = serde_json::from_slice(&std::fs::read(state("alpha")).unwrap()).unwrap();
    assert_eq!(stored, json!({"schema":1,"version":1,"value":1}));
    assert!(!state("beta").exists());
    assert!(!state("gamma").exists());
}

#[test]
fn retired_pi_host_operations_are_rejected_before_activation() {
    let temp = TempDir::new().unwrap();
    let (root, store) = workspace(&temp);
    let reader = written(
        &root,
        "reader",
        "export default api => api.command('resources', () => api.host.call('pi.discover', null))",
        &["commands"],
        json!({}),
    );
    trust(&store, &reader, &["commands"]);
    let error = error_of(&host(&temp), "reader");
    assert!(
        error.contains("unsupported_host_operation: pi.discover"),
        "{error}"
    );
}
