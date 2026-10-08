mod activity;
mod approvals;
mod delivery;
mod tool_batch;
mod tool_output;
mod tool_specs;

use super::*;
use codex_omd::app_routes::InvocationContext;
use codex_omd::data_store::Origin;
use operations::Caller;
use std::collections::BTreeSet;
use std::sync::atomic::AtomicU64;

pub(super) use activity::command_ended;
pub(super) use activity::files;
pub(super) use activity::resume_payload;
pub(super) use activity::tool_finished;
pub(super) use activity::tool_started;
pub(super) use activity::turn_ended;
pub(super) use activity::turn_started;
pub(super) use delivery::lead_started;
pub(super) use delivery::process_started;
pub(super) use delivery::release_owner;
pub(super) use delivery::retain_sources;
pub(super) use tool_batch::tool_before_payload;

/// Queues an observer event for every registered mod on the delivery task.
pub(super) fn broadcast(state: &State, event: &'static str, payload: Value) {
    delivery::push(state, delivery::Pending::Broadcast { event, payload });
}

pub(super) fn worktree(state: &State, phase: &str, path: &std::path::Path, owner: &str) {
    broadcast(
        state,
        "worktree",
        json!({"phase": phase, "path": path.display().to_string(), "owner": owner}),
    );
}

const CORE_OPERATIONS: &[&str] = &[
    "app.routes",
    "workspace.watch",
    "workspace.unwatch",
    "events.publish",
    "credentials.list",
    "routes.select",
    "turns.activity",
    "packages.list",
    "packages.index",
    "packages.preview",
    "packages.reload",
    "settings.write",
    "tools.define",
    "tools.undefine",
    "tools.invoke",
    "tools.check",
    "events.schedule",
    "events.cancel",
];

type Timers = BTreeMap<(String, String, String), (String, tokio::task::JoinHandle<()>)>;

#[derive(Default)]
pub(super) struct State {
    recording: AtomicBool,
    tool_output: AtomicBool,
    approval: AtomicBool,
    approval_result: AtomicBool,
    tool_specs: AtomicBool,
    tool_specs_required: AtomicBool,
    tool_batch: AtomicBool,
    gates: Mutex<std::collections::VecDeque<(String, String)>>,
    current: Mutex<Option<LeadHandle>>,
    leads: Mutex<std::collections::HashMap<ThreadId, LeadHandle>>,
    threads: Mutex<std::collections::HashMap<ThreadId, (LeadHandle, String, u32)>>,
    commands: Mutex<std::collections::HashSet<String>>,
    running: Mutex<BTreeMap<String, String>>,
    pub(super) turns: Mutex<BTreeMap<String, u64>>,
    restarted: Mutex<BTreeMap<String, bool>>,
    watches: Mutex<Option<Arc<crate::workspace_watch::WorkspaceWatches>>>,
    subscribed: Mutex<BTreeSet<String>>,
    bus_cursor: Mutex<String>,
    subscriptions: Mutex<Vec<(String, codex_omd::ModSubscriptions)>>,
    wake: Arc<tokio::sync::Notify>,
    delivery: Mutex<Option<Delivery>>,
    pending: Mutex<std::collections::VecDeque<delivery::Pending>>,
    dropped: AtomicU64,
    timers: Mutex<Timers>,
    core: std::sync::OnceLock<std::sync::Weak<Core>>,
    pub(super) invokers: Mutex<BTreeMap<String, Arc<codex_extension_api::ToolInvokerSlot>>>,
    pub(super) invoked: Mutex<BTreeMap<String, String>>,
    pub(super) invocations: AtomicU64,
    pub(super) definitions: Mutex<Vec<codex_omd::ModAgentDefinition>>,
    pub(super) agent_offers: Mutex<Option<bool>>,
    pub(super) agent_spawn: Mutex<Option<bool>>,
    pub(super) turn_stop: Mutex<Option<bool>>,
    pub(super) peers: AtomicBool,
}

struct Delivery {
    task: tokio::task::JoinHandle<()>,
    _wake: codex_omd::client_surface::Registration,
    _activity: codex_omd::turn_activity::ReaderRegistration,
}

impl Drop for Delivery {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Clone)]
pub(super) struct LeadHandle {
    host: Arc<Host>,
    session: std::sync::Weak<Session>,
    thread: ThreadId,
    permission_profile: Arc<Mutex<PermissionProfile>>,
}

impl LeadHandle {
    fn new(lead: &Lead) -> Self {
        Self {
            host: lead.host.clone(),
            session: Arc::downgrade(&lead.session),
            thread: lead.thread,
            permission_profile: lead.permission_profile.clone(),
        }
    }

