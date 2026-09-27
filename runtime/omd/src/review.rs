use crate::FinalReview;
use crate::VersionMarker;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::io;

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReviewPolicy {
    #[serde(default)]
    pub every_turn_advice: bool,
    #[serde(default)]
    pub extension_blocking: bool,
    #[serde(default)]
    pub final_review: FinalReview,
    #[serde(default = "enabled")]
    pub milestone_review: bool,
    pub max_cycles: u32,
    pub max_findings_per_cycle: usize,
    pub max_open_findings: usize,
    pub max_repairs: u32,
    pub repair_scope: Vec<String>,
}

impl Default for ReviewPolicy {
    fn default() -> Self {
        Self {
            every_turn_advice: false,
            extension_blocking: false,
            final_review: FinalReview::Separate,
            milestone_review: true,
            max_cycles: 16,
            max_findings_per_cycle: 64,
            max_open_findings: 128,
            max_repairs: 4,
            repair_scope: vec![".".into()],
        }
    }
}

impl ReviewPolicy {
    pub fn validate(&self) -> io::Result<()> {
        if self.max_cycles == 0
            || self.max_cycles > 256
            || self.max_findings_per_cycle == 0
            || self.max_findings_per_cycle > 256
            || self.max_open_findings == 0
            || self.max_open_findings > 1024
            || self.max_repairs > 32
            || self.repair_scope.is_empty()
            || self.repair_scope.len() > 128
            || !unique(&self.repair_scope)
            || self.repair_scope.iter().any(|path| !valid_relative(path))
        {
            return Err(invalid("review policy is invalid or unbounded"));
        }
        Ok(())
    }

