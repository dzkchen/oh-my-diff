use bytes::Bytes;
use codex_omd::credentials::CredentialProfiles;
use futures_util::stream;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::collections::{BTreeMap, BTreeSet};
use std::convert::Infallible;
use std::io;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::{Semaphore, watch};

const BODY_BYTES: usize = 16 * 1024 * 1024;
const CONNECTIONS: usize = 16;
const ROUTE_CONNECTIONS: usize = 4;
const IDLE: Duration = Duration::from_secs(30);
const LIFETIME: Duration = Duration::from_secs(600);
const HEADER: &str = "x-omd-credential-header";
type Body = UnsyncBoxBody<Bytes, io::Error>;
type Routes = Arc<Mutex<BTreeMap<String, Arc<Route>>>>;
type Failure = (u16, String);

struct Route {
    store: PathBuf,
    profiles: BTreeSet<String>,
    active: Mutex<Vec<watch::Sender<bool>>>,
}

struct Forward {
    route: Arc<Route>,
    cancelled: watch::Sender<bool>,
}

impl Drop for Forward {
    fn drop(&mut self) {
        if let Ok(mut active) = self.route.active.lock() {
            active.retain(|sender| !sender.same_channel(&self.cancelled));
        }
    }
}

struct Gateway {
    port: u16,
    routes: Routes,
}

pub(crate) struct Registration {
    key: String,
    routes: Routes,
}

impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut routes) = self.routes.lock()
            && let Some(route) = routes.remove(&self.key)
            && let Ok(active) = route.active.lock()
        {
            for cancelled in active.iter() {
                cancelled.send_replace(true);
            }
        }
    }
}

static GATEWAY: OnceLock<Result<Gateway, String>> = OnceLock::new();

fn gateway() -> io::Result<&'static Gateway> {
    GATEWAY
        .get_or_init(|| start_gateway(IDLE, LIFETIME))
        .as_ref()
        .map_err(|error| io::Error::other(error.clone()))
}

fn start_gateway(idle: Duration, lifetime: Duration) -> Result<Gateway, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(idle)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let routes = Routes::default();
    let served = routes.clone();
    std::thread::Builder::new()
        .name("omd-credential-gateway".into())
        .spawn(move || {
            runtime.block_on(async move {
                let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
                    return;
                };
                let slots = Arc::new(Semaphore::new(CONNECTIONS));
                loop {
                    let Ok((socket, _)) = listener.accept().await else {
                        break;
                    };
                    let Ok(slot) = slots.clone().try_acquire_owned() else {
                        drop(socket);
                        continue;
                    };
                    let routes = served.clone();
                    let client = client.clone();
                    tokio::spawn(async move {
                        let _slot = slot;
                        let (cancelled, mut cancellation) = watch::channel(false);
                        let handler = service_fn(move |request| {
                            let routes = routes.clone();
                            let client = client.clone();
                            let cancelled = cancelled.clone();
                            async move {
                                let response =
                                    match forward(&client, &routes, request, cancelled, idle).await
                                    {
                                        Ok(response) => response,
                                        Err((status, error)) => failure(status, error),
                                    };
                                Ok::<_, Infallible>(response)
                            }
                        });
                        let mut builder = http1::Builder::new();
                        builder
                            .keep_alive(false)
                            .max_headers(64)
                            .max_buf_size(32 * 1024)
                            .timer(TokioTimer::new())
                            .header_read_timeout(idle);
                        let connection = builder.serve_connection(TokioIo::new(socket), handler);
                        tokio::select! {
                            _ = connection => {}
                            _ = cancellation.changed() => {}
                            _ = tokio::time::sleep(lifetime) => {}
                        }
                    });
                }
            });
        })
        .map_err(|error| error.to_string())?;
    Ok(Gateway { port, routes })
}

pub(crate) fn register(
    store: PathBuf,
    profiles: BTreeSet<String>,
) -> io::Result<(String, Registration)> {
    register_at(gateway()?, store, profiles)
}

fn register_at(
    gateway: &Gateway,
    store: PathBuf,
    profiles: BTreeSet<String>,
) -> io::Result<(String, Registration)> {
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    let key = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    gateway
        .routes
        .lock()
        .map_err(|_| io::Error::other("credential_gateway_poisoned"))?
        .insert(
            key.clone(),
            Arc::new(Route {
                store,
                profiles,
                active: Mutex::new(Vec::new()),
            }),
        );
    Ok((
        format!("http://127.0.0.1:{}/{key}", gateway.port),
        Registration {
            key,
            routes: gateway.routes.clone(),
        },
    ))
}

fn failure(status: u16, error: String) -> Response<Body> {
    let body = Full::new(Bytes::from(error))
        .map_err(|never| match never {})
        .boxed_unsync();
    let mut response = Response::new(body);
    *response.status_mut() =
        http::StatusCode::from_u16(status).unwrap_or(http::StatusCode::BAD_GATEWAY);
    response.headers_mut().insert(
        http::header::CONNECTION,
        http::HeaderValue::from_static("close"),
    );
    response
}

fn admit(
    routes: &Routes,
    key: &str,
    profile: &str,
    cancelled: watch::Sender<bool>,
) -> Result<Forward, Failure> {
    let denied = || (403, "credential_not_host_approved".to_owned());
    let routes = routes.lock().map_err(|_| denied())?;
    let route = routes
        .get(key)
        .filter(|route| route.profiles.contains(profile))
        .cloned()
        .ok_or_else(denied)?;
    {
        let mut active = route.active.lock().map_err(|_| denied())?;
        if active.len() >= ROUTE_CONNECTIONS {
            return Err((429, "credential_gateway_busy".into()));
        }
        active.push(cancelled.clone());
    }
    Ok(Forward { route, cancelled })
}

