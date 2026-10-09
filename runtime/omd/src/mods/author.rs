use super::*;
use std::collections::VecDeque;

#[derive(Default)]
struct OfflineHost {
    replies: BTreeMap<String, VecDeque<Value>>,
    calls: Vec<Value>,
    now_ms: u64,
    timers: BTreeMap<(String, String), u64>,
    environment: Option<BTreeMap<String, String>>,
    clients: Vec<Value>,
    attached: u64,
}

const POINTER_ACTIONS: [&str; 8] = [
    "down",
    "up",
    "scroll_up",
    "scroll_down",
    "move",
    "drag",
    "enter",
    "leave",
];

impl OfflineHost {
    fn from_scenario(scenario: &Value, now_ms: u64) -> Result<Self> {
        let mut host = Self {
            now_ms,
            ..Self::default()
        };
        if let Some(environment) = scenario.get("environment") {
            let mut values = BTreeMap::new();
            for (name, value) in environment
                .as_object()
                .ok_or_else(|| failure("offline_environment_must_be_an_object"))?
            {
                if crate::host::secret_like(name) {
                    return Err(failure(format!("offline_environment_secret_name: {name}")));
                }
                let value = value.as_str().filter(|value| value.len() <= 4096);
                values.insert(
                    name.clone(),
                    value
                        .ok_or_else(|| {
                            failure(format!("offline_environment_value_invalid: {name}"))
                        })?
                        .to_owned(),
                );
            }
            host.environment = Some(values);
        }
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

    fn call(&mut self, caller: &str, call: ModHostCall) -> Result<Value> {
        self.calls.push(
            json!({"at_ms":self.now_ms,"caller":caller,"operation":call.operation,
            "arguments":call.arguments}),
        );
        let key = call.arguments["key"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        if call.operation == "environment.read"
            && let Some(environment) = &self.environment
        {
            let names = call.arguments["names"]
                .as_array()
                .filter(|names| (1..=16).contains(&names.len()))
                .ok_or_else(|| failure("environment_names_invalid"))?;
            let values = names
                .iter()
                .filter_map(Value::as_str)
                .map(|name| {
                    let value = environment.get(name);
                    let entry = if crate::host::secret_like(name) {
                        json!({"set": value.is_some()})
                    } else {
                        json!({"set": value.is_some(), "value": value})
                    };
                    (name.to_owned(), entry)
                })
                .collect::<serde_json::Map<_, _>>();
            return Ok(json!({"values": values}));
        }
        match call.operation.as_str() {
            "events.schedule" => {
                let delay = call.arguments["delay_ms"]
                    .as_u64()
                    .filter(|delay| (1000..=86_400_000).contains(delay))
                    .ok_or_else(|| failure("timer_delay_invalid"))?;
                self.timers
                    .insert((caller.to_owned(), key.clone()), self.now_ms + delay);
                return Ok(json!({"key": key, "delay_ms": delay}));
            }
            "events.cancel" => {
                let cancelled = self.timers.remove(&(caller.to_owned(), key)).is_some();
                return Ok(json!({"cancelled": cancelled}));
            }
            _ => {}
        }
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
        let mut tiers = BTreeMap::new();
        for (id, tier) in scenario
            .get("tiers")
            .map(|tiers| {
                tiers
                    .as_object()
                    .ok_or_else(|| failure("offline_tiers_must_be_an_object"))
            })
            .transpose()?
            .into_iter()
            .flatten()
        {
            let tier: ManagedTier = serde_json::from_value(tier.clone())
                .map_err(|_| failure(format!("offline_tier_invalid: {id}")))?;
            let loaded = self
                .loaded
                .get(id)
                .ok_or_else(|| failure(format!("offline_tier_unknown_mod: {id}")))?;
            tiers.insert(id.clone(), (tier, loaded.selection.clone()));
        }
        let result = self.offline_steps(steps, &tiers, &mut host, &mut now_ms);
        for (id, (_, selection)) in tiers {
            if let Some(loaded) = self
                .loaded
                .get_mut(&id)
                .filter(|loaded| loaded.selection.scope == MANAGED_SCOPE)
            {
                loaded.selection.scope = selection.scope;
                loaded.selection.tier = selection.tier;
            }
        }
        self.virtual_time_ms = None;
        let outputs = result?;
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

    /// Runs the steps with `tiers` mods simulated as administrator-managed packages in that tier.
    fn offline_steps(
        &mut self,
        steps: &[Value],
        tiers: &BTreeMap<String, (ManagedTier, ModSelection)>,
        host: &mut OfflineHost,
        now_ms: &mut u64,
    ) -> Result<Vec<Value>> {
        let mut outputs = Vec::new();
        for (index, step) in steps.iter().enumerate() {
            for (id, (tier, _)) in tiers {
                if let Some(loaded) = self.loaded.get_mut(id) {
                    loaded.selection.scope = MANAGED_SCOPE.to_owned();
                    loaded.selection.tier = Some(*tier);
                }
            }
            let kind = step
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| failure("offline_step_type_required"))?;
            let cancelled = step
                .get("cancelled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            self.virtual_time_ms = Some(*now_ms);
            host.now_ms = *now_ms;
            let result = self.offline_step(kind, step, !cancelled, host, now_ms);
            let output = match result {
                Ok(value) => {
                    if let Some(expected) = step.get("expect")
                        && &value != expected
                    {
                        return Err(failure(format!(
                            "offline_expectation_failed at step {index}: expected {expected}, got {value}"
                        )));
                    }
                    if step.get("expect_error").is_some() {
                        return Err(failure(format!(
                            "offline_expected_error_missing at step {index}"
                        )));
                    }
                    json!({"index":index,"type":kind,"at_ms":*now_ms,"value":value})
                }
                Err(error) => {
                    let text = error.to_string();
                    let Some(expected) = step.get("expect_error").and_then(Value::as_str) else {
                        return Err(failure(format!(
                            "offline_step_failed at step {index}: {text}"
                        )));
                    };
                    if !text.contains(expected) {
                        return Err(failure(format!(
                            "offline_error_mismatch at step {index}: expected {expected}, got {text}"
                        )));
                    }
                    json!({"index":index,"type":kind,"at_ms":*now_ms,"error":text})
                }
            };
            outputs.push(output);
        }
        Ok(outputs)
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
                let until = now_ms
                    .checked_add(delta)
                    .ok_or_else(|| failure("offline_virtual_time_overflow"))?;
                let mut fired = Vec::new();
                // Due timers fire in due order at their own virtual time; a handler may reschedule.
                while let Some(((owner, key), due)) = host
                    .timers
                    .iter()
                    .filter(|(_, due)| **due <= until)
                    .min_by_key(|(_, due)| **due)
                    .map(|(timer, due)| (timer.clone(), *due))
                {
                    if fired.len() >= 256 {
                        return Err(failure("offline_timer_limit"));
                    }
                    host.timers.remove(&(owner.clone(), key.clone()));
                    (*now_ms, host.now_ms) = (due, due);
                    self.virtual_time_ms = Some(due);
                    let value = self.invoke_scoped_with(
                        &owner,
                        self.generation,
                        "timer",
                        "",
                        json!({"key": key}),
                        || active,
                        |caller, call| host.call(caller, call),
                    );
                    fired.push(match value {
                        Ok(_) => json!({"mod": owner, "key": key, "at_ms": due}),
                        Err(error) => json!({"mod": owner, "key": key, "at_ms": due, "error": error.to_string()}),
                    });
                }
                *now_ms = until;
                let mut value = json!({"now_ms": now_ms});
                if !fired.is_empty() {
                    value["timers"] = json!(fired);
                }
                Ok(value)
            }
            "wait_until" => {
                let check = step
                    .get("check")
                    .ok_or_else(|| failure("offline_wait_check_required"))?;
                let until = step
                    .get("until")
                    .ok_or_else(|| failure("offline_wait_until_required"))?;
                let every_ms = step.get("every_ms").and_then(Value::as_u64).unwrap_or(1000);
                let max_ms = step
                    .get("max_ms")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| failure("offline_wait_max_ms_required"))?;
                if every_ms == 0 || max_ms / every_ms > 256 {
                    return Err(failure("offline_wait_limit"));
                }
                let start = *now_ms;
                loop {
                    self.virtual_time_ms = Some(*now_ms);
                    host.now_ms = *now_ms;
                    let value = self.offline_step(
                        required_string(check, "type")?,
                        check,
                        active,
                        host,
                        now_ms,
                    )?;
                    if &value == until {
                        return Ok(json!({"waited_ms": *now_ms - start, "value": value}));
                    }
                    if *now_ms - start >= max_ms {
                        return Err(failure(format!(
                            "offline_wait_timeout: {until} not reached in {max_ms} ms, last {value}"
                        )));
                    }
                    let delta = every_ms.min(max_ms - (*now_ms - start));
                    self.offline_step("advance_time", &json!({"ms": delta}), active, host, now_ms)?;
                }
            }
            "client_attach" => {
                host.attached += 1;
                let mut renderer = json!({"kind": "gui", "formats": [], "pointer": "none", "reduced_motion": false});
                if let (Some(renderer), Some(given)) = (
                    renderer.as_object_mut(),
                    step.get("renderer").and_then(Value::as_object),
                ) {
                    renderer.extend(given.clone());
                }
                let id = format!("client-{}", host.attached);
                host.clients.push(json!({"id": id, "name": required_string(step, "name")?,
                    "renderer": renderer,
                    "viewport": step.get("viewport").cloned().unwrap_or(Value::Null),
                    "focused": step["focused"].as_bool().unwrap_or(false), "attached_ms": *now_ms}));
                Ok(json!({"id": id, "clients": host.clients}))
            }
            "client_detach" => {
                let id = required_string(step, "id")?;
                let before = host.clients.len();
                host.clients.retain(|client| client["id"] != id);
                if host.clients.len() == before {
                    return Err(failure("offline_client_not_attached"));
                }
                Ok(json!({"clients": host.clients}))
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
            "intercept" => {
                let surface = required_string(step, "surface")?;
                let mut replies = step
                    .get("core")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter();
                let mut core_calls = Vec::new();
                let mut core = |input: Value| {
                    core_calls.push(input);
                    let reply = replies
                        .next()
                        .ok_or_else(|| failure("offline_core_reply_missing"))?;
                    match reply.get("error").and_then(Value::as_str) {
                        Some(error) => Err(failure(error)),
                        None => Ok(reply.get("value").cloned().unwrap_or(Value::Null)),
                    }
                };
                let origin = step
                    .get("origin")
                    .cloned()
                    .unwrap_or_else(|| json!({"caller": "offline"}));
                let chain = chain::intercept(
                    &mut Access::Held(self),
                    &mut |caller, call| host.call(caller, call),
                    &mut chain::Core::Call(&mut core),
                    surface,
                    true,
                    payload,
                    origin,
                    &|| active,
                    &InvocationScope::default(),
                )?;
                let mut value = serde_json::to_value(chain)?;
                for entry in value["trace"].as_array_mut().into_iter().flatten() {
                    entry.as_object_mut().map(|entry| entry.remove("ms"));
                }
                value["core_calls"] = Value::Array(core_calls);
                Ok(value)
            }
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
                    let value = self.invoke_scoped_with(
                        &id,
                        generation,
                        event,
                        "",
                        payload.clone(),
                        || active,
                        |caller, call| host.call(caller, call),
                    )?;
                    values.push(json!({"mod":id,"value":value}));
                }
                Ok(Value::Array(values))
            }
            "invoke" => {
                let id = required_string(step, "mod")?;
                let event = required_string(step, "event")?;
                let name = required_string(step, "name")?;
                self.invoke_scoped_with(
                    id,
                    self.generation,
                    event,
                    name,
                    payload,
                    || active,
                    |caller, call| host.call(caller, call),
                )
            }
            "terminal_mount" | "terminal_interact" => {
                let id = required_string(step, "mod")?;
                let mut payload = payload;
                if let Some(input) = payload.as_object_mut() {
                    input
                        .entry("clients")
                        .or_insert_with(|| json!(host.clients));
                }
                let view = self.invoke_scoped_with(
                    id,
                    self.generation,
                    "terminal",
                    "",
                    payload,
                    || active,
                    |caller, call| host.call(caller, call),
                )?;
                let parsed = ModView::parse(view.clone())?;
                if kind == "terminal_mount" {
                    return Ok(view);
                }
                if let Some(pointer) = step.get("pointer") {
                    let component = required_string(step, "component")?;
                    let mounted = parsed
                        .sites
                        .values()
                        .find_map(|site| terminal_component(&site.components, component))
                        .ok_or_else(|| failure("offline_terminal_component_not_mounted"))?;
                    if !matches!(
                        mounted,
                        ModComponent::Box { pointer: true, .. }
                            | ModComponent::Pane { pointer: true, .. }
                            | ModComponent::Image { pointer: true, .. }
                            | ModComponent::Raster { pointer: true, .. }
                    ) {
                        return Err(failure("offline_terminal_component_not_pointer"));
                    }
                    let valid = pointer["column"].is_i64()
                        && pointer["row"].is_i64()
                        && pointer["action"]
                            .as_str()
                            .is_some_and(|action| POINTER_ACTIONS.contains(&action))
                        && (pointer["half"].is_null()
                            || matches!(pointer["half"].as_u64(), Some(0 | 1)))
                        && (pointer["button"].is_null()
                            || matches!(
                                pointer["button"].as_str(),
                                Some("left" | "right" | "middle")
                            ));
                    if !valid {
                        return Err(failure("offline_terminal_pointer_invalid"));
                    }
                    let mut event = json!({"component": component, "kind": "pointer",
                        "pointer": {"column": pointer["column"], "row": pointer["row"], "half": pointer["half"],
                            "action": pointer["action"], "button": pointer["button"]}});
                    match step.get("client").and_then(Value::as_str) {
                        Some(client) if host.clients.iter().any(|entry| entry["id"] == client) => {
                            event["client"] = json!(client);
                        }
                        Some(_) => return Err(failure("offline_client_not_attached")),
                        None => event["origin"] = json!("user"),
                    }
                    let result = self.invoke_scoped_with(
                        id,
                        self.generation,
                        "component_event",
                        "",
                        event.clone(),
                        || active,
                        |caller, call| host.call(caller, call),
                    )?;
                    return Ok(json!({"event": event, "result": result}));
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
                    let result = self.invoke_scoped_with(
                        owner,
                        self.generation,
                        "command",
                        name,
                        args,
                        || active,
                        |caller, call| host.call(caller, call),
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
            | ModComponent::Line { id, .. }
            | ModComponent::Button { id, .. }
            | ModComponent::Input { id, .. }
            | ModComponent::Select { id, .. }
            | ModComponent::Multiselect { id, .. }
            | ModComponent::Markdown { id, .. }
            | ModComponent::Code { id, .. }
            | ModComponent::List { id, .. }
            | ModComponent::Document { id, .. }
            | ModComponent::Diff { id, .. }
            | ModComponent::Terminal { id, .. }
            | ModComponent::Image { id, .. }
            | ModComponent::Raster { id, .. } => (Some(id.as_str()), &[][..]),
            ModComponent::Slot | ModComponent::Native { .. } => (None, &[][..]),
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
        ModComponent::Multiselect {
            action,
            value: current,
            options,
            ..
        } => {
            let selected = match value {
                Some(value) => serde_json::from_str::<Vec<String>>(value)
                    .map_err(|_| failure("offline_terminal_multiselect_value_invalid"))?,
                None => current.clone(),
            };
            if selected
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != selected.len()
                || !selected
                    .iter()
                    .all(|value| options.iter().any(|option| option.value == *value))
            {
                return Err(failure("offline_terminal_select_value_not_mounted"));
            }
            let ordered = options
                .iter()
                .filter(|option| selected.contains(&option.value))
                .map(|option| &option.value)
                .collect::<Vec<_>>();
            command(
                action,
                Some(&serde_json::to_string(&ordered).map_err(failure)?),
            )
        }
        ModComponent::List {
            action,
            rows,
            selected: current,
            ..
        } => {
            let selected = value
                .or(current.as_deref())
                .ok_or_else(|| failure("offline_terminal_list_value_required"))?;
            if !rows.iter().any(|row| row.value == selected) {
                return Err(failure("offline_terminal_list_value_not_mounted"));
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
        let mut from = 0;
        while let Some(offset) = output[from..].find(prefix) {
            let start = from + offset;
            let tail = &output[start + prefix.len()..];
            let length = tail
                .find(|character: char| {
                    character.is_whitespace()
                        || matches!(character, '\'' | '"' | ',' | ']' | '}' | ')')
                })
                .unwrap_or(tail.len());
            if length == 0 {
                from = start + prefix.len();
                continue;
            }
            output.replace_range(start..start + prefix.len() + length, "[REDACTED]");
            from = start + "[REDACTED]".len();
        }
    }
    output
}
