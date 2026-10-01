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
            "sessions.list" | "sessions.read" | "sessions.snapshot" => Ok("sessions"),
            "routes.list" | "providers.register" | "providers.unregister" => Ok("model"),
            "task.status" | "workspace.integrate" => Ok("agents"),
            "task.complete" | "receipts.submit" | "contract.status" | "contract.restrict" => {
                Ok("contracts")
            }
            "mods.service" => Ok("services"),
            "app.request" => self.arguments["method"]
                .as_str()
                .and_then(crate::app_routes::route)
                .map(|route| route.class.as_str())
                .ok_or_else(|| failure("app_method_unrouted")),
            "app.routes" => Ok("inventory"),
            "workspace.watch" | "workspace.unwatch" => Ok("fs.read"),
            "events.publish" | "events.schedule" | "events.cancel" => Ok("events"),
            "credentials.list" | "credentials.request" => Ok("credentials"),
            "routes.select" => Ok("model"),
            "turns.activity" => Ok("sessions"),
            "terminal.notify"
            | "terminal.show_thread"
            | "terminal.import_file"
            | "terminal.image_sample"
            | "terminal.open"
            | "terminal.prompt" => Ok("terminal"),
            "terminal.pty" => Ok("pty"),
            "model.complete" => Ok("agents"),
            "tools.define" | "tools.undefine" => Ok("tools"),
            "composer.read" | "composer.write" => Ok("composer"),
            "builtins.invoke" => Ok("builtins"),
            "packages.list" | "packages.preview" | "packages.apply" | "packages.reload" => {
                Ok("packages")
            }
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
        if self.operation == "terminal.pty" {
            if self.arguments["write"] == true {
                capabilities.push("fs.write");
            }
            if self.arguments["network"] == "loopback" {
                capabilities.push("network");
            }
        }
        Ok(capabilities)
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run(
    node: &Path,
    loaded: &Loaded,
    event: &str,
    name: &str,
    payload: Value,
    active: &dyn Fn() -> bool,
    host: &mut dyn FnMut(ModHostCall) -> Result<Value>,
    progress: &mut dyn FnMut(String),
    virtual_time_ms: Option<u64>,
    scope: &InvocationScope,
) -> Result<Reply> {
    let mut receipts = Vec::new();
    let mut expected = Vec::new();
    let mut execution = Duration::ZERO;
    let mut forwarded = 0;
    loop {
        if !active() {
            return Err(failure("callback_cancelled"));
        }
        let request = json!({"source": loaded.source, "filename": loaded.selection.path.join("index.ts"),
            "api": MOD_API_VERSION,
            "assets": loaded.assets,
            "entrypoint": loaded.package.entrypoint,
            "entrypoint_sha256": digest(loaded.source.as_bytes()),
            "capabilities": loaded.package.capabilities, "adapter": loaded.package.adapter, "settings": loaded.selection.settings,
            "state": loaded.state, "event": event, "name": name, "payload": payload, "receipts": receipts,
            "hook_budget_ms": loaded.package.hook_budget_ms,"environment":loaded.package.environment});
        let mut request = request;
        request["field_policies"] = ModHost::field_policies();
        request["surface"] = json!({
            "events": MOD_EVENTS.iter().map(|(event, capability)| (event.to_string(), json!(capability))).collect::<serde_json::Map<_, _>>(),
            "replacements": MOD_REPLACEMENT_POINTS,
            "middleware": MOD_MIDDLEWARE_EVENTS,
            "state": "store",
            "contracts": "contracts",
            "adapter": loaded.adapter,
        });
        request["virtual_time_ms"] = virtual_time_ms.map_or(Value::Null, Value::from);
        let started = Instant::now();
        let budget = Duration::from_millis(loaded.package.hook_budget_ms);
        let evaluated = process::evaluate(node, &request, budget, active);
        let elapsed = started.elapsed();
        scope.charge_execution(elapsed)?;
        execution += elapsed;
        let reply: Reply = serde_json::from_value(evaluated?)?;
        if event != "inspect" && reply.registrations != loaded.registrations {
            return Err(failure("registration_changed_during_callback"));
        }
        // Host-call replay re-runs the module, so the whole callback carries a total budget.
        if execution > Duration::from_millis(MOD_CALLBACK_TOTAL_BUDGET_MS) {
            return Err(failure("callback_execution_budget"));
        }
        if !reply.calls.starts_with(&expected) {
            return Err(failure("host_call_replay_diverged"));
        }
        if reply.updates.len() > 32
            || reply
                .updates
                .iter()
                .any(|update| update.is_empty() || update.len() > 1024)
        {
            return Err(failure("invalid_progress"));
        }
        if event == "tool" {
            for update in reply.updates.iter().skip(forwarded) {
                progress(update.clone());
            }
            forwarded = forwarded.max(reply.updates.len());
        }
        let Some(call) = &reply.host_call else {
            if reply.calls != expected {
                return Err(failure("invalid_host_call_receipts"));
            }
            return Ok(reply);
        };
        if event == "inspect"
            || reply.calls.len() != expected.len() + 1
            || reply.calls.last() != Some(call)
        {
            return Err(failure("invalid_host_call_sequence"));
        }
        if expected.len() >= 32 {
            return Err(failure("host_call_limit"));
        }
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
        if !active() {
            return Err(failure("callback_cancelled"));
        }
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
        expected.push(call.clone());
        receipts.push(receipt);
        if serde_json::to_vec(&receipts)?.len() > HOST_RECEIPT_BYTES {
            return Err(failure("host_receipt_limit"));
        }
        scope.charge_receipt(serde_json::to_vec(receipts.last().unwrap())?.len())?;
    }
}
