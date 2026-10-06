use axum::body::Body;
use axum::extract::State;
use axum::http::Request;
use axum::response::Response;
use codex_omd::credentials::CredentialProfiles;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Read};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::{Semaphore, watch};
use tokio::time::Instant;

const BODY_BYTES: usize = 16 * 1024 * 1024;
const HEADER: &str = "x-omd-credential-header";
const CONCURRENCY: usize = 16;
#[cfg(not(test))]
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
#[cfg(test)]
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct Route {
    store: PathBuf,
    profiles: BTreeSet<String>,
    cancelled: watch::Receiver<bool>,
}

type Routes = Arc<Mutex<BTreeMap<String, Route>>>;
type ServerState = (reqwest::Client, Routes, Arc<Semaphore>);
struct Gateway {
    port: u16,
    routes: Routes,
}

pub(crate) struct Registration {
    key: String,
    routes: Routes,
    cancelled: watch::Sender<bool>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.cancelled.send_replace(true);
        if let Ok(mut routes) = self.routes.lock() {
            routes.remove(&self.key);
        }
    }
}

static GATEWAY: OnceLock<Result<Gateway, String>> = OnceLock::new();

fn gateway() -> io::Result<&'static Gateway> {
    GATEWAY
        .get_or_init(|| {
            let listener =
                std::net::TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
            listener
                .set_nonblocking(true)
                .map_err(|error| error.to_string())?;
            let port = listener
                .local_addr()
                .map_err(|error| error.to_string())?
                .port();
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .map_err(|error| error.to_string())?;
            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .read_timeout(IDLE_TIMEOUT)
                .timeout(REQUEST_TIMEOUT)
                .pool_max_idle_per_host(0)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|error| error.to_string())?;
            let routes = Routes::default();
            let state = (
                client,
                routes.clone(),
                Arc::new(Semaphore::new(CONCURRENCY)),
            );
            std::thread::spawn(move || {
                runtime.block_on(async move {
                    if let Ok(listener) = tokio::net::TcpListener::from_std(listener) {
                        let _ = axum::serve(
                            listener,
                            axum::Router::new().fallback(forward).with_state(state),
                        )
                        .await;
                    }
                })
            });
            Ok(Gateway { port, routes })
        })
        .as_ref()
        .map_err(|error| io::Error::other(error.clone()))
}

pub(crate) fn register(
    store: PathBuf,
    profiles: BTreeSet<String>,
) -> io::Result<(String, Registration)> {
    let gateway = gateway()?;
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    let key = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let (cancelled, receiver) = watch::channel(false);
    gateway
        .routes
        .lock()
        .map_err(|_| io::Error::other("credential_gateway_poisoned"))?
        .insert(
            key.clone(),
            Route {
                store,
                profiles,
                cancelled: receiver,
            },
        );
    Ok((
        format!("http://127.0.0.1:{}/{key}", gateway.port),
        Registration {
            key,
            routes: gateway.routes.clone(),
            cancelled,
        },
    ))
}

