use super::*;
use codex_omd::peers::now_ms;
use std::collections::BTreeSet;

const ANSWER_CHARS: usize = 4096;
pub(super) const FINISHED_LIMIT: usize = 64;
const SPAWN_RESERVATION_MS: u64 = 30_000;

/// A tool-path reservation expires; a guarded one lasts until its guard releases it, however long setup takes.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum SpawnHold {
    Expiring,
    Guarded,
}

/// Session-wide agent records; observing one grants no control over it.
#[derive(Default)]
pub(super) struct Inventory {
    records: Mutex<BTreeMap<String, Value>>,
    working: Mutex<BTreeSet<String>>,
    /// Root, call id and reservation time (`None` while guarded).
    reserved: Mutex<Vec<(String, String, Option<u64>)>>,
    directory: std::sync::OnceLock<std::path::PathBuf>,
}

fn root_of<'a>(records: &'a BTreeMap<String, Value>, thread: &'a str) -> &'a str {
    let mut root = thread;
    for _ in 0..16 {
        match records
            .get(root)
            .and_then(|record| record["parent"]["thread_id"].as_str())
        {
            Some(parent) => root = parent,
            None => break,
        }
    }
    root
}

impl Inventory {
    pub(super) fn persist_to(&self, directory: std::path::PathBuf) {
        let day = std::time::Duration::from_secs(86_400);
        for entry in std::fs::read_dir(&directory)
            .into_iter()
            .flatten()
            .flatten()
        {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if (name.ends_with(".json") || name.starts_with(codex_omd::fsio::STAGING_PREFIX))
                && entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .is_ok_and(|modified| modified.elapsed().is_ok_and(|age| age > day))
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        let _ = self.directory.set(directory);
    }

    pub(super) fn forget_session(&self, thread: &str) {
        if let Ok(mut records) = self.records.lock() {
            let session = records
                .keys()
                .filter(|id| root_of(&records, id) == thread)
                .cloned()
                .collect::<Vec<_>>();
            let mut working = self.working.lock().ok();
            for id in session {
                records.remove(&id);
                if let Some(working) = working.as_mut() {
                    working.remove(&id);
                }
            }
        }
        if let Some(directory) = self.directory.get() {
            let _ = std::fs::remove_file(directory.join(format!("{thread}.json")));
        }
    }

    fn snapshot(
        &self,
        records: &BTreeMap<String, Value>,
        thread: &str,
    ) -> Option<(String, Vec<Value>)> {
        self.directory.get()?;
        let root = root_of(records, thread);
        if root == thread {
            return None;
        }
        let agents = records
            .iter()
            .filter(|(id, _)| id.as_str() != root && root_of(records, id) == root)
            .map(|(_, record)| {
                let mut record = record.clone();
                record["answer"] = Value::Null;
                if record["last_turn"].is_object() {
                    record["last_turn"]["answer"] = Value::Null;
                }
                record
            })
            .collect();
        Some((root.to_owned(), agents))
    }

    fn save(&self, snapshot: Option<(String, Vec<Value>)>) {
        let (Some(directory), Some((root, agents))) = (self.directory.get(), snapshot) else {
            return;
        };
        if let Ok(bytes) = serde_json::to_vec(&agents)
            && std::fs::create_dir_all(directory).is_ok()
        {
            let _ = codex_omd::fsio::write_bytes(
                &directory.join(format!("{root}.json")),
                &bytes,
                codex_omd::fsio::Durability::Volatile,
            );
        }
    }

    pub(super) fn start(&self, thread: &str, fields: Value) -> Value {
        let mut record = json!({"agent_id": null, "thread_id": thread,
            "parent": {"thread_id": null, "agent_id": null}, "origin": "native", "owner": null,
            "definition": null, "role": null, "status": "running", "started_at_ms": now_ms(),
            "ended_at_ms": null, "duration_ms": null, "turns": 0, "last_turn": null, "answer": null,
            "usage": {"requests": 0, "input_tokens": 0, "output_tokens": 0, "cached_tokens": 0,
                "microusd": 0, "basis": "unknown", "source": null}, "reason": null});
        if let (Some(record), Some(fields)) = (record.as_object_mut(), fields.as_object()) {
            record.extend(fields.clone());
        }
        if let Ok(mut records) = self.records.lock() {
            let parents = records
                .values()
                .chain([&record])
                .filter_map(|record| record["parent"]["thread_id"].as_str())
                .map(str::to_owned)
                .collect::<BTreeSet<_>>();
            let finished = records
                .iter()
                .filter(|(id, record)| record["status"] != "running" && !parents.contains(*id))
                .map(|(thread, record)| (record["ended_at_ms"].as_u64(), thread.clone()))
                .collect::<BTreeSet<_>>();
            for (_, thread) in finished
                .iter()
                .take(finished.len().saturating_sub(FINISHED_LIMIT - 1))
            {
                records.remove(thread);
            }
            records.insert(thread.to_owned(), record.clone());
            let snapshot = self.snapshot(&records, thread);
            drop(records);
            self.save(snapshot);
        }
        record
    }

    fn update(&self, thread: &str, change: impl FnOnce(&mut Value)) -> Option<Value> {
        let mut records = self.records.lock().ok()?;
        let record = records.get_mut(thread)?;
        change(record);
        let record = record.clone();
        let snapshot = self.snapshot(&records, thread);
        drop(records);
        self.save(snapshot);
        Some(record)
    }

    pub(super) fn describe(
        &self,
        thread: &str,
        provider: &str,
        model: &str,
        billing: Option<&str>,
    ) {
        self.update(thread, |record| {
            record["provider"] = json!(provider);
            record["model"] = json!(model);
            record["billing"] = json!(billing);
        });
    }

    pub(super) fn turn_started(&self, thread: &str) {
        if let Ok(records) = self.records.lock()
            && records.contains_key(thread)
            && let Ok(mut working) = self.working.lock()
        {
            working.insert(thread.to_owned());
        }
    }

    /// Admits a model spawn against live children plus spawns admitted but not yet started.
    pub(super) fn reserve_spawn(
        &self,
        root: &str,
        call_id: &str,
        hold: SpawnHold,
        counted: impl Fn(&str) -> bool,
        admit: impl FnOnce(usize) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut reserved = self
            .reserved
            .lock()
            .map_err(|_| "inventory lock poisoned")?;
        let now = now_ms();
        reserved
            .retain(|(.., at)| at.is_none_or(|at| now.saturating_sub(at) < SPAWN_RESERVATION_MS));
        let pending = reserved.iter().filter(|(owner, ..)| owner == root).count();
        admit(self.live_children(root, counted) + pending)?;
        reserved.push((
            root.to_owned(),
            call_id.to_owned(),
            (hold == SpawnHold::Expiring).then_some(now),
        ));
        Ok(())
    }

    pub(super) fn release_spawn(&self, call_id: &str) {
        if let Ok(mut reserved) = self.reserved.lock() {
            reserved.retain(|(_, call, _)| call != call_id);
        }
    }

    /// Model-spawned children of `root`'s session that are running a turn or have not yet finished their first.
    pub(super) fn live_children(&self, root: &str, counted: impl Fn(&str) -> bool) -> usize {
        let (Ok(records), Ok(working)) = (self.records.lock(), self.working.lock()) else {
            return 0;
        };
        records
            .iter()
            .filter(|(thread, record)| {
                record["origin"] == "model"
                    && record["status"] == "running"
                    && (record["last_turn"].is_null() || working.contains(thread.as_str()))
                    && root_of(&records, thread) == root
                    && counted(thread)
            })
            .count()
    }

    pub(super) fn contains(&self, thread: &str) -> bool {
        self.records
            .lock()
            .is_ok_and(|records| records.contains_key(thread))
    }

    pub(super) fn answer(&self, thread: &str, text: &str) {
        self.update(thread, |record| {
            record["answer"] = json!(text.chars().take(ANSWER_CHARS).collect::<String>());
        });
    }

    pub(super) fn turn(
        &self,
        thread: &str,
        turn_id: &str,
        outcome: &str,
        error: Value,
    ) -> Option<Value> {
        if let Ok(mut working) = self.working.lock() {
            working.remove(thread);
        }
        self.update(thread, |record| {
            record["turns"] = json!(record["turns"].as_u64().unwrap_or(0) + 1);
            record["last_turn"] = json!({"turn_id": turn_id, "outcome": outcome, "at_ms": now_ms(),
                "answer": record["answer"], "error": error});
        })
    }

    /// Adds one `model_response` report to its thread's usage; unpriced spend makes the total partial.
    pub(super) fn usage(&self, response: &Value) {
        let Some(thread) = response["scope"]["thread_id"].as_str() else {
            return;
        };
        let tokens = |pointer: &str| response["usage"].pointer(pointer).and_then(Value::as_u64);
        self.update(thread, |record| {
            let usage = &mut record["usage"];
            if usage["source"] != "accounting" {
                *usage = json!({"requests": 0, "input_tokens": 0, "output_tokens": 0,
                    "cached_tokens": 0, "microusd": 0, "basis": "unknown", "source": "accounting"});
            }
            let add = |usage: &mut Value, key: &str, amount: Option<u64>| {
                usage[key] = json!(usage[key].as_u64().unwrap_or(0) + amount.unwrap_or(0));
            };
            add(usage, "requests", Some(1));
            add(usage, "input_tokens", tokens("/input_tokens"));
            add(usage, "output_tokens", tokens("/output_tokens"));
            add(
                usage,
                "cached_tokens",
                tokens("/input_tokens_details/cached_tokens"),
            );
            let priced = response["cost"]["microusd"].as_u64();
            add(usage, "microusd", priced);
            let first = usage["requests"] == 1;
            usage["basis"] = json!(match (usage["basis"].as_str(), priced) {
                (Some("unknown"), None) => "unknown",
                (Some("unknown"), Some(_)) if first => "settled",
                (Some("settled"), Some(_)) => "settled",
                _ => "partial",
            });
        });
    }

    /// Engine token totals for agents whose requests bypass OMD accounting; cost stays unknown.
    pub(super) fn tokens(&self, thread: &str, total: &codex_protocol::protocol::TokenUsage) {
        self.update(thread, |record| {
            if record["usage"]["source"] == "accounting" {
                return;
            }
            let count = |value: i64| u64::try_from(value).unwrap_or(0);
            record["usage"] = json!({"requests": null, "input_tokens": count(total.input_tokens),
                "output_tokens": count(total.output_tokens), "cached_tokens": count(total.cached_input_tokens),
                "microusd": null, "basis": "unknown", "source": "engine"});
        });
    }

    pub(super) fn end(&self, thread: &str, status: &str, reason: Option<String>) -> Option<Value> {
        if let Ok(mut working) = self.working.lock() {
            working.remove(thread);
        }
        self.update(thread, |record| {
            if record["status"] != "running" {
                return;
            }
            let ended = now_ms();
            record["status"] = json!(status);
            record["reason"] = json!(reason);
            record["ended_at_ms"] = json!(ended);
            record["duration_ms"] =
                json!(ended.saturating_sub(record["started_at_ms"].as_u64().unwrap_or(ended)));
        })
        .filter(|record| record["reason"] == json!(reason) && record["status"] == status)
    }

    /// The session thread at the root of `thread`'s parent chain; a thread without an agent record is its own root.
    pub(super) fn root_thread(&self, thread: &str) -> String {
        let Ok(records) = self.records.lock() else {
            return thread.to_owned();
        };
        root_of(&records, thread).to_owned()
    }

    pub(super) fn list(&self) -> Vec<Value> {
        self.records
            .lock()
            .map(|records| records.values().cloned().collect())
            .unwrap_or_default()
    }
}

/// Publishes an `agent` lifecycle event to every observer, in order, under the session thread's state.
pub(super) fn notify(
    runtime: &Arc<Mutex<ModHost>>,
    inventory: &Inventory,
    phase: &str,
    record: Value,
) {
    type Delivery = (Arc<Mutex<ModHost>>, Option<String>, Value);
    static QUEUE: std::sync::OnceLock<std::sync::mpsc::Sender<Delivery>> =
        std::sync::OnceLock::new();
    let queue = QUEUE.get_or_init(|| {
        let (sender, receiver) = std::sync::mpsc::channel::<Delivery>();
        std::thread::spawn(move || {
            for (runtime, thread, payload) in receiver {
                let _thread = codex_omd::StateThread::enter(thread);
                if let Ok(mut runtime) = runtime.lock() {
                    let _ = runtime.event("agent", payload);
                }
            }
        });
        sender
    });
    let thread = record["parent"]["thread_id"]
        .as_str()
        .map(|parent| inventory.root_thread(parent));
    let _ = queue.send((
        runtime.clone(),
        thread,
        json!({"phase": phase, "agent": record}),
    ));
}
