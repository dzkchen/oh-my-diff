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

/// The mod whose result settled last, i.e. the outermost link that answered or transformed it.
pub(super) fn settled_by(chain: &codex_omd::ModChain) -> String {
    chain
        .trace
        .iter()
        .rev()
        .find(|entry| matches!(entry["outcome"].as_str(), Some("returned" | "caught")))
        .and_then(|entry| entry["mod"].as_str())
        .unwrap_or("mod")
        .to_owned()
}

/// Lets model-request interceptors call host operations from the transport thread.
pub(super) fn install_dispatcher(core: &Arc<Core>) {
    let weak = Arc::downgrade(core);
    core.host.accounts.install_mod_dispatcher(Arc::new(
        move |thread: &str, caller: &str, request: ModHostCall, active: &dyn Fn() -> bool| {
            let unavailable = |reason: &str| {
                std::io::Error::other(format!("host_operation_unavailable: {reason}"))
            };
            let core = weak
                .upgrade()
                .ok_or_else(|| unavailable("native host stopped"))?;
            let handle = tokio::runtime::Handle::try_current()
                .ok()
                .filter(|handle| {
                    handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread
                })
                .ok_or_else(|| {
                    unavailable(
                        "model_request interceptors need the multi-threaded session runtime",
                    )
                })?;
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
            let _cancellation = Cancellation(cancelled.clone());
            tokio::task::block_in_place(|| {
                handle.block_on(async {
                    tokio::select! {
                        value = operations::dispatch(
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
                        ) => value.map_err(std::io::Error::other),
                        () = async {
                            while active() {
                                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                            }
                        } => Err(std::io::Error::other("callback_cancelled")),
                    }
                })
            })
        },
    ));
}
