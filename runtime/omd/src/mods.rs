mod author;
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
mod package_manager;
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
use std::time::Instant;

pub use package_manager::ModInstallRequest;
pub use package_manager::ModPackageGrant;
pub use package_manager::ModPackageLock;
pub use package_manager::ModPackagePlan;
pub use package_manager::ModPackageSource;
pub use package_manager::ModPackageTrust;
pub use store::ModStore;

pub const CODEX_HOST_RELEASE: &str = "0.154.0";
pub const OMD_HOST_RELEASE: &str = env!("CARGO_PKG_VERSION");
pub const MOD_API_VERSION: &str = "0.1.0-experimental.6";
pub const MOD_PACKAGE_SCHEMA_VERSION: u32 = 1;
pub const MOD_STATE_STORAGE_SCHEMA_VERSION: u32 = 1;
pub const INSTALLED_CONTRACT_TYPES_VERSION: u32 = 1;
pub const MOD_HOST_FEATURES: &[&str] = &[
    "author_diagnostics_v1",
    "author_offline_runner_v1",
    "author_tooling_v1",
    "installed_contract_types_v1",
    "package_manager_v1",
    "service_contracts_v1",
    "source_use_v1",
    "state_migration_v1",
    "transactional_reload_v1",
];
pub const MOD_HOST_OPERATIONS: &[&str] = &[
    "task.status",
    "routes.list",
    "checkpoint.read",
    "checkpoint.update",
    "agents.spawn",
    "agents.message",
    "agents.cancel",
    "agents.result",
    "agents.wait",
    "agents.list",
    "review.run",
    "review.complete",
    "delegation.contribute",
    "recovery.escalate",
    "tools.exec",
    "pi.discover",
    "pi.expand",
    "providers.unregister",
    "providers.register",
    "sidecars.start",
    "sidecars.status",
    "sidecars.stop",
    "workflow.status",
    "workflow.restrict",
];
pub const SUPPORTED_MOD_APIS: &[(&str, &str, &str)] = &[
    ("0.1.0-experimental.4", "deprecated", "2027-03-20"),
    ("0.1.0-experimental.5", "experimental", "2027-03-20"),
    (MOD_API_VERSION, "experimental", "2027-03-20"),
];
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
    "middleware",
    "services",
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
    ("model_request", "middleware"),
    ("response_stream", "middleware"),
    ("prompt", "middleware"),
    ("session", "middleware"),
    ("agent", "middleware"),
    ("tool_call", "middleware"),
    ("host_operation", "middleware"),
];
pub const MOD_REPLACEMENT_POINTS: &[&str] = &[
    "tool_before",
    "routing",
    "terminal",
    "compaction",
    "context",
    "input",
];
pub const MOD_SCOPES: &[&str] = &["user", "project"];
pub const MOD_ENVIRONMENT: &[&str] = &["crypto"];
type Result<T> = io::Result<T>;

fn failure(message: impl ToString) -> io::Error {
    io::Error::other(message.to_string())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// A selection that never reaches activation; a later reload stays transactional.
fn reject(
    initial: bool,
    rejected: &mut Vec<ModRejection>,
    selection: &ModSelection,
    id: Option<&str>,
    reason: String,
) -> Result<()> {
    if !initial {
        return Err(failure(reason));
    }
    rejected.push(ModRejection {
        path: selection.path.clone(),
        id: id.map(str::to_owned),
        scope: selection.scope.clone(),
        reason,
    });
    Ok(())
}

fn fail(initial: bool, loaded: &mut Loaded, error: io::Error) -> Result<()> {
    if !initial {
        return Err(error);
    }
    if loaded.error.is_none() {
        loaded.error = Some(error.to_string());
    }
    Ok(())
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}

fn service_name(value: &str) -> bool {
    let mut parts = value.split('.');
    parts.clone().count() >= 2 && parts.all(identifier)
}

fn version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_'))
}

