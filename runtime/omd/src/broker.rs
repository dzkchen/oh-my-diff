use crate::fsio::write_private;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::fs;
use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixListener;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

pub const DAEMON: &str = "/Library/LaunchDaemons/dev.ohmydiff.broker.plist";
pub const SOCKET: &str = "/var/run/dev.ohmydiff.broker.sock";
pub const ROOT: &str = "/Library/Application Support/OhMyDiff/broker";
pub const GRANT_RIGHT: &str = "dev.ohmydiff.broker.grant";
pub const POLICY_RIGHT: &str = "dev.ohmydiff.broker.policy";
pub const HOST_CALLER: &str = "Oh My Diff";
const PASSWORD_PROMPT: &str =
    "Enter your macOS login password to change protected mod grants or credentials.";
const LINE_BYTES: u64 = 1 << 20;
const GRANTS_LIMIT: usize = 256;
const POLICY_VALUE_BYTES: usize = 65_536;

fn failure(code: &str) -> io::Error {
    io::Error::other(code.to_owned())
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn deployed() -> bool {
    fs::symlink_metadata(DAEMON).is_ok_and(|metadata| metadata.is_file() && metadata.uid() == 0)
}

pub fn status() -> &'static str {
    if deployed() {
        "protected (OS-separated broker)"
    } else {
        "unprotected (same-user)"
    }
}

fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries = map.iter().collect::<Vec<_>>();
            entries.sort_by_key(|(key, _)| *key);
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key.clone(), sorted(value)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        _ => value.clone(),
    }
}

// Key order otherwise follows serde_json's per-build preserve_order feature.
pub fn canonical(value: &Value) -> String {
    sorted(value).to_string()
}

fn request_digest(op: &str, arguments: &Value) -> io::Result<String> {
    Ok(sha256(canonical(&json!([op, arguments])).as_bytes()))
}

pub struct Client {
    stream: BufReader<UnixStream>,
}

impl Client {
    pub fn connect() -> io::Result<Self> {
        Self::at(Path::new(SOCKET))
    }

    pub fn at(path: &Path) -> io::Result<Self> {
        let timeout = std::time::Duration::from_secs(30);
        let socket = socket2::Socket::new(socket2::Domain::UNIX, socket2::Type::STREAM, None)?;
        socket
            .connect_timeout(&socket2::SockAddr::unix(path)?, timeout)
            .map_err(|_| failure("authority_broker_unavailable"))?;
        socket.set_read_timeout(Some(timeout))?;
        socket.set_write_timeout(Some(timeout))?;
        let stream: UnixStream = socket.into();
        Ok(Self {
            stream: BufReader::new(stream),
        })
    }

    fn send(&mut self, request: &Value) -> io::Result<Value> {
        let mut line = serde_json::to_vec(request)?;
        line.push(b'\n');
        let written = self.stream.get_mut().write_all(&line);
        let mut response = String::new();
        (&mut self.stream)
            .take(LINE_BYTES)
            .read_line(&mut response)?;
        if !response.ends_with('\n') {
            written?;
            return Err(failure("authority_broker_unavailable"));
        }
        let mut value: Value = serde_json::from_str(&response)?;
        match value["error"].as_str() {
            Some(error) => Err(failure(error)),
            None => Ok(value["ok"].take()),
        }
    }

    pub fn call(&mut self, op: &str, arguments: Value) -> io::Result<Value> {
        self.send(&json!({"op": op, "arguments": arguments}))
    }

    pub(crate) fn socket(&self) -> io::Result<UnixStream> {
        self.stream.get_ref().try_clone()
    }

    pub fn authorized(&mut self, op: &str, arguments: Value) -> io::Result<Value> {
        let nonce = self.call(
            "challenge",
            json!({"sha256": request_digest(op, &arguments)?}),
        )?;
        let password = if platform::graphic_session() {
            None
        } else {
            Some(password()?.ok_or_else(|| failure("authority_authorization_denied"))?)
        };
        let authorization = platform::Authorization::create()?;
        self.send_authorized(&json!({"op": op, "arguments": arguments, "nonce": nonce,
            "authorization": authorization.external()?, "password": password}))
    }

