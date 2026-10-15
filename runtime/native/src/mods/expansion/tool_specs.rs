use super::*;
use codex_extension_api::ToolInventoryEntry;
use codex_extension_api::ToolSpecAdjustment;
use codex_extension_api::ToolSpecContributor;
use codex_extension_api::ToolSpecView;

const SPEC_TOOLS: usize = 512;
const PARAMETER_BYTES: usize = 16 * 1024;

fn bounded_description(text: &str) -> String {
    text.chars().take(4096).collect()
}

fn bounded_parameters(parameters: &Value) -> Value {
    if parameters.to_string().len() <= PARAMETER_BYTES {
        parameters.clone()
    } else {
        Value::Null
    }
}

fn inventory_entry(tool: &ToolInventoryEntry) -> Value {
    json!({"name": tool.name, "kind": tool.kind, "server": tool.server,
        "original": {"description": bounded_description(&tool.description),
            "parameters": bounded_parameters(&tool.parameters), "freeform": tool.freeform},
        "effective": tool.effective.as_ref().map(|view| json!({
            "description": bounded_description(&view.description),
            "parameters": bounded_parameters(&view.parameters), "deferred": view.deferred}))})
}

pub(super) fn list(core: &Core, lead: &Lead) -> Result<Value, String> {
    core.expansion
        .inventories
        .lock()
        .map_err(|_| "tool_inventory_poisoned")?
        .get(&lead.thread)
        .cloned()
        .ok_or_else(|| "tools_unavailable: this thread has not built its tools".into())
}

impl State {
    pub(in crate::mods) fn validate_call(
        &self,
        thread: ThreadId,
        tool: &str,
        arguments: &Value,
        rewritten: bool,
    ) -> Result<(), String> {
        let inventories = self
            .inventories
            .lock()
            .map_err(|_| "tool_inventory_poisoned")?;
        let Some(entry) = inventories
            .get(&thread)
            .and_then(|inventory| inventory["tools"].as_array())
            .and_then(|tools| tools.iter().find(|entry| entry["name"] == tool))
        else {
            return Ok(());
        };
        let schema = &entry["original"]["parameters"];
        if schema.is_null()
            || entry["original"]["freeform"] == true
            || !rewritten && entry["effective"]["parameters"] == *schema
        {
            return Ok(());
        }
        codex_omd::tool_schema::validate(schema, arguments)
            .map_err(|reason| format!("tool_arguments_invalid: {tool}: {reason}"))
    }

    pub(in crate::mods) fn forget_inventory(&self, thread: ThreadId) {
        if let Ok(mut inventories) = self.inventories.lock() {
            inventories.remove(&thread);
        }
    }
}

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
            || thread_store.get::<roles::AgentTools>().is_some()
    }

    fn observing(&self, thread_store: &ExtensionData) -> bool {
        lead_thread(thread_store) && self.expansion.tool_inventory.load(Ordering::Acquire)
    }

    fn observe_tool_inventory(
        &self,
        thread_store: &ExtensionData,
        inventory: &[ToolInventoryEntry],
    ) {
        let Some(lead) = thread_store.get::<Lead>() else {
            return;
        };
        let Ok(mut inventories) = self.expansion.inventories.lock() else {
            return;
        };
        if !self.expansion.tool_inventory.load(Ordering::Acquire) {
            return;
        }
        let snapshot = json!({"thread_id": lead.thread.to_string(),
            "tools": inventory.iter().take(SPEC_TOOLS).map(inventory_entry).collect::<Vec<_>>()});
        if inventories.get(&lead.thread) != Some(&snapshot) {
            let _ = codex_omd::tool_schema::write_inventory(&lead.host.root, &snapshot);
            inventories.insert(lead.thread, snapshot);
        }
    }

    fn adjust_tool_specs(
        &self,
        thread_store: &ExtensionData,
        specs: &[ToolSpecView],
    ) -> Option<ToolSpecAdjustment> {
        if let Some(allowed) = thread_store.get::<roles::AgentTools>() {
            return Some(ToolSpecAdjustment {
                hide: specs
                    .iter()
                    .filter(|spec| !allowed.0.contains(&spec.name))
                    .map(|spec| spec.name.clone())
                    .collect(),
                ..ToolSpecAdjustment::default()
            });
        }
        if !self.adjusting(thread_store) {
            return None;
        }
        let lead = thread_store.get::<Lead>()?;
        let route = self
            .host
            .accounts
            .by_thread
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
                json!({"name": spec.name, "description": bounded_description(&spec.description),
                    "parameters": bounded_parameters(&spec.parameters), "deferred": false})
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