fn api_support(value: &str) -> Option<(&'static str, &'static str)> {
    SUPPORTED_MOD_APIS
        .iter()
        .find(|(candidate, ..)| *candidate == value)
        .map(|(_, stability, support_until)| (*stability, *support_until))
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct SemanticVersion(u64, u64, u64);

impl SemanticVersion {
    fn parse(value: &str) -> Option<Self> {
        let mut parts = value.split('.');
        let parsed = Self(
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
        );
        parts.next().is_none().then_some(parsed)
    }
}

fn service_version_satisfies(requirement: &str, provided: &str) -> bool {
    let Some(provided) = SemanticVersion::parse(provided) else {
        return false;
    };
    let (caret, requirement) = requirement
        .strip_prefix('^')
        .map_or((false, requirement), |value| (true, value));
    let Some(required) = SemanticVersion::parse(requirement) else {
        return false;
    };
    if !caret {
        return provided == required;
    }
    provided >= required
        && if required.0 > 0 {
            provided.0 == required.0
        } else if required.1 > 0 {
            provided.0 == 0 && provided.1 == required.1
        } else {
            provided == required
        }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModHostCompatibility {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub releases: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_features: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub optional_features: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ModStability {
    Stable,
    Deprecated,
    #[default]
    Experimental,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModServiceManifest {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exports: Vec<ModServiceContract>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub imports: Vec<ModServiceImport>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModServiceContract {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub stability: ModStability,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deprecated_since: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacement: Option<String>,
    pub methods: BTreeMap<String, ModServiceMethod>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModServiceMethod {
    pub input: String,
    pub output: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModServiceImport {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModSourceUse {
    pub capabilities: Vec<String>,
    pub events: Vec<String>,
    pub replacements: Vec<String>,
    pub operations: Vec<String>,
    pub services: Vec<String>,
    pub environment: Vec<String>,
}

fn quoted_calls(source: &str, marker: &str) -> Result<Vec<String>> {
    let mut rest = source;
    let mut values = Vec::new();
    while let Some(index) = rest.find(marker) {
        rest = &rest[index + marker.len()..];
        let value = rest.trim_start();
        let quote = value
            .as_bytes()
            .first()
            .copied()
            .filter(|byte| matches!(byte, b'\'' | b'"'))
            .ok_or_else(|| failure(format!("source_use_requires_literal: {marker}")))?;
        let value = &value[1..];
        let end = value
            .bytes()
            .position(|byte| byte == quote)
            .ok_or_else(|| failure(format!("unterminated_source_use: {marker}")))?;
        values.push(value[..end].to_owned());
        rest = &value[end + 1..];
    }
    values.sort();
    values.dedup();
    Ok(values)
}

fn source_use(
    source: &str,
    package: &ModPackage,
    registrations: &Registrations,
) -> Result<(ModSourceUse, Vec<String>, Vec<String>)> {
    let operations = quoted_calls(source, "host.call(")?;
    let services = quoted_calls(source, "services.call(")?;
    let mut environment = Vec::new();
    for (name, needles) in [
        ("crypto", &["crypto.", "crypto["][..]),
        ("network", &["fetch(", "WebSocket("][..]),
        ("process", &["process.", "Deno.", "Bun."][..]),
        (
            "filesystem",
            &["node:fs", "require('fs", "require(\"fs"][..],
        ),
        ("dom", &["document.", "window."][..]),
    ] {
        if needles.iter().any(|needle| source.contains(needle)) {
            environment.push(name.to_owned());
        }
    }
    for name in &environment {
        if !package.environment.contains(name) {
            return Err(failure(format!("undeclared_environment_use: {name}")));
        }
    }
    for operation in &operations {
        let capability = ModHostCall {
            operation: operation.clone(),
            arguments: Value::Null,
        }
        .capability()?;
        if !package
            .capabilities
            .iter()
            .any(|declared| declared == capability)
        {
            return Err(failure(format!("undeclared_operation_use: {operation}")));
        }
    }
    for service in &services {
        if !package
            .services
            .imports
            .iter()
            .any(|import| import.name == *service)
        {
            return Err(failure(format!("undeclared_service_use: {service}")));
        }
    }
    let mut capabilities = BTreeSet::new();
    for event in &registrations.events {
        if event == "tool_result" && package.capabilities.iter().any(|cap| cap == "middleware") {
            capabilities.insert("middleware".to_owned());
        } else if let Some((_, capability)) = MOD_EVENTS.iter().find(|(name, _)| name == event) {
            capabilities.insert((*capability).to_owned());
        }
    }
    if !registrations.tools.is_empty() {
        capabilities.insert("tools".to_owned());
    }
    if !registrations.commands.is_empty() {
        capabilities.insert("commands".to_owned());
    }
    if !registrations.contracts.is_empty() {
        capabilities.insert("workflow".to_owned());
    }
    if !registrations.services.is_empty() || !services.is_empty() {
        capabilities.insert("services".to_owned());
    }
    if source.contains(".state.get(") || source.contains(".state.set(") {
        capabilities.insert("state".to_owned());
    }
    for operation in &operations {
        capabilities.insert(
            ModHostCall {
                operation: operation.clone(),
                arguments: Value::Null,
            }
            .capability()?
            .to_owned(),
        );
    }
    let unused_grants = package
        .capabilities
        .iter()
        .filter(|capability| !capabilities.contains(*capability))
        .cloned()
        .collect();
    let unused_environment = package
        .environment
        .iter()
        .filter(|name| !environment.contains(name))
        .cloned()
        .collect();
    Ok((
        ModSourceUse {
            capabilities: capabilities.into_iter().collect(),
            events: registrations.events.clone(),
            replacements: registrations.replacements.clone(),
            operations,
            services,
            environment,
        },
        unused_grants,
        unused_environment,
    ))
}

fn validate_service_value(value: &Value, expected: &str) -> Result<()> {
    let valid = match expected {
        "json" => true,
        "null" => value.is_null(),
        "boolean" => value.is_boolean(),
        "number" => value.is_number(),
        "string" => value.is_string(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(failure(format!(
            "service_value_type_mismatch: expected {expected}"
        )))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModPackage {
    pub schema: u32,
    pub id: String,
    pub version: String,
    pub api: String,
    #[serde(default = "default_entrypoint")]
    pub entrypoint: String,
    pub state_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<ModProvenance>,
    #[serde(default)]
    pub compatibility: ModHostCompatibility,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter: Option<String>,
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<ModDependency>,
    #[serde(default)]
    pub services: ModServiceManifest,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub environment: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_schema: Option<Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub lifecycle: BTreeMap<String, String>,
    #[serde(default = "default_hook_budget_ms")]
    pub hook_budget_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModProvenance {
    pub maintainer: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModDependency {
    pub id: String,
    pub version: String,
}

fn default_entrypoint() -> String {
    "index.ts".to_owned()
}

fn default_hook_budget_ms() -> u64 {
    1000
}

impl ModPackage {
    fn validate(&self) -> Result<()> {
        if api_support(&self.api).is_none() {
            let supported = SUPPORTED_MOD_APIS
                .iter()
                .map(|(version, stability, until)| {
                    format!("{version} ({stability}, through {until})")
                })
                .collect::<Vec<_>>()
                .join(", ");
            return Err(failure(format!(
                "incompatible_api: OMD host {OMD_HOST_RELEASE} runs mod API {MOD_API_VERSION}; package \"{}\" declares {}. Supported package APIs: {supported}. Install a compatible package release or use a host listed in mods/COMPATIBILITY.md.",
                self.id, self.api,
            )));
        }
        if self.schema != MOD_PACKAGE_SCHEMA_VERSION {
            return Err(failure(format!(
                "incompatible_package_schema: OMD host {OMD_HOST_RELEASE} supports package schema {MOD_PACKAGE_SCHEMA_VERSION}; package \"{}\" declares {}. Install a compatible package release; source, settings and state were not changed.",
                self.id, self.schema
            )));
        }
        if !self.compatibility.releases.is_empty()
            && !self
                .compatibility
                .releases
                .iter()
                .any(|release| release == OMD_HOST_RELEASE)
        {
            return Err(failure(format!(
                "incompatible_host_release: package \"{}\" supports OMD host releases [{}], but this host is {OMD_HOST_RELEASE}. Install a compatible package or host release; source, settings and state were not changed.",
                self.id,
                self.compatibility.releases.join(", ")
            )));
        }
        let missing_features = self
            .compatibility
            .required_features
            .iter()
            .filter(|feature| !MOD_HOST_FEATURES.contains(&feature.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if !missing_features.is_empty() {
            return Err(failure(format!(
                "missing_host_features: package \"{}\" requires [{}], but OMD host {OMD_HOST_RELEASE} provides [{}]. Install a compatible host or package; source, settings and state were not changed.",
                self.id,
                missing_features.join(", "),
                MOD_HOST_FEATURES.join(", ")
            )));
        }
        if !identifier_list(&self.compatibility.required_features, 16)
            || !identifier_list(&self.compatibility.optional_features, 16)
            || self
                .compatibility
                .required_features
                .iter()
                .any(|feature| self.compatibility.optional_features.contains(feature))
            || self.compatibility.releases.len() > 8
            || self
                .compatibility
                .releases
                .iter()
                .any(|release| !version(release))
        {
            return Err(failure("invalid_host_compatibility_declaration"));
        }
        if !identifier(&self.id)
            || self.id.len() > 24
            || self.version.is_empty()
            || self.version.len() > 64
            || self.state_version == 0
            || !version(&self.version)
            || !(25..=2000).contains(&self.hook_budget_ms)
            || !package_file(&self.entrypoint)
        {
            return Err(failure(
                "incompatible_package: valid identity/version, supported API and positive state_version required",
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
        let requires: BTreeSet<_> = self.requires.iter().collect();
        if self.requires.len() > 4
            || requires.len() != self.requires.len()
            || self
                .requires
                .iter()
                .any(|id| !identifier(id) || id == &self.id)
        {
            return Err(failure(
                "invalid_requires: up to four distinct other mod IDs",
            ));
        }
        let dependencies: BTreeSet<_> = self.dependencies.iter().map(|item| &item.id).collect();
        if self.dependencies.len() > 16
            || dependencies.len() != self.dependencies.len()
            || self.dependencies.iter().any(|dependency| {
                !identifier(&dependency.id)
                    || dependency.id == self.id
                    || !version_requirement(&dependency.version)
            })
        {
            return Err(failure("invalid_dependencies"));
        }
        if self.requires.iter().any(|id| dependencies.contains(id)) {
            return Err(failure("dependency_declared_twice"));
        }
        if let Some(license) = &self.license
            && (license.is_empty()
                || license.len() > 128
                || !license.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric()
                        || matches!(byte, b'-' | b'.' | b'+' | b'(' | b')' | b' ')
                }))
        {
            return Err(failure("invalid_license"));
        }
        if let Some(provenance) = &self.provenance
            && (provenance.maintainer.is_empty()
                || provenance.maintainer.len() > 128
                || provenance.source.is_empty()
                || provenance.source.len() > 1024
                || provenance
                    .revision
                    .as_deref()
                    .is_some_and(|value| value.is_empty() || value.len() > 128))
        {
            return Err(failure("invalid_provenance"));
        }
        if let Some(schema) = &self.settings_schema {
            validate_settings_schema(schema)?;
        }
        if self.lifecycle.len() > 3
            || self.lifecycle.iter().any(|(event, path)| {
                !["install", "update", "uninstall"].contains(&event.as_str()) || !package_file(path)
            })
        {
            return Err(failure("invalid_lifecycle_scripts"));
        }
        let environments: BTreeSet<_> = self.environment.iter().collect();
        if environments.len() != self.environment.len()
            || self
                .environment
                .iter()
                .any(|name| !MOD_ENVIRONMENT.contains(&name.as_str()))
        {
            return Err(failure("unsupported_or_duplicate_environment_access"));
        }
        if self.services.exports.len() > 8 || self.services.imports.len() > 16 {
            return Err(failure("service_contract_limit"));
        }
        let mut exports = BTreeSet::new();
        for contract in &self.services.exports {
            if !service_name(&contract.name)
                || SemanticVersion::parse(&contract.version).is_none()
                || !exports.insert(&contract.name)
                || contract.methods.is_empty()
                || contract.methods.len() > 32
                || contract.methods.iter().any(|(name, method)| {
                    !identifier(name)
                        || ![
                            "null", "boolean", "number", "string", "array", "object", "json",
                        ]
                        .contains(&method.input.as_str())
                        || ![
                            "null", "boolean", "number", "string", "array", "object", "json",
                        ]
                        .contains(&method.output.as_str())
                })
                || matches!(contract.stability, ModStability::Stable)
                    && SemanticVersion::parse(&contract.version)
                        .is_some_and(|version| version.0 == 0)
                || matches!(contract.stability, ModStability::Deprecated)
                    && contract
                        .deprecated_since
                        .as_deref()
                        .is_none_or(str::is_empty)
                || contract
                    .replacement
                    .as_deref()
                    .is_some_and(|replacement| !service_name(replacement))
            {
                return Err(failure("invalid_service_export"));
            }
        }
        let mut imports = BTreeSet::new();
        for import in &self.services.imports {
            if !service_name(&import.name)
                || SemanticVersion::parse(import.version.trim_start_matches('^')).is_none()
                || !imports.insert(&import.name)
            {
                return Err(failure("invalid_service_import"));
            }
        }
        if (!self.services.exports.is_empty() || !self.services.imports.is_empty())
            && !self.capabilities.iter().any(|cap| cap == "services")
        {
            return Err(failure("service_capability_required"));
        }
        Ok(())
    }
}

fn package_file(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.ends_with(".ts")
        && !value.starts_with('/')
        && value.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
}

fn version_requirement(value: &str) -> bool {
    SemanticVersion::parse(value.strip_prefix('^').unwrap_or(value)).is_some()
}

fn validate_settings_schema(schema: &Value) -> Result<()> {
    let object = schema
        .as_object()
        .ok_or_else(|| failure("settings_schema_must_be_object"))?;
    if object.keys().any(|key| {
        !["type", "properties", "required", "additionalProperties"].contains(&key.as_str())
    }) || object.get("type") != Some(&json!("object"))
        || object
            .get("additionalProperties")
            .is_some_and(|value| !value.is_boolean())
    {
        return Err(failure("unsupported_settings_schema"));
    }
    let properties = object
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| failure("settings_schema_properties_required"))?;
    if properties.len() > 64 {
        return Err(failure("settings_schema_limit"));
    }
    for (name, definition) in properties {
        if !identifier(name) {
            return Err(failure("invalid_setting_name"));
        }
        let definition = definition
            .as_object()
            .ok_or_else(|| failure("invalid_setting_schema"))?;
        if definition
            .keys()
            .any(|key| !["type", "enum", "default"].contains(&key.as_str()))
        {
            return Err(failure("unsupported_setting_schema"));
        }
        let kind = definition
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| failure("setting_type_required"))?;
        if !["boolean", "number", "string", "array", "object", "null"].contains(&kind) {
            return Err(failure("unsupported_setting_type"));
        }
        if let Some(values) = definition.get("enum") {
            let values = values
                .as_array()
                .filter(|values| !values.is_empty() && values.len() <= 32)
                .ok_or_else(|| failure("invalid_setting_enum"))?;
            if values.iter().any(|value| !setting_type(value, kind)) {
                return Err(failure("setting_enum_type_mismatch"));
            }
        }
        if let Some(default) = definition.get("default")
            && !setting_value(default, definition)
        {
            return Err(failure("setting_default_invalid"));
        }
    }
    if let Some(required) = object.get("required") {
        let required = required
            .as_array()
            .ok_or_else(|| failure("invalid_required_settings"))?;
        let mut unique = BTreeSet::new();
        if required.len() > properties.len()
            || required.iter().any(|name| {
                name.as_str()
                    .is_none_or(|name| !properties.contains_key(name) || !unique.insert(name))
            })
        {
            return Err(failure("invalid_required_settings"));
        }
    }
    Ok(())
}

fn setting_type(value: &Value, kind: &str) -> bool {
    match kind {
        "boolean" => value.is_boolean(),
        "number" => value.is_number(),
        "string" => value.is_string(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        "null" => value.is_null(),
        _ => false,
    }
}

fn setting_value(value: &Value, definition: &serde_json::Map<String, Value>) -> bool {
    definition
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| setting_type(value, kind))
        && definition
            .get("enum")
            .and_then(Value::as_array)
            .is_none_or(|values| values.contains(value))
}

fn validate_settings(package: &ModPackage, settings: &BTreeMap<String, Value>) -> Result<()> {
    let Some(schema) = &package.settings_schema else {
        return Ok(());
    };
    let object = schema
        .as_object()
        .ok_or_else(|| failure("invalid_settings_schema"))?;
    let properties = object["properties"]
        .as_object()
        .ok_or_else(|| failure("invalid_settings_schema"))?;
    if object.get("additionalProperties") == Some(&json!(false))
        && settings.keys().any(|name| !properties.contains_key(name))
    {
        return Err(failure("unknown_setting"));
    }
    for required in object
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if required
            .as_str()
            .is_none_or(|name| !settings.contains_key(name))
        {
            return Err(failure("required_setting_missing"));
        }
    }
    for (name, value) in settings {
        if let Some(definition) = properties.get(name).and_then(Value::as_object)
            && !setting_value(value, definition)
        {
            return Err(failure(format!("invalid_setting: {name}")));
        }
    }
    Ok(())
}

fn identifier_list(values: &[String], limit: usize) -> bool {
    let unique: BTreeSet<_> = values.iter().collect();
    values.len() <= limit
        && unique.len() == values.len()
        && values.iter().all(|value| identifier(value))
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
    #[serde(default = "user_scope")]
    pub scope: String,
}

fn user_scope() -> String {
    "user".to_owned()
}

#[derive(Clone, Debug, Serialize)]
pub struct ModRejection {
    pub path: PathBuf,
    pub id: Option<String>,
    pub scope: String,
    pub reason: String,
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
    #[serde(default)]
    services: Vec<ModServiceContract>,
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

#[derive(Clone)]
struct Loaded {
    package: ModPackage,
    selection: ModSelection,
    source: String,
    state: Value,
    registrations: Registrations,
    source_use: ModSourceUse,
    unused_grants: Vec<String>,
    unused_environment: Vec<String>,
    error: Option<String>,
    telemetry: ModTelemetry,
}

#[derive(Clone, Debug, Default, Serialize)]
struct ModTelemetry {
    invocations: u64,
    total_micros: u128,
    last_micros: u128,
    logs: Vec<Value>,
}

impl ModTelemetry {
    fn record(&mut self, generation: u64, event: &str, name: &str, elapsed: u128, outcome: &str) {
        self.invocations = self.invocations.saturating_add(1);
        self.total_micros = self.total_micros.saturating_add(elapsed);
        self.last_micros = elapsed;
        self.logs
            .push(json!({"generation":generation,"event":event,"name":name,
            "outcome":outcome,"elapsed_micros":elapsed}));
        if self.logs.len() > 64 {
            self.logs.remove(0);
        }
    }
}

pub struct ModHost {
    store: ModStore,
    node: PathBuf,
    generation: u64,
    configuration_sha256: String,
    loaded: BTreeMap<String, Loaded>,
    order: Vec<String>,
    rejected: Vec<ModRejection>,
    reload_error: Option<String>,
    service_calls: Vec<Value>,
    tool_validator: fn(&Value) -> Result<()>,
    virtual_time_ms: Option<u64>,
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
            order: Vec::new(),
            rejected: Vec::new(),
            reload_error: None,
            service_calls: Vec::new(),
            tool_validator,
            virtual_time_ms: None,
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
        let mut rejected = Vec::new();
        let selected = Self::select(&config, initial, &mut rejected)?;
        let mut next = BTreeMap::new();
        for (id, (selection, package, source)) in selected {
            let mut loaded = Loaded {
                package,
                source,
                selection,
                state: Value::Null,
                registrations: Registrations::default(),
                source_use: ModSourceUse::default(),
                unused_grants: Vec::new(),
                unused_environment: Vec::new(),
                error: None,
                telemetry: ModTelemetry::default(),
            };
            let prepared = (|| {
                loaded.state = self.store.state(
                    &loaded.package.id,
                    &loaded.selection.scope,
                    loaded.package.state_version,
                )?;
                let reply = Self::run(&config.node, &loaded, "inspect", "", Value::Null, &|| true)?;
                Self::validate_registrations(&loaded.package, &reply.registrations)?;
                if reply.state != loaded.state {
                    return Err(failure("state_write_during_registration"));
                }
                for tool in &reply.registrations.tools {
                    (self.tool_validator)(&tool.parameters)?;
                }
                let (source_use, unused_grants, unused_environment) =
                    source_use(&loaded.source, &loaded.package, &reply.registrations)?;
                Ok((
                    reply.registrations,
                    source_use,
                    unused_grants,
                    unused_environment,
                ))
            })();
            match prepared {
                Ok((registrations, source_use, unused_grants, unused_environment)) => {
                    loaded.registrations = registrations;
                    loaded.source_use = source_use;
                    loaded.unused_grants = unused_grants;
                    loaded.unused_environment = unused_environment;
                }
                Err(error) => fail(initial, &mut loaded, error)?,
            }
            next.insert(id, loaded);
        }
        Self::resolve_conflicts(&mut next, initial)?;
        Self::resolve_services(&mut next, initial)?;
        let order = Self::resolve_dependencies(&mut next, initial)?;
        self.node = config.node;
        self.loaded = next;
        self.order = order;
        self.rejected = rejected;
        self.configuration_sha256 = hash;
        self.generation += 1;
        self.reload_error = None;
        self.write_installed_service_types()?;
        Ok(true)
    }

    /// Trusted, enabled selections keyed by mod ID after scope precedence.
    fn select(
        config: &ModConfiguration,
        initial: bool,
        rejected: &mut Vec<ModRejection>,
    ) -> Result<BTreeMap<String, (ModSelection, ModPackage, String)>> {
        let mut selected: BTreeMap<String, (ModSelection, ModPackage, String)> = BTreeMap::new();
        for selection in config.mods.iter().filter(|m| m.enabled) {
            let loaded = (|| {
                if !MOD_SCOPES.contains(&selection.scope.as_str()) {
                    return Err(failure(format!("unsupported_scope: {}", selection.scope)));
                }
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
                validate_settings(&package, &selection.settings)?;
                Ok((package, source))
            })();
            let (package, source) = match loaded {
                Ok(loaded) => loaded,
                Err(error) => {
                    reject(initial, rejected, selection, None, error.to_string())?;
                    continue;
                }
            };
            let id = package.id.clone();
            let Some((previous, ..)) = selected.get(&id) else {
                selected.insert(id, (selection.clone(), package, source));
                continue;
            };
            if previous.scope != selection.scope {
                let (loser, winner) = match selection.scope.as_str() {
                    "project" => {
                        let (previous, ..) = selected
                            .insert(id.clone(), (selection.clone(), package, source))
                            .expect("checked above");
                        (previous, selection.path.clone())
                    }
                    _ => (selection.clone(), previous.path.clone()),
                };
                rejected.push(ModRejection {
                    path: loser.path,
                    id: Some(id),
                    scope: loser.scope,
                    reason: format!("shadowed_by_project_scope: {}", winner.display()),
                });
                continue;
            }
            let reason = format!(
                "mod_conflict: {id} is enabled twice in the {} scope",
                selection.scope
            );
            let (previous, ..) = selected.remove(&id).expect("checked above");
            reject(initial, rejected, &previous, Some(&id), reason.clone())?;
            reject(initial, rejected, selection, Some(&id), reason)?;
        }
        Ok(selected)
    }

    /// Every claimant of a contested slot is disabled; none silently wins.
    fn resolve_conflicts(next: &mut BTreeMap<String, Loaded>, initial: bool) -> Result<()> {
        let mut tools: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut points: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut contracts: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (id, loaded) in next.iter().filter(|(_, m)| m.error.is_none()) {
            for tool in &loaded.registrations.tools {
                tools
                    .entry(format!("mod_{id}_{}", tool.name))
                    .or_default()
                    .push(id.clone());
            }
            for point in &loaded.registrations.replacements {
                points.entry(point.clone()).or_default().push(id.clone());
            }
            for contract in &loaded.registrations.contracts {
                contracts
                    .entry(contract.id.clone())
                    .or_default()
                    .push(id.clone());
            }
        }
        let contested = |kind: &'static str, claims: BTreeMap<String, Vec<String>>| {
            claims
                .into_iter()
                .filter(|(_, ids)| ids.len() > 1)
                .flat_map(move |(slot, ids)| {
                    let reason = format!("{kind}: {slot} claimed by {}", ids.join(", "));
                    ids.into_iter().map(move |id| (id, reason.clone()))
                })
                .collect::<Vec<_>>()
        };
        let mut conflicts = contested("tool_name_conflict", tools);
        conflicts.extend(contested("replacement_conflict", points));
        conflicts.extend(contested("workflow_replacement_conflict", contracts));
        for (id, reason) in conflicts {
            if let Some(loaded) = next.get_mut(&id) {
                fail(initial, loaded, failure(reason))?;
            }
        }
        Ok(())
    }

    fn resolve_services(next: &mut BTreeMap<String, Loaded>, initial: bool) -> Result<()> {
        let mut claims: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (id, loaded) in next.iter().filter(|(_, loaded)| loaded.error.is_none()) {
            for contract in &loaded.registrations.services {
                claims
                    .entry(contract.name.clone())
                    .or_default()
                    .push(id.clone());
            }
        }
        for (name, providers) in claims.iter().filter(|(_, providers)| providers.len() > 1) {
            let reason = format!(
                "service_provider_collision: {name} provided by {}",
                providers.join(", ")
            );
            for provider in providers {
                if let Some(loaded) = next.get_mut(provider) {
                    fail(initial, loaded, failure(reason.clone()))?;
                }
            }
        }
        loop {
            let providers: BTreeMap<String, (String, String)> = next
                .iter()
                .filter(|(_, loaded)| loaded.error.is_none())
                .flat_map(|(id, loaded)| {
                    loaded.registrations.services.iter().map(|contract| {
                        (
                            contract.name.clone(),
                            (id.clone(), contract.version.clone()),
                        )
                    })
                })
                .collect();
            let unavailable: Vec<_> = next
                .iter()
                .filter(|(_, loaded)| loaded.error.is_none())
                .filter_map(|(id, loaded)| {
                    loaded.package.services.imports.iter().find_map(|import| {
                        match providers.get(&import.name) {
                            Some((_, version))
                                if service_version_satisfies(&import.version, version) =>
                            {
                                None
                            }
                            None if import.optional => None,
                            Some((_, version)) => Some((
                                id.clone(),
                                format!(
                                    "service_version_incompatible: consumer {id} requires {} {} but the active provider exports {}. Install a compatible provider/consumer pair; the consumer was not activated and the provider remains eligible.",
                                    import.name, import.version, version,
                                ),
                            )),
                            None => Some((
                                id.clone(),
                                format!(
                                    "service_provider_missing: {} requires {}",
                                    id, import.name
                                ),
                            )),
                        }
                    })
                })
                .collect();
            if unavailable.is_empty() {
                break;
            }
            for (id, reason) in unavailable {
                if let Some(loaded) = next.get_mut(&id) {
                    fail(initial, loaded, failure(reason))?;
                }
            }
        }
        Ok(())
    }

    fn dependencies(id: &str, next: &BTreeMap<String, Loaded>) -> Vec<String> {
        let Some(loaded) = next.get(id) else {
            return Vec::new();
        };
        let providers: BTreeMap<&str, &str> = next
            .iter()
            .filter(|(_, candidate)| candidate.error.is_none())
            .flat_map(|(provider, candidate)| {
                candidate
                    .registrations
                    .services
                    .iter()
                    .map(move |contract| (contract.name.as_str(), provider.as_str()))
            })
            .collect();
        let mut dependencies = loaded.package.requires.clone();
        dependencies.extend(
            loaded
                .package
                .dependencies
                .iter()
                .map(|dependency| dependency.id.clone()),
        );
        dependencies.extend(
            loaded
                .package
                .services
                .imports
                .iter()
                .filter_map(|import| providers.get(import.name.as_str()).copied())
                .filter(|provider| *provider != id)
                .map(str::to_owned),
        );
        dependencies.sort();
        dependencies.dedup();
        dependencies
    }

    /// Resolves declared dependencies and returns the activation order.
    fn resolve_dependencies(
        next: &mut BTreeMap<String, Loaded>,
        initial: bool,
    ) -> Result<Vec<String>> {
        loop {
            let unavailable: Vec<(String, String)> = next
                .iter()
                .filter(|(_, m)| m.error.is_none())
                .filter_map(|(id, loaded)| {
                    if let Some(dependency) = loaded.package.dependencies.iter().find(|dependency| {
                        next.get(&dependency.id).is_some_and(|candidate| {
                            candidate.error.is_none()
                                && !service_version_satisfies(
                                    &dependency.version,
                                    &candidate.package.version,
                                )
                        })
                    }) {
                        let actual = &next[&dependency.id].package.version;
                        return Some((
                            id.clone(),
                            format!(
                                "dependency_version_incompatible: {id} requires {} {} but {} is active",
                                dependency.id, dependency.version, actual
                            ),
                        ));
                    }
                    Self::dependencies(id, next)
                        .iter()
                        .find(|required| next.get(*required).is_none_or(|m| m.error.is_some()))
                        .map(|required| {
                            (
                                id.clone(),
                                format!("dependency_unavailable: {id} requires {required}"),
                            )
                        })
                })
                .collect();
            if unavailable.is_empty() {
                break;
            }
            for (id, reason) in unavailable {
                if let Some(loaded) = next.get_mut(&id) {
                    fail(initial, loaded, failure(reason))?;
                }
            }
        }
        let mut remaining: BTreeSet<String> = next
            .iter()
            .filter(|(_, m)| m.error.is_none())
            .map(|(id, _)| id.clone())
            .collect();
        let mut order = Vec::new();
        while let Some(id) = remaining
            .iter()
            .find(|id| {
                Self::dependencies(id, next)
                    .iter()
                    .all(|required| !remaining.contains(required))
            })
            .cloned()
        {
            remaining.remove(&id);
            order.push(id);
        }
        if !remaining.is_empty() {
            let reason = format!(
                "dependency_cycle: {}",
                remaining.iter().cloned().collect::<Vec<_>>().join(" -> ")
            );
            for id in remaining {
                if let Some(loaded) = next.get_mut(&id) {
                    fail(initial, loaded, failure(reason.clone()))?;
                }
            }
        }
        Ok(order)
    }

    fn validate_registrations(package: &ModPackage, registrations: &Registrations) -> Result<()> {
        let has = |cap: &str| package.capabilities.iter().any(|c| c == cap);
        if registrations.tools.len() > 16
            || registrations.commands.len() > 16
            || registrations.events.len() > MOD_EVENTS.len()
            || (!registrations.tools.is_empty() && !has("tools"))
            || (!registrations.commands.is_empty() && !has("commands"))
            || (!registrations.contracts.is_empty() && !has("workflow"))
            || (!registrations.services.is_empty() && !has("services"))
            || registrations.contracts.len() > 4
            || registrations.services.len() > 8
        {
            return Err(failure("registration_limit_or_capability_denied"));
        }
        if registrations.services != package.services.exports {
            return Err(failure(
                "registered_service_contracts_do_not_match_manifest",
            ));
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
            if !(has(capability) || event == "tool_result" && has("middleware"))
                || !names.insert(event)
            {
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
            None,
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
        let mut loaded = self
            .loaded
            .get(id)
            .cloned()
            .ok_or_else(|| failure("mod_disabled"))?;
        if let Some(error) = &loaded.error {
            return Err(failure(format!(
                "mod_failed: {error}; explicitly reload to recover"
            )));
        }
        loaded.state = self.store.state(
            &loaded.package.id,
            &loaded.selection.scope,
            loaded.package.state_version,
        )?;
        let previous_state = loaded.state.clone();
        let node = self.node.clone();
        let virtual_time_ms = self.virtual_time_ms;
        let started = Instant::now();
        let result = (|| {
            match event {
                "tool" if loaded.registrations.tools.iter().any(|t| t.name == name) => (),
                "command" if loaded.registrations.commands.iter().any(|c| c.name == name) => (),
                "service"
                    if loaded.registrations.services.iter().any(|contract| {
                        contract
                            .methods
                            .keys()
                            .any(|method| format!("{}.{}", contract.name, method) == name)
                    }) => {}
                e if loaded
                    .registrations
                    .events
                    .iter()
                    .any(|registered| registered == e) => {}
                _ => return Err(failure("unsupported_or_unregistered_operation")),
            }
            let reply = bridge::run(
                &node,
                &loaded,
                event,
                name,
                payload,
                &active,
                &mut |call| {
                    let before = json!({"phase":"before","caller":id,"operation":call.operation,"arguments":call.arguments});
                    let _ = self.event_except("host_operation", before, id, &active);
                    let result = if call.operation == "mods.service" {
                        self.call_service(id, generation, call.arguments.clone(), &active)
                    } else {
                        host(call.clone())
                    };
                    let after = match &result {
                        Ok(value) => {
                            json!({"phase":"after","caller":id,"operation":call.operation,"result":value})
                        }
                        Err(error) => {
                            json!({"phase":"after","caller":id,"operation":call.operation,"error":error.to_string()})
                        }
                    };
                    let _ = self.event_except("host_operation", after, id, &active);
                    result
                },
                &mut progress,
                virtual_time_ms,
            )?;
            if !active() {
                return Err(failure("callback_cancelled"));
            }
            if reply.registrations != loaded.registrations {
                return Err(failure("registration_changed_during_callback"));
            }
            let replaces = |point: &str| {
                loaded
                    .registrations
                    .replacements
                    .iter()
                    .any(|registered| registered == point)
            };
            if matches!(event, "routing" | "compaction" | "terminal")
                && !reply.value.is_null()
                && !replaces(event)
            {
                return Err(failure("exclusive_replacement_registration_required"));
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
                && !replaces("tool_before")
            {
                return Err(failure("exclusive_replacement_registration_required"));
            }
            if event == "terminal" && !reply.value.is_null() {
                ModView::parse(reply.value.clone())?;
            }
            if event == "input" {
                let decision = ModInputDecision::parse(&reply.value)?;
                if matches!(decision, ModInputDecision::Rewrite(_)) && !replaces("input") {
                    return Err(failure("exclusive_replacement_registration_required"));
                }
            }
            if matches!(
                event,
                "prompt" | "session" | "agent" | "tool_call" | "tool_result" | "host_operation"
            ) && !reply.value.is_null()
            {
                return Err(failure("observe_only_event_returned_a_value"));
            }
            if reply.state != loaded.state {
                if !loaded.package.capabilities.iter().any(|c| c == "state") {
                    return Err(failure("state_capability_denied"));
                }
                self.store.write_state(
                    &loaded.package.id,
                    &loaded.selection.scope,
                    loaded.package.state_version,
                    &loaded.state,
                    &reply.state,
                )?;
            }
            Ok((reply.value, reply.state))
        })();
        let current = self
            .loaded
            .get_mut(id)
            .ok_or_else(|| failure("mod_disabled"))?;
        let elapsed = started.elapsed().as_micros();
        match result {
            Ok((value, state)) => {
                current
                    .telemetry
                    .record(self.generation, event, name, elapsed, "ok");
                if state != previous_state {
                    current.state = state;
                }
                Ok(value)
            }
            Err(error) => {
                current
                    .telemetry
                    .record(self.generation, event, name, elapsed, "error");
                if !error.to_string().starts_with("state_conflict") {
                    current.error = Some(error.to_string());
                }
                Err(error)
            }
        }
    }

    fn event_except(
        &mut self,
        event: &str,
        payload: Value,
        excluded: &str,
        active: &dyn Fn() -> bool,
    ) -> Vec<(String, Result<Value>)> {
        let ids: Vec<_> = self
            .active()
            .filter(|(id, loaded)| {
                id.as_str() != excluded
                    && loaded
                        .registrations
                        .events
                        .iter()
                        .any(|registered| registered == event)
            })
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .map(|id| {
                let result =
                    self.invoke_guarded(&id, self.generation, event, "", payload.clone(), active);
                (id, result)
            })
            .collect()
    }

    fn call_service(
        &mut self,
        caller: &str,
        generation: u64,
        arguments: Value,
        active: &dyn Fn() -> bool,
    ) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct ServiceCall {
            name: String,
            method: String,
            input: Value,
        }
        let call: ServiceCall = serde_json::from_value(arguments)?;
        if serde_json::to_vec(&call.input)?.len() > 32_768 {
            return Err(failure("service_input_limit"));
        }
        let consumer = self
            .loaded
            .get(caller)
            .ok_or_else(|| failure("mod_disabled"))?;
        let import = consumer
            .package
            .services
            .imports
            .iter()
            .find(|import| import.name == call.name)
            .ok_or_else(|| failure("undeclared_service_use"))?;
        let provider = self.active().find_map(|(id, loaded)| {
            loaded
                .registrations
                .services
                .iter()
                .find(|contract| contract.name == call.name)
                .map(|contract| (id.clone(), contract.clone()))
        });
        let Some((provider, contract)) = provider else {
            return Err(failure(if import.optional {
                "optional_service_unavailable"
            } else {
                "service_provider_missing"
            }));
        };
        if !service_version_satisfies(&import.version, &contract.version) {
            return Err(failure(format!(
                "service_version_incompatible: consumer {caller} requires {} {} but provider {provider} exports {}",
                call.name, import.version, contract.version
            )));
        }
        let method = contract
            .methods
            .get(&call.method)
            .ok_or_else(|| failure("unknown_service_method"))?;
        validate_service_value(&call.input, &method.input)?;
        let qualified = format!("{}.{}", call.name, call.method);
        let result = self.invoke_guarded(
            &provider, generation, "service", &qualified, call.input, active,
        )?;
        validate_service_value(&result, &method.output)?;
        if serde_json::to_vec(&result)?.len() > 32_768 {
            return Err(failure("service_output_limit"));
        }
        self.service_calls.push(
            json!({"caller":caller,"provider":provider,"service":call.name,
            "version":contract.version,"method":call.method,"generation":generation}),
        );
        if self.service_calls.len() > 64 {
            self.service_calls.remove(0);
        }
        Ok(result)
    }

    pub fn event(&mut self, event: &str, payload: Value) -> Vec<(String, Result<Value>)> {
        self.event_guarded(event, payload, || true)
    }

    pub fn model_request(
        &mut self,
        mut payload: Value,
        active: impl Fn() -> bool,
    ) -> Result<Value> {
        let presets = payload["authorized_presets"]
            .as_array()
            .ok_or_else(|| failure("authorized_presets_required"))?
            .clone();
        let mut effective = payload["effective"]
            .as_object()
            .cloned()
            .ok_or_else(|| failure("effective_route_required"))?;
        let ids = self.event_ids("model_request");
        let mut provenance = Vec::new();
        for (order, id) in ids.into_iter().enumerate() {
            payload["effective"] = Value::Object(effective.clone());
            let value = self.invoke_guarded(
                &id,
                self.generation,
                "model_request",
                "",
                payload.clone(),
                &active,
            )?;
            if value.is_null() {
                continue;
            }
            let object = value
                .as_object()
                .filter(|object| object.len() == 1)
                .ok_or_else(|| failure("invalid_model_request_result"))?;
            let selected = object
                .get("preset")
                .and_then(Value::as_str)
                .ok_or_else(|| failure("invalid_model_request_result"))?;
            let preset = presets
                .iter()
                .find(|preset| preset["name"].as_str() == Some(selected))
                .and_then(Value::as_object)
                .ok_or_else(|| failure(format!("unauthorized_request_preset: {selected}")))?;
            let previous = effective.get("name").cloned().unwrap_or(Value::Null);
            effective = preset.clone();
            if let Some(loaded) = self.loaded.get(&id) {
                provenance.push(
                    json!({"order":order,"origin":id,"version":loaded.package.version,
                    "sha256":loaded.selection.sha256,"tier":loaded.selection.scope,
                    "from":previous,"to":selected}),
                );
            }
        }
        payload["effective"] = Value::Object(effective);
        payload["provenance"] = Value::Array(provenance);
        Ok(payload)
    }

    pub fn response_stream(
        &mut self,
        mut payload: Value,
        active: impl Fn() -> bool,
    ) -> Result<Value> {
        let protected = payload["protected"].as_bool().unwrap_or(true);
        let original = payload.get("text").cloned().unwrap_or(Value::Null);
        let mut effective = original.clone();
        let mut provenance = Vec::new();
        let mut fallback = Vec::new();
        for (order, id) in self.event_ids("response_stream").into_iter().enumerate() {
            payload["text"] = effective.clone();
            let value = match self.invoke_guarded(
                &id,
                self.generation,
                "response_stream",
                "",
                payload.clone(),
                &active,
            ) {
                Ok(value) => value,
                Err(error) => {
                    fallback.push(json!({"origin":id,"error":error.to_string()}));
                    continue;
                }
            };
            if value.is_null() {
                continue;
            }
            if protected {
                let error = "protected_stream_field_is_observe_only".to_owned();
                if let Some(loaded) = self.loaded.get_mut(&id) {
                    loaded.error = Some(error.clone());
                }
                fallback.push(json!({"origin":id,"error":error}));
                continue;
            }
            let Some(text) = value
                .as_object()
                .filter(|object| object.len() == 1)
                .and_then(|object| object.get("text"))
                .and_then(Value::as_str)
                .filter(|text| text.len() <= 8192)
            else {
                let error = "invalid_stream_transformation".to_owned();
                if let Some(loaded) = self.loaded.get_mut(&id) {
                    loaded.error = Some(error.clone());
                }
                fallback.push(json!({"origin":id,"error":error}));
                continue;
            };
            let previous = effective.clone();
            effective = Value::String(text.to_owned());
            if let Some(loaded) = self.loaded.get(&id) {
                provenance.push(
                    json!({"order":order,"origin":id,"version":loaded.package.version,
                    "sha256":loaded.selection.sha256,"tier":loaded.selection.scope,
                    "from_sha256":digest(serde_json::to_string(&previous)?.as_bytes()),
                    "to_sha256":digest(serde_json::to_string(&effective)?.as_bytes())}),
                );
            }
        }
        payload["original"] = original;
        payload["effective"] = effective;
        payload["provenance"] = Value::Array(provenance);
        payload["fallback"] = Value::Array(fallback);
        Ok(payload)
    }

    fn event_ids(&self, event: &str) -> Vec<String> {
        self.active()
            .filter(|(_, loaded)| {
                loaded
                    .registrations
                    .events
                    .iter()
                    .any(|registered| registered == event)
            })
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn event_guarded(
        &mut self,
        event: &str,
        payload: Value,
        active: impl Fn() -> bool,
    ) -> Vec<(String, Result<Value>)> {
        let ids = self.event_ids(event);
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

    /// Activated mods in composition order: dependencies first, mod ID otherwise.
    fn active(&self) -> impl Iterator<Item = (&String, &Loaded)> {
        self.order.iter().filter_map(|id| {
            self.loaded
                .get(id)
                .filter(|m| m.error.is_none())
                .map(|m| (id, m))
        })
    }

    pub fn tools(&self) -> Vec<(String, u64, ModTool)> {
        self.active()
            .flat_map(|(id, m)| {
                m.registrations
                    .tools
                    .iter()
                    .map(|tool| (id.clone(), self.generation, tool.clone()))
            })
            .collect()
    }

    pub fn commands(&self) -> Vec<(String, ModCommand)> {
        self.active()
            .flat_map(|(id, m)| {
                m.registrations
                    .commands
                    .iter()
                    .map(|command| (id.clone(), command.clone()))
            })
            .collect()
    }

    pub fn owners(&self) -> Vec<(String, crate::PolicyOwner)> {
        self.active()
            .map(|(id, m)| (id.clone(), Self::owner(m)))
            .collect()
    }

    /// The mod holding the exclusive replacement slot for a decision point.
    pub fn replacement_owner(&self, point: &str) -> Option<String> {
        self.active()
            .find(|(_, m)| m.registrations.replacements.iter().any(|p| p == point))
            .map(|(id, _)| id.clone())
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
        self.active()
            .map(|(_, m)| m)
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

    fn write_installed_service_types(&self) -> Result<()> {
        let mut output = format!(
            "export type InstalledContractTypesVersion = {INSTALLED_CONTRACT_TYPES_VERSION};\nexport type InstalledHostRelease = '{OMD_HOST_RELEASE}';\nexport type InstalledModApi = '{MOD_API_VERSION}';\nexport type Json = null | boolean | number | string | Json[] | {{ [key: string]: Json }};\nexport interface InstalledModServices {{\n",
        );
        for (_, loaded) in self.active() {
            for contract in &loaded.registrations.services {
                output.push_str(&format!("  '{}@{}': {{\n", contract.name, contract.version));
                for (name, method) in &contract.methods {
                    output.push_str(&format!(
                        "    {}(input: {}): {};\n",
                        name,
                        service_ts_type(&method.input),
                        service_ts_type(&method.output)
                    ));
                }
                output.push_str("  };\n");
            }
        }
        output.push_str("}\n");
        self.store
            .write_bytes("installed-contracts.d.ts", output.as_bytes())?;
        self.write_active_host_types()
    }

    fn write_active_host_types(&self) -> Result<()> {
        let literal = |values: &[&str]| {
            values
                .iter()
                .map(|value| format!("'{value}'"))
                .collect::<Vec<_>>()
                .join(" | ")
        };
        let events = MOD_EVENTS
            .iter()
            .map(|(event, _)| *event)
            .collect::<Vec<_>>();
        let output = format!(
            "export type ActiveHostRelease = '{OMD_HOST_RELEASE}';\nexport type ActiveCodexRelease = '{CODEX_HOST_RELEASE}';\nexport type ActiveModApi = '{MOD_API_VERSION}';\nexport type ActivePackageSchema = {MOD_PACKAGE_SCHEMA_VERSION};\nexport type ActiveStateStorageSchema = {MOD_STATE_STORAGE_SCHEMA_VERSION};\nexport type ActiveCapability = {};\nexport type ActiveEvent = {};\nexport type ActiveReplacementPoint = {};\nexport type ActiveHostOperation = {};\n",
            literal(MOD_CAPABILITIES),
            literal(&events),
            literal(MOD_REPLACEMENT_POINTS),
            literal(MOD_HOST_OPERATIONS),
        );
        self.store
            .write_bytes("active-host.d.ts", output.as_bytes())
    }

    pub fn field_policies() -> Value {
        json!({
            "model_request": {"request_id":"observe_only","scope":"observe_only","authorized_presets":"observe_only","original":"observe_only","effective":"alterable","provenance":"observe_only"},
            "response_stream": {"kind":"observe_only","raw_sha256":"observe_only","raw_usage":"observe_only","opaque_reasoning":"observe_only","protected":"observe_only","text":"alterable","original":"observe_only","effective":"observe_only","provenance":"observe_only","fallback":"observe_only"},
            "prompt": {"thread_id":"observe_only","turn_id":"observe_only","original":"observe_only","effective":"replaceable","provenance":"observe_only"},
            "session": {"phase":"observe_only","thread_id":"observe_only","cause":"observe_only"},
            "agent": {"phase":"observe_only","agent_id":"observe_only","parent_agent_id":"observe_only","role":"observe_only","status":"observe_only"},
            "tool_call": {"call_id":"observe_only","agent_id":"observe_only","tool":"observe_only","arguments":"observe_only"},
            "tool_before": {"call_id":"observe_only","tool":"replaceable","arguments":"replaceable","deny":"alterable"},
            "tool_result": {"call_id":"observe_only","agent_id":"observe_only","tool":"observe_only","outcome":"observe_only"},
            "host_operation": {"phase":"observe_only","caller":"observe_only","operation":"observe_only","arguments":"observe_only","result":"observe_only","error":"observe_only"}
        })
    }

    pub fn status(&self) -> Value {
        json!({"api": MOD_API_VERSION, "host": {"codex":CODEX_HOST_RELEASE,"omd":OMD_HOST_RELEASE,
            "package_schema":MOD_PACKAGE_SCHEMA_VERSION,"state_storage_schema":MOD_STATE_STORAGE_SCHEMA_VERSION,
            "installed_contract_types":INSTALLED_CONTRACT_TYPES_VERSION,"features":MOD_HOST_FEATURES,
            "supported_apis":SUPPORTED_MOD_APIS.iter().map(|(version,stability,support_until)|
                json!({"version":version,"stability":stability,"support_until":support_until})).collect::<Vec<_>>()},
            "generation": self.generation, "reload_error": self.reload_error,
            "order": self.order, "rejected": self.rejected, "field_policies": Self::field_policies(),
            "installed_contract_types": self.store.root.join("installed-contracts.d.ts"),
            "active_host_types": self.store.root.join("active-host.d.ts"),
            "service_calls": self.service_calls,
            "mods": self.loaded.iter().map(|(id, m)| json!({"id": id, "version": m.package.version,
                "api":m.package.api,"api_stability":api_support(&m.package.api).map(|support|support.0),
                "entrypoint":m.package.entrypoint,"license":m.package.license,
                "provenance":m.package.provenance,"dependencies":m.package.dependencies,
                "settings_schema":m.package.settings_schema,"lifecycle":m.package.lifecycle.keys().collect::<Vec<_>>(),
                "package_schema":m.package.schema,"state_version":m.package.state_version,
                "host_compatibility":m.package.compatibility,
                "negotiated_features":{"required":m.package.compatibility.required_features,
                    "optional_available":m.package.compatibility.optional_features.iter().filter(|feature|MOD_HOST_FEATURES.contains(&feature.as_str())).collect::<Vec<_>>(),
                    "optional_unavailable":m.package.compatibility.optional_features.iter().filter(|feature|!MOD_HOST_FEATURES.contains(&feature.as_str())).collect::<Vec<_>>()},
                "sha256": m.selection.sha256, "capabilities": m.package.capabilities,
                "scope": m.selection.scope, "requires": m.package.requires, "services": m.package.services,
                "source_use":m.source_use,"unused_grants":m.unused_grants,
                "unused_environment":m.unused_environment,"hook_budget_ms":m.package.hook_budget_ms,
                "registrations": m.registrations, "telemetry":m.telemetry, "error": m.error})).collect::<Vec<_>>()})
    }
}

fn service_ts_type(kind: &str) -> &'static str {
    match kind {
        "null" => "null",
        "boolean" => "boolean",
        "number" => "number",
        "string" => "string",
        "array" => "Json[]",
        "object" => "Record<string, Json>",
        _ => "Json",
    }
}
