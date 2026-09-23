use super::*;
use std::collections::VecDeque;

#[derive(Default)]
struct OfflineHost {
    replies: BTreeMap<String, VecDeque<Value>>,
    calls: Vec<Value>,
    now_ms: u64,
}

impl OfflineHost {
    fn from_scenario(scenario: &Value, now_ms: u64) -> Result<Self> {
        let mut host = Self {
            now_ms,
            ..Self::default()
        };
        let Some(operations) = scenario.get("host_operations") else {
            return Ok(host);
        };
        let operations = operations
            .as_object()
            .ok_or_else(|| failure("offline_host_operations_must_be_an_object"))?;
        for (operation, values) in operations {
            if !MOD_HOST_OPERATIONS.contains(&operation.as_str()) {
                return Err(failure(format!(
                    "offline_unknown_host_operation: {operation}"
                )));
            }
            let values = values
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![values.clone()]);
            host.replies
                .insert(operation.clone(), VecDeque::from(values));
        }
        Ok(host)
    }

    fn call(&mut self, call: ModHostCall) -> Result<Value> {
        self.calls
            .push(json!({"at_ms":self.now_ms,"operation":call.operation,
            "arguments":call.arguments}));
        let response = self
            .replies
            .get_mut(&call.operation)
            .and_then(VecDeque::pop_front)
            .ok_or_else(|| {
                failure(format!(
                    "offline_unmocked_host_operation: {}; add a deterministic host_operations fixture",
                    call.operation
                ))
            })?;
        if let Some(error) = response.get("error").and_then(Value::as_str) {
            return Err(failure(error));
        }
        Ok(response.get("result").cloned().unwrap_or(response))
    }
}

impl ModHost {
    pub fn author_inspection(&self) -> Value {
        json!({
            "api":MOD_API_VERSION,
            "generation":self.generation,
            "precedence":"dependencies first, then lexical mod ID; project scope shadows user scope; exclusive replacements fail closed on conflict",
            "order":self.order,
            "events":self.loaded.iter().map(|(id, loaded)| json!({
                "id":id,
                "scope":loaded.selection.scope,
                "requires":loaded.package.requires,
                "events":loaded.registrations.events,
                "replacements":loaded.registrations.replacements,
                "error":loaded.error,
            })).collect::<Vec<_>>(),
            "rejected":self.rejected,
        })
    }

    pub fn capability_explanation(code: &str) -> Value {
        let (cause, fix) = if code.starts_with("capability_denied") {
            (
                "The package requested authority that the manifest or explicit trust grant does not include.",
                "Declare the exact capability in mod.json, inspect the source-use report, then have the user approve the new digest and exact grant.",
            )
        } else if code.starts_with("undeclared_operation_use") {
            (
                "Source analysis found a literal host operation whose capability is not declared.",
                "Add the operation's documented capability or remove the call; rerun check before asking for trust.",
            )
        } else if code.starts_with("undeclared_service_use") {
            (
                "Source analysis found a service call without a matching manifest import.",
                "Declare the service name and compatible version under services.imports or remove the call.",
            )
        } else if code.starts_with("undeclared_environment_use") {
            (
                "Source analysis found environment access outside the manifest declaration.",
                "Remove the access or declare an admitted environment feature; network, filesystem, process and DOM access are intentionally unavailable.",
            )
        } else if code.starts_with("state_capability_denied") {
            (
                "The callback changed persistent state without the state capability.",
                "Declare state or keep the callback stateless, then re-inspect and re-approve the source digest.",
            )
        } else if code.starts_with("host_operation_unavailable") {
            (
                "The callback ran without an active native task capable of servicing that host operation.",
                "Run it inside a task/tool callback or supply an explicit offline host-operation mock in tests.",
            )
        } else {
            (
                "The host denied or could not classify the requested authority.",
                "Use omd-mod report and omd-mod events, then compare the literal operation, manifest declaration and user-approved grant.",
            )
        };
        json!({"code":code,"cause":cause,"fix":fix,
            "guarantee":"Author tooling can explain a denial but cannot grant authority, change trust, or bypass host enforcement."})
    }

    pub fn diagnostic_bundle(&self) -> Value {
        let mut bundle = json!({
            "schema":1,
            "host":{"codex":CODEX_HOST_RELEASE,"omd":OMD_HOST_RELEASE,"api":MOD_API_VERSION},
            "configuration_sha256":self.configuration_sha256,
            "status":self.status(),
            "inspection":self.author_inspection(),
            "redaction":{"paths":true,"settings":true,"environment":true,"credentials":true},
        });
        let mut paths = vec![(self.store.root.display().to_string(), "$STORE".to_owned())];
        paths.extend(self.loaded.iter().map(|(id, loaded)| {
            (
                loaded.selection.path.display().to_string(),
                format!("$MOD/{id}"),
            )
        }));
        redact_value(&mut bundle, None, &paths);
        bundle
    }

