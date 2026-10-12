use super::*;
use codex_omd::ModBackdrop;
use codex_omd::ModCommand;
use codex_omd::ModComponent;
use codex_omd::ModComponentAction;
use codex_omd::ModKeyAction;
use codex_omd::ModView;
use codex_omd::ModViewSnapshot;
use codex_omd::data_store::Origin;
use codex_omd::resource_data::ResourceRef;

const RESETTABLE: &[&str] = &["host.json", "mods.json"];

struct Installed {
    core: std::sync::Weak<Core>,
    handle: Option<tokio::runtime::Handle>,
    _roster: codex_omd::client_surface::Registration,
}

static INSTALLED: Mutex<Option<Installed>> = Mutex::new(None);

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

pub(super) fn install(core: &Arc<Core>) {
    let weak = Arc::downgrade(core);
    let roster = codex_omd::client_surface::register_observer(Arc::new(move |observed| {
        if matches!(observed, codex_omd::client_surface::Observed::Roster) {
            let weak = weak.clone();
            REPUBLISH.request(move || {
                if let Some(core) = weak.upgrade() {
                    republish(&core);
                }
            });
        }
    }));
    if let Ok(mut installed) = INSTALLED.lock() {
        *installed = Some(Installed {
            core: Arc::downgrade(core),
            handle: tokio::runtime::Handle::try_current().ok(),
            _roster: roster,
        });
    }
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
        core.views.quiet.store(true, Ordering::Release);
        publish(&mut runtime, &core.host, &core.views, event, ledger, || {
            true
        });
        core.views.quiet.store(false, Ordering::Release);
    }
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

fn block<T>(future: impl std::future::Future<Output = T>) -> Result<T, String> {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            Ok(tokio::task::block_in_place(|| handle.block_on(future)))
        }
        Ok(_) => Err(
            "host_operation_unavailable: client calls need the multi-threaded session runtime"
                .into(),
        ),
        Err(_) => INSTALLED
            .lock()
            .ok()
            .and_then(|installed| installed.as_ref()?.handle.clone())
            .map(|handle| handle.block_on(future))
            .ok_or_else(|| "host_operation_unavailable: no session runtime".into()),
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

/// The published view, or `None` while mods are inactive or before the host publishes its first one.
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

/// Each client's module instances and the size it last rendered them at.
static MODULE_SIZES: Mutex<BTreeMap<(String, String), (u64, u64)>> = Mutex::new(BTreeMap::new());
/// Undelivered `component_post` payloads by owner, the latest per client instance.
static POSTS: Mutex<Vec<(String, Value)>> = Mutex::new(Vec::new());
static POSTING: Coalesce = Coalesce::new();

/// Steps this client's own instance of a component module, delivering `events` and any due ticks
/// at the size given or last rendered (80×24 by default).
fn module_step(
    client: &str,
    component: &str,
    size: Option<(u64, u64)>,
    events: Vec<Value>,
) -> Result<Value, String> {
    static CLOCK: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let core = core()?;
    let snapshot = snapshot(&core)?;
    let owner = owner(&snapshot, component)?.to_owned();
    let (module, props) = snapshot
        .view
        .module(component)
        .ok_or_else(|| format!("view_stale: {component}"))?;
    let (columns, rows) = {
        let mut sizes = MODULE_SIZES.lock().map_err(|_| "mod_runtime_poisoned")?;
        let size = size.unwrap_or_else(|| {
            sizes
                .get(&(client.to_owned(), component.to_owned()))
                .copied()
                .unwrap_or((80, 24))
        });
        sizes.insert((client.to_owned(), component.to_owned()), size);
        size
    };
    let _thread =
        codex_omd::StateThread::enter(core.expansion.current().map(|lead| lead.thread.to_string()));
    let frame = json!({"instance": format!("client.{client}.{component}"), "client": client,
        "props": props, "now": CLOCK.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64,
        "columns": columns, "rows": rows, "events": events});
    let step = codex_omd::component_shared(&core.runtime, &owner, module, frame, || true)
        .map_err(|error| error.to_string())?;
    if let Some(post) = step["post"].as_object() {
        let payload = json!({"component": component, "module": module, "client": client,
            "data": post["data"]});
        if let Ok(mut posts) = POSTS.lock() {
            posts.retain(|(queued, queued_payload)| {
                *queued != owner
                    || queued_payload["component"] != payload["component"]
                    || queued_payload["client"] != payload["client"]
            });
            posts.push((owner, payload));
        }
        POSTING.request(deliver_posts);
    }
    Ok(step)
}

/// Delivers queued posts to their owners' `component_post` hooks off the client's request.
fn deliver_posts() {
    while let Some((owner, payload)) = POSTS
        .lock()
        .ok()
        .and_then(|mut posts| (!posts.is_empty()).then(|| posts.remove(0)))
    {
        let Ok(core) = core() else {
            return;
        };
        let registered = core
            .runtime
            .lock()
            .is_ok_and(|runtime| runtime.registered(&owner, "component_post"));
        let Ok(lead) = session(&core) else {
            return;
        };
        if registered {
            let lead = Lead {
                permission_profile: Arc::new(Mutex::new(PermissionProfile::read_only())),
                ..lead
            };
            let _ = block(expansion::REMOTE.scope(
                true,
                expansion::invoke_one(&core, &lead, owner, "component_post", payload),
            ));
        }
    }
}

