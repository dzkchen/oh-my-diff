use super::*;
use std::time::Duration;
use std::time::Instant;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModHostCall {
    pub operation: String,
    pub arguments: Value,
}

impl ModHostCall {
    pub fn capability(&self) -> Result<&'static str> {
        let operation = self.operation.as_str();
        match operation {
            "exec.run" | "exec.output_page" => Ok("exec"),
            "workspace.read"
            | "workspace.list"
            | "workspace.stat"
            | "workspace.snapshot"
            | "workspace.fingerprint" => Ok("fs.read"),
            "workspace.check_access" => Ok(if self.arguments["write"] == true {
                "fs.write"
            } else {
                "fs.read"
            }),
            "workspace.transaction"
            | "workspace.backup"
            | "workspace.restore"
            | "workspace.request_rename" => Ok("fs.write"),
            "store.get" | "store.put" | "store.delete" | "store.list" | "store.export"
            | "store.reset" | "evidence.write" | "evidence.read" => Ok("store"),
            "sessions.list" | "sessions.read" | "sessions.snapshot" | "sessions.ports" => {
                Ok("sessions")
            }
            "routes.list"
            | "providers.register"
            | "providers.unregister"
            | "providers.models"
            | "ledger.settle" => Ok("model"),
            "task.status" | "workspace.integrate" => Ok("agents"),
            "task.complete" | "receipts.submit" | "contract.status" | "contract.restrict"
            | "contract.select" => Ok("contracts"),
            "mods.service" => Ok("services"),
            "app.request" => self.arguments["method"]
                .as_str()
                .and_then(crate::app_routes::route)
                .map(|route| route.class.as_str())
                .ok_or_else(|| failure("app_method_unrouted")),
            "app.respond" => Ok("approvals"),
            "app.routes" | "session.info" | "tools.list" => Ok("inventory"),
            "time.sleep" => Ok("events"),
            "workspace.watch" | "workspace.unwatch" => Ok("fs.read"),
            "events.publish" | "events.schedule" | "events.cancel" => Ok("events"),
            "credentials.list" | "credentials.request" => Ok("credentials"),
            "routes.select" => Ok("model"),
            "turns.activity" => Ok("sessions"),
            "turns.abort" => Ok("threads"),
            "terminal.notify"
            | "terminal.show_thread"
            | "commands.list"
            | "commands.describe"
            | "terminal.import_file"
            | "terminal.image_sample"
            | "terminal.open"
            | "terminal.prompt"
            | "terminal.pane"
            | "terminal.panes"
            | "terminal.panel"
            | "terminal.notice"
            | "terminal.selection"
            | "terminal.copy"
            | "terminal.blit" => Ok("terminal"),
            "terminal.pty" => Ok("pty"),
            "model.complete" | "model.fork" => Ok("agents"),
            "tools.define" | "tools.undefine" => Ok("tools"),
            "tools.invoke" | "tools.check" | "tools.original" => Ok("interception"),
            "composer.read" | "composer.write" | "composer.suggest" => Ok("composer"),
            "prompts.consent" | "prompts.submit" | "prompts.status" | "prompts.revoke" => {
                Ok("composer")
            }
            "builtins.invoke" | "commands.invoke" => Ok("builtins"),
            "config.describe" => Ok("config"),
            "config.set" => Ok("config.write"),
            "packages.list" | "packages.index" | "packages.preview" | "packages.apply"
            | "packages.reload" | "routes.add" | "routes.write" => Ok("packages"),
            "settings.write" if self.arguments["id"].is_string() => Ok("packages"),
            "settings.write" => Ok("commands"),
            "http.request" | "http.open" | "http.read" | "http.close" => Ok("http"),
            "mcp.connect" | "mcp.disconnect" => Ok("mcp"),
            "environment.read" | "environment.set" => Ok("exec"),
            "peers.list" | "peers.send" => Ok("peers"),
            "power.hold" | "power.release" => Ok("power"),
            "turns.queue" | "turns.queued" | "turns.dequeue" => Ok("autonomous"),
            _ if operation.starts_with("agents.") && MOD_HOST_OPERATIONS.contains(&operation) => {
                Ok("agents")
            }
            _ if (operation.starts_with("process.") || operation.starts_with("sidecars."))
                && MOD_HOST_OPERATIONS.contains(&operation) =>
            {
                Ok("exec")
            }
            _ => Err(failure(format!(
                "unsupported_host_operation: {}",
                self.operation
            ))),
        }
    }

    pub fn capabilities(&self) -> Result<Vec<&'static str>> {
        let mut capabilities = vec![self.capability()?];
        if self.operation == "model.fork" {
            capabilities.extend(["sessions", "sessions_tools"]);
        }
        if self.operation == "terminal.pty" {
            if self.arguments["write"] == true {
                capabilities.push("fs.write");
            }
            if self.arguments["network"] == "loopback" {
                capabilities.push("network");
            }
        }
        if matches!(
            self.operation.as_str(),
            "exec.run" | "process.start" | "terminal.pty"
        ) && self.arguments["sandbox"] == "none"
        {
            capabilities.push("os");
        }
        if matches!(
            self.operation.as_str(),
            "workspace.read" | "workspace.list" | "workspace.stat" | "workspace.transaction"
        ) && self.arguments.get("root").is_some()
        {
            capabilities.push("fs.external");
        }
        if self.operation == "exec.run"
            && self.arguments["unix_sockets"]
                .as_array()
                .is_some_and(|sockets| !sockets.is_empty())
        {
            capabilities.push("unix_sockets");
        }
        Ok(capabilities)
    }
}

