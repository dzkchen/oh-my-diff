use super::*;
use std::time::Duration;
use std::time::Instant;

/// Host calls that end the callback's process; it replays from its receipts once they settle.
pub(super) const SUSPENDING: &[&str] = &["continuation.next", "time.sleep"];

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
            "routes.list" | "providers.register" | "providers.unregister" | "ledger.settle" => {
                Ok("model")
            }
            "task.status" | "workspace.integrate" => Ok("agents"),
            "task.complete" | "receipts.submit" | "contract.status" | "contract.restrict"
            | "contract.select" => Ok("contracts"),
            "mods.service" => Ok("services"),
            "app.request" => self.arguments["method"]
                .as_str()
                .and_then(crate::app_routes::route)
                .map(|route| route.class.as_str())
                .ok_or_else(|| failure("app_method_unrouted")),
            "app.routes" | "session.info" | "tools.list" => Ok("inventory"),
            "time.sleep" => Ok("events"),
            "workspace.watch" | "workspace.unwatch" => Ok("fs.read"),
            "events.publish" | "events.schedule" | "events.cancel" => Ok("events"),
            "credentials.list" | "credentials.request" => Ok("credentials"),
            "routes.select" => Ok("model"),
            "turns.activity" => Ok("sessions"),
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
            | "terminal.notice"
            | "terminal.blit" => Ok("terminal"),
            "terminal.pty" => Ok("pty"),
            "model.complete" | "model.fork" => Ok("agents"),
            "tools.define" | "tools.undefine" => Ok("tools"),
            "tools.invoke" | "tools.check" => Ok("interception"),
            "composer.read" | "composer.write" | "composer.suggest" => Ok("composer"),
            "prompts.consent" | "prompts.submit" | "prompts.status" | "prompts.revoke" => {
                Ok("composer")
            }
            "builtins.invoke" | "commands.invoke" => Ok("builtins"),
            "config.describe" => Ok("config"),
            "config.set" => Ok("config.write"),
            "packages.list" | "packages.index" | "packages.preview" | "packages.apply"
            | "packages.reload" => Ok("packages"),
            "settings.write" if self.arguments["id"].is_string() => Ok("packages"),
            "settings.write" => Ok("commands"),
            "http.request" | "http.open" | "http.read" | "http.close" => Ok("http"),
            "mcp.connect" | "mcp.disconnect" => Ok("mcp"),
            "environment.read" => Ok("exec"),
            "peers.list" | "peers.send" => Ok("peers"),
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
            capabilities.push("sessions");
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
    if call.operation.starts_with("context.")
        && !loaded
            .package
            .capabilities
            .iter()
            .any(|cap| cap == "context")
    {
        return Err(failure("capability_denied: context"));
    }
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

