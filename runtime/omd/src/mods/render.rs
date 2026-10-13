use super::*;
use std::os::unix::fs::MetadataExt;

const CACHE_LIMIT: usize = 512;
const TREE_BYTES: usize = 65_536;

/// Native components with a render hook and the props a hook may rewrite for the native drawing.
pub const MOD_RENDER_COMPONENTS: &[(&str, &[&str])] = &[
    ("user_message", &[]),
    ("assistant_message", &[]),
    ("tool_call", &[]),
    ("tool_result", &[]),
    ("spinner", &["header"]),
    ("turn_duration", &[]),
    ("notice", &["text"]),
    ("session_mode", &["label"]),
    ("composer_hint", &["placeholder"]),
    ("question", &[]),
    ("list", &[]),
];

pub(super) fn valid_input(original: &Value, input: &Value) -> bool {
    let alterable = MOD_RENDER_COMPONENTS
        .iter()
        .find(|(name, _)| original["component"] == *name)
        .map_or(&[][..], |(_, props)| *props);
    let (Some(before), Some(after)) = (original["props"].as_object(), input["props"].as_object())
    else {
        return false;
    };
    before.len() == after.len()
        && before.iter().all(|(key, value)| match after.get(key) {
            Some(changed) if changed != value && alterable.contains(&key.as_str()) => changed
                .as_str()
                .is_some_and(|text| value.is_string() && text.len() <= 1024),
            changed => changed == Some(value),
        })
}

pub(super) fn valid_result(result: &Value) -> bool {
    result.as_object().is_some_and(|object| object.len() == 1)
        && serde_json::to_vec(result).is_ok_and(|bytes| bytes.len() <= TREE_BYTES)
        && serde_json::from_value::<Vec<ModComponent>>(result["tree"].clone())
            .is_ok_and(|tree| view::invalid_render_tree(&tree).is_none())
}

pub(super) struct Rendered {
    generation: u64,
    reads: BTreeMap<String, BTreeSet<String>>,
    files: String,
    deps: String,
    chain: ModChain,
}

impl ModHost {
    /// Digests the state keys hooks read, or with `files` the identity of their state files.
    fn render_deps(&self, reads: &BTreeMap<String, BTreeSet<String>>, files: bool) -> String {
        let thread = bound_thread();
        let values = reads
            .iter()
            .map(|(id, keys)| {
                let Some(loaded) = self.loaded.get(id) else {
                    return Value::Null;
                };
                let location = self.state_location(
                    &loaded.package,
                    &loaded.selection.scope,
                    thread.as_deref(),
                );
                let selected = if files {
                    self.store
                        .state_file(&location)
                        .and_then(|path| std::fs::metadata(path).ok())
                        .map_or(Value::Null, |file| {
                            json!([file.ino(), file.len(), file.mtime(), file.mtime_nsec()])
                        })
                } else {
                    let state = self
                        .store
                        .scoped_state(&location, loaded.package.state_version)
                        .unwrap_or(Value::Null);
                    if keys.contains("*") {
                        state
                    } else {
                        Value::Array(keys.iter().map(|key| state[key].clone()).collect())
                    }
                };
                json!([
                    id,
                    loaded.selection.sha256,
                    loaded.selection.settings,
                    thread,
                    self.ui_binding(id, thread.as_deref()),
                    selected
                ])
            })
            .collect::<Vec<_>>();
        digest(Value::Array(values).to_string().as_bytes())
    }
}

/// Runs one frame step of a mod's component module without host authority: its events, due ticks and
/// view, answering `{tree, post, next_ms}`. An error stops the instance's runner, unmounting it.
pub fn component_shared(
    runtime: &Mutex<ModHost>,
    id: &str,
    component: &str,
    frame: Value,
    active: impl Fn() -> bool,
) -> Result<Value> {
    let generation = runtime
        .lock()
        .map_err(|_| failure("mod_runtime_poisoned"))?
        .generation;
    let instance = frame["instance"].as_str().unwrap_or(component).to_owned();
    let owner = frame["client"].as_str().unwrap_or_default().to_owned();
    let value = invoke_shared(
        runtime,
        id,
        generation,
        "component",
        component,
        frame,
        active,
        |_, call| {
            Err(failure(format!(
                "host_operation_unavailable: {} is not available to component modules",
                call.operation
            )))
        },
        |_| {},
    )?;
    if let Err(error) = checked_tree(&value) {
        process::unmount(&owner, id, &instance);
        return Err(error);
    }
    Ok(value)
}

