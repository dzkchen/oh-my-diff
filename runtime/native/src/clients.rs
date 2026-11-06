use super::*;
use codex_omd::ModCommand;
use codex_omd::ModComponent;
use codex_omd::ModComponentAction;
use codex_omd::ModKeyAction;
use codex_omd::ModView;
use codex_omd::ModViewSnapshot;
use codex_omd::data_store::Origin;
use codex_omd::resource_data::ResourceRef;

static OWNERS: Mutex<BTreeMap<String, Arc<Mods>>> = Mutex::new(BTreeMap::new());
static SESSION_OWNERS: Mutex<BTreeMap<String, std::sync::Weak<Mods>>> = Mutex::new(BTreeMap::new());
static CLIENT_OWNERS: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

pub fn configuration(client: &str, request: Value) -> Result<Value, String> {
    let action = request["action"]
        .as_str()
        .ok_or("configuration_action_invalid")?;
    let allowed: &[&str] = match action {
        "read" | "catalog" => &["action"],
        "command" => &["action", "command", "args"],
        "write" => &["action", "id", "values", "target", "reset", "scope"],
        "package" => &["action", "request"],
        _ => return Err("configuration_action_invalid".into()),
    };
    let object = request
        .as_object()
        .ok_or("configuration_arguments_invalid")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("configuration_arguments_invalid".into());
    }
    if request
        .get("target")
        .is_some_and(|target| !matches!(target.as_str(), Some("terminal" | "shared")))
    {
        return Err("configuration_target_invalid".into());
    }
    if request.get("scope").is_some_and(|scope| {
        !scope.is_null() && !matches!(scope.as_str(), Some("user" | "project"))
    }) {
        return Err("configuration_scope_invalid".into());
    }
    let core = client_core(client)?;
    if action == "command" {
        let command = request["command"].as_str().ok_or("command_required")?;
        let args = request["args"].as_str().ok_or("command_args_required")?;
        return user_command(core, command.to_owned(), args.to_owned());
    }
    let mut runtime = core
        .input_runtime
        .lock()
        .map_err(|_| "mod_runtime_poisoned")?;
    runtime.refresh(&|| true).map_err(|e| e.to_string())?;
    let result = match action {
        "catalog" => {
            let store = codex_omd::ModStore::open(core.host.root.clone()).map_err(|error| error.to_string())?;
            let packages = runtime.configuration_listing(codex_omd::package_controls::list_fields(&store, Some(&runtime.status()), Value::Null, Some(&core.host.repository), core.terminal_owner.as_deref()).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
            Ok(json!({"status": runtime.status(), "view":core.views.published().as_deref(), "packages":packages,"builtins":codex_omd::BuiltinSnapshot::from_controls(&runtime.builtin_controls())}))
        }
        "read" => {
            let store = codex_omd::ModStore::open(core.host.root.clone()).map_err(|e| e.to_string())?;
            let listed = codex_omd::package_controls::list_fields(&store, Some(&runtime.status()), Value::Null, Some(&core.host.repository), core.terminal_owner.as_deref()).map_err(|e| e.to_string())?;
            runtime.configuration_listing(listed)
        }
        "write" => {
            let id = request["id"].as_str().ok_or("mod_id_required")?;
            let reset: Vec<String> = serde_json::from_value(request.get("reset").cloned().unwrap_or_else(|| json!([]))).map_err(|e| e.to_string())?;
            runtime.write_configuration_in(id, &request["values"], request["target"].as_str().unwrap_or("terminal"), &reset, request["scope"].as_str())
        }
        "package" => {
            let arguments = &request["request"];
            let object = arguments.as_object().ok_or("package_arguments_invalid")?;
            if object.keys().any(|key| !["action", "id", "scope", "target", "expected_generation"].contains(&key.as_str())) { return Err("package_arguments_invalid".into()); }
            let action = arguments["action"].as_str().ok_or("package_action_required")?;
            if !["enable", "disable", "reset", "save-defaults"].contains(&action) { return Err("package_action_requires_confirmation".into()); }
            let preview = runtime.preview_configuration(arguments.clone()).map_err(|e| e.to_string())?;
            runtime.apply_configuration(&preview.control)
        }
        _ => return Err("configuration_action_invalid".into()),
    }.map_err(|e| e.to_string())?;
    Ok(result)
}

pub fn terminal_package_preview(
    owner: &str,
    arguments: Value,
) -> Result<codex_omd::package_controls::PackagePreview, String> {
    let owner = codex_protocol::turn_input::TerminalOwner(
        owner.parse().map_err(|_| "terminal_owner_invalid")?,
    );
    let mods = for_owner(&owner).ok_or("terminal_owner_unavailable")?;
    if !arguments["expected_generation"].is_u64() {
        return Err("expected_generation_required".into());
    }
    if arguments["target"].as_str().unwrap_or("terminal") != "terminal"
        || !matches!(
            arguments["action"].as_str(),
            Some("enable" | "disable" | "reset" | "save-defaults")
        )
    {
        return Err("package_action_requires_local_terminal".into());
    }
    mods.input_runtime
        .lock()
        .map_err(|_| "mod_runtime_poisoned")?
        .preview_configuration(arguments)
        .map_err(|e| e.to_string())
}

pub fn terminal_package_apply(
    owner: &str,
    control: &codex_omd::package_controls::PackageControl,
) -> Result<Value, String> {
    let owner = codex_protocol::turn_input::TerminalOwner(
        owner.parse().map_err(|_| "terminal_owner_invalid")?,
    );
    let mods = for_owner(&owner).ok_or("terminal_owner_unavailable")?;
    let mut runtime = mods
        .input_runtime
        .lock()
        .map_err(|_| "mod_runtime_poisoned")?;
    runtime
        .apply_configuration(control)
        .map_err(|e| e.to_string())
}

