use super::*;
use codex_omd::peers::now_ms;
use codex_protocol::turn_input::StartIfIdleSubmission;
use codex_protocol::turn_input::TurnInputRequest;
use codex_protocol::user_input::UserInput;
use std::time::Duration;

const PRIORITIES: [&str; 3] = ["high", "normal", "low"];
const CONTINUATION_LIMIT: u32 = 4;
const IDLE_GRACE: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub(super) struct Entry {
    owner: String,
    source_sha256: String,
    event: String,
    key: String,
    prompt: String,
    priority: usize,
    deadline_ms: Option<u64>,
    queued_at_ms: u64,
    sequence: u64,
}

impl Entry {
    pub(super) fn view(&self) -> Value {
        json!({"key": self.key, "priority": PRIORITIES[self.priority], "event": self.event,
            "queued_at_ms": self.queued_at_ms, "deadline_ms": self.deadline_ms})
    }
}

fn message(entry: &Entry) -> String {
    format!(
        "[Queued by mod {} on {} (key {}); not typed by the user]\n{}",
        entry.owner, entry.event, entry.key, entry.prompt
    )
}

#[derive(Default)]
pub(super) struct Queue {
    entries: Vec<Entry>,
    paused: bool,
    sequence: u64,
    pub(super) started: BTreeMap<String, u32>,
    spent: BTreeMap<String, u64>,
    pub(super) running: Option<String>,
    submitting: Option<(String, Value)>,
    continued: BTreeMap<(String, String), u32>,
    dispatching: bool,
    woken: bool,
}

impl Queue {
    pub(super) fn pick(
        &mut self,
        grants: &BTreeMap<String, codex_omd::ModGrants>,
        now: u64,
        notices: &mut Vec<(String, Value)>,
    ) -> Option<Entry> {
        if self.paused || self.running.is_some() {
            return None;
        }
        let mut kept = Vec::new();
        for entry in self.entries.drain(..) {
            let grant = grants
                .get(&entry.owner)
                .filter(|grant| grant.source_sha256 == entry.source_sha256);
            let started = self.started.get(&entry.owner).copied().unwrap_or(0);
            let spent = self.spent.get(&entry.owner).copied().unwrap_or(0);
            let reason = match grant.map(|grant| grant.autonomy.as_ref()) {
                None => Some(("dropped", "stale_generation")),
                Some(None) => Some(("dropped", "grant_expired")),
                Some(Some(_)) if entry.deadline_ms.is_some_and(|deadline| deadline < now) => {
                    Some(("expired", "deadline_passed"))
                }
                Some(Some(autonomy)) if started >= autonomy.max_turns => {
                    Some(("denied", "turn_budget_exhausted"))
                }
                Some(Some(autonomy))
                    if autonomy.spend_microusd.is_some_and(|limit| spent >= limit) =>
                {
                    Some(("denied", "spend_budget_exhausted"))
                }
                Some(Some(_)) => None,
            };
            match reason {
                Some((status, reason)) => notices.push((
                    entry.owner.clone(),
                    json!({"key": entry.key, "status": status, "reason": reason}),
                )),
                None => kept.push(entry),
            }
        }
        self.entries = kept;
        let best = self
            .entries
            .iter()
            .enumerate()
            .min_by_key(|(_, entry)| (entry.priority, entry.sequence))
            .map(|(index, _)| index)?;
        let entry = self.entries.remove(best);
        self.running = Some(entry.owner.clone());
        self.dispatching = true;
        self.woken = false;
        self.submitting = Some((
            message(&entry),
            json!({"kind": "mod", "package": entry.owner, "sha256": entry.source_sha256,
                "event": entry.event, "key": entry.key}),
        ));
        Some(entry)
    }
}

#[derive(Default)]
pub(super) struct Queues {
    threads: Mutex<BTreeMap<String, Queue>>,
}

fn notify(core: &Arc<Core>, lead: &Lead, owner: String, payload: Value) {
    let (core, lead) = (core.clone(), lead.clone());
    tokio::spawn(async move {
        expansion::invoke_one(&core, &lead, owner, "turn_queue", payload).await;
    });
}

impl Queues {
    pub(super) fn with<T>(
        &self,
        thread: &str,
        change: impl FnOnce(&mut Queue) -> T,
    ) -> Result<T, String> {
        let mut threads = self.threads.lock().map_err(|_| "turn_queue_poisoned")?;
        Ok(change(threads.entry(thread.to_owned()).or_default()))
    }

