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

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Limits {
    pub requests: u32,
    pub exposure_microusd: u64,
    pub seconds: u64,
    pub concurrent_workers: u32,
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
    limits: WorkerLimits,
    started: Instant,
    requests: u32,
    exposure: u64,
    active: bool,
}

struct State {
    stopped: bool,
    contributor_authorized: bool,
    requests: u32,
    exposure: u64,
    sequence: u64,
    attempts: BTreeMap<u32, Attempt>,
    failures: BTreeMap<u32, Failure>,
    escalated_failures: BTreeSet<u32>,
    escalations: u32,
    workers: BTreeMap<String, Worker>,
}

pub struct Task {
    limits: Limits,
    started: Instant,
    evidence: PathBuf,
    state: Mutex<State>,
}

fn denied(message: &str) -> io::Error {
    io::Error::other(message)
}

impl Task {
    pub fn create(limits: Limits, evidence: PathBuf) -> io::Result<Self> {
        if limits.requests == 0 || limits.seconds == 0 || limits.concurrent_workers == 0 {
            return Err(denied("task limits must be positive"));
        }
        fs::create_dir(&evidence)?;
        let evidence = evidence.canonicalize()?;
        let task = Self {
            limits,
            started: Instant::now(),
            evidence,
            state: Mutex::new(State {
                stopped: false,
                contributor_authorized: false,
                requests: 0,
                exposure: 0,
                sequence: 0,
                attempts: BTreeMap::new(),
                failures: BTreeMap::new(),
                escalated_failures: BTreeSet::new(),
                escalations: 0,
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

    fn record(&self, state: &mut State, event: &Value) -> io::Result<()> {
        state.sequence += 1;
        let result = (|| {
            let bytes = serde_json::to_vec(&serde_json::json!({
                "sequence": state.sequence,
                "elapsed_millis": self.started.elapsed().as_millis(),
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
            state.stopped = true;
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

    pub fn start_worker(&self, id: String, limits: WorkerLimits) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        if id.is_empty() || id.len() > 128 || id == "lead" || state.workers.contains_key(&id) {
            return Err(denied("invalid or reused worker identity"));
        }
        if state.stopped || self.started.elapsed().as_secs() >= self.limits.seconds {
            return Err(denied("task stopped or expired"));
        }
        if limits.requests == 0
            || limits.seconds == 0
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
            &serde_json::json!({"event": "worker_started", "worker": id, "limits": limits}),
        )?;
        state.workers.insert(
            id,
            Worker {
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
        if state.stopped || self.started.elapsed().as_secs() >= self.limits.seconds {
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
        if state.stopped
            || self.started.elapsed().as_secs() >= self.limits.seconds
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
            state.stopped = true;
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
        if state.stopped || self.started.elapsed().as_secs() >= self.limits.seconds {
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
        if state.stopped || self.started.elapsed().as_secs() >= self.limits.seconds {
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
            Duration::from_secs(self.limits.seconds).saturating_sub(self.started.elapsed()),
            self.limits.requests.saturating_sub(state.requests),
            self.limits.exposure_microusd.saturating_sub(state.exposure),
        );
        if state.stopped || remaining.0.is_zero() {
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

    pub fn stop(&self) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        state.stopped = true;
        self.record(&mut state, &serde_json::json!({"event": "task_stopped"}))
    }

    pub fn remaining(&self) -> io::Result<(Duration, u32, u64)> {
        let state = self
            .state
            .lock()
            .map_err(|_| denied("task lock poisoned"))?;
        Ok((
            Duration::from_secs(self.limits.seconds).saturating_sub(self.started.elapsed()),
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
