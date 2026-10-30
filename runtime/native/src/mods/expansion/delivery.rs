use super::*;
use crate::managed_process::ProcessNotice;

const DELIVERIES_PER_ROUND: usize = 64;
const TIMER_FLOOR_MS: u64 = 16;

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
        source: String,
        incarnation: u64,
    },
}

pub(super) fn push(state: &State, pending: Pending) -> bool {
    let mut admitted = false;
    if let Ok(mut queue) = state.pending.lock() {
        if let Pending::Timer {
            thread, owner, key, ..
        } = &pending
        {
            queue.retain(|item| !matches!(item, Pending::Timer { thread: other_thread, owner: other_owner, key: other_key, .. }
                if thread == other_thread && owner == other_owner && key == other_key));
        }
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
            admitted = true;
        } else if queue.len() < 1024 {
            queue.push_back(pending);
            admitted = true;
        } else {
            state.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
    state.wake.notify_one();
    admitted
}

// The slot lock serializes producers with replacement/cancellation and quota accounting.
pub(super) fn push_timer(state: &State, pending: Pending) {
    let Pending::Timer {
        thread,
        owner,
        key,
        incarnation,
        ..
    } = &pending
    else {
        return;
    };
    let Ok(mut timers) = state.timers.lock() else {
        return;
    };
    let slot = (thread.to_string(), owner.clone(), key.clone());
    if timers
        .get(&slot)
        .is_some_and(|(_, current, _)| current == incarnation)
        && !push(state, pending)
    {
        timers.remove(&slot);
    }
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
        && error.kind() != std::io::ErrorKind::AlreadyExists
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
                tokio::time::sleep(std::time::Duration::from_millis(TIMER_FLOOR_MS)).await;
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
    let cursor = core
        .expansion
        .bus_cursor
        .lock()
        .map(|cursor| cursor.clone())
        .unwrap_or_default();
    let (later, earlier): (Vec<_>, Vec<_>) = sync_bus(&core.expansion)
        .into_iter()
        .partition(|id| *id > cursor);
    let mut subscribers = later.into_iter().chain(earlier).collect();
    let mut budget = DELIVERIES_PER_ROUND;
    while budget > 0 {
        let next = next_pending(&core.expansion, std::time::Instant::now());
        let channel = next_channel_event(&core.expansion, &mut subscribers);
        if next.is_none() && channel.is_none() {
            break;
        }
        if let Some(next) = next {
            budget -= 1;
            deliver_pending(core, current.as_ref(), next).await;
        }
        if let Some((id, event)) = channel {
            budget = budget.saturating_sub(1);
            let Some(lead) = ThreadId::from_string(&event.thread)
                .ok()
                .and_then(|thread| core.expansion.thread(thread))
            else {
                continue;
            };
            let payload = json!({"publisher": event.publisher, "channel": event.channel,
                "data": event.data, "correlation": event.correlation,
                "sequence": event.sequence, "dropped": event.dropped});
            invoke_one(core, &lead, id, "channel", payload).await;
        }
    }
    budget == 0
        || core
            .expansion
            .pending
            .lock()
            .is_ok_and(|queue| !queue.is_empty())
}

pub(super) fn next_pending(state: &State, now: std::time::Instant) -> Option<Pending> {
    let mut rates = state.timer_deliveries.lock().ok()?;
    let mut queue = state.pending.lock().ok()?;
    let index = queue.iter().position(|item| match item {
        Pending::Timer { thread, owner, .. } => {
            rates.get(&(*thread, owner.clone())).is_none_or(|last| {
                now.duration_since(*last) >= std::time::Duration::from_millis(TIMER_FLOOR_MS)
            })
        }
        _ => true,
    })?;
    let next = queue.remove(index)?;
    if let Pending::Timer { thread, owner, .. } = &next {
        rates.insert((*thread, owner.clone()), now);
    }
    Some(next)
}

fn next_channel_event(
    expansion: &State,
    subscribers: &mut std::collections::VecDeque<String>,
) -> Option<(String, codex_omd::event_bus::ChannelEvent)> {
    let mut bus = codex_omd::event_bus::global().lock().ok()?;
    while let Some(id) = subscribers.pop_front() {
        let Some(event) = bus.drain(&id, 1).pop() else {
            continue;
        };
        if bus.pending(&id) > 0 {
            subscribers.push_back(id.clone());
        }
        if let Ok(mut cursor) = expansion.bus_cursor.lock() {
            cursor.clone_from(&id);
        }
        return Some((id, event));
    }
    None
}

async fn deliver_pending(core: &Arc<Core>, current: Option<&Lead>, next: Pending) {
    match next {
        Pending::Process {
            thread,
            owner,
            session,
            bytes,
        } => {
            let Some(lead) = core.expansion.thread(thread) else {
                return;
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
                return;
            };
            let (git, paths): (Vec<String>, Vec<String>) =
                paths.into_iter().partition(|path| path.starts_with(".git/"));
            let mut changes =
                super::activity::external_changes(core, &lead, &paths, include_ignored).await;
            changes.extend(
                git.into_iter()
                    .map(|path| json!({"path": path, "before": null, "after": null})),
            );
            if changes.is_empty() {
                return;
            }
            let payload = json!({"repository": lead.host.repository, "source": "external",
                "call_id": null, "watch_id": watch, "changes": changes, "status": "observed", "reason": null});
            invoke_one(core, &lead, owner, "workspace_change", payload).await;
        }
        Pending::Broadcast { event, payload } => {
            core.event(event, payload, current).await;
        }
        Pending::Timer {
            thread,
            owner,
            key,
            source,
            incarnation,
        } => {
            let Some(lead) = core.expansion.thread(thread) else {
                if let Ok(mut timers) = core.expansion.timers.lock() {
                    let slot = (thread.to_string(), owner, key);
                    if timers
                        .get(&slot)
                        .is_some_and(|(_, current, _)| *current == incarnation)
                    {
                        timers.remove(&slot);
                    }
                }
                return;
            };
            invoke_one_guarded(
                core,
                &lead,
                owner,
                "timer",
                json!({"key": key}),
                Some((key, source, incarnation)),
            )
            .await;
        }
    }
}

pub(super) fn sync_bus(expansion: &State) -> Vec<String> {
    let subscriptions = expansion
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
        expansion.subscribed.lock(),
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
    sync_bus(&core.expansion);
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
        #[serde(default)]
        key: Option<String>,
        #[serde(default)]
        git: bool,
    }
    fn recursive() -> bool {
        true
    }
    let shape = format!("{}:{arguments}", lead.thread);
    let input: Input = serde_json::from_value(arguments).map_err(|error| error.to_string())?;
    if input.key.as_deref().is_some_and(invalid_watch_key) {
        return Err("watch_arguments_invalid".into());
    }
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
    let (id, _) = watches
        .watch(
            caller.id,
            caller.source,
            &input.paths,
            input.recursive,
            input.git,
            input.debounce_ms,
            input.key.as_deref().map(|key| (key, shape.as_str())),
            sink,
        )
        .map_err(|error| error.to_string())?;
    Ok(json!({"watch_id": id}))
}

