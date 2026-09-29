use super::*;
use codex_extension_api::ApprovalGate;
use codex_extension_api::ApprovalGateContributor;
use codex_extension_api::ApprovalGateInput;
use codex_extension_api::ApprovalResultInput;

fn reason(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(512).collect()
}

pub(super) fn decide(
    results: Vec<(String, std::io::Result<Value>)>,
) -> (ApprovalGate, Option<String>) {
    let mut ask: Option<(String, String)> = None;
    for (id, result) in results {
        let value = match result {
            Ok(Value::Null) => continue,
            Ok(value) => value,
            Err(error) => {
                ask.get_or_insert((
                    id.clone(),
                    format!(
                        "Mod {id} approval check failed: {}",
                        reason(&error.to_string())
                    ),
                ));
                continue;
            }
        };
        let single = value.as_object().filter(|object| object.len() == 1);
        match single.and_then(|object| object.iter().next()) {
            Some((key, Value::String(text))) if key == "deny" => {
                return (
                    ApprovalGate::Deny(format!("Mod {id} denied this action: {}", reason(text))),
                    Some(id),
                );
            }
            Some((key, Value::String(text))) if key == "ask" => {
                ask.get_or_insert((
                    id.clone(),
                    format!("Mod {id} requires approval: {}", reason(text)),
                ));
            }
            _ => {
                ask.get_or_insert((
                    id.clone(),
                    format!("Mod {id} returned an invalid approval decision"),
                ));
            }
        }
    }
    match ask {
        Some((id, text)) => (ApprovalGate::Ask(text), Some(id)),
        None => (ApprovalGate::Continue, None),
    }
}

impl ApprovalGateContributor for Mods {
    fn gate_approval<'a>(
        &'a self,
        input: ApprovalGateInput<'a>,
    ) -> ExtensionFuture<'a, ApprovalGate> {
        Box::pin(async move {
            if !self.expansion.approval.load(Ordering::Acquire) {
                return ApprovalGate::Continue;
            }
            let Some(lead) = input.thread_store.get::<Lead>() else {
                return ApprovalGate::Continue;
            };
            let payload = json!({"id": input.call_id, "kind": input.kind,
                "thread_id": lead.thread.to_string(), "turn_id": input.turn_id,
                "agent_id": agent_id(input.thread_store), "host_decision": input.host_decision,
                "policy": input.policy, "details": input.details});
            let runtime = self.runtime.clone();
            let cancelled = Arc::new(AtomicBool::new(false));
            let _cancellation = Cancellation(cancelled.clone());
            let results = tokio::task::spawn_blocking(move || {
                let mut runtime = runtime.lock().map_err(|_| "mod_runtime_poisoned")?;
                Ok::<_, &str>(
                    runtime
                        .event_guarded("approval", payload, || !cancelled.load(Ordering::Acquire)),
                )
            })
            .await;
            let (gate, owner) = match results {
                Ok(Ok(results)) => decide(results),
                _ => (
                    ApprovalGate::Ask("Mod approval checks were unavailable".into()),
                    None,
                ),
            };
            if let (Some(owner), Ok(mut gates)) = (owner, self.expansion.gates.lock()) {
                gates.retain(|(call, _)| call != input.call_id);
                if gates.len() >= 256 {
                    gates.pop_front();
                }
                gates.push_back((input.call_id.to_owned(), owner));
            }
            self.cleanup_failed(Some(&lead)).await;
            gate
        })
    }

    fn on_approval_result<'a>(&'a self, input: ApprovalResultInput<'a>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let owner = self.expansion.gates.lock().ok().and_then(|mut gates| {
                let index = gates.iter().position(|(call, _)| call == input.call_id)?;
                gates.remove(index).map(|(_, owner)| owner)
            });
            if !self.expansion.approval_result.load(Ordering::Acquire) {
                return;
            }
            if input.thread_store.get::<Lead>().is_none() {
                return;
            }
            let mut payload = json!({"id": input.call_id, "kind": input.kind,
                "decision": input.decision, "source": input.source});
            if let Some(owner) = owner.filter(|_| input.source == "mod" || input.source == "user") {
                payload["mod"] = Value::String(owner);
            }
            delivery::push(
                &self.expansion,
                delivery::Pending::Broadcast {
                    event: "approval_result",
                    payload,
                },
            );
        })
    }
}
