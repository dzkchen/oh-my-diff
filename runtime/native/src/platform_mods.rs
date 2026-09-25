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
    runtime: Arc<Mutex<ModHost>>,
    input_runtime: Arc<Mutex<ModHost>>,
    epoch: u64,
    revision: AtomicU64,
    turn: Mutex<Option<TurnRecord>>,
}

struct TurnRecord {
    id: String,
    error: Option<String>,
}

struct PlatformTool {
    runtime: Arc<Mutex<ModHost>>,
    id: String,
    generation: u64,
    definition: ModTool,
    parameters: JsonSchema,
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
    if !root.is_absolute() || canonical != root || root.starts_with(repository) {
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
        runtime: Arc::new(Mutex::new(runtime)),
        input_runtime: Arc::new(Mutex::new(input_runtime)),
        epoch: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| u64::try_from(elapsed.as_nanos()).unwrap_or(u64::MAX))
            .unwrap_or_default(),
        revision: AtomicU64::new(0),
        turn: Mutex::new(None),
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
        let runtime = self.runtime.clone();
        let root = self.root.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let _cancellation = Cancellation(cancelled.clone());
        let epoch = self.epoch;
        let revision = self.revision.fetch_add(1, Ordering::AcqRel) + 1;
        tokio::task::spawn_blocking(move || {
            let Ok(mut runtime) = runtime.lock() else {
                return Vec::new();
            };
            let fragments = mods::event_fragments(
                &mut runtime,
                name,
                payload,
                || !cancelled.load(Ordering::Acquire),
                "native permissions",
                |_, _| {
                    Err(std::io::Error::other(
                        "host_operation_unavailable: requires a native task",
                    ))
                },
            );
            let terminal =
                runtime.terminal_view(json!({"event":name}), || !cancelled.load(Ordering::Acquire));
            let snapshot = codex_omd::ModViewSnapshot {
                epoch,
                revision,
                view: terminal.view,
                owner: terminal.owner,
                contributors: terminal.contributors,
                input: json!({"event":name}),
                diagnostics: terminal.diagnostics,
                ..Default::default()
            };
            if let Ok(bytes) =
                serde_json::to_value(snapshot).and_then(|value| serde_json::to_vec(&value))
            {
                let _ = persist_atomic(&root, "mod-view.json", &bytes);
            }
            if let Ok(bytes) = serde_json::to_vec(&runtime.status()) {
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
        Box::pin(self.event(
            "context",
            json!({
                "thread_id":input.thread_id.to_string(), "turn_id":input.turn_id,
                "checkpoint":Value::Null,
            }),
        ))
    }
}

impl ThreadLifecycleContributor<Config> for PlatformMods {
    fn on_thread_start<'a>(&'a self, _: ThreadStartInput<'a, Config>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            self.event("session", json!({"phase":"start"})).await;
            self.event("start", Value::Null).await;
        })
    }
    fn on_thread_resume<'a>(
        &'a self,
        _: codex_extension_api::ThreadResumeInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            self.event("session", json!({"phase":"resume"})).await;
            self.event("resume", Value::Null).await;
        })
    }
    fn on_thread_stop<'a>(&'a self, _: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            self.event("stop", Value::Null).await;
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
            self.event("turn_start", json!({"turn_id":input.turn_id}))
                .await;
        })
    }
    fn on_turn_stop<'a>(
        &'a self,
        _: codex_extension_api::TurnStopInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let turn = self.turn.lock().ok().and_then(|mut turn| turn.take());
            let payload = match turn {
                Some(TurnRecord {
                    id,
                    error: Some(error),
                }) => json!({"turn_id":id,"outcome":"error","error":error}),
                Some(TurnRecord { id, error: None }) => json!({"turn_id":id,"outcome":"completed"}),
                None => json!({"outcome":"completed"}),
            };
            self.event("turn_end", payload).await;
        })
    }
}

impl ToolLifecycleContributor for PlatformMods {
    fn on_tool_finish<'a>(&'a self, input: ToolFinishInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            self.event(
                "tool_result",
                json!({"call_id":input.call_id,"tool":input.tool_name.to_string(),"outcome":format!("{:?}",input.outcome)}),
            )
            .await;
        })
    }
}

impl ToolContributor for PlatformMods {
    fn tools(
        &self,
        _: &ExtensionData,
        _: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        let Ok(runtime) = self.runtime.lock() else {
            return Vec::new();
        };
        self.tool_executors(runtime.tools())
    }
    fn tools_for_step(
        &self,
        _: &ExtensionData,
        _: &ExtensionData,
        _: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        let Ok(mut runtime) = self.runtime.lock() else {
            return Vec::new();
        };
        let tools = runtime.tools_for_step(None, Value::Null, || true);
        self.tool_executors(tools)
    }
}

impl PlatformMods {
    fn tool_executors(
        &self,
        tools: Vec<(String, u64, ModTool)>,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        tools
            .into_iter()
            .filter_map(|(id, generation, definition)| {
                let parameters =
                    codex_extension_api::parse_tool_input_schema(&definition.parameters).ok()?;
                Some(Arc::new(PlatformTool {
                    runtime: self.runtime.clone(),
                    id,
                    generation,
                    definition,
                    parameters,
                })
                    as Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>)
            })
            .collect()
    }
}

impl<'call> ToolExecutor<ToolCall<'call>> for PlatformTool {
    fn tool_name(&self) -> ToolName {
        ToolName::plain(format!("mod_{}_{}", self.id, self.definition.name))
    }
    fn spec(&self) -> ToolSpec {
        ToolSpec::Function(ResponsesApiTool {
            name: format!("mod_{}_{}", self.id, self.definition.name),
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
            let runtime = self.runtime.clone();
            let id = self.id.clone();
            let name = self.definition.name.clone();
            let generation = self.generation;
            let cancelled = Arc::new(AtomicBool::new(false));
            let _cancellation = Cancellation(cancelled.clone());
            let result = tokio::task::spawn_blocking(move || {
                let mut runtime = runtime
                    .lock()
                    .map_err(|_| std::io::Error::other("mod_runtime_poisoned"))?;
                runtime.invoke_with(
                    &id,
                    generation,
                    "tool",
                    &name,
                    payload,
                    || !cancelled.load(Ordering::Acquire),
                    |_| {
                        Err(std::io::Error::other(
                            "controlled_task_operation_unavailable_in_platform_mode",
                        ))
                    },
                )
            })
            .await
            .map_err(|error| FunctionCallError::RespondToModel(error.to_string()))?
            .map_err(|error| FunctionCallError::RespondToModel(error.to_string()))?;
            Ok(Box::new(JsonToolOutput::new(result)) as Box<dyn ToolOutput>)
        })
    }
}
