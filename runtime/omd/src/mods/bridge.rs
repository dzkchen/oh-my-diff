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
        match self.operation.as_str() {
            "task.status" | "routes.list" | "checkpoint.read" | "checkpoint.update" => Ok("task"),
            "agents.spawn" | "agents.message" | "agents.cancel" | "agents.result"
            | "agents.wait" | "agents.list" => Ok("agents"),
            "review.run" | "review.complete" => Ok("review"),
            "recovery.escalate" | "delegation.contribute" => Ok("recovery"),
            "tools.exec" => Ok("execution"),
            "providers.register" | "providers.unregister" => Ok("providers"),
            "pi.discover" | "pi.expand" => Ok("pi_resources"),
            "sidecars.start" | "sidecars.stop" | "sidecars.status" => Ok("sidecars"),
            "workflow.status" | "workflow.restrict" => Ok("workflow"),
            _ => Err(failure(format!(
                "unsupported_host_operation: {}",
                self.operation
            ))),
        }
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
            "capabilities": loaded.package.capabilities, "adapter": loaded.package.adapter, "settings": loaded.selection.settings,
            "state": loaded.state, "event": event, "name": name, "payload": payload, "receipts": receipts});
        let started = Instant::now();
        let reply: Reply = serde_json::from_value(process::evaluate(node, &request, active)?)?;
        if event != "inspect" && reply.registrations != loaded.registrations {
            return Err(failure("registration_changed_during_callback"));
        }
        execution += started.elapsed();
        if execution > Duration::from_secs(6) {
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
        let capability = call.capability()?;
        if !loaded.package.capabilities.iter().any(|c| c == capability) {
            return Err(failure(format!("capability_denied: {capability}")));
        }
        if !active() {
            return Err(failure("callback_cancelled"));
        }
        let result = host(call.clone());
        let receipt = match result {
            Ok(value) => json!({"call": call, "value": value}),
            Err(error) => {
                json!({"call": call, "error": error.to_string().chars().take(768).collect::<String>()})
            }
        };
        expected.push(call.clone());
        receipts.push(receipt);
        if serde_json::to_vec(&receipts)?.len() > 131_072 {
            return Err(failure("host_receipt_limit"));
        }
    }
}
