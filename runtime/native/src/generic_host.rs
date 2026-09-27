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
        use codex_sandboxing::seatbelt::CreateSeatbeltCommandArgsParams;
        use codex_sandboxing::seatbelt::MACOS_PATH_TO_SEATBELT_EXECUTABLE;
        use codex_sandboxing::seatbelt::create_seatbelt_command_args;
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
        let args = create_seatbelt_command_args(CreateSeatbeltCommandArgsParams {
            command: argv,
            file_system_sandbox_policy: &scope,
            network_sandbox_policy: NetworkSandboxPolicy::Restricted,
            sandbox_policy_cwd: repository,
            enforce_managed_network: access.loopback,
            managed_network: loopback.as_ref(),
            environment_id: None,
            network: None,
            extra_allow_unix_sockets: &[],
        })?;
        codex_omd::git::sandboxed(
            Path::new(MACOS_PATH_TO_SEATBELT_EXECUTABLE),
            args,
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

pub(crate) fn process_request_allowed(
    grants: Option<&codex_omd::ModGrants>,
    request: &codex_omd::ModHostCall,
) -> Result<(), String> {
    if request.operation != "process.start" {
        return Ok(());
    }
    let grants = grants.ok_or("host_caller_inactive")?;
    let fields = request.arguments.as_object().ok_or("process_arguments_invalid")?;
    if codex_omd::legacy_api(&grants.api) {
        if fields.contains_key("framing") || fields.contains_key("network") {
            return Err("process_framing_requires_current_api".into());
        }
        return Ok(());
    }
    if fields.contains_key("transport") {
        return Err("process_transport_removed: use framing and network".into());
    }
    if fields.get("network").and_then(Value::as_str) == Some("loopback")
        && !grants.capabilities.iter().any(|capability| capability == "network")
    {
        return Err("capability_denied: network".into());
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
            && matches!(operation, "workspace.read" | "workspace.stat" | "workspace.list")
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