pub(crate) fn request_runtime(
    store: &codex_extension_api::ExtensionData,
) -> Result<Option<crate::accounting::RuntimeBinding>, String> {
    if store
        .get::<codex_protocol::turn_input::TerminalOwner>()
        .is_none()
    {
        return Ok(None);
    }
    let mods = for_store(store).ok_or("terminal_owner_unavailable")?;
    Ok(Some(crate::accounting::RuntimeBinding {
        terminal_owner: mods.terminal_owner.clone(),
        runtime: mods.runtime.clone(),
        required: mods.runtime_required.clone(),
    }))
}

pub(super) fn release_native_owner(owner: &codex_protocol::turn_input::TerminalOwner) {
    let key = owner.0.to_string();
    let mut owners = OWNERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let clients = CLIENT_OWNERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !clients.values().any(|value| value == &key) {
        owners.remove(&key);
    }
}

pub fn release_owner(owner: codex_protocol::turn_input::TerminalOwner) {
    let key = owner.0.to_string();
    OWNERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&key);
    CLIENT_OWNERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .retain(|_, value| value != &key);
}

pub fn bind(client: &str, owner: codex_protocol::turn_input::TerminalOwner) -> Result<(), String> {
    let key = owner.0.to_string();
    let mut owners = OWNERS.lock().map_err(|_| "terminal_owner_poisoned")?;
    if !owners.contains_key(&key)
        && let Ok(base) = core()
    {
        let runtime_owner = codex_omd::terminal_configuration_owner(&key);
        owners.insert(
            key.clone(),
            create_owner(base.host.clone(), runtime_owner, Some(key.clone()))?,
        );
    }
    if let Some(owner) = owners.get(&key) {
        SESSION_OWNERS
            .lock()
            .map_err(|_| "terminal_owner_poisoned")?
            .insert(key.clone(), Arc::downgrade(owner));
    }
    CLIENT_OWNERS
        .lock()
        .map_err(|_| "terminal_owner_poisoned")?
        .insert(client.into(), key);
    Ok(())
}

pub(super) fn ensure_owner(
    owner: &codex_protocol::turn_input::TerminalOwner,
) -> Result<Arc<Mods>, String> {
    let key = owner.0.to_string();
    let mut owners = OWNERS.lock().map_err(|_| "terminal_owner_poisoned")?;
    if let Some(mods) = owners.get(&key) {
        return Ok(mods.clone());
    }
    let base = core()?;
    let mods = create_owner(
        base.host.clone(),
        codex_omd::terminal_configuration_owner(&key),
        Some(key.clone()),
    )?;
    {
        let mut sessions = SESSION_OWNERS
            .lock()
            .map_err(|_| "terminal_owner_poisoned")?;
        sessions.retain(|_, owner| owner.strong_count() > 0);
        sessions.insert(key.clone(), Arc::downgrade(&mods));
    }
    owners.insert(key, mods.clone());
    Ok(mods)
}

pub(super) fn for_owner(owner: &codex_protocol::turn_input::TerminalOwner) -> Option<Arc<Mods>> {
    OWNERS.lock().ok()?.get(&owner.0.to_string()).cloned()
}

pub(super) fn session_owner(
    owner: &codex_protocol::turn_input::TerminalOwner,
) -> Option<Arc<Mods>> {
    for_owner(owner).or_else(|| {
        SESSION_OWNERS
            .lock()
            .ok()?
            .get(&owner.0.to_string())?
            .upgrade()
    })
}

pub(super) fn for_store(store: &codex_extension_api::ExtensionData) -> Option<Arc<Mods>> {
    if let Some(owner) = store.get::<Mods>() {
        return Some(owner);
    }
    for_owner(
        store
            .get::<codex_protocol::turn_input::TerminalOwner>()?
            .as_ref(),
    )
}

fn client_core(client: &str) -> Result<Arc<Core>, String> {
    let key = CLIENT_OWNERS
        .lock()
        .map_err(|_| "terminal_owner_poisoned")?
        .get(client)
        .cloned()
        .ok_or("terminal_owner_missing")?;
    let owner = codex_protocol::turn_input::TerminalOwner(
        key.parse().map_err(|_| "terminal_owner_invalid")?,
    );
    ensure_owner(&owner).map(|mods| mods.core.clone())
}

pub async fn select_thread(
    owner: codex_protocol::turn_input::TerminalOwner,
    thread: &str,
) -> Result<(), String> {
    let Ok(base) = core() else {
        return Ok(());
    };
    let thread = ThreadId::from_string(thread).map_err(|error| error.to_string())?;
    let sources: Vec<_> = OWNERS
        .lock()
        .map_err(|_| "terminal_owner_poisoned")?
        .values()
        .map(|mods| mods.core.clone())
        .chain(std::iter::once(base))
        .collect();
    let lead = sources
        .iter()
        .find_map(|core| core.expansion.thread(thread))
        .ok_or("session_unavailable")?;
    let target = ensure_owner(&owner)?;
    let changed = target
        .expansion
        .current()
        .is_none_or(|current| current.thread != thread);
    let first = target
        .initialized_threads
        .lock()
        .map_err(|_| "terminal_owner_poisoned")?
        .insert(thread.to_string());
    target.expansion.select_thread(&target.core, &lead);
    target
        .sessions
        .lock()
        .map_err(|_| "terminal_owner_poisoned")?
        .insert(thread.to_string(), Arc::downgrade(&lead.session));
    if let Some(invoker) = sources.iter().find_map(|source| {
        source
            .expansion
            .invokers
            .lock()
            .ok()?
            .get(&thread.to_string())
            .cloned()
    }) {
        target
            .expansion
            .invokers
            .lock()
            .map_err(|_| "terminal_owner_poisoned")?
            .insert(thread.to_string(), invoker);
    }
    if changed || first {
        let store = ExtensionData::new(thread.to_string());
        store.insert(lead.clone());
        store.insert_arc(target.clone());
        target.views.start_thread(&store);
    }
    if first {
        target
            .event(
                "session",
                json!({"phase":"start","thread_id":thread.to_string()}),
                None,
            )
            .await;
        target.event("start", Value::Null, Some(&lead)).await;
        peering::start(&target.core, thread);
    }
    if changed {
        target
            .views
            .presentation(&thread.to_string(), Some("resumed"));
        target
            .event(
                "session",
                json!({"phase":"resume","thread_id":thread.to_string()}),
                None,
            )
            .await;
        let payload = expansion::resume_payload(&target.core, &lead).await;
        target.event("resume", payload, Some(&lead)).await;
    }
    Ok(())
}

