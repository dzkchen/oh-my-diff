use super::*;

pub(super) struct Cursor {
    revision: u64,
    prefix: Option<Value>,
    paused: bool,
    invalid: bool,
    offset: usize,
    generation: u64,
    owners: Vec<String>,
    pub tools: Vec<Value>,
    usage_start: Value,
}

fn subscribers(runtime: &ModHost) -> Vec<String> {
    let mut owners = runtime.subscribers_with_capability("turn_end", "sessions");
    owners.extend(runtime.subscribers_with_capability("turn_end", "turn_evidence"));
    owners.sort();
    owners.dedup();
    owners
}

pub(super) async fn begin(core: &Core, lead: &Lead) -> Option<Cursor> {
    let runtime = core.runtime.clone();
    let (owners, generation) = tokio::task::spawn_blocking(move || {
        let runtime = runtime.lock().ok()?;
        Some((subscribers(&runtime), runtime.generation()))
    })
    .await
    .ok()
    .flatten()?;
    if owners.is_empty() {
        return None;
    }
    let thread = lead
        .host
        .manager
        .upgrade()?
        .get_thread(lead.thread)
        .await
        .ok()?;
    let history = thread.conversation_history_snapshot().await;
    Some(Cursor {
        revision: history.review_history_version(),
        prefix: None,
        paused: false,
        invalid: false,
        offset: history.review_items().count(),
        generation,
        owners,
        tools: Vec::new(),
        usage_start: json!(lead.session.task.cost_capture().ok()),
    })
}

pub(super) async fn compact(
    lead: &Lead,
    turns: &Mutex<BTreeMap<String, TurnRecord>>,
    before: bool,
) -> Result<(), String> {
    let key = lead.thread.to_string();
    if turns
        .lock()
        .map_err(|_| "turn_record_poisoned")?
        .get(&key)
        .is_none_or(|turn| turn.evidence.is_none())
    {
        return Ok(());
    }
    let thread = lead
        .host
        .manager
        .upgrade()
        .ok_or("native_thread_manager_stopped")?
        .get_thread(lead.thread)
        .await
        .map_err(|error| error.to_string())?;
    let history = thread.conversation_history_snapshot().await;
    let mut turns = turns.lock().map_err(|_| "turn_record_poisoned")?;
    let Some(turn) = turns.get_mut(&key) else {
        return Ok(());
    };
    let Some(cursor) = turn.evidence.as_mut() else {
        return Ok(());
    };
    if before {
        if cursor.paused
            || history.review_history_version() != cursor.revision
            || history.review_items().count() < cursor.offset
        {
            cursor.invalid = true;
            return Err("evidence_history_changed".into());
        }
        let packet = codex_omd::turn_evidence::project(
            history
                .review_items()
                .skip(cursor.offset)
                .map(|item| serde_json::to_value(item).unwrap_or(Value::Null)),
            &turn.turn_id,
            cursor.revision,
        )
        .map_err(|error| error.to_string())?;
        cursor.prefix = Some(
            codex_omd::turn_evidence::combine(cursor.prefix.take(), packet)
                .map_err(|error| error.to_string())?,
        );
        cursor.paused = true;
    } else if cursor.paused {
        cursor.revision = history.review_history_version();
        cursor.offset = history.review_items().count();
        cursor.paused = false;
    } else {
        cursor.invalid = true;
    }
    Ok(())
}

pub(super) async fn finish(
    core: &Core,
    lead: &Lead,
    cursor: &Cursor,
    turn: &str,
    outcome: &str,
) -> Result<BTreeMap<String, Value>, String> {
    let runtime = core.runtime.clone();
    let (owners, generation, sources) = tokio::task::spawn_blocking(move || {
        let runtime = runtime.lock().map_err(|_| "mod_runtime_poisoned")?;
        Ok::<_, String>((
            subscribers(&runtime),
            runtime.generation(),
            runtime
                .owners()
                .into_iter()
                .map(|(id, owner)| (id, owner.sha256))
                .collect::<BTreeMap<_, _>>(),
        ))
    })
    .await
    .map_err(|e| e.to_string())??;
    if generation != cursor.generation {
        return Err("evidence_generation_changed".into());
    }
    let thread = lead
        .host
        .manager
        .upgrade()
        .ok_or("native_thread_manager_stopped")?
        .get_thread(lead.thread)
        .await
        .map_err(|e| e.to_string())?;
    let history = thread.conversation_history_snapshot().await;
    if cursor.paused
        || cursor.invalid
        || history.review_history_version() != cursor.revision
        || history.review_items().count() < cursor.offset
    {
        return Err("evidence_history_changed".into());
    }
    let mut packet = codex_omd::turn_evidence::project(
        history
            .review_items()
            .skip(cursor.offset)
            .map(|item| serde_json::to_value(item).unwrap_or(Value::Null)),
        turn,
        cursor.revision,
    )
    .map_err(|e| e.to_string())?;
    packet = codex_omd::turn_evidence::combine(cursor.prefix.clone(), packet)
        .map_err(|error| error.to_string())?;
    let sha = crate::workspace_operations::workspace_snapshot(lead)
        .await?
        .hash()
        .map_err(|e| e.to_string())?;
    packet["workspace_sha256"] = json!(sha);
    packet["thread_id"] = json!(lead.thread.to_string());
    packet["outcome"] = json!(outcome);
    packet["tool_outcomes"] = json!(cursor.tools);
    packet["tool_outcomes_truncated"] = json!(cursor.tools.len() >= 128);
    packet["usage"] = lead.session.evidence(
        &format!(
            "turn-usage-{}.json",
            crate::execution::hash(format!("{}:{turn}", lead.thread).as_bytes())
        ),
        &json!({"scope":"session","before":cursor.usage_start,"after":lead.session.task.cost_capture().ok()}),
    )?;
    let root = lead.host.root.clone();
    let mut results = BTreeMap::new();
    for owner in owners
        .into_iter()
        .filter(|owner| cursor.owners.contains(owner))
    {
        let source = sources
            .get(&owner)
            .cloned()
            .ok_or("evidence_owner_unavailable")?;
        let data = codex_omd::scoped_data::ScopedDataHost::new(
            root.clone(),
            lead.host.repository.clone(),
            None,
            None,
            owner.clone(),
            lead.thread.to_string(),
            source,
        )
        .map_err(|e| e.to_string())?;
        let reference = data
            .resources()
            .save("turn", packet.clone())
            .map_err(|e| e.to_string())?;
        results.insert(owner, json!({"evidence":reference}));
    }
    Ok(results)
}
