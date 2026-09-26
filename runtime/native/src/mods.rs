mod agents;
mod operations;
mod policy;
pub(crate) mod services;
mod tools;
mod view;

use super::*;
use codex_extension_api::CompactionLifecycleInput;
use codex_extension_api::ThreadReadyInput;
use codex_extension_api::ThreadResumeInput;
use codex_extension_api::TurnLifecycleContributor;
use codex_extension_api::TurnStartInput;
use codex_extension_api::UserInputDecision;
use codex_extension_api::UserInputInterceptInput;
use codex_omd::ModHost;
use codex_omd::ModInputDecision;
use codex_omd::ModTool;
use std::sync::Mutex;

fn lead_thread(thread: &ExtensionData) -> bool {
    thread
        .get::<Lead>()
        .is_some_and(|lead| lead.owner == "lead")
}

fn agent_id(thread: &ExtensionData) -> Option<String> {
    thread
        .get::<Lead>()
        .and_then(|lead| (lead.owner != "lead").then(|| lead.owner.clone()))
}

fn thread_id(thread: &ExtensionData) -> Option<String> {
    thread.get::<Lead>().map(|lead| lead.thread.to_string())
}

struct TurnRecord {
    turn_id: String,
    error: Option<String>,
}

struct Mods {
    owner: Arc<Host>,
    runtime: Arc<Mutex<ModHost>>,
    input_runtime: Arc<Mutex<ModHost>>,
    agents: Arc<agents::Agents>,
    services: Arc<services::Services>,
    processes: Arc<crate::managed_process::ManagedProcesses>,
    views: Arc<view::Views>,
    turn: Mutex<Option<TurnRecord>>,
    workspace_before: Mutex<BTreeMap<String, Result<codex_omd::WorkspaceIndex, String>>>,
}

fn preview(text: &str) -> String {
    let mut shown: String = text.chars().take(1024).collect();
    if shown.len() < text.len() {
        shown.push_str("...");
    }
    shown
}

pub(crate) fn terminal_identity(runtime: &ModHost, mode: &str) -> Value {
    runtime.identity(
        env!("CARGO_PKG_VERSION"),
        std::env::var("OMD_INSTALL_PROFILE").ok().as_deref(),
        mode,
    )
}

pub(crate) fn lifecycle_git(
    allowed: bool,
    repository: &std::path::Path,
    protected: &[std::path::PathBuf],
    request: codex_omd::ModHostCall,
    active: &dyn Fn() -> bool,
) -> std::io::Result<Value> {
    if !allowed {
        return Err(std::io::Error::other(
            "host_operation_unavailable: git reads run in lifecycle events and commands",
        ));
    }
    let access = codex_omd::git::GitAccess {
        repository,
        protected,
        backups: None,
        write: Err("git_write_requires_user_command"),
        command: None,
        writable: &|_| false,
    };
    codex_omd::git::call(&access, &request.operation, request.arguments, active)
        .map_err(std::io::Error::other)
}

