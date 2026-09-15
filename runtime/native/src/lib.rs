mod accounting;
mod execution;

#[cfg(test)]
#[path = "review_tests.rs"]
mod review_tests;

use accounting::Account;
use accounting::Accounts;
use accounting::Rates;
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
use codex_extension_api::ThreadIdleCause;
use codex_extension_api::ThreadIdleInput;
use codex_extension_api::ThreadLifecycleContributor;
use codex_extension_api::ThreadStartInput;
use codex_extension_api::ThreadStopInput;
use codex_extension_api::ToolCall;
use codex_extension_api::ToolCallOutcome;
use codex_extension_api::ToolContributor;
use codex_extension_api::ToolExecutor;
use codex_extension_api::ToolExecutorFuture;
use codex_extension_api::ToolFinishInput;
use codex_extension_api::ToolLifecycleContributor;
use codex_extension_api::ToolLifecycleFuture;
use codex_extension_api::ToolOutput;
use codex_extension_api::ToolReactionContributor;
use codex_extension_api::ToolStartInput;
use codex_extension_api::TurnContextContributionInput;
use codex_extension_api::TurnItemContributor;
use codex_omd::ActiveGuideline;
use codex_omd::CheckpointUpdate;
use codex_omd::FailureClass;
use codex_omd::GuidelineStore;
use codex_omd::KnowledgeMode;
use codex_omd::KnowledgeSession;
use codex_omd::KnowledgeStore;
use codex_omd::Limits;
use codex_omd::LiveState;
use codex_omd::LspLanguage;
use codex_omd::LspLimits;
use codex_omd::LspPosition;
use codex_omd::LspPreferenceStore;
use codex_omd::LspRange;
use codex_omd::LspSession;
use codex_omd::ProcessSnapshot;
use codex_omd::ProcessStatus;
use codex_omd::ReactiveRuleSet;
use codex_omd::ReactiveRules;
use codex_omd::ReactiveToolOutcome;
use codex_omd::ReactiveTrigger;
use codex_omd::ReviewPolicy;
use codex_omd::Snapshot;
use codex_omd::Task;
use codex_omd::TaskContract;
use codex_omd::UnifiedReview;
use codex_omd::VersionMarker;
use codex_omd::WorkerLimits;
use codex_omd::WorkerReport;
use codex_omd::WorkerReportStatus;
use codex_protocol::ThreadId;
use codex_protocol::items::TurnItem;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ReasoningEffort;
use codex_protocol::protocol::SessionSource;
use codex_protocol::protocol::SubAgentSource;
use codex_protocol::turn_input::TurnStartOptions;
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
    #[serde(default)]
    guideline_store: Option<PathBuf>,
    #[serde(default)]
    knowledge: Option<KnowledgePolicy>,
    #[serde(default)]
    lsp: Option<LspPolicy>,
    #[serde(default)]
    communication: CommunicationPolicy,
    #[serde(default)]
    reactive_rules: Option<PacketReference>,
    #[serde(default)]
    review: ReviewPolicy,
    checkpoint: TaskContract,
    legitimate_wait_tools: Vec<String>,
    lifecycle: LifecyclePolicy,
    recovery: RecoveryPolicy,
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
struct LifecyclePolicy {
    explicit_resume: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveryPolicy {
    contributor_attempts: u32,
    equivalent_failure_threshold: u32,
    fallback_to_opposite_lead: bool,
}

#[derive(Clone, Debug, Default, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct CommunicationPolicy {
    concise_user_updates: bool,
    structured_worker_reports: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct KnowledgePolicy {
    store: PathBuf,
    mode: KnowledgeMode,
    max_context_bytes: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LspPolicy {
    preference_store: PathBuf,
    limits: LspLimits,
}

impl CommunicationPolicy {
    fn user_update_prompt(&self) -> Option<&'static str> {
        self.concise_user_updates.then(user_update_prompt)
    }

    fn worker_output_schema(&self) -> Option<Value> {
        self.structured_worker_reports.then(worker_report_schema)
    }

    fn review_output_schema(&self) -> Option<Value> {
        self.structured_worker_reports
            .then(|| review_schema(ReviewReportMode::Structured))
    }
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
    lead_completed: std::sync::atomic::AtomicBool,
    pending_calls: std::sync::Mutex<BTreeMap<String, PendingCall>>,
    active_guideline: Option<ActiveGuideline>,
    knowledge_prompt: Option<String>,
    lsp: Option<std::sync::Mutex<LspRuntime>>,
    reactive_rules: Option<ReactiveRules>,
    review: std::sync::Mutex<ReviewRuntime>,
}

#[derive(Clone)]
struct PendingCall {
    signature_sha256: String,
    legitimate_wait: bool,
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
    owner: String,
    depth: u32,
    host: Arc<Host>,
}

struct ContributionTool(Arc<Lead>);

struct EscalationTool(Arc<Lead>);

struct CheckpointTool(Arc<Lead>);

struct LspTool(Arc<Lead>);

struct ReviewTool(Arc<Lead>);

struct ReviewRuntime {
    ledger: UnifiedReview,
    candidates: BTreeMap<String, Snapshot>,
}

struct LspRuntime {
    repository: PathBuf,
    limits: LspLimits,
    sessions: BTreeMap<LspLanguage, LspSession>,
    check_cache: BTreeMap<String, Value>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum LspRequest {
    Status,
    Sync {
        language: LspLanguage,
        paths: Vec<String>,
    },
    Definition {
        language: LspLanguage,
        path: String,
        position: LspPosition,
    },
    References {
        language: LspLanguage,
        path: String,
        position: LspPosition,
        #[serde(default)]
        include_declaration: bool,
    },
    CodeActions {
        language: LspLanguage,
        path: String,
        range: LspRange,
    },
    ApplyCodeAction {
        language: LspLanguage,
        action_value: Value,
        scope: Vec<String>,
        expected_versions: BTreeMap<String, Option<String>>,
    },
    RenameSymbol {
        language: LspLanguage,
        path: String,
        position: LspPosition,
        new_name: String,
        scope: Vec<String>,
        expected_versions: BTreeMap<String, Option<String>>,
    },
    RenameFile {
        language: LspLanguage,
        old_path: String,
        new_path: String,
        scope: Vec<String>,
        expected_versions: BTreeMap<String, Option<String>>,
    },
    IntermediateCheck {
        paths: Vec<String>,
    },
}

impl LspRuntime {
    fn session(&mut self, language: LspLanguage) -> Result<&mut LspSession, Value> {
        self.sessions
            .retain(|_, session| !session.is_idle() && session.is_running());
        if !self.sessions.contains_key(&language) {
            let session =
                LspSession::start(self.repository.clone(), language, self.limits.clone(), None)
                    .map_err(|fallback| {
                        serde_json::to_value(fallback).unwrap_or_else(
                            |error| json!({"status": "failed", "error": error.to_string()}),
                        )
                    })?;
            self.sessions.insert(language, session);
        }
        self.sessions
            .get_mut(&language)
            .ok_or_else(|| json!({"status": "failed", "error": "language server session missing"}))
    }