fn invalid_watch_key(key: &str) -> bool {
    key.is_empty() || key.len() > 64
}

pub(in crate::mods) fn unwatch(
    core: &Core,
    caller: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let single = arguments
        .as_object()
        .is_some_and(|object| object.len() == 1);
    let (id, key) = (arguments["watch_id"].as_str(), arguments["key"].as_str());
    if !single || id.is_none() && key.is_none_or(invalid_watch_key) {
        return Err("watch_arguments_invalid".into());
    }
    let stopped = core
        .expansion
        .watches
        .lock()
        .map_err(|_| "watch_state_poisoned")?
        .as_ref()
        .is_some_and(|watches| match (id, key) {
            (Some(id), _) => watches.unwatch(caller, id),
            (None, Some(key)) => watches.unwatch_key(caller, key),
            (None, None) => false,
        });
    Ok(json!({"stopped": stopped}))
}

pub(in crate::mods) fn schedule(
    core: &Core,
    lead: &Lead,
    caller: &Caller<'_>,
    arguments: Value,
) -> Result<Value, String> {
    let (key, delay_ms) = codex_omd::host::validate_timer_request("events.schedule", &arguments)?;
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
    let slot = (lead.thread.to_string(), caller.id.to_owned(), key.clone());
    if !timers.contains_key(&slot)
        && timers
            .keys()
            .filter(|(_, owner, _)| owner == caller.id)
            .count()
            >= lead.host.config.mod_limits.bounded().timers_per_mod
    {
        return Err("timer_limit".into());
    }
    let (owner, timer_key, thread) = (caller.id.to_owned(), key.clone(), lead.thread);
    if let Ok(mut queue) = core.expansion.pending.lock() {
        queue.retain(|item| {
            !matches!(item, Pending::Timer { thread: t, owner: o, key: k, .. }
            if *t == thread && o == &owner && k == &timer_key)
        });
    }
    let source = caller.source.to_owned();
    let incarnation = core
        .expansion
        .timer_sequence
        .fetch_add(1, Ordering::Relaxed);
    let task = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        if let Some(core) = weak.upgrade() {
            push_timer(
                &core.expansion,
                Pending::Timer {
                    thread,
                    owner,
                    key: timer_key,
                    source,
                    incarnation,
                },
            );
        }
    });
    if let Some((_, _, previous)) =
        timers.insert(slot, (caller.source.to_owned(), incarnation, task))
    {
        previous.abort();
    }
    Ok(json!({"key": key, "delay_ms": delay_ms}))
}