pub(super) fn event_fragments(
    runtime: &mut ModHost,
    event: &str,
    payload: Value,
    active: impl Fn() -> bool,
    authority: &str,
    host: impl FnMut(&str, codex_omd::ModHostCall) -> std::io::Result<Value>,
) -> Vec<PromptFragment> {
    let mut fragments = Vec::new();
    let mut remaining_bytes = 6144;
    let assembler = (event == "context")
        .then(|| runtime.replacement_owner("context"))
        .flatten();
    let mut replaced: Vec<String> = Vec::new();
    for (id, result) in runtime.event_guarded_with(event, payload, active, host) {
        match result {
            Ok(value) if event == "context" => {
                if assembler.as_ref().is_some_and(|owner| *owner != id) {
                    if value.get("text").is_some() {
                        replaced.push(id);
                    }
                    continue;
                }
                if let Some(text) = value.get("text").and_then(Value::as_str) {
                    if text.len() + 256 > remaining_bytes {
                        fragments.push(PromptFragment::developer_capability(
                            "Additional mod context omitted at the host aggregate limit.",
                            ContentItemKind("oh_my_diff.mod_error".into()),
                        ));
                        break;
                    }
                    remaining_bytes -= text.len() + 256;
                    fragments.push(PromptFragment::developer_capability(
                        format!("User-approved mod {id}. Subordinate to current user/project instructions and {authority}.\n{text}"),
                        ContentItemKind("oh_my_diff.mod_context".into()),
                    ));
                }
            }
            Err(error) => {
                if remaining_bytes < 1024 {
                    break;
                }
                remaining_bytes -= 1024;
                fragments.push(PromptFragment::developer_capability(
                    format!("Mod {id} failed and is disabled for this runtime: {error}"),
                    ContentItemKind("oh_my_diff.mod_error".into()),
                ));
            }
            _ => (),
        }
    }
    if let Some(assembler) = assembler.filter(|_| !replaced.is_empty()) {
        fragments.push(PromptFragment::developer_capability(
            format!(
                "Mod {assembler} assembles mod context; contributions from {} were replaced.",
                replaced.join(", ")
            ),
            ContentItemKind("oh_my_diff.mod_context".into()),
        ));
    }
    fragments
}

pub(super) fn install(
    registry: &mut ExtensionRegistryBuilder<Config>,
    owner: Arc<Host>,
) -> Result<(), String> {
    let Some(root) = &owner.manifest.mods else {
        return Ok(());
    };
    if root.starts_with(&owner.manifest.repository) || !root.is_absolute() {
        return Err("mod trust/state store must be outside the repository".into());
    }
    let validator = |schema: &Value| {
        codex_extension_api::parse_tool_input_schema(schema)
            .map(|_| ())
            .map_err(std::io::Error::other)
    };
    let runtime = ModHost::open_validated(root.clone(), validator).map_err(|e| e.to_string())?;
    let input_runtime =
        ModHost::open_validated(root.clone(), validator).map_err(|e| e.to_string())?;
    let runtime = Arc::new(Mutex::new(runtime));
    owner.accounts.install_mod_runtime(runtime.clone());
    let views = Arc::new(view::Views::new());
    let extension = Arc::new(Mods {
        agents: Arc::new(agents::Agents::new(
            runtime.clone(),
            views.clone(),
            owner.clone(),
        )),
        owner,
        runtime,
        input_runtime: Arc::new(Mutex::new(input_runtime)),
        services: Arc::new(services::Services::default()),
        processes: Arc::new(crate::managed_process::ManagedProcesses::default()),
        views,
        turn: Mutex::new(None),
        workspace_before: Mutex::new(BTreeMap::new()),
    });
    registry.config_contributor(extension.clone());
    registry.prompt_contributor(extension.clone());
    registry.thread_lifecycle_contributor(extension.clone());
    registry.tool_lifecycle_contributor(extension.clone());
    registry.turn_lifecycle_contributor(extension.clone());
    registry.tool_contributor(extension);
    Ok(())
}

