mod agents;
mod evidence;
mod expansion;
mod operations;
pub(crate) mod services;
mod snapshots;
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
use codex_omd::ModGrants;
use codex_omd::ModHost;
use codex_omd::ModHostCall;
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
use std::sync::atomic::Ordering;

pub(crate) use expansion::take_route_selection;
pub(crate) use operations::DataScope;

type Reply = std::sync::mpsc::SyncSender<std::io::Result<Value>>;
type Facts = BTreeMap<String, (String, Option<ModGrants>)>;

struct HostRequest {
    caller: String,
    source: String,
    grants: Option<ModGrants>,
    request: ModHostCall,
    reply: Reply,
}

pub(crate) fn read_only_sandbox_tool(name: &str) -> bool {
    matches!(
        name,
        "shell"
            | "shell_command"
            | "exec_command"
            | "write_stdin"
            | "web"
            | "web_search"
            | "read"
            | "grep_files"
            | "list_dir"
    )
}

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

fn tool_outcome(outcome: codex_extension_api::ToolCallOutcome) -> &'static str {
    use codex_extension_api::ToolCallOutcome;
    match outcome {
        ToolCallOutcome::Completed { success: true } => "succeeded",
        ToolCallOutcome::Completed { success: false } => "unsuccessful",
        ToolCallOutcome::Blocked => "blocked",
        ToolCallOutcome::Failed {
            handler_executed: true,
        } => "failed",
        ToolCallOutcome::Failed {
            handler_executed: false,
        } => "failed_before_handler",
        ToolCallOutcome::Aborted => "aborted",
    }
}

fn thread_id(thread: &ExtensionData) -> Option<String> {
    thread.get::<Lead>().map(|lead| lead.thread.to_string())
}

fn facts(runtime: &ModHost) -> Facts {
    runtime
        .owners()
        .into_iter()
        .map(|(id, owner)| {
            let grants = runtime.grants(&id);
            (id, (owner.sha256, grants))
        })
        .collect()
}

fn forward(
    requests: &tokio::sync::mpsc::Sender<HostRequest>,
    facts: &Facts,
    caller: &str,
    request: ModHostCall,
    active: &dyn Fn() -> bool,
) -> std::io::Result<Value> {
    let (reply, receiver) = std::sync::mpsc::sync_channel(1);
    let (source, grants) = facts.get(caller).cloned().unwrap_or_default();
    requests
        .blocking_send(HostRequest {
            caller: caller.to_owned(),
            source,
            grants,
            request,
            reply,
        })
        .map_err(|_| std::io::Error::other("native_host_stopped"))?;
    loop {
        if !active() {
            return Err(std::io::Error::other("callback_cancelled"));
        }
        match receiver.recv_timeout(std::time::Duration::from_millis(20)) {
            Ok(value) => return value,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => (),
            Err(error) => return Err(std::io::Error::other(error)),
        }
    }
}

struct TurnRecord {
    turn_id: String,
    error: Option<String>,
    evidence: Option<evidence::Cursor>,
}

pub(super) struct Core {
    host: Arc<Host>,
    runtime: Arc<Mutex<ModHost>>,
    input_runtime: Arc<Mutex<ModHost>>,
    agents: agents::Agents,
    services: services::Services,
    views: Arc<view::Views>,
    expansion: expansion::State,
}

struct Mods {
    core: Arc<Core>,
    turns: Mutex<BTreeMap<String, TurnRecord>>,
    sessions: Mutex<BTreeMap<String, std::sync::Weak<Session>>>,
    workspace_before: Mutex<BTreeMap<String, Result<codex_omd::WorkspaceIndex, String>>>,
}

impl std::ops::Deref for Mods {
    type Target = Core;

    fn deref(&self) -> &Core {
        &self.core
    }
}

fn preview(text: &str) -> String {
    let mut shown: String = text.chars().take(1024).collect();
    if shown.len() < text.len() {
        shown.push_str("...");
    }
    shown
}

pub(crate) fn terminal_identity(runtime: &ModHost) -> Value {
    runtime.identity(
        env!("CARGO_PKG_VERSION"),
        std::env::var("OMD_INSTALL_PROFILE").ok().as_deref(),
        "omd",
    )
}

