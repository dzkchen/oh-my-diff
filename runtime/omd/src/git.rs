use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::io::Read;
use std::io::Write;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

pub const OPERATIONS: &[&str] = &[
    "git.status",
    "git.log",
    "git.diff",
    "git.branches",
    "git.stage",
    "git.unstage",
    "git.commit",
    "git.discard",
    "git.switch",
];

const TIMEOUT: Duration = Duration::from_secs(10);
const COMMIT_TIMEOUT: Duration = Duration::from_secs(120);
const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
const ENTRY_LIMIT: usize = 500;
const LOG_LIMIT: u64 = 50;
const DIFF_LIMIT: usize = 65_536;
const PATH_LIMIT: usize = 64;
const BRANCH_LIMIT: usize = 100;
const MESSAGE_LIMIT: usize = 4096;

pub fn is_read(operation: &str) -> bool {
    matches!(
        operation,
        "git.status" | "git.log" | "git.diff" | "git.branches"
    )
}

pub struct GitAccess<'a> {
    pub repository: &'a Path,
    pub protected: &'a [PathBuf],
    pub backups: Option<&'a Path>,
    pub write: Result<(), &'static str>,
    pub command: Option<&'a GitCommand>,
    pub writable: &'a dyn Fn(&Path) -> bool,
}

pub type GitCommand = dyn Fn(Vec<String>) -> Result<Command, String>;

struct Repository<'a> {
    path: PathBuf,
    command: Option<&'a GitCommand>,
}

impl std::ops::Deref for Repository<'_> {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.path
    }
}

struct GitChild(std::process::Child);

impl Drop for GitChild {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = rustix::process::Pid::from_raw(self.0.id() as i32) {
            let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Output {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
    truncated: bool,
}

#[derive(Clone)]
struct Entry {
    path: String,
    orig_path: Option<String>,
    index: char,
    worktree: char,
    conflicted: bool,
    record: String,
}

impl Entry {
    fn untracked(&self) -> bool {
        self.index == '?'
    }

