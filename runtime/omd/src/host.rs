use crate::data_store::DataStore;
use crate::data_store::Origin;
use crate::data_store::StoreProvenance;
use crate::workspace::Fingerprint;
use crate::workspace::WorkspaceTransaction;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::io::Write;
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

mod environment;
pub use environment::{Environment, EnvironmentValues, environment_evidence, validate_environment};

pub const RESERVED_EXEC_ENVIRONMENT: &[&str] = &[
    "PATH",
    "HOME",
    "TMPDIR",
    "SHELL",
    "USER",
    "LOGNAME",
    "PWD",
    "OLDPWD",
    "IFS",
    "ENV",
    "BASH_ENV",
    "NODE_OPTIONS",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "RUBYOPT",
    "PERL5OPT",
];
pub const RESERVED_EXEC_PREFIXES: &[&str] = &[
    "DYLD_",
    "LD_",
    "OMD_",
    "CODEX_",
    "SSH_",
    "GPG_",
    "GIT_CONFIG",
];
pub const EXEC_DEFAULT_TIMEOUT_MS: u64 = 10_000;
pub const EXEC_MAX_TIMEOUT_MS: u64 = 120_000;
pub const EXEC_OUTPUT_BYTES: usize = 1024 * 1024;
pub const EXEC_INLINE_STDOUT_BYTES: usize = crate::mods::HOST_RECEIPT_BYTES / 2;
pub const EXEC_INLINE_STDERR_BYTES: usize = crate::mods::HOST_RECEIPT_BYTES / 8;
pub const EXEC_ARTIFACT_BYTES: usize = 16 * 1024 * 1024;
pub const EXEC_ARTIFACT_PAGE_BYTES: usize = 16 * 1024;
const EXEC_ARTIFACT_STORE_BYTES: u64 = 64 * 1024 * 1024;
const EXEC_ARTIFACT_STORE_COUNT: usize = 128;
pub const EXEC_CONCURRENCY: usize = 4;
const LIST_LIMIT: usize = 20_000;
const BACKUP_LIMIT: usize = 256;
const BACKUP_BYTES: u64 = 64 * 1024 * 1024;
const LIST_EXCLUDED: &[&str] = &[".git", ".omd"];

static RUNNING: Mutex<BTreeMap<String, usize>> = Mutex::new(BTreeMap::new());

pub struct ExecAccess<'a> {
    pub write: bool,
    pub loopback: bool,
    pub unix_sockets: &'a [PathBuf],
    pub scratch: &'a Path,
}

pub trait Authority {
    fn repository(&self) -> &Path;
    fn readable(&self, path: &Path) -> bool;
    fn writable(&self, path: &Path) -> bool;
    fn command(&self, argv: Vec<String>, access: &ExecAccess<'_>) -> Result<Command, String>;
    fn protected(&self) -> &[PathBuf] {
        &[]
    }
}

pub struct Caller<'a> {
    pub id: &'a str,
    pub source_sha256: &'a str,
    pub capabilities: &'a [String],
    pub exec_environment: &'a [String],
    pub os_access: Option<&'a crate::ModOsAccess>,
    pub fs_access: Option<&'a crate::ModFsAccess>,
    pub origin: Origin,
    pub thread: Option<&'a str>,
}

pub struct Host<'a> {
    pub authority: &'a dyn Authority,
    pub data_root: &'a Path,
    pub environment: Option<&'a Environment>,
    pub active: &'a dyn Fn() -> bool,
    pub record_changes: bool,
}

const CREDENTIAL_PATHS: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".config/gh",
    ".config/gcloud",
    ".docker",
    ".kube",
    ".netrc",
    ".git-credentials",
    ".npmrc",
    "Library/Keychains",
];

pub fn secret_like(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    name.starts_with("AWS_")
        || ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL"]
            .iter()
            .any(|part| name.contains(part))
}

fn credential_paths() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|home| home.join(".codex")))
        .into_iter()
        .chain(
            home.iter()
                .flat_map(|home| CREDENTIAL_PATHS.iter().map(|path| home.join(path))),
        )
        .collect()
}

pub type SessionDispatcher = Arc<
    dyn Fn(
            &str,
            &str,
            Option<&str>,
            Option<&Value>,
            crate::ModHostCall,
            &dyn Fn() -> bool,
        ) -> std::io::Result<Value>
        + Send
        + Sync,
>;

static SESSION_DISPATCHER: Mutex<Option<(Arc<()>, Option<SessionDispatcher>)>> = Mutex::new(None);

pub struct SessionRegistration(Arc<()>);

impl SessionRegistration {
    pub fn install(&self, dispatcher: SessionDispatcher) -> std::io::Result<()> {
        let mut installed = SESSION_DISPATCHER
            .lock()
            .map_err(|_| std::io::Error::other("host_installation_poisoned"))?;
        match installed.as_mut() {
            Some((owner, slot)) if Arc::ptr_eq(owner, &self.0) && slot.is_none() => {
                *slot = Some(dispatcher);
                Ok(())
            }
            _ => Err(std::io::Error::other("host_installation_stale")),
        }
    }
}

impl Drop for SessionRegistration {
    fn drop(&mut self) {
        let mut installed = SESSION_DISPATCHER
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if installed
            .as_ref()
            .is_some_and(|(owner, _)| Arc::ptr_eq(owner, &self.0))
        {
            *installed = None;
        }
    }
}

pub fn install_session_dispatcher(
    dispatcher: SessionDispatcher,
) -> std::io::Result<SessionRegistration> {
    let registration = reserve_session_dispatcher()?;
    registration.install(dispatcher)?;
    Ok(registration)
}

pub fn reserve_session_dispatcher() -> std::io::Result<SessionRegistration> {
    let mut installed = SESSION_DISPATCHER
        .lock()
        .map_err(|_| std::io::Error::other("host_installation_poisoned"))?;
    if installed.is_some() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "host_already_installed",
        ));
    }
    let owner = Arc::new(());
    *installed = Some((owner.clone(), None));
    Ok(SessionRegistration(owner))
}

pub fn session_call(
    thread: &str,
    caller: &str,
    source: Option<&str>,
    policy: Option<&Value>,
    call: crate::ModHostCall,
    active: &dyn Fn() -> bool,
) -> std::io::Result<Value> {
    let dispatcher = SESSION_DISPATCHER
        .lock()
        .ok()
        .and_then(|installed| {
            installed
                .as_ref()
                .and_then(|(_, dispatcher)| dispatcher.clone())
        })
        .ok_or_else(|| {
            std::io::Error::other("host_operation_unavailable: no session in this process")
        })?;
    dispatcher(thread, caller, source, policy, call, active)
}

