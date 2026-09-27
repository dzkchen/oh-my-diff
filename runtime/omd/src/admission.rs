use crate::checkpoint::AllowanceCheckpoint;
use crate::checkpoint::CallDecision;
use crate::checkpoint::CheckpointTaskStatus;
use crate::checkpoint::CheckpointUpdate;
use crate::checkpoint::LiveState;
use crate::checkpoint::NoProgressCheckpoint;
use crate::checkpoint::Reconciliation;
use crate::checkpoint::TaskCheckpoint;
use crate::checkpoint::TaskContract;
use crate::checkpoint::VersionMarker;
use crate::checkpoint::WorkerCheckpoint;
use crate::checkpoint::WorkerStatus;
use crate::checkpoint::preserves;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fs::OpenOptions;
use std::fs::{self};
use std::io::Write;
use std::io::{self};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Limits {
    pub requests: u32,
    pub exposure_microusd: u64,
    pub seconds: u64,
    pub concurrent_workers: u32,
    pub max_depth: u32,
    pub max_reassessments: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct WorkerLimits {
    pub requests: u32,
    pub exposure_microusd: u64,
    pub seconds: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Attempt {
    pub request: u32,
    pub owner: String,
    pub provider: String,
    pub model: String,
    pub reserved_microusd: u64,
    pub status: String,
    pub failure_reason: Option<String>,
    pub raw_usage: Option<Value>,
    pub settled_microusd: Option<u64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub external_subscription: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct TaskCostCapture {
    pub schema: u32,
    pub attempts: Vec<Attempt>,
    pub settled_task_charge_microusd: u64,
    #[serde(default)]
    pub subscription_list_equivalent_microusd: u64,
    pub retained_exposure_upper_bound_microusd: u64,
    pub raw_usage_attempts: u32,
    pub uncertain_requests: Vec<u32>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    Environment,
    Edit,
    Diagnosis,
    Model,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Failure {
    pub id: u32,
    pub class: FailureClass,
    pub summary: String,
    pub evidence: Vec<Value>,
}

#[derive(Clone, Debug)]
pub struct Admission {
    request: u32,
    task: PathBuf,
}

impl Admission {
    pub fn request_id(&self) -> u32 {
        self.request
    }
}

struct Worker {
    parent: String,
    depth: u32,
    limits: WorkerLimits,
    started: Instant,
    requests: u32,
    exposure: u64,
    status: WorkerStatus,
    objective: Option<String>,
    result: Option<VersionMarker>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
struct ArchivedWorker {
    id: String,
    parent: String,
    depth: u32,
    limits: WorkerLimits,
    requests: u32,
    exposure_microusd: u64,
    status: WorkerStatus,
    objective: Option<String>,
    result: Option<VersionMarker>,
}

impl ArchivedWorker {
    fn from_worker(id: String, worker: &Worker) -> Self {
        Self {
            id,
            parent: worker.parent.clone(),
            depth: worker.depth,
            limits: worker.limits.clone(),
            requests: worker.requests,
            exposure_microusd: worker.exposure,
            status: worker.status,
            objective: worker.objective.clone(),
            result: worker.result.clone(),
        }
    }

    fn matches_worker(&self, worker: &Worker) -> bool {
        self.parent == worker.parent
            && self.depth == worker.depth
            && self.limits == worker.limits
            && self.requests == worker.requests
            && self.exposure_microusd == worker.exposure
            && self.status == worker.status
            && self.objective == worker.objective
            && self.result == worker.result
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TaskStatus {
    Active,
    Paused,
    Stopped,
    Completed,
}

#[derive(Clone)]
struct CallRecord {
    result_sha256: String,
    progress_revision: u64,
    unchanged_calls: u32,
}

struct State {
    status: TaskStatus,
    contributor_authorized: bool,
    requests: u32,
    exposure: u64,
    sequence: u64,
    attempts: BTreeMap<u32, Attempt>,
    failures: BTreeMap<u32, Failure>,
    escalated_failures: BTreeSet<u32>,
    escalations: u32,
    reassessments: u32,
    failure_fingerprints: BTreeMap<String, u32>,
    seen_workers: BTreeSet<String>,
    workers: BTreeMap<String, Worker>,
    contract: Option<TaskContract>,
    checkpoint: Option<TaskCheckpoint>,
    calls: BTreeMap<String, CallRecord>,
}

const MAX_TASK_REQUESTS: u32 = 10_000;
const MAX_LIVE_WORKERS: usize = 128;
const MAX_TOTAL_WORKERS: usize = 1_024;
const MAX_LIVE_CALLS: usize = 256;
const MAX_FAILURES: usize = 128;
const MAX_FAILURE_FINGERPRINTS: usize = 128;

pub struct Task {
    limits: Limits,
    started: Instant,
    deadline_unix_millis: u128,
    evidence: PathBuf,
    state: Mutex<State>,
    external_routes: Mutex<BTreeSet<(String, String)>>,
    worker_routes: Mutex<BTreeMap<String, (String, String)>>,
}

fn denied(message: &str) -> io::Error {
    io::Error::other(message)
}

fn unix_millis() -> io::Result<u128> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|_| denied("system clock precedes Unix epoch"))
}

impl Task {
    fn validate_limits(limits: &Limits) -> io::Result<()> {
        if limits.requests == 0
            || limits.requests > MAX_TASK_REQUESTS
            || limits.seconds == 0
            || limits.concurrent_workers == 0
            || limits.concurrent_workers as usize > MAX_LIVE_WORKERS
            || limits.max_depth == 0
        {
            return Err(denied(
                "task limits must be positive and within runtime ceilings",
            ));
        }
        Ok(())
    }

    pub fn create(limits: Limits, evidence: PathBuf) -> io::Result<Self> {
        Self::create_inner(limits, evidence, None)
    }

    pub fn create_checkpointed(
        limits: Limits,
        evidence: PathBuf,
        contract: TaskContract,
        live: LiveState,
    ) -> io::Result<Self> {
        contract.validate()?;
        live.validate()?;
        let task = Self::create_inner(limits, evidence, Some(contract.clone()))?;
        task.save_checkpoint(
            CheckpointUpdate {
                completed_acceptance: Vec::new(),
                completed_steering: Vec::new(),
                remaining_work: contract.acceptance_criteria,
                failed_hypotheses: Vec::new(),
                candidate_versions: Vec::new(),
                check_versions: Vec::new(),
            },
            live,
        )?;
        Ok(task)
    }

    fn create_inner(
        limits: Limits,
        evidence: PathBuf,
        contract: Option<TaskContract>,
    ) -> io::Result<Self> {
        Self::validate_limits(&limits)?;
        fs::create_dir(&evidence)?;
        let evidence = evidence.canonicalize()?;
        let task = Self {
            deadline_unix_millis: unix_millis()?
                .checked_add(u128::from(limits.seconds) * 1000)
                .ok_or_else(|| denied("task deadline overflow"))?,
            limits,
            started: Instant::now(),
            evidence,
            state: Mutex::new(State {
                status: TaskStatus::Active,
                contributor_authorized: false,
                requests: 0,
                exposure: 0,
                sequence: 0,
                attempts: BTreeMap::new(),
                failures: BTreeMap::new(),
                escalated_failures: BTreeSet::new(),
                escalations: 0,
                reassessments: 0,
                failure_fingerprints: BTreeMap::new(),
                seen_workers: BTreeSet::new(),
                workers: BTreeMap::new(),
                contract: contract.clone(),
                checkpoint: None,
                calls: BTreeMap::new(),
            }),
            external_routes: Mutex::new(BTreeSet::new()),
            worker_routes: Mutex::new(BTreeMap::new()),
        };
        let mut state = task
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        task.record(
            &mut state,
            &serde_json::json!({"event": "created", "limits": task.limits, "contract": contract}),
        )?;
        drop(state);
        Ok(task)
    }

    pub fn open(
        limits: Limits,
        evidence: PathBuf,
        explicit_resume: Option<&str>,
    ) -> io::Result<Self> {
        Self::open_inner(limits, evidence, explicit_resume, None, None)
    }

    pub fn open_checkpointed(
        limits: Limits,
        evidence: PathBuf,
        explicit_resume: Option<&str>,
        contract: TaskContract,
        live: LiveState,
    ) -> io::Result<Self> {
        contract.validate()?;
        live.validate()?;
        if !evidence.exists() {
            if explicit_resume.is_some() {
                return Err(denied("explicit resume has no prior task evidence"));
            }
            return Self::create_checkpointed(limits, evidence, contract, live);
        }
        Self::open_inner(
            limits,
            evidence,
            explicit_resume,
            Some(contract),
            Some(live),
        )
    }

    fn open_inner(
        limits: Limits,
        evidence: PathBuf,
        explicit_resume: Option<&str>,
        expected_contract: Option<TaskContract>,
        current_live: Option<LiveState>,
    ) -> io::Result<Self> {
        Self::validate_limits(&limits)?;
        if !evidence.exists() {
            if explicit_resume.is_some() {
                return Err(denied("explicit resume has no prior task evidence"));
            }
            return Self::create_inner(limits, evidence, expected_contract);
        }
        let reference =
            explicit_resume.ok_or_else(|| denied("existing task requires explicit resume"))?;
        if reference.is_empty() || reference.len() > 4096 {
            return Err(denied("explicit resume reference required"));
        }
        let evidence = evidence.canonicalize()?;
        let mut records = fs::read_dir(&evidence)?
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.file_name().to_str().is_some_and(|name| {
                    name.strip_suffix(".json").is_some_and(|stem| {
                        stem.len() == 8 && stem.bytes().all(|byte| byte.is_ascii_digit())
                    })
                })
            })
            .collect::<Vec<_>>();
        records.sort_by_key(fs::DirEntry::file_name);
        if records.is_empty() {
            return Err(denied("resume evidence is empty"));
        }
        let mut state = State {
            status: TaskStatus::Active,
            contributor_authorized: false,
            requests: 0,
            exposure: 0,
            sequence: 0,
            attempts: BTreeMap::new(),
            failures: BTreeMap::new(),
            escalated_failures: BTreeSet::new(),
            escalations: 0,
            reassessments: 0,
            failure_fingerprints: BTreeMap::new(),
            seen_workers: BTreeSet::new(),
            workers: BTreeMap::new(),
            contract: None,
            checkpoint: None,
            calls: BTreeMap::new(),
        };
        let mut created_unix_millis = None;
        for entry in records {
            if entry.file_type()?.is_symlink() {
                return Err(denied("resume evidence cannot be a symbolic link"));
            }
            let value: Value = serde_json::from_slice(&fs::read(entry.path())?)?;
            let sequence = value["sequence"]
                .as_u64()
                .ok_or_else(|| denied("resume evidence sequence missing"))?;
            if state.sequence.checked_add(1) != Some(sequence) {
                return Err(denied("resume evidence sequence is incomplete"));
            }
            state.sequence = sequence;
            let timestamp = value["unix_millis"]
                .as_u64()
                .map(u128::from)
                .ok_or_else(|| denied("resume evidence timestamp missing"))?;
            created_unix_millis.get_or_insert(timestamp);
            let record = &value["record"];
            if state.sequence == 1 && record["event"] != "created" {
                return Err(denied("resume evidence must begin with task creation"));
            }
            match record["event"].as_str() {
                Some("created") => {
                    let recorded: Limits = serde_json::from_value(record["limits"].clone())?;
                    let recorded_contract = record
                        .get("contract")
                        .filter(|value| !value.is_null())
                        .map(|value| serde_json::from_value::<TaskContract>(value.clone()))
                        .transpose()?;
                    if state.sequence != 1
                        || recorded != limits
                        || recorded_contract != expected_contract
                    {
                        return Err(denied(
                            "resume limits or contract differ from original task",
                        ));
                    }
                    state.contract = recorded_contract;
                }
                Some("contributor_authorization") => {
                    state.contributor_authorized = record["authorized"].as_bool().unwrap_or(false);
                }
                Some("worker_started") => {
                    let id = record["worker"]
                        .as_str()
                        .ok_or_else(|| denied("worker identity missing"))?
                        .to_owned();
                    if !state.seen_workers.insert(id.clone())
                        || state.seen_workers.len() > MAX_TOTAL_WORKERS
                        || state.workers.len() >= MAX_LIVE_WORKERS
                    {
                        return Err(denied(
                            "worker identity or live worker archive limit exceeded",
                        ));
                    }
                    state.workers.insert(
                        id,
                        Worker {
                            parent: record["parent"].as_str().unwrap_or("lead").to_owned(),
                            depth: u32::try_from(record["depth"].as_u64().unwrap_or(1))
                                .map_err(|_| denied("worker depth overflow"))?,
                            limits: serde_json::from_value(record["limits"].clone())?,
                            started: Instant::now(),
                            requests: 0,
                            exposure: 0,
                            status: WorkerStatus::Active,
                            objective: None,
                            result: None,
                        },
                    );
                }
                Some("worker_stopped") => {
                    if let Some(worker) = record["worker"]
                        .as_str()
                        .and_then(|id| state.workers.get_mut(id))
                    {
                        worker.status = WorkerStatus::Stopped;
                    }
                }
                Some("worker_objective_claimed") => {
                    let worker = record["worker"]
                        .as_str()
                        .and_then(|id| state.workers.get_mut(id))
                        .ok_or_else(|| denied("objective worker missing"))?;
                    worker.objective = Some(
                        record["objective"]
                            .as_str()
                            .ok_or_else(|| denied("worker objective missing"))?
                            .to_owned(),
                    );
                }
                Some("worker_completed") => {
                    let worker = record["worker"]
                        .as_str()
                        .and_then(|id| state.workers.get_mut(id))
                        .ok_or_else(|| denied("completed worker missing"))?;
                    let result: VersionMarker = serde_json::from_value(record["result"].clone())?;
                    result.validate()?;
                    worker.status = WorkerStatus::Completed;
                    worker.result = Some(result);
                }
                Some("worker_result_consumed") => {
                    let worker = record["worker"]
                        .as_str()
                        .and_then(|id| state.workers.get_mut(id))
                        .ok_or_else(|| denied("consumed worker missing"))?;
                    worker.status = WorkerStatus::Consumed;
                }
                Some("worker_result_discarded") => {
                    let worker = record["worker"]
                        .as_str()
                        .and_then(|id| state.workers.get_mut(id))
                        .ok_or_else(|| denied("discarded worker missing"))?;
                    if worker.status != WorkerStatus::Completed {
                        return Err(denied("discarded worker was not completed"));
                    }
                    worker.status = WorkerStatus::Stopped;
                }
                Some("worker_archived") => {
                    let archived: ArchivedWorker =
                        serde_json::from_value(record["archive"].clone())?;
                    let worker = state
                        .workers
                        .get(&archived.id)
                        .ok_or_else(|| denied("archived worker missing from live state"))?;
                    if archived.status == WorkerStatus::Active || !archived.matches_worker(worker) {
                        return Err(denied("archived worker evidence changed"));
                    }
                    state.workers.remove(&archived.id);
                }
                Some("request_admitted")
                | Some("request_dispatched")
                | Some("request_failed")
                | Some("request_settled")
                | Some("raw_usage_observed") => {
                    let attempt: Attempt = serde_json::from_value(record["attempt"].clone())?;
                    let prior = state.attempts.insert(attempt.request, attempt.clone());
                    if let Some(worker) = state.workers.get_mut(&attempt.owner) {
                        if prior.is_none() {
                            worker.requests = worker
                                .requests
                                .checked_add(1)
                                .ok_or_else(|| denied("resume worker request count overflow"))?;
                        }
                        let prior_exposure = prior.as_ref().map_or(0, |prior| {
                            prior.settled_microusd.unwrap_or(prior.reserved_microusd)
                        });
                        let exposure = attempt
                            .settled_microusd
                            .unwrap_or(attempt.reserved_microusd);
                        worker.exposure = worker
                            .exposure
                            .checked_sub(prior_exposure)
                            .and_then(|value| value.checked_add(exposure))
                            .ok_or_else(|| denied("resume worker exposure overflow"))?;
                    }
                }
                Some("failure_recorded") => {
                    let failure: Failure = serde_json::from_value(record["failure"].clone())?;
                    if state.failures.len() >= MAX_FAILURES
                        || failure.id != state.failures.len() as u32 + 1
                    {
                        return Err(denied("failure evidence exceeds live limit"));
                    }
                    state.failures.insert(failure.id, failure);
                }
                Some("escalation_permitted") => {
                    let failure = record["failure"]
                        .as_u64()
                        .ok_or_else(|| denied("escalation failure identity missing"))?
                        as u32;
                    state.escalated_failures.insert(failure);
                    state.escalations += 1;
                }
                Some("equivalent_failure_observed") => {
                    let fingerprint = record["fingerprint"]
                        .as_str()
                        .ok_or_else(|| denied("failure fingerprint missing"))?;
                    let count = record["count"]
                        .as_u64()
                        .ok_or_else(|| denied("failure observation count missing"))?
                        as u32;
                    if !state.failure_fingerprints.contains_key(fingerprint)
                        && state.failure_fingerprints.len() >= MAX_FAILURE_FINGERPRINTS
                    {
                        return Err(denied("failure fingerprint cache limit exceeded"));
                    }
                    state
                        .failure_fingerprints
                        .insert(fingerprint.to_owned(), count);
                }
                Some("loop_reassessed") => state.reassessments += 1,
                Some("checkpoint_saved") => {
                    let checkpoint: TaskCheckpoint =
                        serde_json::from_value(record["checkpoint"].clone())?;
                    let contract = state
                        .contract
                        .as_ref()
                        .ok_or_else(|| denied("checkpoint contract missing"))?;
                    if checkpoint.schema != 1
                        || checkpoint.objective != contract.objective
                        || checkpoint.acceptance_criteria != contract.acceptance_criteria
                        || checkpoint.progress_revision == 0
                        || state.checkpoint.as_ref().is_some_and(|prior| {
                            checkpoint.progress_revision < prior.progress_revision
                                || checkpoint.progress_revision
                                    > prior.progress_revision.saturating_add(1)
                        })
                        || checkpoint.revision
                            != state
                                .checkpoint
                                .as_ref()
                                .map_or(1, |prior| prior.revision.saturating_add(1))
                        || usize::try_from(checkpoint.archived_workers).ok()
                            != Some(state.seen_workers.len().saturating_sub(state.workers.len()))
                    {
                        return Err(denied("checkpoint sequence or contract changed"));
                    }
                    CheckpointUpdate {
                        completed_acceptance: checkpoint.completed_acceptance.clone(),
                        completed_steering: checkpoint.completed_steering.clone(),
                        remaining_work: checkpoint.remaining_work.clone(),
                        failed_hypotheses: checkpoint.failed_hypotheses.clone(),
                        candidate_versions: checkpoint.candidate_versions.clone(),
                        check_versions: checkpoint.check_versions.clone(),
                    }
                    .validate(contract)?;
                    checkpoint.live.validate()?;
                    if state.checkpoint.as_ref().is_some_and(|prior| {
                        prior.progress_revision != checkpoint.progress_revision
                    }) {
                        state.calls.clear();
                    }
                    state.checkpoint = Some(checkpoint);
                }
                Some("call_observed") => {
                    let signature = record["signature_sha256"]
                        .as_str()
                        .ok_or_else(|| denied("call signature missing"))?;
                    if !state.calls.contains_key(signature) && state.calls.len() >= MAX_LIVE_CALLS {
                        return Err(denied("live call cache limit exceeded"));
                    }
                    state.calls.insert(
                        signature.to_owned(),
                        CallRecord {
                            result_sha256: record["result_sha256"]
                                .as_str()
                                .ok_or_else(|| denied("call result hash missing"))?
                                .to_owned(),
                            progress_revision: record["progress_revision"]
                                .as_u64()
                                .ok_or_else(|| denied("call progress revision missing"))?,
                            unchanged_calls: record["unchanged_calls"]
                                .as_u64()
                                .and_then(|value| u32::try_from(value).ok())
                                .ok_or_else(|| denied("unchanged call count missing"))?,
                        },
                    );
                }
                Some("no_progress_paused") => {
                    state.status = TaskStatus::Paused;
                    for worker in state.workers.values_mut() {
                        if worker.status == WorkerStatus::Active {
                            worker.status = WorkerStatus::Stopped;
                        }
                    }
                }
                Some("task_paused") => {
                    let recorded = record["active_workers"]
                        .as_array()
                        .ok_or_else(|| denied("paused worker list missing"))?
                        .iter()
                        .map(|value| {
                            value
                                .as_str()
                                .map(str::to_owned)
                                .ok_or_else(|| denied("paused worker identity missing"))
                        })
                        .collect::<io::Result<BTreeSet<_>>>()?;
                    let active = state
                        .workers
                        .iter()
                        .filter(|(_, worker)| worker.status == WorkerStatus::Active)
                        .map(|(id, _)| id.clone())
                        .collect::<BTreeSet<_>>();
                    if recorded != active {
                        return Err(denied("paused worker list changed"));
                    }
                    for id in recorded {
                        if let Some(worker) = state.workers.get_mut(&id) {
                            worker.status = WorkerStatus::Stopped;
                        }
                    }
                    state.status = TaskStatus::Paused;
                }
                Some("task_resumed") => state.status = TaskStatus::Active,
                Some("reservation_violation") => {
                    let attempt: Attempt = serde_json::from_value(record["attempt"].clone())?;
                    state.attempts.insert(attempt.request, attempt);
                    state.status = TaskStatus::Stopped;
                }
                Some("task_stopped") => {
                    state.status = TaskStatus::Stopped;
                }
                Some("task_completed") => {
                    state.status = TaskStatus::Completed;
                }
                Some("dispatch_callback_failed") => {}
                Some(_) => return Err(denied("resume evidence event is unsupported")),
                None => return Err(denied("resume evidence event missing")),
            }
        }
        state.requests = u32::try_from(state.attempts.len())
            .map_err(|_| denied("resume request count overflow"))?;
        if state.attempts.keys().copied().ne(1..=state.requests) {
            return Err(denied("resume request sequence is incomplete"));
        }
        state.exposure = state.attempts.values().try_fold(0u64, |total, attempt| {
            total
                .checked_add(
                    attempt
                        .settled_microusd
                        .unwrap_or(attempt.reserved_microusd),
                )
                .ok_or_else(|| denied("resume exposure overflow"))
        })?;
        for worker in state.workers.values_mut() {
            if worker.status == WorkerStatus::Active {
                worker.status = WorkerStatus::Stopped;
            }
        }
        state
            .workers
            .retain(|_, worker| worker.status == WorkerStatus::Completed);
        if let Some(checkpoint) = state.checkpoint.as_mut() {
            checkpoint
                .workers
                .retain(|worker| worker.status == WorkerStatus::Completed);
            checkpoint.archived_workers =
                u32::try_from(state.seen_workers.len().saturating_sub(state.workers.len()))
                    .map_err(|_| denied("archived worker count overflow"))?;
        }
        if matches!(state.status, TaskStatus::Stopped | TaskStatus::Completed) {
            return Err(denied("stopped or completed task cannot resume"));
        }
        let deadline_unix_millis = created_unix_millis
            .ok_or_else(|| denied("created timestamp missing"))?
            .checked_add(u128::from(limits.seconds) * 1000)
            .ok_or_else(|| denied("task deadline overflow"))?;
        if unix_millis()? >= deadline_unix_millis {
            return Err(denied("task expired before resume"));
        }
        let task = Self {
            limits,
            started: Instant::now(),
            deadline_unix_millis,
            evidence,
            state: Mutex::new(state),
            external_routes: Mutex::new(BTreeSet::new()),
            worker_routes: Mutex::new(BTreeMap::new()),
        };
        task.rewrite_compact_checkpoint()?;
        let uncertain = task.uncertain_requests()?;
        {
            let mut state = task
                .state
                .lock()
                .map_err(|_| denied("task lock poisoned"))?;
            if state.status == TaskStatus::Active {
                task.record(
                    &mut state,
                    &serde_json::json!({"event": "task_paused", "reason": "abrupt_client_loss", "active_workers": [], "uncertain_operations": uncertain}),
                )?;
                state.status = TaskStatus::Paused;
            }
        }
        if let Some(live) = current_live {
            task.reconcile("restart", live)?;
        }
        task.resume(reference)?;
        Ok(task)
    }

    fn expired(&self) -> bool {
        unix_millis().map_or(true, |now| now >= self.deadline_unix_millis)
    }

    fn record(&self, state: &mut State, event: &Value) -> io::Result<()> {
        state.sequence = state
            .sequence
            .checked_add(1)
            .ok_or_else(|| denied("evidence sequence overflow"))?;
        let result = (|| {
            let bytes = serde_json::to_vec(&serde_json::json!({
                "sequence": state.sequence,
                "elapsed_millis": self.started.elapsed().as_millis(),
                "unix_millis": unix_millis()?,
                "record": event,
            }))?;
            if bytes.len() > 1_048_576 {
                return Err(denied("evidence event exceeds size limit"));
            }
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(self.evidence.join(format!("{:08}.json", state.sequence)))?;
            file.write_all(&bytes)?;
            file.sync_all()
        })();
        if result.is_err() {
            state.status = TaskStatus::Stopped;
        }
        result
    }

    fn task_status(status: TaskStatus) -> CheckpointTaskStatus {
        match status {
            TaskStatus::Active => CheckpointTaskStatus::Active,
            TaskStatus::Paused => CheckpointTaskStatus::Paused,
            TaskStatus::Stopped => CheckpointTaskStatus::Stopped,
            TaskStatus::Completed => CheckpointTaskStatus::Completed,
        }
    }

    fn allowance(&self, state: &State) -> AllowanceCheckpoint {
        AllowanceCheckpoint {
            seconds_remaining: self
                .deadline_unix_millis
                .saturating_sub(unix_millis().unwrap_or(u128::MAX))
                .min(u128::from(u64::MAX)) as u64
                / 1000,
            requests_consumed: state.requests,
            requests_remaining: self.limits.requests.saturating_sub(state.requests),
            exposure_consumed_microusd: state.exposure,
            exposure_remaining_microusd: self
                .limits
                .exposure_microusd
                .saturating_sub(state.exposure),
            uncertain_requests: state
                .attempts
                .values()
                .filter(|attempt| matches!(attempt.status.as_str(), "unknown" | "in_flight"))
                .map(|attempt| attempt.request)
                .collect(),
        }
    }

    fn worker_checkpoints(state: &State) -> Vec<WorkerCheckpoint> {
        state
            .workers
            .iter()
            .map(|(id, worker)| WorkerCheckpoint {
                id: id.clone(),
                parent: worker.parent.clone(),
                depth: worker.depth,
                objective: worker.objective.clone(),
                status: worker.status,
                result: worker.result.clone(),
            })
            .collect()
    }

    fn archive_worker(&self, state: &mut State, id: &str) -> io::Result<()> {
        self.worker_routes
            .lock()
            .map_err(|_| denied("worker route lock poisoned"))?
            .remove(id);
        let archived = ArchivedWorker::from_worker(
            id.to_owned(),
            state
                .workers
                .get(id)
                .ok_or_else(|| denied("worker archive target missing"))?,
        );
        if archived.status == WorkerStatus::Active {
            return Err(denied("active worker cannot be archived"));
        }
        self.record(
            state,
            &serde_json::json!({"event": "worker_archived", "archive": archived}),
        )?;
        state.workers.remove(id);
        Ok(())
    }

    fn write_compact_checkpoint(&self, checkpoint: &TaskCheckpoint) -> io::Result<()> {
        let bytes = serde_json::to_vec(checkpoint)?;
        if bytes.len() > 65_536 {
            return Err(denied("compact checkpoint exceeds size limit"));
        }
        let temporary = self.evidence.join(format!(
            ".checkpoint-{}-{}.tmp",
            checkpoint.revision,
            unix_millis()?
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, self.evidence.join("checkpoint.json"))?;
        OpenOptions::new()
            .read(true)
            .open(&self.evidence)?
            .sync_all()
    }

    fn rewrite_compact_checkpoint(&self) -> io::Result<()> {
        let checkpoint = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?
            .checkpoint
            .clone();
        if let Some(checkpoint) = checkpoint {
            self.write_compact_checkpoint(&checkpoint)?;
        }
        Ok(())
    }

    fn save_checkpoint_inner(
        &self,
        update: CheckpointUpdate,
        live: LiveState,
        reconciliation: Option<Reconciliation>,
    ) -> io::Result<TaskCheckpoint> {
        live.validate()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if matches!(state.status, TaskStatus::Stopped | TaskStatus::Completed) {
            return Err(denied("terminal task cannot checkpoint"));
        }
        let contract = state
            .contract
            .clone()
            .ok_or_else(|| denied("task has no checkpoint contract"))?;
        update.validate(&contract)?;
        if let Some(prior) = &state.checkpoint
            && (!preserves(&prior.completed_acceptance, &update.completed_acceptance)
                || !preserves(&prior.completed_steering, &update.completed_steering)
                || !preserves(&prior.failed_hypotheses, &update.failed_hypotheses)
                || !preserves(&prior.candidate_versions, &update.candidate_versions)
                || !preserves(&prior.check_versions, &update.check_versions))
        {
            return Err(denied("checkpoint cannot discard completed evidence"));
        }
        if reconciliation.is_none()
            && state.checkpoint.as_ref().is_some_and(|prior| {
                prior.completed_acceptance == update.completed_acceptance
                    && prior.completed_steering == update.completed_steering
                    && prior.remaining_work == update.remaining_work
                    && prior.failed_hypotheses == update.failed_hypotheses
                    && prior.candidate_versions == update.candidate_versions
                    && prior.check_versions == update.check_versions
                    && prior.live == live
            })
        {
            return Err(denied("checkpoint update contains no progress"));
        }
        let revision = state
            .checkpoint
            .as_ref()
            .map_or(1, |checkpoint| checkpoint.revision.saturating_add(1));
        let progress_changed = state.checkpoint.as_ref().is_none_or(|prior| {
            prior.completed_acceptance != update.completed_acceptance
                || prior.completed_steering != update.completed_steering
                || prior.remaining_work != update.remaining_work
                || prior.failed_hypotheses != update.failed_hypotheses
                || prior.candidate_versions != update.candidate_versions
                || prior.check_versions != update.check_versions
        });
        let progress_revision = state.checkpoint.as_ref().map_or(1, |checkpoint| {
            checkpoint
                .progress_revision
                .saturating_add(u64::from(progress_changed))
        });
        if progress_changed {
            state.calls.clear();
        }
        let no_progress = state
            .checkpoint
            .as_ref()
            .map(|checkpoint| checkpoint.no_progress.clone())
            .unwrap_or(NoProgressCheckpoint {
                signature_sha256: None,
                unchanged_calls: 0,
                max_unchanged_calls: contract.max_no_progress_calls,
                decision: "progress".into(),
            });
        let checkpoint = TaskCheckpoint {
            schema: 1,
            revision,
            progress_revision,
            task_status: Self::task_status(state.status),
            objective: contract.objective,
            acceptance_criteria: contract.acceptance_criteria,
            completed_acceptance: update.completed_acceptance,
            completed_steering: update.completed_steering,
            remaining_work: update.remaining_work,
            failed_hypotheses: update.failed_hypotheses,
            candidate_versions: update.candidate_versions,
            check_versions: update.check_versions,
            workers: Self::worker_checkpoints(&state),
            archived_workers: u32::try_from(
                state.seen_workers.len().saturating_sub(state.workers.len()),
            )
            .map_err(|_| denied("archived worker count overflow"))?,
            allowance: self.allowance(&state),
            live,
            reconciliation,
            no_progress,
        };
        self.record(
            &mut state,
            &serde_json::json!({"event": "checkpoint_saved", "checkpoint": checkpoint}),
        )?;
        if let Err(error) = self.write_compact_checkpoint(&checkpoint) {
            state.status = TaskStatus::Stopped;
            return Err(error);
        }
        state.checkpoint = Some(checkpoint.clone());
        Ok(checkpoint)
    }

    pub fn save_checkpoint(
        &self,
        update: CheckpointUpdate,
        live: LiveState,
    ) -> io::Result<TaskCheckpoint> {
        self.save_checkpoint_inner(update, live, None)
    }

    pub fn reconcile(&self, reason: &str, live: LiveState) -> io::Result<TaskCheckpoint> {
        if reason.is_empty() || reason.len() > 256 {
            return Err(denied("reconciliation reason required"));
        }
        let prior = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?
            .checkpoint
            .clone()
            .ok_or_else(|| denied("task has no checkpoint to reconcile"))?;
        let reconciliation = Reconciliation {
            reason: reason.to_owned(),
            prior_workspace_sha256: prior.live.workspace_sha256.clone(),
            current_workspace_sha256: live.workspace_sha256.clone(),
            changed_workspace: prior.live.workspace_sha256 != live.workspace_sha256,
            prior_processes: prior.live.processes.clone(),
            current_processes: live.processes.clone(),
        };
        self.save_checkpoint_inner(
            CheckpointUpdate {
                completed_acceptance: prior.completed_acceptance,
                completed_steering: prior.completed_steering,
                remaining_work: prior.remaining_work,
                failed_hypotheses: prior.failed_hypotheses,
                candidate_versions: prior.candidate_versions,
                check_versions: prior.check_versions,
            },
            live,
            Some(reconciliation),
        )
    }

    pub fn checkpoint(&self) -> io::Result<Option<TaskCheckpoint>> {
        Ok(self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?
            .checkpoint
            .clone())
    }

    fn refresh_checkpoint(&self, state: &mut State) -> io::Result<()> {
        let workers = Self::worker_checkpoints(state);
        let archived_workers =
            u32::try_from(state.seen_workers.len().saturating_sub(state.workers.len()))
                .map_err(|_| denied("archived worker count overflow"))?;
        let allowance = self.allowance(state);
        let status = Self::task_status(state.status);
        if let Some(checkpoint) = state.checkpoint.as_mut() {
            checkpoint.task_status = status;
            checkpoint.workers = workers;
            checkpoint.archived_workers = archived_workers;
            checkpoint.allowance = allowance;
            if let Err(error) = self.write_compact_checkpoint(checkpoint) {
                state.status = TaskStatus::Stopped;
                return Err(error);
            }
        }
        Ok(())
    }

    pub fn observe_call(
        &self,
        signature_sha256: &str,
        result_sha256: &str,
        legitimate_wait: bool,
    ) -> io::Result<CallDecision> {
        let valid_hash = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        if !valid_hash(signature_sha256) || !valid_hash(result_sha256) {
            return Err(denied("call observation requires SHA256 identities"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if state.status != TaskStatus::Active || self.expired() {
            return Err(denied("task stopped or expired"));
        }
        let progress_revision = state
            .checkpoint
            .as_ref()
            .ok_or_else(|| denied("task has no checkpoint"))?
            .progress_revision;
        let max = state
            .contract
            .as_ref()
            .ok_or_else(|| denied("task has no checkpoint contract"))?
            .max_no_progress_calls;
        let prior = state.calls.get(signature_sha256);
        let unchanged = prior.is_some_and(|call| {
            call.result_sha256 == result_sha256 && call.progress_revision == progress_revision
        });
        let unchanged_calls = if unchanged {
            prior
                .map(|call| call.unchanged_calls)
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| denied("unchanged call count overflow"))?
        } else {
            1
        };
        if prior.is_none() && state.calls.len() >= MAX_LIVE_CALLS {
            return Err(denied(
                "live call cache limit exceeded; checkpoint progress required",
            ));
        }
        let decision = if legitimate_wait {
            CallDecision::LegitimateWait
        } else if !unchanged {
            CallDecision::Progress
        } else if unchanged_calls < max {
            CallDecision::Unchanged
        } else if unchanged_calls == max {
            CallDecision::Reassess
        } else {
            CallDecision::Paused
        };
        self.record(
            &mut state,
            &serde_json::json!({
                "event": "call_observed",
                "signature_sha256": signature_sha256,
                "result_sha256": result_sha256,
                "progress_revision": progress_revision,
                "unchanged_calls": unchanged_calls,
                "legitimate_wait": legitimate_wait,
                "decision": decision,
            }),
        )?;
        state.calls.insert(
            signature_sha256.to_owned(),
            CallRecord {
                result_sha256: result_sha256.to_owned(),
                progress_revision,
                unchanged_calls,
            },
        );
        if let Some(checkpoint) = state.checkpoint.as_mut() {
            checkpoint.no_progress = NoProgressCheckpoint {
                signature_sha256: Some(signature_sha256.to_owned()),
                unchanged_calls,
                max_unchanged_calls: max,
                decision: serde_json::to_value(decision)?
                    .as_str()
                    .unwrap_or("unknown")
                    .to_owned(),
            };
        }
        if decision == CallDecision::Paused {
            self.record(
                &mut state,
                &serde_json::json!({"event": "no_progress_paused", "signature_sha256": signature_sha256, "unchanged_calls": unchanged_calls}),
            )?;
            state.status = TaskStatus::Paused;
            let active_workers = state
                .workers
                .iter()
                .filter(|(_, worker)| worker.status == WorkerStatus::Active)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for id in active_workers {
                if let Some(worker) = state.workers.get_mut(&id) {
                    worker.status = WorkerStatus::Stopped;
                }
                self.archive_worker(&mut state, &id)?;
            }
        }
        self.refresh_checkpoint(&mut state)?;
        Ok(decision)
    }

    pub fn set_contributor_authorization(
        &self,
        authorized: bool,
        reference: &str,
    ) -> io::Result<()> {
        if reference.is_empty() || reference.len() > 4096 {
            return Err(denied("authorization evidence reference required"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        self.record(&mut state, &serde_json::json!({"event": "contributor_authorization", "authorized": authorized, "reference": reference}))?;
        state.contributor_authorized = authorized;
        Ok(())
    }

    pub fn start_worker(
        &self,
        id: String,
        parent: String,
        depth: u32,
        limits: WorkerLimits,
    ) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if id.is_empty()
            || id.len() > 128
            || id == "lead"
            || state.seen_workers.contains(&id)
            || state.seen_workers.len() >= MAX_TOTAL_WORKERS
            || state.workers.len() >= MAX_LIVE_WORKERS
        {
            return Err(denied("invalid or reused worker identity"));
        }
        if state.status != TaskStatus::Active || self.expired() {
            return Err(denied("task stopped or expired"));
        }
        let valid_parent = if depth == 1 {
            parent == "lead"
        } else {
            state.workers.get(&parent).is_some_and(|worker| {
                worker.status == WorkerStatus::Active && worker.depth.checked_add(1) == Some(depth)
            })
        };
        if limits.requests == 0
            || limits.seconds == 0
            || depth == 0
            || depth > self.limits.max_depth
            || !valid_parent
            || limits.requests > self.limits.requests
            || limits.seconds > self.limits.seconds
            || limits.exposure_microusd > self.limits.exposure_microusd
            || state
                .workers
                .values()
                .filter(|worker| worker.status == WorkerStatus::Active)
                .count()
                >= self.limits.concurrent_workers as usize
        {
            return Err(denied("worker limits exceed task ceiling or capacity"));
        }
        self.record(
            &mut state,
            &serde_json::json!({"event": "worker_started", "worker": id, "parent": parent, "depth": depth, "limits": limits}),
        )?;
        state.seen_workers.insert(id.clone());
        state.workers.insert(
            id,
            Worker {
                parent,
                depth,
                limits,
                started: Instant::now(),
                requests: 0,
                exposure: 0,
                status: WorkerStatus::Active,
                objective: None,
                result: None,
            },
        );
        self.refresh_checkpoint(&mut state)?;
        Ok(())
    }

    pub fn claim_worker_objective(&self, id: &str, objective: &str) -> io::Result<()> {
        let normalized = objective
            .split_whitespace()
            .map(str::to_lowercase)
            .collect::<Vec<_>>()
            .join(" ");
        if normalized.is_empty() || normalized.len() > 4096 {
            return Err(denied("bounded worker objective required"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if !state.workers.get(id).is_some_and(|worker| {
            worker.status == WorkerStatus::Active && worker.objective.is_none()
        }) || state.workers.iter().any(|(other_id, worker)| {
            other_id != id
                && worker.status == WorkerStatus::Active
                && worker.objective.as_deref() == Some(normalized.as_str())
        }) {
            return Err(denied("duplicate or invalid active worker objective"));
        }
        self.record(
            &mut state,
            &serde_json::json!({"event": "worker_objective_claimed", "worker": id, "objective": normalized}),
        )?;
        state
            .workers
            .get_mut(id)
            .ok_or_else(|| denied("worker disappeared"))?
            .objective = Some(normalized);
        self.refresh_checkpoint(&mut state)?;
        Ok(())
    }

    pub fn complete_worker(&self, id: &str, result: VersionMarker) -> io::Result<()> {
        result.validate()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if !state
            .workers
            .get(id)
            .is_some_and(|worker| worker.status == WorkerStatus::Active)
            || state
                .workers
                .values()
                .any(|worker| worker.status == WorkerStatus::Active && worker.parent == id)
        {
            return Err(denied("worker is not completable"));
        }
        self.record(
            &mut state,
            &serde_json::json!({"event": "worker_completed", "worker": id, "result": result}),
        )?;
        let worker = state
            .workers
            .get_mut(id)
            .ok_or_else(|| denied("worker disappeared"))?;
        worker.status = WorkerStatus::Completed;
        worker.result = Some(result);
        self.refresh_checkpoint(&mut state)?;
        Ok(())
    }

    pub fn consume_worker_result(&self, id: &str) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if !state.workers.get(id).is_some_and(|worker| {
            worker.status == WorkerStatus::Completed && worker.result.is_some()
        }) {
            return Err(denied("worker result is not consumable"));
        }
        self.record(
            &mut state,
            &serde_json::json!({"event": "worker_result_consumed", "worker": id}),
        )?;
        state
            .workers
            .get_mut(id)
            .ok_or_else(|| denied("worker disappeared"))?
            .status = WorkerStatus::Consumed;
        self.archive_worker(&mut state, id)?;
        self.refresh_checkpoint(&mut state)?;
        Ok(())
    }

    pub fn discard_worker_result(&self, id: &str) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if !state
            .workers
            .get(id)
            .is_some_and(|worker| worker.status == WorkerStatus::Completed)
        {
            return Err(denied("worker has no completed result to discard"));
        }
        self.record(
            &mut state,
            &serde_json::json!({"event":"worker_result_discarded","worker":id}),
        )?;
        state
            .workers
            .get_mut(id)
            .ok_or_else(|| denied("worker disappeared"))?
            .status = WorkerStatus::Stopped;
        self.archive_worker(&mut state, id)?;
        self.refresh_checkpoint(&mut state)?;
        Ok(())
    }

    pub fn finish_worker(&self, id: &str) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if !state
            .workers
            .get(id)
            .is_some_and(|worker| worker.status == WorkerStatus::Active)
        {
            return Err(denied("unknown or inactive worker"));
        }
        if state
            .workers
            .values()
            .any(|worker| worker.status == WorkerStatus::Active && worker.parent == id)
        {
            return Err(denied("worker has active descendants"));
        }
        self.record(
            &mut state,
            &serde_json::json!({"event": "worker_stopped", "worker": id}),
        )?;
        state
            .workers
            .get_mut(id)
            .ok_or_else(|| denied("worker disappeared"))?
            .status = WorkerStatus::Stopped;
        self.archive_worker(&mut state, id)?;
        self.refresh_checkpoint(&mut state)?;
        Ok(())
    }

    pub fn authorize_external_route(&self, provider: &str, model: &str) -> io::Result<()> {
        if provider.is_empty()
            || provider.len() > 64
            || !provider
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            || model.is_empty()
            || model.len() > 128
            || provider == "openai"
            || provider == "meta"
        {
            return Err(denied("invalid external provider route"));
        }
        self.external_routes
            .lock()
            .map_err(|_| denied("external route lock poisoned"))?
            .insert((provider.to_owned(), model.to_owned()));
        Ok(())
    }

    pub fn authorize_worker_route(
        &self,
        owner: &str,
        provider: &str,
        model: &str,
    ) -> io::Result<()> {
        let state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if state.status != TaskStatus::Active
            || self.expired()
            || owner == "lead"
            || !state
                .workers
                .get(owner)
                .is_some_and(|worker| worker.status == WorkerStatus::Active)
            || provider == "meta"
            || provider.is_empty()
            || provider.len() > 64
            || !provider
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            || model.is_empty()
            || model.len() > 128
        {
            return Err(denied("invalid worker provider route"));
        }
        let mut routes = self
            .worker_routes
            .lock()
            .map_err(|_| denied("worker route lock poisoned"))?;
        let route = (provider.to_owned(), model.to_owned());
        if routes.get(owner).is_some_and(|current| current != &route) {
            return Err(denied("worker provider route already fixed"));
        }
        routes.insert(owner.to_owned(), route);
        Ok(())
    }

    pub fn admit(
        &self,
        owner: &str,
        provider: &str,
        model: &str,
        exposure_microusd: u64,
    ) -> io::Result<Admission> {
        self.admit_with_billing(owner, provider, model, exposure_microusd, false)
    }

    pub fn admit_with_billing(
        &self,
        owner: &str,
        provider: &str,
        model: &str,
        exposure_microusd: u64,
        external_subscription: bool,
    ) -> io::Result<Admission> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if state.status != TaskStatus::Active || self.expired() {
            return Err(denied("task stopped or expired"));
        }
        let allowed = match (provider, model) {
            ("openai", "gpt-5.6-sol" | "gpt-6-astra") => true,
            ("meta", "muse-spark-1.3-contributor") => {
                state.contributor_authorized && owner != "lead"
            }
            _ => {
                self.worker_routes
                    .lock()
                    .map_err(|_| denied("worker route lock poisoned"))?
                    .get(owner)
                    .is_some_and(|route| route == &(provider.to_owned(), model.to_owned()))
                    || self
                        .external_routes
                        .lock()
                        .map_err(|_| denied("external route lock poisoned"))?
                        .contains(&(provider.to_owned(), model.to_owned()))
            }
        };
        if !allowed {
            return Err(denied(
                "provider/model or Contributor data authorization denied",
            ));
        }
        if external_subscription
            && !self
                .external_routes
                .lock()
                .map_err(|_| denied("external route lock poisoned"))?
                .contains(&(provider.to_owned(), model.to_owned()))
        {
            return Err(denied("external subscription requires a granted route"));
        }
        let next_exposure = state
            .exposure
            .checked_add(exposure_microusd)
            .ok_or_else(|| denied("exposure overflow"))?;
        if state.requests >= self.limits.requests || next_exposure > self.limits.exposure_microusd {
            return Err(denied("shared request or exposure limit"));
        }
        if owner != "lead" {
            let worker = state
                .workers
                .get(owner)
                .ok_or_else(|| denied("unregistered worker"))?;
            if worker.status != WorkerStatus::Active
                || worker.started.elapsed().as_secs() >= worker.limits.seconds
                || worker.requests >= worker.limits.requests
                || worker
                    .exposure
                    .checked_add(exposure_microusd)
                    .is_none_or(|amount| amount > worker.limits.exposure_microusd)
            {
                return Err(denied("worker stopped or allowance exhausted"));
            }
        }
        let attempt = Attempt {
            request: state.requests + 1,
            owner: owner.to_owned(),
            provider: provider.to_owned(),
            model: model.to_owned(),
            reserved_microusd: exposure_microusd,
            status: "unknown".to_owned(),
            failure_reason: None,
            raw_usage: None,
            settled_microusd: None,
            external_subscription,
        };
        self.record(
            &mut state,
            &serde_json::json!({"event": "request_admitted", "attempt": attempt}),
        )?;
        state.requests += 1;
        state.exposure = next_exposure;
        if let Some(worker) = state.workers.get_mut(owner) {
            worker.requests += 1;
            worker.exposure += exposure_microusd;
        }
        let admission = Admission {
            request: attempt.request,
            task: self.evidence.clone(),
        };
        state.attempts.insert(attempt.request, attempt);
        self.refresh_checkpoint(&mut state)?;
        Ok(admission)
    }

    pub fn dispatch<T>(
        &self,
        admission: &Admission,
        send: impl FnOnce() -> io::Result<T>,
    ) -> io::Result<T> {
        if admission.task != self.evidence {
            return Err(denied("request belongs to another task"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        let mut attempt = state
            .attempts
            .get(&admission.request)
            .cloned()
            .ok_or_else(|| denied("unknown request"))?;
        if state.status != TaskStatus::Active
            || self.expired()
            || attempt.status != "unknown"
            || (attempt.provider == "meta" && !state.contributor_authorized)
        {
            return Err(denied(
                "request dispatch stopped, expired, revoked or already consumed",
            ));
        }
        if attempt.owner != "lead"
            && !state.workers.get(&attempt.owner).is_some_and(|worker| {
                worker.status == WorkerStatus::Active
                    && worker.started.elapsed().as_secs() < worker.limits.seconds
            })
        {
            return Err(denied("worker stopped or expired before dispatch"));
        }
        attempt.status = "in_flight".to_owned();
        self.record(
            &mut state,
            &serde_json::json!({"event": "request_dispatched", "attempt": attempt}),
        )?;
        state.attempts.insert(admission.request, attempt.clone());
        self.refresh_checkpoint(&mut state)?;
        drop(state);
        match send() {
            Ok(value) => Ok(value),
            Err(error) => {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| denied("task lock poisoned"))?;
                let mut attempt = state
                    .attempts
                    .get(&admission.request)
                    .cloned()
                    .ok_or_else(|| denied("unknown dispatched request"))?;
                if attempt.status == "in_flight" {
                    attempt.status = "failed".to_owned();
                    attempt.failure_reason = Some("dispatch_failed".to_owned());
                } else {
                    self.record(&mut state, &serde_json::json!({"event": "dispatch_callback_failed", "request": admission.request, "request_status": attempt.status}))?;
                    return Err(error);
                }
                self.record(
                    &mut state,
                    &serde_json::json!({"event": "request_failed", "attempt": attempt}),
                )?;
                state.attempts.insert(admission.request, attempt);
                self.refresh_checkpoint(&mut state)?;
                Err(error)
            }
        }
    }

    pub fn settle(
        &self,
        admission: &Admission,
        raw_usage: Value,
        upper_microusd: u64,
    ) -> io::Result<()> {
        if admission.task != self.evidence {
            return Err(denied("request belongs to another task"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        let mut attempt = state
            .attempts
            .get(&admission.request)
            .cloned()
            .ok_or_else(|| denied("unknown request"))?;
        if attempt.status == "unknown"
            || attempt.settled_microusd.is_some()
            || !raw_usage.is_object()
        {
            return Err(denied("request settled or invalid raw usage"));
        }
        if upper_microusd > attempt.reserved_microusd {
            state.status = TaskStatus::Stopped;
            state.exposure = state
                .exposure
                .saturating_add(upper_microusd - attempt.reserved_microusd);
            if let Some(worker) = state.workers.get_mut(&attempt.owner) {
                worker.exposure = worker
                    .exposure
                    .saturating_add(upper_microusd - attempt.reserved_microusd);
            }
            attempt.raw_usage = Some(raw_usage);
            attempt.settled_microusd = Some(upper_microusd);
            attempt.status = "reservation_violation".to_owned();
            state.attempts.insert(admission.request, attempt.clone());
            self.record(
                &mut state,
                &serde_json::json!({"event": "reservation_violation", "attempt": attempt}),
            )?;
            self.refresh_checkpoint(&mut state)?;
            return Err(denied(
                "observed usage exceeded reservation; admission stopped",
            ));
        }
        attempt.raw_usage = Some(raw_usage);
        attempt.settled_microusd = Some(upper_microusd);
        attempt.status = if attempt.failure_reason.is_some() {
            "failed"
        } else {
            "completed"
        }
        .to_owned();
        self.record(
            &mut state,
            &serde_json::json!({"event": "request_settled", "attempt": attempt}),
        )?;
        let released = attempt.reserved_microusd - upper_microusd;
        state.exposure -= released;
        if let Some(worker) = state.workers.get_mut(&attempt.owner) {
            worker.exposure -= released;
        }
        state.attempts.insert(admission.request, attempt);
        self.refresh_checkpoint(&mut state)?;
        Ok(())
    }

    pub fn fail(&self, admission: &Admission, reason: &str) -> io::Result<()> {
        if admission.task != self.evidence || reason.is_empty() || reason.len() > 4096 {
            return Err(denied("invalid failure identity or reason"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        let mut attempt = state
            .attempts
            .get(&admission.request)
            .cloned()
            .ok_or_else(|| denied("unknown request"))?;
        if !matches!(attempt.status.as_str(), "unknown" | "in_flight") {
            return Err(denied("request already finalized"));
        }
        attempt.status = "failed".to_owned();
        attempt.failure_reason = Some(reason.to_owned());
        self.record(
            &mut state,
            &serde_json::json!({"event": "request_failed", "attempt": attempt}),
        )?;
        state.attempts.insert(admission.request, attempt);
        self.refresh_checkpoint(&mut state)?;
        Ok(())
    }

    pub fn retain_usage(&self, admission: &Admission, raw_usage: Value) -> io::Result<()> {
        if admission.task != self.evidence || !raw_usage.is_object() {
            return Err(denied("invalid raw usage identity or shape"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        let mut attempt = state
            .attempts
            .get(&admission.request)
            .cloned()
            .ok_or_else(|| denied("unknown request"))?;
        if attempt.raw_usage.is_some() || attempt.settled_microusd.is_some() {
            return Err(denied("raw usage already retained"));
        }
        attempt.raw_usage = Some(raw_usage);
        self.record(
            &mut state,
            &serde_json::json!({"event": "raw_usage_observed", "attempt": attempt}),
        )?;
        state.attempts.insert(admission.request, attempt);
        self.refresh_checkpoint(&mut state)?;
        Ok(())
    }

    pub fn check_active(&self) -> io::Result<()> {
        let state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if state.status != TaskStatus::Active || self.expired() {
            return Err(denied("task stopped or expired"));
        }
        Ok(())
    }

    pub fn record_failure(
        &self,
        class: FailureClass,
        summary: String,
        evidence: Vec<Value>,
    ) -> io::Result<Failure> {
        if summary.is_empty()
            || summary.len() > 4096
            || evidence.is_empty()
            || evidence.len() > 16
            || serde_json::to_vec(&evidence)?.len() > 1_048_576
        {
            return Err(denied("bounded failure summary and evidence required"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if state.status != TaskStatus::Active || self.expired() {
            return Err(denied("task stopped or expired"));
        }
        if state.failures.len() >= MAX_FAILURES {
            return Err(denied("failure evidence limit exceeded"));
        }
        let id = u32::try_from(state.failures.len())
            .ok()
            .and_then(|count| count.checked_add(1))
            .ok_or_else(|| denied("failure count overflow"))?;
        let failure = Failure {
            id,
            class,
            summary,
            evidence,
        };
        self.record(
            &mut state,
            &serde_json::json!({"event": "failure_recorded", "failure": failure}),
        )?;
        state.failures.insert(id, failure.clone());
        Ok(failure)
    }

    pub fn permit_escalation(
        &self,
        failure: u32,
        max_escalations: u32,
    ) -> io::Result<(Duration, u32, u64)> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        let remaining = (
            Duration::from_millis(
                self.deadline_unix_millis
                    .saturating_sub(unix_millis().unwrap_or(u128::MAX))
                    .min(u128::from(u64::MAX)) as u64,
            ),
            self.limits.requests.saturating_sub(state.requests),
            self.limits.exposure_microusd.saturating_sub(state.exposure),
        );
        if state.status != TaskStatus::Active || remaining.0.is_zero() {
            return Err(denied("task stopped or expired"));
        }
        if max_escalations == 0
            || state.escalations >= max_escalations
            || state.escalated_failures.contains(&failure)
            || remaining.1 == 0
            || !state.failures.contains_key(&failure)
        {
            return Err(denied(
                "escalation is not permitted within remaining allowance",
            ));
        }
        self.record(
            &mut state,
            &serde_json::json!({
                "event": "escalation_permitted",
                "failure": failure,
                "remaining": {
                    "seconds": remaining.0.as_secs(),
                    "requests": remaining.1,
                    "exposure_microusd": remaining.2,
                },
            }),
        )?;
        state.escalations += 1;
        state.escalated_failures.insert(failure);
        Ok(remaining)
    }

    pub fn observe_equivalent_failure(
        &self,
        fingerprint: &str,
        threshold: u32,
        changed_action: &str,
    ) -> io::Result<bool> {
        if fingerprint.is_empty()
            || fingerprint.len() > 256
            || threshold < 2
            || changed_action.is_empty()
            || changed_action.len() > 256
        {
            return Err(denied("invalid loop reassessment observation"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if state.status != TaskStatus::Active {
            return Err(denied("task is not active"));
        }
        if !state.failure_fingerprints.contains_key(fingerprint)
            && state.failure_fingerprints.len() >= MAX_FAILURE_FINGERPRINTS
        {
            return Err(denied("failure fingerprint cache limit exceeded"));
        }
        let count = state
            .failure_fingerprints
            .get(fingerprint)
            .copied()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| denied("failure observation overflow"))?;
        self.record(
            &mut state,
            &serde_json::json!({"event": "equivalent_failure_observed", "fingerprint": fingerprint, "count": count}),
        )?;
        state
            .failure_fingerprints
            .insert(fingerprint.to_owned(), count);
        if count < threshold {
            return Ok(false);
        }
        if count > threshold || state.reassessments >= self.limits.max_reassessments {
            return Err(denied("loop reassessment limit exhausted"));
        }
        self.record(
            &mut state,
            &serde_json::json!({"event": "loop_reassessed", "fingerprint": fingerprint, "equivalent_failures": count, "changed_action": changed_action}),
        )?;
        state.reassessments += 1;
        Ok(true)
    }

    pub fn pause(&self, reason: &str, uncertain_operations: Vec<u32>) -> io::Result<()> {
        if reason.is_empty() || reason.len() > 256 {
            return Err(denied("pause reason required"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if state.status != TaskStatus::Active {
            return Err(denied("only an active task can pause"));
        }
        let active_workers = state
            .workers
            .iter()
            .filter(|(_, worker)| worker.status == WorkerStatus::Active)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        self.record(
            &mut state,
            &serde_json::json!({"event": "task_paused", "reason": reason, "active_workers": active_workers, "uncertain_operations": uncertain_operations}),
        )?;
        state.status = TaskStatus::Paused;
        for id in active_workers {
            if let Some(worker) = state.workers.get_mut(&id) {
                worker.status = WorkerStatus::Stopped;
            }
            self.archive_worker(&mut state, &id)?;
        }
        self.refresh_checkpoint(&mut state)?;
        Ok(())
    }

    pub fn resume(&self, reference: &str) -> io::Result<()> {
        if reference.is_empty() || reference.len() > 4096 {
            return Err(denied("explicit resume reference required"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if state.status != TaskStatus::Paused || self.expired() {
            return Err(denied("task is not resumable"));
        }
        let remaining_requests = self.limits.requests.saturating_sub(state.requests);
        let remaining_exposure = self.limits.exposure_microusd.saturating_sub(state.exposure);
        self.record(
            &mut state,
            &serde_json::json!({"event": "task_resumed", "reference": reference, "remaining": {"requests": remaining_requests, "exposure_microusd": remaining_exposure}}),
        )?;
        state.status = TaskStatus::Active;
        self.refresh_checkpoint(&mut state)?;
        Ok(())
    }

    pub fn uncertain_requests(&self) -> io::Result<Vec<u32>> {
        let state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        Ok(state
            .attempts
            .values()
            .filter(|attempt| matches!(attempt.status.as_str(), "unknown" | "in_flight"))
            .map(|attempt| attempt.request)
            .collect())
    }

    pub fn stop(&self) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        state.status = TaskStatus::Stopped;
        self.record(&mut state, &serde_json::json!({"event": "task_stopped"}))?;
        self.refresh_checkpoint(&mut state)
    }

    pub fn complete(&self, reference: &str) -> io::Result<()> {
        if reference.is_empty() || reference.len() > 4096 {
            return Err(denied("completion evidence reference required"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        let contract = state
            .contract
            .as_ref()
            .ok_or_else(|| denied("task has no checkpoint contract"))?;
        let checkpoint = state
            .checkpoint
            .as_ref()
            .ok_or_else(|| denied("task has no checkpoint"))?;
        let completed = checkpoint
            .completed_acceptance
            .iter()
            .map(|acceptance| &acceptance.criterion)
            .collect::<BTreeSet<_>>();
        if state.status != TaskStatus::Active
            || !checkpoint.remaining_work.is_empty()
            || contract
                .acceptance_criteria
                .iter()
                .any(|criterion| !completed.contains(criterion))
            || state
                .workers
                .values()
                .any(|worker| worker.status == WorkerStatus::Active)
            || state
                .attempts
                .values()
                .any(|attempt| matches!(attempt.status.as_str(), "unknown" | "in_flight"))
        {
            return Err(denied(
                "task acceptance is incomplete or work remains active",
            ));
        }
        self.record(
            &mut state,
            &serde_json::json!({"event": "task_completed", "reference": reference}),
        )?;
        state.status = TaskStatus::Completed;
        self.refresh_checkpoint(&mut state)
    }

    pub fn complete_direct(&self, reference: &str) -> io::Result<()> {
        if reference.is_empty() || reference.len() > 4096 {
            return Err(denied("completion evidence reference required"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if state.status != TaskStatus::Active
            || state
                .workers
                .values()
                .any(|worker| worker.status == WorkerStatus::Active)
            || state
                .attempts
                .values()
                .any(|attempt| matches!(attempt.status.as_str(), "unknown" | "in_flight"))
        {
            return Err(denied("direct task still has active or uncertain work"));
        }
        self.record(
            &mut state,
            &serde_json::json!({"event": "direct_task_completed", "reference": reference}),
        )?;
        state.status = TaskStatus::Completed;
        self.refresh_checkpoint(&mut state)
    }

    pub fn remaining(&self) -> io::Result<(Duration, u32, u64)> {
        let state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        Ok((
            Duration::from_millis(
                self.deadline_unix_millis
                    .saturating_sub(unix_millis().unwrap_or(u128::MAX))
                    .min(u128::from(u64::MAX)) as u64,
            ),
            self.limits.requests - state.requests,
            self.limits.exposure_microusd.saturating_sub(state.exposure),
        ))
    }

    pub fn attempts(&self) -> io::Result<Vec<Attempt>> {
        let state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        Ok(state.attempts.values().cloned().collect())
    }

    pub fn cost_capture(&self) -> io::Result<TaskCostCapture> {
        let state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        let attempts = state.attempts.values().cloned().collect::<Vec<_>>();
        let settled_task_charge_microusd = attempts
            .iter()
            .filter(|attempt| !attempt.external_subscription)
            .filter_map(|attempt| attempt.settled_microusd)
            .sum();
        let subscription_list_equivalent_microusd = attempts
            .iter()
            .filter(|attempt| attempt.external_subscription)
            .filter_map(|attempt| attempt.settled_microusd)
            .sum();
        let retained_exposure_upper_bound_microusd = attempts
            .iter()
            .map(|attempt| {
                attempt
                    .settled_microusd
                    .unwrap_or(attempt.reserved_microusd)
            })
            .sum();
        let raw_usage_attempts = attempts
            .iter()
            .filter(|attempt| attempt.raw_usage.is_some())
            .count()
            .try_into()
            .map_err(|_| denied("raw usage attempt count overflow"))?;
        let uncertain_requests = attempts
            .iter()
            .filter(|attempt| matches!(attempt.status.as_str(), "unknown" | "in_flight"))
            .map(|attempt| attempt.request)
            .collect();
        Ok(TaskCostCapture {
            schema: 1,
            attempts,
            settled_task_charge_microusd,
            subscription_list_equivalent_microusd,
            retained_exposure_upper_bound_microusd,
            raw_usage_attempts,
            uncertain_requests,
        })
    }
}
