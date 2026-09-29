use super::*;
use crate::workspace_operations::WorkspaceAuthority;
use codex_omd::data_store::Origin;

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
    pub record_changes: bool,
}

pub(super) fn event_allows(event: &str, operation: &str) -> bool {
    crate::generic_host::event_allows(event, operation)
        || event == "context"
            && (codex_omd::scoped_data::operation(operation)
                || matches!(
                    operation,
                    "store.get"
                        | "store.list"
                        | "routes.list"
                        | "task.status"
                        | "contract.status"
                        | "workspace.snapshot"
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
    acquire_workspace_operation(&session.operation, &session.repository_identity)
}

fn needs_exclusive_workspace(operation: &str, arguments: &Value) -> bool {
    matches!(operation, "workspace.transaction" | "workspace.restore")
        || operation == "exec.run"
            && arguments.get("snapshot").is_none()
            && (arguments.get("write") == Some(&Value::Bool(true))
                || arguments.get("guards").is_some()
                || arguments.get("required_access").is_some())
}

fn workspace_guard<'a>(
    operation: &str,
    arguments: &Value,
    active: &'a AtomicBool,
    repository_identity: &str,
) -> Result<Option<OperationGuard<'a>>, String> {
    needs_exclusive_workspace(operation, arguments)
        .then(|| acquire_workspace_operation(active, repository_identity))
        .transpose()
}

