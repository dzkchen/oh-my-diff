use super::*;
use crate::workspace_operations::WorkspaceAuthority;
use codex_omd::data_store::Origin;
use std::path::Path;

#[derive(Clone, Default)]
pub(crate) struct DataScope(Arc<Mutex<Option<codex_omd::scoped_data::ScopedDataHosts>>>);

impl DataScope {
    async fn call(
        &self,
        lead: &Lead,
        authority: WorkspaceAuthority,
        caller: &Caller<'_>,
        request: ModHostCall,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Value, String> {
        let root = lead.host.root.clone();
        let scope = self.0.clone();
        let thread = lead.thread.to_string();
        let (id, source) = (caller.id.to_owned(), caller.source.to_owned());
        tokio::task::spawn_blocking(move || {
            let mut scope = scope.lock().map_err(|_| "data_scope_poisoned")?;
            scope
                .get_or_insert_with(|| {
                    codex_omd::scoped_data::ScopedDataHosts::new(
                        root,
                        authority.repository.clone(),
                        authority.session_root.clone(),
                        authority.session_database.clone(),
                        thread,
                    )
                })
                .call(
                    &id,
                    &source,
                    &request.operation,
                    request.arguments,
                    &|path| authority.readable(path),
                    || !cancelled.load(Ordering::Acquire),
                )
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

pub(super) struct Caller<'a> {
    pub id: &'a str,
    pub source: &'a str,
    pub grants: Option<ModGrants>,
    pub generation: u64,
    pub origin: Origin,
}

pub(super) fn event_allows(event: &str, operation: &str) -> bool {
    crate::generic_host::event_allows(event, operation)
        || event == "context"
            && (codex_omd::scoped_data::operation(operation)
                || matches!(
                    operation,
                    "store.get" | "store.list" | "routes.list" | "task.status" | "contract.status"
                ))
}

pub(super) fn route_info(host: &Host, route: &config::Route) -> Value {
    let available = route.grant.as_ref().is_none_or(|grant| {
        accounting::worker_authorized(
            &grant.path,
            &grant.sha256,
            &host.repository_identity,
            &route.provider,
            &route.model,
            &route.responses_url,
            route.rates.included_subscription,
        )
    });
    json!({"name": route.name, "model": route.model, "provider": route.provider,
        "reasoning": route.reasoning_effort, "roles": route.roles,
        "billing": if route.rates.included_subscription {"included_subscription"} else {"explicit_paid_api_grant"},
        "tools": route.tools, "available": available})
}

async fn authority(lead: &Lead, call: Option<&ToolCall<'_>>) -> Result<WorkspaceAuthority, String> {
    match call {
        Some(call) => WorkspaceAuthority::for_call(lead, call).await,
        None => WorkspaceAuthority::for_lead(lead).await,
    }
}

pub(super) fn exclusive(session: &Session) -> Result<OperationGuard<'_>, String> {
    if session.operation.swap(true, Ordering::AcqRel) {
        return Err("workspace_operation_active: another integrate, restore, rename or transaction is running".into());
    }
    Ok(OperationGuard(&session.operation))
}

fn protected_resource(host: &Host, path: Option<&str>) -> bool {
    path.is_none_or(|path| {
        host.protected_paths()
            .iter()
            .filter(|protected| Some(*protected) != host.config.pi_user.as_ref())
            .any(|protected| Path::new(path).starts_with(protected))
    })
}

fn now() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default()
}

fn notify_contract(core: &Core, payload: Value) {
    let runtime = core.runtime.clone();
    tokio::task::spawn_blocking(move || {
        if let Ok(mut runtime) = runtime.lock() {
            let _ = runtime.event("contract", payload);
        }
    });
}

async fn submit_receipt(
    core: &Core,
    lead: &Lead,
    caller: &Caller<'_>,
    arguments: Value,
) -> Result<Value, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        kind: String,
        candidate_sha256: String,
        #[serde(default)]
        acceptance_sha256: Option<String>,
        outcome: codex_omd::ReceiptOutcome,
        evidence: codex_omd::resource_data::ResourceRef,
        #[serde(default)]
        agent: Option<String>,
        #[serde(default)]
        findings: Vec<codex_omd::ReceiptFinding>,
    }
    let input: Input = serde_json::from_value(arguments).map_err(|e| e.to_string())?;
    let producer = match input.agent {
        Some(handle) => {
            core.agents
                .attest(&handle, caller.id, caller.generation)
                .await?;
            codex_omd::ReceiptProducer {
                kind: codex_omd::ProducerKind::Agent,
                handle: Some(handle),
            }
        }
        None => codex_omd::ReceiptProducer {
            kind: codex_omd::ProducerKind::Lead,
            handle: None,
        },
    };
    let receipt = codex_omd::Receipt {
        kind: input.kind,
        candidate_sha256: input.candidate_sha256,
        acceptance_sha256: input.acceptance_sha256,
        outcome: input.outcome,
        evidence: input.evidence,
        producer,
        findings: input.findings,
        submitted_by: caller.id.to_owned(),
        at: now(),
    };
    receipt.validate()?;
    let value = serde_json::to_value(&receipt).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    lead.session
        .evidence(&format!("receipt-{}.json", execution::hash(&bytes)), &value)?;
    let submitted = lead
        .session
        .contract
        .lock()
        .map_err(|_| "contract_lock_poisoned")?
        .submit(receipt)?;
    lead.session.persist_contract()?;
    Ok(submitted)
}

