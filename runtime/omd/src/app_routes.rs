use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub const APP_QUEUE_EVENTS: usize = 256;
pub const APP_QUEUE_BYTES: usize = 1 << 20;

#[derive(Deserialize)]
struct Table {
    requests: BTreeMap<String, AppRoute>,
    notifications: BTreeSet<String>,
    server_requests: BTreeSet<String>,
    authority_config: BTreeSet<String>,
    writable_config: BTreeSet<String>,
    config_subkeys: BTreeMap<String, Vec<String>>,
}

static TABLE: LazyLock<Table> = LazyLock::new(|| {
    serde_json::from_str(include_str!("app_routes.json"))
        .unwrap_or_else(|error| panic!("app route table: {error}"))
});

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InvocationContext {
    User,
    Event,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThreadScope {
    Current,
    Visible,
    Root,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct AppRoute {
    pub class: String,
    pub contexts: Vec<InvocationContext>,
    #[serde(default)]
    pub confirm: bool,
    #[serde(default)]
    pub scope: Option<ThreadScope>,
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default)]
    pub root: Vec<String>,
    #[serde(default)]
    pub route_fields: Vec<String>,
    #[serde(default)]
    pub keys: Option<String>,
}

pub struct AppCaller<'a> {
    pub capabilities: &'a BTreeSet<String>,
    pub context: InvocationContext,
    pub current_thread: Option<&'a str>,
    pub visible_threads: &'a BTreeSet<String>,
    pub roots: &'a [PathBuf],
    pub routes: &'a [(String, String)],
}

fn denied(code: &str, detail: impl std::fmt::Display) -> io::Error {
    io::Error::other(format!("{code}: {detail}"))
}

pub fn route(method: &str) -> Option<&'static AppRoute> {
    TABLE.requests.get(method)
}

pub fn class(capability: &str) -> bool {
    TABLE
        .requests
        .values()
        .any(|route| route.class == capability)
}

pub fn classes_named_in(source: &str) -> Option<BTreeSet<&'static str>> {
    let named: BTreeSet<_> = TABLE
        .requests
        .iter()
        .filter(|(method, _)| {
            ['\'', '"', '`']
                .iter()
                .any(|quote| source.contains(&format!("{quote}{method}{quote}")))
        })
        .map(|(_, route)| route.class.as_str())
        .collect();
    (!named.is_empty()).then_some(named)
}

pub fn routes() -> Value {
    Value::Array(
        TABLE
            .requests
            .iter()
            .map(|(method, route)| {
                json!({
                    "method": method,
                    "class": route.class,
                    "contexts": route.contexts.iter().map(|c| match c { InvocationContext::User => "user", InvocationContext::Event => "event" }).collect::<Vec<_>>(),
                    "confirm": route.confirm,
                })
            })
            .collect(),
    )
}

pub fn unscoped_directory(directory: &Path) -> bool {
    directory.parent().is_none()
        || std::env::var_os("HOME")
            .and_then(|home| Path::new(&home).canonicalize().ok())
            .is_some_and(|home| home == directory)
}

pub fn session_roots(repository: &Path) -> Vec<PathBuf> {
    let mut roots = vec![repository.to_path_buf()];
    let output = std::process::Command::new("git")
        .args([
            "-c",
            "core.fsmonitor=false",
            "worktree",
            "list",
            "--porcelain",
        ])
        .current_dir(repository)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    if let Ok(output) = output
        && output.status.success()
    {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Some(path) = line.strip_prefix("worktree ")
                && let Ok(path) = Path::new(path).canonicalize()
                && !roots.contains(&path)
                && roots.len() < 64
            {
                roots.push(path);
            }
        }
    }
    roots
}

pub fn notification_routed(method: &str) -> bool {
    TABLE.notifications.contains(method)
}

pub fn server_request_routed(method: &str) -> bool {
    TABLE.server_requests.contains(method)
}