    fn sync_open_documents(&mut self) {
        self.sessions
            .retain(|_, session| !session.is_idle() && session.is_running());
        for session in self.sessions.values_mut() {
            let _ = session.sync_open_documents();
        }
    }
}

fn lsp_result(runtime: &mut LspRuntime, request: LspRequest) -> Value {
    let result = match request {
        LspRequest::Status => {
            runtime
                .sessions
                .retain(|_, session| !session.is_idle() && session.is_running());
            return json!({
                "schema": 1,
                "status": "ready",
                "opt_in": "enabled",
                "installed_servers": codex_omd::detect_installed_servers(),
                "active_sessions": runtime.sessions.iter().map(|(language, session)| (language, session.capabilities())).collect::<BTreeMap<_, _>>(),
                "limits": runtime.limits,
                "auto_install": false,
            });
        }
        LspRequest::Sync { language, paths } => runtime
            .session(language)
            .and_then(|session| {
                session
                    .sync(&paths)
                    .map_err(|error| json!({"status": "failed", "error": error.to_string()}))
            })
            .and_then(|value| {
                serde_json::to_value(value)
                    .map_err(|error| json!({"status": "failed", "error": error.to_string()}))
            }),
        LspRequest::Definition {
            language,
            path,
            position,
        } => runtime.session(language).and_then(|session| {
            session
                .definition(&path, position)
                .map_err(|fallback| serde_json::to_value(fallback).expect("serializable fallback"))
        }),
        LspRequest::References {
            language,
            path,
            position,
            include_declaration,
        } => runtime.session(language).and_then(|session| {
            session
                .references(&path, position, include_declaration)
                .map_err(|fallback| serde_json::to_value(fallback).expect("serializable fallback"))
        }),
        LspRequest::CodeActions {
            language,
            path,
            range,
        } => runtime.session(language).and_then(|session| {
            session
                .code_actions(&path, range)
                .map_err(|fallback| serde_json::to_value(fallback).expect("serializable fallback"))
        }),
        LspRequest::ApplyCodeAction {
            language,
            action_value,
            scope,
            expected_versions,
        } => runtime
            .session(language)
            .and_then(|session| {
                session
                    .apply_code_action(&action_value, &scope, &expected_versions)
                    .map_err(|fallback| {
                        serde_json::to_value(fallback).expect("serializable fallback")
                    })
            })
            .and_then(|value| {
                serde_json::to_value(value)
                    .map_err(|error| json!({"status": "failed", "error": error.to_string()}))
            }),
        LspRequest::RenameSymbol {
            language,
            path,
            position,
            new_name,
            scope,
            expected_versions,
        } => runtime
            .session(language)
            .and_then(|session| {
                session
                    .rename_symbol(&path, position, &new_name, &scope, &expected_versions)
                    .map_err(|fallback| {
                        serde_json::to_value(fallback).expect("serializable fallback")
                    })
            })
            .and_then(|value| {
                serde_json::to_value(value)
                    .map_err(|error| json!({"status": "failed", "error": error.to_string()}))
            }),
        LspRequest::RenameFile {
            language,
            old_path,
            new_path,
            scope,
            expected_versions,
        } => runtime
            .session(language)
            .and_then(|session| {
                session
                    .rename_file(&old_path, &new_path, &scope, &expected_versions)
                    .map_err(|fallback| {
                        serde_json::to_value(fallback).expect("serializable fallback")
                    })
            })
            .and_then(|value| {
                serde_json::to_value(value)
                    .map_err(|error| json!({"status": "failed", "error": error.to_string()}))
            }),
        LspRequest::IntermediateCheck { .. } => unreachable!("checks are asynchronous"),
    };
    match result {
        Ok(value) => json!({"schema": 1, "status": "completed", "result": value}),
        Err(value) => value,
    }
}

async fn read_bounded(
    reader: impl tokio::io::AsyncRead + Unpin,
    limit: usize,
) -> Result<Vec<u8>, String> {
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    reader
        .take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| error.to_string())?;
    if bytes.len() > limit {
        return Err("intermediate check output exceeds limit".into());
    }
    Ok(bytes)
}

async fn execute_intermediate_check(
    check: codex_omd::IntermediateCheck,
    limits: &LspLimits,
) -> Value {
    use std::process::Stdio;
    let mut child = match tokio::process::Command::new(&check.program)
        .args(&check.arguments)
        .current_dir(&check.working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return json!({"schema": 1, "status": "failed", "check": check, "error": error.to_string()});
        }
    };
    let stdout = child.stdout.take().expect("piped check stdout");
    let stderr = child.stderr.take().expect("piped check stderr");
    let run = async {
        let (stdout, stderr, status) = tokio::join!(
            read_bounded(stdout, limits.max_check_output_bytes),
            read_bounded(stderr, limits.max_check_output_bytes),
            child.wait(),
        );
        Ok::<_, String>((stdout?, stderr?, status.map_err(|error| error.to_string())?))
    };
    match tokio::time::timeout(
        std::time::Duration::from_millis(limits.check_timeout_ms),
        run,
    )
    .await
    {
        Ok(Ok((stdout, stderr, status))) => json!({
            "schema": 1,
            "status": if status.success() { "passed" } else { "failed" },
            "check": check,
            "exit_code": status.code(),
            "stdout": String::from_utf8_lossy(&stdout),
            "stderr": String::from_utf8_lossy(&stderr),
            "cached": false,
        }),
        Ok(Err(error)) => json!({"schema": 1, "status": "failed", "check": check, "error": error}),
        Err(_) => {
            let _ = child.kill().await;
            json!({"schema": 1, "status": "timed_out", "check": check, "timeout_ms": limits.check_timeout_ms})
        }
    }
}

fn guideline_prompt(guideline: &ActiveGuideline) -> String {
    format!(
        "Maintainer-promoted simplicity guideline version {} with proposal SHA256 {}. It is subordinate to current user and project instructions and was frozen when this session started.\n{}",
        guideline.selection.version,
        guideline.selection.proposal_sha256,
        guideline.variant.render()
    )
}

fn knowledge_prompt(
    policy: &KnowledgePolicy,
    session: &KnowledgeSession,
) -> Result<String, String> {
    Ok(format!(
        "Host-owned repository knowledge store {}. {}",
        policy.store.display(),
        session.render().map_err(|error| error.to_string())?
    ))
}

fn user_update_prompt() -> &'static str {
    "For user-facing progress and final updates, use concise ordinary-language sentences. State the current outcome and next relevant action without telegraphic wording or a persona. Preserve the requested scope, distinguish verified facts from uncertainty, retain useful evidence references, and ask any clarification required for safe progress as a direct understandable question. Do not shorten away constraints, blockers, limitations, or incomplete work."
}

fn worker_report_prompt() -> &'static str {
    "Return only the structured worker report required by the response schema. Report the bounded scope actually handled, every material uncertainty, useful file/check/source evidence references, and every clarification the lead must obtain from the user. Use an empty array only when that category is genuinely absent. Use blocked status when progress requires clarification, partial when useful work remains, and completed only when no clarification is required."
}

fn review_report_prompt() -> &'static str {
    "Return only the review object required by the response schema. Keep the exact candidate SHA256, typed findings, and resolved finding IDs at the top level, and include the structured worker report in the report field. The nested report must preserve review scope, uncertainty, evidence references, and required clarification."
}

fn string_array_schema(max_items: u32) -> Value {
    json!({
        "type": "array",
        "items": {"type": "string", "minLength": 1},
        "maxItems": max_items,
        "uniqueItems": true
    })
}

fn worker_report_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "schema": {"type": "integer", "const": 1},
            "status": {"type": "string", "enum": ["completed", "partial", "blocked"]},
            "summary": {"type": "string", "minLength": 1, "maxLength": 4096},
            "scope": string_array_schema(32),
            "uncertainty": string_array_schema(32),
            "evidence": string_array_schema(64),
            "required_clarification": string_array_schema(16)
        },
        "required": ["schema", "status", "summary", "scope", "uncertainty", "evidence", "required_clarification"],
        "additionalProperties": false
    })
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ReviewReportMode {
    Plain,
    Structured,
}