pub(super) fn cores_for_thread(thread: ThreadId) -> Vec<Arc<Core>> {
    OWNERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .values()
        .filter(|owner| owner.expansion.thread(thread).is_some())
        .map(|owner| owner.core.clone())
        .collect()
}

pub fn published_for(client: &str) -> Option<Arc<ModViewSnapshot>> {
    snapshot(client_core(client).ok()?.as_ref()).ok()
}

const RESETTABLE: &[&str] = &["host.json", "mods.json"];

struct Installed {
    owner: Arc<()>,
    core: std::sync::Weak<Core>,
    _roster: codex_omd::client_surface::Registration,
}

static INSTALLED: Mutex<Option<Installed>> = Mutex::new(None);

pub(super) struct Registration {
    owner: Arc<()>,
    _dispatcher: codex_omd::host::SessionRegistration,
}

impl Drop for Registration {
    fn drop(&mut self) {
        let mut installed = INSTALLED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if installed
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(&current.owner, &self.owner))
        {
            *installed = None;
            drop(installed);
            OWNERS
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clear();
            CLIENT_OWNERS
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clear();
            SESSION_OWNERS
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clear();
        }
    }
}

/// Runs requested work on one thread at a time; requests during a run cause one trailing run.
struct Coalesce {
    running: AtomicBool,
    dirty: AtomicBool,
}

impl Coalesce {
    const fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            dirty: AtomicBool::new(false),
        }
    }

    fn request(&'static self, work: impl Fn() + Send + 'static) {
        self.dirty.store(true, Ordering::Release);
        if !self.running.swap(true, Ordering::AcqRel) {
            std::thread::spawn(move || self.drain(work));
        }
    }

    fn drain(&self, work: impl Fn()) {
        loop {
            while self.dirty.swap(false, Ordering::AcqRel) {
                work();
            }
            self.running.store(false, Ordering::Release);
            if !self.dirty.load(Ordering::Acquire) || self.running.swap(true, Ordering::AcqRel) {
                return;
            }
        }
    }
}

static REPUBLISH: Coalesce = Coalesce::new();

pub(super) fn install(
    core: &Arc<Core>,
    dispatcher: codex_omd::host::SessionRegistration,
) -> Result<Registration, String> {
    let mut installed = INSTALLED.lock().map_err(|_| "host_installation_poisoned")?;
    if installed.is_some() {
        return Err("host_already_installed".into());
    }
    let owner = Arc::new(());
    let roster = codex_omd::client_surface::register_observer(Arc::new(|observed| {
        if matches!(observed, codex_omd::client_surface::Observed::Roster) {
            REPUBLISH.request(|| {
                let mut cores = OWNERS
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .values()
                    .map(|owner| owner.core.clone())
                    .collect::<Vec<_>>();
                if let Ok(core) = self::core() {
                    cores.push(core);
                }
                for core in cores {
                    republish(&core);
                }
            });
        }
    }));
    *installed = Some(Installed {
        owner: owner.clone(),
        core: Arc::downgrade(core),
        _roster: roster,
    });
    Ok(Registration {
        owner,
        _dispatcher: dispatcher,
    })
}

/// Renders the view again so mods see the changed roster, keeping the last published event.
fn republish(core: &Core) {
    let Some(snapshot) = core.views.published() else {
        return;
    };
    let event = snapshot.input["event"].as_str().unwrap_or("start");
    let lead = core.expansion.current();
    let _thread = codex_omd::StateThread::enter(lead.as_ref().map(|lead| lead.thread.to_string()));
    let ledger = lead.as_ref().map_or(Value::Null, Lead::ledger);
    if let Ok(mut runtime) = core.runtime.lock() {
        publish(
            &mut runtime,
            &core.host,
            &core.views,
            core.terminal_owner.is_some(),
            event,
            ledger,
            || true,
        );
    }
}

pub(super) fn shared_native_tasks() -> Option<(
    Arc<Mutex<BTreeMap<String, TurnRecord>>>,
    Arc<Mutex<BTreeMap<String, Config>>>,
)> {
    core()
        .ok()
        .map(|core| (core.turns.clone(), core.provider_switches.clone()))
}

pub(super) fn shared_native_sessions()
-> Option<Arc<Mutex<BTreeMap<String, std::sync::Weak<Session>>>>> {
    Some(core().ok()?.sessions.clone())
}

pub(super) fn shared_inventory() -> Option<Arc<inventory::Inventory>> {
    core().ok().map(|core| core.inventory.clone())
}

fn core() -> Result<Arc<Core>, String> {
    INSTALLED
        .lock()
        .ok()
        .and_then(|installed| installed.as_ref()?.core.upgrade())
        .ok_or_else(|| "mod_host_inactive: mods are not running in this host".to_owned())
}

