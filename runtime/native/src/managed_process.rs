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
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

type Key = (String, u64, String);

#[derive(Default)]
pub(super) struct ManagedProcesses {
    records: Mutex<BTreeMap<Key, ManagedProcess>>,
}

struct ManagedProcess {
    child: Child,
    sender: mpsc::SyncSender<(Vec<Value>, mpsc::SyncSender<Result<(), String>>)>,
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

fn read_policy(
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

    pub fn call(
        &self,
        id: &str,
        generation: u64,
        repository: &Path,
        policy: &FileSystemSandboxPolicy,
        operation: &str,
        arguments: Value,
        active: impl Fn() -> bool,
    ) -> Result<Value, String> {
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
                    transport: Option<String>,
                }
                let input: Input =
                    serde_json::from_value(arguments).map_err(|error| error.to_string())?;
                if input.session.is_empty()
                    || input.session.len() > 64
                    || !input
                        .session
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                    || input.arguments.len() > 16
                    || input.arguments.iter().map(String::len).sum::<usize>() > 4096
                    || !matches!(
                        input.transport.as_deref(),
                        None | Some("stdio") | Some("unix_dap") | Some("stdio_dap")
                    )
                    || (input.transport.as_deref() == Some("unix_dap")
                        && (input.name != "dlv" || input.arguments != ["dap"]))
                    || (input.transport.as_deref() == Some("stdio_dap")
                        && !((input.name == "lldb-dap" && input.arguments.is_empty())
                            || (input.name == "python3"
                                && input.arguments == ["-m", "debugpy.adapter"])))
                    || program(&input.name, repository).as_ref() != Some(&input.path)
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
                let mut records = self
                    .records
                    .lock()
                    .map_err(|_| "process_records_poisoned")?;
                if records.contains_key(&key)
                    || records.len() >= 8
                    || records.keys().filter(|(owner, _, _)| owner == id).count() >= 5
                {
                    return Err("process_session_limit_or_duplicate".into());
                }
                let scratch_root = if input.transport.as_deref() == Some("unix_dap") {
                    PathBuf::from("/private/tmp")
                } else {
                    std::env::temp_dir()
                };
                let scratch = scratch_root.join(format!(
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
                    let scope = read_policy(policy, &scratch)?;
                    let socket = scratch.join("dap.sock");
                    let unix_dap = input.transport.as_deref() == Some("unix_dap");
                    let stdio_dap = input.transport.as_deref() == Some("stdio_dap");
                    let mut command = vec![input.path.to_string_lossy().into_owned()];
                    command.extend(input.arguments);
                    if unix_dap {
                        command.push(format!("--listen=unix:{}", socket.display()));
                    }
                    let sockets = if unix_dap {
                        vec![
                            AbsolutePathBuf::from_absolute_path_checked(&socket)
                                .map_err(|error| error.to_string())?,
                        ]
                    } else {
                        Vec::new()
                    };
                    let loopback = (stdio_dap || unix_dap).then(|| ManagedNetworkSandboxContext {
                        allow_local_binding: true,
                        ..Default::default()
                    });
                    let argv = create_seatbelt_command_args(CreateSeatbeltCommandArgsParams {
                        command,
                        file_system_sandbox_policy: &scope,
                        network_sandbox_policy: NetworkSandboxPolicy::Restricted,
                        sandbox_policy_cwd: repository,
                        enforce_managed_network: stdio_dap || unix_dap,
                        managed_network: loopback.as_ref(),
                        environment_id: None,
                        network: None,
                        extra_allow_unix_sockets: &sockets,
                    })?;
                    let mut command = Command::new(MACOS_PATH_TO_SEATBELT_EXECUTABLE);
                    let mut child = command
                        .args(argv)
                        .current_dir(repository)
                        .env_clear()
                        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
                        .env("HOME", &scratch)
                        .env("TMPDIR", &scratch)
                        .env("XDG_CACHE_HOME", &scratch)
                        .env("PYTHONDONTWRITEBYTECODE", "1")
                        .stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::null())
                        .process_group(0)
                        .spawn()
                        .map_err(|error| error.to_string())?;
                    let streams: Result<(Box<dyn Write + Send>, Box<dyn Read + Send>), String> =
                        (|| {
                            if !unix_dap {
                                return Ok((
                                    Box::new(child.stdin.take().ok_or("process_stdin_missing")?)
                                        as Box<dyn Write + Send>,
                                    Box::new(child.stdout.take().ok_or("process_stdout_missing")?)
                                        as Box<dyn Read + Send>,
                                ));
                            }
                            let deadline = Instant::now() + Duration::from_secs(3);
                            let stream = loop {
                                if !active()
                                    || Instant::now() >= deadline
                                    || child
                                        .try_wait()
                                        .map_err(|error| error.to_string())?
                                        .is_some()
                                {
                                    return Err("process_socket_start_failed".into());
                                }
                                match UnixStream::connect(&socket) {
                                    Ok(stream) => break stream,
                                    Err(_) => std::thread::sleep(Duration::from_millis(25)),
                                }
                            };
                            let reader = stream.try_clone().map_err(|error| error.to_string())?;
                            Ok((Box::new(stream), Box::new(reader)))
                        })();
                    let (stdin, stdout) = match streams {
                        Ok(streams) => streams,
                        Err(error) => {
                            let _ = kill_process_group(child.id());
                            let _ = child.kill();
                            let _ = child.wait();
                            return Err(error);
                        }
                    };
                    let (writer_sender, writer_receiver) =
                        mpsc::sync_channel::<(Vec<Value>, mpsc::SyncSender<Result<(), String>>)>(1);
                    std::thread::spawn(move || {
                        let mut stdin = stdin;
                        while let Ok((messages, reply)) = writer_receiver.recv() {
                            let result = messages
                                .iter()
                                .try_for_each(|message| send_message(&mut stdin, message));
                            let failed = result.is_err();
                            let _ = reply.send(result);
                            if failed {
                                break;
                            }
                        }
                    });
                    let (sender, receiver) = mpsc::sync_channel(128);
                    std::thread::spawn(move || {
                        let mut reader = BufReader::new(stdout);
                        loop {
                            let result = read_message(&mut reader);
                            let terminal = result.is_err();
                            if sender.send(result).is_err() || terminal {
                                break;
                            }
                        }
                    });
                    Ok::<_, String>(ManagedProcess {
                        child,
                        sender: writer_sender,
                        receiver,
                        scratch: scratch.clone(),
                        last_used: Instant::now(),
                    })
                })();
                match launched {
                    Ok(process) => {
                        records.insert(key, process);
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
                let mut records = self
                    .records
                    .lock()
                    .map_err(|_| "process_records_poisoned")?;
                if operation == "process.stop" {
                    return Ok(json!({"stopped":records.remove(&key).is_some()}));
                }
                let process = records.get_mut(&key).ok_or("process_session_unavailable")?;
                if process
                    .child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_some()
                {
                    records.remove(&key);
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
                            records.remove(&key);
                            return Err("process_cancelled".into());
                        }
                        match reply_receiver.recv_timeout(Duration::from_millis(50)) {
                            Ok(Ok(())) => break,
                            Ok(Err(error)) => {
                                records.remove(&key);
                                return Err(error);
                            }
                            Err(mpsc::RecvTimeoutError::Disconnected) => {
                                records.remove(&key);
                                return Err("process_writer_stopped".into());
                            }
                            Err(mpsc::RecvTimeoutError::Timeout)
                                if Instant::now() >= write_deadline =>
                            {
                                records.remove(&key);
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
                        records.remove(&key);
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
                            records.remove(&key);
                            return Err(error.to_string());
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            records.remove(&key);
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
    fn unix_dap_process_uses_private_owned_socket() {
        let repository_dir = tempfile::tempdir().unwrap();
        let repository = repository_dir.path().canonicalize().unwrap();
        let executable_dir = tempfile::tempdir().unwrap();
        let executable = executable_dir.path().join("dlv");
        fs::write(
            &executable,
            "#!/usr/bin/python3\nimport json,socket,sys\np=sys.argv[2].split('unix:',1)[1]\ns=socket.socket(socket.AF_UNIX)\ns.bind(p)\ns.listen(1)\nc,_=s.accept()\nwhile True:\n h=b''\n while b'\\r\\n\\r\\n' not in h:\n  b=c.recv(1)\n  if not b: sys.exit(0)\n  h+=b\n n=int(h.split(b':',1)[1].strip())\n v=json.loads(c.recv(n))\n out=json.dumps({'type':'response','request_seq':v['seq'],'success':True}).encode()\n c.sendall(b'Content-Length: '+str(len(out)).encode()+b'\\r\\n\\r\\n'+out)\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let old_path = std::env::var_os("PATH").unwrap_or_default();
        let new_path = format!(
            "{}:{}",
            executable_dir.path().display(),
            old_path.to_string_lossy()
        );
        unsafe { std::env::set_var("PATH", new_path) };
        let processes = ManagedProcesses::default();
        let policy = FileSystemSandboxPolicy::read_only();
        let found = processes
            .call(
                "fixture",
                1,
                &repository,
                &policy,
                "process.which",
                json!({"names":["dlv"]}),
                || true,
            )
            .unwrap();
        let dlv = &found["found"][0];
        let started = processes.call("fixture", 1, &repository, &policy, "process.start", json!({"session":"dap","name":"dlv","path":dlv["path"],"sha256":dlv["sha256"],"arguments":["dap"],"transport":"unix_dap"}), || true);
        unsafe { std::env::set_var("PATH", old_path) };
        assert!(started.is_ok(), "{started:?}");
        let records = processes.records.lock().unwrap();
        let scratch = &records.values().next().unwrap().scratch;
        assert_eq!(
            fs::metadata(scratch).unwrap().permissions().mode() & 0o777,
            0o700
        );
        drop(records);
        let response = processes.call("fixture", 1, &repository, &policy, "process.exchange", json!({"session":"dap","send":[{"seq":1,"type":"request","command":"initialize"}],"wait_ms":1000}), || true).unwrap();
        assert_eq!(response["messages"][0]["request_seq"], 1);
        assert_eq!(
            processes
                .call(
                    "fixture",
                    1,
                    &repository,
                    &policy,
                    "process.stop",
                    json!({"session":"dap"}),
                    || true
                )
                .unwrap()["stopped"],
            true
        );
    }

    #[test]
    fn framed_process_is_owned_bounded_and_stopped() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().canonicalize().unwrap();
        let processes = ManagedProcesses::default();
        let policy = FileSystemSandboxPolicy::read_only();
        let found = processes
            .call(
                "fixture",
                1,
                &repository,
                &policy,
                "process.which",
                json!({"names":["cat"]}),
                || true,
            )
            .unwrap();
        let cat = found["found"].as_array().unwrap().first().unwrap();
        let started = processes
            .call(
                "fixture",
                1,
                &repository,
                &policy,
                "process.start",
                json!({"session":"framed","name":"cat","path":cat["path"],"sha256":cat["sha256"]}),
                || true,
            )
            .unwrap();
        assert_eq!(started["running"], true);
        let answer = processes
            .call("fixture", 1, &repository, &policy, "process.exchange", json!({"session":"framed","send":[{"jsonrpc":"2.0","id":7,"method":"hello"}],"wait_ms":1000}), || true)
            .unwrap();
        assert_eq!(answer["messages"][0]["method"], "hello");
        assert_eq!(
            processes
                .call(
                    "other",
                    1,
                    &repository,
                    &policy,
                    "process.status",
                    json!({"session":"framed"}),
                    || true
                )
                .unwrap_err(),
            "process_session_unavailable"
        );
        assert_eq!(
            processes
                .call(
                    "fixture",
                    1,
                    &repository,
                    &policy,
                    "process.stop",
                    json!({"session":"framed"}),
                    || true
                )
                .unwrap()["stopped"],
            true
        );
    }

    #[test]
    fn blocked_process_write_observes_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().canonicalize().unwrap();
        let processes = ManagedProcesses::default();
        let policy = FileSystemSandboxPolicy::read_only();
        let found = processes
            .call(
                "fixture",
                1,
                &repository,
                &policy,
                "process.which",
                json!({"names":["sleep"]}),
                || true,
            )
            .unwrap();
        let sleep = found["found"].as_array().unwrap().first().unwrap();
        processes
            .call(
                "fixture",
                1,
                &repository,
                &policy,
                "process.start",
                json!({"session":"blocked","name":"sleep","path":sleep["path"],"sha256":sleep["sha256"],"arguments":["20"]}),
                || true,
            )
            .unwrap();
        let started = Instant::now();
        let error = processes
            .call(
                "fixture",
                1,
                &repository,
                &policy,
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
                    "fixture",
                    1,
                    &repository,
                    &policy,
                    "process.status",
                    json!({"session":"blocked"}),
                    || true,
                )
                .unwrap_err(),
            "process_session_unavailable"
        );
    }
}
