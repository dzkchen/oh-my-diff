#[cfg(target_os = "macos")]
use codex_network_proxy::ManagedNetworkSandboxContext;
#[cfg(target_os = "macos")]
use codex_protocol::permissions::FileSystemAccessMode;
#[cfg(target_os = "macos")]
use codex_protocol::permissions::FileSystemPath;
#[cfg(target_os = "macos")]
use codex_protocol::permissions::FileSystemSandboxEntry;
#[cfg(target_os = "macos")]
use codex_protocol::permissions::FileSystemSandboxKind;
use codex_protocol::permissions::FileSystemSandboxPolicy;
#[cfg(target_os = "macos")]
use codex_protocol::permissions::NetworkSandboxPolicy;
#[cfg(target_os = "macos")]
use codex_sandboxing::seatbelt::CreateSeatbeltCommandArgsParams;
#[cfg(target_os = "macos")]
use codex_sandboxing::seatbelt::MACOS_PATH_TO_SEATBELT_EXECUTABLE;
#[cfg(target_os = "macos")]
use codex_sandboxing::seatbelt::create_seatbelt_command_args;
#[cfg(target_os = "macos")]
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_pty::process_group::kill_process_group;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::fs;
use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
#[cfg(target_os = "macos")]
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

type Key = (String, u64, String);
type Session = Arc<Mutex<ManagedProcess>>;
type WriteRequest = (Vec<Value>, mpsc::SyncSender<Result<(), String>>);

const INPUT_MESSAGES: usize = 128;
const INPUT_BYTES: usize = 256 * 1024;
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const EXCHANGE_WRITE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
struct InputQueue {
    messages: std::collections::VecDeque<(Value, usize)>,
    bytes: usize,
    closed: bool,
}

impl InputQueue {
    fn offer(&mut self, message: Value) -> bool {
        let bytes = serde_json::to_vec(&message).map_or(usize::MAX, |bytes| bytes.len());
        if self.closed || bytes > INPUT_BYTES {
            self.close();
            return false;
        }
        let replaceable = |value: &Value| {
            if value.get("box").is_some() {
                Some(0)
            } else {
                match value["pointer"]["action"].as_str() {
                    Some("move") => Some(1),
                    Some("drag") => Some(2),
                    _ => None,
                }
            }
        };
        if let Some((last, size)) = self.messages.back()
            && replaceable(&message).is_some()
            && replaceable(&message) == replaceable(last)
        {
            self.bytes -= size;
            self.messages.pop_back();
        }
        if self.messages.len() >= INPUT_MESSAGES || self.bytes + bytes > INPUT_BYTES {
            self.close();
            return false;
        }
        self.bytes += bytes;
        self.messages.push_back((message, bytes));
        true
    }

    fn take(&mut self) -> Option<Value> {
        let (message, bytes) = self.messages.pop_front()?;
        self.bytes -= bytes;
        Some(message)
    }

    fn close(&mut self) {
        self.closed = true;
        self.messages.clear();
        self.bytes = 0;
    }
}

fn write_until(
    writer: &mpsc::SyncSender<WriteRequest>,
    messages: Vec<Value>,
    deadline: Instant,
    active: &impl Fn() -> bool,
) -> Result<(), String> {
    let (reply, written) = mpsc::sync_channel(1);
    let mut request = (messages, reply);
    loop {
        if !active() {
            return Err("process_cancelled".into());
        }
        if Instant::now() >= deadline {
            return Err("process_write_timeout".into());
        }
        match writer.try_send(request) {
            Ok(()) => break,
            Err(mpsc::TrySendError::Disconnected(_)) => return Err("process_writer_stopped".into()),
            Err(mpsc::TrySendError::Full(pending)) => {
                request = pending;
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
    loop {
        if !active() {
            return Err("process_cancelled".into());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        match written.recv_timeout(remaining.min(Duration::from_millis(50))) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => (),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("process_writer_stopped".into());
            }
            _ => return Err("process_write_timeout".into()),
        }
    }
}

fn input_sink(
    writer: mpsc::SyncSender<WriteRequest>,
    group: u32,
    reaped: Arc<Mutex<bool>>,
) -> codex_omd::process_raster::Sink {
    let pending = Arc::new(Mutex::new(InputQueue::default()));
    let (notify, notified) = mpsc::sync_channel(1);
    let queued = pending.clone();
    let worker_reaped = reaped.clone();
    std::thread::spawn(move || {
        while notified.recv().is_ok() {
            loop {
                let message = queued.lock().unwrap_or_else(PoisonError::into_inner).take();
                let Some(message) = message else {
                    break;
                };
                if write_until(
                    &writer,
                    vec![message],
                    Instant::now() + WRITE_TIMEOUT,
                    &|| true,
                )
                .is_err()
                {
                    queued
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .close();
                    kill_group_if_alive(group, &worker_reaped);
                    return;
                }
            }
        }
    });
    Arc::new(move |message| {
        let accepted = pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .offer(message);
        if !accepted {
            kill_group_if_alive(group, &reaped);
            return false;
        }
        !matches!(
            notify.try_send(()),
            Err(mpsc::TrySendError::Disconnected(_))
        )
    })
}

pub(super) struct ProcessNotice {
    pub owner: String,
    pub session: String,
    pub output_bytes: Option<usize>,
    pub exited: bool,
    pub deliver: bool,
}

pub(super) type ProcessNotifier = Arc<dyn Fn(ProcessNotice) + Send + Sync>;

pub(super) type BlitSink = Arc<
    dyn Fn(
            Value,
            Arc<dyn Fn() -> bool + Send + Sync>,
        ) -> Result<Value, codex_omd::client_surface::BlitError>
        + Send
        + Sync,
>;

const BLIT_RETRY: Duration = Duration::from_millis(100);
const BLIT_ATTEMPTS: u32 = 50;

#[derive(Default)]
pub(super) struct ManagedProcesses {
    records: Mutex<BTreeMap<Key, Session>>,
    notifier: std::sync::OnceLock<ProcessNotifier>,
}

#[derive(Clone, Copy)]
pub(super) struct ProcessOwner<'a> {
    pub thread: Option<&'a str>,
    pub id: &'a str,
    pub generation: u64,
    pub repository: &'a Path,
    pub policy: &'a FileSystemSandboxPolicy,
    pub protected: &'a [PathBuf],
    pub os_access: Option<&'a codex_omd::ModOsAccess>,
    pub blit: Option<&'a BlitSink>,
    pub environment: Option<&'a codex_omd::host::EnvironmentValues>,
}

struct ManagedProcess {
    child: Child,
    unrestricted: bool,
    sender: mpsc::SyncSender<WriteRequest>,
    receiver: mpsc::Receiver<io::Result<Value>>,
    /// Received past one exchange's limit or after its output; the next exchange returns it first.
    pending: Option<io::Result<Value>>,
    /// When an exchange first saw the leader exited; its readers get one second from then to finish.
    exited_at: Option<Instant>,
    stdin: bool,
    scratch: PathBuf,
    last_used: Instant,
    /// Set under the lock that reaps the child, so nothing signals a pid the system may have reused.
    reaped: Arc<Mutex<bool>>,
    _raster: Option<codex_omd::process_raster::Binding>,
}

impl ManagedProcess {
    /// Leaves an exited leader unreaped, so its group id stays reserved until Drop kills the group.
    fn exited(&self) -> io::Result<bool> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::waitid(
                libc::P_PID,
                self.child.id(),
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { info.si_pid() } != 0)
    }
}