fn session(core: &Core) -> Result<Lead, String> {
    core.expansion
        .current()
        .ok_or_else(|| "session_unavailable: no thread is running in this host".to_owned())
}

fn block<T>(core: &Core, future: impl std::future::Future<Output = T>) -> Result<T, String> {
    let owner = core
        .session_runtime
        .as_ref()
        .ok_or("host_operation_unavailable: no session runtime")?;
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            Ok(tokio::task::block_in_place(|| owner.block_on(future)))
        }
        Ok(_) => Err(
            "host_operation_unavailable: client calls need the multi-threaded session runtime"
                .into(),
        ),
        Err(_) => Ok(owner.block_on(future)),
    }
}

fn snapshot(core: &Core) -> Result<Arc<ModViewSnapshot>, String> {
    core.views
        .published()
        .ok_or_else(|| "view_unavailable: the host has not published a view".to_owned())
}

fn owner<'a>(snapshot: &'a ModViewSnapshot, component: &str) -> Result<&'a str, String> {
    snapshot
        .component_owners
        .get(component)
        .map(String::as_str)
        .ok_or_else(|| format!("view_stale: {component}"))
}

pub fn published() -> Option<Arc<ModViewSnapshot>> {
    core().ok()?.views.published()
}

const EVENT_BYTES: usize = 64 * 1024;

const POINTER_ACTIONS: &[&str] = &[
    "down",
    "up",
    "scroll_up",
    "scroll_down",
    "move",
    "drag",
    "enter",
    "leave",
];
const POINTER_BUTTONS: &[&str] = &["left", "right", "middle"];

fn pointer(pointer: &Value) -> Option<Value> {
    (pointer["column"].is_u64()
        && pointer["row"].is_u64()
        && pointer["action"]
            .as_str()
            .is_some_and(|action| POINTER_ACTIONS.contains(&action))
        && pointer.get("button").is_some_and(|button| {
            button.is_null()
                || button
                    .as_str()
                    .is_some_and(|b| POINTER_BUTTONS.contains(&b))
        })
        && (pointer["half"].is_null() || matches!(pointer["half"].as_u64(), Some(0 | 1))))
    .then(|| {
        json!({"column": pointer["column"], "row": pointer["row"], "half": pointer["half"],
            "action": pointer["action"], "button": pointer["button"]})
    })
}

/// A client's event rebuilt from its kind's fields only, under 64 KiB; `origin`, `events`, `anchor` and the like stay the host's.
fn event_payload(event: &Value) -> Result<serde_json::Map<String, Value>, String> {
    let invalid = |reason: &str| format!("component_event_invalid: {reason}");
    if event.to_string().len() > EVENT_BYTES {
        return Err(invalid("event exceeds 64 KiB"));
    }
    let kind = event["kind"].as_str().unwrap_or_default();
    let fields: Option<Vec<(&str, Value)>> = match kind {
        "change" if event["value"].is_string() => Some(vec![("value", event["value"].clone())]),
        "change" => event["values"]
            .as_array()
            .filter(|values| values.iter().all(Value::is_string))
            .map(|_| vec![("values", event["values"].clone())]),
        "pointer" => pointer(&event["pointer"]).map(|pointer| vec![("pointer", pointer)]),
        "scroll" => event["offset"]
            .is_number()
            .then(|| vec![("offset", event["offset"].clone())]),
        "key" => (event["key"].is_string()
            && (event["text"].is_null() || event["text"].is_string()))
        .then(|| {
            vec![
                ("key", event["key"].clone()),
                ("text", event["text"].clone()),
            ]
        }),
        "focus" => Some(Vec::new()),
        _ => {
            return Err(invalid(
                "kind must be change, pointer, focus, scroll or key",
            ));
        }
    };
    let fields = fields.ok_or_else(|| invalid("event is missing its kind's fields"))?;
    Ok(std::iter::once(("kind", Value::from(kind)))
        .chain(fields)
        .map(|(name, value)| (name.to_owned(), value))
        .collect())
}

struct Module {
    owner: String,
    module: String,
    size: (u64, u64),
    revoked: Arc<AtomicBool>,
}

static MODULES: Mutex<BTreeMap<(String, String), Module>> = Mutex::new(BTreeMap::new());

fn instance(client: &str, component: &str) -> String {
    format!("client.{client}.{component}")
}

fn revoke(client: &str, component: &str, module: &Module) {
    module.revoked.store(true, Ordering::Release);
    codex_omd::client_component_unmount(client, &module.owner, &instance(client, component));
}

/// Unmounts the client module instances the published view no longer gives the same owner and module.
pub(super) fn reconcile(views: &view::Views, snapshot: &ModViewSnapshot) {
    let Ok(mut modules) = MODULES.lock() else {
        return;
    };
    modules.retain(|(client, component), module| {
        if !client_core(client).is_ok_and(|core| std::ptr::eq(&*core.views, views)) {
            return true;
        }
        let current = snapshot.component_owners.get(component) == Some(&module.owner)
            && snapshot
                .view
                .module(component)
                .is_some_and(|(name, _)| name == module.module);
        if !current {
            revoke(client, component, module);
        }
        current
    });
}
/// Undelivered `component_post` payloads by owner, the latest per client instance.
struct ComponentPost {
    core: std::sync::Weak<Core>,
    lead: Lead,
    owner: String,
    source: String,
    payload: Value,
    revoked: Arc<AtomicBool>,
}

static POSTS: Mutex<Vec<ComponentPost>> = Mutex::new(Vec::new());
static POSTING: Coalesce = Coalesce::new();

