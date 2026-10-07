use crate::app_routes::InvocationContext;
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

type Admission = (Value, Option<Arc<AtomicBool>>);
thread_local! {
    static CALL_ADMISSION: std::cell::RefCell<Option<Admission>> = const { std::cell::RefCell::new(None) };
}

pub fn with_admission<T>(
    source: &str,
    generation: u64,
    cancelled: Option<Arc<AtomicBool>>,
    action: impl FnOnce() -> T,
) -> T {
    struct Reset(Option<Admission>);
    impl Drop for Reset {
        fn drop(&mut self) {
            CALL_ADMISSION.with(|value| *value.borrow_mut() = self.0.take());
        }
    }
    let previous = CALL_ADMISSION.with(|value| {
        value.replace(Some((
            serde_json::json!({"source": source, "generation": generation}),
            cancelled,
        )))
    });
    let _reset = Reset(previous);
    action()
}

pub const SURFACE_OPERATIONS: &[&str] = &[
    "app.request",
    "credentials.request",
    "terminal.notify",
    "terminal.show_thread",
    "commands.list",
    "commands.describe",
    "commands.invoke",
    "config.describe",
    "config.set",
    "sessions.ports",
    "terminal.import_file",
    "terminal.image_sample",
    "composer.read",
    "composer.write",
    "composer.suggest",
    "prompts.consent",
    "prompts.submit",
    "prompts.status",
    "prompts.revoke",
    "builtins.invoke",
    "packages.apply",
    "contract.select",
    "terminal.open",
    "terminal.prompt",
    "terminal.pane",
    "terminal.panes",
    "terminal.notice",
    "terminal.blit",
    "terminal.pty",
];

pub const USER_ONLY_OPERATIONS: &[&str] = &[
    "credentials.request",
    "terminal.import_file",
    "builtins.invoke",
    "commands.invoke",
    "config.set",
    "packages.apply",
    "contract.select",
];

pub fn awaits_user(operation: &str, arguments: &Value) -> bool {
    USER_ONLY_OPERATIONS.contains(&operation)
        || operation == "terminal.prompt"
        || (operation == "app.request"
            && arguments["method"]
                .as_str()
                .and_then(crate::app_routes::route)
                .is_some_and(|route| route.confirm))
}

pub type Reply = SyncSender<Result<Value, String>>;

#[derive(Clone)]
pub struct Validity(pub Arc<dyn Fn() -> bool + Send + Sync>);

impl std::fmt::Debug for Validity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Validity(..)")
    }
}

#[derive(Clone, Debug, Default)]
pub struct CallLifetime {
    pub admission: Option<Value>,
    upstream_cancelled: Option<Arc<AtomicBool>>,
    cancelled: Arc<AtomicBool>,
    phase: Arc<AtomicU8>,
    deadline: Arc<Mutex<Option<Instant>>>,
    pub binding: Option<Value>,
}

const QUEUED: u8 = 0;
const EXECUTING: u8 = 1;
const CANCELLED: u8 = 2;

