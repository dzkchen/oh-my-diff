mod agents;
mod operations;
mod policy;
pub(crate) mod services;
mod tools;
mod view;

use super::*;
use codex_extension_api::CompactionLifecycleInput;
use codex_extension_api::ThreadResumeInput;
use codex_extension_api::TurnLifecycleContributor;
use codex_extension_api::TurnStartInput;
use codex_extension_api::UserInputDecision;
use codex_extension_api::UserInputInterceptInput;
use codex_omd::ModHost;
use codex_omd::ModInputDecision;
use codex_omd::ModTool;
use std::sync::Mutex;

fn lead_thread(thread: &ExtensionData) -> bool {
    thread
        .get::<Lead>()
        .is_some_and(|lead| lead.owner == "lead")
}

struct TurnRecord {
    turn_id: String,
    error: Option<String>,
}

struct Mods {
    owner: Arc<Host>,
    runtime: Arc<Mutex<ModHost>>,
    input_runtime: Arc<Mutex<ModHost>>,
    agents: Arc<agents::Agents>,
    services: Arc<services::Services>,
    views: Arc<view::Views>,
    turn: Mutex<Option<TurnRecord>>,
}

fn preview(text: &str) -> String {
    let mut shown: String = text.chars().take(1024).collect();
    if shown.len() < text.len() {
        shown.push_str("...");
    }
    shown
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
    let validator = |schema: &Value| {
        codex_extension_api::parse_tool_input_schema(schema)
            .map(|_| ())
            .map_err(std::io::Error::other)
    };
    let runtime = ModHost::open_validated(root.clone(), validator).map_err(|e| e.to_string())?;
    let input_runtime =
        ModHost::open_validated(root.clone(), validator).map_err(|e| e.to_string())?;
    let runtime = Arc::new(Mutex::new(runtime));
    let views = Arc::new(view::Views::new());
    let extension = Arc::new(Mods {
        agents: Arc::new(agents::Agents::new(
            runtime.clone(),
            views.clone(),
            owner.clone(),
        )),
        owner,
        runtime,
        input_runtime: Arc::new(Mutex::new(input_runtime)),
        services: Arc::new(services::Services::default()),
        views,
        turn: Mutex::new(None),
    });
    registry.config_contributor(extension.clone());
    registry.prompt_contributor(extension.clone());
    registry.thread_lifecycle_contributor(extension.clone());
    registry.tool_lifecycle_contributor(extension.clone());
    registry.turn_lifecycle_contributor(extension.clone());
    registry.tool_contributor(extension);
    Ok(())
}

