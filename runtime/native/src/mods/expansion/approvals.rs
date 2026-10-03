use super::*;
use codex_extension_api::ApprovalGate;
use codex_extension_api::ApprovalGateContributor;
use codex_extension_api::ApprovalGateInput;
use codex_extension_api::ApprovalResultInput;

fn reason(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(512).collect()
}

fn matches(pattern: &str, value: &str) -> bool {
    pattern == "*"
        || pattern == value
        || pattern
            .strip_suffix('*')
            .is_some_and(|prefix| value.starts_with(prefix))
        || pattern
            .strip_prefix("*.")
            .is_some_and(|suffix| value.ends_with(&format!(".{suffix}")))
}

fn base(value: &Value) -> String {
    value
        .as_str()
        .and_then(|path| path.rsplit('/').next())
        .unwrap_or_default()
        .to_owned()
}

fn local(value: &Value) -> Option<std::path::PathBuf> {
    serde_json::from_value::<codex_utils_path_uri::PathUri>(value.clone())
        .ok()
        .map(|uri| uri.to_path_buf())
        .or_else(|| value.as_str().map(std::path::PathBuf::from))
}

/// Checks a mod approval against its current delegated grant: kind, tool, roots and hosts.
pub(super) fn within_grant(
    grants: Option<&codex_omd::ModGrants>,
    kind: &str,
    host_decision: &str,
    details: &Value,
) -> Result<(), String> {
    let grants = grants.ok_or("the mod is not active")?;
    let granted = |name: &str| grants.capabilities.iter().any(|c| c == name);
    let scope = grants
        .approves
        .as_ref()
        .filter(|_| granted("approve"))
        .ok_or("no current approve grant")?;
    if host_decision == "forbidden" && !granted("approve.override") {
        return Err("your rules forbid this and approve.override is not granted".into());
    }
    if !scope.kinds.iter().any(|allowed| allowed == kind) {
        return Err(format!("{kind} requests are outside its grant"));
    }
    let tool = match kind {
        "exec" => {
            let command = &details["command"];
            match (command[1].as_str(), command[2].as_str()) {
                (Some("-c" | "-lc"), Some(script))
                    if !script.contains(|c: char| ";&|`$<>(){}\n\\".contains(c)) =>
                {
                    base(&json!(script.split_whitespace().next().unwrap_or_default()))
                }
                _ => base(&command[0]),
            }
        }
        "execve" => base(&details["program"]),
        "mcp_tool" => format!(
            "{}/{}",
            details["server"].as_str().unwrap_or_default(),
            details["tool_name"].as_str().unwrap_or_default()
        ),
        "patch" => "apply_patch".to_owned(),
        "stdin" => "write_stdin".to_owned(),
        _ => "network".to_owned(),
    };
    if !scope.tools.is_empty() && !scope.tools.iter().any(|pattern| matches(pattern, &tool)) {
        return Err(format!("{tool} is outside its grant"));
    }
    let paths: Vec<Value> = match kind {
        "patch" => details["files"].as_array().cloned().unwrap_or_default(),
        "exec" | "execve" | "stdin" => vec![details["cwd"].clone()],
        _ => Vec::new(),
    };
    if !scope.roots.is_empty() && !scope.roots.iter().any(|root| root == "*") {
        for path in &paths {
            let path = local(path).ok_or("a request path is unreadable")?;
            if path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
                || !scope.roots.iter().any(|root| path.starts_with(root))
            {
                return Err(format!("{} is outside its roots", path.display()));
            }
        }
    }
    if kind == "network"
        && !scope.hosts.is_empty()
        && !scope
            .hosts
            .iter()
            .any(|pattern| matches(pattern, details["host"].as_str().unwrap_or_default()))
    {
        return Err("the host is outside its grant".into());
    }
    Ok(())
}

pub(super) fn decide(
    results: Vec<(String, std::io::Result<Value>)>,
    grant: &dyn Fn(&str) -> Result<(), String>,
) -> (ApprovalGate, Option<String>) {
    let mut ask: Option<(String, String)> = None;
    let mut approve: Option<(String, String)> = None;
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
            Some((key, Value::String(text))) if key == "approve" => match grant(&id) {
                Ok(()) => {
                    approve.get_or_insert((
                        id.clone(),
                        format!(
                            "Mod {id} approved this under its delegated grant: {}",
                            reason(text)
                        ),
                    ));
                }
                Err(why) => {
                    ask.get_or_insert((
                        id.clone(),
                        format!("Mod {id} tried to approve, but {}", reason(&why)),
                    ));
                }
            },
            _ => {
                ask.get_or_insert((
                    id.clone(),
                    format!("Mod {id} returned an invalid approval decision"),
                ));
            }
        }
    }
    match (ask, approve) {
        (Some((id, text)), _) => (ApprovalGate::Ask(text), Some(id)),
        (None, Some((id, text))) => (ApprovalGate::Approve(text), Some(id)),
        (None, None) => (ApprovalGate::Continue, None),
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
                "policy": input.policy, "details": input.details, "assessment": input.assessment});
            let runtime = self.runtime.clone();
            let cancelled = Arc::new(AtomicBool::new(false));
            let _cancellation = Cancellation(cancelled.clone());
            let (kind, host_decision, details) = (
                input.kind.to_owned(),
                input.host_decision.to_owned(),
                input.details.clone(),
            );
            let results = tokio::task::spawn_blocking(move || {
                let mut runtime = runtime.lock().map_err(|_| "mod_runtime_poisoned")?;
                let results = runtime
                    .event_guarded("approval", payload, || !cancelled.load(Ordering::Acquire));
                let grants = results
                    .iter()
                    .filter_map(|(id, _)| runtime.grants(id).map(|grants| (id.clone(), grants)))
                    .collect::<BTreeMap<_, _>>();
                Ok::<_, &str>(decide(results, &|id| {
                    within_grant(grants.get(id), &kind, &host_decision, &details)
                }))
            })
            .await;
            let (gate, owner) = match results {
                Ok(Ok(decided)) => decided,
                _ => (
                    ApprovalGate::Ask("Mod approval checks were unavailable".into()),
                    None,
                ),
            };
            if let (Some(owner), Ok(mut gates)) = (
                owner.filter(|_| !input.assessment),
                self.expansion.gates.lock(),
            ) {
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
