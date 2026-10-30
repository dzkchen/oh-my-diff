use super::*;
use codex_core::exec::ExecCapturePolicy;
use codex_core::exec::ExecExpiration;
use codex_core::exec::ExecParams;
use codex_core::exec::process_exec_tool_call;
use codex_features::Feature;
use codex_omd::Snapshot;
use codex_protocol::config_types::ShellEnvironmentPolicyInherit;
use codex_protocol::config_types::WindowsSandboxLevel;
use codex_protocol::models::PermissionProfile;
use codex_protocol::models::PermissionProfileSnapshot;
use codex_protocol::models::SandboxPermissions;
use codex_protocol::permissions::FileSystemAccessMode as Access;
use codex_protocol::permissions::FileSystemPath;
use codex_protocol::permissions::FileSystemSandboxEntry as Entry;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use codex_protocol::permissions::FileSystemSpecialPath;
use codex_protocol::permissions::NetworkSandboxPolicy;
use codex_protocol::protocol::AskForApproval;
use codex_protocol::protocol::Op;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::PathUri;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn error(e: impl ToString) -> String {
    e.to_string()
}

pub(super) struct Child {
    pub(super) thread: Arc<codex_core::CodexThread>,
    pub(super) task: Arc<Task>,
    pub(super) owner: String,
    pub(super) active: bool,
    pub(super) runtime: tokio::runtime::Handle,
}

impl Drop for Child {
    fn drop(&mut self) {
        if self.active {
            stop_dropped(
                &self.runtime,
                self.thread.clone(),
                self.task.clone(),
                self.owner.clone(),
                false,
                None,
                (),
            );
        }
    }
}

pub(super) async fn shutdown(
    thread: &codex_core::CodexThread,
) -> Result<codex_protocol::error::Result<()>, tokio::time::error::Elapsed> {
    let _ = thread.submit(Op::CleanBackgroundTerminals).await;
    tokio::time::timeout(Duration::from_secs(5), thread.shutdown_and_wait()).await
}

/// Interrupts and shuts down a worker's thread, then stops the worker and, with `discard`, drops its unconsumed result.
pub(super) async fn stop_worker(
    thread: &codex_core::CodexThread,
    task: &Task,
    worker: &str,
    discard: bool,
) {
    let _ = thread.submit(Op::Interrupt).await;
    let _ = shutdown(thread).await;
    let _ = task.finish_worker(worker);
    if discard {
        let _ = task.discard_worker_result(worker);
    }
}

/// `stop_worker` for `Drop`, on the runtime that owns the thread: awaits `job` first and drops `keep` last.
pub(super) fn stop_dropped(
    runtime: &tokio::runtime::Handle,
    thread: Arc<codex_core::CodexThread>,
    task: Arc<Task>,
    worker: String,
    discard: bool,
    job: Option<tokio::task::JoinHandle<()>>,
    keep: impl Send + 'static,
) {
    runtime.spawn(async move {
        if let Some(job) = job {
            let _ = job.await;
        }
        stop_worker(&thread, &task, &worker, discard).await;
        drop(keep);
    });
}

pub(super) fn intersect(
    parent: &PermissionProfile,
    requested: &PermissionProfile,
    cwd: &Path,
) -> Result<PermissionProfile, String> {
    if matches!(parent, PermissionProfile::External { .. })
        || matches!(requested, PermissionProfile::External { .. })
    {
        return Err("external sandbox authority is not supported".into());
    }
    let policies = [
        parent.file_system_sandbox_policy(),
        requested.file_system_sandbox_policy(),
    ];
    if policies.iter().flat_map(|p| &p.entries).any(|e| {
        matches!(
            e.path,
            FileSystemPath::Special {
                value: FileSystemSpecialPath::Minimal
            }
        ) && e.access != Access::Read
    }) {
        return Err("non-read platform-default permissions are unsupported".into());
    }
    let minimal = policies.iter().all(|p| {
        p.has_full_disk_read_access()
            || p.include_platform_defaults()
            || p.can_read_local_path_with_cwd(Path::new("/"), cwd)
    });
    let stripped: Vec<_> = policies
        .into_iter()
        .zip([parent, requested])
        .map(|(mut policy, profile)| {
            policy.entries.retain(|entry| {
                !matches!(
                    entry.path,
                    FileSystemPath::Special {
                        value: FileSystemSpecialPath::Minimal
                    }
                )
            });
            PermissionProfile::from_runtime_permissions(&policy, profile.network_sandbox_policy())
        })
        .collect();
    let result =
        codex_protocol::intersect_effective_permission_profiles(&stripped[0], &stripped[1], cwd)
            .map_err(error)?;
    let mut filesystem = result.file_system_sandbox_policy();
    if minimal && !filesystem.has_full_disk_read_access() {
        filesystem.entries.push(Entry::new(
            FileSystemPath::Special {
                value: FileSystemSpecialPath::Minimal,
            },
            Access::Read,
        ));
    }
    Ok(PermissionProfile::from_runtime_permissions(
        &filesystem,
        result.network_sandbox_policy(),
    ))
}