fn event_fragments_scoped(
    runtime: &Mutex<ModHost>,
    event: &str,
    payload: Value,
    private: BTreeMap<String, Value>,
    active: impl Fn() -> bool,
    authority: &str,
    host: impl FnMut(&str, codex_omd::ModHostCall) -> std::io::Result<Value>,
) -> Vec<PromptFragment> {
    let mut fragments = Vec::new();
    let mut remaining_bytes = 6144;
    let assembler = (event == "context")
        .then(|| runtime.lock().ok()?.replacement_owner("context"))
        .flatten();
    let mut replaced: Vec<String> = Vec::new();
    for (id, result) in codex_omd::event_shared(
        runtime,
        event,
        |id| {
            let mut value = payload.clone();
            if let Some(fields) = private.get(id).and_then(Value::as_object)
                && let Some(object) = value.as_object_mut()
            {
                object.extend(fields.clone());
            }
            value
        },
        active,
        host,
    ) {
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
    host: Arc<Host>,
) -> Result<(), String> {
    let validator = |schema: &Value| {
        codex_extension_api::parse_tool_input_schema(schema)
            .map(|_| ())
            .map_err(std::io::Error::other)
    };
    let runtime =
        ModHost::open_validated(host.root.clone(), validator).map_err(|e| e.to_string())?;
    let input_runtime =
        ModHost::open_validated(host.root.clone(), validator).map_err(|e| e.to_string())?;
    let runtime = Arc::new(Mutex::new(runtime));
    host.accounts.install_mod_runtime(runtime.clone());
    let views = Arc::new(view::Views::new());
    let input_runtime = Arc::new(Mutex::new(input_runtime));
    let extension = Arc::new(Mods {
        core: Arc::new_cyclic(|core| Core {
            agents: agents::Agents::new(core.clone(), runtime.clone(), views.clone(), host.clone()),
            host,
            runtime,
            input_runtime,
            services: services::Services::default(),
            views,
            expansion: expansion::State::default(),
        }),
        turns: Mutex::new(BTreeMap::new()),
        sessions: Mutex::new(BTreeMap::new()),
        workspace_before: Mutex::new(BTreeMap::new()),
    });
    registry.config_contributor(extension.clone());
    registry.prompt_contributor(extension.clone());
    registry.thread_lifecycle_contributor(extension.clone());
    registry.tool_lifecycle_contributor(extension.clone());
    registry.turn_lifecycle_contributor(extension.clone());
    registry.tool_output_contributor(extension.clone());
    registry.approval_gate_contributor(extension.clone());
    registry.tool_spec_contributor(extension.clone());
    registry.tool_batch_contributor(extension.clone());
    registry.tool_contributor(extension);
    Ok(())
}

fn publish(
    runtime: &mut ModHost,
    host: &Host,
    views: &view::Views,
    event: &str,
    ledger: Value,
    active: impl Fn() -> bool,
) {
    let input = json!({"event": event, "ledger": ledger, "identity": terminal_identity(runtime),
        "presentation": views.current_presentation()});
    let mut terminal = runtime.terminal_view(input.clone(), active);
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
    views.base(host, terminal, input);
    let _ = host.persist_json("mod-status.json", &status);
    let builtins = codex_omd::BuiltinSnapshot::from_controls(&runtime.builtin_controls());
    if codex_omd::BuiltinSnapshot::read(&host.root) != builtins {
        let _ = host.persist_json(codex_omd::BUILTINS_SNAPSHOT, &builtins);
    }
}

fn refresh_contract(runtime: &ModHost, session: &Session) {
    let documents = runtime.contract_documents();
    if session
        .contract
        .lock()
        .is_ok_and(|mut contract| contract.revalidate(&documents))
    {
        let _ = session.persist_contract();
    }
}

impl Core {
    async fn cleanup_failed(&self, lead: Option<&Lead>) {
        let runtime = self.runtime.clone();
        let session = lead.map(|lead| lead.session.clone());
        let failed = tokio::task::spawn_blocking(move || {
            let Ok(runtime) = runtime.lock() else {
                return Vec::new();
            };
            if let Some(session) = &session {
                refresh_contract(&runtime, session);
            }
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
            expansion::release_owner(self, &id);
            if let Some(lead) = lead {
                lead.session.processes.cleanup_owned(&id, generation);
            }
        }
    }

    async fn event(
        &self,
        event: &'static str,
        payload: Value,
        lead: Option<&Lead>,
    ) -> Vec<PromptFragment> {
        self.event_with_private(event, payload, lead, BTreeMap::new())
            .await
    }

    async fn event_with_private(
        &self,
        event: &'static str,
        payload: Value,
        lead: Option<&Lead>,
        private: BTreeMap<String, Value>,
    ) -> Vec<PromptFragment> {
        let runtime = self.runtime.clone();
        let host = self.host.clone();
        let views = self.views.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let _cancellation = Cancellation(cancelled.clone());
        let (requests, mut receiver) = tokio::sync::mpsc::channel::<HostRequest>(1);
        let current = self.runtime.lock().ok().map(|runtime| {
            let sources = runtime
                .owners()
                .into_iter()
                .map(|(id, owner)| (id, owner.sha256))
                .collect::<BTreeMap<_, _>>();
            (runtime.generation(), sources)
        });
        let generation = current.as_ref().map(|(generation, _)| *generation);
        if let Some((generation, sources)) = &current {
            expansion::retain_sources(self, sources);
            if let Some(lead) = lead {
                lead.session.processes.cleanup_stale(*generation);
            }
        }
        let ledger = lead.map(Lead::ledger).unwrap_or(Value::Null);
        let flag = cancelled.clone();
        let job = tokio::task::spawn_blocking(move || {
            let Some(facts) = runtime.lock().ok().map(|runtime| {
                codex_omd::observe_workspace_changes(
                    &host.repository,
                    runtime.has_event("workspace_change"),
                );
                facts(&runtime)
            }) else {
                return Vec::new();
            };
            let mut fragments = event_fragments_scoped(
                &runtime,
                event,
                payload,
                private,
                || !flag.load(Ordering::Acquire),
                "native permissions",
                |id, request| {
                    if !operations::event_allows(event, &request.operation) {
                        return Err(std::io::Error::other(format!(
                            "host_operation_unavailable: {} is not available during {event}",
                            request.operation
                        )));
                    }
                    forward(&requests, &facts, id, request, &|| {
                        !flag.load(Ordering::Acquire)
                    })
                },
            );
            let Ok(mut runtime) = runtime.lock() else {
                return fragments;
            };
            publish(&mut runtime, &host, &views, event, ledger, || {
                !flag.load(Ordering::Acquire)
            });
            if let Some(error) = runtime.status()["reload_error"].as_str() {
                fragments.push(PromptFragment::developer_capability(
                    format!("Mod reload failed; previous eligible mods retained: {error}"),
                    ContentItemKind("oh_my_diff.mod_error".into()),
                ));
            }
            fragments
        });
        while let Some(call) = receiver.recv().await {
            let value = match (lead, generation) {
                (Some(lead), Some(generation)) => {
                    operations::dispatch(
                        self,
                        lead,
                        operations::Caller {
                            id: &call.caller,
                            source: &call.source,
                            grants: call.grants,
                            generation,
                            origin: codex_omd::data_store::Origin::Event,
                            record_changes: event != "workspace_change",
                        },
                        None,
                        call.request,
                        &cancelled,
                    )
                    .await
                }
                _ => Err("host_operation_unavailable: no session".into()),
            };
            let _ = call.reply.send(value.map_err(std::io::Error::other));
        }
        let fragments = job.await.unwrap_or_default();
        self.cleanup_failed(lead).await;
        if let Some(lead) = lead {
            self.publish_workspace_changes(lead).await;
        }
        fragments
    }

    fn workspace_change<'a>(
        &'a self,
        lead: &'a Lead,
        source: &'a str,
        call_id: Option<&'a str>,
        changes: Result<Vec<codex_omd::WorkspaceChange>, String>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let (status, changes, reason) = match changes {
                Ok(changes)
                    if changes.len() > 128
                        || changes
                            .iter()
                            .map(|change| change.path.len())
                            .sum::<usize>()
                            > 16_000 =>
                {
                    (
                        "unavailable",
                        Vec::new(),
                        Some("workspace_change_batch_limit".to_owned()),
                    )
                }
                Ok(changes) if changes.is_empty() => return,
                Ok(changes) => {
                    match crate::workspace_operations::WorkspaceAuthority::for_lead(lead)
                        .await
                        .and_then(|authority| authority.visible_changes(changes))
                    {
                        Ok(changes) if changes.is_empty() => return,
                        Ok(changes) => ("observed", changes, None),
                        Err(_) => (
                            "unavailable",
                            Vec::new(),
                            Some("workspace_change_scope_unavailable".to_owned()),
                        ),
                    }
                }
                Err(error) => ("unavailable", Vec::new(), Some(error)),
            };
            if let Ok(Value::Array(recorded)) = serde_json::to_value(&changes) {
                expansion::files(self, lead, &recorded, source);
            }
            self.event(
                "workspace_change",
                json!({"repository":self.host.repository,"source":source,"call_id":call_id,
                    "changes":changes,"status":status,"reason":reason}),
                (lead.owner == "lead").then_some(lead),
            )
            .await;
        })
    }

    fn publish_workspace_changes<'a>(&'a self, lead: &'a Lead) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if lead.owner != "lead" {
                return;
            }
            for recorded in codex_omd::take_workspace_changes(&self.host.repository) {
                self.workspace_change(lead, recorded.source, None, recorded.changes)
                    .await;
            }
        })
    }
}

