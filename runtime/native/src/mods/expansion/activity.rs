use super::*;
use codex_omd::turn_activity::ActivityRecord;
use codex_omd::turn_activity::TurnActivityLog;

const EXEC_TOOLS: &[&str] = &["shell", "shell_command", "local_shell", "exec_command"];
const LIVE_COMMANDS: usize = 1024;
const HASH_BYTES: u64 = 8 * 1024 * 1024;

pub(in crate::mods) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn log(lead: &Lead) -> Option<TurnActivityLog> {
    TurnActivityLog::open(
        &lead.host.root.join("turn-activity"),
        &lead.thread.to_string(),
    )
    .ok()
}

fn running_turn(core: &Core, lead: &Lead) -> Option<String> {
    core.expansion
        .running
        .lock()
        .ok()?
        .get(&lead.thread.to_string())
        .cloned()
}

pub(in crate::mods) fn record(core: &Core, lead: &Lead, make: impl FnOnce(&str) -> ActivityRecord) {
    if lead.owner != "lead" || !core.expansion.recording.load(Ordering::Acquire) {
        return;
    }
    let Some(turn) = running_turn(core, lead) else {
        return;
    };
    if let Some(log) = log(lead)
        && let Err(error) = log.append(&make(&turn))
    {
        core.views
            .diagnostic(&core.host, "turn_activity", Some(error.to_string()));
    }
}

pub(in crate::mods) async fn turn_started(core: &Arc<Core>, lead: &Lead, turn_id: &str) {
    let refreshed = core.clone();
    let stopped = tokio::task::spawn_blocking(move || {
        refreshed
            .runtime
            .lock()
            .ok()
            .map(|runtime| refreshed.expansion.refresh(&runtime))
    })
    .await
    .ok()
    .flatten()
    .unwrap_or(false);
    let thread = lead.thread.to_string();
    if stopped && let Some(log) = log(lead) {
        let _ = log.append(&ActivityRecord::Paused { at: now() });
    }
    if let Ok(mut turns) = core.expansion.turns.lock() {
        *turns.entry(thread.clone()).or_default() += 1;
    }
    if let Ok(mut running) = core.expansion.running.lock() {
        running.insert(thread, turn_id.to_owned());
    }
    if let Ok(mut current) = core.expansion.current.lock() {
        *current = Some(LeadHandle::new(lead));
    }
    record(core, lead, |turn| ActivityRecord::TurnStarted {
        turn_id: turn.to_owned(),
        at: now(),
    });
}

pub(in crate::mods) fn turn_ended(
    core: &Core,
    lead: &Lead,
    outcome: &str,
    reason: Option<String>,
    error: Option<Value>,
) {
    record(core, lead, |turn| ActivityRecord::TurnEnded {
        turn_id: turn.to_owned(),
        at: now(),
        outcome: outcome.to_owned(),
        reason,
        error,
    });
    if let Ok(mut running) = core.expansion.running.lock() {
        running.remove(&lead.thread.to_string());
    }
}

fn command(arguments: &Value) -> String {
    let value = arguments
        .get("cmd")
        .or_else(|| arguments.get("command"))
        .unwrap_or(&Value::Null);
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    };
    text.chars().take(512).collect()
}

pub(in crate::mods) fn tool_started(
    core: &Core,
    lead: &Lead,
    call_id: &str,
    tool: &str,
    arguments: Option<&str>,
) {
    record(core, lead, |turn| ActivityRecord::ToolStarted {
        turn_id: turn.to_owned(),
        call_id: call_id.to_owned(),
        tool: tool.to_owned(),
        at: now(),
    });
    if EXEC_TOOLS.contains(&tool) && core.expansion.recording.load(Ordering::Acquire) {
        if let Ok(mut commands) = core.expansion.commands.lock()
            && commands.len() < LIVE_COMMANDS
        {
            commands.insert(call_id.to_owned());
        }
        let arguments = arguments
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .unwrap_or(Value::Null);
        record(core, lead, |turn| ActivityRecord::ProcessStarted {
            turn_id: turn.to_owned(),
            id: call_id.to_owned(),
            kind: "exec".to_owned(),
            command: command(&arguments),
            at: now(),
        });
    }
}

pub(in crate::mods) fn tool_finished(
    core: &Core,
    lead: &Lead,
    call_id: &str,
    tool: &str,
    outcome: &str,
) {
    record(core, lead, |turn| ActivityRecord::ToolFinished {
        turn_id: turn.to_owned(),
        call_id: call_id.to_owned(),
        at: now(),
        outcome: outcome.to_owned(),
    });
    if (tool != "exec_command" || outcome != "succeeded")
        && let Ok(mut commands) = core.expansion.commands.lock()
    {
        commands.remove(call_id);
    }
}

pub(in crate::mods) fn command_ended(core: &Core, lead: &Lead, call_id: &str, exit_code: i32) {
    if let Ok(mut commands) = core.expansion.commands.lock() {
        commands.remove(call_id);
    }
    if lead.owner != "lead" || !core.expansion.recording.load(Ordering::Acquire) {
        return;
    }
    if let Some(log) = log(lead) {
        let _ = log.append(&ActivityRecord::ProcessExited {
            id: call_id.to_owned(),
            exit_code: Some(exit_code),
            at: now(),
        });
    }
}

pub(in crate::mods) fn files(core: &Core, lead: &Lead, changes: &[Value], source: &str) {
    for change in changes
        .iter()
        .take(codex_omd::turn_activity::ACTIVITY_FILES)
    {
        let Some(path) = change["path"].as_str() else {
            continue;
        };
        let hash = |key: &str| change[key].as_str().map(str::to_owned);
        record(core, lead, |turn| ActivityRecord::FileChanged {
            turn_id: turn.to_owned(),
            path: path.to_owned(),
            before: hash("before"),
            after: hash("after"),
            source: source.to_owned(),
        });
    }
}