pub(super) fn isolated(
    parent: &Config,
    root: &Path,
    reads: &[PathBuf],
    denied: &[PathBuf],
    writable: bool,
) -> Result<Config, String> {
    let cwd = AbsolutePathBuf::from_absolute_path_checked(root).map_err(error)?;
    let mut entries = vec![Entry::new(
        FileSystemPath::Path {
            path: PathUri::from_abs_path(&cwd),
        },
        if writable {
            Access::Write
        } else {
            Access::Read
        },
    )];
    entries.push(Entry::new(
        FileSystemPath::Special {
            value: FileSystemSpecialPath::Minimal,
        },
        Access::Read,
    ));
    let metadata = root
        .parent()
        .map(|p| p.join("depot/.git"))
        .filter(|p| p.is_dir());
    let system_reads = [
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/Library/Developer/CommandLineTools/usr",
    ]
    .into_iter()
    .map(PathBuf::from)
    .filter(|p| p.exists());
    let allowed_reads: Vec<_> = reads
        .iter()
        .cloned()
        .chain(metadata)
        .chain(system_reads)
        .collect();
    for path in &allowed_reads {
        let path = AbsolutePathBuf::from_absolute_path_checked(path).map_err(error)?;
        entries.push(Entry::new(
            FileSystemPath::Path {
                path: PathUri::from_abs_path(&path),
            },
            Access::Read,
        ));
    }
    for path in denied
        .iter()
        .map(PathBuf::as_path)
        .chain(std::iter::once(parent.codex_home.as_path()))
    {
        let path = AbsolutePathBuf::from_absolute_path_checked(path).map_err(error)?;
        entries.push(Entry::new(
            FileSystemPath::Path {
                path: PathUri::from_abs_path(&path),
            },
            Access::Deny,
        ));
    }
    let requested = PermissionProfile::from_runtime_permissions(
        &FileSystemSandboxPolicy::restricted(entries),
        NetworkSandboxPolicy::Restricted,
    );
    let profile = intersect(
        &parent.permissions.effective_permission_profile(),
        &requested,
        parent.cwd.as_path(),
    )?;
    let mut config = parent.clone();
    config.cwd = cwd.clone();
    config.workspace_roots = vec![cwd.clone()];
    config.base_instructions = None;
    config.base_instructions_provenance = None;
    config
        .permissions
        .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::legacy(profile))
        .map_err(error)?;
    config.permissions.set_workspace_roots(vec![cwd]);
    config
        .permissions
        .approval_policy
        .set(AskForApproval::Never)
        .map_err(error)?;
    config.permissions.shell_environment_policy.inherit = ShellEnvironmentPolicyInherit::None;
    let path = reads
        .iter()
        .filter(|p| p.is_file())
        .filter_map(|p| p.parent())
        .map(|p| p.display().to_string())
        .chain(["/usr/bin:/bin:/usr/sbin:/sbin".into()])
        .collect::<Vec<_>>()
        .join(":");
    config.permissions.shell_environment_policy.r#set = HashMap::from([
        ("PATH".into(), path),
        ("HOME".into(), root.display().to_string()),
        ("TMPDIR".into(), root.join(".omd-tmp").display().to_string()),
        ("LANG".into(), "en_US.UTF-8".into()),
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
    ]);
    config.permissions.shell_environment_policy.use_profile = false;
    config.permissions.file_system_helper_sandbox = true;
    config.mcp_servers.set(HashMap::new()).map_err(error)?;
    config.agent_max_depth = 0;
    config.agent_max_threads = Some(1);
    for feature in config.features.enabled_features() {
        if !matches!(feature, Feature::ShellTool | Feature::UnifiedExec) {
            config.features.disable(feature).map_err(error)?;
        }
    }
    config
        .features
        .enable(Feature::SkipHostSkillDiscovery)
        .map_err(error)?;
    config.include_skill_instructions = false;
    Ok(config)
}

const ONE_SHOT: Duration = Duration::from_secs(300);