    fn upgrade(&self) -> Option<Lead> {
        Some(Lead {
            host: self.host.clone(),
            session: self.session.upgrade()?,
            thread: self.thread,
            owner: "lead".into(),
            depth: 0,
            permission_profile: self.permission_profile.clone(),
        })
    }
}

impl State {
    pub(super) fn current(&self) -> Option<Lead> {
        self.current
            .lock()
            .ok()?
            .as_ref()
            .and_then(LeadHandle::upgrade)
    }

    pub(super) fn turn_running(&self, thread: ThreadId) -> bool {
        self.running
            .lock()
            .is_ok_and(|running| running.contains_key(&thread.to_string()))
    }

    pub(super) fn lead(&self, thread: ThreadId) -> Option<Lead> {
        self.leads.lock().ok()?.get(&thread)?.upgrade()
    }

    /// Any live thread's own `Lead`, worker and subagent threads included.
    pub(super) fn thread(&self, thread: ThreadId) -> Option<Lead> {
        let threads = self.threads.lock().ok()?;
        let (handle, owner, depth) = threads.get(&thread)?;
        Some(Lead {
            owner: owner.clone(),
            depth: *depth,
            ..handle.upgrade()?
        })
    }

    pub(super) fn thread_started(&self, lead: &Lead) {
        if let Ok(mut threads) = self.threads.lock() {
            threads.retain(|_, (handle, ..)| handle.session.strong_count() > 0);
            threads.insert(
                lead.thread,
                (LeadHandle::new(lead), lead.owner.clone(), lead.depth),
            );
        }
    }

    fn refresh(&self, runtime: &ModHost) -> bool {
        self.tool_output
            .store(runtime.has_event("tool_output"), Ordering::Release);
        self.approval
            .store(runtime.has_event("approval"), Ordering::Release);
        let tool_specs = runtime.intercepts("tool_specs");
        self.tool_specs
            .store(tool_specs.is_some(), Ordering::Release);
        self.tool_specs_required
            .store(tool_specs == Some(true), Ordering::Release);
        self.tool_batch.store(
            runtime.replacement_owner("tool_batch").is_some(),
            Ordering::Release,
        );
        self.approval_result
            .store(runtime.has_event("approval_result"), Ordering::Release);
        if let Ok(mut subscriptions) = self.subscriptions.lock() {
            *subscriptions = runtime.subscriptions();
        }
        if !delivery::sync_bus(self).is_empty() {
            self.wake.notify_one();
        }
        if let Ok(mut definitions) = self.definitions.lock() {
            *definitions = runtime.agent_definitions();
        }
        if let Ok(mut offers) = self.agent_offers.lock() {
            *offers = runtime.intercepts("agent_offers");
        }
        if let Ok(mut spawn) = self.agent_spawn.lock() {
            *spawn = runtime.intercepts("agent_spawn");
        }
        if let Ok(mut stop) = self.turn_stop.lock() {
            *stop = runtime.intercepts("turn_stop");
        }
        self.peers.store(
            runtime.owners().iter().any(|(id, _)| {
                runtime
                    .grants(id)
                    .is_some_and(|grants| grants.peer_access.is_some())
            }),
            Ordering::Release,
        );
        let recording = runtime.uses_operation("turns.activity");
        self.recording.swap(recording, Ordering::AcqRel) && !recording
    }

    pub(super) fn tool_output_active(&self) -> bool {
        self.tool_output.load(Ordering::Acquire)
    }
}

pub(super) fn served(operation: &str) -> bool {
    CORE_OPERATIONS.contains(&operation)
        || codex_omd::client_surface::SURFACE_OPERATIONS.contains(&operation)
}

pub(super) fn event_allows(event: &str) -> bool {
    matches!(
        event,
        "process_event"
            | "channel"
            | "approval_result"
            | "timer"
            | "tool_output"
            | "model_response"
            | "turn_queue"
            | "peer_message"
            | "peer_receipt"
    )
}

type HostFn<'a> = &'a mut dyn FnMut(&str, ModHostCall) -> std::io::Result<Value>;