pub fn deny_protected(profile: &mut String, protected: &[PathBuf]) -> Result<(), String> {
    for root in protected.iter().cloned().chain(credential_paths()) {
        for path in std::iter::once(root.clone()).chain(root.canonicalize().ok()) {
            let literal = serde_json::to_string(&path.to_string_lossy())
                .map_err(|error| error.to_string())?;
            profile.push_str(&format!(
                "\n(deny file-read* file-write* (literal {literal}) (subpath {literal}))"
            ));
        }
    }
    Ok(())
}

pub fn served(operation: &str) -> bool {
    matches!(
        operation,
        "exec.run"
            | "exec.output_page"
            | "workspace.read"
            | "workspace.list"
            | "workspace.stat"
            | "workspace.check_access"
            | "workspace.transaction"
            | "workspace.backup"
            | "workspace.restore"
            | "store.get"
            | "store.put"
            | "store.delete"
            | "store.list"
            | "store.export"
            | "store.reset"
            | "environment.read"
            | "environment.set"
    )
}

struct ExternalRoot {
    root: PathBuf,
    write: bool,
}

impl Authority for ExternalRoot {
    fn repository(&self) -> &Path {
        &self.root
    }

    fn readable(&self, path: &Path) -> bool {
        path.starts_with(&self.root)
    }

    fn writable(&self, path: &Path) -> bool {
        self.write && path.starts_with(&self.root)
    }

    fn command(&self, _argv: Vec<String>, _access: &ExecAccess<'_>) -> Result<Command, String> {
        Err("fs_external_exec_unavailable".into())
    }
}

pub fn validate_environment_read(arguments: &Value) -> Result<Vec<String>, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        names: Vec<String>,
    }
    let input: Input =
        serde_json::from_value(arguments.clone()).map_err(|error| error.to_string())?;
    if input.names.is_empty() || input.names.len() > 16 {
        return Err("environment_names_invalid".into());
    }
    Ok(input.names)
}

pub fn validate_environment_set(arguments: &Value) -> Result<(String, Option<String>), String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        name: String,
        value: Value,
    }
    let input: Input =
        serde_json::from_value(arguments.clone()).map_err(|_| "environment_arguments_invalid")?;
    if !environment::environment_name_valid(&input.name) {
        return Err("environment_name_invalid".into());
    }
    let value = match input.value {
        Value::Null => None,
        Value::String(value) if value.len() <= 4096 && !value.contains('\0') => Some(value),
        _ => return Err("environment_value_invalid".into()),
    };
    Ok((input.name, value))
}

pub fn validate_timer_request(operation: &str, arguments: &Value) -> Result<(String, u64), String> {
    if operation == "events.cancel" {
        return arguments["key"]
            .as_str()
            .map(|key| (key.to_owned(), 0))
            .ok_or_else(|| "timer_invalid".into());
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        key: String,
        delay_ms: u64,
    }
    let input: Input =
        serde_json::from_value(arguments.clone()).map_err(|error| error.to_string())?;
    if input.key.is_empty() || input.key.len() > 64 || !(16..=86_400_000).contains(&input.delay_ms)
    {
        return Err("timer_invalid".into());
    }
    Ok((input.key, input.delay_ms))
}

fn environment(
    state: Option<&Environment>,
    caller: &Caller<'_>,
    arguments: Value,
) -> Result<Value, String> {
    let names = validate_environment_read(&arguments)?;
    let mut values = serde_json::Map::new();
    let overrides = state
        .map(|state| {
            state.values(
                caller.thread,
                caller.id,
                caller.source_sha256,
                caller.exec_environment,
            )
        })
        .transpose()?
        .unwrap_or_default();
    for name in names {
        if !caller.exec_environment.contains(&name) {
            return Err(format!("exec_environment_undeclared: {name}"));
        }
        let value = overrides
            .get(&name)
            .cloned()
            .or_else(|| std::env::var(&name).ok())
            .filter(|value| value.len() <= 4096);
        let entry = if secret_like(&name) {
            json!({"set": value.is_some()})
        } else {
            json!({"set": value.is_some(), "value": value})
        };
        values.insert(name, entry);
    }
    Ok(json!({"values": values}))
}

pub fn repository_key(repository: &Path) -> String {
    format!(
        "{:x}",
        Sha256::digest(repository.as_os_str().as_encoded_bytes())
    )
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Result<Vec<u8>, String> {
    if !text.len().is_multiple_of(2) {
        return Err("backup_record_invalid".into());
    }
    (0..text.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&text[index..index + 2], 16)
                .map_err(|_| "backup_record_invalid".into())
        })
        .collect()
}

fn relative(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 4096
        && !name.starts_with('/')
        && !name.contains('\\')
        && !name.contains('\0')
        && name.split('/').all(|part| {
            !part.is_empty() && part != "." && part != ".." && !part.eq_ignore_ascii_case(".git")
        })
}

struct Running(String);

impl Drop for Running {
    fn drop(&mut self) {
        if let Ok(mut running) = RUNNING.lock()
            && let Some(count) = running.get_mut(&self.0)
        {
            *count = count.saturating_sub(1);
        }
    }
}

struct Child(std::process::Child);