fn authorize(loaded: &Loaded, call: &ModHostCall) -> Result<()> {
    let capabilities = call.capabilities()?;
    if let Some(missing) = capabilities
        .iter()
        .find(|capability| !loaded.package.capabilities.iter().any(|c| c == *capability))
    {
        return Err(failure(format!("capability_denied: {missing}")));
    }
    if let Some(expired) = capabilities.iter().find(|capability| {
        AUTHORITY_CAPABILITIES.contains(capability) && !loaded.selection.authority_current()
    }) {
        return Err(failure(format!("grant_expired: {expired}")));
    }
    let namespace = host_namespace(&call.operation, &call.arguments);
    if loaded
        .withheld
        .iter()
        .any(|pattern| namespace_matches(pattern, &namespace))
    {
        return Err(failure(format!("capability_withheld: {namespace}")));
    }
    Ok(())
}

#[derive(Serialize)]
struct Request<'a> {
    #[serde(flatten)]
    metadata: &'a Value,
    #[serde(flatten)]
    invocation: Value,
    #[serde(skip)]
    kept: [u8; 32],
}

impl process::Kept for Request<'_> {
    fn kept_digest(&self) -> Result<[u8; 32]> {
        Ok(self.kept)
    }

    fn kept_line(&self) -> Result<Vec<u8>> {
        let mut line: std::collections::BTreeMap<&str, &Value> = self
            .metadata
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(field, _)| !process::KEPT_FIELDS.contains(&field.as_str()))
            .map(|(field, value)| (field.as_str(), value))
            .collect();
        line.extend(
            self.invocation
                .as_object()
                .into_iter()
                .flatten()
                .map(|(field, value)| (field.as_str(), value)),
        );
        let kept = json!(process::KEPT_FIELDS);
        line.insert("kept", &kept);
        process::request_line(&line)
    }
}

impl std::ops::Index<&str> for Request<'_> {
    type Output = Value;

    fn index(&self, field: &str) -> &Value {
        self.invocation.get(field).unwrap_or(&self.metadata[field])
    }
}

fn metadata(loaded: &Loaded) -> Result<(Value, String, [u8; 32])> {
    let mut request = json!({"source": loaded.source.as_ref(), "filename": loaded.selection.path.join(&loaded.package.entrypoint),
        "api": MOD_API_VERSION,
        "assets": loaded.assets.as_ref(),
        "entrypoint": loaded.package.entrypoint,
        "entrypoint_sha256": digest(loaded.source.as_bytes()),
        "package": {"id": loaded.package.id, "version": loaded.package.version},
        "capabilities": loaded.package.capabilities, "adapter": loaded.package.adapter, "settings": effective_settings(loaded.package.settings_schema.as_ref(), &loaded.selection.settings),
        "settings_file": loaded.settings_file,
        "hook_budget_ms": loaded.package.hook_budget_ms,"max_host_calls": MAX_HOST_CALLS,"environment":loaded.package.environment});
    request["field_policies"] = ModHost::field_policies();
    request["surface"] = json!({
        "events": MOD_EVENTS.iter().map(|(event, capability)| (event.to_string(), json!(capability))).collect::<serde_json::Map<_, _>>(),
        "replacements": MOD_REPLACEMENT_POINTS,
        "middleware": MOD_MIDDLEWARE_EVENTS,
        "intercept": MOD_INTERCEPT_SURFACES.iter().map(|(surface, capability)| (surface.to_string(), json!(capability))).collect::<serde_json::Map<_, _>>(),
        "state": "store",
        "contracts": "contracts",
        "adapter": loaded.adapter,
    });
    // `entrypoint_sha256` stands for the source.
    let mut identity = Sha256::new();
    for (field, value) in request.as_object().into_iter().flatten() {
        if field != "source" {
            identity.update(field);
            identity.update(value.to_string());
        }
    }
    let identity = format!("{:x}", identity.finalize());
    let kept = process::kept_digest(&request)?;
    Ok((request, identity, kept))
}

