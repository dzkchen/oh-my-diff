pub(crate) mod access;
mod agents;
mod autonomy;
#[path = "clients.rs"]
pub mod clients;
mod compaction;
mod elicitation;
mod evidence;
mod expansion;
pub(crate) mod intercept;
mod inventory;
mod launch_snapshot;
mod mentions;
mod operations;
mod peering;
mod persisted;
mod roles;
pub(crate) mod services;
mod snapshots;
mod tools;
mod view;

/// Serializes tests that install or observe the process-global host dispatcher and client surface.
#[cfg(test)]
static DISPATCHER_TEST: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

pub(crate) use access::AccessState;
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
    matches!(name, "exec_command" | "write_stdin" | "web_search")
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
    error: Option<Value>,
    evidence: Option<evidence::Cursor>,
}

pub(super) struct Core {
    session_runtime: Option<tokio::runtime::Handle>,
    host: Arc<Host>,
    runtime: Arc<Mutex<ModHost>>,
    input_runtime: Arc<Mutex<ModHost>>,
    persist_runtime: Arc<Mutex<ModHost>>,
    persist_required: Arc<Mutex<Vec<&'static str>>>,
    environment: Arc<codex_omd::host::Environment>,
    codex_config: Arc<Mutex<std::collections::BTreeSet<String>>>,
    agents: agents::Agents,
    services: services::Services,
    views: Arc<view::Views>,
    expansion: expansion::State,
    inventory: inventory::Inventory,
    autonomy: autonomy::Queues,
    peering: peering::Registry,
    this: std::sync::Weak<Core>,
}

struct Mods {
    registration: Mutex<Option<clients::Registration>>,
    core: Arc<Core>,
    turns: Mutex<BTreeMap<String, TurnRecord>>,
    sessions: Mutex<BTreeMap<String, std::sync::Weak<Session>>>,
    workspace_before: Mutex<BTreeMap<String, Result<codex_omd::WorkspaceIndex, String>>>,
    worktrees: Mutex<BTreeMap<std::path::PathBuf, Arc<Host>>>,
    pending: Mutex<BTreeMap<String, PendingTool>>,
    answered: Mutex<BTreeMap<String, String>>,
    child_errors: Mutex<BTreeMap<String, Value>>,
    /// Tool and outcome of each lead call until its batch settles or its thread's next turn starts.
    settled: Mutex<BTreeMap<(String, String), (String, String)>>,
    /// Secret fields of each pending elicitation, redacted from its result.
    elicitations: Mutex<std::collections::VecDeque<(String, Vec<String>)>>,
    provider_switches: Mutex<BTreeMap<String, Config>>,
}

struct PendingTool {
    thread: String,
    result: std::sync::mpsc::Sender<Result<Value, String>>,
    chain: tokio::task::JoinHandle<Result<codex_omd::ModChain, String>>,
    values: bool,
    _cancellation: Cancellation,
}

impl Mods {
    async fn resume(
        &self,
        call_id: &str,
        result: Result<Value, String>,
    ) -> Option<Result<codex_omd::ModChain, String>> {
        let PendingTool {
            result: sender,
            chain,
            _cancellation,
            ..
        } = self.pending.lock().ok()?.remove(call_id)?;
        let _ = sender.send(result);
        Some(
            chain
                .await
                .map_err(|e| e.to_string())
                .and_then(|chain| chain),
        )
    }

    fn release_pending(&self, thread: Option<String>) {
        let Some(thread) = thread else {
            return;
        };
        self.host.accounts.forget_retry(&thread);
        if let Ok(mut pending) = self.pending.lock() {
            pending.retain(|_, entry| entry.thread != thread);
        }
    }

    /// Records a sub-agent the engine or a model started; mod workers are recorded at spawn.
    fn native_agent_started(
        &self,
        thread: ThreadId,
        source: &SessionSource,
        thread_store: &codex_extension_api::ExtensionData,
    ) {
        let SessionSource::SubAgent(kind) = source else {
            return;
        };
        if let SubAgentSource::ThreadSpawn { agent_role, .. } = kind
            && let Some(tools) =
                self.role_tools(&self.host, agent_role.as_deref().unwrap_or("default"))
        {
            thread_store.insert(roles::AgentTools(tools));
        }
        if self.inventory.contains(&thread.to_string()) {
            return;
        }
        let fields = match kind {
            SubAgentSource::ThreadSpawn {
                parent_thread_id,
                agent_role,
                agent_nickname,
                ..
            } => {
                let role = agent_role.clone().unwrap_or_else(|| "default".into());
                let definition = self.role_definition(&self.host, &role);
                json!({"agent_id": format!("agent:{thread}"), "origin": "model",
                    "parent": {"thread_id": parent_thread_id.to_string(), "agent_id": null},
                    "role": agent_nickname.clone().unwrap_or(role),
                    "definition": definition.map(|definition| json!({"name": format!("{}/{}", definition.owner, definition.agent.name),
                        "owner": definition.owner, "source_sha256": definition.source_sha256}))})
            }
            other => json!({"agent_id": format!("agent:{thread}"), "origin": "native",
                "role": format!("{other:?}").chars().take(64).collect::<String>()}),
        };
        let record = self.inventory.start(&thread.to_string(), fields);
        inventory::notify(&self.runtime, &self.inventory, "start", record);
    }

    fn agent_turn(
        &self,
        thread_store: &codex_extension_api::ExtensionData,
        turn_store: &codex_extension_api::ExtensionData,
        outcome: &str,
        error: Value,
    ) {
        if let Some(record) = self.inventory.turn(
            thread_store.level_id(),
            turn_store.level_id(),
            outcome,
            error,
        ) {
            inventory::notify(&self.runtime, &self.inventory, "turn", record);
        }
    }

    fn host_for(&self, cwd: &std::path::Path) -> Option<Arc<Host>> {
        if cwd == self.host.repository {
            return Some(self.host.clone());
        }
        let cwd = cwd.canonicalize().ok()?;
        let mut worktrees = self.worktrees.lock().ok()?;
        if let Some(host) = worktrees.get(&cwd) {
            return Some(host.clone());
        }
        codex_omd::app_routes::session_roots(&self.host.repository)
            .contains(&cwd)
            .then(|| {
                let host = Arc::new(self.host.for_worktree(cwd.clone()));
                worktrees.insert(cwd, host.clone());
                host
            })
    }
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
    initialize(registry, host).map(|_| ())
}

