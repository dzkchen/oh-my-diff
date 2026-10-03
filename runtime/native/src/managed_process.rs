use codex_network_proxy::ManagedNetworkSandboxContext;
use codex_protocol::permissions::FileSystemAccessMode;
use codex_protocol::permissions::FileSystemPath;
use codex_protocol::permissions::FileSystemSandboxEntry;
use codex_protocol::permissions::FileSystemSandboxKind;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use codex_protocol::permissions::NetworkSandboxPolicy;
use codex_sandboxing::seatbelt::CreateSeatbeltCommandArgsParams;
use codex_sandboxing::seatbelt::MACOS_PATH_TO_SEATBELT_EXECUTABLE;
use codex_sandboxing::seatbelt::create_seatbelt_command_args;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_pty::process_group::kill_process_group;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
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
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

type Key = (String, u64, String);
type Session = Arc<Mutex<ManagedProcess>>;
type WriteRequest = (Vec<Value>, mpsc::SyncSender<Result<(), String>>);

pub(super) struct ProcessNotice {
    pub owner: String,
    pub session: String,
    pub output_bytes: Option<usize>,
    pub exited: bool,
    pub deliver: bool,
}

pub(super) type ProcessNotifier = Arc<dyn Fn(ProcessNotice) + Send + Sync>;

#[derive(Default)]
pub(super) struct ManagedProcesses {
    records: Mutex<BTreeMap<Key, Session>>,
    notifier: std::sync::OnceLock<ProcessNotifier>,
}

#[derive(Clone, Copy)]
pub(super) struct ProcessOwner<'a> {
    pub id: &'a str,
    pub generation: u64,
    pub repository: &'a Path,
    pub policy: &'a FileSystemSandboxPolicy,
    pub protected: &'a [PathBuf],
    pub os_access: Option<&'a codex_omd::ModOsAccess>,
}

struct ManagedProcess {
    child: Child,
    unrestricted: bool,
    sender: mpsc::SyncSender<WriteRequest>,
    receiver: mpsc::Receiver<io::Result<Value>>,
    scratch: PathBuf,
    last_used: Instant,
}