/// Blocks until the leader has exited, without reaping it; fails once something else has.
fn wait_for_exit(pid: u32) -> io::Result<()> {
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe { libc::waitid(libc::P_PID, pid, &mut info, libc::WEXITED | libc::WNOWAIT) } == 0
        {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn kill_group_if_alive(group: u32, reaped: &Mutex<bool>) {
    if !*reaped.lock().unwrap_or_else(PoisonError::into_inner) {
        let _ = kill_process_group(group);
    }
}

impl Drop for ManagedProcess {
    fn drop(&mut self) {
        let mut reaped = self.reaped.lock().unwrap_or_else(PoisonError::into_inner);
        let _ = kill_process_group(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
        *reaped = true;
        drop(reaped);
        let _ = fs::remove_dir_all(&self.scratch);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Framing {
    ContentLength,
    Ndjson,
    Raw,
}

fn program_sha256(path: &Path) -> io::Result<String> {
    static HASHES: Mutex<BTreeMap<PathBuf, (codex_omd::FileStamp, String)>> =
        Mutex::new(BTreeMap::new());
    let stamp = codex_omd::file_stamp(&fs::metadata(path)?);
    if let Some((known, sha256)) = HASHES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(path)
        && *known == stamp
    {
        return Ok(sha256.clone());
    }
    let sha256 = crate::execution::hash(&fs::read(path)?);
    HASHES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(path.to_path_buf(), (stamp, sha256.clone()));
    Ok(sha256)
}

/// The newest frame waiting for the blit thread; older ones are dropped.
struct Frames(Arc<(Mutex<Option<Option<Value>>>, std::sync::Condvar)>);

impl Drop for Frames {
    fn drop(&mut self) {
        let (slot, ready) = &*self.0;
        *slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(None);
        ready.notify_one();
    }
}

impl Frames {
    fn offer(&self, image: Value) {
        let (slot, ready) = &*self.0;
        *slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(Some(image));
        ready.notify_one();
    }
}

fn blit_worker(
    key: String,
    sink: BlitSink,
    alive: Arc<std::sync::atomic::AtomicBool>,
    stop: impl Fn() + Send + 'static,
) -> Frames {
    let shared = Arc::new((Mutex::new(None::<Option<Value>>), std::sync::Condvar::new()));
    let frames = shared.clone();
    std::thread::spawn(move || {
        let (slot, ready) = &*shared;
        let active: Arc<dyn Fn() -> bool + Send + Sync> =
            Arc::new(move || alive.load(std::sync::atomic::Ordering::Acquire));
        let mut attempts = 0;
        loop {
            let image = {
                let mut slot = slot.lock().unwrap_or_else(PoisonError::into_inner);
                while slot.is_none() {
                    slot = ready.wait(slot).unwrap_or_else(PoisonError::into_inner);
                }
                slot.take().unwrap_or_default()
            };
            let Some(image) = image else {
                return;
            };
            let arguments = if let Some(pixels) = image.get("pixels") {
                json!({"key": key, "pixels": pixels})
            } else {
                json!({"key": key, "image": image})
            };
            let wait = match sink(arguments, active.clone()) {
                Ok(reply) if reply["status"] == "backpressure" => Some(Duration::from_millis(
                    reply["retry_after_ms"].as_u64().unwrap_or(16).min(1_000),
                )),
                Ok(_) => None,
                Err(_) if !active() => return,
                Err(error) if error.kind == codex_omd::client_surface::BlitErrorKind::Revoked => {
                    stop();
                    return;
                }
                Err(error)
                    if image.get("pixels").is_some()
                        && error.kind == codex_omd::client_surface::BlitErrorKind::Fatal =>
                {
                    stop();
                    return;
                }
                Err(_) => (image.get("pixels").is_some() || attempts < BLIT_ATTEMPTS)
                    .then_some(BLIT_RETRY),
            };
            attempts = if wait.is_some() {
                attempts.saturating_add(1)
            } else {
                0
            };
            if let Some(wait) = wait {
                slot.lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .get_or_insert(Some(image));
                std::thread::sleep(wait);
            }
        }
    });
    Frames(frames)
}

fn read_framed(reader: &mut impl BufRead, framing: Framing) -> io::Result<Value> {
    if framing == Framing::ContentLength {
        return read_message(reader);
    }
    let mut line = Vec::new();
    loop {
        let read = reader
            .by_ref()
            .take(4 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut line)?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "process_stopped",
            ));
        }
        if line.len() > 4 * 1024 * 1024 {
            return Err(io::Error::other("process message length invalid"));
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            line.clear();
            continue;
        }
        return serde_json::from_slice(&line).map_err(io::Error::other);
    }
}

/// Small enough that a chunk of control bytes, six bytes each once escaped, fits one exchange.
const RAW_READ_BYTES: usize = 8_000;
const EXCHANGE_BYTES: usize = 48 * 1024;

type Reader = Box<dyn FnMut() -> io::Result<Value> + Send>;

/// One stream read as written into a reused buffer whose first `held` bytes are a partial UTF-8 character.
struct RawReader<R> {
    reader: R,
    buffer: Vec<u8>,
    held: usize,
    chunks: VecDeque<Value>,
    stream: &'static str,
}

impl<R: Read> RawReader<R> {
    fn new(reader: R, stream: &'static str) -> Self {
        Self {
            reader,
            buffer: vec![0; RAW_READ_BYTES],
            held: 0,
            chunks: VecDeque::new(),
            stream,
        }
    }

    fn read_chunk(&mut self) -> io::Result<Value> {
        loop {
            if let Some(chunk) = self.chunks.pop_front() {
                return Ok(chunk);
            }
            let read = match self.reader.read(&mut self.buffer[self.held..]) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                result => result?,
            };
            let filled = self.held + read;
            if filled == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "process_stopped",
                ));
            }
            self.split(filled, read == 0);
        }
    }

    /// Queues valid UTF-8 as `data` and each run of invalid bytes as `data_base64`; keeps an incomplete tail unless `eof`.
    fn split(&mut self, filled: usize, eof: bool) {
        let mut at = 0;
        let mut invalid = None;
        while at < filled {
            let error = std::str::from_utf8(&self.buffer[at..filled]).err();
            let valid = error
                .as_ref()
                .map_or(filled - at, std::str::Utf8Error::valid_up_to);
            if valid > 0 {
                self.queue(invalid.take(), at);
                self.queue(Some(at), at + valid);
                at += valid;
            }
            match error.and_then(|error| error.error_len()) {
                Some(length) => {
                    invalid.get_or_insert(at);
                    at += length;
                }
                None if at < filled && eof => {
                    invalid.get_or_insert(at);
                    at = filled;
                }
                None => break,
            }
        }
        self.queue(invalid, at);
        self.buffer.copy_within(at..filled, 0);
        self.held = filled - at;
    }

    fn queue(&mut self, start: Option<usize>, end: usize) {
        if let Some(start) = start.filter(|start| *start < end) {
            let (field, data) = crate::mods::access::content("data", &self.buffer[start..end]);
            self.chunks
                .push_back(json!({"stream": self.stream, field: data}));
        }
    }
}

fn send_framed(stdin: &mut impl Write, message: &Value, framing: Framing) -> Result<(), String> {
    if framing == Framing::ContentLength {
        return send_message(stdin, message);
    }
    if framing == Framing::Raw {
        let text = message
            .as_str()
            .filter(|text| text.len() <= 4 * 1024 * 1024)
            .ok_or("process_message_invalid_or_too_large")?;
        stdin
            .write_all(text.as_bytes())
            .map_err(|error| error.to_string())?;
        return stdin.flush().map_err(|error| error.to_string());
    }
    let mut bytes = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 || !message.is_object() {
        return Err("process_message_invalid_or_too_large".into());
    }
    bytes.push(b'\n');
    stdin.write_all(&bytes).map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

fn read_message(reader: &mut impl BufRead) -> io::Result<Value> {
    let mut length = None;
    let mut headers = 0_usize;
    loop {
        let mut line = String::new();
        if reader
            .by_ref()
            .take((8192 - headers + 1) as u64)
            .read_line(&mut line)?
            == 0
        {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "process_stopped",
            ));
        }
        headers += line.len();
        if headers > 8192 {
            return Err(io::Error::other("process headers exceed limit"));
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some(value) = line
            .split_once(':')
            .filter(|(name, _)| name.eq_ignore_ascii_case("Content-Length"))
            .map(|(_, value)| value.trim())
        {
            length = Some(value.parse::<usize>().map_err(io::Error::other)?);
        }
    }
    let length = length
        .filter(|value| *value <= 4 * 1024 * 1024)
        .ok_or_else(|| io::Error::other("process message length invalid"))?;
    let mut bytes = vec![0_u8; length];
    reader.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

fn send_message(stdin: &mut impl Write, message: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 || !message.is_object() {
        return Err("process_message_invalid_or_too_large".into());
    }
    write!(stdin, "Content-Length: {}\r\n\r\n", bytes.len()).map_err(|error| error.to_string())?;
    stdin.write_all(&bytes).map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub(crate) fn read_policy(
    policy: &FileSystemSandboxPolicy,
    scratch: &Path,
) -> Result<FileSystemSandboxPolicy, String> {
    if policy.kind == FileSystemSandboxKind::ExternalSandbox {
        return Err("managed_process_requires_native_sandbox".into());
    }
    let mut result = if policy.kind == FileSystemSandboxKind::Unrestricted {
        FileSystemSandboxPolicy::read_only()
    } else {
        FileSystemSandboxPolicy::restricted(
            policy
                .entries
                .iter()
                .cloned()
                .map(|mut entry| {
                    if entry.access == FileSystemAccessMode::Write {
                        entry.access = FileSystemAccessMode::Read;
                    }
                    entry
                })
                .collect(),
        )
    };
    let path =
        AbsolutePathBuf::from_absolute_path_checked(scratch).map_err(|error| error.to_string())?;
    result.entries.push(FileSystemSandboxEntry::new(
        FileSystemPath::Path { path: path.into() },
        FileSystemAccessMode::Write,
    ));
    Ok(result)
}

fn program(name: &str, repository: &Path) -> Option<PathBuf> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return None;
    }
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|directory| {
        let candidate = directory.join(name).canonicalize().ok()?;
        (candidate.is_file() && !candidate.starts_with(repository)).then_some(candidate)
    })
}

impl ManagedProcesses {
    pub fn set_notifier(&self, notifier: ProcessNotifier) {
        let _ = self.notifier.set(notifier);
    }

    pub fn running(&self, owner: &str, session: &str) -> Option<bool> {
        let process = {
            let records = self.records.lock().ok()?;
            let (_, process) = records
                .iter()
                .find(|((id, _, name), _)| id == owner && name == session)?;
            process.clone()
        };
        let process = process.lock().ok()?;
        Some(!process.exited().ok()?)
    }

    pub fn cleanup_stale(&self, generation: u64) {
        if let Ok(mut records) = self.records.lock() {
            records.retain(|(_, current, _), _| *current == generation);
        }
    }

    pub fn cleanup_owned(&self, id: &str, generation: u64) {
        if let Ok(mut records) = self.records.lock() {
            records.retain(|(owner, current, _), _| owner != id || *current != generation);
        }
    }

    pub fn cleanup(&self) {
        if let Ok(mut records) = self.records.lock() {
            records.clear();
        }
    }

