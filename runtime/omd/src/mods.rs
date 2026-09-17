mod process;
mod store;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::io;
use std::path::Path;
use std::path::PathBuf;

pub use store::ModStore;

pub const MOD_API_VERSION: &str = "0.1.0-experimental.1";
pub const MOD_CAPABILITIES: &[&str] = &["context", "tools", "commands", "lifecycle", "state"];
type Result<T> = io::Result<T>;

fn failure(message: impl ToString) -> io::Error {
    io::Error::other(message.to_string())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModPackage {
    pub schema: u32,
    pub id: String,
    pub version: String,
    pub api: String,
    pub state_version: u32,
    pub capabilities: Vec<String>,
}

impl ModPackage {
    fn validate(&self) -> Result<()> {
        if self.schema != 1
            || self.api != MOD_API_VERSION
            || !identifier(&self.id)
            || self.id.len() > 24
            || self.version.is_empty()
            || self.version.len() > 64
            || self.state_version != 1
        {
            return Err(failure(
                "incompatible_package: schema=1, exact experimental API and state_version=1 required",
            ));
        }
        let capabilities: BTreeSet<_> = self.capabilities.iter().collect();
        if capabilities.len() != self.capabilities.len()
            || self
                .capabilities
                .iter()
                .any(|c| !MOD_CAPABILITIES.contains(&c.as_str()))
        {
            return Err(failure("unsupported_or_duplicate_capability"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModSelection {
    pub path: PathBuf,
    pub sha256: String,
    pub enabled: bool,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub settings: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModConfiguration {
    pub schema: u32,
    #[serde(default)]
    pub revision: u64,
    pub node: PathBuf,
    pub mods: Vec<ModSelection>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModTool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Registrations {
    tools: Vec<ModTool>,
    commands: Vec<String>,
    events: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    registrations: Registrations,
    state: Value,
    value: Value,
}

struct Loaded {
    package: ModPackage,
    selection: ModSelection,
    source: String,
    state: Value,
    registrations: Registrations,
    error: Option<String>,
}

pub struct ModHost {
    store: ModStore,
    node: PathBuf,
    generation: u64,
    configuration_sha256: String,
    loaded: BTreeMap<String, Loaded>,
    reload_error: Option<String>,
}

impl ModHost {
    pub fn open(root: PathBuf) -> Result<Self> {
        let store = ModStore::open(root)?;
        let mut host = Self {
            store,
            node: PathBuf::new(),
            generation: 0,
            configuration_sha256: String::new(),
            loaded: BTreeMap::new(),
            reload_error: None,
        };
        host.reload()?;
        Ok(host)
    }

    pub fn reload(&mut self) -> Result<bool> {
        let bytes = store::read(&self.store.root.join("mods.json"), 65_536)?;
        let hash = digest(&bytes);
        if hash == self.configuration_sha256 {
            return Ok(false);
        }
        let config: ModConfiguration = serde_json::from_slice(&bytes)?;
        if config.schema != 1 || config.mods.len() > 16 || !config.node.is_absolute() {
            return Err(failure("invalid_mod_configuration"));
        }
        let retained = self.loaded.len();
        self.loaded.retain(|_, loaded| {
            config.mods.iter().any(|m| {
                m.enabled
                    && m.path == loaded.selection.path
                    && loaded
                        .package
                        .capabilities
                        .iter()
                        .all(|cap| m.capabilities.contains(cap))
            })
        });
        if self.loaded.len() != retained {
            self.generation += 1;
        }
        let mut next = BTreeMap::new();
        let mut tool_names = BTreeSet::new();
        for selection in config.mods.into_iter().filter(|m| m.enabled) {
            let (package, source, hash) = store::package(&selection.path)?;
            if hash != selection.sha256 {
                return Err(failure(format!("untrusted_source: {}", package.id)));
            }
            let granted: BTreeSet<_> = selection.capabilities.iter().collect();
            if package.capabilities.iter().any(|c| !granted.contains(c))
                || selection
                    .capabilities
                    .iter()
                    .any(|c| !MOD_CAPABILITIES.contains(&c.as_str()))
            {
                return Err(failure(format!("capability_denied: {}", package.id)));
            }
            if next.contains_key(&package.id) {
                return Err(failure(format!("mod_conflict: {}", package.id)));
            }
            let state = self.store.state(&package.id, package.state_version)?;
            let mut loaded = Loaded {
                package,
                source,
                selection,
                state,
                registrations: Registrations::default(),
                error: None,
            };
            let reply = Self::run(&config.node, &loaded, "inspect", "", Value::Null, &|| true)?;
            Self::validate_registrations(&loaded.package, &reply.registrations)?;
            if reply.state != loaded.state {
                return Err(failure("state_write_during_registration"));
            }
            for tool in &reply.registrations.tools {
                if !tool_names.insert(format!("mod_{}_{}", loaded.package.id, tool.name)) {
                    return Err(failure("tool_name_conflict"));
                }
            }
            loaded.registrations = reply.registrations;
            next.insert(loaded.package.id.clone(), loaded);
        }
        self.node = config.node;
        self.loaded = next;
        self.configuration_sha256 = hash;
        self.generation += 1;
        self.reload_error = None;
        Ok(true)
    }

    fn validate_registrations(package: &ModPackage, registrations: &Registrations) -> Result<()> {
        let has = |cap: &str| package.capabilities.iter().any(|c| c == cap);
        if registrations.tools.len() > 16
            || registrations.commands.len() > 16
            || registrations.events.len() > 6
            || (!registrations.tools.is_empty() && !has("tools"))
            || (!registrations.commands.is_empty() && !has("commands"))
        {
            return Err(failure("registration_limit_or_capability_denied"));
        }
        let mut names = BTreeSet::new();
        for tool in &registrations.tools {
            if !identifier(&tool.name)
                || !names.insert(&tool.name)
                || tool.description.is_empty()
                || tool.description.len() > 2048
                || tool.parameters["type"] != "object"
                || !tool.parameters["properties"].is_object()
                || serde_json::to_vec(&tool.parameters)?.len() > 8192
            {
                return Err(failure("invalid_tool_registration"));
            }
        }
        names.clear();
        for name in &registrations.commands {
            if !identifier(name) || !names.insert(name) {
                return Err(failure("command_conflict"));
            }
        }
        names.clear();
        for event in &registrations.events {
            let capability = match event.as_str() {
                "context" => "context",
                "start" | "idle" | "stop" | "resume" | "tool_result" => "lifecycle",
                _ => return Err(failure("unsupported_event")),
            };
            if !has(capability) || !names.insert(event) {
                return Err(failure("event_capability_denied_or_conflict"));
            }
        }
        Ok(())
    }

    fn run(
        node: &Path,
        loaded: &Loaded,
        event: &str,
        name: &str,
        payload: Value,
        active: &dyn Fn() -> bool,
    ) -> Result<Reply> {
        let request = json!({"source": loaded.source, "filename": loaded.selection.path.join("index.ts"),
            "capabilities": loaded.package.capabilities, "settings": loaded.selection.settings,
            "state": loaded.state, "event": event, "name": name, "payload": payload});
        serde_json::from_value(process::evaluate(node, &request, active)?).map_err(failure)
    }

    pub fn invoke(
        &mut self,
        id: &str,
        generation: u64,
        event: &str,
        name: &str,
        payload: Value,
    ) -> Result<Value> {
        self.invoke_guarded(id, generation, event, name, payload, || true)
    }

    pub fn invoke_guarded(
        &mut self,
        id: &str,
        generation: u64,
        event: &str,
        name: &str,
        payload: Value,
        active: impl Fn() -> bool,
    ) -> Result<Value> {
        if !active() {
            return Err(failure("callback_cancelled"));
        }
        if generation != self.generation {
            return Err(failure("stale_mod_generation: retry on the next turn"));
        }
        let loaded = self
            .loaded
            .get_mut(id)
            .ok_or_else(|| failure("mod_disabled"))?;
        if loaded.error.is_some() {
            return Err(failure("mod_failed: explicitly reload to recover"));
        }
        let result = (|| {
            match event {
                "tool" if loaded.registrations.tools.iter().any(|t| t.name == name) => (),
                "command" if loaded.registrations.commands.iter().any(|c| c == name) => (),
                e if loaded
                    .registrations
                    .events
                    .iter()
                    .any(|registered| registered == e) => {}
                _ => return Err(failure("unsupported_or_unregistered_operation")),
            }
            let reply = Self::run(&self.node, loaded, event, name, payload, &active)?;
            if !active() {
                return Err(failure("callback_cancelled"));
            }
            if reply.registrations != loaded.registrations {
                return Err(failure("registration_changed_during_callback"));
            }
            if event == "context" && !reply.value.is_null() {
                let text = reply
                    .value
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_context_result"))?;
                if text.len() > 1024 {
                    return Err(failure("context_limit"));
                }
            }
            if reply.state != loaded.state {
                if !loaded.package.capabilities.iter().any(|c| c == "state") {
                    return Err(failure("state_capability_denied"));
                }
                self.store.write_state(
                    &loaded.package.id,
                    loaded.package.state_version,
                    &loaded.state,
                    &reply.state,
                )?;
                loaded.state = reply.state;
            }
            Ok(reply.value)
        })();
        if let Err(error) = &result {
            loaded.error = Some(error.to_string());
        }
        result
    }

    pub fn event(&mut self, event: &str, payload: Value) -> Vec<(String, Result<Value>)> {
        self.event_guarded(event, payload, || true)
    }

    pub fn event_guarded(
        &mut self,
        event: &str,
        payload: Value,
        active: impl Fn() -> bool,
    ) -> Vec<(String, Result<Value>)> {
        let ids: Vec<_> = self
            .loaded
            .iter()
            .filter(|(_, m)| m.error.is_none() && m.registrations.events.iter().any(|e| e == event))
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .map(|id| {
                let result =
                    self.invoke_guarded(&id, self.generation, event, "", payload.clone(), &active);
                (id, result)
            })
            .collect()
    }

    pub fn turn_boundary(&mut self) {
        if let Err(error) = self.reload() {
            self.reload_error = Some(error.to_string());
        }
    }

    pub fn tools(&self) -> Vec<(String, u64, ModTool)> {
        self.loaded
            .iter()
            .filter(|(_, m)| m.error.is_none())
            .flat_map(|(id, m)| {
                m.registrations
                    .tools
                    .iter()
                    .map(|tool| (id.clone(), self.generation, tool.clone()))
            })
            .collect()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn status(&self) -> Value {
        json!({"api": MOD_API_VERSION, "generation": self.generation, "reload_error": self.reload_error,
            "mods": self.loaded.iter().map(|(id, m)| json!({"id": id, "version": m.package.version,
                "sha256": m.selection.sha256, "capabilities": m.package.capabilities,
                "registrations": m.registrations, "error": m.error})).collect::<Vec<_>>()})
    }
}