impl CallLifetime {
    pub fn active(&self) -> bool {
        self.phase.load(Ordering::Acquire) != CANCELLED
            && !self.cancelled.load(Ordering::Acquire)
            && !self
                .upstream_cancelled
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::Acquire))
            && self
                .deadline
                .lock()
                .is_ok_and(|deadline| deadline.is_none_or(|deadline| Instant::now() < deadline))
    }

    pub fn begin_execution(&self) -> Result<(), String> {
        if !self.active() {
            return Err("callback_cancelled_or_expired".into());
        }
        self.phase
            .compare_exchange(QUEUED, EXECUTING, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| "callback_cancelled_or_executing".into())
    }

    fn cancel_queued(&self) -> bool {
        self.phase
            .compare_exchange(QUEUED, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}

pub struct PendingReply {
    receiver: Receiver<Result<Value, String>>,
    lifetime: CallLifetime,
}

impl Drop for PendingReply {
    fn drop(&mut self) {
        self.lifetime.cancel_queued();
        self.lifetime.cancelled.store(true, Ordering::Release);
    }
}

impl std::ops::Deref for PendingReply {
    type Target = Receiver<Result<Value, String>>;
    fn deref(&self) -> &Self::Target {
        &self.receiver
    }
}

static EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static ADMISSION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn admission() -> u64 {
    ADMISSION.load(std::sync::atomic::Ordering::Acquire)
}

pub fn advance_admission() -> u64 {
    ADMISSION.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1
}

pub fn epoch() -> u64 {
    EPOCH.load(std::sync::atomic::Ordering::Acquire)
}

pub fn set_epoch(epoch: u64) {
    EPOCH.store(epoch, std::sync::atomic::Ordering::Release);
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Authority {
    pub epoch: u64,
    pub admission: u64,
    pub configuration: String,
    pub source: String,
}

thread_local! {
    static AUTHORITY: std::cell::RefCell<Option<Authority>> = const { std::cell::RefCell::new(None) };
}

pub struct AuthorityGuard(Option<Authority>);

impl Authority {
    pub fn enter(self) -> AuthorityGuard {
        AuthorityGuard(AUTHORITY.replace(Some(self)))
    }
}

impl Drop for AuthorityGuard {
    fn drop(&mut self) {
        AUTHORITY.set(self.0.take());
    }
}

#[derive(Debug, Clone)]
pub struct SurfaceCall {
    pub validity: Validity,
    pub caller: String,
    pub operation: String,
    pub arguments: Value,
    pub context: InvocationContext,
    /// Caused by an attached client's action or event rather than the local user.
    pub remote: bool,
    pub thread: Option<String>,
    pub authority: Option<Authority>,
    pub confirm: Option<String>,
    pub reply: Reply,
    pub lifetime: CallLifetime,
}

/// Operations only the user at the terminal may cause, never an attached client.
pub fn needs_terminal(operation: &str, arguments: &Value) -> bool {
    USER_ONLY_OPERATIONS.contains(&operation)
        || operation == "prompts.consent"
        || (operation == "terminal.pty" && arguments["action"] == "start")
}

pub fn needs_terminal_error(operation: &str) -> String {
    format!(
        "client_surface_operation_unavailable: {operation} needs the terminal (/omd) or omd-mod"
    )
}

pub trait ClientSurface: Send + Sync {
    fn submit(&self, call: SurfaceCall) -> Result<(), String>;

    fn redraw(&self) {}

    fn client(&self) -> Value {
        Value::Null
    }
}

pub type Wake = Arc<dyn Fn() + Send + Sync>;

pub type Observer = Arc<dyn Fn(Observed) + Send + Sync>;

const MIRRORED_OPERATIONS: &[&str] = &["terminal.notify", "terminal.notice", "terminal.blit"];

#[derive(Clone, Debug, Serialize)]
pub struct ClientEntry {
    pub id: String,
    pub name: String,
    pub renderer: Value,
    pub viewport: Value,
    pub operations: Vec<String>,
    pub attached_ms: u64,
    pub focused: bool,
}

#[derive(Clone, Debug)]
pub enum Observed {
    Redraw,
    Roster,
    Mirrored {
        caller: String,
        operation: String,
        arguments: Value,
    },
}

#[derive(Default)]
struct Hub {
    surface: Option<(u64, Arc<dyn ClientSurface>)>,
    wake: Option<(u64, Wake)>,
    clients: Vec<(u64, ClientEntry)>,
    observers: Vec<(u64, Observer)>,
    next: u64,
}

static SCREEN: Mutex<Option<&'static str>> = Mutex::new(None);

/// Records whether the terminal client draws on the alternate screen (`fullscreen`) or `inline`.
pub fn set_screen(screen: &'static str) {
    *SCREEN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(screen);
}

pub fn presented(mut presentation: Value) -> Value {
    let screen = *SCREEN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let (Some(fields), Some(screen)) = (presentation.as_object_mut(), screen) {
        fields.insert("surface".into(), screen.into());
    }
    presentation
}

static HUB: Mutex<Hub> = Mutex::new(Hub {
    surface: None,
    wake: None,
    clients: Vec::new(),
    observers: Vec::new(),
    next: 0,
});

fn hub() -> std::sync::MutexGuard<'static, Hub> {
    HUB.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

enum Slot {
    Surface,
    Wake,
    Client,
    Observer,
}

#[must_use]
pub struct Registration {
    id: u64,
    slot: Slot,
}

impl Drop for Registration {
    fn drop(&mut self) {
        let id = self.id;
        let mut hub = hub();
        match self.slot {
            Slot::Surface => drop(hub.surface.take_if(|(slot, _)| *slot == id)),
            Slot::Wake => drop(hub.wake.take_if(|(slot, _)| *slot == id)),
            Slot::Observer => hub.observers.retain(|(slot, _)| *slot != id),
            Slot::Client => {
                let attached = hub.clients.len();
                hub.clients.retain(|(slot, _)| *slot != id);
                if hub.clients.len() != attached {
                    drop(hub);
                    roster_changed();
                }
            }
        }
    }
}

fn insert(slot: Slot, add: impl FnOnce(&mut Hub, u64)) -> Registration {
    let mut hub = hub();
    hub.next += 1;
    let id = hub.next;
    add(&mut hub, id);
    Registration { id, slot }
}

pub fn register(surface: Arc<dyn ClientSurface>) -> Registration {
    insert(Slot::Surface, |hub, id| hub.surface = Some((id, surface)))
}

pub fn register_wake(wake: Wake) -> Registration {
    insert(Slot::Wake, |hub, id| hub.wake = Some((id, wake)))
}

pub fn register_observer(observer: Observer) -> Registration {
    insert(Slot::Observer, |hub, id| hub.observers.push((id, observer)))
}

pub fn attach(entry: ClientEntry) -> Registration {
    let registration = insert(Slot::Client, |hub, id| {
        hub.clients.retain(|(_, attached)| attached.id != entry.id);
        hub.clients.push((id, entry));
    });
    roster_changed();
    registration
}

pub fn update(id: &str, renderer: Option<Value>, viewport: Option<Value>, focused: Option<bool>) {
    {
        let mut hub = hub();
        let Some((_, entry)) = hub.clients.iter_mut().find(|(_, entry)| entry.id == id) else {
            return;
        };
        if let Some(renderer) = renderer {
            entry.renderer = renderer;
        }
        if let Some(viewport) = viewport {
            entry.viewport = viewport;
        }
        if let Some(focused) = focused {
            entry.focused = focused;
        }
    }
    roster_changed();
}

pub fn roster() -> Vec<Value> {
    hub()
        .clients
        .iter()
        .map(|(_, entry)| serde_json::json!(entry))
        .collect()
}

pub fn clients() -> Vec<Value> {
    hub()
        .clients
        .iter()
        .map(|(_, entry)| {
            serde_json::json!({"id": entry.id, "name": entry.name, "renderer": entry.renderer,
                "viewport": entry.viewport, "attached_ms": entry.attached_ms, "focused": entry.focused})
        })
        .collect()
}

pub fn surface_available() -> bool {
    hub().surface.is_some()
}

fn notify(observed: Observed) {
    let observers = hub()
        .observers
        .iter()
        .map(|(_, observer)| observer.clone())
        .collect::<Vec<_>>();
    for observer in observers {
        observer(observed.clone());
    }
}

fn roster_changed() {
    notify(Observed::Roster);
    wake();
}

pub fn wake() {
    let wake = hub().wake.as_ref().map(|(_, wake)| wake.clone());
    if let Some(wake) = wake {
        wake();
    }
}

pub fn redraw() {
    let surface = hub().surface.as_ref().map(|(_, surface)| surface.clone());
    if let Some(surface) = surface {
        surface.redraw();
    }
    notify(Observed::Redraw);
}

pub fn client() -> Value {
    let surface = hub().surface.as_ref().map(|(_, surface)| surface.clone());
    surface.map_or(Value::Null, |surface| surface.client())
}

pub fn submit(
    caller: &str,
    operation: &str,
    arguments: Value,
    context: InvocationContext,
    remote: bool,
    thread: Option<&str>,
    confirm: Option<String>,
) -> Result<PendingReply, String> {
    submit_bound(
        caller,
        operation,
        arguments,
        context,
        remote,
        thread,
        confirm,
        Arc::new(|| true),
    )
}

#[allow(clippy::too_many_arguments)]
fn submit_bound(
    caller: &str,
    operation: &str,
    arguments: Value,
    context: InvocationContext,
    remote: bool,
    thread: Option<&str>,
    confirm: Option<String>,
    active: Arc<dyn Fn() -> bool + Send + Sync>,
) -> Result<PendingReply, String> {
    if !SURFACE_OPERATIONS.contains(&operation) {
        return Err(format!("unsupported_host_operation: {operation}"));
    }
    if context != InvocationContext::User && USER_ONLY_OPERATIONS.contains(&operation) {
        return Err(format!("host_operation_user_only: {operation}"));
    }
    if remote && needs_terminal(operation, &arguments) {
        return Err(needs_terminal_error(operation));
    }
    let surface = hub()
        .surface
        .as_ref()
        .map(|(_, surface)| surface.clone())
        .ok_or("client_surface_unavailable: no interactive client is attached to this host")?;
    let (reply, receiver) = sync_channel(1);
    let admission = CALL_ADMISSION.with(|value| value.borrow().clone());
    let lifetime = CallLifetime {
        admission: admission.as_ref().map(|(binding, _)| binding.clone()),
        upstream_cancelled: admission.and_then(|(_, flag)| flag),
        ..CallLifetime::default()
    };
    if confirm.is_none() && !awaits_user(operation, &arguments) {
        *lifetime
            .deadline
            .lock()
            .map_err(|_| "client_surface_poisoned")? =
            Some(Instant::now() + Duration::from_millis(crate::mods::MOD_CALLBACK_TOTAL_BUDGET_MS));
    }
    let queued = lifetime.clone();
    surface.submit(SurfaceCall {
        validity: Validity(Arc::new(move || queued.active() && active())),
        caller: caller.to_owned(),
        operation: operation.to_owned(),
        arguments,
        context,
        remote,
        thread: thread.map(str::to_owned),
        authority: (operation == "terminal.pty")
            .then(|| AUTHORITY.with_borrow(Clone::clone))
            .flatten(),
        confirm,
        reply,
        lifetime: lifetime.clone(),
    })?;
    Ok(PendingReply { receiver, lifetime })
}

pub fn wait(
    receiver: PendingReply,
    active: &dyn Fn() -> bool,
    deadline: Option<Instant>,
) -> Result<Value, String> {
    if let Some(deadline) = deadline {
        *receiver
            .lifetime
            .deadline
            .lock()
            .map_err(|_| "client_surface_poisoned")? = Some(deadline);
    }
    loop {
        if receiver.lifetime.phase.load(Ordering::Acquire) != EXECUTING
            && !active()
            && receiver.lifetime.cancel_queued()
        {
            return Err("callback_cancelled".into());
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline)
            && receiver.lifetime.cancel_queued()
        {
            return Err(format!(
                "callback_execution_budget: the client did not answer within {} ms",
                crate::mods::MOD_CALLBACK_TOTAL_BUDGET_MS
            ));
        }
        match receiver.receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(result) => return result,
            Err(RecvTimeoutError::Timeout) => (),
            Err(RecvTimeoutError::Disconnected) => {
                return Err("client_surface_closed".into());
            }
        }
    }
}

const VISIBLE_THREADS: usize = 256;

static VISIBLE: Mutex<std::collections::BTreeMap<String, std::collections::VecDeque<String>>> =
    Mutex::new(std::collections::BTreeMap::new());

#[allow(clippy::too_many_arguments)]
pub fn app_request(
    caller: &str,
    capabilities: &[String],
    context: InvocationContext,
    remote: bool,
    thread: Option<&str>,
    repository: &std::path::Path,
    routes: &[(String, String)],
    arguments: Value,
    active: Arc<dyn Fn() -> bool + Send + Sync>,
) -> Result<Value, String> {
    let method = arguments["method"]
        .as_str()
        .ok_or("app_params_invalid: method")?
        .to_owned();
    let roots = crate::app_routes::route(&method)
        .filter(|route| !route.root.is_empty())
        .map(|_| crate::app_routes::session_roots(repository))
        .unwrap_or_default();
    let visible = VISIBLE
        .lock()
        .map_err(|_| "app_visibility_poisoned")?
        .get(caller)
        .map(|threads| threads.iter().cloned().collect())
        .unwrap_or_default();
    let route = crate::app_routes::authorize(
        &method,
        &arguments["params"],
        &crate::app_routes::AppCaller {
            capabilities: &capabilities.iter().cloned().collect(),
            context,
            current_thread: thread,
            visible_threads: &visible,
            roots: &roots,
            routes,
        },
    )
    .map_err(|error| error.to_string())?;
    let confirm = route
        .confirm
        .then(|| confirmation(caller, &method, &arguments["params"]))
        .transpose()?;
    let mut arguments = arguments;
    if method == "thread/rewrite" {
        arguments["params"]
            .as_object_mut()
            .ok_or("app_params_invalid: params must be an object")?
            .insert("author".into(), Value::String(format!("mod:{caller}")));
    }
    let mut value = call(
        caller,
        "app.request",
        arguments,
        context,
        remote,
        thread,
        confirm,
        active,
    )?;
    if method == "config/read" {
        if let Some(config) = value.get_mut("config") {
            redact_config(config);
        }
        for layer in value
            .get_mut("layers")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if let Some(config) = layer.get_mut("config") {
                redact_config(config);
            }
        }
    }
    if matches!(method.as_str(), "thread/start" | "thread/fork")
        && let Some(created) = value["thread"]["id"].as_str()
        && let Ok(mut visible) = VISIBLE.lock()
    {
        let threads = visible.entry(caller.to_owned()).or_default();
        if threads.len() >= VISIBLE_THREADS {
            threads.pop_front();
        }
        threads.push_back(created.to_owned());
    }
    Ok(value)
}

