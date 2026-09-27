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

pub(super) async fn begin(mods: &Mods, lead: Option<Arc<Lead>>) -> Option<Cursor> {
    let (owners, generation) = {
        let runtime = mods.runtime.lock().ok()?;
        (
            runtime.subscribers_with_capability("turn_end", "turn_evidence"),
            runtime.generation(),
        )
    };
    if owners.is_empty() {
        return None;
    }
    let lead = lead?;
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
        usage_start: json!(lead.host.task.cost_capture().ok()),
    })
}

pub(super) async fn compact(mods: &Mods, lead: &Lead, before: bool) -> Result<(), String> {
    if !mods
        .turn
        .lock()
        .map_err(|_| "turn_record_poisoned")?
        .as_ref()
        .is_some_and(|turn| turn.evidence.is_some())
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
    let mut turn = mods.turn.lock().map_err(|_| "turn_record_poisoned")?;
    let Some(turn) = turn.as_mut() else {
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
    mods: &Mods,
    lead: &Lead,
    cursor: &Cursor,
    turn: &str,
    outcome: &str,
) -> Result<BTreeMap<String, Value>, String> {
    lead.host.authorize()?;
    let (owners, generation) = {
        let runtime = mods.runtime.lock().map_err(|_| "mod_runtime_poisoned")?;
        (
            runtime.subscribers_with_capability("turn_end", "turn_evidence"),
            runtime.generation(),
        )
    };
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
    let config = thread.config().await;
    let authority = crate::workspace_operations::WorkspaceAuthority::for_lead(lead).await?;
    let approved = lead
        .host
        .manifest
        .approved_untracked
        .iter()
        .cloned()
        .collect();
    let paths =
        codex_omd::tracked_paths(&authority.repository, &approved).map_err(|e| e.to_string())?;
    if paths
        .iter()
        .any(|path| !authority.readable(&authority.repository.join(path)))
    {
        return Err("evidence_source_permission_denied".into());
    }
    let snapshot = codex_omd::Snapshot::capture(
        &authority.repository,
        &paths,
        lead.host.manifest.snapshot_bytes,
    )
    .map_err(|e| e.to_string())?;
    let sha = snapshot.hash().map_err(|e| e.to_string())?;
    packet["workspace_sha256"] = json!(sha);
    packet["thread_id"] = json!(lead.thread.to_string());
    packet["outcome"] = json!(outcome);
    packet["tool_outcomes"] = json!(cursor.tools);
    packet["tool_outcomes_truncated"] = json!(cursor.tools.len() >= 128);
    packet["usage"] = lead.host.evidence(&format!("turn-usage-{}.json",crate::execution::hash(format!("{}:{turn}",lead.thread).as_bytes())),&json!({"scope":"task","before":cursor.usage_start,"after":lead.host.task.cost_capture().ok()}))?;
    let root = lead
        .host
        .manifest
        .mods
        .clone()
        .ok_or("mod_store_unavailable")?;
    let mut results = BTreeMap::new();
    for owner in owners
        .into_iter()
        .filter(|owner| cursor.owners.contains(owner))
    {
        lead.host.task.check_active().map_err(|e| e.to_string())?;
        let source = mods
            .runtime
            .lock()
            .map_err(|_| "mod_runtime_poisoned")?
            .owners()
            .into_iter()
            .find(|(id, _)| id == &owner)
            .ok_or("evidence_owner_unavailable")?
            .1
            .sha256;
        let data = codex_omd::scoped_data::ScopedDataHost::new(
            root.clone(),
            authority.repository.clone(),
            Some(config.codex_home.join("sessions").to_path_buf()),
            owner.clone(),
            lead.thread.to_string(),
            generation,
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