fn review_schema(report_mode: ReviewReportMode) -> Value {
    let finding = json!({
        "type": "object",
        "properties": {
            "key": {"type": "string", "minLength": 1, "maxLength": 256},
            "severity": {"type": "string", "enum": ["advice", "warning", "blocking"]},
            "summary": {"type": "string", "minLength": 1, "maxLength": 4096},
            "paths": string_array_schema(128)
        },
        "required": ["key", "severity", "summary", "paths"],
        "additionalProperties": false
    });
    let mut schema = json!({
        "type": "object",
        "properties": {
            "candidate_sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
            "findings": {"type": "array", "items": finding, "maxItems": 256},
            "resolved_finding_ids": {"type": "array", "items": {"type": "integer", "minimum": 1}, "maxItems": 128, "uniqueItems": true}
        },
        "required": ["candidate_sha256", "findings", "resolved_finding_ids"],
        "additionalProperties": false
    });
    if report_mode == ReviewReportMode::Structured {
        schema["properties"]["report"] = worker_report_schema();
        schema["required"]
            .as_array_mut()
            .expect("required array")
            .push(json!("report"));
    }
    schema
}

fn capture_live_state(manifest: &Manifest, accounts: &Accounts) -> Result<LiveState, String> {
    let approved = manifest
        .approved_untracked
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    let paths =
        codex_omd::tracked_paths(&manifest.repository, &approved).map_err(|e| e.to_string())?;
    let snapshot =
        codex_omd::capture_tracked(&manifest.repository, &approved, manifest.snapshot_bytes)
            .map_err(|e| e.to_string())?;
    let processes = accounts
        .0
        .lock()
        .map_err(|_| "account lock poisoned")?
        .iter()
        .map(|(identity, account)| ProcessSnapshot {
            identity: identity.clone(),
            owner: account.owner.clone(),
            status: ProcessStatus::Running,
        })
        .collect();
    Ok(LiveState {
        workspace_sha256: snapshot.hash().map_err(|e| e.to_string())?,
        tracked_paths_sha256: execution::hash(
            &serde_json::to_vec(&paths).map_err(|e| e.to_string())?,
        ),
        processes,
    })
}