pub(in crate::mods) fn process_exited(core: &Core, lead: &Lead, owner: &str, session: &str) {
    if lead.owner != "lead" || !core.expansion.recording.load(Ordering::Acquire) {
        return;
    }
    if let Some(log) = log(lead) {
        let _ = log.append(&ActivityRecord::ProcessExited {
            id: format!("{owner}/{session}"),
            exit_code: None,
            at: now(),
        });
    }
}

pub(in crate::mods) fn output_replaced(
    core: &Core,
    lead: &Lead,
    call_id: &str,
    owner: &str,
    original: &str,
    replacement: &str,
) {
    record(core, lead, |turn| ActivityRecord::ToolOutputReplaced {
        turn_id: turn.to_owned(),
        call_id: call_id.to_owned(),
        r#mod: owner.to_owned(),
        original_sha256: crate::execution::hash(original.as_bytes()),
        replacement_sha256: crate::execution::hash(replacement.as_bytes()),
    });
}

pub(in crate::mods) const MAX_CHANGES: usize = 128;

pub(in crate::mods) fn visible_paths(
    root: &std::path::Path,
    paths: Vec<String>,
    include_ignored: bool,
    readable: impl Fn(&std::path::Path) -> bool,
) -> Vec<String> {
    let filter = codex_omd::watch_filter::WatchFilter::new(root);
    paths
        .into_iter()
        .filter(|path| include_ignored || !filter.ignored(root, path))
        .filter(|path| readable(&root.join(path)))
        .take(MAX_CHANGES)
        .collect()
}

pub(in crate::mods) fn file_hash(root: &std::path::Path, path: &str) -> Option<String> {
    let snapshot = codex_omd::Snapshot::capture(
        root,
        &std::collections::BTreeSet::from([path.to_owned()]),
        HASH_BYTES as usize,
    )
    .ok()?;
    let file = snapshot.files.get(path)?;
    Some(crate::execution::hash(&file.bytes))
}

pub(in crate::mods) async fn external_changes(
    core: &Core,
    lead: &Lead,
    paths: &[String],
    include_ignored: bool,
) -> Vec<Value> {
    let Ok(authority) = crate::workspace_operations::WorkspaceAuthority::for_lead(lead).await
    else {
        return Vec::new();
    };
    let root = lead.host.repository.clone();
    let paths = paths.to_vec();
    let changes = tokio::task::spawn_blocking(move || {
        visible_paths(&root, paths, include_ignored, |path| {
            authority.readable(path)
        })
        .into_iter()
        .map(|path| {
            let after = file_hash(&root, &path);
            json!({"path": path, "before": null, "after": after})
        })
        .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    files(core, lead, &changes, "external");
    changes
}

pub(in crate::mods) async fn read(
    core: &Core,
    lead: &Lead,
    arguments: Value,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(prepare(core, lead, arguments)?)
        .await
        .map_err(|error| error.to_string())?
}

pub(in crate::mods) fn prepare(
    core: &Core,
    lead: &Lead,
    arguments: Value,
) -> Result<impl FnOnce() -> Result<Value, String> + Send + 'static, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        #[serde(default)]
        thread_id: Option<String>,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        last: Option<usize>,
    }
    let input: Input = serde_json::from_value(if arguments.is_null() {
        json!({})
    } else {
        arguments
    })
    .map_err(|error| error.to_string())?;
    let thread = lead.thread.to_string();
    if input
        .thread_id
        .as_ref()
        .is_some_and(|requested| *requested != thread)
    {
        return Err("turn_activity_thread_out_of_scope".into());
    }
    let last = input.last.unwrap_or(1).clamp(1, 50);
    let log = log(lead).ok_or("turn_activity_unavailable")?;
    let running = running_turn(core, lead);
    let recording = core.expansion.recording.load(Ordering::Acquire);
    let processes = lead.session.processes.clone();
    let commands = core
        .expansion
        .commands
        .lock()
        .map(|commands| commands.clone())
        .unwrap_or_default();
    Ok(move || {
        let live = |id: &str| match id.split_once('/') {
            Some((owner, session)) => processes.running(owner, session),
            None => Some(commands.contains(id)),
        };
        let mut value = log
            .read(input.turn_id.as_deref(), last, running.as_deref(), &live)
            .map_err(|error| error.to_string())?;
        value["recording"] = Value::Bool(recording);
        Ok(value)
    })
}

pub(in crate::mods) async fn resume_payload(core: &Core, lead: &Lead) -> Value {
    let thread = lead.thread.to_string();
    let restarted = core
        .expansion
        .restarted
        .lock()
        .ok()
        .and_then(|restarted| restarted.get(&thread).copied())
        .unwrap_or(true);
    let last_turn = match log(lead) {
        Some(log) => tokio::task::spawn_blocking(move || {
            let value = log.read(None, 1, None, &|_| None).ok()?;
            let turn = value["turns"].as_array()?.last()?.clone();
            let status = match turn["outcome"].as_str()? {
                "completed" => "completed",
                "error" => "failed",
                "running" => "in_progress",
                _ => "interrupted",
            };
            Some(json!({"turn_id": turn["turn_id"], "status": status}))
        })
        .await
        .ok()
        .flatten(),
        None => None,
    };
    json!({"thread_id": thread, "last_turn": last_turn, "restarted": restarted})
}
