use super::*;
use codex_omd::resource_data::ResourceRef;
use codex_omd::{ReviewCadence, ReviewFindingInput, ReviewLane, ReviewSeverity, ReviewSubmission};

pub(super) struct Binding {
    source: ResourceRef,
    candidate_sha256: String,
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

pub(super) fn prepare(
    lead: &Lead,
    owner: &str,
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
    let packet = codex_omd::scoped_data::ScopedDataHost::new(
        root,
        host.manifest.repository.clone(),
        None,
        None,
        owner.into(),
        lead.thread.to_string(),
        source_sha256.to_owned(),
    )
    .and_then(|data| data.resources().load(&request.evidence, "turn"))
    .map_err(|e| e.to_string())?;
    let candidate_sha256 = packet["workspace_sha256"]
        .as_str()
        .filter(|sha| sha.len() == 64 && packet["thread_id"] == lead.thread.to_string())
        .ok_or("review_evidence_stale_or_foreign")?
        .to_owned();
    let binding = Binding {
        source: request.evidence,
        candidate_sha256,
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
    let snapshot = crate::workspace_operations::workspace_snapshot(lead).await?;
    let current = snapshot.hash().map_err(|e| e.to_string())?;
    let mut records = records.lock().await;
    let agent = records
        .get_mut(&input.handle)
        .filter(|agent| agent.mod_id == owner && agent.generation == generation)
        .ok_or("unknown_or_foreign_review")?;
    let binding = agent.review.as_mut().ok_or("worker_is_not_review")?;
    if binding.submitted || binding.candidate_sha256 != current {
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
    let blocking = input
        .findings
        .iter()
        .any(|finding| finding.severity == ReviewSeverity::Blocking);
    if blocking && !review.ledger.snapshot().policy.extension_blocking {
        return Err("extension_blocking_not_user_authorized".into());
    }
    let handle_hash = execution::hash(input.handle.as_bytes());
    let provenance=lead.host.evidence(&format!("extension-review-{handle_hash}.json"),&json!({"extension":owner,"generation":generation,"worker":input.handle,"model":agent.implementation.model,"provider":agent.implementation.provider,"evidence":binding.source,"response_sha256":input.result_sha256,"response":result,"findings":input.findings}))?;
    let candidate = if blocking {
        let reference = lead.host.evidence(
            &format!("review-candidate-{handle_hash}.json"),
            &serde_json::to_value(&snapshot).map_err(|e| e.to_string())?,
        )?;
        execution::evidence_marker("extension-review-candidate", &current, &reference)?
    } else {
        VersionMarker {
            label: "extension-review-candidate".into(),
            sha256: current.clone(),
            evidence: format!("resource:{}", binding.source.reference),
            evidence_sha256: binding.source.sha256.clone(),
        }
    };
    let cycle = review
        .ledger
        .submit_advisory(ReviewSubmission {
            cadence: binding.cadence,
            candidate,
            stable: binding.stable,
            risk: binding.risk.clone(),
            reviewer: format!("native-thread:{}", agent.worker),
            separate_reviewer: true,
            checks: vec![],
            findings: input.findings,
            resolved_finding_ids: vec![],
        })
        .map_err(|e| e.to_string())?;
    if cycle.lane == ReviewLane::Enforced {
        review.candidates.insert(current, snapshot);
    }
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