/// Defaults to 80 columns and rows 0 (the auto height a terminal node without `height` gets) when no size was given or rendered.
fn module_step(
    client: &str,
    component: &str,
    size: Option<(u64, u64)>,
    events: Vec<Value>,
) -> Result<Value, String> {
    static CLOCK: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let core = client_core(client)?;
    // Read under the instance table so a publication that lands after this read reconciles this entry.
    let (owner, module, props, (columns, rows), revoked) = {
        let mut modules = MODULES.lock().map_err(|_| "mod_runtime_poisoned")?;
        let snapshot = snapshot(&core)?;
        let owner = owner(&snapshot, component)?.to_owned();
        let (module, props) = snapshot
            .view
            .module(component)
            .ok_or_else(|| format!("view_stale: {component}"))?;
        let key = (client.to_owned(), component.to_owned());
        let previous = modules.remove(&key);
        let size = size
            .or(previous.as_ref().map(|previous| previous.size))
            .unwrap_or((80, 0));
        let revoked = match previous {
            Some(previous) if previous.owner == owner && previous.module == module => {
                previous.revoked
            }
            Some(previous) => {
                revoke(client, component, &previous);
                Arc::default()
            }
            None => Arc::default(),
        };
        modules.insert(
            key,
            Module {
                owner: owner.clone(),
                module: module.to_owned(),
                size,
                revoked: revoked.clone(),
            },
        );
        (owner, module.to_owned(), props.clone(), size, revoked)
    };
    let _thread =
        codex_omd::StateThread::enter(core.expansion.current().map(|lead| lead.thread.to_string()));
    let frame = json!({"instance": instance(client, component), "client": client,
        "props": props, "now": CLOCK.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64,
        "columns": columns, "rows": rows, "events": events});
    let source = core
        .runtime
        .lock()
        .map_err(|_| "mod_runtime_poisoned")?
        .grants(&owner)
        .ok_or("host_caller_inactive")?
        .source_sha256;
    let step = codex_omd::component_shared(&core.runtime, &owner, &module, frame, || {
        !revoked.load(Ordering::Acquire)
    });
    if revoked.load(Ordering::Acquire) {
        return Err(format!("view_stale: {component}"));
    }
    let step = step.map_err(|error| error.to_string())?;
    if let Some(post) = step["post"].as_object() {
        let payload = json!({"component": component, "module": module, "client": client,
            "data": post["data"]});
        if let Ok(mut posts) = POSTS.lock() {
            posts.retain(|queued| {
                queued.owner != owner
                    || queued.payload["component"] != payload["component"]
                    || queued.payload["client"] != payload["client"]
            });
            posts.push(ComponentPost {
                core: Arc::downgrade(&core),
                lead: session(&core)?,
                owner,
                source,
                payload,
                revoked,
            });
        }
        POSTING.request(deliver_posts);
    }
    Ok(step)
}

fn deliver_posts() {
    while let Some(post) = POSTS
        .lock()
        .ok()
        .and_then(|mut posts| (!posts.is_empty()).then(|| posts.remove(0)))
    {
        if post.revoked.load(Ordering::Acquire) {
            continue;
        }
        let Some(core) = post.core.upgrade() else {
            continue;
        };
        let registered = core.runtime.lock().is_ok_and(|runtime| {
            runtime.registered(&post.owner, "component_post")
                && runtime
                    .grants(&post.owner)
                    .is_some_and(|grants| grants.source_sha256 == post.source)
        });
        if registered {
            let lead = Lead {
                permission_profile: Arc::new(Mutex::new(PermissionProfile::read_only())),
                ..post.lead
            };
            let _ = block(
                &core,
                expansion::REMOTE.scope(
                    true,
                    expansion::invoke_one(&core, &lead, post.owner, "component_post", post.payload),
                ),
            );
        }
    }
}

pub fn detached(client: &str) {
    CLIENT_OWNERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(client);
    if let Ok(mut modules) = MODULES.lock() {
        modules.retain(|(owner, _), module| {
            if owner == client {
                module.revoked.store(true, Ordering::Release);
            }
            owner != client
        });
    }
    codex_omd::component_detach(client);
}

pub fn component_event(client: &str, component: &str, event: Value) -> Result<Value, String> {
    let mut payload = event_payload(&event)?;
    let core = client_core(client)?;
    let snapshot = snapshot(&core)?;
    let owner = owner(&snapshot, component)?.to_owned();
    if snapshot.view.module(component).is_some() {
        let events = codex_omd::component_events(&Value::Object(payload));
        module_step(client, component, None, events)?;
        return Ok(json!({"delivered": true}));
    }
    payload.insert("component".into(), component.into());
    payload.insert("client".into(), client.into());
    let lead = session(&core)?;
    if !core
        .runtime
        .lock()
        .map_err(|_| "mod_runtime_poisoned")?
        .registered(&owner, "component_event")
    {
        return Ok(json!({"delivered": false}));
    }
    let lead = Lead {
        permission_profile: Arc::new(Mutex::new(PermissionProfile::read_only())),
        ..lead
    };
    block(
        &core,
        expansion::REMOTE.scope(
            true,
            expansion::invoke_one(
                &core,
                &lead,
                owner,
                "component_event",
                Value::Object(payload),
            ),
        ),
    )?
    .ok_or("mod_runtime_poisoned")??;
    Ok(json!({"delivered": true}))
}

fn current(snapshot: &ModViewSnapshot, epoch: u64, revision: u64) -> Result<(), String> {
    if (snapshot.epoch, snapshot.revision) == (epoch, revision) {
        Ok(())
    } else {
        Err("action_stale: the view changed; use the latest view's token".into())
    }
}

