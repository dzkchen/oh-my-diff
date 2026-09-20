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
fn mod_state_refreshes_per_call_and_racing_writers_fail_without_lost_updates() {
    let source = "export default api => { api.command('count', () => { api.state.set(Number(api.state.get() ?? 0)+1); return api.state.get(); }); api.command('slow', () => { const value = Number(api.state.get() ?? 0); const end = Date.now() + 500; while (Date.now() < end) {} api.state.set(value + 100); return value; }); }";
    let (temp, _, _) = fixture(source, &["commands", "state"]);
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
    let (_, result) = racing.join().unwrap();
    assert!(result.unwrap_err().to_string().contains("state_conflict"));
    let mut resumed = host(&temp);
    assert_eq!(invoke(&mut resumed, "count").unwrap(), json!(5));
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

#[test]
fn native_host_bridge_preserves_once_only_effects_and_rust_capability_checks() {
    let source = "export default api => api.command('run', () => { const a = api.host.call('task.status',null); api.state.set(a); return api.host.call('checkpoint.read',{a}); })";
    let (temp, _, _) = fixture(source, &["commands", "state", "task"]);
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
    assert_eq!(calls, vec!["task.status", "checkpoint.read"]);
    let state: Value = serde_json::from_slice(
        &std::fs::read(temp.path().join("store/state-fixture.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(state["value"], json!(1));
    let (denied, _, _) = fixture(source, &["commands", "state"]);
    let mut runtime = host(&denied);
    assert!(
        runtime
            .invoke_with(
                "fixture",
                runtime.generation(),
                "command",
                "run",
                Value::Null,
                || true,
                |_| panic!("denied call reached host")
            )
            .unwrap_err()
            .to_string()
            .contains("capability_denied")
    );
}

#[test]
fn migration_is_explicit_bounded_and_preserves_previous_state() {
    let (temp, store, path) = fixture(COUNTER, &["commands", "state"]);
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
        .trust(path.clone(), &sha, vec!["commands".into(), "state".into()])
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
fn host_error_receipts_are_catchable_without_repeating_operations() {
    let source = "export default api => api.command('run', () => { let value; try { value = api.host.call('task.status'); } catch(e) { if (e instanceof Error) return {failed:true}; throw e; } return value; })";
    let (temp, _, _) = fixture(source, &["commands", "task"]);
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
fn exclusive_replacement_conflicts_fail_before_activation() {
    let source = "export default api => api.replace('routing', () => 'sol')";
    let (temp, store, _) = fixture(source, &["routing"]);
    let mut runtime = host(&temp);
    let other = package(
        &temp.path().canonicalize().unwrap(),
        "other",
        source,
        &["routing"],
    );
    trust(&store, &other, &["routing"]);
    assert!(
        runtime
            .reload()
            .unwrap_err()
            .to_string()
            .contains("replacement_conflict")
    );
    let results = runtime.event("routing", Value::Null);
    assert_eq!(results.len(), 1);
    assert_eq!(*results[0].1.as_ref().unwrap(), json!("sol"));
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
        "theme":{"accent":81,"user_message_background":"#202830","syntax":"github","success":"#00FF00","attention":214,"failure":196},
        "keybindings":{"F6":"draft","F7":{"insert":"inserted"},"Ctrl+r":{"submit":"Run the tests"},"Alt+x":{"command":"counter:reset","args":"now"},"Alt+y":{"command":"reset"}}
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
    };
    std::fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    assert_eq!(codex_omd::ModViewSnapshot::read(&path).unwrap(), snapshot);
    snapshot.activity[0].label = "bad\u{1b}".into();
    std::fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    assert!(codex_omd::ModViewSnapshot::read(&path).is_err());
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
    assert!(ModHost::open(temp.path().canonicalize().unwrap().join("store")).is_err());
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
        (
            "export default api => api.on('turn_start', () => null)",
            &["commands"][..],
        ),
    ] {
        let (temp, _, _) = fixture(source, capabilities);
        assert!(
            ModHost::open(temp.path().canonicalize().unwrap().join("store")).is_err(),
            "{source}"
        );
    }
}

#[test]
fn tool_progress_is_forwarded_once_across_host_call_replay() {
    let source = "export default api => { api.tool({name:'work',description:'Work',parameters:{type:'object',properties:{}}}, () => { api.progress('started'); const status = api.host.call('task.status', null); api.progress('finished'); return status; }); api.command('bad', () => api.progress('nope')); }";
    let (temp, _, _) = fixture(source, &["tools", "commands", "task"]);
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
fn pi_nested_skills_honor_ignore_rules_and_frontmatter() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let user = root.join("user");
    let project = root.join("project");
    let skills = user.join("skills");
    let write = |path: &std::path::Path, content: &str| {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    };
    let skill = |description: &str| format!("---\ndescription: {description}\n---\nBody\n");
    write(
        &skills.join("root.md"),
        "---\nname: root-skill\ndescription: Root file\n---\n",
    );
    write(&skills.join("group/alpha/SKILL.md"), &skill("Alpha skill"));
    write(
        &skills.join("group/alpha/nested/SKILL.md"),
        &skill("Hidden below a skill root"),
    );
    write(
        &skills.join("group/ignored/SKILL.md"),
        &skill("Ignored by gitignore"),
    );
    write(&skills.join(".gitignore"), "group/ignored/\n");
    write(&skills.join("group/.ignore"), "gamma\n");
    write(
        &skills.join("group/gamma/SKILL.md"),
        &skill("Ignored by nested ignore"),
    );
    write(
        &skills.join("group/.hidden/SKILL.md"),
        &skill("Dot directory"),
    );
    write(
        &skills.join("node_modules/pkg/SKILL.md"),
        &skill("Dependency"),
    );
    write(&skills.join("group/beta/SKILL.md"), "No frontmatter\n");
    write(
        &skills.join("group/delta/SKILL.md"),
        "---\nname: delta-renamed\ndescription: Delta\n---\n",
    );
    write(
        &skills.join("group/deep/notes.md"),
        &skill("Not a root file"),
    );
    write(
        &project.join(".pi/prompts/review.md"),
        "---\ndescription: Review a file\nargument-hint: <path> [mode]\n---\nReview $1 carefully\n$@\n",
    );
    write(
        &project.join(".pi/prompts/plain.md"),
        &format!("\n{}\nsecond line\n", "y".repeat(70)),
    );
    let catalog = ModStore::discover_pi(&user, &project).unwrap();
    let mut names = catalog["resources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            format!(
                "{}/{}",
                r["kind"].as_str().unwrap(),
                r["name"].as_str().unwrap()
            )
        })
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(
        names,
        vec![
            "prompts/plain",
            "prompts/review",
            "skills/alpha",
            "skills/delta-renamed",
            "skills/root-skill"
        ]
    );
    assert!(
        catalog["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["error"] == "pi_skill_description_required")
    );
    let (prompts, _) = ModStore::pi_prompts(&user, &project).unwrap();
    let review = prompts.iter().find(|p| p.name == "review").unwrap();
    assert_eq!(review.description, "Review a file");
    assert_eq!(review.argument_hint.as_deref(), Some("<path> [mode]"));
    assert_eq!(review.body, "Review $1 carefully\n$@");
    let plain = prompts.iter().find(|p| p.name == "plain").unwrap();
    assert_eq!(plain.description, format!("{}...", "y".repeat(60)));
    assert_eq!(
        ModStore::expand_pi_prompt(&user, &project, "review", "\"src/main.rs\" fast").unwrap()["text"],
        json!("Review src/main.rs carefully\nsrc/main.rs fast")
    );
    assert!(ModStore::expand_pi_prompt(&user, &project, "missing", "").is_err());
}

#[test]
fn pi_prompt_expansion_matches_pi_0_74_oracle() {
    let oracle: Vec<Value> = serde_json::from_str(ORACLE).unwrap();
    for case in oracle {
        let parsed = codex_omd::parse_command_args(case["args"].as_str().unwrap());
        assert_eq!(json!(parsed), case["parsed"], "{case}");
        assert_eq!(
            codex_omd::substitute_args(case["template"].as_str().unwrap(), &parsed),
            case["expanded"].as_str().unwrap(),
            "{case}"
        );
    }
}

const ORACLE: &str = r####"[{"template": "Review $1 then $2", "args": "a b", "parsed": ["a", "b"], "expanded": "Review a then b"}, {"template": "All: $@ / $ARGUMENTS", "args": "one \"two words\" 'three'", "parsed": ["one", "two words", "three"], "expanded": "All: one two words three / one two words three"}, {"template": "Slice ${@:2} and ${@:1:2} and ${@:0} and ${@:3:0}", "args": "a b c d", "parsed": ["a", "b", "c", "d"], "expanded": "Slice b c d and a b and a b c d and "}, {"template": "Missing $3 and $0 and $10", "args": "x y", "parsed": ["x", "y"], "expanded": "Missing  and  and "}, {"template": "Money $$1 and ${@:x} and ${@:2:y}", "args": "p q r", "parsed": ["p", "q", "r"], "expanded": "Money $p and ${@:x} and ${@:2:y}"}, {"template": "Special $@", "args": "$& $$ $` $' tail", "parsed": ["$&", "$$", "$`", "$ tail"], "expanded": "Special $@ $ Special  $ tail"}, {"template": "Nested ${@:1}", "args": "\"${@:2}\" z", "parsed": ["${@:2}", "z"], "expanded": "Nested ${@:2} z"}, {"template": "Tabs\t$1", "args": "a\tb  c", "parsed": ["a", "b", "c"], "expanded": "Tabs\ta"}, {"template": "Unclosed \"quote $1", "args": "\"a b", "parsed": ["a b"], "expanded": "Unclosed \"quote a b"}, {"template": "Arguments $ARGUMENTS$@", "args": "", "parsed": [], "expanded": "Arguments "}]"####;

#[test]
fn pi_and_native_discovery_preserve_project_precedence_without_trust() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let user = root.join("user");
    let project = root.join("project");
    std::fs::create_dir_all(user.join("prompts")).unwrap();
    std::fs::create_dir_all(project.join(".pi/prompts")).unwrap();
    std::fs::write(user.join("prompts/review.md"), "user prompt").unwrap();
    std::fs::write(project.join(".pi/prompts/review.md"), "project prompt").unwrap();
    let catalog = ModStore::discover_pi(&user, &project).unwrap();
    assert_eq!(catalog["resources"].as_array().unwrap().len(), 1);
    assert_eq!(catalog["resources"][0]["content"], json!("project prompt"));
    let outside = root.join("private");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("secret.md"), "private content").unwrap();
    std::os::unix::fs::symlink(&outside, project.join(".pi/skills")).unwrap();
    let catalog = ModStore::discover_pi(&user, &project).unwrap();
    assert_eq!(catalog["resources"].as_array().unwrap().len(), 1);
    assert_eq!(
        catalog["diagnostics"][0]["error"],
        json!("pi_symlink_unsupported")
    );
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
        &["commands", "task"],
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