impl Mods {
    fn take_turn(&self, thread: &ThreadId) -> Option<TurnRecord> {
        self.turns
            .lock()
            .ok()
            .and_then(|mut turns| turns.remove(&thread.to_string()))
    }

    async fn compaction(&self, event: &'static str, input: CompactionLifecycleInput<'_>) {
        if !lead_thread(input.thread_store) {
            return;
        }
        let lead = input.thread_store.get::<Lead>();
        if let Some(lead) = &lead
            && let Err(error) =
                evidence::compact(lead, &self.turns, event == "compaction_start").await
        {
            self.views
                .diagnostic(&self.host, "turn_evidence", Some(error));
        }
        self.event(
            event,
            json!({"turn_id":input.turn_id,"trigger":input.trigger}),
            lead.as_deref(),
        )
        .await;
    }

    fn compaction_decision(
        &self,
        runtime: &mut ModHost,
        config: &mut Config,
    ) -> Result<(), String> {
        let compaction = runtime.event(
            "compaction",
            json!({"token_limit":config.model_auto_compact_token_limit,"context_window":config.model_context_window}),
        );
        let mut selected: Option<(String, Option<String>)> = None;
        for (id, result) in compaction {
            let value = result.map_err(|e| format!("mod_compaction_failed: {id}: {e}"))?;
            if value.is_null() {
                continue;
            }
            if selected.is_some() {
                return Err("mod_compaction_conflict".into());
            }
            let (limit, prompt) = match &value {
                Value::Number(_) => (
                    Some(value.as_i64().ok_or("invalid_compaction_limit")?),
                    None,
                ),
                Value::Object(object)
                    if !object.is_empty()
                        && object
                            .keys()
                            .all(|key| key == "threshold" || key == "prompt") =>
                {
                    let limit = object
                        .get("threshold")
                        .map(|limit| limit.as_i64().ok_or("invalid_compaction_limit"))
                        .transpose()?;
                    let prompt = object
                        .get("prompt")
                        .map(|prompt| {
                            prompt
                                .as_str()
                                .filter(|prompt| {
                                    !prompt.trim().is_empty()
                                        && prompt.len() <= 16_384
                                        && !prompt
                                            .chars()
                                            .any(|c| c.is_control() && c != '\n' && c != '\t')
                                })
                                .map(str::to_owned)
                                .ok_or("invalid_compaction_prompt")
                        })
                        .transpose()?;
                    (limit, prompt)
                }
                _ => return Err("invalid_compaction_decision".into()),
            };
            if let Some(limit) = limit {
                let ceiling = config
                    .model_auto_compact_token_limit
                    .or(config.model_context_window)
                    .unwrap_or(1_000_000);
                if !(256..=ceiling).contains(&limit) {
                    return Err("compaction_limit_outside_host_bounds".into());
                }
                config.model_auto_compact_token_limit = Some(limit);
            }
            selected = Some((id, prompt));
        }
        let key = "compaction_prompt";
        match selected {
            Some((id, Some(prompt))) => {
                let remote = codex_model_provider::create_model_provider(
                    config.model_provider.clone(),
                    None,
                )
                .capabilities()
                .remote_compaction;
                if remote == codex_model_provider::RemoteCompactionSupport::Unsupported {
                    config.compact_prompt = Some(prompt);
                    self.views.diagnostic(&self.host, key, None);
                } else {
                    self.views.diagnostic(
                        &self.host,
                        key,
                        Some(format!(
                            "{id}: compaction_prompt_unsupported_for_remote_compaction on provider {}; native remote compaction unchanged",
                            config.model_provider_id
                        )),
                    );
                }
            }
            _ => self.views.diagnostic(&self.host, key, None),
        }
        Ok(())
    }