pub(super) fn gate(
    core: &Core,
    lead: &Lead,
    gate: codex_omd::Gate,
    candidate_sha256: &str,
) -> Result<Vec<codex_omd::ContractRequirement>, String> {
    let missing = lead
        .session
        .contract
        .lock()
        .map_err(|_| "contract_lock_poisoned")?
        .gate(gate, candidate_sha256, None)?;
    notify_contract(
        core,
        json!({"gate": gate, "outcome": if missing.is_empty() {"passed"} else {"refused"},
            "missing": missing, "candidate_sha256": candidate_sha256}),
    );
    Ok(missing)
}

async fn complete(core: &Core, lead: &Lead, arguments: Value) -> Result<Value, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        candidate_sha256: String,
    }
    let input: Input = serde_json::from_value(arguments).map_err(|e| e.to_string())?;
    let host = lead.host.clone();
    let current = tokio::task::spawn_blocking(move || contract::current_candidate(&host))
        .await
        .map_err(|e| e.to_string())??;
    if current != input.candidate_sha256 {
        return Err("candidate_changed: the workspace no longer matches candidate_sha256".into());
    }
    let missing = gate(core, lead, codex_omd::Gate::Complete, &current)?;
    if !missing.is_empty() {
        return Ok(json!({"status": "refused", "missing": missing}));
    }
    let status = lead
        .session
        .contract
        .lock()
        .map_err(|_| "contract_lock_poisoned")?
        .status();
    lead.session.evidence(
        &format!("completion-{current}-{}.json", now()),
        &json!({"candidate_sha256": current, "contract": status}),
    )?;
    Ok(json!({"status": "completed", "receipts": status["receipts"]}))
}

fn pi(host: &Host, operation: &str, arguments: Value) -> Result<Value, String> {
    let root = host
        .config
        .pi_user
        .as_ref()
        .ok_or("pi_resource_roots_not_host_approved")?;
    if operation == "pi.discover" {
        let mut catalog = codex_omd::ModStore::discover_pi(root, &host.repository)
            .map_err(|e| e.to_string())?;
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
        return Ok(catalog);
    }
    let name = arguments["name"]
        .as_str()
        .filter(|name| !name.is_empty() && name.len() <= 128)
        .ok_or("invalid_pi_prompt_name")?;
    let text = arguments["args"].as_str().unwrap_or_default();
    if arguments
        .as_object()
        .is_none_or(|object| object.keys().any(|key| key != "name" && key != "args"))
        || text.len() > 8192
    {
        return Err("invalid_pi_expand_arguments".into());
    }
    let expanded = codex_omd::ModStore::expand_pi_prompt(root, &host.repository, name, text)
        .map_err(|e| e.to_string())?;
    if protected_resource(host, expanded["path"].as_str()) {
        return Err("pi_protected_resource".into());
    }
    Ok(expanded)
}