async fn bounded<T, E: std::fmt::Display>(
    cancelled: &mut watch::Receiver<bool>,
    deadline: Instant,
    future: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, (u16, String)> {
    if *cancelled.borrow() {
        return Err((403, "credential_gateway_revoked".into()));
    }
    tokio::select! {
        biased;
        _ = cancelled.changed() => Err((403, "credential_gateway_revoked".into())),
        result = tokio::time::timeout_at(deadline.min(Instant::now() + IDLE_TIMEOUT), future) => {
            result.map_err(|_| (504, "credential_gateway_deadline".into()))?
                .map_err(|error| (502, format!("credential_gateway_upstream: {error}")))
        }
    }
}

async fn forward(
    State((client, routes, capacity)): State<ServerState>,
    request: Request<Body>,
) -> Response {
    let result = async {
        let permit = capacity
            .try_acquire_owned()
            .map_err(|_| (503, "credential_gateway_busy".to_owned()))?;
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        let (parts, body) = request.into_parts();
        let mut path = parts
            .uri
            .path_and_query()
            .map(|value| value.as_str())
            .unwrap_or("/")
            .trim_start_matches('/')
            .splitn(3, '/');
        let (key, profile, rest) = (
            path.next().unwrap_or_default(),
            path.next().unwrap_or_default(),
            path.next().unwrap_or_default(),
        );
        let mut route = routes
            .lock()
            .map_err(|_| (403, "credential_gateway_poisoned".to_owned()))?
            .get(key)
            .filter(|route| route.profiles.contains(profile))
            .cloned()
            .ok_or((403, "credential_not_host_approved".to_owned()))?;
        let denied = |error: io::Error| (403, error.to_string());
        let profiles = CredentialProfiles::open(&route.store).map_err(denied)?;
        let origin = profiles
            .profile(profile)
            .map_err(denied)?
            .destination()
            .map(str::to_owned)
            .ok_or((403, "credential_origin_missing".to_owned()))?;
        let secret = profiles.secret(profile, &origin).map_err(denied)?;
        let mut headers = reqwest::header::HeaderMap::new();
        for (name, value) in &parts.headers {
            if !matches!(
                name.as_str(),
                HEADER
                    | "host"
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
            ) {
                headers.append(name, value.clone());
            }
        }
        let (name, value) = match parts.headers.get(HEADER).map(|value| value.to_str()) {
            None | Some(Ok("authorization")) => (
                reqwest::header::AUTHORIZATION,
                format!("Bearer {}", secret.token),
            ),
            Some(Ok("x-api-key")) => (
                reqwest::header::HeaderName::from_static("x-api-key"),
                secret.token,
            ),
            _ => return Err((400, format!("{HEADER} must be authorization or x-api-key"))),
        };
        let mut value = reqwest::header::HeaderValue::from_str(&value)
            .map_err(|_| (403, "credential token is not a valid header".to_owned()))?;
        value.set_sensitive(true);
        headers.insert(name, value);
        if let Some(account) = secret.account_id
            && let Ok(account) = reqwest::header::HeaderValue::from_str(&account)
        {
            headers.insert("chatgpt-account-id", account);
        }
        let body = bounded(&mut route.cancelled, deadline, async {
            Ok::<_, io::Error>(axum::body::to_bytes(body, BODY_BYTES).await)
        })
        .await?
        .map_err(|error| (413, error.to_string()))?;
        let upstream = bounded(
            &mut route.cancelled,
            deadline,
            client
                .request(parts.method, format!("{origin}/{rest}"))
                .headers(headers)
                .body(body)
                .send(),
        )
        .await?;
        let mut response = Response::builder().status(upstream.status());
        for (name, value) in upstream.headers() {
            if !matches!(
                name.as_str(),
                "transfer-encoding" | "connection" | "trailer" | "upgrade"
            ) {
                response = response.header(name, value);
            }
        }
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        let cancelled = route.cancelled.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let mut upstream = upstream;
            let mut cancelled = route.cancelled;
            loop {
                match bounded(&mut cancelled, deadline, upstream.chunk()).await {
                    Ok(Some(chunk)) => {
                        if bounded(&mut cancelled, deadline, sender.send(Ok(chunk)))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err((_, error)) => {
                        let _ = sender.try_send(Err(io::Error::other(error)));
                        break;
                    }
                }
            }
        });
        let stream = futures::stream::try_unfold(
            (receiver, cancelled),
            move |(mut receiver, mut cancelled)| async move {
                let chunk = bounded(&mut cancelled, deadline, async {
                    Ok::<_, io::Error>(receiver.recv().await)
                })
                .await
                .map_err(|(_, error)| io::Error::other(error))?
                .transpose()?;
                Ok::<_, io::Error>(chunk.map(|chunk| (chunk, (receiver, cancelled))))
            },
        );
        response
            .body(Body::from_stream(stream))
            .map_err(|error| (502, error.to_string()))
    }
    .await;
    result.unwrap_or_else(|(status, error)| {
        Response::builder()
            .status(status)
            .body(Body::from(error))
            .expect("valid gateway error")
    })
}

#[cfg(test)]
#[path = "credential_gateway_tests.rs"]
mod tests;
