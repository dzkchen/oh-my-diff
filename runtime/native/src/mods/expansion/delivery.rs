use super::*;
use crate::managed_process::ProcessNotice;

const DELIVERIES_PER_ROUND: usize = 64;

pub(in crate::mods) enum Pending {
    Process {
        thread: ThreadId,
        owner: String,
        session: String,
        bytes: Option<usize>,
    },
    Watch {
        thread: ThreadId,
        owner: String,
        watch: String,
        paths: Vec<String>,
        include_ignored: bool,
    },
    Broadcast {
        event: &'static str,
        payload: Value,
    },
    Timer {
        thread: ThreadId,
        owner: String,
        key: String,
    },
}

pub(super) fn push(state: &State, pending: Pending) {
    if let Ok(mut queue) = state.pending.lock() {
        if let (
            Pending::Process {
                thread,
                owner,
                session,
                bytes: Some(bytes),
            },
            Some(Pending::Process {
                thread: last_thread,
                owner: last_owner,
                session: last_session,
                bytes: Some(total),
            }),
        ) = (&pending, queue.back_mut())
            && thread == last_thread
            && owner == last_owner
            && session == last_session
        {
            *total = total.saturating_add(*bytes);
        } else if queue.len() < 1024 {
            queue.push_back(pending);
        } else {
            state.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
    state.wake.notify_one();
}

pub(in crate::mods) fn lead_started(core: &Arc<Core>, lead: &Lead, forked: Option<ThreadId>) {
    let state = &core.expansion;
    let _ = state.core.set(Arc::downgrade(core));
    let thread = lead.thread.to_string();
    if let Ok(mut restarted) = state.restarted.lock() {
        let seen = restarted.contains_key(&thread);
        restarted.insert(thread.clone(), !seen);
    }
    if let Ok(mut current) = state.current.lock() {
        *current = Some(LeadHandle::new(lead));
    }
    if let Ok(mut leads) = state.leads.lock() {
        leads.retain(|_, handle| handle.session.strong_count() > 0);
        leads.insert(lead.thread, LeadHandle::new(lead));
    }
    let weak = Arc::downgrade(core);
    let handle = LeadHandle::new(lead);
    lead.session
        .processes
        .set_notifier(Arc::new(move |notice: ProcessNotice| {
            let Some(core) = weak.upgrade() else {
                return;
            };
            if notice.exited
                && let Some(lead) = handle.upgrade()
            {
                super::activity::process_exited(&core, &lead, &notice.owner, &notice.session);
            }
            if notice.deliver {
                push(
                    &core.expansion,
                    Pending::Process {
                        thread: handle.thread,
                        owner: notice.owner,
                        session: notice.session,
                        bytes: notice.output_bytes,
                    },
                );
            }
        }));
    if let Some(parent) = forked
        && let Err(error) =
            codex_omd::data_store::fork_thread_data(&lead.host.root, &parent.to_string(), &thread)
        && !error.to_string().starts_with("store_thread_exists")
    {
        core.views.diagnostic(
            &core.host,
            "thread_store",
            Some(format!("fork copy failed: {error}")),
        );
    }
    let runtime = core.runtime.clone();
    let refresh = Arc::downgrade(core);
    tokio::spawn(async move {
        let _ = tokio::task::spawn_blocking(move || {
            if let (Some(core), Ok(runtime)) = (refresh.upgrade(), runtime.lock()) {
                core.expansion.refresh(&runtime);
            }
        })
        .await;
    });
    ensure_delivery(core);
}

fn ensure_delivery(core: &Arc<Core>) {
    let Ok(mut delivery) = core.expansion.delivery.lock() else {
        return;
    };
    if delivery
        .as_ref()
        .is_some_and(|current| !current.task.is_finished())
    {
        return;
    }
    let wake = core.expansion.wake.clone();
    let signal = wake.clone();
    let registration =
        codex_omd::client_surface::register_wake(Arc::new(move || signal.notify_one()));
    let reader = Arc::downgrade(core);
    let activity = codex_omd::turn_activity::register_reader(Arc::new(move |thread, arguments| {
        let core = reader.upgrade().ok_or("turn_activity_unavailable")?;
        let lead = ThreadId::from_string(thread)
            .ok()
            .and_then(|thread| core.expansion.lead(thread))
            .ok_or("turn_activity_unavailable")?;
        super::activity::prepare(&core, &lead, arguments)?()
    }));
    let weak = Arc::downgrade(core);
    let task = tokio::spawn(async move {
        loop {
            wake.notified().await;
            let Some(core) = weak.upgrade() else {
                return;
            };
            if deliver(&core).await {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                core.expansion.wake.notify_one();
            }
        }
    });
    *delivery = Some(Delivery {
        task,
        _wake: registration,
        _activity: activity,
    });
}

pub(super) async fn deliver(core: &Arc<Core>) -> bool {
    let dropped = core.expansion.dropped.swap(0, Ordering::Relaxed);
    if dropped > 0 {
        core.views.diagnostic(
            &core.host,
            "delivery",
            Some(format!(
                "{dropped} background events dropped at the queue limit"
            )),
        );
    }
    let current = core.expansion.current();
    let mut budget = DELIVERIES_PER_ROUND;
    while budget > 0 {
        let next = core
            .expansion
            .pending
            .lock()
            .ok()
            .and_then(|mut queue| queue.pop_front());
        let Some(next) = next else {
            break;
        };
        budget -= 1;
        match next {
            Pending::Process {
                thread,
                owner,
                session,
                bytes,
            } => {
                let Some(lead) = core.expansion.thread(thread) else {
                    continue;
                };
                let payload = match bytes {
                    Some(bytes) => json!({"session": session, "kind": "output", "bytes": bytes}),
                    None => {
                        json!({"session": session, "kind": "exit"})
                    }
                };
                invoke_one(core, &lead, owner, "process_event", payload).await;
            }
            Pending::Watch {
                thread,
                owner,
                watch,
                paths,
                include_ignored,
            } => {
                let Some(lead) = core.expansion.thread(thread) else {
                    continue;
                };
                let changes =
                    super::activity::external_changes(core, &lead, &paths, include_ignored).await;
                if changes.is_empty() {
                    continue;
                }
                let payload = json!({"repository": lead.host.repository, "source": "external",
                    "call_id": null, "watch_id": watch, "changes": changes, "status": "observed", "reason": null});
                invoke_one(core, &lead, owner, "workspace_change", payload).await;
            }
            Pending::Broadcast { event, payload } => {
                core.event(event, payload, current.as_ref()).await;
            }
            Pending::Timer { thread, owner, key } => {
                let Some(lead) = core.expansion.thread(thread) else {
                    continue;
                };
                invoke_one(core, &lead, owner, "timer", json!({"key": key})).await;
            }
        }
    }
    let ids = sync_bus(core);
    for id in ids {
        if budget == 0 {
            break;
        }
        let events = codex_omd::event_bus::global()
            .lock()
            .map(|mut bus| bus.drain(&id, budget))
            .unwrap_or_default();
        for event in events {
            budget -= 1;
            let Some(lead) = ThreadId::from_string(&event.thread)
                .ok()
                .and_then(|thread| core.expansion.thread(thread))
            else {
                continue;
            };
            let payload = json!({"publisher": event.publisher, "channel": event.channel,
                "data": event.data, "correlation": event.correlation,
                "sequence": event.sequence, "dropped": event.dropped});
            invoke_one(core, &lead, id.clone(), "channel", payload).await;
        }
    }
    budget == 0
}

fn sync_bus(core: &Core) -> Vec<String> {
    let subscriptions = core
        .expansion
        .subscriptions
        .lock()
        .map(|subscriptions| subscriptions.clone())
        .unwrap_or_default();
    let current = subscriptions
        .iter()
        .filter(|(_, subscriptions)| !subscriptions.channels.is_empty())
        .map(|(id, _)| id.clone())
        .collect::<BTreeSet<_>>();
    let (Ok(mut bus), Ok(mut subscribed)) = (
        codex_omd::event_bus::global().lock(),
        core.expansion.subscribed.lock(),
    ) else {
        return Vec::new();
    };
    for removed in subscribed.difference(&current) {
        bus.unsubscribe(removed);
    }
    for (id, subscriptions) in &subscriptions {
        if !subscriptions.channels.is_empty() {
            bus.subscribe(id, subscriptions.channels.clone());
        }
    }
    *subscribed = current.clone();
    current
        .into_iter()
        .filter(|id| bus.pending(id) > 0)
        .collect()
}

pub(in crate::mods) fn publish(
    core: &Core,
    lead: &Lead,
    caller: &str,
    arguments: Value,
) -> Result<Value, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        channel: String,
        data: Value,
        #[serde(default)]
        correlation: Option<String>,
    }
    let input: Input = serde_json::from_value(arguments).map_err(|error| error.to_string())?;
    sync_bus(core);
    let delivery = codex_omd::event_bus::global()
        .lock()
        .map_err(|_| "event_bus_poisoned")?
        .publish(
            caller,
            &input.channel,
            input.data,
            input.correlation,
            &lead.thread.to_string(),
        )
        .map_err(|error| error.to_string())?;
    core.expansion.wake.notify_one();
    Ok(json!({"delivered": delivery.delivered, "dropped": delivery.dropped}))
}

