mod bridge;
mod packages;
mod pi;
pub use pi::PiPrompt;
pub use pi::parse_command_args;
pub use pi::substitute_args;
mod view;
pub use view::MOD_KEY_LIMIT;
pub use view::ModActivity;
pub use view::ModColor;
pub use view::ModKeyAction;
pub use view::ModPanel;
pub use view::ModSidebarSide;
pub use view::ModTheme;
pub use view::ModView;
pub use view::ModViewSnapshot;
pub use view::mod_command_reference;
pub use view::mod_key_name;
mod outcome;
pub use outcome::ModCommandOutcome;
pub use outcome::ModInputDecision;
mod process;
pub use bridge::ModHostCall;
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

pub const MOD_API_VERSION: &str = "0.1.0-experimental.3";
pub const MOD_CAPABILITIES: &[&str] = &[
    "context",
    "tools",
    "commands",
    "lifecycle",
    "state",
    "task",
    "agents",
    "review",
    "recovery",
    "execution",
    "interception",
    "routing",
    "terminal",
    "providers",
    "sidecars",
    "compaction",
    "pi_resources",
    "input",
    "workflow",
];
pub const MOD_EVENTS: &[(&str, &str)] = &[
    ("context", "context"),
    ("migrate", "state"),
    ("tool_before", "interception"),
    ("input", "input"),
    ("routing", "routing"),
    ("terminal", "terminal"),
    ("compaction", "compaction"),
    ("start", "lifecycle"),
    ("idle", "lifecycle"),
    ("stop", "lifecycle"),
    ("resume", "lifecycle"),
    ("tool_result", "lifecycle"),
    ("turn_start", "lifecycle"),
    ("turn_end", "lifecycle"),
    ("compaction_start", "lifecycle"),
    ("compaction_end", "lifecycle"),
    ("agent_end", "lifecycle"),
    ("workflow", "workflow"),
];
pub const MOD_REPLACEMENT_POINTS: &[&str] = &[
    "tool_before",
    "routing",
    "terminal",
    "compaction",
    "context",
    "input",
];
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter: Option<String>,
    pub capabilities: Vec<String>,
}