/// A component instance keeps one runner, and with it its module state, for as long as it stays mounted.
pub(super) fn component_key(id: &str, component: &str, identity: &str) -> String {
    format!("runner:component:{id}:{component}:{identity}")
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run(
    loaded: &Loaded,
    event: &str,
    name: &str,
    payload: Value,
    replay: &[Value],
    active: &dyn Fn() -> bool,
    host: &mut dyn FnMut(ModHostCall) -> Result<Value>,
    progress: &mut dyn FnMut(String),
    now_ms: Option<u64>,
    scope: &InvocationScope,
) -> Result<Reply> {
    let mut receipts = replay.to_vec();
    let mut receipts_bytes = serde_json::to_vec(&receipts)?.len();
    let mut expected = replay
        .iter()
        .map(|receipt| serde_json::from_value::<ModHostCall>(receipt["call"].clone()))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut forwarded = 0;
    let mut waited = Duration::ZERO;
    let (metadata, identity, kept) = match loaded.request_metadata.get() {
        Some(cached) => cached,
        None => {
            let computed = metadata(loaded)?;
            loaded.request_metadata.get_or_init(|| computed)
        }
    };
    let mut request = Request {
        metadata,
        kept: *kept,
        invocation: json!({"state": loaded.state, "ui_state": loaded.ui_state, "ui_revision": loaded.ui_revision, "event": event, "name": name, "payload": payload, "interactive": true}),
    };
    request.invocation["virtual_time_ms"] = json!(now_ms.unwrap_or_else(crate::peers::now_ms));
    let render = event == "intercept" && request["payload"]["surface"] == "render";
    let component = event == "component";
    let warm = (render || component || loaded.package.environment.is_empty()).then(|| {
        request.invocation["serve"] = Value::Bool(render || component);
        request.invocation["reuse"] = Value::Bool(!render && !component);
        if component {
            let instance = request["payload"]["instance"].as_str().unwrap_or(name);
            return component_key(&loaded.package.id, instance, identity);
        }
        if !render {
            return format!("runner:{identity}");
        }
        let mut key = Sha256::new();
        key.update(identity);
        for (field, value) in request.invocation.as_object().into_iter().flatten() {
            if !["name", "payload", "receipts", "virtual_time_ms"].contains(&field.as_str()) {
                key.update(field);
                key.update(value.to_string());
            }
        }
        format!("runner:{:x}", key.finalize())
    });
    let started = Instant::now();
    let budget = Duration::from_millis(loaded.package.hook_budget_ms);
    request.invocation["receipts"] = Value::Array(receipts.clone());
    if event == "history" {
        fit_history(&mut request)?;
    }
    let mut answer = |frame: Value| -> Result<Value> {
        if event == "inspect" {
            return Err(failure("invalid_host_call_sequence"));
        }
        let frame: Frame = serde_json::from_value(frame)?;
        forward(event, &frame.updates, &mut forwarded, progress)?;
        let call = frame.call;
        if expected.len() >= MAX_HOST_CALLS {
            return Err(failure("host_call_limit"));
        }
        let continuation = call.operation == "continuation.next";
        if continuation && event != "intercept" {
            return Err(failure("continuation_outside_interceptor"));
        }
        if !continuation {
            authorize(loaded, &call)?;
        }
        if !active() {
            return Err(failure("callback_cancelled"));
        }
        let call_started = Instant::now();
        let exempt = continuation
            || call.operation == "time.sleep"
            || !crate::client_surface::SURFACE_OPERATIONS.contains(&call.operation.as_str())
            || crate::client_surface::awaits_user(&call.operation, &call.arguments)
            // Clipboard delivery is external work bounded by the surface call lifetime.
            || call.operation == "terminal.copy";
        scope.charge_call()?;
        let separator = usize::from(!receipts.is_empty());
        let (receipt, receipt_bytes) =
            receipt_for(&call, host(call.clone()), receipts_bytes + separator, scope)?;
        expected.push(call);
        receipts_bytes += receipt_bytes + usize::from(!receipts.is_empty());
        receipts.push(receipt.clone());
        if receipts_bytes > HOST_RECEIPT_BYTES {
            return Err(failure("host_receipt_limit"));
        }
        scope.charge_receipt(receipt_bytes)?;
        if exempt {
            waited += call_started.elapsed();
        }
        scope.check_execution(started.elapsed().saturating_sub(waited))?;
        Ok(receipt)
    };
    let evaluated = match &warm {
        Some(key) => process::evaluate_warm(
            key,
            &request,
            loaded.code_cache.as_deref(),
            budget,
            active,
            &mut answer,
        ),
        None => process::evaluate(
            &request,
            loaded.code_cache.as_deref(),
            budget,
            active,
            &mut answer,
        ),
    }?;
    let mut reply: Reply = serde_json::from_value(evaluated).inspect_err(|_| {
        if let Some(key) = &warm {
            process::invalidate_warm(key);
        }
    })?;
    let execution = started.elapsed().saturating_sub(waited);
    scope.charge_execution(execution)?;
    if event != "inspect" && reply.registrations != loaded.registrations {
        if let Some(key) = &warm {
            process::invalidate_warm(key);
        }
        return Err(failure("registration_changed_during_callback"));
    }
    if reply.host_call.is_some() || reply.calls != expected {
        if let Some(key) = &warm {
            process::invalidate_warm(key);
        }
        return Err(failure("invalid_host_call_receipts"));
    }
    forward(event, &reply.updates, &mut forwarded, progress)?;
    reply.receipts = receipts;
    Ok(reply)
}

fn fit_history(request: &mut Request) -> Result<()> {
    if serde_json::to_vec(&*request)?.len() <= process::INPUT_LIMIT {
        return Ok(());
    }
    let Some(items) = request
        .invocation
        .get_mut("payload")
        .and_then(|payload| payload.get_mut("items"))
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
    else {
        return Ok(());
    };
    let Some(mut room) = process::INPUT_LIMIT.checked_sub(serde_json::to_vec(&*request)?.len())
    else {
        request.invocation["payload"]["items"] = Value::Array(items);
        return Ok(());
    };
    let mut kept = 0;
    for item in items.iter().rev() {
        let bytes = serde_json::to_vec(item)?.len() + usize::from(kept > 0);
        if bytes > room {
            break;
        }
        room -= bytes;
        kept += 1;
    }
    request.invocation["payload"]["items"] = Value::Array(items[items.len() - kept..].to_vec());
    Ok(())
}

fn receipt_for(
    call: &ModHostCall,
    result: Result<Value>,
    receipts_bytes: usize,
    scope: &InvocationScope,
) -> Result<(Value, usize)> {
    let receipt = match result {
        Ok(value) => Value::Object(serde_json::Map::from_iter([
            ("call".to_owned(), json!(call)),
            ("value".to_owned(), value),
        ])),
        Err(error) => {
            json!({"call": call, "error": error.to_string().chars().take(768).collect::<String>()})
        }
    };
    let bytes = serde_json::to_vec(&receipt)?.len();
    let room = scope
        .receipt_room()
        .min(HOST_RECEIPT_BYTES.saturating_sub(receipts_bytes));
    if bytes > room {
        let receipt = json!({"call": call, "error": format!(
        "host_result_limit: the {bytes}-byte result exceeds the {room} bytes left in this callback; the operation ran, request a smaller page or an artifact")});
        let bytes = serde_json::to_vec(&receipt)?.len();
        return Ok((receipt, bytes));
    }
    Ok((receipt, bytes))
}

#[derive(Deserialize)]
struct Frame {
    call: ModHostCall,
    updates: Vec<String>,
}

fn forward(
    event: &str,
    updates: &[String],
    forwarded: &mut usize,
    progress: &mut dyn FnMut(String),
) -> Result<()> {
    if updates.len() > 32
        || updates
            .iter()
            .any(|update| update.is_empty() || update.len() > 1024)
    {
        return Err(failure("invalid_progress"));
    }
    if event == "tool" {
        for update in updates.iter().skip(*forwarded) {
            progress(update.clone());
        }
        *forwarded = (*forwarded).max(updates.len());
    }
    Ok(())
}