fn review_runtime(manifest: &Manifest) -> Result<ReviewRuntime, String> {
    let path = manifest.evidence.join("review-state.json");
    let ledger = if path.exists() {
        if manifest.lifecycle.explicit_resume.is_none() {
            return Err("existing review state requires explicit resume".into());
        }
        let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
        if bytes.len() > 8_388_608 {
            return Err("persisted review state exceeds limit".into());
        }
        UnifiedReview::restore(serde_json::from_slice(&bytes).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?
    } else {
        UnifiedReview::new(manifest.review.clone()).map_err(|error| error.to_string())?
    };
    if ledger.snapshot().policy != manifest.review {
        return Err("review policy changed across resume".into());
    }
    let mut candidates = BTreeMap::new();
    let snapshot = ledger.snapshot();
    let markers = snapshot
        .cycles
        .iter()
        .map(|cycle| &cycle.candidate)
        .chain(snapshot.repairs.iter().map(|repair| &repair.evidence));
    for marker in markers {
        if candidates.contains_key(&marker.sha256) {
            continue;
        }
        let path = PathBuf::from(&marker.evidence);
        if path.canonicalize().map_err(|error| error.to_string())? != path
            || !path.starts_with(&manifest.evidence)
        {
            return Err("persisted review candidate evidence is not host-owned".into());
        }
        let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
        if execution::hash(&bytes) != marker.evidence_sha256 {
            return Err("persisted review candidate evidence changed".into());
        }
        let candidate: Snapshot =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if candidate.hash().map_err(|error| error.to_string())? != marker.sha256 {
            return Err("persisted review candidate version changed".into());
        }
        candidates.insert(marker.sha256.clone(), candidate);
    }
    Ok(ReviewRuntime { ledger, candidates })
}

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
    manifest.review.validate().map_err(|e| e.to_string())?;
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
        || manifest.recovery.contributor_attempts == 0
        || manifest.recovery.equivalent_failure_threshold < 2
        || manifest.recovery.contributor_attempts < manifest.recovery.equivalent_failure_threshold
        || manifest.legitimate_wait_tools.len() > 16
        || manifest
            .legitimate_wait_tools
            .iter()
            .any(|name| name.is_empty() || name.len() > 128)
        || manifest
            .legitimate_wait_tools
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != manifest.legitimate_wait_tools.len()
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
    let reactive_rules = match &manifest.reactive_rules {
        Some(reference) => {
            let canonical = reference.path.canonicalize().map_err(|e| e.to_string())?;
            if canonical != reference.path || reference.path.starts_with(&manifest.repository) {
                return Err("reactive rules must be canonical and host-owned".into());
            }
            let bytes = std::fs::read(&reference.path).map_err(|e| e.to_string())?;
            if bytes.len() > 65_536 || execution::hash(&bytes) != reference.sha256 {
                return Err("reactive rule source changed or exceeds its bound".into());
            }
            let rule_set: ReactiveRuleSet =
                serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            Some(
                ReactiveRules::new(
                    rule_set,
                    reference.path.display().to_string(),
                    reference.sha256.clone(),
                )
                .map_err(|e| e.to_string())?,
            )
        }
        None => None,
    };
    let active_guideline = match &manifest.guideline_store {
        Some(path)
            if path.canonicalize().map_err(|e| e.to_string())? == *path
                && !path.starts_with(&manifest.repository) =>
        {
            GuidelineStore::open(path.clone())
                .and_then(|store| store.active())
                .map_err(|e| e.to_string())?
        }
        Some(_) => return Err("guideline store must be canonical and host-owned".into()),
        None => None,
    };
    let knowledge_session = match &manifest.knowledge {
        Some(policy)
            if policy.store.canonicalize().map_err(|e| e.to_string())? == policy.store
                && !policy.store.starts_with(&manifest.repository)
                && policy.max_context_bytes > 0
                && policy.max_context_bytes <= manifest.max_request_bytes =>
        {
            let store = KnowledgeStore::open(policy.store.clone()).map_err(|e| e.to_string())?;
            if store.repository_identity().map_err(|e| e.to_string())?
                != manifest.repository_identity
            {
                return Err("knowledge store repository identity mismatch".into());
            }
            Some(
                store
                    .session(&manifest.repository, policy.mode, policy.max_context_bytes)
                    .map_err(|e| e.to_string())?,
            )
        }
        Some(_) => return Err("knowledge store must be canonical, host-owned, and bounded".into()),
        None => None,
    };
    let lsp_enabled = match &manifest.lsp {
        Some(policy) => {
            policy
                .limits
                .validate()
                .map_err(|error| error.to_string())?;
            let parent = policy
                .preference_store
                .parent()
                .ok_or("LSP preference store parent missing")?;
            if parent.canonicalize().map_err(|error| error.to_string())? != parent
                || policy.preference_store.starts_with(&manifest.repository)
            {
                return Err("LSP preference store must be canonical and host-owned".into());
            }
            LspPreferenceStore::open(policy.preference_store.clone())
                .map_err(|error| error.to_string())?
                .preference(&manifest.repository_identity)
                .is_some_and(|preference| preference.enabled)
        }
        None => false,
    };
    let frozen_knowledge_prompt = match (&manifest.knowledge, &knowledge_session) {
        (Some(policy), Some(session)) => Some(knowledge_prompt(policy, session)?),
        _ => None,
    };
    if manifest.lifecycle.explicit_resume.is_some() && manifest.scratch.exists() {
        codex_omd::cleanup_owned_directory(&manifest.repository, &manifest.scratch)
            .map_err(|e| e.to_string())?;
    }
    let accounts = Arc::new(Accounts::default());
    let live = capture_live_state(&manifest, &accounts)?;
    let task = Arc::new(
        Task::open_checkpointed(
            manifest.limits.clone(),
            manifest.evidence.clone(),
            manifest.lifecycle.explicit_resume.as_deref(),
            manifest.checkpoint.clone(),
            live,
        )
        .map_err(|e| e.to_string())?,
    );
    codex_api::request_observer::install_response_observer(accounts.clone())
        .map_err(str::to_owned)?;
    let review = review_runtime(&manifest)?;
    let host = Arc::new(Host {
        lsp: lsp_enabled.then(|| {
            let policy = manifest.lsp.as_ref().expect("enabled LSP policy");
            std::sync::Mutex::new(LspRuntime {
                repository: manifest.repository.clone(),
                limits: policy.limits.clone(),
                sessions: BTreeMap::new(),
                check_cache: BTreeMap::new(),
            })
        }),
        manifest,
        task,
        accounts,
        manager,
        contribution_started: std::sync::atomic::AtomicBool::new(false),
        operation: std::sync::atomic::AtomicBool::new(false),
        lead_completed: std::sync::atomic::AtomicBool::new(false),
        pending_calls: std::sync::Mutex::new(BTreeMap::new()),
        active_guideline,
        knowledge_prompt: frozen_knowledge_prompt,
        reactive_rules,
        review: std::sync::Mutex::new(review),
    });
    let _ = host.authorize();
    let deadline_host = host.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(
            deadline_host.manifest.limits.seconds,
        ))
        .await;
        deadline_host.stop_tree("task_deadline", true, None).await;
    });
    if let Some(lsp) = &host.lsp {
        let interval = lsp
            .lock()
            .map_err(|_| "LSP runtime lock poisoned")?
            .limits
            .idle_ms
            .min(60_000);
        let weak = Arc::downgrade(&host);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(interval)).await;
                let Some(host) = weak.upgrade() else {
                    break;
                };
                if let Some(lsp) = &host.lsp
                    && let Ok(mut runtime) = lsp.lock()
                {
                    runtime
                        .sessions
                        .retain(|_, session| !session.is_idle() && session.is_running());
                }
            }
        });
    }
    registry.thread_lifecycle_contributor(Arc::new(Extension(host.clone())));
    registry.prompt_contributor(Arc::new(Extension(host.clone())));
    registry.tool_lifecycle_contributor(Arc::new(Extension(host.clone())));
    registry.tool_reaction_contributor(Arc::new(Extension(host.clone())));
    registry.turn_item_contributor(Arc::new(Extension(host.clone())));
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

    async fn stop_tree(&self, reason: &str, final_stop: bool, except: Option<ThreadId>) {
        if final_stop {
            let reviewed_current = self
                .live_state()
                .ok()
                .and_then(|live| {
                    self.review
                        .lock()
                        .ok()
                        .and_then(|review| review.ledger.snapshot().final_candidate_sha256)
                        .map(|candidate| candidate == live.workspace_sha256)
                })
                .unwrap_or(false);
            if reason != "completed"
                || !reviewed_current
                || self
                    .task
                    .complete("foreground acceptance checkpoint")
                    .is_err()
            {
                let _ = self.task.stop();
            }
        } else {
            let uncertain = self.task.uncertain_requests().unwrap_or_default();
            let _ = self.task.pause(reason, uncertain);
        }
        let threads: Vec<_> = self
            .accounts
            .0
            .lock()
            .map(|v| v.keys().cloned().collect())
            .unwrap_or_default();
        if let Some(manager) = self.manager.upgrade() {
            for id in threads {
                if let Ok(id) = ThreadId::from_string(&id)
                    && Some(id) != except
                    && let Ok(thread) = manager.get_thread(id).await
                {
                    let _ = thread.submit(codex_protocol::protocol::Op::Interrupt).await;
                    let _ = thread
                        .submit(codex_protocol::protocol::Op::CleanBackgroundTerminals)
                        .await;
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        thread.shutdown_and_wait(),
                    )
                    .await;
                }
            }
        }
        let _ =
            codex_omd::cleanup_owned_directory(&self.manifest.repository, &self.manifest.scratch);
        if let Some(lsp) = &self.lsp
            && let Ok(mut runtime) = lsp.lock()
        {
            runtime.sessions.clear();
        }
    }

    fn authorize(&self) -> Result<(), String> {
        let allowed = accounting::authorized(
            &self.manifest.authorization,
            &self.manifest.authorization_sha256,
            &self.manifest.repository_identity,
            &self.manifest.evidence.join(accounting::REVOCATION_FILE),
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
            provider: if route.model == "muse-spark-1.3-contributor" {
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
            revocation: self.manifest.evidence.join(accounting::REVOCATION_FILE),
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
        let name = self
            .manifest
            .lifecycle
            .explicit_resume
            .as_ref()
            .map(|reference| format!("resume-{}-{name}", execution::hash(reference.as_bytes())))
            .unwrap_or_else(|| name.to_owned());
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

    fn persist_review(&self) -> Result<(), String> {
        use std::io::Write;
        let bytes = serde_json::to_vec(
            &self
                .review
                .lock()
                .map_err(|_| "review runtime lock poisoned")?
                .ledger
                .snapshot(),
        )
        .map_err(|error| error.to_string())?;
        if bytes.len() > 8_388_608 {
            return Err("review state exceeds persistence limit".into());
        }
        let path = self.manifest.evidence.join("review-state.json");
        let temporary = self.manifest.evidence.join(format!(
            "review-state-{}-{}.tmp",
            std::process::id(),
            execution::hash(&bytes)
        ));
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
        std::fs::File::open(&self.manifest.evidence)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn live_state(&self) -> Result<LiveState, String> {
        capture_live_state(&self.manifest, &self.accounts)
    }

    fn save_checkpoint(
        &self,
        update: CheckpointUpdate,
    ) -> Result<codex_omd::TaskCheckpoint, String> {
        for marker in update
            .candidate_versions
            .iter()
            .chain(&update.check_versions)
            .chain(
                update
                    .completed_acceptance
                    .iter()
                    .flat_map(|acceptance| &acceptance.evidence),
            )
        {
            let path = PathBuf::from(&marker.evidence);
            if path.canonicalize().map_err(|e| e.to_string())? != path
                || !path.starts_with(&self.manifest.evidence)
                || !std::fs::symlink_metadata(&path)
                    .map_err(|e| e.to_string())?
                    .file_type()
                    .is_file()
                || execution::hash(&std::fs::read(&path).map_err(|e| e.to_string())?)
                    != marker.evidence_sha256
            {
                return Err("checkpoint marker is not bound to host-owned evidence".into());
            }
        }
        self.task
            .save_checkpoint(update, self.live_state()?)
            .map_err(|e| e.to_string())
    }

    fn observe_call_result(&self, thread: ThreadId, call_id: &str, result: &[u8]) {
        let identity = format!("{thread}:{call_id}");
        let pending = self
            .pending_calls
            .lock()
            .ok()
            .and_then(|mut calls| calls.remove(&identity));
        if let Some(pending) = pending {
            let _ = self.task.observe_call(
                &pending.signature_sha256,
                &execution::hash(result),
                pending.legitimate_wait,
            );
        }
    }

    fn observe_history_results<'a>(
        &self,
        thread: ThreadId,
        items: impl Iterator<Item = &'a ResponseItem>,
    ) {
        for item in items {
            let observed = match item {
                ResponseItem::FunctionCallOutput {
                    call_id: Some(call_id),
                    output,
                    ..
                } => serde_json::to_vec(output)
                    .ok()
                    .map(|result| (call_id.as_str(), result)),
                ResponseItem::CustomToolCallOutput {
                    call_id, output, ..
                } => serde_json::to_vec(output)
                    .ok()
                    .map(|result| (call_id.as_str(), result)),
                ResponseItem::ToolSearchOutput {
                    call_id: Some(call_id),
                    status,
                    tools,
                    ..
                } => serde_json::to_vec(&(status, tools))
                    .ok()
                    .map(|result| (call_id.as_str(), result)),
                _ => None,
            };
            if let Some((call_id, result)) = observed {
                self.observe_call_result(thread, call_id, &result);
            }
        }
    }
}

impl ContextContributor for Extension {
    fn contribute_turn_context<'a>(
        &'a self,
        input: TurnContextContributionInput<'a>,
    ) -> ExtensionFuture<'a, Vec<PromptFragment>> {
        Box::pin(async move {
            let lead = input.thread_store.get::<Lead>();
            let controlled =
                lead.is_some()
                    || self.accounts.0.lock().ok().is_some_and(|accounts| {
                        accounts.contains_key(&input.thread_id.to_string())
                    });
            if !controlled {
                return Vec::new();
            }
            let mut fragments = Vec::new();
            if let Some(lead) = lead {
                if let Ok(Some(checkpoint)) = self.task.checkpoint()
                    && let Ok(rendered) = serde_json::to_string(&checkpoint)
                {
                    fragments.push(PromptFragment::developer_capability(
                        format!(
                            "Host-owned durable task checkpoint. Treat it as authoritative across compaction and use omd_checkpoint for evidence-backed progress updates: {rendered}"
                        ),
                        ContentItemKind("oh_my_diff.task_checkpoint".into()),
                    ));
                }
                if let Some(guideline) = &self.active_guideline {
                    fragments.push(PromptFragment::developer_capability(
                        guideline_prompt(guideline),
                        ContentItemKind("oh_my_diff.guideline".into()),
                    ));
                }
                if let Some(prompt) = &self.knowledge_prompt {
                    fragments.push(PromptFragment::developer_capability(
                        prompt.clone(),
                        ContentItemKind("oh_my_diff.repository_knowledge".into()),
                    ));
                }
                if self.lsp.is_some() {
                    fragments.push(PromptFragment::developer_capability(
                        "This repository has remembered semantic-feedback opt-in. Use omd_lsp on demand for the supported five languages. Synchronize each coherent write batch before navigation or diagnostics; semantic writes require an exact declared scope and current SHA256 for every affected existing or absent path. Use intermediate_check after meaningful changes. Treat unsupported or unavailable results as an explicit fallback, not success. Servers start on demand, stop after bounded idle time, and are never installed automatically.",
                        ContentItemKind("oh_my_diff.lsp".into()),
                    ));
                }
                if let Ok(review) = self.review.lock() {
                    let snapshot = review.ledger.snapshot();
                    let current_candidate = self
                        .live_state()
                        .ok()
                        .map(|state| state.workspace_sha256)
                        .unwrap_or_else(|| "unavailable".into());
                    let prompt = format!(
                        "Use the single host-owned omd_review system for stable milestones, explicit risk-triggered advice, and final review. Findings are candidate-bound and reconciled across cycles; repairs are limited to configured scope and count. Final review runs executable checks and uses the separately configured opposite lead before completion or integration. Every-turn advice is {} and remains independent of the required final review. Current candidate SHA256: {current_candidate}. Current review cycles: {}; unresolved findings: {}; repairs: {}/{}.",
                        if snapshot.policy.every_turn_advice {
                            "enabled"
                        } else {
                            "disabled"
                        },
                        snapshot.cycles.len(),
                        review.ledger.unresolved().len(),
                        snapshot.repairs.len(),
                        snapshot.policy.max_repairs,
                    );
                    fragments.push(PromptFragment::developer_capability(
                        prompt,
                        ContentItemKind("oh_my_diff.review".into()),
                    ));
                }
                if lead.owner == "lead"
                    && let Some(prompt) = self.manifest.communication.user_update_prompt()
                {
                    fragments.push(PromptFragment::developer_capability(
                        prompt,
                        ContentItemKind("oh_my_diff.user_updates".into()),
                    ));
                }
            }
            if let Some(reactive) = &self.reactive_rules
                && let Ok(prompts) = reactive.context_prompts(&input.thread_id.to_string())
            {
                fragments.extend(prompts.into_iter().map(|prompt| {
                    PromptFragment::developer_capability(
                        prompt,
                        ContentItemKind("oh_my_diff.reactive_rule".into()),
                    )
                }));
            }
            fragments
        })
    }
}