pub fn validate_tool_schema(schema: &Value) -> std::io::Result<()> {
    codex_extension_api::parse_tool_input_schema(schema)
        .map(|_| ())
        .map_err(std::io::Error::other)
}

fn initialize(
    registry: &mut ExtensionRegistryBuilder<Config>,
    host: Arc<Host>,
) -> Result<Arc<Mods>, String> {
    let registration =
        codex_omd::host::reserve_session_dispatcher().map_err(|error| error.to_string())?;
    let runtime = ModHost::open_in(host.root.clone(), validate_tool_schema, &host.repository)
        .map_err(|e| e.to_string())?;
    let input_runtime = ModHost::open_in(host.root.clone(), validate_tool_schema, &host.repository)
        .map_err(|e| e.to_string())?;
    let persist_runtime =
        ModHost::open_in(host.root.clone(), validate_tool_schema, &host.repository)
            .map_err(|e| e.to_string())?;
    let persist_required = persist_runtime.required_surfaces();
    services::define_providers(&host.config, |id| runtime.grants(id).is_some());
    let _ = host.persist_json("mod-status.json", &runtime.status());
    let required = runtime.required_surfaces();
    let environment = runtime.environment();
    let codex_config = runtime.codex_config();
    let runtime = Arc::new(Mutex::new(runtime));
    let views = Arc::new(view::Views::new());
    let input_runtime = Arc::new(Mutex::new(input_runtime));
    let persist_runtime = Arc::new(Mutex::new(persist_runtime));
    let extension = Arc::new(Mods {
        registration: Mutex::new(None),
        core: Arc::new_cyclic(|core| Core {
            session_runtime: tokio::runtime::Handle::try_current().ok(),
            agents: agents::Agents::new(core.clone(), runtime.clone(), views.clone(), host.clone()),
            host,
            runtime,
            input_runtime,
            persist_runtime,
            persist_required,
            environment,
            codex_config,
            services: services::Services::default(),
            views,
            expansion: expansion::State::default(),
            inventory: inventory::Inventory::default(),
            autonomy: autonomy::Queues::default(),
            peering: peering::Registry::default(),
            this: core.clone(),
        }),
        turns: Mutex::new(BTreeMap::new()),
        sessions: Mutex::new(BTreeMap::new()),
        workspace_before: Mutex::new(BTreeMap::new()),
        worktrees: Mutex::new(BTreeMap::new()),
        pending: Mutex::new(BTreeMap::new()),
        answered: Mutex::new(BTreeMap::new()),
        child_errors: Mutex::new(BTreeMap::new()),
        settled: Mutex::new(BTreeMap::new()),
        elicitations: Mutex::default(),
        provider_switches: Mutex::default(),
    });
    let dispatcher = intercept::dispatcher(&extension.core);
    registration
        .install(dispatcher.clone())
        .map_err(|error| error.to_string())?;
    *extension
        .registration
        .lock()
        .map_err(|_| "host_installation_poisoned")? =
        Some(clients::install(&extension.core, registration)?);
    extension
        .core
        .host
        .accounts
        .install_mod_runtime(extension.core.runtime.clone(), required);
    extension
        .core
        .host
        .accounts
        .install_mod_dispatcher(dispatcher);
    intercept::install_notifier(&extension.core);
    registry.config_contributor(extension.clone());
    registry.prompt_contributor(extension.clone());
    registry.thread_lifecycle_contributor(extension.clone());
    registry.tool_lifecycle_contributor(extension.clone());
    registry.turn_lifecycle_contributor(extension.clone());
    registry.turn_input_contributor(extension.clone());
    registry.tool_output_contributor(extension.clone());
    registry.approval_gate_contributor(extension.clone());
    registry.tool_spec_contributor(extension.clone());
    registry.agent_role_contributor(extension.clone());
    registry.token_usage_contributor(extension.clone());
    registry.tool_batch_contributor(extension.clone());
    registry.tool_contributor(extension.clone());
    Ok(extension)
}

fn publish(
    runtime: &mut ModHost,
    host: &Host,
    views: &view::Views,
    event: &str,
    ledger: Value,
    active: impl Fn() -> bool,
) {
    let mut input = json!({"event": event, "ledger": ledger, "identity": terminal_identity(runtime),
        "presentation": codex_omd::client_surface::presented(views.current_presentation()),
        "client": codex_omd::client_surface::client(),
        "clients": codex_omd::client_surface::clients()});
    let pty_scope = json!({"epoch": codex_omd::client_surface::epoch(), "admission": codex_omd::client_surface::admission(), "configuration": runtime.configuration_sha256()});
    let rendered_ms = codex_omd::peers::now_ms();
    let mut terminal = runtime.terminal_view(input.clone(), active);
    input["pty_scope"] = pty_scope;
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
        terminal
            .view
            .title
            .get_or_insert_with(|| "Mod recovery".into());
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
    views.base(host, terminal, input, rendered_ms);
    let _ = host.persist_json("mod-status.json", &status);
    let builtins = codex_omd::BuiltinSnapshot::from_controls(&runtime.builtin_controls());
    codex_features::set_removed(builtins.removed_features());
    let name = codex_omd::builtins_snapshot(&host.repository);
    // A missing snapshot reads as no controls, so a repository without any keeps no file.
    if builtins == codex_omd::BuiltinSnapshot::from_controls(&[]) {
        let _ = std::fs::remove_file(host.root.join(name));
    } else if codex_omd::BuiltinSnapshot::read(&host.root, &host.repository) != builtins {
        let _ = host.persist_json(&name, &builtins);
    }
}

// `turns.activity` readers see changed files from the turn-activity ledger.
fn observes_workspace(runtime: &ModHost) -> bool {
    runtime.has_event("workspace_change") || runtime.uses_operation("turns.activity")
}

