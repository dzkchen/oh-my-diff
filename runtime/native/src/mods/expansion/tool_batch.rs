use super::*;
use codex_extension_api::ToolBatchContributor;
use codex_extension_api::ToolBatchInput;
use codex_extension_api::ToolBatchMerge;

const MERGES: usize = 32;

pub(in crate::mods) fn tool_before_payload(
    turn_store: &ExtensionData,
    call_id: &str,
    tool: &ToolName,
    arguments: &Value,
    raw: &str,
) -> Value {
    let facts = turn_store
        .get::<codex_extension_api::ToolCallFacts>()
        .and_then(|facts| facts.get(call_id))
        .unwrap_or_default();
    json!({"tool": tool.to_string(), "arguments": arguments, "call_id": call_id,
        "schema": facts.schema, "raw_arguments": raw,
        "batch": facts.batch.map(|batch| json!({"id": batch.id, "index": batch.index, "size": batch.size}))})
}

pub(super) fn parse(
    owner: &str,
    value: Value,
    known: &[String],
) -> Result<Vec<ToolBatchMerge>, String> {
    let invalid = || "invalid_tool_batch_decision".to_owned();
    let merges = match value {
        Value::Null => return Ok(Vec::new()),
        Value::Object(object) if object.len() == 1 => object
            .get("merge")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(invalid)?,
        _ => return Err(invalid()),
    };
    if merges.len() > MERGES {
        return Err(invalid());
    }
    merges
        .into_iter()
        .map(|merge| {
            let object = merge.as_object().ok_or_else(invalid)?;
            let success_per_call = match object.get("success_per_call") {
                None => false,
                Some(Value::Bool(flag)) => *flag,
                Some(_) => return Err(invalid()),
            };
            if object.len() != 3 + usize::from(object.contains_key("success_per_call")) {
                return Err(invalid());
            }
            let call_ids = object
                .get("call_ids")
                .and_then(Value::as_array)
                .ok_or_else(invalid)?
                .iter()
                .map(|id| {
                    id.as_str()
                        .filter(|id| known.iter().any(|known| known == id))
                        .map(str::to_owned)
                        .ok_or_else(invalid)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let tool = object
                .get("tool")
                .and_then(Value::as_str)
                .filter(|tool| !tool.is_empty() && tool.len() <= 64)
                .ok_or_else(invalid)?;
            let arguments = object
                .get("arguments")
                .filter(|arguments| arguments.is_object())
                .ok_or_else(invalid)?;
            Ok(ToolBatchMerge {
                call_ids,
                tool: format!("mod_{owner}_{tool}"),
                arguments: arguments.to_string(),
                success_per_call,
            })
        })
        .collect()
}

impl ToolBatchContributor for Mods {
    fn batching(&self, thread_store: &ExtensionData) -> bool {
        self.expansion.tool_batch.load(Ordering::Acquire) && lead_thread(thread_store)
    }

    fn merge_tool_batch<'a>(
        &'a self,
        input: ToolBatchInput<'a>,
    ) -> ExtensionFuture<'a, Vec<ToolBatchMerge>> {
        Box::pin(async move {
            let Some(lead) = input.thread_store.get::<Lead>() else {
                return Vec::new();
            };
            let known = input
                .calls
                .iter()
                .map(|call| call.call_id.clone())
                .collect::<Vec<_>>();
            let calls = input
                .calls
                .iter()
                .map(|call| {
                    let arguments = serde_json::from_str::<Value>(&call.arguments)
                        .unwrap_or_else(|_| Value::String(call.arguments.clone()));
                    json!({"call_id": call.call_id, "tool": call.tool, "arguments": arguments,
                        "parallel_safe": call.parallel_safe})
                })
                .collect::<Vec<_>>();
            let payload = json!({"batch_id": input.batch_id, "thread_id": lead.thread.to_string(), "calls": calls});
            let runtime = self.runtime.clone();
            let cancelled = Arc::new(AtomicBool::new(false));
            let _cancellation = Cancellation(cancelled.clone());
            let result = tokio::task::spawn_blocking(move || {
                let mut runtime = runtime.lock().map_err(|_| "mod_runtime_poisoned".to_owned())?;
                let owner = runtime
                    .replacement_owner("tool_batch")
                    .ok_or("tool_batch_owner_unavailable")?;
                let generation = runtime.generation();
                let value = runtime
                    .invoke_with(
                        &owner,
                        generation,
                        "tool_batch",
                        "",
                        payload,
                        || !cancelled.load(Ordering::Acquire),
                        |_| {
                            Err(std::io::Error::other(
                                "host_operation_unavailable: tool_batch runs without host operations",
                            ))
                        },
                    )
                    .map_err(|error| error.to_string())?;
                parse(&owner, value, &known).map_err(|error| format!("{owner}: {error}"))
            })
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result);
            self.cleanup_failed(Some(&lead)).await;
            match result {
                Ok(merges) => merges,
                Err(error) => {
                    self.views.diagnostic(
                        &self.host,
                        "tool_batch",
                        Some(format!("{error}; calls dispatched individually")),
                    );
                    Vec::new()
                }
            }
        })
    }
}
