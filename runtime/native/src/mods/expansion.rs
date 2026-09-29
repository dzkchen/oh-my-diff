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

pub(super) use activity::files;
pub(super) use activity::resume_payload;
pub(super) use activity::tool_finished;
pub(super) use activity::tool_started;
pub(super) use activity::turn_ended;
pub(super) use activity::turn_started;
pub(super) use delivery::lead_started;
pub(super) use delivery::process_started;
pub(super) use delivery::release_owner;
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
];

#[derive(Default)]
pub(super) struct State {
    recording: AtomicBool,
    tool_output: AtomicBool,
    approval: AtomicBool,
    approval_result: AtomicBool,
    tool_specs: AtomicBool,
    tool_batch: AtomicBool,
    gates: Mutex<BTreeMap<String, String>>,
    current: Mutex<Option<LeadHandle>>,
    running: Mutex<BTreeMap<String, String>>,
    restarted: Mutex<BTreeMap<String, bool>>,
    watches: Mutex<Option<Arc<crate::workspace_watch::WorkspaceWatches>>>,
    subscribed: Mutex<BTreeSet<String>>,
    subscriptions: Mutex<Vec<(String, codex_omd::ModSubscriptions)>>,
    wake: Arc<tokio::sync::Notify>,
    delivery: Mutex<Option<Delivery>>,
    pending: Mutex<std::collections::VecDeque<delivery::Pending>>,
    core: std::sync::OnceLock<std::sync::Weak<Core>>,
}