fn refresh_turn(host: &Host, session: &Session, runtime: &Mutex<ModHost>) {
    let _ = host.refresh_session(session);
    if let Ok(mut runtime) = runtime.lock() {
        runtime.turn_boundary();
        refresh_contract(&runtime, session);
        codex_omd::observe_workspace_changes(&host.repository, observes_workspace(&runtime));
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
                lead.session.power.release_owner(&id);
                access::release_servers(lead, generation, Some(&id)).await;
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
                lead.session.power.retain(sources);
                self.services.cleanup_stale(*generation, sources).await;
                access::release_servers(lead, *generation, None).await;
            }
        }
        let ledger = lead.map(Lead::ledger).unwrap_or(Value::Null);
        let thread = lead.map(|lead| lead.thread.to_string());
        let flag = cancelled.clone();
        let job = tokio::task::spawn_blocking(move || {
            let _thread = codex_omd::StateThread::enter(thread);
            let Some(facts) = runtime.lock().ok().map(|runtime| {
                codex_omd::observe_workspace_changes(
                    &host.repository,
                    observes_workspace(&runtime),
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
                json!({"repository":lead.host.repository,"source":source,"call_id":call_id,
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
            for recorded in codex_omd::take_workspace_changes(&lead.host.repository) {
                self.workspace_change(lead, recorded.source, None, recorded.changes)
                    .await;
            }
        })
    }
}

impl Mods {
    fn switch_ledger_provider(&self, lead: &Lead, config: &Config) {
        if let Err(error) = lead.host.switch_provider(lead, config) {
            self.views.diagnostic(
                &self.host,
                "session",
                Some(format!("OMD ledger provider switch failed: {error}")),
            );
        }
    }

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
        let mut payload = json!({"turn_id":input.turn_id,"trigger":input.trigger});
        if let Some(outcome) = input.outcome {
            payload["outcome"] = json!(outcome);
            payload["by"] = json!(input.by);
            payload["provider_call"] = json!(input.provider_call);
        }
        self.event(event, payload, lead.as_deref()).await;
    }

    fn compaction_decision(
        &self,
        runtime: &mut ModHost,
        config: &mut Config,
    ) -> Result<(), String> {
        let compaction = runtime.event(
            "compaction",
            json!({"token_limit":config.model_auto_compact_token_limit
                .or_else(|| config.model_context_window.map(|window| window * 9 / 10)),
                "context_window":config.model_context_window}),
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
        let (routing, _) = self.host.route_config();
        let routes = routing
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
                        && routing
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
            selected.and_then(|name| routing.route(&name, config::RouteRole::Lead, None))
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
    fn prepare_thread_config(
        &self,
        config: &mut Config,
        thread: Option<&str>,
        forked_from: Option<&str>,
    ) -> Result<(), String> {
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
        if self
            .codex_config
            .lock()
            .is_ok_and(|keys| keys.contains(codex_omd::CODEX_CONFIG_UPDATE_PLAN))
        {
            config.update_plan_enabled = true;
        }
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
        if let (Some(thread), Some(parent)) = (thread, forked_from)
            && let Err(error) =
                codex_omd::data_store::fork_thread_data(&self.host.root, parent, thread)
            && error.kind() != std::io::ErrorKind::AlreadyExists
        {
            self.views.diagnostic(
                &self.host,
                "thread_store",
                Some(format!("fork copy failed: {error}")),
            );
        }
        let _thread = codex_omd::StateThread::enter(thread.map(str::to_owned));
        self.compaction_decision(&mut runtime, config)?;
        self.routing_decision(&mut runtime, config)
    }

    fn on_config_changed(
        &self,
        _session_store: &codex_extension_api::ExtensionData,
        thread_store: &codex_extension_api::ExtensionData,
        previous: &Config,
        next: &Config,
    ) {
        if previous.model_provider_id != next.model_provider_id
            && let Some(lead) = thread_store.get::<Lead>()
            && lead.owner == "lead"
        {
            let thread = lead.thread.to_string();
            let running = self
                .turns
                .lock()
                .is_ok_and(|turns| turns.contains_key(&thread));
            if !running {
                self.switch_ledger_provider(&lead, next);
            } else if let Ok(mut switches) = self.provider_switches.lock() {
                switches.insert(thread, next.clone());
            }
        }
        if lead_thread(thread_store)
            && let Some(change) = settings_change(&settings_view(previous), &settings_view(next))
        {
            expansion::broadcast(&self.expansion, "thread_settings", change);
        }
    }
}

fn submission_context(items: &[Value]) -> (Vec<Value>, Vec<Value>) {
    let (mut attachments, mut elements) = (Vec::new(), Vec::new());
    for item in items {
        match item["type"].as_str() {
            Some("text") => {
                for element in item["text_elements"].as_array().into_iter().flatten() {
                    let placeholder = element["placeholder"].as_str().unwrap_or_default();
                    let kind = if placeholder.starts_with("[Image") {
                        "image"
                    } else if placeholder.starts_with("[Pasted") {
                        "paste"
                    } else {
                        "mention"
                    };
                    elements.push(
                        json!({"kind": kind, "start": element["byte_range"]["start"],
                        "end": element["byte_range"]["end"], "source": placeholder}),
                    );
                }
            }
            Some(kind @ ("skill" | "mention")) => {
                elements.push(json!({"kind": kind, "name": item["name"], "source": item["path"]}));
            }
            Some("local_image") => {
                attachments.push(json!({"kind": "image", "source": item["path"]}))
            }
            Some("image") => attachments.push(json!({"kind": "image", "source": "inline"})),
            Some(kind @ ("audio" | "local_audio")) => {
                attachments.push(
                    json!({"kind": kind, "source": item.get("path").unwrap_or(&json!("inline"))}),
                );
            }
            _ => {}
        }
    }
    (attachments, elements)
}

fn settings_view(config: &Config) -> Value {
    let roots = config
        .workspace_roots
        .iter()
        .map(|root| root.display().to_string())
        .collect::<std::collections::BTreeSet<_>>();
    json!({"cwd": config.cwd.display().to_string(), "roots": roots, "model": config.model,
        "effort": config.model_reasoning_effort, "provider": config.model_provider_id})
}

fn settings_change(previous: &Value, next: &Value) -> Option<Value> {
    let roots = |value: &Value| {
        value["roots"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<std::collections::BTreeSet<_>>()
    };
    let (before, after) = (roots(previous), roots(next));
    let mut change = json!({"roots": {"added": after.difference(&before).collect::<Vec<_>>(),
        "removed": before.difference(&after).collect::<Vec<_>>()}});
    for key in ["cwd", "model", "effort", "provider"] {
        change[key] = json!({"before": previous[key], "after": next[key]});
    }
    let changed = before != after
        || ["cwd", "model", "effort", "provider"]
            .iter()
            .any(|key| previous[key] != next[key]);
    changed.then_some(change)
}

impl TurnLifecycleContributor for Mods {
    fn turn_start_phase(
        &self,
        _thread_store: &codex_extension_api::ExtensionData,
    ) -> codex_extension_api::TurnStartPhase {
        codex_extension_api::TurnStartPhase::RegularTaskStart
    }

    fn on_turn_abort<'a>(
        &'a self,
        input: codex_extension_api::TurnAbortInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            self.release_pending(thread_id(input.thread_store));
            if let Ok(mut errors) = self.child_errors.lock() {
                errors.remove(input.thread_store.level_id());
            }
            self.agent_turn(input.thread_store, input.turn_store, "aborted", Value::Null);
            let Some(lead) = input
                .thread_store
                .get::<Lead>()
                .filter(|lead| lead.owner == "lead")
            else {
                return;
            };
            lead.session.processes.cleanup();
            lead.session.access.cleanup();
            self.autonomy.turn_ended(
                &self.core,
                &lead,
                matches!(
                    input.reason,
                    codex_protocol::protocol::TurnAbortReason::Interrupted
                ),
            );
            if let Some(turn) = self.take_turn(&lead.thread) {
                expansion::turn_ended(
                    &self.core,
                    &lead,
                    "aborted",
                    Some(format!("{:?}", input.reason)),
                    None,
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
            self.release_pending(thread_id(input.thread_store));
            let failure =
                agents::classify_error(&Some(input.error), &input.error_details.to_string());
            if let Some(thread) = thread_id(input.thread_store)
                && lead_thread(input.thread_store)
                && let Ok(mut turns) = self.turns.lock()
                && let Some(turn) = turns.get_mut(&thread)
            {
                turn.error = Some(failure);
            } else if !lead_thread(input.thread_store)
                && let Ok(mut errors) = self.child_errors.lock()
            {
                errors.insert(input.thread_store.level_id().to_owned(), failure);
            }
        })
    }

    fn on_turn_stop<'a>(
        &'a self,
        input: codex_extension_api::TurnStopInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            self.release_pending(thread_id(input.thread_store));
            let failed = self
                .child_errors
                .lock()
                .ok()
                .and_then(|mut errors| errors.remove(input.thread_store.level_id()));
            self.agent_turn(
                input.thread_store,
                input.turn_store,
                if failed.is_some() {
                    "error"
                } else {
                    "completed"
                },
                failed.unwrap_or(Value::Null),
            );
            let Some(lead) = input
                .thread_store
                .get::<Lead>()
                .filter(|lead| lead.owner == "lead")
            else {
                return;
            };
            self.autonomy.turn_ended(&self.core, &lead, false);
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
                None,
                payload.get("error").cloned(),
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

    fn continue_turn<'a>(
        &'a self,
        input: codex_extension_api::TurnContinueInput<'a>,
    ) -> ExtensionFuture<'a, Option<codex_extension_api::TurnContinuation>> {
        Box::pin(async move {
            let required = (*self.expansion.turn_stop.lock().ok()?)?;
            if input.continued >= autonomy::CONTINUATIONS {
                return None;
            }
            let lead = input
                .thread_store
                .get::<Lead>()
                .filter(|lead| lead.owner == "lead")?;
            let thread = lead.thread.to_string();
            let payload = json!({"thread_id": thread, "turn_id": input.turn_id,
                "outcome": if input.error.is_some() { "error" } else { "completed" },
                "error": input.error.map(|error| error.chars().take(2048).collect::<String>()),
                "message": input.last_agent_message.map(|message| message.chars().take(8192).collect::<String>()),
                "continued": input.continued, "limit": autonomy::CONTINUATIONS,
                "provenance": self.autonomy.running(&thread).map(|owner| json!({"kind": "mod", "package": owner}))});
            let cancelled = Arc::new(AtomicBool::new(false));
            let _cancellation = Cancellation(cancelled.clone());
            let chain = intercept::chain(
                self.core.clone(),
                lead,
                self.runtime.clone(),
                "turn_stop",
                required,
                payload,
                json!({"caller": "engine", "thread_id": thread}),
                cancelled,
                |_| Ok(json!({"stop": true})),
            )
            .await;
            let chain = match chain {
                Ok(chain) => chain,
                Err(error) => {
                    self.views.diagnostic(
                        &self.host,
                        "turn_stop",
                        Some(format!("{error}; the turn ended")),
                    );
                    return None;
                }
            };
            let prompt = chain.result["continue"].as_str()?.to_owned();
            let owner = chain
                .answered_by
                .clone()
                .unwrap_or_else(|| intercept::settled_by(&chain));
            let (runtime, id) = (self.runtime.clone(), owner.clone());
            let limit = tokio::task::spawn_blocking(move || {
                runtime
                    .lock()
                    .ok()?
                    .grants(&id)?
                    .autonomy
                    .map(|autonomy| autonomy.max_continuations)
            })
            .await
            .ok()
            .flatten()?;
            if !self
                .autonomy
                .continue_turn(&thread, input.turn_id, &owner, limit)
            {
                return None;
            }
            Some(codex_extension_api::TurnContinuation {
                source: format!("mod:{owner}"),
                prompt: format!(
                    "[Continuation requested by mod {owner}; not typed by the user]\n{prompt}"
                ),
            })
        })
    }

    fn on_item_completed<'a>(
        &'a self,
        thread_store: &'a codex_extension_api::ExtensionData,
        _turn_store: &'a codex_extension_api::ExtensionData,
        item: &'a codex_protocol::items::TurnItem,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let thread = thread_store.level_id();
            if let codex_protocol::items::TurnItem::AgentMessage(message) = item
                && self.inventory.contains(thread)
            {
                let text = message
                    .content
                    .iter()
                    .map(|content| match content {
                        codex_protocol::items::AgentMessageContent::Text { text } => text.as_str(),
                    })
                    .collect::<String>();
                self.inventory.answer(thread, &text);
            }
        })
    }

    fn disabled_collaboration_modes(&self) -> Vec<String> {
        // Input interception reloads this runtime before the core reads the turn's modes.
        match self.input_runtime.try_lock() {
            Ok(runtime) => runtime
                .builtin_controls()
                .into_iter()
                .flat_map(|(_, controls)| controls.modes.disable)
                .collect(),
            Err(_) => codex_omd::BuiltinSnapshot::read(&self.host.root, &self.host.repository)
                .disabled_modes
                .into_values()
                .flatten()
                .collect(),
        }
    }

    fn rewrites_persisted_text(&self) -> bool {
        self.core
            .persist_runtime
            .try_lock()
            .map_or(true, |runtime| {
                runtime.intercepts("history_persist").is_some() || runtime.refresh_due()
            })
    }

    fn rewrite_persisted_text<'a>(
        &'a self,
        input: codex_extension_api::PersistedTextInput<'a>,
    ) -> ExtensionFuture<'a, Option<codex_extension_api::PersistedTextRewrite>> {
        Box::pin(persisted::rewrite(
            self.core.persist_runtime.clone(),
            self.core.persist_required.clone(),
            input,
        ))
    }

    fn intercept_user_input<'a>(
        &'a self,
        input: UserInputInterceptInput<'a>,
    ) -> ExtensionFuture<'a, UserInputDecision> {
        Box::pin(async move {
            if !lead_thread(input.thread_store) {
                return UserInputDecision::Keep;
            }
            let Some(lead) = input.thread_store.get::<Lead>() else {
                return UserInputDecision::Keep;
            };
            let runtime = self.input_runtime.clone();
            let thread = thread_id(input.thread_store);
            let provenance = self
                .autonomy
                .take_submitting(&lead.thread.to_string(), input.text);
            if provenance.is_none() {
                self.autonomy.user_turn(&lead.thread.to_string());
            }
            let cancelled = Arc::new(AtomicBool::new(false));
            let _cancellation = Cancellation(cancelled.clone());
            let unavailable = |error: String| UserInputDecision::Deny {
                notice: format!("Mod input interception failed; the prompt was not sent: {error}"),
            };
            let (flag, scoped) = (cancelled.clone(), thread.clone());
            let announce = |effective: &str| {
                let prompt = json!({"thread_id":thread,"turn_id":Value::Null,
                    "original":input.text,"effective":effective,"provenance":provenance.iter().collect::<Vec<_>>()});
                let (runtime, flag, scoped) = (runtime.clone(), flag.clone(), thread.clone());
                tokio::task::spawn_blocking(move || {
                    let _thread = codex_omd::StateThread::enter(scoped);
                    if let Ok(mut runtime) = runtime.lock() {
                        let _ = runtime
                            .event_guarded("prompt", prompt, || !flag.load(Ordering::Acquire));
                    }
                })
            };
            let boundary = runtime.clone();
            let boundary_cancelled = cancelled.clone();
            let intercepting = tokio::task::spawn_blocking(move || {
                let _thread = codex_omd::StateThread::enter(scoped);
                let mut runtime = boundary.lock().map_err(|_| "mod_runtime_poisoned")?;
                runtime
                    .refresh_guarded(&|| !boundary_cancelled.load(Ordering::Acquire))
                    .map_err(|error| error.to_string())?;
                Ok::<_, String>(runtime.intercepts("input"))
            })
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result);
            let required = match intercepting {
                Ok(Some(required)) => required,
                Ok(None) => {
                    let _ = announce(input.text).await;
                    return UserInputDecision::Keep;
                }
                Err(error) => return unavailable(error),
            };
            let (attachments, elements) = submission_context(input.items);
            let payload = json!({"thread_id":thread,"text":input.text,
                "revision": input.client_id.and_then(codex_omd::drafts::take),
                "attachments":attachments,"elements":elements});
            let origin = match &provenance {
                Some(provenance) => {
                    json!({"caller":provenance["package"],"thread_id":thread,"provenance":provenance})
                }
                None => json!({"caller":"user","thread_id":thread}),
            };
            let chain = intercept::chain(
                self.core.clone(),
                lead,
                self.input_runtime.clone(),
                "input",
                required,
                payload,
                origin,
                cancelled.clone(),
                |input| Ok(json!({"text": input["text"]})),
            )
            .await;
            let decision = match chain {
                Err(error) => unavailable(error),
                Ok(chain) => match (chain.result["deny"].as_str(), chain.result["text"].as_str()) {
                    (Some(reason), _) => UserInputDecision::Deny {
                        notice: format!(
                            "Mod {} denied this prompt: {reason}",
                            intercept::settled_by(&chain)
                        ),
                    },
                    (None, Some(text)) if text != input.text => UserInputDecision::Rewrite {
                        notice: format!(
                            "Mods rewrote this prompt. The model received:\n{}",
                            preview(text)
                        ),
                        text: text.to_owned(),
                    },
                    _ => UserInputDecision::Keep,
                },
            };
            match &decision {
                UserInputDecision::Keep => {
                    let _ = announce(input.text).await;
                }
                UserInputDecision::Rewrite { text, .. } => {
                    let _ = announce(text).await;
                }
                UserInputDecision::Deny { .. } => {}
            }
            decision
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

    fn on_tool_batch_end<'a>(
        &'a self,
        input: codex_extension_api::ToolBatchEndInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let Some(lead) = input
                .thread_store
                .get::<Lead>()
                .filter(|lead| lead.owner == "lead")
            else {
                return;
            };
            let calls = {
                let mut settled = self.settled.lock().ok();
                input
                    .call_ids
                    .iter()
                    .map(|call_id| {
                        let (tool, outcome) = settled
                            .as_mut()
                            .and_then(|settled| {
                                settled.remove(&(lead.thread.to_string(), call_id.clone()))
                            })
                            .unwrap_or_default();
                        json!({"call_id": call_id, "tool": tool, "outcome": outcome})
                    })
                    .collect::<Vec<_>>()
            };
            self.event(
                "tool_batch_end",
                json!({"turn_id": input.turn_id, "calls": calls}),
                Some(&*lead),
            )
            .await;
        })
    }

    fn on_prompt_expanded<'a>(
        &'a self,
        input: codex_extension_api::PromptExpandedInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let Some(lead) = input
                .thread_store
                .get::<Lead>()
                .filter(|lead| lead.owner == "lead")
            else {
                return;
            };
            self.event(
                "prompt_expanded",
                json!({"turn_id": input.turn_id, "items": input.items}),
                Some(&*lead),
            )
            .await;
        })
    }

    fn on_instructions_loaded<'a>(
        &'a self,
        input: codex_extension_api::InstructionsLoadedInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let Some(lead) = input
                .thread_store
                .get::<Lead>()
                .filter(|lead| lead.owner == "lead")
            else {
                return;
            };
            self.event(
                "instructions_loaded",
                json!({"kind": input.kind, "source": input.source, "sha256": input.sha256,
                    "bytes": input.bytes, "reason": input.reason}),
                Some(&*lead),
            )
            .await;
        })
    }

    fn intercept_elicitation<'a>(
        &'a self,
        input: codex_extension_api::ElicitationInterceptInput<'a>,
    ) -> ExtensionFuture<'a, Option<codex_extension_api::ElicitationAnswer>> {
        Box::pin(self.elicitation_answer(input))
    }

    fn on_elicitation_result<'a>(
        &'a self,
        input: codex_extension_api::ElicitationResultInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(self.elicitation_result(input))
    }

    fn plan_compaction<'a>(
        &'a self,
        input: codex_extension_api::CompactionInterceptInput<'a>,
    ) -> ExtensionFuture<'a, codex_extension_api::CompactionPlan> {
        Box::pin(self.compaction_plan(input))
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
            let switch = self
                .provider_switches
                .lock()
                .ok()
                .and_then(|mut switches| switches.remove(&lead.thread.to_string()));
            if let Some(config) = switch {
                self.switch_ledger_provider(&lead, &config);
            }
            // Batches settle within their turn; calls an aborted turn left behind are dropped here.
            if let Ok(mut settled) = self.settled.lock() {
                let thread = lead.thread.to_string();
                settled.retain(|(owner, _), _| *owner != thread);
            }
            let runtime = self.runtime.clone();
            let session = lead.session.clone();
            let host = lead.host.clone();
            let _ =
                tokio::task::spawn_blocking(move || refresh_turn(&host, &session, &runtime)).await;
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