const MANAGED_SOURCES: &[&str] = &[
    "mdm",
    "system",
    "enterpriseManaged",
    "legacyManagedConfigTomlFromFile",
    "legacyManagedConfigTomlFromMdm",
];

/// Config rows for `config.describe`: host-writable Codex keys from a `config/read` result plus mod settings.
/// `packages` is a `packages.list` result; its enabled mods' settings become `mods.<id>.<name>` rows.
pub fn config_rows(read: &Value, packages: &Value) -> Vec<Value> {
    let mut rows = Vec::new();
    for package in packages["packages"].as_array().into_iter().flatten() {
        let id = package["id"].as_str().unwrap_or_default();
        if package["effective"] != true {
            continue;
        }
        for (name, property) in package["settings_schema"]["properties"]
            .as_object()
            .into_iter()
            .flatten()
        {
            rows.push(serde_json::json!({"key": format!("mods.{id}.{name}"), "label": format!("{id} {name}"),
                "value": package["settings"][name], "source": "mod_settings", "version": Value::Null,
                "scope": "mod", "type": property["type"], "enum": property["enum"],
                "editable": true, "managed": false, "secret": false, "hidden": false}));
        }
    }
    let mut config = read["config"].clone();
    redact_config(&mut config);
    for key in crate::app_routes::writable_config_keys() {
        let pointer = format!("/{}", key.replace('.', "/"));
        let Some(value) = config.pointer(&pointer).filter(|value| !value.is_object()) else {
            continue;
        };
        let origin = &read["origins"][key];
        let source = origin["name"]["type"].as_str().unwrap_or("default");
        let managed = MANAGED_SOURCES.contains(&source);
        let secret = value == "<redacted>";
        rows.push(serde_json::json!({"key": key, "label": key,
            "value": if secret { Value::from("<redacted>") } else { value.clone() },
            "source": source, "version": origin["version"], "scope": "codex",
            "editable": !managed && !secret
                && matches!(source, "user" | "packagedDefaults" | "default")
                && crate::app_routes::check_config_key(key).is_ok(),
            "managed": managed, "secret": secret, "hidden": false}));
    }
    rows.truncate(200);
    rows
}

