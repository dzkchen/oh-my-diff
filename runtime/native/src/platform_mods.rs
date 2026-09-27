use super::*;
use codex_omd::ModHost;
use codex_omd::ModInputDecision;
use codex_omd::ModTool;
use codex_protocol::models::PermissionProfile;
use codex_protocol::models::PermissionProfileSnapshot;
use codex_protocol::permissions::FileSystemAccessMode;
use codex_protocol::permissions::FileSystemPath;
use codex_protocol::permissions::FileSystemSandboxEntry;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use codex_utils_absolute_path::AbsolutePathBuf;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

struct PlatformMods {
    root: PathBuf,
    repository: PathBuf,
    runtime: Arc<Mutex<ModHost>>,
    input_runtime: Arc<Mutex<ModHost>>,
    epoch: u64,
    revision: AtomicU64,
    turn: Mutex<Option<TurnRecord>>,
    workspace_before: Mutex<BTreeMap<String, Result<codex_omd::WorkspaceIndex, String>>>,
}

struct PlatformPermission(PermissionProfile);
struct PlatformProcesses(Arc<crate::managed_process::ManagedProcesses>);
struct PlatformSessionRoot(PathBuf, PathBuf);
#[derive(Clone)]
struct PlatformDataScope {
    thread: String,
    sessions: PathBuf,
    database: PathBuf,
}

struct TurnRecord {
    id: String,
    error: Option<String>,
}

struct PlatformTool {
    runtime: Arc<Mutex<ModHost>>,
    pre_rename_runtime: Arc<Mutex<ModHost>>,
    repository: PathBuf,
    processes: Arc<crate::managed_process::ManagedProcesses>,
    id: String,
    generation: u64,
    definition: ModTool,
    parameters: JsonSchema,
    root: PathBuf,
    data_scope: Option<Arc<PlatformDataScope>>,
}

struct Cancellation(Arc<AtomicBool>);

impl Drop for Cancellation {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

pub(super) fn install(registry: &mut ExtensionRegistryBuilder<Config>) -> Result<(), String> {
    let root = PathBuf::from(
        std::env::var_os(codex_omd::MOD_STORE_ENV).ok_or("platform mode requires OMD_MOD_STORE")?,
    );
    let canonical = root.canonicalize().map_err(|error| error.to_string())?;
    let repository = std::env::current_dir()
        .and_then(|path| path.canonicalize())
        .map_err(|error| error.to_string())?;
    if !root.is_absolute() || canonical != root || root.starts_with(&repository) {
        return Err("platform mod store must be canonical and outside the repository".into());
    }
    let validator = |schema: &Value| {
        codex_extension_api::parse_tool_input_schema(schema)
            .map(|_| ())
            .map_err(std::io::Error::other)
    };
    let runtime =
        ModHost::open_validated(root.clone(), validator).map_err(|error| error.to_string())?;
    let input_runtime =
        ModHost::open_validated(root.clone(), validator).map_err(|error| error.to_string())?;
    let extension = Arc::new(PlatformMods {
        root,
        repository,
        runtime: Arc::new(Mutex::new(runtime)),
        input_runtime: Arc::new(Mutex::new(input_runtime)),
        epoch: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| u64::try_from(elapsed.as_nanos()).unwrap_or(u64::MAX))
            .unwrap_or_default(),
        revision: AtomicU64::new(0),
        turn: Mutex::new(None),
        workspace_before: Mutex::new(BTreeMap::new()),
    });
    registry.config_contributor(extension.clone());
    registry.prompt_contributor(extension.clone());
    registry.thread_lifecycle_contributor(extension.clone());
    registry.turn_lifecycle_contributor(extension.clone());
    registry.tool_lifecycle_contributor(extension.clone());
    registry.tool_contributor(extension);
    Ok(())
}

impl PlatformMods {
    async fn event(&self, name: &'static str, payload: Value) -> Vec<PromptFragment> {
        self.event_with_profile(name, payload, None, None).await
    }

    async fn event_with_profile(
        &self,
        name: &'static str,
        payload: Value,
        profile: Option<PermissionProfile>,
        processes: Option<Arc<crate::managed_process::ManagedProcesses>>,
    ) -> Vec<PromptFragment> {
        self.event_with_data(name, payload, profile, processes, None)
            .await
    }

