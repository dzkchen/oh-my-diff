mod accounting;
mod config;
mod contract;
mod execution;
mod generic_host;
mod ledger;
mod managed_process;
mod mods;
mod workspace_operations;

use accounting::Account;
use accounting::Accounts;
use codex_core::StartThreadOptions;
use codex_core::ThreadManager;
use codex_core::config::Config;
use codex_extension_api::ContentItemKind;
use codex_extension_api::ContextContributor;
use codex_extension_api::ExtensionData;
use codex_extension_api::ExtensionFuture;
use codex_extension_api::ExtensionRegistryBuilder;
use codex_extension_api::JsonToolOutput;
use codex_extension_api::PromptFragment;
use codex_extension_api::ThreadIdleInput;
use codex_extension_api::ThreadLifecycleContributor;
use codex_extension_api::ThreadStartInput;
use codex_extension_api::ThreadStopInput;
use codex_extension_api::ToolCall;
use codex_extension_api::ToolContributor;
use codex_extension_api::ToolExecutor;
use codex_extension_api::ToolExecutorFuture;
use codex_extension_api::ToolFinishInput;
use codex_extension_api::ToolLifecycleContributor;
use codex_extension_api::ToolLifecycleFuture;
use codex_extension_api::ToolOutput;
use codex_extension_api::ToolStartInput;
use codex_extension_api::TurnContextContributionInput;
use codex_omd::Task;
use codex_omd::VersionMarker;
use codex_protocol::ThreadId;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::SubAgentSource;
use codex_tools::FunctionCallError;
use codex_tools::JsonSchema;
use codex_tools::ResponsesApiTool;
use codex_tools::ToolExposure;
use codex_tools::ToolName;
use codex_tools::ToolSpec;
use config::HostConfig;
use config::Route;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Weak;

pub(crate) struct Host {
    root: PathBuf,
    repository: PathBuf,
    repository_identity: String,
    config: HostConfig,
    accounts: Arc<Accounts>,
    manager: Weak<ThreadManager>,
    epoch: u128,
}

pub(crate) struct Session {
    task: Arc<Task>,
    repository_identity: String,
    evidence: PathBuf,
    scratch: PathBuf,
    contract: std::sync::Mutex<contract::SessionContract>,
    contract_state: PathBuf,
    operation: std::sync::atomic::AtomicBool,
    processes: Arc<managed_process::ManagedProcesses>,
    data: mods::DataScope,
}

#[derive(Clone)]
pub(crate) struct Lead {
    host: Arc<Host>,
    session: Arc<Session>,
    thread: ThreadId,
    owner: String,
    depth: u32,
    permission_profile: Arc<std::sync::Mutex<codex_protocol::models::PermissionProfile>>,
}

struct OperationGuard<'a> {
    operation: &'a std::sync::atomic::AtomicBool,
    repository_identity: String,
}

static WORKSPACE_OPERATIONS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::BTreeSet<String>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::BTreeSet::new()));

impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        self.operation
            .store(false, std::sync::atomic::Ordering::Release);
        if let Ok(mut active) = WORKSPACE_OPERATIONS.lock() {
            active.remove(&self.repository_identity);
        }
    }
}

fn acquire_workspace_operation<'a>(
    operation: &'a std::sync::atomic::AtomicBool,
    repository_identity: &str,
) -> Result<OperationGuard<'a>, String> {
    use std::sync::atomic::Ordering;
    if operation.swap(true, Ordering::AcqRel) {
        return Err("workspace_operation_active: another integrate, restore, rename or transaction is running".into());
    }
    let mut active = WORKSPACE_OPERATIONS.lock().map_err(|_| {
        operation.store(false, Ordering::Release);
        "workspace_operation_lock_poisoned"
    })?;
    if !active.insert(repository_identity.to_owned()) {
        operation.store(false, Ordering::Release);
        return Err("workspace_operation_active: another integrate, restore, rename or transaction is running".into());
    }
    Ok(OperationGuard {
        operation,
        repository_identity: repository_identity.to_owned(),
    })
}

pub fn install(
    registry: &mut ExtensionRegistryBuilder<Config>,
    manager: Weak<ThreadManager>,
) -> Result<(), String> {
    let effective = codex_omd::effective_mode()?;
    if !effective.mode.mod_host_enabled() {
        return Ok(());
    }
    let root = PathBuf::from(
        std::env::var_os(codex_omd::MOD_STORE_ENV).ok_or("OMD_MODE=omd requires OMD_MOD_STORE")?,
    );
    let repository = std::env::current_dir()
        .and_then(|path| path.canonicalize())
        .map_err(|error| error.to_string())?;
    if !root.is_absolute()
        || root.canonicalize().map_err(|error| error.to_string())? != root
        || root.starts_with(&repository)
    {
        return Err("the mod store must be canonical and outside the repository".into());
    }
    let config = HostConfig::load(&root, &repository)?;
    let host = Arc::new(Host {
        repository_identity: execution::hash(repository.as_os_str().as_encoded_bytes()),
        root,
        repository,
        config,
        accounts: accounting::global(),
        manager,
        epoch: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default(),
    });
    mods::install(registry, host)
}