    fn send_authorized(&mut self, request: &Value) -> io::Result<Value> {
        let timeout = self.stream.get_ref().read_timeout()?;
        self.stream.get_mut().set_read_timeout(None)?;
        let result = self.send(request);
        self.stream.get_mut().set_read_timeout(timeout)?;
        result
    }
}

// Without a GUI session the broker checks the password instead of showing a dialog.
pub(crate) fn password() -> io::Result<Option<String>> {
    if let Ok(receiver) = crate::client_surface::submit(
        HOST_CALLER,
        "terminal.prompt",
        json!({"kind": "text", "masked": true, "title": "macOS password", "message": PASSWORD_PROMPT}),
        crate::app_routes::InvocationContext::User,
        false,
        None,
        None,
    ) {
        let answer = crate::client_surface::wait(receiver, &|| true, None)
            .map_err(|error| failure(&error))?;
        return Ok(answer["value"].as_str().map(str::to_owned));
    }
    let mut tty = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .map_err(|_| failure("authority_password_unavailable"))?;
    let saved = rustix::termios::tcgetattr(&tty)?;
    let mut quiet = saved.clone();
    quiet.local_modes.remove(rustix::termios::LocalModes::ECHO);
    rustix::termios::tcsetattr(&tty, rustix::termios::OptionalActions::Now, &quiet)?;
    write!(tty, "{PASSWORD_PROMPT}\nPassword: ")?;
    let mut line = String::new();
    let read = BufReader::new(&tty).read_line(&mut line);
    rustix::termios::tcsetattr(&tty, rustix::termios::OptionalActions::Now, &saved)?;
    writeln!(tty)?;
    read?;
    let line = line.trim_end_matches(['\n', '\r']);
    Ok((!line.is_empty()).then(|| line.to_owned()))
}

pub fn call(op: &str, arguments: Value) -> io::Result<Value> {
    Client::connect()?.call(op, arguments)
}

pub fn authorized(op: &str, arguments: Value) -> io::Result<Value> {
    Client::connect()?.authorized(op, arguments)
}

#[derive(Debug, Deserialize, PartialEq)]
pub struct Anchor {
    pub count: u64,
    pub head: String,
    pub last: Option<String>,
}

fn hmac(key: &[u8], message: &[u8]) -> String {
    let mut block = [0u8; 64];
    let used = key.len().min(64);
    block[..used].copy_from_slice(&key[..used]);
    let pad = |byte: u8| block.iter().map(|key| key ^ byte).collect::<Vec<_>>();
    let inner = Sha256::new()
        .chain_update(pad(0x36))
        .chain_update(message)
        .finalize();
    format!(
        "{:x}",
        Sha256::new()
            .chain_update(pad(0x5c))
            .chain_update(inner)
            .finalize()
    )
}

pub fn chain(head: &str, sha256: &str) -> String {
    self::sha256(format!("{head}{sha256}").as_bytes())
}

pub fn anchor(stream: &Path, sha256: &str) -> io::Result<()> {
    if deployed() {
        call("anchor.append", json!({"stream": stream, "sha256": sha256}))?;
    }
    Ok(())
}

pub fn seed(stream: &Path, count: u64, head: &str, last: &str) -> io::Result<()> {
    if deployed() {
        call(
            "anchor.seed",
            json!({"stream": stream, "count": count, "head": head, "last": last}),
        )?;
    }
    Ok(())
}

pub fn anchored(stream: &Path) -> io::Result<Option<Anchor>> {
    if !deployed() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_value(call(
        "anchor.get",
        json!({"stream": stream}),
    )?)?))
}

pub trait Gate: Send + Sync {
    fn peer(&self, stream: &UnixStream) -> io::Result<()>;
    fn authorize(
        &self,
        stream: &UnixStream,
        right: &str,
        authorization: &str,
        password: Option<&str>,
    ) -> bool;
}