/// A component module step's tree must parse, pass the render checks, stay under 64 KiB and not draw the native component.
pub(super) fn checked_tree(step: &Value) -> Result<()> {
    let tree = serde_json::from_value::<Vec<ModComponent>>(step["tree"].clone())
        .map_err(|error| failure(format!("invalid_component_tree: {error}")))?;
    if let Some(reason) = view::invalid_render_tree(&tree).or_else(|| {
        (tree
            .iter()
            .any(|node| node.contains(&|node| matches!(node, ModComponent::Native { .. })))
            || serde_json::to_vec(&step["tree"]).map_or(true, |bytes| bytes.len() > TREE_BYTES))
        .then(|| "the tree draws the native component or exceeds 64 KiB".to_owned())
    }) {
        return Err(failure(format!("invalid_component_tree: {reason}")));
    }
    Ok(())
}

pub fn component_unmount(id: &str, component: &str) {
    process::unmount("", id, component);
}

/// Unmounts every component module instance a detached client had mounted.
pub fn component_detach(client: &str) {
    process::detach(client);
}

/// A component's input event as the key and pointer events a component module receives.
pub fn component_events(payload: &Value) -> Vec<Value> {
    match payload["kind"].as_str() {
        Some("input") => payload["events"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|event| match event.get("paste") {
                Some(paste) => json!({"kind": "key", "key": null, "text": paste}),
                None => json!({"kind": "key", "key": event["key"], "text": event["text"]}),
            })
            .collect(),
        Some("key") => vec![json!({"kind": "key", "key": payload["key"], "text": payload["text"]})],
        Some("pointer") => {
            let mut pointer = payload["pointer"].clone();
            if let Some(object) = pointer.as_object_mut() {
                object.remove("fraction");
                object.insert("kind".into(), "pointer".into());
            }
            vec![pointer]
        }
        _ => Vec::new(),
    }
}

/// Runs the `render` chain for one component instance; a cached tree stands while the state keys its hooks read hold.
pub fn render_shared(
    runtime: &Mutex<ModHost>,
    input: Value,
    active: impl Fn() -> bool,
) -> Result<ModChain> {
    let key = digest(json!([bound_thread(), input]).to_string().as_bytes());
    let cached = {
        let mut runtime = runtime
            .lock()
            .map_err(|_| failure("mod_runtime_poisoned"))?;
        let hit = runtime
            .rendered
            .get(&key)
            .filter(|entry| entry.generation == runtime.generation)
            .and_then(|entry| {
                let files = runtime.render_deps(&entry.reads, true);
                (files == entry.files || runtime.render_deps(&entry.reads, false) == entry.deps)
                    .then(|| (files, entry.chain.clone()))
            });
        hit.map(|(files, chain)| {
            if let Some(entry) = runtime.rendered.get_mut(&key) {
                entry.files = files;
            }
            chain
        })
    };
    if let Some(chain) = cached {
        return Ok(chain);
    }
    let (generation, hooked, everyone, before) = {
        let runtime = runtime
            .lock()
            .map_err(|_| failure("mod_runtime_poisoned"))?;
        let everyone = runtime
            .loaded
            .keys()
            .map(|id| (id.clone(), BTreeSet::from(["*".to_owned()])))
            .collect::<BTreeMap<_, _>>();
        let before = runtime.render_deps(&everyone, true);
        (
            runtime.generation,
            runtime.may_intercept("render", &input),
            everyone,
            before,
        )
    };
    let chain = intercept_shared(
        runtime,
        "render",
        false,
        input,
        json!({"caller": "engine"}),
        active,
        |_, call| {
            Err(failure(format!(
                "host_operation_unavailable: {} is not available while rendering",
                call.operation
            )))
        },
        |_| Ok(json!({"tree": [{"type": "native"}]})),
    )?;
    // Hooks answer even when unmatched, so no answer at all means the runtime was busy.
    let busy = (hooked && chain.reads.is_empty())
        || chain.trace.iter().any(|entry| {
            entry["reason"]
                .as_str()
                .is_some_and(|reason| reason.starts_with("mod_runtime_busy"))
        });
    if busy {
        return Err(failure("mod_runtime_busy"));
    }
    // A failed hook, or state written while hooks ran, is drawn again instead of being cached.
    let settled = chain.trace.iter().all(|entry| entry["reason"].is_null());
    let mut runtime = runtime
        .lock()
        .map_err(|_| failure("mod_runtime_poisoned"))?;
    if settled && runtime.generation == generation && runtime.render_deps(&everyone, true) == before
    {
        if runtime.rendered.len() >= CACHE_LIMIT {
            runtime.rendered.clear();
        }
        let files = runtime.render_deps(&chain.reads, true);
        let deps = runtime.render_deps(&chain.reads, false);
        runtime.rendered.insert(
            key,
            Rendered {
                generation,
                reads: chain.reads.clone(),
                files,
                deps,
                chain: chain.clone(),
            },
        );
    }
    Ok(chain)
}