    async fn event_with_data(
        &self,
        name: &'static str,
        payload: Value,
        profile: Option<PermissionProfile>,
        processes: Option<Arc<crate::managed_process::ManagedProcesses>>,
        data_scope: Option<PlatformDataScope>,
    ) -> Vec<PromptFragment> {
        let runtime = self.runtime.clone();
        let root = self.root.clone();
        let repository = self.repository.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let _cancellation = Cancellation(cancelled.clone());
        let epoch = self.epoch;
        let revision = self.revision.fetch_add(1, Ordering::AcqRel) + 1;
        tokio::task::spawn_blocking(move || {
            let Ok(mut runtime) = runtime.lock() else {
                return Vec::new();
            };
            let generation = runtime.generation();
            if let Some(processes) = &processes {
                processes.cleanup_stale(generation);
            }
            let sources: BTreeMap<_, _> = runtime
                .owners()
                .into_iter()
                .map(|(id, owner)| (id, owner.sha256))
                .collect();
            let fragments = mods::event_fragments(
                &mut runtime,
                name,
                payload,
                || !cancelled.load(Ordering::Acquire),
                "native permissions",
                |id, request| {
                    if codex_omd::scoped_data::operation(&request.operation) {
                        let scope = data_scope.as_ref().ok_or_else(|| {
                            std::io::Error::other("thread_data_scope_unavailable")
                        })?;
                        let profile = profile.as_ref().ok_or_else(|| {
                            std::io::Error::other("platform_permission_profile_unavailable")
                        })?;
                        let authority =
                            crate::workspace_operations::WorkspaceAuthority::for_platform(
                                &repository,
                                profile.clone(),
                            )
                            .map_err(std::io::Error::other)?;
                        let mut data = codex_omd::scoped_data::ScopedDataHost::new(
                            root.clone(),
                            repository.clone(),
                            Some(scope.sessions.clone()),
                            id.to_owned(),
                            scope.thread.clone(),
                            generation,
                            sources
                                .get(id)
                                .cloned()
                                .ok_or_else(|| std::io::Error::other("data_owner_missing"))?,
                        )?;
                        data.session_database = Some(scope.database.clone());
                        return data.call(
                            &request.operation,
                            request.arguments,
                            &|path| authority.readable(path),
                            || !cancelled.load(Ordering::Acquire),
                        );
                    }
                    if request.operation.starts_with("git.") {
                        return mods::lifecycle_git(
                            matches!(
                                name,
                                "start"
                                    | "resume"
                                    | "turn_start"
                                    | "turn_end"
                                    | "workspace_write"
                                    | "idle"
                            ),
                            &repository,
                            std::slice::from_ref(&root),
                            request,
                            &|| !cancelled.load(Ordering::Acquire),
                        );
                    }
                    let allowed = (matches!(name, "workspace_write" | "turn_start")
                        && request.operation == "workspace.read")
                        || (matches!(
                            name,
                            "start" | "resume" | "turn_start" | "workspace_write" | "idle" | "stop"
                        ) && request.operation.starts_with("process."));
                    if !allowed {
                        return Err(std::io::Error::other(
                            "host_operation_unavailable: requires a native task",
                        ));
                    }
                    let profile = profile.as_ref().ok_or_else(|| {
                        std::io::Error::other("platform_permission_profile_unavailable")
                    })?;
                    let authority = crate::workspace_operations::WorkspaceAuthority::for_platform(
                        &repository,
                        profile.clone(),
                    )
                    .map_err(std::io::Error::other)?;
                    let result = if request.operation == "workspace.read" {
                        authority.call(&request.operation, request.arguments, || {
                            !cancelled.load(Ordering::Acquire)
                        })
                    } else {
                        processes
                            .as_ref()
                            .ok_or_else(|| {
                                std::io::Error::other("platform_process_scope_unavailable")
                            })?
                            .call(
                                id,
                                generation,
                                &authority.repository,
                                &authority.policy,
                                &request.operation,
                                request.arguments,
                                || !cancelled.load(Ordering::Acquire),
                            )
                    };
                    result.map_err(std::io::Error::other)
                },
            );
            let input =
                json!({"event":name,"identity":mods::terminal_identity(&runtime, "platform")});
            let terminal =
                runtime.terminal_view(input.clone(), || !cancelled.load(Ordering::Acquire));
            let snapshot = codex_omd::ModViewSnapshot {
                epoch,
                revision,
                view: terminal.view,
                owner: terminal.owner,
                contributors: terminal.contributors,
                input,
                diagnostics: terminal.diagnostics,
                ..Default::default()
            };
            if let Ok(bytes) =
                serde_json::to_value(snapshot).and_then(|value| serde_json::to_vec(&value))
            {
                let _ = persist_atomic(&root, "mod-view.json", &bytes);
            }
            let status = runtime.status();
            for id in status["mods"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item["error"].is_string())
                .filter_map(|item| item["id"].as_str())
            {
                if let Some(processes) = &processes {
                    processes.cleanup_owned(id, generation);
                }
            }
            if let Ok(bytes) = serde_json::to_vec(&status) {
                let _ = persist_atomic(&root, "mod-status.json", &bytes);
            }
            fragments
        })
        .await
        .unwrap_or_default()
    }
}

