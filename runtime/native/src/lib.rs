mod accounting;
mod execution;

use accounting::Account;
use accounting::Accounts;
use accounting::Rates;
use codex_core::StartThreadOptions;
use codex_core::ThreadManager;
use codex_core::config::Config;
use codex_extension_api::ExtensionData;
use codex_extension_api::ExtensionFuture;
use codex_extension_api::ExtensionRegistryBuilder;
use codex_extension_api::JsonToolOutput;
use codex_extension_api::ThreadIdleCause;
use codex_extension_api::ThreadIdleInput;
use codex_extension_api::ThreadLifecycleContributor;
use codex_extension_api::ThreadStartInput;
use codex_extension_api::ThreadStopInput;
use codex_extension_api::ToolCall;
use codex_extension_api::ToolContributor;
use codex_extension_api::ToolExecutor;
use codex_extension_api::ToolExecutorFuture;
use codex_extension_api::ToolOutput;
use codex_omd::FailureClass;
use codex_omd::Limits;
use codex_omd::Snapshot;
use codex_omd::Task;
use codex_omd::WorkerLimits;
use codex_protocol::ThreadId;
use codex_protocol::openai_models::ReasoningEffort;
use codex_tools::FunctionCallError;
use codex_tools::JsonSchema;
use codex_tools::ResponsesApiTool;
use codex_tools::ToolExposure;
use codex_tools::ToolName;
use codex_tools::ToolSpec;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Weak;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    repository: PathBuf,
    evidence: PathBuf,
    scratch: PathBuf,
    authorization: PathBuf,
    authorization_sha256: String,
    repository_identity: String,
    approved_untracked: Vec<String>,
    limits: Limits,
    worker_limits: WorkerLimits,
    lead_policy: LeadPolicy,
    leads: LeadRoutes,
    context_policy: WorkerContextPolicy,
    escalation: EscalationPolicy,
    worker: Route,
    check_command: Vec<String>,
    toolchain_reads: Vec<PathBuf>,
    snapshot_bytes: usize,
    max_request_bytes: usize,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct EscalationPolicy {
    allowed_failure_classes: Vec<FailureClass>,
    max_attempts: u32,
    evidence_bytes: usize,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Route {
    provider: String,
    model: String,
    reasoning_effort: ReasoningEffort,
    responses_url: String,
    rates: Rates,
}

#[derive(Clone, Copy, Debug, Deserialize, serde::Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum LeadName {
    Sol,
    Astra,
}