    pub fn offline_test(&mut self, scenario: Value) -> Result<Value> {
        if scenario.get("schema").and_then(Value::as_u64) != Some(1) {
            return Err(failure("offline_scenario_schema_1_required"));
        }
        let mut now_ms = scenario
            .get("virtual_time_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let mut host = OfflineHost::from_scenario(&scenario, now_ms)?;
        let steps = scenario
            .get("steps")
            .and_then(Value::as_array)
            .ok_or_else(|| failure("offline_steps_required"))?;
        if steps.len() > 256 {
            return Err(failure("offline_step_limit"));
        }
        let mut outputs = Vec::new();
        for (index, step) in steps.iter().enumerate() {
            let kind = step
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| failure("offline_step_type_required"))?;
            let cancelled = step
                .get("cancelled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            self.virtual_time_ms = Some(now_ms);
            host.now_ms = now_ms;
            let result = self.offline_step(kind, step, !cancelled, &mut host, &mut now_ms);
            let output = match result {
                Ok(value) => {
                    if let Some(expected) = step.get("expect")
                        && &value != expected
                    {
                        self.virtual_time_ms = None;
                        return Err(failure(format!(
                            "offline_expectation_failed at step {index}: expected {expected}, got {value}"
                        )));
                    }
                    if step.get("expect_error").is_some() {
                        self.virtual_time_ms = None;
                        return Err(failure(format!(
                            "offline_expected_error_missing at step {index}"
                        )));
                    }
                    json!({"index":index,"type":kind,"at_ms":now_ms,"value":value})
                }
                Err(error) => {
                    let text = error.to_string();
                    let Some(expected) = step.get("expect_error").and_then(Value::as_str) else {
                        self.virtual_time_ms = None;
                        return Err(failure(format!(
                            "offline_step_failed at step {index}: {text}"
                        )));
                    };
                    if !text.contains(expected) {
                        self.virtual_time_ms = None;
                        return Err(failure(format!(
                            "offline_error_mismatch at step {index}: expected {expected}, got {text}"
                        )));
                    }
                    json!({"index":index,"type":kind,"at_ms":now_ms,"error":text})
                }
            };
            outputs.push(output);
        }
        self.virtual_time_ms = None;
        let remaining = host
            .replies
            .iter()
            .filter(|(_, replies)| !replies.is_empty())
            .map(|(operation, replies)| json!({"operation":operation,"remaining":replies.len()}))
            .collect::<Vec<_>>();
        Ok(
            json!({"schema":1,"offline":true,"paid_requests":0,"virtual_time_ms":now_ms,
            "steps":outputs,"host_calls":host.calls,"unused_mock_replies":remaining,
            "status":self.status()}),
        )
    }

    fn offline_step(
        &mut self,
        kind: &str,
        step: &Value,
        active: bool,
        host: &mut OfflineHost,
        now_ms: &mut u64,
    ) -> Result<Value> {
        let payload = step.get("payload").cloned().unwrap_or(Value::Null);
        match kind {
            "advance_time" => {
                let delta = step
                    .get("ms")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| failure("offline_advance_ms_required"))?;
                *now_ms = now_ms
                    .checked_add(delta)
                    .ok_or_else(|| failure("offline_virtual_time_overflow"))?;
                Ok(json!({"now_ms":now_ms}))
            }
            "status" => Ok(self.status()),
            "reload" => {
                self.store.reload()?;
                self.turn_boundary();
                if let Some(error) = &self.reload_error {
                    return Err(failure(error));
                }
                Ok(json!({"generation":self.generation,"reload_error":self.reload_error}))
            }
            "model_request" => self.model_request(payload, || active),
            "tool_exposure" => {
                let thread_id = step
                    .get("thread_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let tools = self.tools_for_step(thread_id, payload, || active);
                Ok(json!(
                    tools
                        .into_iter()
                        .map(|(id, _, tool)| format!("mod_{id}_{}", tool.name))
                        .collect::<Vec<_>>()
                ))
            }
            "response_stream" => self.response_stream(payload, || active),
            "event" | "tool_outcome" | "agent" => {
                let event = match kind {
                    "tool_outcome" => "tool_result",
                    "agent" => "agent",
                    _ => step
                        .get("event")
                        .and_then(Value::as_str)
                        .ok_or_else(|| failure("offline_event_name_required"))?,
                };
                let ids = self.event_ids(event);
                let mut values = Vec::new();
                for id in ids {
                    let generation = self.generation;
                    let value = self.invoke_with(
                        &id,
                        generation,
                        event,
                        "",
                        payload.clone(),
                        || active,
                        |call| host.call(call),
                    )?;
                    values.push(json!({"mod":id,"value":value}));
                }
                Ok(Value::Array(values))
            }
            "invoke" => {
                let id = required_string(step, "mod")?;
                let event = required_string(step, "event")?;
                let name = required_string(step, "name")?;
                self.invoke_with(
                    id,
                    self.generation,
                    event,
                    name,
                    payload,
                    || active,
                    |call| host.call(call),
                )
            }
            "terminal_mount" | "terminal_interact" => {
                let id = required_string(step, "mod")?;
                let view = self.invoke_with(
                    id,
                    self.generation,
                    "terminal",
                    "",
                    payload,
                    || active,
                    |call| host.call(call),
                )?;
                let parsed = ModView::parse(view.clone())?;
                if kind == "terminal_mount" {
                    return Ok(view);
                }
                let action = if let Some(component) = step.get("component").and_then(Value::as_str)
                {
                    terminal_component_action(
                        &parsed,
                        component,
                        step.get("value").and_then(Value::as_str),
                    )?
                } else {
                    let key = required_string(step, "key")?;
                    serde_json::to_value(
                        parsed
                            .keybindings
                            .get(key)
                            .ok_or_else(|| failure("offline_terminal_key_not_mounted"))?,
                    )?
                };
                if let Some(command) = action.get("command").and_then(Value::as_str) {
                    let (owner, name) = command.split_once(':').unwrap_or((id, command));
                    let args = action.get("args").cloned().unwrap_or_else(|| json!(""));
                    let result = self.invoke_with(
                        owner,
                        self.generation,
                        "command",
                        name,
                        args,
                        || active,
                        |call| host.call(call),
                    )?;
                    Ok(json!({"action":action,"result":result}))
                } else {
                    Ok(json!({"action":action}))
                }
            }
            _ => Err(failure(format!("offline_unknown_step_type: {kind}"))),
        }
    }
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| failure(format!("offline_{key}_required")))
}

