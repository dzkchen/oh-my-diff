use super::*;

struct Tool {
    lead: Arc<Lead>,
    agents: Arc<agents::Agents>,
    services: Arc<services::Services>,
    processes: Arc<crate::managed_process::ManagedProcesses>,
    views: Arc<view::Views>,
    owner: Arc<Host>,
    runtime: Arc<Mutex<ModHost>>,
    pre_rename_runtime: Arc<Mutex<ModHost>>,
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
        let Some(lead) = thread.get::<Lead>() else {
            return Vec::new();
        };
        let Ok(runtime) = self.runtime.lock() else {
            return Vec::new();
        };
        self.tool_executors(lead, runtime.tools())
    }

    fn tools_for_step(
        &self,
        _: &ExtensionData,
        thread: &ExtensionData,
        _: &ExtensionData,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        if !lead_thread(thread) {
            return Vec::new();
        }
        let Some(lead) = thread.get::<Lead>() else {
            return Vec::new();
        };
        let Ok(mut runtime) = self.runtime.lock() else {
            return Vec::new();
        };
        if !runtime.has_task_scoped_tools() {
            return self.tool_executors(lead, runtime.tools());
        }
        if self.owner.task.check_active().is_err() {
            return self.tool_executors(
                lead,
                runtime
                    .tools()
                    .into_iter()
                    .filter(|(_, _, tool)| !tool.task_scoped)
                    .collect(),
            );
        }
        let checkpoint = self.owner.task.checkpoint().ok().flatten();
        let checkpoint = serde_json::to_value(checkpoint).unwrap_or(Value::Null);
        let checkpoint = if serde_json::to_vec(&checkpoint).is_ok_and(|bytes| bytes.len() <= 16_384)
        {
            checkpoint
        } else {
            Value::Null
        };
        let tools = runtime.tools_for_step(thread_id(thread), checkpoint, || {
            self.owner.task.check_active().is_ok()
        });
        self.tool_executors(lead, tools)
    }
}

impl Mods {
    fn tool_executors(
        &self,
        lead: Arc<Lead>,
        tools: Vec<(String, u64, ModTool)>,
    ) -> Vec<Arc<dyn for<'call> ToolExecutor<ToolCall<'call>>>> {
        tools
            .into_iter()
            .filter_map(|(id, generation, definition)| {
                let parameters =
                    codex_extension_api::parse_tool_input_schema(&definition.parameters).ok()?;
                Some(Arc::new(Tool {
                    lead: lead.clone(),
                    agents: self.agents.clone(),
                    services: self.services.clone(),
                    processes: self.processes.clone(),
                    views: self.views.clone(),
                    owner: self.owner.clone(),
                    runtime: self.runtime.clone(),
                    pre_rename_runtime: self.input_runtime.clone(),
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

impl Tool {
    fn label(&self) -> String {
        self.definition
            .label
            .clone()
            .unwrap_or_else(|| self.definition.name.clone())
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
            let lead = self.lead.clone();
            let label = self.label();
            let tool_name = format!("mod_{}_{}", self.id, self.definition.name);
            self.views.progress(&self.owner, &label, "Running");
            let views = self.views.clone();
            let progress_owner = self.owner.clone();
            let progress_label = label.clone();
            let (requests, mut receiver) = tokio::sync::mpsc::channel::<(
                codex_omd::ModHostCall,
                std::sync::mpsc::SyncSender<std::io::Result<Value>>,
            )>(1);
            let job = tokio::task::spawn_blocking(move || {
                owner.task.check_active()?;
                let mut runtime = runtime
                    .lock()
                    .map_err(|_| std::io::Error::other("mod runtime poisoned"))?;
                let active = || {
                    !cancelled.load(std::sync::atomic::Ordering::Acquire)
                        && owner.task.check_active().is_ok()
                };
                runtime.invoke_streaming(
                    &id,
                    generation,
                    "tool",
                    &name,
                    payload,
                    active,
                    |request| {
                        let (sender, reply) = std::sync::mpsc::sync_channel(1);
                        requests
                            .blocking_send((request, sender))
                            .map_err(|_| std::io::Error::other("native_host_stopped"))?;
                        loop {
                            if !active() {
                                return Err(std::io::Error::other("callback_cancelled"));
                            }
                            match reply.recv_timeout(std::time::Duration::from_millis(20)) {
                                Ok(value) => return value,
                                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => (),
                                Err(error) => return Err(std::io::Error::other(error)),
                            }
                        }
                    },
                    |update| views.progress(&progress_owner, &progress_label, &update),
                )
            });
            let mut ordinal = 0u32;
            while let Some((request, reply)) = receiver.recv().await {
                ordinal += 1;
                let mut nested_call = call.clone();
                nested_call.call_id =
                    format!("{}/mod/{}/{generation}/{ordinal}", call.call_id, self.id);
                let value = operations::dispatch(
                    &self.agents,
                    &self.services,
                    &self.processes,
                    &self.pre_rename_runtime,
                    &lead,
                    &self.id,
                    generation,
                    &nested_call,
                    request,
                )
                .await
                .map_err(std::io::Error::other);
                let _ = reply.send(value);
            }
            let result = job
                .await
                .map_err(|e| e.to_string())
                .and_then(|result| result.map_err(|e| e.to_string()));
            let result = match result {
                Ok(value) => value,
                Err(error) => {
                    self.views
                        .finish(&self.owner, &self.id, &tool_name, &label, "failed");
                    self.agents.cleanup_owned(&self.id, generation).await;
                    self.services.cleanup_owned(&self.id, generation).await;
                    self.processes.cleanup_owned(&self.id, generation);
                    return Err(FunctionCallError::RespondToModel(error));
                }
            };
            self.views
                .finish(&self.owner, &self.id, &tool_name, &label, "completed");
            self.owner
                .task
                .check_active()
                .map_err(|e| FunctionCallError::RespondToModel(e.to_string()))?;
            Ok(Box::new(JsonToolOutput::new(result)) as Box<dyn ToolOutput>)
        })
    }
}
