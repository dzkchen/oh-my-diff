use crate::workspace_operations::WorkspaceAuthority;
use codex_network_proxy::ManagedNetworkSandboxContext;
use codex_omd::data_store::Origin;
use codex_omd::host::Authority;
use codex_omd::host::Caller;
use codex_omd::host::ExecAccess;
use codex_omd::host::Host;
use codex_protocol::permissions::FileSystemAccessMode;
use codex_protocol::permissions::FileSystemPath;
use codex_protocol::permissions::FileSystemSandboxEntry;
use codex_protocol::permissions::NetworkSandboxPolicy;
use codex_utils_absolute_path::AbsolutePathBuf;
use serde_json::Value;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

pub(crate) struct NativeAuthority<'a> {
    pub workspace: &'a WorkspaceAuthority,
    pub protected: Vec<PathBuf>,
}

impl Authority for NativeAuthority<'_> {
    fn repository(&self) -> &Path {
        &self.workspace.repository
    }

    fn readable(&self, path: &Path) -> bool {
        !self.protected.iter().any(|root| path.starts_with(root)) && self.workspace.readable(path)
    }

    fn writable(&self, path: &Path) -> bool {
        !self.protected.iter().any(|root| path.starts_with(root)) && self.workspace.writable(path)
    }

    fn command(&self, argv: Vec<String>, access: &ExecAccess<'_>) -> Result<Command, String> {
        sandboxed_command(
            &self.workspace.policy,
            &self.workspace.repository,
            &self.protected,
            argv,
            access,
        )
    }
}

