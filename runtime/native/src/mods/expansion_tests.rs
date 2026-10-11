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
        .trust_with_secrets(
            path.clone(),
            inspected["sha256"].as_str().unwrap(),
            package
                .capabilities
                .iter()
                .map(|c| (*c).to_owned())
                .collect(),
            "user",
            manifest["exec_environment"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|name| codex_omd::host::secret_like(name))
                .map(str::to_owned)
                .collect(),
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
    let runtime = ModHost::open(root.clone()).unwrap();
    let environment = runtime.environment();
    let runtime = Arc::new(Mutex::new(runtime));
    let input_runtime = Arc::new(Mutex::new(ModHost::open(root.clone()).unwrap()));
    let views = Arc::new(view::Views::new());
    let core = Arc::new_cyclic(|core| Core {
        agents: agents::Agents::new(core.clone(), runtime.clone(), views.clone(), host.clone()),
        host: host.clone(),
        runtime,
        input_runtime,
        environment,
        services: services::Services::default(),
        views,
        expansion: State::default(),
        inventory: inventory::Inventory::default(),
        autonomy: autonomy::Queues::default(),
        peering: peering::Registry::default(),
        this: core.clone(),
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
    core.expansion.thread_started(&lead);
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
        child_errors: Mutex::new(BTreeMap::new()),
        settled: Mutex::new(BTreeMap::new()),
        elicitations: Mutex::default(),
    }
}

async fn attach_thread(fixture: &mut Fixture) -> Arc<codex_core::ThreadManager> {
    attach_thread_with_sandbox_mode(fixture, None).await
}

async fn attach_thread_with_sandbox_mode(
    fixture: &mut Fixture,
    sandbox_mode: Option<codex_protocol::config_types::SandboxMode>,
) -> Arc<codex_core::ThreadManager> {
    let mut config = codex_core::config::ConfigBuilder::default()
        .codex_home(fixture._dir.path().join("codex"))
        .harness_overrides(codex_core::config::ConfigOverrides {
            cwd: Some(fixture.lead.host.repository.clone()),
            sandbox_mode,
            ..Default::default()
        })
        .loader_overrides(codex_core::config::LoaderOverrides::without_managed_config_for_tests())
        .build()
        .await
        .unwrap();
    config.model_provider.base_url = Some("http://127.0.0.1:9/v1".into());
    let policy = codex_config::CloudConfigBundlePolicy::default();
    let mut snapshot = codex_config::CloudConfigBundleSnapshot {
        bundle: Ok(None),
        binding: None,
    };
    policy.publish_snapshot(&mut snapshot);
    config.config_layer_stack = config
        .config_layer_stack
        .with_cloud_config_binding(snapshot.binding);
    *fixture.lead.permission_profile.lock().unwrap() =
        config.permissions.effective_permission_profile();
    let manager = Arc::new(
        codex_core::test_support::thread_manager_with_models_provider(
            codex_login::CodexAuth::from_api_key("test"),
            config.model_provider.clone(),
        ),
    );
    let started = manager
        .start_thread(codex_core::StartThreadOptions::new(config))
        .await
        .unwrap();
    let host = &fixture.lead.host;
    fixture.lead.host = Arc::new(Host {
        root: host.root.clone(),
        repository: host.repository.clone(),
        repository_identity: host.repository_identity.clone(),
        config: host.config.clone(),
        routes: Mutex::new(crate::RouteTable {
            stamp: None,
            config: Arc::new(host.config.clone()),
            error: None,
        }),
        accounts: host.accounts.clone(),
        manager: Arc::downgrade(&manager),
        epoch: host.epoch,
    });
    fixture.lead.thread = started.thread_id;
    *fixture.lead.session.contract.lock().unwrap() =
        crate::contract::SessionContract::resolve(&fixture.lead.host, &[]);
    manager
}

async fn control_call(
    fixture: &Fixture,
    origin: Origin,
    operation: &str,
    arguments: Value,
) -> Result<Value, String> {
    let (grants, generation) = {
        let runtime = fixture.core.runtime.lock().unwrap();
        (runtime.grants("control"), runtime.generation())
    };
    let source = grants
        .as_ref()
        .unwrap_or_else(|| {
            panic!(
                "missing control grants: {:?}",
                fixture.core.runtime.lock().unwrap().status()
            )
        })
        .source_sha256
        .clone();
    super::operations::dispatch(
        &fixture.core,
        &fixture.lead,
        Caller {
            id: "control",
            source: &source,
            grants,
            generation,
            origin,
            record_changes: false,
        },
        None,
        ModHostCall {
            operation: operation.into(),
            arguments,
        },
        &Arc::new(AtomicBool::new(false)),
    )
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn turn_abort_requires_event_or_user_and_stays_in_current_thread() {
    let Some(mut fixture) = fixture(&[Package {
        id: "control",
        capabilities: &["threads"],
        manifest: Value::Null,
        source: "export default () => {}",
    }]) else {
        return;
    };
    let _manager = attach_thread(&mut fixture).await;
    assert!(
        control_call(
            &fixture,
            Origin::Tool,
            "turns.abort",
            json!({"turn_id": "stale"})
        )
        .await
        .unwrap_err()
        .contains("user_or_event_only")
    );
    for origin in [Origin::UserCommand, Origin::Event] {
        for arguments in [
            json!({}),
            json!({"turn_id": ""}),
            json!({"turn_id": "x".repeat(129)}),
            json!({"turn_id": "stale", "thread_id": ThreadId::new().to_string()}),
        ] {
            assert_eq!(
                control_call(&fixture, origin, "turns.abort", arguments)
                    .await
                    .unwrap_err(),
                "turn_abort_arguments_invalid"
            );
        }
        assert_eq!(
            control_call(&fixture, origin, "turns.abort", json!({"turn_id": "stale"}))
                .await
                .unwrap(),
            json!({"accepted": false})
        );
    }
    let (grants, generation) = {
        let runtime = fixture.core.runtime.lock().unwrap();
        (runtime.grants("control"), runtime.generation())
    };
    let source = grants.as_ref().unwrap().source_sha256.clone();
    let cancelled = Arc::new(AtomicBool::new(true));
    assert_eq!(
        super::operations::dispatch(
            &fixture.core,
            &fixture.lead,
            Caller {
                id: "control",
                source: &source,
                grants,
                generation,
                origin: Origin::Event,
                record_changes: false,
            },
            None,
            ModHostCall {
                operation: "turns.abort".into(),
                arguments: json!({"turn_id": "stale"}),
            },
            &cancelled,
        )
        .await
        .unwrap_err(),
        "callback_cancelled"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn scoped_environment_reaches_managed_children_and_clears_on_unload() {
    let Some(mut fixture) = fixture(&[Package {
        id: "control",
        capabilities: &["exec"],
        manifest: json!({"exec_environment": ["FIXTURE_VALUE", "PYTHONDONTWRITEBYTECODE", "E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"]}),
        source: "export default () => {}",
    }]) else {
        return;
    };
    let _manager = attach_thread(&mut fixture).await;
    control_call(
        &fixture,
        Origin::Event,
        "environment.set",
        json!({"name": "FIXTURE_VALUE", "value": "scoped"}),
    )
    .await
    .unwrap();
    let found = control_call(
        &fixture,
        Origin::Event,
        "process.which",
        json!({"names": ["sh"]}),
    )
    .await
    .unwrap();
    let sh = &found["found"][0];
    for (session, explicit, expected) in [
        ("scoped", json!({}), "scoped"),
        ("explicit", json!({"FIXTURE_VALUE": "explicit"}), "explicit"),
        ("unset", json!({"FIXTURE_VALUE": null}), "unset"),
    ] {
        control_call(&fixture, Origin::Event, "process.start", json!({"session": session, "name": "sh", "path": sh["path"], "sha256": sh["sha256"], "environment": explicit,
            "arguments": ["-c", "printf '{\"value\":\"%s\"}\\n' \"${FIXTURE_VALUE-unset}\"; read marker"], "framing": "ndjson"})).await.unwrap();
        let result = control_call(
            &fixture,
            Origin::Event,
            "process.exchange",
            json!({"session": session, "wait_ms": 1000}),
        )
        .await
        .unwrap();
        assert_eq!(result["messages"][0]["value"], expected);
        control_call(
            &fixture,
            Origin::Event,
            "process.stop",
            json!({"session": session}),
        )
        .await
        .unwrap();
    }
    control_call(
        &fixture,
        Origin::Event,
        "environment.set",
        json!({"name": "FIXTURE_VALUE", "value": "x".repeat(1025)}),
    )
    .await
    .unwrap();
    for name in [
        "PYTHONDONTWRITEBYTECODE",
        "E0",
        "E1",
        "E2",
        "E3",
        "E4",
        "E5",
        "E6",
        "E7",
        "E8",
    ] {
        control_call(
            &fixture,
            Origin::Event,
            "environment.set",
            json!({"name": name, "value": "0"}),
        )
        .await
        .unwrap();
    }
    assert!(
        control_call(
            &fixture,
            Origin::Event,
            "process.start",
            json!({"session": "large", "name": "sh", "path": sh["path"], "sha256": sh["sha256"],
                "arguments": ["-c", "printf '{\"length\":%s,\"python\":\"%s\"}\\n' \"${#FIXTURE_VALUE}\" \"$PYTHONDONTWRITEBYTECODE\"; read marker"], "framing": "ndjson"})
        )
        .await
        .is_ok()
    );
    let result = control_call(
        &fixture,
        Origin::Event,
        "process.exchange",
        json!({"session": "large", "wait_ms": 1000}),
    )
    .await
    .unwrap();
    assert_eq!(
        result["messages"][0],
        json!({"length": 1025, "python": "0"})
    );
    control_call(
        &fixture,
        Origin::Event,
        "process.stop",
        json!({"session": "large"}),
    )
    .await
    .unwrap();
    assert!(control_call(&fixture, Origin::Event, "process.start", json!({"session": "explicit_large", "name": "sh", "path": sh["path"], "sha256": sh["sha256"], "environment": {"FIXTURE_VALUE": "x".repeat(1025)}})).await.is_err());
    for name in [
        "FIXTURE_VALUE",
        "PYTHONDONTWRITEBYTECODE",
        "E0",
        "E1",
        "E2",
        "E3",
        "E4",
        "E5",
        "E6",
        "E7",
        "E8",
    ] {
        control_call(
            &fixture,
            Origin::Event,
            "environment.set",
            json!({"name": name, "value": null}),
        )
        .await
        .unwrap();
    }
    for name in ["FIXTURE_VALUE", "E0", "E1", "E2"] {
        control_call(
            &fixture,
            Origin::Event,
            "environment.set",
            json!({"name": name, "value": "y".repeat(4096)}),
        )
        .await
        .unwrap();
    }
    control_call(&fixture, Origin::Event, "process.start", json!({"session": "separate_bounds", "name": "sh", "path": sh["path"], "sha256": sh["sha256"], "environment": {"E3": "z".repeat(1024)},
        "arguments": ["-c", "printf '{\"persistent\":%s,\"explicit\":%s}\\n' \"${#FIXTURE_VALUE}\" \"${#E3}\"; read marker"], "framing": "ndjson"})).await.unwrap();
    let result = control_call(
        &fixture,
        Origin::Event,
        "process.exchange",
        json!({"session": "separate_bounds", "wait_ms": 1000}),
    )
    .await
    .unwrap();
    assert_eq!(
        result["messages"][0],
        json!({"persistent": 4096, "explicit": 1024})
    );
    control_call(
        &fixture,
        Origin::Event,
        "process.stop",
        json!({"session": "separate_bounds"}),
    )
    .await
    .unwrap();
    let result = control_call(&fixture, Origin::Event, "exec.run", json!({"program": "sh", "argv": ["-c", "printf '%s:%s' \"${#FIXTURE_VALUE}\" \"${#E3}\""], "env": {"E3": "z".repeat(1024)}})).await.unwrap();
    assert_eq!(result["stdout"], "4096:1024");
    let store = ModStore::open(fixture.lead.host.root.clone()).unwrap();
    let package = fixture
        ._dir
        .path()
        .join("packages/control")
        .canonicalize()
        .unwrap();
    store.enable(&package, false).unwrap();
    fixture.core.runtime.lock().unwrap().reload().unwrap();
    store.enable(&package, true).unwrap();
    fixture.core.runtime.lock().unwrap().reload().unwrap();
    let value = control_call(
        &fixture,
        Origin::Event,
        "environment.read",
        json!({"names": ["FIXTURE_VALUE"]}),
    )
    .await
    .unwrap();
    assert_ne!(value["values"]["FIXTURE_VALUE"]["value"], "y".repeat(4096));
}

#[tokio::test(flavor = "multi_thread")]
async fn scoped_environment_session_dispatch_rejects_a_different_captured_source() {
    let Some(mut fixture) = fixture(&[Package {
        id: "control",
        capabilities: &["exec", "fs.read", "fs.write"],
        manifest: json!({"exec_environment": ["FIXTURE_VALUE"]}),
        source: "export default () => {}",
    }]) else {
        return;
    };
    let _manager = attach_thread_with_sandbox_mode(
        &mut fixture,
        Some(codex_protocol::config_types::SandboxMode::WorkspaceWrite),
    )
    .await;
    fixture.core.expansion.thread_started(&fixture.lead);
    super::intercept::install_dispatcher(&fixture.core);
    let source = fixture
        .core
        .runtime
        .lock()
        .unwrap()
        .grants("control")
        .unwrap()
        .source_sha256;
    let thread = fixture.lead.thread.to_string();
    let call = |source: &str, operation: &str, arguments: Value| {
        codex_omd::host::session_call(
            &thread,
            "control",
            Some(source),
            None,
            ModHostCall {
                operation: operation.into(),
                arguments,
            },
            &|| true,
        )
    };
    call(
        &source,
        "environment.set",
        json!({"name": "FIXTURE_VALUE", "value": "scoped"}),
    )
    .unwrap();
    for (operation, arguments) in [
        ("environment.read", json!({"names": ["FIXTURE_VALUE"]})),
        (
            "environment.set",
            json!({"name": "FIXTURE_VALUE", "value": "foreign"}),
        ),
    ] {
        assert_eq!(
            call("different-source", operation, arguments)
                .unwrap_err()
                .to_string(),
            "host_caller_source_changed"
        );
    }
    let value = call(
        &source,
        "environment.read",
        json!({"names": ["FIXTURE_VALUE"]}),
    )
    .unwrap();
    assert_eq!(value["values"]["FIXTURE_VALUE"]["value"], "scoped");
    let write = json!({"program": "sh", "argv": ["-c", "printf forbidden > scoped-policy-proof"], "write": true});
    let result = call(&source, "exec.run", write.clone()).unwrap();
    assert_eq!(result["exit_code"], 0);
    let proof = fixture.lead.host.repository.join("scoped-policy-proof");
    assert_eq!(std::fs::read_to_string(&proof).unwrap(), "forbidden");
    std::fs::remove_file(&proof).unwrap();
    let policy =
        serde_json::to_value(codex_protocol::models::PermissionProfile::read_only()).unwrap();
    let read = codex_omd::host::session_call(
        &thread,
        "control",
        Some(&source),
        Some(&policy),
        ModHostCall {
            operation: "exec.run".into(),
            arguments: json!({"program": "sh", "argv": ["-c", "printf %s \"$FIXTURE_VALUE\""]}),
        },
        &|| true,
    )
    .unwrap();
    assert_eq!(read["exit_code"], 0);
    assert_eq!(read["stdout"], "scoped");
    assert!(
        std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&fixture.lead.host.repository)
            .status()
            .unwrap()
            .success()
    );
    let snapshot = control_call(&fixture, Origin::Event, "workspace.snapshot", json!({}))
        .await
        .unwrap();
    let read_snapshot = codex_omd::host::session_call(
        &thread, "control", Some(&source), Some(&policy), ModHostCall {
            operation: "exec.run".into(),
            arguments: json!({"snapshot": snapshot["snapshot"], "program": "sh", "argv": ["-c", "printf %s \"$FIXTURE_VALUE\""]}),
        }, &|| true,
    ).unwrap();
    assert_eq!(read_snapshot["exit_code"], 0);
    assert_eq!(read_snapshot["stdout"], "scoped");
    let denied = codex_omd::host::session_call(
        &thread,
        "control",
        Some(&source),
        Some(&policy),
        ModHostCall {
            operation: "exec.run".into(),
            arguments: write,
        },
        &|| true,
    )
    .unwrap_err();
    assert_eq!(denied.to_string(), "exec_cwd_unavailable");
    assert!(
        !fixture
            .lead
            .host
            .repository
            .join("scoped-policy-proof")
            .exists()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn scoped_environment_pre_rename_children_keep_mod_and_thread_scope() {
    let source = r#"export default api => api.on('workspace_pre_rename', () => {
      const sh = api.host.call('process.which', { names: ['sh'] }).found[0];
      api.host.call('process.start', { session: 'rename', name: 'sh', path: sh.path, sha256: sh.sha256,
        arguments: ['-c', 'printf \'{"value":"%s"}\\n\' "${FIXTURE_VALUE-unset}"; read marker'], framing: 'ndjson' });
      const result = api.host.call('process.exchange', { session: 'rename', wait_ms: 1000 });
      api.state.set(result.messages[0].value);
      api.host.call('process.stop', { session: 'rename' });
      return { status: 'fallback', reason: 'fixture' };
    });"#;
    let manifest = json!({"exec_environment": ["FIXTURE_VALUE"]});
    let capabilities = &["exec", "fs.read", "fs.write", "store"];
    let Some(mut fixture) = fixture(&[
        Package {
            id: "control",
            capabilities,
            manifest: manifest.clone(),
            source,
        },
        Package {
            id: "observer",
            capabilities,
            manifest,
            source,
        },
    ]) else {
        return;
    };
    let _manager = attach_thread(&mut fixture).await;
    std::fs::write(fixture.lead.host.repository.join("old.ts"), "export {};\n").unwrap();
    control_call(
        &fixture,
        Origin::Event,
        "environment.set",
        json!({"name": "FIXTURE_VALUE", "value": "scoped"}),
    )
    .await
    .unwrap();
    for (thread, expected) in [
        (fixture.lead.thread.to_string(), "scoped"),
        (ThreadId::new().to_string(), "unset"),
    ] {
        let authority = crate::workspace_operations::WorkspaceAuthority::for_platform(
            &fixture.lead.host.repository,
            PermissionProfile::from_runtime_permissions(
                &codex_protocol::permissions::FileSystemSandboxPolicy::unrestricted(),
                codex_protocol::permissions::NetworkSandboxPolicy::Restricted,
            ),
        )
        .unwrap();
        let runtime = fixture.core.input_runtime.clone();
        let processes = fixture.lead.session.processes.clone();
        let environment = fixture.core.environment.clone();
        let result = tokio::task::spawn_blocking(move || {
            let mut runtime = runtime.lock().unwrap();
            let generation = runtime.generation();
            authority.request_rename(
                json!({"old": "old.ts", "new": "new.ts"}),
                &mut runtime,
                &processes,
                &[],
                generation,
                &thread,
                &environment,
                || true,
            )
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result["status"], "fallback");
        let runtime = fixture.core.input_runtime.lock().unwrap();
        assert_eq!(runtime.state("control"), Some(&json!(expected)));
        assert_eq!(runtime.state("observer"), Some(&json!("unset")));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn scoped_environment_survives_observer_reload_and_stop_callbacks() {
    let Some(mut fixture) = fixture(&[Package {
        id: "control",
        capabilities: &["exec", "store", "lifecycle"],
        manifest: json!({"exec_environment": ["FIXTURE_VALUE"]}),
        source: r#"export default api => api.on('stop', () => api.state.set(api.host.call('exec.run', { program: 'sh', argv: ['-c', 'printf %s "$FIXTURE_VALUE"'] }).stdout));"#,
    }]) else {
        return;
    };
    let _manager = attach_thread(&mut fixture).await;
    control_call(
        &fixture,
        Origin::Event,
        "environment.set",
        json!({"name": "FIXTURE_VALUE", "value": "cleanup"}),
    )
    .await
    .unwrap();
    let path = fixture.lead.host.root.join("mods.json");
    let saved = std::fs::read(&path).unwrap();
    let mut empty: Value = serde_json::from_slice(&saved).unwrap();
    empty["mods"] = json!([]);
    std::fs::write(&path, serde_json::to_vec(&empty).unwrap()).unwrap();
    fixture.core.input_runtime.lock().unwrap().reload().unwrap();
    std::fs::write(&path, saved).unwrap();
    let read = control_call(
        &fixture,
        Origin::Event,
        "environment.read",
        json!({"names": ["FIXTURE_VALUE"]}),
    )
    .await
    .unwrap();
    assert_eq!(read["values"]["FIXTURE_VALUE"]["value"], "cleanup");
    let thread_store = ExtensionData::new("thread");
    thread_store.insert(fixture.lead.clone());
    mods(&fixture.core)
        .on_thread_stop(ThreadStopInput {
            session_store: &ExtensionData::new("session"),
            thread_store: &thread_store,
        })
        .await;
    assert_eq!(
        fixture.core.runtime.lock().unwrap().state("control"),
        Some(&json!("cleanup"))
    );
    let read = control_call(
        &fixture,
        Origin::Event,
        "environment.read",
        json!({"names": ["FIXTURE_VALUE"]}),
    )
    .await
    .unwrap();
    assert_ne!(read["values"]["FIXTURE_VALUE"]["value"], "cleanup");
}

#[tokio::test(flavor = "multi_thread")]
async fn scoped_environment_snapshot_execution_records_effective_values_and_secret_hashes() {
    let Some(mut fixture) = fixture(&[Package {
        id: "control",
        capabilities: &["exec", "fs.read"],
        manifest: json!({"exec_environment": ["FIXTURE_VALUE", "FIXTURE_TOKEN"]}),
        source: "export default () => {}",
    }]) else {
        return;
    };
    let _manager = attach_thread(&mut fixture).await;
    assert!(
        std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&fixture.lead.host.repository)
            .status()
            .unwrap()
            .success()
    );
    for (name, value) in [
        ("FIXTURE_VALUE", "scoped"),
        ("FIXTURE_TOKEN", "private-token"),
    ] {
        control_call(
            &fixture,
            Origin::Event,
            "environment.set",
            json!({"name": name, "value": value}),
        )
        .await
        .unwrap();
    }
    let snapshot = control_call(&fixture, Origin::Event, "workspace.snapshot", json!({}))
        .await
        .unwrap();
    for (explicit, expected) in [
        (json!({}), "scoped"),
        (json!({"FIXTURE_VALUE": "explicit"}), "explicit"),
    ] {
        let result = control_call(
            &fixture,
            Origin::Event,
            "exec.run",
            json!({
                "program": "sh", "argv": ["-c", "printf %s \"$FIXTURE_VALUE\""],
                "snapshot": snapshot["snapshot"], "env": explicit,
            }),
        )
        .await
        .unwrap();
        assert_eq!(result["exit_code"], 0);
        assert_eq!(result["stdout"], expected);
        let evidence = std::fs::read_dir(&fixture.lead.session.evidence)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("execution-")
            })
            .map(|path| std::fs::read(path).unwrap())
            .find(|bytes| json!(crate::execution::hash(bytes)) == result["evidence"]["sha256"])
            .unwrap();
        let recorded: Value = serde_json::from_slice(&evidence).unwrap();
        assert_eq!(
            recorded["environment"]["FIXTURE_VALUE"],
            json!({"value": expected})
        );
        assert_eq!(
            recorded["environment"]["FIXTURE_TOKEN"],
            json!({"sha256": crate::execution::hash(b"private-token")})
        );
        assert!(
            !String::from_utf8(evidence)
                .unwrap()
                .contains("private-token")
        );
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
fn a_client_recovery_reload_is_refused_mid_turn_and_otherwise_refreshes_like_a_turn_start() {
    let Some(fixture) = fixture(&[]) else {
        return;
    };
    let lead = &fixture.lead;
    let write = |exposure: u64| {
        let config = json!({"limits": {"requests": 400, "exposure_microusd": exposure, "seconds": 86400,
            "concurrent_workers": 4, "max_depth": 2}, "routes": [{"name": "first", "provider": "local",
            "model": "first-model", "reasoning_effort": "high", "responses_url": "http://127.0.0.1:1/v1/responses",
            "roles": ["lead"], "rates": {"input_microusd_per_million": 0, "cached_microusd_per_million": 0,
            "output_microusd_per_million": 0, "reservation_microusd": 0, "max_output_tokens": 1000,
            "input_token_ceiling": 1000, "included_subscription": true}}]});
        std::fs::write(lead.host.root.join("host.json"), config.to_string()).unwrap();
    };
    write(1000);
    let route = lead
        .host
        .route_config()
        .0
        .route("first", config::RouteRole::Lead, None)
        .cloned()
        .unwrap();
    lead.host
        .enroll(lead.thread, &lead.session, "lead", Some(&route), None)
        .unwrap();
    lead.host.refresh_session(&lead.session).unwrap();
    assert_eq!(lead.session.task.remaining().unwrap().2, 1000);
    *fixture.core.expansion.current.lock().unwrap() = Some(LeadHandle::new(lead));
    write(5000);
    fixture
        .core
        .expansion
        .running
        .lock()
        .unwrap()
        .insert(lead.thread.to_string(), "turn".into());
    assert!(
        super::super::clients::idle(&fixture.core)
            .unwrap_err()
            .starts_with("recovery_unavailable_during_turn")
    );
    fixture.core.expansion.running.lock().unwrap().clear();
    super::super::clients::idle(&fixture.core).unwrap();
    super::super::clients::reloaded(&fixture.core);
    assert_eq!(lead.session.task.remaining().unwrap().2, 5000);
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
        (
            tool.name.as_str(),
            serde_json::from_str::<serde_json::Value>(&arguments).unwrap()
        ),
        (
            "read",
            serde_json::json!({"checked": true, "path": "a.txt"})
        )
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
struct RecordingInvoker(std::sync::Mutex<Vec<(String, String, Value, bool)>>);

impl codex_extension_api::ToolInvoker for RecordingInvoker {
    fn invoke<'a>(
        &'a self,
        request: codex_extension_api::ToolInvocationRequest,
    ) -> ExtensionFuture<'a, Result<codex_extension_api::ToolInvocationOutcome, String>> {
        self.0.lock().unwrap().push((
            request.call_id,
            request.tool,
            request.arguments,
            request.serialized,
        ));
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
            capabilities: &["interception", "events"],
            manifest: json!({"subscriptions": {"channels": ["probe/*"]}}),
            source: "export default function (api) {\n  api.on('channel', () => { api.host.call('tools.invoke', { tool: 'read', arguments: { path: 'c.txt' } }); });\n  api.intercept('tool', { match: { tool: 'probe' } }, () => {\n    const check = api.host.call('tools.check', { tool: 'exec_command', arguments: { cmd: 'ls' } });\n    const run = api.host.call('tools.invoke', { tool: 'read', arguments: { path: 'b.txt' } });\n    return { output: `${check.decision} ${run.call_id} ${run.output}`, success: true };\n  });\n  api.intercept('tool', { match: { tool: 'read' } }, () => ({ output: 'own call intercepted', success: true }));\n}\n",
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
            json!({"path": "a.txt", "attempt": 2}),
            false
        )]
    );
    assert!(fixture.core.expansion.invoked.lock().unwrap().is_empty());
    fixture
        .core
        .expansion
        .invoked
        .lock()
        .unwrap()
        .insert("call-1:retry1".into(), String::new());
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
    *fixture.core.expansion.current.lock().unwrap() = Some(LeadHandle::new(&fixture.lead));
    delivery::publish(
        &fixture.core,
        &fixture.lead,
        "probe",
        json!({"channel": "go", "data": 1}),
    )
    .unwrap();
    delivery::deliver(&fixture.core).await;
    let calls = invoker.0.lock().unwrap().clone();
    assert_eq!(
        calls.iter().map(|call| call.3).collect::<Vec<_>>(),
        [false, false, true],
        "only calls outside a running tool wait for the turn's tool gate"
    );
    let chain = codex_omd::intercept_shared(
        &fixture.core.runtime,
        "tool",
        false,
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
        let delivered = delivery::publish(
            core,
            &fixture.lead,
            "herald",
            json!({"channel": "ping", "data": data}),
        )
        .unwrap();
        assert_eq!(delivered["delivered"], 1);
    }
    assert!(
        delivery::publish(
            core,
            &fixture.lead,
            "herald",
            json!({"channel": "Bad Name", "data": 1})
        )
        .is_err()
    );
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
    delivery::publish(
        core,
        &fixture.lead,
        "crier",
        json!({"channel": "news", "data": "a"}),
    )
    .unwrap();
    assert!(seen(json!(["a"])).await);
    codex_omd::event_bus::global()
        .lock()
        .unwrap()
        .publish(
            "crier",
            "news",
            json!("b"),
            None,
            &fixture.lead.thread.to_string(),
        )
        .unwrap();
    codex_omd::client_surface::wake();
    assert!(seen(json!(["a", "b"])).await);
    let ignored = delivery::publish(
        core,
        &fixture.lead,
        "crier",
        json!({"channel": "other", "data": "c"}),
    )
    .unwrap();
    assert_eq!(ignored["delivered"], 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn declared_subscriptions_receive_publications_before_any_delivery_round() {
    let Some(fixture) = fixture(&[Package {
        id: "preheard",
        capabilities: &["events"],
        manifest: json!({"subscriptions": {"channels": ["prespeaker/news"]}}),
        source: "export default function (api) { api.on('channel', () => {}); }\n",
    }]) else {
        return;
    };
    let delivery = codex_omd::event_bus::global()
        .lock()
        .unwrap()
        .publish(
            "prespeaker",
            "news",
            json!("early"),
            None,
            &fixture.lead.thread.to_string(),
        )
        .unwrap();
    assert_eq!(delivery.delivered, 1);
    let mut bus = codex_omd::event_bus::global().lock().unwrap();
    assert_eq!(bus.drain("preheard", 1)[0].data, json!("early"));
    bus.unsubscribe("preheard");
}

#[tokio::test(flavor = "multi_thread")]
async fn busy_queue_and_subscriber_do_not_starve_other_channel_subscribers() {
    let Some(fixture) = fixture(&[
        Package {
            id: "flooded",
            capabilities: &["events"],
            manifest: json!({"subscriptions": {"channels": ["floodgate/busy"]}}),
            source: "export default function (api) { api.on('channel', () => {}); }\n",
        },
        Package {
            id: "starved",
            capabilities: &["events", "store", "commands"],
            manifest: json!({"subscriptions": {"channels": ["floodgate/quiet"]}}),
            source: "export default function (api) {\n  api.on('channel', event => { api.state.set(event.data); });\n  api.command('seen', () => api.state.get());\n}\n",
        },
    ]) else {
        return;
    };
    let core = &fixture.core;
    let elsewhere = ThreadId::new();
    for session in (0..2 * 64).map(|index| ["a", "b"][index % 2]) {
        delivery::push(
            &core.expansion,
            delivery::Pending::Process {
                thread: elsewhere,
                owner: "flooded".into(),
                session: session.into(),
                bytes: Some(1),
            },
        );
    }
    for (channel, data) in std::iter::repeat_n(("busy", "noise"), 64).chain([("quiet", "go")]) {
        delivery::publish(
            core,
            &fixture.lead,
            "floodgate",
            json!({"channel": channel, "data": data}),
        )
        .unwrap();
    }
    assert!(delivery::deliver(core).await);
    let mut bus = codex_omd::event_bus::global().lock().unwrap();
    bus.unsubscribe("flooded");
    bus.unsubscribe("starved");
    drop(bus);
    assert_eq!(command(core, "starved", "seen"), json!("go"));
}

fn background_threads(core: &Arc<Core>, first: &Lead) -> Lead {
    let thread = ThreadId::new();
    let session = first.host.open_session(thread, false).unwrap();
    *session.data.0.lock().unwrap() = Some(codex_omd::scoped_data::ScopedDataHosts::new(
        first.host.root.clone(),
        first.host.repository.clone(),
        None,
        None,
        thread.to_string(),
    ));
    let second = Lead {
        host: first.host.clone(),
        session,
        thread,
        owner: "lead".into(),
        depth: 0,
        permission_profile: Arc::new(Mutex::new(PermissionProfile::default())),
    };
    for lead in [first, &second] {
        *lead.session.contract.lock().unwrap() =
            crate::contract::SessionContract::resolve(&lead.host, &[]);
        core.expansion.thread_started(lead);
        core.expansion
            .leads
            .lock()
            .unwrap()
            .insert(lead.thread, LeadHandle::new(lead));
    }
    *core.expansion.current.lock().unwrap() = Some(LeadHandle::new(&second));
    core.expansion.core.set(Arc::downgrade(core)).unwrap();
    second
}

async fn background_call(core: &Core, lead: &Lead, operation: &str, arguments: Value) -> Value {
    let source = core
        .runtime
        .lock()
        .unwrap()
        .grants("observer")
        .unwrap()
        .source_sha256;
    let caller = {
        let runtime = core.runtime.lock().unwrap();
        Caller {
            id: "observer",
            source: &source,
            grants: runtime.grants("observer"),
            generation: runtime.generation(),
            origin: Origin::Event,
            record_changes: false,
        }
    };
    dispatch(
        core,
        lead,
        &caller,
        ModHostCall {
            operation: operation.into(),
            arguments,
        },
        &Arc::new(AtomicBool::new(false)),
    )
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn background_channels_use_the_publishing_thread_and_refuse_dead_origins() {
    let Some(fixture) = fixture(&[Package {
        id: "observer",
        capabilities: &["events", "store", "commands", "agents", "autonomous"],
        manifest: json!({"state_scope": "thread", "subscriptions": {"channels": ["observer/news"]},
            "autonomy": {"max_queued": 2, "max_turns": 1, "max_continuations": 1}}),
        source: "export default function(api) { api.on('channel', e => { const seen = [e.data, api.host.call('task.status', {}).ledger.thread_id]; if (e.data === 'worker') seen.push(api.host.tryCall('turns.queued', {})); api.state.set(seen); }); api.command('seen', () => api.state.get()); }",
    }]) else {
        return;
    };
    let second = background_threads(&fixture.core, &fixture.lead);
    for (lead, data) in [(&fixture.lead, "first"), (&second, "second")] {
        background_call(
            &fixture.core,
            lead,
            "events.publish",
            json!({"channel": "news", "data": data}),
        )
        .await;
    }
    delivery::deliver(&fixture.core).await;
    for (lead, data) in [(&fixture.lead, "first"), (&second, "second")] {
        let _thread = codex_omd::StateThread::enter(Some(lead.thread.to_string()));
        assert_eq!(
            command(&fixture.core, "observer", "seen"),
            json!([data, lead.thread.to_string()])
        );
    }
    let worker = Lead {
        owner: "mod-observer-worker".into(),
        depth: 1,
        ..second
    };
    fixture.core.expansion.thread_started(&worker);
    fixture
        .core
        .expansion
        .leads
        .lock()
        .unwrap()
        .remove(&worker.thread);
    let recovered = fixture.core.expansion.thread(worker.thread).unwrap();
    assert_eq!(
        (recovered.owner.as_str(), recovered.depth),
        ("mod-observer-worker", 1)
    );
    assert!(Arc::ptr_eq(
        &recovered.permission_profile,
        &worker.permission_profile
    ));
    background_call(
        &fixture.core,
        &worker,
        "events.publish",
        json!({"channel": "news", "data": "worker"}),
    )
    .await;
    delivery::deliver(&fixture.core).await;
    let worker_seen = {
        let _thread = codex_omd::StateThread::enter(Some(worker.thread.to_string()));
        command(&fixture.core, "observer", "seen")
    };
    assert_eq!(worker_seen[0], "worker");
    assert_eq!(worker_seen[2]["ok"], false);
    assert!(
        worker_seen[2]["error"]
            .as_str()
            .unwrap()
            .contains("turn_queue_lead_only")
    );
    fixture
        .core
        .expansion
        .threads
        .lock()
        .unwrap()
        .remove(&fixture.lead.thread);
    fixture
        .core
        .expansion
        .leads
        .lock()
        .unwrap()
        .remove(&fixture.lead.thread);
    background_call(
        &fixture.core,
        &fixture.lead,
        "events.publish",
        json!({"channel": "news", "data": "dead"}),
    )
    .await;
    delivery::deliver(&fixture.core).await;
    let _thread = codex_omd::StateThread::enter(Some(worker.thread.to_string()));
    assert_eq!(command(&fixture.core, "observer", "seen"), worker_seen);
}

#[tokio::test(flavor = "multi_thread")]
async fn background_timers_replace_and_cancel_only_in_the_calling_thread() {
    let Some(fixture) = fixture(&[Package {
        id: "observer",
        capabilities: &["events", "store", "commands"],
        manifest: json!({"state_scope": "thread"}),
        source: "export default function(api) { api.on('timer', e => api.state.set([...(api.state.get() ?? []), e.key])); api.command('seen', () => api.state.get()); }",
    }]) else {
        return;
    };
    let second = background_threads(&fixture.core, &fixture.lead);
    for lead in [&fixture.lead, &second, &fixture.lead] {
        background_call(
            &fixture.core,
            lead,
            "events.schedule",
            json!({"key": "hop", "delay_ms": 100}),
        )
        .await;
    }
    assert_eq!(fixture.core.expansion.timers.lock().unwrap().len(), 2);
    let cancelled = background_call(
        &fixture.core,
        &fixture.lead,
        "events.cancel",
        json!({"key": "hop"}),
    )
    .await;
    assert_eq!(cancelled["cancelled"], true);
    assert_eq!(
        background_call(
            &fixture.core,
            &fixture.lead,
            "events.cancel",
            json!({"key": "hop"})
        )
        .await["cancelled"],
        false
    );
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    delivery::deliver(&fixture.core).await;
    for (lead, expected) in [(&fixture.lead, Value::Null), (&second, json!(["hop"]))] {
        let _thread = codex_omd::StateThread::enter(Some(lead.thread.to_string()));
        assert_eq!(command(&fixture.core, "observer", "seen"), expected);
    }
    let limit = fixture.lead.host.config.mod_limits.bounded().timers_per_mod;
    for index in 0..limit {
        let lead = if index % 2 == 0 {
            &fixture.lead
        } else {
            &second
        };
        background_call(
            &fixture.core,
            lead,
            "events.schedule",
            json!({"key": format!("quota-{index}"), "delay_ms": 1000}),
        )
        .await;
    }
    let runtime = fixture.core.runtime.lock().unwrap();
    let caller = Caller {
        id: "observer",
        source: "source",
        grants: runtime.grants("observer"),
        generation: runtime.generation(),
        origin: Origin::Event,
        record_changes: false,
    };
    drop(runtime);
    assert_eq!(
        delivery::schedule(
            &fixture.core,
            &second,
            &caller,
            json!({"key": "overflow", "delay_ms": 1000})
        )
        .unwrap_err(),
        "timer_limit"
    );
    delivery::retain_sources(&fixture.core, &BTreeMap::new());
    assert!(fixture.core.expansion.timers.lock().unwrap().is_empty());
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
    activity::turn_ended(core, lead, "completed", None, None);
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
async fn agent_events_reach_thread_scoped_observers_of_the_session() {
    let Some(fixture) = fixture(&[Package {
        id: "watcher",
        capabilities: &["middleware", "commands", "store"],
        manifest: json!({"state_scope": "thread"}),
        source: "export default function (api) {\n  api.on('agent', e => { api.state.set([...(api.state.get() ?? []), e.phase]); });\n  api.command('seen', () => api.state.get());\n}\n",
    }]) else {
        return;
    };
    let mods = mods(&fixture.core);
    let child = ThreadId::new();
    let source = SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
        parent_thread_id: fixture.lead.thread,
        depth: 1,
        agent_path: None,
        agent_nickname: None,
        agent_role: None,
    });
    mods.native_agent_started(child, &source, &ExtensionData::new(child.to_string()));
    let lead = fixture.lead.thread.to_string();
    let seen = settle(|| {
        let _thread = codex_omd::StateThread::enter(Some(lead.clone()));
        Some(command(&fixture.core, "watcher", "seen")).filter(|seen| !seen.is_null())
    })
    .await;
    assert_eq!(seen, json!(["start"]));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_ledger_handed_to_mods_counts_observed_requests() {
    let Some(fixture) = fixture(&[]) else {
        return;
    };
    for _ in 0..70 {
        fixture
            .lead
            .session
            .task
            .observe(
                "lead",
                "openai",
                "gpt",
                Some(json!({"input_tokens": 1})),
                "completed",
            )
            .unwrap();
    }
    let ledger = fixture.lead.ledger();
    assert_eq!(ledger["cost"]["observed_requests"], 70);
    assert!(ledger["cost"].get("observed").is_none());
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
        ..Default::default()
    };
    let approver = grants(&["approvals", "middleware", "approve"]);
    let check =
        |grants: Option<&codex_omd::ModGrants>, kind: &str, decision: &str, details: Value| {
            approvals::within_grant(grants, kind, decision, &details, Path::new("/repository"))
        };
    let cargo = json!({"command": ["cargo", "test"], "cwd": "file:///work/crate"});
    assert!(check(Some(&approver), "exec", "ask", cargo.clone()).is_ok());
    for command in [
        json!(["/bin/zsh", "-lc", "./cargo test"]),
        json!(["/tmp/x/cargo", "test"]),
        json!(["/tmp/x/cargo", "-c", "cargo"]),
    ] {
        assert!(
            check(
                Some(&approver),
                "exec",
                "ask",
                json!({"command": command, "cwd": "file:///work"})
            )
            .is_err()
        );
    }
    let root = tempfile::tempdir().expect("root");
    std::os::unix::fs::symlink("/etc", root.path().join("link")).expect("symlink");
    let mut linked = approver.clone();
    if let Some(scope) = linked.approves.as_mut() {
        scope.roots = vec![root.path().display().to_string()];
    }
    assert!(
        check(
            Some(&linked),
            "patch",
            "ask",
            json!({"files": [root.path().join("a.rs")]})
        )
        .is_ok()
    );
    assert!(
        check(
            Some(&linked),
            "patch",
            "ask",
            json!({"files": [root.path().join("link/hosts")]})
        )
        .is_err()
    );
    assert!(
        check(
            Some(&approver),
            "exec",
            "ask",
            json!({"command": ["/bin/sh", "-lc", "cargo test"], "cwd": "file:///work"})
        )
        .is_ok()
    );
    let mut prefixed = approver.clone();
    if let Some(scope) = prefixed.approves.as_mut() {
        scope.tools = vec!["s*".into()];
    }
    assert!(
        check(
            Some(&prefixed),
            "exec",
            "ask",
            json!({"command": ["/bin/sh"], "cwd": "file:///work"})
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
    let grep = ToolSpecView {
        description: "—".repeat(2048),
        ..view("grep")
    };
    let adjustment = mods
        .adjust_tool_specs(
            &thread_store,
            &[view("read"), grep, view("mcp__srv__search")],
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
async fn tool_inventory_observation_tracks_consumers() {
    use codex_extension_api::ToolSpecContributor;
    if let Some(empty) = fixture(&[]) {
        let thread = ExtensionData::new("thread");
        thread.insert(empty.lead.clone());
        assert!(!mods(&empty.core).observing(&thread));
    }
    for (capabilities, source) in [
        (vec!["inventory"], "export default api => {}"),
        (
            vec!["interception"],
            "export default api => api.intercept('tool', (e, next) => next(e))",
        ),
        (
            vec!["interception", "tools"],
            "export default api => api.intercept('tool_specs', (e, next) => next(e))",
        ),
    ] {
        let Some(fixture) = fixture(&[Package {
            id: "consumer",
            capabilities: &capabilities,
            source,
            manifest: json!({}),
        }]) else {
            return;
        };
        let thread = ExtensionData::new("thread");
        thread.insert(fixture.lead.clone());
        assert!(mods(&fixture.core).observing(&thread), "{source}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn tool_inventory_lists_with_hidden_and_deferred_stores_once_and_validates_final_arguments() {
    use codex_extension_api::ToolInventoryEntry;
    use codex_extension_api::ToolInventoryView;
    use codex_extension_api::ToolSpecContributor;
    let Some(fixture) = fixture(&[Package {
        id: "consumer",
        capabilities: &["inventory"],
        source: "export default api => {}",
        manifest: json!({}),
    }]) else {
        return;
    };
    let mods = mods(&fixture.core);
    let thread_store = ExtensionData::new("thread".to_owned());
    assert!(!mods.observing(&thread_store));
    thread_store.insert(fixture.lead.clone());
    assert!(mods.observing(&thread_store));
    let schema =
        json!({"type": "object", "properties": {"cmd": {"type": "string"}}, "required": ["cmd"]});
    let entry =
        |name: &str, parameters: &Value, effective: Option<(&Value, bool)>| ToolInventoryEntry {
            name: name.to_owned(),
            kind: "builtin",
            server: None,
            description: "d".into(),
            freeform: parameters.is_null(),
            parameters: parameters.clone(),
            effective: effective.map(|(parameters, deferred)| ToolInventoryView {
                description: "d".into(),
                parameters: parameters.clone(),
                deferred,
            }),
        };
    let replaced = json!({"type": "object"});
    let tools = [
        entry("run", &schema, Some((&schema, false))),
        entry("hidden", &schema, None),
        entry("later", &schema, Some((&schema, true))),
        entry("patch", &Value::Null, Some((&Value::Null, false))),
        entry("loose", &schema, Some((&replaced, false))),
    ];
    mods.observe_tool_inventory(&thread_store, &tools);
    let listed = tool_specs::list(&fixture.core, &fixture.lead).unwrap();
    assert_eq!(listed["thread_id"], fixture.lead.thread.to_string());
    assert_eq!(listed["tools"][1]["effective"], Value::Null);
    assert_eq!(listed["tools"][2]["effective"]["deferred"], true);
    assert_eq!(listed["tools"][3]["original"]["freeform"], true);
    let stored = fixture.lead.host.root.join("tool-inventory.json");
    assert_eq!(
        std::fs::read(&stored).unwrap(),
        serde_json::to_vec(&listed).unwrap()
    );
    std::fs::write(&stored, "sentinel").unwrap();
    mods.observe_tool_inventory(&thread_store, &tools);
    assert_eq!(std::fs::read(&stored).unwrap(), b"sentinel");
    let validate = |tool: &str, arguments: Value, rewritten: bool| {
        fixture
            .core
            .expansion
            .validate_call(fixture.lead.thread, tool, &arguments, rewritten)
    };
    assert_eq!(validate("run", json!({"cmd": "ls"}), true), Ok(()));
    assert_eq!(
        validate("run", json!({"cmd": 1}), true),
        Err("tool_arguments_invalid: run: /cmd: expected string, got number".into())
    );
    assert_eq!(validate("run", json!({"cmd": 1}), false), Ok(()));
    assert_eq!(
        validate("loose", json!({}), false),
        Err("tool_arguments_invalid: loose: /cmd: required".into())
    );
    assert_eq!(validate("patch", json!("anything"), true), Ok(()));
    assert_eq!(validate("unknown", json!(1), true), Ok(()));
    ModStore::open(fixture.lead.host.root.clone())
        .unwrap()
        .revoke("consumer")
        .unwrap();
    {
        let mut runtime = fixture.core.runtime.lock().unwrap();
        runtime.reload().unwrap();
        fixture.core.expansion.refresh(&runtime);
    }
    assert!(!mods.observing(&thread_store));
    mods.observe_tool_inventory(&thread_store, &tools);
    assert_eq!(validate("loose", json!({}), false), Ok(()));
    mods.on_thread_stop(ThreadStopInput {
        session_store: &ExtensionData::new("session".to_owned()),
        thread_store: &thread_store,
    })
    .await;
    assert!(
        tool_specs::list(&fixture.core, &fixture.lead)
            .unwrap_err()
            .starts_with("tools_unavailable"),
        "a closed thread drops its tool snapshot"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn invalid_rewritten_tool_arguments_settle_the_chain_with_their_cause() {
    use codex_extension_api::ToolInventoryEntry;
    use codex_extension_api::ToolInventoryView;
    use codex_extension_api::ToolSpecContributor;
    let Some(fixture) = fixture(&[Package {
        id: "rewrite",
        capabilities: &["interception"],
        manifest: Value::Null,
        source: "export default function (api) {\n  api.intercept('tool', { match: { tool: 'run' } }, (e, next) => next({ ...e, arguments: { cmd: 1 } }));\n  api.intercept('tool', { match: { tool: 'again' } }, async (e, next) => {\n    const first = await next(e);\n    return first.success ? first : next({ ...e, arguments: { cmd: 2 } });\n  });\n}\n",
    }]) else {
        return;
    };
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
    let schema =
        json!({"type": "object", "properties": {"cmd": {"type": "string"}}, "required": ["cmd"]});
    let tools = ["run", "again"].map(|name| ToolInventoryEntry {
        name: name.to_owned(),
        kind: "builtin",
        server: None,
        description: "d".into(),
        freeform: false,
        parameters: schema.clone(),
        effective: Some(ToolInventoryView {
            description: "d".into(),
            parameters: schema.clone(),
            deferred: false,
        }),
    });
    mods.observe_tool_inventory(&thread_store, &tools);
    let payload = codex_tools::ToolPayload::Function {
        arguments: r#"{"cmd":"ls"}"#.to_owned(),
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
    static RUN: std::sync::LazyLock<ToolName> = std::sync::LazyLock::new(|| ToolName::plain("run"));
    static AGAIN: std::sync::LazyLock<ToolName> =
        std::sync::LazyLock::new(|| ToolName::plain("again"));
    let error = mods
        .intercept_tool(start("call-1", &RUN))
        .await
        .unwrap_err();
    assert!(error.starts_with("tool_arguments_invalid: run"), "{error}");
    let chains = || fixture.core.runtime.lock().unwrap().status()["chains"].to_string();
    assert!(chains().contains("tool_arguments_invalid"), "{}", chains());
    assert!(!chains().contains("callback_cancelled"), "{}", chains());

    assert_eq!(
        mods.intercept_tool(start("call-2", &AGAIN)).await.unwrap(),
        ToolInterception::Continue(None)
    );
    mods.replace_tool_output(codex_extension_api::ToolOutputInput {
        session_store: &session_store,
        thread_store: &thread_store,
        turn_store: &turn_store,
        turn_id: "turn-1",
        call_id: "call-2",
        tool_name: &AGAIN,
        arguments: Some(r#"{"cmd":"ls"}"#),
        success: false,
        text: "first attempt failed",
    })
    .await;
    assert!(
        invoker.0.lock().unwrap().is_empty(),
        "an invalid retry is never dispatched"
    );
    assert!(
        chains().contains("tool_arguments_invalid: again"),
        "{}",
        chains()
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

#[test]
fn timer_delivery_budget_coalesces_keys_and_does_not_block_other_owners() {
    let state = State::default();
    let thread = ThreadId::new();
    let timer = |owner: &str, key: &str| delivery::Pending::Timer {
        thread,
        owner: owner.into(),
        key: key.into(),
        source: "source".into(),
        incarnation: 0,
    };
    for item in [
        timer("a", "one"),
        timer("a", "one"),
        timer("a", "two"),
        timer("b", "one"),
    ] {
        delivery::push(&state, item);
    }
    assert_eq!(state.pending.lock().unwrap().len(), 3);
    let now = std::time::Instant::now();
    assert!(
        matches!(delivery::next_pending(&state, now), Some(delivery::Pending::Timer { owner, key, .. }) if owner == "a" && key == "one")
    );
    assert!(
        matches!(delivery::next_pending(&state, now), Some(delivery::Pending::Timer { owner, .. }) if owner == "b")
    );
    assert!(delivery::next_pending(&state, now + std::time::Duration::from_millis(99)).is_none());
    assert!(
        matches!(delivery::next_pending(&state, now + std::time::Duration::from_millis(100)), Some(delivery::Pending::Timer { key, .. }) if key == "two")
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
    let source = grants.as_ref().unwrap().source_sha256.clone();
    let generation = fixture.core.runtime.lock().unwrap().generation();
    let caller = Caller {
        id: "steerer",
        source: &source,
        grants,
        generation,
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
    for (arguments, expected) in [
        (
            json!({"route": "w", "prompt": "x", "effort": "turbo"}),
            "model_call_option_invalid",
        ),
        (
            json!({"route": "w", "prompt": "x", "max_output_tokens": 0}),
            "model_call_option_invalid",
        ),
        (
            json!({"route": "w", "prompt": "x", "output": {"schema": "text"}}),
            "model_call_option_invalid",
        ),
        (
            json!({"route": "w", "prompt": "x", "context": vec!["c"; 9]}),
            "model_call_option_invalid",
        ),
        (
            json!({"route": "w", "prompt": "x", "tools": ["read_file"]}),
            "model_tools_require_fork",
        ),
        (
            json!({"route": "lead", "prompt": "x"}),
            "lead_route_unconfigured",
        ),
    ] {
        assert_eq!(run(arguments).await.unwrap_err(), expected);
    }
    let fork = operations::dispatch(
        &fixture.core,
        &fixture.lead,
        Caller {
            grants: caller.grants.clone(),
            ..caller
        },
        None,
        ModHostCall {
            operation: "model.fork".into(),
            arguments: json!({"prompt": "summarize the thread"}),
        },
        &cancelled,
    )
    .await
    .unwrap_err();
    assert_eq!(
        fork, "native_thread_manager_stopped",
        "a fork needs the live thread"
    );
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

#[tokio::test(flavor = "multi_thread")]
async fn mcp_connect_builds_only_declared_servers_for_the_engine() {
    let Some(fixture) = fixture(&[Package {
        id: "connector",
        capabilities: &["mcp"],
        manifest: json!({"mcp_servers": {"docs": {"command": "docs-server", "args": ["--stdio"]}}}),
        source: "export default function () {}\n",
    }]) else {
        return;
    };
    let (grants, generation) = {
        let runtime = fixture.core.runtime.lock().unwrap();
        (runtime.grants("connector"), runtime.generation())
    };
    let caller = Caller {
        id: "connector",
        source: "",
        grants,
        generation,
        origin: Origin::Event,
        record_changes: false,
    };
    let flag = AtomicBool::new(false);
    let connect = |server: &str| ModHostCall {
        operation: "mcp.connect".into(),
        arguments: json!({"server": server}),
    };
    let error = super::access::dispatch(
        &fixture.core,
        &fixture.lead,
        &caller,
        connect("other"),
        &flag,
    )
    .await
    .unwrap_err();
    assert_eq!(error, "mcp_server_undeclared: other");
    let error = super::access::dispatch(
        &fixture.core,
        &fixture.lead,
        &caller,
        connect("docs"),
        &flag,
    )
    .await
    .unwrap_err();
    assert_eq!(error, "native_thread_manager_stopped");
}

#[tokio::test(flavor = "multi_thread")]
async fn mcp_refresh_tracks_rejected_publications_and_preserves_stale_cleanup_ownership() {
    let Some(mut fixture) = fixture(&[Package {
        id: "connector",
        capabilities: &["mcp"],
        manifest: json!({"mcp_servers": {"docs": {"command": "/usr/bin/true"}}}),
        source: "export default function () {}\n",
    }]) else {
        return;
    };
    let mut config = codex_core::config::ConfigBuilder::default()
        .codex_home(fixture._dir.path().join("codex"))
        .harness_overrides(codex_core::config::ConfigOverrides {
            cwd: Some(fixture.lead.host.repository.clone()),
            ..Default::default()
        })
        .loader_overrides(codex_core::config::LoaderOverrides::without_managed_config_for_tests())
        .build()
        .await
        .unwrap();
    config.model_provider.base_url = Some("http://127.0.0.1:9/v1".into());
    let policy = codex_config::CloudConfigBundlePolicy::default();
    let mut snapshot = codex_config::CloudConfigBundleSnapshot {
        bundle: Ok(None),
        binding: None,
    };
    policy.publish_snapshot(&mut snapshot);
    config.config_layer_stack = config
        .config_layer_stack
        .with_cloud_config_binding(snapshot.binding);
    let manager = Arc::new(
        codex_core::test_support::thread_manager_with_models_provider(
            codex_login::CodexAuth::from_api_key("test"),
            config.model_provider.clone(),
        ),
    );
    let started = manager
        .start_thread(codex_core::StartThreadOptions::new(config))
        .await
        .unwrap();
    let host = &fixture.lead.host;
    fixture.lead.host = Arc::new(Host {
        root: host.root.clone(),
        repository: host.repository.clone(),
        repository_identity: host.repository_identity.clone(),
        config: host.config.clone(),
        routes: Mutex::new(crate::RouteTable {
            stamp: None,
            config: Arc::new(host.config.clone()),
            error: None,
        }),
        accounts: host.accounts.clone(),
        manager: Arc::downgrade(&manager),
        epoch: host.epoch,
    });
    fixture.lead.thread = started.thread_id;
    let (grants, generation) = {
        let runtime = fixture.core.runtime.lock().unwrap();
        (runtime.grants("connector"), runtime.generation())
    };
    let caller = Caller {
        id: "connector",
        source: "",
        grants,
        generation,
        origin: Origin::Event,
        record_changes: false,
    };
    let flag = AtomicBool::new(false);
    let request = |operation: &str| ModHostCall {
        operation: operation.into(),
        arguments: json!({"server": "docs"}),
    };
    let mut changed = codex_config::CloudConfigBundle::default();
    changed
        .requirements_toml
        .enterprise_managed
        .push(codex_config::CloudRequirementsFragment {
            id: "changed".into(),
            name: "changed".into(),
            contents: String::new(),
        });
    policy.observe_remote_bundle(&changed);
    for operation in ["mcp.connect", "mcp.disconnect", "mcp.connect"] {
        super::access::dispatch(
            &fixture.core,
            &fixture.lead,
            &caller,
            request(operation),
            &flag,
        )
        .await
        .unwrap();
    }
    let mut current_snapshot = codex_config::CloudConfigBundleSnapshot {
        bundle: Ok(Some(changed.clone())),
        binding: None,
    };
    policy.publish_snapshot(&mut current_snapshot);
    let current = started.thread.config().await;
    let mut next = current.as_ref().clone();
    next.config_layer_stack = next
        .config_layer_stack
        .with_cloud_config_binding(current_snapshot.binding);
    assert_eq!(
        started.thread.refresh_mcp_config(current, next).await,
        codex_core::ConfigRefreshOutcome::Published
    );
    changed.requirements_toml.enterprise_managed[0].id = "changed-again".into();
    policy.observe_remote_bundle(&changed);
    policy.publish_snapshot(&mut codex_config::CloudConfigBundleSnapshot {
        bundle: Ok(Some(changed)),
        binding: None,
    });
    super::access::release_servers(&fixture.lead, generation, Some("connector")).await;
    assert!(
        started
            .thread
            .config()
            .await
            .mcp_servers
            .get()
            .contains_key("mod_connector_docs")
    );
    let error = super::access::dispatch(
        &fixture.core,
        &fixture.lead,
        &caller,
        request("mcp.disconnect"),
        &flag,
    )
    .await
    .unwrap_err();
    assert_eq!(error, "mcp_config_stale");
    started.thread.shutdown_and_wait().await.unwrap();
}

fn serve(server: tiny_http::Server, denied: u16) {
    for request in server.incoming_requests() {
        let header = |name: &str, value: &str| tiny_http::Header::from_bytes(name, value).unwrap();
        let path = request.url().to_owned();
        let auth = request
            .headers()
            .iter()
            .any(|h| h.field.equiv("authorization"));
        match path.as_str() {
            "/out" => request
                .respond(
                    tiny_http::Response::empty(302)
                        .with_header(header("location", &format!("http://127.0.0.1:{denied}/"))),
                )
                .unwrap(),
            "/in?token=secret" => request
                .respond(tiny_http::Response::empty(303).with_header(header("location", "/final")))
                .unwrap(),
            "/final" => request
                .respond(
                    tiny_http::Response::from_string(format!("ok auth={auth}"))
                        .with_header(header("set-cookie", "session=s")),
                )
                .unwrap(),
            "/utf8" => request
                .respond(tiny_http::Response::from_string("a€b"))
                .unwrap(),
            "/slow" => {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let _ = request.respond(tiny_http::Response::empty(204));
                });
            }
            _ => request
                .respond(tiny_http::Response::from_string("stream-body"))
                .unwrap(),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn structured_http_reassesses_redirects_streams_cancels_and_records_receipts() {
    let granted = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let denied = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = granted.server_addr().to_ip().unwrap().port();
    let denied_port = denied.server_addr().to_ip().unwrap().port();
    std::thread::spawn(move || serve(granted, denied_port));
    std::thread::spawn(move || serve(denied, 0));
    let origin = format!("http://127.0.0.1:{port}");
    let Some(fixture) = fixture(&[Package {
        id: "fetcher",
        capabilities: &["http"],
        manifest: json!({"http_access": {"origins": [origin], "credentials": ["p1", "owned"]}}),
        source: "export default function () {}\n",
    }]) else {
        return;
    };
    *fixture.lead.session.contract.lock().unwrap() =
        crate::contract::SessionContract::resolve(&fixture.lead.host, &[]);
    let profiles =
        codex_omd::credentials::CredentialProfiles::local(&fixture.core.host.root).unwrap();
    let up = profiles
        .create("up", "provider", Some("up"), Some("https://up.example"))
        .unwrap();
    let flag = Arc::new(AtomicBool::new(false));
    let call = |operation: &str, arguments: Value| ModHostCall {
        operation: operation.into(),
        arguments,
    };
    let run = |request: ModHostCall| {
        let flag = flag.clone();
        let (core, lead) = (fixture.core.clone(), fixture.lead.clone());
        async move {
            let (grants, generation) = {
                let runtime = core.runtime.lock().unwrap();
                (runtime.grants("fetcher"), runtime.generation())
            };
            let caller = Caller {
                id: "fetcher",
                source: "",
                grants,
                generation,
                origin: Origin::Event,
                record_changes: false,
            };
            super::operations::dispatch(&core, &lead, caller, None, request, &flag).await
        }
    };
    let followed = run(call(
        "http.request",
        json!({"url": format!("{origin}/in?token=secret"), "method": "POST", "body": "x", "redirects": 2,
            "headers": {"authorization": "Bearer mine"}}),
    ))
    .await
    .unwrap();
    assert_eq!(followed["status"], 200);
    assert_eq!(followed["body"], "ok auth=true");
    assert_eq!(followed["headers"]["set-cookie"], "[redacted]");
    assert_eq!(followed["redirects"][0]["status"], 303);
    let truncated = run(call(
        "http.request",
        json!({"url": format!("{origin}/utf8"), "max_bytes": 2}),
    ))
    .await
    .unwrap();
    assert_eq!(
        (&truncated["body"], &truncated["truncated"]),
        (&json!("a"), &json!(true))
    );
    let error = run(call(
        "http.request",
        json!({"url": format!("{origin}/out"), "redirects": 1}),
    ))
    .await
    .unwrap_err();
    assert_eq!(
        error,
        format!("http_origin_denied: http://127.0.0.1:{denied_port}")
    );
    let unfollowed = run(call(
        "http.request",
        json!({"url": format!("{origin}/out")}),
    ))
    .await
    .unwrap();
    assert_eq!(unfollowed["status"], 302);
    let error = run(call(
        "http.request",
        json!({"url": format!("http://127.0.0.1:{denied_port}/")}),
    ))
    .await
    .unwrap_err();
    assert!(error.starts_with("http_origin_denied"), "{error}");
    let error = run(call(
        "http.request",
        json!({"url": format!("{origin}/final"), "credential": up.id}),
    ))
    .await
    .unwrap_err();
    assert_eq!(error, format!("credential_origin_mismatch: {}", up.id));
    let down = profiles
        .create(
            "down",
            "provider",
            Some("down"),
            Some("https://down.example"),
        )
        .unwrap();
    let borrowed = profiles
        .create_secret("borrowed", "https://own.example", "vault")
        .unwrap();
    let own = profiles
        .create_secret("own", "https://own.example", "fetcher")
        .unwrap();
    for (credential, expected) in [
        (
            down.id.clone(),
            format!("credential_not_granted: {}", down.id),
        ),
        (
            borrowed.id.clone(),
            format!("credential_secret_not_owned: {}", borrowed.id),
        ),
        (
            own.id.clone(),
            format!("credential_origin_mismatch: {}", own.id),
        ),
        ("other".into(), "credential_profile_unknown: other".into()),
    ] {
        let error = run(call(
            "http.request",
            json!({"url": format!("{origin}/final"), "credential": credential}),
        ))
        .await
        .unwrap_err();
        assert_eq!(error, expected);
    }
    let error = run(call(
        "http.request",
        json!({"url": format!("{origin}/slow"), "timeout_ms": 100}),
    ))
    .await
    .unwrap_err();
    assert_eq!(error, "http_timeout");
    let cancel = flag.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        cancel.store(true, Ordering::Release);
    });
    let error = run(call(
        "http.request",
        json!({"url": format!("{origin}/slow")}),
    ))
    .await
    .unwrap_err();
    assert_eq!(error, "host_operation_cancelled");
    flag.store(false, Ordering::Release);

    let opened = run(call(
        "http.open",
        json!({"url": format!("{origin}/stream")}),
    ))
    .await
    .unwrap();
    let handle = opened["handle"].clone();
    let read = run(call(
        "http.read",
        json!({"handle": handle, "max_bytes": 6, "wait_ms": 2000}),
    ))
    .await
    .unwrap();
    assert_eq!(read["data"], "stream");
    let reopened = run(call(
        "http.open",
        json!({"url": format!("{origin}/stream")}),
    ))
    .await
    .unwrap();
    let generation = fixture.core.runtime.lock().unwrap().generation();
    super::access::release_servers(&fixture.lead, generation + 1, None).await;
    for handle in [handle, reopened["handle"].clone()] {
        let error = run(call("http.read", json!({"handle": handle})))
            .await
            .unwrap_err();
        assert_eq!(error, "http_stream_unavailable");
    }

    let log =
        std::fs::read_to_string(fixture.lead.session.evidence.join("mod-access.jsonl")).unwrap();
    assert!(
        !log.contains("token=secret") && !log.contains("Bearer"),
        "{log}"
    );
    let first: Value = serde_json::from_str(log.lines().next().unwrap()).unwrap();
    assert_eq!(first["origin"], origin);
    assert_eq!(first["path"], "/in");
    assert_eq!(first["status"], 200);
    let normalized = codex_omd::access_receipt(
        "fetcher",
        &call(
            "http.request",
            json!({"url": "https://API.example.com:443/v1?key=s"}),
        ),
        Ok(&json!({})),
    )
    .unwrap();
    assert_eq!(
        (normalized["origin"].clone(), normalized["path"].clone()),
        (json!("https://api.example.com"), json!("/v1"))
    );
}

fn caller<'a>(core: &Core, id: &'a str) -> Caller<'a> {
    Caller {
        id,
        source: "",
        grants: core.runtime.lock().unwrap().grants(id),
        generation: 0,
        origin: Origin::Event,
        record_changes: false,
    }
}

async fn settle<T>(check: impl Fn() -> Option<T>) -> T {
    for _ in 0..200 {
        if let Some(value) = check() {
            return value;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("condition not reached");
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_definitions_are_offered_wrapped_and_observed_without_control() {
    let Some(fixture) = fixture(&[
        Package {
            id: "reviewer",
            capabilities: &["agents"],
            manifest: Value::Null,
            source: "export default function (api) {\n  api.agent({ name: 'review', description: 'Reviews diffs', instructions: 'Review carefully.', tools: ['read_file'], offer: true });\n}\n",
        },
        Package {
            id: "auditor",
            capabilities: &["agents"],
            manifest: Value::Null,
            source: "export default function (api) {\n  api.agent({ name: 'review', description: 'Audits changes', instructions: 'Audit.' });\n  api.intercept('agent_offers', async (e, next) => { const r = await next(e); return { offers: r.offers.map(o => ({ ...o, description: o.description + ' [audited]' })) }; });\n  api.intercept('agent_spawn', (e, next) => {\n    if (e.model === 'huge') return { deny: 'model not allowed' };\n    if (e.prompt === 'escape') return next({ ...e, cwd: '/' });\n    return next({ ...e, definition: e.definition ?? 'auditor/review', tools: ['read_file'] });\n  });\n}\n",
        },
        Package {
            id: "observer",
            capabilities: &["agents", "events", "store"],
            manifest: Value::Null,
            source: "export default function (api) {\n  api.on('timer', () => { api.state.set({ spawn: api.host.tryCall('agents.spawn', { definition: 'reviewer/review', route: 'huge', prompt: 'look' }) }); });\n}\n",
        },
    ]) else {
        return;
    };
    *fixture.lead.session.contract.lock().unwrap() =
        crate::contract::SessionContract::resolve(&fixture.lead.host, &[]);
    let mods = mods(&fixture.core);
    let (session_store, thread_store, turn_store) = (
        ExtensionData::new("session".to_owned()),
        ExtensionData::new(fixture.lead.thread.to_string()),
        ExtensionData::new("turn-1".to_owned()),
    );
    thread_store.insert(fixture.lead.clone());

    use codex_extension_api::AgentRoleContributor as _;
    use codex_extension_api::ToolSpecContributor as _;
    let offered = mods.offered_agent_roles(&thread_store);
    assert_eq!(offered.len(), 1);
    assert_eq!(offered[0].name, "reviewer/review");
    assert_eq!(
        offered[0].description,
        "Reviews diffs [audited] (mod reviewer)"
    );
    let role = std::fs::read_to_string(&offered[0].config_file).unwrap();
    assert!(role.contains("Review carefully."), "{role}");
    assert!(
        mods.resolve_agent_role(&thread_store, "auditor/review")
            .is_some()
    );
    assert!(
        mods.resolve_agent_role(&thread_store, "missing/review")
            .is_none()
    );
    assert!(mods.resolve_agent_role(&thread_store, "explorer").is_none());

    static SPAWN: std::sync::LazyLock<ToolName> =
        std::sync::LazyLock::new(|| ToolName::plain("spawn_agent"));
    let spawn = |call_id: &'static str, arguments: &'static str| {
        let payload = Box::leak(Box::new(codex_tools::ToolPayload::Function {
            arguments: arguments.to_owned(),
        }));
        ToolStartInput {
            session_store: &session_store,
            thread_store: &thread_store,
            turn_store: &turn_store,
            turn_id: "turn-1",
            root_turn_id: None,
            call_id,
            originating_item_id: None,
            tool_name: &SPAWN,
            mcp_tool: None,
            permissions: Box::pin(async { None }),
            payload,
            conversation_history: Arc::new(NoHistory),
            source: codex_extension_api::ToolCallSource::Direct,
        }
    };
    let ToolInterception::Continue(Some((_, codex_tools::ToolPayload::Function { arguments }))) =
        mods.intercept_tool(spawn(
            "spawn-1",
            r#"{"message":"check","agent_type":"reviewer/review"}"#,
        ))
        .await
        .unwrap()
    else {
        panic!("the transformed spawn must reach the native executor");
    };
    let arguments: Value = serde_json::from_str(&arguments).unwrap();
    let plan = arguments["agent_type"].as_str().unwrap().to_owned();
    assert!(plan.starts_with("omd-agent-"), "{arguments}");
    assert_eq!(arguments["message"], "check");
    assert_eq!(
        mods.replace_tool_output(codex_extension_api::ToolOutputInput {
            session_store: &session_store,
            thread_store: &thread_store,
            turn_store: &turn_store,
            turn_id: "turn-1",
            call_id: "spawn-1",
            tool_name: &SPAWN,
            arguments: None,
            success: true,
            text: r#"{"agent_id":"child","nickname":null}"#,
        })
        .await,
        None
    );
    let denied = mods
        .intercept_tool(spawn("spawn-2", r#"{"message":"go","model":"huge"}"#))
        .await
        .unwrap_err();
    assert!(denied.contains("model not allowed"), "{denied}");
    let escaped = mods
        .intercept_tool(spawn("spawn-3", r#"{"message":"escape"}"#))
        .await
        .unwrap_err();
    assert!(
        escaped.contains("agent_spawn_cwd_outside_session"),
        "{escaped}"
    );
    std::fs::write(
        fixture
            .lead
            .host
            .root
            .join("agents/plans/omd-agent-foreign.json"),
        r#"{"definition":null,"cwd":"/","tools":null}"#,
    )
    .unwrap();
    assert!(
        mods.resolve_agent_role(&thread_store, "omd-agent-foreign")
            .is_none(),
        "a plan from another session's workspace is refused"
    );

    let child = ThreadId::new();
    let child_store = ExtensionData::new(child.to_string());
    child_store.insert(Lead {
        owner: format!("agent:{child}"),
        depth: 1,
        thread: child,
        ..fixture.lead.clone()
    });
    let source = SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
        parent_thread_id: fixture.lead.thread,
        depth: 1,
        agent_path: None,
        agent_nickname: None,
        agent_role: Some(plan),
    });
    let reopened = ExtensionData::new(child.to_string());
    for store in [&child_store, &reopened] {
        mods.native_agent_started(child, &source, store);
        let hidden = mods
            .adjust_tool_specs(
                store,
                &[
                    codex_extension_api::ToolSpecView {
                        name: "read_file".into(),
                        description: String::new(),
                        parameters: Value::Null,
                    },
                    codex_extension_api::ToolSpecView {
                        name: "exec_command".into(),
                        description: String::new(),
                        parameters: Value::Null,
                    },
                ],
            )
            .unwrap()
            .hide;
        assert_eq!(hidden, vec!["exec_command".to_owned()]);
    }
    static EXEC: std::sync::LazyLock<ToolName> =
        std::sync::LazyLock::new(|| ToolName::plain("exec_command"));
    let refused = mods
        .intercept_tool(ToolStartInput {
            thread_store: &child_store,
            tool_name: &EXEC,
            ..spawn("child-1", r#"{"cmd":"ls"}"#)
        })
        .await
        .unwrap_err();
    assert!(refused.starts_with("agent_tool_denied"), "{refused}");
    fixture.core.inventory.start(
        "review-thread",
        json!({"origin": "native", "role": "Review"}),
    );
    fixture.core.inventory.tokens(
        "review-thread",
        &codex_protocol::protocol::TokenUsage {
            input_tokens: 40,
            output_tokens: 3,
            ..Default::default()
        },
    );
    let review = fixture.core.inventory.list();
    let review = review
        .iter()
        .find(|record| record["thread_id"] == "review-thread")
        .unwrap();
    assert_eq!(review["usage"]["source"], "engine");
    assert_eq!(review["usage"]["input_tokens"], 40);
    assert!(review["usage"]["microusd"].is_null());
    fixture
        .core
        .inventory
        .usage(&json!({"scope": {"thread_id": child.to_string()},
        "usage": {"input_tokens": 10, "output_tokens": 5}, "cost": {"microusd": 7}}));
    fixture
        .core
        .inventory
        .answer(&child.to_string(), "looks fine");
    mods.on_turn_error(codex_extension_api::TurnErrorInput {
        turn_id: "child-turn",
        error: codex_protocol::protocol::CodexErrorInfo::ServerOverloaded,
        error_details: &codex_protocol::error::CodexErrorDetails::ServerOverloaded,
        session_store: &session_store,
        thread_store: &child_store,
        turn_store: &turn_store,
    })
    .await;
    mods.on_turn_stop(codex_extension_api::TurnStopInput {
        session_store: &session_store,
        thread_store: &child_store,
        turn_store: &turn_store,
    })
    .await;
    mods.on_thread_stop(ThreadStopInput {
        session_store: &session_store,
        thread_store: &child_store,
    })
    .await;

    let cancelled = Arc::new(AtomicBool::new(false));
    let call = |operation: &str, arguments: Value| ModHostCall {
        operation: operation.into(),
        arguments,
    };
    let inventory = operations::dispatch(
        &fixture.core,
        &fixture.lead,
        caller(&fixture.core, "observer"),
        None,
        call("agents.inventory", Value::Null),
        &cancelled,
    )
    .await
    .unwrap();
    let record = inventory["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["thread_id"] == child.to_string())
        .unwrap();
    assert_eq!(record["origin"], "model");
    assert_eq!(record["definition"]["name"], "reviewer/review");
    assert_eq!(record["status"], "failed");
    assert_eq!(record["turns"], 1);
    assert_eq!(
        record["last_turn"]["error"],
        json!({"category": "transport", "code": "server_overloaded",
            "message": "Selected model is at capacity. Please try a different model."})
    );
    assert_eq!(record["answer"], "looks fine");
    assert_eq!(record["usage"]["microusd"], 7);
    assert_eq!(record["usage"]["basis"], "settled");
    assert!(record["duration_ms"].is_u64());
    let control = operations::dispatch(
        &fixture.core,
        &fixture.lead,
        caller(&fixture.core, "observer"),
        None,
        call("agents.cancel", json!({"handle": format!("agent:{child}")})),
        &cancelled,
    )
    .await;
    assert!(
        control.is_err(),
        "observing an agent must not grant control"
    );

    expansion::invoke_one(
        &fixture.core,
        &fixture.lead,
        "observer".into(),
        "timer",
        json!({"key": "spawn"}),
    )
    .await;
    let state = fixture
        .core
        .runtime
        .lock()
        .unwrap()
        .state("observer")
        .cloned()
        .unwrap();
    assert_eq!(state["spawn"]["ok"], false);
    assert!(
        state["spawn"]["error"]
            .as_str()
            .unwrap()
            .contains("agent_spawn_denied: model not allowed"),
        "{state}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn autonomous_queues_wait_for_idle_respect_budgets_and_pause_on_interrupt() {
    let Some(fixture) = fixture(&[Package {
        id: "monitor",
        capabilities: &["events", "autonomous", "store"],
        manifest: json!({"autonomy": {"max_queued": 2, "max_turns": 1, "max_continuations": 1}}),
        source: "export default function (api) {\n  api.on('timer', () => { api.state.set({ queued: [\n    api.host.call('turns.queue', { prompt: 'check CI', key: 'ci' }),\n    api.host.call('turns.queue', { prompt: 'check CI', key: 'ci' }),\n    api.host.tryCall('turns.queue', { prompt: 'triage', key: 'triage', priority: 'high' }),\n    api.host.tryCall('turns.queue', { prompt: 'more', key: 'more' }),\n  ] }); });\n  api.on('turn_queue', e => { api.state.set({ ...api.state.get(), last: e }); });\n  api.intercept('turn_stop', (e, next) => e.continued === 0 || e.continued >= 4 ? { continue: 'verify once more' } : next(e));\n}\n",
    }]) else {
        return;
    };
    *fixture.lead.session.contract.lock().unwrap() =
        crate::contract::SessionContract::resolve(&fixture.lead.host, &[]);
    let core = &fixture.core;
    let thread = fixture.lead.thread.to_string();
    expansion::invoke_one(
        core,
        &fixture.lead,
        "monitor".into(),
        "timer",
        json!({"key": "poll"}),
    )
    .await;
    let state = |key: &str| {
        core.runtime
            .lock()
            .unwrap()
            .state("monitor")
            .cloned()
            .unwrap()[key]
            .clone()
    };
    let queued = state("queued");
    assert_eq!(queued[0]["status"], "queued");
    assert_eq!(queued[1]["status"], "duplicate");
    assert_eq!(queued[2]["ok"], true);
    assert_eq!(queued[3]["error"], "turn_queue_full");

    let grants = BTreeMap::from([(
        "monitor".to_owned(),
        core.runtime.lock().unwrap().grants("monitor").unwrap(),
    )]);
    let pick = |grants: &BTreeMap<String, codex_omd::ModGrants>| {
        let mut notices = Vec::new();
        let entry = core
            .autonomy
            .with(&thread, |queue| {
                queue
                    .pick(grants, codex_omd::peers::now_ms(), &mut notices)
                    .map(|entry| entry.view())
            })
            .unwrap();
        (entry, notices)
    };
    core.autonomy
        .with(&thread, |queue| queue.running = Some("user".into()))
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1300)).await;
    assert_eq!(
        core.autonomy.running(&thread).as_deref(),
        Some("user"),
        "a busy thread keeps its queue"
    );
    core.autonomy.turn_ended(core, &fixture.lead, true);
    assert_eq!(
        pick(&grants).0,
        None,
        "an interrupted thread pauses its queues"
    );
    core.autonomy.user_turn(&thread);
    let (first, _) = pick(&grants);
    assert_eq!(first.unwrap()["key"], "triage");
    core.autonomy.turn_ended(core, &fixture.lead, false);
    assert_eq!(
        core.autonomy.running(&thread).as_deref(),
        Some("monitor"),
        "a turn ending while a dispatch starts leaves the picked entry to it"
    );
    assert!(
        core.autonomy
            .take_submitting(&thread, "typed by the user")
            .is_none()
    );
    let provenance = core
        .autonomy
        .take_submitting(
            &thread,
            "[Queued by mod monitor on timer (key triage); not typed by the user]\ntriage",
        )
        .unwrap();
    assert_eq!(provenance["package"], "monitor");
    assert_eq!(provenance["event"], "timer");
    core.autonomy
        .with(&thread, |queue| queue.running = None)
        .unwrap();
    let mut stale = grants.clone();
    stale.get_mut("monitor").unwrap().source_sha256 = "other".into();
    let (none, notices) = pick(&stale);
    assert_eq!(none, None);
    assert_eq!(notices[0].1["reason"], "stale_generation");

    let poll = || {
        expansion::invoke_one(
            core,
            &fixture.lead,
            "monitor".into(),
            "timer",
            json!({"key": "poll"}),
        )
    };
    poll().await;
    core.autonomy
        .with(&thread, |queue| {
            queue.started.insert("monitor".into(), 1);
        })
        .unwrap();
    let (none, notices) = pick(&grants);
    assert_eq!(none, None);
    assert_eq!(notices[0].1["reason"], "turn_budget_exhausted");

    core.autonomy
        .with(&thread, |queue| queue.started.clear())
        .unwrap();
    poll().await;
    let last = settle(|| {
        let queued = core
            .autonomy
            .call(
                core,
                &fixture.lead,
                &caller(core, "monitor"),
                ModHostCall {
                    operation: "turns.queued".into(),
                    arguments: Value::Null,
                },
            )
            .unwrap();
        Some(state("last")).filter(|last| {
            last["status"] == "failed"
                && queued["entries"].as_array().unwrap().is_empty()
                && core.autonomy.running(&thread).is_none()
        })
    })
    .await;
    assert!(
        last["reason"]
            .as_str()
            .unwrap()
            .contains("native_thread_manager_stopped"),
        "{last}"
    );
    assert!(
        core.autonomy.running(&thread).is_none(),
        "a failed start frees the queue"
    );

    let mods = mods(core);
    let (session_store, thread_store, turn_store) = (
        ExtensionData::new("session".to_owned()),
        ExtensionData::new(thread.clone()),
        ExtensionData::new("turn-9".to_owned()),
    );
    thread_store.insert(fixture.lead.clone());
    let ask = |continued| {
        mods.continue_turn(codex_extension_api::TurnContinueInput {
            turn_id: "turn-9",
            last_agent_message: Some("done"),
            error: None,
            continued,
            session_store: &session_store,
            thread_store: &thread_store,
            turn_store: &turn_store,
        })
    };
    assert!(
        ask(4).await.is_none(),
        "at most four continuations per turn in total"
    );
    let continuation = ask(0).await.unwrap();
    assert_eq!(continuation.source, "mod:monitor");
    assert!(continuation.prompt.ends_with("verify once more"));
    assert!(ask(1).await.is_none());
    assert!(ask(0).await.is_none(), "max_continuations bounds each turn");
}

#[tokio::test(flavor = "multi_thread")]
async fn peer_messages_pass_receive_interceptors_as_untrusted_data() {
    let Some(fixture) = fixture(&[
        Package {
            id: "chat",
            capabilities: &["peers", "store"],
            manifest: json!({"peer_access": {"projects": "same"}}),
            source: "export default function (api) {\n  api.intercept('peer_receive', (e, next) => e.data === 'spam' ? { deny: 'spam' } : next({ ...e, data: String(e.data).toUpperCase() }));\n  api.on('peer_message', e => { api.state.set({ got: e }); });\n}\n",
        },
        Package {
            id: "silent",
            capabilities: &["peers"],
            manifest: json!({"peer_access": {"projects": "any"}}),
            source: "export default function () {}\n",
        },
    ]) else {
        return;
    };
    *fixture.lead.session.contract.lock().unwrap() =
        crate::contract::SessionContract::resolve(&fixture.lead.host, &[]);
    let message = |data: &str, package: &str| {
        json!({"id": "m1", "from": {"session": "other", "repository": "/repo", "package": "chat", "sha256": "a"},
            "to": {"session": fixture.lead.thread.to_string(), "package": package},
            "correlation": "c", "data": data, "sent_at_ms": 1})
    };
    assert_eq!(
        peering::receive(
            &fixture.core,
            &fixture.lead,
            "chat",
            &message("hello", "chat")
        )
        .await,
        ("delivered", None)
    );
    let got = fixture
        .core
        .runtime
        .lock()
        .unwrap()
        .state("chat")
        .cloned()
        .unwrap()["got"]
        .clone();
    assert_eq!(got["data"], "HELLO");
    assert_eq!(got["untrusted"], true);
    assert_eq!(got["from"]["session"], "other");
    assert_eq!(
        peering::receive(
            &fixture.core,
            &fixture.lead,
            "chat",
            &message("spam", "chat")
        )
        .await,
        ("refused", Some("spam".to_owned()))
    );
    assert_eq!(
        peering::receive(
            &fixture.core,
            &fixture.lead,
            "silent",
            &message("hi", "silent")
        )
        .await,
        ("refused", Some("no_peer_message_handler".to_owned()))
    );
}

#[test]
fn provider_billed_service_routes_are_found_only_for_their_provider_and_mod() {
    let Some(fixture) = fixture(&[]) else {
        return;
    };
    let grant = |id: &str, provider: &str, billed: bool| {
        json!({"id": id, "mod_id": "fixture", "program": "/usr/bin/true", "program_sha256": "0".repeat(64),
            "route": {"name": id, "provider": provider, "model": "m", "reasoning_effort": "medium", "responses_url": "http://127.0.0.1:1/v1/responses",
            "roles": ["lead"], "rates": {"input_microusd_per_million": 0, "cached_microusd_per_million": 0,
            "output_microusd_per_million": 0, "reservation_microusd": 0, "max_output_tokens": 1000,
            "input_token_ceiling": 1000, "included_subscription": !billed, "provider_billed": billed}}})
    };
    std::fs::write(
        fixture.lead.host.root.join("host.json"),
        json!({"services": [grant("billed", "billed", true), grant("included", "included", false)]}).to_string(),
    )
    .unwrap();
    let (config, error) = fixture.lead.host.route_config();
    assert_eq!(error, None);
    assert!(config.billed_rates("billed", None).is_some());
    assert!(config.billed_rates("billed", Some("fixture")).is_some());
    assert!(config.billed_rates("billed", Some("other")).is_none());
    assert!(config.billed_rates("included", None).is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn compaction_chains_answer_skip_replace_and_fail_closed() {
    use codex_extension_api::CompactionPlan;
    use codex_extension_api::CompactionReplacement;
    let Some(fixture) = fixture(&[
        Package {
            id: "a_keep",
            capabilities: &["compaction"],
            manifest: json!({}),
            source: "export default function (api) {\n  api.intercept('compaction', async (e, next) => {\n    if (e.phase === 'mid_turn') return { skip: 'busy' };\n    if (e.phase !== 'post_turn') return next(e);\n    const done = await next(e);\n    return { history: { keep: [done.history.length - 1], insert: [{ before: 0, role: 'developer', text: 'kept tail' }] } };\n  });\n}\n",
        },
        Package {
            id: "b_sum",
            capabilities: &["compaction"],
            manifest: json!({}),
            source: "export default function (api) {\n  api.intercept('compaction', (e, next) => {\n    if (e.trigger === 'manual') return { summary: 'summary of ' + e.items };\n    if (e.implementation === 'remote') return { history: { keep: [99] } };\n    return next(e.summary_prompt === null ? e : { ...e, summary_prompt: 'shorter' });\n  });\n}\n",
        },
        Package {
            id: "c_fail",
            capabilities: &["compaction"],
            manifest: json!({}),
            source: "export default function (api) {\n  api.intercept('compaction', { required: true }, (e, next) => {\n    if (e.reason === 'model_downshift') throw new Error('refused');\n    return next(e);\n  });\n}\n",
        },
    ]) else {
        return;
    };
    let mods = mods(&fixture.core);
    let (session_store, thread_store, turn_store) = (
        ExtensionData::new("session".to_owned()),
        ExtensionData::new(fixture.lead.thread.to_string()),
        ExtensionData::new("turn-1".to_owned()),
    );
    thread_store.insert(fixture.lead.clone());
    let history = vec![
        json!({"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}),
        json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "yo"}]}),
    ];
    let plan = |trigger, reason, phase, implementation, prompt| {
        mods.compaction_plan(codex_extension_api::CompactionInterceptInput {
            turn_id: "turn-1",
            trigger,
            reason,
            phase,
            implementation,
            tokens: 900,
            auto_limit: Some(800),
            context_window: Some(1000),
            hard: false,
            history: &history,
            summary_prompt: prompt,
            session_store: &session_store,
            thread_store: &thread_store,
            turn_store: &turn_store,
        })
    };
    match plan(
        "manual",
        "user_requested",
        "standalone_turn",
        "local",
        Some("p"),
    )
    .await
    {
        CompactionPlan::Replace(CompactionReplacement::Summary { by, text }) => {
            assert_eq!((by.as_str(), text.as_str()), ("b_sum", "summary of 2"));
        }
        _ => panic!("the inner mod answers without the host"),
    }
    match plan("auto", "context_limit", "mid_turn", "local", Some("p")).await {
        CompactionPlan::Skip { by, reason } => {
            assert_eq!((by.as_str(), reason.as_str()), ("a_keep", "busy"));
        }
        _ => panic!("the outer mod skips"),
    }
    match plan("auto", "context_limit", "pre_turn", "remote", None).await {
        CompactionPlan::Fail(reason) => {
            assert_eq!(reason, "compaction_history_invalid: keep (b_sum)");
        }
        _ => panic!("an invalid history fails the occurrence"),
    }
    match plan("auto", "model_downshift", "pre_turn", "local", Some("p")).await {
        CompactionPlan::Fail(reason) => {
            assert!(reason.starts_with("mod_interception_failed"), "{reason}");
        }
        _ => panic!("a failing required interceptor fails closed"),
    }
    let CompactionPlan::Native {
        summary_prompt,
        settle,
    } = plan("auto", "context_limit", "pre_turn", "local", Some("p")).await
    else {
        panic!("the host compacts with the rewritten prompt");
    };
    assert_eq!(summary_prompt.as_deref(), Some("shorter"));
    drop(settle);
    let CompactionPlan::Native {
        settle: Some(settle),
        ..
    } = plan("auto", "context_limit", "post_turn", "local", Some("p")).await
    else {
        panic!("a dropped settle releases its chain");
    };
    let installed = vec![
        json!({"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}),
        json!({"type": "message", "role": "user", "content": [{"type": "input_text", "text": "summary"}]}),
    ];
    let replaced = settle(codex_extension_api::CompactionSettled {
        summary: Some("native".into()),
        history: installed.clone(),
        provider_call: true,
        usage: None,
    })
    .await;
    let Some(CompactionReplacement::History { by, items }) = replaced else {
        panic!("the outer mod rewrites the host's history");
    };
    assert_eq!(by, "a_keep");
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["content"][0]["text"], "kept tail");
    assert_eq!(items[1], installed[1]);
}

#[tokio::test(flavor = "multi_thread")]
async fn lifecycle_seams_report_batches_loads_failures_and_elicitations() {
    let Some(fixture) = fixture(&[Package {
        id: "observer",
        capabilities: &["lifecycle", "approvals", "autonomous", "store"],
        manifest: json!({"autonomy": {"max_queued": 1, "max_turns": 1, "max_continuations": 1}}),
        source: "export default function (api) {\n  const log = e => api.state.set([...(api.state.get() ?? []), e]);\n  api.on('tool_batch_end', log);\n  api.on('instructions_loaded', log);\n  api.on('elicitation_result', log);\n  api.on('worktree', log);\n  api.on('thread_settings', log);\n  api.intercept('elicitation', (e, next) => e.server === 'docs' ? { accept: { name: 'omd' } } : e.server === 'extra' ? { accept: { other: 1 } } : next(e));\n  api.intercept('turn_stop', (e, next) => e.outcome === 'error' ? { continue: 'retry after ' + e.error } : next(e));\n}\n",
    }]) else {
        return;
    };
    let mods = mods(&fixture.core);
    let (session_store, thread_store, turn_store) = (
        ExtensionData::new("session".to_owned()),
        ExtensionData::new(fixture.lead.thread.to_string()),
        ExtensionData::new("turn-2".to_owned()),
    );
    thread_store.insert(fixture.lead.clone());
    mods.settled
        .lock()
        .unwrap()
        .insert("c1".into(), ("exec_command".into(), "failed".into()));
    mods.on_tool_batch_end(codex_extension_api::ToolBatchEndInput {
        turn_id: "turn-2",
        call_ids: &["c1".into(), "c2".into()],
        session_store: &session_store,
        thread_store: &thread_store,
        turn_store: &turn_store,
    })
    .await;
    mods.on_instructions_loaded(codex_extension_api::InstructionsLoadedInput {
        kind: "skill",
        source: "/skills/review/SKILL.md",
        sha256: Some("ab"),
        bytes: 12,
        reason: "explicit",
        session_store: &session_store,
        thread_store: &thread_store,
        turn_store: None,
    })
    .await;
    let (mods, session_store, thread_store) = (&mods, &session_store, &thread_store);
    let form = |server: &'static str, schema: Value| async move {
        let request = json!({"mode": "form", "message": "who?", "requested_schema": schema});
        mods.intercept_elicitation(codex_extension_api::ElicitationInterceptInput {
            turn_id: "turn-2",
            server,
            request_id: "7",
            request: &request,
            session_store,
            thread_store,
        })
        .await
    };
    let schema =
        json!({"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]});
    let answer = form("docs", schema.clone()).await.unwrap();
    assert_eq!(
        (answer.action.as_str(), answer.by.as_str()),
        ("accept", "observer")
    );
    assert_eq!(answer.content, Some(json!({"name": "omd"})));
    assert!(
        form("extra", schema).await.is_none(),
        "undeclared fields go to the user"
    );
    let secret = json!({"type": "object", "properties": {"token": {"type": "string", "format": "password"}}});
    assert!(
        form("docs", secret).await.is_none(),
        "secret forms are never offered to mods"
    );
    mods.on_elicitation_result(codex_extension_api::ElicitationResultInput {
        server: "docs",
        request_id: "7",
        action: "accept",
        content: Some(&json!({"token": "hunter2"})),
        by: None,
        session_store,
        thread_store,
    })
    .await;
    let request = json!({"mode": "form", "message": "token?", "requested_schema":
        {"type": "object", "properties": {"token": {"type": "string", "format": "password"}}}});
    for id in (0..=64).rev() {
        mods.intercept_elicitation(codex_extension_api::ElicitationInterceptInput {
            turn_id: "turn-2",
            server: "bulk",
            request_id: &format!("{id:02}"),
            request: &request,
            session_store,
            thread_store,
        })
        .await;
    }
    for id in ["64", "00"] {
        mods.on_elicitation_result(codex_extension_api::ElicitationResultInput {
            server: "bulk",
            request_id: id,
            action: "accept",
            content: Some(&json!({"token": "hunter2"})),
            by: None,
            session_store,
            thread_store,
        })
        .await;
    }
    let log = fixture
        .core
        .runtime
        .lock()
        .unwrap()
        .state("observer")
        .cloned()
        .unwrap();
    assert_eq!(
        log[0]["calls"],
        json!([{"call_id": "c1", "tool": "exec_command", "outcome": "failed"},
            {"call_id": "c2", "tool": "", "outcome": ""}])
    );
    assert_eq!(log[1]["kind"], "skill");
    assert_eq!(log[1]["reason"], "explicit");
    assert_eq!(log[2]["content"], json!({"token": "[redacted]"}));
    assert_eq!(log[2]["by"], Value::Null);
    assert_eq!(
        log[3]["content"],
        json!("[redacted]"),
        "the oldest pending schema is evicted and its answer withheld"
    );
    assert_eq!(log[4]["content"], json!({"token": "[redacted]"}));

    let failed = mods
        .continue_turn(codex_extension_api::TurnContinueInput {
            turn_id: "turn-2",
            last_agent_message: None,
            error: Some("stream disconnected"),
            continued: 0,
            session_store,
            thread_store,
            turn_store: &turn_store,
        })
        .await
        .unwrap();
    assert!(failed.prompt.ends_with("retry after stream disconnected"));

    let view = |cwd: &str, roots: Value, model: &str| json!({"cwd": cwd, "roots": roots, "model": model, "effort": "high", "provider": "openai"});
    let change = settings_change(
        &view("/repo", json!(["/repo"]), "a"),
        &view("/repo/sub", json!(["/repo", "/extra"]), "b"),
    )
    .unwrap();
    assert_eq!(
        change["cwd"],
        json!({"before": "/repo", "after": "/repo/sub"})
    );
    assert_eq!(change["roots"], json!({"added": ["/extra"], "removed": []}));
    assert_eq!(change["model"]["after"], "b");
    assert!(settings_change(&view("/r", json!([]), "a"), &view("/r", json!([]), "a")).is_none());

    let core = &fixture.core;
    *core.expansion.current.lock().unwrap() = Some(LeadHandle::new(&fixture.lead));
    expansion::worktree(
        &core.expansion,
        "created",
        Path::new("/scratch/agent"),
        "agent",
    );
    expansion::broadcast(&core.expansion, "thread_settings", change);
    assert!(!delivery::deliver(core).await);
    let log = core
        .runtime
        .lock()
        .unwrap()
        .state("observer")
        .cloned()
        .unwrap();
    assert_eq!(
        log[5],
        json!({"phase": "created", "path": "/scratch/agent", "owner": "agent"})
    );
    assert_eq!(log[6]["roots"]["added"], json!(["/extra"]));
}

#[tokio::test]
async fn timer_replacement_rejects_an_old_producer_after_queue_cleanup() {
    let state = State::default();
    let thread = ThreadId::new();
    let slot = (thread.to_string(), "observer".to_owned(), "tick".to_owned());
    let task = tokio::spawn(async {});
    // Resume an old producer after replacement installed incarnation 2 and cleared its queue.
    state
        .timers
        .lock()
        .unwrap()
        .insert(slot, ("source".into(), 2, task));
    let pending = |incarnation| delivery::Pending::Timer {
        thread,
        owner: "observer".into(),
        key: "tick".into(),
        source: "source".into(),
        incarnation,
    };
    delivery::push_timer(&state, pending(1));
    assert!(state.pending.lock().unwrap().is_empty());
    delivery::push_timer(&state, pending(2));
    assert_eq!(state.pending.lock().unwrap().len(), 1);
    state.pending.lock().unwrap().clear();
    for _ in 0..1024 {
        delivery::push(
            &state,
            delivery::Pending::Broadcast {
                event: "idle",
                payload: Value::Null,
            },
        );
    }
    delivery::push_timer(&state, pending(2));
    assert!(state.timers.lock().unwrap().is_empty());
    assert_eq!(state.dropped.load(Ordering::Relaxed), 1);
    for (_, (_, _, task)) in std::mem::take(&mut *state.timers.lock().unwrap()) {
        task.abort();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn timer_pending_ticks_keep_their_quota_after_producers_finish() {
    let Some(fixture) = fixture(&[Package {
        id: "observer",
        capabilities: &["events"],
        manifest: Value::Null,
        source: "export default function(api) { api.on('timer', () => {}); }\n",
    }]) else {
        return;
    };
    let core = &fixture.core;
    let _ = core.expansion.core.set(Arc::downgrade(core));
    let grants = core.runtime.lock().unwrap().grants("observer");
    let source = grants.as_ref().unwrap().source_sha256.clone();
    let caller = Caller {
        id: "observer",
        source: &source,
        grants,
        generation: core.runtime.lock().unwrap().generation(),
        origin: Origin::Event,
        record_changes: false,
    };
    let limit = fixture.lead.host.config.mod_limits.bounded().timers_per_mod;
    for index in 0..limit {
        let key = format!("pending-{index}");
        let mut task = tokio::spawn(async {});
        (&mut task).await.unwrap();
        core.expansion.timers.lock().unwrap().insert(
            (
                fixture.lead.thread.to_string(),
                "observer".into(),
                key.clone(),
            ),
            (source.clone(), index as u64, task),
        );
        delivery::push_timer(
            &core.expansion,
            delivery::Pending::Timer {
                thread: fixture.lead.thread,
                owner: "observer".into(),
                key,
                source: source.clone(),
                incarnation: index as u64,
            },
        );
    }
    assert_eq!(
        delivery::schedule(
            core,
            &fixture.lead,
            &caller,
            json!({"key": "overflow", "delay_ms": 100})
        )
        .unwrap_err(),
        "timer_limit"
    );
    delivery::push(
        &core.expansion,
        delivery::Pending::Broadcast {
            event: "idle",
            payload: Value::Null,
        },
    );
    assert_eq!(core.expansion.pending.lock().unwrap().len(), limit + 1);
    assert_eq!(core.expansion.dropped.load(Ordering::Relaxed), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn timer_invocation_rechecks_source_and_incarnation_at_generation_capture() {
    let Some(fixture) = fixture(&[Package {
        id: "observer",
        capabilities: &["events", "store", "commands"],
        manifest: Value::Null,
        source: "export default function(api) { api.on('timer', () => api.state.set('old')); api.command('seen', () => api.state.get()); }\n",
    }]) else {
        return;
    };
    let core = &fixture.core;
    let old_source = core
        .runtime
        .lock()
        .unwrap()
        .grants("observer")
        .unwrap()
        .source_sha256
        .clone();
    let slot = (
        fixture.lead.thread.to_string(),
        "observer".to_owned(),
        "tick".to_owned(),
    );
    core.expansion.timers.lock().unwrap().insert(
        slot.clone(),
        (old_source.clone(), 1, tokio::spawn(async {})),
    );
    // The old event was already popped/validated. Reload before invocation captures generation.
    let path = fixture
        ._dir
        .path()
        .join("packages/observer")
        .canonicalize()
        .unwrap();
    std::fs::write(path.join("index.ts"), "export default function(api) { api.on('timer', () => api.state.set('replacement')); api.command('seen', () => api.state.get()); }\n").unwrap();
    let store = ModStore::open(fixture.lead.host.root.clone()).unwrap();
    let inspected = ModStore::inspect_package(&path).unwrap();
    store
        .trust(
            path.clone(),
            inspected["sha256"].as_str().unwrap(),
            vec!["events".into(), "store".into(), "commands".into()],
            "user",
        )
        .unwrap();
    store.enable(&path, true).unwrap();
    core.runtime.lock().unwrap().reload().unwrap();
    assert!(core.runtime.lock().unwrap().registered("observer", "timer"));
    invoke_one_guarded(
        core,
        &fixture.lead,
        "observer".into(),
        "timer",
        json!({"key":"tick"}),
        Some(("tick".into(), old_source, 1)),
    )
    .await
    .unwrap()
    .unwrap();
    let _thread = codex_omd::StateThread::enter(Some(fixture.lead.thread.to_string()));
    assert_eq!(command(core, "observer", "seen"), Value::Null);
    let source = core
        .runtime
        .lock()
        .unwrap()
        .grants("observer")
        .unwrap()
        .source_sha256
        .clone();
    core.expansion
        .timers
        .lock()
        .unwrap()
        .insert(slot.clone(), (source.clone(), 3, tokio::spawn(async {})));
    invoke_one_guarded(
        core,
        &fixture.lead,
        "observer".into(),
        "timer",
        json!({"key":"tick"}),
        Some(("tick".into(), source.clone(), 2)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(command(core, "observer", "seen"), Value::Null);
    assert!(core.expansion.timers.lock().unwrap().contains_key(&slot));
    invoke_one_guarded(
        core,
        &fixture.lead,
        "observer".into(),
        "timer",
        json!({"key":"tick"}),
        Some(("tick".into(), source, 3)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(command(core, "observer", "seen"), json!("replacement"));
    assert!(core.expansion.timers.lock().unwrap().is_empty());
}
