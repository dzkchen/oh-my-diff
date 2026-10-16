use super::*;
use codex_omd::data_store::Origin;
use operations::Caller;

/// Runs a continuation chain off the async runtime; each interceptor's host calls run under its own grants.
#[allow(clippy::too_many_arguments)]
pub(super) async fn chain(
    core: Arc<Core>,
    lead: Arc<Lead>,
    runtime: Arc<Mutex<ModHost>>,
    surface: &'static str,
    required: bool,
    input: Value,
    origin: Value,
    cancelled: Arc<AtomicBool>,
    executor: impl FnMut(Value) -> std::io::Result<Value> + Send + 'static,
) -> Result<codex_omd::ModChain, String> {
    let secondary = !Arc::ptr_eq(&runtime, &core.runtime);
    let (facts, generation) = {
        let runtime = runtime.lock().map_err(|_| "mod_runtime_poisoned")?;
        (facts(&runtime), runtime.generation())
    };
    let (requests, mut receiver) = tokio::sync::mpsc::channel::<HostRequest>(1);
    let (flag, thread) = (cancelled.clone(), lead.thread.to_string());
    let handle = tokio::task::spawn_blocking(move || {
        let _thread = codex_omd::StateThread::enter(Some(thread));
        let active = || !flag.load(Ordering::Acquire);
        codex_omd::intercept_shared(
            &runtime,
            surface,
            required,
            input,
            origin,
            active,
            |caller, request| {
                if !operations::event_allows("intercept", &request.operation) {
                    return Err(std::io::Error::other(format!(
                        "host_operation_unavailable: {} is not available to interceptors",
                        request.operation
                    )));
                }
                forward(&requests, &facts, caller, request, &active)
            },
            executor,
        )
        .map_err(|error| error.to_string())
    });
    while let Some(call) = receiver.recv().await {
        let generation = if secondary {
            let authority = core.runtime.clone();
            let caller = call.caller.clone();
            let source = call.source.clone();
            let capabilities = call.grants.as_ref().map(|grants| grants.capabilities.clone());
            let flag = cancelled.clone();
            let current = tokio::task::spawn_blocking(move || {
                let mut runtime = authority.lock().map_err(|_| "mod_runtime_poisoned".to_owned())?;
                runtime.refresh_guarded(&|| !flag.load(Ordering::Acquire)).map_err(|error| error.to_string())?;
                let grants = runtime.grants(&caller).ok_or("host_caller_inactive")?;
                if grants.source_sha256 != source || Some(grants.capabilities) != capabilities {
                    return Err("callback_authority_changed".into());
                }
                Ok(runtime.generation())
            }).await.map_err(|error| error.to_string()).and_then(|result| result);
            match current {
                Ok(generation) => generation,
                Err(error) => {
                    let _ = call.reply.send(Err(std::io::Error::other(error)));
                    continue;
                }
            }
        } else { generation };
        let value = operations::dispatch(
            &core,
            &lead,
            Caller {
                id: &call.caller,
                source: &call.source,
                grants: call.grants,
                generation,
                origin: Origin::Event,
                record_changes: true,
            },
            None,
            call.request,
            &cancelled,
        )
        .await;
        let _ = call.reply.send(value.map_err(std::io::Error::other));
    }
    let result = handle.await.map_err(|error| error.to_string())?;
    core.cleanup_failed(Some(&lead)).await;
    result
}

pub(crate) fn settled_by(chain: &codex_omd::ModChain) -> String {
    chain
        .trace
        .iter()
        .rev()
        .find(|entry| matches!(entry["outcome"].as_str(), Some("returned" | "caught")))
        .and_then(|entry| entry["mod"].as_str())
        .unwrap_or("mod")
        .to_owned()
}

pub(super) fn install_notifier(core: &Arc<Core>) {
    let notified = Arc::downgrade(core);
    core.host.accounts.install_mod_notifier(Arc::new(
        move |event: &'static str, payload: Value| {
            if let Some(core) = notified.upgrade() {
                if event == "model_response" {
                    core.inventory.usage(&payload);
                    if let Some(thread) = payload["scope"]["thread_id"].as_str() {
                        core.autonomy
                            .charge(&core.inventory.root_thread(thread), &payload);
                    }
                }
                expansion::broadcast(&core.expansion, event, payload);
            }
        },
    ));
}