fn persist(
    directory: &std::path::Path,
    name: &str,
    bytes: &[u8],
    durable: bool,
) -> Result<(), String> {
    use std::io::Write;
    let path = directory.join(name);
    let temporary = directory.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos()
    ));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    let result = file
        .write_all(bytes)
        .and_then(|()| if durable { file.sync_all() } else { Ok(()) })
        .and_then(|()| std::fs::rename(&temporary, &path));
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

fn persist_view(directory: &std::path::Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    persist(directory, name, bytes, false)
}

impl Host {
    fn persist_json(&self, name: &str, value: &impl Serialize) -> Result<(), String> {
        let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        persist_view(&self.root, name, &bytes)
    }

    fn lead_route(&self, config: &Config) -> Option<&Route> {
        self.config.routes.iter().find(|route| {
            route.roles.contains(&config::RouteRole::Lead)
                && config.model.as_deref() == Some(route.model.as_str())
                && config.model_provider_id == route.provider
                && config.model_reasoning_effort.as_ref() == Some(&route.reasoning_effort)
        })
    }

    fn protected_paths(&self) -> Vec<PathBuf> {
        let mut paths = vec![self.root.clone()];
        paths.extend(self.config.protected.iter().cloned());
        paths.extend(self.config.secret_refs.values().cloned());
        paths
    }

    fn open_session(&self, thread: ThreadId, resumed: bool) -> Result<Arc<Session>, String> {
        let sessions = self.root.join("sessions");
        match std::fs::create_dir(&sessions) {
            Ok(()) => {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&sessions, std::fs::Permissions::from_mode(0o700))
                    .map_err(|error| error.to_string())?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
        if std::fs::symlink_metadata(&sessions)
            .map_err(|e| e.to_string())?
            .is_symlink()
            || sessions.canonicalize().map_err(|e| e.to_string())? != sessions
        {
            return Err("session_store_not_canonical".into());
        }
        let task = Arc::new(ledger::open(
            &sessions,
            &self.repository_identity,
            thread,
            self.config.limits.clone(),
            resumed,
        )?);
        let scratch = self
            .repository
            .join(".omd")
            .join(format!("session-{thread}"));
        if resumed && scratch.symlink_metadata().is_ok() {
            codex_omd::cleanup_owned_directory(
                scratch.parent().ok_or("scratch_parent_missing")?,
                &scratch,
            )
            .map_err(|e| e.to_string())?;
        }
        let evidence = sessions.join(format!("{thread}-{}-{}", self.epoch, ThreadId::new()));
        std::fs::create_dir(&evidence).map_err(|e| e.to_string())?;
        let evidence = evidence.canonicalize().map_err(|error| error.to_string())?;
        Ok(Arc::new(Session {
            task,
            repository_identity: self.repository_identity.clone(),
            scratch,
            contract: std::sync::Mutex::new(contract::SessionContract::default()),
            contract_state: sessions.join(format!(
                "contract-{}-{thread}.json",
                self.repository_identity
            )),
            operation: std::sync::atomic::AtomicBool::new(false),
            processes: Arc::new(managed_process::ManagedProcesses::default()),
            data: mods::DataScope::default(),
            evidence,
        }))
    }

    fn enroll(
        &self,
        thread: ThreadId,
        session: &Arc<Session>,
        owner: &str,
        route: Option<&Route>,
        config: Option<&Config>,
    ) -> Result<(), String> {
        let (provider, model, url) = match (route, config) {
            (Some(route), _) => (
                route.provider.clone(),
                route.model.clone(),
                route.responses_url.clone(),
            ),
            (None, Some(config)) => (
                config.model_provider_id.clone(),
                config.model.clone().unwrap_or_default(),
                String::new(),
            ),
            (None, None) => return Err("enrollment_requires_route_or_config".into()),
        };
        let lead_routes = self
            .config
            .routes
            .iter()
            .filter(|candidate| {
                candidate.roles.contains(&config::RouteRole::Lead) && candidate.provider == provider
            })
            .map(|candidate| accounting::RequestRoute {
                name: candidate.name.clone(),
                model: candidate.model.clone(),
                provider: candidate.provider.clone(),
                reasoning: serde_json::to_value(&candidate.reasoning_effort)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .unwrap_or_default(),
                rates: candidate.rates.clone(),
            })
            .collect::<Vec<_>>();
        if owner == "lead" && route.is_some() {
            session
                .task
                .authorize_route(&provider, &model)
                .map_err(|error| error.to_string())?;
            for candidate in &lead_routes {
                session
                    .task
                    .authorize_route(&candidate.provider, &candidate.model)
                    .map_err(|error| error.to_string())?;
            }
        }
        let account = Account {
            task: session.task.clone(),
            owner: owner.into(),
            model,
            provider,
            url,
            max_request_bytes: self.config.max_request_bytes,
            rates: route.map(|route| route.rates.clone()),
            repository_identity: self.repository_identity.clone(),
            cost_capture: session.evidence.join("task-cost.json"),
            route: route.map(|route| route.name.clone()),
            lead_routes,
            worker_authorization: route
                .and_then(|route| route.grant.as_ref())
                .map(|grant| (grant.path.clone(), grant.sha256.clone())),
        };
        let mut accounts = self
            .accounts
            .0
            .lock()
            .map_err(|_| "account lock poisoned")?;
        if accounts.insert(thread.to_string(), account).is_some() {
            return Err("duplicate native thread enrollment".into());
        }
        Ok(())
    }
}

impl Session {
    fn evidence(&self, name: &str, value: &Value) -> Result<Value, String> {
        use std::io::Write;
        let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        let path = self.evidence.join(name);
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(json!({"path": path, "sha256": execution::hash(&bytes)}))
    }