pub struct Pinned {
    pins: PathBuf,
}

impl Pinned {
    pub fn new(root: &Path) -> Self {
        Self {
            pins: root.join("pins.json"),
        }
    }
}

impl Gate for Pinned {
    fn peer(&self, stream: &UnixStream) -> io::Result<()> {
        let pins: Value = serde_json::from_slice(&fs::read(&self.pins)?)?;
        let pins = pins["cdhashes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|pin| pin.len() == 40 && pin.bytes().all(|b| b.is_ascii_hexdigit()))
            .collect::<Vec<_>>();
        if pins.is_empty() {
            return Err(failure("authority_pins_missing"));
        }
        platform::verify_peer(stream, &pins)
    }

    fn authorize(
        &self,
        stream: &UnixStream,
        right: &str,
        authorization: &str,
        password: Option<&str>,
    ) -> bool {
        platform::authorize(stream, right, authorization, password)
    }
}

pub(crate) fn peer_uid(stream: &UnixStream) -> Option<u32> {
    platform::peer_uid(stream)
}

pub fn listener() -> io::Result<UnixListener> {
    platform::launchd_listener()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    op: String,
    #[serde(default)]
    arguments: Value,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    authorization: Option<String>,
    #[serde(default)]
    password: Option<String>,
}

pub struct Broker {
    root: PathBuf,
    pub(crate) power: PathBuf,
    state: Mutex<()>,
}

fn read_json(path: &Path, default: Value) -> io::Result<Value> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(default),
        Err(error) => Err(error),
    }
}

fn text<'a>(arguments: &'a Value, key: &str) -> io::Result<&'a str> {
    text_within(arguments, key, 4096)
}

fn text_within<'a>(arguments: &'a Value, key: &str, limit: usize) -> io::Result<&'a str> {
    arguments[key]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= limit)
        .ok_or_else(|| failure("authority_request_invalid"))
}

fn digest_text(arguments: &Value, key: &str) -> io::Result<String> {
    let value = text(arguments, key)?;
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(failure("authority_request_invalid"));
    }
    Ok(value.to_owned())
}

