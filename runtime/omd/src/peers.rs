//! Peer-session mailboxes in a shared mod store, countersigned by the authority broker.

use crate::broker;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::io::Write;
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

pub const MESSAGE_BYTES: usize = 65_536;
const TTL_MS: std::ops::RangeInclusive<u64> = 1_000..=3_600_000;
const INBOX_LIMIT: usize = 64;

fn failure(code: impl Into<String>) -> io::Error {
    io::Error::other(code.into())
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

pub trait Seal: Send + Sync {
    fn seal(&self, sha256: &str) -> io::Result<String>;
    fn verify(&self, sha256: &str, tag: &str) -> io::Result<bool>;
}

pub struct SocketSeal(pub PathBuf);

impl Seal for SocketSeal {
    fn seal(&self, sha256: &str) -> io::Result<String> {
        broker::Client::at(&self.0)?
            .call("peer.seal", json!({"sha256": sha256}))?
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| failure("authority_response_invalid"))
    }

    fn verify(&self, sha256: &str, tag: &str) -> io::Result<bool> {
        Ok(broker::Client::at(&self.0)?
            .call("peer.verify", json!({"sha256": sha256, "tag": tag}))?
            == true)
    }
}

/// The deployed authority broker, which admits only pinned OMD binaries; peers fail closed without it.
pub struct BrokerSeal;

impl BrokerSeal {
    fn socket() -> io::Result<SocketSeal> {
        if !broker::deployed() {
            return Err(failure(
                "peers_unavailable: the authority broker is not deployed",
            ));
        }
        Ok(SocketSeal(PathBuf::from(broker::SOCKET)))
    }
}

impl Seal for BrokerSeal {
    fn seal(&self, sha256: &str) -> io::Result<String> {
        Self::socket()?.seal(sha256)
    }

    fn verify(&self, sha256: &str, tag: &str) -> io::Result<bool> {
        Self::socket()?.verify(sha256, tag)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Endpoint {
    pub package: String,
    pub sha256: String,
    pub projects: String,
}

#[derive(Clone, Debug)]
pub struct Inbound {
    pub message: Value,
}

struct Sent {
    package: String,
    to: String,
    expires_at_ms: u64,
}

pub struct Peers {
    root: PathBuf,
    session: String,
    repository: PathBuf,
    _lock: fs::File,
    /// Message ids already taken, until they expire; a replay after that is refused as expired.
    seen: Mutex<BTreeMap<String, u64>>,
    sent: Mutex<BTreeMap<String, Sent>>,
}

fn write_atomic(path: &Path, value: &Value) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| failure("peer_path_invalid"))?;
    private_directory(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        std::process::id(),
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("entry")
    ));
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)?
        .write_all(&serde_json::to_vec(value)?)?;
    fs::rename(&temporary, path)
}

fn private_directory(path: &Path) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

/// Opens each complete `.json` entry before removing it; a failure keeps it queued and ends the pass with what was taken.
fn drain<T>(
    directory: &Path,
    mut take: impl FnMut(&Value) -> io::Result<Option<T>>,
) -> io::Result<(Vec<T>, bool)> {
    let mut taken = Vec::new();
    for entry in fs::read_dir(directory).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let envelope = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let item = match envelope.as_ref().map(&mut take).transpose() {
            Ok(item) => item.flatten(),
            Err(error) if taken.is_empty() => return Err(error),
            Err(_) => return Ok((taken, false)),
        };
        taken.extend(item);
        if let Err(error) = fs::remove_file(&path) {
            return if taken.is_empty() {
                Err(error)
            } else {
                Ok((taken, false))
            };
        }
    }
    Ok((taken, true))
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
}

fn sealed(seal: &dyn Seal, key: &str, body: Value) -> io::Result<Value> {
    let tag = seal.seal(&broker::sha256(broker::canonical(&body).as_bytes()))?;
    Ok(json!({key: body, "tag": tag}))
}

fn opened(seal: &dyn Seal, key: &str, envelope: &Value) -> io::Result<Option<Value>> {
    let body = &envelope[key];
    let Some(tag) = envelope["tag"]
        .as_str()
        .filter(|tag| !tag.is_empty() && tag.len() <= 4096)
    else {
        return Ok(None);
    };
    Ok(seal
        .verify(&broker::sha256(broker::canonical(body).as_bytes()), tag)?
        .then(|| body.clone()))
}

