use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeSet;
use std::io;

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct TaskContract {
    pub objective: String,
    pub acceptance_criteria: Vec<String>,
    pub max_no_progress_calls: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(deny_unknown_fields)]
pub struct VersionMarker {
    pub label: String,
    pub sha256: String,
    pub evidence: String,
    pub evidence_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(deny_unknown_fields)]
pub struct AcceptanceEvidence {
    pub criterion: String,
    pub evidence: Vec<VersionMarker>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CheckpointUpdate {
    pub completed_acceptance: Vec<AcceptanceEvidence>,
    pub completed_steering: Vec<String>,
    pub remaining_work: Vec<String>,
    pub failed_hypotheses: Vec<String>,
    pub candidate_versions: Vec<VersionMarker>,
    pub check_versions: Vec<VersionMarker>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "snake_case")]
pub enum ProcessStatus {
    Running,
    Stopped,
    Completed,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
pub struct ProcessSnapshot {
    pub identity: String,
    pub owner: String,
    pub status: ProcessStatus,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct LiveState {
    pub workspace_sha256: String,
    pub tracked_paths_sha256: String,
    pub processes: Vec<ProcessSnapshot>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStatus {
    Active,
    Stopped,
    Completed,
    Consumed,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct WorkerCheckpoint {
    pub id: String,
    pub parent: String,
    pub depth: u32,
    pub objective: Option<String>,
    pub status: WorkerStatus,
    pub result: Option<VersionMarker>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointTaskStatus {
    Active,
    Paused,
    Stopped,
    Completed,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct AllowanceCheckpoint {
    pub seconds_remaining: u64,
    pub requests_consumed: u32,
    pub requests_remaining: u32,
    pub exposure_consumed_microusd: u64,
    pub exposure_remaining_microusd: u64,
    pub uncertain_requests: Vec<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct Reconciliation {
    pub reason: String,
    pub prior_workspace_sha256: String,
    pub current_workspace_sha256: String,
    pub changed_workspace: bool,
    pub prior_processes: Vec<ProcessSnapshot>,
    pub current_processes: Vec<ProcessSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct NoProgressCheckpoint {
    pub signature_sha256: Option<String>,
    pub unchanged_calls: u32,
    pub max_unchanged_calls: u32,
    pub decision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct TaskCheckpoint {
    pub schema: u32,
    pub revision: u64,
    pub progress_revision: u64,
    pub task_status: CheckpointTaskStatus,
    pub objective: String,
    pub acceptance_criteria: Vec<String>,
    pub completed_acceptance: Vec<AcceptanceEvidence>,
    pub completed_steering: Vec<String>,
    pub remaining_work: Vec<String>,
    pub failed_hypotheses: Vec<String>,
    pub candidate_versions: Vec<VersionMarker>,
    pub check_versions: Vec<VersionMarker>,
    pub workers: Vec<WorkerCheckpoint>,
    #[serde(default)]
    pub archived_workers: u32,
    pub allowance: AllowanceCheckpoint,
    pub live: LiveState,
    pub reconciliation: Option<Reconciliation>,
    pub no_progress: NoProgressCheckpoint,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CallDecision {
    Progress,
    Unchanged,
    Reassess,
    LegitimateWait,
    Paused,
}

fn invalid(message: &str) -> io::Error {
    io::Error::other(message)
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max
}

fn unique_text(values: &[String], max_items: usize, max_bytes: usize) -> bool {
    values.len() <= max_items
        && values.iter().all(|value| valid_text(value, max_bytes))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl VersionMarker {
    pub(crate) fn validate(&self) -> io::Result<()> {
        if !valid_text(&self.label, 256)
            || !valid_sha256(&self.sha256)
            || !valid_text(&self.evidence, 4096)
            || !valid_sha256(&self.evidence_sha256)
        {
            return Err(invalid("invalid version marker"));
        }
        Ok(())
    }
}

impl TaskContract {
    pub(crate) fn validate(&self) -> io::Result<()> {
        if !valid_text(&self.objective, 4096)
            || !unique_text(&self.acceptance_criteria, 32, 1024)
            || self.acceptance_criteria.is_empty()
            || !(2..=16).contains(&self.max_no_progress_calls)
        {
            return Err(invalid("invalid bounded task contract"));
        }
        Ok(())
    }
}

impl LiveState {
    pub(crate) fn validate(&self) -> io::Result<()> {
        if !valid_sha256(&self.workspace_sha256)
            || !valid_sha256(&self.tracked_paths_sha256)
            || self.processes.len() > 128
        {
            return Err(invalid("invalid live state"));
        }
        let mut identities = BTreeSet::new();
        for process in &self.processes {
            if !valid_text(&process.identity, 256)
                || !valid_text(&process.owner, 128)
                || !identities.insert(&process.identity)
            {
                return Err(invalid("invalid live process state"));
            }
        }
        Ok(())
    }
}

impl CheckpointUpdate {
    pub(crate) fn validate(&self, contract: &TaskContract) -> io::Result<()> {
        if !unique_text(&self.completed_steering, 64, 4096)
            || !unique_text(&self.remaining_work, 64, 4096)
            || !unique_text(&self.failed_hypotheses, 64, 4096)
            || self.completed_acceptance.len() > contract.acceptance_criteria.len()
            || self.candidate_versions.len() > 32
            || self.check_versions.len() > 32
        {
            return Err(invalid("invalid bounded checkpoint update"));
        }
        let criteria = contract.acceptance_criteria.iter().collect::<BTreeSet<_>>();
        let mut completed = BTreeSet::new();
        for acceptance in &self.completed_acceptance {
            if !criteria.contains(&acceptance.criterion)
                || !completed.insert(&acceptance.criterion)
                || acceptance.evidence.is_empty()
                || acceptance.evidence.len() > 16
            {
                return Err(invalid("invalid acceptance evidence"));
            }
            for marker in &acceptance.evidence {
                marker.validate()?;
            }
        }
        for marker in self.candidate_versions.iter().chain(&self.check_versions) {
            marker.validate()?;
        }
        if serde_json::to_vec(self)?.len() > 65_536 {
            return Err(invalid("checkpoint update exceeds size limit"));
        }
        Ok(())
    }
}

pub(crate) fn preserves<T: Ord>(prior: &[T], current: &[T]) -> bool {
    let current = current.iter().collect::<BTreeSet<_>>();
    prior.iter().all(|value| current.contains(value))
}
