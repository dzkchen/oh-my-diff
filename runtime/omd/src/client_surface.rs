use crate::app_routes::InvocationContext;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;
use serde_json::Value;
use sha2::Digest as _;
use sha2::Sha256;
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

pub fn current_generation() -> Option<u64> {
    CALL_ADMISSION.with(|value| {
        value
            .borrow()
            .as_ref()
            .and_then(|(binding, _)| binding["generation"].as_u64())
    })
}

pub const SURFACE_OPERATIONS: &[&str] = &[
    "app.request",
    "app.respond",
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
    "terminal.selection",
    "terminal.copy",
    "terminal.blit",
    "terminal.pty",
];

pub const USER_ONLY_OPERATIONS: &[&str] = &[
    "terminal.selection",
    "terminal.copy",
    "credentials.request",
    "terminal.import_file",
    "builtins.invoke",
    "commands.invoke",
    "config.set",
    "packages.apply",
    "contract.select",
];

pub fn awaits_user(operation: &str, arguments: &Value) -> bool {
    (USER_ONLY_OPERATIONS.contains(&operation)
        && !matches!(operation, "terminal.selection" | "terminal.copy"))
        || operation == "terminal.prompt"
        || (operation == "app.request"
            && arguments["method"]
                .as_str()
                .and_then(crate::app_routes::route)
                .is_some_and(|route| route.confirm))
}

pub type Reply = SyncSender<Result<Value, String>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlitErrorKind {
    Retryable,
    Revoked,
    Fatal,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlitError {
    pub kind: BlitErrorKind,
    pub message: String,
}

impl BlitError {
    pub fn new(kind: BlitErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
    pub fn retryable(message: impl Into<String>) -> Self {
        Self::new(BlitErrorKind::Retryable, message)
    }
    pub fn fatal(message: impl Into<String>) -> Self {
        Self::new(BlitErrorKind::Fatal, message)
    }
}

impl From<String> for BlitError {
    fn from(message: String) -> Self {
        Self::fatal(message)
    }
}
impl From<&str> for BlitError {
    fn from(message: &str) -> Self {
        Self::fatal(message)
    }
}
impl std::fmt::Display for BlitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}
impl std::error::Error for BlitError {}

#[derive(Clone)]
pub struct Validity(pub Arc<dyn Fn() -> bool + Send + Sync>);

impl std::fmt::Debug for Validity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Validity(..)")
    }
}