    fn routing_decision(&self, runtime: &mut ModHost, config: &mut Config) -> Result<(), String> {
        let routes = self
            .host
            .config
            .routes
            .iter()
            .filter(|route| route.roles.contains(&config::RouteRole::Lead))
            .map(|route| operations::route_info(&self.host, route))
            .collect::<Vec<_>>();
        if routes.is_empty() {
            return Ok(());
        }
        let values = runtime.event(
            "routing",
            json!({"routes":routes,"model":config.model,"provider":config.model_provider_id,
                "reasoning":config.model_reasoning_effort}),
        );
        let mut selected: Option<String> = None;
        let mut diagnostic = None;
        for (id, result) in values {
            let value = match result {
                Ok(value) if value.is_null() => continue,
                Ok(value) => value,
                Err(error) => {
                    diagnostic = Some(format!(
                        "mod_routing_failed: {id}: {error}; configured model retained"
                    ));
                    continue;
                }
            };
            if selected.is_some() {
                diagnostic = Some("mod_routing_conflict; configured model retained".into());
                selected = None;
                break;
            }
            match value.get("route").and_then(Value::as_str) {
                Some(name)
                    if value.as_object().is_some_and(|object| object.len() == 1)
                        && self
                            .host
                            .config
                            .route(name, config::RouteRole::Lead, Some(&id))
                            .is_some() =>
                {
                    selected = Some(name.to_owned());
                }
                _ => {
                    diagnostic = Some(format!(
                        "mod_route_not_configured: {id}; configured model retained"
                    ))
                }
            }
        }
        if let Some(route) =
            selected.and_then(|name| self.host.config.route(&name, config::RouteRole::Lead, None))
        {
            config.model = Some(route.model.clone());
            config.model_provider_id = route.provider.clone();
            config.model_provider = config
                .model_providers
                .get(&route.provider)
                .cloned()
                .ok_or("configured_provider_missing")?;
            config.model_reasoning_effort = Some(route.reasoning_effort.clone());
        }
        self.views.diagnostic(&self.host, "routing", diagnostic);
        Ok(())
    }
}

