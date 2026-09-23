use codex_omd::MOD_API_VERSION;
use codex_omd::ModHost;
use codex_omd::ModStore;
use codex_omd::OMD_HOST_RELEASE;
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
        "api":MOD_API_VERSION,"state_version":1,"capabilities":capabilities});
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
fn colliding_tool_slots_and_contested_terminal_owners_disable_only_the_claimants() {
    let temp = TempDir::new().unwrap();
    let (root, store) = workspace(&temp);
    let alpha = written(&root, "alpha", &tool("beta_run"), &["tools"], json!({}));
    let alpha_beta = written(&root, "alpha_beta", &tool("run"), &["tools"], json!({}));
    let view = |title: &str| {
        format!(
            "export default api => api.replace('terminal', () => ({{title:'{title}',keybindings:{{'F6':'draft'}}}}))"
        )
    };
    let first_ui = written(&root, "first_ui", &view("first"), &["terminal"], json!({}));
    let second_ui = written(
        &root,
        "second_ui",
        &view("second"),
        &["terminal"],
        json!({}),
    );
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
        (&first_ui, &["terminal"][..]),
        (&second_ui, &["terminal"][..]),
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
            error_of(&runtime, id).contains("replacement_conflict: terminal"),
            "{id}: {}",
            error_of(&runtime, id)
        );
    }
    assert_eq!(active(&runtime), ["helper"]);
    assert_eq!(runtime.replacement_owner("terminal"), None);
    assert!(
        runtime
            .event("terminal", json!({"event":"draw","checkpoint":null}))
            .is_empty()
    );
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
fn the_single_terminal_owner_binds_keys_that_may_target_another_mods_command() {
    let temp = TempDir::new().unwrap();
    let (root, store) = workspace(&temp);
    let ui = written(
        &root,
        "ui",
        "export default api => api.replace('terminal', ({event}) => event === 'reserved' ? ({keybindings:{'Ctrl+c':'ignore'}}) : ({title:'Workspace',keybindings:{'F6':{command:'helper:ping'},'F7':{command:'ping'},'Alt+x':{insert:'note'}}}))",
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
    assert_eq!(runtime.replacement_owner("terminal").as_deref(), Some("ui"));
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
    let reserved = runtime.event("terminal", json!({"event":"reserved","checkpoint":null}));
    assert!(
        reserved[0]
            .1
            .as_ref()
            .unwrap_err()
            .to_string()
            .contains("invalid_terminal_view")
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
    let middleware = |transform: &str| {
        format!(
            "export default api => api.middleware('response_stream', event => ({{text: {transform}}}))"
        )
    };
    let stream = written(
        &root,
        "stream",
        &middleware("String(event.text).toUpperCase()"),
        &["middleware"],
        json!({}),
    );
    let worker = written(
        &root,
        "worker",
        "export default api => api.tool({name:'work',description:'work',parameters:{type:'object',properties:{}}}, () => { api.progress('started'); const status = api.host.call('task.status', null); api.progress('finished'); return status; })",
        &["tools", "task"],
        json!({}),
    );
    let ui = written(
        &root,
        "ui",
        "export default api => api.replace('terminal', () => ({title:'Workspace'}))",
        &["terminal"],
        json!({}),
    );
    trust(&store, &stream, &["middleware"]);
    trust(&store, &worker, &["tools", "task"]);
    trust(&store, &ui, &["terminal"]);

    let mut runtime = host(&temp);
    let generation = runtime.generation();
    let delta = json!({"kind":"response.output_text.delta","raw_sha256":"00","raw_usage":null,
        "opaque_reasoning":false,"protected":false,"text":"hello"});
    assert_eq!(
        runtime.response_stream(delta.clone(), || true).unwrap()["effective"],
        json!("HELLO")
    );

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
                std::fs::write(
                    stream.join("index.ts"),
                    middleware("String(event.text)+'!'"),
                )?;
                trust(&store, &stream, &["middleware"]);
                Ok(json!({"task":"running"}))
            },
            |update| updates.push(update),
        )
        .unwrap();
    assert_eq!(value, json!({"task":"running"}));
    assert_eq!(updates, ["started".to_string(), "finished".to_string()]);
    assert_eq!(
        runtime.response_stream(delta.clone(), || true).unwrap()["effective"],
        json!("HELLO")
    );

    assert!(runtime.reload().unwrap());
    assert_ne!(runtime.generation(), generation);
    assert_eq!(
        runtime.response_stream(delta, || true).unwrap()["effective"],
        json!("hello!")
    );
    assert!(
        runtime
            .invoke("worker", generation, "tool", "work", json!({}))
            .unwrap_err()
            .to_string()
            .contains("stale_mod_generation")
    );
    assert_eq!(runtime.replacement_owner("terminal").as_deref(), Some("ui"));
    assert_eq!(active(&runtime), ["stream", "ui", "worker"]);
}

