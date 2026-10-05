use super::operations::Caller;
use super::*;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use std::time::Duration;
use std::time::Instant;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_BODY_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 128 * 1024;
const REQUEST_BODY_BYTES: usize = 1024 * 1024;
const READ_BYTES: usize = 64 * 1024;
const MAX_WAIT_MS: u64 = 5_000;
const STREAMS_PER_MOD: usize = 4;
const STREAM_IDLE: Duration = Duration::from_secs(60);
const MAX_REDIRECTS: usize = 5;
const HIDDEN_HEADERS: &[&str] = &[
    "set-cookie",
    "set-cookie2",
    "authorization",
    "proxy-authorization",
];
const FORBIDDEN_HEADERS: &[&str] = &[
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "proxy-authorization",
    "proxy-connection",
    "keep-alive",
    "te",
    "trailer",
    "upgrade",
];

struct Stream {
    owner: String,
    generation: u64,
    used: Instant,
    body: Option<Body>,
}

struct Body {
    response: reqwest::Response,
    pending: Vec<u8>,
    done: bool,
}

/// HTTP streams and MCP servers a session's mods hold; both end with the mod generation that opened them.
#[derive(Default)]
pub(crate) struct AccessState {
    streams: Mutex<BTreeMap<u64, Stream>>,
    next: std::sync::atomic::AtomicU64,
    servers: Mutex<BTreeMap<String, (String, u64)>>,
}