impl codex_extension_api::ConfigContributor<Config> for Mods {
    fn prepare_thread_config(&self, config: &mut Config) -> Result<(), String> {
        let profile = config.permissions.effective_permission_profile();
        if matches!(profile, PermissionProfile::External { .. }) {
            return Err("mods_require_native_sandbox_for_host_owned_files".into());
        }
        let mut denies = Vec::new();
        for path in self.host.protected_paths() {
            if path
                .canonicalize()
                .map_err(|_| "protected_path_unavailable")?
                != path
                || path.starts_with(&self.host.repository)
            {
                return Err("protected_mod_path_must_be_canonical_and_external".into());
            }
            let path =
                AbsolutePathBuf::from_absolute_path_checked(&path).map_err(|e| e.to_string())?;
            denies.push(FileSystemSandboxEntry::new(
                FileSystemPath::Path { path: path.into() },
                FileSystemAccessMode::Deny,
            ));
        }
        config.model_provider.supports_websockets = false;
        let mut filesystem = profile.file_system_sandbox_policy();
        filesystem
            .preserve_deny_read_restrictions_from(&FileSystemSandboxPolicy::restricted(denies));
        let protected = PermissionProfile::from_runtime_permissions(
            &filesystem,
            profile.network_sandbox_policy(),
        );
        config
            .permissions
            .shell_environment_policy
            .r#set
            .insert("OMD_NARROW_SANDBOX".into(), "1".into());
        config
            .permissions
            .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::legacy(
                protected,
            ))
            .map_err(|e| e.to_string())?;
        let mut runtime = match self.runtime.try_lock() {
            Ok(runtime) => runtime,
            Err(std::sync::TryLockError::Poisoned(_)) => return Err("mod_runtime_poisoned".into()),
            Err(std::sync::TryLockError::WouldBlock) => return Ok(()),
        };
        self.compaction_decision(&mut runtime, config)?;
        self.routing_decision(&mut runtime, config)
    }
}