pub(crate) fn sandboxed_command(
    policy: &codex_protocol::permissions::FileSystemSandboxPolicy,
    repository: &Path,
    protected: &[PathBuf],
    argv: Vec<String>,
    access: &ExecAccess<'_>,
) -> Result<Command, String> {
    #[cfg(target_os = "macos")]
    {
        use codex_protocol::config_types::WindowsSandboxLevel;
        use codex_protocol::models::PermissionProfile;
        use codex_sandboxing::seatbelt::MACOS_PATH_TO_SEATBELT_EXECUTABLE;
        use codex_sandboxing::{
            SandboxCommand, SandboxManager, SandboxTransformRequest, SandboxType,
        };
        use codex_utils_path_uri::PathUri;
        let mut scope = if access.write {
            policy.clone()
        } else {
            crate::managed_process::read_policy(policy, access.scratch)?
        };
        if access.write {
            let scratch = AbsolutePathBuf::from_absolute_path_checked(access.scratch)
                .map_err(|error| error.to_string())?;
            scope.entries.push(FileSystemSandboxEntry::new(
                FileSystemPath::Path {
                    path: scratch.into(),
                },
                FileSystemAccessMode::Write,
            ));
        }
        let loopback = access.loopback.then(|| ManagedNetworkSandboxContext {
            allow_local_binding: true,
            ..Default::default()
        });
        let (program, arguments) = argv.split_first().ok_or("exec_command_empty")?;
        let cwd = PathUri::from_host_native_path(repository).map_err(|error| error.to_string())?;
        let permissions =
            PermissionProfile::from_runtime_permissions(&scope, NetworkSandboxPolicy::Restricted);
        let transformed = SandboxManager::for_file_system_helpers()
            .transform(SandboxTransformRequest {
                command: SandboxCommand {
                    program: program.into(),
                    args: arguments.to_vec(),
                    cwd: cwd.clone(),
                    env: Default::default(),
                    managed_network: loopback,
                    additional_permissions: None,
                },
                permissions: &permissions,
                sandbox: SandboxType::MacosSeatbelt,
                sandbox_policy_cwd: &cwd,
                enforce_managed_network: access.loopback,
                environment_id: None,
                network: None,
                sandbox_exe: None,
                use_legacy_landlock: false,
                windows_sandbox_level: WindowsSandboxLevel::Disabled,
            })
            .map_err(|error| error.to_string())?;
        if transformed.command.first().map(String::as_str)
            != Some(MACOS_PATH_TO_SEATBELT_EXECUTABLE)
        {
            return Err("exec_sandbox_unavailable".into());
        }
        sandboxed_seatbelt(
            Path::new(MACOS_PATH_TO_SEATBELT_EXECUTABLE),
            transformed.command[1..].to_vec(),
            protected,
            repository,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (policy, repository, protected, argv, access);
        Err("exec_sandbox_unavailable".to_owned())
    }
}

#[cfg(target_os = "macos")]
fn sandboxed_seatbelt(
    executable: &Path,
    mut args: Vec<String>,
    protected: &[PathBuf],
    cwd: &Path,
) -> Result<Command, String> {
    if args.first().map(String::as_str) != Some("-p") || args.len() < 2 {
        return Err("exec_sandbox_unavailable".to_owned());
    }
    for root in protected {
        for path in std::iter::once(root.clone()).chain(root.canonicalize().ok()) {
            let literal = serde_json::to_string(&path.to_string_lossy())
                .map_err(|error| error.to_string())?;
            args[1].push_str(&format!(
                "\n(deny file-read* file-write* (literal {literal}) (subpath {literal}))"
            ));
        }
    }
    let mut command = Command::new(executable);
    command.args(args).current_dir(cwd);
    Ok(command)
}

pub(crate) fn process_request_allowed(
    grants: Option<&codex_omd::ModGrants>,
    request: &codex_omd::ModHostCall,
) -> Result<(), String> {
    if request.operation != "process.start" {
        return Ok(());
    }
    let grants = grants.ok_or("host_caller_inactive")?;
    let fields = request
        .arguments
        .as_object()
        .ok_or("process_arguments_invalid")?;
    if fields.get("network").and_then(Value::as_str) == Some("loopback")
        && !grants
            .capabilities
            .iter()
            .any(|capability| capability == "network")
    {
        return Err("capability_denied: network".into());
    }
    if fields
        .get("environment")
        .and_then(Value::as_object)
        .is_some_and(|environment| {
            environment
                .keys()
                .any(|name| !grants.exec_environment.contains(name))
        })
    {
        return Err("exec_environment_undeclared".into());
    }
    Ok(())
}

pub(crate) const LIFECYCLE_EVENTS: &[&str] = &[
    "start",
    "resume",
    "idle",
    "stop",
    "turn_start",
    "turn_end",
    "tool_result",
    "workspace_change",
    "workspace_write",
    "compaction_start",
    "compaction_end",
    "agent_end",
];

pub(crate) fn event_allows(event: &str, operation: &str) -> bool {
    LIFECYCLE_EVENTS.contains(&event)
        || event == "workspace_pre_rename"
            && matches!(
                operation,
                "workspace.read" | "workspace.stat" | "workspace.list"
            )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn call(
    runtime_grants: Option<codex_omd::ModGrants>,
    workspace: &WorkspaceAuthority,
    data_root: &Path,
    protected: Vec<PathBuf>,
    caller: &str,
    origin: Origin,
    thread: Option<&str>,
    request: codex_omd::ModHostCall,
    active: &dyn Fn() -> bool,
    record_changes: bool,
) -> Result<Value, String> {
    let grants = runtime_grants.ok_or("host_caller_inactive")?;
    let authority = NativeAuthority {
        workspace,
        protected,
    };
    Host {
        authority: &authority,
        data_root,
        active,
        record_changes,
    }
    .call(
        &Caller {
            id: caller,
            source_sha256: &grants.source_sha256,
            capabilities: &grants.capabilities,
            exec_environment: &grants.exec_environment,
            origin,
            thread,
        },
        &request.operation,
        request.arguments,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn process_environment_names_must_be_declared_by_the_manifest() {
        let grants = codex_omd::ModGrants {
            api: codex_omd::MOD_API_VERSION.into(),
            source_sha256: "a".repeat(64),
            capabilities: vec!["exec".into()],
            exec_environment: vec!["RUSTUP_HOME".into()],
        };
        let start = |environment: Value| codex_omd::ModHostCall {
            operation: "process.start".into(),
            arguments: json!({"session":"s","environment":environment}),
        };
        assert!(
            process_request_allowed(Some(&grants), &start(json!({"RUSTUP_HOME":"/r"}))).is_ok()
        );
        assert_eq!(
            process_request_allowed(Some(&grants), &start(json!({"UNDECLARED":"1"}))).unwrap_err(),
            "exec_environment_undeclared"
        );
    }
}