impl LeadName {
    fn as_str(self) -> &'static str {
        match self {
            Self::Sol => "sol",
            Self::Astra => "astra",
        }
    }

    fn opposite(self) -> Self {
        match self {
            Self::Sol => Self::Astra,
            Self::Astra => Self::Sol,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum LeadPolicy {
    Fixed { lead: LeadName },
    TaskEntry,
}

impl LeadPolicy {
    fn name(&self) -> &'static str {
        match self {
            Self::Fixed { .. } => "fixed",
            Self::TaskEntry => "task_entry",
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct LeadRoutes {
    sol: Route,
    astra: Route,
}

impl LeadRoutes {
    fn get(&self, lead: LeadName) -> &Route {
        match lead {
            LeadName::Sol => &self.sol,
            LeadName::Astra => &self.astra,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PacketReference {
    path: PathBuf,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum WorkerContextPolicy {
    FocusedBrief {
        max_bytes: usize,
    },
    SharedTaskPacket {
        max_bytes: usize,
        packet: PacketReference,
    },
    ParentHistory {
        max_bytes: usize,
    },
}

impl WorkerContextPolicy {
    fn name(&self) -> &'static str {
        match self {
            Self::FocusedBrief { .. } => "focused_brief",
            Self::SharedTaskPacket { .. } => "shared_task_packet",
            Self::ParentHistory { .. } => "parent_history",
        }
    }

    fn max_bytes(&self) -> usize {
        match self {
            Self::FocusedBrief { max_bytes }
            | Self::SharedTaskPacket { max_bytes, .. }
            | Self::ParentHistory { max_bytes } => *max_bytes,
        }
    }
}

struct Extension(Arc<Host>);

impl std::ops::Deref for Extension {
    type Target = Host;
    fn deref(&self) -> &Host {
        &self.0
    }
}

struct Host {
    manifest: Manifest,
    task: Arc<Task>,
    accounts: Arc<Accounts>,
    manager: Weak<ThreadManager>,
    contribution_started: std::sync::atomic::AtomicBool,
    operation: std::sync::atomic::AtomicBool,
}

struct OperationGuard<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

#[derive(Clone)]
struct Lead {
    thread: ThreadId,
    route: LeadName,
    host: Arc<Host>,
}

struct ContributionTool(Arc<Lead>);

struct EscalationTool(Arc<Lead>);

pub fn install(
    registry: &mut ExtensionRegistryBuilder<Config>,
    manager: Weak<ThreadManager>,
) -> Result<(), String> {
    let Some(path) = std::env::var_os("OMD_CONTROLLED_MANIFEST") else {
        return Ok(());
    };
    if !cfg!(target_os = "macos") {
        return Err("controlled delegation currently requires macOS".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 65_536 {
        return Err("controlled manifest exceeds limit".into());
    }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if manifest.leads.sol.model != "gpt-5.6-sol"
        || manifest.leads.astra.model != "gpt-6-astra"
        || manifest.worker.model != "muse-spark-1.3-contributor"
        || manifest.check_command.is_empty()
        || manifest.snapshot_bytes == 0
        || manifest.max_request_bytes == 0
        || manifest.context_policy.max_bytes() == 0
        || manifest.context_policy.max_bytes() > manifest.max_request_bytes
        || manifest.escalation.max_attempts == 0
        || manifest.escalation.evidence_bytes == 0
        || manifest.escalation.evidence_bytes > manifest.max_request_bytes
        || manifest.escalation.allowed_failure_classes.is_empty()
        || manifest
            .escalation
            .allowed_failure_classes
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != manifest.escalation.allowed_failure_classes.len()
    {
        return Err("invalid controlled-delegation assignments or limits".into());
    }
    if manifest
        .repository
        .canonicalize()
        .map_err(|e| e.to_string())?
        != manifest.repository
        || manifest.evidence.starts_with(&manifest.repository)
        || manifest.scratch != manifest.repository.join(".omd")
        || manifest
            .evidence
            .parent()
            .ok_or("evidence parent missing")?
            .canonicalize()
            .map_err(|e| e.to_string())?
            != manifest
                .evidence
                .parent()
                .ok_or("evidence parent missing")?
        || manifest
            .authorization
            .canonicalize()
            .map_err(|e| e.to_string())?
            != manifest.authorization
        || manifest.authorization.starts_with(&manifest.repository)
    {
        return Err(
            "manifest requires canonical source, external evidence, and in-scope scratch".into(),
        );
    }
    if let WorkerContextPolicy::SharedTaskPacket { packet, .. } = &manifest.context_policy {
        let canonical = packet.path.canonicalize().map_err(|e| e.to_string())?;
        if canonical != packet.path || packet.path.starts_with(&manifest.repository) {
            return Err("shared task packet must be canonical and host-owned".into());
        }
    }
    let task = Arc::new(
        Task::create(manifest.limits.clone(), manifest.evidence.clone())
            .map_err(|e| e.to_string())?,
    );
    let accounts = Arc::new(Accounts::default());
    codex_api::request_observer::install_response_observer(accounts.clone())
        .map_err(str::to_owned)?;
    let host = Arc::new(Host {
        manifest,
        task,
        accounts,
        manager,
        contribution_started: std::sync::atomic::AtomicBool::new(false),
        operation: std::sync::atomic::AtomicBool::new(false),
    });
    let _ = host.authorize();
    let deadline_host = host.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(
            deadline_host.manifest.limits.seconds,
        ))
        .await;
        deadline_host.stop_tree().await;
    });
    registry.thread_lifecycle_contributor(Arc::new(Extension(host.clone())));
    registry.tool_contributor(Arc::new(Extension(host)));
    Ok(())
}

impl Host {
    fn route(&self, lead: LeadName) -> &Route {
        self.manifest.leads.get(lead)
    }

    fn resolve_lead(&self, config: &Config) -> Option<LeadName> {
        let matches = |lead| {
            let route = self.route(lead);
            config.model.as_deref() == Some(route.model.as_str())
                && config.model_provider_id == route.provider
                && config.model_reasoning_effort.as_ref() == Some(&route.reasoning_effort)
        };
        match self.manifest.lead_policy {
            LeadPolicy::Fixed { lead } => matches(lead).then_some(lead),
            LeadPolicy::TaskEntry => [LeadName::Sol, LeadName::Astra]
                .into_iter()
                .find(|lead| matches(*lead)),
        }
    }

    async fn stop_tree(&self) {
        let _ = self.task.stop();
        let threads: Vec<_> = self
            .accounts
            .0
            .lock()
            .map(|v| v.keys().cloned().collect())
            .unwrap_or_default();
        if let Some(manager) = self.manager.upgrade() {
            for id in threads {
                if let Ok(id) = ThreadId::from_string(&id)
                    && let Ok(thread) = manager.get_thread(id).await
                {
                    let _ = thread.submit(codex_protocol::protocol::Op::Interrupt).await;
                    let _ = thread
                        .submit(codex_protocol::protocol::Op::CleanBackgroundTerminals)
                        .await;
                }
            }
        }
    }

    fn authorize(&self) -> Result<(), String> {
        let allowed = accounting::authorized(
            &self.manifest.authorization,
            &self.manifest.authorization_sha256,
            &self.manifest.repository_identity,
        );
        self.task
            .set_contributor_authorization(
                allowed,
                &self.manifest.authorization.display().to_string(),
            )
            .map_err(|e| e.to_string())?;
        if !allowed {
            return Err("Contributor repository authorization revoked or absent".into());
        }
        Ok(())
    }

    fn enroll(&self, thread: ThreadId, owner: &str, route: &Route) -> Result<(), String> {
        let account = Account {
            task: self.task.clone(),
            owner: owner.into(),
            model: route.model.clone(),
            provider: if owner == "contributor" {
                "meta"
            } else {
                "openai"
            }
            .into(),
            url: route.responses_url.clone(),
            max_request_bytes: self.manifest.max_request_bytes,
            rates: route.rates.clone(),
            authorization: self.manifest.authorization.clone(),
            authorization_sha256: self.manifest.authorization_sha256.clone(),
            repository_identity: self.manifest.repository_identity.clone(),
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

    fn evidence(&self, name: &str, value: &Value) -> Result<Value, String> {
        use std::io::Write;
        let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        let path = self.manifest.evidence.join(name);
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
}

impl ThreadLifecycleContributor<Config> for Extension {
    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if input.config.cwd.as_path() != self.manifest.repository {
                return;
            }
            let Some(route_name) = self.resolve_lead(input.config) else {
                return;
            };
            let route = self.route(route_name);
            if let Ok(thread) = ThreadId::from_string(input.thread_store.level_id())
                && self.enroll(thread, "lead", route).is_ok()
            {
                input.thread_store.insert(Lead {
                    thread,
                    route: route_name,
                    host: self.0.clone(),
                });
            }
        })
    }

    fn on_thread_idle<'a>(&'a self, input: ThreadIdleInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if input.thread_store.get::<Lead>().is_some()
                && matches!(
                    input.cause,
                    ThreadIdleCause::Interrupted | ThreadIdleCause::Failed
                )
            {
                self.stop_tree().await;
            }
        })
    }

    fn on_thread_stop<'a>(&'a self, input: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if input.thread_store.get::<Lead>().is_some() {
                let _ = self.task.stop();
            }
        })
    }
}