/// Unmounts a detached client's module instances.
pub fn detached(client: &str) {
    if let Ok(mut sizes) = MODULE_SIZES.lock() {
        sizes.retain(|(owner, _), _| owner != client);
    }
    codex_omd::component_detach(client);
}

pub fn component_event(client: &str, component: &str, event: Value) -> Result<Value, String> {
    let mut payload = event_payload(&event)?;
    let core = core()?;
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
    block(expansion::REMOTE.scope(
        true,
        expansion::invoke_one(
            &core,
            &lead,
            owner,
            "component_event",
            Value::Object(payload),
        ),
    ))?
    .ok_or("mod_runtime_poisoned")??;
    Ok(json!({"delivered": true}))
}

/// The action token was issued for `(epoch, revision)`; a newer view makes it stale.
fn current(snapshot: &ModViewSnapshot, epoch: u64, revision: u64) -> Result<(), String> {
    if (snapshot.epoch, snapshot.revision) == (epoch, revision) {
        Ok(())
    } else {
        Err("action_stale: the view changed; use the latest view's token".into())
    }
}

pub fn action(
    _client: &str,
    epoch: u64,
    revision: u64,
    component: &str,
    row: Option<usize>,
    value: Option<Value>,
) -> Result<Value, String> {
    let core = core()?;
    let snapshot = snapshot(&core)?;
    current(&snapshot, epoch, revision)?;
    owner(&snapshot, component)?;
    let ModKeyAction::Command { command, args } =
        resolve_action(&snapshot.view, component, row, value.as_ref())?
    else {
        return Err(format!("action_unavailable: {component}"));
    };
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
                publish(&mut runtime, &owner_host, &views, "command", ledger, active);
            }
            result
        },
    );
    let result = block(expansion::REMOTE.scope(true, run))?.ok_or("mod_runtime_poisoned")??;
    Ok(json!({"status": "completed", "result": result["result"]}))
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
            (columns, rows) => Some((columns.unwrap_or(80), rows.unwrap_or(24))),
        };
        let step = module_step(client, component, size, Vec::new())?;
        return Ok(json!({"original": props, "effective": {"next_ms": step["next_ms"]},
            "tree": step["tree"], "answeredBy": null}));
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
    let core = core()?;
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

pub fn resource(reference: &str) -> Result<(String, Vec<u8>), String> {
    let core = core()?;
    let snapshot = snapshot(&core)?;
    let (resource, owners) = view_resource(&snapshot, reference)
        .ok_or_else(|| format!("resource_not_in_view: {reference}"))?;
    let sources = core
        .runtime
        .lock()
        .map_err(|_| "mod_runtime_poisoned")?
        .owners()
        .into_iter()
        .map(|(id, owner)| (id, owner.sha256))
        .collect::<BTreeMap<_, _>>();
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

/// The running host's store, or the configured one when mods failed to start.
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

pub fn recovery_read() -> Result<Value, String> {
    let (root, store) = store()?;
    let status = std::fs::read(root.join("mod-status.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or_default();
    let (mods, store_error) = match store.selection_status() {
        Ok(selections) => (recovery_entries(&selections, &status), Value::Null),
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
                        .find(|item| item["id"] == selection["id"])
                        .and_then(|item| item["error"].as_str())
                });
            let error = failure.or(selection["error"].as_str());
            json!({"id": selection["id"], "path": selection["path"], "scope": selection["scope"],
                "enabled": selection["selected"] == true, "packaged": selection["packaged"] == true,
                "failing": failure.is_some(), "error": error})
        })
        .collect()
}

pub fn recovery_apply(action: &str, target: &str) -> Result<Value, String> {
    match action {
        "enable" | "disable" | "reset" => {
            return Err(codex_omd::client_surface::needs_terminal_error(&format!(
                "omd/recovery/apply {action}"
            )));
        }
        "reload" => {}
        _ => return Err(format!("recovery_action_invalid: {action}")),
    }
    if let Ok(core) = core() {
        idle(&core)?;
    }
    let (_, store) = store()?;
    store.reload().map_err(|error| error.to_string())?;
    if let Ok(core) = core() {
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
        Some(lead) => refresh_turn(&lead.host, &lead.session, &core.runtime),
        None => {
            if let Ok(mut runtime) = core.runtime.lock() {
                runtime.turn_boundary();
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
        .or_else(|| match &snapshot.view.backdrop {
            Some(ModBackdrop::Image { image, .. }) if image.resource.reference == reference => {
                Some((image.resource.clone(), snapshot.contributors.clone()))
            }
            _ => None,
        })
}

#[cfg(test)]
#[path = "clients_tests.rs"]
mod tests;