pub(super) async fn command(
    task: &Task,
    output_bytes: usize,
    config: &Config,
    argv: Vec<String>,
    limit: Duration,
) -> Result<Value, String> {
    task.check_active().map_err(error)?;
    let remaining = task.remaining().map_err(error)?.0;
    if remaining.is_zero() {
        return Err("task deadline exceeded".into());
    }
    let result = process_exec_tool_call(
        ExecParams {
            command: argv.clone(),
            cwd: config.cwd.clone(),
            expiration: ExecExpiration::Timeout(remaining.min(limit)),
            capture_policy: ExecCapturePolicy::Controlled {
                max_bytes: output_bytes.saturating_mul(4).saturating_add(65536),
            },
            env: config.permissions.shell_environment_policy.r#set.clone(),
            network: None,
            network_environment_id: None,
            sandbox_permissions: SandboxPermissions::UseDefault,
            windows_sandbox_level: WindowsSandboxLevel::Disabled,
            justification: None,
            arg0: None,
            file_system_helper_sandbox: config.permissions.file_system_helper_sandbox,
        },
        &config.permissions.effective_permission_profile(),
        &config.cwd,
        config.permissions.workspace_roots(),
        &config.codex_linux_sandbox_exe,
        &config.codex_self_exe,
        false,
        None,
    )
    .await
    .map_err(error)?;
    Ok(
        json!({"argv": argv, "exit_code": result.exit_code, "stdout": result.stdout.text, "stdout_truncated": result.stdout.truncated_after_lines.is_some() || result.stdout.text.len() >= output_bytes.saturating_mul(4).saturating_add(65536), "stderr": result.stderr.text, "timed_out": result.timed_out, "wall_seconds": result.duration.as_secs_f64()}),
    )
}

pub(super) async fn all_paths(
    task: &Task,
    output_bytes: usize,
    config: &Config,
) -> Result<BTreeSet<String>, String> {
    let output = command(
        task,
        output_bytes,
        config,
        vec![
            "/Library/Developer/CommandLineTools/usr/bin/git".into(),
            "-c".into(),
            "core.fsmonitor=false".into(),
            "-c".into(),
            "core.hooksPath=/dev/null".into(),
            "ls-files".into(),
            "--cached".into(),
            "--others".into(),
            "--exclude-standard".into(),
            "-z".into(),
        ],
        ONE_SHOT,
    )
    .await?;
    if output["exit_code"] != 0 || output["stdout_truncated"] != false {
        return Err(format!(
            "candidate path enumeration failed or truncated: {output}"
        ));
    }
    let names = output["stdout"]
        .as_str()
        .ok_or("candidate path list missing")?;
    if !names.is_empty() && !names.ends_with('\0') {
        return Err("incomplete candidate path list".into());
    }
    Ok(names
        .split('\0')
        .filter(|p| !p.is_empty() && !p.starts_with(".omd-tmp/"))
        .map(str::to_owned)
        .collect())
}

pub(super) struct ParentState {
    untracked: BTreeSet<String>,
    tracked: BTreeSet<String>,
    paths: BTreeSet<String>,
    pub(super) current: Snapshot,
}

impl ParentState {
    pub(super) fn capture(
        host: &Host,
        candidate_paths: impl IntoIterator<Item = String>,
    ) -> Result<Self, String> {
        let untracked = host.config.approved_untracked.iter().cloned().collect();
        let tracked = codex_omd::tracked_paths(&host.repository, &untracked).map_err(error)?;
        let mut paths = tracked.clone();
        paths.extend(candidate_paths);
        let current = Snapshot::capture_tree(&host.repository, &paths, host.config.snapshot_bytes)
            .map_err(error)?;
        Ok(Self {
            untracked,
            tracked,
            paths,
            current,
        })
    }

    pub(super) fn matches(&self, host: &Host, expected: &Snapshot) -> Result<bool, String> {
        Ok(
            codex_omd::tracked_paths(&host.repository, &self.untracked).map_err(error)?
                == self.tracked
                && Snapshot::capture_tree(
                    &host.repository,
                    &self.paths,
                    host.config.snapshot_bytes,
                )
                .map_err(error)?
                    == *expected,
        )
    }
}

