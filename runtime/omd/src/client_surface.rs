use crate::app_routes::InvocationContext;
use serde_json::Value;
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const SURFACE_OPERATIONS: &[&str] = &[
    "app.request",
    "credentials.request",
    "terminal.notify",
    "terminal.show_thread",
    "terminal.import_file",
    "terminal.image_sample",
    "composer.read",
    "composer.write",
    "builtins.invoke",
    "packages.apply",
    "terminal.open",
    "terminal.prompt",
    "terminal.pty",
];

pub const USER_ONLY_OPERATIONS: &[&str] = &[
    "credentials.request",
    "terminal.import_file",
    "builtins.invoke",
    "packages.apply",
];

pub type Reply = SyncSender<Result<Value, String>>;

#[derive(Debug)]
pub struct SurfaceCall {
    pub caller: String,
    pub operation: String,
    pub arguments: Value,
    pub context: InvocationContext,
    pub thread: Option<String>,
    pub confirm: Option<String>,
    pub reply: Reply,
}

pub trait ClientSurface: Send + Sync {
    fn submit(&self, call: SurfaceCall) -> Result<(), String>;
}

pub type Wake = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct Hub {
    surface: Option<(u64, Arc<dyn ClientSurface>)>,
    wake: Option<(u64, Wake)>,
    next: u64,
}

static HUB: Mutex<Hub> = Mutex::new(Hub {
    surface: None,
    wake: None,
    next: 0,
});

fn hub() -> std::sync::MutexGuard<'static, Hub> {
    HUB.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[must_use]
pub struct Registration {
    id: u64,
    wake: bool,
}

impl Drop for Registration {
    fn drop(&mut self) {
        let mut hub = hub();
        let slot_id = if self.wake {
            hub.wake.as_ref().map(|(id, _)| *id)
        } else {
            hub.surface.as_ref().map(|(id, _)| *id)
        };
        if slot_id == Some(self.id) {
            if self.wake {
                hub.wake = None;
            } else {
                hub.surface = None;
            }
        }
    }
}

pub fn register(surface: Arc<dyn ClientSurface>) -> Registration {
    let mut hub = hub();
    hub.next += 1;
    let id = hub.next;
    hub.surface = Some((id, surface));
    Registration { id, wake: false }
}

pub fn register_wake(wake: Wake) -> Registration {
    let mut hub = hub();
    hub.next += 1;
    let id = hub.next;
    hub.wake = Some((id, wake));
    Registration { id, wake: true }
}

pub fn wake() {
    let wake = hub().wake.as_ref().map(|(_, wake)| wake.clone());
    if let Some(wake) = wake {
        wake();
    }
}

pub fn submit(
    caller: &str,
    operation: &str,
    arguments: Value,
    context: InvocationContext,
    thread: Option<&str>,
    confirm: Option<String>,
) -> Result<Receiver<Result<Value, String>>, String> {
    if !SURFACE_OPERATIONS.contains(&operation) {
        return Err(format!("unsupported_host_operation: {operation}"));
    }
    if context != InvocationContext::User && USER_ONLY_OPERATIONS.contains(&operation) {
        return Err(format!("host_operation_user_only: {operation}"));
    }
    let surface = hub()
        .surface
        .as_ref()
        .map(|(_, surface)| surface.clone())
        .ok_or("client_surface_unavailable: no interactive client is attached to this host")?;
    let (reply, receiver) = sync_channel(1);
    surface.submit(SurfaceCall {
        caller: caller.to_owned(),
        operation: operation.to_owned(),
        arguments,
        context,
        thread: thread.map(str::to_owned),
        confirm,
        reply,
    })?;
    Ok(receiver)
}

pub fn wait(
    receiver: Receiver<Result<Value, String>>,
    active: &dyn Fn() -> bool,
) -> Result<Value, String> {
    loop {
        if !active() {
            return Err("callback_cancelled".into());
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(result) => return result,
            Err(RecvTimeoutError::Timeout) => (),
            Err(RecvTimeoutError::Disconnected) => {
                return Err("client_surface_closed".into());
            }
        }
    }
}

const VISIBLE_THREADS: usize = 256;

static VISIBLE: Mutex<std::collections::BTreeMap<String, std::collections::BTreeSet<String>>> =
    Mutex::new(std::collections::BTreeMap::new());

#[allow(clippy::too_many_arguments)]
pub fn app_request(
    caller: &str,
    capabilities: &[String],
    context: InvocationContext,
    thread: Option<&str>,
    repository: &std::path::Path,
    routes: &[(String, String)],
    arguments: Value,
    active: &dyn Fn() -> bool,
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
        .cloned()
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
        .then(|| format!("Mod {caller} requests {method}."));
    let value = call(
        caller,
        "app.request",
        arguments,
        context,
        thread,
        confirm,
        active,
    )?;
    if matches!(method.as_str(), "thread/start" | "thread/fork")
        && let Some(created) = value["thread"]["id"].as_str()
        && let Ok(mut visible) = VISIBLE.lock()
    {
        let threads = visible.entry(caller.to_owned()).or_default();
        if threads.len() < VISIBLE_THREADS {
            threads.insert(created.to_owned());
        }
    }
    Ok(value)
}

pub fn call(
    caller: &str,
    operation: &str,
    arguments: Value,
    context: InvocationContext,
    thread: Option<&str>,
    confirm: Option<String>,
    active: &dyn Fn() -> bool,
) -> Result<Value, String> {
    wait(
        submit(caller, operation, arguments, context, thread, confirm)?,
        active,
    )
}

#[cfg(test)]
#[path = "client_surface_tests.rs"]
mod tests;