struct Delivery {
    task: tokio::task::JoinHandle<()>,
    _wake: codex_omd::client_surface::Registration,
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
        let recording = runtime.holds_capability("sessions");
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

pub(super) fn event_allows(event: &str, operation: &str) -> bool {
    matches!(event, "process_event" | "channel" | "approval_result")
        || event == "tool_output"
            && matches!(operation, "evidence.read" | "store.get" | "store.list")
}

type HostFn<'a> = &'a mut dyn FnMut(&str, ModHostCall) -> std::io::Result<Value>;

pub(super) async fn run<T: Send + 'static>(
    core: &Core,
    lead: &Lead,
    event: &'static str,
    job: impl FnOnce(&mut ModHost, HostFn<'_>, &dyn Fn() -> bool) -> T + Send + 'static,
) -> Option<T> {
    let runtime = core.runtime.clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancellation = Cancellation(cancelled.clone());
    let (requests, mut receiver) = tokio::sync::mpsc::channel::<HostRequest>(1);
    let generation = Arc::new(AtomicU64::new(0));
    let (flag, current) = (cancelled.clone(), generation.clone());
    let handle = tokio::task::spawn_blocking(move || {
        let mut runtime = runtime.lock().ok()?;
        current.store(runtime.generation(), Ordering::Release);
        let facts = facts(&runtime);
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
        Some(job(&mut runtime, &mut host, &active))
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
    run(core, lead, event, move |runtime, host, active| {
        if !runtime.registered(&id, event) {
            return Ok(Value::Null);
        }
        let generation = runtime.generation();
        runtime
            .invoke_with(&id, generation, event, "", payload, active, |call| {
                host(&id, call)
            })
            .map_err(|error| error.to_string())
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
        "workspace.watch" => delivery::watch(core, lead, caller.id, request.arguments),
        "workspace.unwatch" => delivery::unwatch(core, caller.id, &request.arguments),
        "events.publish" => delivery::publish(core, caller.id, request.arguments),
        "turns.activity" => activity::read(core, lead, request.arguments).await,
        "routes.select" => select_route(lead, caller.id, request.arguments),
        "credentials.list" => {
            blocking(Box::new(move || {
                let profiles = codex_omd::credentials::CredentialProfiles::open(&host.root)
                    .and_then(|profiles| profiles.list())
                    .map_err(|error| error.to_string())?;
                Ok(Value::Array(
                    profiles
                        .into_iter()
                        .map(|profile| {
                            json!({"id": profile.id, "label": profile.label, "kind": profile.kind,
                                "provider": profile.provider, "origin": profile.origin, "status": "unknown", "default": profile.default})
                        })
                        .collect(),
                ))
            }))
            .await
        }
        "packages.list" | "packages.preview" | "packages.reload" => {
            let operation = request.operation.clone();
            let arguments = request.arguments;
            blocking(Box::new(move || packages(&host.root, &operation, arguments))).await
        }
        _ => surface(lead, caller, request, cancelled).await,
    }
}

fn packages(root: &std::path::Path, operation: &str, arguments: Value) -> Result<Value, String> {
    let store = codex_omd::ModStore::open(root.to_path_buf()).map_err(|error| error.to_string())?;
    match operation {
        "packages.list" => {
            codex_omd::package_controls::list(&store).map_err(|error| error.to_string())
        }
        "packages.preview" => codex_omd::package_controls::preview(&store, arguments)
            .map(|preview| preview.public)
            .map_err(|error| error.to_string()),
        _ => {
            if !arguments.is_null() {
                return Err("packages_reload_arguments_invalid".into());
            }
            let status = store
                .selection_status()
                .map_err(|error| error.to_string())?;
            let failed = status["selections"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item["selected"] == true && !item["error"].is_null())
                .filter_map(|item| {
                    item["id"]
                        .as_str()
                        .or(item["path"].as_str())
                        .map(str::to_owned)
                })
                .collect::<Vec<_>>();
            let generation = store
                .package_lock()
                .map(|lock| lock.revision)
                .map_err(|error| error.to_string())?;
            Ok(json!({"generation": generation, "failed": failed, "applies": "next_boundary"}))
        }
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
    let route = lead
        .host
        .config
        .route(&input.route, config::RouteRole::Lead, Some(caller))
        .ok_or_else(|| format!("route_not_configured: {}", input.route))?;
    let enrolled = lead
        .host
        .accounts
        .0
        .lock()
        .map_err(|_| "account lock poisoned")?
        .get(&lead.thread.to_string())
        .is_some_and(|account| {
            account.owner == "lead"
                && (account.route.as_deref() == Some(route.name.as_str())
                    || account
                        .lead_routes
                        .iter()
                        .any(|candidate| candidate.name == route.name))
        });
    if !enrolled {
        return Err(format!("route_unavailable_for_thread: {}", input.route));
    }
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
    let confirm = if request.operation == "app.request" {
        let grants = caller.grants.as_ref().ok_or("host_caller_inactive")?;
        let method = request.arguments["method"]
            .as_str()
            .ok_or("app_params_invalid: method")?;
        let capabilities = grants.capabilities.iter().cloned().collect::<BTreeSet<_>>();
        let routes = lead
            .host
            .config
            .routes
            .iter()
            .filter(|route| route.roles.contains(&config::RouteRole::Lead))
            .map(|route| (route.model.clone(), route.provider.clone()))
            .collect::<Vec<_>>();
        let route = codex_omd::app_routes::authorize(
            method,
            &request.arguments["params"],
            &codex_omd::app_routes::AppCaller {
                capabilities: &capabilities,
                context,
                current_thread: Some(&thread),
                visible_threads: &BTreeSet::new(),
                roots: &codex_omd::app_routes::session_roots(&lead.host.repository),
                routes: &routes,
            },
        )
        .map_err(|error| error.to_string())?;
        route
            .confirm
            .then(|| format!("Mod {} requests {method}.", caller.id))
    } else {
        None
    };
    let (id, operation) = (caller.id.to_owned(), request.operation);
    let arguments = request.arguments;
    let cancelled = cancelled.clone();
    tokio::task::spawn_blocking(move || {
        codex_omd::client_surface::call(
            &id,
            &operation,
            arguments,
            context,
            Some(&thread),
            confirm,
            &|| !cancelled.load(Ordering::Acquire),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
#[path = "expansion_tests.rs"]
mod tests;