impl AccessState {
    pub(crate) fn cleanup(&self) {
        if let Ok(mut streams) = self.streams.lock() {
            streams.clear();
        }
    }
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

async fn cancelled(flag: &AtomicBool) {
    while !flag.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Bounds a future by the request deadline and the callback's cancellation.
async fn bounded<T>(
    future: impl std::future::Future<Output = Result<T, String>>,
    deadline: tokio::time::Instant,
    flag: &AtomicBool,
) -> Result<T, String> {
    tokio::select! {
        result = future => result,
        () = cancelled(flag) => Err("host_operation_cancelled".into()),
        () = tokio::time::sleep_until(deadline) => Err("http_timeout".into()),
    }
}

fn current_grants(core: &Core, id: &str) -> Result<ModGrants, String> {
    core.runtime
        .lock()
        .map_err(|_| "mod_runtime_poisoned")?
        .grants(id)
        .ok_or_else(|| "host_caller_inactive".into())
}

fn http_access(core: &Core, id: &str) -> Result<codex_omd::ModHttpAccess, String> {
    current_grants(core, id)?
        .http_access
        .ok_or_else(|| "grant_expired: http".into())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    body_base64: Option<String>,
    #[serde(default)]
    credential: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    max_bytes: Option<usize>,
    #[serde(default)]
    redirects: usize,
}

struct Sent {
    response: reqwest::Response,
    url: String,
    hops: Vec<Value>,
    deadline: tokio::time::Instant,
}

fn redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

/// Sends a request, reassessing every redirect hop against the caller's current grant.
async fn send(
    core: &Core,
    caller: &Caller<'_>,
    request: &Request,
    flag: &AtomicBool,
) -> Result<Sent, String> {
    let timeout = request
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS);
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout);
    if request.redirects > MAX_REDIRECTS {
        return Err("http_redirects_invalid: at most 5".into());
    }
    let mut body = match (&request.body, &request.body_base64) {
        (Some(_), Some(_)) => return Err("http_body_conflict".into()),
        (Some(text), None) => text.clone().into_bytes(),
        (None, Some(encoded)) => STANDARD
            .decode(encoded)
            .map_err(|_| "http_body_base64_invalid")?,
        (None, None) => Vec::new(),
    };
    if body.len() > REQUEST_BODY_BYTES {
        return Err("http_body_limit".into());
    }
    if request.headers.len() > 32
        || request
            .headers
            .iter()
            .map(|(name, value)| name.len() + value.len())
            .sum::<usize>()
            > 8192
    {
        return Err("http_headers_limit".into());
    }
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in &request.headers {
        let lower = name.to_ascii_lowercase();
        if FORBIDDEN_HEADERS.contains(&lower.as_str())
            || lower.starts_with("proxy-")
            || request.credential.is_some()
                && matches!(lower.as_str(), "authorization" | "x-api-key")
        {
            return Err(format!("http_header_refused: {lower}"));
        }
        headers.insert(
            reqwest::header::HeaderName::from_bytes(lower.as_bytes())
                .map_err(|_| format!("http_header_invalid: {lower}"))?,
            reqwest::header::HeaderValue::from_str(value)
                .map_err(|_| format!("http_header_invalid: {lower}"))?,
        );
    }
    let mut method = reqwest::Method::from_bytes(
        request
            .method
            .as_deref()
            .unwrap_or("GET")
            .to_ascii_uppercase()
            .as_bytes(),
    )
    .map_err(|_| "http_method_invalid")?;
    let initial = codex_omd::url_origin(&request.url).ok_or("http_url_invalid")?;
    let mut url = request.url.clone();
    let mut hops = Vec::new();
    loop {
        let access = http_access(core, caller.id)?;
        let origin = codex_omd::url_origin(&url).ok_or("http_url_invalid")?;
        if !access.allows(&origin) {
            return Err(format!("http_origin_denied: {origin}"));
        }
        let mut hop_headers = headers.clone();
        if origin != initial {
            for name in ["authorization", "cookie", "x-api-key"] {
                hop_headers.remove(name);
            }
        }
        if let Some(profile) = &request.credential {
            if !access.credentials.contains(profile) {
                return Err(format!("credential_not_granted: {profile}"));
            }
            let store = core.host.root.clone();
            let (profile, target) = (profile.clone(), origin.clone());
            let secret = tokio::task::spawn_blocking(move || {
                let profiles = codex_omd::credentials::CredentialProfiles::open(&store)?;
                if profiles.profile(&profile)?.destination() != Some(target.as_str()) {
                    return Ok(None);
                }
                profiles.secret(&profile, &target).map(Some)
            })
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
            if secret.is_none() && hops.is_empty() {
                return Err(format!(
                    "credential_origin_mismatch: {}",
                    request.credential.as_deref().unwrap_or_default()
                ));
            }
            if let Some(secret) = secret {
                let mut value =
                    reqwest::header::HeaderValue::from_str(&format!("Bearer {}", secret.token))
                        .map_err(|_| "credential token is not a valid header")?;
                value.set_sensitive(true);
                hop_headers.insert(reqwest::header::AUTHORIZATION, value);
                if let Some(account) = secret.account_id
                    && let Ok(account) = reqwest::header::HeaderValue::from_str(&account)
                {
                    hop_headers.insert("chatgpt-account-id", account);
                }
            }
        }
        let pending = client()?
            .request(method.clone(), &url)
            .headers(hop_headers)
            .body(body.clone())
            .send();
        let response = bounded(
            async {
                pending
                    .await
                    .map_err(|error| format!("http_request_failed: {error}"))
            },
            deadline,
            flag,
        )
        .await?;
        let status = response.status().as_u16();
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        match location {
            Some(location) if redirect(status) && hops.len() < request.redirects => {
                let next = reqwest::Url::parse(&url)
                    .and_then(|base| base.join(&location))
                    .map_err(|_| "http_redirect_invalid")?
                    .to_string();
                hops.push(json!({"status": status, "origin": codex_omd::url_origin(&next)}));
                if status == 303 || matches!(status, 301 | 302) && method == reqwest::Method::POST {
                    method = reqwest::Method::GET;
                    body.clear();
                }
                url = next;
            }
            _ => {
                return Ok(Sent {
                    response,
                    url,
                    hops,
                    deadline,
                });
            }
        }
    }
}

fn response_headers(response: &reqwest::Response) -> Value {
    let mut headers = serde_json::Map::new();
    for (name, value) in response.headers().iter().take(64) {
        let name = name.as_str();
        let value = if HIDDEN_HEADERS.contains(&name) {
            "[redacted]".to_owned()
        } else {
            String::from_utf8_lossy(value.as_bytes())
                .chars()
                .take(1024)
                .collect()
        };
        match headers.get_mut(name) {
            Some(Value::String(existing)) if existing != "[redacted]" => {
                existing.push_str(", ");
                existing.push_str(&value);
            }
            Some(_) => (),
            None => {
                headers.insert(name.to_owned(), Value::String(value));
            }
        }
    }
    Value::Object(headers)
}