impl Peers {
    /// Registers `session` (a lead thread) under `<store>/peers`; the held lock marks it live.
    pub fn open(store: &Path, session: &str, repository: &Path) -> io::Result<Self> {
        if !identifier(session) {
            return Err(failure("peer_session_invalid"));
        }
        let root = store.join("peers");
        private_directory(&root.join("sessions"))?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .open(root.join("sessions").join(format!("{session}.lock")))?;
        lock.try_lock()
            .map_err(|_| failure("peer_session_already_registered"))?;
        Ok(Self {
            root,
            session: session.to_owned(),
            repository: repository.to_owned(),
            _lock: lock,
            seen: Mutex::new(BTreeMap::new()),
            sent: Mutex::new(BTreeMap::new()),
        })
    }

    pub fn session(&self) -> &str {
        &self.session
    }

    pub fn publish(&self, endpoints: &[Endpoint]) -> io::Result<()> {
        write_atomic(
            &self
                .root
                .join("sessions")
                .join(format!("{}.json", self.session)),
            &json!({"session": self.session, "repository": self.repository, "pid": std::process::id(),
                "packages": endpoints.iter().map(|endpoint| json!({"id": endpoint.package, "projects": endpoint.projects})).collect::<Vec<_>>()}),
        )
    }

    fn live(&self, session: &str) -> bool {
        fs::OpenOptions::new()
            .write(true)
            .open(self.root.join("sessions").join(format!("{session}.lock")))
            .is_ok_and(|file| file.try_lock().is_err())
    }

    fn registration(&self, session: &str) -> Option<Value> {
        let text = fs::read(self.root.join("sessions").join(format!("{session}.json"))).ok()?;
        serde_json::from_slice(&text).ok()
    }

    fn reachable(&self, from: &Endpoint, registration: &Value, package: &str) -> bool {
        let same = registration["repository"].as_str() == self.repository.to_str();
        registration["packages"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|entry| {
                entry["id"] == package
                    && (same || from.projects == "any" && entry["projects"] == "any")
            })
    }

    pub fn list(&self, from: &Endpoint, package: &str) -> io::Result<Vec<Value>> {
        let mut sessions = Vec::new();
        for entry in fs::read_dir(self.root.join("sessions"))? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            let Some(session) = name.strip_suffix(".json") else {
                continue;
            };
            if session == self.session || !self.live(session) {
                continue;
            }
            if let Some(registration) = self.registration(session)
                && self.reachable(from, &registration, package)
            {
                sessions.push(json!({"session": session, "package": package,
                    "repository": registration["repository"],
                    "same_project": registration["repository"].as_str() == self.repository.to_str()}));
            }
        }
        Ok(sessions)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn send(
        &self,
        seal: &dyn Seal,
        from: &Endpoint,
        to: &str,
        package: &str,
        data: Value,
        correlation: Option<String>,
        ttl_ms: u64,
    ) -> io::Result<Value> {
        if !identifier(to) || !identifier(package) {
            return Err(failure("peer_address_invalid"));
        }
        if !TTL_MS.contains(&ttl_ms) {
            return Err(failure("peer_ttl_invalid"));
        }
        if serde_json::to_vec(&data)?.len() > MESSAGE_BYTES
            || correlation.as_ref().is_some_and(|value| value.len() > 256)
        {
            return Err(failure("peer_message_limit"));
        }
        if !self.live(to) {
            return Err(failure("peer_closed: the recipient session is not running"));
        }
        let registration = self
            .registration(to)
            .ok_or_else(|| failure("peer_closed: the recipient session is not running"))?;
        if !self.reachable(from, &registration, package) {
            return Err(failure("peer_scope_denied"));
        }
        let inbox = self.root.join("inbox").join(to);
        if fs::read_dir(&inbox).map_or(0, Iterator::count) >= INBOX_LIMIT {
            return Err(failure("peer_inbox_full"));
        }
        let sent_at_ms = now_ms();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        let id = broker::sha256(
            format!(
                "{}:{}:{nanos}:{}",
                self.session,
                from.package,
                std::process::id()
            )
            .as_bytes(),
        )[..32]
            .to_owned();
        let message = json!({"id": id, "from": {"session": self.session, "repository": self.repository,
                "package": from.package, "sha256": from.sha256},
            "to": {"session": to, "package": package}, "correlation": correlation, "data": data,
            "sent_at_ms": sent_at_ms, "expires_at_ms": sent_at_ms + ttl_ms});
        write_atomic(
            &inbox.join(format!("{id}.json")),
            &sealed(seal, "message", message)?,
        )?;
        if let Ok(mut sent) = self.sent.lock() {
            sent.insert(
                id.clone(),
                Sent {
                    package: from.package.clone(),
                    to: to.to_owned(),
                    expires_at_ms: sent_at_ms + ttl_ms,
                },
            );
        }
        Ok(json!({"id": id, "status": "queued", "to": {"session": to, "package": package}}))
    }