pub(super) async fn run<T: Send + 'static>(
    core: &Core,
    lead: &Lead,
    event: &'static str,
    origin: Origin,
    job: impl FnOnce(&Mutex<ModHost>, HostFn<'_>, &dyn Fn() -> bool) -> T + Send + 'static,
) -> Option<T> {
    let runtime = core.runtime.clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancellation = Cancellation(cancelled.clone());
    let (requests, mut receiver) = tokio::sync::mpsc::channel::<HostRequest>(1);
    let generation = Arc::new(AtomicU64::new(0));
    let (flag, current) = (cancelled.clone(), generation.clone());
    let thread = lead.thread.to_string();
    let handle = tokio::task::spawn_blocking(move || {
        let _thread = codex_omd::StateThread::enter(Some(thread));
        let facts = {
            let runtime = runtime.lock().ok()?;
            current.store(runtime.generation(), Ordering::Release);
            facts(&runtime)
        };
        let active = || !flag.load(Ordering::Acquire);
        let mut host = |id: &str, request: ModHostCall| {
            if !operations::event_allows(event, &request.operation) {
                return Err(std::io::Error::other(format!(
                    "host_operation_unavailable: {} is not available during {event}",
                    request.operation
                )));
            }
            forward(&requests, &facts, id, request, &active)
        };
        Some(job(&runtime, &mut host, &active))
    });
    while let Some(call) = receiver.recv().await {
        let dispatched = operations::dispatch(
            core,
            lead,
            Caller {
                id: &call.caller,
                source: &call.source,
                grants: call.grants,
                generation: generation.load(Ordering::Acquire),
                origin,
                record_changes: true,
            },
            None,
            call.request,
            &cancelled,
        );
        let value = SERIALIZED.scope(event != "tool_output", dispatched).await;
        let _ = call.reply.send(value.map_err(std::io::Error::other));
    }
    let result = handle.await.ok().flatten();
    core.cleanup_failed(Some(lead)).await;
    core.publish_workspace_changes(lead).await;
    result
}

pub(super) async fn invoke_one(
    core: &Core,
    lead: &Lead,
    id: String,
    event: &'static str,
    payload: Value,
) -> Option<Result<Value, String>> {
    let (views, owner, ledger) = (core.views.clone(), core.host.clone(), lead.ledger());
    run(
        core,
        lead,
        event,
        Origin::Event,
        move |runtime, host, active| {
            let (generation, before) = {
                let runtime = runtime.lock().map_err(|_| "mod_runtime_poisoned")?;
                if !runtime.registered(&id, event) {
                    return Ok(Value::Null);
                }
                (runtime.generation(), runtime.state(&id).cloned())
            };
            let result = codex_omd::invoke_shared(
                runtime,
                &id,
                generation,
                event,
                "",
                payload,
                active,
                host,
                |_| {},
            )
            .map_err(|error| error.to_string());
            // The tool_result event that follows every tool_output republishes the view.
            if event != "tool_output"
                && let Ok(mut runtime) = runtime.lock()
                && runtime.state(&id) != before.as_ref()
            {
                publish(&mut runtime, &owner, &views, event, ledger, active);
            }
            result
        },
    )
    .await
}

tokio::task_local! {
    /// Set while serving a callback outside any tool call, whose `tools.invoke` waits for the turn's tool gate.
    static SERIALIZED: bool;
    /// Set while running work an attached client caused; its surface calls carry `remote`.
    pub(crate) static REMOTE: bool;
}

pub(super) const TOOL_RESULT_BYTES: usize = 48 * 1024;

pub(super) fn bounded_output(mut output: String) -> (String, bool) {
    if output.len() <= TOOL_RESULT_BYTES {
        return (output, false);
    }
    let mut end = TOOL_RESULT_BYTES;
    while !output.is_char_boundary(end) {
        end -= 1;
    }
    output.truncate(end);
    (output, true)
}