impl Mods {
    async fn cleanup_failed(&self) {
        let runtime = self.runtime.clone();
        let failed = tokio::task::spawn_blocking(move || {
            let Ok(runtime) = runtime.lock() else {
                return Vec::new();
            };
            runtime.status()["mods"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item["error"].is_string())
                .filter_map(|item| {
                    item["id"]
                        .as_str()
                        .map(|id| (id.to_owned(), runtime.generation()))
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        for (id, generation) in failed {
            self.agents.cleanup_owned(&id, generation).await;
            self.services.cleanup_owned(&id, generation).await;
            self.processes.cleanup_owned(&id, generation);
        }
    }

    async fn event(&self, event: &'static str, payload: Value) -> Vec<PromptFragment> {
        self.event_with_lead(event, payload, None).await
    }

    async fn event_with_lead(
        &self,
        event: &'static str,
        payload: Value,
        lead: Option<Arc<Lead>>,
    ) -> Vec<PromptFragment> {
        let runtime = self.runtime.clone();
        let owner = self.owner.clone();
        let views = self.views.clone();
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _cancellation = Cancellation(cancelled.clone());
        let (requests, mut receiver) = tokio::sync::mpsc::channel::<(
            String,
            codex_omd::ModHostCall,
            std::sync::mpsc::SyncSender<std::io::Result<Value>>,
        )>(1);
        let generation = self.runtime.lock().ok().map(|runtime| runtime.generation());
        if let Some(generation) = generation {
            self.processes.cleanup_stale(generation);
        }
        let allow_provider = matches!(event, "start" | "resume" | "turn_start");
        let allow_git = matches!(
            event,
            "start" | "resume" | "turn_start" | "turn_end" | "workspace_write" | "idle"
        );
        let git_repository = owner.manifest.repository.clone();
        let git_protected = crate::execution::protected_paths(&owner.manifest);
        let allow_workspace = matches!(
            event,
            "workspace_write" | "workspace_pre_rename" | "turn_start"
        );
        let allow_process = matches!(
            event,
            "start"
                | "resume"
                | "turn_start"
                | "workspace_write"
                | "workspace_pre_rename"
                | "idle"
                | "stop"
        );
        let job = tokio::task::spawn_blocking(move || {
            let Ok(mut runtime) = runtime.lock() else {
                return Vec::new();
            };

            let mut fragments = event_fragments(
                &mut runtime,
                event,
                payload,
                || !cancelled.load(std::sync::atomic::Ordering::Acquire),
                "native workflow enforcement",
                |id, request| {
                    if request.operation.starts_with("git.") {
                        return lifecycle_git(
                            allow_git,
                            &git_repository,
                            &git_protected,
                            request,
                            &|| !cancelled.load(std::sync::atomic::Ordering::Acquire),
                        );
                    }
                    if !((allow_provider
                        && matches!(
                            request.operation.as_str(),
                            "providers.register" | "routes.list"
                        ))
                        || (allow_workspace && request.operation == "workspace.read")
                        || (allow_process && request.operation.starts_with("process.")))
                    {
                        return Err(std::io::Error::other(
                            "lifecycle_host_operation_unavailable",
                        ));
                    }
                    let (sender, reply) = std::sync::mpsc::sync_channel(1);
                    requests
                        .blocking_send((id.to_owned(), request, sender))
                        .map_err(|_| std::io::Error::other("native_host_stopped"))?;
                    reply
                        .recv()
                        .map_err(|_| std::io::Error::other("native_host_stopped"))?
                },
            );
            let terminal_input = json!({"event":event,"checkpoint":owner.task.checkpoint().ok().flatten(),
                "identity":terminal_identity(&runtime, "enabled")});
            let mut terminal = runtime.terminal_view(terminal_input.clone(), || {
                !cancelled.load(std::sync::atomic::Ordering::Acquire)
            });
            let status = runtime.status();
            let mut errors = status["mods"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| {
                    item["error"]
                        .as_str()
                        .map(|error| format!("{}: {error}", item["id"].as_str().unwrap_or("mod")))
                })
                .collect::<Vec<_>>();
            errors.extend(
                status["rejected"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|item| {
                        item["reason"]
                            .as_str()
                            .filter(|reason| !reason.starts_with("shadowed_"))
                            .map(|reason| {
                                format!(
                                    "{}: {reason}",
                                    item["id"]
                                        .as_str()
                                        .or(item["path"].as_str())
                                        .unwrap_or("selection")
                                )
                            })
                    }),
            );
            if let Some(error) = status["reload_error"].as_str() {
                errors.push(format!("Reload: {error}"));
            }
            if !errors.is_empty() {
                if terminal.owner.is_none() {
                    terminal.view = codex_omd::ModView {
                        title: Some("Mod recovery".into()),
                        ..Default::default()
                    };
                }
                terminal.view.panels.insert(
                    0,
                    codex_omd::ModPanel {
                        title: "Mod errors".into(),
                        lines: errors
                            .into_iter()
                            .take(16)
                            .map(|error| {
                                error
                                    .chars()
                                    .filter(|c| !c.is_control())
                                    .take(180)
                                    .collect()
                            })
                            .collect(),
                    },
                );
            }
            views.base(&owner, terminal, terminal_input);
            if let Some(error) = status["reload_error"].as_str() {
                fragments.push(PromptFragment::developer_capability(
                    format!("Mod reload failed; previous eligible mods retained: {error}"),
                    ContentItemKind("oh_my_diff.mod_error".into()),
                ));
            }
            let _ = owner.persist_runtime_file("mod-status.json", &status);
            fragments
        });
        while let Some((id, request, reply)) = receiver.recv().await {
            let value = match (&lead, generation) {
                (Some(lead), _) if request.operation == "routes.list" => Ok(json!([LeadName::Sol, LeadName::Astra].map(|name| {
                    let route = lead.host.route(name);
                    json!({"name":name,"model":route.model,"provider":route.provider,"reasoning":route.reasoning_effort})
                }))),
                (None, _) if request.operation == "routes.list" => Ok(json!([])),
                (Some(lead), Some(generation)) if request.operation == "workspace.read" || request.operation.starts_with("process.") => {
                    let authority = crate::workspace_operations::WorkspaceAuthority::for_lead(lead).await;
                    match authority {
                        Ok(authority) => {
                            let processes = self.processes.clone();
                            let lead = lead.clone();
                            tokio::task::spawn_blocking(move || {
                                if request.operation == "workspace.read" {
                                    authority.call(&request.operation, request.arguments, || lead.host.task.check_active().is_ok())
                                } else {
                                    processes.call(&id, generation, &authority.repository, &authority.policy, &request.operation, request.arguments, || lead.host.task.check_active().is_ok())
                                }
                            }).await.map_err(|error| error.to_string()).and_then(|result| result).map_err(std::io::Error::other)
                        }
                        Err(error) => Err(std::io::Error::other(error)),
                    }
                },
                (Some(lead), Some(generation)) => self
                    .services
                    .call(lead, &id, generation, request)
                    .await
                    .map_err(std::io::Error::other),
                _ => Err(std::io::Error::other("lifecycle_host_operation_unavailable")),
            };
            let _ = reply.send(value);
        }
        let fragments = job.await.unwrap_or_default();
        self.cleanup_failed().await;
        fragments
    }
}

impl Mods {
    fn take_turn(&self) -> Option<TurnRecord> {
        self.turn.lock().ok().and_then(|mut turn| turn.take())
    }

    async fn compaction(&self, event: &'static str, input: CompactionLifecycleInput<'_>) {
        if lead_thread(input.thread_store) {
            self.event(
                event,
                json!({"turn_id":input.turn_id,"trigger":input.trigger}),
            )
            .await;
        }
    }
}

impl TurnLifecycleContributor for Mods {
    fn on_turn_abort<'a>(
        &'a self,
        input: codex_extension_api::TurnAbortInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if lead_thread(input.thread_store) {
                self.agents.cleanup().await;
                self.services.cleanup().await;
                self.processes.cleanup();
                if let Some(turn) = self.take_turn() {
                    self.event("turn_end", json!({"turn_id":turn.turn_id,"outcome":"aborted","reason":format!("{:?}", input.reason)}))
                        .await;
                }
            }
        })
    }
    fn on_turn_error<'a>(
        &'a self,
        input: codex_extension_api::TurnErrorInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if lead_thread(input.thread_store)
                && let Ok(mut turn) = self.turn.lock()
                && let Some(turn) = turn.as_mut()
            {
                turn.error = Some(format!("{:?}", input.error));
            }
        })
    }
    fn on_turn_stop<'a>(
        &'a self,
        input: codex_extension_api::TurnStopInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if lead_thread(input.thread_store) {
                self.agents.cleanup().await;
                self.services.cleanup().await;
                if let Some(turn) = self.take_turn() {
                    let payload = match turn.error {
                        Some(error) => {
                            json!({"turn_id":turn.turn_id,"outcome":"error","error":error})
                        }
                        None => json!({"turn_id":turn.turn_id,"outcome":"completed"}),
                    };
                    self.event("turn_end", payload).await;
                }
            }
        })
    }
    fn intercept_user_input<'a>(
        &'a self,
        input: UserInputInterceptInput<'a>,
    ) -> ExtensionFuture<'a, UserInputDecision> {
        Box::pin(async move {
            if !lead_thread(input.thread_store) {
                return UserInputDecision::Keep;
            }
            let runtime = self.input_runtime.clone();
            let payload = json!({"text":input.text,"attachments":input.attachments});
            let prompt = json!({"thread_id":thread_id(input.thread_store),"turn_id":Value::Null,
                "original":input.text,"effective":input.text,"provenance":[]});
            let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let _cancellation = Cancellation(cancelled.clone());
            let unavailable = || UserInputDecision::Deny {
                notice: "Mod input hook unavailable; the prompt was not sent.".into(),
            };
            tokio::task::spawn_blocking(move || {
                let Ok(mut runtime) = runtime.lock() else {
                    return unavailable();
                };
                runtime.turn_boundary();
                let _ = runtime.event_guarded("prompt", prompt, || {
                    !cancelled.load(std::sync::atomic::Ordering::Acquire)
                });
                let mut rewrite: Option<(String, String)> = None;
                for (id, result) in runtime.event_guarded("input", payload, || {
                    !cancelled.load(std::sync::atomic::Ordering::Acquire)
                }) {
                    match result.and_then(|value| ModInputDecision::parse(&value)) {
                        Err(error) => {
                            return UserInputDecision::Deny {
                                notice: format!("Mod {id} input hook failed; the prompt was not sent and the mod is disabled until reload: {error}"),
                            };
                        }
                        Ok(ModInputDecision::Keep) => {}
                        Ok(ModInputDecision::Deny(reason)) => {
                            return UserInputDecision::Deny {
                                notice: format!("Mod {id} denied this prompt: {reason}"),
                            };
                        }
                        Ok(ModInputDecision::Rewrite(text)) => {
                            if rewrite.is_some() {
                                return UserInputDecision::Deny {
                                    notice: "mod_input_rewrite_conflict; the prompt was not sent.".into(),
                                };
                            }
                            rewrite = Some((id, text));
                        }
                    }
                }
                match rewrite {
                    Some((id, text)) => UserInputDecision::Rewrite {
                        notice: format!("Mod {id} rewrote this prompt. The model received:\n{}", preview(&text)),
                        text,
                    },
                    None => UserInputDecision::Keep,
                }
            })
            .await
            .unwrap_or_else(|_| unavailable())
        })
    }
    fn on_compaction_start<'a>(
        &'a self,
        input: CompactionLifecycleInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(self.compaction("compaction_start", input))
    }
    fn on_compaction_end<'a>(
        &'a self,
        input: CompactionLifecycleInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(self.compaction("compaction_end", input))
    }

    fn on_turn_start<'a>(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if !lead_thread(input.thread_store) {
                return;
            }
            self.agents.cleanup().await;
            self.services.cleanup().await;
            let runtime = self.runtime.clone();
            let owner = self.owner.clone();
            let views = self.views.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(mut runtime) = runtime.lock() {
                    runtime.turn_boundary();
                    let diagnostic = policy::refresh_worker_context(&mut runtime, &owner);
                    views.diagnostic(&owner, "coordination_policy", diagnostic);
                }
            })
            .await;
            if let Ok(mut turn) = self.turn.lock() {
                *turn = Some(TurnRecord {
                    turn_id: input.turn_id.to_owned(),
                    error: None,
                });
            }
            self.event_with_lead(
                "turn_start",
                json!({"turn_id":input.turn_id}),
                input.thread_store.get::<Lead>(),
            )
            .await;
        })
    }
}

