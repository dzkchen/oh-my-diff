use crate::AcceptanceEvidence;
use crate::AssuranceLabel;
use crate::CompletionMode;
use crate::ReviewCadence;
use crate::ReviewCycle;
use crate::TaskContract;
use crate::VersionMarker;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::io;

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CompletionPolicy {
    pub max_attempts: u32,
    pub max_paths_per_challenge: usize,
    pub max_requirements: usize,
    pub max_requirement_bytes: usize,
}

impl Default for CompletionPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 8,
            max_paths_per_challenge: 128,
            max_requirements: 12,
            max_requirement_bytes: 512,
        }
    }
}

impl CompletionPolicy {
    pub fn validate(&self) -> io::Result<()> {
        if self.max_attempts == 0
            || self.max_attempts > 32
            || self.max_paths_per_challenge == 0
            || self.max_paths_per_challenge > 256
            || self.max_requirements == 0
            || self.max_requirements > 16
            || self.max_requirement_bytes == 0
            || self.max_requirement_bytes > 512
        {
            return Err(invalid("completion policy is invalid or unbounded"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "snake_case")]
pub enum CompletionStatus {
    Completed,
    Continue,
    Blocked,
    Unverified,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "snake_case")]
pub enum RequirementVerdict {
    Satisfied,
    Unsatisfied,
    Blocked,
    Unverified,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "snake_case")]
pub enum ChallengeKind {
    MissingWiring,
    TestWeakening,
    NegativeCases,
}

impl ChallengeKind {
    fn all() -> [Self; 3] {
        [
            Self::MissingWiring,
            Self::TestWeakening,
            Self::NegativeCases,
        ]
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "snake_case")]
pub enum ChallengeVerdict {
    Passed,
    Finding,
    Blocked,
    Unverified,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RequirementAssessment {
    pub criterion: String,
    pub verdict: RequirementVerdict,
    pub summary: String,
    pub evidence_sha256s: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChallengeAssessment {
    pub kind: ChallengeKind,
    pub verdict: ChallengeVerdict,
    pub summary: String,
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CompletionSubmission {
    pub candidate: VersionMarker,
    pub contract_sha256: String,
    pub verifier: String,
    pub separate_verifier: bool,
    pub final_review: ReviewCycle,
    pub requirement_evidence: Vec<AcceptanceEvidence>,
    pub requirements: Vec<RequirementAssessment>,
    pub challenges: Vec<ChallengeAssessment>,
    pub allowance_remaining: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct RequirementReceipt {
    pub criterion: String,
    pub verdict: RequirementVerdict,
    pub summary: String,
    pub evidence: Vec<VersionMarker>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct CompletionReceipt {
    pub schema: u32,
    pub attempt: u32,
    #[serde(default = "independently_verified")]
    pub assurance: AssuranceLabel,
    #[serde(default = "yes")]
    pub independent_review: bool,
    pub contract_sha256: String,
    pub initial_candidate_sha256: String,
    pub candidate: VersionMarker,
    pub verifier: Option<String>,
    pub separate_verifier: bool,
    pub final_review_cycle: Option<u32>,
    pub status: CompletionStatus,
    pub requirements: Vec<RequirementReceipt>,
    pub challenges: Vec<ChallengeAssessment>,
    pub allowance_remaining: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct CompletionSnapshot {
    pub schema: u32,
    #[serde(default = "independently_verified")]
    pub assurance: AssuranceLabel,
    pub policy: CompletionPolicy,
    pub contract: TaskContract,
    pub contract_sha256: String,
    pub initial_candidate_sha256: String,
    pub receipts: Vec<CompletionReceipt>,
    pub approved_candidate_sha256: Option<String>,
}

pub struct CompletionGate {
    snapshot: CompletionSnapshot,
}

impl CompletionGate {
    pub fn new(
        policy: CompletionPolicy,
        contract: TaskContract,
        initial_candidate_sha256: String,
    ) -> io::Result<Self> {
        Self::new_for(
            policy,
            contract,
            initial_candidate_sha256,
            CompletionMode::AdversarialSeparate,
        )
    }

    pub fn new_for(
        policy: CompletionPolicy,
        contract: TaskContract,
        initial_candidate_sha256: String,
        mode: CompletionMode,
    ) -> io::Result<Self> {
        policy.validate()?;
        contract.validate()?;
        validate_short_contract(&policy, &contract)?;
        validate_sha256(&initial_candidate_sha256)?;
        let contract_sha256 = acceptance_contract_sha256(&contract)?;
        Ok(Self {
            snapshot: CompletionSnapshot {
                schema: 1,
                assurance: assurance_for(mode)?,
                policy,
                contract,
                contract_sha256,
                initial_candidate_sha256,
                receipts: Vec::new(),
                approved_candidate_sha256: None,
            },
        })
    }

    pub fn restore(snapshot: CompletionSnapshot) -> io::Result<Self> {
        snapshot.policy.validate()?;
        snapshot.contract.validate()?;
        validate_short_contract(&snapshot.policy, &snapshot.contract)?;
        validate_sha256(&snapshot.initial_candidate_sha256)?;
        if snapshot.schema != 1
            || !matches!(
                snapshot.assurance,
                AssuranceLabel::IndependentlyVerified | AssuranceLabel::SelfReviewed
            )
            || snapshot.contract_sha256 != acceptance_contract_sha256(&snapshot.contract)?
            || snapshot.receipts.len() > snapshot.policy.max_attempts as usize
            || snapshot
                .receipts
                .iter()
                .enumerate()
                .any(|(index, receipt)| {
                    receipt.attempt != index as u32 + 1
                        || validate_receipt(&snapshot, receipt).is_err()
                })
            || snapshot.approved_candidate_sha256
                != snapshot.receipts.last().and_then(|receipt| {
                    (receipt.status == CompletionStatus::Completed)
                        .then(|| receipt.candidate.sha256.clone())
                })
        {
            return Err(invalid(
                "persisted completion state is invalid or contract-weakened",
            ));
        }
        Ok(Self { snapshot })
    }

    pub fn snapshot(&self) -> CompletionSnapshot {
        self.snapshot.clone()
    }

    pub fn submit(&mut self, submission: CompletionSubmission) -> io::Result<CompletionReceipt> {
        if self.snapshot.receipts.len() >= self.snapshot.policy.max_attempts as usize {
            return Err(invalid("completion attempt limit exhausted"));
        }
        validate_submission(&self.snapshot, &submission)?;
        let evidence = submission
            .requirement_evidence
            .into_iter()
            .map(|entry| (entry.criterion.clone(), entry))
            .collect::<BTreeMap<_, _>>();
        let assessments = submission
            .requirements
            .into_iter()
            .map(|entry| (entry.criterion.clone(), entry))
            .collect::<BTreeMap<_, _>>();
        let requirements = self
            .snapshot
            .contract
            .acceptance_criteria
            .iter()
            .map(|criterion| {
                let assessment = assessments
                    .get(criterion)
                    .expect("validated exact requirement assessment");
                RequirementReceipt {
                    criterion: criterion.clone(),
                    verdict: assessment.verdict,
                    summary: assessment.summary.clone(),
                    evidence: evidence
                        .get(criterion)
                        .expect("validated exact requirement evidence")
                        .evidence
                        .clone(),
                }
            })
            .collect::<Vec<_>>();
        let status = completion_status(
            &requirements,
            &submission.challenges,
            submission.allowance_remaining,
        );
        let receipt = CompletionReceipt {
            schema: 1,
            attempt: self.snapshot.receipts.len() as u32 + 1,
            assurance: self.snapshot.assurance,
            independent_review: submission.separate_verifier,
            contract_sha256: self.snapshot.contract_sha256.clone(),
            initial_candidate_sha256: self.snapshot.initial_candidate_sha256.clone(),
            candidate: submission.candidate,
            verifier: Some(submission.verifier),
            separate_verifier: submission.separate_verifier,
            final_review_cycle: Some(submission.final_review.id),
            status,
            requirements,
            challenges: ordered_challenges(submission.challenges),
            allowance_remaining: submission.allowance_remaining,
            reason: None,
        };
        let mut staged = self.snapshot.clone();
        validate_receipt(&staged, &receipt)?;
        staged.approved_candidate_sha256 =
            (status == CompletionStatus::Completed).then(|| receipt.candidate.sha256.clone());
        staged.receipts.push(receipt.clone());
        self.snapshot = staged;
        Ok(receipt)
    }

    pub fn record_unavailable(
        &mut self,
        candidate: VersionMarker,
        contract_sha256: &str,
        status: CompletionStatus,
        allowance_remaining: bool,
        reason: String,
    ) -> io::Result<CompletionReceipt> {
        if self.snapshot.receipts.len() >= self.snapshot.policy.max_attempts as usize {
            return Err(invalid("completion attempt limit exhausted"));
        }
        candidate.validate()?;
        if contract_sha256 != self.snapshot.contract_sha256
            || !matches!(
                status,
                CompletionStatus::Blocked | CompletionStatus::Unverified
            )
            || (status == CompletionStatus::Blocked && allowance_remaining)
            || reason.trim().is_empty()
            || reason.len() > 2048
        {
            return Err(invalid("invalid unavailable completion receipt"));
        }
        let requirements = self
            .snapshot
            .contract
            .acceptance_criteria
            .iter()
            .map(|criterion| RequirementReceipt {
                criterion: criterion.clone(),
                verdict: RequirementVerdict::Unverified,
                summary: reason.clone(),
                evidence: Vec::new(),
            })
            .collect();
        let challenges = ChallengeKind::all()
            .into_iter()
            .map(|kind| ChallengeAssessment {
                kind,
                verdict: ChallengeVerdict::Unverified,
                summary: reason.clone(),
                paths: Vec::new(),
            })
            .collect();
        let receipt = CompletionReceipt {
            schema: 1,
            attempt: self.snapshot.receipts.len() as u32 + 1,
            assurance: self.snapshot.assurance,
            independent_review: false,
            contract_sha256: self.snapshot.contract_sha256.clone(),
            initial_candidate_sha256: self.snapshot.initial_candidate_sha256.clone(),
            candidate,
            verifier: None,
            separate_verifier: false,
            final_review_cycle: None,
            status,
            requirements,
            challenges,
            allowance_remaining,
            reason: Some(reason),
        };
        let mut staged = self.snapshot.clone();
        validate_receipt(&staged, &receipt)?;
        staged.approved_candidate_sha256 = None;
        staged.receipts.push(receipt.clone());
        self.snapshot = staged;
        Ok(receipt)
    }
}

fn independently_verified() -> AssuranceLabel {
    AssuranceLabel::IndependentlyVerified
}

fn yes() -> bool {
    true
}

fn assurance_for(mode: CompletionMode) -> io::Result<AssuranceLabel> {
    match mode {
        CompletionMode::AdversarialSeparate => Ok(AssuranceLabel::IndependentlyVerified),
        CompletionMode::SelfVerified => Ok(AssuranceLabel::SelfReviewed),
        CompletionMode::None => Err(invalid(
            "a completion gate requires an adversarial or self-verified contract",
        )),
    }
}

pub fn acceptance_contract_sha256(contract: &TaskContract) -> io::Result<String> {
    contract.validate()?;
    let bytes = serde_json::to_vec(contract).map_err(io::Error::other)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn validate_submission(
    snapshot: &CompletionSnapshot,
    submission: &CompletionSubmission,
) -> io::Result<()> {
    submission.candidate.validate()?;
    let independent = snapshot.assurance.claims_independent_verification();
    if submission.contract_sha256 != snapshot.contract_sha256
        || submission.verifier.trim().is_empty()
        || submission.verifier.len() > 128
        || submission.separate_verifier != independent
        || submission.final_review.cadence != ReviewCadence::Final
        || !submission.final_review.final_approved
        || submission.final_review.separate_reviewer != independent
        || submission.final_review.candidate.sha256 != submission.candidate.sha256
        || submission.final_review.checks.is_empty()
        || submission.final_review.checks.iter().any(|marker| {
            marker.validate().is_err() || marker.sha256 != submission.candidate.sha256
        })
    {
        return Err(invalid(if independent {
            "completion requires the immutable contract and exact separately approved final review"
        } else {
            "self-verified completion requires the immutable contract and the lead's own exact approved final review"
        }));
    }
    let criteria = snapshot
        .contract
        .acceptance_criteria
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let evidence = submission
        .requirement_evidence
        .iter()
        .map(|entry| entry.criterion.clone())
        .collect::<BTreeSet<_>>();
    let assessed = submission
        .requirements
        .iter()
        .map(|entry| entry.criterion.clone())
        .collect::<BTreeSet<_>>();
    if evidence != criteria
        || assessed != criteria
        || evidence.len() != submission.requirement_evidence.len()
        || assessed.len() != submission.requirements.len()
    {
        return Err(invalid(
            "completion must preserve and assess every exact acceptance criterion",
        ));
    }
    for entry in &submission.requirement_evidence {
        if entry.evidence.is_empty()
            || entry.evidence.len() > 16
            || entry
                .evidence
                .iter()
                .any(|marker| marker.validate().is_err())
            || !entry
                .evidence
                .iter()
                .any(|marker| marker.sha256 == submission.candidate.sha256)
        {
            return Err(invalid(
                "acceptance evidence is missing or stale for the final candidate",
            ));
        }
    }
    let evidence_by_criterion = submission
        .requirement_evidence
        .iter()
        .map(|entry| {
            (
                entry.criterion.as_str(),
                entry
                    .evidence
                    .iter()
                    .map(|marker| marker.evidence_sha256.as_str())
                    .collect::<BTreeSet<_>>(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    for assessment in &submission.requirements {
        if assessment.summary.trim().is_empty()
            || assessment.summary.len() > 2048
            || assessment.evidence_sha256s.len() > 16
            || assessment
                .evidence_sha256s
                .iter()
                .collect::<BTreeSet<_>>()
                .len()
                != assessment.evidence_sha256s.len()
            || assessment
                .evidence_sha256s
                .iter()
                .any(|value| validate_sha256(value).is_err())
            || assessment.evidence_sha256s.iter().any(|value| {
                !evidence_by_criterion
                    .get(assessment.criterion.as_str())
                    .is_some_and(|known| known.contains(value.as_str()))
            })
            || (assessment.verdict == RequirementVerdict::Satisfied
                && assessment.evidence_sha256s.is_empty())
        {
            return Err(invalid("requirement assessment evidence is invalid"));
        }
    }
    let kinds = submission
        .challenges
        .iter()
        .map(|challenge| challenge.kind)
        .collect::<BTreeSet<_>>();
    if kinds != ChallengeKind::all().into_iter().collect()
        || submission.challenges.len() != kinds.len()
    {
        return Err(invalid(
            "all adversarial challenge categories are required exactly once",
        ));
    }
    for challenge in &submission.challenges {
        if challenge.summary.trim().is_empty()
            || challenge.summary.len() > 2048
            || challenge.paths.len() > snapshot.policy.max_paths_per_challenge
            || challenge.paths.iter().collect::<BTreeSet<_>>().len() != challenge.paths.len()
            || challenge.paths.iter().any(|path| !valid_relative(path))
            || (challenge.verdict == ChallengeVerdict::Passed && challenge.paths.is_empty())
        {
            return Err(invalid("adversarial challenge assessment is invalid"));
        }
    }
    Ok(())
}

fn completion_status(
    requirements: &[RequirementReceipt],
    challenges: &[ChallengeAssessment],
    allowance_remaining: bool,
) -> CompletionStatus {
    if requirements
        .iter()
        .any(|entry| entry.verdict == RequirementVerdict::Blocked)
        || challenges
            .iter()
            .any(|entry| entry.verdict == ChallengeVerdict::Blocked)
    {
        CompletionStatus::Blocked
    } else if requirements
        .iter()
        .any(|entry| entry.verdict == RequirementVerdict::Unverified)
        || challenges
            .iter()
            .any(|entry| entry.verdict == ChallengeVerdict::Unverified)
    {
        CompletionStatus::Unverified
    } else if requirements
        .iter()
        .any(|entry| entry.verdict == RequirementVerdict::Unsatisfied)
        || challenges
            .iter()
            .any(|entry| entry.verdict == ChallengeVerdict::Finding)
    {
        if allowance_remaining {
            CompletionStatus::Continue
        } else {
            CompletionStatus::Blocked
        }
    } else {
        CompletionStatus::Completed
    }
}

fn ordered_challenges(challenges: Vec<ChallengeAssessment>) -> Vec<ChallengeAssessment> {
    let by_kind = challenges
        .into_iter()
        .map(|challenge| (challenge.kind, challenge))
        .collect::<BTreeMap<_, _>>();
    ChallengeKind::all()
        .into_iter()
        .map(|kind| by_kind[&kind].clone())
        .collect()
}

fn validate_receipt(snapshot: &CompletionSnapshot, receipt: &CompletionReceipt) -> io::Result<()> {
    receipt.candidate.validate()?;
    let criteria = &snapshot.contract.acceptance_criteria;
    let independent = snapshot.assurance.claims_independent_verification();
    if receipt.assurance != snapshot.assurance
        || receipt.independent_review != (receipt.separate_verifier && independent)
        || (!independent && receipt.assurance.independent())
    {
        return Err(invalid(
            "completion receipt may not claim assurance the selected contract did not provide",
        ));
    }
    if receipt.schema != 1
        || receipt.contract_sha256 != snapshot.contract_sha256
        || receipt.initial_candidate_sha256 != snapshot.initial_candidate_sha256
        || receipt.requirements.len() != criteria.len()
        || receipt
            .requirements
            .iter()
            .zip(criteria)
            .any(|(entry, criterion)| {
                entry.criterion != *criterion
                    || entry.summary.trim().is_empty()
                    || entry.summary.len() > 2048
                    || entry.evidence.len() > 16
                    || entry
                        .evidence
                        .iter()
                        .any(|marker| marker.validate().is_err())
            })
        || receipt.challenges.len() != 3
        || receipt
            .challenges
            .iter()
            .map(|challenge| challenge.kind)
            .collect::<Vec<_>>()
            != ChallengeKind::all()
        || receipt.challenges.iter().any(|challenge| {
            challenge.summary.trim().is_empty()
                || challenge.summary.len() > 2048
                || challenge.paths.len() > snapshot.policy.max_paths_per_challenge
                || challenge.paths.iter().collect::<BTreeSet<_>>().len() != challenge.paths.len()
                || challenge.paths.iter().any(|path| !valid_relative(path))
                || (challenge.verdict == ChallengeVerdict::Passed && challenge.paths.is_empty())
        })
        || receipt
            .verifier
            .as_ref()
            .is_some_and(|verifier| verifier.trim().is_empty() || verifier.len() > 128)
        || receipt
            .reason
            .as_ref()
            .is_some_and(|reason| reason.trim().is_empty() || reason.len() > 2048)
    {
        return Err(invalid("completion receipt is invalid or incomplete"));
    }
    match receipt.status {
        CompletionStatus::Completed => {
            if receipt
                .verifier
                .as_ref()
                .is_none_or(|value| value.trim().is_empty())
                || receipt.separate_verifier != independent
                || receipt.final_review_cycle.is_none()
                || receipt.reason.is_some()
                || receipt.requirements.iter().any(|entry| {
                    entry.verdict != RequirementVerdict::Satisfied
                        || entry.evidence.is_empty()
                        || !entry
                            .evidence
                            .iter()
                            .any(|marker| marker.sha256 == receipt.candidate.sha256)
                })
                || receipt.challenges.iter().any(|entry| {
                    entry.verdict != ChallengeVerdict::Passed || entry.paths.is_empty()
                })
            {
                return Err(invalid("completed receipt lacks exact positive evidence"));
            }
        }
        CompletionStatus::Continue => {}
        CompletionStatus::Blocked | CompletionStatus::Unverified => {}
    }
    if receipt.reason.is_none() {
        if receipt
            .verifier
            .as_ref()
            .is_none_or(|value| value.trim().is_empty())
            || receipt.separate_verifier != independent
            || receipt.final_review_cycle.is_none()
            || receipt.status
                != completion_status(
                    &receipt.requirements,
                    &receipt.challenges,
                    receipt.allowance_remaining,
                )
        {
            return Err(invalid("completion receipt verdict is inconsistent"));
        }
    } else if receipt.verifier.is_some()
        || receipt.separate_verifier
        || receipt.final_review_cycle.is_some()
        || !matches!(
            receipt.status,
            CompletionStatus::Blocked | CompletionStatus::Unverified
        )
        || (receipt.status == CompletionStatus::Blocked && receipt.allowance_remaining)
        || receipt.requirements.iter().any(|entry| {
            entry.verdict != RequirementVerdict::Unverified || !entry.evidence.is_empty()
        })
        || receipt
            .challenges
            .iter()
            .any(|entry| entry.verdict != ChallengeVerdict::Unverified || !entry.paths.is_empty())
    {
        return Err(invalid("unavailable completion receipt is inconsistent"));
    }
    Ok(())
}

fn validate_short_contract(policy: &CompletionPolicy, contract: &TaskContract) -> io::Result<()> {
    if contract.acceptance_criteria.len() > policy.max_requirements
        || contract
            .acceptance_criteria
            .iter()
            .any(|criterion| criterion.len() > policy.max_requirement_bytes)
    {
        return Err(invalid("acceptance contract is not short and bounded"));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> io::Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid("exact lowercase SHA256 is required"));
    }
    Ok(())
}

fn valid_relative(path: &str) -> bool {
    if path == "." {
        return true;
    }
    let path = std::path::Path::new(path);
    !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
#[path = "completion_tests.rs"]
mod tests;
