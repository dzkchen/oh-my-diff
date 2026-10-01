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

const CORE_OPERATIONS: &[&str] = &[
    "app.routes",
    "workspace.watch",
    "workspace.unwatch",
    "events.publish",
    "credentials.list",
    "routes.select",
    "turns.activity",
    "packages.list",
    "packages.preview",
    "packages.reload",
    "tools.define",
    "tools.undefine",
    "events.schedule",
    "events.cancel",
];

type Timers = BTreeMap<(String, String), (String, tokio::task::JoinHandle<()>)>;

#[derive(Default)]
pub(super) struct State {
    recording: AtomicBool,
    tool_output: AtomicBool,
    approval: AtomicBool,
    approval_result: AtomicBool,
    tool_specs: AtomicBool,
    tool_batch: AtomicBool,
    gates: Mutex<std::collections::VecDeque<(String, String)>>,
    current: Mutex<Option<LeadHandle>>,
    leads: Mutex<std::collections::HashMap<ThreadId, LeadHandle>>,
    commands: Mutex<std::collections::HashSet<String>>,
    running: Mutex<BTreeMap<String, String>>,
    restarted: Mutex<BTreeMap<String, bool>>,
    watches: Mutex<Option<Arc<crate::workspace_watch::WorkspaceWatches>>>,
    subscribed: Mutex<BTreeSet<String>>,
    subscriptions: Mutex<Vec<(String, codex_omd::ModSubscriptions)>>,
    wake: Arc<tokio::sync::Notify>,
    delivery: Mutex<Option<Delivery>>,
    pending: Mutex<std::collections::VecDeque<delivery::Pending>>,
    dropped: AtomicU64,
    timers: Mutex<Timers>,
    core: std::sync::OnceLock<std::sync::Weak<Core>>,
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
    fn current(&self) -> Option<Lead> {
        self.current
            .lock()
            .ok()?
            .as_ref()
            .and_then(LeadHandle::upgrade)
    }

    fn lead(&self, thread: ThreadId) -> Option<Lead> {
        self.leads.lock().ok()?.get(&thread)?.upgrade()
    }

    fn refresh(&self, runtime: &ModHost) -> bool {
        self.tool_output
            .store(runtime.has_event("tool_output"), Ordering::Release);
        self.approval
            .store(runtime.has_event("approval"), Ordering::Release);
        self.tool_specs.store(
            runtime.replacement_owner("tool_specs").is_some(),
            Ordering::Release,
        );
        self.tool_batch.store(
            runtime.replacement_owner("tool_batch").is_some(),
            Ordering::Release,
        );
        self.approval_result
            .store(runtime.has_event("approval_result"), Ordering::Release);
        if let Ok(mut subscriptions) = self.subscriptions.lock() {
            *subscriptions = runtime.subscriptions();
        }
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
        "process_event" | "channel" | "approval_result" | "timer" | "tool_output"
    )
}

type HostFn<'a> = &'a mut dyn FnMut(&str, ModHostCall) -> std::io::Result<Value>;

pub(super) async fn run<T: Send + 'static>(
    core: &Core,
    lead: &Lead,
    event: &'static str,
    job: impl FnOnce(&Mutex<ModHost>, HostFn<'_>, &dyn Fn() -> bool) -> T + Send + 'static,
) -> Option<T> {
    let runtime = core.runtime.clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancellation = Cancellation(cancelled.clone());
    let (requests, mut receiver) = tokio::sync::mpsc::channel::<HostRequest>(1);
    let generation = Arc::new(AtomicU64::new(0));
    let (flag, current) = (cancelled.clone(), generation.clone());
    let handle = tokio::task::spawn_blocking(move || {
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
        let value = operations::dispatch(
            core,
            lead,
            Caller {
                id: &call.caller,
                source: &call.source,
                grants: call.grants,
                generation: generation.load(Ordering::Acquire),
                origin: Origin::Event,
                record_changes: true,
            },
            None,
            call.request,
            &cancelled,
        )
        .await;
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
    run(core, lead, event, move |runtime, host, active| {
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
    })
    .await
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
        "events.publish" => delivery::publish(core, caller.id, request.arguments),
        "events.schedule" => delivery::schedule(core, lead, caller, request.arguments),
        "events.cancel" => delivery::cancel(core, caller.id, &request.arguments),
        "turns.activity" => activity::read(core, lead, request.arguments).await,
        "routes.select" => select_route(lead, caller.id, request.arguments),
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
        "packages.reload" => Err("host_operation_user_only: packages.reload".into()),
        _ => surface(lead, caller, request, cancelled).await,
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
    if account.route.as_deref() != Some(route.name.as_str())
        && !account
            .lead_routes
            .iter()
            .any(|candidate| candidate.name == route.name)
    {
        if route.provider != account.provider {
            return Err(format!("route_unavailable_for_thread: {}", input.route));
        }
        lead.session
            .task
            .authorize_route(&route.provider, &route.model)
            .map_err(|error| error.to_string())?;
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
    lead: &Lead,
    caller: &Caller<'_>,
    request: ModHostCall,
    cancelled: &Arc<AtomicBool>,
) -> Result<Value, String> {
    let context = match caller.origin {
        Origin::UserCommand | Origin::Cli => InvocationContext::User,
        Origin::Tool | Origin::Event => InvocationContext::Event,
    };
    let thread = lead.thread.to_string();
    let capabilities = caller
        .grants
        .as_ref()
        .map(|grants| grants.capabilities.clone())
        .ok_or("host_caller_inactive")?;
    let routes = lead
        .host
        .route_config()
        .0
        .routes
        .iter()
        .filter(|route| route.roles.contains(&config::RouteRole::Lead))
        .map(|route| (route.model.clone(), route.provider.clone()))
        .collect::<Vec<_>>();
    let repository = lead.host.repository.clone();
    let (id, operation) = (caller.id.to_owned(), request.operation);
    let arguments = request.arguments;
    let cancelled = cancelled.clone();
    tokio::task::spawn_blocking(move || {
        let active = || !cancelled.load(Ordering::Acquire);
        if operation == "app.request" {
            return codex_omd::client_surface::app_request(
                &id,
                &capabilities,
                context,
                Some(&thread),
                &repository,
                &routes,
                arguments,
                &active,
            );
        }
        codex_omd::client_surface::call(
            &id,
            &operation,
            arguments,
            context,
            Some(&thread),
            None,
            &active,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
#[path = "expansion_tests.rs"]
mod tests;