/// The length without a trailing incomplete UTF-8 character, when that leaves valid text.
fn text_end(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Err(error) if error.error_len().is_none() && error.valid_up_to() > 0 => error.valid_up_to(),
        _ => bytes.len(),
    }
}

/// Text when the bytes are UTF-8, otherwise base64.
fn content(field: &str, bytes: &[u8]) -> (String, Value) {
    match std::str::from_utf8(bytes) {
        Ok(text) => (field.to_owned(), json!(text)),
        Err(_) => (format!("{field}_base64"), json!(STANDARD.encode(bytes))),
    }
}

fn sweep(core: &Core, lead: &Lead) {
    let Ok(mut streams) = lead.session.access.streams.lock() else {
        return;
    };
    let runtime = core.runtime.lock().ok();
    streams.retain(|_, stream| {
        stream.used.elapsed() < STREAM_IDLE
            && runtime.as_ref().is_some_and(|runtime| {
                runtime.generation() == stream.generation
                    && runtime
                        .grants(&stream.owner)
                        .is_some_and(|grants| grants.http_access.is_some())
            })
    });
}

async fn http(
    core: &Core,
    lead: &Lead,
    caller: &Caller<'_>,
    request: ModHostCall,
    flag: &AtomicBool,
) -> Result<Value, String> {
    sweep(core, lead);
    match request.operation.as_str() {
        "http.request" => {
            let input: Request =
                serde_json::from_value(request.arguments).map_err(|error| error.to_string())?;
            let limit = input
                .max_bytes
                .unwrap_or(DEFAULT_BODY_BYTES)
                .clamp(1, MAX_BODY_BYTES);
            let Sent {
                mut response,
                url,
                hops,
                deadline,
            } = send(core, caller, &input, flag).await?;
            let status = response.status().as_u16();
            let headers = response_headers(&response);
            let mut bytes = Vec::new();
            let mut truncated = false;
            while let Some(chunk) = bounded(
                async {
                    response
                        .chunk()
                        .await
                        .map_err(|error| format!("http_read_failed: {error}"))
                },
                deadline,
                flag,
            )
            .await?
            {
                bytes.extend_from_slice(&chunk);
                if bytes.len() > limit {
                    bytes.truncate(limit);
                    bytes.truncate(text_end(&bytes));
                    truncated = true;
                    break;
                }
            }
            let (field, body) = content("body", &bytes);
            let mut result = json!({"status": status, "url": url, "headers": headers,
                "truncated": truncated, "bytes": bytes.len(), "redirects": hops});
            result[field] = body;
            Ok(result)
        }
        "http.open" => {
            let input: Request =
                serde_json::from_value(request.arguments).map_err(|error| error.to_string())?;
            if input.max_bytes.is_some() {
                return Err("http_open_arguments_invalid: max_bytes belongs to http.read".into());
            }
            let generation = caller.generation;
            let owned = lead
                .session
                .access
                .streams
                .lock()
                .map_err(|_| "http_streams_poisoned")?
                .values()
                .filter(|stream| stream.owner == caller.id)
                .count();
            if owned >= STREAMS_PER_MOD {
                return Err("http_stream_limit: at most 4 open streams".into());
            }
            let Sent {
                response,
                url,
                hops,
                ..
            } = send(core, caller, &input, flag).await?;
            let status = response.status().as_u16();
            let headers = response_headers(&response);
            let handle = lead.session.access.next.fetch_add(1, Ordering::Relaxed) + 1;
            lead.session
                .access
                .streams
                .lock()
                .map_err(|_| "http_streams_poisoned")?
                .insert(
                    handle,
                    Stream {
                        owner: caller.id.to_owned(),
                        generation,
                        used: Instant::now(),
                        body: Some(Body {
                            response,
                            pending: Vec::new(),
                            done: false,
                        }),
                    },
                );
            Ok(
                json!({"handle": handle, "status": status, "url": url, "headers": headers, "redirects": hops}),
            )
        }
        "http.read" | "http.close" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Input {
                handle: u64,
                #[serde(default)]
                max_bytes: Option<usize>,
                #[serde(default)]
                wait_ms: Option<u64>,
            }
            let input: Input =
                serde_json::from_value(request.arguments).map_err(|error| error.to_string())?;
            let mut body = {
                let mut streams = lead
                    .session
                    .access
                    .streams
                    .lock()
                    .map_err(|_| "http_streams_poisoned")?;
                let Some(stream) = streams
                    .get_mut(&input.handle)
                    .filter(|stream| stream.owner == caller.id)
                else {
                    return Err("http_stream_unavailable".into());
                };
                stream.used = Instant::now();
                if request.operation == "http.close" {
                    streams.remove(&input.handle);
                    return Ok(json!({"closed": true}));
                }
                stream.body.take().ok_or("http_stream_busy")?
            };
            let limit = input.max_bytes.unwrap_or(16 * 1024).clamp(1, READ_BYTES);
            let wait = Duration::from_millis(input.wait_ms.unwrap_or(0).min(MAX_WAIT_MS));
            let deadline = tokio::time::Instant::now() + wait;
            let partial = |pending: &[u8]| {
                std::str::from_utf8(pending)
                    .is_err_and(|error| error.error_len().is_none() && error.valid_up_to() == 0)
            };
            let mut read = Ok(());
            while (body.pending.is_empty() || partial(&body.pending)) && !body.done {
                let chunk = tokio::select! {
                    chunk = tokio::time::timeout_at(deadline, body.response.chunk()) => match chunk {
                        Ok(chunk) => chunk.map(Some).map_err(|error| format!("http_read_failed: {error}")),
                        Err(_) => Ok(None),
                    },
                    () = cancelled(flag) => Err("host_operation_cancelled".to_owned()),
                };
                match chunk {
                    Ok(Some(Some(chunk))) => body.pending.extend_from_slice(&chunk),
                    Ok(Some(None)) => body.done = true,
                    Ok(None) => break,
                    Err(error) => {
                        read = Err(error);
                        break;
                    }
                }
            }
            let read = read.map(|()| {
                let take = text_end(&body.pending[..body.pending.len().min(limit)]);
                let bytes = body.pending.drain(..take).collect::<Vec<_>>();
                (bytes, body.done && body.pending.is_empty())
            });
            {
                let mut streams = lead
                    .session
                    .access
                    .streams
                    .lock()
                    .map_err(|_| "http_streams_poisoned")?;
                if read.as_ref().is_ok_and(|(_, done)| *done) {
                    streams.remove(&input.handle);
                } else if let Some(stream) = streams.get_mut(&input.handle) {
                    stream.body = Some(body);
                }
            }
            let (bytes, done) = read?;
            let (field, data) = content("data", &bytes);
            let mut result = json!({"done": done, "bytes": bytes.len()});
            result[field] = data;
            Ok(result)
        }
        operation => Err(format!("unsupported_host_operation: {operation}")),
    }
}