impl codex_extension_api::TokenUsageContributor for Mods {
    fn on_token_usage<'a>(
        &'a self,
        _session_store: &'a codex_extension_api::ExtensionData,
        thread_store: &'a codex_extension_api::ExtensionData,
        _turn_store: &'a codex_extension_api::ExtensionData,
        token_usage: &'a codex_protocol::protocol::TokenUsageInfo,
    ) -> ExtensionFuture<'a, ()> {
        self.inventory
            .tokens(thread_store.level_id(), &token_usage.total_token_usage);
        Box::pin(std::future::ready(()))
    }
}

/// Only a thread the user opened sets or clears the "Mods are off" warning; internal and sub-agent threads (memory runs in CODEX_HOME) don't.
fn reports_directory(
    source: &SessionSource,
    cwd: &std::path::Path,
    codex_home: &std::path::Path,
) -> bool {
    !source.is_non_root_agent() && !cwd.starts_with(codex_home)
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
            self.native_agent_started(thread, input.session_source, input.thread_store);
            let host = self.host_for(input.config.cwd.as_path());
            if reports_directory(
                input.session_source,
                input.config.cwd.as_path(),
                input.config.codex_home.as_path(),
            ) {
                self.views.diagnostic(
                    &self.host,
                    "directory",
                    host.is_none().then(|| {
                        format!(
                            "Mods are off in {}: it is neither the launch project nor one of its worktrees",
                            input.config.cwd.display()
                        )
                    }),
                );
            }
            let Some(host) = host else {
                return;
            };
            if self
                .host
                .accounts
                .by_thread
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
                None => match host.open_session(
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
                .then(|| host.lead_route(input.config))
                .flatten();
            if let Err(error) =
                host.enroll(thread, &session, &owner, route.as_ref(), Some(input.config))
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
                let mut resolved = contract::SessionContract::resolve(&host, &documents);
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
            if let Ok(mut invokers) = self.expansion.invokers.lock() {
                invokers.insert(
                    thread.to_string(),
                    input
                        .thread_store
                        .get_or_init(codex_extension_api::ToolInvokerSlot::default),
                );
            }
            input.thread_store.insert(Lead {
                permission_profile: Arc::new(std::sync::Mutex::new(
                    input.config.permissions.effective_permission_profile(),
                )),
                host,
                session,
                thread,
                owner: owner.clone(),
                depth,
            });
            if let Some(lead) = input.thread_store.get::<Lead>() {
                self.core.expansion.thread_started(&lead);
            }
            if owner == "lead" {
                if let Some(lead) = input.thread_store.get::<Lead>() {
                    self.views.start_thread(input.thread_store);
                    let forked = input
                        .thread_store
                        .get::<codex_extension_api::ForkedFromThread>()
                        .map(|forked| forked.0);
                    expansion::lead_started(&self.core, &lead, forked);
                    peering::start(&self.core, lead.thread);
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
            let thread = input.thread_store.level_id();
            let status = match self
                .inventory
                .list()
                .into_iter()
                .find(|record| record["thread_id"] == thread)
            {
                Some(record) if record["origin"] == "mod" => None,
                Some(record) if record["last_turn"]["outcome"] == "error" => Some("failed"),
                Some(record) if record["last_turn"]["outcome"] == "aborted" => Some("cancelled"),
                Some(_) => Some("completed"),
                None => None,
            };
            if let Some(record) = status.and_then(|status| self.inventory.end(thread, status, None))
            {
                inventory::notify(&self.runtime, &self.inventory, "end", record);
            }
            let Some(lead) = input.thread_store.get::<Lead>() else {
                return;
            };
            if let Ok(mut accounts) = self.host.accounts.by_thread.lock() {
                accounts.remove(&lead.thread.to_string());
            }
            self.host.accounts.forget_thread(&lead.thread.to_string());
            expansion::release_thread(self, lead.thread);
            if let Ok(mut invokers) = self.expansion.invokers.lock() {
                invokers.remove(&lead.thread.to_string());
            }
            if lead.owner != "lead" {
                self.environment.clear(Some(&lead.thread.to_string()), None);
                return;
            }
            self.expansion.forget_inventory(lead.thread);
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
            expansion::release_thread(self, lead.thread);
            self.environment.clear(Some(&lead.thread.to_string()), None);
            lead.session.processes.cleanup();
            lead.session.power.clear();
            lead.session.access.cleanup();
            let _ = lead.session.persist_cost_capture();
        })
    }
}

