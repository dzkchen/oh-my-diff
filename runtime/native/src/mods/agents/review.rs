use super::*;
use codex_omd::resource_data::ResourceRef;
use codex_omd::{ReviewCadence, ReviewFindingInput, ReviewSeverity, ReviewSubmission};

pub(super) struct Binding {
    source: ResourceRef,
    candidate: VersionMarker,
    snapshot: codex_omd::Snapshot,
    cadence: ReviewCadence,
    stable: bool,
    risk: Option<String>,
    submitted: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    route: String,
    prompt: String,
    evidence: ResourceRef,
    cadence: ReviewCadence,
    stable: bool,
    risk: Option<String>,
    tools: Vec<String>,
}

async fn snapshot(lead: &Lead) -> Result<codex_omd::Snapshot, String> {
    let authority = crate::workspace_operations::WorkspaceAuthority::for_lead(lead).await?;
    let approved = lead
        .host
        .manifest
        .approved_untracked
        .iter()
        .cloned()
        .collect();
    let paths =
        codex_omd::tracked_paths(&authority.repository, &approved).map_err(|e| e.to_string())?;
    if paths
        .iter()
        .any(|path| !authority.readable(&authority.repository.join(path)))
    {
        return Err("review_source_permission_denied".into());
    }
    codex_omd::Snapshot::capture(
        &authority.repository,
        &paths,
        lead.host.manifest.snapshot_bytes,
    )
    .map_err(|e| e.to_string())
}

pub(super) async fn prepare(
    lead: &Lead,
    owner: &str,
    generation: u64,
    source_sha256: &str,
    arguments: Value,
) -> Result<(Value, Binding), String> {
    let request: Request = serde_json::from_value(arguments).map_err(|e| e.to_string())?;
    let host = &lead.host;
    if !host.manifest.capabilities.unified_review || request.cadence == ReviewCadence::Final {
        return Err("extension_review_requires_enabled_nonfinal_policy".into());
    }
    host.authorize_contract(codex_omd::ContractOperation::MilestoneReview)?;
    host.authorize()?;
    host.review
        .lock()
        .map_err(|_| "review_runtime_poisoned")?
        .ledger
        .snapshot()
        .policy
        .validate_request(request.cadence, request.stable, request.risk.as_deref())
        .map_err(|e| e.to_string())?;
    let root = host.manifest.mods.clone().ok_or("mod_store_unavailable")?;
    let data = codex_omd::scoped_data::ScopedDataHost::new(
        root,
        host.manifest.repository.clone(),
        None,
        owner.into(),
        lead.thread.to_string(),
        generation,
        source_sha256.to_owned(),
    )
    .map_err(|e| e.to_string())?;
    let packet = data
        .resources()
        .load(&request.evidence, "turn")
        .map_err(|e| e.to_string())?;
    let snapshot = snapshot(lead).await?;
    let sha = snapshot.hash().map_err(|e| e.to_string())?;
    if packet["workspace_sha256"] != sha || packet["thread_id"] != lead.thread.to_string() {
        return Err("review_evidence_stale_or_foreign".into());
    }
    let candidate = VersionMarker {
        label: "extension-review-candidate".into(),
        sha256: sha,
        evidence: format!("resource:{}", request.evidence.reference),
        evidence_sha256: request.evidence.sha256.clone(),
    };
    let binding = Binding {
        source: request.evidence,
        candidate,
        snapshot,
        cadence: request.cadence,
        stable: request.stable,
        risk: request.risk,
        submitted: false,
    };
    Ok((
        json!({"role":"independent review","route":request.route,"prompt":request.prompt,"workspace":"read_only","tools":request.tools}),
        binding,
    ))
}

pub(super) async fn submit(
    records: &tokio::sync::Mutex<BTreeMap<String, Agent>>,
    lead: &Lead,
    owner: &str,
    generation: u64,
    arguments: Value,
) -> Result<Value, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        handle: String,
        result_sha256: String,
        findings: Vec<ReviewFindingInput>,
    }
    let mut input: Input = serde_json::from_value(arguments).map_err(|e| e.to_string())?;
    lead.host.authorize()?;
    lead.host
        .authorize_contract(codex_omd::ContractOperation::MilestoneReview)?;
    let current = snapshot(lead).await?.hash().map_err(|e| e.to_string())?;
    let mut records = records.lock().await;
    let agent = records
        .get_mut(&input.handle)
        .filter(|agent| agent.mod_id == owner && agent.generation == generation)
        .ok_or("unknown_or_foreign_review")?;
    let binding = agent.review.as_mut().ok_or("worker_is_not_review")?;
    if binding.submitted || binding.candidate.sha256 != current {
        return Err("review_already_submitted_or_stale".into());
    }
    let result = agent
        .result
        .lock()
        .map_err(|_| "agent_result_poisoned")?
        .clone()
        .ok_or("review_not_completed")??;
    if execution::hash(result.as_bytes()) != input.result_sha256 {
        return Err("review_result_hash_mismatch".into());
    }
    for finding in &mut input.findings {
        if finding.fingerprint.len() != 64
            || !finding
                .fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("review_fingerprint_invalid".into());
        }
        finding.fingerprint =
            execution::hash(format!("{owner}:{}", finding.fingerprint).as_bytes());
    }
    let mut review = lead
        .host
        .review
        .lock()
        .map_err(|_| "review_runtime_poisoned")?;
    if !review.ledger.snapshot().policy.extension_blocking
        && input
            .findings
            .iter()
            .any(|finding| finding.severity == ReviewSeverity::Blocking)
    {
        return Err("extension_blocking_not_user_authorized".into());
    }
    let provenance=lead.host.evidence(&format!("extension-review-{}.json",execution::hash(input.handle.as_bytes())),&json!({"extension":owner,"generation":generation,"worker":input.handle,"model":agent.implementation.model,"provider":agent.implementation.provider,"evidence":binding.source,"response_sha256":input.result_sha256,"response":result,"findings":input.findings}))?;
    let cycle = review
        .ledger
        .submit_with_severity_enforcement(
            ReviewSubmission {
                cadence: binding.cadence,
                candidate: binding.candidate.clone(),
                stable: binding.stable,
                risk: binding.risk.clone(),
                reviewer: format!("native-thread:{}", agent.worker),
                separate_reviewer: true,
                checks: vec![],
                findings: input.findings,
                resolved_finding_ids: vec![],
            },
            true,
        )
        .map_err(|e| e.to_string())?;
    review.candidates.insert(current, binding.snapshot.clone());
    drop(review);
    binding.submitted = true;
    if !agent.consumed {
        lead.host
            .task
            .consume_worker_result(&input.handle)
            .map_err(|e| e.to_string())?;
        agent.consumed = true;
    }
    lead.host.persist_review()?;
    Ok(json!({"cycle":cycle,"evidence":provenance}))
}