impl ContextContributor for Mods {
    fn contribute_turn_context<'a>(
        &'a self,
        input: TurnContextContributionInput<'a>,
    ) -> ExtensionFuture<'a, Vec<PromptFragment>> {
        Box::pin(async move {
            if !lead_thread(input.thread_store) {
                return Vec::new();
            }
            self.event(
                "context",
                json!({"thread_id": input.thread_id.to_string(), "turn_id": input.turn_id,
                "checkpoint": self.owner.task.checkpoint().ok().flatten()}),
            )
            .await
        })
    }
}

impl ThreadLifecycleContributor<Config> for Mods {
    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if lead_thread(input.thread_store) {
                self.event(
                    "session",
                    json!({"phase":"start","thread_id":thread_id(input.thread_store)}),
                )
                .await;
            }
        })
    }
    fn on_thread_ready<'a>(
        &'a self,
        input: ThreadReadyInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if lead_thread(input.thread_store) {
                self.event_with_lead("start", Value::Null, input.thread_store.get::<Lead>())
                    .await;
            }
        })
    }
    fn on_thread_resume<'a>(&'a self, input: ThreadResumeInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if lead_thread(input.thread_store) {
                self.event(
                    "session",
                    json!({"phase":"resume","thread_id":thread_id(input.thread_store)}),
                )
                .await;
                self.event_with_lead("resume", Value::Null, input.thread_store.get::<Lead>())
                    .await;
            }
        })
    }
    fn on_thread_idle<'a>(&'a self, input: ThreadIdleInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if lead_thread(input.thread_store) {
                self.event("session", json!({"phase":"idle","thread_id":thread_id(input.thread_store),"cause":format!("{:?}", input.cause)})).await;
                self.event_with_lead(
                    "idle",
                    json!({"cause": format!("{:?}", input.cause)}),
                    input.thread_store.get::<Lead>(),
                )
                .await;
            }
        })
    }
    fn on_thread_stop<'a>(&'a self, input: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if lead_thread(input.thread_store) {
                if let Ok(mut before) = self.workspace_before.lock() {
                    before.clear();
                }
                self.agents.cleanup().await;
                self.services.cleanup().await;
                self.event(
                    "session",
                    json!({"phase":"stop","thread_id":thread_id(input.thread_store)}),
                )
                .await;
                self.event_with_lead("stop", Value::Null, input.thread_store.get::<Lead>())
                    .await;
                self.processes.cleanup();
            }
        })
    }
}

