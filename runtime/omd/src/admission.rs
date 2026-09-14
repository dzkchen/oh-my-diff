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

#[derive(Clone, Debug, Deserialize, Serialize)]
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
    active: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TaskStatus {
    Active,
    Paused,
    Stopped,
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
    workers: BTreeMap<String, Worker>,
}

pub struct Task {
    limits: Limits,
    started: Instant,
    deadline_unix_millis: u128,
    evidence: PathBuf,
    state: Mutex<State>,
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
    pub fn create(limits: Limits, evidence: PathBuf) -> io::Result<Self> {
        if limits.requests == 0
            || limits.seconds == 0
            || limits.concurrent_workers == 0
            || limits.max_depth == 0
        {
            return Err(denied("task limits must be positive"));
        }
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
                workers: BTreeMap::new(),
            }),
        };
        let mut state = task
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        task.record(
            &mut state,
            &serde_json::json!({"event": "created", "limits": task.limits}),
        )?;
        drop(state);
        Ok(task)
    }

    pub fn open(
        limits: Limits,
        evidence: PathBuf,
        explicit_resume: Option<&str>,
    ) -> io::Result<Self> {
        if !evidence.exists() {
            if explicit_resume.is_some() {
                return Err(denied("explicit resume has no prior task evidence"));
            }
            return Self::create(limits, evidence);
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
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.len() == 13 && name.ends_with(".json"))
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
            workers: BTreeMap::new(),
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
                    if state.sequence != 1 || recorded != limits {
                        return Err(denied("resume limits differ from original task"));
                    }
                }
                Some("contributor_authorization") => {
                    state.contributor_authorized = record["authorized"].as_bool().unwrap_or(false);
                }
                Some("worker_started") => {
                    let id = record["worker"]
                        .as_str()
                        .ok_or_else(|| denied("worker identity missing"))?
                        .to_owned();
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
                            active: true,
                        },
                    );
                }
                Some("worker_stopped") => {
                    if let Some(worker) = record["worker"]
                        .as_str()
                        .and_then(|id| state.workers.get_mut(id))
                    {
                        worker.active = false;
                    }
                }
                Some("request_admitted")
                | Some("request_dispatched")
                | Some("request_failed")
                | Some("request_settled")
                | Some("raw_usage_observed") => {
                    let attempt: Attempt = serde_json::from_value(record["attempt"].clone())?;
                    state.attempts.insert(attempt.request, attempt);
                }
                Some("failure_recorded") => {
                    let failure: Failure = serde_json::from_value(record["failure"].clone())?;
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
                    state
                        .failure_fingerprints
                        .insert(fingerprint.to_owned(), count);
                }
                Some("loop_reassessed") => state.reassessments += 1,
                Some("task_paused") => state.status = TaskStatus::Paused,
                Some("task_resumed") => state.status = TaskStatus::Active,
                Some("reservation_violation") => {
                    let attempt: Attempt = serde_json::from_value(record["attempt"].clone())?;
                    state.attempts.insert(attempt.request, attempt);
                    state.status = TaskStatus::Stopped;
                }
                Some("task_stopped") => {
                    state.status = TaskStatus::Stopped;
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
            worker.active = false;
        }
        if state.status == TaskStatus::Stopped {
            return Err(denied("stopped task cannot resume"));
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
        };
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
        if id.is_empty() || id.len() > 128 || id == "lead" || state.workers.contains_key(&id) {
            return Err(denied("invalid or reused worker identity"));
        }
        if state.status != TaskStatus::Active || self.expired() {
            return Err(denied("task stopped or expired"));
        }
        let valid_parent = if depth == 1 {
            parent == "lead"
        } else {
            state
                .workers
                .get(&parent)
                .is_some_and(|worker| worker.active && worker.depth.checked_add(1) == Some(depth))
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
                .filter(|worker| worker.active)
                .count()
                >= self.limits.concurrent_workers as usize
        {
            return Err(denied("worker limits exceed task ceiling or capacity"));
        }
        self.record(
            &mut state,
            &serde_json::json!({"event": "worker_started", "worker": id, "parent": parent, "depth": depth, "limits": limits}),
        )?;
        state.workers.insert(
            id,
            Worker {
                parent,
                depth,
                limits,
                started: Instant::now(),
                requests: 0,
                exposure: 0,
                active: true,
            },
        );
        Ok(())
    }

    pub fn finish_worker(&self, id: &str) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if !state.workers.get(id).is_some_and(|worker| worker.active) {
            return Err(denied("unknown or inactive worker"));
        }
        if state
            .workers
            .values()
            .any(|worker| worker.active && worker.parent == id)
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
            .active = false;
        Ok(())
    }

    pub fn admit(
        &self,
        owner: &str,
        provider: &str,
        model: &str,
        exposure_microusd: u64,
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
            _ => false,
        };
        if !allowed {
            return Err(denied(
                "provider/model or Contributor data authorization denied",
            ));
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
            if !worker.active
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
                worker.active && worker.started.elapsed().as_secs() < worker.limits.seconds
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
            .filter(|(_, worker)| worker.active)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        self.record(
            &mut state,
            &serde_json::json!({"event": "task_paused", "reason": reason, "active_workers": active_workers, "uncertain_operations": uncertain_operations}),
        )?;
        state.status = TaskStatus::Paused;
        for worker in state.workers.values_mut() {
            worker.active = false;
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
        self.record(&mut state, &serde_json::json!({"event": "task_stopped"}))
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
}
