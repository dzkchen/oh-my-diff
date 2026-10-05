use super::*;
use std::collections::BTreeSet;

const ANSWER_CHARS: usize = 4096;
const FINISHED_LIMIT: usize = 64;

/// Session-wide agent records; observing one grants no control over it.
#[derive(Default)]
pub(super) struct Inventory {
    records: Mutex<BTreeMap<String, Value>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

impl Inventory {
    /// Records a started agent keyed by its thread and returns the record.
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
            let finished = records
                .iter()
                .filter(|(_, record)| record["status"] != "running")
                .map(|(thread, record)| (record["ended_at_ms"].as_u64(), thread.clone()))
                .collect::<BTreeSet<_>>();
            for (_, thread) in finished
                .iter()
                .take(finished.len().saturating_sub(FINISHED_LIMIT - 1))
            {
                records.remove(thread);
            }
            records.insert(thread.to_owned(), record.clone());
        }
        record
    }

    fn update(&self, thread: &str, change: impl FnOnce(&mut Value)) -> Option<Value> {
        let mut records = self.records.lock().ok()?;
        let record = records.get_mut(thread)?;
        change(record);
        Some(record.clone())
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

    pub(super) fn turn(&self, thread: &str, turn_id: &str, outcome: &str) -> Option<Value> {
        self.update(thread, |record| {
            record["turns"] = json!(record["turns"].as_u64().unwrap_or(0) + 1);
            record["last_turn"] = json!({"turn_id": turn_id, "outcome": outcome, "at_ms": now_ms(),
                "answer": record["answer"]});
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
            add(usage, "cached_tokens", tokens("/input_tokens_details/cached_tokens"));
            let priced = response["cost"]["microusd"].as_u64();
            add(usage, "microusd", priced);
            usage["basis"] = json!(match (usage["basis"].as_str(), priced) {
                (Some("unknown") | Some("settled"), Some(_)) => "settled",
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

    pub(super) fn list(&self) -> Vec<Value> {
        self.records
            .lock()
            .map(|records| records.values().cloned().collect())
            .unwrap_or_default()
    }
}

/// Publishes an `agent` lifecycle event to every observer.
pub(super) fn notify(runtime: &Arc<Mutex<ModHost>>, phase: &str, record: Value) {
    let runtime = runtime.clone();
    let payload = json!({"phase": phase, "agent": record});
    tokio::task::spawn_blocking(move || {
        if let Ok(mut runtime) = runtime.lock() {
            let _ = runtime.event("agent", payload);
        }
    });
}