impl codex_extension_api::ConfigContributor<Config> for PlatformMods {
    fn prepare_thread_config(&self, config: &mut Config) -> Result<(), String> {
        let profile = config.permissions.effective_permission_profile();
        if matches!(profile, PermissionProfile::External { .. }) {
            return Err("mods_require_native_sandbox_for_host_owned_files".into());
        }
        let path = AbsolutePathBuf::from_absolute_path_checked(&self.root)
            .map_err(|error| error.to_string())?;
        let mut filesystem = profile.file_system_sandbox_policy();
        filesystem.preserve_deny_read_restrictions_from(&FileSystemSandboxPolicy::restricted(
            vec![FileSystemSandboxEntry::new(
                FileSystemPath::Path { path: path.into() },
                FileSystemAccessMode::Deny,
            )],
        ));
        let protected = PermissionProfile::from_runtime_permissions(
            &filesystem,
            profile.network_sandbox_policy(),
        );
        config
            .permissions
            .shell_environment_policy
            .r#set
            .insert("OMD_CONTROLLED_NARROW_SANDBOX".into(), "1".into());
        config
            .permissions
            .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::legacy(
                protected,
            ))
            .map_err(|error| error.to_string())
    }
}

impl ContextContributor for PlatformMods {
    fn contribute_turn_context<'a>(
        &'a self,
        input: TurnContextContributionInput<'a>,
    ) -> ExtensionFuture<'a, Vec<PromptFragment>> {
        Box::pin(async move {
            if let Some(profile) = input.permission_profile {
                input
                    .thread_store
                    .insert(PlatformPermission(profile.clone()));
            }
            let scope =
                input
                    .thread_store
                    .get::<PlatformSessionRoot>()
                    .map(|home| PlatformDataScope {
                        thread: input.thread_id.to_string(),
                        sessions: home.0.clone(),
                        database: home.1.clone(),
                    });
            if let Some(scope) = &scope {
                input.thread_store.insert(scope.clone());
            }
            self.event_with_data("context",json!({"thread_id":input.thread_id.to_string(),"turn_id":input.turn_id,"checkpoint":Value::Null}),
                input.thread_store.get::<PlatformPermission>().map(|value|value.0.clone()),
                input.thread_store.get::<PlatformProcesses>().map(|value|value.0.clone()),scope).await
        })
    }
}

impl ThreadLifecycleContributor<Config> for PlatformMods {
    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let profile = input.config.permissions.effective_permission_profile();
            input.thread_store.insert(PlatformSessionRoot(
                input.config.codex_home.join("sessions").to_path_buf(),
                input.config.sqlite.state_db_path(),
            ));
            input
                .thread_store
                .insert(PlatformPermission(profile.clone()));
            let processes = Arc::new(crate::managed_process::ManagedProcesses::default());
            input
                .thread_store
                .insert(PlatformProcesses(processes.clone()));
            self.event("session", json!({"phase":"start"})).await;
            self.event_with_profile("start", Value::Null, Some(profile), Some(processes))
                .await;
        })
    }
    fn on_thread_resume<'a>(
        &'a self,
        input: codex_extension_api::ThreadResumeInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            self.event("session", json!({"phase":"resume"})).await;
            self.event_with_data(
                "resume",
                Value::Null,
                input
                    .thread_store
                    .get::<PlatformPermission>()
                    .map(|value| value.0.clone()),
                input
                    .thread_store
                    .get::<PlatformProcesses>()
                    .map(|value| value.0.clone()),
                input.thread_store.get::<PlatformDataScope>().map(|value| (*value).clone()),
            )
            .await;
        })
    }
    fn on_thread_idle<'a>(&'a self, input: ThreadIdleInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            self.event_with_data(
                "idle",
                json!({"cause":format!("{:?}", input.cause)}),
                input
                    .thread_store
                    .get::<PlatformPermission>()
                    .map(|value| value.0.clone()),
                input
                    .thread_store
                    .get::<PlatformProcesses>()
                    .map(|value| value.0.clone()),
                input.thread_store.get::<PlatformDataScope>().map(|value| (*value).clone()),
            )
            .await;
        })
    }
    fn on_thread_stop<'a>(&'a self, input: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            self.event_with_data(
                "stop",
                Value::Null,
                input
                    .thread_store
                    .get::<PlatformPermission>()
                    .map(|value| value.0.clone()),
                input
                    .thread_store
                    .get::<PlatformProcesses>()
                    .map(|value| value.0.clone()),
                input.thread_store.get::<PlatformDataScope>().map(|value| (*value).clone()),
            )
            .await;
            if let Some(processes) = input.thread_store.get::<PlatformProcesses>() {
                processes.0.cleanup();
            }
        })
    }
}