pub(super) fn dispatcher(core: &Arc<Core>) -> codex_omd::host::SessionDispatcher {
    let weak = Arc::downgrade(core);
    let session = tokio::runtime::Handle::try_current().ok();
    let dispatcher: codex_omd::host::SessionDispatcher = Arc::new(
        move |thread: &str,
              caller: &str,
              expected_source: Option<&str>,
              policy: Option<&Value>,
              request: ModHostCall,
              active: &dyn Fn() -> bool| {
            let unavailable = |reason: &str| {
                std::io::Error::other(format!("host_operation_unavailable: {reason}"))
            };
            let core = weak
                .upgrade()
                .ok_or_else(|| unavailable("native host stopped"))?;
            let (handle, worker) = match tokio::runtime::Handle::try_current() {
                Ok(handle)
                    if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread =>
                {
                    (session.clone().ok_or_else(|| unavailable("no session runtime"))?, true)
                }
                Ok(_) => {
                    return Err(unavailable(
                        "host calls from this thread need the multi-threaded session runtime",
                    ));
                }
                Err(_) => (
                    session
                        .clone()
                        .ok_or_else(|| unavailable("no session runtime"))?,
                    false,
                ),
            };
            if !operations::event_allows("intercept", &request.operation) {
                return Err(unavailable(&request.operation));
            }
            let lead = ThreadId::from_string(thread)
                .ok()
                .and_then(|thread| core.expansion.thread(thread))
                .ok_or_else(|| unavailable("no session for this thread"))?;
            let ((source, grants), generation) = {
                let runtime = core
                    .runtime
                    .lock()
                    .map_err(|_| std::io::Error::other("mod_runtime_poisoned"))?;
                (
                    facts(&runtime).remove(caller).unwrap_or_default(),
                    runtime.generation(),
                )
            };
            let cancelled = Arc::new(AtomicBool::new(false));
            if expected_source.is_some_and(|expected| expected != source) {
                return Err(std::io::Error::other("host_caller_source_changed"));
            }
            let policy: Option<codex_protocol::models::PermissionProfile> =
                policy.cloned().map(serde_json::from_value).transpose()?;
            let _cancellation = Cancellation(cancelled.clone());
            let stopped = AtomicBool::new(false);
            let operation = || {
                handle.block_on(async {
                    tokio::select! {
                        value = operations::dispatch_with_policy(
                            &core,
                            &lead,
                            Caller {
                                id: caller,
                                source: &source,
                                grants,
                                generation,
                                origin: Origin::Event,
                                record_changes: true,
                            },
                            None,
                            request,
                            &cancelled,
                            policy.as_ref(),
                        ) => value.map_err(std::io::Error::other),
                        () = async {
                            while !stopped.load(Ordering::Acquire) {
                                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                            }
                        } => Err(std::io::Error::other("callback_cancelled")),
                    }
                })
            };
            // Callers include small-stack callback threads; the future is built and polled on a thread with a Tokio worker's stack.
            let wait = || {
                std::thread::scope(|scope| {
                    let (tx, rx) = std::sync::mpsc::channel();
                    std::thread::Builder::new()
                        .name("omd-host-call".into())
                        .stack_size(codex_async_utils::THREAD_STACK_SIZE_BYTES)
                        .spawn_scoped(scope, move || {
                            let _ = tx.send(operation());
                        })?;
                    loop {
                        match rx.recv_timeout(std::time::Duration::from_millis(20)) {
                            Ok(result) => return result,
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                                if !active() {
                                    stopped.store(true, Ordering::Release);
                                }
                            }
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                                return Err(unavailable("host operation thread failed"));
                            }
                        }
                    }
                })
            };
            if worker {
                tokio::task::block_in_place(wait)
            } else {
                wait()
            }
        },
    );
    dispatcher
}