impl ToolReactionContributor for Extension {
    fn on_tool_finish_reaction<'a>(
        &'a self,
        input: ToolFinishInput<'a>,
    ) -> ExtensionFuture<'a, Option<String>> {
        Box::pin(async move {
            let thread = input.thread_store.level_id().to_string();
            let owner = match input.thread_store.get::<Lead>() {
                Some(lead) => lead.owner.clone(),
                None => self
                    .accounts
                    .0
                    .lock()
                    .ok()?
                    .get(&thread)
                    .map(|account| account.owner.clone())?,
            };
            let Some(reactive) = &self.reactive_rules else {
                return None;
            };
            let outcome = match input.outcome {
                ToolCallOutcome::Completed { success: true } => {
                    ReactiveToolOutcome::CompletedHostSuccess
                }
                ToolCallOutcome::Completed { success: false } => {
                    ReactiveToolOutcome::CompletedHostFailure
                }
                ToolCallOutcome::Blocked => ReactiveToolOutcome::Blocked,
                ToolCallOutcome::Failed {
                    handler_executed: false,
                } => ReactiveToolOutcome::FailedBeforeExecution,
                ToolCallOutcome::Failed {
                    handler_executed: true,
                } => ReactiveToolOutcome::FailedAfterExecution,
                ToolCallOutcome::Aborted => ReactiveToolOutcome::Aborted,
            };
            let trigger = ReactiveTrigger::ToolFinished {
                tool: input.tool_name.to_string(),
                outcome,
            };
            let activation = match reactive.activate(&thread, &owner, &trigger) {
                Ok(Some(activation)) => activation,
                _ => return None,
            };
            let prompt = activation.prompt();
            let allowance = self
                .task
                .checkpoint()
                .ok()
                .flatten()
                .map(|checkpoint| checkpoint.allowance);
            let evidence = json!({
                "schema": 1,
                "activation": activation,
                "prompt": prompt,
                "thread": thread,
                "owner": owner,
                "call_id": input.call_id,
                "turn_id": input.turn_id,
                "allowance_before_follow_up": allowance,
                "stream_interrupted": false,
            });
            let name = format!(
                "reactive-{}.json",
                execution::hash(
                    format!(
                        "{}\0{}\0{}\0{}",
                        thread, input.turn_id, input.call_id, activation.rule_id
                    )
                    .as_bytes()
                )
            );
            if self.evidence(&name, &evidence).is_err() {
                return None;
            }
            Some(prompt)
        })
    }
}

impl ToolLifecycleContributor for Extension {
    fn on_tool_start<'a>(&'a self, input: ToolStartInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            let Some(lead) = input.thread_store.get::<Lead>() else {
                return;
            };
            self.observe_history_results(lead.thread, input.conversation_history.items());
            let tool = input.tool_name.to_string();
            let payload_sha256 = execution::hash(input.payload.log_payload().as_bytes());
            let signature_sha256 =
                execution::hash(format!("{}\0{}\0{}", lead.owner, tool, payload_sha256).as_bytes());
            let legitimate_wait = self
                .manifest
                .legitimate_wait_tools
                .iter()
                .any(|name| name == &tool);
            if let Ok(mut pending) = self.pending_calls.lock() {
                pending.insert(
                    format!("{}:{}", lead.thread, input.call_id),
                    PendingCall {
                        signature_sha256,
                        legitimate_wait,
                    },
                );
            }
        })
    }

    fn on_tool_finish<'a>(&'a self, input: ToolFinishInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            let Some(lead) = input.thread_store.get::<Lead>() else {
                return;
            };
            if matches!(input.outcome, ToolCallOutcome::Completed { .. })
                && let Some(lsp) = &self.lsp
                && let Ok(mut runtime) = lsp.lock()
            {
                runtime.sync_open_documents();
            }
            let result = match input.outcome {
                ToolCallOutcome::Completed { .. } => return,
                ToolCallOutcome::Blocked => b"blocked".as_slice(),
                ToolCallOutcome::Failed { handler_executed } => {
                    if handler_executed {
                        b"failed:executed".as_slice()
                    } else {
                        b"failed:not_executed".as_slice()
                    }
                }
                ToolCallOutcome::Aborted => b"aborted".as_slice(),
            };
            self.observe_call_result(lead.thread, input.call_id, result);
        })
    }
}