impl codex_extension_api::TurnLifecycleContributor for PlatformMods {
    fn on_turn_abort<'a>(
        &'a self,
        input: codex_extension_api::TurnAbortInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let turn = self.turn.lock().ok().and_then(|mut turn| turn.take());
            self.event(
                "turn_end",
                json!({"turn_id":turn.map(|turn| turn.id),"outcome":"aborted","reason":format!("{:?}", input.reason)}),
            )
            .await;
        })
    }
    fn on_turn_error<'a>(
        &'a self,
        input: codex_extension_api::TurnErrorInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Ok(mut turn) = self.turn.lock()
                && let Some(turn) = turn.as_mut()
            {
                turn.error = Some(format!("{:?}", input.error));
            }
        })
    }
    fn on_compaction_start<'a>(
        &'a self,
        input: codex_extension_api::CompactionLifecycleInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            self.event(
                "compaction_start",
                json!({"turn_id":input.turn_id,"trigger":input.trigger}),
            )
            .await;
        })
    }
    fn on_compaction_end<'a>(
        &'a self,
        input: codex_extension_api::CompactionLifecycleInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            self.event(
                "compaction_end",
                json!({"turn_id":input.turn_id,"trigger":input.trigger}),
            )
            .await;
        })
    }
    fn intercept_user_input<'a>(
        &'a self,
        input: codex_extension_api::UserInputInterceptInput<'a>,
    ) -> ExtensionFuture<'a, codex_extension_api::UserInputDecision> {
        Box::pin(async move {
            let runtime = self.input_runtime.clone();
            let payload = json!({"text":input.text,"attachments":input.attachments});
            tokio::task::spawn_blocking(move || {
                let mut runtime = match runtime.lock() {
                    Ok(runtime) => runtime,
                    Err(_) => return codex_extension_api::UserInputDecision::Deny {
                        notice: "Mod input hook unavailable; prompt not sent".into(),
                    },
                };
                runtime.turn_boundary();
                let mut rewrite = None;
                for (id, result) in runtime.event_guarded("input", payload, || true) {
                    match result.and_then(|value| ModInputDecision::parse(&value)) {
                        Ok(ModInputDecision::Keep) => (),
                        Ok(ModInputDecision::Deny(reason)) => return codex_extension_api::UserInputDecision::Deny {
                            notice: format!("Mod {id} denied this prompt: {reason}"),
                        },
                        Ok(ModInputDecision::Rewrite(text)) if rewrite.is_none() => rewrite = Some((id, text)),
                        Ok(ModInputDecision::Rewrite(_)) => return codex_extension_api::UserInputDecision::Deny {
                            notice: "mod_input_rewrite_conflict".into(),
                        },
                        Err(error) => return codex_extension_api::UserInputDecision::Deny {
                            notice: format!("Mod {id} input hook failed and is disabled until reload: {error}"),
                        },
                    }
                }
                match rewrite {
                    Some((id, text)) => codex_extension_api::UserInputDecision::Rewrite {
                        notice: format!("Mod {id} rewrote this prompt."), text,
                    },
                    None => codex_extension_api::UserInputDecision::Keep,
                }
            }).await.unwrap_or(codex_extension_api::UserInputDecision::Deny {
                notice: "Mod input hook unavailable; prompt not sent".into(),
            })
        })
    }
    fn on_turn_start<'a>(
        &'a self,
        input: codex_extension_api::TurnStartInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Ok(mut runtime) = self.runtime.lock() {
                runtime.turn_boundary();
            }
            if let Ok(mut turn) = self.turn.lock() {
                *turn = Some(TurnRecord {
                    id: input.turn_id.to_owned(),
                    error: None,
                });
            }
            self.event_with_data(
                "turn_start",
                json!({"turn_id":input.turn_id}),
                input
                    .thread_store
                    .get::<PlatformPermission>()
                    .map(|value| value.0.clone()),
                input
                    .thread_store
                    .get::<PlatformProcesses>()
                    .map(|value| value.0.clone()),
                input.thread_store.get::<PlatformDataScope>().map(|value| (*value).clone()),
            )
            .await;
        })
    }
    fn on_turn_stop<'a>(
        &'a self,
        input: codex_extension_api::TurnStopInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Ok(mut before) = self.workspace_before.lock() {
                before.clear();
            }
            let turn = self.turn.lock().ok().and_then(|mut turn| turn.take());
            let payload = match turn {
                Some(TurnRecord {
                    id,
                    error: Some(error),
                }) => json!({"turn_id":id,"outcome":"error","error":error}),
                Some(TurnRecord { id, error: None }) => json!({"turn_id":id,"outcome":"completed"}),
                None => json!({"outcome":"completed"}),
            };
            self.event_with_data("turn_end", payload,
                input.thread_store.get::<PlatformPermission>().map(|value|value.0.clone()),
                input.thread_store.get::<PlatformProcesses>().map(|value|value.0.clone()),
                input.thread_store.get::<PlatformDataScope>().map(|value|(*value).clone())).await;
        })
    }
}

