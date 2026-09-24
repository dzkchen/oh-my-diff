use super::*;
use codex_omd::ModHostCall;
use std::path::Path;

fn protected_resource(host: &Host, path: Option<&str>) -> bool {
    path.is_none_or(|path| {
        host.manifest
            .mod_secret_refs
            .values()
            .chain(host.manifest.mods.iter())
            .any(|protected| Path::new(path).starts_with(protected))
    })
}

fn recovery_selection(host: &Host, id: &str, value: Value) -> Result<PolicySelection, String> {
    let value = value
        .as_str()
        .filter(|value| matches!(*value, "opposite_lead" | "pause"))
        .ok_or("invalid_recovery_policy")?;
    let owner = host
        .mod_owners
        .get(id)
        .cloned()
        .ok_or("unknown_policy_owner")?;
    Ok(PolicySelection {
        policy: "mod".into(),
        value: value.into(),
        provenance: json!({"owner": owner}),
    })
}

pub(super) async fn dispatch(
    agents: &agents::Agents,
    services: &services::Services,
    lead: &Lead,
    id: &str,
    generation: u64,
    call: &ToolCall<'_>,
    request: ModHostCall,
) -> Result<Value, String> {
    let host = &lead.host;
    host.task.check_active().map_err(|e| e.to_string())?;
    if request.operation.starts_with("agents.") {
        return agents.call(services, lead, id, generation, request).await;
    }
    if request.operation.starts_with("providers.") || request.operation.starts_with("sidecars.") {
        return services.call(lead, id, generation, request).await;
    }
    match request.operation.as_str() {
        "pi.discover" => {
            let root = host.manifest.mod_pi_user.as_ref().ok_or("pi_resource_roots_not_host_approved")?;
            let mut catalog = codex_omd::ModStore::discover_pi(root, &host.manifest.repository).map_err(|e| e.to_string())?;
            let mut denied = false;
            if let Some(resources) = catalog["resources"].as_array_mut() {
                resources.retain(|resource| {
                    let protected = protected_resource(host, resource["path"].as_str());
                    denied |= protected;
                    !protected
                });
            }
            if denied && let Some(diagnostics) = catalog["diagnostics"].as_array_mut() {
                diagnostics.push(json!({"error":"pi_protected_resource"}));
            }
            Ok(catalog)
        }
        "pi.expand" => {
            let root = host.manifest.mod_pi_user.as_ref().ok_or("pi_resource_roots_not_host_approved")?;
            let name = request.arguments["name"].as_str().filter(|name| !name.is_empty() && name.len() <= 128).ok_or("invalid_pi_prompt_name")?;
            let arguments = request.arguments["args"].as_str().unwrap_or_default();
            if request.arguments.as_object().is_none_or(|object| object.keys().any(|key| key != "name" && key != "args")) || arguments.len() > 8192 {
                return Err("invalid_pi_expand_arguments".into());
            }
            let expanded = codex_omd::ModStore::expand_pi_prompt(root, &host.manifest.repository, name, arguments).map_err(|e| e.to_string())?;
            if protected_resource(host, expanded["path"].as_str()) {
                return Err("pi_protected_resource".into());
            }
            Ok(expanded)
        }
        "workflow.status" => Ok(host.contract.lock().map_err(|_| "workflow contract lock poisoned")?.view().map_err(|e| e.to_string())?),
        "workflow.restrict" => {
            let owner = host.mod_owners.get(id).cloned().ok_or("unknown_policy_owner")?;
            let operations: Vec<codex_omd::ContractOperation> = serde_json::from_value(request.arguments["operations"].clone()).map_err(|e| e.to_string())?;
            let reason = request.arguments["reason"].as_str().ok_or("invalid_restriction_reason")?;
            if request.arguments.as_object().is_none_or(|object| object.keys().any(|key| key != "operations" && key != "reason")) {
                return Err("invalid_restriction_arguments".into());
            }
            let restrictions = host.contract.lock().map_err(|_| "workflow contract lock poisoned")?.restrict(operations, owner, reason.to_string()).map_err(|e| e.to_string())?;
            host.persist_contract()?;
            Ok(json!({"restrictions": restrictions}))
        }
        "task.status" => Ok(json!({"settings":host.effective_settings,"checkpoint":host.task.checkpoint().map_err(|e| e.to_string())?,"cost":host.task.cost_capture().map_err(|e| e.to_string())?})),
        "routes.list" => Ok(json!([LeadName::Sol, LeadName::Astra].map(|name| {
            let route = host.route(name);
            json!({"name":name,"model":route.model,"provider":route.provider,"reasoning":route.reasoning_effort})
        }))),
        "checkpoint.read" => Ok(json!(host.task.checkpoint().map_err(|e| e.to_string())?)),
        "checkpoint.update" => {
            if !host.manifest.capabilities.checkpoints { return Err("native_checkpoints_disabled".into()); }
            let update = serde_json::from_value(request.arguments).map_err(|e| e.to_string())?;
            Ok(json!(host.save_checkpoint(update)?))
        }
        "review.run" | "review.complete" | "delegation.contribute" | "recovery.escalate" => {
            let lead = Arc::new(lead.clone());
            let mut arguments = request.arguments;
            let final_cadence = arguments["cadence"] == "final";
            host.authorize_contract(match request.operation.as_str() {
                "review.run" if final_cadence => codex_omd::ContractOperation::FinalReview,
                "review.run" => codex_omd::ContractOperation::MilestoneReview,
                "review.complete" => codex_omd::ContractOperation::Completion,
                "delegation.contribute" => codex_omd::ContractOperation::Delegate,
                _ => codex_omd::ContractOperation::Escalate,
            })?;
            let recovery = match request.operation.as_str() {
                "delegation.contribute" => arguments
                    .as_object_mut()
                    .and_then(|object| object.remove("outage_action"))
                    .map(|value| recovery_selection(host, id, value))
                    .transpose()?,
                "recovery.escalate" => arguments
                    .as_object_mut()
                    .and_then(|object| object.remove("advisory_route"))
                    .map(|value| recovery_selection(host, id, value))
                    .transpose()?,
                _ => None,
            };
            let tool: Box<dyn for<'a> ToolExecutor<ToolCall<'a>>> = match request.operation.as_str() {
                "review.run" if host.manifest.capabilities.unified_review => Box::new(ReviewTool(lead)),
                "review.complete" if host.manifest.capabilities.completion_gate => Box::new(CompletionTool(lead)),
                "delegation.contribute" if host.manifest.capabilities.delegation => Box::new(ContributionTool { lead, recovery }),
                "recovery.escalate" if host.manifest.capabilities.escalation => Box::new(EscalationTool { lead, recovery }),
                _ => return Err("native_capability_disabled".into()),
            };
            let mut nested = call.clone();
            nested.tool_name = tool.tool_name();
            nested.payload = codex_tools::ToolPayload::Function { arguments: serde_json::to_string(&arguments).map_err(|e| e.to_string())? };
            let payload = nested.payload.clone();
            let output = tool.handle(nested).await.map_err(|e| e.to_string())?;
            Ok(output.code_mode_result(&payload))
        }
        "tools.exec" => {
            if host.operation.swap(true, std::sync::atomic::Ordering::AcqRel) { return Err("another controlled operation is active".into()); }
            let _operation = OperationGuard(&host.operation);
            let argv: Vec<String> = serde_json::from_value(request.arguments).map_err(|e| e.to_string())?;
            if argv.is_empty() || argv.len() > 128 || argv.iter().map(String::len).sum::<usize>() > 8192 {
                return Err("exec_argument_limit".into());
            }
            let manager = host.manager.upgrade().ok_or("native_thread_manager_stopped")?;
            let config = manager.get_thread(lead.thread).await.map_err(|e| e.to_string())?.config().await;
            let restricted = execution::isolated(&config, &host.manifest.repository, &host.manifest.toolchain_reads, &execution::protected_paths(&host.manifest), true)?;
            execution::command(host, &restricted, argv).await
        }
        _ => Err(format!("unsupported_host_operation: {}", request.operation)),
    }
}
