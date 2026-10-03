use super::*;
use codex_extension_api::ToolLifecycleContributor as _;
use codex_extension_api::ToolOutputContributor;
use codex_omd::ModStore;
use std::path::Path;
use std::path::PathBuf;

struct Fixture {
    _dir: tempfile::TempDir,
    core: Arc<Core>,
    lead: Lead,
}

struct Package<'a> {
    id: &'a str,
    capabilities: &'a [&'a str],
    manifest: Value,
    source: &'a str,
}

fn install(store: &ModStore, dir: &Path, package: &Package<'_>) {
    let path = dir.join(package.id);
    std::fs::create_dir(&path).unwrap();
    let mut manifest = json!({"schema": 1, "id": package.id, "version": "1.0.0",
        "api": codex_omd::MOD_API_VERSION, "state_version": 1, "capabilities": package.capabilities});
    if let Some(extra) = package.manifest.as_object() {
        manifest.as_object_mut().unwrap().extend(extra.clone());
    }
    std::fs::write(
        path.join("mod.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(path.join("index.ts"), package.source).unwrap();
    let path = path.canonicalize().unwrap();
    let inspected = ModStore::inspect_package(&path).unwrap();
    store
        .trust(
            path.clone(),
            inspected["sha256"].as_str().unwrap(),
            package
                .capabilities
                .iter()
                .map(|c| (*c).to_owned())
                .collect(),
            "user",
        )
        .unwrap();
    store.enable(&path, true).unwrap();
}

fn fixture(packages: &[Package<'_>]) -> Option<Fixture> {
    let node = PathBuf::from(std::env::var_os("OMD_TEST_NODE")?);
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let repository = base.join("repo");
    std::fs::create_dir(&repository).unwrap();
    let store = ModStore::create(base.join("store"), node).unwrap();
    let sources = base.join("packages");
    std::fs::create_dir(&sources).unwrap();
    for package in packages {
        install(&store, &sources, package);
    }
    let root = base.join("store").canonicalize().unwrap();
    let host = Arc::new(Host {
        root: root.clone(),
        repository: repository.clone(),
        repository_identity: "fixture".into(),
        config: config::HostConfig::default(),
        routes: Mutex::new(crate::RouteTable {
            stamp: None,
            config: Arc::new(config::HostConfig::default()),
            error: None,
        }),
        accounts: Arc::new(accounting::Accounts::default()),
        manager: std::sync::Weak::new(),
        epoch: 1,
    });
    let runtime = Arc::new(Mutex::new(ModHost::open(root.clone()).unwrap()));
    let input_runtime = Arc::new(Mutex::new(ModHost::open(root.clone()).unwrap()));
    let views = Arc::new(view::Views::new());
    let core = Arc::new_cyclic(|core| Core {
        agents: agents::Agents::new(core.clone(), runtime.clone(), views.clone(), host.clone()),
        host: host.clone(),
        runtime,
        input_runtime,
        services: services::Services::default(),
        views,
        expansion: State::default(),
    });
    let thread = ThreadId::new();
    let session = host.open_session(thread, false).unwrap();
    *session.data.0.lock().unwrap() = Some(codex_omd::scoped_data::ScopedDataHosts::new(
        root,
        repository,
        None,
        None,
        thread.to_string(),
    ));
    let lead = Lead {
        host,
        session,
        thread,
        owner: "lead".into(),
        depth: 0,
        permission_profile: Arc::new(Mutex::new(PermissionProfile::default())),
    };
    core.expansion.refresh(&core.runtime.lock().unwrap());
    Some(Fixture {
        _dir: dir,
        core,
        lead,
    })
}

fn mods(core: &Arc<Core>) -> Mods {
    Mods {
        core: core.clone(),
        turns: Mutex::new(BTreeMap::new()),
        sessions: Mutex::new(BTreeMap::new()),
        workspace_before: Mutex::new(BTreeMap::new()),
        worktrees: Mutex::new(BTreeMap::new()),
        pending: Mutex::new(BTreeMap::new()),
        answered: Mutex::new(BTreeMap::new()),
    }
}

fn command(core: &Core, id: &str, name: &str) -> Value {
    let mut runtime = core.runtime.lock().unwrap();
    let generation = runtime.generation();
    runtime
        .invoke_with(
            id,
            generation,
            "command",
            name,
            Value::Null,
            || true,
            |_| Err(std::io::Error::other("unexpected_host_call")),
        )
        .unwrap()
}

#[test]
fn routes_reload_from_host_config_and_select_routes_added_after_enrollment() {
    let Some(fixture) = fixture(&[]) else {
        return;
    };
    let lead = &fixture.lead;
    let route = |name: &str, provider: &str| {
        json!({"name": name, "provider": provider, "model": format!("{name}-model"), "reasoning_effort": "high",
            "responses_url": "http://127.0.0.1:1/v1/responses", "roles": ["lead"], "rates": {
            "input_microusd_per_million": 0, "cached_microusd_per_million": 0, "output_microusd_per_million": 0,
            "reservation_microusd": 0, "max_output_tokens": 1000, "input_token_ceiling": 1000, "included_subscription": true}})
    };
    let write = |value: &Value| {
        std::fs::write(lead.host.root.join("host.json"), value.to_string()).unwrap()
    };
    write(&json!({"routes": [route("first", "local")]}));
    let first = lead
        .host
        .route_config()
        .0
        .route("first", config::RouteRole::Lead, None)
        .cloned()
        .unwrap();
    lead.host
        .enroll(lead.thread, &lead.session, "lead", Some(&first), None)
        .unwrap();
    let select =
        |name: &str| select_route(lead, "fixture", json!({"route": name, "scope": "thread"}));
    assert_eq!(select("added"), Err("route_not_configured: added".into()));
    write(
        &json!({"routes": [route("first", "local"), route("added", "local"), route("other", "remote")]}),
    );
    assert_eq!(select("added").unwrap()["route"]["model"], "added-model");
    assert_eq!(
        take_route_selection(&lead.thread.to_string()),
        Some("added".into())
    );
    assert_eq!(
        select("other"),
        Err("route_unavailable_for_thread: other".into())
    );
    assert_eq!(select("first").unwrap()["route"]["name"], "first");
    let mut edited = route("added", "local");
    edited["model"] = "added-v2".into();
    write(
        &json!({"limits": {"requests": 400, "exposure_microusd": 5000, "seconds": 86400,
        "concurrent_workers": 4, "max_depth": 2}, "routes": [route("first", "local"), edited]}),
    );
    lead.host.refresh_session(&lead.session).unwrap();
    assert_eq!(lead.session.task.remaining().unwrap().2, 5000);
    assert_eq!(
        lead.host.accounts.0.lock().unwrap()[&lead.thread.to_string()]
            .lead_routes
            .iter()
            .map(|route| route.model.as_str())
            .collect::<Vec<_>>(),
        ["first-model", "added-v2"]
    );
    write(&json!({"routes": "invalid"}));
    assert!(select("added").is_ok());
    let error = select("later").unwrap_err();
    assert!(
        error.starts_with("route_not_configured: later; invalid /")
            && error.contains("/host.json: "),
        "{error}"
    );
}

struct NoHistory;

impl codex_extension_api::ConversationHistorySnapshot for NoHistory {
    fn history_version(&self) -> u64 {
        0
    }

    fn user_message_revision(&self) -> u64 {
        0
    }

    fn items(&self) -> Box<dyn Iterator<Item = &codex_extension_api::ResponseItem> + Send + '_> {
        Box::new(std::iter::empty())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn tool_interceptors_wrap_execution_answer_synthetically_and_keep_the_original() {
    let Some(fixture) = fixture(&[
        Package {
            id: "budget",
            capabilities: &["interception", "store"],
            manifest: Value::Null,
            source: "export default function (api) {\n  api.intercept('tool', async (e, next) => {\n    const r = await next({ ...e, arguments: { ...e.arguments, checked: true } });\n    return r.output.length > 4 ? { ...r, output: `trimmed ${r.output.length} ${e.tool} ${e.arguments.path}` } : r;\n  });\n}\n",
        },
        Package {
            id: "cache",
            capabilities: &["interception"],
            manifest: Value::Null,
            source: "export default function (api) {\n  api.intercept('tool', { match: { tool: 'cached' } }, () => ({ output: 'from cache', success: true }));\n}\n",
        },
        Package {
            id: "lint",
            capabilities: &["outputs", "agents"],
            manifest: Value::Null,
            source: "export default function (api) {\n  api.on('tool_output', event => event.text.startsWith('trimmed') ? { append: `lint: ${api.host.tryCall('model.complete', { route: 'missing', prompt: 'lint' }).error}` } : null);\n}\n",
        },
    ]) else {
        return;
    };
    *fixture.lead.session.contract.lock().unwrap() =
        crate::contract::SessionContract::resolve(&fixture.lead.host, &[]);
    let mods = mods(&fixture.core);
    let (session_store, thread_store, turn_store) = (
        ExtensionData::new("session".to_owned()),
        ExtensionData::new("thread".to_owned()),
        ExtensionData::new("turn".to_owned()),
    );
    thread_store.insert(fixture.lead.clone());
    let payload = codex_tools::ToolPayload::Function {
        arguments: r#"{"path":"a.txt"}"#.to_owned(),
    };
    let start = |call_id: &'static str, tool: &'static ToolName| ToolStartInput {
        session_store: &session_store,
        thread_store: &thread_store,
        turn_store: &turn_store,
        turn_id: "turn-1",
        root_turn_id: None,
        call_id,
        originating_item_id: None,
        tool_name: tool,
        mcp_tool: None,
        permissions: Box::pin(async { None }),
        payload: &payload,
        conversation_history: Arc::new(NoHistory),
        source: codex_extension_api::ToolCallSource::Direct,
    };
    static READ: std::sync::LazyLock<ToolName> =
        std::sync::LazyLock::new(|| ToolName::plain("read"));
    static CACHED: std::sync::LazyLock<ToolName> =
        std::sync::LazyLock::new(|| ToolName::plain("cached"));
    let output = |call_id: &'static str, text: &'static str| codex_extension_api::ToolOutputInput {
        session_store: &session_store,
        thread_store: &thread_store,
        turn_store: &turn_store,
        turn_id: "turn-1",
        call_id,
        tool_name: &READ,
        arguments: Some(r#"{"path":"a.txt","checked":true}"#),
        success: true,
        text,
    };
    let ToolInterception::Continue(Some((tool, codex_tools::ToolPayload::Function { arguments }))) =
        mods.intercept_tool(start("call-1", &READ)).await.unwrap()
    else {
        panic!("the effective call must reach the native executor");
    };
    assert_eq!(
        (tool.name.as_str(), arguments.as_str()),
        ("read", r#"{"checked":true,"path":"a.txt"}"#)
    );
    assert_eq!(
        mods.replace_tool_output(output("call-1", "hello world"))
            .await
            .as_deref(),
        Some("trimmed 11 read a.txt\n\nlint: provider_not_registered_or_stopped")
    );
    mods.intercept_tool(start("call-2", &READ)).await.unwrap();
    assert_eq!(mods.replace_tool_output(output("call-2", "ok")).await, None);
    assert_eq!(
        mods.intercept_tool(start("call-3", &CACHED)).await.unwrap(),
        ToolInterception::Respond {
            output: "trimmed 10 cached a.txt".into(),
            success: true
        }
    );
    assert_eq!(mods.answered.lock().unwrap()["call-3"], "cache");

    let source = fixture
        .core
        .runtime
        .lock()
        .unwrap()
        .grants("budget")
        .unwrap()
        .source_sha256;
    let mut scope = fixture.lead.session.data.0.lock().unwrap();
    let hosts = scope.as_mut().unwrap();
    let reference = hosts
        .text_evidence("budget", &source, "probe", "hello world")
        .unwrap();
    let page = hosts
        .call(
            "budget",
            &source,
            "evidence.read",
            json!({"reference": reference}),
            || true,
        )
        .unwrap();
    assert!(page.to_string().contains("hello world"));
}

#[derive(Default)]
struct RecordingInvoker(std::sync::Mutex<Vec<(String, String, Value)>>);

impl codex_extension_api::ToolInvoker for RecordingInvoker {
    fn invoke<'a>(
        &'a self,
        request: codex_extension_api::ToolInvocationRequest,
    ) -> ExtensionFuture<'a, Result<codex_extension_api::ToolInvocationOutcome, String>> {
        self.0
            .lock()
            .unwrap()
            .push((request.call_id, request.tool, request.arguments));
        Box::pin(std::future::ready(Ok(
            codex_extension_api::ToolInvocationOutcome {
                output: "second attempt".into(),
                success: true,
            },
        )))
    }

    fn check<'a>(
        &'a self,
        tool: &'a str,
        _arguments: Value,
    ) -> ExtensionFuture<'a, Result<codex_extension_api::ToolCheckOutcome, String>> {
        Box::pin(std::future::ready(Ok(
            codex_extension_api::ToolCheckOutcome {
                decision: if tool == "exec_command" {
                    "ask"
                } else {
                    "allow"
                },
                reason: None,
                authority: "exec_policy",
            },
        )))
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn tool_retries_and_mod_calls_redispatch_through_the_turn_invoker() {
    let Some(fixture) = fixture(&[
        Package {
            id: "retry",
            capabilities: &["interception"],
            manifest: Value::Null,
            source: "export default function (api) {\n  api.intercept('tool', { match: { tool: 'flaky' } }, async (e, next) => {\n    const first = await next(e);\n    return first.success ? first : next({ ...e, arguments: { ...e.arguments, attempt: 2 } });\n  });\n}\n",
        },
        Package {
            id: "probe",
            capabilities: &["interception"],
            manifest: Value::Null,
            source: "export default function (api) {\n  api.intercept('tool', { match: { tool: 'probe' } }, () => {\n    const check = api.host.call('tools.check', { tool: 'exec_command', arguments: { cmd: 'ls' } });\n    const run = api.host.call('tools.invoke', { tool: 'read', arguments: { path: 'b.txt' } });\n    return { output: `${check.decision} ${run.call_id} ${run.output}`, success: true };\n  });\n  api.intercept('tool', { match: { tool: 'read' } }, () => ({ output: 'own call intercepted', success: true }));\n}\n",
        },
    ]) else {
        return;
    };
    *fixture.lead.session.contract.lock().unwrap() =
        crate::contract::SessionContract::resolve(&fixture.lead.host, &[]);
    let mods = mods(&fixture.core);
    let (session_store, thread_store, turn_store) = (
        ExtensionData::new("session".to_owned()),
        ExtensionData::new("thread".to_owned()),
        ExtensionData::new("turn".to_owned()),
    );
    thread_store.insert(fixture.lead.clone());
    let invoker = Arc::new(RecordingInvoker::default());
    thread_store
        .get_or_init(codex_extension_api::ToolInvokerSlot::default)
        .set("turn-1", invoker.clone());
    fixture.core.expansion.invokers.lock().unwrap().insert(
        fixture.lead.thread.to_string(),
        thread_store.get_or_init(codex_extension_api::ToolInvokerSlot::default),
    );
    let payload = codex_tools::ToolPayload::Function {
        arguments: r#"{"path":"a.txt"}"#.to_owned(),
    };
    let start = |call_id: &'static str, tool: &'static ToolName| ToolStartInput {
        session_store: &session_store,
        thread_store: &thread_store,
        turn_store: &turn_store,
        turn_id: "turn-1",
        root_turn_id: None,
        call_id,
        originating_item_id: None,
        tool_name: tool,
        mcp_tool: None,
        permissions: Box::pin(async { None }),
        payload: &payload,
        conversation_history: Arc::new(NoHistory),
        source: codex_extension_api::ToolCallSource::Direct,
    };
    static FLAKY: std::sync::LazyLock<ToolName> =
        std::sync::LazyLock::new(|| ToolName::plain("flaky"));
    static PROBE: std::sync::LazyLock<ToolName> =
        std::sync::LazyLock::new(|| ToolName::plain("probe"));
    assert_eq!(
        mods.intercept_tool(start("call-1", &FLAKY)).await.unwrap(),
        ToolInterception::Continue(None)
    );
    let replaced = mods
        .replace_tool_output(codex_extension_api::ToolOutputInput {
            session_store: &session_store,
            thread_store: &thread_store,
            turn_store: &turn_store,
            turn_id: "turn-1",
            call_id: "call-1",
            tool_name: &FLAKY,
            arguments: Some(r#"{"path":"a.txt"}"#),
            success: false,
            text: "first attempt failed",
        })
        .await;
    assert_eq!(replaced.as_deref(), Some("second attempt"));
    assert_eq!(
        invoker.0.lock().unwrap().clone(),
        vec![(
            "call-1:retry1".to_owned(),
            "flaky".to_owned(),
            json!({"path": "a.txt", "attempt": 2})
        )]
    );
    assert_eq!(
        mods.intercept_tool(start("call-1:retry1", &FLAKY))
            .await
            .unwrap(),
        ToolInterception::Continue(None),
        "a retry was already wrapped by the chain that issued it"
    );
    let probed = mods.intercept_tool(start("call-2", &PROBE)).await.unwrap();
    assert_eq!(
        probed,
        ToolInterception::Respond {
            output: "ask mod-probe-0 second attempt".into(),
            success: true
        }
    );
    assert_eq!(invoker.0.lock().unwrap()[1].0, "mod-probe-0");
    let chain = codex_omd::intercept_shared(
        &fixture.core.runtime,
        "tool",
        json!({"tool": "read", "arguments": {}}),
        json!({"caller": "probe"}),
        || true,
        |_, _| Err(std::io::Error::other("unexpected host call")),
        |_| Ok(json!({"output": "native", "success": true})),
    )
    .unwrap();
    assert_eq!(
        chain.result["output"], "native",
        "a mod never intercepts its own call"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn tool_output_without_owner_is_not_offered() {
    let Some(fixture) = fixture(&[Package {
        id: "quiet",
        capabilities: &["lifecycle"],
        manifest: Value::Null,
        source: "export default function () {}\n",
    }]) else {
        return;
    };
    assert!(!fixture.core.expansion.tool_output_active());
}

#[tokio::test(flavor = "multi_thread")]
async fn channel_events_reach_subscribers_in_order() {
    let Some(fixture) = fixture(&[
        Package {
            id: "herald",
            capabilities: &["events"],
            manifest: Value::Null,
            source: "export default function () {}\n",
        },
        Package {
            id: "listener",
            capabilities: &["events", "store", "commands"],
            manifest: json!({"subscriptions": {"channels": ["herald/*"]}}),
            source: "export default function (api) {\n  api.on('channel', event => { api.state.set([...(api.state.get() ?? []), [event.channel, event.sequence, event.data]]); });\n  api.command('seen', () => api.state.get());\n}\n",
        },
    ]) else {
        return;
    };
    let core = &fixture.core;
    *core.expansion.current.lock().unwrap() = Some(LeadHandle::new(&fixture.lead));
    for data in [json!(1), json!({"n": 2})] {
        let delivered =
            delivery::publish(core, "herald", json!({"channel": "ping", "data": data})).unwrap();
        assert_eq!(delivered["delivered"], 1);
    }
    assert!(delivery::publish(core, "herald", json!({"channel": "Bad Name", "data": 1})).is_err());
    let revision = || {
        codex_omd::ModViewSnapshot::read(&core.host.root.join("mod-view.json"))
            .map(|snapshot| snapshot.revision)
            .unwrap_or_default()
    };
    let before = revision();
    assert!(!delivery::deliver(core).await);
    assert_eq!(
        revision(),
        before + 2,
        "each state-changing delivery republishes the view"
    );
    assert_eq!(
        command(core, "listener", "seen"),
        json!([["herald/ping", 1, 1], ["herald/ping", 2, {"n": 2}]])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn background_delivery_wakes_on_publish_and_client_wake() {
    let Some(fixture) = fixture(&[Package {
        id: "hearer",
        capabilities: &["events", "store", "commands"],
        manifest: json!({"subscriptions": {"channels": ["crier/news"]}}),
        source: "export default function (api) {\n  api.on('channel', event => { api.state.set([...(api.state.get() ?? []), event.data]); });\n  api.command('seen', () => api.state.get());\n}\n",
    }]) else {
        return;
    };
    let core = &fixture.core;
    delivery::lead_started(core, &fixture.lead, None);
    let seen = |expected: Value| async move {
        for _ in 0..200 {
            if command(core, "hearer", "seen") == expected {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        false
    };
    delivery::publish(core, "crier", json!({"channel": "news", "data": "a"})).unwrap();
    assert!(seen(json!(["a"])).await);
    codex_omd::event_bus::global()
        .lock()
        .unwrap()
        .publish("crier", "news", json!("b"), None)
        .unwrap();
    codex_omd::client_surface::wake();
    assert!(seen(json!(["a", "b"])).await);
    let ignored =
        delivery::publish(core, "crier", json!({"channel": "other", "data": "c"})).unwrap();
    assert_eq!(ignored["delivered"], 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn turn_activity_records_only_while_a_mod_reads_it() {
    let Some(fixture) = fixture(&[Package {
        id: "ledger",
        capabilities: &["sessions"],
        manifest: Value::Null,
        source: "export default function (api) { const read = () => api.host.tryCall('turns.activity', {}); }\n",
    }]) else {
        return;
    };
    let (core, lead) = (&fixture.core, &fixture.lead);
    activity::turn_started(core, lead, "t1").await;
    activity::tool_started(
        core,
        lead,
        "c1",
        "shell",
        Some(r#"{"command":["ls","-a"]}"#),
    );
    activity::tool_started(
        core,
        lead,
        "c2",
        "exec_command",
        Some(r#"{"cmd":"sleep 9"}"#),
    );
    activity::command_ended(core, lead, "c1", 0);
    activity::tool_finished(core, lead, "c1", "shell", "succeeded");
    activity::tool_finished(core, lead, "c2", "exec_command", "succeeded");
    activity::files(
        core,
        lead,
        &[json!({"path": "a.txt", "before": null, "after": "h1"})],
        "tool",
    );
    let turns = activity::read(core, lead, json!({"last": 1}))
        .await
        .unwrap();
    let turn = &turns["turns"][0];
    assert_eq!(turn["outcome"], "running");
    assert_eq!(turn["tool_calls"][0]["outcome"], "succeeded");
    assert_eq!(turn["processes"][0]["command"], "ls -a");
    assert_eq!(
        (
            &turn["processes"][0]["running"],
            &turn["processes"][0]["exit_code"]
        ),
        (&json!(false), &json!(0))
    );
    assert_eq!(turn["processes"][1]["running"], true);
    assert_eq!(turn["files"][0]["path"], "a.txt");
    activity::turn_ended(core, lead, "completed", None);
    let turns = activity::read(core, lead, Value::Null).await.unwrap();
    assert_eq!(turns["turns"][0]["outcome"], "completed");

    activity::turn_started(core, lead, "t2").await;
    core.expansion.running.lock().unwrap().clear();
    let turns = activity::read(core, lead, json!({"last": 2}))
        .await
        .unwrap();
    assert_eq!(turns["turns"][1]["outcome"], "interrupted");
    assert_eq!(turns["turns"][1]["unrecorded_end"], true);
    assert_eq!(
        activity::resume_payload(core, lead).await,
        json!({"thread_id": lead.thread.to_string(),
            "last_turn": {"turn_id": "t2", "status": "interrupted"}, "restarted": true})
    );
    assert!(
        activity::read(core, lead, json!({"thread_id": "other"}))
            .await
            .unwrap_err()
            .contains("out_of_scope")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn turn_activity_stays_empty_without_a_reader() {
    let Some(fixture) = fixture(&[Package {
        id: "plain",
        capabilities: &["sessions"],
        manifest: Value::Null,
        source: "export default function () {}\n",
    }]) else {
        return;
    };
    let (core, lead) = (&fixture.core, &fixture.lead);
    activity::turn_started(core, lead, "t1").await;
    activity::tool_started(core, lead, "c1", "shell", None);
    let turns = activity::read(core, lead, Value::Null).await.unwrap();
    assert_eq!(turns["turns"], json!([]));
    assert_eq!(turns["recording"], false);
    assert!(!lead.host.root.join("turn-activity").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn zero_mods_allocate_nothing_and_change_no_decision() {
    use codex_extension_api::ApprovalGate;
    use codex_extension_api::ApprovalGateContributor;
    use codex_extension_api::ToolBatchContributor;
    use codex_extension_api::ToolOutputContributor;
    use codex_extension_api::ToolSpecContributor;
    let Some(fixture) = fixture(&[]) else {
        return;
    };
    let (core, lead) = (&fixture.core, &fixture.lead);
    let mods = mods(core);
    let (session_store, thread_store, turn_store) = (
        ExtensionData::new("session".to_owned()),
        ExtensionData::new("thread".to_owned()),
        ExtensionData::new("turn".to_owned()),
    );
    thread_store.insert(lead.clone());
    let tool = ToolName::plain("read");
    assert_eq!(
        mods.replace_tool_output(codex_extension_api::ToolOutputInput {
            session_store: &session_store,
            thread_store: &thread_store,
            turn_store: &turn_store,
            turn_id: "t",
            call_id: "c",
            tool_name: &tool,
            arguments: None,
            success: true,
            text: "output",
        })
        .await,
        None
    );
    assert_eq!(
        mods.gate_approval(codex_extension_api::ApprovalGateInput {
            session_store: &session_store,
            thread_store: &thread_store,
            call_id: "c",
            turn_id: None,
            kind: "exec",
            host_decision: "ask",
            policy: "never",
            details: Value::Null,
            assessment: false,
        })
        .await,
        ApprovalGate::Continue
    );
    assert!(!mods.batching(&thread_store));
    assert_eq!(mods.adjust_tool_specs(&thread_store, &[]), None);
    activity::turn_started(core, lead, "t").await;
    activity::tool_started(core, lead, "c", "shell", None);
    assert!(!lead.host.root.join("turn-activity").exists());
    assert!(core.expansion.watches.lock().unwrap().is_none());
    assert!(core.expansion.pending.lock().unwrap().is_empty());
    assert!(core.expansion.subscriptions.lock().unwrap().is_empty());
}

#[test]
fn approval_decisions_deny_first_and_fail_closed_to_ask() {
    use codex_extension_api::ApprovalGate;
    let ok = |id: &str, value: Value| (id.to_owned(), Ok(value));
    let granted = |id: &str| {
        (id == "g")
            .then_some(())
            .ok_or_else(|| "no current approve grant".to_owned())
    };
    let decide = |results| approvals::decide(results, &granted);
    assert_eq!(
        decide(vec![ok("a", Value::Null)]),
        (ApprovalGate::Continue, None)
    );
    assert_eq!(
        decide(vec![
            ok("a", Value::Null),
            ok("g", json!({"approve": "ok"}))
        ]),
        (
            ApprovalGate::Approve("Mod g approved this under its delegated grant: ok".into()),
            Some("g".into())
        )
    );
    assert!(matches!(
        decide(vec![ok("a", json!({"approve": "mine"}))]).0,
        ApprovalGate::Ask(text) if text.contains("no current approve grant")
    ));
    assert!(matches!(
        decide(vec![
            ok("g", json!({"approve": "ok"})),
            ok("a", json!({"ask": "person"}))
        ])
        .0,
        ApprovalGate::Ask(_)
    ));
    assert!(matches!(
        decide(vec![
            ("a".to_owned(), Err(std::io::Error::other("boom"))),
            ok("g", json!({"approve": "ok"}))
        ])
        .0,
        ApprovalGate::Ask(_)
    ));
    let (gate, owner) = decide(vec![
        ok("g", json!({"approve": "ok"})),
        ok("a", json!({"ask": "check"})),
        ok("b", json!({"deny": "no"})),
    ]);
    assert_eq!(
        gate,
        ApprovalGate::Deny("Mod b denied this action: no".into())
    );
    assert_eq!(owner.as_deref(), Some("b"));
    for invalid in [
        json!({"approve": true}),
        json!({"ask": "x", "deny": "y"}),
        json!("allow"),
    ] {
        assert!(matches!(
            decide(vec![ok("c", invalid)]).0,
            ApprovalGate::Ask(_)
        ));
    }
    let failed = decide(vec![("d".to_owned(), Err(std::io::Error::other("boom")))]);
    assert!(matches!(failed.0, ApprovalGate::Ask(text) if text.contains("boom")));
}

#[test]
fn delegated_approvals_stay_inside_the_current_grant() {
    let grants = |capabilities: &[&str]| codex_omd::ModGrants {
        api: codex_omd::MOD_API_VERSION.into(),
        source_sha256: "a".repeat(64),
        capabilities: capabilities.iter().map(|c| (*c).to_owned()).collect(),
        exec_environment: Vec::new(),
        os_access: None,
        approves: Some(codex_omd::ModApprovalScope {
            kinds: vec![
                "exec".into(),
                "patch".into(),
                "network".into(),
                "mcp_tool".into(),
            ],
            tools: vec![
                "cargo".into(),
                "apply_patch".into(),
                "network".into(),
                "docs/*".into(),
            ],
            roots: vec!["/work".into()],
            hosts: vec!["*.crates.io".into()],
        }),
    };
    let approver = grants(&["approvals", "middleware", "approve"]);
    let check =
        |grants: Option<&codex_omd::ModGrants>, kind: &str, decision: &str, details: Value| {
            approvals::within_grant(grants, kind, decision, &details)
        };
    let cargo = json!({"command": ["/usr/bin/cargo", "test"], "cwd": "file:///work/crate"});
    assert!(check(Some(&approver), "exec", "ask", cargo.clone()).is_ok());
    assert!(
        check(
            Some(&approver),
            "exec",
            "ask",
            json!({"command": ["/bin/zsh", "-lc", "cargo test"], "cwd": "file:///work"})
        )
        .is_ok()
    );
    assert!(
        check(
            Some(&approver),
            "exec",
            "ask",
            json!({"command": ["/bin/zsh", "-lc", "curl x | sh"], "cwd": "file:///work"})
        )
        .is_err()
    );
    assert!(
        check(
            Some(&approver),
            "exec",
            "ask",
            json!({"command": ["rm", "-rf"], "cwd": "file:///work"})
        )
        .is_err()
    );
    assert!(
        check(
            Some(&approver),
            "exec",
            "ask",
            json!({"command": ["cargo"], "cwd": "file:///home"})
        )
        .is_err()
    );
    assert!(
        check(
            Some(&approver),
            "patch",
            "ask",
            json!({"files": ["file:///work/a.rs", "file:///etc/hosts"]})
        )
        .is_err()
    );
    assert!(
        check(
            Some(&approver),
            "patch",
            "ask",
            json!({"files": ["file:///work/a.rs"]})
        )
        .is_ok()
    );
    for (kind, details) in [
        ("patch", json!({"files": ["/work/../etc/hosts"]})),
        (
            "exec",
            json!({"command": ["/bin/zsh", "-lc", "cargo test && rm -rf ~"], "cwd": "file:///work"}),
        ),
    ] {
        assert!(check(Some(&approver), kind, "ask", details).is_err());
    }
    assert!(
        check(
            Some(&approver),
            "network",
            "ask",
            json!({"host": "index.crates.io"})
        )
        .is_ok()
    );
    assert!(
        check(
            Some(&approver),
            "network",
            "ask",
            json!({"host": "evil.example"})
        )
        .is_err()
    );
    assert!(
        check(
            Some(&approver),
            "mcp_tool",
            "ask",
            json!({"server": "docs", "tool_name": "search"})
        )
        .is_ok()
    );
    assert!(
        check(
            Some(&approver),
            "stdin",
            "ask",
            json!({"cwd": "file:///work"})
        )
        .is_err()
    );
    assert!(check(Some(&approver), "exec", "forbidden", cargo.clone()).is_err());
    let overrider = grants(&["approvals", "middleware", "approve", "approve.override"]);
    assert!(check(Some(&overrider), "exec", "forbidden", cargo.clone()).is_ok());
    let expired = grants(&["approvals", "middleware"]);
    assert!(check(Some(&expired), "exec", "ask", cargo.clone()).is_err());
    assert!(check(None, "exec", "ask", cargo).is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn approval_middleware_tightens_and_reports_results() {
    use codex_extension_api::ApprovalGate;
    use codex_extension_api::ApprovalGateContributor;
    let Some(fixture) = fixture(&[
        Package {
            id: "guard",
            capabilities: &["middleware", "approvals"],
            manifest: Value::Null,
            source: "export default function (api) {\n  api.middleware('approval', event => {\n    if (event.kind === 'exec' && JSON.stringify(event.details).includes('rm')) return { deny: 'destructive command' };\n    if (event.kind === 'network') return { ask: 'network needs a person' };\n    return null;\n  });\n}\n",
        },
        Package {
            id: "auditor",
            capabilities: &["approvals", "store", "commands"],
            manifest: Value::Null,
            source: "export default function (api) {\n  api.on('approval_result', event => { api.state.set([...(api.state.get() ?? []), [event.id, event.decision, event.source, event.mod ?? null]]); });\n  api.command('log', () => api.state.get());\n}\n",
        },
    ]) else {
        return;
    };
    let mods = mods(&fixture.core);
    let (session_store, thread_store) = (
        ExtensionData::new("session".to_owned()),
        ExtensionData::new("thread".to_owned()),
    );
    thread_store.insert(fixture.lead.clone());
    let gate = |call_id: &'static str, kind: &'static str, details: Value| {
        mods.gate_approval(codex_extension_api::ApprovalGateInput {
            session_store: &session_store,
            thread_store: &thread_store,
            call_id,
            turn_id: Some("turn"),
            kind,
            host_decision: "ask",
            policy: "on-request",
            details,
            assessment: false,
        })
    };
    assert_eq!(
        gate("c1", "exec", json!({"command": ["rm", "-rf", "x"]})).await,
        ApprovalGate::Deny("Mod guard denied this action: destructive command".into())
    );
    assert_eq!(
        gate("c2", "network", json!({"host": "example.com"})).await,
        ApprovalGate::Ask("Mod guard requires approval: network needs a person".into())
    );
    assert_eq!(gate("c3", "patch", json!({})).await, ApprovalGate::Continue);
    for (call_id, decision, source) in [("c1", "denied", "mod"), ("c2", "approved", "user")] {
        mods.on_approval_result(codex_extension_api::ApprovalResultInput {
            thread_store: &thread_store,
            call_id,
            kind: "exec",
            decision,
            source,
        })
        .await;
    }
    *fixture.core.expansion.current.lock().unwrap() = Some(LeadHandle::new(&fixture.lead));
    delivery::deliver(&fixture.core).await;
    assert_eq!(
        command(&fixture.core, "auditor", "log"),
        json!([
            ["c1", "denied", "mod", "guard"],
            ["c2", "approved", "user", "guard"]
        ])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn approval_middleware_requires_the_approvals_capability() {
    let Some(fixture) = fixture(&[Package {
        id: "sneaky",
        capabilities: &["middleware"],
        manifest: Value::Null,
        source: "export default function (api) {\n  api.middleware('approval', () => null);\n}\n",
    }]) else {
        return;
    };
    let status = fixture.core.runtime.lock().unwrap().status();
    let rejected = status.to_string();
    assert!(
        rejected.contains("capability_denied: approvals"),
        "{rejected}"
    );
    assert!(!fixture.core.expansion.approval.load(Ordering::Acquire));
}

#[tokio::test(flavor = "multi_thread")]
async fn tool_specs_interceptors_compose_hide_defer_and_redescribe() {
    use codex_extension_api::ToolSpecContributor;
    use codex_extension_api::ToolSpecView;
    let Some(fixture) = fixture(&[
        Package {
            id: "harness",
            capabilities: &["tools"],
            manifest: Value::Null,
            source: "export default function (api) {\n  api.intercept('tool_specs', async (event, next) => {\n    const result = await next({ ...event, tools: event.tools.filter(tool => !tool.name.startsWith('mcp__')) });\n    return { tools: result.tools.map(tool => tool.name === 'read' ? { ...tool, description: `Read (${event.tools.length} tools)` } : tool) };\n  });\n}\n",
        },
        Package {
            id: "lazy",
            capabilities: &["tools"],
            manifest: Value::Null,
            source: "export default function (api) {\n  api.intercept('tool_specs', async (event, next) => {\n    const result = await next(event);\n    return { tools: result.tools.map(tool => tool.name === 'grep' ? { ...tool, deferred: true } : tool) };\n  });\n}\n",
        },
        Package {
            id: "inventor",
            capabilities: &["tools"],
            manifest: Value::Null,
            source: "export default function (api) {\n  api.intercept('tool_specs', async (event, next) => {\n    const result = await next(event);\n    return { tools: [...result.tools, { name: 'forged', description: '', parameters: null, deferred: false }] };\n  });\n}\n",
        },
    ]) else {
        return;
    };
    let mods = mods(&fixture.core);
    let thread_store = ExtensionData::new("thread".to_owned());
    assert_eq!(mods.adjust_tool_specs(&thread_store, &[]), None);
    thread_store.insert(fixture.lead.clone());
    let view = |name: &str| ToolSpecView {
        name: name.to_owned(),
        description: String::new(),
        parameters: json!({"type": "object"}),
    };
    let adjustment = mods
        .adjust_tool_specs(
            &thread_store,
            &[view("read"), view("grep"), view("mcp__srv__search")],
        )
        .unwrap();
    assert_eq!(adjustment.hide, vec!["mcp__srv__search".to_owned()]);
    assert_eq!(adjustment.defer, vec!["grep".to_owned()]);
    assert_eq!(
        adjustment.describe.get("read"),
        Some(&(Some("Read (3 tools)".to_owned()), None))
    );
    assert!(
        !adjustment.describe.contains_key("forged") && !adjustment.hide.contains(&"forged".into())
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn tool_batch_owner_merges_calls_into_its_own_tool() {
    use codex_extension_api::ToolBatchCall;
    use codex_extension_api::ToolBatchContributor;
    let Some(fixture) = fixture(&[Package {
        id: "batcher",
        capabilities: &["interception", "tools"],
        manifest: Value::Null,
        source: "export default function (api) {\n  api.tool({ name: 'reads', description: 'Read many files', parameters: { type: 'object', properties: { paths: { type: 'array' } } } }, () => ({}));\n  api.replace('tool_batch', event => {\n    const reads = event.calls.filter(call => call.tool === 'read');\n    return reads.length < 2 ? null : { merge: [{ call_ids: reads.map(call => call.call_id), tool: 'reads', arguments: { paths: reads.map(call => call.arguments.path) } }] };\n  });\n}\n",
    }]) else {
        return;
    };
    let mods = mods(&fixture.core);
    let thread_store = ExtensionData::new("thread".to_owned());
    assert!(!mods.batching(&thread_store));
    thread_store.insert(fixture.lead.clone());
    assert!(mods.batching(&thread_store));
    let call = |id: &str, tool: &str, path: &str| ToolBatchCall {
        call_id: id.to_owned(),
        tool: tool.to_owned(),
        arguments: json!({"path": path}).to_string(),
        parallel_safe: true,
    };
    let calls = [
        call("c1", "read", "a"),
        call("c2", "list_dir", "."),
        call("c3", "read", "b"),
    ];
    let merges = mods
        .merge_tool_batch(codex_extension_api::ToolBatchInput {
            thread_store: &thread_store,
            turn_id: "turn",
            batch_id: "batch-c1",
            calls: &calls,
        })
        .await;
    assert_eq!(
        merges,
        vec![codex_extension_api::ToolBatchMerge {
            call_ids: vec!["c1".into(), "c3".into()],
            tool: "mod_batcher_reads".into(),
            arguments: json!({"paths": ["a", "b"]}).to_string(),
        }]
    );
    let known = vec!["c1".to_owned()];
    assert!(
        tool_batch::parse(
            "m",
            json!({"merge": [{"call_ids": ["zz"], "tool": "t", "arguments": {}}]}),
            &known
        )
        .is_err()
    );
    assert!(
        tool_batch::parse(
            "m",
            json!({"merge": [{"call_ids": ["c1"], "tool": "t", "arguments": []}]}),
            &known
        )
        .is_err()
    );
}

#[test]
fn tool_before_payload_carries_schema_raw_arguments_and_batch_position() {
    let (session_store, thread_store, turn_store) = (
        ExtensionData::new("session".to_owned()),
        ExtensionData::new("thread".to_owned()),
        ExtensionData::new("turn".to_owned()),
    );
    let facts = turn_store.get_or_init(codex_extension_api::ToolCallFacts::default);
    facts.0.lock().unwrap().insert(
        "c1".into(),
        codex_extension_api::ToolCallFact {
            schema: Some(json!({"type": "object"})),
            batch: Some(codex_extension_api::ToolBatchPosition {
                id: "b".into(),
                index: 1,
                size: 3,
            }),
        },
    );
    let _ = (&session_store, &thread_store);
    let tool = ToolName::plain("read");
    let value = tool_batch::tool_before_payload(
        &turn_store,
        "c1",
        &tool,
        &json!({"path": "a"}),
        r#"{"path":"a"}"#,
    );
    assert_eq!(value["schema"], json!({"type": "object"}));
    assert_eq!(value["raw_arguments"], r#"{"path":"a"}"#);
    assert_eq!(value["batch"], json!({"id": "b", "index": 1, "size": 3}));
    assert_eq!(value["arguments"]["path"], "a");
}

#[test]
fn process_output_notices_coalesce_per_session_and_keep_exit_order() {
    let state = State::default();
    let thread = ThreadId::new();
    let output = |session: &str, bytes| delivery::Pending::Process {
        thread,
        owner: "m".into(),
        session: session.into(),
        bytes,
    };
    for pending in [
        output("a", Some(3)),
        output("a", Some(4)),
        output("b", Some(1)),
        output("a", None),
        output("a", Some(5)),
    ] {
        delivery::push(&state, pending);
    }
    let queue = state
        .pending
        .lock()
        .unwrap()
        .iter()
        .map(|pending| match pending {
            delivery::Pending::Process { session, bytes, .. } => (session.clone(), *bytes),
            _ => unreachable!(),
        })
        .collect::<Vec<_>>();
    assert_eq!(
        queue,
        vec![
            ("a".to_owned(), Some(7)),
            ("b".to_owned(), Some(1)),
            ("a".to_owned(), None),
            ("a".to_owned(), Some(5)),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn event_context_refuses_user_only_app_methods_before_the_client() {
    let Some(fixture) = fixture(&[Package {
        id: "steerer",
        capabilities: &["threads"],
        manifest: Value::Null,
        source: "export default function () {}\n",
    }]) else {
        return;
    };
    let grants = fixture.core.runtime.lock().unwrap().grants("steerer");
    let caller = Caller {
        id: "steerer",
        source: "",
        grants,
        generation: 0,
        origin: Origin::Event,
        record_changes: false,
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    let request = |method: &str| ModHostCall {
        operation: "app.request".into(),
        arguments: json!({"method": method, "params": {"threadId": fixture.lead.thread.to_string()}}),
    };
    let refused = dispatch(
        &fixture.core,
        &fixture.lead,
        &caller,
        request("turn/start"),
        &cancelled,
    )
    .await
    .unwrap_err();
    assert!(refused.starts_with("app_context_user_only"), "{refused}");
    let unattached = dispatch(
        &fixture.core,
        &fixture.lead,
        &caller,
        request("turn/steer"),
        &cancelled,
    )
    .await
    .unwrap_err();
    assert!(
        unattached.starts_with("client_surface_unavailable"),
        "{unattached}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn model_completions_use_only_configured_worker_routes() {
    let Some(fixture) = fixture(&[Package {
        id: "summarizer",
        capabilities: &["agents"],
        manifest: Value::Null,
        source: "export default function () {}\n",
    }]) else {
        return;
    };
    *fixture.lead.session.contract.lock().unwrap() =
        crate::contract::SessionContract::resolve(&fixture.lead.host, &[]);
    let grants = fixture.core.runtime.lock().unwrap().grants("summarizer");
    let caller = Caller {
        id: "summarizer",
        source: "",
        grants,
        generation: 0,
        origin: Origin::Event,
        record_changes: false,
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    let complete = |arguments: Value| ModHostCall {
        operation: "model.complete".into(),
        arguments,
    };
    let run = |arguments: Value| {
        let caller = Caller {
            grants: caller.grants.clone(),
            ..caller
        };
        operations::dispatch(
            &fixture.core,
            &fixture.lead,
            caller,
            None,
            complete(arguments),
            &cancelled,
        )
    };
    let unknown = run(json!({"route": "missing", "prompt": "summarize"}))
        .await
        .unwrap_err();
    assert_eq!(unknown, "provider_not_registered_or_stopped");
    let malformed = run(json!({"prompt": "x"})).await.unwrap_err();
    assert!(malformed.contains("route"), "{malformed}");
}

#[tokio::test(flavor = "multi_thread")]
async fn dynamic_tools_are_defined_invoked_and_removed_by_their_mod() {
    let Some(fixture) = fixture(&[Package {
        id: "bridge",
        capabilities: &["tools", "events"],
        manifest: Value::Null,
        source: "export default function (api) {\n  api.dynamicTools(call => ({ called: call.name, arguments: call.arguments }));\n}\n",
    }]) else {
        return;
    };
    let (core, lead) = (&fixture.core, &fixture.lead);
    let (generation, grants) = {
        let runtime = core.runtime.lock().unwrap();
        (runtime.generation(), runtime.grants("bridge"))
    };
    let caller = Caller {
        id: "bridge",
        source: "",
        grants,
        generation,
        origin: Origin::Event,
        record_changes: false,
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    let call = |operation: &str, arguments: Value| {
        let caller = Caller {
            grants: caller.grants.clone(),
            ..caller
        };
        let request = ModHostCall {
            operation: operation.into(),
            arguments,
        };
        let cancelled = cancelled.clone();
        async move { dispatch(core, lead, &caller, request, &cancelled).await }
    };
    let schema = json!({"type": "object", "properties": {"q": {"type": "string"}}, "additionalProperties": false});
    call(
        "tools.define",
        json!({"name": "search", "description": "Search.", "parameters": schema}),
    )
    .await
    .unwrap();
    assert!(
        call(
            "tools.define",
            json!({"name": "Bad-Name", "description": "x", "parameters": schema})
        )
        .await
        .is_err()
    );
    let listed = core.runtime.lock().unwrap().tools();
    assert!(
        listed
            .iter()
            .any(|(id, _, tool)| id == "bridge" && tool.name == "search")
    );
    let value = codex_omd::invoke_shared(
        &core.runtime,
        "bridge",
        generation,
        "tool",
        "search",
        json!({"q": "x"}),
        || true,
        |_, _| Err(std::io::Error::other("unexpected_host_call")),
        |_| {},
    )
    .unwrap();
    assert_eq!(value, json!({"called": "search", "arguments": {"q": "x"}}));
    assert_eq!(
        call("tools.undefine", json!({"name": "search"}))
            .await
            .unwrap()["removed"],
        true
    );
    assert!(
        !core
            .runtime
            .lock()
            .unwrap()
            .tools()
            .iter()
            .any(|(_, _, tool)| tool.name == "search")
    );
    assert!(
        call("events.schedule", json!({"key": "k", "delay_ms": 10}))
            .await
            .unwrap_err()
            .contains("timer_invalid")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn dynamic_tools_cannot_shadow_another_mods_exposed_tool_name() {
    let Some(fixture) = fixture(&[
        Package {
            id: "bridge",
            capabilities: &["tools"],
            manifest: Value::Null,
            source: "export default function (api) {\n  api.dynamicTools(() => ({}));\n}\n",
        },
        Package {
            id: "bridge_x",
            capabilities: &["tools"],
            manifest: Value::Null,
            source: "export default function (api) {\n  api.tool({ name: 'y', description: 'Y.', parameters: { type: 'object', properties: {} } }, () => ({}));\n}\n",
        },
    ]) else {
        return;
    };
    let mut runtime = fixture.core.runtime.lock().unwrap();
    let generation = runtime.generation();
    let schema = json!({"type": "object", "properties": {}});
    let error = runtime
        .define_tool(
            "bridge",
            generation,
            json!({"name": "x_y", "description": "X.", "parameters": schema}),
        )
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("tool_name_conflict: mod_bridge_x_y"),
        "{error}"
    );
    runtime
        .define_tool(
            "bridge",
            generation,
            json!({"name": "z", "description": "Z.", "parameters": schema}),
        )
        .unwrap();
}

#[test]
fn watched_changes_skip_ignored_paths_unless_included() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::write(root.join(".gitignore"), "build/\n").unwrap();
    let paths = vec!["src/a.rs".to_owned(), "build/out.js".to_owned()];
    assert_eq!(
        super::activity::visible_paths(&root, paths.clone(), false, |_| true),
        vec!["src/a.rs"]
    );
    assert_eq!(
        super::activity::visible_paths(&root, paths, true, |_| true),
        vec!["src/a.rs", "build/out.js"]
    );
}