/// Runs or assesses a tool through the current turn's dispatch under a mod-labelled call id.
async fn tool_call(
    core: &Core,
    lead: &Lead,
    caller: &Caller<'_>,
    request: ModHostCall,
) -> Result<Value, String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        tool: String,
        arguments: Value,
    }
    let input: Input = serde_json::from_value(request.arguments).map_err(|e| e.to_string())?;
    if input.tool.is_empty()
        || input.tool.len() > 128
        || !(input.arguments.is_object() || input.arguments.is_string())
        || input.arguments.to_string().len() > 64 * 1024
    {
        return Err("tool_arguments_invalid".into());
    }
    let invoker = core
        .expansion
        .invokers
        .lock()
        .map_err(|_| "tool_invokers_poisoned")?
        .get(&lead.thread.to_string())
        .and_then(|slot| slot.get())
        .ok_or("tools_unavailable: this thread has not started a turn")?;
    if request.operation == "tools.check" {
        let check = invoker.check(&input.tool, input.arguments).await?;
        return Ok(
            json!({"decision": check.decision, "reason": check.reason, "authority": check.authority}),
        );
    }
    let sequence = core.expansion.invocations.fetch_add(1, Ordering::AcqRel);
    let call_id = format!("mod-{}-{sequence}", caller.id);
    core.expansion
        .invoked
        .lock()
        .map_err(|_| "tool_invocations_poisoned")?
        .insert(call_id.clone(), caller.id.to_owned());
    let outcome = invoker
        .invoke(codex_extension_api::ToolInvocationRequest {
            call_id: call_id.clone(),
            tool: input.tool,
            arguments: input.arguments,
            serialized: SERIALIZED
                .try_with(|serialized| *serialized)
                .unwrap_or(false),
        })
        .await;
    if let Ok(mut invoked) = core.expansion.invoked.lock() {
        invoked.remove(&call_id);
    }
    let outcome = outcome?;
    let (output, truncated) = bounded_output(outcome.output);
    Ok(
        json!({"call_id": call_id, "output": output, "success": outcome.success, "truncated": truncated}),
    )
}

pub(super) async fn dispatch(
    core: &Core,
    lead: &Lead,
    caller: &Caller<'_>,
    request: ModHostCall,
    cancelled: &Arc<AtomicBool>,
) -> Result<Value, String> {
    let host = lead.host.clone();
    let blocking = |job: Box<dyn FnOnce() -> Result<Value, String> + Send>| async move {
        tokio::task::spawn_blocking(job)
            .await
            .map_err(|error| error.to_string())?
    };
    match request.operation.as_str() {
        "app.routes" => Ok(codex_omd::app_routes::routes()),
        "workspace.watch" => delivery::watch(core, lead, caller, request.arguments),
        "workspace.unwatch" => delivery::unwatch(core, caller.id, &request.arguments),
        "events.publish" => delivery::publish(core, lead, caller.id, request.arguments),
        "events.schedule" => delivery::schedule(core, lead, caller, request.arguments),
        "events.cancel" => delivery::cancel(core, lead, caller.id, &request.arguments),
        "turns.activity" => activity::read(core, lead, request.arguments).await,
        "routes.select" => select_route(lead, caller.id, request.arguments),
        "tools.invoke" | "tools.check" => tool_call(core, lead, caller, request).await,
        "tools.define" | "tools.undefine" => {
            let mut runtime = core.runtime.lock().map_err(|_| "mod_runtime_poisoned")?;
            if request.operation == "tools.define" {
                runtime.define_tool(caller.id, caller.generation, request.arguments)
            } else {
                runtime.undefine_tool(caller.id, &request.arguments)
            }
            .map_err(|error| error.to_string())
        }
        "credentials.list" => {
            let caller = caller.id.to_owned();
            blocking(Box::new(move || {
                codex_omd::credentials::CredentialProfiles::open(&host.root)
                    .and_then(|profiles| profiles.visible(&caller))
                    .map(Value::Array)
                    .map_err(|error| error.to_string())
            }))
            .await
        }
        "packages.list" => {
            let runtime = core
                .runtime
                .lock()
                .map_err(|_| "mod_runtime_poisoned")?
                .status();
            blocking(Box::new(move || {
                codex_omd::ModStore::open(host.root.clone())
                    .and_then(|store| codex_omd::package_controls::list(&store, Some(&runtime)))
                    .map_err(|error| error.to_string())
            }))
            .await
        }
        "packages.preview" => {
            let arguments = request.arguments;
            blocking(Box::new(move || {
                codex_omd::ModStore::open(host.root.clone())
                    .and_then(|store| codex_omd::package_controls::preview(&store, arguments))
                    .map(|preview| preview.public)
                    .map_err(|error| error.to_string())
            }))
            .await
        }
        "packages.index" => {
            let arguments = request.arguments;
            blocking(Box::new(move || {
                codex_omd::ModStore::open(host.root.clone())
                    .and_then(|store| codex_omd::package_controls::index(&store, arguments))
                    .map_err(|error| error.to_string())
            }))
            .await
        }
        "packages.reload" => Err("host_operation_user_only: packages.reload".into()),
        "settings.write" => Err("host_operation_user_only: settings.write".into()),
        _ => surface(core, lead, caller, request, cancelled).await,
    }
}