impl Drop for ManagedProcess {
    fn drop(&mut self) {
        let _ = kill_process_group(self.child.id());
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.scratch);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Framing {
    ContentLength,
    Ndjson,
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
                "process stopped",
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

fn send_framed(stdin: &mut impl Write, message: &Value, framing: Framing) -> Result<(), String> {
    if framing == Framing::ContentLength {
        return send_message(stdin, message);
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
        if reader.read_line(&mut line)? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "process stopped",
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
        let records = self.records.lock().ok()?;
        let (_, process) = records
            .iter()
            .find(|((id, _, name), _)| id == owner && name == session)?;
        let mut process = process.lock().ok()?;
        Some(process.child.try_wait().ok()?.is_none())
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
            id,
            generation,
            repository,
            policy,
            protected,
            os_access,
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
                }
                let input: Input =
                    serde_json::from_value(arguments).map_err(|error| error.to_string())?;
                if input.names.is_empty() || input.names.len() > 8 {
                    return Err("process_candidate_limit".into());
                }
                let found = input
                    .names
                    .iter()
                    .filter_map(|name| {
                        let path = program(name, repository)?;
                        let metadata = fs::metadata(&path).ok()?;
                        if metadata.len() > 128 * 1024 * 1024 {
                            return None;
                        }
                        let sha256 = crate::execution::hash(&fs::read(&path).ok()?);
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
                    environment: BTreeMap<String, String>,
                    #[serde(default)]
                    framing: Option<String>,
                    #[serde(default)]
                    network: Option<String>,
                    #[serde(default)]
                    notify: Vec<String>,
                    #[serde(default)]
                    sandbox: Option<String>,
                }
                let input: Input =
                    serde_json::from_value(arguments).map_err(|error| error.to_string())?;
                let unrestricted = match input.sandbox.as_deref() {
                    None => None,
                    Some("none") if input.network.is_some() => {
                        return Err("process_unrestricted_network_comes_from_os_access".into());
                    }
                    Some("none") => Some(os_access.ok_or("capability_denied: os")?),
                    Some(_) => return Err("process_sandbox_invalid".into()),
                };
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
                            || value.len() > 1024
                            || value
                                .bytes()
                                .any(|byte| byte == 0 || byte == b'\n' || byte == b'\r')
                    })
                    || !matches!(
                        input.framing.as_deref(),
                        None | Some("content-length") | Some("ndjson")
                    )
                    || !matches!(
                        input.network.as_deref(),
                        None | Some("none") | Some("loopback")
                    )
                    || match unrestricted {
                        Some(access) => {
                            codex_omd::host::unrestricted_program(access, &input.name)?
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
                let metadata = fs::metadata(&input.path).map_err(|error| error.to_string())?;
                if !metadata.is_file()
                    || metadata.len() > 128 * 1024 * 1024
                    || crate::execution::hash(
                        &fs::read(&input.path).map_err(|error| error.to_string())?,
                    ) != input.sha256
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
                let scratch = std::env::temp_dir().join(format!(
                    "omd-process-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_err(|error| error.to_string())?
                        .as_nanos(),
                ));
                fs::create_dir(&scratch).map_err(|error| error.to_string())?;
                fs::set_permissions(&scratch, fs::Permissions::from_mode(0o700)).map_err(
                    |error| {
                        let _ = fs::remove_dir(&scratch);
                        error.to_string()
                    },
                )?;
                let launched = (|| {
                    let framing = if input.framing.as_deref() == Some("ndjson") {
                        Framing::Ndjson
                    } else {
                        Framing::ContentLength
                    };
                    let arguments = input.arguments.into_iter().map(|argument| {
                        argument.replace("{process.home}", &scratch.to_string_lossy())
                    });
                    let mut command = match unrestricted {
                        Some(access) => {
                            let mut command =
                                codex_omd::host::unrestricted_command(access, &input.path, &[]);
                            command.args(arguments);
                            command
                        }
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
                    let mut child = command
                        .current_dir(repository)
                        .env("TMPDIR", &scratch)
                        .env("XDG_CACHE_HOME", &scratch)
                        .env("PYTHONDONTWRITEBYTECODE", "1")
                        .envs(&input.environment)
                        .stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::null())
                        .process_group(0)
                        .spawn()
                        .map_err(|error| error.to_string())?;
                    let streams = child
                        .stdin
                        .take()
                        .zip(child.stdout.take())
                        .ok_or("process_stdio_missing");
                    let (mut stdin, stdout) = match streams {
                        Ok(streams) => streams,
                        Err(error) => {
                            let _ = kill_process_group(child.id());
                            let _ = child.kill();
                            let _ = child.wait();
                            return Err(error.to_owned());
                        }
                    };
                    let (writer_sender, writer_receiver) = mpsc::sync_channel::<WriteRequest>(1);
                    std::thread::spawn(move || {
                        while let Ok((messages, reply)) = writer_receiver.recv() {
                            let result = messages
                                .iter()
                                .try_for_each(|message| send_framed(&mut stdin, message, framing));
                            let failed = result.is_err();
                            let _ = reply.send(result);
                            if failed {
                                break;
                            }
                        }
                    });
                    let (sender, receiver) = mpsc::sync_channel(128);
                    let notifier = self.notifier.get().cloned();
                    let (owner, session) = (id.to_owned(), input.session.clone());
                    std::thread::spawn(move || {
                        let mut reader = BufReader::new(stdout);
                        loop {
                            let result = read_framed(&mut reader, framing);
                            let terminal = result.is_err();
                            let bytes = match (&result, notify_output) {
                                (Ok(message), true) => {
                                    serde_json::to_vec(message).ok().map(|bytes| bytes.len())
                                }
                                _ => None,
                            };
                            if sender.send(result).is_err() || terminal {
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
                    Ok::<_, String>(ManagedProcess {
                        child,
                        unrestricted: unrestricted.is_some(),
                        sender: writer_sender,
                        receiver,
                        scratch: scratch.clone(),
                        last_used: Instant::now(),
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
                if process
                    .child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_some()
                {
                    self.remove(&key, &session);
                    return Err("process_stopped".into());
                }
                if operation == "process.status" {
                    return Ok(
                        json!({"session":input.session,"running":true,"idle_ms":process.last_used.elapsed().as_millis()}),
                    );
                }
                if input.send.len() > 32 || input.wait_ms > 10_000 {
                    return Err("process_exchange_limit".into());
                }
                if !input.send.is_empty() {
                    let (reply_sender, reply_receiver) = mpsc::sync_channel(1);
                    process
                        .sender
                        .send((input.send, reply_sender))
                        .map_err(|_| "process_writer_stopped")?;
                    let write_deadline = Instant::now() + Duration::from_secs(10);
                    loop {
                        if !active() {
                            self.remove(&key, &session);
                            return Err("process_cancelled".into());
                        }
                        match reply_receiver.recv_timeout(Duration::from_millis(50)) {
                            Ok(Ok(())) => break,
                            Ok(Err(error)) => {
                                self.remove(&key, &session);
                                return Err(error);
                            }
                            Err(mpsc::RecvTimeoutError::Disconnected) => {
                                self.remove(&key, &session);
                                return Err("process_writer_stopped".into());
                            }
                            Err(mpsc::RecvTimeoutError::Timeout)
                                if Instant::now() >= write_deadline =>
                            {
                                self.remove(&key, &session);
                                return Err("process_write_timeout".into());
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => (),
                        }
                    }
                }
                process.last_used = Instant::now();
                let deadline = Instant::now() + Duration::from_millis(input.wait_ms);
                let mut messages = Vec::new();
                let mut bytes = 0_usize;
                loop {
                    if !active() {
                        self.remove(&key, &session);
                        return Err("process_cancelled".into());
                    }
                    let next = if messages.is_empty() && input.wait_ms > 0 {
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
                            bytes = bytes.saturating_add(
                                serde_json::to_vec(&message)
                                    .map_err(|error| error.to_string())?
                                    .len(),
                            );
                            if bytes > 4 * 1024 * 1024 || messages.len() >= 64 {
                                return Err("process_exchange_output_limit".into());
                            }
                            messages.push(message);
                        }
                        Ok(Err(error)) => {
                            self.remove(&key, &session);
                            return Err(error.to_string());
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            self.remove(&key, &session);
                            return Err("process_stopped".into());
                        }
                        Err(mpsc::RecvTimeoutError::Timeout)
                            if !messages.is_empty() || Instant::now() >= deadline =>
                        {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framed_process_is_owned_bounded_and_stopped() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().canonicalize().unwrap();
        let processes = ManagedProcesses::default();
        let policy = FileSystemSandboxPolicy::read_only();
        let owner = ProcessOwner {
            id: "fixture",
            generation: 1,
            repository: &repository,
            policy: &policy,
            protected: &[],
            os_access: None,
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
    fn unrestricted_process_needs_a_current_grant_and_takes_its_tree_down() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().canonicalize().unwrap();
        let processes = ManagedProcesses::default();
        let policy = FileSystemSandboxPolicy::read_only();
        let access = codex_omd::ModOsAccess {
            programs: vec!["sh".into()],
            network: true,
        };
        let owner = ProcessOwner {
            id: "fixture",
            generation: 1,
            repository: &repository,
            policy: &policy,
            protected: &[],
            os_access: Some(&access),
        };
        let sh = codex_omd::host::unrestricted_program(&access, "sh").unwrap();
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
    fn blocked_process_write_observes_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().canonicalize().unwrap();
        let processes = ManagedProcesses::default();
        let policy = FileSystemSandboxPolicy::read_only();
        let owner = ProcessOwner {
            id: "fixture",
            generation: 1,
            repository: &repository,
            policy: &policy,
            protected: &[],
            os_access: None,
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
    fn process_environment_rejects_host_overrides() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().canonicalize().unwrap();
        let processes = ManagedProcesses::default();
        let policy = FileSystemSandboxPolicy::read_only();
        let owner = ProcessOwner {
            id: "fixture",
            generation: 1,
            repository: &repository,
            policy: &policy,
            protected: &[],
            os_access: None,
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