impl Mods {
    async fn cleanup_failed(&self) {
        let runtime = self.runtime.clone();
        let failed = tokio::task::spawn_blocking(move || {
            let Ok(runtime) = runtime.lock() else {
                return Vec::new();
            };
            runtime.status()["mods"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item["error"].is_string())
                .filter_map(|item| {
                    item["id"]
                        .as_str()
                        .map(|id| (id.to_owned(), runtime.generation()))
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        for (id, generation) in failed {
            self.agents.cleanup_owned(&id, generation).await;
            self.services.cleanup_owned(&id, generation).await;
        }
    }

    async fn event(&self, event: &'static str, payload: Value) -> Vec<PromptFragment> {
        let runtime = self.runtime.clone();
        let owner = self.owner.clone();
        let views = self.views.clone();
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _cancellation = Cancellation(cancelled.clone());
        let fragments = tokio::task::spawn_blocking(move || {
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
            let terminal_views = runtime.event_guarded("terminal", json!({"event":event,"checkpoint":owner.task.checkpoint().ok().flatten()}), || !cancelled.load(std::sync::atomic::Ordering::Acquire));
            let mut view = codex_omd::ModView::default();
            let mut supplier = None;
            for (id, result) in terminal_views {
                if result.as_ref().is_ok_and(Value::is_null) { continue; }
                match result.and_then(codex_omd::ModView::parse) {
                    Ok(candidate) if supplier.is_none() => { view = candidate; supplier = Some(id); }
                    _ => { view = codex_omd::ModView { title: Some("Mod UI failed".into()), panels: vec![codex_omd::ModPanel { title: "Recovery".into(), lines: vec!["Disable or reload the failed mod".into()] }], ..Default::default() }; supplier = None; break; }
                }
            }
            let status = runtime.status();
            let mut errors = status["mods"].as_array().into_iter().flatten().filter_map(|item| item["error"].as_str().map(|error| format!("{}: {error}", item["id"].as_str().unwrap_or("mod")))).collect::<Vec<_>>();
            if let Some(error) = status["reload_error"].as_str() { errors.push(format!("Reload: {error}")); }
            if !errors.is_empty() {
                view = codex_omd::ModView { title: Some("Mod recovery".into()), ..Default::default() };
                view.panels.push(codex_omd::ModPanel { title: "Mod errors".into(), lines: errors.into_iter().take(16).map(|error| error.chars().filter(|c| !c.is_control()).take(180).collect()).collect() });
                supplier = None;
            }
            views.base(&owner, view, supplier);
            if let Some(error) = status["reload_error"].as_str() {
                fragments.push(PromptFragment::developer_capability(
                    format!("Mod reload failed; previous eligible mods retained: {error}"),
                    ContentItemKind("oh_my_diff.mod_error".into()),
                ));
            }
            let _ = owner.persist_runtime_file("mod-status.json", &status);
            fragments
        }).await.unwrap_or_default();
        self.cleanup_failed().await;
        fragments
    }
}

impl Mods {
    fn take_turn(&self) -> Option<TurnRecord> {
        self.turn.lock().ok().and_then(|mut turn| turn.take())
    }

    async fn compaction(&self, event: &'static str, input: CompactionLifecycleInput<'_>) {
        if lead_thread(input.thread_store) {
            self.event(
                event,
                json!({"turn_id":input.turn_id,"trigger":input.trigger}),
            )
            .await;
        }
    }
}

impl TurnLifecycleContributor for Mods {
    fn on_turn_abort<'a>(
        &'a self,
        input: codex_extension_api::TurnAbortInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if lead_thread(input.thread_store) {
                self.agents.cleanup().await;
                self.services.cleanup().await;
                if let Some(turn) = self.take_turn() {
                    self.event("turn_end", json!({"turn_id":turn.turn_id,"outcome":"aborted","reason":format!("{:?}", input.reason)}))
                        .await;
                }
            }
        })
    }
    fn on_turn_error<'a>(
        &'a self,
        input: codex_extension_api::TurnErrorInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if lead_thread(input.thread_store)
                && let Ok(mut turn) = self.turn.lock()
                && let Some(turn) = turn.as_mut()
            {
                turn.error = Some(format!("{:?}", input.error));
            }
        })
    }
    fn on_turn_stop<'a>(
        &'a self,
        input: codex_extension_api::TurnStopInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if lead_thread(input.thread_store) {
                self.agents.cleanup().await;
                self.services.cleanup().await;
                if let Some(turn) = self.take_turn() {
                    let payload = match turn.error {
                        Some(error) => {
                            json!({"turn_id":turn.turn_id,"outcome":"error","error":error})
                        }
                        None => json!({"turn_id":turn.turn_id,"outcome":"completed"}),
                    };
                    self.event("turn_end", payload).await;
                }
            }
        })
    }
    fn intercept_user_input<'a>(
        &'a self,
        input: UserInputInterceptInput<'a>,
    ) -> ExtensionFuture<'a, UserInputDecision> {
        Box::pin(async move {
            if !lead_thread(input.thread_store) {
                return UserInputDecision::Keep;
            }
            let runtime = self.input_runtime.clone();
            let payload = json!({"text":input.text,"attachments":input.attachments});
            let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let _cancellation = Cancellation(cancelled.clone());
            let unavailable = || UserInputDecision::Deny {
                notice: "Mod input hook unavailable; the prompt was not sent.".into(),
            };
            tokio::task::spawn_blocking(move || {
                let Ok(mut runtime) = runtime.lock() else {
                    return unavailable();
                };
                runtime.turn_boundary();
                let mut rewrite: Option<(String, String)> = None;
                for (id, result) in runtime.event_guarded("input", payload, || {
                    !cancelled.load(std::sync::atomic::Ordering::Acquire)
                }) {
                    match result.and_then(|value| ModInputDecision::parse(&value)) {
                        Err(error) => {
                            return UserInputDecision::Deny {
                                notice: format!("Mod {id} input hook failed; the prompt was not sent and the mod is disabled until reload: {error}"),
                            };
                        }
                        Ok(ModInputDecision::Keep) => {}
                        Ok(ModInputDecision::Deny(reason)) => {
                            return UserInputDecision::Deny {
                                notice: format!("Mod {id} denied this prompt: {reason}"),
                            };
                        }
                        Ok(ModInputDecision::Rewrite(text)) => {
                            if rewrite.is_some() {
                                return UserInputDecision::Deny {
                                    notice: "mod_input_rewrite_conflict; the prompt was not sent.".into(),
                                };
                            }
                            rewrite = Some((id, text));
                        }
                    }
                }
                match rewrite {
                    Some((id, text)) => UserInputDecision::Rewrite {
                        notice: format!("Mod {id} rewrote this prompt. The model received:\n{}", preview(&text)),
                        text,
                    },
                    None => UserInputDecision::Keep,
                }
            })
            .await
            .unwrap_or_else(|_| unavailable())
        })
    }
    fn on_compaction_start<'a>(
        &'a self,
        input: CompactionLifecycleInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(self.compaction("compaction_start", input))
    }
    fn on_compaction_end<'a>(
        &'a self,
        input: CompactionLifecycleInput<'a>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(self.compaction("compaction_end", input))
    }

    fn on_turn_start<'a>(&'a self, input: TurnStartInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            if !lead_thread(input.thread_store) {
                return;
            }
            self.agents.cleanup().await;
            self.services.cleanup().await;
            let runtime = self.runtime.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(mut runtime) = runtime.lock() {
                    runtime.turn_boundary();
                }
            })
            .await;
            if let Ok(mut turn) = self.turn.lock() {
                *turn = Some(TurnRecord {
                    turn_id: input.turn_id.to_owned(),
                    error: None,
                });
            }
            self.event("turn_start", json!({"turn_id":input.turn_id}))
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
                self.agents.cleanup().await;
                self.services.cleanup().await;
                self.event("stop", Value::Null).await;
            }
        })
    }
}

