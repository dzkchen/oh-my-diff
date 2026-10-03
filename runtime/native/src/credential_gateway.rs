use codex_omd::credentials::CredentialProfiles;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::io;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

const BODY_BYTES: u64 = 16 * 1024 * 1024;
const HEADER: &str = "x-omd-credential-header";

type Routes = Arc<Mutex<BTreeMap<String, (PathBuf, BTreeSet<String>)>>>;

struct Gateway {
    port: u16,
    routes: Routes,
}

/// Keeps a sidecar's gateway path open; dropping it revokes the path.
pub(crate) struct Registration {
    key: String,
    routes: Routes,
}

impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut routes) = self.routes.lock() {
            routes.remove(&self.key);
        }
    }
}

static GATEWAY: OnceLock<Result<Gateway, String>> = OnceLock::new();

fn gateway() -> io::Result<&'static Gateway> {
    GATEWAY
        .get_or_init(|| {
            let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
            let port = server
                .server_addr()
                .to_ip()
                .ok_or("credential_gateway_unavailable")?
                .port();
            // A blocking client must not be built on an async runtime thread.
            let client = std::thread::spawn(|| {
                reqwest::blocking::Client::builder()
                    .timeout(None::<std::time::Duration>)
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
            })
            .join()
            .map_err(|_| "credential_gateway_unavailable")?
            .map_err(|e| e.to_string())?;
            let routes = Routes::default();
            let served = routes.clone();
            std::thread::spawn(move || {
                for request in server.incoming_requests() {
                    let (client, routes) = (client.clone(), served.clone());
                    std::thread::spawn(move || forward(&client, &routes, request));
                }
            });
            Ok(Gateway { port, routes })
        })
        .as_ref()
        .map_err(|error| io::Error::other(error.clone()))
}

/// Opens `http://127.0.0.1:PORT/KEY`; `KEY/PROFILE/PATH` reaches `PATH` on that profile's enrolled origin.
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
    gateway
        .routes
        .lock()
        .map_err(|_| io::Error::other("credential_gateway_poisoned"))?
        .insert(key.clone(), (store, profiles));
    Ok((
        format!("http://127.0.0.1:{}/{key}", gateway.port),
        Registration {
            key,
            routes: gateway.routes.clone(),
        },
    ))
}

fn forward(client: &reqwest::blocking::Client, routes: &Routes, mut request: tiny_http::Request) {
    let response = upstream(client, routes, &mut request);
    let _ = match response {
        Ok(upstream) => {
            let status = upstream.status().as_u16();
            let headers = upstream
                .headers()
                .iter()
                .filter(|(name, _)| {
                    !matches!(
                        name.as_str(),
                        "content-length"
                            | "transfer-encoding"
                            | "connection"
                            | "trailer"
                            | "upgrade"
                    )
                })
                .filter_map(|(name, value)| {
                    tiny_http::Header::from_bytes(name.as_str(), value.as_bytes()).ok()
                })
                .collect();
            let length = upstream.content_length().map(|length| length as usize);
            if length.is_none()
                && request.method() != &tiny_http::Method::Head
                && !matches!(status, 204 | 304)
            {
                stream(request, status, headers, upstream)
            } else {
                request.respond(tiny_http::Response::new(
                    tiny_http::StatusCode(status),
                    headers,
                    upstream,
                    length,
                    None,
                ))
            }
        }
        Err((status, error)) => {
            request.respond(tiny_http::Response::from_string(error).with_status_code(status))
        }
    };
}

/// tiny_http's chunked encoder holds 8 KiB before writing, so streamed replies are framed and flushed here.
fn stream(
    request: tiny_http::Request,
    status: u16,
    headers: Vec<tiny_http::Header>,
    mut body: impl Read,
) -> io::Result<()> {
    let mut writer = request.into_writer();
    let reason = tiny_http::StatusCode(status).default_reason_phrase();
    write!(writer, "HTTP/1.1 {status} {reason}\r\n")?;
    for header in headers {
        write!(writer, "{}: {}\r\n", header.field, header.value)?;
    }
    writer.write_all(b"Transfer-Encoding: chunked\r\n\r\n")?;
    let mut buffer = [0; 8192];
    loop {
        let read = body.read(&mut buffer)?;
        write!(writer, "{read:x}\r\n")?;
        writer.write_all(&buffer[..read])?;
        writer.write_all(b"\r\n")?;
        writer.flush()?;
        if read == 0 {
            return Ok(());
        }
    }
}

fn upstream(
    client: &reqwest::blocking::Client,
    routes: &Routes,
    request: &mut tiny_http::Request,
) -> Result<reqwest::blocking::Response, (u16, String)> {
    let denied = |error: &str| (403, error.to_owned());
    let mut parts = request.url().trim_start_matches('/').splitn(3, '/');
    let (key, profile, rest) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default().to_owned(),
        parts.next().unwrap_or_default().to_owned(),
    );
    let store = routes
        .lock()
        .map_err(|_| denied("credential_gateway_poisoned"))?
        .get(key)
        .filter(|(_, profiles)| profiles.contains(&profile))
        .map(|(store, _)| store.clone())
        .ok_or_else(|| denied("credential_not_host_approved"))?;
    let profiles = CredentialProfiles::open(&store).map_err(|e| denied(&e.to_string()))?;
    let origin = profiles
        .profile(&profile)
        .map_err(|e| denied(&e.to_string()))?
        .destination()
        .map(str::to_owned)
        .ok_or_else(|| denied("credential_origin_missing"))?;
    let secret = profiles
        .secret(&profile, &origin)
        .map_err(|e| denied(&e.to_string()))?;
    let mut headers = reqwest::header::HeaderMap::new();
    let mut style = None;
    for header in request.headers() {
        let name = header.field.as_str().as_str().to_ascii_lowercase();
        if name == HEADER {
            style = Some(header.value.as_str().to_owned());
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
        ) && let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_bytes(header.value.as_bytes()),
        ) {
            headers.append(name, value);
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
    request
        .as_reader()
        .take(BODY_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|e| (400, e.to_string()))?;
    if body.len() as u64 > BODY_BYTES {
        return Err((413, "credential_gateway_body_limit".to_owned()));
    }
    let method = reqwest::Method::from_bytes(request.method().as_str().as_bytes())
        .map_err(|_| (405, "method_unsupported".to_owned()))?;
    client
        .request(method, format!("{origin}/{rest}"))
        .headers(headers)
        .body(body)
        .send()
        .map_err(|e| (502, format!("credential_gateway_upstream: {e}")))
}

#[cfg(test)]
#[path = "credential_gateway_tests.rs"]
mod tests;