impl ToolLifecycleContributor for Mods {
    fn on_tool_start<'a>(&'a self, input: ToolStartInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            if !lead_thread(input.thread_store)
                || !self
                    .runtime
                    .lock()
                    .is_ok_and(|runtime| runtime.has_event("workspace_write"))
            {
                return;
            }
            let repository = self.owner.manifest.repository.clone();
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

    fn intercept_tool<'a>(
        &'a self,
        input: ToolStartInput<'a>,
    ) -> ExtensionFuture<'a, Result<Option<(ToolName, codex_tools::ToolPayload)>, String>> {
        Box::pin(async move {
            if input.thread_store.get::<Lead>().is_none() {
                return Ok(None);
            }
            let codex_tools::ToolPayload::Function { arguments } = input.payload else {
                return Ok(None);
            };
            let original_tool = input.tool_name.clone();
            let scope_agent_id = agent_id(input.thread_store);
            let arguments: Value = serde_json::from_str(arguments).map_err(|e| e.to_string())?;
            let payload = json!({"tool":input.tool_name.to_string(),"arguments":arguments,"call_id":input.call_id});
            let runtime = self.runtime.clone();
            let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let _cancellation = Cancellation(cancelled.clone());
            let result = tokio::task::spawn_blocking(move || {
                let mut runtime = runtime.lock().map_err(|_| "mod_runtime_poisoned")?;
                let _ = runtime.event_guarded(
                    "tool_call",
                    json!({"tool":original_tool.to_string(),"arguments":payload["arguments"],
                        "call_id":payload["call_id"],"agent_id":scope_agent_id}),
                    || !cancelled.load(std::sync::atomic::Ordering::Acquire),
                );
                let mut replacement = None;
                for (id, result) in runtime.event_guarded("tool_before", payload, || {
                    !cancelled.load(std::sync::atomic::Ordering::Acquire)
                }) {
                    let value =
                        result.map_err(|e| format!("mod_interception_failed: {id}: {e}"))?;
                    if value.is_null() {
                        continue;
                    }
                    let object = value.as_object().ok_or("invalid_interception_result")?;
                    if object.is_empty()
                        || object.len() > 2
                        || object
                            .keys()
                            .any(|key| !["arguments", "tool", "deny"].contains(&key.as_str()))
                    {
                        return Err("invalid_interception_result".into());
                    }
                    if let Some(reason) = value.get("deny").and_then(Value::as_str) {
                        return Err(format!(
                            "mod_tool_denied: {id}: {}",
                            reason.chars().take(512).collect::<String>()
                        ));
                    }
                    let arguments = value
                        .get("arguments")
                        .filter(|v| v.is_object())
                        .ok_or("invalid_interception_result")?;
                    if replacement.is_some() {
                        return Err("mod_tool_replacement_conflict".into());
                    }
                    let target = match value.get("tool") {
                        None => original_tool.clone(),
                        Some(value) => ToolName::plain(
                            value
                                .as_str()
                                .filter(|s| !s.is_empty() && s.len() <= 128)
                                .ok_or("invalid_replacement_tool")?,
                        ),
                    };
                    replacement = Some((
                        target,
                        codex_tools::ToolPayload::Function {
                            arguments: serde_json::to_string(arguments)
                                .map_err(|e| e.to_string())?,
                        },
                    ));
                }
                Ok(replacement)
            })
            .await
            .map_err(|e| e.to_string())?;
            self.cleanup_failed().await;
            result
        })
    }

    fn on_tool_finish<'a>(&'a self, input: ToolFinishInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            if input.thread_store.get::<Lead>().is_some() {
                self.event(
                    "tool_result",
                    json!({"call_id": input.call_id,
                    "agent_id":agent_id(input.thread_store),"tool": input.tool_name.to_string(),
                    "outcome": format!("{:?}", input.outcome)}),
                )
                .await;
                let before = self
                    .workspace_before
                    .lock()
                    .ok()
                    .and_then(|mut snapshots| snapshots.remove(input.call_id));
                if let Some(before) = before {
                    let repository = self.owner.manifest.repository.clone();
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
                        (Err(error), _) | (_, Err(error)) => {
                            ("unavailable", Vec::new(), Some(error))
                        }
                    };
                    let (status, changes, reason) = if status == "observed" && !changes.is_empty() {
                        match input.thread_store.get::<Lead>() {
                            Some(lead) => {
                                match crate::workspace_operations::WorkspaceAuthority::for_lead(
                                    &lead,
                                )
                                .await
                                {
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
                        self.event_with_lead(
                            "workspace_write",
                            json!({
                                "repository":self.owner.manifest.repository,
                                "call_id":input.call_id,
                                "tool":input.tool_name.to_string(),
                                "outcome":format!("{:?}", input.outcome),
                                "changes":changes,
                                "status":status,
                                "reason":reason,
                            }),
                            input.thread_store.get::<Lead>(),
                        )
                        .await;
                    }
                }
            }
        })
    }
}

struct Cancellation(Arc<std::sync::atomic::AtomicBool>);

impl Drop for Cancellation {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Release);
    }
}