impl ToolLifecycleContributor for Mods {
    fn wants_call_facts(&self) -> bool {
        true
    }

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
            let repository = lead.host.repository.clone();
            let snapshot = tokio::task::spawn_blocking(move || {
                let observed = runtime
                    .lock()
                    .is_ok_and(|runtime| observes_workspace(&runtime));
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
    ) -> ExtensionFuture<'a, Result<ToolInterception, String>> {
        Box::pin(async move {
            let Some(lead) = input.thread_store.get::<Lead>() else {
                return Ok(ToolInterception::Continue(None));
            };
            if let Some(tools) = input.thread_store.get::<roles::AgentTools>()
                && !tools.0.contains(&input.tool_name.name)
                && !tools.0.contains(&input.tool_name.to_string())
            {
                return Err(format!(
                    "agent_tool_denied: {} is outside this agent's tools",
                    input.tool_name
                ));
            }
            let invoker = input
                .thread_store
                .get_or_init(codex_extension_api::ToolInvokerSlot::default);
            let invoked_by = self
                .expansion
                .invoked
                .lock()
                .ok()
                .and_then(|mut invoked| invoked.remove(input.call_id));
            if invoked_by.as_deref() == Some("") {
                return Ok(ToolInterception::Continue(None));
            }
            let (freeform, raw) = match input.payload {
                codex_tools::ToolPayload::Function { arguments } => (false, arguments),
                codex_tools::ToolPayload::Custom { input } => (true, input),
                _ => return Ok(ToolInterception::Continue(None)),
            };
            let original_tool = input.tool_name.clone();
            let scope_agent_id = agent_id(input.thread_store);
            let raw_arguments = raw.chars().take(65_536).collect::<String>();
            let arguments: Value = if freeform {
                Value::String(raw.clone())
            } else {
                serde_json::from_str(raw).map_err(|e| e.to_string())?
            };
            let spawn = arguments.is_object()
                && roles::is_spawn(input.tool_name)
                && self
                    .expansion
                    .agent_spawn
                    .lock()
                    .is_ok_and(|intercepts| intercepts.is_some());
            let surface = if spawn { "agent_spawn" } else { "tool" };
            let payload = if spawn {
                self.spawn_payload(&lead, &arguments, &lead.host.repository)
            } else {
                let mut payload = expansion::tool_before_payload(
                    input.turn_store,
                    input.call_id,
                    input.tool_name,
                    &arguments,
                    &raw_arguments,
                );
                payload["thread_id"] = json!(lead.thread.to_string());
                payload["agent_id"] = json!(scope_agent_id);
                payload
            };
            let runtime = self.runtime.clone();
            let observed = json!({"tool":original_tool.to_string(),"arguments":arguments,
                "call_id":input.call_id,"agent_id":scope_agent_id});
            let thread = lead.thread.to_string();
            let intercepting = tokio::task::spawn_blocking(move || {
                let _thread = codex_omd::StateThread::enter(Some(thread));
                let mut runtime = runtime.lock().map_err(|_| "mod_runtime_poisoned")?;
                let _ = runtime.event_guarded("tool_call", observed, || true);
                Ok::<_, String>((
                    runtime.intercepts(surface),
                    runtime.intercepts_with(surface, "code_mode_values_v1"),
                ))
            })
            .await
            .map_err(|e| e.to_string())??;
            let (Some(required), values) = intercepting else {
                self.cleanup_failed(Some(&lead)).await;
                if !spawn {
                    self.expansion.validate_call(
                        lead.thread,
                        &original_tool.to_string(),
                        &arguments,
                        false,
                    )?;
                }
                return Ok(ToolInterception::Continue(None));
            };
            let (thread_id, lead_thread_id) = (lead.thread, lead.thread.to_string());
            let cancelled = Arc::new(AtomicBool::new(false));
            let cancellation = Cancellation(cancelled.clone());
            let (reached, reached_at_executor) = tokio::sync::oneshot::channel::<Value>();
            let (result, results) = std::sync::mpsc::channel::<Result<Value, String>>();
            let (flag, mut reached) = (cancelled.clone(), Some(reached));
            let (core, base_call, dispatcher) = (
                self.core.clone(),
                input.call_id.to_owned(),
                tokio::runtime::Handle::current(),
            );
            let mut retries = 0;
            let (spawn_lead, spawn_arguments, spawn_before) =
                (lead.clone(), arguments.clone(), payload.clone());
            let spawn_tool = original_tool.to_string();
            let executor = move |effective: Value| -> std::io::Result<Value> {
                let effective = if spawn {
                    if reached.is_none() {
                        return Err(std::io::Error::other(
                            "agent_spawn_retry_unsupported: a spawn runs once",
                        ));
                    }
                    let arguments = core
                        .spawn_arguments(&spawn_lead, &spawn_arguments, &spawn_before, &effective)
                        .map_err(std::io::Error::other)?;
                    json!({"tool": spawn_tool, "arguments": arguments})
                } else {
                    effective
                };
                let Some(first) = reached.take() else {
                    let invoker = invoker.get().ok_or_else(|| {
                        std::io::Error::other(
                            "continuation_retry_unavailable: this turn has no tool dispatch",
                        )
                    })?;
                    core.expansion
                        .validate_call(
                            thread_id,
                            effective["tool"].as_str().unwrap_or_default(),
                            &effective["arguments"],
                            effective["tool"] != spawn_before["tool"]
                                || effective["arguments"] != spawn_before["arguments"],
                        )
                        .map_err(std::io::Error::other)?;
                    retries += 1;
                    let call_id = format!("{base_call}:retry{retries}");
                    if let Ok(mut invoked) = core.expansion.invoked.lock() {
                        invoked.insert(call_id.clone(), String::new());
                    }
                    let outcome = dispatcher.block_on(invoker.invoke(
                        codex_extension_api::ToolInvocationRequest {
                            call_id: call_id.clone(),
                            tool: effective["tool"].as_str().unwrap_or_default().to_owned(),
                            arguments: effective["arguments"].clone(),
                            serialized: false,
                        },
                    ));
                    if let Ok(mut invoked) = core.expansion.invoked.lock() {
                        invoked.remove(&call_id);
                    }
                    let outcome = outcome.map_err(std::io::Error::other)?;
                    let (output, truncated) = expansion::bounded_output(outcome.output);
                    return Ok(
                        json!({"output": output, "success": outcome.success, "truncated": truncated, "call_id": call_id}),
                    );
                };
                first
                    .send(effective)
                    .map_err(|_| std::io::Error::other("tool_dispatch_stopped"))?;
                loop {
                    if flag.load(Ordering::Acquire) {
                        return Err(std::io::Error::other("callback_cancelled"));
                    }
                    match results.recv_timeout(std::time::Duration::from_millis(20)) {
                        Ok(result) => {
                            return result
                                .map(|result| {
                                    if spawn {
                                        roles::spawn_result(&result)
                                    } else {
                                        result
                                    }
                                })
                                .map_err(std::io::Error::other);
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            return Err(std::io::Error::other("tool_result_unavailable"));
                        }
                    }
                }
            };
            let mut origin = json!({"caller":"model","thread_id":lead.thread.to_string(),
                "agent_id":scope_agent_id,"call_id":input.call_id});
            if let Some(caller) = invoked_by {
                origin["caller"] = json!(caller);
            } else if let codex_tools::ToolCallSource::CodeMode { cell_id, .. } = &input.source {
                origin["caller"] = json!("code_mode");
                origin["cell_id"] = json!(cell_id);
            }
            let chain = tokio::spawn(intercept::chain(
                self.core.clone(),
                lead,
                self.runtime.clone(),
                surface,
                required,
                payload.clone(),
                origin,
                cancelled,
                executor,
            ));
            if let Ok(effective) = reached_at_executor.await {
                if !spawn
                    && let Err(error) = self.expansion.validate_call(
                        thread_id,
                        effective["tool"].as_str().unwrap_or_default(),
                        &effective["arguments"],
                        effective["tool"] != payload["tool"]
                            || effective["arguments"] != payload["arguments"],
                    )
                {
                    let _ = result.send(Err(error.clone()));
                    let _ = chain.await;
                    return Err(error);
                }
                if let Ok(mut pending) = self.pending.lock() {
                    pending.insert(
                        input.call_id.to_owned(),
                        PendingTool {
                            thread: lead_thread_id.clone(),
                            result,
                            chain,
                            values,
                            _cancellation: cancellation,
                        },
                    );
                }
                let (tool, arguments) = if spawn {
                    (original_tool.to_string(), arguments)
                } else {
                    (
                        payload["tool"].as_str().unwrap_or_default().to_owned(),
                        payload["arguments"].clone(),
                    )
                };
                if effective["tool"] == tool && effective["arguments"] == arguments {
                    return Ok(ToolInterception::Continue(None));
                }
                let target = match effective["tool"].as_str() {
                    Some(name) if name != tool => ToolName::plain(name),
                    _ => original_tool,
                };
                let payload = match &effective["arguments"] {
                    Value::String(input) => codex_tools::ToolPayload::Custom {
                        input: input.clone(),
                    },
                    arguments => codex_tools::ToolPayload::Function {
                        arguments: serde_json::to_string(arguments).map_err(|e| e.to_string())?,
                    },
                };
                return Ok(ToolInterception::Continue(Some((target, payload))));
            }
            let chain = chain
                .await
                .map_err(|e| e.to_string())
                .and_then(|chain| chain)
                .map_err(|e| format!("mod_interception_failed: {e}"))?;
            let by = intercept::settled_by(&chain);
            if let Some(reason) = chain.result["deny"].as_str() {
                return Err(format!(
                    "mod_tool_denied: {by}: {}",
                    reason.chars().take(512).collect::<String>()
                ));
            }
            if let Ok(mut answered) = self.answered.lock() {
                answered.insert(
                    input.call_id.to_owned(),
                    chain.answered_by.clone().unwrap_or(by),
                );
            }
            Ok(ToolInterception::Respond {
                output: chain.result["output"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                success: chain.result["success"].as_bool().unwrap_or(false),
                value: chain
                    .result
                    .get("value")
                    .filter(|value| !value.is_null())
                    .cloned(),
            })
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
                let answered_by = self
                    .answered
                    .lock()
                    .ok()
                    .and_then(|answered| answered.get(input.call_id).cloned());
                cursor.tools.push(json!({"call_id":input.call_id.chars().take(128).collect::<String>(),"tool":input.tool_name.to_string().chars().take(128).collect::<String>(),"outcome":tool_outcome(input.outcome),"answered_by":answered_by}));
            }
            expansion::tool_finished(
                &self.core,
                &lead,
                input.call_id,
                &input.tool_name.to_string(),
                tool_outcome(input.outcome),
            );
            let unavailable = format!("tool_result_unavailable: {}", tool_outcome(input.outcome));
            // A chain that only rethrows the tool's own failure is not a mod fault: the model already has that failure.
            if let Some(Err(error)) = self.resume(input.call_id, Err(unavailable.clone())).await
                && error != unavailable
            {
                self.views.diagnostic(
                    &self.host,
                    "intercept",
                    Some(format!("{}: {error}", input.call_id)),
                );
            }
            let answered_by = self
                .answered
                .lock()
                .ok()
                .and_then(|mut answered| answered.remove(input.call_id));
            if lead.owner == "lead"
                && let Ok(mut settled) = self.settled.lock()
            {
                settled.insert(
                    (lead.thread.to_string(), input.call_id.to_owned()),
                    (
                        input.tool_name.to_string(),
                        tool_outcome(input.outcome).to_owned(),
                    ),
                );
            }
            let event_lead = (lead.owner == "lead").then_some(&*lead);
            self.event(
                "tool_result",
                json!({"call_id": input.call_id, "agent_id":agent_id(input.thread_store),
                    "thread_id": lead.thread.to_string(), "tool": input.tool_name.to_string(),
                    "outcome": tool_outcome(input.outcome), "answered_by": answered_by,
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
                let repository = lead.host.repository.clone();
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

#[cfg(test)]
#[test]
fn directory_warning_comes_only_from_user_threads() {
    let home = std::path::Path::new("/home/user/.codex");
    let outside = std::path::Path::new("/elsewhere");
    let memories = SessionSource::Internal(
        codex_protocol::protocol::InternalSessionSource::MemoryConsolidation,
    );
    assert!(reports_directory(&SessionSource::Cli, outside, home));
    assert!(!reports_directory(
        &memories,
        home.join("memories").as_path(),
        home
    ));
    assert!(!reports_directory(&memories, outside, home));
    assert!(!reports_directory(
        &SessionSource::Cli,
        home.join("memories").as_path(),
        home
    ));
}
