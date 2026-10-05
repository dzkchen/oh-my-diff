use super::*;
use codex_extension_api::CompactionInterceptInput;
use codex_extension_api::CompactionPlan;
use codex_extension_api::CompactionReplacement;
use codex_extension_api::CompactionSettle;
use codex_extension_api::CompactionSettled;
use codex_omd::history;
use std::sync::mpsc::RecvTimeoutError;

fn native() -> CompactionPlan {
    CompactionPlan::Native {
        summary_prompt: None,
        settle: None,
    }
}

/// Maps a settled chain onto a replacement; `items` are what `history.keep` indexes.
fn replacement(
    chain: &codex_omd::ModChain,
    items: &[Value],
    executed: Option<&Value>,
) -> Result<Option<CompactionReplacement>, String> {
    if executed == Some(&chain.result) {
        return Ok(None);
    }
    let by = chain
        .answered_by
        .clone()
        .unwrap_or_else(|| intercept::settled_by(chain));
    if let Some(text) = chain.result["summary"].as_str() {
        return Ok(Some(CompactionReplacement::Summary {
            by,
            text: text.to_owned(),
        }));
    }
    let edit = serde_json::from_value(chain.result["history"].clone())
        .map_err(|error| format!("compaction_history_invalid: {by}: {error}"))?;
    let items = history::compact(items, edit).map_err(|error| format!("{error} ({by})"))?;
    Ok(Some(CompactionReplacement::History { by, items }))
}

impl Mods {
    pub(super) async fn compaction_plan(
        &self,
        input: CompactionInterceptInput<'_>,
    ) -> CompactionPlan {
        let Some(lead) = input
            .thread_store
            .get::<Lead>()
            .filter(|lead| lead.owner == "lead")
        else {
            return native();
        };
        let thread = lead.thread.to_string();
        let (runtime, scope) = (self.runtime.clone(), thread.clone());
        let required = tokio::task::spawn_blocking(move || {
            let _thread = codex_omd::StateThread::enter(Some(scope));
            runtime
                .lock()
                .ok()
                .and_then(|runtime| runtime.intercepts("compaction"))
        })
        .await
        .ok()
        .flatten();
        let Some(required) = required else {
            return native();
        };
        let items = input.history.to_vec();
        let payload = json!({"thread_id": thread, "turn_id": input.turn_id, "trigger": input.trigger,
            "reason": input.reason, "phase": input.phase, "implementation": input.implementation,
            "budget": {"tokens": input.tokens, "auto_limit": input.auto_limit,
                "context_window": input.context_window, "hard": input.hard},
            "items": items.len(), "history": history::compaction_view(&items),
            "summary_prompt": input.summary_prompt});
        let cancelled = Arc::new(AtomicBool::new(false));
        let (reached, at_executor) = tokio::sync::oneshot::channel::<Value>();
        let (settled, results) = std::sync::mpsc::channel::<Value>();
        let (flag, mut reached) = (cancelled.clone(), Some(reached));
        let executor = move |effective: Value| {
            let first = reached.take().ok_or_else(|| {
                std::io::Error::other(
                    "compaction_retry_unavailable: the host compacts once per occurrence",
                )
            })?;
            first
                .send(effective)
                .map_err(|_| std::io::Error::other("compaction_stopped"))?;
            loop {
                if flag.load(Ordering::Acquire) {
                    return Err(std::io::Error::other("callback_cancelled"));
                }
                match results.recv_timeout(std::time::Duration::from_millis(20)) {
                    Ok(result) => return Ok(result),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        return Err(std::io::Error::other("compaction_result_unavailable"));
                    }
                }
            }
        };
        let chain = tokio::spawn(intercept::chain(
            self.core.clone(),
            lead,
            self.runtime.clone(),
            "compaction",
            required,
            payload.clone(),
            json!({"caller": "engine", "thread_id": thread}),
            cancelled.clone(),
            executor,
        ));
        if let Ok(effective) = at_executor.await {
            let summary_prompt = (effective["summary_prompt"] != payload["summary_prompt"])
                .then(|| effective["summary_prompt"].as_str().map(str::to_owned))
                .flatten();
            let (views, host) = (self.views.clone(), self.host.clone());
            let settle: CompactionSettle = Box::new(move |done: CompactionSettled| {
                Box::pin(async move {
                    let _cancel_on_drop = Cancellation(cancelled);
                    let executed = json!({"summary": done.summary,
                        "history": history::compaction_view(&done.history),
                        "usage": done.usage.and_then(|usage| serde_json::to_value(usage).ok()),
                        "provider_call": done.provider_call});
                    let _ = settled.send(executed.clone());
                    let outcome = chain
                        .await
                        .map_err(|error| error.to_string())
                        .and_then(|chain| chain)
                        .and_then(|chain| replacement(&chain, &done.history, Some(&executed)));
                    match outcome {
                        Ok(replacement) => replacement,
                        Err(error) => {
                            views.diagnostic(
                                &host,
                                "compaction",
                                Some(format!("{error}; the host's compaction was kept")),
                            );
                            None
                        }
                    }
                })
            });
            return CompactionPlan::Native {
                summary_prompt,
                settle: Some(settle),
            };
        }
        let chain = match chain
            .await
            .map_err(|error| error.to_string())
            .and_then(|c| c)
        {
            Ok(chain) => chain,
            Err(error) => return CompactionPlan::Fail(format!("mod_interception_failed: {error}")),
        };
        let by = chain
            .answered_by
            .clone()
            .unwrap_or_else(|| intercept::settled_by(&chain));
        for (key, plan) in [("skip", true), ("defer", false)] {
            if let Some(reason) = chain.result[key].as_str() {
                let (by, reason) = (by, reason.to_owned());
                return if plan {
                    CompactionPlan::Skip { by, reason }
                } else {
                    CompactionPlan::Defer { by, reason }
                };
            }
        }
        match replacement(&chain, &items, None) {
            Ok(Some(replacement)) => CompactionPlan::Replace(replacement),
            Ok(None) => native(),
            Err(error) => CompactionPlan::Fail(error),
        }
    }
}