pub(in crate::mods) fn cancel(
    core: &Core,
    lead: &Lead,
    caller: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let (key, _) = codex_omd::host::validate_timer_request("events.cancel", arguments)?;
    let mut timers = core
        .expansion
        .timers
        .lock()
        .map_err(|_| "timer_state_poisoned")?;
    let removed = timers.remove(&(lead.thread.to_string(), caller.to_owned(), key.to_owned()));
    if let Some((_, _, task)) = &removed {
        task.abort();
    }
    let mut cancelled = removed.is_some();
    if let Ok(mut queue) = core.expansion.pending.lock() {
        let before = queue.len();
        queue.retain(|item| {
            !matches!(item, Pending::Timer { thread, owner, key: k, .. }
            if *thread == lead.thread && owner == caller && k == &key)
        });
        cancelled |= queue.len() != before;
    }
    Ok(json!({"cancelled": cancelled}))
}

pub(in crate::mods) fn retain_sources(core: &Core, sources: &BTreeMap<String, String>) {
    if let Ok(mut timers) = core.expansion.timers.lock() {
        timers.retain(|(_, owner, _), (source, _, task)| {
            let keep = sources.get(owner) == Some(source);
            if !keep {
                task.abort();
            }
            keep
        });
        if let Ok(mut queue) = core.expansion.pending.lock() {
            queue.retain(|item| {
                !matches!(item, Pending::Timer { owner, source, .. }
                    if sources.get(owner) != Some(source))
            });
        }
    }
    if let Ok(mut rates) = core.expansion.timer_deliveries.lock() {
        rates.retain(|(_, owner), _| sources.contains_key(owner));
    }
    if let Ok(watches) = core.expansion.watches.lock()
        && let Some(watches) = watches.as_ref()
    {
        watches.retain_sources(sources);
    }
}

pub(in crate::mods) fn release_owner(core: &Core, owner: &str) {
    core.environment.clear(None, Some(owner));
    clear_timers(core, None, Some(owner));
    if let Ok(watches) = core.expansion.watches.lock()
        && let Some(watches) = watches.as_ref()
    {
        watches.unwatch_all(owner);
    }
}

pub(in crate::mods) fn release_thread(core: &Core, thread: ThreadId) {
    clear_timers(core, Some(thread), None);
}

fn clear_timers(core: &Core, thread: Option<ThreadId>, owner: Option<&str>) {
    let matches = |t: &str, id: &str| {
        thread.is_none_or(|thread| thread.to_string() == t) && owner.is_none_or(|owner| owner == id)
    };
    if let Ok(mut timers) = core.expansion.timers.lock() {
        timers.retain(|(t, id, _), (_, _, task)| {
            if matches(t, id) {
                task.abort();
                false
            } else {
                true
            }
        });
        if let Ok(mut queue) = core.expansion.pending.lock() {
            queue.retain(|item| {
                !matches!(item, Pending::Timer { thread, owner, .. }
                if matches(&thread.to_string(), owner))
            });
        }
    }
    if let Ok(mut rates) = core.expansion.timer_deliveries.lock() {
        rates.retain(|(thread, owner), _| !matches(&thread.to_string(), owner));
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
