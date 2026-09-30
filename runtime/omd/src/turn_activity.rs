use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const ACTIVITY_READ_BYTES: u64 = 8 << 20;
pub const ACTIVITY_TOOL_CALLS: usize = 200;
pub const ACTIVITY_FILES: usize = 500;
pub const ACTIVITY_PROCESSES: usize = 100;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "record", rename_all = "snake_case")]
pub enum ActivityRecord {
    TurnStarted {
        turn_id: String,
        at: String,
    },
    TurnEnded {
        turn_id: String,
        at: String,
        outcome: String,
        reason: Option<String>,
    },
    ToolStarted {
        turn_id: String,
        call_id: String,
        tool: String,
        at: String,
    },
    ToolFinished {
        turn_id: String,
        call_id: String,
        at: String,
        outcome: String,
    },
    ProcessStarted {
        turn_id: String,
        id: String,
        kind: String,
        command: String,
        at: String,
    },
    ProcessExited {
        id: String,
        exit_code: Option<i32>,
        at: String,
    },
    FileChanged {
        turn_id: String,
        path: String,
        before: Option<String>,
        after: Option<String>,
        source: String,
    },
    ToolOutputReplaced {
        turn_id: String,
        call_id: String,
        r#mod: String,
        original_sha256: String,
        replacement_sha256: String,
    },
    Paused {
        at: String,
    },
}

pub struct TurnActivityLog {
    path: PathBuf,
}

fn valid_thread(thread: &str) -> bool {
    !thread.is_empty()
        && thread.len() <= 128
        && thread
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

impl TurnActivityLog {
    pub fn open(root: &Path, thread: &str) -> io::Result<Self> {
        if !valid_thread(thread) {
            return Err(io::Error::other("turn_activity_thread_invalid"));
        }
        Ok(Self {
            path: root.join(format!("{thread}.jsonl")),
        })
    }

    pub fn remove(&self) -> io::Result<()> {
        match fs::remove_file(&self.path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }

    pub fn append(&self, record: &ActivityRecord) -> io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut line = serde_json::to_vec(record).map_err(io::Error::other)?;
        line.push(b'\n');
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?
            .write_all(&line)
    }

    fn records(&self) -> io::Result<(Vec<ActivityRecord>, bool)> {
        let mut file = match fs::File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok((Vec::new(), false));
            }
            Err(error) => return Err(error),
        };
        let length = file.metadata()?.len();
        let clipped = length > ACTIVITY_READ_BYTES;
        if clipped {
            file.seek(SeekFrom::Start(length - ACTIVITY_READ_BYTES))?;
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let text = String::from_utf8_lossy(&bytes);
        let mut lines = text.lines();
        if clipped {
            lines.next();
        }
        Ok((
            lines
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect(),
            clipped,
        ))
    }

    pub fn read(
        &self,
        turn_id: Option<&str>,
        last: usize,
        running_turn: Option<&str>,
        live: &dyn Fn(&str) -> Option<bool>,
    ) -> io::Result<Value> {
        let (records, clipped) = self.records()?;
        let mut order: Vec<String> = Vec::new();
        let mut turns: BTreeMap<String, Turn> = BTreeMap::new();
        let mut process_turn: BTreeMap<String, String> = BTreeMap::new();
        for record in records {
            match record {
                ActivityRecord::TurnStarted { turn_id, at } => {
                    ensure(&mut turns, &mut order, &turn_id).started_at = Some(at);
                }
                ActivityRecord::TurnEnded {
                    turn_id,
                    at,
                    outcome,
                    reason,
                } => {
                    let entry = ensure(&mut turns, &mut order, &turn_id);
                    (entry.ended_at, entry.outcome, entry.reason) =
                        (Some(at), Some(outcome), reason);
                }
                ActivityRecord::ToolStarted {
                    turn_id,
                    call_id,
                    tool,
                    at,
                } => {
                    ensure(&mut turns, &mut order, &turn_id).tools.push(json!({"call_id": call_id, "tool": tool, "started_at": at, "finished_at": null, "outcome": null}));
                }
                ActivityRecord::ToolFinished {
                    turn_id,
                    call_id,
                    at,
                    outcome,
                } => {
                    if let Some(call) = ensure(&mut turns, &mut order, &turn_id)
                        .tools
                        .iter_mut()
                        .rev()
                        .find(|c| c["call_id"] == call_id.as_str())
                    {
                        (call["finished_at"], call["outcome"]) = (json!(at), json!(outcome));
                    }
                }
                ActivityRecord::ProcessStarted {
                    turn_id,
                    id: process,
                    kind,
                    command,
                    at: _,
                } => {
                    process_turn.insert(process.clone(), turn_id.clone());
                    ensure(&mut turns, &mut order, &turn_id).processes.push(json!({"id": process, "kind": kind, "command": command, "running": null, "exit_code": null}));
                }
                ActivityRecord::ProcessExited {
                    id: process,
                    exit_code,
                    at: _,
                } => {
                    if let Some(entry) = process_turn.get(&process).and_then(|t| turns.get_mut(t))
                        && let Some(slot) = entry
                            .processes
                            .iter_mut()
                            .rev()
                            .find(|p| p["id"] == process.as_str())
                    {
                        (slot["running"], slot["exit_code"]) = (json!(false), json!(exit_code));
                    }
                }
                ActivityRecord::FileChanged {
                    turn_id,
                    path,
                    before,
                    after,
                    source,
                } => {
                    ensure(&mut turns, &mut order, &turn_id).files.push(
                        json!({"path": path, "before": before, "after": after, "source": source}),
                    );
                }
                ActivityRecord::ToolOutputReplaced {
                    turn_id,
                    call_id,
                    r#mod,
                    original_sha256,
                    replacement_sha256,
                } => {
                    if let Some(call) = ensure(&mut turns, &mut order, &turn_id)
                        .tools
                        .iter_mut()
                        .rev()
                        .find(|c| c["call_id"] == call_id.as_str())
                    {
                        call["output_replaced"] = json!({"mod": r#mod,
                            "original_sha256": original_sha256, "replacement_sha256": replacement_sha256});
                    }
                }
                ActivityRecord::Paused { .. } => {
                    for entry in turns.values_mut().filter(|t| t.outcome.is_none()) {
                        entry.paused = true;
                    }
                }
            }
        }
        let selected: Vec<&String> = match turn_id {
            Some(id) => order.iter().filter(|t| t.as_str() == id).collect(),
            None => order.iter().rev().take(last.max(1)).rev().collect(),
        };
        let first = order.first().cloned();
        let items = selected
            .into_iter()
            .map(|id| {
                let entry = &turns[id];
                let (outcome, unrecorded_end) = match (&entry.outcome, entry.paused) {
                    (Some(outcome), _) => (outcome.clone(), false),
                    (None, _) if running_turn == Some(id.as_str()) => ("running".to_owned(), false),
                    (None, true) => ("unknown".to_owned(), false),
                    (None, false) => ("interrupted".to_owned(), true),
                };
                let processes: Vec<Value> = entry
                    .processes
                    .iter()
                    .map(|p| {
                        let mut p = p.clone();
                        if p["running"].is_null() {
                            p["running"] = live(p["id"].as_str().unwrap_or_default())
                                .map_or(Value::Null, Value::Bool);
                        }
                        p
                    })
                    .collect();
                let truncated = (clipped && first.as_deref() == Some(id.as_str()))
                    || entry.tools.len() > ACTIVITY_TOOL_CALLS
                    || entry.files.len() > ACTIVITY_FILES
                    || processes.len() > ACTIVITY_PROCESSES;
                json!({
                    "turn_id": id,
                    "started_at": entry.started_at,
                    "ended_at": entry.ended_at,
                    "outcome": outcome,
                    "reason": entry.reason,
                    "unrecorded_end": unrecorded_end,
                    "tool_calls": tail(&entry.tools, ACTIVITY_TOOL_CALLS),
                    "processes": tail(&processes, ACTIVITY_PROCESSES),
                    "files": tail(&entry.files, ACTIVITY_FILES),
                    "truncated": truncated,
                })
            })
            .collect();
        Ok(json!({ "turns": Value::Array(items) }))
    }
}