/// Approvals and elicitations may only be declined or cancelled (approving needs the `approve` grant), permissions only granted nothing, `requestUserInput` only answered with bounded text.
pub fn response_allowed(method: &str, result: &Value) -> Result<(), String> {
    let refused = |reason: &str| Err(format!("app_response_refused: {reason}"));
    let object = result
        .as_object()
        .ok_or_else(|| "app_response_refused: result must be an object".to_owned())?;
    let only = |keys: &[&str]| object.keys().all(|key| keys.contains(&key.as_str()));
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            if only(&["decision"])
                && matches!(
                    object.get("decision").and_then(Value::as_str),
                    Some("decline" | "cancel")
                )
            {
                Ok(())
            } else {
                refused("approvals accept only {decision: 'decline' | 'cancel'}")
            }
        }
        "item/permissions/requestApproval" => {
            if only(&["permissions"])
                && object
                    .get("permissions")
                    .and_then(Value::as_object)
                    .is_some_and(|value| value.is_empty())
            {
                Ok(())
            } else {
                refused("permission requests accept only {permissions: {}}")
            }
        }
        "mcpServer/elicitation/request" => {
            let empty = |key: &str| object.get(key).is_none_or(Value::is_null);
            if only(&["action", "content", "_meta"])
                && matches!(
                    object.get("action").and_then(Value::as_str),
                    Some("decline" | "cancel")
                )
                && empty("content")
                && empty("_meta")
            {
                Ok(())
            } else {
                refused("elicitations accept only {action: 'decline' | 'cancel'}")
            }
        }
        "item/tool/requestUserInput" => {
            let answers = object.get("answers").and_then(Value::as_object);
            let valid = only(&["answers"])
                && answers.is_some_and(|answers| {
                    answers.len() <= 16
                        && answers.values().all(|answer| {
                            answer.as_object().is_some_and(|answer| {
                                answer.len() == 1
                                    && answer.get("answers").and_then(Value::as_array).is_some_and(
                                        |items| {
                                            items.len() <= 16 && items.iter().all(Value::is_string)
                                        },
                                    )
                            })
                        })
                });
            if !valid {
                refused("requestUserInput accepts only {answers: {id: {answers: string[]}}}")
            } else if result.to_string().len() > 16_384 {
                refused("answers exceed 16384 bytes")
            } else {
                Ok(())
            }
        }
        _ => refused("method is not answerable"),
    }
}

pub fn notification_patterns_match(pattern: &str) -> bool {
    let patterns = [pattern.to_owned()];
    TABLE
        .notifications
        .iter()
        .any(|method| subscribed(&patterns, method))
}

pub fn server_request_patterns_match(pattern: &str) -> bool {
    let patterns = [pattern.to_owned()];
    TABLE
        .server_requests
        .iter()
        .any(|method| subscribed(&patterns, method))
}

pub fn authorize(
    method: &str,
    params: &Value,
    caller: &AppCaller,
) -> io::Result<&'static AppRoute> {
    let route = route(method).ok_or_else(|| denied("app_method_unrouted", method))?;
    if !caller.capabilities.contains(&route.class) {
        return Err(denied("app_capability_missing", &route.class));
    }
    if !route.contexts.contains(&caller.context) {
        return Err(denied("app_context_user_only", method));
    }
    let object = match params {
        Value::Object(object) => object,
        Value::Null => &serde_json::Map::new(),
        _ => return Err(denied("app_params_invalid", "params must be an object")),
    };
    if let Some((field, _)) = object
        .iter()
        .find(|(field, value)| !value.is_null() && !route.fields.contains(field))
    {
        return Err(denied("app_param_refused", field));
    }
    check_thread(route.scope, object.get("threadId"), caller)?;
    if route.scope.is_some() {
        for (_, thread) in object.iter().filter(|(field, value)| {
            field.ends_with("ThreadId") && *field != "threadId" && !value.is_null()
        }) {
            check_thread(Some(ThreadScope::Visible), Some(thread), caller)?;
        }
    }
    for field in &route.root {
        if let Some(value) = object.get(field.as_str()).filter(|v| !v.is_null()) {
            check_root(value, caller.roots)?;
        }
    }
    check_route_fields(route, object, caller.routes)?;
    if let Some(keys) = &route.keys {
        for key in config_keys(keys, object)? {
            check_config_key(&key)?;
        }
    }
    Ok(route)
}