#[allow(clippy::too_many_arguments)]
pub(super) fn run(
    node: &Path,
    loaded: &Loaded,
    event: &str,
    name: &str,
    payload: Value,
    replay: &[Value],
    active: &dyn Fn() -> bool,
    host: &mut dyn FnMut(ModHostCall) -> Result<Value>,
    progress: &mut dyn FnMut(String),
    virtual_time_ms: Option<u64>,
    scope: &InvocationScope,
) -> Result<Reply> {
    let mut receipts = replay.to_vec();
    let mut expected = replay
        .iter()
        .map(|receipt| serde_json::from_value::<ModHostCall>(receipt["call"].clone()))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut forwarded = 0;
    let mut waited = Duration::ZERO;
    let mut request = json!({"source": loaded.source, "filename": loaded.selection.path.join("index.ts"),
        "api": MOD_API_VERSION,
        "assets": loaded.assets,
        "entrypoint": loaded.package.entrypoint,
        "entrypoint_sha256": digest(loaded.source.as_bytes()),
        "package": {"id": loaded.package.id, "version": loaded.package.version},
        "capabilities": loaded.package.capabilities, "adapter": loaded.package.adapter, "settings": effective_settings(loaded.package.settings_schema.as_ref(), &loaded.selection.settings),
        "state": loaded.state, "event": event, "name": name, "payload": payload, "interactive": true,
        "hook_budget_ms": loaded.package.hook_budget_ms,"environment":loaded.package.environment});
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
    request["virtual_time_ms"] = virtual_time_ms.map_or(Value::Null, Value::from);
    let started = Instant::now();
    let budget = Duration::from_millis(loaded.package.hook_budget_ms);
    // A continuation suspends the callback; it replays from its receipts once the downstream chain settles.
    let mut reply: Reply = loop {
        request["receipts"] = Value::Array(receipts.clone());
        let evaluated = process::evaluate(node, &request, budget, active, &mut |frame| {
            if event == "inspect" {
                return Err(failure("invalid_host_call_sequence"));
            }
            let frame: Frame = serde_json::from_value(frame)?;
            forward(event, &frame.updates, &mut forwarded, progress)?;
            let call = frame.call;
            if expected.len() >= 32 {
                return Err(failure("host_call_limit"));
            }
            authorize(loaded, &call)?;
            if !active() {
                return Err(failure("callback_cancelled"));
            }
            let call_started = Instant::now();
            let exempt = !crate::client_surface::SURFACE_OPERATIONS
                .contains(&call.operation.as_str())
                || crate::client_surface::awaits_user(&call.operation, &call.arguments);
            scope.charge_call()?;
            let result = host(call.clone());
            let mut receipt = match result {
                Ok(value) => json!({"call": call, "value": value}),
                Err(error) => {
                    json!({"call": call, "error": error.to_string().chars().take(768).collect::<String>()})
                }
            };
            let bytes = serde_json::to_vec(&receipt)?.len();
            let room = scope
                .receipt_room()
                .min(HOST_RECEIPT_BYTES.saturating_sub(serde_json::to_vec(&receipts)?.len()));
            if bytes > room {
                receipt = json!({"call": call, "error": format!(
                "host_result_limit: the {bytes}-byte result exceeds the {room} bytes left in this callback; the operation ran, request a smaller page or an artifact")});
            }
            expected.push(call);
            receipts.push(receipt.clone());
            if serde_json::to_vec(&receipts)?.len() > HOST_RECEIPT_BYTES {
                return Err(failure("host_receipt_limit"));
            }
            scope.charge_receipt(serde_json::to_vec(&receipt)?.len())?;
            if exempt {
                waited += call_started.elapsed();
            }
            scope.check_execution(started.elapsed().saturating_sub(waited))?;
            Ok(receipt)
        });
        let reply: Reply = serde_json::from_value(evaluated?)?;
        let Some(call) = reply
            .host_call
            .clone()
            .filter(|call| SUSPENDING.contains(&call.operation.as_str()))
            .filter(|call| reply.calls.split_last() == Some((call, &expected[..])))
        else {
            break reply;
        };
        if call.operation == "continuation.next" && event != "intercept" {
            return Err(failure("continuation_outside_interceptor"));
        }
        if call.operation == "time.sleep" {
            authorize(loaded, &call)?;
        }
        if expected.len() >= 32 {
            return Err(failure("host_call_limit"));
        }
        scope.charge_call()?;
        let call_started = Instant::now();
        let receipt = match host(call.clone()) {
            Ok(value) => json!({"call": call, "value": value}),
            Err(error) => {
                json!({"call": call, "error": error.to_string().chars().take(768).collect::<String>()})
            }
        };
        waited += call_started.elapsed();
        expected.push(call);
        receipts.push(receipt);
        if serde_json::to_vec(&receipts)?.len() > HOST_RECEIPT_BYTES {
            return Err(failure("host_receipt_limit"));
        }
    };
    let execution = started.elapsed().saturating_sub(waited);
    scope.charge_execution(execution)?;
    if event != "inspect" && reply.registrations != loaded.registrations {
        return Err(failure("registration_changed_during_callback"));
    }
    if reply.host_call.is_some() || reply.calls != expected {
        return Err(failure("invalid_host_call_receipts"));
    }
    forward(event, &reply.updates, &mut forwarded, progress)?;
    reply.receipts = receipts;
    Ok(reply)
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