pub(in crate::mods) fn watch(
    core: &Core,
    lead: &Lead,
    caller: &Caller<'_>,
    arguments: Value,
) -> Result<Value, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        paths: Vec<String>,
        #[serde(default = "recursive")]
        recursive: bool,
        #[serde(default)]
        debounce_ms: Option<u64>,
        #[serde(default)]
        include_ignored: bool,
    }
    fn recursive() -> bool {
        true
    }
    let input: Input = serde_json::from_value(arguments).map_err(|error| error.to_string())?;
    let watches = {
        let mut watches = core
            .expansion
            .watches
            .lock()
            .map_err(|_| "watch_state_poisoned")?;
        match watches.as_ref() {
            Some(watches) => watches.clone(),
            None => {
                let watcher = codex_file_watcher::FileWatcher::new()
                    .map_err(|error| format!("watch_unavailable: {error}"))?;
                let created = Arc::new(
                    crate::workspace_watch::WorkspaceWatches::new(
                        Arc::new(watcher),
                        lead.host.repository.clone(),
                        lead.host.protected_paths(),
                        lead.host.config.mod_limits,
                    )
                    .map_err(|error| error.to_string())?,
                );
                *watches = Some(created.clone());
                created
            }
        }
    };
    let weak = core
        .expansion
        .core
        .get()
        .cloned()
        .ok_or("watch_unavailable: no session")?;
    let (owner, thread, include_ignored) =
        (caller.id.to_owned(), lead.thread, input.include_ignored);
    let sink: crate::workspace_watch::ChangeSink =
        Arc::new(move |watch: &str, paths: Vec<String>| {
            if let Some(core) = weak.upgrade() {
                push(
                    &core.expansion,
                    Pending::Watch {
                        thread,
                        owner: owner.clone(),
                        watch: watch.to_owned(),
                        paths,
                        include_ignored,
                    },
                );
            }
        });
    let id = watches
        .watch(
            caller.id,
            caller.source,
            &input.paths,
            input.recursive,
            input.debounce_ms,
            sink,
        )
        .map_err(|error| error.to_string())?;
    Ok(json!({"watch_id": id}))
}

