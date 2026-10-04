use super::*;

struct Tool {
    core: Arc<Core>,
    lead: Arc<Lead>,
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
        let Some(lead) = thread.get::<Lead>().filter(|lead| lead.owner == "lead") else {
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
        let Some(lead) = thread.get::<Lead>().filter(|lead| lead.owner == "lead") else {
            return Vec::new();
        };
        let Ok(mut runtime) = self.runtime.lock() else {
            return Vec::new();
        };
        if !runtime.has_task_scoped_tools() {
            return self.tool_executors(lead, runtime.tools());
        }
        let task = lead.session.task.clone();
        if task.check_active().is_err() {
            return self.tool_executors(
                lead,
                runtime
                    .tools()
                    .into_iter()
                    .filter(|(_, _, tool)| !tool.task_scoped)
                    .collect(),
            );
        }
        let ledger = lead.ledger();
        let tools =
            runtime.tools_for_step(thread_id(thread), ledger, || task.check_active().is_ok());
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
                    core: self.core.clone(),
                    lead: lead.clone(),
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

    fn name(&self) -> String {
        if self.id.is_empty() {
            self.definition.name.clone()
        } else {
            format!("mod_{}_{}", self.id, self.definition.name)
        }
    }
}

impl<'call> ToolExecutor<ToolCall<'call>> for Tool {
    fn tool_name(&self) -> ToolName {
        ToolName::plain(self.name())
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec::Function(ResponsesApiTool {
            name: self.name(),
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

    fn search_info(&self) -> Option<codex_tools::ToolSearchInfo> {
        let source = (!self.id.is_empty()).then(|| codex_tools::ToolSearchSourceInfo {
            name: format!("{} mod tools", self.id),
            description: Some(format!("Tools of the enabled {} mod", self.id)),
        });
        codex_tools::ToolSearchInfo::from_tool_spec(self.spec(), source)
    }

    fn handle<'a>(&'a self, call: ToolCall<'call>) -> ToolExecutorFuture<'a>
    where
        'call: 'a,
    {
        Box::pin(async move {
            let payload: Value = serde_json::from_str(call.function_arguments()?)
                .map_err(|e| FunctionCallError::RespondToModel(e.to_string()))?;
            let core = &self.core;
            let runtime = core.runtime.clone();
            let (id, name, generation) = (
                self.id.clone(),
                self.definition.name.clone(),
                self.generation,
            );
            let cancelled = Arc::new(AtomicBool::new(false));
            let _cancellation = Cancellation(cancelled.clone());
            let (label, tool_name) = (self.label(), self.name());
            core.views.progress(&core.host, &label, "Running");
            let (views, host_info, progress_label) =
                (core.views.clone(), core.host.clone(), label.clone());
            let (requests, mut receiver) = tokio::sync::mpsc::channel::<HostRequest>(1);
            let flag = cancelled.clone();
            let thread = self.lead.thread.to_string();
            let job = tokio::task::spawn_blocking(move || {
                let _thread = codex_omd::StateThread::enter(Some(thread));
                let poisoned = || std::io::Error::other("mod runtime poisoned");
                let facts = facts(&*runtime.lock().map_err(|_| poisoned())?);
                let active = || !flag.load(Ordering::Acquire);
                let host =
                    |caller: &str, request| forward(&requests, &facts, caller, request, &active);
                let progress =
                    |update: String| views.progress(&host_info, &progress_label, &update);
                if id.is_empty() {
                    return runtime
                        .lock()
                        .map_err(|_| poisoned())?
                        .invoke_tool(&id, generation, &name, payload, active, host, progress);
                }
                codex_omd::invoke_shared(
                    &runtime, &id, generation, "tool", &name, payload, active, host, progress,
                )
            });
            let mut ordinal = 0u32;
            while let Some(host_call) = receiver.recv().await {
                ordinal += 1;
                let mut nested = call.clone();
                nested.call_id = format!("{}/mod/{}/{generation}/{ordinal}", call.call_id, self.id);
                let value = operations::dispatch(
                    core,
                    &self.lead,
                    operations::Caller {
                        id: &host_call.caller,
                        source: &host_call.source,
                        grants: host_call.grants,
                        generation,
                        origin: codex_omd::data_store::Origin::Tool,
                        record_changes: false,
                    },
                    Some(&nested),
                    host_call.request,
                    &cancelled,
                )
                .await;
                let _ = host_call.reply.send(value.map_err(std::io::Error::other));
            }
            let result = job
                .await
                .map_err(|e| e.to_string())
                .and_then(|result| result.map_err(|e| e.to_string()));
            match result {
                Ok(value) => {
                    core.views
                        .finish(&core.host, &self.id, &tool_name, &label, "completed");
                    Ok(Box::new(JsonToolOutput::new(value)) as Box<dyn ToolOutput>)
                }
                Err(error) => {
                    core.views
                        .finish(&core.host, &self.id, &tool_name, &label, "failed");
                    core.agents.cleanup_owned(&self.id, generation).await;
                    core.services.cleanup_owned(&self.id, generation).await;
                    self.lead
                        .session
                        .processes
                        .cleanup_owned(&self.id, generation);
                    super::access::release_servers(&self.lead, generation, Some(&self.id)).await;
                    Err(FunctionCallError::RespondToModel(error))
                }
            }
        })
    }
}
