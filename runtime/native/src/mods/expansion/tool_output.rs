use super::*;
use codex_extension_api::ToolOutputContributor;
use codex_extension_api::ToolOutputInput;

use codex_extension_api::TOOL_OUTPUT_FEEDBACK_BYTES;

const HEAD_BYTES: usize = 48 * 1024;
const TAIL_BYTES: usize = 16 * 1024;
const APPEND_BYTES: usize = 4096;

fn bounded(text: &str) -> &str {
    &text[..text.floor_char_boundary(HEAD_BYTES)]
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
            || self.pending.lock().is_ok_and(|pending| !pending.is_empty())
    }

    fn wants_value(&self, call_id: &str) -> bool {
        self.pending
            .lock()
            .is_ok_and(|pending| pending.get(call_id).is_some_and(|pending| pending.values))
    }

    fn replace_tool_output<'a>(
        &'a self,
        input: ToolOutputInput<'a>,
    ) -> ExtensionFuture<'a, Option<String>> {
        Box::pin(async move {
            let diagnostic = |message: String| {
                self.views
                    .diagnostic(&self.host, "tool_output", Some(message));
            };
            let head = bounded(input.text);
            let mut executed = json!({"output": head, "success": input.success,
                "truncated": input.text.len() > HEAD_BYTES});
            if let Some(value) = input.value
                && serde_json::to_vec(value).is_ok_and(|bytes| {
                    bytes.len() <= 32_768 && head.len() + bytes.len() <= HEAD_BYTES
                })
            {
                executed["value"] = value.clone();
            }
            let mut text = None;
            let mut replaced_by = "feedback".to_owned();
            match self.resume(input.call_id, Ok(executed.clone())).await {
                Some(Ok(chain))
                    if chain.result.get("deny").is_some()
                        || chain.result["output"] != executed["output"] =>
                {
                    replaced_by = super::super::intercept::settled_by(&chain);
                    text = Some(match chain.result["deny"].as_str() {
                        Some(reason) => format!("mod_tool_denied: {replaced_by}: {reason}"),
                        None => chain.result["output"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                    });
                }
                Some(Err(error)) => {
                    replaced_by = "intercept".to_owned();
                    text = Some(format!("mod_interception_failed: {error}"));
                }
                _ => {}
            }
            let Some(lead) = input.thread_store.get::<Lead>() else {
                return text;
            };
            if text.is_some() && replaced_by != "intercept" {
                let (runtime, id) = (self.runtime.clone(), replaced_by.clone());
                let source = tokio::task::spawn_blocking(move || {
                    runtime
                        .lock()
                        .ok()
                        .and_then(|runtime| runtime.grants(&id))
                        .map(|grants| grants.source_sha256)
                })
                .await
                .ok()
                .flatten();
                if let Some(source) = source
                    && let Err(error) =
                        original(&lead, &replaced_by, &source, input.call_id, input.text).await
                {
                    diagnostic(format!("{replaced_by}: original unavailable: {error}"));
                }
            }
            if !self.expansion.tool_output_active() {
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
                return text;
            }
            let runtime = self.runtime.clone();
            let observers = tokio::task::spawn_blocking(move || {
                let runtime = runtime.lock().ok()?;
                Some(
                    runtime
                        .owners()
                        .into_iter()
                        .map(|(id, _)| id)
                        .filter(|id| runtime.registered(id, "tool_output"))
                        .collect::<Vec<_>>(),
                )
            })
            .await
            .ok()
            .flatten()?;
            let arguments = input
                .arguments
                .map(|raw| {
                    serde_json::from_str::<Value>(raw)
                        .unwrap_or_else(|_| Value::String(bounded(raw).to_owned()))
                })
                .unwrap_or(Value::Null);
            let payload = |text: &str| {
                json!({"call_id": input.call_id, "tool": input.tool_name.to_string(),
                    "arguments": arguments, "success": input.success,
                    "text": bounded(text),
                    "tail": (text.len() > HEAD_BYTES).then(|| &text[text.ceil_char_boundary(text.len() - TAIL_BYTES)..]),
                    "bytes": text.len()})
            };
            let mut appended = String::new();
            for id in observers {
                let current = text.as_deref().unwrap_or(input.text);
                let Some(result) = invoke_one(
                    &self.core,
                    &lead,
                    id.clone(),
                    "tool_output",
                    payload(current),
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