pub(super) fn now() -> u128 {
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
        execution: bool,
        #[serde(default)]
        findings: Vec<codex_omd::ReceiptFinding>,
        #[serde(default)]
        resolves: Vec<String>,
    }
    let input: Input = serde_json::from_value(arguments).map_err(|e| e.to_string())?;
    if input.execution && input.agent.is_some() {
        return Err("receipt_producer_conflict".into());
    }
    let producer = match input.agent {
        Some(handle) => {
            core.agents
                .attest(
                    &handle,
                    caller.id,
                    caller.generation,
                    &lead.session.task,
                    &input.candidate_sha256,
                    input.acceptance_sha256.as_deref(),
                    &input.resolves,
                    &input.evidence,
                )
                .await?;
            codex_omd::ReceiptProducer {
                kind: codex_omd::ProducerKind::Agent,
                handle: Some(handle),
            }
        }
        None if input.execution => {
            core.agents.attest_execution(
                lead,
                caller,
                &input.candidate_sha256,
                &input.evidence,
                input.outcome,
            )?;
            codex_omd::ReceiptProducer {
                kind: codex_omd::ProducerKind::Host,
                handle: None,
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
        resolves: input.resolves,
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
    acceptance_sha256: Option<&str>,
) -> Result<Vec<codex_omd::ContractRequirement>, String> {
    let missing = lead
        .session
        .contract
        .lock()
        .map_err(|_| "contract_lock_poisoned")?
        .gate(gate, candidate_sha256, acceptance_sha256)?;
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
        #[serde(default)]
        acceptance_sha256: Option<String>,
    }
    let input: Input = serde_json::from_value(arguments).map_err(|e| e.to_string())?;
    let _workspace_guard = exclusive(&lead.session)?;
    let host = lead.host.clone();
    let current = tokio::task::spawn_blocking(move || contract::current_candidate(&host))
        .await
        .map_err(|e| e.to_string())??;
    if current != input.candidate_sha256 {
        return Err("candidate_changed: the workspace no longer matches candidate_sha256".into());
    }
    let contract = lead
        .session
        .contract
        .lock()
        .map_err(|_| "contract_lock_poisoned")?;
    let missing = match contract.gate(
        codex_omd::Gate::Complete,
        &current,
        input.acceptance_sha256.as_deref(),
    ) {
        Ok(missing) => missing,
        Err(error) if error.starts_with("unresolved_blocking_findings:") => {
            let outstanding = error
                .trim_start_matches("unresolved_blocking_findings:")
                .split(',')
                .collect::<Vec<_>>();
            notify_contract(
                core,
                json!({"gate":"complete","outcome":"refused","reason":"unresolved_blocking_findings",
                    "outstanding_findings":outstanding,"candidate_sha256":current}),
            );
            return Ok(
                json!({"status":"refused","reason":"unresolved_blocking_findings",
                "outstanding_findings":outstanding}),
            );
        }
        Err(error) => return Err(error),
    };
    notify_contract(
        core,
        json!({"gate":"complete","outcome":if missing.is_empty() {"passed"} else {"refused"},
            "missing":missing,"candidate_sha256":current}),
    );
    if !missing.is_empty() {
        return Ok(json!({"status": "refused", "missing": missing}));
    }
    let status = contract.status();
    lead.session.evidence(
        &format!("completion-{current}-{}.json", now()),
        &json!({"candidate_sha256": current, "contract": status}),
    )?;
    Ok(json!({"status": "completed", "receipts": status["receipts"]}))
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
        lead.restricted(&operation, &request.arguments)?;
    }
    let active = {
        let cancelled = cancelled.clone();
        move || !cancelled.load(Ordering::Acquire)
    };
    if codex_omd::host::served(&operation) {
        if operation == "exec.run" && request.arguments.get("snapshot").is_some() {
            if request.arguments.get("guards").is_some()
                || request.arguments.get("required_access").is_some()
            {
                return Err("exec_guards_require_live_workspace".into());
            }
            let authority = authority(lead, call).await?;
            let scoped = Lead {
                permission_profile: Arc::new(std::sync::Mutex::new(authority.context.permissions)),
                ..lead.clone()
            };
            return core
                .agents
                .execute_snapshot(&scoped, &caller, request.arguments, cancelled)
                .await;
        }
        let _guard = workspace_guard(
            &operation,
            &request.arguments,
            &lead.session.operation,
            &lead.session.repository_identity,
        )?;
        let authority = authority(lead, call).await?;
        let (root, protected) = (host.root.clone(), host.protected_paths());
        let (id, thread) = (caller.id.to_owned(), lead.thread.to_string());
        let (grants, origin, record) = (caller.grants, caller.origin, caller.record_changes);
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
                record,
            )
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    if operation == "sessions.snapshot" {
        let authority = authority(lead, call).await?;
        let scoped = Lead {
            permission_profile: Arc::new(std::sync::Mutex::new(authority.context.permissions)),
            ..lead.clone()
        };
        return core
            .agents
            .history_evidence(&scoped, &caller, request.arguments, cancelled)
            .await;
    }
    if codex_omd::scoped_data::operation(&operation) {
        let authority = authority(lead, call).await?;
        return lead
            .session
            .data
            .call(lead, authority, &caller, request, cancelled.clone())
            .await;
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
            authority.request_rename(
                request.arguments,
                &mut runtime,
                &processes,
                generation,
                active,
            )
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
    if operation.starts_with("agents.")
        || matches!(
            operation.as_str(),
            "workspace.integrate" | "workspace.snapshot"
        )
    {
        let scoped = match (operation.as_str(), call) {
            ("agents.spawn" | "workspace.snapshot", Some(call)) => {
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
        if operation == "workspace.snapshot" {
            return core
                .agents
                .snapshot(lead, &caller, request.arguments, cancelled)
                .await;
        }
        let repository = host.repository.clone();
        let before = if operation == "workspace.integrate" && caller.record_changes {
            tokio::task::spawn_blocking(move || codex_omd::change_baseline(&repository))
                .await
                .map_err(|e| e.to_string())?
        } else {
            None
        };
        let result = core.agents.call(core, lead, &caller, request).await;
        if let (Some(before), Ok(_)) = (before, &result) {
            let repository = host.repository.clone();
            let _ = tokio::task::spawn_blocking(move || {
                codex_omd::record_workspace_change(&repository, "transaction", before)
            })
            .await;
        }
        return result;
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
        "task.status" => Ok(
            json!({"ledger": lead.ledger(), "limits": host.config.limits,
            "worker_limits": host.config.worker_limits}),
        ),
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
        _ => Err(format!("unsupported_host_operation: {operation}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_exec_write_reserves_the_workspace_across_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let repository = temp.path().to_str().unwrap();
        let write = json!({"program":"sh","write":true});
        let first = AtomicBool::new(false);
        let second = AtomicBool::new(false);
        assert!(
            workspace_guard("exec.run", &json!({"program":"sh"}), &first, repository)
                .unwrap()
                .is_none()
        );
        assert!(
            workspace_guard(
                "exec.run",
                &json!({"program":"sh","write":true,"snapshot":{"sha256":"x"}}),
                &first,
                repository
            )
            .unwrap()
            .is_none()
        );
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let write = &write;
            let first = &first;
            scope.spawn(move || {
                let _guard = workspace_guard("exec.run", write, first, repository)
                    .unwrap()
                    .unwrap();
                held_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            });
            held_rx.recv().unwrap();
            assert!(
                workspace_guard("workspace.restore", &json!({}), &second, repository)
                    .err()
                    .unwrap()
                    .contains("workspace_operation_active")
            );
            release_tx.send(()).unwrap();
        });
        let _guard = workspace_guard("exec.run", &write, &second, repository)
            .unwrap()
            .unwrap();
    }
}