pub fn action(
    client: &str,
    epoch: u64,
    revision: u64,
    component: &str,
    row: Option<usize>,
    value: Option<Value>,
) -> Result<Value, String> {
    let core = client_core(client)?;
    let snapshot = snapshot(&core)?;
    current(&snapshot, epoch, revision)?;
    let owner = owner(&snapshot, component)?.to_owned();
    let ModKeyAction::Command { command, args } =
        resolve_action(&snapshot.view, component, row, value.as_ref())?
    else {
        return Err(format!("action_unavailable: {component}"));
    };
    let command = codex_omd::owned_command(&owner, &command)
        .ok_or_else(|| format!("action_unavailable: {component}"))?;
    user_command(core, command, args)
}

fn user_command(core: Arc<Core>, command: String, args: String) -> Result<Value, String> {
    let lead = session(&core)?;
    let commands = core
        .runtime
        .lock()
        .map_err(|_| "mod_runtime_poisoned")?
        .commands();
    let (id, registration) = command_target(&commands, &command)
        .ok_or_else(|| format!("command_unavailable: /{command}"))?;
    let immediate = registration.immediate != Some(false);
    let active_turn = core.expansion.turn_running(lead.thread);
    if active_turn && !immediate {
        return Err(format!("command_unavailable_during_turn: /{command}"));
    }
    let input = json!({"command": command, "args": args, "owner": id, "immediate": immediate,
        "active_turn": active_turn});
    let origin = json!({"caller": "user", "thread_id": lead.thread.to_string()});
    let terminal_owner = core.terminal_owner.is_some();
    let (views, owner_host, ledger) = (core.views.clone(), core.host.clone(), lead.ledger());
    let run = expansion::run(
        &core,
        &lead,
        "command",
        Origin::UserCommand,
        move |runtime, host, active| {
            let host = std::cell::RefCell::new(host);
            let call = |caller: &str, request: ModHostCall| {
                let mut host = host.borrow_mut();
                (*host)(caller, request)
            };
            let generation = runtime
                .lock()
                .map_err(|_| "mod_runtime_poisoned")?
                .generation();
            let result = codex_omd::continue_operation(
                runtime,
                "command",
                input,
                origin,
                active,
                call,
                |effective| {
                    let args = effective["args"].as_str().unwrap_or_default().to_owned();
                    codex_omd::invoke_shared(
                        runtime,
                        &id,
                        generation,
                        "command",
                        &registration.name,
                        Value::String(args),
                        active,
                        call,
                        |_| {},
                    )
                    .map(|value| json!({"result": value}))
                },
            )
            .map_err(|error| error.to_string());
            if let Ok(mut runtime) = runtime.lock() {
                publish(
                    &mut runtime,
                    &owner_host,
                    &views,
                    terminal_owner,
                    "command",
                    ledger,
                    active,
                );
            }
            result
        },
    );
    let result =
        block(&core, expansion::REMOTE.scope(true, run))?.ok_or("mod_runtime_poisoned")??;
    let snapshot = snapshot(&core)?;
    let status = core
        .runtime
        .lock()
        .map_err(|_| "mod_runtime_poisoned")?
        .status();
    Ok(
        json!({"status": "completed", "result": result["result"], "snapshot": snapshot.as_ref(), "catalog": status}),
    )
}

pub fn render(client: &str, slot: &str, props: Value) -> Result<Value, String> {
    if slot == "module" {
        let component = props["component"]
            .as_str()
            .ok_or("render_props_invalid: a module render names its view component")?;
        let dimension = |name: &str| match &props[name] {
            Value::Null => Ok(None),
            value => value
                .as_u64()
                .filter(|cells| (1..=u64::from(u16::MAX)).contains(cells))
                .map(Some)
                .ok_or_else(|| format!("render_props_invalid: {name} must be 1 to 65535 cells")),
        };
        let size = match (dimension("columns")?, dimension("rows")?) {
            (None, None) => None,
            (columns, rows) => Some((columns.unwrap_or(80), rows.unwrap_or(0))),
        };
        let step = module_step(client, component, size, Vec::new())?;
        return Ok(
            json!({"original": props, "effective": {"next_ms": step["next_ms"]},
            "tree": step["tree"], "answeredBy": null}),
        );
    }
    if !codex_omd::MOD_RENDER_COMPONENTS
        .iter()
        .any(|(name, _)| *name == slot)
    {
        return Err(format!("render_slot_invalid: {slot}"));
    }
    if !props.is_object() {
        return Err("render_props_invalid: props must be an object".into());
    }
    let core = client_core(client)?;
    let _thread =
        codex_omd::StateThread::enter(core.expansion.current().map(|lead| lead.thread.to_string()));
    let input = json!({"component": slot, "id": format!("client:{slot}"), "surface": "inline",
        "viewport": {"columns": 80, "rows": 24}, "lifecycle": "final", "owner": null, "props": props.clone()});
    let chain = codex_omd::render_shared(&core.runtime, input, || true)
        .map_err(|error| error.to_string())?;
    Ok(
        json!({"original": props, "effective": chain.input["props"], "tree": chain.result["tree"],
            "answeredBy": chain.answered_by}),
    )
}