impl TurnLifecycleContributor for Mods {
    fn on_turn_abort<'a>(
        &'a self,
        input: codex_extension_api::TurnAbortInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let Some(lead) = input
                .thread_store
                .get::<Lead>()
                .filter(|lead| lead.owner == "lead")
            else {
                return;
            };
            lead.session.processes.cleanup();
            if let Some(turn) = self.take_turn(&lead.thread) {
                expansion::turn_ended(
                    &self.core,
                    &lead,
                    "aborted",
                    Some(format!("{:?}", input.reason)),
                );
                self.event(
                    "turn_end",
                    json!({"turn_id":turn.turn_id,"outcome":"aborted","reason":format!("{:?}", input.reason)}),
                    Some(&*lead),
                )
                .await;
            }
        })
    }

    fn on_turn_error<'a>(
        &'a self,
        input: codex_extension_api::TurnErrorInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(thread) = thread_id(input.thread_store)
                && lead_thread(input.thread_store)
                && let Ok(mut turns) = self.turns.lock()
                && let Some(turn) = turns.get_mut(&thread)
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
            let Some(lead) = input
                .thread_store
                .get::<Lead>()
                .filter(|lead| lead.owner == "lead")
            else {
                return;
            };
            let Some(turn) = self.take_turn(&lead.thread) else {
                return;
            };
            let payload = match turn.error {
                Some(error) => json!({"turn_id":turn.turn_id,"outcome":"error","error":error}),
                None => json!({"turn_id":turn.turn_id,"outcome":"completed"}),
            };
            expansion::turn_ended(
                &self.core,
                &lead,
                payload["outcome"].as_str().unwrap_or("error"),
                payload["error"].as_str().map(str::to_owned),
            );
            let private = match &turn.evidence {
                Some(cursor) => match evidence::finish(
                    &self.core,
                    &lead,
                    cursor,
                    &turn.turn_id,
                    payload["outcome"].as_str().unwrap_or("error"),
                )
                .await
                {
                    Ok(value) => value,
                    Err(error) => {
                        self.views
                            .diagnostic(&self.host, "turn_evidence", Some(error));
                        BTreeMap::new()
                    }
                },
                None => BTreeMap::new(),
            };
            self.event_with_private("turn_end", payload, Some(&*lead), private)
                .await;
        })
    }

    fn disabled_collaboration_modes(&self) -> Vec<String> {
        match self.runtime.try_lock() {
            Ok(runtime) => runtime
                .builtin_controls()
                .into_iter()
                .flat_map(|(_, controls)| controls.modes.disable)
                .collect(),
            Err(_) => codex_omd::BuiltinSnapshot::read(&self.host.root)
                .disabled_modes
                .into_values()
                .flatten()
                .collect(),
        }
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
            let cancelled = Arc::new(AtomicBool::new(false));
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
                    !cancelled.load(Ordering::Acquire)
                });
                let mut rewrite: Option<(String, String)> = None;
                for (id, result) in runtime.event_guarded("input", payload, || {
                    !cancelled.load(Ordering::Acquire)
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
            let Some(lead) = input
                .thread_store
                .get::<Lead>()
                .filter(|lead| lead.owner == "lead")
            else {
                return;
            };
            self.views
                .presentation(&lead.thread.to_string(), Some("started"));
            let runtime = self.runtime.clone();
            let session = lead.session.clone();
            let session_repository = self.host.repository.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(mut runtime) = runtime.lock() {
                    runtime.turn_boundary();
                    refresh_contract(&runtime, &session);
                    codex_omd::observe_workspace_changes(
                        &session_repository,
                        runtime.has_event("workspace_change"),
                    );
                }
            })
            .await;
            self.publish_workspace_changes(&lead).await;
            let evidence = evidence::begin(&self.core, &lead).await;
            if let Ok(mut turns) = self.turns.lock() {
                turns.insert(
                    lead.thread.to_string(),
                    TurnRecord {
                        turn_id: input.turn_id.to_owned(),
                        error: None,
                        evidence,
                    },
                );
            }
            expansion::turn_started(&self.core, &lead, input.turn_id).await;
            self.event("turn_start", json!({"turn_id":input.turn_id}), Some(&*lead))
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
            let Some(lead) = input
                .thread_store
                .get::<Lead>()
                .filter(|lead| lead.owner == "lead")
            else {
                return Vec::new();
            };
            if let Some(profile) = input.permission_profile {
                let Ok(mut current) = lead.permission_profile.lock() else {
                    return Vec::new();
                };
                *current = profile.clone();
            }
            self.event(
                "context",
                json!({"thread_id": input.thread_id.to_string(), "turn_id": input.turn_id,
                    "ledger": lead.ledger()}),
                Some(&*lead),
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
            let Ok(thread) = ThreadId::from_string(input.thread_store.level_id()) else {
                return;
            };
            if input.config.cwd.as_path() != self.host.repository {
                self.views.diagnostic(
                    &self.host,
                    "session",
                    Some(format!(
                        "Mods are inactive for thread {thread}: its working directory is not the launch repository"
                    )),
                );
                return;
            }
            if self
                .host
                .accounts
                .0
                .lock()
                .map_or(true, |accounts| accounts.contains_key(&thread.to_string()))
            {
                return;
            }
            let parent = match input.session_source {
                SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
                    parent_thread_id, ..
                }) => Some(*parent_thread_id),
                _ => None,
            };
            let parent_session = parent.and_then(|parent| {
                self.sessions
                    .lock()
                    .ok()?
                    .get(&parent.to_string())
                    .and_then(std::sync::Weak::upgrade)
            });
            let Some((owner, depth)) = thread_owner(&input, thread, parent_session.is_some())
            else {
                return;
            };
            let session = match parent_session {
                Some(session) => session,
                None => match self.host.open_session(
                    thread,
                    input
                        .thread_store
                        .get::<codex_extension_api::ResumedThread>()
                        .is_some(),
                ) {
                    Ok(session) => session,
                    Err(error) => {
                        self.views.diagnostic(
                            &self.host,
                            "session",
                            Some(format!("OMD session unavailable: {error}")),
                        );
                        return;
                    }
                },
            };
            let route = (owner == "lead")
                .then(|| self.host.lead_route(input.config))
                .flatten();
            if let Err(error) =
                self.host
                    .enroll(thread, &session, &owner, route, Some(input.config))
            {
                self.views.diagnostic(
                    &self.host,
                    "session",
                    Some(format!("OMD ledger enrollment failed: {error}")),
                );
                return;
            }
            if owner == "lead" {
                let runtime = self.runtime.clone();
                let documents = tokio::task::spawn_blocking(move || {
                    runtime
                        .lock()
                        .map(|runtime| runtime.contract_documents())
                        .unwrap_or_default()
                })
                .await
                .unwrap_or_default();
                let mut resolved = contract::SessionContract::resolve(&self.host, &documents);
                if let Err(error) = resolved.restore(&session.contract_state) {
                    resolved.invalidate(error);
                }
                if let Ok(mut current) = session.contract.lock() {
                    *current = resolved;
                }
                let _ = session.persist_contract();
            }
            if let Ok(mut sessions) = self.sessions.lock() {
                sessions.retain(|_, session| session.strong_count() > 0);
                sessions.insert(thread.to_string(), Arc::downgrade(&session));
            }
            input.thread_store.insert(Lead {
                permission_profile: Arc::new(std::sync::Mutex::new(
                    input.config.permissions.effective_permission_profile(),
                )),
                host: self.host.clone(),
                session,
                thread,
                owner: owner.clone(),
                depth,
            });
            if owner == "lead" {
                if let Some(lead) = input.thread_store.get::<Lead>() {
                    self.views.start_thread(input.thread_store);
                    let forked = input
                        .thread_store
                        .get::<codex_extension_api::ForkedFromThread>()
                        .map(|forked| forked.0);
                    expansion::lead_started(&self.core, &lead, forked);
                }
                self.event(
                    "session",
                    json!({"phase":"start","thread_id":thread.to_string()}),
                    None,
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
            if let Some(lead) = input
                .thread_store
                .get::<Lead>()
                .filter(|lead| lead.owner == "lead")
            {
                self.event("start", Value::Null, Some(&*lead)).await;
            }
        })
    }

    fn on_thread_resume<'a>(&'a self, input: ThreadResumeInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(lead) = input
                .thread_store
                .get::<Lead>()
                .filter(|lead| lead.owner == "lead")
            {
                self.views
                    .presentation(&lead.thread.to_string(), Some("resumed"));
                self.event(
                    "session",
                    json!({"phase":"resume","thread_id":lead.thread.to_string()}),
                    None,
                )
                .await;
                let payload = expansion::resume_payload(&self.core, &lead).await;
                self.event("resume", payload, Some(&*lead)).await;
            }
        })
    }

    fn on_thread_idle<'a>(&'a self, input: ThreadIdleInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(lead) = input
                .thread_store
                .get::<Lead>()
                .filter(|lead| lead.owner == "lead")
            {
                self.event(
                    "session",
                    json!({"phase":"idle","thread_id":lead.thread.to_string(),"cause":format!("{:?}", input.cause)}),
                    None,
                )
                .await;
                self.event(
                    "idle",
                    json!({"cause": format!("{:?}", input.cause)}),
                    Some(&*lead),
                )
                .await;
            }
        })
    }

    fn on_thread_stop<'a>(&'a self, input: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let Some(lead) = input.thread_store.get::<Lead>() else {
                return;
            };
            if let Ok(mut accounts) = self.host.accounts.0.lock() {
                accounts.remove(&lead.thread.to_string());
            }
            if lead.owner != "lead" {
                return;
            }
            self.agents.cleanup_session(&lead.session).await;
            self.agents.cleanup_snapshots(lead.thread);
            self.services.cleanup_session(&lead.session).await;
            self.event(
                "session",
                json!({"phase":"stop","thread_id":lead.thread.to_string()}),
                None,
            )
            .await;
            self.event("stop", Value::Null, Some(&*lead)).await;
            lead.session.processes.cleanup();
            let _ = lead.session.persist_cost_capture();
        })
    }
}