    pub(super) fn call(
        &self,
        core: &Arc<Core>,
        lead: &Lead,
        caller: &operations::Caller<'_>,
        request: ModHostCall,
    ) -> Result<Value, String> {
        if lead.owner != "lead" {
            return Err("turn_queue_lead_only: agent threads cannot queue turns".into());
        }
        let autonomy = caller
            .grants
            .as_ref()
            .and_then(|grants| grants.autonomy.clone())
            .ok_or("grant_expired: autonomous")?;
        let thread = lead.thread.to_string();
        let arguments = &request.arguments;
        match request.operation.as_str() {
            "turns.queue" => {
                let prompt = arguments["prompt"]
                    .as_str()
                    .filter(|prompt| !prompt.trim().is_empty() && prompt.len() <= 8192)
                    .ok_or("turn_queue_prompt_limit")?;
                let key = arguments["key"]
                    .as_str()
                    .filter(|key| {
                        !key.is_empty()
                            && key.len() <= 64
                            && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
                    })
                    .ok_or("turn_queue_key_invalid")?;
                let priority = match arguments.get("priority").and_then(Value::as_str) {
                    None => 1,
                    Some(name) => PRIORITIES
                        .iter()
                        .position(|priority| *priority == name)
                        .ok_or("turn_queue_priority_invalid")?,
                };
                let deadline_ms = match arguments.get("deadline_ms").and_then(Value::as_u64) {
                    None => None,
                    Some(ms) if (1_000..=86_400_000).contains(&ms) => Some(now_ms() + ms),
                    Some(_) => return Err("turn_queue_deadline_invalid".into()),
                };
                let event = arguments["event"].as_str().unwrap_or("unknown").to_owned();
                let queued = self.with(&thread, |queue| {
                    if queue.entries.iter().any(|entry| entry.owner == caller.id && entry.key == key) {
                        return Ok(json!({"key": key, "status": "duplicate"}));
                    }
                    if queue.entries.iter().filter(|entry| entry.owner == caller.id).count()
                        >= autonomy.max_queued as usize
                    {
                        return Err("turn_queue_full".to_owned());
                    }
                    queue.sequence += 1;
                    queue.entries.push(Entry {
                        owner: caller.id.to_owned(),
                        source_sha256: caller.source.to_owned(),
                        event,
                        key: key.to_owned(),
                        prompt: prompt.to_owned(),
                        priority,
                        deadline_ms,
                        queued_at_ms: now_ms(),
                        sequence: queue.sequence,
                    });
                    Ok(json!({"key": key, "status": "queued", "paused": queue.paused}))
                })??;
                if queued["status"] == "queued" {
                    self.schedule(core, lead);
                }
                Ok(queued)
            }
            "turns.queued" => self.with(&thread, |queue| {
                json!({"paused": queue.paused, "started": queue.started.get(caller.id).copied().unwrap_or(0),
                    "spent_microusd": queue.spent.get(caller.id).copied().unwrap_or(0),
                    "entries": queue.entries.iter().filter(|entry| entry.owner == caller.id).map(Entry::view).collect::<Vec<_>>()})
            }),
            "turns.dequeue" => {
                let key = arguments["key"].as_str().ok_or("turn_queue_key_invalid")?;
                self.with(&thread, |queue| {
                    let before = queue.entries.len();
                    queue
                        .entries
                        .retain(|entry| !(entry.owner == caller.id && entry.key == key));
                    json!({"removed": queue.entries.len() < before})
                })
            }
            operation => Err(format!("unsupported_host_operation: {operation}")),
        }
    }

    pub(super) fn schedule(&self, core: &Arc<Core>, lead: &Lead) {
        let (core, lead) = (core.clone(), lead.clone());
        tokio::spawn(async move {
            tokio::time::sleep(IDLE_GRACE).await;
            core.autonomy.dispatch(&core, &lead).await;
        });
    }