#[test]
fn mixed_api_mods_share_one_host_and_upgrade_independently() {
    let temp = TempDir::new().unwrap();
    let (root, store) = workspace(&temp);
    let ping = "export default api => api.command('ping', () => api.version)";
    let legacy = written(
        &root,
        "legacy",
        ping,
        &["commands"],
        json!({"api":"0.1.0-experimental.4"}),
    );
    let middle = written(
        &root,
        "middle",
        ping,
        &["commands"],
        json!({"api":"0.1.0-experimental.5",
            "compatibility":{"required_features":["transactional_reload_v1"],
                "optional_features":["future_optional_v1"]}}),
    );
    let current = written(
        &root,
        "current",
        "export default api => api.command('count', () => { api.state.set(Number(api.state.get() ?? 0)+1); return api.state.get(); })",
        &["commands", "state"],
        json!({"compatibility":{"releases":[OMD_HOST_RELEASE]}}),
    );
    trust(&store, &legacy, &["commands"]);
    trust(&store, &middle, &["commands"]);
    trust(&store, &current, &["commands", "state"]);

    let mut runtime = host(&temp);
    assert_eq!(active(&runtime), ["current", "legacy", "middle"]);
    let stability = |runtime: &ModHost, id: &str| {
        runtime.status()["mods"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == id)
            .map(|entry| {
                (
                    entry["api"].as_str().unwrap().to_owned(),
                    entry["api_stability"].as_str().unwrap().to_owned(),
                )
            })
            .unwrap()
    };
    assert_eq!(
        stability(&runtime, "legacy"),
        ("0.1.0-experimental.4".to_string(), "deprecated".to_string())
    );
    assert_eq!(
        stability(&runtime, "middle"),
        (
            "0.1.0-experimental.5".to_string(),
            "experimental".to_string()
        )
    );
    assert_eq!(
        stability(&runtime, "current"),
        (MOD_API_VERSION.to_string(), "experimental".to_string())
    );
    let generation = runtime.generation();
    for id in ["legacy", "middle"] {
        assert_eq!(
            runtime
                .invoke(id, generation, "command", "ping", Value::Null)
                .unwrap(),
            json!(MOD_API_VERSION)
        );
    }
    assert_eq!(
        runtime
            .invoke("current", generation, "command", "count", Value::Null)
            .unwrap(),
        json!(1)
    );

    let elsewhere = written(
        &root,
        "elsewhere",
        ping,
        &["commands"],
        json!({"compatibility":{"releases":["0.0.9"]}}),
    );
    let refused = ModStore::inspect_package(&elsewhere)
        .unwrap_err()
        .to_string();
    assert!(
        refused.contains("this host is") && refused.contains(OMD_HOST_RELEASE),
        "{refused}"
    );

    written(
        &root,
        "current",
        "export default api => { api.on('migrate', ({from,to}) => api.state.set({count:api.state.get(),from,to})); api.command('count', () => api.state.get()); }",
        &["commands", "state"],
        json!({"state_version":2}),
    );
    trust(&store, &current, &["commands", "state"]);
    assert!(
        runtime
            .reload()
            .unwrap_err()
            .to_string()
            .contains("state_migration_required")
    );

    let mut upgraded = host(&temp);
    assert!(
        error_of(&upgraded, "current").contains("state_migration_required"),
        "{}",
        error_of(&upgraded, "current")
    );
    assert_eq!(active(&upgraded), ["legacy", "middle"]);
    assert_eq!(
        upgraded
            .invoke(
                "legacy",
                upgraded.generation(),
                "command",
                "ping",
                Value::Null
            )
            .unwrap(),
        json!(MOD_API_VERSION)
    );

    contended(|| store.enable(&current, false));
    contended(|| store.migrate(&current));
    contended(|| store.enable(&current, true));
    let mut migrated = host(&temp);
    assert_eq!(active(&migrated), ["current", "legacy", "middle"]);
    assert_eq!(
        migrated
            .invoke(
                "current",
                migrated.generation(),
                "command",
                "count",
                Value::Null
            )
            .unwrap(),
        json!({"count":1,"from":1,"to":2})
    );
}