pub(super) async fn apply_candidate(
    host: &Host,
    task: &Task,
    parent: &Config,
    denied: &[PathBuf],
    directory: &Path,
    state: &ParentState,
    candidate: &Snapshot,
) -> Result<Value, String> {
    let bytes = host.config.snapshot_bytes;
    if !state.matches(host, &state.current)? {
        return Err("parent changed after candidate checks/review; integration refused".into());
    }
    let delta = directory.join("delta");
    std::fs::create_dir(&delta).map_err(error)?;
    state
        .current
        .write_new(&delta.join("a"), bytes)
        .map_err(error)?;
    candidate
        .write_new(&delta.join("b"), bytes)
        .map_err(error)?;
    let git = |args: &[&str]| {
        [
            "/Library/Developer/CommandLineTools/usr/bin/git",
            "-c",
            "core.fsmonitor=false",
        ]
        .iter()
        .chain(args)
        .map(|arg| (*arg).to_owned())
        .collect::<Vec<String>>()
    };
    let diff = command(
        task,
        bytes,
        &isolated(parent, &delta, &[], denied, true)?,
        git(&[
            "diff",
            "--no-index",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
            "--output=candidate.patch",
            "--",
            "a",
            "b",
        ]),
        ONE_SHOT,
    )
    .await?;
    let patch = delta.join("candidate.patch");
    if diff["exit_code"] != 1 || !patch.is_file() {
        return Err("candidate diff failed".into());
    }
    task.check_active().map_err(error)?;
    if !state.matches(host, &state.current)? {
        return Err("parent changed immediately before apply; integration refused".into());
    }
    command(
        task,
        bytes,
        &isolated(parent, &host.repository, &[], denied, true)?,
        git(&["apply", "-p2", "--binary", &patch.display().to_string()]),
        ONE_SHOT,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolated_commands_keep_platform_reads_without_reopening_parent_denials() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = AbsolutePathBuf::from_absolute_path_checked(&root).unwrap();
        let denied = root.join("private");
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().canonicalize().unwrap().join("source");
        std::fs::write(&outside_file, "parent-source").unwrap();
        std::fs::create_dir(&denied).unwrap();
        let denial = Entry::new(
            FileSystemPath::Path {
                path: PathUri::from_host_native_path(&denied).unwrap(),
            },
            Access::Deny,
        );
        let parent = PermissionProfile::from_runtime_permissions(
            &FileSystemSandboxPolicy::restricted(vec![
                Entry::new(
                    FileSystemPath::Special {
                        value: FileSystemSpecialPath::Root,
                    },
                    Access::Read,
                ),
                Entry::new(
                    FileSystemPath::Path {
                        path: path.clone().into(),
                    },
                    Access::Write,
                ),
                denial.clone(),
            ]),
            NetworkSandboxPolicy::Restricted,
        );
        let requested = PermissionProfile::from_runtime_permissions(
            &FileSystemSandboxPolicy::restricted(vec![
                Entry::new(
                    FileSystemPath::Special {
                        value: FileSystemSpecialPath::Minimal,
                    },
                    Access::Read,
                ),
                Entry::new(FileSystemPath::Path { path: path.into() }, Access::Write),
            ]),
            NetworkSandboxPolicy::Restricted,
        );
        let policy = intersect(&parent, &requested, &root)
            .unwrap()
            .file_system_sandbox_policy();
        assert!(policy.include_platform_defaults());
        assert!(policy.entries.contains(&denial));
        assert!(!policy.can_read_local_path_with_cwd(&denied, &root));
        let output = crate::generic_host::sandboxed_command(
            &policy,
            &root,
            &[],
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "if cat \"$1\"; then exit 19; fi; printf sandbox-ok".into(),
                "check".into(),
                outside_file.display().to_string(),
            ],
            &codex_omd::host::ExecAccess {
                write: true,
                loopback: false,
                unix_sockets: &[],
                scratch: &root,
            },
        )
        .unwrap()
        .output()
        .unwrap();
        assert!(output.status.success(), "{:?}", output);
        assert_eq!(output.stdout, b"sandbox-ok");
    }

    #[test]
    fn protected_host_paths_stay_unreadable_even_under_an_unrestricted_session() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let repository = root.join("repo");
        let protected = root.join("omd-data");
        std::fs::create_dir(&repository).unwrap();
        std::fs::create_dir(&protected).unwrap();
        std::fs::write(protected.join("secret"), "host-only").unwrap();
        let output = crate::generic_host::sandboxed_command(
            &FileSystemSandboxPolicy::unrestricted(),
            &repository,
            std::slice::from_ref(&protected),
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "if cat \"$1\"; then exit 19; fi; printf sandbox-ok".into(),
                "check".into(),
                protected.join("secret").display().to_string(),
            ],
            &codex_omd::host::ExecAccess {
                write: false,
                loopback: false,
                unix_sockets: &[],
                scratch: &repository,
            },
        )
        .unwrap()
        .output()
        .unwrap();
        assert!(output.status.success(), "{:?}", output);
        assert_eq!(output.stdout, b"sandbox-ok");
    }

    #[test]
    fn sandboxed_commands_reach_only_granted_unix_sockets() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let socket = root.join("integration.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        for granted in [false, true] {
            let sockets = if granted {
                vec![socket.clone()]
            } else {
                Vec::new()
            };
            let status = crate::generic_host::sandboxed_command(
                &FileSystemSandboxPolicy::unrestricted(),
                &root,
                &[],
                vec![
                    "/usr/bin/perl".into(),
                    "-MIO::Socket::UNIX".into(),
                    "-e".into(),
                    "exit !IO::Socket::UNIX->new(Peer => shift)".into(),
                    socket.display().to_string(),
                ],
                &codex_omd::host::ExecAccess {
                    write: false,
                    loopback: false,
                    unix_sockets: &sockets,
                    scratch: &root,
                },
            )
            .unwrap()
            .status()
            .unwrap();
            assert_eq!(status.success(), granted);
        }
    }
}
