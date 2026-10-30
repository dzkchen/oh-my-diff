use super::*;
use codex_protocol::models::PermissionProfile;
use codex_protocol::models::PermissionProfileSnapshot;
use codex_protocol::permissions::FileSystemAccessMode;
use codex_protocol::permissions::FileSystemPath;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use std::collections::BTreeSet;
use std::path::Path;
use std::time::Duration;

const SERVICE_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

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

/// Defines the provider of each loopback provider grant of an active mod for this process; configured providers keep precedence.
pub(crate) fn define_providers(config: &crate::config::HostConfig, active: impl Fn(&str) -> bool) {
    for grant in &config.services {
        let Some(route) = grant.route.as_ref().filter(|_| active(&grant.mod_id)) else {
            continue;
        };
        let Some(base_url) = route
            .responses_url
            .strip_suffix("/responses")
            .filter(|url| url.starts_with("http://127.0.0.1:"))
        else {
            continue;
        };
        let token = grant
            .secrets
            .values()
            .next()
            .filter(|_| grant.secrets.len() == 1)
            .and_then(|reference| config.secret_refs.get(reference))
            .filter(|path| {
                std::fs::symlink_metadata(path)
                    .is_ok_and(|metadata| metadata.is_file() && metadata.len() <= 4096)
            })
            .and_then(|path| std::fs::read_to_string(path).ok())
            .map(|token| token.trim().to_string().into());
        codex_model_provider_info::set_runtime_provider(
            &route.provider,
            Some(codex_model_provider_info::ModelProviderInfo {
                name: route.provider.clone(),
                base_url: Some(base_url.to_string()),
                experimental_bearer_token: token,
                request_max_retries: Some(0),
                stream_max_retries: Some(0),
                ..Default::default()
            }),
        );
    }
}

impl Grant {
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
    started_at_ms: u64,
    route: Option<Route>,
    job: Option<tokio::task::JoinHandle<Result<Value, String>>>,
    task: Arc<Task>,
    worker: String,
    _gateway: Option<crate::credential_gateway::Registration>,
    _snapshot: tempfile::TempDir,
}