impl TurnItemContributor for Extension {
    fn contribute<'a>(
        &'a self,
        thread_store: &'a ExtensionData,
        _turn_store: &'a ExtensionData,
        item: &'a mut TurnItem,
    ) -> ExtensionFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let Some(lead) = thread_store.get::<Lead>() else {
                return Ok(());
            };
            let observed = match item {
                TurnItem::FunctionCallOutput(output) => Some((
                    output.id.as_str(),
                    serde_json::to_vec(&output.output).map_err(|e| e.to_string())?,
                )),
                TurnItem::DynamicToolCall(output)
                    if !matches!(
                        output.status,
                        codex_protocol::items::DynamicToolCallStatus::InProgress
                    ) =>
                {
                    Some((
                        output.id.as_str(),
                        serde_json::to_vec(&(
                            output.status,
                            &output.content_items,
                            output.success,
                            &output.error,
                        ))
                        .map_err(|e| e.to_string())?,
                    ))
                }
                TurnItem::CollabAgentToolCall(output)
                    if !matches!(
                        output.status,
                        codex_protocol::items::CollabAgentToolCallStatus::InProgress
                    ) =>
                {
                    Some((
                        output.id.as_str(),
                        serde_json::to_vec(&(
                            output.status,
                            &output.receiver_thread_ids,
                            &output.receiver_agents,
                        ))
                        .map_err(|e| e.to_string())?,
                    ))
                }
                TurnItem::McpToolCall(output)
                    if !matches!(
                        output.status,
                        codex_protocol::items::McpToolCallStatus::InProgress
                    ) =>
                {
                    Some((
                        output.id.as_str(),
                        serde_json::to_vec(&(&output.status, &output.result, &output.error))
                            .map_err(|e| e.to_string())?,
                    ))
                }
                TurnItem::ContextCompaction(_) => {
                    let live = self.live_state()?;
                    self.task
                        .reconcile("conversation_compaction", live)
                        .map_err(|e| e.to_string())?;
                    None
                }
                _ => None,
            };
            if let Some((call_id, result)) = observed {
                self.observe_call_result(lead.thread, call_id, &result);
            }
            Ok(())
        })
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
            let Ok(thread) = ThreadId::from_string(input.thread_store.level_id()) else {
                return;
            };
            let (owner, parent, depth) = match input.session_source {
                SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
                    parent_thread_id,
                    depth,
                    ..
                }) => {
                    let parent =
                        self.accounts.0.lock().ok().and_then(|accounts| {
                            accounts.get(&parent_thread_id.to_string()).cloned()
                        });
                    let Some(parent) = parent else {
                        return;
                    };
                    (
                        format!("agent:{thread}"),
                        parent.owner,
                        u32::try_from(*depth).unwrap_or(u32::MAX),
                    )
                }
                _ => ("lead".into(), String::new(), 0),
            };
            if owner != "lead"
                && self
                    .task
                    .start_worker(
                        owner.clone(),
                        parent,
                        depth,
                        self.manifest.worker_limits.clone(),
                    )
                    .is_err()
            {
                return;
            }
            if self.enroll(thread, &owner, route).is_ok() {
                input.thread_store.insert(Lead {
                    thread,
                    route: route_name,
                    owner,
                    depth,
                    host: self.0.clone(),
                });
            } else if owner != "lead" {
                let _ = self.task.finish_worker(&owner);
            }
        })
    }

    fn on_thread_idle<'a>(&'a self, input: ThreadIdleInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(lead) = input.thread_store.get::<Lead>() {
                match input.cause {
                    ThreadIdleCause::Completed
                        if self
                            .accounts
                            .0
                            .lock()
                            .ok()
                            .and_then(|accounts| accounts.get(&lead.thread.to_string()).cloned())
                            .is_some_and(|account| account.owner == "lead") =>
                    {
                        self.lead_completed
                            .store(true, std::sync::atomic::Ordering::Release);
                    }
                    ThreadIdleCause::Completed if lead.owner.starts_with("agent:") => {
                        let _ = self.task.complete_worker(
                            &lead.owner,
                            VersionMarker {
                                label: "native-agent-result".into(),
                                sha256: execution::hash(lead.thread.to_string().as_bytes()),
                                evidence: format!("native-thread:{}", lead.thread),
                                evidence_sha256: execution::hash(
                                    lead.thread.to_string().as_bytes(),
                                ),
                            },
                        );
                    }
                    ThreadIdleCause::Interrupted | ThreadIdleCause::Failed => {
                        self.lead_completed
                            .store(false, std::sync::atomic::Ordering::Release);
                        self.stop_tree("foreground_interrupted", false, Some(lead.thread))
                            .await;
                    }
                    _ => {}
                }
            }
        })
    }

    fn on_thread_stop<'a>(&'a self, input: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if let Some(lead) = input.thread_store.get::<Lead>() {
                let account = self
                    .accounts
                    .0
                    .lock()
                    .ok()
                    .and_then(|mut accounts| accounts.remove(&lead.thread.to_string()));
                if let Some(account) = account {
                    if account.owner == "lead" {
                        let completed = self
                            .lead_completed
                            .load(std::sync::atomic::Ordering::Acquire);
                        self.stop_tree(
                            if completed {
                                "completed"
                            } else {
                                "client_loss"
                            },
                            completed,
                            Some(lead.thread),
                        )
                        .await;
                    } else {
                        if self.task.consume_worker_result(&account.owner).is_err() {
                            let _ = self.task.finish_worker(&account.owner);
                        }
                    }
                }
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
        let mut tools: Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> = vec![
            Arc::new(CheckpointTool(lead.clone())),
            Arc::new(EscalationTool(lead.clone())),
            Arc::new(ReviewTool(lead.clone())),
        ];
        if self.lsp.is_some() {
            tools.push(Arc::new(LspTool(lead.clone())));
        }
        if accounting::authorized(
            &self.manifest.authorization,
            &self.manifest.authorization_sha256,
            &self.manifest.repository_identity,
            &self.manifest.evidence.join(accounting::REVOCATION_FILE),
        ) {
            tools.push(Arc::new(ContributionTool(lead)));
        }
        tools
    }
}

fn version_marker_schema() -> JsonSchema {
    JsonSchema::object(
        BTreeMap::from([
            (
                "label".into(),
                JsonSchema::string(Some("Version label.".into())),
            ),
            (
                "sha256".into(),
                JsonSchema::string(Some("Exact lowercase SHA256.".into())),
            ),
            (
                "evidence".into(),
                JsonSchema::string(Some("Host-owned evidence reference.".into())),
            ),
            (
                "evidence_sha256".into(),
                JsonSchema::string(Some("Exact lowercase evidence SHA256.".into())),
            ),
        ]),
        Some(vec![
            "label".into(),
            "sha256".into(),
            "evidence".into(),
            "evidence_sha256".into(),
        ]),
        Some(false.into()),
    )
}