impl ToolLifecycleContributor for PlatformMods {
    fn on_tool_start<'a>(&'a self, input: ToolStartInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            if !self
                .runtime
                .lock()
                .is_ok_and(|runtime| runtime.has_event("workspace_write"))
            {
                return;
            }
            let repository = self.repository.clone();
            let snapshot = tokio::task::spawn_blocking(move || {
                codex_omd::WorkspaceIndex::capture(&repository, 20_000, 128 * 1024 * 1024)
                    .map_err(|error| error.to_string())
            })
            .await
            .unwrap_or_else(|error| Err(error.to_string()));
            if let Ok(mut before) = self.workspace_before.lock() {
                before.insert(input.call_id.to_owned(), snapshot);
            }
        })
    }

    fn on_tool_finish<'a>(&'a self, input: ToolFinishInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            self.event(
                "tool_result",
                json!({"call_id":input.call_id,"tool":input.tool_name.to_string(),"outcome":format!("{:?}",input.outcome)}),
            )
            .await;
            let before = self
                .workspace_before
                .lock()
                .ok()
                .and_then(|mut snapshots| snapshots.remove(input.call_id));
            if let Some(before) = before {
                let repository = self.repository.clone();
                let after = tokio::task::spawn_blocking(move || {
                    codex_omd::WorkspaceIndex::capture(&repository, 20_000, 128 * 1024 * 1024)
                        .map_err(|error| error.to_string())
                })
                .await
                .unwrap_or_else(|error| Err(error.to_string()));
                let (status, changes, reason) = match (before, after) {
                    (Ok(before), Ok(after)) => {
                        let changes = before.changed(&after);
                        if changes.len() > 128
                            || changes
                                .iter()
                                .map(|change| change.path.len())
                                .sum::<usize>()
                                > 16_000
                        {
                            (
                                "unavailable",
                                Vec::new(),
                                Some("workspace_change_batch_limit".to_owned()),
                            )
                        } else {
                            ("observed", changes, None)
                        }
                    }
                    (Err(error), _) | (_, Err(error)) => ("unavailable", Vec::new(), Some(error)),
                };
                let (status, changes, reason) = if status == "observed" && !changes.is_empty() {
                    match input.thread_store.get::<PlatformPermission>() {
                        Some(profile) => {
                            match crate::workspace_operations::WorkspaceAuthority::for_platform(
                                &self.repository,
                                profile.0.clone(),
                            ) {
                                Ok(authority) => match authority.visible_changes(changes) {
                                    Ok(changes) => (status, changes, reason),
                                    Err(error) => ("unavailable", Vec::new(), Some(error)),
                                },
                                Err(_) => (
                                    "unavailable",
                                    Vec::new(),
                                    Some("workspace_change_scope_unavailable".to_owned()),
                                ),
                            }
                        }
                        None => (
                            "unavailable",
                            Vec::new(),
                            Some("workspace_change_scope_unavailable".to_owned()),
                        ),
                    }
                } else {
                    (status, changes, reason)
                };
                if status == "unavailable" || !changes.is_empty() {
                    self.event_with_data(
                        "workspace_write",
                        json!({
                            "repository":self.repository,
                            "call_id":input.call_id,
                            "tool":input.tool_name.to_string(),
                            "outcome":format!("{:?}", input.outcome),
                            "changes":changes,
                            "status":status,
                            "reason":reason,
                        }),
                        input
                            .thread_store
                            .get::<PlatformPermission>()
                            .map(|value| value.0.clone()),
                        input
                            .thread_store
                            .get::<PlatformProcesses>()
                            .map(|value| value.0.clone()),
                        input.thread_store.get::<PlatformDataScope>().map(|value| (*value).clone()),
                    )
                    .await;
                }
            }
        })
    }
}