    pub fn validate_request(
        &self,
        cadence: ReviewCadence,
        stable: bool,
        risk: Option<&str>,
    ) -> io::Result<()> {
        if !self.milestone_review && cadence != ReviewCadence::Final {
            return Err(invalid(
                "the selected workflow contract has no milestone review",
            ));
        }
        match cadence {
            ReviewCadence::StableMilestone if !stable => {
                return Err(invalid("milestone review requires a stable candidate"));
            }
            ReviewCadence::RiskTriggered
                if risk.is_none_or(|risk| risk.trim().is_empty() || risk.len() > 2048) =>
            {
                return Err(invalid("risk-triggered review requires a bounded risk"));
            }
            ReviewCadence::EveryTurn if !self.every_turn_advice => {
                return Err(invalid("every-turn advice is disabled"));
            }
            ReviewCadence::Final if !stable => {
                return Err(invalid("final review requires a stable candidate"));
            }
            _ => {}
        }
        if cadence != ReviewCadence::RiskTriggered && risk.is_some() {
            return Err(invalid("risk is valid only for risk-triggered review"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewCadence {
    StableMilestone,
    RiskTriggered,
    EveryTurn,
    Final,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewSeverity {
    Advice,
    Warning,
    Blocking,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReviewFindingInput {
    pub fingerprint: String,
    pub severity: ReviewSeverity,
    pub summary: String,
    pub paths: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FindingStatus {
    Open,
    Resolved,
    Stale,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct ReviewFinding {
    pub id: u32,
    pub fingerprint: String,
    pub severity: ReviewSeverity,
    pub summary: String,
    pub paths: Vec<String>,
    pub status: FindingStatus,
    #[serde(default = "enabled")]
    pub enforced: bool,
    pub introduced_candidate_sha256: String,
    pub last_seen_candidate_sha256: String,
    pub duplicate_observations: u32,
    pub resolved_candidate_sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReviewSubmission {
    pub cadence: ReviewCadence,
    pub candidate: VersionMarker,
    pub stable: bool,
    pub risk: Option<String>,
    pub reviewer: String,
    pub separate_reviewer: bool,
    pub checks: Vec<VersionMarker>,
    pub findings: Vec<ReviewFindingInput>,
    pub resolved_finding_ids: Vec<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct ReviewCycle {
    pub id: u32,
    pub cadence: ReviewCadence,
    pub candidate: VersionMarker,
    pub stable: bool,
    pub risk: Option<String>,
    pub reviewer: String,
    pub separate_reviewer: bool,
    pub checks: Vec<VersionMarker>,
    pub observed_finding_ids: Vec<u32>,
    pub resolved_finding_ids: Vec<u32>,
    pub duplicate_findings: u32,
    pub final_approved: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct RepairRecord {
    pub id: u32,
    pub from_candidate_sha256: String,
    pub to_candidate_sha256: String,
    pub paths: Vec<String>,
    pub finding_ids: Vec<u32>,
    pub evidence: VersionMarker,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct ReviewSnapshot {
    pub schema: u32,
    pub policy: ReviewPolicy,
    pub cycles: Vec<ReviewCycle>,
    pub findings: Vec<ReviewFinding>,
    pub repairs: Vec<RepairRecord>,
    pub final_candidate_sha256: Option<String>,
}

pub struct UnifiedReview {
    snapshot: ReviewSnapshot,
}

impl UnifiedReview {
    pub fn new(policy: ReviewPolicy) -> io::Result<Self> {
        policy.validate()?;
        Ok(Self {
            snapshot: ReviewSnapshot {
                schema: 1,
                policy,
                cycles: Vec::new(),
                findings: Vec::new(),
                repairs: Vec::new(),
                final_candidate_sha256: None,
            },
        })
    }

    pub fn snapshot(&self) -> ReviewSnapshot {
        self.snapshot.clone()
    }

    pub fn restore(snapshot: ReviewSnapshot) -> io::Result<Self> {
        snapshot.policy.validate()?;
        if snapshot.schema != 1
            || snapshot.cycles.len() > snapshot.policy.max_cycles as usize
            || snapshot.findings.len()
                > snapshot
                    .policy
                    .max_cycles
                    .saturating_mul(snapshot.policy.max_findings_per_cycle as u32)
                    as usize
            || snapshot.repairs.len() > snapshot.policy.max_repairs as usize
            || snapshot.cycles.iter().enumerate().any(|(index, cycle)| {
                cycle.id != index as u32 + 1 || validate_marker(&cycle.candidate).is_err()
            })
            || snapshot
                .findings
                .iter()
                .enumerate()
                .any(|(index, finding)| {
                    finding.id != index as u32 + 1
                        || validate_sha256(&finding.fingerprint).is_err()
                        || validate_sha256(&finding.introduced_candidate_sha256).is_err()
                        || validate_sha256(&finding.last_seen_candidate_sha256).is_err()
                })
            || snapshot.repairs.iter().enumerate().any(|(index, repair)| {
                repair.id != index as u32 + 1
                    || validate_sha256(&repair.from_candidate_sha256).is_err()
                    || validate_sha256(&repair.to_candidate_sha256).is_err()
                    || validate_marker(&repair.evidence).is_err()
            })
            || snapshot
                .final_candidate_sha256
                .as_ref()
                .is_some_and(|candidate| {
                    validate_sha256(candidate).is_err()
                        || !snapshot.cycles.iter().any(|cycle| {
                            cycle.final_approved && cycle.candidate.sha256 == *candidate
                        })
                })
        {
            return Err(invalid("persisted review state is invalid or unbounded"));
        }
        Ok(Self { snapshot })
    }

    pub fn unresolved(&self) -> Vec<ReviewFinding> {
        self.snapshot
            .findings
            .iter()
            .filter(|finding| finding.status != FindingStatus::Resolved)
            .cloned()
            .collect()
    }

    pub fn blocking(&self) -> Vec<ReviewFinding> {
        self.unresolved()
            .into_iter()
            .filter(|finding| finding.enforced)
            .collect()
    }

    pub fn recorded_repair(
        &self,
        from_candidate_sha256: &str,
        to_candidate_sha256: &str,
    ) -> Option<&RepairRecord> {
        self.snapshot.repairs.iter().find(|repair| {
            repair.from_candidate_sha256 == from_candidate_sha256
                && repair.to_candidate_sha256 == to_candidate_sha256
        })
    }

    pub fn record_repair(
        &mut self,
        from_candidate_sha256: &str,
        to_candidate_sha256: &str,
        paths: Vec<String>,
        finding_ids: Vec<u32>,
        evidence: VersionMarker,
    ) -> io::Result<RepairRecord> {
        if self.snapshot.repairs.len() >= self.snapshot.policy.max_repairs as usize {
            return Err(invalid("review repair limit exhausted"));
        }
        validate_sha256(from_candidate_sha256)?;
        validate_sha256(to_candidate_sha256)?;
        validate_marker(&evidence)?;
        if from_candidate_sha256 == to_candidate_sha256
            || evidence.sha256 != to_candidate_sha256
            || paths.is_empty()
            || paths.len() > 256
            || finding_ids.is_empty()
            || finding_ids.len() > self.snapshot.policy.max_open_findings
            || self
                .recorded_repair(from_candidate_sha256, to_candidate_sha256)
                .is_some()
            || !unique(&paths)
            || !unique(&finding_ids)
            || paths.iter().any(|path| {
                !valid_relative(path)
                    || !self
                        .snapshot
                        .policy
                        .repair_scope
                        .iter()
                        .any(|scope| in_scope(path, scope))
            })
            || finding_ids.iter().any(|id| {
                !self
                    .snapshot
                    .findings
                    .iter()
                    .any(|finding| finding.id == *id && finding.status != FindingStatus::Resolved)
            })
        {
            return Err(invalid(
                "repair is stale, duplicate, or outside authorized scope",
            ));
        }
        let record = RepairRecord {
            id: self.snapshot.repairs.len() as u32 + 1,
            from_candidate_sha256: from_candidate_sha256.into(),
            to_candidate_sha256: to_candidate_sha256.into(),
            paths,
            finding_ids,
            evidence,
        };
        self.snapshot.final_candidate_sha256 = None;
        self.snapshot.repairs.push(record.clone());
        Ok(record)
    }

    pub fn submit(&mut self, submission: ReviewSubmission) -> io::Result<ReviewCycle> {
        self.submit_with_severity_enforcement(submission, false)
    }

    pub fn submit_with_severity_enforcement(
        &mut self,
        submission: ReviewSubmission,
        blocking_only: bool,
    ) -> io::Result<ReviewCycle> {
        let mut staged = Self {
            snapshot: self.snapshot.clone(),
        };
        let cycle = staged.submit_in_place(submission, blocking_only)?;
        self.snapshot = staged.snapshot;
        Ok(cycle)
    }

    fn submit_in_place(
        &mut self,
        submission: ReviewSubmission,
        blocking_only: bool,
    ) -> io::Result<ReviewCycle> {
        if self.snapshot.cycles.len() >= self.snapshot.policy.max_cycles as usize {
            return Err(invalid("review cycle limit exhausted"));
        }
        validate_submission(&self.snapshot.policy, &submission)?;
        let prior_candidate = self
            .snapshot
            .cycles
            .last()
            .map(|cycle| cycle.candidate.sha256.as_str());
        let changed_candidate = prior_candidate
            .is_some_and(|candidate| candidate != submission.candidate.sha256.as_str());
        let resolved: BTreeSet<_> = submission.resolved_finding_ids.iter().copied().collect();
        if submission.resolved_finding_ids.len() != resolved.len()
            || resolved.iter().any(|id| {
                !self
                    .snapshot
                    .findings
                    .iter()
                    .any(|finding| finding.id == *id && finding.status != FindingStatus::Resolved)
            })
        {
            return Err(invalid(
                "resolved finding is unknown, duplicate, or already resolved",
            ));
        }
        if !resolved.is_empty() && !changed_candidate {
            return Err(invalid("finding resolution requires a changed candidate"));
        }
        let mut deduplicated = BTreeMap::new();
        let mut duplicate_findings = 0;
        for finding in submission.findings {
            validate_finding(&finding)?;
            if deduplicated
                .insert(finding.fingerprint.clone(), finding)
                .is_some()
            {
                duplicate_findings += 1;
            }
        }
        let observed_fingerprints: BTreeSet<_> = deduplicated.keys().cloned().collect();
        for finding in &mut self.snapshot.findings {
            if finding.status == FindingStatus::Resolved {
                continue;
            }
            if resolved.contains(&finding.id) {
                finding.status = FindingStatus::Resolved;
                finding.resolved_candidate_sha256 = Some(submission.candidate.sha256.clone());
            } else if changed_candidate && !observed_fingerprints.contains(&finding.fingerprint) {
                finding.status = FindingStatus::Stale;
            }
        }
        let mut observed_finding_ids = Vec::new();
        for (fingerprint, input) in deduplicated {
            if let Some(existing) = self.snapshot.findings.iter_mut().find(|finding| {
                finding.fingerprint == fingerprint && finding.status != FindingStatus::Resolved
            }) {
                existing.status = FindingStatus::Open;
                existing.last_seen_candidate_sha256 = submission.candidate.sha256.clone();
                existing.enforced = !blocking_only || input.severity == ReviewSeverity::Blocking;
                existing.severity = input.severity;
                existing.summary = input.summary;
                existing.paths = input.paths;
                existing.duplicate_observations = existing.duplicate_observations.saturating_add(1);
                observed_finding_ids.push(existing.id);
            } else {
                let id = self.snapshot.findings.len() as u32 + 1;
                self.snapshot.findings.push(ReviewFinding {
                    id,
                    fingerprint,
                    severity: input.severity,
                    summary: input.summary,
                    paths: input.paths,
                    status: FindingStatus::Open,
                    enforced: !blocking_only || input.severity == ReviewSeverity::Blocking,
                    introduced_candidate_sha256: submission.candidate.sha256.clone(),
                    last_seen_candidate_sha256: submission.candidate.sha256.clone(),
                    duplicate_observations: 0,
                    resolved_candidate_sha256: None,
                });
                observed_finding_ids.push(id);
            }
        }
        if self.unresolved().len() > self.snapshot.policy.max_open_findings {
            return Err(invalid("open review finding limit exceeded"));
        }
        let final_approved =
            submission.cadence == ReviewCadence::Final && self.blocking().is_empty();
        let cycle = ReviewCycle {
            id: self.snapshot.cycles.len() as u32 + 1,
            cadence: submission.cadence,
            candidate: submission.candidate,
            stable: submission.stable,
            risk: submission.risk,
            reviewer: submission.reviewer,
            separate_reviewer: submission.separate_reviewer,
            checks: submission.checks,
            observed_finding_ids,
            resolved_finding_ids: resolved.into_iter().collect(),
            duplicate_findings,
            final_approved,
        };
        self.snapshot.final_candidate_sha256 =
            final_approved.then(|| cycle.candidate.sha256.clone());
        self.snapshot.cycles.push(cycle.clone());
        Ok(cycle)
    }
}

fn validate_submission(policy: &ReviewPolicy, submission: &ReviewSubmission) -> io::Result<()> {
    validate_marker(&submission.candidate)?;
    policy.validate_request(
        submission.cadence,
        submission.stable,
        submission.risk.as_deref(),
    )?;
    if submission.reviewer.trim().is_empty() || submission.reviewer.len() > 128 {
        return Err(invalid("reviewer identity is required and bounded"));
    }
    if submission.findings.len() > policy.max_findings_per_cycle {
        return Err(invalid("review finding limit exceeded"));
    }
    if submission.cadence == ReviewCadence::Final {
        if policy.final_review == FinalReview::None {
            return Err(invalid(
                "the selected workflow contract has no final review",
            ));
        }
        if submission.checks.is_empty() {
            return Err(invalid(
                "final review requires a stable candidate and executable checks",
            ));
        }
        if submission.separate_reviewer != (policy.final_review == FinalReview::Separate) {
            return Err(invalid(if policy.final_review == FinalReview::Separate {
                "final review requires a separate reviewer"
            } else {
                "a final self-review may not be recorded as an independent review"
            }));
        }
    }
    for check in &submission.checks {
        validate_marker(check)?;
        if check.sha256 != submission.candidate.sha256 {
            return Err(invalid("review check is stale for the candidate"));
        }
    }
    Ok(())
}

fn validate_finding(finding: &ReviewFindingInput) -> io::Result<()> {
    if finding.fingerprint.len() != 64
        || !finding
            .fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || finding.summary.trim().is_empty()
        || finding.summary.len() > 4096
        || finding.paths.len() > 128
        || !unique(&finding.paths)
        || finding.paths.iter().any(|path| !valid_relative(path))
    {
        return Err(invalid("review finding is invalid or unbounded"));
    }
    Ok(())
}

fn validate_marker(marker: &VersionMarker) -> io::Result<()> {
    if marker.label.trim().is_empty()
        || marker.label.len() > 128
        || marker.evidence.trim().is_empty()
        || marker.evidence.len() > 4096
    {
        return Err(invalid("version marker is invalid or unbounded"));
    }
    validate_sha256(&marker.sha256)?;
    validate_sha256(&marker.evidence_sha256)
}

fn validate_sha256(value: &str) -> io::Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(invalid("exact lowercase SHA256 is required"));
    }
    Ok(())
}

fn enabled() -> bool {
    true
}

fn unique<T: Ord>(values: &[T]) -> bool {
    values.iter().collect::<BTreeSet<_>>().len() == values.len()
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

fn in_scope(path: &str, scope: &str) -> bool {
    scope == "." || path == scope || path.starts_with(&format!("{scope}/"))
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
#[path = "review_tests.rs"]
mod tests;