fn select_route(lead: &Lead, caller: &str, arguments: Value) -> Result<Value, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        route: String,
        scope: String,
    }
    let input: Input = serde_json::from_value(arguments).map_err(|error| error.to_string())?;
    let persistent = match input.scope.as_str() {
        "next_request" => false,
        "thread" => true,
        _ => return Err("route_scope_invalid".into()),
    };
    let (routing, reload_error) = lead.host.route_config();
    let route = routing
        .route(&input.route, config::RouteRole::Lead, Some(caller))
        .ok_or_else(|| match &reload_error {
            Some(error) => format!("route_not_configured: {}; {error}", input.route),
            None => format!("route_not_configured: {}", input.route),
        })?;
    let mut accounts = lead
        .host
        .accounts
        .0
        .lock()
        .map_err(|_| "account lock poisoned")?;
    let account = accounts
        .get_mut(&lead.thread.to_string())
        .filter(|account| account.owner == "lead" && account.route.is_some())
        .ok_or_else(|| format!("route_unavailable_for_thread: {}", input.route))?;
    if account.route.as_deref() != Some(route.name.as_str()) {
        if route.provider != account.provider {
            return Err(format!("route_unavailable_for_thread: {}", input.route));
        }
        lead.session
            .task
            .authorize_route(&route.provider, &route.model)
            .map_err(|error| error.to_string())?;
        account
            .lead_routes
            .retain(|candidate| candidate.name != route.name);
        account.lead_routes.push(crate::request_route(route));
    }
    drop(accounts);
    SELECTIONS
        .lock()
        .map_err(|_| "route_selection_poisoned")?
        .insert(lead.thread.to_string(), (route.name.clone(), persistent));
    Ok(json!({"route": operations::route_info(&lead.host, route), "effective_at": "next_request"}))
}

static SELECTIONS: Mutex<BTreeMap<String, (String, bool)>> = Mutex::new(BTreeMap::new());

pub(crate) fn take_route_selection(thread: &str) -> Option<String> {
    let mut selections = SELECTIONS.lock().ok()?;
    let (route, persistent) = selections.get(thread)?.clone();
    if !persistent {
        selections.remove(thread);
    }
    Some(route)
}

async fn surface(
    core: &Core,
    lead: &Lead,
    caller: &Caller<'_>,
    request: ModHostCall,
    cancelled: &Arc<AtomicBool>,
) -> Result<Value, String> {
    let context = match caller.origin {
        Origin::UserCommand | Origin::Cli => InvocationContext::User,
        Origin::Tool | Origin::Event => InvocationContext::Event,
    };
    let remote = REMOTE.try_with(|remote| *remote).unwrap_or(false);
    let thread = lead.thread.to_string();
    let capabilities = caller
        .grants
        .as_ref()
        .map(|grants| grants.capabilities.clone())
        .ok_or("host_caller_inactive")?;
    let (id, operation) = (caller.id.to_owned(), request.operation);
    let routes = if operation == "app.request" {
        lead.host
            .route_config()
            .0
            .routes
            .iter()
            .filter(|route| route.roles.contains(&config::RouteRole::Lead))
            .map(|route| (route.model.clone(), route.provider.clone()))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let repository = lead.host.repository.clone();
    let arguments = request.arguments;
    let cancelled = cancelled.clone();
    let surface_authority = caller
        .grants
        .as_ref()
        .map(|grants| grants.surface_authority.clone());
    let runtime = core.runtime.clone();
    let generation = caller.generation;
    let source = caller.source.to_owned();
    let admitted_source = source.clone();
    let admission_cancelled = cancelled.clone();
    tokio::task::spawn_blocking(move || {
        let _authority = surface_authority.map(codex_omd::client_surface::Authority::enter);
        let owner = id.clone();
        let admitted_capabilities = capabilities.clone();
        let active: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
            if cancelled.load(Ordering::Acquire) {
                return false;
            }
            let mut runtime = runtime
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if runtime.reload().is_err() {
                return false;
            }
            runtime.generation() == generation
                && runtime.grants(&owner).is_some_and(|grants| {
                    grants.source_sha256 == source && grants.capabilities == admitted_capabilities
                })
        });
        codex_omd::client_surface::with_admission(
            &admitted_source,
            generation,
            Some(admission_cancelled),
            || {
                if operation == "app.request" {
                    return codex_omd::client_surface::app_request(
                        &id,
                        &capabilities,
                        context,
                        remote,
                        Some(&thread),
                        &repository,
                        &routes,
                        arguments,
                        active,
                    );
                }
                codex_omd::client_surface::call(
                    &id,
                    &operation,
                    arguments,
                    context,
                    remote,
                    Some(&thread),
                    None,
                    active,
                )
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
#[path = "expansion_tests.rs"]
mod tests;
