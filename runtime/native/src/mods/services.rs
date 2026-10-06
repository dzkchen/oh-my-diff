use super::*;
use codex_protocol::models::PermissionProfile;
use codex_protocol::models::PermissionProfileSnapshot;
use codex_protocol::permissions::FileSystemAccessMode;
use codex_protocol::permissions::FileSystemPath;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use std::collections::BTreeSet;
use std::path::Path;
use std::time::Duration;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Grant {
    id: String,
    mod_id: String,
    program: PathBuf,
    program_sha256: String,
    #[serde(default)]
    arguments: Vec<String>,
    #[serde(default)]
    secrets: BTreeMap<String, String>,
    #[serde(default)]
    route: Option<Route>,
    #[serde(default)]
    network: bool,
    #[serde(default)]
    read_paths: Vec<PathBuf>,
    #[serde(default)]
    requests: bool,
    #[serde(default)]
    read_hashes: BTreeMap<PathBuf, String>,
    #[serde(default)]
    code_roots: BTreeMap<PathBuf, String>,
    #[serde(default)]
    credentials: BTreeSet<String>,
}

impl Grant {
    /// The rates of this grant's provider-billed route for `provider`, when it declares one.
    pub(crate) fn billed_rates(&self, provider: &str) -> Option<&crate::accounting::Rates> {
        self.route
            .as_ref()
            .filter(|route| {
                route.provider == provider
                    && route.rates.provider_billed
                    && !route.rates.included_subscription
                    && route.rates.reservation_microusd == 0
            })
            .map(|route| &route.rates)
    }

    pub(crate) fn mod_id(&self) -> &str {
        &self.mod_id
    }
}

#[derive(Default)]
pub(super) struct Services {
    records: tokio::sync::Mutex<BTreeMap<String, Service>>,
}

struct Service {
    mod_id: String,
    generation: u64,
    route: Option<Route>,
    job: Option<tokio::task::JoinHandle<Result<Value, String>>>,
    task: Arc<Task>,
    worker: String,
    _gateway: Option<crate::credential_gateway::Registration>,
    _snapshot: tempfile::TempDir,
}

impl Drop for Service {
    fn drop(&mut self) {
        if let Some(job) = self.job.take() {
            job.abort();
        }
        let _ = self.task.finish_worker(&self.worker);
    }
}

impl Service {
    fn finished(&self) -> bool {
        self.job
            .as_ref()
            .is_none_or(tokio::task::JoinHandle::is_finished)
    }

    async fn stop(mut self) {
        if let Some(job) = self.job.take() {
            job.abort();
            let _ = job.await;
        }
    }
}

