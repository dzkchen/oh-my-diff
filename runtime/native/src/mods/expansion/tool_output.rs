use super::*;
use codex_extension_api::ToolOutputContributor;
use codex_extension_api::ToolOutputInput;

use codex_extension_api::TOOL_OUTPUT_FEEDBACK_BYTES;

const HEAD_BYTES: usize = 48 * 1024;
const TAIL_BYTES: usize = 16 * 1024;
const APPEND_BYTES: usize = 4096;

fn bounded(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn tail(text: &str, limit: usize) -> Option<&str> {
    if text.len() <= HEAD_BYTES {
        return None;
    }
    let mut start = text.len() - limit;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    Some(&text[start..])
}

async fn original(
    lead: &Lead,
    owner: &str,
    source: &str,
    call_id: &str,
    text: &str,
) -> Result<Value, String> {
    let scope = lead.session.data.0.clone();
    let initialized = scope.lock().map_err(|_| "data_scope_poisoned")?.is_some();
    let authority = match initialized {
        true => None,
        false => Some(crate::workspace_operations::WorkspaceAuthority::for_lead(lead).await?),
    };
    let (root, thread) = (lead.host.root.clone(), lead.thread.to_string());
    let (owner, source) = (owner.to_owned(), source.to_owned());
    let (label, text) = (format!("tool_output:{call_id}"), text.to_owned());
    tokio::task::spawn_blocking(move || {
        let mut scope = scope.lock().map_err(|_| "data_scope_poisoned")?;
        if scope.is_none() {
            let authority = authority.ok_or("data_scope_unavailable")?;
            *scope = Some(codex_omd::scoped_data::ScopedDataHosts::new(
                root,
                authority.repository,
                authority.session_root,
                authority.session_database,
                thread,
            ));
        }
        let hosts = scope.as_mut().ok_or("data_scope_unavailable")?;
        let reference = hosts
            .text_evidence(&owner, &source, &label, &text)
            .map_err(|error| error.to_string())?;
        serde_json::to_value(reference).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn decision(value: Value) -> Result<Option<String>, String> {
    match value {
        Value::Null => Ok(None),
        Value::Object(object) if object.len() == 1 => {
            let text = object
                .get("text")
                .and_then(Value::as_str)
                .ok_or("invalid_tool_output_decision")?;
            if text.len() > codex_extension_api::TOOL_OUTPUT_REPLACEMENT_BYTES {
                return Err("tool_output_replacement_too_large".into());
            }
            Ok(Some(text.to_owned()))
        }
        _ => Err("invalid_tool_output_decision".into()),
    }
}

fn append(value: Value) -> Result<Option<String>, String> {
    match value {
        Value::Null => Ok(None),
        Value::Object(object) if object.len() == 1 => match object.get("append") {
            Some(Value::String(text)) if text.len() <= APPEND_BYTES => Ok(Some(text.clone())),
            _ => Err("invalid_tool_output_feedback".into()),
        },
        _ => Err("invalid_tool_output_feedback".into()),
    }
}

impl ToolOutputContributor for Mods {
    fn replacing(&self, _thread_store: &ExtensionData) -> bool {
        self.expansion.tool_output_active()
    }

    fn replace_tool_output<'a>(
        &'a self,
        input: ToolOutputInput<'a>,
    ) -> ExtensionFuture<'a, Option<String>> {
        Box::pin(async move {
            if !self.expansion.tool_output_active() {
                return None;
            }
            let lead = input.thread_store.get::<Lead>()?;
            let runtime = self.runtime.clone();
            let (owner, observers) = tokio::task::spawn_blocking(move || {
                let runtime = runtime.lock().ok()?;
                let owner = runtime.replacement_owner("tool_output");
                let observers = runtime
                    .owners()
                    .into_iter()
                    .map(|(id, _)| id)
                    .filter(|id| {
                        runtime.registered(id, "tool_output") && owner.as_ref() != Some(id)
                    })
                    .collect::<Vec<_>>();
                let owner = owner.and_then(|owner| {
                    let source = runtime.grants(&owner)?.source_sha256;
                    Some((owner, source))
                });
                Some((owner, observers))
            })
            .await
            .ok()
            .flatten()?;
            let arguments = input
                .arguments
                .map(|raw| {
                    serde_json::from_str::<Value>(raw)
                        .unwrap_or_else(|_| Value::String(bounded(raw, HEAD_BYTES).to_owned()))
                })
                .unwrap_or(Value::Null);
            let payload = |text: &str, original: Value| {
                json!({"call_id": input.call_id, "tool": input.tool_name.to_string(),
                    "arguments": arguments, "success": input.success,
                    "text": bounded(text, HEAD_BYTES), "tail": tail(text, TAIL_BYTES),
                    "bytes": text.len(), "original": original})
            };
            let diagnostic = |message: String| {
                self.views
                    .diagnostic(&self.host, "tool_output", Some(message));
            };
            let mut text = None;
            let mut replaced_by = "feedback".to_owned();
            if let Some((owner, source)) = owner {
                match original(&lead, &owner, &source, input.call_id, input.text).await {
                    Ok(reference) => {
                        let result = invoke_one(
                            &self.core,
                            &lead,
                            owner.clone(),
                            "tool_output",
                            payload(input.text, reference),
                        )
                        .await;
                        match result.map(|result| result.and_then(decision)) {
                            Some(Ok(Some(replacement))) => {
                                text = Some(replacement);
                                replaced_by = owner;
                            }
                            Some(Err(error)) => {
                                diagnostic(format!("{owner}: {error}; output kept"))
                            }
                            _ => {}
                        }
                    }
                    Err(error) => diagnostic(format!(
                        "{owner}: original unavailable, output kept: {error}"
                    )),
                }
            }
            let mut appended = String::new();
            for id in observers {
                let current = text.as_deref().unwrap_or(input.text);
                let Some(result) = invoke_one(
                    &self.core,
                    &lead,
                    id.clone(),
                    "tool_output",
                    payload(current, Value::Null),
                )
                .await
                else {
                    continue;
                };
                match result.and_then(append) {
                    Ok(Some(extra))
                        if appended.len() + extra.len() + 2 <= TOOL_OUTPUT_FEEDBACK_BYTES =>
                    {
                        appended.push_str("\n\n");
                        appended.push_str(&extra);
                    }
                    Ok(Some(_)) => diagnostic(format!(
                        "{id}: feedback over the {TOOL_OUTPUT_FEEDBACK_BYTES}-byte budget dropped"
                    )),
                    Ok(None) => {}
                    Err(error) => diagnostic(format!("{id}: {error}; feedback dropped")),
                }
            }
            if !appended.is_empty() {
                text = Some(format!(
                    "{}{appended}",
                    text.as_deref().unwrap_or(input.text)
                ));
            }
            if let Some(text) = &text {
                activity::output_replaced(
                    &self.core,
                    &lead,
                    input.call_id,
                    &replaced_by,
                    input.text,
                    text,
                );
            }
            text
        })
    }
}