impl ToolContributor for Extension {
    fn tools(
        &self,
        _: &ExtensionData,
        thread: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        let Some(lead) = thread.get::<Lead>() else {
            return Vec::new();
        };
        let mut tools: Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> =
            vec![Arc::new(EscalationTool(lead.clone()))];
        if accounting::authorized(
            &self.manifest.authorization,
            &self.manifest.authorization_sha256,
            &self.manifest.repository_identity,
        ) {
            tools.push(Arc::new(ContributionTool(lead)));
        }
        tools
    }
}

impl<'call> ToolExecutor<ToolCall<'call>> for ContributionTool {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("omd_contribute")
    }
    fn spec(&self) -> ToolSpec {
        let mut properties = BTreeMap::new();
        let required = match self.0.host.manifest.context_policy {
            WorkerContextPolicy::FocusedBrief { .. } => {
                properties.insert(
                    "brief".into(),
                    JsonSchema::string(Some("Focused bounded task brief.".into())),
                );
                properties.insert(
                    "selected_evidence".into(),
                    JsonSchema::array(
                        JsonSchema::string(Some("Repository-relative tracked path.".into())),
                        Some("Selected source evidence to include with hashes.".into()),
                    ),
                );
                Some(vec!["brief".into(), "selected_evidence".into()])
            }
            WorkerContextPolicy::SharedTaskPacket { .. } => None,
            WorkerContextPolicy::ParentHistory { .. } => {
                properties.insert(
                    "brief".into(),
                    JsonSchema::string(Some("Bounded assignment within parent history.".into())),
                );
                Some(vec!["brief".into()])
            }
        };
        ToolSpec::Function(ResponsesApiTool {
            name: "omd_contribute".into(),
            description: format!(
                "Delegate one bounded implementation to isolated Muse Contributor using the configured {} context. Host runs configured checks and separate opposite-lead review, rejects conflicts, and integrates only accepted changes. All attempts use the shared task allowance.",
                self.0.host.manifest.context_policy.name()
            ),
            strict: false,
            defer_loading: None,
            output_schema: None,
            parameters: JsonSchema::object(properties, required, Some(false.into())),
        })
    }
    fn exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }
    fn handle<'a>(&'a self, call: ToolCall<'call>) -> ToolExecutorFuture<'a>
    where
        'call: 'a,
    {
        Box::pin(async move {
            let request: execution::ContributionRequest =
                serde_json::from_str(call.function_arguments()?)
                    .map_err(|e| FunctionCallError::RespondToModel(e.to_string()))?;
            if self
                .0
                .host
                .operation
                .swap(true, std::sync::atomic::Ordering::AcqRel)
            {
                return Err(FunctionCallError::RespondToModel(
                    "another controlled operation is active".into(),
                ));
            }
            let _operation = OperationGuard(&self.0.host.operation);
            if self
                .0
                .host
                .contribution_started
                .swap(true, std::sync::atomic::Ordering::AcqRel)
            {
                return Err(FunctionCallError::RespondToModel(
                    "one controlled contribution is permitted per task".into(),
                ));
            }
            let result = execution::contribute(&self.0, &call, request).await;
            let value = match result {
                Ok(value) => value,
                Err(error) => json!({"status": "failed", "error": error}),
            };
            let reference = self
                .0
                .host
                .evidence(
                    &format!(
                        "worker-result-{}.json",
                        execution::hash(call.call_id.as_bytes())
                    ),
                    &value,
                )
                .map_err(FunctionCallError::RespondToModel)?;
            Ok(Box::new(JsonToolOutput::new(
                json!({"result": value, "evidence": reference}),
            )) as Box<dyn ToolOutput>)
        })
    }
}