impl ToolLifecycleContributor for Mods {
    fn on_tool_start<'a>(&'a self, input: ToolStartInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            let Some(lead) = input.thread_store.get::<Lead>() else {
                return;
            };
            let arguments = match input.payload {
                codex_tools::ToolPayload::Function { arguments } => Some(arguments.as_str()),
                _ => None,
            };
            expansion::tool_started(
                &self.core,
                &lead,
                input.call_id,
                &input.tool_name.to_string(),
                arguments,
            );
            let runtime = self.runtime.clone();
            let repository = self.host.repository.clone();
            let snapshot = tokio::task::spawn_blocking(move || {
                let observed = runtime
                    .lock()
                    .is_ok_and(|runtime| runtime.has_event("workspace_change"));
                codex_omd::observe_workspace_changes(&repository, observed);
                codex_omd::change_baseline(&repository)
            })
            .await
            .ok()
            .flatten()
            .map(|snapshot| snapshot.map_err(|error| error.to_string()));
            let Some(snapshot) = snapshot else {
                return;
            };
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
            let raw_arguments = arguments.chars().take(65_536).collect::<String>();
            let arguments: Value = serde_json::from_str(arguments).map_err(|e| e.to_string())?;
            let mut payload = expansion::tool_before_payload(
                input.turn_store,
                input.call_id,
                input.tool_name,
                &arguments,
                &raw_arguments,
            );
            payload["thread_id"] = json!(
                input
                    .thread_store
                    .get::<Lead>()
                    .map(|lead| lead.thread.to_string())
            );
            let runtime = self.runtime.clone();
            let cancelled = Arc::new(AtomicBool::new(false));
            let _cancellation = Cancellation(cancelled.clone());
            let result = tokio::task::spawn_blocking(move || {
                let mut runtime = runtime.lock().map_err(|_| "mod_runtime_poisoned")?;
                let _ = runtime.event_guarded(
                    "tool_call",
                    json!({"tool":original_tool.to_string(),"arguments":payload["arguments"],
                        "call_id":payload["call_id"],"agent_id":scope_agent_id}),
                    || !cancelled.load(Ordering::Acquire),
                );
                let mut replacement = None;
                for (id, result) in runtime.event_guarded("tool_before", payload, || {
                    !cancelled.load(Ordering::Acquire)
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
            self.cleanup_failed(input.thread_store.get::<Lead>().as_deref())
                .await;
            result
        })
    }

    fn on_command_end<'a>(
        &'a self,
        input: codex_extension_api::CommandEndInput<'a>,
    ) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            if let Some(lead) = input.thread_store.get::<Lead>() {
                expansion::command_ended(&self.core, &lead, input.call_id, input.exit_code);
            }
        })
    }

    fn on_tool_finish<'a>(&'a self, input: ToolFinishInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            let Some(lead) = input.thread_store.get::<Lead>() else {
                return;
            };
            if lead.owner == "lead"
                && let Ok(mut turns) = self.turns.lock()
                && let Some(cursor) = turns
                    .get_mut(&lead.thread.to_string())
                    .and_then(|turn| turn.evidence.as_mut())
                && cursor.tools.len() < 128
            {
                cursor.tools.push(json!({"call_id":input.call_id.chars().take(128).collect::<String>(),"tool":input.tool_name.to_string().chars().take(128).collect::<String>(),"outcome":tool_outcome(input.outcome)}));
            }
            expansion::tool_finished(
                &self.core,
                &lead,
                input.call_id,
                &input.tool_name.to_string(),
                tool_outcome(input.outcome),
            );
            let event_lead = (lead.owner == "lead").then_some(&*lead);
            self.event(
                "tool_result",
                json!({"call_id": input.call_id, "agent_id":agent_id(input.thread_store),
                    "thread_id": lead.thread.to_string(), "tool": input.tool_name.to_string(),
                    "outcome": tool_outcome(input.outcome),
                    "call_sha256": input.call_sha256, "result_sha256": input.result_sha256,
                    "result_complete": input.result_sha256.is_some()}),
                event_lead,
            )
            .await;
            let before = self
                .workspace_before
                .lock()
                .ok()
                .and_then(|mut snapshots| snapshots.remove(input.call_id));
            if let Some(before) = before {
                let repository = self.host.repository.clone();
                let changes = tokio::task::spawn_blocking(move || {
                    let after = codex_omd::WorkspaceIndex::capture(
                        &repository,
                        codex_omd::INDEX_FILES,
                        codex_omd::INDEX_BYTES,
                    )
                    .map_err(|error| error.to_string());
                    before.and_then(|before| after.map(|after| before.changed(&after)))
                })
                .await
                .unwrap_or_else(|error| Err(error.to_string()));
                self.workspace_change(&lead, "tool", Some(input.call_id), changes)
                    .await;
            }
            self.publish_workspace_changes(&lead).await;
        })
    }
}

struct Cancellation(Arc<AtomicBool>);

impl Drop for Cancellation {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