#[test]
fn mods_share_the_event_pipeline_and_the_store_without_crossing_boundaries() {
    let temp = TempDir::new().unwrap();
    let (root, store) = workspace(&temp);
    let alpha = written(
        &root,
        "alpha",
        "export default api => { api.on('context', () => ({text:'alpha'})); api.command('count', () => { api.state.set(Number(api.state.get() ?? 0)+1); return api.state.get(); }); }",
        &["context", "commands", "state"],
        json!({}),
    );
    let beta = written(
        &root,
        "beta",
        "export default api => { api.on('context', () => { throw new Error('beta failed') }); api.command('count', () => { api.state.set(Number(api.state.get() ?? 0)+10); return api.state.get(); }); }",
        &["context", "commands", "state"],
        json!({}),
    );
    let gamma = written(
        &root,
        "gamma",
        "export default api => api.on('context', () => ({text:'x'.repeat(1025)}))",
        &["context"],
        json!({}),
    );
    trust(&store, &alpha, &["context", "commands", "state"]);
    trust(&store, &beta, &["context", "commands", "state"]);
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
fn mods_and_upstream_pi_resources_coexist_without_capturing_each_other() {
    let temp = TempDir::new().unwrap();
    let (root, store) = workspace(&temp);
    let user = root.join("user");
    let project = root.join("project");
    std::fs::create_dir_all(user.join("prompts")).unwrap();
    std::fs::create_dir_all(project.join(".pi/skills/review")).unwrap();
    std::fs::write(user.join("prompts/ping.md"), "upstream prompt").unwrap();
    std::fs::write(
        project.join(".pi/skills/review/SKILL.md"),
        "---\ndescription: Upstream skill\n---\nBody\n",
    )
    .unwrap();
    let reader = written(
        &root,
        "reader",
        "export default api => { api.command('ping', () => 'mod'); api.command('resources', () => api.host.call('pi.discover', null).resources.map(resource => resource.kind + '/' + resource.name)); }",
        &["commands", "pi_resources"],
        json!({}),
    );
    trust(&store, &reader, &["commands", "pi_resources"]);

    let mut runtime = host(&temp);
    let generation = runtime.generation();
    let discovered = runtime
        .invoke_with(
            "reader",
            generation,
            "command",
            "resources",
            Value::Null,
            || true,
            |_| ModStore::discover_pi(&user, &project),
        )
        .unwrap();
    assert_eq!(discovered, json!(["prompts/ping", "skills/review"]));
    assert_eq!(
        runtime
            .invoke("reader", generation, "command", "ping", Value::Null)
            .unwrap(),
        json!("mod")
    );
    let commands: Vec<String> = runtime
        .commands()
        .into_iter()
        .map(|(id, command)| format!("{id}:{}", command.name))
        .collect();
    assert_eq!(commands, ["reader:ping", "reader:resources"]);
}