fn redact_config(config: &mut Value) {
    for (table, maps, values, url) in [
        (
            "mcp_servers",
            &["env", "http_headers"][..],
            &["/bearer_token", "/oauth/client_secret"][..],
            "url",
        ),
        (
            "model_providers",
            &["http_headers", "query_params"][..],
            &["/experimental_bearer_token"][..],
            "base_url",
        ),
    ] {
        for entry in config
            .get_mut(table)
            .and_then(Value::as_object_mut)
            .into_iter()
            .flat_map(|entries| entries.values_mut())
        {
            for map in maps {
                for value in entry
                    .get_mut(*map)
                    .and_then(Value::as_object_mut)
                    .into_iter()
                    .flat_map(|map| map.values_mut())
                {
                    *value = Value::from("<redacted>");
                }
            }
            for pointer in values {
                if let Some(value) = entry.pointer_mut(pointer).filter(|value| !value.is_null()) {
                    *value = Value::from("<redacted>");
                }
            }
            if let Some(value) = entry.get_mut(url)
                && let Some(redacted) = value.as_str().map(redact_url)
            {
                *value = Value::from(redacted);
            }
        }
    }
}

fn redact_url(url: &str) -> String {
    let (scheme, rest) = url.split_once("://").unwrap_or(("", url));
    let (authority, tail) = rest.split_at(rest.find(['/', '?', '#']).unwrap_or(rest.len()));
    let authority = authority.rsplit_once('@').map_or_else(
        || authority.to_owned(),
        |(_, host)| format!("<redacted>@{host}"),
    );
    let tail = if tail.is_empty() || tail == "/" {
        tail
    } else {
        "/<redacted>"
    };
    if scheme.is_empty() {
        format!("{authority}{tail}")
    } else {
        format!("{scheme}://{authority}{tail}")
    }
}