async fn mcp(
    core: &Core,
    lead: &Lead,
    caller: &Caller<'_>,
    request: ModHostCall,
) -> Result<Value, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        server: String,
    }
    let input: Input =
        serde_json::from_value(request.arguments).map_err(|error| error.to_string())?;
    let grants = current_grants(core, caller.id)?;
    let declared = grants
        .mcp_servers
        .get(&input.server)
        .cloned()
        .ok_or_else(|| format!("mcp_server_undeclared: {}", input.server))?;
    let name = format!("mod_{}_{}", caller.id, input.server);
    if lead
        .session
        .access
        .servers
        .lock()
        .map_err(|_| "mcp_servers_poisoned")?
        .get(&name)
        .is_some_and(|(owner, _)| owner != caller.id)
    {
        return Err(format!("mcp_server_name_taken: {name}"));
    }
    let connect = request.operation == "mcp.connect";
    let config = if connect {
        let mut config = match (&declared.command, &declared.url) {
            (Some(command), _) => json!({"command": command, "args": declared.args}),
            (None, Some(url)) => json!({"url": url}),
            (None, None) => return Err("invalid_mcp_servers".into()),
        };
        if let (Some(profile), Some(url)) = (&declared.credential, &declared.url) {
            let store = core.host.root.clone();
            let (profile, origin) = (
                profile.clone(),
                codex_omd::url_origin(url).ok_or("http_url_invalid")?,
            );
            let secret = tokio::task::spawn_blocking(move || {
                codex_omd::credentials::CredentialProfiles::open(&store)?.secret(&profile, &origin)
            })
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
            config["http_headers"] = json!({"Authorization": format!("Bearer {}", secret.token)});
        }
        Some(
            serde_json::from_value::<codex_config::types::McpServerConfig>(config)
                .map_err(|error| format!("invalid_mcp_servers: {error}"))?,
        )
    } else {
        None
    };
    reconfigure(lead, &name, config).await?;
    let mut servers = lead
        .session
        .access
        .servers
        .lock()
        .map_err(|_| "mcp_servers_poisoned")?;
    if connect {
        servers.insert(name.clone(), (caller.id.to_owned(), caller.generation));
    } else {
        servers.remove(&name);
    }
    Ok(json!({"server": name, "connected": connect, "tool_prefix": format!("mcp__{name}__")}))
}