fn check_thread(
    scope: Option<ThreadScope>,
    thread: Option<&Value>,
    caller: &AppCaller,
) -> io::Result<()> {
    let Some(scope) = scope else { return Ok(()) };
    let thread = match thread {
        Some(Value::String(thread)) => thread.as_str(),
        None | Some(Value::Null) if scope == ThreadScope::Root => return Ok(()),
        _ => return Err(denied("app_thread_out_of_scope", "threadId is required")),
    };
    let allowed = match scope {
        ThreadScope::Current => caller.current_thread == Some(thread),
        ThreadScope::Visible | ThreadScope::Root => {
            caller.current_thread == Some(thread) || caller.visible_threads.contains(thread)
        }
    };
    if allowed {
        Ok(())
    } else {
        Err(denied("app_thread_out_of_scope", thread))
    }
}

fn check_root(value: &Value, roots: &[PathBuf]) -> io::Result<()> {
    let path = match value {
        Value::Array(paths) if !paths.is_empty() && paths.len() <= 16 => {
            return paths.iter().try_for_each(|path| check_root(path, roots));
        }
        Value::String(path) => path,
        _ => return Err(denied("app_root_invalid", "path must be a string")),
    };
    let Some(session) = roots.first() else {
        return Err(denied("app_root_invalid", "no session root"));
    };
    let candidate = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        session.join(path)
    };
    let resolved = candidate
        .canonicalize()
        .map_err(|_| denied("app_root_invalid", path))?;
    if roots.iter().any(|root| resolved.starts_with(root)) {
        Ok(())
    } else {
        Err(denied("app_root_invalid", path))
    }
}

fn check_route_fields(
    route: &AppRoute,
    object: &serde_json::Map<String, Value>,
    routes: &[(String, String)],
) -> io::Result<()> {
    let text = |field: &str| {
        route
            .route_fields
            .iter()
            .any(|f| f == field)
            .then(|| object.get(field).and_then(Value::as_str))
            .flatten()
    };
    let (model, provider) = (text("model"), text("modelProvider"));
    let configured = routes.iter().any(|(m, p)| {
        model.is_none_or(|model| model == m) && provider.is_none_or(|provider| provider == p)
    });
    if (model.is_some() || provider.is_some()) && !configured {
        return Err(denied(
            "app_route_unconfigured",
            model.or(provider).unwrap_or_default(),
        ));
    }
    Ok(())
}

fn config_keys(spec: &str, object: &serde_json::Map<String, Value>) -> io::Result<Vec<String>> {
    let invalid = || denied("app_params_invalid", spec);
    let edit = |edit: Option<&serde_json::Map<String, Value>>| {
        let edit = edit.ok_or_else(invalid)?;
        let key = edit.get("keyPath").and_then(Value::as_str).ok_or_else(invalid)?;
        let mut keys = leaf_keys(key.to_owned(), edit.get("value"));
        keys.push(key.to_owned());
        Ok::<_, io::Error>(keys)
    };
    Ok(match spec {
        "keyPath" => edit(Some(object))?,
        "edits[].keyPath" => object
            .get("edits")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?
            .iter()
            .map(|entry| edit(entry.as_object()))
            .collect::<io::Result<Vec<_>>>()?
            .concat(),
        "enablement{}" => object
            .get("enablement")
            .and_then(Value::as_object)
            .ok_or_else(invalid)?
            .keys()
            .map(|name| format!("features.{name}"))
            .collect(),
        _ => return Err(invalid()),
    })
}

fn leaf_keys(key: String, value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Object(table)) if !table.is_empty() => table
            .iter()
            .flat_map(|(name, value)| leaf_keys(format!("{key}.{name}"), Some(value)))
            .collect(),
        _ => vec![key],
    }
}

pub fn writable_config_keys() -> impl Iterator<Item = &'static str> {
    TABLE.writable_config.iter().map(String::as_str)
}