fn nonce() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl Broker {
    pub fn open(root: PathBuf) -> io::Result<Self> {
        if root.canonicalize()? != root {
            return Err(failure("authority_root_invalid"));
        }
        Ok(Self {
            root,
            power: PathBuf::from(crate::power::SOCKET),
            state: Mutex::new(()),
        })
    }

    pub fn serve(self: Arc<Self>, listener: UnixListener, gate: Arc<dyn Gate>) {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else {
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            };
            if gate.peer(&stream).is_err() {
                let _ = stream.write_all(b"{\"error\":\"authority_peer_unverified\"}\n");
                continue;
            }
            let (broker, gate) = (self.clone(), gate.clone());
            std::thread::spawn(move || broker.connection(stream, &*gate));
        }
    }

    fn connection(&self, stream: UnixStream, gate: &dyn Gate) -> io::Result<()> {
        let mut writer = stream.try_clone()?;
        let peer = stream.try_clone()?;
        let mut reader = BufReader::new(stream);
        let (mut challenge, mut hold) = (None, None);
        loop {
            let mut line = String::new();
            (&mut reader).take(LINE_BYTES).read_line(&mut line)?;
            if !line.ends_with('\n') {
                return Ok(());
            }
            let response = match self.request(&peer, &line, &mut challenge, &mut hold, gate) {
                Ok(value) => json!({"ok": value}),
                Err(error) => json!({"error": error.to_string()}),
            };
            let mut bytes = serde_json::to_vec(&response)?;
            bytes.push(b'\n');
            writer.write_all(&bytes)?;
        }
    }

    fn request(
        &self,
        peer: &UnixStream,
        line: &str,
        challenge: &mut Option<(String, String)>,
        hold: &mut Option<crate::power::Hold>,
        gate: &dyn Gate,
    ) -> io::Result<Value> {
        let request: Request =
            serde_json::from_str(line).map_err(|_| failure("authority_request_invalid"))?;
        if request.op == "challenge" {
            let nonce = nonce()?;
            *challenge = Some((nonce.clone(), digest_text(&request.arguments, "sha256")?));
            return Ok(Value::String(nonce));
        }
        if request.op == "power.hold" {
            if hold.is_some() {
                return Err(failure("authority_power_held"));
            }
            *hold = Some(crate::power::Hold::start(
                &self.power,
                &request.arguments,
                peer.try_clone()?,
            )?);
            return Ok(Value::Null);
        }
        // State is keyed by path, so only its owner (or, for an unwritten stream, its directory's owner) may name it.
        for (field, refused) in [
            ("store", "authority_store_unowned"),
            ("stream", "authority_stream_unowned"),
        ] {
            let Some(path) = request
                .arguments
                .get(field)
                .and_then(Value::as_str)
                .map(Path::new)
            else {
                continue;
            };
            let metadata = fs::metadata(path).or_else(|error| match path.parent() {
                Some(parent) if field == "stream" && error.kind() == io::ErrorKind::NotFound => {
                    fs::metadata(parent)
                }
                _ => Err(error),
            });
            let uid = platform::peer_uid(peer);
            if !metadata
                .is_ok_and(|metadata| Some(std::os::unix::fs::MetadataExt::uid(&metadata)) == uid)
            {
                return Err(failure(refused));
            }
            // The first owner to name a path keeps its state, so a path deleted and recreated by another user is refused.
            let directory = crate::workspace::private_path(
                &self.root,
                &["owners"],
                "authority_directory_invalid",
            )?;
            let record = directory.join(format!(
                "{field}-{}.json",
                sha256(path.as_os_str().as_encoded_bytes())
            ));
            let _state = self
                .state
                .lock()
                .map_err(|_| failure("authority_state_poisoned"))?;
            match read_json(&record, Value::Null)? {
                Value::Null => write_private(&record, &json!(uid))?,
                owner if owner != json!(uid) => return Err(failure(refused)),
                _ => {}
            }
        }
        let right = self.right(&request.op, &request.arguments)?;
        if let Some(right) = right {
            let digest = request_digest(&request.op, &request.arguments)?;
            match (challenge.take(), &request.nonce) {
                (Some((expected, sha256)), Some(nonce))
                    if expected == *nonce && sha256 == digest => {}
                _ => return Err(failure("authority_challenge_invalid")),
            }
            if !request.authorization.is_some_and(|authorization| {
                gate.authorize(peer, right, &authorization, request.password.as_deref())
            }) {
                return Err(failure("authority_authorization_denied"));
            }
        }
        let _state = self
            .state
            .lock()
            .map_err(|_| failure("authority_state_poisoned"))?;
        self.dispatch(&request.op, request.arguments, right.is_some())
    }

    fn store(&self, arguments: &Value) -> io::Result<PathBuf> {
        let store = text(arguments, "store")?;
        if !Path::new(store).is_absolute() {
            return Err(failure("authority_request_invalid"));
        }
        crate::workspace::private_path(
            &self.root,
            &["stores", &sha256(store.as_bytes())],
            "authority_directory_invalid",
        )
    }

    fn profiles(&self, arguments: &Value) -> io::Result<crate::credentials::CredentialProfiles> {
        crate::credentials::CredentialProfiles::local(&self.store(arguments)?)
    }

    fn right(&self, op: &str, arguments: &Value) -> io::Result<Option<&'static str>> {
        Ok(match op {
            "grants.put" => {
                let _state = self
                    .state
                    .lock()
                    .map_err(|_| failure("authority_state_poisoned"))?;
                self.adds_grants(arguments)?.then_some(GRANT_RIGHT)
            }
            "credentials.store_secret" | "credentials.store_auth" | "credentials.set_default" => {
                Some(GRANT_RIGHT)
            }
            "credentials.remove" => {
                let _state = self
                    .state
                    .lock()
                    .map_err(|_| failure("authority_state_poisoned"))?;
                self.profiles(arguments)?
                    .enrolled(text(arguments, "id")?)?
                    .then_some(GRANT_RIGHT)
            }
            "policy.put" | "policy.rollback" => Some(POLICY_RIGHT),
            _ => None,
        })
    }

    /// Revoking grants needs no authorization; adding any does.
    fn adds_grants(&self, arguments: &Value) -> io::Result<bool> {
        let current = read_json(
            &self.store(arguments)?.join("grants.json"),
            json!({"generation": 0, "grants": []}),
        )?;
        let granted = current["grants"].as_array().cloned().unwrap_or_default();
        Ok(arguments["grants"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|grant| !granted.contains(grant)))
    }

    fn dispatch(&self, op: &str, arguments: Value, authorized: bool) -> io::Result<Value> {
        let id = || text(&arguments, "id");
        Ok(match op {
            "credentials.list" => serde_json::to_value(self.profiles(&arguments)?.list()?)?,
            "credentials.visible" => {
                json!(
                    self.profiles(&arguments)?
                        .visible(text(&arguments, "caller")?)?
                )
            }
            "credentials.public" => {
                let profiles = self.profiles(&arguments)?;
                profiles.public(&profiles.profile(id()?)?)?
            }
            "credentials.profile" => {
                serde_json::to_value(self.profiles(&arguments)?.profile(id()?)?)?
            }
            "credentials.secret" => {
                let secret = self.profiles(&arguments)?.secret(
                    id()?,
                    text(&arguments, "origin")?,
                    arguments["owner"].as_str(),
                )?;
                json!({"token": secret.token, "account_id": secret.account_id})
            }
            "credentials.owned_secret" => self
                .profiles(&arguments)?
                .owned_secret(id()?, text(&arguments, "owner")?)?,
            "credentials.create" => serde_json::to_value(self.profiles(&arguments)?.create(
                text(&arguments, "label")?,
                text(&arguments, "kind")?,
                arguments["provider"].as_str(),
                arguments["origin"].as_str(),
            )?)?,
            "credentials.create_secret" => {
                serde_json::to_value(self.profiles(&arguments)?.create_secret(
                    text(&arguments, "label")?,
                    text(&arguments, "origin")?,
                    text(&arguments, "owner")?,
                )?)?
            }
            "credentials.remove" => {
                let profiles = self.profiles(&arguments)?;
                if !authorized && profiles.enrolled(id()?)? {
                    return Err(failure("authority_authorization_denied"));
                }
                json!(profiles.remove(id()?)?)
            }
            "credentials.store_secret" => {
                self.profiles(&arguments)?
                    .store_secret(id()?, text(&arguments, "value")?)?;
                Value::Null
            }
            "credentials.store_auth" => {
                self.profiles(&arguments)?
                    .store_auth(id()?, text_within(&arguments, "auth", 65_536)?)?;
                Value::Null
            }
            "credentials.set_default" => {
                self.profiles(&arguments)?.set_default(id()?)?;
                Value::Null
            }
            "grants.get" => read_json(
                &self.store(&arguments)?.join("grants.json"),
                json!({"generation": 0, "grants": []}),
            )?,
            "grants.put" => {
                if !authorized && self.adds_grants(&arguments)? {
                    return Err(failure("authority_authorization_denied"));
                }
                let path = self.store(&arguments)?.join("grants.json");
                let current = read_json(&path, json!({"generation": 0, "grants": []}))?;
                if arguments["generation"] != current["generation"] {
                    return Err(failure("authority_grants_stale"));
                }
                let grants = arguments["grants"]
                    .as_array()
                    .filter(|grants| grants.len() <= GRANTS_LIMIT)
                    .ok_or_else(|| failure("authority_request_invalid"))?;
                let generation = current["generation"].as_u64().unwrap_or_default() + 1;
                let next = json!({"generation": generation, "grants": grants});
                write_private(&path, &next)?;
                next
            }
            "policy.get" => read_json(&self.root.join("policy.json"), json!({}))?
                [text(&arguments, "key")?]
            .clone(),
            "policy.put" => {
                let key = text(&arguments, "key")?;
                if key.len() > 128
                    || serde_json::to_vec(&arguments["value"])?.len() > POLICY_VALUE_BYTES
                {
                    return Err(failure("authority_request_invalid"));
                }
                let (path, kept) = (
                    self.root.join("policy.json"),
                    self.root.join("policy-previous.json"),
                );
                let (mut policy, mut previous) =
                    (read_json(&path, json!({}))?, read_json(&kept, json!({}))?);
                previous[key] = policy[key].clone();
                policy[key] = arguments["value"].clone();
                write_private(&kept, &previous)?;
                write_private(&path, &policy)?;
                Value::Null
            }
            "policy.rollback" => {
                let key = text(&arguments, "key")?;
                let (path, kept) = (
                    self.root.join("policy.json"),
                    self.root.join("policy-previous.json"),
                );
                let (mut policy, mut previous) =
                    (read_json(&path, json!({}))?, read_json(&kept, json!({}))?);
                if previous.get(key).is_none() {
                    return Err(failure("authority_policy_previous_missing"));
                }
                let restored = previous[key].take();
                previous[key] = policy[key].take();
                policy[key] = restored;
                write_private(&kept, &previous)?;
                write_private(&path, &policy)?;
                Value::Null
            }
            "peer.seal" | "peer.verify" => {
                let entry = digest_text(&arguments, "sha256")?;
                let path = self.root.join("peer-key.json");
                let mut stored = read_json(&path, json!({}))?;
                if !stored["key"].is_string() {
                    stored = json!({"key": format!("{}{}", nonce()?, nonce()?)});
                    write_private(&path, &stored)?;
                }
                let tag = hmac(
                    stored["key"].as_str().unwrap_or_default().as_bytes(),
                    entry.as_bytes(),
                );
                if op == "peer.seal" {
                    Value::String(tag)
                } else {
                    Value::Bool(text(&arguments, "tag")? == tag)
                }
            }
            "anchor.get" | "anchor.append" | "anchor.seed" => {
                let stream = text(&arguments, "stream")?;
                let path = crate::workspace::private_path(
                    &self.root,
                    &["anchors"],
                    "authority_directory_invalid",
                )?
                .join(format!("{}.json", sha256(stream.as_bytes())));
                let mut anchor = read_json(
                    &path,
                    json!({"stream": stream, "count": 0, "head": "", "last": null}),
                )?;
                if op == "anchor.seed" {
                    if anchor["count"] != 0 {
                        return Err(failure("authority_anchor_exists"));
                    }
                    anchor = json!({"stream": stream,
                        "count": arguments["count"].as_u64().filter(|count| *count > 0)
                            .ok_or_else(|| failure("authority_request_invalid"))?,
                        "head": digest_text(&arguments, "head")?,
                        "last": digest_text(&arguments, "last")?});
                    write_private(&path, &anchor)?;
                } else if op == "anchor.append" {
                    let entry = digest_text(&arguments, "sha256")?;
                    anchor = json!({"stream": stream,
                        "count": anchor["count"].as_u64().unwrap_or_default() + 1,
                        "head": chain(anchor["head"].as_str().unwrap_or_default(), &entry),
                        "last": entry});
                    write_private(&path, &anchor)?;
                }
                anchor
            }
            _ => return Err(failure("authority_operation_unknown")),
        })
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::failure;
    use base64::Engine;
    use security_framework_sys::authorization as sys;
    use std::io;
    use std::os::fd::AsRawFd;
    use std::os::fd::FromRawFd;
    use std::os::unix::net::UnixListener;
    use std::os::unix::net::UnixStream;

    const SOL_LOCAL: libc::c_int = 0;
    const LOCAL_PEERTOKEN: libc::c_int = 0x006;

    unsafe extern "C" {
        fn launch_activate_socket(
            name: *const libc::c_char,
            fds: *mut *mut libc::c_int,
            count: *mut libc::size_t,
        ) -> libc::c_int;
    }

    pub(super) fn launchd_listener() -> io::Result<UnixListener> {
        let mut fds = std::ptr::null_mut();
        let mut count = 0;
        let status = unsafe { launch_activate_socket(c"Listener".as_ptr(), &mut fds, &mut count) };
        if status != 0 || count == 0 {
            return Err(io::Error::from_raw_os_error(status));
        }
        let fd = unsafe { *fds };
        unsafe { libc::free(fds.cast()) };
        Ok(unsafe { UnixListener::from_raw_fd(fd) })
    }

    pub(super) fn verify_peer(stream: &UnixStream, pins: &[&str]) -> io::Result<()> {
        let mut token = [0u8; 32];
        let mut length = token.len() as libc::socklen_t;
        let status = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                SOL_LOCAL,
                LOCAL_PEERTOKEN,
                token.as_mut_ptr().cast(),
                &mut length,
            )
        };
        if status != 0 || length as usize != token.len() {
            return Err(failure("authority_peer_unverified"));
        }
        // The kernel's view of the running peer, so its executable need not be readable by the broker.
        let pid = u32::from_ne_bytes([token[20], token[21], token[22], token[23]]) as libc::pid_t;
        let (mut flags, mut cdhash) = (0u32, [0u8; 20]);
        let known = unsafe {
            csops_audittoken(
                pid,
                CS_OPS_STATUS,
                (&raw mut flags).cast(),
                4,
                token.as_mut_ptr(),
            ) == 0
                && csops_audittoken(
                    pid,
                    CS_OPS_CDHASH,
                    cdhash.as_mut_ptr().cast(),
                    20,
                    token.as_mut_ptr(),
                ) == 0
        };
        let cdhash = cdhash
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if known && flags & CS_VALID != 0 && pins.contains(&cdhash.as_str()) {
            Ok(())
        } else {
            Err(failure("authority_peer_unverified"))
        }
    }

    const CS_OPS_STATUS: libc::c_uint = 0;
    const CS_OPS_CDHASH: libc::c_uint = 5;
    const CS_VALID: u32 = 0x1;

    unsafe extern "C" {
        fn csops_audittoken(
            pid: libc::pid_t,
            ops: libc::c_uint,
            useraddr: *mut libc::c_void,
            usersize: libc::size_t,
            token: *mut u8,
        ) -> libc::c_int;
    }

    unsafe extern "C" {
        fn SessionGetInfo(session: u32, id: *mut u32, attributes: *mut u32) -> i32;
    }

    pub(super) fn graphic_session() -> bool {
        const CALLER_SESSION: u32 = u32::MAX;
        const HAS_GRAPHIC_ACCESS: u32 = 0x0010;
        let (mut id, mut attributes) = (0, 0);
        let status = unsafe { SessionGetInfo(CALLER_SESSION, &mut id, &mut attributes) };
        status != 0 || attributes & HAS_GRAPHIC_ACCESS != 0
    }

    pub(super) fn peer_uid(stream: &UnixStream) -> Option<u32> {
        let (mut uid, mut gid) = (0, 0);
        // SAFETY: both out-pointers are valid for the call.
        (unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } == 0).then_some(uid)
    }

    fn peer_user(stream: &UnixStream) -> Option<std::ffi::CString> {
        let (mut uid, mut gid) = (0, 0);
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
            return None;
        }
        let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
        let mut buffer = vec![0 as libc::c_char; 4096];
        let mut found = std::ptr::null_mut();
        let status = unsafe {
            libc::getpwuid_r(
                uid,
                &mut entry,
                buffer.as_mut_ptr(),
                buffer.len(),
                &mut found,
            )
        };
        if status != 0 || found.is_null() {
            return None;
        }
        Some(unsafe { std::ffi::CStr::from_ptr(entry.pw_name) }.to_owned())
    }

    pub(super) fn authorize(
        stream: &UnixStream,
        right: &str,
        authorization: &str,
        password: Option<&str>,
    ) -> bool {
        let credentials = match password {
            Some(password) => match (peer_user(stream), std::ffi::CString::new(password)) {
                (Some(user), Ok(password)) => Some((user, password)),
                _ => return false,
            },
            None => None,
        };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(authorization) else {
            return false;
        };
        let mut form = sys::AuthorizationExternalForm {
            bytes: [0; sys::kAuthorizationExternalFormLength],
        };
        if bytes.len() != form.bytes.len() {
            return false;
        }
        for (target, byte) in form.bytes.iter_mut().zip(bytes) {
            *target = byte as libc::c_char;
        }
        let Ok(name) = std::ffi::CString::new(right) else {
            return false;
        };
        let mut handle = std::ptr::null_mut();
        if unsafe { sys::AuthorizationCreateFromExternalForm(&form, &mut handle) }
            != sys::errAuthorizationSuccess
        {
            return false;
        }
        let mut item = sys::AuthorizationItem {
            name: name.as_ptr(),
            valueLength: 0,
            value: std::ptr::null_mut(),
            flags: 0,
        };
        let rights = sys::AuthorizationItemSet {
            count: 1,
            items: &mut item,
        };
        let mut supplied = credentials
            .iter()
            .flat_map(|(user, password)| [(c"username", user), (c"password", password)])
            .map(|(name, value)| sys::AuthorizationItem {
                name: name.as_ptr(),
                valueLength: value.as_bytes().len(),
                value: value.as_ptr() as *mut libc::c_void,
                flags: 0,
            })
            .collect::<Vec<_>>();
        let environment = sys::AuthorizationItemSet {
            count: supplied.len() as u32,
            items: supplied.as_mut_ptr(),
        };
        let flags = if credentials.is_some() {
            sys::kAuthorizationFlagExtendRights
        } else {
            sys::kAuthorizationFlagInteractionAllowed | sys::kAuthorizationFlagExtendRights
        };
        let status = unsafe {
            sys::AuthorizationCopyRights(handle, &rights, &environment, flags, std::ptr::null_mut())
        };
        unsafe { sys::AuthorizationFree(handle, sys::kAuthorizationFlagDestroyRights) };
        status == sys::errAuthorizationSuccess
    }

    pub(super) struct Authorization(security_framework::authorization::Authorization);

    impl Authorization {
        pub(super) fn create() -> io::Result<Self> {
            security_framework::authorization::Authorization::default()
                .map(Self)
                .map_err(|_| failure("authority_authorization_unavailable"))
        }

        pub(super) fn external(&self) -> io::Result<String> {
            let form = self
                .0
                .make_external_form()
                .map_err(|_| failure("authority_authorization_unavailable"))?;
            Ok(base64::engine::general_purpose::STANDARD.encode(
                form.bytes
                    .iter()
                    .map(|byte| *byte as u8)
                    .collect::<Vec<_>>(),
            ))
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::failure;
    use std::io;
    use std::os::unix::net::UnixListener;
    use std::os::unix::net::UnixStream;

    pub(super) fn launchd_listener() -> io::Result<UnixListener> {
        Err(failure("authority_broker_unsupported"))
    }

    pub(super) fn verify_peer(_stream: &UnixStream, _pins: &[&str]) -> io::Result<()> {
        Err(failure("authority_broker_unsupported"))
    }

    pub(super) fn graphic_session() -> bool {
        true
    }

    pub(super) fn peer_uid(_stream: &UnixStream) -> Option<u32> {
        None
    }

    pub(super) fn authorize(
        _stream: &UnixStream,
        _right: &str,
        _authorization: &str,
        _password: Option<&str>,
    ) -> bool {
        false
    }

    pub(super) struct Authorization;

    impl Authorization {
        pub(super) fn create() -> io::Result<Self> {
            Err(failure("authority_broker_unsupported"))
        }

        pub(super) fn external(&self) -> io::Result<String> {
            Err(failure("authority_broker_unsupported"))
        }
    }
}

#[cfg(test)]
#[path = "broker_tests.rs"]
mod tests;