impl Drop for Service {
    fn drop(&mut self) {
        if let Some(route) = &self.route {
            codex_models_manager::runtime_models::set(&route.provider, Vec::new());
            codex_models_manager::runtime_models::set_name(&route.provider, None);
        }
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

    async fn publish_models(
        &self,
        mod_id: &str,
        generation: u64,
        arguments: Value,
    ) -> Result<Value, String> {
        use codex_protocol::openai_models::ReasoningEffort;
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Model {
            slug: String,
            display: String,
            context_window: i64,
            efforts: Vec<ReasoningEffort>,
            #[serde(default)]
            default_effort: Option<ReasoningEffort>,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            provider: String,
            #[serde(default)]
            name: Option<String>,
            models: Vec<Model>,
        }
        let input: Input = serde_json::from_value(arguments).map_err(|e| e.to_string())?;
        if input.models.len() > 16 {
            return Err("provider_model_limit".into());
        }
        if input
            .name
            .as_ref()
            .is_some_and(|name| name.trim().is_empty() || name.len() > 64)
        {
            return Err("provider_name_invalid".into());
        }
        let mut models = Vec::with_capacity(input.models.len());
        for model in input.models {
            if model.slug.is_empty()
                || model.slug.len() > 64
                || !model
                    .slug
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
                || model.display.trim().is_empty()
                || model.display.len() > 64
                || !(1..=10_000_000).contains(&model.context_window)
                || model.efforts.len() > 8
                || model
                    .default_effort
                    .as_ref()
                    .is_some_and(|effort| !model.efforts.contains(effort))
                || models
                    .iter()
                    .any(|known: &codex_protocol::openai_models::ModelInfo| {
                        known.slug == model.slug
                    })
                || codex_models_manager::runtime_models::find(&model.slug)
                    .is_some_and(|(owner, _)| owner != input.provider)
            {
                return Err(format!("provider_model_invalid: {}", model.slug));
            }
            let mut info = codex_models_manager::model_info::model_info_from_slug(&model.slug);
            info.display_name = model.display;
            info.context_window = Some(model.context_window);
            info.max_context_window = Some(model.context_window);
            info.auto_compact_token_limit = Some(model.context_window / 10 * 9);
            info.default_reasoning_level = model
                .default_effort
                .or_else(|| model.efforts.first().cloned());
            info.supported_reasoning_levels = model
                .efforts
                .into_iter()
                .map(
                    |effort| codex_protocol::openai_models::ReasoningEffortPreset {
                        description: effort.to_string(),
                        effort,
                    },
                )
                .collect();
            info.visibility = codex_protocol::openai_models::ModelVisibility::List;
            info.apply_patch_tool_type =
                Some(codex_protocol::openai_models::ApplyPatchToolType::Freeform);
            info.truncation_policy =
                codex_protocol::openai_models::TruncationPolicyConfig::tokens(10_000);
            info.supports_search_tool = true;
            info.multi_agent_version = Some(codex_protocol::protocol::MultiAgentVersion::V2);
            info.used_fallback_model_metadata = false;
            models.push(info);
        }
        let records = self.records.lock().await;
        if !records.values().any(|service| {
            service.mod_id == mod_id
                && service.generation == generation
                && !service.finished()
                && service
                    .route
                    .as_ref()
                    .is_some_and(|route| route.provider == input.provider)
        }) {
            return Err("provider_not_registered_or_stopped".into());
        }
        let count = models.len();
        codex_models_manager::runtime_models::set_name(&input.provider, input.name);
        codex_models_manager::runtime_models::set(&input.provider, models);
        drop(records);
        Ok(json!({"provider": input.provider, "models": count}))
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
        if request.operation == "providers.models" {
            return self
                .publish_models(mod_id, generation, request.arguments)
                .await;
        }
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
            return Ok(
                json!({"id":selection.id,"running":!record.finished(),"started_at_ms":record.started_at_ms}),
            );
        }
        if records.contains_key(&selection.id) {
            return Err("service_already_registered".into());
        }
        let host = &lead.host;
        let current = host.route_config().0;
        define_providers(&current, |id| id == mod_id);
        let mut grant = current
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
        config.permissions.file_system_helper_sandbox = false;
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
            let path = current
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
            let (url, registration) = crate::credential_gateway::register(
                host.root.clone(),
                mod_id.to_owned(),
                grant.credentials.clone(),
            )
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
            if !(config.model_providers.contains_key(&route.provider)
                || codex_model_provider_info::runtime_provider(&route.provider).is_some())
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
        let output_bytes = SERVICE_OUTPUT_BYTES;
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
                started_at_ms: codex_omd::peers::now_ms(),
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

#[cfg(not(target_os = "macos"))]
async fn request_output(_config: &Config, _command: Vec<String>) -> Result<Value, String> {
    Err("service_sandbox_unavailable".into())
}

#[cfg(target_os = "macos")]
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

    #[test]
    fn loopback_provider_grants_define_their_provider() {
        let store = tempfile::tempdir().unwrap();
        let token = store.path().join("local-token");
        std::fs::write(&token, "local-secret\n").unwrap();
        let rates = json!({"input_microusd_per_million": 0, "cached_microusd_per_million": 0,
            "output_microusd_per_million": 0, "reservation_microusd": 0, "max_output_tokens": 1,
            "input_token_ceiling": 1, "included_subscription": true});
        let grant = |id: &str, url: &str| {
            json!({"id": id, "mod_id": "m", "program": "/bin/sh",
            "program_sha256": "0", "secrets": {"TOKEN": "local"}, "route": {"name": id,
            "provider": format!("{id}_provider"), "model": "m1", "reasoning_effort": "high",
            "responses_url": url, "rates": rates}})
        };
        let config: crate::config::HostConfig = serde_json::from_value(json!({
            "secret_refs": {"local": token},
            "services": [grant("loopback", "http://127.0.0.1:4321/v1/responses"),
                grant("remote", "https://example.com/v1/responses")]}))
        .unwrap();
        define_providers(&config, |_| true);
        let provider = codex_model_provider_info::runtime_provider("loopback_provider").unwrap();
        assert_eq!(
            provider.base_url.as_deref(),
            Some("http://127.0.0.1:4321/v1")
        );
        assert_eq!(
            provider
                .experimental_bearer_token
                .map(|token| token.into_inner())
                .as_deref(),
            Some("local-secret")
        );
        assert!(!provider.requires_openai_auth && !provider.supports_websockets);
        assert!(codex_model_provider_info::runtime_provider("remote_provider").is_none());
    }

    #[tokio::test]
    async fn endpoint_handoff_reads_only_the_granted_file() {
        let home = tempfile::tempdir().unwrap();
        let repository = tempfile::tempdir().unwrap();
        let user_temp = std::process::Command::new("/usr/bin/getconf")
            .arg("DARWIN_USER_TEMP_DIR")
            .output()
            .unwrap()
            .stdout;
        let store = tempfile::tempdir_in(String::from_utf8(user_temp).unwrap().trim()).unwrap();
        let root = repository.path().canonicalize().unwrap();
        let store = store.path().canonicalize().unwrap();
        let endpoint = store.join("pane.json");
        let private = store.join("vault.json");
        std::fs::write(&endpoint, "endpoint-token\n").unwrap();
        std::fs::write(&private, "private-cookie").unwrap();
        let parent = Config::load_default_with_cli_overrides_for_codex_home(
            home.path().canonicalize().unwrap(),
            vec![],
        )
        .await
        .unwrap();
        let config =
            execution::isolated(&parent, &root, std::slice::from_ref(&endpoint), &[], false)
                .unwrap();
        let output = request_output(&config, vec!["/bin/sh".into(), "-c".into(),
            "value=$(cat \"$1\") || exit 10; if cat \"$2\"; then exit 11; fi; if printf bad > \"$1\"; then exit 12; fi; printf '{\"exit_code\":0,\"stdout\":\"%s\"}\\n' \"$value\"".into(),
            "check".into(), endpoint.display().to_string(), private.display().to_string()]).await.unwrap();
        assert_eq!(output["exit_code"], 0, "{output}");
        assert_eq!(output["stdout"], "endpoint-token");
        assert_eq!(
            std::fs::read_to_string(&endpoint).unwrap(),
            "endpoint-token\n"
        );
        let denied = execution::isolated(
            &parent,
            &root,
            std::slice::from_ref(&endpoint),
            &[store],
            false,
        )
        .unwrap();
        let output = request_output(
            &denied,
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "if cat \"$1\"; then printf '{\"stdout\":\"leaked\"}\\n'; else printf '{\"stdout\":\"denied\"}\\n'; fi".into(),
                "check".into(),
                endpoint.display().to_string(),
            ],
        )
        .await
        .unwrap();
        assert_eq!(output["stdout"], "denied");
    }
}