pub(in crate::mods) fn unwatch(
    core: &Core,
    caller: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let id = arguments["watch_id"]
        .as_str()
        .filter(|_| {
            arguments
                .as_object()
                .is_some_and(|object| object.len() == 1)
        })
        .ok_or("watch_arguments_invalid")?;
    let stopped = core
        .expansion
        .watches
        .lock()
        .map_err(|_| "watch_state_poisoned")?
        .as_ref()
        .is_some_and(|watches| watches.unwatch(caller, id));
    Ok(json!({"stopped": stopped}))
}

pub(in crate::mods) fn schedule(
    core: &Core,
    lead: &Lead,
    caller: &Caller<'_>,
    arguments: Value,
) -> Result<Value, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        key: String,
        delay_ms: u64,
    }
    let input: Input = serde_json::from_value(arguments).map_err(|error| error.to_string())?;
    if input.key.is_empty()
        || input.key.len() > 64
        || !(1_000..=86_400_000).contains(&input.delay_ms)
    {
        return Err("timer_invalid".into());
    }
    let weak = core
        .expansion
        .core
        .get()
        .cloned()
        .ok_or("timer_unavailable: no session")?;
    let mut timers = core
        .expansion
        .timers
        .lock()
        .map_err(|_| "timer_state_poisoned")?;
    timers.retain(|_, (_, task)| !task.is_finished());
    let slot = (
        lead.thread.to_string(),
        caller.id.to_owned(),
        input.key.clone(),
    );
    if !timers.contains_key(&slot)
        && timers
            .keys()
            .filter(|(_, owner, _)| owner == caller.id)
            .count()
            >= lead.host.config.mod_limits.bounded().timers_per_mod
    {
        return Err("timer_limit".into());
    }
    let (owner, key, thread) = (caller.id.to_owned(), input.key.clone(), lead.thread);
    let task = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(input.delay_ms)).await;
        if let Some(core) = weak.upgrade() {
            push(&core.expansion, Pending::Timer { thread, owner, key });
        }
    });
    if let Some((_, previous)) = timers.insert(slot, (caller.source.to_owned(), task)) {
        previous.abort();
    }
    Ok(json!({"key": input.key, "delay_ms": input.delay_ms}))
}