impl ToolContributor for PlatformMods {
    fn tools(
        &self,
        _: &ExtensionData,
        thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        let Ok(runtime) = self.runtime.lock() else {
            return Vec::new();
        };
        let Some(processes) = thread_store.get::<PlatformProcesses>() else {
            return Vec::new();
        };
        self.tool_executors(
            runtime.tools(),
            processes.0.clone(),
            thread_store.get::<PlatformDataScope>(),
        )
    }
    fn tools_for_step(
        &self,
        _: &ExtensionData,
        thread_store: &ExtensionData,
        _: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        let Ok(mut runtime) = self.runtime.lock() else {
            return Vec::new();
        };
        let tools = runtime.tools_for_step(None, Value::Null, || true);
        let Some(processes) = thread_store.get::<PlatformProcesses>() else {
            return Vec::new();
        };
        self.tool_executors(
            tools,
            processes.0.clone(),
            thread_store.get::<PlatformDataScope>(),
        )
    }
}

impl PlatformMods {
    fn tool_executors(
        &self,
        tools: Vec<(String, u64, ModTool)>,
        processes: Arc<crate::managed_process::ManagedProcesses>,
        data_scope: Option<Arc<PlatformDataScope>>,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        tools
            .into_iter()
            .filter_map(|(id, generation, definition)| {
                let parameters =
                    codex_extension_api::parse_tool_input_schema(&definition.parameters).ok()?;
                Some(Arc::new(PlatformTool {
                    runtime: self.runtime.clone(),
                    pre_rename_runtime: self.input_runtime.clone(),
                    repository: self.repository.clone(),
                    processes: processes.clone(),
                    id,
                    generation,
                    definition,
                    parameters,
                    root: self.root.clone(),
                    data_scope: data_scope.clone(),
                })
                    as Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>)
            })
            .collect()
    }
}