fn confirmation(caller: &str, method: &str, params: &Value) -> Result<String, String> {
    if params.is_null() {
        return Ok(format!("Mod {caller} requests {method}."));
    }
    let detail = params.to_string();
    if detail.len() > 2000 {
        return Err(format!("app_confirmation_too_large: {method}"));
    }
    Ok(format!("Mod {caller} requests {method} with {detail}."))
}

#[allow(clippy::too_many_arguments)]
pub fn call(
    caller: &str,
    operation: &str,
    arguments: Value,
    context: InvocationContext,
    remote: bool,
    thread: Option<&str>,
    confirm: Option<String>,
    active: Arc<dyn Fn() -> bool + Send + Sync>,
) -> Result<Value, String> {
    if !active() {
        return Err("callback_cancelled".into());
    }
    let deadline = (confirm.is_none() && !awaits_user(operation, &arguments))
        .then(|| Instant::now() + Duration::from_millis(crate::mods::MOD_CALLBACK_TOTAL_BUDGET_MS));
    let mirrored = MIRRORED_OPERATIONS
        .contains(&operation)
        .then(|| arguments.clone());
    let answer = wait(
        submit_bound(
            caller,
            operation,
            arguments,
            context,
            remote,
            thread,
            confirm,
            active.clone(),
        )?,
        active.as_ref(),
        deadline,
    )?;
    if let Some(arguments) = mirrored.filter(|_| answer["status"] != "backpressure") {
        notify(Observed::Mirrored {
            caller: caller.to_owned(),
            operation: operation.to_owned(),
            arguments,
        });
    }
    Ok(answer)
}