pub fn check_config_key(key: &str) -> io::Result<()> {
    let parts: Vec<&str> = key.split('.').collect();
    if parts.iter().any(|part| part.is_empty()) {
        return Err(denied("app_config_key_refused", key));
    }
    let first = parts[0].to_owned();
    let second = parts.get(1).map(|part| format!("{first}.{part}"));
    let table = &*TABLE;
    if let Some(patterns) = table.config_subkeys.get(&first) {
        let matches = patterns.iter().any(|pattern| {
            let pattern: Vec<&str> = pattern.split('.').collect();
            pattern.len() + 1 == parts.len()
                && pattern
                    .iter()
                    .zip(&parts[1..])
                    .all(|(expected, part)| *expected == "*" || expected == part)
        });
        return if matches {
            Ok(())
        } else {
            Err(denied("app_config_key_refused", key))
        };
    }
    let parent = format!("{key}.");
    if table.authority_config.contains(&first)
        || second
            .as_ref()
            .is_some_and(|second| table.authority_config.contains(second))
        || table
            .authority_config
            .iter()
            .any(|authority| authority.starts_with(&parent))
    {
        return Err(denied("app_config_key_refused", key));
    }
    let nested = table
        .writable_config
        .iter()
        .any(|k| k.starts_with(&format!("{first}.")));
    let writable = table.writable_config.contains(key)
        || second
            .as_ref()
            .is_some_and(|second| parts.len() > 2 && table.writable_config.contains(second))
        || (!nested && table.writable_config.contains(&first));
    if writable {
        Ok(())
    } else {
        Err(denied("app_config_key_refused", key))
    }
}

pub fn subscribed(patterns: &[String], method: &str) -> bool {
    patterns
        .iter()
        .any(|pattern| match pattern.strip_suffix('*') {
            Some(prefix) => method.starts_with(prefix),
            None => pattern == method,
        })
}

#[derive(Clone, Debug, PartialEq)]
pub struct AppNotification {
    pub method: String,
    pub params: Value,
    pub thread_id: Option<String>,
    pub coalesced: u64,
    pub dropped: u64,
}

pub struct NotificationQueue {
    events: VecDeque<(AppNotification, usize)>,
    bytes: usize,
    dropped: u64,
    max_events: usize,
    max_bytes: usize,
}

impl Default for NotificationQueue {
    fn default() -> Self {
        Self::new(APP_QUEUE_EVENTS, APP_QUEUE_BYTES)
    }
}

impl NotificationQueue {
    pub fn new(max_events: usize, max_bytes: usize) -> Self {
        Self {
            events: VecDeque::new(),
            bytes: 0,
            dropped: 0,
            max_events,
            max_bytes,
        }
    }

    pub fn push(&mut self, method: &str, params: Value) {
        let thread_id = params
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some((last, size)) = self.events.back_mut()
            && let Some(next) = coalescible(last, method, &params)
            && *size + next.len() <= self.max_bytes
            && let Some(Value::String(delta)) = last.params.get_mut("delta")
        {
            delta.push_str(next);
            *size += next.len();
            self.bytes += next.len();
            last.coalesced += 1;
        } else {
            let size = method.len() + params.to_string().len();
            self.bytes += size;
            self.events.push_back((
                AppNotification {
                    method: method.to_owned(),
                    params,
                    thread_id,
                    coalesced: 0,
                    dropped: 0,
                },
                size,
            ));
        }
        while self.events.len() > self.max_events
            || (self.bytes > self.max_bytes && self.events.len() > 1)
        {
            if let Some((_, size)) = self.events.pop_front() {
                self.bytes -= size;
                self.dropped += 1;
            }
        }
    }

    pub fn drain(&mut self) -> Vec<AppNotification> {
        let mut drained: Vec<_> = self.events.drain(..).map(|(event, _)| event).collect();
        if let Some(first) = drained.first_mut() {
            first.dropped = std::mem::take(&mut self.dropped);
        }
        self.bytes = 0;
        drained
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
}

fn coalescible<'a>(last: &AppNotification, method: &str, params: &'a Value) -> Option<&'a str> {
    if last.method != method || !(method.ends_with("/delta") || method.ends_with("Delta")) {
        return None;
    }
    let same = |field: &str| last.params.get(field) == params.get(field);
    if ![
        "threadId",
        "turnId",
        "itemId",
        "summaryIndex",
        "contentIndex",
        "role",
    ]
    .iter()
    .all(|field| same(field))
    {
        return None;
    }
    last.params.get("delta")?.as_str()?;
    params.get("delta")?.as_str()
}

#[cfg(test)]
#[path = "app_routes_tests.rs"]
mod tests;