pub(super) async fn dispatch(
    core: &Core,
    lead: &Lead,
    caller: Caller<'_>,
    call: Option<&ToolCall<'_>>,
    request: ModHostCall,
    cancelled: &Arc<AtomicBool>,
) -> Result<Value, String> {
    let host = &lead.host;
    let operation = request.operation.clone();
    if operation != "contract.status" {
        lead.restricted(&operation)?;
    }
    let active = {
        let cancelled = cancelled.clone();
        move || !cancelled.load(Ordering::Acquire)
    };
    if codex_omd::host::served(&operation) {
        let _guard = matches!(operation.as_str(), "workspace.transaction" | "workspace.restore")
            .then(|| exclusive(&lead.session))
            .transpose()?;
        let authority = authority(lead, call).await?;
        let (root, protected) = (host.root.clone(), host.protected_paths());
        let (id, thread) = (caller.id.to_owned(), lead.thread.to_string());
        let (grants, origin) = (caller.grants, caller.origin);
        return tokio::task::spawn_blocking(move || {
            crate::generic_host::call(
                grants,
                &authority,
                &root,
                protected,
                &id,
                origin,
                Some(&thread),
                request,
                &active,
            )
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    if codex_omd::scoped_data::operation(&operation) {
        let authority = authority(lead, call).await?;
        return lead
            .session
            .data
            .call(lead, authority, &caller, request, cancelled.clone())
            .await;
    }
    if operation.starts_with("git.") {
        if caller.origin != Origin::Event {
            return Err(
                "host_operation_unavailable: git reads run in lifecycle events and commands".into(),
            );
        }
        let authority = authority(lead, call).await?;
        let (repository, protected) = (host.repository.clone(), host.protected_paths());
        return tokio::task::spawn_blocking(move || {
            lifecycle_git(true, &repository, &protected, &authority.policy, request, &active)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string());
    }
    if operation == "workspace.request_rename" {
        if call.is_none() {
            return Err(
                "host_operation_unavailable: workspace.request_rename runs in tools".into(),
            );
        }
        let _guard = exclusive(&lead.session)?;
        let authority = authority(lead, call).await?;
        let runtime = core.input_runtime.clone();
        let processes = lead.session.processes.clone();
        let generation = caller.generation;
        return tokio::task::spawn_blocking(move || {
            let mut runtime = runtime.lock().map_err(|_| "pre_rename_runtime_poisoned")?;
            authority.request_rename(request.arguments, &mut runtime, &processes, generation, active)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    if operation.starts_with("process.") {
        crate::generic_host::process_request_allowed(caller.grants.as_ref(), &request)?;
        let authority = authority(lead, call).await?;
        let processes = lead.session.processes.clone();
        let (id, generation) = (caller.id.to_owned(), caller.generation);
        return tokio::task::spawn_blocking(move || {
            processes.call(
                &id,
                generation,
                &authority.repository,
                &authority.policy,
                &request.operation,
                request.arguments,
                active,
            )
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    if operation.starts_with("agents.") || operation == "workspace.integrate" {
        let scoped = match (operation.as_str(), call) {
            ("agents.spawn", Some(call)) => {
                let authority = WorkspaceAuthority::for_call(lead, call).await?;
                Some(Lead {
                    permission_profile: Arc::new(std::sync::Mutex::new(
                        authority.context.permissions,
                    )),
                    ..lead.clone()
                })
            }
            _ => None,
        };
        let lead = scoped.as_ref().unwrap_or(lead);
        return core.agents.call(core, lead, &caller, request).await;
    }
    if operation.starts_with("providers.") || operation.starts_with("sidecars.") {
        return core
            .services
            .call(lead, caller.id, caller.generation, request)
            .await;
    }
    match operation.as_str() {
        "routes.list" => Ok(json!(
            host.config
                .routes_for(caller.id)
                .into_iter()
                .map(|route| route_info(host, route))
                .collect::<Vec<_>>()
        )),
        "task.status" => Ok(json!({"ledger": lead.ledger(), "limits": host.config.limits,
            "worker_limits": host.config.worker_limits})),
        "receipts.submit" => submit_receipt(core, lead, &caller, request.arguments).await,
        "task.complete" => complete(core, lead, request.arguments).await,
        "contract.status" => Ok(lead
            .session
            .contract
            .lock()
            .map_err(|_| "contract_lock_poisoned")?
            .status()),
        "contract.restrict" => {
            let restricted = lead
                .session
                .contract
                .lock()
                .map_err(|_| "contract_lock_poisoned")?
                .restrict(request.arguments)?;
            lead.session.persist_contract()?;
            Ok(restricted)
        }
        "pi.discover" | "pi.expand" => pi(host, &operation, request.arguments),
        _ => Err(format!("unsupported_host_operation: {operation}")),
    }
}