#[derive(Clone, Debug, Default)]
pub struct CallLifetime {
    blit_error: Arc<std::sync::OnceLock<BlitErrorKind>>,
    pub admission: Option<Value>,
    pub pixels: Arc<std::sync::OnceLock<Arc<crate::process_raster::PixelFrame>>>,
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

thread_local! {
    static DEPTH: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub struct DepthGuard(usize);

/// Surface calls submitted from this thread run inside `depth` others until the guard drops.
pub fn nest(depth: usize) -> DepthGuard {
    DepthGuard(DEPTH.replace(depth))
}

impl Drop for DepthGuard {
    fn drop(&mut self) {
        DEPTH.set(self.0);
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
    /// How many surface calls this one runs inside, as set by `nest`.
    pub depth: usize,
}

impl SurfaceCall {
    pub fn reply_blit(&self, result: Result<Value, BlitError>) {
        if let Err(error) = &result {
            let _ = self.lifetime.blit_error.set(error.kind);
        }
        let _ = self.reply.send(result.map_err(|error| error.message));
    }

    pub fn snapshot_pixels(
        &self,
        source: &crate::process_raster::PixelSource,
        next: std::time::Instant,
    ) -> Result<Arc<crate::process_raster::PixelFrame>, BlitError> {
        if !(self.validity.0)() {
            return Err(BlitError::retryable("callback_cancelled_or_expired"));
        }
        self.lifetime
            .begin_execution()
            .map_err(BlitError::retryable)?;
        let component = self.arguments["key"]
            .as_str()
            .ok_or("terminal_blit_invalid")?;
        let snapshot = || {
            crate::process_raster::snapshot(
                self.thread.as_deref(),
                &self.caller,
                component,
                source.clone(),
                next,
            )
        };
        let pixels = if let Some(admission) = &self.lifetime.admission {
            with_admission(
                admission["source"].as_str().unwrap_or_default(),
                admission["generation"]
                    .as_u64()
                    .ok_or_else(|| BlitError::retryable("client_surface_admission_changed"))?,
                None,
                snapshot,
            )?
        } else {
            snapshot()?
        };
        let _ = self.lifetime.pixels.set(pixels.clone());
        Ok(pixels)
    }
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
        pixels: Option<Arc<crate::process_raster::PixelFrame>>,
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
    .map_err(|error| error.message)
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
) -> Result<PendingReply, BlitError> {
    if !SURFACE_OPERATIONS.contains(&operation) {
        return Err(BlitError::fatal(format!(
            "unsupported_host_operation: {operation}"
        )));
    }
    if context != InvocationContext::User && USER_ONLY_OPERATIONS.contains(&operation) {
        return Err(BlitError::fatal(format!(
            "host_operation_user_only: {operation}"
        )));
    }
    if remote && needs_terminal(operation, &arguments) {
        return Err(BlitError::fatal(needs_terminal_error(operation)));
    }
    let surface = hub()
        .surface
        .as_ref()
        .map(|(_, surface)| surface.clone())
        .ok_or_else(|| {
            BlitError::retryable(
                "client_surface_unavailable: no interactive client is attached to this host",
            )
        })?;
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
    surface
        .submit(SurfaceCall {
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
            depth: DEPTH.get(),
        })
        .map_err(BlitError::retryable)?;
    Ok(PendingReply { receiver, lifetime })
}

pub fn wait(
    receiver: PendingReply,
    active: &dyn Fn() -> bool,
    deadline: Option<Instant>,
) -> Result<Value, String> {
    wait_classified(receiver, active, deadline).map_err(|error| error.message)
}

fn wait_classified(
    receiver: PendingReply,
    active: &dyn Fn() -> bool,
    deadline: Option<Instant>,
) -> Result<Value, BlitError> {
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
            return Err(BlitError::retryable("callback_cancelled"));
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline)
            && receiver.lifetime.cancel_queued()
        {
            return Err(BlitError::retryable(format!(
                "callback_execution_budget: the client did not answer within {} ms",
                crate::mods::MOD_CALLBACK_TOTAL_BUDGET_MS
            )));
        }
        match receiver.receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(result) => {
                return result.map_err(|message| {
                    BlitError::new(
                        receiver
                            .lifetime
                            .blit_error
                            .get()
                            .copied()
                            .unwrap_or(BlitErrorKind::Fatal),
                        message,
                    )
                });
            }
            Err(RecvTimeoutError::Timeout) => (),
            Err(RecvTimeoutError::Disconnected) => {
                return Err(BlitError::retryable("client_surface_closed"));
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
    redact_result(&method, &mut value);
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

fn redact_result(method: &str, value: &mut Value) {
    match method {
        "config/read" => {
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
        "hooks/list" => scrub_secrets(value, ""),
        _ => {}
    }
}

fn redact_config(config: &mut Value) {
    for (table, url) in [("mcp_servers", "url"), ("model_providers", "base_url")] {
        for value in config
            .get_mut(table)
            .and_then(Value::as_object_mut)
            .into_iter()
            .flat_map(|entries| entries.values_mut())
            .filter_map(|entry| entry.get_mut(url))
        {
            if let Some(redacted) = value.as_str().map(redact_url) {
                *value = Value::from(redacted);
            }
        }
    }
    if let Some(set) = config.pointer_mut("/shell_environment_policy/set") {
        redact_all(set);
    }
    scrub_secrets(config, "");
}

/// Redacts header, environment and query maps, launch arguments, secret-named strings and secret-looking lines;
/// `env_key` stays readable only while it looks like an upper-case variable name with an underscore.
fn scrub_secrets(value: &mut Value, name: &str) {
    match value {
        Value::Object(map) => {
            let launches = map.contains_key("command");
            for (key, value) in map.iter_mut() {
                if key.ends_with("headers")
                    || matches!(key.as_str(), "env" | "query_params")
                    || (launches && key == "args")
                {
                    redact_all(value);
                } else if key == "env_key" && value.is_string() {
                    if !value.as_str().is_some_and(|name| {
                        name.bytes()
                            .next()
                            .is_some_and(|byte| !byte.is_ascii_digit())
                            && name.contains('_')
                            && name.bytes().all(|byte| {
                                byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                            })
                    }) {
                        *value = Value::from("<redacted>");
                    }
                } else {
                    scrub_secrets(value, key);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| scrub_secrets(item, name)),
        Value::String(text) => {
            let mut segments = name.rsplit(['_', '-']);
            let last = segments.next().unwrap_or_default();
            let named = match segments.next() {
                Some(previous) if last == "key" => format!("{previous}_key"),
                _ => last.to_owned(),
            };
            let redacted = crate::resource_data::redact(text);
            if crate::resource_data::contains_secret(&format!("{named}=x")) {
                *value = Value::from("<redacted>");
            } else if redacted != *text {
                *value = Value::from(redacted.replace("[redacted]", "<redacted>"));
            }
        }
        _ => {}
    }
}

fn redact_all(value: &mut Value) {
    match value {
        Value::Object(map) => map.values_mut().for_each(redact_all),
        Value::Array(items) => items.iter_mut().for_each(redact_all),
        Value::Null => {}
        _ => *value = Value::from("<redacted>"),
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
    call_classified(
        caller, operation, arguments, context, remote, thread, confirm, active,
    )
    .map_err(|error| error.message)
}

#[allow(clippy::too_many_arguments)]
pub fn call_classified(
    caller: &str,
    operation: &str,
    arguments: Value,
    context: InvocationContext,
    remote: bool,
    thread: Option<&str>,
    confirm: Option<String>,
    active: Arc<dyn Fn() -> bool + Send + Sync>,
) -> Result<Value, BlitError> {
    if !active() {
        return Err(BlitError::retryable("callback_cancelled"));
    }
    let deadline = (confirm.is_none() && !awaits_user(operation, &arguments))
        .then(|| Instant::now() + Duration::from_millis(crate::mods::MOD_CALLBACK_TOTAL_BUDGET_MS));
    let mirrored = (MIRRORED_OPERATIONS.contains(&operation) && !hub().observers.is_empty())
        .then(|| arguments.clone());
    let pending = submit_bound(
        caller,
        operation,
        arguments,
        context,
        remote,
        thread,
        confirm,
        active.clone(),
    )?;
    let pixels = pending.lifetime.pixels.clone();
    let answer = wait_classified(pending, active.as_ref(), deadline)?;
    if let Some(arguments) = mirrored.filter(|_| answer["status"] != "backpressure") {
        notify(Observed::Mirrored {
            caller: caller.to_owned(),
            operation: operation.to_owned(),
            arguments,
            pixels: pixels.get().cloned(),
        });
    }
    Ok(answer)
}

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

pub fn materialize(
    store: &std::path::Path,
    repository: &std::path::Path,
    caller: &str,
    thread: Option<&str>,
    reference: &Value,
) -> Result<std::path::PathBuf, String> {
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
    let directory =
        crate::workspace::private_path(store, &["attachments"], "attachment_directory_invalid")
            .map_err(|error| error.to_string())?;
    let path = directory.join(format!("{digest}.{extension}"));
    if !path.exists() {
        let mut temporary =
            tempfile::NamedTempFile::new_in(&directory).map_err(|error| error.to_string())?;
        std::io::Write::write_all(&mut temporary, &bytes).map_err(|error| error.to_string())?;
        temporary
            .persist(&path)
            .map_err(|error| error.error.to_string())?;
    }
    Ok(path)
}

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

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NoticePlacement {
    Toast,
    Status,
}

#[derive(Debug, PartialEq)]
pub enum NoticeRequest<'a> {
    Clear {
        id: &'a str,
    },
    Transient {
        id: Option<&'a str>,
        kind: &'static str,
        placement: NoticePlacement,
        text: &'a str,
        ttl: Duration,
    },
    Transcript {
        kind: &'static str,
        text: &'a str,
        model: bool,
        call_id: Option<&'a str>,
    },
}

pub fn notice_request(arguments: &Value) -> Result<NoticeRequest<'_>, String> {
    let invalid = || "terminal_notice_invalid".to_owned();
    let one_of = |key: &str, values: &[&'static str]| match &arguments[key] {
        Value::Null => Ok(values[0]),
        value => values
            .iter()
            .find(|known| value == **known)
            .copied()
            .ok_or_else(invalid),
    };
    let kind = one_of("kind", &["info", "warning", "error"])?;
    let placement = match one_of("placement", &["toast", "status", "transcript"])? {
        "toast" => Some(NoticePlacement::Toast),
        "status" => Some(NoticePlacement::Status),
        _ => None,
    };
    let model = one_of("audience", &["user", "model"])? == "model";
    let id = match &arguments["id"] {
        Value::Null => None,
        Value::String(id) if crate::mod_component_id(id) => Some(id.as_str()),
        _ => return Err(invalid()),
    };
    if arguments["clear"] == true {
        return match (id, placement) {
            (Some(id), Some(_)) => Ok(NoticeRequest::Clear { id }),
            _ => Err(invalid()),
        };
    }
    let text = arguments["text"]
        .as_str()
        .filter(|text| {
            !text.trim().is_empty() && text.len() <= 512 && !text.chars().any(char::is_control)
        })
        .ok_or_else(invalid)?;
    match placement {
        Some(placement) => {
            let ttl = match &arguments["ttl_ms"] {
                Value::Null => 5_000,
                value => value
                    .as_u64()
                    .filter(|ttl| (1_000..=60_000).contains(ttl))
                    .ok_or_else(invalid)?,
            };
            if model || !arguments["tool_call_id"].is_null() {
                return Err(invalid());
            }
            Ok(NoticeRequest::Transient {
                id,
                kind,
                placement,
                text,
                ttl: Duration::from_millis(ttl),
            })
        }
        None if !arguments["ttl_ms"].is_null() || id.is_some() => Err(invalid()),
        None => {
            let call_id = match &arguments["tool_call_id"] {
                Value::Null => None,
                Value::String(call_id)
                    if !call_id.is_empty()
                        && call_id.len() <= 128
                        && !call_id.chars().any(char::is_control) =>
                {
                    Some(call_id.as_str())
                }
                _ => return Err(invalid()),
            };
            Ok(NoticeRequest::Transcript {
                kind,
                text,
                model,
                call_id,
            })
        }
    }
}

pub const BLIT_FRAME: Duration = Duration::from_millis(16);
pub const BLIT_QUEUE_UPDATES: usize = 32;
pub const BLIT_QUEUE_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct BlitCell {
    pub symbol: String,
    pub fg: Option<crate::ModColor>,
    pub bg: Option<crate::ModColor>,
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum WireCell {
    Glyph(String),
    Styled(String, Option<crate::ModColor>, Option<crate::ModColor>),
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlitRect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct WireImage {
    media_type: String,
    base64: String,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct WireBlit {
    key: String,
    rect: Option<BlitRect>,
    cells: Option<Vec<WireCell>>,
    image: Option<WireImage>,
    pixels: Option<crate::process_raster::PixelSource>,
}

pub enum BlitContent {
    Source(crate::process_raster::PixelSource),
    Pixels(Arc<crate::process_raster::PixelFrame>),
    Cells {
        rect: BlitRect,
        cells: Vec<BlitCell>,
    },
    Encoded {
        media_type: String,
        base64: String,
    },
    Image {
        sha256: String,
        bytes: Arc<[u8]>,
    },
}

pub struct Blit {
    pub key: String,
    pub content: BlitContent,
    pub bytes: usize,
}

pub const IMAGE_PIXELS: u32 = 4096;

pub fn decode_image(bytes: &[u8]) -> Result<image::DynamicImage, String> {
    let _stage = crate::frame_metrics::stage("decode");
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("image_too_large".into());
    }
    let format = image::guess_format(bytes).map_err(|_| "image_format_unsupported")?;
    if !matches!(format, image::ImageFormat::Png | image::ImageFormat::Jpeg) {
        return Err("image_format_unsupported".into());
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(IMAGE_PIXELS);
    limits.max_image_height = Some(IMAGE_PIXELS);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| "image_invalid_or_too_large".into())
}

pub fn half_block(image: &image::DynamicImage, width: u16, height: u16) -> Vec<Vec<BlitCell>> {
    let _stage = crate::frame_metrics::stage("half_block");
    let pixels = image
        .resize(
            u32::from(width),
            u32::from(height) * 2,
            image::imageops::FilterType::Triangle,
        )
        .to_rgb8();
    let color = |x: u32, y: u32| {
        let [r, g, b] = pixels
            .get_pixel_checked(x, y)
            .map_or([0, 0, 0], |pixel| pixel.0);
        Some(crate::ModColor::Rgb(r, g, b))
    };
    (0..pixels.height().div_ceil(2))
        .map(|row| {
            (0..pixels.width())
                .map(|x| BlitCell {
                    symbol: "▀".to_owned(),
                    fg: color(x, row * 2),
                    bg: color(x, row * 2 + 1),
                })
                .collect()
        })
        .collect()
}

pub fn frame_cells(arguments: &Value, size: (u16, u16)) -> Option<Value> {
    let image = arguments.get("image")?;
    let bytes = STANDARD.decode(image["base64"].as_str()?).ok()?;
    Some(pixel_cells(
        &arguments["key"],
        &decode_image(&bytes).ok()?,
        size,
    ))
}

pub fn pixel_cells(key: &Value, image: &image::DynamicImage, size: (u16, u16)) -> Value {
    let rows = half_block(image, size.0, size.1);
    let cells = (0..usize::from(size.1)).flat_map(|y| {
        let rows = &rows;
        (0..usize::from(size.0)).map(move |x| {
            rows.get(y).and_then(|row| row.get(x)).map_or_else(
                || serde_json::json!(" "),
                |cell| serde_json::json!([cell.symbol, cell.fg, cell.bg]),
            )
        })
    });
    serde_json::json!({
        "key": key,
        "rect": {"x": 0, "y": 0, "width": size.0, "height": size.1},
        "cells": cells.collect::<Vec<_>>(),
    })
}

impl Blit {
    /// Image frames are only header-checked here; pixels are decoded when first drawn.
    pub fn checked(
        mut self,
        snapshot: impl FnOnce(
            &crate::process_raster::PixelSource,
        ) -> Result<Arc<crate::process_raster::PixelFrame>, BlitError>,
    ) -> Result<Self, BlitError> {
        if let BlitContent::Source(source) = &self.content {
            let pixels = snapshot(source)?;
            self.bytes = pixels.source.byte_len()?;
            self.content = BlitContent::Pixels(pixels);
        }
        if let BlitContent::Encoded { media_type, base64 } = &self.content {
            let format = match media_type.as_str() {
                "image/png" => image::ImageFormat::Png,
                "image/jpeg" => image::ImageFormat::Jpeg,
                _ => return Err("terminal_blit_image_invalid".into()),
            };
            let bytes = STANDARD.decode(base64).ok().filter(|bytes| {
                let reader =
                    image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format();
                reader.is_ok_and(|reader| {
                    reader.format() == Some(format)
                        && reader.into_dimensions().is_ok_and(|(width, height)| {
                            (1..=IMAGE_PIXELS).contains(&width)
                                && (1..=IMAGE_PIXELS).contains(&height)
                        })
                })
            });
            let bytes = bytes.ok_or("terminal_blit_image_invalid")?;
            self.content = BlitContent::Image {
                sha256: format!("{:x}", Sha256::digest(&bytes)),
                bytes: bytes.into(),
            };
        }
        Ok(self)
    }
}

/// `terminal.blit` arguments checked against the caller's raster `owner` and `size`; glyph width is the renderer's.
pub fn blit_request(
    caller: &str,
    owner: Option<&str>,
    size: Option<(u16, u16)>,
    arguments: &Value,
) -> Result<Blit, BlitError> {
    let bytes = arguments.to_string().len();
    if bytes > BLIT_QUEUE_BYTES {
        return Err("terminal_blit_too_large".into());
    }
    let blit: WireBlit =
        serde_json::from_value(arguments.clone()).map_err(|_| "terminal_blit_invalid")?;
    let (rect, image, pixels) = match (blit.rect, blit.cells, blit.image, blit.pixels) {
        (Some(rect), Some(cells), None, None) => (Some((rect, cells)), None, None),
        (None, None, Some(image), None) => (None, Some(image), None),
        (None, None, None, Some(pixels)) => (None, None, Some(pixels)),
        _ => return Err("terminal_blit_invalid".into()),
    };
    match owner {
        Some(owner) if owner == caller => {}
        Some(_) => return Err(BlitError::retryable("terminal_blit_not_owned")),
        None => return Err(BlitError::retryable("terminal_blit_unknown")),
    }
    let content = match (rect, image) {
        (Some((rect, cells)), _) => {
            let (width, height) =
                size.ok_or_else(|| BlitError::retryable("terminal_blit_unknown"))?;
            if rect.width == 0
                || rect.height == 0
                || u32::from(rect.x) + u32::from(rect.width) > u32::from(width)
                || u32::from(rect.y) + u32::from(rect.height) > u32::from(height)
                || cells.len() != usize::from(rect.width) * usize::from(rect.height)
            {
                return Err("terminal_blit_invalid".into());
            }
            let cells = cells
                .into_iter()
                .map(|cell| {
                    let (symbol, fg, bg) = match cell {
                        WireCell::Glyph(symbol) => (symbol, None, None),
                        WireCell::Styled(symbol, fg, bg) => (symbol, fg, bg),
                    };
                    (!symbol.is_empty()
                        && symbol.len() <= 16
                        && !symbol.chars().any(char::is_control))
                    .then_some(BlitCell { symbol, fg, bg })
                })
                .collect::<Option<Vec<_>>>()
                .ok_or("terminal_blit_invalid")?;
            BlitContent::Cells { rect, cells }
        }
        (None, Some(image)) => BlitContent::Encoded {
            media_type: image.media_type,
            base64: image.base64,
        },
        (None, None) => BlitContent::Source(pixels.ok_or("terminal_blit_invalid")?),
    };
    Ok(Blit {
        key: blit.key,
        content,
        bytes,
    })
}

#[cfg(test)]
#[path = "client_surface_tests.rs"]
mod tests;