async fn forward(
    client: &reqwest::Client,
    routes: &Routes,
    request: Request<Incoming>,
    cancelled: watch::Sender<bool>,
    idle: Duration,
) -> Result<Response<Body>, Failure> {
    let denied = |error: &str| (403, error.to_owned());
    let (parts, mut incoming) = request.into_parts();
    let target = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let mut path = target.trim_start_matches('/').splitn(3, '/');
    let key = path.next().unwrap_or_default();
    let profile = path.next().unwrap_or_default();
    let rest = path.next().unwrap_or_default();
    let guard = admit(routes, key, profile, cancelled)?;
    static LOOKUPS: std::sync::LazyLock<Arc<tokio::sync::Semaphore>> =
        std::sync::LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(4)));
    let permit = LOOKUPS
        .clone()
        .try_acquire_owned()
        .map_err(|_| (429, "credential_gateway_busy".to_owned()))?;
    let store = guard.route.store.clone();
    let profile = profile.to_owned();
    let (origin, secret) = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let profiles = CredentialProfiles::open(&store).map_err(|error| error.to_string())?;
        let origin = profiles
            .profile(&profile)
            .map_err(|error| error.to_string())?
            .destination()
            .map(str::to_owned)
            .ok_or_else(|| "credential_origin_missing".to_owned())?;
        let secret = profiles
            .secret(&profile, &origin, None)
            .map_err(|error| error.to_string())?;
        Ok::<_, String>((origin, secret))
    })
    .await
    .map_err(|error| denied(&error.to_string()))?
    .map_err(|error| denied(&error))?;
    let mut headers = reqwest::header::HeaderMap::new();
    let mut style = None;
    for (name, value) in &parts.headers {
        if name.as_str() == HEADER {
            style = Some(
                value
                    .to_str()
                    .map_err(|_| (400, "credential_header_invalid".to_owned()))?
                    .to_owned(),
            );
        } else if !matches!(
            name.as_str(),
            "host"
                | "authorization"
                | "x-api-key"
                | "chatgpt-account-id"
                | "cookie"
                | "connection"
                | "content-length"
                | "transfer-encoding"
                | "proxy-authorization"
                | "upgrade"
                | "trailer"
                | "expect"
        ) {
            headers.append(name.clone(), value.clone());
        }
    }
    let (name, value) = match style.as_deref() {
        None | Some("authorization") => (
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", secret.token),
        ),
        Some("x-api-key") => (
            reqwest::header::HeaderName::from_static("x-api-key"),
            secret.token,
        ),
        Some(_) => return Err((400, format!("{HEADER} must be authorization or x-api-key"))),
    };
    let mut value = reqwest::header::HeaderValue::from_str(&value)
        .map_err(|_| denied("credential token is not a valid header"))?;
    value.set_sensitive(true);
    headers.insert(name, value);
    if let Some(account) = secret.account_id
        && let Ok(account) = reqwest::header::HeaderValue::from_str(&account)
    {
        headers.insert("chatgpt-account-id", account);
    }
    let mut body = Vec::new();
    while let Some(frame) = tokio::time::timeout(idle, incoming.frame())
        .await
        .map_err(|_| (408, "credential_gateway_body_timeout".to_owned()))?
    {
        let frame = frame.map_err(|error| (400, error.to_string()))?;
        if let Ok(data) = frame.into_data() {
            if data.len() > BODY_BYTES.saturating_sub(body.len()) {
                return Err((413, "credential_gateway_body_limit".into()));
            }
            body.extend_from_slice(&data);
        }
    }
    let upstream = tokio::time::timeout(
        idle,
        client
            .request(parts.method, format!("{origin}/{rest}"))
            .headers(headers)
            .body(body)
            .send(),
    )
    .await
    .map_err(|_| (504, "credential_gateway_upstream_timeout".to_owned()))?
    .map_err(|error| (502, format!("credential_gateway_upstream: {error}")))?;
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let chunks = stream::unfold(Some((upstream, guard)), move |state| async move {
        let (mut upstream, guard) = state?;
        match tokio::time::timeout(idle, upstream.chunk()).await {
            Ok(Ok(Some(bytes))) => Some((
                Ok::<_, io::Error>(Frame::data(bytes)),
                Some((upstream, guard)),
            )),
            Ok(Ok(None)) => None,
            Ok(Err(error)) => Some((Err(io::Error::other(error)), None)),
            Err(_) => Some((
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "credential_gateway_stream_timeout",
                )),
                None,
            )),
        }
    });
    let mut response = Response::new(StreamBody::new(chunks).boxed_unsync());
    *response.status_mut() = status;
    for (name, value) in &headers {
        if !matches!(
            name.as_str(),
            "content-length" | "transfer-encoding" | "connection" | "trailer" | "upgrade"
        ) {
            response.headers_mut().append(name.clone(), value.clone());
        }
    }
    response.headers_mut().insert(
        http::header::CONNECTION,
        http::HeaderValue::from_static("close"),
    );
    Ok(response)
}

#[cfg(test)]
#[path = "credential_gateway_tests.rs"]
mod tests;