    fn staged(&self) -> bool {
        !self.untracked() && (self.conflicted || self.index != ' ')
    }
}

struct Head {
    oid: Option<String>,
    branch: Option<String>,
    upstream: Option<String>,
    ahead: i64,
    behind: i64,
}

struct Status {
    head: Head,
    entries: Vec<Entry>,
    complete: bool,
}

pub fn call(
    access: &GitAccess<'_>,
    operation: &str,
    arguments: Value,
    active: &dyn Fn() -> bool,
) -> Result<Value, String> {
    if !OPERATIONS.contains(&operation) {
        return Err(format!("unsupported_host_operation: {operation}"));
    }
    if !is_read(operation) {
        access.write?;
    }
    let mut root = Repository {
        path: access.repository.to_path_buf(),
        command: access.command,
    };
    root.path = toplevel(&root, active)?;
    if !is_read(operation) {
        if canonical(&root) != canonical(access.repository) {
            return Err("git_write_requires_repository_root".to_owned());
        }
        writable(access, &root)?;
        let metadata = checked(
            read(
                &root,
                &[
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-dir",
                    "--git-common-dir",
                ],
                active,
            )?,
            "rev-parse",
        )?;
        let metadata = String::from_utf8(metadata.stdout).map_err(|_| "invalid_git_metadata")?;
        for path in metadata.lines() {
            writable(access, Path::new(path))?;
        }
    }
    match operation {
        "git.status" => status(access, &root, &arguments, active),
        "git.log" => log(&root, &arguments, active),
        "git.diff" => diff(access, &root, &arguments, active),
        "git.branches" => branches(&root, active),
        "git.stage" | "git.unstage" => index_update(access, &root, operation, &arguments, active),
        "git.commit" => commit(access, &root, &arguments, active),
        "git.discard" => discard(access, &root, &arguments, active),
        "git.switch" => switch(access, &root, &arguments, active),
        _ => Err(format!("unsupported_host_operation: {operation}")),
    }
}

fn run(
    root: &Repository<'_>,
    args: &[&str],
    stdin: Option<&[u8]>,
    read_only: bool,
    timeout: Duration,
    active: &dyn Fn() -> bool,
) -> Result<Output, String> {
    if !active() {
        return Err("callback_cancelled".to_owned());
    }
    let mut argv = vec![
        "git".to_owned(),
        "-C".to_owned(),
        root.to_string_lossy().into_owned(),
    ];
    argv.extend(
        [
            "--no-pager",
            "--literal-pathspecs",
            "-c",
            "core.quotepath=off",
            "-c",
            "color.ui=false",
            "-c",
            "core.fsmonitor=false",
        ]
        .map(str::to_owned),
    );
    argv.extend(args.iter().map(|arg| (*arg).to_owned()));
    let mut command = match root.command {
        Some(build) => build(argv)?,
        None => {
            let mut command = Command::new(&argv[0]);
            command.args(&argv[1..]);
            command
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    for key in [
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_CONFIG",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
    ] {
        command.env_remove(key);
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_PAGER", "cat")
        .env("LC_ALL", "C")
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if read_only {
        command.env("GIT_OPTIONAL_LOCKS", "0");
    }
    let mut child = GitChild(
        command
            .spawn()
            .map_err(|error| format!("git_unavailable: {error}"))?,
    );
    if let (Some(bytes), Some(mut pipe)) = (stdin, child.0.stdin.take()) {
        pipe.write_all(bytes)
            .map_err(|error| format!("git_io: {error}"))?;
    }
    let bounded = |pipe: Option<Box<dyn Read + Send>>, limit: usize| {
        std::thread::spawn(move || {
            let mut kept = Vec::new();
            let mut truncated = false;
            if let Some(mut pipe) = pipe {
                let mut chunk = [0_u8; 8192];
                while let Ok(read) = pipe.read(&mut chunk) {
                    if read == 0 {
                        break;
                    }
                    let room = limit.saturating_sub(kept.len());
                    kept.extend_from_slice(&chunk[..read.min(room)]);
                    truncated |= read > room;
                }
            }
            (kept, truncated)
        })
    };
    let stdout = bounded(
        child
            .0
            .stdout
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
        OUTPUT_LIMIT,
    );
    let stderr = bounded(
        child
            .0
            .stderr
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
        4096,
    );
    let started = Instant::now();
    let code = loop {
        if !active() {
            break Err("callback_cancelled".to_owned());
        }
        if started.elapsed() > timeout {
            break Err("git_timeout".to_owned());
        }
        match child.0.try_wait() {
            Ok(Some(status)) => break Ok(status.code()),
            Ok(None) => (),
            Err(error) => break Err(format!("git_io: {error}")),
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    drop(child);
    let (stdout, truncated) = stdout.join().map_err(|_| "git_io")?;
    let (stderr, _) = stderr.join().map_err(|_| "git_io")?;
    Ok(Output {
        code: code?,
        stdout,
        stderr: String::from_utf8_lossy(&stderr)
            .chars()
            .filter(|c| !c.is_control() || *c == '\n')
            .take(512)
            .collect::<String>()
            .trim()
            .to_owned(),
        truncated,
    })
}

fn checked(output: Output, operation: &str) -> Result<Output, String> {
    if output.code == Some(0) {
        Ok(output)
    } else {
        let detail = output.stderr.lines().next().unwrap_or("").to_owned();
        Err(format!("git_failed: {operation}: {detail}"))
    }
}

fn read(root: &Repository<'_>, args: &[&str], active: &dyn Fn() -> bool) -> Result<Output, String> {
    run(root, args, None, true, TIMEOUT, active)
}

fn toplevel(repository: &Repository<'_>, active: &dyn Fn() -> bool) -> Result<PathBuf, String> {
    let output = read(repository, &["rev-parse", "--show-toplevel"], active)?;
    if output.code != Some(0) {
        return Err("not_a_git_repository".to_owned());
    }
    let text = String::from_utf8(output.stdout).map_err(|_| "not_a_git_repository")?;
    let root = PathBuf::from(text.trim_end_matches('\n'));
    if !root.is_absolute() {
        return Err("not_a_git_repository".to_owned());
    }
    Ok(root)
}

fn relative(root: &Path, access: &GitAccess<'_>, value: &Value) -> Result<String, String> {
    let text = value.as_str().ok_or("invalid_git_path")?;
    let path = text.strip_suffix('/').unwrap_or(text);
    let valid = !path.is_empty()
        && path.len() <= 4096
        && !path.chars().any(char::is_control)
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(part) if part != ".git"));
    if !valid {
        return Err(format!("invalid_git_path: {text}"));
    }
    let absolute = root.join(path);
    let resolved = canonical(&absolute);
    if !resolved.starts_with(canonical(root)) {
        return Err(format!("invalid_git_path: {path}"));
    }
    let protected = access.protected.iter().any(|protected| {
        let protected = canonical(protected);
        absolute.starts_with(&protected)
            || protected.starts_with(&absolute)
            || resolved.starts_with(&protected)
            || protected.starts_with(&resolved)
    });
    if protected {
        return Err(format!("protected_git_path: {path}"));
    }
    Ok(path.to_owned())
}

fn canonical(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut rest = Vec::new();
    while let Some(parent) = existing.parent() {
        if let Ok(resolved) = existing.canonicalize() {
            return rest
                .into_iter()
                .rev()
                .fold(resolved, |path, part| path.join(part));
        }
        rest.extend(existing.file_name());
        existing = parent;
    }
    path.to_path_buf()
}

fn paths(
    root: &Path,
    access: &GitAccess<'_>,
    value: Option<&Value>,
) -> Result<Vec<String>, String> {
    let items = value.and_then(Value::as_array).ok_or("invalid_git_paths")?;
    if items.is_empty() || items.len() > PATH_LIMIT {
        return Err("git_path_limit".to_owned());
    }
    let paths = items
        .iter()
        .map(|item| relative(root, access, item))
        .collect::<Result<Vec<_>, _>>()?;
    if paths.iter().collect::<BTreeSet<_>>().len() != paths.len() {
        return Err("duplicate_git_path".to_owned());
    }
    Ok(paths)
}

fn writable(access: &GitAccess<'_>, path: &Path) -> Result<(), String> {
    if !(access.writable)(path) || !(access.writable)(&canonical(path)) {
        return Err(format!(
            "git_write_denied_by_permissions: {}",
            path.display()
        ));
    }
    Ok(())
}

fn write_paths(access: &GitAccess<'_>, root: &Path, paths: &[String]) -> Result<(), String> {
    for path in paths {
        let path = relative(root, access, &Value::String(path.clone()))?;
        writable(access, &root.join(path))?;
    }
    Ok(())
}

fn listed_paths(output: Output) -> Result<Vec<String>, String> {
    if output.truncated {
        return Err("git_write_scope_incomplete".to_owned());
    }
    let text = String::from_utf8(output.stdout).map_err(|_| "invalid_git_path")?;
    Ok(text
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect())
}

fn index_paths(
    access: &GitAccess<'_>,
    root: &Repository<'_>,
    paths: &[String],
    active: &dyn Fn() -> bool,
) -> Result<(), String> {
    write_paths(access, root, paths)?;
    let mut args = vec![
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
    ];
    args.extend(paths.iter().map(String::as_str));
    let selected = listed_paths(checked(read(root, &args, active)?, "ls-files")?)?;
    write_paths(access, root, &selected)
}

fn read_status(
    root: &Repository<'_>,
    pathspec: &[String],
    active: &dyn Fn() -> bool,
) -> Result<Status, String> {
    let mut args = vec![
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=dirty",
    ];
    if !pathspec.is_empty() {
        args.push("--");
        args.extend(pathspec.iter().map(String::as_str));
    }
    let output = checked(read(root, &args, active)?, "status")?;
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut fields = text.split('\0').filter(|field| !field.is_empty());
    let mut head = Head {
        oid: None,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
    };
    let mut entries = Vec::new();
    while let Some(field) = fields.next() {
        if let Some(header) = field.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" if value != "(initial)" => head.oid = Some(value.to_owned()),
                "branch.head" if value != "(detached)" => head.branch = Some(value.to_owned()),
                "branch.upstream" => head.upstream = Some(value.to_owned()),
                "branch.ab" => {
                    for part in value.split(' ') {
                        if let Some(ahead) = part.strip_prefix('+') {
                            head.ahead = ahead.parse().unwrap_or(0);
                        } else if let Some(behind) = part.strip_prefix('-') {
                            head.behind = behind.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let kind = field.chars().next().unwrap_or(' ');
        let parts = |count: usize| field.splitn(count, ' ').collect::<Vec<_>>();
        let entry = match kind {
            '1' => {
                let parts = parts(9);
                (parts.len() == 9).then(|| (parts[1], parts[8].to_owned(), None, false))
            }
            '2' => {
                let parts = parts(10);
                let orig = fields.next().map(str::to_owned);
                (parts.len() == 10).then(|| (parts[1], parts[9].to_owned(), orig, false))
            }
            'u' => {
                let parts = parts(11);
                (parts.len() == 11).then(|| (parts[1], parts[10].to_owned(), None, true))
            }
            '?' => Some(("??", field[2..].to_owned(), None, false)),
            _ => None,
        };
        let Some((xy, path, orig_path, conflicted)) = entry else {
            continue;
        };
        let mut xy = xy.chars().map(|c| if c == '.' { ' ' } else { c });
        entries.push(Entry {
            index: xy.next().unwrap_or(' '),
            worktree: xy.next().unwrap_or(' '),
            path,
            orig_path,
            conflicted,
            record: field.to_owned(),
        });
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(Status {
        head,
        entries,
        complete: !output.truncated,
    })
}

fn worktree_marker(root: &Path, path: &str) -> String {
    match std::fs::symlink_metadata(root.join(path)) {
        Ok(metadata) => {
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |time| time.as_nanos());
            format!("{}:{modified}", metadata.len())
        }
        Err(_) => "missing".to_owned(),
    }
}

fn fingerprint<'a>(
    root: &Path,
    head: &Head,
    branch: bool,
    entries: impl IntoIterator<Item = &'a Entry>,
    clean: &[String],
) -> String {
    let mut hash = Sha256::new();
    hash.update(b"omd-git-fingerprint-v1\0");
    hash.update(head.oid.as_deref().unwrap_or("(initial)"));
    hash.update(b"\0");
    if branch {
        hash.update(head.branch.as_deref().unwrap_or("(detached)"));
        hash.update(b"\0");
    }
    for entry in entries {
        hash.update(&entry.record);
        hash.update(b"\0");
        hash.update(worktree_marker(root, &entry.path));
        hash.update(b"\0");
    }
    for path in clean {
        hash.update(path);
        hash.update(b"\0clean\0");
    }
    format!("{:x}", hash.finalize())
}

fn scoped(root: &Path, status: &Status, paths: &[String]) -> String {
    let wanted = paths.iter().collect::<BTreeSet<_>>();
    let covered = |entry: &&Entry| {
        wanted.contains(&entry.path)
            || wanted
                .iter()
                .any(|path| entry.path.starts_with(&format!("{path}/")))
    };
    let clean = paths
        .iter()
        .filter(|path| {
            !status
                .entries
                .iter()
                .any(|entry| entry.path == **path || entry.path.starts_with(&format!("{path}/")))
        })
        .cloned()
        .collect::<Vec<_>>();
    fingerprint(
        root,
        &status.head,
        false,
        status.entries.iter().filter(covered),
        &clean,
    )
}

fn staged_fingerprint(root: &Path, status: &Status) -> String {
    fingerprint(
        root,
        &status.head,
        false,
        status.entries.iter().filter(|entry| entry.staged()),
        &[],
    )
}

fn whole_fingerprint(root: &Path, status: &Status) -> Option<String> {
    status
        .complete
        .then(|| fingerprint(root, &status.head, true, &status.entries, &[]))
}

fn head_json(head: &Head) -> Value {
    json!({"oid": head.oid, "branch": head.branch, "detached": head.branch.is_none() && head.oid.is_some(),
        "upstream": head.upstream, "ahead": head.ahead, "behind": head.behind})
}

fn status(
    access: &GitAccess<'_>,
    root: &Repository<'_>,
    arguments: &Value,
    active: &dyn Fn() -> bool,
) -> Result<Value, String> {
    let scope = match arguments.get("paths") {
        None | Some(Value::Null) => Vec::new(),
        Some(value) => paths(root, access, Some(value))?,
    };
    let status = read_status(root, &scope, active)?;
    let entries = status
        .entries
        .iter()
        .take(ENTRY_LIMIT)
        .map(|entry| {
            json!({"path": entry.path, "orig_path": entry.orig_path, "index": entry.index.to_string(),
                "worktree": entry.worktree.to_string(), "conflicted": entry.conflicted,
                "fingerprint": scoped(root, &status, std::slice::from_ref(&entry.path))})
        })
        .collect::<Vec<_>>();
    let fingerprint = if scope.is_empty() {
        whole_fingerprint(root, &status).map_or(Value::Null, Value::from)
    } else {
        Value::from(scoped(root, &status, &scope))
    };
    Ok(json!({"head": head_json(&status.head), "entries": entries,
        "truncated": status.entries.len() > ENTRY_LIMIT || !status.complete,
        "fingerprint": fingerprint, "staged_fingerprint": staged_fingerprint(root, &status)}))
}

fn log(
    root: &Repository<'_>,
    arguments: &Value,
    active: &dyn Fn() -> bool,
) -> Result<Value, String> {
    let limit = match arguments.get("limit") {
        None | Some(Value::Null) => 20,
        Some(value) => value
            .as_u64()
            .filter(|limit| (1..=LOG_LIMIT).contains(limit))
            .ok_or("git_log_limit")?,
    };
    let count = format!("--max-count={}", limit + 1);
    let output = read(
        root,
        &[
            "log",
            &count,
            "--topo-order",
            "--no-show-signature",
            "--format=%H%x1f%P%x1f%D%x1f%s%x1e",
        ],
        active,
    )?;
    if output.code != Some(0) {
        if read(root, &["rev-parse", "--verify", "--quiet", "HEAD"], active)?.code != Some(0) {
            return Ok(json!({"commits": [], "truncated": false}));
        }
        return checked(output, "log").map(|_| Value::Null);
    }
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let records = text
        .split('\u{1e}')
        .map(|record| record.trim_start_matches('\n'))
        .filter(|record| !record.is_empty())
        .collect::<Vec<_>>();
    let commits = records
        .iter()
        .take(limit as usize)
        .filter_map(|record| {
            let mut fields = record.splitn(4, '\u{1f}');
            let oid = fields.next()?;
            let parents = fields
                .next()?
                .split(' ')
                .filter(|parent| !parent.is_empty())
                .collect::<Vec<_>>();
            let refs = fields.next()?.chars().take(200).collect::<String>();
            let subject = fields
                .next()?
                .chars()
                .filter(|c| !c.is_control())
                .take(120)
                .collect::<String>();
            Some(json!({"oid": oid, "parents": parents, "refs": refs, "subject": subject}))
        })
        .collect::<Vec<_>>();
    Ok(json!({"commits": commits, "truncated": records.len() > limit as usize}))
}

fn diff(
    access: &GitAccess<'_>,
    root: &Repository<'_>,
    arguments: &Value,
    active: &dyn Fn() -> bool,
) -> Result<Value, String> {
    let path = relative(root, access, arguments.get("path").unwrap_or(&Value::Null))?;
    let staged = match arguments.get("staged") {
        None | Some(Value::Null) => false,
        Some(value) => value.as_bool().ok_or("invalid_git_staged")?,
    };
    let scope = std::slice::from_ref(&path);
    for _ in 0..2 {
        let before = read_status(root, scope, active)?;
        let untracked = before
            .entries
            .iter()
            .any(|entry| entry.path == path && entry.untracked());
        let output = if untracked && !staged {
            let output = read(
                root,
                &[
                    "diff",
                    "--no-index",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--",
                    "/dev/null",
                    &path,
                ],
                active,
            )?;
            if matches!(output.code, Some(0 | 1)) {
                output
            } else {
                checked(output, "diff")?
            }
        } else {
            let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
            if staged {
                args.push("--cached");
            }
            args.extend(["--", path.as_str()]);
            checked(read(root, &args, active)?, "diff")?
        };
        let after = read_status(root, scope, active)?;
        let fingerprint = scoped(root, &after, scope);
        if scoped(root, &before, scope) != fingerprint {
            continue;
        }
        let truncated = output.truncated || output.stdout.len() > DIFF_LIMIT;
        let text = String::from_utf8_lossy(&output.stdout[..output.stdout.len().min(DIFF_LIMIT)])
            .into_owned();
        let binary = text
            .lines()
            .any(|line| line.starts_with("Binary files ") && line.ends_with(" differ"));
        return Ok(
            json!({"text": text, "binary": binary, "truncated": truncated, "fingerprint": fingerprint}),
        );
    }
    Err("stale_git_state: the file changed while reading its diff".to_owned())
}

fn branches(root: &Repository<'_>, active: &dyn Fn() -> bool) -> Result<Value, String> {
    let count = format!("--count={}", BRANCH_LIMIT + 1);
    let output = checked(
        read(
            root,
            &[
                "for-each-ref",
                &count,
                "--format=%(refname:short)",
                "refs/heads",
            ],
            active,
        )?,
        "for-each-ref",
    )?;
    let local = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let current = read(
        root,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        active,
    )?;
    let current = (current.code == Some(0))
        .then(|| String::from_utf8_lossy(&current.stdout).trim().to_owned());
    Ok(
        json!({"current": current, "local": local.iter().take(BRANCH_LIMIT).collect::<Vec<_>>(),
        "truncated": local.len() > BRANCH_LIMIT}),
    )
}

fn expected(arguments: &Value) -> Result<&str, String> {
    arguments
        .get("fingerprint")
        .and_then(Value::as_str)
        .filter(|value| value.len() == 64)
        .ok_or_else(|| "invalid_git_fingerprint".to_owned())
}

fn fresh(expected: &str, actual: Option<String>) -> Result<(), String> {
    if actual.as_deref() == Some(expected) {
        Ok(())
    } else {
        Err("stale_git_state: refresh and review the change again".to_owned())
    }
}

fn index_update(
    access: &GitAccess<'_>,
    root: &Repository<'_>,
    operation: &str,
    arguments: &Value,
    active: &dyn Fn() -> bool,
) -> Result<Value, String> {
    let paths = paths(root, access, arguments.get("paths"))?;
    let expected = expected(arguments)?;
    let before = read_status(root, &paths, active)?;
    if !before.complete {
        return Err("git_write_scope_incomplete".to_owned());
    }
    index_paths(access, root, &paths, active)?;
    fresh(expected, Some(scoped(root, &before, &paths)))?;
    let mut args = match operation {
        "git.stage" => vec!["add", "--"],
        _ if before.head.oid.is_none() => vec!["rm", "--cached", "--quiet", "-r", "--"],
        _ => vec!["restore", "--staged", "--"],
    };
    args.extend(paths.iter().map(String::as_str));
    checked(
        run(root, &args, None, false, TIMEOUT, active)?,
        operation.trim_start_matches("git."),
    )?;
    let after = read_status(root, &paths, active)?;
    Ok(
        json!({"fingerprint": scoped(root, &after, &paths), "staged_fingerprint": staged_fingerprint(root, &after)}),
    )
}

fn commit(
    access: &GitAccess<'_>,
    root: &Repository<'_>,
    arguments: &Value,
    active: &dyn Fn() -> bool,
) -> Result<Value, String> {
    let message = arguments
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| {
            !message.is_empty() && message.len() <= MESSAGE_LIMIT && !message.contains('\0')
        })
        .ok_or("invalid_commit_message")?;
    let expected = expected(arguments)?;
    let before = read_status(root, &[], active)?;
    if !before.complete {
        return Err("git_write_scope_incomplete".to_owned());
    }
    let staged = before
        .entries
        .iter()
        .filter(|entry| entry.staged())
        .flat_map(|entry| std::iter::once(entry.path.clone()).chain(entry.orig_path.clone()))
        .collect::<Vec<_>>();
    write_paths(access, root, &staged)?;
    if before.entries.iter().any(|entry| entry.conflicted) {
        return Err("git_conflicts_unresolved".to_owned());
    }
    if !before.entries.iter().any(Entry::staged) {
        return Err("nothing_staged".to_owned());
    }
    fresh(expected, Some(staged_fingerprint(root, &before)))?;
    checked(
        run(
            root,
            &["commit", "--file=-", "--cleanup=strip"],
            Some(message.as_bytes()),
            false,
            COMMIT_TIMEOUT,
            active,
        )?,
        "commit",
    )?;
    let oid = checked(read(root, &["rev-parse", "HEAD"], active)?, "rev-parse")?;
    let after = read_status(root, &[], active)?;
    Ok(
        json!({"oid": String::from_utf8_lossy(&oid.stdout).trim(), "staged_fingerprint": staged_fingerprint(root, &after)}),
    )
}

fn copy_tree(source: &Path, target: &Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(source)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if metadata.is_dir() {
        std::fs::create_dir_all(target)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
        Ok(())
    } else if metadata.file_type().is_symlink() {
        let link = std::fs::read_link(source)?;
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(link, target)
        }
        #[cfg(not(unix))]
        {
            std::fs::write(target, link.to_string_lossy().as_bytes())
        }
    } else {
        std::fs::copy(source, target).map(|_| ())
    }
}

fn discard(
    access: &GitAccess<'_>,
    root: &Repository<'_>,
    arguments: &Value,
    active: &dyn Fn() -> bool,
) -> Result<Value, String> {
    let paths = paths(root, access, arguments.get("paths"))?;
    let expected = expected(arguments)?;
    let backups = access.backups.ok_or("git_backup_unavailable")?;
    let before = read_status(root, &paths, active)?;
    if !before.complete {
        return Err("git_write_scope_incomplete".to_owned());
    }
    write_paths(access, root, &paths)?;
    fresh(expected, Some(scoped(root, &before, &paths)))?;
    let mut untracked = Vec::new();
    let mut tracked = Vec::new();
    for path in &paths {
        let entry = before
            .entries
            .iter()
            .find(|entry| entry.path == *path)
            .ok_or_else(|| format!("no_unstaged_changes: {path}"))?;
        if entry.conflicted {
            return Err(format!("conflicted_path: {path}"));
        }
        if entry.untracked() {
            untracked.push(path);
        } else if entry.worktree != ' ' {
            tracked.push(path);
        } else {
            return Err(format!("no_unstaged_changes: {path}"));
        }
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis());
    let backup = backups.join(format!("{stamp}"));
    for path in untracked.iter().chain(&tracked) {
        let source = root.join(path);
        if std::fs::symlink_metadata(&source).is_ok_and(|metadata| metadata.is_dir()) {
            return Err(format!("git_discard_requires_file: {path}"));
        }
        if std::fs::symlink_metadata(&source).is_ok() {
            copy_tree(&source, &backup.join(path))
                .map_err(|error| format!("git_backup_failed: {path}: {error}"))?;
        }
    }
    if !tracked.is_empty() {
        let mut args = vec!["restore", "--worktree", "--"];
        args.extend(tracked.iter().map(|path| path.as_str()));
        checked(run(root, &args, None, false, TIMEOUT, active)?, "restore")?;
    }
    for path in untracked {
        let target = root.join(path);
        let removed = if std::fs::symlink_metadata(&target).is_ok_and(|metadata| metadata.is_dir())
        {
            std::fs::remove_dir_all(&target)
        } else {
            std::fs::remove_file(&target)
        };
        removed.map_err(|error| format!("git_discard_failed: {path}: {error}"))?;
    }
    let after = read_status(root, &paths, active)?;
    Ok(json!({"backup": backup, "fingerprint": scoped(root, &after, &paths)}))
}

fn switch(
    access: &GitAccess<'_>,
    root: &Repository<'_>,
    arguments: &Value,
    active: &dyn Fn() -> bool,
) -> Result<Value, String> {
    let branch = arguments
        .get("branch")
        .and_then(Value::as_str)
        .filter(|branch| {
            !branch.is_empty()
                && branch.len() <= 255
                && !branch.starts_with('-')
                && !branch.chars().any(|c| c.is_control() || c.is_whitespace())
        })
        .ok_or("invalid_git_branch")?;
    let expected = expected(arguments)?;
    let reference = format!("refs/heads/{branch}");
    if read(
        root,
        &["show-ref", "--verify", "--quiet", &reference],
        active,
    )?
    .code
        != Some(0)
    {
        return Err(format!("unknown_git_branch: {branch}"));
    }
    let before = read_status(root, &[], active)?;
    for revision in std::iter::once(reference.as_str()).chain(before.head.oid.as_deref()) {
        let entries = listed_paths(checked(
            read(
                root,
                &["ls-tree", "-r", "--name-only", "-z", revision],
                active,
            )?,
            "ls-tree",
        )?)?;
        write_paths(access, root, &entries)?;
    }
    if before.entries.iter().any(|entry| entry.conflicted) {
        return Err("git_conflicts_unresolved".to_owned());
    }
    fresh(expected, whole_fingerprint(root, &before))?;
    checked(
        run(
            root,
            &["switch", "--no-guess", branch],
            None,
            false,
            TIMEOUT,
            active,
        )?,
        "switch",
    )?;
    let after = read_status(root, &[], active)?;
    Ok(json!({"head": head_json(&after.head), "fingerprint": whole_fingerprint(root, &after)}))
}

#[cfg(test)]
#[path = "git_tests.rs"]
mod tests;