#[derive(Default)]
struct Turn {
    started_at: Option<String>,
    ended_at: Option<String>,
    outcome: Option<String>,
    reason: Option<String>,
    paused: bool,
    tools: Vec<Value>,
    processes: Vec<Value>,
    files: Vec<Value>,
}

fn ensure<'a>(
    turns: &'a mut BTreeMap<String, Turn>,
    order: &mut Vec<String>,
    id: &str,
) -> &'a mut Turn {
    if !turns.contains_key(id) {
        order.push(id.to_owned());
    }
    turns.entry(id.to_owned()).or_default()
}

fn tail(values: &[Value], limit: usize) -> Value {
    Value::Array(values[values.len().saturating_sub(limit)..].to_vec())
}

pub type Reader = std::sync::Arc<dyn Fn(&str, Value) -> Result<Value, String> + Send + Sync>;

static READER: std::sync::Mutex<(u64, Option<Reader>)> = std::sync::Mutex::new((0, None));

fn reader() -> std::sync::MutexGuard<'static, (u64, Option<Reader>)> {
    READER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[must_use]
pub struct ReaderRegistration(u64);

impl Drop for ReaderRegistration {
    fn drop(&mut self) {
        let mut slot = reader();
        if slot.0 == self.0 {
            slot.1 = None;
        }
    }
}

/// Lets in-process clients read the ledger through the session host that records it.
pub fn register_reader(read: Reader) -> ReaderRegistration {
    let mut slot = reader();
    slot.0 += 1;
    slot.1 = Some(read);
    ReaderRegistration(slot.0)
}

pub fn read_registered(thread: &str, arguments: Value) -> Result<Value, String> {
    let read = reader().1.clone().ok_or("turn_activity_unavailable")?;
    read(thread, arguments)
}

#[cfg(test)]
#[path = "turn_activity_tests.rs"]
mod tests;
