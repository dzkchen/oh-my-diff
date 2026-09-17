use super::*;
use codex_extension_api::ThreadResumeInput;
use codex_extension_api::TurnLifecycleContributor;
use codex_extension_api::TurnStartInput;
use codex_omd::ModHost;
use codex_omd::ModTool;
use std::sync::Mutex;

fn lead_thread(thread: &ExtensionData) -> bool {
    thread
        .get::<Lead>()
        .is_some_and(|lead| lead.owner == "lead")
}

struct Mods {
    owner: Arc<Host>,
    runtime: Arc<Mutex<ModHost>>,
}

pub(super) fn install(
    registry: &mut ExtensionRegistryBuilder<Config>,
    owner: Arc<Host>,
) -> Result<(), String> {
    let Some(root) = &owner.manifest.mods else {
        return Ok(());
    };
    if root.starts_with(&owner.manifest.repository) || !root.is_absolute() {
        return Err("mod trust/state store must be outside the repository".into());
    }
    let runtime = ModHost::open(root.clone()).map_err(|e| e.to_string())?;
    for (_, _, tool) in runtime.tools() {
        codex_extension_api::parse_tool_input_schema(&tool.parameters)
            .map_err(|e| e.to_string())?;
    }
    let extension = Arc::new(Mods {
        owner,
        runtime: Arc::new(Mutex::new(runtime)),
    });
    registry.prompt_contributor(extension.clone());
    registry.thread_lifecycle_contributor(extension.clone());
    registry.tool_lifecycle_contributor(extension.clone());
    registry.turn_lifecycle_contributor(extension.clone());
    registry.tool_contributor(extension);
    Ok(())
}

impl Mods {
    async fn event(&self, event: &'static str, payload: Value) -> Vec<PromptFragment> {
        let runtime = self.runtime.clone();
        let owner = self.owner.clone();
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _cancellation = Cancellation(cancelled.clone());
        tokio::task::spawn_blocking(move || {
            let Ok(mut runtime) = runtime.lock() else { return Vec::new(); };

            let mut fragments = Vec::new();
            let mut remaining_bytes = 6144;
            for (id, result) in runtime.event_guarded(event, payload, || !cancelled.load(std::sync::atomic::Ordering::Acquire)) {
                match result {
                    Ok(value) if event == "context" => {
                        if let Some(text) = value.get("text").and_then(Value::as_str) {
                            if text.len() + 256 > remaining_bytes {
                                fragments.push(PromptFragment::developer_capability(
                                    "Additional mod context omitted at the host aggregate limit.",
                                    ContentItemKind("oh_my_diff.mod_error".into()),
                                ));
                                break;
                            }
                            remaining_bytes -= text.len() + 256;
                            fragments.push(PromptFragment::developer_capability(
                                format!("User-approved mod {id}. Subordinate to current user/project instructions and native workflow enforcement.\n{text}"),
                                ContentItemKind("oh_my_diff.mod_context".into()),
                            ));
                        }
                    }
                    Err(error) => {
                        if remaining_bytes < 1024 { break; }
                        remaining_bytes -= 1024;
                        fragments.push(PromptFragment::developer_capability(
                        format!("Mod {id} failed and is disabled for this runtime: {error}"),
                        ContentItemKind("oh_my_diff.mod_error".into()),
                    )); },
                    _ => (),
                }
            }
            let status = runtime.status();
            if let Some(error) = status["reload_error"].as_str() {
                fragments.push(PromptFragment::developer_capability(
                    format!("Mod reload failed; previous eligible mods retained: {error}"),
                    ContentItemKind("oh_my_diff.mod_error".into()),
                ));
            }
            let _ = owner.evidence("mod-status.json", &status);
            fragments
        }).await.unwrap_or_default()
    }
}

impl TurnLifecycleContributor for Mods {
    fn on_turn_start<'a>(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if !lead_thread(input.thread_store) {
                return;
            }
            let runtime = self.runtime.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(mut runtime) = runtime.lock() {
                    runtime.turn_boundary();
                }
            })
            .await;
        })
    }
}

impl ContextContributor for Mods {
    fn contribute_turn_context<'a>(
        &'a self,
        input: TurnContextContributionInput<'a>,
    ) -> ExtensionFuture<'a, Vec<PromptFragment>> {
        Box::pin(async move {
            if !lead_thread(input.thread_store) {
                return Vec::new();
            }
            self.event(
                "context",
                json!({"thread_id": input.thread_id.to_string(), "turn_id": input.turn_id,
                "checkpoint": self.owner.task.checkpoint().ok().flatten()}),
            )
            .await
        })
    }
}