fn terminal_component<'a>(components: &'a [ModComponent], id: &str) -> Option<&'a ModComponent> {
    components.iter().find_map(|component| {
        let (component_id, children) = match component {
            ModComponent::Box { id, children, .. }
            | ModComponent::Pane { id, children, .. }
            | ModComponent::Dialog { id, children, .. } => (Some(id.as_str()), children.as_slice()),
            ModComponent::Text { id, .. }
            | ModComponent::Button { id, .. }
            | ModComponent::Input { id, .. }
            | ModComponent::Select { id, .. }
            | ModComponent::Markdown { id, .. }
            | ModComponent::Code { id, .. } => (Some(id.as_str()), &[][..]),
            ModComponent::Slot => (None, &[][..]),
        };
        if component_id == Some(id) {
            Some(component)
        } else {
            terminal_component(children, id)
        }
    })
}

fn terminal_component_action(view: &ModView, id: &str, value: Option<&str>) -> Result<Value> {
    let component = view
        .sites
        .values()
        .find_map(|site| terminal_component(&site.components, id))
        .ok_or_else(|| failure("offline_terminal_component_not_mounted"))?;
    let command = |action: &ModCommandAction, value: Option<&str>| {
        let args = match value {
            Some(value) if action.args.is_empty() => value.to_owned(),
            Some(value) => format!("{} {value}", action.args),
            None => action.args.clone(),
        };
        serde_json::to_value(ModKeyAction::Command {
            command: action.command.clone(),
            args,
        })
        .map_err(failure)
    };
    match component {
        ModComponent::Button { action, .. } => serde_json::to_value(action).map_err(failure),
        ModComponent::Input {
            action,
            value: current,
            ..
        } => command(action, value.or(Some(current))),
        ModComponent::Select {
            action,
            value: current,
            options,
            ..
        } => {
            let selected = value.unwrap_or(current);
            if !options.iter().any(|option| option.value == selected) {
                return Err(failure("offline_terminal_select_value_not_mounted"));
            }
            command(action, Some(selected))
        }
        _ => Err(failure("offline_terminal_component_not_interactive")),
    }
}

fn redact_value(value: &mut Value, key: Option<&str>, paths: &[(String, String)]) {
    let sensitive = key.is_some_and(|key| {
        let key = key.to_ascii_lowercase();
        ["secret", "token", "password", "credential", "api_key"]
            .iter()
            .any(|needle| key.contains(needle))
    });
    if sensitive && !value.is_boolean() {
        *value = Value::String("[REDACTED]".to_owned());
        return;
    }
    match value {
        Value::String(text) => {
            for (path, replacement) in paths {
                *text = text.replace(path, replacement);
            }
            *text = redact_text(text);
        }
        Value::Array(values) => {
            for value in values {
                redact_value(value, None, paths);
            }
        }
        Value::Object(object) => {
            for (key, value) in object {
                redact_value(value, Some(key), paths);
            }
        }
        _ => {}
    }
}

fn redact_text(text: &str) -> String {
    let mut output = text.to_owned();
    for prefix in ["sk-", "ghp_", "github_pat_", "Bearer "] {
        while let Some(start) = output.find(prefix) {
            let tail = &output[start + prefix.len()..];
            let length = tail
                .find(|character: char| {
                    character.is_whitespace()
                        || matches!(character, '\'' | '"' | ',' | ']' | '}' | ')')
                })
                .unwrap_or(tail.len());
            if length == 0 {
                break;
            }
            output.replace_range(start..start + prefix.len() + length, "[REDACTED]");
        }
    }
    output
}