    /// Takes verified, unexpired, first-seen messages; expired ones get a receipt, replays are dropped.
    pub fn receive(&self, seal: &dyn Seal) -> io::Result<Vec<Inbound>> {
        let inbox = self.root.join("inbox").join(&self.session);
        let now = now_ms();
        if let Ok(mut seen) = self.seen.lock() {
            seen.retain(|_, expires_at_ms| *expires_at_ms >= now);
        }
        let (messages, _) =
            drain(&inbox, |envelope| {
                let Some(message) = opened(seal, "message", envelope)? else {
                    return Ok(None);
                };
                if message["to"]["session"] != self.session.as_str() {
                    return Ok(None);
                }
                let id = message["id"].as_str().unwrap_or_default().to_owned();
                let expires_at_ms = message["expires_at_ms"].as_u64();
                if !self.seen.lock().is_ok_and(|mut seen| {
                    seen.insert(id, expires_at_ms.unwrap_or_default()).is_none()
                }) {
                    return Ok(None);
                }
                if expires_at_ms.is_none_or(|at| at < now_ms()) {
                    self.receipt(seal, &message, "expired", None)?;
                    return Ok(None);
                }
                Ok(Some(Inbound { message }))
            })?;
        Ok(messages)
    }

    pub fn admits(&self, endpoint: &Endpoint, message: &Value) -> bool {
        endpoint.projects == "any"
            || message["from"]["repository"].as_str() == self.repository.to_str()
    }

    pub fn receipt(
        &self,
        seal: &dyn Seal,
        message: &Value,
        status: &str,
        reason: Option<String>,
    ) -> io::Result<()> {
        let Some(sender) = message["from"]["session"]
            .as_str()
            .filter(|session| identifier(session))
        else {
            return Ok(());
        };
        let id = message["id"].as_str().unwrap_or_default();
        let receipt = json!({"id": id, "status": status, "reason": reason, "at_ms": now_ms(),
            "by": {"session": self.session, "package": message["to"]["package"]},
            "correlation": message["correlation"]});
        write_atomic(
            &self
                .root
                .join("receipts")
                .join(sender)
                .join(format!("{id}.json")),
            &sealed(seal, "receipt", receipt)?,
        )
    }

    /// Verified receipts for messages this session sent, plus `expired` or `closed` for messages whose time ran out without one.
    pub fn receipts(&self, seal: &dyn Seal) -> io::Result<Vec<(String, Value)>> {
        let directory = self.root.join("receipts").join(&self.session);
        let (mut settled, complete) = drain(&directory, |envelope| {
            let Some(receipt) = opened(seal, "receipt", envelope)? else {
                return Ok(None);
            };
            Ok(self
                .sent
                .lock()
                .ok()
                .and_then(|mut sent| sent.remove(receipt["id"].as_str().unwrap_or_default()))
                .map(|sent| (sent.package, receipt)))
        })?;
        if !complete {
            return Ok(settled);
        }
        let now = now_ms();
        let lapsed = self
            .sent
            .lock()
            .map(|mut sent| {
                let ids = sent
                    .iter()
                    .filter(|(_, entry)| entry.expires_at_ms + 5_000 < now)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                ids.into_iter()
                    .filter_map(|id| sent.remove(&id).map(|entry| (id, entry)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (id, entry) in lapsed {
            let status = if self.live(&entry.to) {
                "expired"
            } else {
                "closed"
            };
            let _ = fs::remove_file(
                self.root
                    .join("inbox")
                    .join(&entry.to)
                    .join(format!("{id}.json")),
            );
            settled.push((
                entry.package,
                json!({"id": id, "status": status, "reason": "no receipt before the message expired",
                    "at_ms": now, "by": {"session": entry.to, "package": null}, "correlation": null}),
            ));
        }
        Ok(settled)
    }
}

impl Drop for Peers {
    fn drop(&mut self) {
        let sessions = self.root.join("sessions");
        let _ = fs::remove_file(sessions.join(format!("{}.json", self.session)));
    }
}

#[cfg(test)]
#[path = "peers_tests.rs"]
mod tests;