pub(in crate::mods) fn cancel(
    core: &Core,
    lead: &Lead,
    caller: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let key = arguments["key"].as_str().ok_or("timer_invalid")?;
    let removed = core
        .expansion
        .timers
        .lock()
        .map_err(|_| "timer_state_poisoned")?
        .remove(&(lead.thread.to_string(), caller.to_owned(), key.to_owned()));
    if let Some((_, task)) = &removed {
        task.abort();
    }
    Ok(json!({"cancelled": removed.is_some()}))
}

pub(in crate::mods) fn retain_sources(core: &Core, sources: &BTreeMap<String, String>) {
    if let Ok(mut timers) = core.expansion.timers.lock() {
        timers.retain(|(_, owner, _), (source, task)| {
            let keep = sources.get(owner) == Some(source);
            if !keep {
                task.abort();
            }
            keep
        });
    }
    if let Ok(watches) = core.expansion.watches.lock()
        && let Some(watches) = watches.as_ref()
    {
        watches.retain_sources(sources);
    }
}

pub(in crate::mods) fn release_owner(core: &Core, owner: &str) {
    if let Ok(watches) = core.expansion.watches.lock()
        && let Some(watches) = watches.as_ref()
    {
        watches.unwatch_all(owner);
    }
}

pub(in crate::mods) fn process_started(core: &Core, lead: &Lead, caller: &str, arguments: &Value) {
    let session = arguments["session"].as_str().unwrap_or_default();
    let command = arguments["name"].as_str().unwrap_or_default();
    super::activity::record(core, lead, |turn| {
        codex_omd::turn_activity::ActivityRecord::ProcessStarted {
            turn_id: turn.to_owned(),
            id: format!("{caller}/{session}"),
            kind: "managed".into(),
            command: command.to_owned(),
            at: super::activity::now(),
        }
    });
}