impl ToolLifecycleContributor for Mods {
    fn intercept_tool<'a>(
        &'a self,
        input: ToolStartInput<'a>,
    ) -> ExtensionFuture<'a, Result<Option<(ToolName, codex_tools::ToolPayload)>, String>> {
        Box::pin(async move {
            if !lead_thread(input.thread_store) {
                return Ok(None);
            }
            let codex_tools::ToolPayload::Function { arguments } = input.payload else {
                return Ok(None);
            };
            let original_tool = input.tool_name.clone();
            let arguments: Value = serde_json::from_str(arguments).map_err(|e| e.to_string())?;
            let payload = json!({"tool":input.tool_name.to_string(),"arguments":arguments,"call_id":input.call_id});
            let runtime = self.runtime.clone();
            let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let _cancellation = Cancellation(cancelled.clone());
            let result = tokio::task::spawn_blocking(move || {
                let mut runtime = runtime.lock().map_err(|_| "mod_runtime_poisoned")?;
                let mut replacement = None;
                for (id, result) in runtime.event_guarded("tool_before", payload, || {
                    !cancelled.load(std::sync::atomic::Ordering::Acquire)
                }) {
                    let value =
                        result.map_err(|e| format!("mod_interception_failed: {id}: {e}"))?;
                    if value.is_null() {
                        continue;
                    }
                    let object = value.as_object().ok_or("invalid_interception_result")?;
                    if object.is_empty()
                        || object.len() > 2
                        || object
                            .keys()
                            .any(|key| !["arguments", "tool", "deny"].contains(&key.as_str()))
                    {
                        return Err("invalid_interception_result".into());
                    }
                    if let Some(reason) = value.get("deny").and_then(Value::as_str) {
                        return Err(format!(
                            "mod_tool_denied: {id}: {}",
                            reason.chars().take(512).collect::<String>()
                        ));
                    }
                    let arguments = value
                        .get("arguments")
                        .filter(|v| v.is_object())
                        .ok_or("invalid_interception_result")?;
                    if replacement.is_some() {
                        return Err("mod_tool_replacement_conflict".into());
                    }
                    let target = match value.get("tool") {
                        None => original_tool.clone(),
                        Some(value) => ToolName::plain(
                            value
                                .as_str()
                                .filter(|s| !s.is_empty() && s.len() <= 128)
                                .ok_or("invalid_replacement_tool")?,
                        ),
                    };
                    replacement = Some((
                        target,
                        codex_tools::ToolPayload::Function {
                            arguments: serde_json::to_string(arguments)
                                .map_err(|e| e.to_string())?,
                        },
                    ));
                }
                Ok(replacement)
            })
            .await
            .map_err(|e| e.to_string())?;
            self.cleanup_failed().await;
            result
        })
    }

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