impl Drop for Child {
    fn drop(&mut self) {
        if let Some(pid) = rustix::process::Pid::from_raw(self.0.id() as i32) {
            let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn resolve_program(name: &str, repository: &Path) -> Option<PathBuf> {
    let path = Path::new(name);
    if path.is_absolute() {
        let canonical = path.canonicalize().ok()?;
        return (canonical == path && canonical.is_file() && !canonical.starts_with(repository))
            .then_some(canonical);
    }
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

/// Like [`resolve_program`], a bare name never resolves inside the repository, whose files the
/// sandboxed agent can write; an absolute program there runs only when `os_access` lists that path.
pub fn unrestricted_program(
    access: &crate::ModOsAccess,
    name: &str,
    repository: &Path,
) -> Result<PathBuf, String> {
    let path = Path::new(name);
    let resolved = if let Some(node) = access.node.as_ref().filter(|_| name == "node") {
        node.canonicalize().ok()
    } else if path.is_absolute() {
        path.canonicalize().ok()
    } else if !name.is_empty() && !name.contains('/') && !name.contains('\0') {
        std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths).find_map(|directory| {
                let candidate = directory.join(name).canonicalize().ok()?;
                (!candidate.starts_with(repository)).then_some(candidate)
            })
        })
    } else {
        None
    }
    .filter(|path| path.is_file())
    .ok_or("exec_program_unavailable")?;
    let listed = access
        .programs
        .iter()
        .any(|allowed| Path::new(allowed) == resolved || Path::new(allowed) == path);
    if resolved.starts_with(repository) && !listed
        || !access.allows(name, &resolved) && !access.allows(name, path)
    {
        return Err(format!("os_access_denied: {name}"));
    }
    Ok(resolved)
}

/// The command for an unsandboxed program: no Seatbelt with network, otherwise a macOS Seatbelt denying only IP networking.
pub fn unrestricted_command(
    access: &crate::ModOsAccess,
    program: &Path,
    exec_environment: &[String],
) -> Result<Command, String> {
    let mut command = if access.network {
        Command::new(program)
    } else if !cfg!(target_os = "macos") {
        return Err("exec_sandbox_unavailable".to_owned());
    } else {
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command
            .args([
                "-p",
                "(version 1)(allow default)(deny network*)(allow network* (remote unix-socket))(allow network* (local unix-socket))",
            ])
            .arg(program);
        command
    };
    command
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default());
    for name in [
        "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
    ]
    .into_iter()
    .chain(exec_environment.iter().map(String::as_str))
    {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    Ok(command)
}

fn inherited_socket(name: &str, repository: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::FileTypeExt;
    use std::os::unix::fs::MetadataExt;
    let path = PathBuf::from(std::env::var_os(name)?);
    let metadata = fs::symlink_metadata(&path).ok()?;
    (path.is_absolute()
        && path.canonicalize().ok()? == path
        && !path.starts_with(repository)
        && metadata.file_type().is_socket()
        && metadata.uid() == rustix::process::geteuid().as_raw())
    .then_some(path)
}

pub fn program_hash(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > 128 * 1024 * 1024 {
        return Err("exec_program_too_large".into());
    }
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut chunk = vec![0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&chunk[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn stored_outputs(owner: &Path) -> Result<Vec<(std::time::SystemTime, PathBuf, u64)>, String> {
    let mut stored = Vec::new();
    let mut directories = vec![(owner.to_path_buf(), 0)];
    while let Some((directory, depth)) = directories.pop() {
        for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() {
                return Err("exec_output_directory_invalid".into());
            }
            if metadata.is_dir() && depth < 2 {
                directories.push((entry.path(), depth + 1));
            } else if depth == 2
                && metadata.is_file()
                && entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "txt")
            {
                let modified = metadata.modified().map_err(|error| error.to_string())?;
                stored.push((modified, entry.path(), metadata.len()));
            }
        }
    }
    Ok(stored)
}

impl Host<'_> {
    fn repository(&self) -> &Path {
        self.authority.repository()
    }

    fn output_directory(&self, caller: &Caller<'_>) -> Result<PathBuf, String> {
        let thread = caller.thread.unwrap_or("cli");
        if !crate::resource_data::token(caller.id)
            || !crate::resource_data::token(thread)
            || caller.source_sha256.len() != 64
            || !caller
                .source_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || self
                .data_root
                .canonicalize()
                .map_err(|error| error.to_string())?
                != self.data_root
            || self.data_root.starts_with(self.repository())
        {
            return Err("exec_output_binding_invalid".into());
        }
        let path = crate::workspace::private_path(
            self.data_root,
            &[
                "exec-output",
                &repository_key(self.repository()),
                caller.id,
                thread,
                caller.source_sha256,
            ],
            "exec_output_directory_invalid",
        )
        .map_err(|error| error.to_string())?;
        if path.canonicalize().map_err(|error| error.to_string())? != path {
            return Err("exec_output_directory_invalid".into());
        }
        Ok(path)
    }

    fn save_output(&self, caller: &Caller<'_>, bytes: &[u8]) -> Result<Value, String> {
        std::str::from_utf8(bytes).map_err(|_| "exec_output_artifact_utf8_required")?;
        let directory = self.output_directory(caller)?;
        let owner = directory
            .parent()
            .and_then(Path::parent)
            .ok_or("exec_output_directory_invalid")?;
        let digest = sha256(bytes);
        let path = directory.join(format!("{digest}.txt"));
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(owner.join(".outputs.lock"))
            .map_err(|error| error.to_string())?;
        lock.try_lock().map_err(|_| "exec_output_store_busy")?;
        if path.exists() {
            if fs::symlink_metadata(&path)
                .map_err(|error| error.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err("exec_output_integrity_failed".into());
            }
            let existing = fs::read(&path).map_err(|error| error.to_string())?;
            if existing != bytes {
                return Err("exec_output_integrity_failed".into());
            }
        } else {
            let mut stored = stored_outputs(owner)?;
            stored.sort();
            let mut total: u64 = stored.iter().map(|(_, _, len)| len).sum();
            let mut oldest = stored.into_iter();
            while total.saturating_add(bytes.len() as u64) > EXEC_ARTIFACT_STORE_BYTES
                || oldest.len() >= EXEC_ARTIFACT_STORE_COUNT
            {
                let (_, evicted, len) = oldest.next().ok_or("exec_output_store_quota")?;
                fs::remove_file(&evicted).map_err(|error| error.to_string())?;
                total -= len;
                for parent in evicted.ancestors().skip(1).take(2) {
                    if parent != directory && fs::remove_dir(parent).is_err() {
                        break;
                    }
                }
            }
            let temporary = directory.join(format!(".{digest}.{}.tmp", crate::peers::now_ms()));
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
                .open(&temporary)
                .map_err(|error| error.to_string())?;
            let written = file.write_all(bytes).and_then(|()| file.sync_all());
            drop(file);
            if let Err(error) = written {
                let _ = fs::remove_file(&temporary);
                return Err(error.to_string());
            }
            if let Err(error) = fs::rename(&temporary, &path) {
                let _ = fs::remove_file(&temporary);
                return Err(error.to_string());
            }
            fs::File::open(&directory)
                .and_then(|file| file.sync_all())
                .map_err(|error| error.to_string())?;
        }
        Ok(json!({"reference": digest, "sha256": digest}))
    }

    fn output_page(&self, caller: &Caller<'_>, arguments: Value) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            artifact: crate::resource_data::ResourceRef,
            #[serde(default)]
            cursor: usize,
            #[serde(default)]
            max_bytes: Option<usize>,
        }
        let input: Input = serde_json::from_value(arguments).map_err(|error| error.to_string())?;
        let digest = &input.artifact.sha256;
        if digest.len() != 64
            || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
            || input.artifact.reference != *digest
        {
            return Err("exec_output_reference_invalid".into());
        }
        let directory = self.output_directory(caller)?;
        let path = directory.join(format!("{digest}.txt"));
        let mut file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(path)
            .map_err(|_| "exec_output_unavailable")?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take((EXEC_ARTIFACT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() > EXEC_ARTIFACT_BYTES || sha256(&bytes) != *digest {
            return Err("exec_output_integrity_failed".into());
        }
        if !(self.active)() {
            return Err("host_operation_cancelled".into());
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| "exec_output_integrity_failed")?;
        if input.cursor > bytes.len() || !text.is_char_boundary(input.cursor) {
            return Err("exec_output_cursor_invalid".into());
        }
        let max = input
            .max_bytes
            .unwrap_or(EXEC_ARTIFACT_PAGE_BYTES)
            .clamp(1, EXEC_ARTIFACT_PAGE_BYTES);
        let mut end = input.cursor.saturating_add(max).min(bytes.len());
        while end > input.cursor && !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == input.cursor && end < bytes.len() {
            end += text[end..]
                .chars()
                .next()
                .ok_or("exec_output_cursor_invalid")?
                .len_utf8();
        }
        Ok(
            json!({"text": &text[input.cursor..end], "cursor": if end < bytes.len() { Some(end) } else { None },
            "bytes": bytes.len(), "sha256": digest}),
        )
    }

    fn external(
        &self,
        caller: &Caller<'_>,
        operation: &str,
        mut arguments: Value,
    ) -> Result<Value, String> {
        let root = arguments
            .as_object_mut()
            .and_then(|fields| fields.remove("root"))
            .and_then(|root| root.as_str().map(str::to_owned))
            .ok_or("fs_root_invalid")?;
        let granted = caller
            .fs_access
            .and_then(|access| access.roots.iter().find(|granted| granted.path == root))
            .ok_or_else(|| format!("fs_root_not_granted: {root}"))?;
        let path = PathBuf::from(&root);
        if fs::canonicalize(&path).ok().as_deref() != Some(path.as_path()) || !path.is_dir() {
            return Err(format!("fs_root_not_canonical: {root}"));
        }
        let overlaps = |other: &Path| path.starts_with(other) || other.starts_with(&path);
        if credential_paths()
            .into_iter()
            .chain(self.authority.protected().iter().cloned())
            .chain([
                self.data_root.to_path_buf(),
                self.repository().to_path_buf(),
            ])
            .any(|other| {
                overlaps(&other) || other.canonicalize().is_ok_and(|other| overlaps(&other))
            })
        {
            return Err(format!("fs_root_protected: {root}"));
        }
        let authority = ExternalRoot {
            root: path,
            write: granted.write,
        };
        let host = Host {
            authority: &authority,
            data_root: self.data_root,
            environment: self.environment,
            active: self.active,
            record_changes: false,
        };
        match operation {
            "workspace.read" => host.read(arguments),
            "workspace.list" => host.list(arguments),
            "workspace.stat" => host.stat(arguments),
            _ => host.transaction(caller, arguments),
        }
    }

    fn checked_paths(&self, names: &[String], write: bool) -> Result<Vec<PathBuf>, String> {
        if names.is_empty()
            || names.len() > 128
            || names.iter().collect::<BTreeSet<_>>().len() != names.len()
        {
            return Err("workspace_path_scope_invalid".into());
        }
        names
            .iter()
            .map(|name| {
                if !(self.active)() {
                    return Err("host_operation_cancelled".into());
                }
                let path = crate::workspace_path(self.repository(), name)
                    .map_err(|error| error.to_string())?;
                if !self.authority.readable(&path) {
                    return Err("workspace_read_permission_denied".into());
                }
                if write && !self.authority.writable(&path) {
                    return Err("workspace_write_permission_denied".into());
                }
                Ok(path)
            })
            .collect()
    }

    pub fn call(
        &self,
        caller: &Caller<'_>,
        operation: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        if !(self.active)() {
            return Err("host_operation_cancelled".into());
        }
        if arguments.get("root").is_some()
            && matches!(
                operation,
                "workspace.read" | "workspace.list" | "workspace.stat" | "workspace.transaction"
            )
        {
            return self.external(caller, operation, arguments);
        }
        let source = match operation {
            "workspace.transaction" | "workspace.restore" => Some("transaction"),
            "exec.run" if arguments["write"] == true => Some("exec"),
            _ => None,
        }
        .filter(|_| self.record_changes);
        let before = source.and_then(|_| crate::change_baseline(self.repository()));
        let result = self.dispatch(caller, operation, arguments);
        if let (Some(source), Some(before), Ok(_)) = (source, before, &result) {
            crate::record_workspace_change(self.repository(), source, before);
        }
        result
    }

    fn dispatch(
        &self,
        caller: &Caller<'_>,
        operation: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        match operation {
            "exec.run" => self.exec(caller, arguments),
            "exec.output_page" => self.output_page(caller, arguments),
            "workspace.read" => self.read(arguments),
            "workspace.list" => self.list(arguments),
            "workspace.stat" => self.stat(arguments),
            "workspace.check_access" => self.check_access(caller, arguments),
            "workspace.transaction" => self.transaction(caller, arguments),
            "workspace.backup" => self.backup(caller, arguments),
            "workspace.restore" => self.restore(caller, arguments),
            "environment.read" => environment(self.environment, caller, arguments),
            "environment.set" => self
                .environment
                .ok_or("environment_thread_required")?
                .set(caller, arguments),
            operation if operation.starts_with("store.") => {
                let key = repository_key(self.repository());
                DataStore {
                    root: self.data_root,
                    repository_key: &key,
                    owner: caller.id,
                    provenance: StoreProvenance {
                        r#mod: caller.id.to_owned(),
                        source_sha256: caller.source_sha256.to_owned(),
                        thread_id: caller.thread.map(str::to_owned),
                        origin: caller.origin,
                        at: 0,
                    },
                }
                .call(operation, arguments)
                .map_err(|error| error.to_string())
            }
            _ => Err(format!("unsupported_host_operation: {operation}")),
        }
    }

    fn exec(&self, caller: &Caller<'_>, arguments: Value) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Guard {
            program: String,
            #[serde(default)]
            sha256: Option<String>,
            #[serde(default)]
            argv: Vec<String>,
            #[serde(default)]
            cwd: Option<String>,
            #[serde(default)]
            env: BTreeMap<String, String>,
            stdout_sha256: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            program: String,
            #[serde(default)]
            sha256: Option<String>,
            #[serde(default)]
            argv: Vec<String>,
            #[serde(default)]
            cwd: Option<String>,
            #[serde(default)]
            env: BTreeMap<String, String>,
            #[serde(default)]
            stdin: Option<String>,
            #[serde(default)]
            timeout_ms: Option<u64>,
            #[serde(default)]
            max_output_bytes: Option<usize>,
            #[serde(default)]
            output_artifact: bool,
            #[serde(default)]
            write: bool,
            #[serde(default)]
            network: Option<String>,
            #[serde(default)]
            unix_sockets: Vec<String>,
            #[serde(default)]
            guards: Vec<Guard>,
            #[serde(default)]
            required_access: Option<RequiredAccess>,
            #[serde(default)]
            exclusive_workspace: Option<String>,
            #[serde(default)]
            sandbox: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct RequiredAccess {
            write: Vec<String>,
        }
        let mut input: Input =
            serde_json::from_value(arguments).map_err(|error| error.to_string())?;
        if !(self.active)() {
            return Err("exec_cancelled".into());
        }
        if input.guards.len() > 4
            || !input.guards.is_empty() && !input.write
            || input.guards.iter().any(|guard| {
                guard.stdout_sha256.len() != 64
                    || !guard
                        .stdout_sha256
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Err("exec_guards_invalid".into());
        }
        let granted = |capability: &str| caller.capabilities.iter().any(|cap| cap == capability);
        let loopback = match input.network.as_deref() {
            None | Some("none") => false,
            Some("loopback") if granted("network") => true,
            Some("loopback") => return Err("capability_denied: network".into()),
            Some(_) => return Err("exec_network_invalid".into()),
        };
        if input.write && !granted("fs.write") {
            return Err("capability_denied: fs.write".into());
        }
        if !input.unix_sockets.is_empty() && !granted("unix_sockets") {
            return Err("capability_denied: unix_sockets".into());
        }
        if input.required_access.is_some() && !input.write {
            return Err("exec_access_requires_write".into());
        }
        let unrestricted = match input.sandbox.as_deref() {
            None => None,
            Some("none") => Some(caller.os_access.ok_or("capability_denied: os")?),
            Some(_) => return Err("exec_sandbox_invalid".into()),
        };
        if unrestricted.is_some()
            && (input.network.is_some()
                || !input.unix_sockets.is_empty()
                || !input.guards.is_empty()
                || input.required_access.is_some())
        {
            return Err("exec_unrestricted_arguments_invalid: network comes from os_access; unix_sockets, guards and required_access need the sandbox".into());
        }
        if input.argv.len() > 128
            || input.argv.iter().map(String::len).sum::<usize>() > 8192
            || input.argv.iter().any(|arg| arg.contains('\0'))
            || input
                .stdin
                .as_ref()
                .is_some_and(|stdin| stdin.len() > 64 * 1024)
            || input.env.len() > 16
            || input.env.values().map(String::len).sum::<usize>() > 16 * 1024
            || input.env.values().any(|value| value.contains('\0'))
            || input
                .env
                .keys()
                .any(|name| !caller.exec_environment.contains(name))
            || input.unix_sockets.len() > 4
            || input
                .unix_sockets
                .iter()
                .any(|name| !caller.exec_environment.contains(name))
        {
            return Err("exec_arguments_invalid".into());
        }
        let overrides = self
            .environment
            .map(|state| {
                state.values(
                    caller.thread,
                    caller.id,
                    caller.source_sha256,
                    caller.exec_environment,
                )
            })
            .transpose()?
            .unwrap_or_default();
        for (name, value) in overrides {
            input.env.entry(name).or_insert(value);
        }
        let mut timeout = Duration::from_millis(
            input
                .timeout_ms
                .unwrap_or(EXEC_DEFAULT_TIMEOUT_MS)
                .clamp(1, EXEC_MAX_TIMEOUT_MS),
        );
        let limit = input
            .max_output_bytes
            .unwrap_or(if input.output_artifact {
                EXEC_ARTIFACT_BYTES
            } else {
                EXEC_OUTPUT_BYTES
            })
            .clamp(
                1,
                if input.output_artifact {
                    EXEC_ARTIFACT_BYTES
                } else {
                    EXEC_OUTPUT_BYTES
                },
            );
        let repository = self.repository().to_path_buf();
        let unix_sockets = input
            .unix_sockets
            .iter()
            .map(|name| inherited_socket(name, &repository).ok_or("exec_socket_unavailable"))
            .collect::<Result<Vec<_>, _>>()?;
        let program = match unrestricted {
            Some(access) => unrestricted_program(access, &input.program, &repository)?,
            None => {
                resolve_program(&input.program, &repository).ok_or("exec_program_unavailable")?
            }
        };
        let digest = program_hash(&program)?;
        if input
            .sha256
            .as_ref()
            .is_some_and(|expected| *expected != digest)
        {
            return Err("exec_program_changed".into());
        }
        let cwd = match (input.cwd.as_deref(), unrestricted) {
            (None | Some("") | Some("."), _) => repository.clone(),
            (Some(name), Some(_)) if Path::new(name).is_absolute() || relative(name) => repository
                .join(name)
                .canonicalize()
                .map_err(|_| "exec_cwd_unavailable")?,
            (Some(name), None) if relative(name) => {
                self.checked_paths(&[name.to_owned()], false)?.remove(0)
            }
            _ => return Err("exec_cwd_invalid".into()),
        };
        if !cwd.is_dir()
            || unrestricted.is_none()
                && (!self.authority.readable(&cwd) || input.write && !self.authority.writable(&cwd))
        {
            return Err("exec_cwd_unavailable".into());
        }
        let guarded_started = Instant::now();
        let _workspace_lease = if let Some(path) = input.exclusive_workspace {
            let path = Path::new(&path)
                .canonicalize()
                .map_err(|_| "workspace_ownership_unavailable")?;
            if !input.write || unrestricted.is_some() || !self.authority.writable(&path) {
                return Err("workspace_exclusive_access_denied".into());
            }
            Some(crate::workspace_lease::exclusive(&path).map_err(|error| error.to_string())?)
        } else {
            None
        };
        let guard_count = input.guards.len();
        for guard in input.guards {
            let remaining = timeout.saturating_sub(guarded_started.elapsed());
            if remaining.is_zero() {
                return Err("exec_guard_timeout".into());
            }
            let checked = self.exec(
                caller,
                json!({
                    "program": guard.program,
                    "sha256": guard.sha256,
                    "argv": guard.argv,
                    "cwd": guard.cwd,
                    "env": guard.env,
                    "timeout_ms": remaining.as_millis().min(10_000) as u64,
                    "max_output_bytes": EXEC_OUTPUT_BYTES,
                    "write": false,
                    "network": "none",
                }),
            )?;
            if checked["exit_code"] != 0
                || checked["timed_out"] != false
                || checked["signal"] != Value::Null
                || checked["stdout_truncated"] != false
                || checked["stderr_truncated"] != false
            {
                return Err("exec_guard_failed".into());
            }
            if checked["stdout_sha256"].as_str() != Some(guard.stdout_sha256.as_str()) {
                return Err("exec_guard_changed".into());
            }
        }
        if !(self.active)() {
            return Err("exec_cancelled".into());
        }
        if let Some(access) = &input.required_access {
            self.checked_paths(&access.write, true)?;
        }
        if guard_count > 0 && program_hash(&program)? != digest {
            return Err("exec_program_changed".into());
        }
        timeout = timeout.saturating_sub(guarded_started.elapsed());
        if timeout.is_zero() {
            return Err("exec_guard_timeout".into());
        }
        let _running = {
            let mut running = RUNNING.lock().map_err(|_| "exec_accounting_poisoned")?;
            let count = running.entry(caller.id.to_owned()).or_default();
            if *count >= EXEC_CONCURRENCY {
                return Err("exec_concurrency_limit".into());
            }
            *count += 1;
            Running(caller.id.to_owned())
        };
        let scratch = std::env::temp_dir().join(format!(
            "omd-exec-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_nanos()
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&scratch)
            .map_err(|error| error.to_string())?;
        let scratch = Scratch(scratch.canonicalize().map_err(|error| error.to_string())?);
        let mut command = match unrestricted {
            Some(access) => {
                let mut command = unrestricted_command(access, &program, caller.exec_environment)?;
                command.args(input.argv);
                command
            }
            None => {
                let mut argv = vec![program.to_string_lossy().into_owned()];
                argv.extend(input.argv);
                let mut command = self.authority.command(
                    argv,
                    &ExecAccess {
                        write: input.write,
                        loopback,
                        unix_sockets: &unix_sockets,
                        scratch: &scratch.0,
                    },
                )?;
                command
                    .env_clear()
                    .env("PATH", std::env::var_os("PATH").unwrap_or_default())
                    .env("HOME", &scratch.0);
                for name in ["LANG", "LC_ALL", "LC_CTYPE"]
                    .into_iter()
                    .chain(caller.exec_environment.iter().map(String::as_str))
                {
                    if let Some(value) = std::env::var_os(name) {
                        command.env(name, value);
                    }
                }
                command
            }
        };
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command
            .current_dir(&cwd)
            .env("TMPDIR", &scratch.0)
            .env("TERM", "dumb")
            .stdin(if input.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.envs(&input.env);
        let started = Instant::now();
        let mut child = Child(
            command
                .spawn()
                .map_err(|error| format!("exec_spawn_failed: {error}"))?,
        );
        if let (Some(bytes), Some(mut pipe)) = (input.stdin.as_ref(), child.0.stdin.take()) {
            let bytes = bytes.clone().into_bytes();
            std::thread::spawn(move || {
                let _ = pipe.write_all(&bytes);
            });
        }
        let bounded = |pipe: Option<Box<dyn Read + Send>>, bound: usize| {
            let output = Arc::new(Mutex::new((Vec::new(), false)));
            let shared = output.clone();
            let reader = std::thread::spawn(move || {
                if let Some(mut pipe) = pipe {
                    let mut chunk = [0_u8; 8192];
                    while let Ok(read) = pipe.read(&mut chunk) {
                        if read == 0 {
                            break;
                        }
                        let Ok(mut output) = shared.lock() else { break };
                        let room = bound.saturating_sub(output.0.len());
                        output.0.extend_from_slice(&chunk[..read.min(room)]);
                        output.1 |= read > room;
                    }
                }
            });
            (reader, output)
        };
        let stdout = bounded(
            child
                .0
                .stdout
                .take()
                .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
            limit,
        );
        let stderr = bounded(
            child
                .0
                .stderr
                .take()
                .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
            EXEC_OUTPUT_BYTES,
        );
        let mut timed_out = false;
        let status = loop {
            if let Some(status) = child.0.try_wait().map_err(|error| error.to_string())? {
                break Some(status);
            }
            if !(self.active)() {
                drop(child);
                return Err("exec_cancelled".into());
            }
            if started.elapsed() >= timeout {
                timed_out = true;
                if let Some(pid) = rustix::process::Pid::from_raw(child.0.id() as i32) {
                    let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
                }
                let _ = child.0.kill();
                let _ = child.0.wait();
                break None;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        if let Some(pid) = rustix::process::Pid::from_raw(child.0.id() as i32) {
            let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
        }
        while !(stdout.0.is_finished() && stderr.0.is_finished()) {
            if !(self.active)() {
                return Err("exec_cancelled".into());
            }
            if started.elapsed() >= timeout {
                timed_out = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let drained = |output: &Mutex<(Vec<u8>, bool)>| {
            output
                .lock()
                .map(|output| output.clone())
                .map_err(|_| "exec_output_failed")
        };
        let (stdout, stdout_truncated) = drained(&stdout.1)?;
        let (stderr, stderr_truncated) = drained(&stderr.1)?;
        if input.output_artifact && stdout_truncated {
            return Err("exec_output_artifact_limit".into());
        }
        let output_artifact = if input.output_artifact {
            Some(self.save_output(caller, &stdout)?)
        } else {
            None
        };
        let visible_stdout = &stdout[..stdout.len().min(if input.output_artifact {
            4096
        } else {
            EXEC_INLINE_STDOUT_BYTES
        })];
        let visible_stderr = &stderr[..stderr.len().min(EXEC_INLINE_STDERR_BYTES)];
        let signal = status.and_then(|status| {
            use std::os::unix::process::ExitStatusExt;
            status.signal().map(|signal| signal.to_string())
        });
        Ok(json!({
            "exit_code": status.and_then(|status| status.code()),
            "signal": signal,
            "stdout": String::from_utf8_lossy(visible_stdout),
            "stdout_sha256": sha256(&stdout),
            "stdout_bytes": stdout.len(),
            "output_artifact": output_artifact,
            "stderr": String::from_utf8_lossy(visible_stderr),
            "stdout_truncated": stdout_truncated,
            "stdout_preview_truncated": stdout.len() > visible_stdout.len(),
            "stderr_truncated": stderr_truncated,
            "stderr_preview_truncated": stderr.len() > visible_stderr.len(),
            "timed_out": timed_out,
            "duration_ms": started.elapsed().as_millis() as u64,
            "program": {"path": program, "sha256": digest},
            "guards_verified": guard_count,
        }))
    }

    fn read(&self, arguments: Value) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            paths: Vec<String>,
        }
        let input: Input = serde_json::from_value(arguments).map_err(|error| error.to_string())?;
        self.checked_paths(&input.paths, false)?;
        let selected = input.paths.into_iter().collect::<BTreeSet<_>>();
        let snapshot = crate::Snapshot::capture(self.repository(), &selected, 4 * 1024 * 1024)
            .map_err(|error| error.to_string())?;
        let mut files = serde_json::Map::new();
        for name in selected {
            let value = match snapshot.files.get(&name) {
                Some(file) => json!({
                    "text": String::from_utf8(file.bytes.clone()).map_err(|_| "workspace_text_not_utf8")?,
                    "sha256": sha256(&file.bytes),
                }),
                None => Value::Null,
            };
            files.insert(name, value);
        }
        Ok(json!({"files": files}))
    }

    fn file_stat(path: &Path, hash: Option<(&Path, &str)>) -> Result<Value, String> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
            Err(error) => return Err(error.to_string()),
        };
        let kind = if metadata.file_type().is_symlink() {
            "symlink"
        } else if metadata.is_dir() {
            "dir"
        } else if metadata.is_file() {
            "file"
        } else {
            return Ok(Value::Null);
        };
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |elapsed| elapsed.as_millis() as u64);
        let mut value = json!({"kind": kind, "size": metadata.len(), "mtime_ms": mtime_ms});
        if let Some((root, name)) =
            hash.filter(|_| kind == "file" && metadata.len() <= 64 * 1024 * 1024)
        {
            let mut file =
                crate::workspace::open_contained(root, name).map_err(|error| error.to_string())?;
            if !file
                .metadata()
                .map_err(|error| error.to_string())?
                .is_file()
            {
                return Err("workspace_not_regular_file".into());
            }
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            value["sha256"] = json!(sha256(&bytes));
        }
        Ok(value)
    }

    fn stat(&self, arguments: Value) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            paths: Vec<String>,
            #[serde(default)]
            hash: bool,
        }
        let input: Input = serde_json::from_value(arguments).map_err(|error| error.to_string())?;
        let paths = self.checked_paths(&input.paths, false)?;
        let mut files = serde_json::Map::new();
        for (name, path) in input.paths.iter().zip(paths) {
            files.insert(
                name.clone(),
                Self::file_stat(
                    &path,
                    input.hash.then_some((self.repository(), name.as_str())),
                )?,
            );
        }
        Ok(json!({"files": files}))
    }

    fn check_access(&self, caller: &Caller<'_>, arguments: Value) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            paths: Vec<String>,
            #[serde(default)]
            write: bool,
        }
        let input: Input = serde_json::from_value(arguments).map_err(|error| error.to_string())?;
        if input.write
            && !caller
                .capabilities
                .iter()
                .any(|capability| capability == "fs.write")
        {
            return Err("capability_denied: fs.write".into());
        }
        self.checked_paths(&input.paths, input.write)?;
        Ok(json!({"paths": input.paths, "write": input.write}))
    }

    fn list(&self, arguments: Value) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            #[serde(default)]
            path: Option<String>,
            #[serde(default)]
            recursive: bool,
            #[serde(default)]
            include_ignored: bool,
            #[serde(default)]
            max_entries: Option<usize>,
        }
        let input: Input = serde_json::from_value(arguments).map_err(|error| error.to_string())?;
        let limit = input.max_entries.unwrap_or(LIST_LIMIT).clamp(1, LIST_LIMIT);
        let repository = self.repository().to_path_buf();
        let base = match input.path.as_deref() {
            None | Some("") | Some(".") => repository.clone(),
            Some(name) if relative(name) => {
                self.checked_paths(&[name.to_owned()], false)?.remove(0)
            }
            Some(_) => return Err("workspace_path_scope_invalid".into()),
        };
        if !base.is_dir() {
            return Err("workspace_list_requires_directory".into());
        }
        let walker = ignore::WalkBuilder::new(&base)
            .hidden(false)
            .git_ignore(!input.include_ignored)
            .git_global(false)
            .git_exclude(!input.include_ignored)
            .ignore(!input.include_ignored)
            .parents(!input.include_ignored)
            .require_git(false)
            .follow_links(false)
            .max_depth((!input.recursive).then_some(1))
            .filter_entry(|entry| {
                !(entry.depth() > 0
                    && entry.file_type().is_some_and(|kind| kind.is_dir())
                    && LIST_EXCLUDED.contains(&entry.file_name().to_string_lossy().as_ref()))
            })
            .build();
        let mut entries = Vec::new();
        let mut truncated = false;
        for entry in walker {
            if !(self.active)() {
                return Err("host_operation_cancelled".into());
            }
            let Ok(entry) = entry else { continue };
            if entry.depth() == 0 {
                continue;
            }
            let path = entry.path();
            let Some(name) = path
                .strip_prefix(&repository)
                .ok()
                .and_then(Path::to_str)
                .filter(|name| relative(name))
            else {
                continue;
            };
            if !self.authority.readable(path) {
                continue;
            }
            if entries.len() == limit {
                truncated = true;
                break;
            }
            let mut value = Self::file_stat(path, None)?;
            if value.is_null() {
                continue;
            }
            value["path"] = json!(name);
            entries.push(value);
        }
        entries.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
        Ok(json!({"entries": entries, "truncated": truncated}))
    }

    fn backup_directory(&self, caller: &Caller<'_>) -> Result<PathBuf, String> {
        if !crate::resource_data::token(caller.id)
            || self.data_root.canonicalize().ok().as_deref() != Some(self.data_root)
        {
            return Err("backup_root_invalid".into());
        }
        crate::workspace::private_path(
            self.data_root,
            &["backups", &repository_key(self.repository()), caller.id],
            "backup_directory_invalid",
        )
        .map_err(|error| error.to_string())
    }

    fn save_backup(
        &self,
        caller: &Caller<'_>,
        files: &BTreeMap<String, Option<Vec<u8>>>,
    ) -> std::io::Result<Value> {
        let directory = self
            .backup_directory(caller)
            .map_err(std::io::Error::other)?;
        let record = json!({
            "schema": 1,
            "owner": caller.id,
            "repository": repository_key(self.repository()),
            "created_ms": crate::peers::now_ms(),
            "files": files.iter().map(|(name, bytes)| (name.clone(), bytes.as_ref().map_or(Value::Null, |bytes| json!(hex(bytes))))).collect::<serde_json::Map<_, _>>(),
        });
        let bytes = serde_json::to_vec(&record)?;
        let digest = sha256(&bytes);
        let mut count = 0;
        let mut total = 0;
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            count += 1;
            total += entry.metadata()?.len();
        }
        if count >= BACKUP_LIMIT || total + bytes.len() as u64 > BACKUP_BYTES {
            return Err(std::io::Error::other("backup_quota"));
        }
        let path = directory.join(format!("{digest}.json"));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(&bytes)?;
                file.sync_all()?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error),
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        Ok(json!({"reference": digest, "sha256": digest}))
    }

    fn transaction(&self, caller: &Caller<'_>, arguments: Value) -> Result<Value, String> {
        let transaction: WorkspaceTransaction =
            serde_json::from_value(arguments).map_err(|error| error.to_string())?;
        self.checked_paths(
            &transaction.expected.keys().cloned().collect::<Vec<_>>(),
            true,
        )?;
        let sink = |files: &BTreeMap<String, Option<Vec<u8>>>| self.save_backup(caller, files);
        let result = transaction
            .apply_with_backup(self.repository(), || (self.active)(), Some(&sink))
            .map_err(|error| error.to_string())?;
        Ok(json!({"files": result.files, "backup": result.backup}))
    }

    fn backup(&self, caller: &Caller<'_>, arguments: Value) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            expected: BTreeMap<String, Option<Fingerprint>>,
        }
        let input: Input = serde_json::from_value(arguments).map_err(|error| error.to_string())?;
        let names = input.expected.keys().cloned().collect::<Vec<_>>();
        self.checked_paths(&names, false)?;
        let selected = names.iter().cloned().collect::<BTreeSet<_>>();
        let snapshot = crate::Snapshot::capture(self.repository(), &selected, 4 * 1024 * 1024)
            .map_err(|error| error.to_string())?;
        let mut files = BTreeMap::new();
        for (name, expected) in &input.expected {
            let current = snapshot.files.get(name).map(|file| file.bytes.clone());
            let stat = Self::file_stat(
                &crate::workspace_path(self.repository(), name)
                    .map_err(|error| error.to_string())?,
                None,
            )?;
            let matches = match (expected, &current) {
                (None, None) => true,
                (Some(Fingerprint::Hash(hash)), Some(bytes)) => *hash == sha256(bytes),
                (Some(Fingerprint::Stat { size, mtime_ms }), Some(_)) => {
                    stat["size"] == json!(size) && stat["mtime_ms"] == json!(mtime_ms)
                }
                _ => false,
            };
            if !matches {
                return Err(format!("stale expected version for {name}"));
            }
            files.insert(name.clone(), current);
        }
        let backup = self
            .save_backup(caller, &files)
            .map_err(|error| error.to_string())?;
        Ok(json!({"backup": backup}))
    }

    fn restore(&self, caller: &Caller<'_>, arguments: Value) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            backup: crate::resource_data::ResourceRef,
            expected: BTreeMap<String, Option<Fingerprint>>,
        }
        let input: Input = serde_json::from_value(arguments).map_err(|error| error.to_string())?;
        if input.backup.reference != input.backup.sha256
            || input.backup.sha256.len() != 64
            || !input
                .backup
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("backup_reference_invalid".into());
        }
        let path = self
            .backup_directory(caller)?
            .join(format!("{}.json", input.backup.sha256));
        let bytes = fs::read(&path).map_err(|_| "backup_unavailable")?;
        if sha256(&bytes) != input.backup.sha256 {
            return Err("backup_integrity_failed".into());
        }
        let record: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if record["owner"] != caller.id || record["repository"] != repository_key(self.repository())
        {
            return Err("backup_scope_mismatch".into());
        }
        let files = record["files"].as_object().ok_or("backup_record_invalid")?;
        if files.keys().collect::<BTreeSet<_>>() != input.expected.keys().collect::<BTreeSet<_>>() {
            return Err("restore_expected_must_cover_backup".into());
        }
        let mut transaction = WorkspaceTransaction {
            expected: input.expected.clone(),
            ..Default::default()
        };
        for (name, content) in files {
            match content.as_str() {
                Some(text) => {
                    transaction.byte_writes.insert(name.clone(), unhex(text)?);
                }
                None if input.expected.get(name).is_some_and(Option::is_some) => {
                    transaction.deletes.push(name.clone());
                }
                None => {
                    transaction.expected.remove(name);
                }
            }
        }
        if transaction.expected.is_empty() {
            return Ok(json!({"files": {}}));
        }
        self.checked_paths(
            &transaction.expected.keys().cloned().collect::<Vec<_>>(),
            true,
        )?;
        let result = transaction
            .apply(self.repository(), || (self.active)())
            .map_err(|error| error.to_string())?;
        Ok(json!({"files": result.files}))
    }
}

#[cfg(test)]
mod installation_tests {
    use super::*;

    #[test]
    fn singleton_rejects_replacement_and_stale_teardown() {
        let dispatcher = || {
            Arc::new(
                |_: &str,
                 _: &str,
                 _: Option<&str>,
                 _: Option<&Value>,
                 _: crate::ModHostCall,
                 _: &dyn Fn() -> bool| Ok(Value::Null),
            ) as SessionDispatcher
        };
        let pending = reserve_session_dispatcher().unwrap();
        assert!(install_session_dispatcher(dispatcher()).is_err());
        drop(pending);
        let first = install_session_dispatcher(dispatcher()).unwrap();
        assert!(
            matches!(install_session_dispatcher(dispatcher()), Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists)
        );
        let stale = SessionRegistration(first.0.clone());
        drop(first);
        let second = install_session_dispatcher(dispatcher()).unwrap();
        assert!(stale.install(dispatcher()).is_err());
        drop(stale);
        assert!(install_session_dispatcher(dispatcher()).is_err());
        drop(second);
        assert!(install_session_dispatcher(dispatcher()).is_ok());
    }
}