    fn persist_contract(&self) -> Result<(), String> {
        let status = self
            .contract
            .lock()
            .map_err(|_| "contract_lock_poisoned")?
            .status();
        let bytes = serde_json::to_vec(&status).map_err(|error| error.to_string())?;
        if status["status"] == "unavailable" {
            return Err("contract_unavailable".into());
        }
        let result = if bytes.len() > contract::STATE_BYTES {
            Err("contract_state_byte_limit".into())
        } else {
            persist(
                self.contract_state
                    .parent()
                    .ok_or("contract_state_parent_missing")?,
                self.contract_state
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("contract_state_name_invalid")?,
                &bytes,
                true,
            )
        };
        if let Err(error) = &result {
            self.contract
                .lock()
                .map_err(|_| "contract_lock_poisoned")?
                .invalidate(error.clone());
        }
        result?;
        persist(&self.evidence, "contract.json", &bytes, false)
    }

    fn persist_cost_capture(&self) -> Result<(), String> {
        let capture = self
            .task
            .cost_capture()
            .map_err(|error| error.to_string())?;
        let bytes = serde_json::to_vec_pretty(&capture).map_err(|error| error.to_string())?;
        persist(&self.evidence, "task-cost.json", &bytes, true)
    }
}

impl Lead {
    fn ledger(&self) -> Value {
        json!({"thread_id": self.thread.to_string(), "cwd": self.host.repository, "cost": self.session.task.cost_capture().ok()})
    }

    fn restricted(&self, operation: &str, arguments: &Value) -> Result<(), String> {
        self.session
            .contract
            .lock()
            .map_err(|_| "contract_lock_poisoned")?
            .restricted(operation, arguments)
    }
}

fn thread_owner(
    input: &ThreadStartInput<'_, Config>,
    thread: ThreadId,
    parent: bool,
) -> Option<(String, u32)> {
    match input.session_source {
        SessionSource::SubAgent(SubAgentSource::ThreadSpawn { depth, .. }) => parent.then(|| {
            (
                format!("agent:{thread}"),
                u32::try_from(*depth).unwrap_or(u32::MAX),
            )
        }),
        SessionSource::Internal(_) | SessionSource::SubAgent(_) => None,
        _ if input
            .thread_store
            .get::<codex_protocol::protocol::ThreadSource>()
            .is_some_and(|source| {
                !matches!(*source, codex_protocol::protocol::ThreadSource::User)
            }) =>
        {
            None
        }
        _ => Some(("lead".into(), 0)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_operation_guard_excludes_other_sessions_in_same_repository() {
        let first = std::sync::atomic::AtomicBool::new(false);
        let second = std::sync::atomic::AtomicBool::new(false);
        let held = acquire_workspace_operation(&first, "repo-a").unwrap();
        assert!(acquire_workspace_operation(&first, "repo-a").is_err());
        assert!(acquire_workspace_operation(&second, "repo-a").is_err());
        assert!(acquire_workspace_operation(&second, "repo-b").is_ok());
        drop(held);
        assert!(acquire_workspace_operation(&second, "repo-a").is_ok());
    }

    #[test]
    fn host_config_defaults_are_bounded_and_route_free() {
        let config = HostConfig::default();
        assert!(config.routes.is_empty());
        assert_eq!(config.limits.exposure_microusd, 0);
        assert_eq!(config.worker_limits.exposure_microusd, 0);
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        assert!(
            HostConfig::load(&root, &root.join("repo"))
                .unwrap()
                .routes
                .is_empty()
        );
        std::fs::write(root.join(config::HOST_CONFIG), br#"{"schema":2}"#).unwrap();
        assert!(HostConfig::load(&root, &root.join("repo")).is_err());
    }

    #[test]
    fn atomic_persistence_replaces_private_file_without_leftovers() {
        let directory = tempfile::tempdir().unwrap();
        persist(directory.path(), "state.json", b"{\"first\":true}", true).unwrap();
        persist(directory.path(), "state.json", b"{\"second\":true}", true).unwrap();
        let path = directory.path().join("state.json");
        assert_eq!(std::fs::read(&path).unwrap(), b"{\"second\":true}");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