    fn session(&self, key: &Key) -> Result<Session, String> {
        self.records
            .lock()
            .map_err(|_| "process_records_poisoned")?
            .get(key)
            .cloned()
            .ok_or_else(|| "process_session_unavailable".into())
    }

    fn remove(&self, key: &Key, process: &Session) {
        if let Ok(mut records) = self.records.lock()
            && records
                .get(key)
                .is_some_and(|current| Arc::ptr_eq(current, process))
        {
            records.remove(key);
        }
    }

    pub fn call(
        &self,
        owner: ProcessOwner,
        operation: &str,
        arguments: Value,
        active: impl Fn() -> bool,
    ) -> Result<Value, String> {
        let ProcessOwner {
            thread,
            id,
            generation,
            repository,
            policy,
            protected,
            os_access,
            blit,
            environment,
        } = owner;
        if !active()
            || !repository.is_absolute()
            || repository
                .canonicalize()
                .map_err(|error| error.to_string())?
                != repository
        {
            return Err("managed_process_inactive_or_repository_invalid".into());
        }
        match operation {
            "process.which" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    names: Vec<String>,
                    sandbox: Option<String>,
                }
                let input: Input =
                    serde_json::from_value(arguments).map_err(|error| error.to_string())?;
                if input.names.is_empty() || input.names.len() > 8 {
                    return Err("process_candidate_limit".into());
                }
                let unrestricted = unrestricted_access(input.sandbox.as_deref(), os_access)?;
                let found = input
                    .names
                    .iter()
                    .filter_map(|name| {
                        let path = match unrestricted {
                            Some(access) => {
                                codex_omd::host::unrestricted_program(access, name, repository)
                                    .ok()?
                            }
                            None => program(name, repository)?,
                        };
                        let metadata = fs::metadata(&path).ok()?;
                        if metadata.len() > 128 * 1024 * 1024 {
                            return None;
                        }
                        let sha256 = program_sha256(&path).ok()?;
                        Some(json!({"name":name,"path":path,"sha256":sha256}))
                    })
                    .collect::<Vec<_>>();
                Ok(json!({"found":found}))
            }
            "process.start" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    session: String,
                    name: String,
                    path: PathBuf,
                    sha256: String,
                    #[serde(default)]
                    arguments: Vec<String>,
                    #[serde(default)]
                    environment: BTreeMap<String, Option<String>>,
                    #[serde(default)]
                    framing: Option<String>,
                    #[serde(default)]
                    network: Option<String>,
                    #[serde(default)]
                    notify: Vec<String>,
                    #[serde(default)]
                    sandbox: Option<String>,
                    #[serde(default)]
                    raster: Option<String>,
                    #[serde(default)]
                    keys: Option<String>,
                    #[serde(default)]
                    pixels: bool,
                    #[serde(default)]
                    stdin: Option<String>,
                }
                let mut input: Input =
                    serde_json::from_value(arguments).map_err(|error| error.to_string())?;
                let component = |id: &String| {
                    !id.is_empty()
                        && id.len() <= 128
                        && id.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric()
                                || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
                        })
                };
                let raster = match (&input.raster, &input.keys) {
                    (None, None) if !input.pixels => None,
                    (Some(raster), keys)
                        if input.framing.as_deref() == Some("ndjson")
                            && input.stdin.is_none()
                            && component(raster)
                            && keys
                                .as_ref()
                                .is_none_or(|keys| component(keys) && keys != raster) =>
                    {
                        Some((
                            raster.clone(),
                            keys.clone(),
                            blit.cloned().ok_or("capability_denied: terminal")?,
                        ))
                    }
                    _ => return Err("process_raster_invalid".into()),
                };
                if input.sandbox.as_deref() == Some("none") && input.network.is_some() {
                    return Err("process_unrestricted_network_comes_from_os_access".into());
                }
                let unrestricted = unrestricted_access(input.sandbox.as_deref(), os_access)?;
                if input.notify.len() > 2
                    || input
                        .notify
                        .iter()
                        .any(|kind| !matches!(kind.as_str(), "output" | "exit"))
                {
                    return Err("process_notify_invalid".into());
                }
                let notify_output = input.notify.iter().any(|kind| kind == "output");
                let notify_exit = input.notify.iter().any(|kind| kind == "exit");
                if input.session.is_empty()
                    || input.session.len() > 64
                    || !input
                        .session
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                    || input.arguments.len() > 16
                    || input.arguments.iter().map(String::len).sum::<usize>() > 4096
                    || input.environment.len() > 8
                    || input.environment.iter().any(|(key, value)| {
                        key.is_empty()
                            || key.len() > 64
                            || !key.bytes().all(|byte| {
                                byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                            })
                            || codex_omd::host::RESERVED_EXEC_ENVIRONMENT.contains(&key.as_str())
                            || codex_omd::host::RESERVED_EXEC_PREFIXES
                                .iter()
                                .any(|prefix| key.starts_with(prefix))
                            || key == "XDG_CACHE_HOME"
                            || value.as_ref().is_some_and(|value| {
                                value.len() > 1024
                                    || value
                                        .bytes()
                                        .any(|byte| byte == 0 || byte == b'\n' || byte == b'\r')
                            })
                    })
                    || !matches!(
                        input.framing.as_deref(),
                        None | Some("content-length") | Some("ndjson") | Some("raw")
                    )
                    || !matches!(
                        input.network.as_deref(),
                        None | Some("none") | Some("loopback")
                    )
                    || !matches!(input.stdin.as_deref(), None | Some("null"))
                    || match unrestricted {
                        Some(access) => {
                            codex_omd::host::unrestricted_program(access, &input.name, repository)?
                                != input.path
                        }
                        None => program(&input.name, repository).as_ref() != Some(&input.path),
                    }
                    || input
                        .path
                        .canonicalize()
                        .map_err(|error| error.to_string())?
                        != input.path
                {
                    return Err("process_program_or_arguments_invalid".into());
                }
                if let Some(environment) = environment {
                    codex_omd::host::validate_environment(environment)?;
                    for (name, value) in environment {
                        input
                            .environment
                            .entry(name.clone())
                            .or_insert_with(|| Some(value.clone()));
                    }
                }
                let metadata = fs::metadata(&input.path).map_err(|error| error.to_string())?;
                if !metadata.is_file()
                    || metadata.len() > 128 * 1024 * 1024
                    || program_sha256(&input.path).map_err(|error| error.to_string())?
                        != input.sha256
                {
                    return Err("process_executable_changed".into());
                }
                let key = (id.to_owned(), generation, input.session.clone());
                let admitted = |records: &BTreeMap<Key, Session>| {
                    !records.contains_key(&key)
                        && records.len() < 8
                        && records.keys().filter(|(owner, _, _)| owner == id).count() < 5
                };
                if !admitted(
                    &*self
                        .records
                        .lock()
                        .map_err(|_| "process_records_poisoned")?,
                ) {
                    return Err("process_session_limit_or_duplicate".into());
                }
                static STARTED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                let scratch = std::env::temp_dir().join(format!(
                    "omd-process-{}-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_err(|error| error.to_string())?
                        .as_nanos(),
                    STARTED.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                ));
                fs::create_dir(&scratch).map_err(|error| error.to_string())?;
                fs::set_permissions(&scratch, fs::Permissions::from_mode(0o700)).map_err(
                    |error| {
                        let _ = fs::remove_dir(&scratch);
                        error.to_string()
                    },
                )?;
                let launched = (|| {
                    let framing = match input.framing.as_deref() {
                        Some("ndjson") => Framing::Ndjson,
                        Some("raw") => Framing::Raw,
                        _ => Framing::ContentLength,
                    };
                    let arguments = input.arguments.into_iter().map(|argument| {
                        argument.replace("{process.home}", &scratch.to_string_lossy())
                    });
                    let mut command = match unrestricted {
                        Some(access) => {
                            let mut command =
                                codex_omd::host::unrestricted_command(access, &input.path, &[])?;
                            command.args(arguments);
                            command
                        }
                        #[cfg(not(target_os = "macos"))]
                        None => {
                            let _ = (policy, protected);
                            return Err("managed_process_requires_native_sandbox".into());
                        }
                        #[cfg(target_os = "macos")]
                        None => {
                            let scope = read_policy(policy, &scratch)?;
                            let loopback_network = input.network.as_deref() == Some("loopback");
                            let mut command = vec![input.path.to_string_lossy().into_owned()];
                            command.extend(arguments);
                            let loopback = loopback_network.then(|| ManagedNetworkSandboxContext {
                                allow_local_binding: true,
                                ..Default::default()
                            });
                            let mut argv =
                                create_seatbelt_command_args(CreateSeatbeltCommandArgsParams {
                                    command,
                                    file_system_sandbox_policy: &scope,
                                    network_sandbox_policy: NetworkSandboxPolicy::Restricted,
                                    sandbox_policy_cwd: repository,
                                    enforce_managed_network: loopback_network,
                                    managed_network: loopback.as_ref(),
                                    environment_id: None,
                                    network: None,
                                    extra_allow_unix_sockets: &[],
                                })?;
                            if argv.first().map(String::as_str) != Some("-p") || argv.len() < 2 {
                                return Err("managed_process_requires_native_sandbox".into());
                            }
                            codex_omd::host::deny_protected(&mut argv[1], protected)?;
                            let mut command = Command::new(MACOS_PATH_TO_SEATBELT_EXECUTABLE);
                            command
                                .args(argv)
                                .env_clear()
                                .env("PATH", std::env::var_os("PATH").unwrap_or_default())
                                .env("HOME", &scratch);
                            command
                        }
                    };
                    command
                        .env("TMPDIR", &scratch)
                        .env("XDG_CACHE_HOME", &scratch)
                        .env("PYTHONDONTWRITEBYTECODE", "1");
                    for (name, value) in &input.environment {
                        match value {
                            Some(value) => {
                                command.env(name, value);
                            }
                            None => {
                                command.env_remove(name);
                            }
                        }
                    }
                    let mut child = command
                        .current_dir(repository)
                        .stdin(if input.stdin.is_some() {
                            Stdio::null()
                        } else {
                            Stdio::piped()
                        })
                        .stdout(Stdio::piped())
                        .stderr(if framing == Framing::Raw {
                            Stdio::piped()
                        } else {
                            Stdio::null()
                        })
                        .process_group(0)
                        .spawn()
                        .map_err(|error| error.to_string())?;
                    let stderr = child.stderr.take();
                    let stdin = child.stdin.take();
                    let Some(stdout) = child.stdout.take() else {
                        let _ = kill_process_group(child.id());
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err("process_stdio_missing".into());
                    };
                    let (writer_sender, writer_receiver) = mpsc::sync_channel::<WriteRequest>(1);
                    if let Some(mut stdin) = stdin {
                        std::thread::spawn(move || {
                            while let Ok((messages, reply)) = writer_receiver.recv() {
                                let result = messages.iter().try_for_each(|message| {
                                    send_framed(&mut stdin, message, framing)
                                });
                                let failed = result.is_err();
                                let _ = reply.send(result);
                                if failed {
                                    break;
                                }
                            }
                        });
                    }
                    let (sender, receiver) = mpsc::sync_channel(128);
                    let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
                    let group = child.id();
                    let reaped = Arc::new(Mutex::new(false));
                    let frames = raster.as_ref().map(|(key, _, sink)| {
                        let reaped = reaped.clone();
                        blit_worker(key.clone(), sink.clone(), alive.clone(), move || {
                            kill_group_if_alive(group, &reaped)
                        })
                    });
                    let raster_input = raster
                        .as_ref()
                        .map(|_| input_sink(writer_sender.clone(), group, reaped.clone()));
                    let mut binding =
                        raster
                            .as_ref()
                            .zip(raster_input.as_ref())
                            .map(|((key, keys, _), sink)| {
                                let mut components =
                                    vec![(key.clone(), codex_omd::process_raster::Role::Raster)];
                                components.extend(keys.iter().map(|keys| {
                                    (keys.clone(), codex_omd::process_raster::Role::Keys)
                                }));
                                codex_omd::process_raster::Binding::prepare(
                                    thread,
                                    id,
                                    components,
                                    sink.clone(),
                                )
                            });
                    if let Some(binding) = &mut binding {
                        if input.pixels {
                            let initialized = binding
                                .pixels(&scratch.join("pixels.raw"), Some(generation))
                                .and_then(|message| {
                                    raster_input.as_ref().unwrap()(message)
                                        .then_some(())
                                        .ok_or("process_pixels_init_failed".to_owned())
                                });
                            if let Err(error) = initialized {
                                let _ = kill_process_group(child.id());
                                let _ = child.kill();
                                let _ = child.wait();
                                return Err(error);
                            }
                        }
                        binding.publish();
                    }
                    let notifier = self.notifier.get().cloned();
                    let (owner, session) = (id.to_owned(), input.session.clone());
                    let mut readers: Vec<Reader> = if framing == Framing::Raw {
                        let mut stdout = RawReader::new(stdout, "stdout");
                        let mut readers: Vec<Reader> = vec![Box::new(move || stdout.read_chunk())];
                        if let Some(stderr) = stderr {
                            let mut stderr = RawReader::new(stderr, "stderr");
                            readers.push(Box::new(move || stderr.read_chunk()));
                        }
                        readers
                    } else {
                        let mut reader = BufReader::new(stdout);
                        vec![Box::new(move || read_framed(&mut reader, framing))]
                    };
                    let open = Arc::new(std::sync::atomic::AtomicUsize::new(readers.len()));
                    let announced = Arc::new(std::sync::atomic::AtomicBool::new(false));
                    if let Some(notifier) = notifier.clone() {
                        let (announced, owner, session, reaped) = (
                            announced.clone(),
                            owner.clone(),
                            session.clone(),
                            Arc::clone(&reaped),
                        );
                        std::thread::spawn(move || {
                            if wait_for_exit(group).is_ok()
                                && !*reaped.lock().unwrap_or_else(PoisonError::into_inner)
                                && !announced.swap(true, std::sync::atomic::Ordering::AcqRel)
                            {
                                notifier(ProcessNotice {
                                    owner,
                                    session,
                                    output_bytes: None,
                                    exited: true,
                                    deliver: notify_exit,
                                });
                            }
                        });
                    }
                    let mut frames = frames;
                    for mut next in readers.drain(..) {
                        let (sender, frames, alive, open, announced) = (
                            sender.clone(),
                            frames.take(),
                            alive.clone(),
                            open.clone(),
                            announced.clone(),
                        );
                        let (notifier, owner, session) =
                            (notifier.clone(), owner.clone(), session.clone());
                        let reader_reaped = Arc::clone(&reaped);
                        std::thread::spawn(move || {
                            loop {
                                let result = next();
                                if let (Some(frames), Ok(message)) = (&frames, &result)
                                    && let Some(image) = message.get("blit")
                                {
                                    frames.offer(image.clone());
                                    continue;
                                }
                                let terminal = result.is_err();
                                if let Err(error) = &result
                                    && error.kind() != io::ErrorKind::UnexpectedEof
                                {
                                    kill_group_if_alive(group, &reader_reaped);
                                }
                                if terminal
                                    && open.fetch_sub(1, std::sync::atomic::Ordering::AcqRel) > 1
                                {
                                    break;
                                }
                                let bytes = match (&result, notify_output) {
                                    (Ok(message), true) => {
                                        serde_json::to_vec(message).ok().map(|bytes| bytes.len())
                                    }
                                    _ => None,
                                };
                                if sender.send(result).is_err() || terminal {
                                    alive.store(false, std::sync::atomic::Ordering::Release);
                                    if announced.swap(true, std::sync::atomic::Ordering::AcqRel) {
                                        break;
                                    }
                                    if let Some(notifier) = &notifier {
                                        notifier(ProcessNotice {
                                            owner: owner.clone(),
                                            session: session.clone(),
                                            output_bytes: None,
                                            exited: true,
                                            deliver: notify_exit,
                                        });
                                    }
                                    break;
                                }
                                if let (Some(notifier), Some(bytes)) = (&notifier, bytes) {
                                    notifier(ProcessNotice {
                                        owner: owner.clone(),
                                        session: session.clone(),
                                        output_bytes: Some(bytes),
                                        exited: false,
                                        deliver: true,
                                    });
                                }
                            }
                        });
                    }
                    Ok::<_, String>(ManagedProcess {
                        child,
                        unrestricted: unrestricted.is_some(),
                        sender: writer_sender,
                        receiver,
                        pending: None,
                        exited_at: None,
                        stdin: input.stdin.is_none(),
                        scratch: scratch.clone(),
                        last_used: Instant::now(),
                        reaped,
                        _raster: binding,
                    })
                })();
                match launched {
                    Ok(process) => {
                        let mut records = self
                            .records
                            .lock()
                            .map_err(|_| "process_records_poisoned")?;
                        if !admitted(&records) {
                            return Err("process_session_limit_or_duplicate".into());
                        }
                        records.insert(key.clone(), Arc::new(Mutex::new(process)));
                        Ok(json!({"session":input.session,"running":true}))
                    }
                    Err(error) => {
                        let _ = fs::remove_dir_all(scratch);
                        Err(error)
                    }
                }
            }
            "process.exchange" | "process.status" | "process.stop" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    session: String,
                    #[serde(default)]
                    send: Vec<Value>,
                    #[serde(default)]
                    wait_ms: u64,
                }
                let input: Input =
                    serde_json::from_value(arguments).map_err(|error| error.to_string())?;
                let key = (id.to_owned(), generation, input.session.clone());
                if operation == "process.stop" {
                    let stopped = self
                        .records
                        .lock()
                        .map_err(|_| "process_records_poisoned")?
                        .remove(&key);
                    return Ok(json!({"stopped":stopped.is_some()}));
                }
                let session = self.session(&key)?;
                let mut process = session.lock().map_err(|_| "process_session_poisoned")?;
                if process.unrestricted && os_access.is_none() {
                    drop(process);
                    self.remove(&key, &session);
                    return Err("grant_expired: os".into());
                }
                let exited = process.exited().map_err(|error| error.to_string())?;
                if exited && process.exited_at.is_none() {
                    process.exited_at = Some(Instant::now());
                }
                let grace = process
                    .exited_at
                    .map(|exited_at| exited_at + Duration::from_secs(1));
                if operation == "process.status" {
                    let queued = !exited
                        || match process
                            .pending
                            .take()
                            .map_or_else(|| process.receiver.try_recv(), Ok)
                        {
                            Ok(next) => {
                                let output = next.is_ok();
                                process.pending = Some(next);
                                output
                            }
                            Err(mpsc::TryRecvError::Empty) => {
                                grace.is_some_and(|grace| Instant::now() < grace)
                            }
                            Err(mpsc::TryRecvError::Disconnected) => false,
                        };
                    if !queued {
                        self.remove(&key, &session);
                        return Err("process_stopped".into());
                    }
                    return Ok(
                        json!({"session":input.session,"running":true,"idle_ms":process.last_used.elapsed().as_millis()}),
                    );
                }
                if input.send.len() > 32 || input.wait_ms > 10_000 {
                    return Err("process_exchange_limit".into());
                }
                if !input.send.is_empty() && !process.stdin {
                    return Err("process_stdin_null".into());
                }
                if !input.send.is_empty()
                    && !exited
                    && let Err(error) = write_until(
                        &process.sender,
                        input.send,
                        Instant::now() + EXCHANGE_WRITE_TIMEOUT,
                        &active,
                    )
                {
                    kill_group_if_alive(process.child.id(), &process.reaped);
                    self.remove(&key, &session);
                    return Err(error);
                }
                process.last_used = Instant::now();
                let deadline = Instant::now() + Duration::from_millis(input.wait_ms);
                let deadline = grace.map_or(deadline, |grace| deadline.max(grace));
                let mut messages = Vec::new();
                let mut bytes = 1_usize;
                while messages.len() < 64 {
                    if !active() {
                        self.remove(&key, &session);
                        return Err("process_cancelled".into());
                    }
                    let next = if let Some(next) = process.pending.take() {
                        Ok(next)
                    } else if messages.is_empty() && Instant::now() < deadline {
                        process.receiver.recv_timeout(
                            deadline
                                .saturating_duration_since(Instant::now())
                                .min(Duration::from_millis(50)),
                        )
                    } else {
                        process.receiver.try_recv().map_err(|error| match error {
                            mpsc::TryRecvError::Empty => mpsc::RecvTimeoutError::Timeout,
                            mpsc::TryRecvError::Disconnected => {
                                mpsc::RecvTimeoutError::Disconnected
                            }
                        })
                    };
                    match next {
                        Ok(Ok(message)) => {
                            let size = serde_json::to_vec(&message)
                                .map_err(|error| error.to_string())?
                                .len();
                            if !messages.is_empty() && bytes + size + 1 > EXCHANGE_BYTES {
                                process.pending = Some(Ok(message));
                                break;
                            }
                            bytes += size + 1;
                            messages.push(message);
                        }
                        Ok(Err(error)) if !messages.is_empty() => {
                            process.pending = Some(Err(error));
                            break;
                        }
                        Ok(Err(error)) => {
                            self.remove(&key, &session);
                            return Err(error.to_string());
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            self.remove(&key, &session);
                            return Err("process_stopped".into());
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) if !messages.is_empty() => break,
                        Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() >= deadline => {
                            if exited {
                                self.remove(&key, &session);
                                return Err("process_stopped".into());
                            }
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    }
                }
                Ok(json!({"session":input.session,"messages":messages,"running":true}))
            }
            _ => Err("unsupported_process_operation".into()),
        }
    }
}