pub fn resource(client: &str, reference: &str) -> Result<(String, Vec<u8>), String> {
    let core = client_core(client)?;
    let snapshot = snapshot(&core)?;
    let (resource, owners) = view_resource(&snapshot, reference)
        .ok_or_else(|| format!("resource_not_in_view: {reference}"))?;
    let sources = {
        let mut runtime = core
            .input_runtime
            .lock()
            .map_err(|_| "mod_runtime_poisoned")?;
        runtime.refresh(&|| true).map_err(|e| e.to_string())?;
        runtime
            .owners()
            .into_iter()
            .map(|(id, owner)| (id, owner.sha256))
            .collect::<BTreeMap<_, _>>()
    };
    let thread = core
        .expansion
        .current()
        .map_or_else(|| "user".to_owned(), |lead| lead.thread.to_string());
    let mut last = "resource_unavailable".to_owned();
    for owner in owners {
        let Some(source) = sources.get(&owner) else {
            last = "host_caller_inactive".into();
            continue;
        };
        let loaded = codex_omd::scoped_data::ScopedDataHost::new(
            core.host.root.clone(),
            core.host.repository.clone(),
            None,
            None,
            owner,
            thread.clone(),
            source.clone(),
        )
        .and_then(|host| {
            let resources = host.resources();
            let record = resources.load(&resource, "evidence")?;
            let bytes = match (record["blob"].as_str(), &record["content"]) {
                (Some(blob), _) => resources.blob(blob)?,
                (None, Value::String(text)) => text.clone().into_bytes(),
                (None, content) => serde_json::to_vec(content)?,
            };
            let media_type = record["media_type"]
                .as_str()
                .unwrap_or("application/octet-stream");
            Ok((media_type.to_owned(), bytes))
        });
        match loaded {
            Ok(loaded) => return Ok(loaded),
            Err(error) => last = error.to_string(),
        }
    }
    Err(last)
}

fn store() -> Result<(PathBuf, codex_omd::ModStore), String> {
    let root = match core() {
        Ok(core) => core.host.root.clone(),
        Err(_) => std::env::var_os(codex_omd::MOD_STORE_ENV)
            .map(PathBuf::from)
            .ok_or("mod_store_unavailable: no mod store is configured")?,
    };
    let store = codex_omd::ModStore::open(root.clone())
        .map_err(|error| format!("mod_store_unavailable: {error}"))?;
    Ok((root, store))
}

pub fn recovery_read(client: &str) -> Result<Value, String> {
    let (root, store) = store()?;
    recovery_read_from(client, &root, &store)
}