impl ModPackage {
    fn validate(&self) -> Result<()> {
        if self.api != MOD_API_VERSION {
            return Err(failure(format!(
                "incompatible_api: this host runs mod API {MOD_API_VERSION}; package \"{}\" declares {}. Update the package's mod.json api field and re-trust it.",
                self.id, self.api
            )));
        }
        if self.schema != 1
            || !identifier(&self.id)
            || self.id.len() > 24
            || self.version.is_empty()
            || self.version.len() > 64
            || self.state_version == 0
        {
            return Err(failure(
                "incompatible_package: schema=1, exact experimental API and positive state_version required",
            ));
        }
        if self
            .adapter
            .as_deref()
            .is_some_and(|adapter| adapter != "pi-0.74-tools-commands-v1")
        {
            return Err(failure("unsupported_adapter"));
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub description: String,
    pub parameters: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModCommand {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Registrations {
    tools: Vec<ModTool>,
    commands: Vec<ModCommand>,
    events: Vec<String>,
    #[serde(default)]
    replacements: Vec<String>,
    #[serde(default)]
    contracts: Vec<crate::WorkflowContract>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    registrations: Registrations,
    state: Value,
    value: Value,
    #[serde(default)]
    calls: Vec<ModHostCall>,
    #[serde(default)]
    host_call: Option<ModHostCall>,
    #[serde(default)]
    updates: Vec<String>,
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
    tool_validator: fn(&Value) -> Result<()>,
}

impl ModHost {
    pub fn open(root: PathBuf) -> Result<Self> {
        Self::open_validated(root, |_| Ok(()))
    }

    pub fn open_validated(root: PathBuf, tool_validator: fn(&Value) -> Result<()>) -> Result<Self> {
        let store = ModStore::open(root)?;
        let mut host = Self {
            store,
            node: PathBuf::new(),
            generation: 0,
            configuration_sha256: String::new(),
            loaded: BTreeMap::new(),
            reload_error: None,
            tool_validator,
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
        let initial = self.configuration_sha256.is_empty();
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
        let mut replacements = BTreeSet::new();
        let mut contracts = BTreeSet::new();
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
            let reply = match Self::run(&config.node, &loaded, "inspect", "", Value::Null, &|| true)
            {
                Ok(reply) => reply,
                Err(error) if initial => {
                    loaded.error = Some(error.to_string());
                    next.insert(loaded.package.id.clone(), loaded);
                    continue;
                }
                Err(error) => return Err(error),
            };
            Self::validate_registrations(&loaded.package, &reply.registrations)?;
            if reply.state != loaded.state {
                return Err(failure("state_write_during_registration"));
            }
            for tool in &reply.registrations.tools {
                (self.tool_validator)(&tool.parameters)?;
                if !tool_names.insert(format!("mod_{}_{}", loaded.package.id, tool.name)) {
                    return Err(failure("tool_name_conflict"));
                }
            }
            for point in &reply.registrations.replacements {
                if !replacements.insert(point.clone()) {
                    return Err(failure(format!("replacement_conflict: {point}")));
                }
            }
            for contract in &reply.registrations.contracts {
                if !contracts.insert(contract.id.clone()) {
                    return Err(failure(format!(
                        "workflow_replacement_conflict: {}",
                        contract.id
                    )));
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
            || registrations.events.len() > MOD_EVENTS.len()
            || (!registrations.tools.is_empty() && !has("tools"))
            || (!registrations.commands.is_empty() && !has("commands"))
            || (!registrations.contracts.is_empty() && !has("workflow"))
            || registrations.contracts.len() > 4
        {
            return Err(failure("registration_limit_or_capability_denied"));
        }
        let mut contract_ids = BTreeSet::new();
        for contract in &registrations.contracts {
            contract.validate().map_err(failure)?;
            if contract.host_owned() || !contract_ids.insert(&contract.id) {
                return Err(failure("invalid_or_duplicate_contract_registration"));
            }
        }
        let visible = |text: &str, limit: usize| {
            !text.is_empty() && text.len() <= limit && !text.chars().any(char::is_control)
        };
        let mut names = BTreeSet::new();
        for tool in &registrations.tools {
            if !identifier(&tool.name)
                || !names.insert(&tool.name)
                || tool
                    .label
                    .as_deref()
                    .is_some_and(|label| !visible(label, 64))
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
        for command in &registrations.commands {
            if !identifier(&command.name)
                || !names.insert(&command.name)
                || command
                    .description
                    .as_deref()
                    .is_some_and(|description| !visible(description, 256))
            {
                return Err(failure("command_conflict_or_invalid_description"));
            }
        }
        names.clear();
        for event in &registrations.events {
            let capability = MOD_EVENTS
                .iter()
                .find(|(name, _)| name == event)
                .map(|(_, capability)| *capability)
                .ok_or_else(|| failure("unsupported_event"))?;
            if !has(capability) || !names.insert(event) {
                return Err(failure("event_capability_denied_or_conflict"));
            }
        }
        if registrations.replacements.iter().any(|point| {
            !MOD_REPLACEMENT_POINTS.contains(&point.as_str())
                || !registrations.events.contains(point)
        }) {
            return Err(failure("invalid_replacement_point"));
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
        bridge::run(
            node,
            loaded,
            event,
            name,
            payload,
            active,
            &mut |_| {
                Err(failure(
                    "host_operation_unavailable: requires a native task",
                ))
            },
            &mut |_| {},
        )
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
        self.invoke_with(id, generation, event, name, payload, active, |_| {
            Err(failure(
                "host_operation_unavailable: requires a native task",
            ))
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn invoke_with(
        &mut self,
        id: &str,
        generation: u64,
        event: &str,
        name: &str,
        payload: Value,
        active: impl Fn() -> bool,
        host: impl FnMut(ModHostCall) -> Result<Value>,
    ) -> Result<Value> {
        self.invoke_streaming(id, generation, event, name, payload, active, host, |_| {})
    }

    #[allow(clippy::too_many_arguments)]
    pub fn invoke_streaming(
        &mut self,
        id: &str,
        generation: u64,
        event: &str,
        name: &str,
        payload: Value,
        active: impl Fn() -> bool,
        mut host: impl FnMut(ModHostCall) -> Result<Value>,
        mut progress: impl FnMut(String),
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
                "command" if loaded.registrations.commands.iter().any(|c| c.name == name) => (),
                e if loaded
                    .registrations
                    .events
                    .iter()
                    .any(|registered| registered == e) => {}
                _ => return Err(failure("unsupported_or_unregistered_operation")),
            }
            loaded.state = self
                .store
                .state(&loaded.package.id, loaded.package.state_version)?;
            let reply = bridge::run(
                &self.node,
                loaded,
                event,
                name,
                payload,
                &active,
                &mut host,
                &mut progress,
            )?;
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
            if event == "tool_before"
                && reply.value.get("arguments").is_some()
                && !loaded
                    .registrations
                    .replacements
                    .iter()
                    .any(|p| p == "tool_before")
            {
                return Err(failure("exclusive_replacement_registration_required"));
            }
            if event == "terminal" && !reply.value.is_null() {
                ModView::parse(reply.value.clone())?;
            }
            if event == "input" {
                let decision = ModInputDecision::parse(&reply.value)?;
                if matches!(decision, ModInputDecision::Rewrite(_))
                    && !loaded
                        .registrations
                        .replacements
                        .iter()
                        .any(|p| p == "input")
                {
                    return Err(failure("exclusive_replacement_registration_required"));
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
        if let Err(error) = &result
            && !error.to_string().starts_with("state_conflict")
        {
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

    pub fn commands(&self) -> Vec<(String, ModCommand)> {
        self.loaded
            .iter()
            .filter(|(_, m)| m.error.is_none())
            .flat_map(|(id, m)| {
                m.registrations
                    .commands
                    .iter()
                    .map(|command| (id.clone(), command.clone()))
            })
            .collect()
    }

    pub fn owners(&self) -> Vec<(String, crate::PolicyOwner)> {
        self.loaded
            .iter()
            .filter(|(_, m)| m.error.is_none())
            .map(|(id, m)| (id.clone(), Self::owner(m)))
            .collect()
    }

    fn owner(loaded: &Loaded) -> crate::PolicyOwner {
        crate::PolicyOwner {
            kind: crate::OwnerKind::Mod,
            id: loaded.package.id.clone(),
            version: loaded.package.version.clone(),
            source: loaded.selection.path.display().to_string(),
            sha256: loaded.selection.sha256.clone(),
        }
    }

    pub fn contracts(&self) -> Vec<(crate::WorkflowContract, crate::PolicyOwner)> {
        self.loaded
            .values()
            .filter(|m| m.error.is_none())
            .flat_map(|m| {
                m.registrations
                    .contracts
                    .iter()
                    .map(|contract| (contract.clone(), Self::owner(m)))
            })
            .collect()
    }

    pub fn registered(&self, id: &str, event: &str) -> bool {
        self.loaded
            .get(id)
            .is_some_and(|m| m.error.is_none() && m.registrations.events.iter().any(|e| e == event))
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
