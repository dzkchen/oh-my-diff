use super::*;
use codex_extension_api::ToolSpecAdjustment;
use codex_extension_api::ToolSpecContributor;
use codex_extension_api::ToolSpecView;

const SPEC_TOOLS: usize = 512;
const PARAMETER_BYTES: usize = 16 * 1024;

/// Turns the composed tool list into hide, defer and re-describe decisions against the original.
pub(super) fn adjustment(original: &[Value], tools: &Value) -> ToolSpecAdjustment {
    let tools = tools.as_array().cloned().unwrap_or_default();
    let mut adjustment = ToolSpecAdjustment::default();
    for before in original {
        let name = before["name"].as_str().unwrap_or_default();
        let Some(after) = tools.iter().find(|tool| tool["name"] == name) else {
            adjustment.hide.push(name.to_owned());
            continue;
        };
        if after["deferred"] == true {
            adjustment.defer.push(name.to_owned());
        }
        let description = (after["description"] != before["description"])
            .then(|| after["description"].as_str().map(str::to_owned))
            .flatten();
        let parameters = (after["parameters"] != before["parameters"]
            && after["parameters"].is_object())
        .then(|| after["parameters"].clone());
        if description.is_some() || parameters.is_some() {
            adjustment
                .describe
                .insert(name.to_owned(), (description, parameters));
        }
    }
    adjustment
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
                json!({"name": spec.name, "description": spec.description.chars().take(4096).collect::<String>(),
                    "parameters": parameters, "deferred": false})
            })
            .collect::<Vec<_>>();
        let payload = json!({"thread_id": lead.thread.to_string(), "route": route, "tools": tools});
        let origin = json!({"caller": "engine", "thread_id": lead.thread.to_string()});
        let chain = codex_omd::intercept_shared(
            &self.runtime,
            "tool_specs",
            self.expansion.tool_specs_required.load(Ordering::Acquire),
            payload,
            origin,
            || true,
            |_, _| {
                Err(std::io::Error::other(
                    "host_operation_unavailable: tool_specs runs without host operations",
                ))
            },
            |effective| Ok(json!({"tools": effective["tools"]})),
        );
        match chain {
            Ok(chain) => {
                self.views.diagnostic(&self.host, "tool_specs", None);
                Some(adjustment(&tools, &chain.result["tools"]))
            }
            Err(error) => {
                self.views.diagnostic(
                    &self.host,
                    "tool_specs",
                    Some(format!("{error}; native tool specs kept")),
                );
                None
            }
        }
    }
}