impl<'call> ToolExecutor<ToolCall<'call>> for CheckpointTool {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("omd_checkpoint")
    }

    fn spec(&self) -> ToolSpec {
        let acceptance = JsonSchema::object(
            BTreeMap::from([
                (
                    "criterion".into(),
                    JsonSchema::string(Some(
                        "Exact acceptance criterion from the task contract.".into(),
                    )),
                ),
                (
                    "evidence".into(),
                    JsonSchema::array(
                        version_marker_schema(),
                        Some("Evidence proving this criterion.".into()),
                    ),
                ),
            ]),
            Some(vec!["criterion".into(), "evidence".into()]),
            Some(false.into()),
        );
        let text_array = |description: &str| {
            JsonSchema::array(JsonSchema::string(None), Some(description.into()))
        };
        ToolSpec::Function(ResponsesApiTool {
            name: "omd_checkpoint".into(),
            description: "Persist an evidence-backed compact task checkpoint outside the conversation summary. Completed acceptance, steering, failed hypotheses, and version markers are monotonic; remaining work may be revised. Host captures worker states, live workspace/process state, and remaining allowance.".into(),
            strict: false,
            defer_loading: None,
            output_schema: None,
            parameters: JsonSchema::object(
                BTreeMap::from([
                    (
                        "completed_acceptance".into(),
                        JsonSchema::array(acceptance, Some("Completed acceptance evidence.".into())),
                    ),
                    (
                        "completed_steering".into(),
                        text_array("Completed user steering."),
                    ),
                    ("remaining_work".into(), text_array("Exact work still remaining.")),
                    (
                        "failed_hypotheses".into(),
                        text_array("Failed hypotheses retained for recovery."),
                    ),
                    (
                        "candidate_versions".into(),
                        JsonSchema::array(
                            version_marker_schema(),
                            Some("Candidate versions and evidence.".into()),
                        ),
                    ),
                    (
                        "check_versions".into(),
                        JsonSchema::array(
                            version_marker_schema(),
                            Some("Check versions and evidence.".into()),
                        ),
                    ),
                ]),
                Some(vec![
                    "completed_acceptance".into(),
                    "completed_steering".into(),
                    "remaining_work".into(),
                    "failed_hypotheses".into(),
                    "candidate_versions".into(),
                    "check_versions".into(),
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
            let update: CheckpointUpdate = serde_json::from_str(call.function_arguments()?)
                .map_err(|e| FunctionCallError::RespondToModel(e.to_string()))?;
            let checkpoint = self
                .0
                .host
                .save_checkpoint(update)
                .map_err(FunctionCallError::RespondToModel)?;
            Ok(Box::new(JsonToolOutput::new(json!({
                "schema": 1,
                "revision": checkpoint.revision,
                "task_status": checkpoint.task_status,
                "remaining_work": checkpoint.remaining_work,
                "allowance": checkpoint.allowance,
            }))) as Box<dyn ToolOutput>)
        })
    }
}

fn lsp_position_schema() -> JsonSchema {
    JsonSchema::object(
        BTreeMap::from([
            (
                "line".into(),
                JsonSchema::integer(Some("Zero-based line.".into())),
            ),
            (
                "character".into(),
                JsonSchema::integer(Some("Zero-based UTF-16 character offset.".into())),
            ),
        ]),
        Some(vec!["line".into(), "character".into()]),
        Some(false.into()),
    )
}

fn lsp_range_schema() -> JsonSchema {
    JsonSchema::object(
        BTreeMap::from([
            ("start".into(), lsp_position_schema()),
            ("end".into(), lsp_position_schema()),
        ]),
        Some(vec!["start".into(), "end".into()]),
        Some(false.into()),
    )
}

impl<'call> ToolExecutor<ToolCall<'call>> for LspTool {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("omd_lsp")
    }

    fn spec(&self) -> ToolSpec {
        let language = JsonSchema::string_enum(
            ["rust", "typescript", "javascript", "python", "java"]
                .into_iter()
                .map(|value| json!(value))
                .collect(),
            Some("Language server route.".into()),
        );
        let paths = JsonSchema::array(
            JsonSchema::string(Some("Normalized repository-relative path.".into())),
            Some("Exact coherent path batch or semantic edit scope.".into()),
        );
        let expected_versions = JsonSchema::object(
            BTreeMap::new(),
            None,
            Some(
                JsonSchema::any_of(
                    vec![JsonSchema::string(None), JsonSchema::null(None)],
                    Some(
                        "Current SHA256 for an existing path or null for an absent destination."
                            .into(),
                    ),
                )
                .into(),
            ),
        );
        ToolSpec::Function(ResponsesApiTool {
            name: "omd_lsp".into(),
            description: "Use repository-opted-in, installed language servers for synchronized diagnostics, definition navigation, references, supported code actions, and exact-scope symbol or file renames. Use intermediate_check for one derived allowlisted executable check per changed language. Call sync with the complete coherent write batch before semantic reads. Rename and code-action writes require scope and expected_versions to match every affected path exactly. Unsupported capabilities return an explicit ordinary-tool fallback; servers are never installed.".into(),
            strict: false,
            defer_loading: None,
            output_schema: None,
            parameters: JsonSchema::object(
                BTreeMap::from([
                    (
                        "action".into(),
                        JsonSchema::string_enum(
                            [
                                "status",
                                "sync",
                                "definition",
                                "references",
                                "code_actions",
                                "apply_code_action",
                                "rename_symbol",
                                "rename_file",
                                "intermediate_check",
                            ]
                            .into_iter()
                            .map(|value| json!(value))
                            .collect(),
                            Some("Requested bounded operation.".into()),
                        ),
                    ),
                    ("language".into(), language),
                    ("paths".into(), paths.clone()),
                    (
                        "path".into(),
                        JsonSchema::string(Some("Synchronized repository-relative source path.".into())),
                    ),
                    ("position".into(), lsp_position_schema()),
                    ("range".into(), lsp_range_schema()),
                    (
                        "include_declaration".into(),
                        JsonSchema::boolean(Some("Include the declaration in references.".into())),
                    ),
                    (
                        "action_value".into(),
                        JsonSchema::object(BTreeMap::new(), None, Some(true.into())),
                    ),
                    (
                        "new_name".into(),
                        JsonSchema::string(Some("Requested new symbol name.".into())),
                    ),
                    (
                        "old_path".into(),
                        JsonSchema::string(Some("Existing repository-relative file path.".into())),
                    ),
                    (
                        "new_path".into(),
                        JsonSchema::string(Some("Absent repository-relative destination path.".into())),
                    ),
                    ("scope".into(), paths),
                    ("expected_versions".into(), expected_versions),
                ]),
                Some(vec!["action".into()]),
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
            let request: LspRequest = serde_json::from_str(call.function_arguments()?)
                .map_err(|error| FunctionCallError::RespondToModel(error.to_string()))?;
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
            let value = match request {
                LspRequest::IntermediateCheck { paths } => {
                    let (checks, unsupported, limits) = {
                        let runtime = self
                            .0
                            .host
                            .lsp
                            .as_ref()
                            .ok_or_else(|| {
                                FunctionCallError::RespondToModel("LSP opt-in is disabled".into())
                            })?
                            .lock()
                            .map_err(|_| {
                                FunctionCallError::RespondToModel(
                                    "LSP runtime lock poisoned".into(),
                                )
                            })?;
                        let (checks, unsupported) = codex_omd::select_intermediate_checks(
                            &runtime.repository,
                            &paths,
                            &runtime.limits,
                        )
                        .map_err(|error| FunctionCallError::RespondToModel(error.to_string()))?;
                        (checks, unsupported, runtime.limits.clone())
                    };
                    let mut results = Vec::new();
                    for check in checks {
                        let key = format!("{:?}:{}", check.language, check.input_sha256);
                        let cached = self
                            .0
                            .host
                            .lsp
                            .as_ref()
                            .and_then(|runtime| runtime.lock().ok())
                            .and_then(|runtime| runtime.check_cache.get(&key).cloned());
                        if let Some(mut cached) = cached {
                            cached["cached"] = json!(true);
                            results.push(cached);
                            continue;
                        }
                        let result = execute_intermediate_check(check.clone(), &limits).await;
                        let post_input = self
                            .0
                            .host
                            .lsp
                            .as_ref()
                            .and_then(|runtime| runtime.lock().ok())
                            .and_then(|runtime| {
                                codex_omd::select_intermediate_checks(
                                    &runtime.repository,
                                    &paths,
                                    &runtime.limits,
                                )
                                .ok()
                            })
                            .and_then(|(checks, _)| {
                                checks
                                    .into_iter()
                                    .find(|post| post.language == check.language)
                                    .map(|post| post.input_sha256)
                            });
                        let mut result = result;
                        let candidate_current = post_input.as_deref() == Some(&check.input_sha256);
                        result["candidate_current"] = json!(candidate_current);
                        if !candidate_current {
                            result["status"] = json!("stale");
                        }
                        if candidate_current
                            && let Some(runtime) = &self.0.host.lsp
                            && let Ok(mut runtime) = runtime.lock()
                        {
                            runtime.check_cache.insert(key, result.clone());
                        }
                        results.push(result);
                    }
                    let status = if results.is_empty() {
                        "unsupported"
                    } else if unsupported.is_empty() {
                        "completed"
                    } else {
                        "partial"
                    };
                    json!({
                        "schema": 1,
                        "status": status,
                        "results": results,
                        "unsupported": unsupported,
                    })
                }
                request => {
                    let mut runtime = self
                        .0
                        .host
                        .lsp
                        .as_ref()
                        .ok_or_else(|| {
                            FunctionCallError::RespondToModel("LSP opt-in is disabled".into())
                        })?
                        .lock()
                        .map_err(|_| {
                            FunctionCallError::RespondToModel("LSP runtime lock poisoned".into())
                        })?;
                    lsp_result(&mut runtime, request)
                }
            };
            let reference = self
                .0
                .host
                .evidence(
                    &format!(
                        "lsp-result-{}.json",
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

impl<'call> ToolExecutor<ToolCall<'call>> for ReviewTool {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("omd_review")
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec::Function(ResponsesApiTool {
            name: "omd_review".into(),
            description: "Run one candidate-bound pass through the shared review ledger. Stable-milestone and explicit risk-triggered advice reuse unresolved findings. Every-turn advice works only when separately enabled. Final review first runs configured executable checks, then a read-only opposite-lead reviewer; completion remains blocked unless that exact candidate has no unresolved or stale findings. Candidate changes after findings count as bounded repairs and must remain inside configured repair scope.".into(),
            strict: false,
            defer_loading: None,
            output_schema: None,
            parameters: JsonSchema::object(
                BTreeMap::from([
                    (
                        "cadence".into(),
                        JsonSchema::string_enum(
                            ["stable_milestone", "risk_triggered", "every_turn", "final"]
                                .into_iter()
                                .map(|value| json!(value))
                                .collect(),
                            Some("Review cadence; every_turn may be disabled.".into()),
                        ),
                    ),
                    (
                        "candidate_sha256".into(),
                        JsonSchema::string(Some(
                            "Exact current candidate SHA256 from host review context.".into(),
                        )),
                    ),
                    (
                        "stable".into(),
                        JsonSchema::boolean(Some(
                            "Whether implementation writes for this milestone have stopped.".into(),
                        )),
                    ),
                    (
                        "risk".into(),
                        JsonSchema::string(Some(
                            "Concrete bounded risk; required only for risk_triggered.".into(),
                        )),
                    ),
                ]),
                Some(vec![
                    "cadence".into(),
                    "candidate_sha256".into(),
                    "stable".into(),
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
            let request: execution::ReviewRequest =
                serde_json::from_str(call.function_arguments()?)
                    .map_err(|error| FunctionCallError::RespondToModel(error.to_string()))?;
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
            let value = execution::review_current(&self.0, &call, request)
                .await
                .unwrap_or_else(|error| json!({"schema": 1, "status": "failed", "error": error}));
            Ok(Box::new(JsonToolOutput::new(value)) as Box<dyn ToolOutput>)
        })
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

#[cfg(test)]
mod communication_tests {
    use super::*;

    #[test]
    fn user_updates_and_worker_reports_are_independent() {
        let user_only = CommunicationPolicy {
            concise_user_updates: true,
            structured_worker_reports: false,
        };
        assert!(user_only.user_update_prompt().is_some());
        assert!(user_only.worker_output_schema().is_none());

        let worker_only = CommunicationPolicy {
            concise_user_updates: false,
            structured_worker_reports: true,
        };
        assert!(worker_only.user_update_prompt().is_none());
        assert!(worker_only.worker_output_schema().is_some());
    }

    #[test]
    fn communication_contract_retains_required_information() {
        let prompt = user_update_prompt();
        for required in ["scope", "uncertainty", "evidence", "clarification"] {
            assert!(prompt.contains(required));
            assert!(worker_report_prompt().contains(required));
        }
        let schema = worker_report_schema();
        let required = schema["required"].as_array().unwrap();
        for field in ["scope", "uncertainty", "evidence", "required_clarification"] {
            assert!(required.iter().any(|value| value == field));
        }
        assert!(review_report_prompt().contains("top level"));
        assert!(review_report_prompt().contains("report field"));
    }
}

#[cfg(test)]
mod guideline_tests {
    use super::*;
    use codex_omd::GuidelineRule;
    use codex_omd::GuidelineSelection;
    use codex_omd::GuidelineVariant;

    fn active(variant: GuidelineVariant) -> ActiveGuideline {
        ActiveGuideline {
            selection: GuidelineSelection {
                version: "candidate-v1".into(),
                proposal_sha256: "a".repeat(64),
            },
            variant,
            promoted_revision: 1,
        }
    }

    fn rule(id: &str, text: &str) -> GuidelineRule {
        GuidelineRule {
            id: id.into(),
            text: text.into(),
        }
    }

    #[test]
    fn promoted_full_and_tiny_variants_render_with_frozen_identity() {
        let full = guideline_prompt(&active(GuidelineVariant::FullChecklist {
            checklist: vec![
                rule("requirements", "Preserve explicit requirements."),
                rule("existing", "Prefer existing code."),
                rule("native", "Prefer native capabilities."),
                rule("smallest", "Make the smallest clear correct change."),
            ],
        }));
        assert!(full.contains("candidate-v1"));
        assert!(full.contains(&"a".repeat(64)));
        assert!(full.contains("complete short simplicity checklist"));
        assert!(full.contains("frozen when this session started"));

        let tiny = guideline_prompt(&active(GuidelineVariant::TinyCore {
            core: vec![rule("requirements", "Preserve explicit requirements.")],
            selected_rules: vec![rule("smallest", "Make the smallest clear correct change.")],
        }));
        assert!(tiny.contains("tiny shared simplicity core"));
        assert!(tiny.contains("selected one-line rules"));
    }
}

#[cfg(test)]
mod knowledge_tests {
    use super::*;

    #[test]
    fn cold_state_is_explicit_in_native_context() {
        let policy = KnowledgePolicy {
            store: PathBuf::from("/host/knowledge"),
            mode: KnowledgeMode::Cold,
            max_context_bytes: 4096,
        };
        let session = KnowledgeSession {
            schema: 1,
            mode: KnowledgeMode::Cold,
            repository_identity: "fixture/repository".into(),
            generation: 3,
            revision: 9,
            refreshed_fact_ids: Vec::new(),
            invalidated_ids: Vec::new(),
            facts: Vec::new(),
            approved_lessons: Vec::new(),
        };
        let prompt = knowledge_prompt(&policy, &session).unwrap();
        assert!(prompt.contains("/host/knowledge"));
        assert!(prompt.contains("state: cold"));
        assert!(prompt.contains("no retained task evidence"));
        assert!(prompt.contains("generation 3"));
        assert!(prompt.contains("Unapproved candidates are excluded"));
    }
}