    pub(super) async fn dispatch(&self, core: &Arc<Core>, lead: &Lead) {
        let thread = lead.thread.to_string();
        let grants = {
            let runtime = core.runtime.clone();
            tokio::task::spawn_blocking(move || {
                runtime
                    .lock()
                    .map(|runtime| {
                        runtime
                            .owners()
                            .into_iter()
                            .filter_map(|(id, _)| Some((id.clone(), runtime.grants(&id)?)))
                            .collect::<BTreeMap<_, _>>()
                    })
                    .unwrap_or_default()
            })
            .await
            .unwrap_or_default()
        };
        let mut notices = Vec::new();
        let picked = self.with(&thread, |queue| queue.pick(&grants, now_ms(), &mut notices));
        for (owner, payload) in notices {
            notify(core, lead, owner, payload);
        }
        let Ok(Some(entry)) = picked else {
            return;
        };
        let started = self.start(lead, &entry).await;
        let restore = |queue: &mut Queue| {
            queue.running = None;
            queue.submitting = None;
            queue.entries.push(entry.clone());
        };
        match started {
            Ok(Some(turn_id)) => {
                let _ = self.with(&thread, |queue| {
                    queue.dispatching = false;
                    *queue.started.entry(entry.owner.clone()).or_default() += 1;
                });
                notify(
                    core,
                    lead,
                    entry.owner.clone(),
                    json!({"key": entry.key, "status": "started", "turn_id": turn_id}),
                );
            }
            Ok(None) => {
                // A turn that ended while this dispatch was starting found the entry gone and did not reschedule.
                let missed = self.with(&thread, |queue| {
                    restore(queue);
                    queue.dispatching = false;
                    std::mem::take(&mut queue.woken) && !queue.paused
                });
                if missed == Ok(true) {
                    self.schedule(core, lead);
                }
            }
            Err(error) => {
                let _ = self.with(&thread, |queue| {
                    queue.running = None;
                    queue.submitting = None;
                    queue.dispatching = false;
                });
                notify(
                    core,
                    lead,
                    entry.owner.clone(),
                    json!({"key": entry.key, "status": "failed", "reason": error}),
                );
            }
        }
    }

    async fn start(&self, lead: &Lead, entry: &Entry) -> Result<Option<String>, String> {
        let manager = lead
            .host
            .manager
            .upgrade()
            .ok_or("native_thread_manager_stopped")?;
        let thread = manager
            .get_thread(lead.thread)
            .await
            .map_err(|e| e.to_string())?;
        let text = message(entry);
        let mut request = TurnInputRequest::user_input(vec![UserInput::Text {
            text,
            text_elements: vec![],
        }]);
        request.start.turn_trigger = Some(format!("mod:{}", entry.owner));
        match thread
            .start_turn_if_idle(request)
            .await
            .map_err(|e| e.to_string())?
        {
            StartIfIdleSubmission::Started { turn_id, .. } => Ok(Some(turn_id)),
            StartIfIdleSubmission::NotSubmitted { .. } => Ok(None),
        }
    }

    pub(super) fn running(&self, thread: &str) -> Option<String> {
        self.with(thread, |queue| queue.running.clone())
            .ok()
            .flatten()
    }

    /// Provenance of the mod prompt being submitted, taken once by the input carrying its text.
    pub(super) fn take_submitting(&self, thread: &str, text: &str) -> Option<Value> {
        self.with(thread, |queue| {
            if queue
                .submitting
                .as_ref()
                .is_some_and(|(expected, _)| expected == text)
            {
                queue.submitting.take().map(|(_, provenance)| provenance)
            } else {
                None
            }
        })
        .ok()
        .flatten()
    }

    pub(super) fn user_turn(&self, thread: &str) {
        let _ = self.with(thread, |queue| queue.paused = false);
    }

    pub(super) fn turn_ended(&self, core: &Arc<Core>, lead: &Lead, interrupted: bool) {
        let resume = self
            .with(&lead.thread.to_string(), |queue| {
                queue.continued.clear();
                if interrupted {
                    queue.paused = true;
                }
                if queue.dispatching {
                    queue.woken = true;
                    return false;
                }
                queue.running = None;
                !queue.paused && !queue.entries.is_empty()
            })
            .unwrap_or(false);
        if resume {
            self.schedule(core, lead);
        }
    }

    pub(super) fn charge(&self, thread: &str, response: &Value) {
        let Some(microusd) = response["cost"]["microusd"].as_u64() else {
            return;
        };
        if let Ok(mut threads) = self.threads.lock()
            && let Some(queue) = threads.get_mut(thread)
            && let Some(owner) = queue.running.clone()
        {
            *queue.spent.entry(owner).or_default() += microusd;
        }
    }

    pub(super) fn continue_turn(&self, thread: &str, turn: &str, owner: &str, limit: u32) -> bool {
        self.with(thread, |queue| {
            let used = queue
                .continued
                .entry((turn.to_owned(), owner.to_owned()))
                .or_default();
            if *used >= limit.min(CONTINUATION_LIMIT) {
                return false;
            }
            *used += 1;
            true
        })
        .unwrap_or(false)
    }
}

pub(super) const CONTINUATIONS: u32 = CONTINUATION_LIMIT;