impl ThreadLifecycleContributor<Config> for Mods {
    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if lead_thread(input.thread_store) {
                self.event("start", Value::Null).await;
            }
        })
    }
    fn on_thread_resume<'a>(&'a self, input: ThreadResumeInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if lead_thread(input.thread_store) {
                self.event("resume", Value::Null).await;
            }
        })
    }
    fn on_thread_idle<'a>(&'a self, input: ThreadIdleInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if lead_thread(input.thread_store) {
                self.event("idle", json!({"cause": format!("{:?}", input.cause)}))
                    .await;
            }
        })
    }
    fn on_thread_stop<'a>(&'a self, input: ThreadStopInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if lead_thread(input.thread_store) {
                self.event("stop", Value::Null).await;
            }
        })
    }
}

impl ToolLifecycleContributor for Mods {
    fn on_tool_finish<'a>(&'a self, input: ToolFinishInput<'a>) -> ToolLifecycleFuture<'a> {
        Box::pin(async move {
            if lead_thread(input.thread_store) {
                self.event("tool_result", json!({"call_id": input.call_id,
                    "tool": input.tool_name.to_string(), "outcome": format!("{:?}", input.outcome)})).await;
            }
        })
    }
}

struct Cancellation(Arc<std::sync::atomic::AtomicBool>);

impl Drop for Cancellation {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Release);
    }
}

struct Tool {
    owner: Arc<Host>,
    runtime: Arc<Mutex<ModHost>>,
    id: String,
    generation: u64,
    definition: ModTool,
    parameters: JsonSchema,
}

impl ToolContributor for Mods {
    fn tools(
        &self,
        _: &ExtensionData,
        thread: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        if !lead_thread(thread) {
            return Vec::new();
        }
        let Ok(runtime) = self.runtime.lock() else {
            return Vec::new();
        };
        runtime
            .tools()
            .into_iter()
            .filter_map(|(id, generation, definition)| {
                let parameters =
                    codex_extension_api::parse_tool_input_schema(&definition.parameters).ok()?;
                Some(Arc::new(Tool {
                    owner: self.owner.clone(),
                    runtime: self.runtime.clone(),
                    id,
                    generation,
                    definition,
                    parameters,
                })
                    as Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>)
            })
            .collect()
    }
}

impl<'call> ToolExecutor<ToolCall<'call>> for Tool {
    fn tool_name(&self) -> ToolName {
        ToolName::plain(format!("mod_{}_{}", self.id, self.definition.name))
    }
    fn spec(&self) -> ToolSpec {
        ToolSpec::Function(ResponsesApiTool {
            name: format!("mod_{}_{}", self.id, self.definition.name),
            description: self.definition.description.clone(),
            strict: false,
            defer_loading: None,
            output_schema: None,
            parameters: self.parameters.clone(),
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
            self.owner
                .task
                .check_active()
                .map_err(|e| FunctionCallError::RespondToModel(e.to_string()))?;
            let payload: Value = serde_json::from_str(call.function_arguments()?)
                .map_err(|e| FunctionCallError::RespondToModel(e.to_string()))?;
            let runtime = self.runtime.clone();
            let owner = self.owner.clone();
            let id = self.id.clone();
            let name = self.definition.name.clone();
            let generation = self.generation;
            let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let _cancellation = Cancellation(cancelled.clone());
            let result = tokio::task::spawn_blocking(move || {
                owner.task.check_active()?;
                let mut runtime = runtime
                    .lock()
                    .map_err(|_| std::io::Error::other("mod runtime poisoned"))?;
                runtime.invoke_guarded(&id, generation, "tool", &name, payload, || {
                    !cancelled.load(std::sync::atomic::Ordering::Acquire)
                        && owner.task.check_active().is_ok()
                })
            })
            .await
            .map_err(|e| FunctionCallError::RespondToModel(e.to_string()))?
            .map_err(|e| FunctionCallError::RespondToModel(e.to_string()))?;
            self.owner
                .task
                .check_active()
                .map_err(|e| FunctionCallError::RespondToModel(e.to_string()))?;
            Ok(Box::new(JsonToolOutput::new(result)) as Box<dyn ToolOutput>)
        })
    }
}