impl<'call> ToolExecutor<ToolCall<'call>> for EscalationTool {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("omd_escalate")
    }

    fn spec(&self) -> ToolSpec {
        let mut properties = BTreeMap::new();
        properties.insert(
            "failure_class".into(),
            JsonSchema::string(Some(
                "One of environment, edit, diagnosis, or model.".into(),
            )),
        );
        properties.insert(
            "summary".into(),
            JsonSchema::string(Some("Concise description of what failed.".into())),
        );
        properties.insert(
            "call_ids".into(),
            JsonSchema::array(
                JsonSchema::string(Some("Prior failed tool call ID.".into())),
                Some("Prior calls whose exact inputs and outputs support the failure.".into()),
            ),
        );
        ToolSpec::Function(ResponsesApiTool {
            name: "omd_escalate".into(),
            description: format!(
                "Preserve cited failure evidence and request one bounded opposite-lead consultation when permitted. The host classifies environment, edit, diagnosis, and model failures separately, keeps existing permissions, and charges the shared remaining allowance. Allowed classes: {}.",
                self.0
                    .host
                    .manifest
                    .escalation
                    .allowed_failure_classes
                    .iter()
                    .map(|class| format!("{class:?}").to_lowercase())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            strict: false,
            defer_loading: None,
            output_schema: None,
            parameters: JsonSchema::object(
                properties,
                Some(vec![
                    "failure_class".into(),
                    "summary".into(),
                    "call_ids".into(),
                ]),
                Some(false.into()),
            ),
        })
    }

    fn exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn handle<'a>(&'a self, call: ToolCall<'call>) -> ToolExecutorFuture<'a>
    where
        'call: 'a,
    {
        Box::pin(async move {
            let request: execution::EscalationRequest =
                serde_json::from_str(call.function_arguments()?)
                    .map_err(|e| FunctionCallError::RespondToModel(e.to_string()))?;
            if self
                .0
                .host
                .operation
                .swap(true, std::sync::atomic::Ordering::AcqRel)
            {
                return Err(FunctionCallError::RespondToModel(
                    "another controlled operation is active".into(),
                ));
            }
            let _operation = OperationGuard(&self.0.host.operation);
            let result = execution::escalate(&self.0, &call, request).await;
            let value = match result {
                Ok(value) => value,
                Err(error) => json!({"status": "failed", "error": error}),
            };
            let reference = self
                .0
                .host
                .evidence(
                    &format!(
                        "escalation-result-{}.json",
                        execution::hash(call.call_id.as_bytes())
                    ),
                    &value,
                )
                .map_err(FunctionCallError::RespondToModel)?;
            Ok(Box::new(JsonToolOutput::new(
                json!({"result": value, "evidence": reference}),
            )) as Box<dyn ToolOutput>)
        })
    }
}
