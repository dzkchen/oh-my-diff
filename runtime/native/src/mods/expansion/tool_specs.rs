use super::*;
use codex_extension_api::ToolSpecAdjustment;
use codex_extension_api::ToolSpecContributor;
use codex_extension_api::ToolSpecView;

const SPEC_TOOLS: usize = 512;
const PARAMETER_BYTES: usize = 16 * 1024;

pub(super) fn parse(value: Value) -> Result<Option<ToolSpecAdjustment>, String> {
    let invalid = || "invalid_tool_specs_decision".to_owned();
    let object = match value {
        Value::Null => return Ok(None),
        Value::Object(object) if object.keys().all(|key| key == "hide" || key == "describe") => {
            object
        }
        _ => return Err(invalid()),
    };
    let mut adjustment = ToolSpecAdjustment::default();
    if let Some(hide) = object.get("hide") {
        let hide = hide
            .as_array()
            .filter(|hide| hide.len() <= 256)
            .ok_or_else(invalid)?;
        adjustment.hide = hide
            .iter()
            .map(|name| name.as_str().map(str::to_owned).ok_or_else(invalid))
            .collect::<Result<_, _>>()?;
    }
    if let Some(describe) = object.get("describe") {
        let describe = describe
            .as_object()
            .filter(|describe| describe.len() <= 128)
            .ok_or_else(invalid)?;
        for (name, entry) in describe {
            let entry = entry
                .as_object()
                .filter(|entry| {
                    entry
                        .keys()
                        .all(|key| key == "description" || key == "parameters")
                })
                .ok_or_else(invalid)?;
            let description = match entry.get("description") {
                None => None,
                Some(Value::String(text)) => Some(text.clone()),
                Some(_) => return Err(invalid()),
            };
            let parameters = match entry.get("parameters") {
                None => None,
                Some(schema @ Value::Object(_)) => Some(schema.clone()),
                Some(_) => return Err(invalid()),
            };
            adjustment
                .describe
                .insert(name.clone(), (description, parameters));
        }
    }
    Ok(Some(adjustment))
}

impl ToolSpecContributor for Mods {
    fn adjusting(&self, thread_store: &ExtensionData) -> bool {
        self.expansion.tool_specs.load(Ordering::Acquire) && lead_thread(thread_store)
    }

    fn adjust_tool_specs(
        &self,
        thread_store: &ExtensionData,
        specs: &[ToolSpecView],
    ) -> Option<ToolSpecAdjustment> {
        if !self.adjusting(thread_store) {
            return None;
        }
        let lead = thread_store.get::<Lead>()?;
        let route = self
            .host
            .accounts
            .0
            .lock()
            .ok()?
            .get(&lead.thread.to_string())
            .map(|account| {
                json!({"name": account.route.clone().unwrap_or_else(|| "session".into()),
                    "model": account.model, "provider": account.provider})
            });
        let tools = specs
            .iter()
            .take(SPEC_TOOLS)
            .map(|spec| {
                let parameters = if spec.parameters.to_string().len() <= PARAMETER_BYTES {
                    spec.parameters.clone()
                } else {
                    Value::Null
                };
                json!({"name": spec.name, "description": spec.description, "parameters": parameters})
            })
            .collect::<Vec<_>>();
        let payload = json!({"thread_id": lead.thread.to_string(), "route": route, "tools": tools});
        let mut runtime = self.runtime.lock().ok()?;
        let owner = runtime.replacement_owner("tool_specs")?;
        let generation = runtime.generation();
        let result = runtime
            .invoke_with(
                &owner,
                generation,
                "tool_specs",
                "",
                payload,
                || true,
                |_| {
                    Err(std::io::Error::other(
                        "host_operation_unavailable: tool_specs runs without host operations",
                    ))
                },
            )
            .map_err(|error| error.to_string())
            .and_then(parse);
        drop(runtime);
        match result {
            Ok(adjustment) => {
                self.views.diagnostic(&self.host, "tool_specs", None);
                adjustment
            }
            Err(error) => {
                self.views.diagnostic(
                    &self.host,
                    "tool_specs",
                    Some(format!("{owner}: {error}; native tool specs kept")),
                );
                None
            }
        }
    }
}
