use super::*;
use codex_omd::ModHostCall;
use std::path::Path;

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
                    let protected = resource["path"].as_str().is_none_or(|path| {
                        host.manifest.mod_secret_refs.values().chain(host.manifest.mods.iter()).any(|protected| Path::new(path).starts_with(protected))
                    });
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
            let protected = expanded["path"].as_str().is_none_or(|path| {
                host.manifest.mod_secret_refs.values().chain(host.manifest.mods.iter()).any(|protected| Path::new(path).starts_with(protected))
            });
            if protected {
                return Err("pi_protected_resource".into());
            }
            Ok(expanded)
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
            let tool: Box<dyn for<'a> ToolExecutor<ToolCall<'a>>> = match request.operation.as_str() {
                "review.run" if host.manifest.capabilities.unified_review => Box::new(ReviewTool(lead)),
                "review.complete" if host.manifest.capabilities.completion_gate => Box::new(CompletionTool(lead)),
                "delegation.contribute" if host.manifest.capabilities.delegation => Box::new(ContributionTool(lead)),
                "recovery.escalate" if host.manifest.capabilities.escalation => Box::new(EscalationTool(lead)),
                _ => return Err("native_capability_disabled".into()),
            };
            let mut nested = call.clone();
            nested.tool_name = tool.tool_name();
            nested.payload = codex_tools::ToolPayload::Function { arguments: serde_json::to_string(&request.arguments).map_err(|e| e.to_string())? };
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
