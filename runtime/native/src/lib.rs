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
use codex_omd::Limits;
use codex_omd::Snapshot;
use codex_omd::Task;
use codex_omd::WorkerLimits;
use codex_protocol::ThreadId;
use codex_tools::FunctionCallError;
use codex_tools::JsonSchema;
use codex_tools::ResponsesApiTool;
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
    lead: Route,
    worker: Route,
    reviewer: Route,
    check_command: Vec<String>,
    toolchain_reads: Vec<PathBuf>,
    snapshot_bytes: usize,
    max_request_bytes: usize,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Route {
    provider: String,
    model: String,
    responses_url: String,
    rates: Rates,
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
    operation_started: std::sync::atomic::AtomicBool,
}

#[derive(Clone)]
struct Lead {
    thread: ThreadId,
    host: Arc<Host>,
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
    if manifest.lead.model != "gpt-5.6-sol"
        || manifest.worker.model != "muse-spark-1.3-contributor"
        || manifest.reviewer.model != "gpt-6-astra"
        || manifest.check_command.is_empty()
        || manifest.snapshot_bytes == 0
        || manifest.max_request_bytes == 0
    {
        return Err("invalid fixed controlled-delegation assignments or limits".into());
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
        operation_started: std::sync::atomic::AtomicBool::new(false),
    });
    host.authorize()?;
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
            if input.config.cwd.as_path() != self.manifest.repository
                || input.config.model.as_deref() != Some(&self.manifest.lead.model)
            {
                return;
            }
            if let Ok(thread) = ThreadId::from_string(input.thread_store.level_id())
                && self.enroll(thread, "lead", &self.manifest.lead).is_ok()
            {
                input.thread_store.insert(Lead {
                    thread,
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
        thread
            .get::<Lead>()
            .map(|lead| vec![lead as Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>])
            .unwrap_or_default()
    }
}

impl<'call> ToolExecutor<ToolCall<'call>> for Lead {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("omd_contribute")
    }
    fn spec(&self) -> ToolSpec {
        ToolSpec::Function(ResponsesApiTool {
            name: "omd_contribute".into(),
            description: "Delegate one bounded implementation to isolated Muse Contributor. Host runs configured checks and separate Astra review of the merged candidate, rejects conflicts, and integrates only accepted changes. Supply a focused brief with selected evidence; all attempts use the shared task allowance.".into(),
            strict: false, defer_loading: None, output_schema: None,
            parameters: JsonSchema::object(BTreeMap::from([("brief".into(), JsonSchema::string(None))]), Some(vec!["brief".into()]), Some(false.into())),
        })
    }
    fn handle<'a>(&'a self, call: ToolCall<'call>) -> ToolExecutorFuture<'a>
    where
        'call: 'a,
    {
        Box::pin(async move {
            let request: Value = serde_json::from_str(call.function_arguments()?)
                .map_err(|e| FunctionCallError::RespondToModel(e.to_string()))?;
            let brief = request["brief"]
                .as_str()
                .filter(|v| !v.is_empty() && v.len() <= 16_384)
                .ok_or_else(|| {
                    FunctionCallError::RespondToModel("brief must contain 1..16384 bytes".into())
                })?;
            if self
                .host
                .operation_started
                .swap(true, std::sync::atomic::Ordering::AcqRel)
            {
                return Err(FunctionCallError::RespondToModel(
                    "one controlled operation is permitted per task".into(),
                ));
            }
            let result = execution::contribute(self, &call, brief).await;
            let value = match result {
                Ok(value) => value,
                Err(error) => json!({"status": "failed", "error": error}),
            };
            let reference = self
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