impl Services {
    #[expect(
        clippy::await_holding_invalid_type,
        reason = "Stop stale services before admitting replacements"
    )]
    pub(super) async fn cleanup_stale(&self, generation: u64, owners: &BTreeMap<String, String>) {
        let mut records = self.records.lock().await;
        let stale = {
            let keys = records
                .iter()
                .filter(|(_, service)| {
                    service.generation != generation || !owners.contains_key(&service.mod_id)
                })
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|id| records.remove(&id))
                .collect::<Vec<_>>()
        };
        for service in stale {
            service.stop().await;
        }
        drop(records);
    }

    pub(super) async fn cleanup_owned(&self, mod_id: &str, generation: u64) {
        let owned = {
            let mut records = self.records.lock().await;
            let keys = records
                .iter()
                .filter(|(_, agent)| agent.mod_id == mod_id && agent.generation == generation)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| records.remove(&key))
                .collect::<Vec<_>>()
        };
        for agent in owned {
            agent.stop().await;
        }
    }

    pub(super) async fn cleanup_session(&self, session: &Session) {
        let owned = {
            let mut records = self.records.lock().await;
            let keys = records
                .iter()
                .filter(|(_, service)| Arc::ptr_eq(&service.task, &session.task))
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| records.remove(&key))
                .collect::<Vec<_>>()
        };
        for service in owned {
            service.stop().await;
        }
    }

    pub(super) async fn route(
        &self,
        mod_id: &str,
        generation: u64,
        id: &str,
    ) -> Result<Route, String> {
        self.records
            .lock()
            .await
            .get(id)
            .filter(|s| s.mod_id == mod_id && s.generation == generation && !s.finished())
            .and_then(|s| s.route.clone())
            .ok_or_else(|| "provider_not_registered_or_stopped".into())
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "Keep service registration atomic with cleanup ownership"
    )]
    pub(super) async fn call(
        &self,
        runtime: &Mutex<ModHost>,
        lead: &Lead,
        mod_id: &str,
        generation: u64,
        request: codex_omd::ModHostCall,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Selection {
            id: String,
            #[serde(default)]
            input: Option<Value>,
            #[serde(default)]
            secrets: Vec<String>,
        }
        let selection: Selection =
            serde_json::from_value(request.arguments).map_err(|e| e.to_string())?;
        if !selection.secrets.is_empty()
            && !matches!(
                request.operation.as_str(),
                "sidecars.start" | "providers.register"
            )
            || selection.secrets.len() > 16
        {
            return Err("credential_requires_service_start".into());
        }
        let invoke = request.operation == "sidecars.invoke";
        if invoke != selection.input.is_some()
            || selection.input.as_ref().is_some_and(|input| {
                serde_json::to_vec(input).map_or(true, |bytes| bytes.len() > 16384)
            })
        {
            return Err("service_request_input_invalid".into());
        }
        let mut records = self.records.lock().await;
        if matches!(
            request.operation.as_str(),
            "sidecars.stop" | "providers.unregister"
        ) {
            if records
                .get(&selection.id)
                .is_none_or(|r| r.mod_id != mod_id || r.generation != generation)
            {
                return Err("unknown_or_foreign_sidecar".into());
            }
            let service = records.remove(&selection.id);
            drop(records);
            if let Some(service) = service {
                service.stop().await;
            }
            return Ok(json!({"stopped":true}));
        }
        if request.operation == "sidecars.status" {
            let record = records
                .get(&selection.id)
                .filter(|r| r.mod_id == mod_id && r.generation == generation)
                .ok_or("unknown_or_foreign_sidecar")?;
            return Ok(json!({"id":selection.id,"running":!record.finished()}));
        }
        if records.contains_key(&selection.id) {
            return Err("service_already_registered".into());
        }
        let host = &lead.host;
        let mut grant = host
            .config
            .services
            .iter()
            .find(|g| g.id == selection.id && g.mod_id == mod_id)
            .cloned()
            .ok_or("service_not_host_approved")?;
        if records.len() >= 8 || grant.id.is_empty() || grant.id.len() > 32 {
            return Err("service_limit".into());
        }
        if request.operation == "providers.register" && grant.route.is_none() {
            return Err("provider_grant_required".into());
        }
        if request.operation == "sidecars.start" && grant.route.is_some() {
            return Err("provider_registration_required".into());
        }
        let (source_root, mut source_files) = runtime
            .lock()
            .map_err(|_| "runtime_poisoned")?
            .launch_sources(mod_id, generation)
            .map_err(|error| error.to_string())?;
        let mut code_roots = vec![source_root];
        let mut source_links = BTreeMap::new();
        if grant.code_roots.len() > 4 {
            return Err("service_source_limit".into());
        }
        let mut source_bytes = source_files.values().map(Vec::len).sum::<usize>();
        for (root, expected) in &grant.code_roots {
            if code_roots
                .iter()
                .any(|prior| root.starts_with(prior) || prior.starts_with(root))
            {
                return Err("service_code_roots_overlap".into());
            }
            let files = launch_snapshot::capture(root)?;
            if launch_snapshot::digest(&files) != *expected {
                return Err("service_source_changed".into());
            }
            source_bytes += files.files.values().map(Vec::len).sum::<usize>();
            if source_bytes > 128 * 1024 * 1024
                || source_files.len() + source_links.len() + files.files.len() + files.links.len()
                    > 8192
            {
                return Err("service_source_limit".into());
            }
            for (path, bytes) in files.files {
                if let Some(admitted) = source_files.get(&path)
                    && admitted != &bytes
                {
                    return Err("service_source_changed".into());
                }
                source_files.insert(path, bytes);
            }
            source_links.extend(files.links);
            code_roots.push(root.clone());
        }
        if invoke && (!grant.requests || grant.route.is_some() || grant.read_hashes.is_empty()) {
            return Err("service_request_not_host_approved".into());
        }
        if grant.read_hashes.len() > 32 {
            return Err("service_source_limit".into());
        }
        for (path, expected) in &grant.read_hashes {
            use std::io::Read;
            use std::os::unix::fs::OpenOptionsExt;
            let mut bytes = Vec::new();
            let file = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(path)
                .map_err(|_| "service_source_unavailable")?;
            if !file
                .metadata()
                .map_err(|_| "service_source_unavailable")?
                .is_file()
            {
                return Err("service_source_unavailable".into());
            }
            file.take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "service_source_unavailable")?;
            if !path.is_absolute()
                || path
                    .canonicalize()
                    .map_err(|_| "service_source_unavailable")?
                    != *path
                || bytes.len() > 4 * 1024 * 1024
                || execution::hash(&bytes) != *expected
            {
                return Err("service_source_changed".into());
            }
            if let Some(admitted) = source_files.get(path)
                && admitted != &bytes
            {
                return Err("service_source_changed".into());
            }
            source_files.insert(path.clone(), bytes);
        }
        if source_files.values().map(Vec::len).sum::<usize>() > 128 * 1024 * 1024
            || source_files.len() + source_links.len() > 8192
        {
            return Err("service_source_limit".into());
        }
        let snapshot = launch_snapshot::materialize(&host.root, &source_files, &source_links)?;
        for argument in &mut grant.arguments {
            let path = Path::new(argument);
            if source_files.contains_key(path) {
                *argument = launch_snapshot::path(snapshot.path(), path)?
                    .to_string_lossy()
                    .into_owned();
            }
        }
        if grant.program.starts_with(&host.repository)
            || grant.program.canonicalize().map_err(|e| e.to_string())? != grant.program
        {
            return Err("service_executable_must_be_canonical_and_outside_repository".into());
        }
        let metadata = std::fs::metadata(&grant.program).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() > 134_217_728 {
            return Err("service_executable_limit".into());
        }
        if execution::hash(&std::fs::read(&grant.program).map_err(|e| e.to_string())?)
            != grant.program_sha256
        {
            return Err("service_executable_changed".into());
        }
        let manager = host
            .manager
            .upgrade()
            .ok_or("native_thread_manager_stopped")?;
        let parent = manager
            .get_thread(lead.thread)
            .await
            .map_err(|e| e.to_string())?
            .config()
            .await;
        if grant.read_paths.len() > 16 {
            return Err("service_read_path_limit".into());
        }
        let mut reads = host.config.toolchain_reads.clone();
        reads.push(grant.program.clone());
        let supervisor = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        reads.push(supervisor.clone());
        reads.extend(grant.read_paths.iter().cloned());
        reads.push(snapshot.path().to_path_buf());
        let mut denied = host
            .protected_paths()
            .into_iter()
            .filter(|path| *path != host.root)
            .collect::<Vec<_>>();
        denied.extend(code_roots);
        let mut parent = (*parent).clone();
        let inherited = execution::intersect(
            &parent.permissions.effective_permission_profile(),
            &lead
                .permission_profile
                .lock()
                .map_err(|_| "permission_profile_poisoned")?
                .clone(),
            parent.cwd.as_path(),
        )?;
        let source = Some(host.root.join("sources").join(mod_id));
        for entry in inherited.file_system_sandbox_policy().entries {
            if entry.access != FileSystemAccessMode::Deny {
                continue;
            }
            let FileSystemPath::Path { path } = entry.path else {
                return Err("service_parent_denial_unsupported".into());
            };
            let path = path.to_path_buf();
            if path == Path::new("/")
                || host.root == path
                || (source.as_ref() == Some(&path) && grant.read_paths.contains(&path))
            {
                continue;
            }
            if !denied.contains(&path) {
                denied.push(path);
            }
        }
        let scope = PermissionProfile::from_runtime_permissions(
            &FileSystemSandboxPolicy::unrestricted(),
            inherited.network_sandbox_policy(),
        );
        parent
            .permissions
            .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::legacy(scope))
            .map_err(|e| e.to_string())?;
        let mut config = execution::isolated(&parent, &host.repository, &reads, &denied, false)?;
        if grant.network {
            let service_profile = config.permissions.effective_permission_profile();
            let profile = codex_protocol::models::PermissionProfile::from_runtime_permissions(
                &service_profile.file_system_sandbox_policy(),
                codex_protocol::permissions::NetworkSandboxPolicy::Enabled,
            );
            config
                .permissions
                .set_permission_profile_from_session_snapshot(
                    codex_protocol::models::PermissionProfileSnapshot::legacy(profile),
                )
                .map_err(|e| e.to_string())?;
        }
        config.permissions.shell_environment_policy.r#set.clear();
        config.permissions.shell_environment_policy.r#set.insert(
            "OMD_SERVICE_ROOT".into(),
            snapshot.path().to_string_lossy().into_owned(),
        );
        for (environment, reference) in &grant.secrets {
            if matches!(environment.as_str(), "OMD_READY_TOKEN" | "OMD_SERVICE_ROOT")
                || environment.is_empty()
                || environment.len() > 64
                || !environment
                    .bytes()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
            {
                return Err("invalid_secret_environment_key".into());
            }
            let path = host
                .config
                .secret_refs
                .get(reference)
                .ok_or("unknown_secret_reference")?;
            if path.starts_with(&host.repository)
                || !path.is_absolute()
                || std::fs::symlink_metadata(path)
                    .map_err(|_| "secret_reference_unavailable")?
                    .file_type()
                    .is_symlink()
                || !std::fs::metadata(path)
                    .map_err(|_| "secret_reference_unavailable")?
                    .is_file()
                || std::fs::metadata(path)
                    .map_err(|_| "secret_reference_unavailable")?
                    .len()
                    > 8192
            {
                return Err("secret_reference_unavailable".into());
            }
            let value =
                std::fs::read_to_string(path).map_err(|_| "secret_reference_unavailable")?;
            config
                .permissions
                .shell_environment_policy
                .r#set
                .insert(environment.clone(), value.trim_end().to_string());
        }
        let gateway = if grant.credentials.is_empty() {
            None
        } else if !grant.network || grant.credentials.len() > 32 {
            return Err("credential_gateway_requires_network".into());
        } else {
            let (url, registration) =
                crate::credential_gateway::register(host.root.clone(), grant.credentials.clone())
                    .map_err(|error| error.to_string())?;
            config
                .permissions
                .shell_environment_policy
                .r#set
                .insert("OMD_CREDENTIAL_GATEWAY".to_owned(), url);
            Some(registration)
        };
        if !selection.secrets.is_empty() {
            let profiles = codex_omd::credentials::CredentialProfiles::open(&host.root)
                .map_err(|error| error.to_string())?;
            let secrets = selection
                .secrets
                .iter()
                .map(|id| profiles.owned_secret(id, mod_id))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            config
                .permissions
                .shell_environment_policy
                .r#set
                .insert("OMD_SECRETS".to_owned(), Value::Array(secrets).to_string());
        }
        if let Some(route) = &grant.route {
            if route.model.is_empty() || route.model.len() > 128 {
                return Err("unsupported_adapter_model".into());
            }
            if !config.model_providers.contains_key(&route.provider)
                || !route.responses_url.starts_with("http://127.0.0.1:")
            {
                return Err("configured_loopback_provider_required".into());
            }
        }
        if invoke {
            let worker = format!(
                "service-request-{}-{}",
                grant.id,
                manager.reserve_thread_id()
            );
            lead.session
                .task
                .start_worker(
                    worker.clone(),
                    lead.owner.clone(),
                    lead.depth.saturating_add(1),
                    host.worker_limits(&lead.session)?,
                )
                .map_err(|e| e.to_string())?;
            struct RequestGuard {
                task: Arc<Task>,
                worker: String,
            }
            impl Drop for RequestGuard {
                fn drop(&mut self) {
                    let _ = self.task.finish_worker(&self.worker);
                }
            }
            let _guard = RequestGuard {
                task: lead.session.task.clone(),
                worker,
            };
            let mut argv = vec![grant.program.to_string_lossy().into_owned()];
            argv.extend(grant.arguments.clone());
            argv.push("--omd-request-json".into());
            argv.push(serde_json::to_string(&selection.input).map_err(|e| e.to_string())?);
            if argv.len() > 128 || argv.iter().map(String::len).sum::<usize>() > 24576 {
                return Err("service_argument_limit".into());
            }
            let timeout = lead
                .session
                .task
                .remaining()
                .map_err(|e| e.to_string())?
                .0
                .min(Duration::from_secs(30));
            let mut supervised = vec![
                supervisor.to_string_lossy().into_owned(),
                "--omd-managed-request-v1".into(),
                std::process::id().to_string(),
                timeout.as_secs().saturating_add(1).to_string(),
            ];
            supervised.extend(argv);
            drop(records);
            let output = tokio::time::timeout(timeout, request_output(&config, supervised))
                .await
                .map_err(|_| "service_request_deadline")??;
            lead.session
                .task
                .check_active()
                .map_err(|e| e.to_string())?;
            if output["exit_code"] != 0 {
                return Err("service_request_failed".into());
            }
            let text = output["stdout"]
                .as_str()
                .filter(|text| text.len() <= 32768)
                .ok_or("service_response_limit")?;
            if config
                .permissions
                .shell_environment_policy
                .r#set
                .values()
                .filter(|value| value.len() >= 4)
                .any(|secret| text.contains(secret))
            {
                return Err("service_response_secret_excluded".into());
            }
            let value: Value =
                serde_json::from_str(text).map_err(|_| "service_response_not_json")?;
            return Ok(
                json!({"provider":grant.id,"program_sha256":grant.program_sha256,"source_hashes":grant.read_hashes,"result":value,"untrusted":true}),
            );
        }
        let nonce = manager.reserve_thread_id().to_string();
        config
            .permissions
            .shell_environment_policy
            .r#set
            .insert("OMD_READY_TOKEN".into(), nonce.clone());
        let port = grant
            .route
            .as_ref()
            .map(|route| {
                let uri: http::Uri = route
                    .responses_url
                    .parse()
                    .map_err(|_| "invalid_provider_url")?;
                if uri.scheme_str() != Some("http") || uri.host() != Some("127.0.0.1") {
                    return Err("configured_loopback_provider_required");
                }
                uri.port_u16().ok_or("explicit_provider_port_required")
            })
            .transpose()?;
        let worker = format!("sidecar-{}-{}", grant.id, manager.reserve_thread_id());
        lead.session
            .task
            .start_worker(
                worker.clone(),
                lead.owner.clone(),
                lead.depth.saturating_add(1),
                host.worker_limits(&lead.session)?,
            )
            .map_err(|e| e.to_string())?;
        let mut argv = vec![grant.program.to_string_lossy().into_owned()];
        argv.extend(grant.arguments);
        if argv.len() > 128 || argv.iter().map(String::len).sum::<usize>() > 8192 {
            let _ = lead.session.task.finish_worker(&worker);
            return Err("service_argument_limit".into());
        }
        let task = lead.session.task.clone();
        let output_bytes = host.config.snapshot_bytes;
        let timeout = lead
            .session
            .task
            .remaining()
            .map_err(|e| e.to_string())?
            .0
            .min(Duration::from_secs(
                host.route_config().0.worker_limits.seconds,
            ));
        let mut supervised = vec![
            supervisor.to_string_lossy().into_owned(),
            "--omd-managed-service-v1".into(),
            std::process::id().to_string(),
            timeout.as_secs().saturating_add(1).min(86400).to_string(),
        ];
        supervised.extend(argv);
        let job = tokio::spawn(async move {
            let result = tokio::time::timeout(
                timeout,
                execution::command(&task, output_bytes, &config, supervised, timeout),
            )
            .await
            .map_err(|_| "sidecar_deadline".to_string())??;
            Ok(json!({"exit_code":result["exit_code"],"timed_out":result["timed_out"]}))
        });
        records.insert(
            grant.id.clone(),
            Service {
                mod_id: mod_id.into(),
                generation,
                // A provider becomes routable only after its readiness handshake succeeds.
                route: None,
                job: Some(job),
                task: lead.session.task.clone(),
                worker: worker.clone(),
                _gateway: gateway,
                _snapshot: snapshot,
            },
        );
        // Every mod shares these records, so wait for readiness without holding the lock.
        drop(records);
        if let (Some(port), Some(route)) = (port, grant.route) {
            let ready = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    lead.session
                        .task
                        .check_active()
                        .map_err(|e| e.to_string())?;
                    if self
                        .records
                        .lock()
                        .await
                        .get(&grant.id)
                        .is_none_or(|s| s.worker != worker || s.finished())
                    {
                        return Err("provider_sidecar_stopped".to_string());
                    }
                    if let Ok(mut stream) =
                        tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await
                    {
                        use tokio::io::AsyncReadExt;
                        use tokio::io::AsyncWriteExt;
                        let attempt = async {
                            stream
                                .write_all(b"GET /_omd/ready HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
                                .await?;
                            let mut response = Vec::new();
                            stream.take(4096).read_to_end(&mut response).await?;
                            Ok::<_, std::io::Error>(
                                response.ends_with(format!("OMD_READY:{nonce}").as_bytes()),
                            )
                        };
                        if tokio::time::timeout(Duration::from_millis(200), attempt)
                            .await
                            .is_ok_and(|r| r.unwrap_or(false))
                        {
                            return Ok(());
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await;
            let mut records = self.records.lock().await;
            match records.get_mut(&grant.id) {
                Some(service) if service.worker == worker && matches!(ready, Ok(Ok(()))) => {
                    service.route = Some(route);
                }
                current => {
                    let stale = current
                        .is_some_and(|s| s.worker == worker)
                        .then(|| records.remove(&grant.id))
                        .flatten();
                    drop(records);
                    if let Some(service) = stale {
                        service.stop().await;
                    }
                    return Err("provider_readiness_failed".into());
                }
            }
        }
        Ok(
            json!({"id":grant.id,"status":if port.is_some() {"ready"} else {"starting"},"secret_references":grant.secrets.values().collect::<Vec<_>>(),"credentials":grant.credentials}),
        )
    }
}

async fn request_output(config: &Config, command: Vec<String>) -> Result<Value, String> {
    use codex_sandboxing::seatbelt::{
        CreateSeatbeltCommandArgsParams, MACOS_PATH_TO_SEATBELT_EXECUTABLE,
        create_seatbelt_command_args,
    };
    use tokio::io::{AsyncBufReadExt, AsyncReadExt};
    let profile = config.permissions.effective_permission_profile();
    let argv = create_seatbelt_command_args(CreateSeatbeltCommandArgsParams {
        command,
        file_system_sandbox_policy: &profile.file_system_sandbox_policy(),
        network_sandbox_policy: profile.network_sandbox_policy(),
        sandbox_policy_cwd: config.cwd.as_path(),
        enforce_managed_network: false,
        managed_network: None,
        environment_id: None,
        network: None,
        extra_allow_unix_sockets: &[],
    })?;
    let mut child = tokio::process::Command::new(MACOS_PATH_TO_SEATBELT_EXECUTABLE)
        .args(argv)
        .current_dir(&config.cwd)
        .env_clear()
        .envs(config.permissions.shell_environment_policy.r#set.iter())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| error.to_string())?;
    struct Group(u32);
    impl Drop for Group {
        fn drop(&mut self) {
            let _ = codex_utils_pty::process_group::kill_process_group(self.0);
        }
    }
    let group = Group(child.id().ok_or("service_process_id_missing")?);
    let stdout = child.stdout.take().ok_or("service_stdout_missing")?;
    let mut line = Vec::new();
    tokio::io::BufReader::new(stdout)
        .take(196_609)
        .read_until(b'\n', &mut line)
        .await
        .map_err(|error| error.to_string())?;
    drop(group);
    let _ = child.wait().await;
    if line.len() > 196_608 || line.last() != Some(&b'\n') {
        return Err("service_response_limit_or_incomplete".into());
    }
    serde_json::from_slice(&line).map_err(|_| "service_response_invalid".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(root: &Path, name: &str) -> Session {
        let directory = root.join(name);
        std::fs::create_dir(&directory).unwrap();
        Session {
            task: Arc::new(
                Task::create(
                    codex_omd::Limits {
                        requests: 20,
                        exposure_microusd: 0,
                        seconds: 60,
                        concurrent_workers: 8,
                        max_depth: 2,
                    },
                    directory.join("ledger"),
                )
                .unwrap(),
            ),
            repository_identity: name.into(),
            evidence: directory.join("evidence"),
            scratch: directory.join("scratch"),
            contract: std::sync::Mutex::new(crate::contract::SessionContract::default()),
            contract_state: directory.join("contract.json"),
            processes: Arc::new(crate::managed_process::ManagedProcesses::default()),
            data: DataScope::default(),
            access: AccessState::default(),
        }
    }

    async fn insert(
        services: &Services,
        session: &Session,
        id: &str,
        owner: &str,
        generation: u64,
    ) -> (tokio::task::AbortHandle, PathBuf) {
        let worker = format!("{id}-{generation}");
        session
            .task
            .start_worker(
                worker.clone(),
                "lead".into(),
                1,
                codex_omd::WorkerLimits {
                    requests: 1,
                    exposure_microusd: 0,
                    seconds: 30,
                },
            )
            .unwrap();
        let job = tokio::spawn(std::future::pending::<Result<Value, String>>());
        let abort = job.abort_handle();
        let snapshot = tempfile::tempdir().unwrap();
        let path = snapshot.path().to_path_buf();
        services.records.lock().await.insert(
            id.into(),
            Service {
                mod_id: owner.into(),
                generation,
                route: None,
                job: Some(job),
                task: session.task.clone(),
                worker,
                _gateway: None,
                _snapshot: snapshot,
            },
        );
        (abort, path)
    }

    #[tokio::test]
    async fn stale_and_disabled_services_stop_and_release_their_ids() {
        let root = tempfile::tempdir().unwrap();
        let first = session(root.path(), "first");
        let other = session(root.path(), "other");
        let services = Services::default();
        let (stale, stale_path) = insert(&services, &first, "stale", "enabled", 1).await;
        let (disabled, disabled_path) = insert(&services, &first, "disabled", "disabled", 2).await;
        let (current, _) = insert(&services, &first, "current", "enabled", 2).await;
        let (foreign, _) = insert(&services, &other, "foreign", "enabled", 2).await;
        let (foreign_stale, _) = insert(&services, &other, "foreign-stale", "enabled", 1).await;
        let owners = BTreeMap::from([("enabled".to_owned(), "hash".to_owned())]);
        services.cleanup_stale(2, &owners).await;
        assert!(stale.is_finished() && disabled.is_finished() && foreign_stale.is_finished());
        assert!(!stale_path.exists() && !disabled_path.exists());
        assert!(!current.is_finished() && !foreign.is_finished());
        assert!(!services.records.lock().await.contains_key("stale"));
        let (replacement, _) = insert(&services, &first, "stale", "enabled", 2).await;
        services.cleanup_stale(2, &owners).await;
        assert!(!replacement.is_finished());
        services.cleanup_session(&first).await;
        assert!(current.is_finished() && replacement.is_finished());
        assert!(!foreign.is_finished());
        services.cleanup_session(&other).await;
    }
}