fn recovery_read_from(
    client: &str,
    root: &std::path::Path,
    store: &codex_omd::ModStore,
) -> Result<Value, String> {
    let core = match client_core(client) {
        Ok(core) => core,
        Err(_) if core().is_err() => {
            let status = std::fs::read(root.join("mod-status.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .unwrap_or_default();
            let (mods, store_error) = match store.selection_status() {
                Ok(selections) => (recovery_entries(&selections, &status), Value::Null),
                Err(error) => (Vec::new(), Value::from(error.to_string())),
            };
            return Ok(
                json!({"mods":mods,"resettable":RESETTABLE,"store_error":store_error,
                "activation_error":status["activation_error"],"reload_error":status["reload_error"]}),
            );
        }
        Err(error) => return Err(error),
    };
    let mut runtime = core
        .input_runtime
        .lock()
        .map_err(|_| "mod_runtime_poisoned")?;
    let refresh_error = runtime
        .refresh(&|| true)
        .err()
        .map(|error| error.to_string());
    let status = runtime.status();
    let (mods, store_error) = match store.selection_status().and_then(|mut selections| {
        let projected =
            runtime.configuration_listing(json!({"packages":selections["selections"]}))?;
        selections["selections"] = projected["packages"].clone();
        Ok(selections)
    }) {
        Ok(selections) => (
            recovery_entries(&selections, &status),
            refresh_error.map_or(Value::Null, Value::from),
        ),
        Err(error) => (Vec::new(), Value::from(error.to_string())),
    };
    Ok(
        json!({"mods": mods, "resettable": RESETTABLE, "store_error": store_error,
        "activation_error": status["activation_error"], "reload_error": status["reload_error"]}),
    )
}

fn recovery_entries(selections: &Value, status: &Value) -> Vec<Value> {
    let listed = |key: &str| status[key].as_array().cloned().unwrap_or_default();
    let (rejected, loaded) = (listed("rejected"), listed("mods"));
    selections["selections"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|selection| {
            let failure = rejected
                .iter()
                .find(|item| item["path"] == selection["path"])
                .and_then(|item| item["reason"].as_str())
                .or_else(|| {
                    loaded
                        .iter()
                        .find(|item| item["id"] == selection["id"] && item["scope"] == selection["scope"])
                        .and_then(|item| item["error"].as_str())
                });
            let error = failure.or(selection["error"].as_str());
            json!({"id": selection["id"], "path": selection["path"], "scope": selection["scope"],
                "enabled": selection.get("enabled").unwrap_or(&selection["selected"]).as_bool() == Some(true),
                "inherited_enabled": selection.get("inherited_enabled").filter(|value| !value.is_null()).unwrap_or(&selection["selected"]),
                "settings":selection["settings"], "inherited_settings":selection["inherited_settings"], "overrides":selection["overrides"],
                "packaged": selection["packaged"] == true,
                "failing": failure.is_some(), "error": error})
        })
        .collect()
}

pub fn recovery_apply(client: Option<&str>, action: &str, target: &str) -> Result<Value, String> {
    match action {
        "enable" | "disable" | "reset" => {
            return Err(codex_omd::client_surface::needs_terminal_error(&format!(
                "omd/recovery/apply {action}"
            )));
        }
        "reload" => {}
        _ => return Err(format!("recovery_action_invalid: {action}")),
    }
    let selected = client.map(client_core).transpose()?;
    let selected = selected.or_else(|| core().ok());
    if let Some(core) = &selected {
        idle(core)?;
    }
    let (_, store) = store()?;
    store.reload().map_err(|error| error.to_string())?;
    if let Some(core) = selected {
        core.input_runtime
            .lock()
            .map_err(|_| "mod_runtime_poisoned")?
            .reload()
            .map_err(|error| error.to_string())?;
        reloaded(&core);
    }
    Ok(json!({"action": action, "target": target, "status": "applied"}))
}

pub(super) fn idle(core: &Core) -> Result<(), String> {
    match core.expansion.current() {
        Some(lead) if core.expansion.turn_running(lead.thread) => {
            Err("recovery_unavailable_during_turn: reload after the turn ends".into())
        }
        _ => Ok(()),
    }
}

pub(super) fn reloaded(core: &Core) {
    match core.expansion.current() {
        Some(lead) => {
            let refreshed = refresh_turn(&lead.host, &lead.session, &core.runtime);
            core.views
                .diagnostic(&core.host, "session_refresh", refreshed);
        }
        None => {
            if let Ok(mut runtime) = core.runtime.lock() {
                runtime.turn_boundary(&|| true);
            }
        }
    }
    republish(core);
}

fn components(view: &ModView) -> Vec<&ModComponent> {
    let mut all = Vec::new();
    for component in view.sites.values().flat_map(|site| &site.components) {
        component.descendants(&mut all);
    }
    all
}

/// The command a Space/Enter on `component` runs, with `row` or `value` checked against the view's own options.
fn resolve_action(
    view: &ModView,
    component: &str,
    row: Option<usize>,
    value: Option<&Value>,
) -> Result<ModKeyAction, String> {
    use ModComponent as C;
    let invalid = || format!("action_value_invalid: {component}");
    let target = components(view)
        .into_iter()
        .find(|candidate| candidate.id() == Some(component))
        .ok_or_else(|| format!("view_stale: {component}"))?;
    let text = || {
        value
            .map(|value| value.as_str().ok_or_else(invalid))
            .transpose()
    };
    let pick = |values: Vec<&str>, current: Option<&str>| {
        let picked = match (row, text()?) {
            (Some(row), _) => values.get(row).copied(),
            (None, Some(text)) => values.iter().copied().find(|value| *value == text),
            (None, None) => current
                .filter(|current| values.contains(current))
                .or(values.first().copied()),
        };
        picked.map(str::to_owned).ok_or_else(invalid)
    };
    Ok(match target {
        C::Button {
            action: ModComponentAction::Command(action),
            ..
        } => action.with_value(None),
        C::Input {
            action,
            value: current,
            ..
        } => action.with_value(Some(text()?.unwrap_or(current.as_str()))),
        C::Select {
            action,
            options,
            value: current,
            ..
        } => {
            let values = options.iter().map(|option| option.value.as_str()).collect();
            action.with_value(Some(&pick(values, Some(current.as_str()))?))
        }
        C::List {
            action,
            rows,
            selected,
            ..
        } => {
            let values = rows.iter().map(|row| row.value.as_str()).collect();
            action.with_value(Some(&pick(values, selected.as_deref())?))
        }
        C::Multiselect {
            action,
            options,
            value: current,
            ..
        } => {
            let checked: Vec<String> = match value {
                Some(value) => serde_json::from_value(value.clone()).map_err(|_| invalid())?,
                None => current.clone(),
            };
            if !checked
                .iter()
                .all(|value| options.iter().any(|option| option.value == *value))
            {
                return Err(invalid());
            }
            let values = options
                .iter()
                .map(|option| &option.value)
                .filter(|value| checked.contains(value))
                .collect::<Vec<_>>();
            action.with_value(Some(
                &serde_json::to_string(&values).map_err(|error| error.to_string())?,
            ))
        }
        C::Document {
            action: Some(action),
            lines,
            anchors,
            ..
        } => {
            let text = text()?.ok_or_else(invalid)?;
            if !anchors.iter().any(|anchor| anchor == text) && !line(text, lines.len()) {
                return Err(invalid());
            }
            action.with_value(Some(text))
        }
        C::Diff {
            action: Some(action),
            unified,
            ..
        } => {
            let text = text()?.ok_or_else(invalid)?;
            if !line(text, unified.lines().count()) {
                return Err(invalid());
            }
            action.with_value(Some(text))
        }
        _ => return Err(format!("action_unavailable: {component}")),
    })
}

/// A 1-based line number within `count` lines, as the terminal's document activation sends.
fn line(text: &str, count: usize) -> bool {
    text.parse::<usize>()
        .is_ok_and(|line| (1..=count).contains(&line))
}

/// Resolves `owner:name` or a bare name registered by exactly one mod.
fn command_target(
    commands: &[(String, ModCommand)],
    invocation: &str,
) -> Option<(String, ModCommand)> {
    match invocation.split_once(':') {
        Some((owner, name)) => commands
            .iter()
            .find(|(id, command)| id == owner && command.name == name)
            .cloned(),
        None => {
            let mut matching = commands
                .iter()
                .filter(|(_, command)| command.name == invocation);
            let first = matching.next()?;
            matching.next().is_none().then(|| first.clone())
        }
    }
}

fn view_resource(
    snapshot: &ModViewSnapshot,
    reference: &str,
) -> Option<(ResourceRef, Vec<String>)> {
    let owned = |id: &str| {
        snapshot
            .component_owners
            .get(id)
            .cloned()
            .into_iter()
            .collect::<Vec<_>>()
    };
    components(&snapshot.view)
        .into_iter()
        .find_map(|component| match component {
            ModComponent::Image { id, image, .. } if image.reference == reference => {
                Some((image.clone(), owned(id)))
            }
            ModComponent::Document {
                id,
                source: Some(source),
                ..
            } if source.reference == reference => Some((source.clone(), owned(id))),
            _ => None,
        })
}

#[cfg(test)]
#[path = "clients_tests.rs"]
mod tests;