/// Adds or removes one MCP server on the lead thread through the engine's own MCP refresh.
async fn reconfigure(
    lead: &Lead,
    name: &str,
    server: Option<codex_config::types::McpServerConfig>,
) -> Result<(), String> {
    let manager = lead
        .host
        .manager
        .upgrade()
        .ok_or("native_thread_manager_stopped")?;
    let thread = manager
        .get_thread(lead.thread)
        .await
        .map_err(|error| error.to_string())?;
    let mut config = (*thread.config().await).clone();
    let mut servers = config.mcp_servers.get().clone();
    let owned = lead
        .session
        .access
        .servers
        .lock()
        .map_err(|_| "mcp_servers_poisoned")?
        .contains_key(name);
    if servers.contains_key(name) && !owned {
        return Err(format!("mcp_server_name_taken: {name}"));
    }
    match server {
        Some(server) => {
            servers.insert(name.to_owned(), server);
        }
        None if !owned => return Ok(()),
        None => {
            servers.remove(name);
        }
    }
    config
        .mcp_servers
        .set(servers)
        .map_err(|error| format!("mcp_server_refused: {error}"))?;
    thread.refresh_mcp_config(config).await;
    Ok(())
}

/// Disconnects MCP servers whose owner is gone or reloaded; `owner` limits it to one mod.
pub(super) async fn release_servers(lead: &Lead, generation: u64, owner: Option<&str>) {
    let stale = lead.session.access.servers.lock().map_or_else(
        |_| Vec::new(),
        |servers| {
            servers
                .iter()
                .filter(|(_, (id, current))| match owner {
                    Some(owner) => id == owner && *current == generation,
                    None => *current != generation,
                })
                .map(|(name, _)| name.clone())
                .collect::<Vec<_>>()
        },
    );
    for name in stale {
        let _ = reconfigure(lead, &name, None).await;
        if let Ok(mut servers) = lead.session.access.servers.lock() {
            servers.remove(&name);
        }
    }
    if let Ok(mut streams) = lead.session.access.streams.lock() {
        streams.retain(|_, stream| match owner {
            Some(owner) => stream.owner != owner || stream.generation != generation,
            None => stream.generation == generation,
        });
    }
}

pub(super) async fn dispatch(
    core: &Core,
    lead: &Lead,
    caller: &Caller<'_>,
    request: ModHostCall,
    flag: &AtomicBool,
) -> Result<Value, String> {
    if request.operation.starts_with("mcp.") {
        mcp(core, lead, caller, request).await
    } else {
        http(core, lead, caller, request, flag).await
    }
}