fn unrestricted_access<'a>(
    sandbox: Option<&str>,
    os_access: Option<&'a codex_omd::ModOsAccess>,
) -> Result<Option<&'a codex_omd::ModOsAccess>, &'static str> {
    match sandbox {
        None => Ok(None),
        Some("none") => os_access.map(Some).ok_or("capability_denied: os"),
        Some(_) => Err("process_sandbox_invalid"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn raster_input_queue_bounds_bytes_messages_and_coalesces_in_order() {
        let mut queue = InputQueue::default();
        for x in 0..1000 {
            assert!(queue.offer(json!({"pointer": {"action": "move", "x": x}})));
        }
        assert_eq!(queue.messages.len(), 1);
        assert!(queue.offer(json!({"input": [{"key": "a"}]})));
        assert!(queue.offer(json!({"pointer": {"action": "move", "x": 1000}})));
        assert_eq!(queue.take().unwrap()["pointer"]["x"], 999);
        assert!(queue.take().unwrap().get("input").is_some());
        assert_eq!(queue.take().unwrap()["pointer"]["x"], 1000);
        for rows in 0..1000 {
            assert!(queue.offer(json!({"box": {"rows": rows}})));
        }
        assert_eq!(queue.messages.len(), 1);
        queue.take();
        for _ in 0..INPUT_MESSAGES {
            assert!(queue.offer(json!({"input": []})));
        }
        assert!(!queue.offer(json!({"input": []})));
        assert_eq!(queue.bytes, 0);
        assert!(queue.take().is_none());
        assert!(!queue.offer(json!({"box": {}})));
        let mut queue = InputQueue::default();
        assert!(queue.offer(json!("x".repeat(INPUT_BYTES / 2))));
        assert!(!queue.offer(json!("x".repeat(INPUT_BYTES / 2))));
        assert!(queue.closed);
        assert!(queue.messages.is_empty());
        let (writer, _reader) = mpsc::sync_channel(1);
        let (reply, _replies) = mpsc::sync_channel(1);
        writer.send((vec![], reply)).unwrap();
        let start = Instant::now();
        assert_eq!(
            write_until(&writer, vec![], start + Duration::from_millis(50), &|| true).unwrap_err(),
            "process_write_timeout"
        );
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn raster_input_stalled_writer_exits_and_rejects_later_input() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exec sleep 30"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        let group = child.id();
        let reaped = Arc::new(Mutex::new(false));
        let mut stdin = child.stdin.take().unwrap();
        let (writer, requests) = mpsc::sync_channel::<WriteRequest>(1);
        let worker = std::thread::spawn(move || {
            while let Ok((messages, reply)) = requests.recv() {
                let result = messages
                    .iter()
                    .try_for_each(|message| send_framed(&mut stdin, message, Framing::Ndjson));
                let failed = result.is_err();
                let _ = reply.send(result);
                if failed {
                    break;
                }
            }
        });
        let sink = input_sink(writer, group, reaped.clone());
        let started = Instant::now();
        assert!(sink(json!({"input": [{"paste": "x".repeat(128 * 1024)}]})));
        loop {
            let mut guard = reaped.lock().unwrap();
            if child.try_wait().unwrap().is_some() {
                *guard = true;
                break;
            }
            drop(guard);
            if started.elapsed() > Duration::from_secs(5) {
                kill_group_if_alive(group, &reaped);
                let mut guard = reaped.lock().unwrap();
                child.wait().unwrap();
                *guard = true;
                panic!("stalled input did not kill its process");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!sink(json!({"input": [{"key": "late"}]})));
        drop(sink);
        worker.join().unwrap();
    }

    #[test]
    fn content_length_headers_are_bounded_before_allocation() {
        for prefix in ["", "Content-Length: 2\r\n"] {
            let bytes = format!("{prefix}{}", "x".repeat(16384));
            let mut reader = io::Cursor::new(bytes.as_bytes());
            assert_eq!(
                read_message(&mut reader).unwrap_err().to_string(),
                "process headers exceed limit"
            );
            assert_eq!(reader.position(), 8193);
        }
    }

    #[test]
    fn framed_process_is_owned_bounded_and_stopped() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().canonicalize().unwrap();
        let processes = ManagedProcesses::default();
        let policy = FileSystemSandboxPolicy::read_only();
        let owner = ProcessOwner {
            thread: None,
            id: "fixture",
            generation: 1,
            repository: &repository,
            policy: &policy,
            protected: &[],
            environment: None,
            os_access: None,
            blit: None,
        };
        let found = processes
            .call(owner, "process.which", json!({"names":["cat"]}), || true)
            .unwrap();
        let cat = found["found"].as_array().unwrap().first().unwrap();
        let started = processes
            .call(
                owner,
                "process.start",
                json!({"session":"framed","name":"cat","path":cat["path"],"sha256":cat["sha256"]}),
                || true,
            )
            .unwrap();
        assert_eq!(started["running"], true);
        let scratch = processes
            .session(&("fixture".into(), 1, "framed".into()))
            .unwrap()
            .lock()
            .unwrap()
            .scratch
            .clone();
        assert_eq!(
            fs::metadata(&scratch).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let answer = processes
            .call(owner, "process.exchange", json!({"session":"framed","send":[{"jsonrpc":"2.0","id":7,"method":"hello"}],"wait_ms":1000}), || true)
            .unwrap();
        assert_eq!(answer["messages"][0]["method"], "hello");
        assert_eq!(
            processes
                .call(
                    ProcessOwner {
                        id: "other",
                        ..owner
                    },
                    "process.status",
                    json!({"session":"framed"}),
                    || true
                )
                .unwrap_err(),
            "process_session_unavailable"
        );
        assert_eq!(
            processes
                .call(owner, "process.stop", json!({"session":"framed"}), || true)
                .unwrap()["stopped"],
            true
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn raw_buffer_sandbox_allows_private_files_but_denies_named_shared_memory() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().canonicalize().unwrap();
        let processes = ManagedProcesses::default();
        let policy = FileSystemSandboxPolicy::read_only();
        let owner = ProcessOwner {
            thread: None,
            id: "raw-sandbox",
            generation: 1,
            repository: &repository,
            policy: &policy,
            protected: &[],
            environment: None,
            os_access: None,
            blit: None,
        };
        let found = processes
            .call(owner, "process.which", json!({"names":["sh"]}), || true)
            .unwrap();
        let sh = &found["found"][0];
        let python = Command::new("python3")
            .args(["-c", "import sys; print(sys.executable)"])
            .output()
            .unwrap()
            .stdout;
        let python = String::from_utf8(python).unwrap();
        let probe = r#"import ctypes,errno,json,os
lib=ctypes.CDLL(None,use_errno=True)
name=('/omdprobe_'+str(os.getpid())).encode()
fd=lib.shm_open(name,os.O_CREAT|os.O_EXCL|os.O_RDWR,0o600)
error=ctypes.get_errno()
if fd >= 0:
 os.close(fd)
 lib.shm_unlink(name)
with open(os.path.join(os.environ['HOME'],'pixels.raw'),'wb') as f: f.write(bytes([1,2,3]))
print(json.dumps({'shm_fd':fd,'errno':error,'denied':error in (errno.EPERM,errno.EACCES),'file':True}),flush=True)
"#;
        processes
            .call(
                owner,
                "process.start",
                json!({"session":"probe","name":"sh","path":sh["path"],"sha256":sh["sha256"],
            "arguments":["-c","exec \"$0\" -c \"$1\"",python.trim(),probe],"framing":"ndjson"}),
                || true,
            )
            .unwrap();
        let answer = processes
            .call(
                owner,
                "process.exchange",
                json!({"session":"probe","wait_ms":1000}),
                || true,
            )
            .unwrap();
        let result = &answer["messages"][0];
        assert_eq!(result["shm_fd"], -1, "{answer}");
        assert_eq!(result["denied"], true, "{answer}");
        assert_eq!(result["file"], true, "{answer}");
        eprintln!("raw sandbox probe: {result}");
    }

    struct Fixture {
        _directory: tempfile::TempDir,
        repository: PathBuf,
        policy: FileSystemSandboxPolicy,
        processes: ManagedProcesses,
        sh: Value,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let repository = directory.path().canonicalize().unwrap();
            let fixture = Self {
                _directory: directory,
                repository,
                policy: FileSystemSandboxPolicy::read_only(),
                processes: ManagedProcesses::default(),
                sh: Value::Null,
            };
            let found = fixture
                .call("process.which", json!({"names":["sh"]}))
                .unwrap();
            Self {
                sh: found["found"][0].clone(),
                ..fixture
            }
        }

        fn owner(&self) -> ProcessOwner<'_> {
            ProcessOwner {
                thread: None,
                id: "fixture",
                generation: 1,
                repository: &self.repository,
                policy: &self.policy,
                protected: &[],
                environment: None,
                os_access: None,
                blit: None,
            }
        }

        fn call(&self, operation: &str, arguments: Value) -> Result<Value, String> {
            self.processes
                .call(self.owner(), operation, arguments, || true)
        }

        fn start(&self, session: &str, script: &str, extra: Value) -> Result<Value, String> {
            let mut arguments = json!({"session":session,"name":"sh","path":self.sh["path"],
                "sha256":self.sh["sha256"],"framing":"raw","arguments":["-c",script]});
            arguments
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            self.call("process.start", arguments)
        }

        fn drain(&self, session: &str, mut send: Value) -> (Vec<Value>, String) {
            let mut messages = Vec::new();
            loop {
                match self.call(
                    "process.exchange",
                    json!({"session":session,"send":std::mem::replace(&mut send, json!([])),"wait_ms":2000}),
                ) {
                    Ok(answer) => messages.extend(answer["messages"].as_array().unwrap().clone()),
                    Err(error) => return (messages, error),
                }
            }
        }
    }

    #[test]
    fn liveness_releases_registry_before_waiting_for_process() {
        let fixture = Arc::new(Fixture::new());
        fixture.start("locked", "read line", json!({})).unwrap();
        let key = ("fixture".to_owned(), 1, "locked".to_owned());
        let session = fixture.processes.session(&key).unwrap();
        let held = session.lock().unwrap();
        let count = Arc::strong_count(&session);
        let reader = fixture.clone();
        let reader = std::thread::spawn(move || reader.processes.running("fixture", "locked"));
        let deadline = Instant::now() + Duration::from_secs(5);
        while Arc::strong_count(&session) == count
            && fixture.processes.records.try_lock().is_ok()
            && Instant::now() < deadline
        {
            std::thread::yield_now();
        }
        let remover = fixture.clone();
        let removing = session.clone();
        let (sent, received) = mpsc::channel();
        let remover = std::thread::spawn(move || {
            remover.processes.remove(&key, &removing);
            sent.send(()).unwrap();
        });
        let removed = received.recv_timeout(Duration::from_secs(2));
        drop(held);
        remover.join().unwrap();
        assert_eq!(reader.join().unwrap(), Some(true));
        assert!(
            removed.is_ok(),
            "removal blocked behind liveness while the process was locked"
        );
    }

    #[test]
    fn raw_streams_deliver_both_streams_whole_characters_and_output_after_exit() {
        let fixture = Fixture::new();
        let script = "printf 'out\\n'; printf 'err\\n' >&2; read line; printf 'got:%s\\n' \"$line\"; printf '\\303'; sleep 0.2; printf '\\251'; sleep 0.2; printf '\\377'";
        assert_eq!(
            fixture
                .start("raster", script, json!({"raster":"screen"}))
                .unwrap_err(),
            "process_raster_invalid"
        );
        fixture.start("raw", script, json!({})).unwrap();
        let (chunks, stopped) = fixture.drain("raw", json!(["hi\n"]));
        assert_eq!(stopped, "process_stopped");
        let text = |stream: &str| {
            chunks
                .iter()
                .filter(|chunk| chunk["stream"] == stream)
                .filter_map(|chunk| chunk["data"].as_str())
                .collect::<String>()
        };
        assert_eq!(text("stdout"), "out\ngot:hi\né");
        assert_eq!(text("stderr"), "err\n");
        assert_eq!(
            chunks
                .iter()
                .filter_map(|chunk| chunk.get("data_base64"))
                .collect::<Vec<_>>(),
            [&json!("/w==")]
        );
    }

    #[test]
    fn invalid_bytes_are_cut_out_of_the_text_around_them() {
        struct Reads(VecDeque<&'static [u8]>);
        impl Read for Reads {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                let read = self.0.pop_front().unwrap_or_default();
                buffer[..read.len()].copy_from_slice(read);
                Ok(read.len())
            }
        }
        let mut reader = RawReader::new(
            Reads(VecDeque::from([
                b"ab\xff\xfecd\xc3".as_slice(),
                b"\xa9e\xe2\x82".as_slice(),
            ])),
            "stdout",
        );
        let mut chunks = Vec::new();
        while let Ok(chunk) = reader.read_chunk() {
            chunks.push(chunk);
        }
        assert_eq!(
            chunks,
            [
                json!({"stream":"stdout","data":"ab"}),
                json!({"stream":"stdout","data_base64":"//4="}),
                json!({"stream":"stdout","data":"cd"}),
                json!({"stream":"stdout","data":"\u{e9}e"}),
                json!({"stream":"stdout","data_base64":"4oI="}),
            ]
        );
    }

    #[test]
    fn one_exchange_stays_inside_the_receipt_budget_and_leaves_the_rest_for_the_next() {
        let fixture = Fixture::new();
        fixture
            .start(
                "flood",
                "head -c 200000 /dev/zero | tr '\\0' '\\001'",
                json!({}),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while fixture.processes.running("fixture", "flood") != Some(false) {
            assert!(Instant::now() < deadline, "the leader never exited");
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(200));
        let (mut exchanges, mut total) = (0, 0);
        while let Ok(answer) = fixture.call(
            "process.exchange",
            json!({"session":"flood","wait_ms":2000}),
        ) {
            let messages = answer["messages"].as_array().unwrap();
            assert!(
                serde_json::to_vec(messages).unwrap().len() <= EXCHANGE_BYTES,
                "{} messages",
                messages.len()
            );
            total += messages
                .iter()
                .map(|chunk| chunk["data"].as_str().unwrap().len())
                .sum::<usize>();
            exchanges += 1;
        }
        assert_eq!(total, 200_000);
        assert!(exchanges > 1);
    }

    #[test]
    fn an_exited_leader_keeps_queued_output_and_waits_for_its_readers_once() {
        let fixture = Fixture::new();
        fixture
            .start("linger", "printf 'last\\n'; sleep 600 &", json!({}))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while fixture.processes.running("fixture", "linger") != Some(false) {
            assert!(Instant::now() < deadline, "the leader never exited");
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            fixture
                .call("process.status", json!({"session":"linger"}))
                .unwrap()["running"],
            true
        );
        let answer = fixture
            .call(
                "process.exchange",
                json!({"session":"linger","send":["ignored\n"]}),
            )
            .unwrap();
        assert_eq!(
            answer["messages"],
            json!([{"stream":"stdout","data":"last\n"}])
        );
        std::thread::sleep(Duration::from_millis(1100));
        let started = Instant::now();
        assert_eq!(
            fixture
                .call("process.exchange", json!({"session":"linger","wait_ms":0}))
                .unwrap_err(),
            "process_stopped"
        );
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn the_exit_notice_fires_once_when_the_leader_exits_even_while_a_child_holds_the_pipes() {
        let fixture = Fixture::new();
        let (sender, notices) = mpsc::channel();
        fixture
            .processes
            .set_notifier(Arc::new(move |notice: ProcessNotice| {
                if notice.exited {
                    let _ = sender.send(notice.session);
                }
            }));
        fixture
            .start("server", "sleep 600 & echo hi", json!({"notify":["exit"]}))
            .unwrap();
        assert_eq!(
            notices.recv_timeout(Duration::from_secs(5)).as_deref(),
            Ok("server")
        );
        fixture
            .call("process.stop", json!({"session":"server"}))
            .unwrap();
        assert_eq!(
            notices.recv_timeout(Duration::from_millis(500)),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
    }

    #[test]
    fn a_null_stdin_process_reads_end_of_input_and_refuses_sends() {
        let fixture = Fixture::new();
        let script = "cat; printf done";
        let null = json!({"stdin":"null"});
        assert_eq!(
            fixture
                .start(
                    "raster",
                    script,
                    json!({"stdin":"null","framing":"ndjson","raster":"screen"})
                )
                .unwrap_err(),
            "process_raster_invalid"
        );
        assert_eq!(
            fixture
                .start("bad", script, json!({"stdin":"pipe"}))
                .unwrap_err(),
            "process_program_or_arguments_invalid"
        );
        fixture.start("null", script, null).unwrap();
        assert_eq!(
            fixture
                .call("process.exchange", json!({"session":"null","send":["x"]}))
                .unwrap_err(),
            "process_stdin_null"
        );
        let (messages, stopped) = fixture.drain("null", json!([]));
        let text = messages
            .iter()
            .filter_map(|chunk| chunk["data"].as_str())
            .collect::<String>();
        assert_eq!(
            (text.as_str(), stopped.as_str()),
            ("done", "process_stopped")
        );
    }

    #[test]
    fn a_child_that_breaks_the_framed_channel_is_stopped() {
        let fixture = Fixture::new();
        fixture
            .start("plain", "echo plain; sleep 30", json!({"framing":"ndjson"}))
            .unwrap();
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        while fixture
            .call("process.status", json!({"session":"plain"}))
            .is_ok_and(|status| status["running"] == true)
        {
            assert!(Instant::now() < deadline, "the child kept running");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    #[test]
    fn raster_bound_processes_draw_frames_without_callbacks_and_take_bound_input() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().canonicalize().unwrap();
        let processes = ManagedProcesses::default();
        let policy = FileSystemSandboxPolicy::read_only();
        let access = codex_omd::ModOsAccess {
            programs: vec!["sh".into()],
            network: false,
            node: None,
        };
        let drawn = Arc::new(Mutex::new(Vec::new()));
        let sink: BlitSink = {
            let drawn = drawn.clone();
            Arc::new(move |arguments, _| {
                drawn.lock().unwrap().push(arguments);
                Ok(json!({"frame": 1}))
            })
        };
        let owner = ProcessOwner {
            thread: None,
            id: "fixture",
            generation: 1,
            repository: &repository,
            policy: &policy,
            protected: &[],
            environment: None,
            os_access: Some(&access),
            blit: Some(&sink),
        };
        let sh = codex_omd::host::unrestricted_program(&access, "sh", &repository).unwrap();
        let sha256 = program_sha256(&sh).unwrap();
        let script = r#"printf '{"blit":{"media_type":"image/png","base64":"AA=="}}\n{"note":1}\n'; exec cat"#;
        let start = |owner: ProcessOwner<'_>, session: &str, framing: &str| {
            processes.call(
                owner,
                "process.start",
                json!({"session": session, "name": "sh", "path": sh, "sha256": sha256, "sandbox": "none",
                    "framing": framing, "raster": "pr-frame", "keys": "pr-keys", "arguments": ["-c", script]}),
                || true,
            )
        };
        assert_eq!(
            start(
                ProcessOwner {
                    blit: None,
                    ..owner
                },
                "denied",
                "ndjson"
            )
            .unwrap_err(),
            "capability_denied: terminal"
        );
        assert_eq!(
            start(owner, "framed", "content-length").unwrap_err(),
            "process_raster_invalid"
        );
        start(owner, "screen", "ndjson").unwrap();
        let exchange = || {
            processes
                .call(
                    owner,
                    "process.exchange",
                    json!({"session":"screen","wait_ms":2000}),
                    || true,
                )
                .unwrap()["messages"]
                .clone()
        };
        assert_eq!(exchange(), json!([{"note": 1}]));
        let deadline = Instant::now() + Duration::from_secs(5);
        while drawn.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline, "the frame was never drawn");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            drawn.lock().unwrap()[0],
            json!({"key": "pr-frame", "image": {"media_type": "image/png", "base64": "AA=="}})
        );
        assert!(!codex_omd::process_raster::send(
            None,
            "other",
            "pr-keys",
            json!({"input": []})
        ));
        assert!(codex_omd::process_raster::send(
            None,
            "fixture",
            "pr-keys",
            json!({"input": [{"key": "a"}]})
        ));
        assert_eq!(exchange(), json!([{"input": [{"key": "a"}]}]));
        processes
            .call(owner, "process.stop", json!({"session":"screen"}), || true)
            .unwrap();
        assert!(!codex_omd::process_raster::send(
            None,
            "fixture",
            "pr-frame",
            json!({"pointer": {}})
        ));
        let echo = |session: &str, raster: Option<&str>| {
            processes.call(
                owner,
                "process.start",
                json!({"session": session, "name": "sh", "path": sh, "sha256": sha256, "sandbox": "none",
                    "framing": "ndjson", "raster": raster, "pixels": true, "arguments": ["-c", "exec cat"]}),
                || true,
            )
        };
        assert_eq!(echo("unbound", None).unwrap_err(), "process_raster_invalid");
        echo("raw", Some("pr-frame")).unwrap();
        let initialized = processes
            .call(
                owner,
                "process.exchange",
                json!({"session":"raw","wait_ms":2000}),
                || true,
            )
            .unwrap();
        assert!(
            initialized["messages"][0]["pixels"]["path"].is_string(),
            "{initialized}"
        );
        processes
            .call(owner, "process.stop", json!({"session":"raw"}), || true)
            .unwrap();
    }

    #[test]
    fn unrestricted_process_needs_a_current_grant_and_takes_its_tree_down() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().canonicalize().unwrap();
        let processes = ManagedProcesses::default();
        let policy = FileSystemSandboxPolicy::read_only();
        let access = codex_omd::ModOsAccess {
            programs: vec!["sh".into()],
            network: true,
            node: None,
        };
        let owner = ProcessOwner {
            thread: None,
            id: "fixture",
            generation: 1,
            repository: &repository,
            policy: &policy,
            protected: &[],
            environment: None,
            os_access: Some(&access),
            blit: None,
        };
        let sh = codex_omd::host::unrestricted_program(&access, "sh", &repository).unwrap();
        let sha256 = crate::execution::hash(&fs::read(&sh).unwrap());
        let pidfile = repository.join("child.pid");
        let start = |owner: ProcessOwner<'_>, session: &str| {
            processes.call(
                owner,
                "process.start",
                json!({"session": session, "name": "sh", "path": sh, "sha256": sha256, "sandbox": "none",
                    "arguments": ["-c", format!("sleep 300 & echo $! > {}; exec cat", pidfile.display())]}),
                || true,
            )
        };
        assert_eq!(
            start(
                ProcessOwner {
                    os_access: None,
                    blit: None,
                    ..owner
                },
                "denied"
            )
            .unwrap_err(),
            "capability_denied: os"
        );
        start(owner, "tree").unwrap();
        let answer = processes
            .call(
                owner,
                "process.exchange",
                json!({"session":"tree","send":[{"id":1}],"wait_ms":2000}),
                || true,
            )
            .unwrap();
        assert_eq!(answer["messages"][0]["id"], 1);
        let child = fs::read_to_string(&pidfile).unwrap().trim().to_owned();
        let alive = || {
            Command::new("kill")
                .args(["-0", &child])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        };
        assert!(alive());
        assert_eq!(
            processes
                .call(
                    ProcessOwner {
                        os_access: None,
                        blit: None,
                        ..owner
                    },
                    "process.status",
                    json!({"session":"tree"}),
                    || true
                )
                .unwrap_err(),
            "grant_expired: os"
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive(), "revoking the grant kills the whole process group");
    }

    #[test]
    fn null_frames_do_not_stop_the_blit_worker() {
        let (sender, receiver) = mpsc::channel();
        let frames = blit_worker(
            "frame".into(),
            Arc::new(move |value, _| {
                sender.send(value).unwrap();
                Ok(Value::Null)
            }),
            Arc::new(std::sync::atomic::AtomicBool::new(true)),
            || {},
        );
        frames.offer(Value::Null);
        assert!(receiver.recv_timeout(Duration::from_secs(1)).unwrap()["image"].is_null());
        frames.offer(json!({"media_type":"image/png","base64":"AA=="}));
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(1)).unwrap()["image"]["base64"],
            "AA=="
        );
        drop(frames);
        assert!(receiver.recv_timeout(Duration::from_secs(1)).is_err());
    }

    #[test]
    fn raw_frame_transient_failures_retry_and_cancellation_does_not_kill() {
        for error in [
            "client_surface_closed",
            "callback_execution_budget",
            "callback_cancelled",
            "terminal_blit_unknown",
            "terminal_blit_not_owned",
            "terminal_blit_limit",
            "unrelated explanatory wording",
        ] {
            let (sender, receiver) = mpsc::channel();
            let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let calls = attempts.clone();
            let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let stop = stopped.clone();
            let failures = if error == "callback_cancelled" {
                BLIT_ATTEMPTS as usize + 1
            } else {
                1
            };
            let frames = blit_worker(
                "raw-retry".into(),
                Arc::new(move |_, _| {
                    if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < failures {
                        Err(codex_omd::client_surface::BlitError::retryable(error))
                    } else {
                        sender.send(()).unwrap();
                        Ok(Value::Null)
                    }
                }),
                Arc::new(std::sync::atomic::AtomicBool::new(true)),
                move || {
                    stop.store(true, std::sync::atomic::Ordering::SeqCst);
                },
            );
            frames.offer(json!({"pixels": {}}));
            receiver.recv_timeout(Duration::from_secs(60)).unwrap();
            assert_eq!(
                attempts.load(std::sync::atomic::Ordering::SeqCst),
                failures + 1
            );
            assert!(!stopped.load(std::sync::atomic::Ordering::SeqCst));
        }
        let (sender, receiver) = mpsc::channel();
        let frames = blit_worker(
            "raw-cancel".into(),
            Arc::new(|_, _| Err("terminal_blit_pixels_invalid".into())),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            move || {
                sender.send(()).unwrap();
            },
        );
        frames.offer(json!({"pixels": {}}));
        assert!(matches!(
            receiver.recv_timeout(Duration::from_secs(1)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        ));
    }

    #[test]
    fn raw_frame_revocation_stops_raw_and_encoded_producers() {
        for image in [
            json!({"pixels":{}}),
            json!({"media_type":"image/png", "base64":"AA=="}),
        ] {
            let (sender, receiver) = mpsc::channel();
            let frames = blit_worker(
                "revoked".into(),
                Arc::new(|_, _| {
                    Err(codex_omd::client_surface::BlitError::new(
                        codex_omd::client_surface::BlitErrorKind::Revoked,
                        "authority removed",
                    ))
                }),
                Arc::new(std::sync::atomic::AtomicBool::new(true)),
                move || {
                    sender.send(()).unwrap();
                },
            );
            frames.offer(image);
            receiver.recv_timeout(Duration::from_secs(1)).unwrap();
            assert!(matches!(
                receiver.recv_timeout(Duration::from_secs(1)),
                Err(mpsc::RecvTimeoutError::Disconnected)
            ));
        }
    }

    #[test]
    fn raw_frame_worker_drop_releases_idle_state() {
        let (sender, receiver) = mpsc::channel::<()>();
        let frames = blit_worker(
            "raw-idle".into(),
            Arc::new(move |_, _| {
                let _ = &sender;
                Ok(Value::Null)
            }),
            Arc::new(std::sync::atomic::AtomicBool::new(true)),
            || {},
        );
        drop(frames);
        assert!(matches!(
            receiver.recv_timeout(Duration::from_secs(1)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        ));
    }

    #[test]
    fn invalid_or_unclassified_raw_frame_errors_stop_the_producer_without_retrying() {
        for error in ["terminal_blit_pixels_invalid", "terminal_blit_unclassified"] {
            let (sender, receiver) = mpsc::channel();
            let frames = blit_worker(
                "raw-frame".into(),
                Arc::new(move |_, _| Err(error.into())),
                Arc::new(std::sync::atomic::AtomicBool::new(true)),
                move || {
                    sender.send(()).unwrap();
                },
            );
            frames.offer(json!({"pixels":{"format":"invalid"}}));
            receiver.recv_timeout(Duration::from_secs(1)).unwrap();
            assert!(receiver.recv_timeout(Duration::from_secs(1)).is_err());
        }
    }

    #[test]
    fn exchange_writes_allow_a_slow_reader() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().canonicalize().unwrap();
        let processes = ManagedProcesses::default();
        let policy = FileSystemSandboxPolicy::read_only();
        let access = codex_omd::ModOsAccess {
            programs: vec!["sh".into()],
            network: false,
            node: None,
        };
        let sh = codex_omd::host::unrestricted_program(&access, "sh", &repository).unwrap();
        let owner = ProcessOwner {
            thread: None,
            id: "fixture",
            generation: 1,
            repository: &repository,
            policy: &policy,
            protected: &[],
            environment: None,
            os_access: Some(&access),
            blit: None,
        };
        processes
            .call(
                owner,
                "process.start",
                json!({"session":"slow","name":"sh","path":sh,
            "sha256":program_sha256(&sh).unwrap(),"sandbox":"none","framing":"ndjson",
            "arguments":["-c","sleep 3; cat >/dev/null"]}),
                || true,
            )
            .unwrap();
        processes
            .call(
                owner,
                "process.exchange",
                json!({"session":"slow","send":[{"data":"x".repeat(256*1024)}],"wait_ms":0}),
                || true,
            )
            .unwrap();
        assert!(
            processes
                .call(owner, "process.status", json!({"session":"slow"}), || true)
                .is_ok()
        );
    }

    #[test]
    fn unsandboxed_which_resolves_the_runner_node() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().canonicalize().unwrap();
        let runner = repository.parent().unwrap().join(format!(
            "{}-runner-node",
            repository.file_name().unwrap().to_string_lossy()
        ));
        std::fs::write(&runner, "#!/bin/sh\n").unwrap();
        let processes = ManagedProcesses::default();
        let policy = FileSystemSandboxPolicy::read_only();
        let access = codex_omd::ModOsAccess {
            programs: vec!["node".into()],
            network: false,
            node: Some(runner.clone()),
        };
        let owner = ProcessOwner {
            thread: None,
            id: "fixture",
            generation: 1,
            repository: &repository,
            policy: &policy,
            protected: &[],
            environment: None,
            os_access: Some(&access),
            blit: None,
        };
        let found = processes
            .call(
                owner,
                "process.which",
                json!({"names":["node"],"sandbox":"none"}),
                || true,
            )
            .unwrap();
        std::fs::remove_file(&runner).unwrap();
        assert_eq!(found["found"][0]["path"], json!(runner));
    }

    #[test]
    fn blocked_process_write_observes_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().canonicalize().unwrap();
        let processes = ManagedProcesses::default();
        let policy = FileSystemSandboxPolicy::read_only();
        let owner = ProcessOwner {
            thread: None,
            id: "fixture",
            generation: 1,
            repository: &repository,
            policy: &policy,
            protected: &[],
            environment: None,
            os_access: None,
            blit: None,
        };
        let found = processes
            .call(owner, "process.which", json!({"names":["sleep"]}), || true)
            .unwrap();
        let sleep = found["found"].as_array().unwrap().first().unwrap();
        processes
            .call(
                 owner,
                "process.start",
                json!({"session":"blocked","name":"sleep","path":sleep["path"],"sha256":sleep["sha256"],"arguments":["20"]}),
                || true,
            )
            .unwrap();
        let started = Instant::now();
        let error = processes
            .call(
                owner,
                "process.exchange",
                json!({"session":"blocked","send":[{"data":"x".repeat(256 * 1024)}],"wait_ms":0}),
                || started.elapsed() < Duration::from_millis(100),
            )
            .unwrap_err();
        assert_eq!(error, "process_cancelled");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            processes
                .call(
                    owner,
                    "process.status",
                    json!({"session":"blocked"}),
                    || true,
                )
                .unwrap_err(),
            "process_session_unavailable"
        );
    }

    #[test]
    fn dropping_a_session_kills_what_its_exited_leader_left_in_the_group() {
        let mut child = Command::new("sh")
            .args(["-c", "sleep 30 & echo $!"])
            .stdout(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let orphan: libc::pid_t = line.trim().parse().unwrap();
        let process = ManagedProcess {
            child,
            unrestricted: false,
            sender: mpsc::sync_channel(1).0,
            receiver: mpsc::sync_channel(1).1,
            pending: None,
            exited_at: None,
            stdin: true,
            scratch: PathBuf::from("/nonexistent/omd-reaped"),
            last_used: Instant::now(),
            reaped: Arc::default(),
            _raster: None,
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while !process.exited().unwrap() {
            assert!(Instant::now() < deadline, "the leader never exited");
            std::thread::sleep(Duration::from_millis(10));
        }
        let reaped = Arc::clone(&process.reaped);
        drop(process);
        assert!(*reaped.lock().unwrap());
        while unsafe { libc::kill(orphan, 0) } == 0 {
            assert!(Instant::now() < deadline, "the background child survived");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn process_environment_rejects_host_overrides() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().canonicalize().unwrap();
        let processes = ManagedProcesses::default();
        let policy = FileSystemSandboxPolicy::read_only();
        let owner = ProcessOwner {
            thread: None,
            id: "fixture",
            generation: 1,
            repository: &repository,
            policy: &policy,
            protected: &[],
            environment: None,
            os_access: None,
            blit: None,
        };
        let found = processes
            .call(owner, "process.which", json!({"names":["cat"]}), || true)
            .unwrap();
        let cat = found["found"].as_array().unwrap().first().unwrap();
        for environment in [
            json!({"HOME":"/tmp"}),
            json!({"DYLD_INSERT_LIBRARIES":"/tmp/injected.dylib"}),
            json!({"NODE_OPTIONS":"--require=/tmp/injected.js"}),
            json!({"GIT_CONFIG_GLOBAL":"/tmp/injected"}),
            json!({"BASH_ENV":"/tmp/injected.sh"}),
            json!({"CUSTOM_PATH":"line\nbreak"}),
        ] {
            assert_eq!(
                processes
                    .call(
                         owner,
                        "process.start",
                        json!({"session":"rejected","name":"cat","path":cat["path"],"sha256":cat["sha256"],"environment":environment}),
                        || true,
                    )
                    .unwrap_err(),
                "process_program_or_arguments_invalid"
            );
        }
    }
}