impl<'call> ToolExecutor<ToolCall<'call>> for PlatformTool {
    fn tool_name(&self) -> ToolName {
        ToolName::plain(if self.id.is_empty() {
            self.definition.name.clone()
        } else {
            format!("mod_{}_{}", self.id, self.definition.name)
        })
    }
    fn spec(&self) -> ToolSpec {
        ToolSpec::Function(ResponsesApiTool {
            name: if self.id.is_empty() {
                self.definition.name.clone()
            } else {
                format!("mod_{}_{}", self.id, self.definition.name)
            },
            description: self.definition.description.clone(),
            strict: false,
            defer_loading: None,
            output_schema: None,
            parameters: self.parameters.clone(),
        })
    }
    fn exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }
    fn handle<'a>(&'a self, call: ToolCall<'call>) -> ToolExecutorFuture<'a>
    where
        'call: 'a,
    {
        Box::pin(async move {
            let payload: Value = serde_json::from_str(call.function_arguments()?)
                .map_err(|error| FunctionCallError::RespondToModel(error.to_string()))?;
            let environment = call.environments.as_slice();
            let authority = (environment.len() == 1
                && environment[0].environment_id == "local"
                && environment[0]
                    .cwd
                    .to_abs_path()
                    .is_ok_and(|cwd| cwd.as_path() == self.repository.as_path()))
            .then(|| {
                let context = environment[0].file_system_sandbox_context.clone();
                crate::workspace_operations::WorkspaceAuthority {
                    repository: self.repository.clone(),
                    session_root: self.data_scope.as_ref().map(|scope| scope.sessions.clone()),
                    session_database: self.data_scope.as_ref().map(|scope| scope.database.clone()),
                    policy: context.permissions.file_system_sandbox_policy(),
                    context,
                }
            });
            let runtime = self.runtime.clone();
            let pre_rename_runtime = self.pre_rename_runtime.clone();
            let processes = self.processes.clone();
            let id = self.id.clone();
            let name = self.definition.name.clone();
            let generation = self.generation;
            let root = self.root.clone();
            let data_scope = self.data_scope.clone();
            let cancelled = Arc::new(AtomicBool::new(false));
            let _cancellation = Cancellation(cancelled.clone());
            let result = tokio::task::spawn_blocking(move || {
                let mut runtime = runtime
                    .lock()
                    .map_err(|_| std::io::Error::other("mod_runtime_poisoned"))?;
                let sources: BTreeMap<_, _> = runtime
                    .owners()
                    .into_iter()
                    .map(|(id, owner)| (id, owner.sha256))
                    .collect();
                runtime.invoke_tool(
                    &id,
                    generation,
                    &name,
                    payload,
                    || !cancelled.load(Ordering::Acquire),
                    |caller, request| {
                        if codex_omd::scoped_data::operation(&request.operation) {
                            let authority = authority.as_ref().ok_or_else(|| {
                                std::io::Error::other(
                                    "workspace_operation_requires_local_repository",
                                )
                            })?;
                            let scope = data_scope.as_ref().ok_or_else(|| {
                                std::io::Error::other("thread_data_scope_unavailable")
                            })?;
                            let mut data = codex_omd::scoped_data::ScopedDataHost::new(
                                root.clone(),
                                authority.repository.clone(),
                                Some(scope.sessions.clone()),
                                caller.to_owned(),
                                scope.thread.clone(),
                                generation,
                                sources
                                    .get(caller)
                                    .cloned()
                                    .ok_or_else(|| std::io::Error::other("data_owner_missing"))?,
                            )?;
                            data.session_database = Some(scope.database.clone());
                        return data.call(
                                &request.operation,
                                request.arguments,
                                &|path| authority.readable(path),
                                || !cancelled.load(Ordering::Acquire),
                            );
                        }
                        if matches!(
                            request.operation.as_str(),
                            "workspace.read"
                                | "workspace.transaction"
                                | "workspace.request_rename"
                                | "process.which"
                                | "process.start"
                                | "process.exchange"
                                | "process.status"
                                | "process.stop"
                        ) {
                            let authority = authority.as_ref().ok_or_else(|| {
                                std::io::Error::other(
                                    "workspace_operation_requires_local_repository",
                                )
                            })?;
                            let result = if request.operation == "workspace.request_rename" {
                                let mut runtime = pre_rename_runtime.lock().map_err(|_| {
                                    std::io::Error::other("pre_rename_runtime_poisoned")
                                })?;
                                authority.request_rename(
                                    request.arguments,
                                    &mut runtime,
                                    &processes,
                                    generation,
                                    || !cancelled.load(Ordering::Acquire),
                                )
                            } else if request.operation.starts_with("process.") {
                                processes.call(
                                    caller,
                                    generation,
                                    &authority.repository,
                                    &authority.policy,
                                    &request.operation,
                                    request.arguments,
                                    || !cancelled.load(Ordering::Acquire),
                                )
                            } else {
                                authority.call(&request.operation, request.arguments, || {
                                    !cancelled.load(Ordering::Acquire)
                                })
                            };
                            result.map_err(std::io::Error::other)
                        } else {
                            Err(std::io::Error::other(
                                "controlled_task_operation_unavailable_in_platform_mode",
                            ))
                        }
                    },
                    |_| {},
                )
            })
            .await
            .map_err(|error| FunctionCallError::RespondToModel(error.to_string()))?
            .map_err(|error| FunctionCallError::RespondToModel(error.to_string()))?;
            Ok(Box::new(JsonToolOutput::new(result)) as Box<dyn ToolOutput>)
        })
    }
}
