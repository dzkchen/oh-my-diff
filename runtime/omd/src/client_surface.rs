use crate::app_routes::InvocationContext;
use serde_json::Value;
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

    fn redraw(&self) {}
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

pub fn redraw() {
    let surface = hub().surface.as_ref().map(|(_, surface)| surface.clone());
    if let Some(surface) = surface {
        surface.redraw();
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
    deadline: Option<Instant>,
) -> Result<Value, String> {
    loop {
        if !active() {
            return Err("callback_cancelled".into());
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return Err(format!(
                "callback_execution_budget: the client did not answer within {} ms",
                crate::mods::MOD_CALLBACK_TOTAL_BUDGET_MS
            ));
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

static VISIBLE: Mutex<std::collections::BTreeMap<String, std::collections::VecDeque<String>>> =
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
    let mut value = call(
        caller,
        "app.request",
        arguments,
        context,
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

pub fn call(
    caller: &str,
    operation: &str,
    arguments: Value,
    context: InvocationContext,
    thread: Option<&str>,
    confirm: Option<String>,
    active: &dyn Fn() -> bool,
) -> Result<Value, String> {
    let deadline = (confirm.is_none() && !awaits_user(operation, &arguments))
        .then(|| Instant::now() + Duration::from_millis(crate::mods::MOD_CALLBACK_TOTAL_BUDGET_MS));
    wait(
        submit(caller, operation, arguments, context, thread, confirm)?,
        active,
        deadline,
    )
}

#[cfg(test)]
#[path = "client_surface_tests.rs"]
mod tests;
