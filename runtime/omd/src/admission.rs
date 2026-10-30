use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fs::{self};
use std::io::{self};
use std::path::Path;
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
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct WorkerLimits {
    pub requests: u32,
    pub exposure_microusd: u64,
    pub seconds: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(deny_unknown_fields)]
pub struct VersionMarker {
    pub label: String,
    pub sha256: String,
    pub evidence: String,
    pub evidence_sha256: String,
}

impl VersionMarker {
    fn validate(&self) -> io::Result<()> {
        let valid_hash = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        if self.label.trim().is_empty()
            || self.label.len() > 256
            || !valid_hash(&self.sha256)
            || self.evidence.trim().is_empty()
            || self.evidence.len() > 4096
            || !valid_hash(&self.evidence_sha256)
        {
            return Err(io::Error::other("invalid version marker"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStatus {
    Active,
    Stopped,
    Completed,
    Consumed,
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
    #[serde(default, skip_serializing_if = "is_false")]
    pub provider_billed: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

impl Attempt {
    /// Provider-billed costs never count against the exposure ceiling.
    fn exposure(&self) -> u64 {
        match self.settled_microusd {
            Some(settled) if !self.provider_billed => settled,
            _ => self.reserved_microusd,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct TaskCostCapture {
    pub schema: u32,
    pub attempts: Vec<Attempt>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub observed: Vec<Attempt>,
    pub settled_task_charge_microusd: u64,
    #[serde(default)]
    pub subscription_list_equivalent_microusd: u64,
    pub retained_exposure_upper_bound_microusd: u64,
    pub raw_usage_attempts: u32,
    pub uncertain_requests: Vec<u32>,
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
    idle: bool,
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
}

struct State {
    status: TaskStatus,
    requests: u32,
    exposure: u64,
    sequence: u64,
    attempts: BTreeMap<u32, Attempt>,
    seen_workers: BTreeSet<String>,
    workers: BTreeMap<String, Worker>,
    observed: Vec<Attempt>,
}

const MAX_OBSERVED_REQUESTS: usize = 10_000;
const MAX_TASK_REQUESTS: u32 = 10_000;
const MAX_LIVE_WORKERS: usize = 128;
const MAX_TOTAL_WORKERS: usize = 1_024;

pub struct Task {
    limits: Mutex<Limits>,
    started: Instant,
    started_unix_millis: Mutex<u128>,
    evidence: PathBuf,
    state: Mutex<State>,
    external_routes: Mutex<BTreeSet<(String, String)>>,
    worker_routes: Mutex<BTreeMap<String, (String, String)>>,
}

fn denied(message: &str) -> io::Error {
    io::Error::other(message)
}

fn check_depth(depth: u32, max_depth: u32) -> io::Result<()> {
    if depth > max_depth {
        return Err(io::Error::other(format!(
            "subagent_depth_limit: depth {depth} exceeds limits.max_depth {max_depth}"
        )));
    }
    Ok(())
}

fn check_concurrency(running: usize, cap: u32) -> io::Result<()> {
    if running >= cap as usize {
        return Err(io::Error::other(format!(
            "subagent_concurrency_limit: {running} running of limits.concurrent_workers {cap}"
        )));
    }
    Ok(())
}

fn active_workers(state: &State) -> usize {
    state
        .workers
        .values()
        .filter(|worker| worker.status == WorkerStatus::Active && !worker.idle)
        .count()
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
        Self::create_inner(limits, evidence)
    }

    fn create_inner(limits: Limits, evidence: PathBuf) -> io::Result<Self> {
        Self::validate_limits(&limits)?;
        fs::create_dir(&evidence)?;
        Self::create_in(limits, &evidence).inspect_err(|_| {
            let _ = fs::remove_dir(&evidence);
        })
    }

    fn create_in(limits: Limits, evidence: &Path) -> io::Result<Self> {
        let evidence = evidence.canonicalize()?;
        if crate::broker::anchored(&evidence)?.is_some_and(|anchor| anchor.count > 0) {
            return Err(denied("evidence_anchor_mismatch"));
        }
        let task = Self {
            started_unix_millis: Mutex::new(unix_millis()?),
            limits: Mutex::new(limits.clone()),
            started: Instant::now(),
            evidence,
            state: Mutex::new(State {
                status: TaskStatus::Active,
                requests: 0,
                exposure: 0,
                sequence: 0,
                attempts: BTreeMap::new(),
                seen_workers: BTreeSet::new(),
                workers: BTreeMap::new(),
                observed: Vec::new(),
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
            &serde_json::json!({"event": "created", "limits": limits}),
        )?;
        drop(state);
        Ok(task)
    }

    pub fn open(
        limits: Limits,
        evidence: PathBuf,
        explicit_resume: Option<&str>,
    ) -> io::Result<Self> {
        Self::open_inner(limits, evidence, explicit_resume)
    }

    fn open_inner(
        limits: Limits,
        evidence: PathBuf,
        explicit_resume: Option<&str>,
    ) -> io::Result<Self> {
        Self::validate_limits(&limits)?;
        if !evidence.exists() {
            if explicit_resume.is_some() {
                return Err(denied("explicit resume has no prior task evidence"));
            }
            return Self::create_inner(limits, evidence);
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
        if records.len() > 200_000 {
            return Err(denied("resume journal limit"));
        }
        if records.is_empty() {
            return Err(denied("resume evidence is empty"));
        }
        let mut state = State {
            status: TaskStatus::Active,
            requests: 0,
            exposure: 0,
            sequence: 0,
            attempts: BTreeMap::new(),
            seen_workers: BTreeSet::new(),
            workers: BTreeMap::new(),
            observed: Vec::new(),
        };
        let mut created_unix_millis = None;
        let mut recorded_limits = None;
        let (mut head, mut last) = (String::new(), String::new());
        for entry in records {
            let metadata = entry.metadata()?;
            if entry.file_type()?.is_symlink()
                || !metadata.is_file()
                || metadata.len() > 4 * 1024 * 1024
            {
                return Err(denied("resume evidence must be a bounded regular file"));
            }
            let bytes = fs::read(entry.path())?;
            last = crate::broker::sha256(&bytes);
            head = crate::broker::chain(&head, &last);
            let value: Value = serde_json::from_slice(&bytes)?;
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
                Some("created") | Some("limits_changed") => {
                    let recorded: Limits = serde_json::from_value(record["limits"].clone())?;
                    if (state.sequence == 1) != (record["event"] == "created") {
                        return Err(denied("resume evidence must begin with task creation"));
                    }
                    recorded_limits = Some(recorded);
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
                            idle: false,
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
                | Some("request_provider_reported")
                | Some("request_provider_settled")
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
                        let prior_exposure = prior.as_ref().map_or(0, Attempt::exposure);
                        let exposure = attempt.exposure();
                        worker.exposure = worker
                            .exposure
                            .checked_sub(prior_exposure)
                            .and_then(|value| value.checked_add(exposure))
                            .ok_or_else(|| denied("resume worker exposure overflow"))?;
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
                Some("request_observed") => {
                    let attempt: Attempt = serde_json::from_value(record["attempt"].clone())?;
                    if state.observed.len() >= MAX_OBSERVED_REQUESTS
                        || attempt.request as usize != state.observed.len() + 1
                        || !attempt.status.starts_with("observed_")
                        || attempt.reserved_microusd != 0
                        || attempt.settled_microusd.is_some()
                    {
                        return Err(denied("resume observed request invalid"));
                    }
                    state.observed.push(attempt);
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
                .checked_add(attempt.exposure())
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
        if state.status == TaskStatus::Stopped {
            return Err(denied("stopped task cannot resume"));
        }
        match crate::broker::anchored(&evidence)? {
            Some(anchor) if anchor.count == 0 => {
                crate::broker::seed(&evidence, state.sequence, &head, &last)?;
            }
            Some(anchor) if anchor.count != state.sequence || anchor.head != head => {
                return Err(denied("evidence_anchor_mismatch"));
            }
            _ => {}
        }
        let created_unix_millis =
            created_unix_millis.ok_or_else(|| denied("created timestamp missing"))?;
        let recorded_limits = recorded_limits
            .ok_or_else(|| denied("resume evidence must begin with task creation"))?;
        let task = Self {
            limits: Mutex::new(recorded_limits),
            started: Instant::now(),
            started_unix_millis: Mutex::new(created_unix_millis),
            evidence,
            state: Mutex::new(state),
            external_routes: Mutex::new(BTreeSet::new()),
            worker_routes: Mutex::new(BTreeMap::new()),
        };
        let active = task
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?
            .status
            == TaskStatus::Active;
        if active {
            task.pause("abrupt_client_loss", task.uncertain_requests()?)?;
        }
        task.set_limits(limits)?;
        task.resume(reference)?;
        Ok(task)
    }

    fn limits(&self) -> Limits {
        self.limits
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn deadline_unix_millis(&self) -> u128 {
        (*self
            .started_unix_millis
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner))
        .saturating_add(u128::from(self.limits().seconds) * 1000)
    }

    fn expired(&self) -> bool {
        unix_millis().map_or(true, |now| now >= self.deadline_unix_millis())
    }

    pub fn set_limits(&self, limits: Limits) -> io::Result<()> {
        Self::validate_limits(&limits)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if self.limits() == limits {
            return Ok(());
        }
        self.record(
            &mut state,
            &serde_json::json!({"event": "limits_changed", "limits": limits}),
        )?;
        *self
            .limits
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = limits;
        Ok(())
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
            let path = self.evidence.join(format!("{:08}.json", state.sequence));
            crate::fsio::create_new(&path, &bytes)?;
            let written = crate::broker::anchor(&self.evidence, &crate::broker::sha256(&bytes));
            if written.is_err() {
                let _ = fs::remove_file(&path);
            }
            written
        })();
        if result.is_err() {
            state.status = TaskStatus::Stopped;
        }
        result
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
        let valid_parent = parent == "lead"
            || state.workers.get(&parent).is_some_and(|worker| {
                worker.status == WorkerStatus::Active && worker.depth < depth
            });
        let ceiling = self.limits();
        check_depth(depth, ceiling.max_depth)?;
        if !valid_parent {
            return Err(denied("invalid worker parent"));
        }
        if limits.requests == 0
            || limits.seconds == 0
            || depth == 0
            || limits.requests > ceiling.requests
            || limits.seconds > ceiling.seconds
            || limits.exposure_microusd > ceiling.exposure_microusd
        {
            return Err(denied("worker limits exceed task ceiling"));
        }
        check_concurrency(active_workers(&state), ceiling.concurrent_workers)?;
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
                idle: false,
                objective: None,
                result: None,
            },
        );
        Ok(())
    }

    /// Admits a model-spawned subagent at `depth` beside `other_running` live children the task does not track as workers.
    pub fn admit_subagent(&self, depth: u32, other_running: usize) -> io::Result<()> {
        let state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        let ceiling = self.limits();
        check_depth(depth, ceiling.max_depth)?;
        check_concurrency(
            active_workers(&state).saturating_add(other_running),
            ceiling.concurrent_workers,
        )
    }

    /// An idle worker keeps its limits and route but holds no concurrency slot.
    pub fn set_worker_idle(&self, id: &str, idle: bool) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        let worker = state
            .workers
            .get_mut(id)
            .filter(|worker| worker.status == WorkerStatus::Active)
            .ok_or_else(|| denied("unknown or inactive worker"))?;
        worker.idle = idle;
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
        Ok(())
    }

    pub fn authorize_route(&self, provider: &str, model: &str) -> io::Result<()> {
        if provider.is_empty()
            || provider.len() > 64
            || !provider
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            || model.is_empty()
            || model.len() > 128
        {
            return Err(denied("invalid provider route"));
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
            || provider.is_empty()
            || provider.len() > 64
            || !provider
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
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
        let allowed = self
            .worker_routes
            .lock()
            .map_err(|_| denied("worker route lock poisoned"))?
            .get(owner)
            .is_some_and(|route| route == &(provider.to_owned(), model.to_owned()))
            || self
                .external_routes
                .lock()
                .map_err(|_| denied("external route lock poisoned"))?
                .contains(&(provider.to_owned(), model.to_owned()));
        if !allowed {
            return Err(denied("provider/model route is not authorized"));
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
        let ceiling = self.limits();
        if state.requests >= ceiling.requests || next_exposure > ceiling.exposure_microusd {
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
            provider_billed: false,
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
        if state.status != TaskStatus::Active || self.expired() || attempt.status != "unknown" {
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
            || attempt.provider_billed
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
        Ok(())
    }

    /// Completes a provider-billed request with the provider's own cost, or leaves it awaiting `settle_provider`.
    pub fn settle_reported(
        &self,
        admission: &Admission,
        raw_usage: Option<Value>,
        microusd: Option<u64>,
    ) -> io::Result<()> {
        if admission.task != self.evidence
            || raw_usage.as_ref().is_some_and(|usage| !usage.is_object())
        {
            return Err(denied("invalid provider-reported identity or usage"));
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
            || attempt.provider_billed
        {
            return Err(denied("request settled or invalid raw usage"));
        }
        attempt.provider_billed = true;
        attempt.raw_usage = raw_usage;
        attempt.settled_microusd = microusd;
        attempt.status = if attempt.failure_reason.is_some() {
            "failed"
        } else {
            "completed"
        }
        .to_owned();
        self.record(
            &mut state,
            &serde_json::json!({"event": "request_provider_reported", "attempt": attempt}),
        )?;
        state.attempts.insert(admission.request, attempt);
        Ok(())
    }

    pub fn settle_provider(
        &self,
        request: u32,
        microusd: u64,
        source: &str,
    ) -> io::Result<Attempt> {
        if source.is_empty() || source.len() > 128 {
            return Err(denied("invalid settlement source"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        let mut attempt = state
            .attempts
            .get(&request)
            .cloned()
            .ok_or_else(|| denied("unknown request"))?;
        if !attempt.provider_billed || attempt.settled_microusd.is_some() {
            return Err(denied("request is not awaiting provider settlement"));
        }
        attempt.settled_microusd = Some(microusd);
        self.record(
            &mut state,
            &serde_json::json!({"event": "request_provider_settled", "source": source, "attempt": attempt}),
        )?;
        state.attempts.insert(request, attempt.clone());
        Ok(attempt)
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
        if state.status != TaskStatus::Paused {
            return Err(denied("task is not resumable"));
        }
        let ceiling = self.limits();
        let remaining_requests = ceiling.requests.saturating_sub(state.requests);
        let remaining_exposure = ceiling.exposure_microusd.saturating_sub(state.exposure);
        self.record(
            &mut state,
            &serde_json::json!({"event": "task_resumed", "reference": reference, "remaining": {"requests": remaining_requests, "exposure_microusd": remaining_exposure}}),
        )?;
        *self
            .started_unix_millis
            .lock()
            .map_err(|_| denied("task lock poisoned"))? = unix_millis()?;
        state.status = TaskStatus::Active;
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

    pub fn observe(
        &self,
        owner: &str,
        provider: &str,
        model: &str,
        raw_usage: Option<Value>,
        status: &str,
    ) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if state.observed.len() >= MAX_OBSERVED_REQUESTS {
            return Ok(());
        }
        let attempt = Attempt {
            request: u32::try_from(state.observed.len() + 1).unwrap_or(u32::MAX),
            owner: owner.chars().take(128).collect(),
            provider: provider.chars().take(64).collect(),
            model: model.chars().take(128).collect(),
            reserved_microusd: 0,
            status: format!("observed_{}", status.chars().take(32).collect::<String>()),
            failure_reason: None,
            raw_usage,
            settled_microusd: None,
            external_subscription: false,
            provider_billed: false,
        };
        self.record(
            &mut state,
            &serde_json::json!({"event": "request_observed", "attempt": attempt}),
        )?;
        state.observed.push(attempt);
        Ok(())
    }

    pub fn stop(&self) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        state.status = TaskStatus::Stopped;
        self.record(&mut state, &serde_json::json!({"event": "task_stopped"}))?;
        Ok(())
    }

    pub fn remaining(&self) -> io::Result<(Duration, u32, u64)> {
        let state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        Ok((
            Duration::from_millis(
                self.deadline_unix_millis()
                    .saturating_sub(unix_millis().unwrap_or(u128::MAX))
                    .min(u128::from(u64::MAX)) as u64,
            ),
            self.limits().requests.saturating_sub(state.requests),
            self.limits()
                .exposure_microusd
                .saturating_sub(state.exposure),
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
        Self::capture(&state, usize::MAX, state.observed.clone())
    }

    /// Totals over every attempt, but only the newest `attempts` cloned and observed requests counted, not copied.
    pub fn cost_summary(&self, attempts: usize) -> io::Result<(TaskCostCapture, usize)> {
        let state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        Ok((
            Self::capture(&state, attempts, Vec::new())?,
            state.observed.len(),
        ))
    }

    fn capture(
        state: &State,
        newest: usize,
        observed: Vec<Attempt>,
    ) -> io::Result<TaskCostCapture> {
        let all = || state.attempts.values();
        let settled_task_charge_microusd = all()
            .filter(|attempt| !attempt.external_subscription)
            .filter_map(|attempt| attempt.settled_microusd)
            .sum();
        let subscription_list_equivalent_microusd = all()
            .filter(|attempt| attempt.external_subscription)
            .filter_map(|attempt| attempt.settled_microusd)
            .sum();
        let retained_exposure_upper_bound_microusd = all().map(Attempt::exposure).sum();
        let raw_usage_attempts = all()
            .filter(|attempt| attempt.raw_usage.is_some())
            .count()
            .try_into()
            .map_err(|_| denied("raw usage attempt count overflow"))?;
        let uncertain_requests = all()
            .filter(|attempt| matches!(attempt.status.as_str(), "unknown" | "in_flight"))
            .map(|attempt| attempt.request)
            .collect();
        let attempts = all()
            .skip(state.attempts.len().saturating_sub(newest))
            .cloned()
            .collect();
        Ok(TaskCostCapture {
            schema: 1,
            attempts,
            observed,
            settled_task_charge_microusd,
            subscription_list_equivalent_microusd,
            retained_exposure_upper_bound_microusd,
            raw_usage_attempts,
            uncertain_requests,
        })
    }
}