/// The caller's scoped resource store, bound to its active package from `mod-status.json`.
pub fn resource_host(
    store: &std::path::Path,
    repository: &std::path::Path,
    caller: &str,
    thread: Option<&str>,
) -> Result<crate::scoped_data::ScopedDataHost, String> {
    let status = store.join("mod-status.json");
    let metadata = std::fs::symlink_metadata(&status).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || metadata.len() > 262_144 {
        return Err(format!(
            "unsafe or oversized Oh My Diff file: {}",
            status.display()
        ));
    }
    let source = serde_json::from_slice::<Value>(
        &std::fs::read(&status).map_err(|error| error.to_string())?,
    )
    .ok()
    .and_then(|status| {
        status["mods"].as_array()?.iter().find_map(|item| {
            (item["id"] == caller).then(|| item["sha256"].as_str().map(str::to_owned))?
        })
    })
    .ok_or("host_caller_inactive")?;
    crate::scoped_data::ScopedDataHost::new(
        store.to_path_buf(),
        repository.to_path_buf(),
        None,
        None,
        caller.to_owned(),
        thread.unwrap_or("user").to_owned(),
        source,
    )
    .map_err(|error| error.to_string())
}

/// Writes a referenced image resource under `<store>/attachments` and returns its path.
pub fn materialize(
    store: &std::path::Path,
    repository: &std::path::Path,
    caller: &str,
    thread: Option<&str>,
    reference: &Value,
) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let host = resource_host(store, repository, caller, thread)?;
    let resources = host.resources();
    let reference: crate::resource_data::ResourceRef =
        serde_json::from_value(reference.clone()).map_err(|error| error.to_string())?;
    let record = resources
        .load(&reference, "evidence")
        .map_err(|error| error.to_string())?;
    let extension = match record["media_type"].as_str() {
        Some("image/png") => "png",
        Some("image/jpeg") => "jpg",
        _ => return Err("resource_not_image".into()),
    };
    let digest = record["blob"].as_str().ok_or("resource_not_binary")?;
    let bytes = resources.blob(digest).map_err(|error| error.to_string())?;
    let directory = store.join("attachments");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let path = directory.join(format!("{digest}.{extension}"));
    if !path.exists() {
        std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    }
    Ok(path)
}

/// Rewrites `app.request` params: `localImage` resource references become materialized paths.
pub fn translate_images(
    store: &std::path::Path,
    repository: &std::path::Path,
    caller: &str,
    thread: Option<&str>,
    value: &mut Value,
) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            if matches!(
                object.get("type").and_then(Value::as_str),
                Some("localImage" | "localAudio")
            ) && object.contains_key("path")
            {
                return Err("local_path_refused: attach a resource reference".into());
            }
            if let Some(resource) = object.remove("resource") {
                if object.get("type").and_then(Value::as_str) != Some("localImage") {
                    return Err("resource_field_requires_local_image".into());
                }
                let path = materialize(store, repository, caller, thread, &resource)?;
                object.insert(
                    "path".into(),
                    Value::String(path.to_string_lossy().into_owned()),
                );
            }
            object
                .values_mut()
                .try_for_each(|value| translate_images(store, repository, caller, thread, value))
        }
        Value::Array(items) => items
            .iter_mut()
            .try_for_each(|value| translate_images(store, repository, caller, thread, value)),
        _ => Ok(()),
    }
}

#[cfg(test)]
#[path = "client_surface_tests.rs"]
mod tests;
