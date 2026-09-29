mod author;
mod bridge;
mod packages;
mod view;
pub use view::MOD_KEY_LIMIT;
pub use view::ModActivity;
pub use view::ModAsciiBackdrop;
pub use view::ModBackdrop;
pub use view::ModBorder;
pub use view::ModColor;
pub use view::ModCommandAction;
pub use view::ModCompletedTools;
pub use view::ModComponent;
pub use view::ModComponentAction;
pub use view::ModDensity;
pub use view::ModFind;
pub use view::ModIcons;
pub use view::ModImageBackdrop;
pub use view::ModKeyAction;
pub use view::ModLayout;
pub use view::ModLayoutLeaf;
pub use view::ModLayoutSplit;
pub use view::ModLayoutTabs;
pub use view::ModListRow;
pub use view::ModPanel;
pub use view::ModRange;
pub use view::ModRenderSite;
pub use view::ModSelectOption;
pub use view::ModSelectionPolicy;
pub use view::ModSelectionSource;
pub use view::ModSidebarSide;
pub use view::ModSiteMode;
pub use view::ModSpan;
pub use view::ModSplit;
pub use view::ModTab;
pub use view::ModTheme;
pub use view::ModThemePatch;
pub use view::ModTone;
pub use view::ModView;
pub use view::ModViewPatch;
pub use view::ModViewSnapshot;
pub use view::mod_command_reference;
pub use view::mod_key_name;
pub use view::valid_glyphs;
mod outcome;
pub use outcome::ModCommandOutcome;
pub use outcome::ModInputDecision;
mod package_manager;
mod process;
pub use bridge::ModHostCall;
mod resources;
mod store;
pub use resources::ModVirtualReader;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::cell::Cell;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

pub use package_manager::ModInstallRequest;
pub use package_manager::ModPackageGrant;
pub use package_manager::ModPackageLock;
pub use package_manager::ModPackagePlan;
pub use package_manager::ModPackageSource;
pub use package_manager::ModPackageTrust;
pub use store::ModStore;

pub const CODEX_HOST_RELEASE: &str = "0.157.0";
pub const OMD_HOST_RELEASE: &str = env!("CARGO_PKG_VERSION");
pub const MOD_API_VERSION: &str = "0.2.0-experimental.4";
pub const MOD_CALLBACK_TOTAL_BUDGET_MS: u64 = 5_000;
pub const MOD_SERVICE_DEPTH_LIMIT: usize = 8;

#[derive(Default)]
struct InvocationScope {
    calls: Cell<usize>,
    execution: Cell<Duration>,
    receipt_bytes: Cell<usize>,
    stack: RefCell<Vec<String>>,
}

struct InvocationFrame<'a>(&'a InvocationScope);

impl Drop for InvocationFrame<'_> {
    fn drop(&mut self) {
        self.0.stack.borrow_mut().pop();
    }
}

impl InvocationScope {
    fn enter(&self, id: &str) -> Result<InvocationFrame<'_>> {
        let mut stack = self.stack.borrow_mut();
        if stack.len() >= MOD_SERVICE_DEPTH_LIMIT {
            return Err(failure("service_depth_limit"));
        }
        if stack.iter().any(|item| item == id) {
            return Err(failure("service_call_cycle"));
        }
        stack.push(id.to_owned());
        Ok(InvocationFrame(self))
    }

    fn contains(&self, id: &str) -> bool {
        self.stack.borrow().iter().any(|item| item == id)
    }

    fn charge_execution(&self, elapsed: Duration) -> Result<()> {
        let total = self.execution.get().saturating_add(elapsed);
        self.execution.set(total);
        if total > Duration::from_millis(MOD_CALLBACK_TOTAL_BUDGET_MS) {
            return Err(failure("callback_execution_budget"));
        }
        Ok(())
    }

    fn charge_call(&self) -> Result<()> {
        let calls = self.calls.get();
        if calls >= 32 {
            return Err(failure("host_call_limit"));
        }
        self.calls.set(calls + 1);
        Ok(())
    }

    fn charge_receipt(&self, bytes: usize) -> Result<()> {
        let total = self.receipt_bytes.get().saturating_add(bytes);
        if total > HOST_RECEIPT_BYTES {
            return Err(failure("host_receipt_limit"));
        }
        self.receipt_bytes.set(total);
        Ok(())
    }

    fn receipt_room(&self) -> usize {
        HOST_RECEIPT_BYTES.saturating_sub(self.receipt_bytes.get())
    }
}

pub const HOST_RECEIPT_BYTES: usize = 131_072;

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
    "service_dispatch_v1",
    "integration_receipts_v1",
    "tool_result_fingerprints_v1",
    "source_use_v1",
    "state_migration_v1",
    "terminal_components_v1",
    "terminal_identity_v1",
    "terminal_render_sites_v1",
    "terminal_rich_line_v1",
    "terminal_selection_v1",
    "transactional_reload_v1",
    "task_tool_exposure_v1",
    "virtual_reads_v1",
    "scoped_data_v1",
    "plugin_dispatch_v1",
    "turn_evidence_v1",
    "service_requests_v1",
    "exec_v1",
    "exec_output_artifacts_v1",
    "guarded_exec_v1",
    "package_text_assets_v1",
    "workspace_access_v1",
    "workspace_fs_v1",
    "workspace_snapshots_v1",
    "workspace_fingerprint_v1",
    "snapshot_exec_v1",
    "agent_parent_history_v1",
    "agent_failures_v1",
    "task_resume_v1",
    "contract_scoped_restrictions_v1",
    "store_v1",
    "routes_v1",
    "stream_control_v1",
    "builtins_v1",
    "contracts_v2",
    "framed_process_v1",
    "kernels_v1",
    "terminal_lists_v1",
    "adapters_v1",
    "app_v1",
    "approval_v1",
    "tool_output_v1",
    "tool_batch_v1",
    "tool_specs_v1",
    "events_v1",
    "store_thread_v1",
    "turn_activity_v1",
    "binary_evidence_v1",
    "package_controls_v1",
    "terminal_surface_v1",
    "credentials_v1",
    "completion_v1",
    "tool_feedback_v1",
    "terminal_media_v1",
    "secrets_v1",
    "terminal_prompt_v1",
    "model_complete_v1",
    "history_v1",
    "terminal_pty_v1",
    "dynamic_tools_v1",
    "timers_v1",
    "terminal_input_v1",
    "terminal_style_v1",
    "completion_arguments_v1",
    "terminal_editor_v1",
    "pty_programs_v1",
];
pub const MOD_HOST_OPERATIONS: &[&str] = &[
    "exec.run",
    "exec.output_page",
    "workspace.read",
    "workspace.list",
    "workspace.stat",
    "workspace.check_access",
    "workspace.snapshot",
    "workspace.fingerprint",
    "workspace.transaction",
    "workspace.backup",
    "workspace.restore",
    "workspace.request_rename",
    "workspace.integrate",
    "store.get",
    "store.put",
    "store.delete",
    "store.list",
    "store.export",
    "store.reset",
    "evidence.write",
    "evidence.read",
    "sessions.list",
    "sessions.read",
    "sessions.snapshot",
    "routes.list",
    "task.status",
    "task.complete",
    "receipts.submit",
    "contract.status",
    "contract.restrict",
    "agents.spawn",
    "agents.message",
    "agents.cancel",
    "agents.result",
    "agents.wait",
    "agents.list",
    "process.which",
    "process.start",
    "process.exchange",
    "process.status",
    "process.stop",
    "providers.register",
    "providers.unregister",
    "sidecars.invoke",
    "sidecars.start",
    "sidecars.status",
    "sidecars.stop",
    "app.request",
    "app.routes",
    "workspace.watch",
    "workspace.unwatch",
    "events.publish",
    "credentials.list",
    "credentials.request",
    "routes.select",
    "turns.activity",
    "terminal.notify",
    "terminal.show_thread",
    "terminal.import_file",
    "composer.read",
    "composer.write",
    "builtins.invoke",
    "packages.list",
    "packages.preview",
    "packages.apply",
    "packages.reload",
    "terminal.open",
    "terminal.prompt",
    "terminal.pty",
    "model.complete",
    "tools.define",
    "tools.undefine",
    "events.schedule",
    "events.cancel",
];
pub const SUPPORTED_MOD_APIS: &[(&str, &str, &str)] = &[
    ("0.2.0-experimental.1", "experimental", "2027-03-20"),
    ("0.2.0-experimental.2", "experimental", "2027-03-20"),
    ("0.2.0-experimental.3", "experimental", "2027-03-20"),
    (MOD_API_VERSION, "experimental", "2027-03-20"),
];
pub const MOD_CAPABILITIES: &[&str] = &[
    "context",
    "tools",
    "commands",
    "lifecycle",
    "input",
    "interception",
    "compaction",
    "middleware",
    "services",
    "virtual_reads",
    "terminal",
    "exec",
    "fs.read",
    "fs.write",
    "network",
    "model",
    "agents",
    "store",
    "sessions",
    "contracts",
    "builtins",
    "threads",
    "config",
    "config.write",
    "inventory",
    "account",
    "packages",
    "approvals",
    "events",
    "credentials",
    "composer",
    "pty",
    "history",
    "outputs",
];
pub const MOD_EVENTS: &[(&str, &str)] = &[
    ("context", "context"),
    ("migrate", "store"),
    ("tool_before", "interception"),
    ("tool_exposure", "tools"),
    ("input", "input"),
    ("routing", "model"),
    ("terminal", "terminal"),
    ("list", "terminal"),
    ("selection", "terminal"),
    ("selection_result", "terminal"),
    ("compaction", "compaction"),
    ("start", "lifecycle"),
    ("idle", "lifecycle"),
    ("stop", "lifecycle"),
    ("resume", "lifecycle"),
    ("tool_result", "lifecycle"),
    ("workspace_change", "fs.read"),
    ("workspace_pre_rename", "fs.write"),
    ("turn_start", "lifecycle"),
    ("turn_end", "lifecycle"),
    ("compaction_start", "lifecycle"),
    ("compaction_end", "lifecycle"),
    ("agent_end", "lifecycle"),
    ("contract", "contracts"),
    ("model_request", "middleware"),
    ("response_stream", "middleware"),
    ("prompt", "middleware"),
    ("session", "middleware"),
    ("agent", "middleware"),
    ("tool_call", "middleware"),
    ("host_operation", "middleware"),
    ("app_notification", "threads"),
    ("app_server_request", "approvals"),
    ("approval", "approvals"),
    ("approval_result", "approvals"),
    ("tool_output", "outputs"),
    ("tool_batch", "interception"),
    ("tool_specs", "tools"),
    ("process_event", "exec"),
    ("channel", "events"),
    ("timer", "events"),
    ("component_event", "terminal"),
    ("view", "terminal"),
    ("focus", "terminal"),
    ("completion", "composer"),
    ("history", "history"),
];
pub const MOD_REPLACEMENT_POINTS: &[&str] = &[
    "tool_before",
    "routing",
    "terminal",
    "compaction",
    "context",
    "input",
    "list",
    "selection",
    "tool_output",
    "tool_batch",
    "tool_specs",
    "completion",
    "history",
];
pub const MOD_MIDDLEWARE_EVENTS: &[&str] = &[
    "model_request",
    "response_stream",
    "prompt",
    "session",
    "agent",
    "tool_call",
    "tool_result",
    "host_operation",
    "approval",
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

fn outside_literals(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut visible = bytes.to_vec();
    let mut index = 0;
    while index < bytes.len() {
        let quote = bytes[index];
        if matches!(quote, b'\'' | b'"' | b'`') {
            visible[index] = b' ';
            index += 1;
            while index < bytes.len() {
                let byte = bytes[index];
                visible[index] = b' ';
                index += 1;
                if byte == b'\\' && index < bytes.len() {
                    visible[index] = b' ';
                    index += 1;
                } else if byte == quote {
                    break;
                }
            }
        } else if quote == b'/' && bytes.get(index + 1) == Some(&b'/') {
            while index < bytes.len() && bytes[index] != b'\n' {
                visible[index] = b' ';
                index += 1;
            }
        } else if quote == b'/' && bytes.get(index + 1) == Some(&b'*') {
            visible[index] = b' ';
            index += 1;
            while index < bytes.len() {
                let end = bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/');
                visible[index] = b' ';
                index += 1;
                if end {
                    visible[index] = b' ';
                    index += 1;
                    break;
                }
            }
        } else {
            index += 1;
        }
    }
    String::from_utf8(visible).unwrap_or_default()
}

fn source_use(
    source: &str,
    package: &ModPackage,
    registrations: &Registrations,
) -> Result<(ModSourceUse, Vec<String>, Vec<String>)> {
    let mut operations = quoted_calls(source, "host.call(")?;
    operations.extend(quoted_calls(source, "host.tryCall(")?);
    operations.sort();
    operations.dedup();
    let services = quoted_calls(source, "services.call(")?;
    let visible = outside_literals(source);
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
        if needles.iter().any(|needle| {
            if name == "filesystem" {
                source.contains(needle)
            } else {
                visible.contains(needle)
            }
        }) {
            environment.push(name.to_owned());
        }
    }
    for name in &environment {
        if !package.environment.contains(name) {
            return Err(failure(format!("undeclared_environment_use: {name}")));
        }
    }
    let used_capabilities = |operation: &String| -> Result<Vec<String>> {
        let used = if operation == "app.request" {
            let named = crate::app_routes::classes_named_in(source);
            package
                .capabilities
                .iter()
                .filter(|declared| match &named {
                    Some(named) => named.contains(declared.as_str()),
                    None => crate::app_routes::class(declared),
                })
                .cloned()
                .collect()
        } else {
            let capability = ModHostCall {
                operation: operation.clone(),
                arguments: Value::Null,
            }
            .capability()?;
            package
                .capabilities
                .iter()
                .filter(|declared| *declared == capability)
                .cloned()
                .collect::<Vec<_>>()
        };
        if used.is_empty() {
            return Err(failure(format!("undeclared_operation_use: {operation}")));
        }
        Ok(used)
    };
    for operation in &operations {
        used_capabilities(operation)?;
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
        capabilities.insert("contracts".to_owned());
    }
    if !registrations.builtins.is_empty() {
        capabilities.insert("builtins".to_owned());
    }
    if !registrations.services.is_empty() || !services.is_empty() {
        capabilities.insert("services".to_owned());
    }
    if !registrations.virtual_reads.is_empty() {
        capabilities.insert("virtual_reads".to_owned());
    }
    if source.contains(".state.get(") || source.contains(".state.set(") {
        capabilities.insert("store".to_owned());
    }
    for operation in &operations {
        capabilities.extend(used_capabilities(operation)?);
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_module: Option<ModAdapterModule>,
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exec_environment: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<ModDependency>,
    #[serde(default)]
    pub services: ModServiceManifest,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assets: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub environment: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_schema: Option<Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub lifecycle: BTreeMap<String, String>,
    #[serde(default = "default_hook_budget_ms")]
    pub hook_budget_ms: u64,
    #[serde(default, skip_serializing_if = "ModSubscriptions::is_empty")]
    pub subscriptions: ModSubscriptions,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModSubscriptions {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub app: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub channels: Vec<String>,
}

impl ModSubscriptions {
    pub fn is_empty(&self) -> bool {
        self.app.is_empty() && self.channels.is_empty()
    }

    fn validate(&self, capabilities: &[String]) -> Result<()> {
        let granted = |capability: &str| capabilities.iter().any(|c| c == capability);
        let pattern = |value: &str, allowed: &dyn Fn(u8) -> bool| {
            let body = value.strip_suffix('*').unwrap_or(value);
            !value.is_empty() && value.len() <= 96 && body.bytes().all(allowed)
        };
        let app_ok = self.app.iter().all(|value| {
            pattern(value, &|b| {
                b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_')
            }) && (crate::app_routes::notification_patterns_match(value)
                || crate::app_routes::server_request_patterns_match(value))
        });
        let channels_ok = self.channels.iter().all(|value| {
            pattern(value, &|b| {
                b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || matches!(b, b'/' | b'_' | b'-' | b'.')
            })
        });
        if self.app.len() > 32 || self.channels.len() > 32 || !app_ok || !channels_ok {
            return Err(failure("invalid_subscriptions"));
        }
        for value in &self.app {
            if crate::app_routes::notification_patterns_match(value) && !granted("threads") {
                return Err(failure("capability_denied: threads"));
            }
            if crate::app_routes::server_request_patterns_match(value) && !granted("approvals") {
                return Err(failure("capability_denied: approvals"));
            }
        }
        if !self.channels.is_empty() && !granted("events") {
            return Err(failure("capability_denied: events"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModAdapterModule {
    pub entry: String,
    #[serde(default)]
    pub aliases: BTreeMap<String, String>,
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
        if let Some(adapter) = self.adapter.as_deref()
            && (adapter == self.id
                || !self
                    .dependencies
                    .iter()
                    .any(|dependency| dependency.id == adapter))
        {
            return Err(failure("unsupported_adapter"));
        }
        if let Some(module) = &self.adapter_module
            && (!self.assets.contains(&module.entry)
                || module.aliases.len() > 8
                || module.aliases.iter().any(|(specifier, asset)| {
                    specifier.is_empty()
                        || specifier.len() > 64
                        || specifier.starts_with('.')
                        || specifier.starts_with('/')
                        || !self.assets.contains(asset)
                }))
        {
            return Err(failure("invalid_adapter_module"));
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
        self.subscriptions.validate(&self.capabilities)?;
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
        let assets: BTreeSet<_> = self.assets.iter().collect();
        if self.assets.len() > 8
            || assets.len() != self.assets.len()
            || self
                .assets
                .iter()
                .any(|asset| !asset_file(asset) || asset == &self.entrypoint)
        {
            return Err(failure("invalid_package_assets"));
        }
        if self.exec_environment.len() > 16
            || self.exec_environment.iter().collect::<BTreeSet<_>>().len()
                != self.exec_environment.len()
            || self.exec_environment.iter().any(|name| {
                name.is_empty()
                    || name.len() > 64
                    || !name.bytes().all(|byte| {
                        byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                    })
                    || name.as_bytes()[0].is_ascii_digit()
                    || crate::host::RESERVED_EXEC_ENVIRONMENT.contains(&name.as_str())
                    || crate::host::RESERVED_EXEC_PREFIXES
                        .iter()
                        .any(|prefix| name.starts_with(prefix))
            })
            || !self.exec_environment.is_empty() && !self.capabilities.iter().any(|c| c == "exec")
        {
            return Err(failure("invalid_exec_environment"));
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
            if exports.contains(&import.name) {
                return Err(failure(format!("service_self_import: {}", import.name)));
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

fn asset_file(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && [".ts", ".mjs", ".json"]
            .iter()
            .any(|ending| value.ends_with(ending))
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
    #[serde(default)]
    pub task_scoped: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModCommand {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModTerminalView {
    pub view: ModView,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub contributors: Vec<String>,
    #[serde(default)]
    pub diagnostics: Vec<String>,
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
    contracts: Vec<Value>,
    #[serde(default)]
    builtins: Vec<Value>,
    #[serde(default)]
    services: Vec<ModServiceContract>,
    #[serde(default)]
    virtual_reads: Vec<ModVirtualReader>,
    #[serde(default)]
    dynamic_tools: bool,
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
    assets: BTreeMap<String, Value>,
    adapter: Option<Value>,
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

#[derive(Clone, Debug, PartialEq)]
pub struct ModGrants {
    pub api: String,
    pub source_sha256: String,
    pub capabilities: Vec<String>,
    pub exec_environment: Vec<String>,
}

pub struct ModHost {
    store: ModStore,
    node: PathBuf,
    generation: u64,
    configuration_sha256: String,
    selections: (usize, usize),
    loaded: BTreeMap<String, Loaded>,
    order: Vec<String>,
    rejected: Vec<ModRejection>,
    reload_error: Option<String>,
    service_calls: Vec<Value>,
    tool_validator: fn(&Value) -> Result<()>,
    virtual_time_ms: Option<u64>,
    dynamic_tools: BTreeMap<String, Vec<ModTool>>,
}

enum Access<'a> {
    Held(&'a mut ModHost),
    Shared(&'a Mutex<ModHost>),
}

impl Access<'_> {
    fn with<T>(&mut self, run: impl FnOnce(&mut ModHost) -> Result<T>) -> Result<T> {
        match self {
            Access::Held(runtime) => run(runtime),
            Access::Shared(runtime) => run(&mut *runtime
                .lock()
                .map_err(|_| failure("mod_runtime_poisoned"))?),
        }
    }
}

struct Invocation {
    loaded: Loaded,
    dynamic: Vec<String>,
    previous_state: Value,
    node: PathBuf,
    virtual_time_ms: Option<u64>,
    started: Instant,
}

fn registered_call(loaded: &Loaded, dynamic: &[String], event: &str, name: &str) -> Result<()> {
    match event {
        "tool" if loaded.registrations.tools.iter().any(|t| t.name == name) => (),
        "tool" if dynamic.iter().any(|tool| tool == name) => (),
        "command" if loaded.registrations.commands.iter().any(|c| c.name == name) => (),
        "virtual_read"
            if loaded
                .registrations
                .virtual_reads
                .iter()
                .any(|reader| reader.scheme == name) => {}
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
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn invoke(
    access: &mut Access<'_>,
    id: &str,
    generation: u64,
    event: &str,
    name: &str,
    payload: Value,
    active: &dyn Fn() -> bool,
    host: &mut dyn FnMut(&str, ModHostCall) -> Result<Value>,
    progress: &mut dyn FnMut(String),
    scope: &InvocationScope,
) -> Result<Value> {
    let _frame = scope.enter(id)?;
    let invocation = access.with(|runtime| runtime.begin(id, generation, active))?;
    let reply = registered_call(&invocation.loaded, &invocation.dynamic, event, name).and_then(|()| {
        bridge::run(
            &invocation.node,
            &invocation.loaded,
            event,
            name,
            payload,
            active,
            &mut |call| {
                let private = call.operation.starts_with("sessions.")
                    || call.operation.starts_with("evidence.");
                let before = json!({"phase":"before","caller":id,"operation":call.operation,"arguments":if private {Value::Null} else {call.arguments.clone()}});
                let _ = access.with(|runtime| {
                    Ok(runtime.event_except("host_operation", before, id, active, scope))
                });
                let result = if call.operation == "mods.service" {
                    access.with(|runtime| {
                        runtime.call_service(id, generation, call.arguments.clone(), active, host, scope)
                    })
                } else {
                    host(id, call.clone())
                };
                let after = match &result {
                    Ok(value) => {
                        json!({"phase":"after","caller":id,"operation":call.operation,"result":if private {Value::Null} else {value.clone()}})
                    }
                    Err(error) => {
                        json!({"phase":"after","caller":id,"operation":call.operation,"error":if private {"private_operation_failed".to_owned()} else {error.to_string()}})
                    }
                };
                let _ = access.with(|runtime| {
                    Ok(runtime.event_except("host_operation", after, id, active, scope))
                });
                result
            },
            progress,
            invocation.virtual_time_ms,
            scope,
        )
    });
    access.with(|runtime| runtime.finish(id, generation, event, name, invocation, reply, active))
}

#[allow(clippy::too_many_arguments)]
pub fn invoke_shared(
    runtime: &Mutex<ModHost>,
    id: &str,
    generation: u64,
    event: &str,
    name: &str,
    payload: Value,
    active: impl Fn() -> bool,
    mut host: impl FnMut(&str, ModHostCall) -> Result<Value>,
    mut progress: impl FnMut(String),
) -> Result<Value> {
    invoke(
        &mut Access::Shared(runtime),
        id,
        generation,
        event,
        name,
        payload,
        &active,
        &mut host,
        &mut progress,
        &InvocationScope::default(),
    )
}

pub fn event_shared(
    runtime: &Mutex<ModHost>,
    event: &str,
    mut payload: impl FnMut(&str) -> Value,
    active: impl Fn() -> bool,
    mut host: impl FnMut(&str, ModHostCall) -> Result<Value>,
) -> Vec<(String, Result<Value>)> {
    let Ok((ids, generation)) = runtime
        .lock()
        .map(|runtime| (runtime.event_ids(event), runtime.generation))
    else {
        return Vec::new();
    };
    ids.into_iter()
        .map(|id| {
            let result = invoke_shared(
                runtime,
                &id,
                generation,
                event,
                "",
                payload(&id),
                &active,
                &mut host,
                |_| {},
            );
            (id, result)
        })
        .collect()
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
            selections: (0, 0),
            loaded: BTreeMap::new(),
            order: Vec::new(),
            rejected: Vec::new(),
            reload_error: None,
            service_calls: Vec::new(),
            tool_validator,
            virtual_time_ms: None,
            dynamic_tools: BTreeMap::new(),
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
        if config.schema != 1 || !config.node.is_absolute() {
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
            self.dynamic_tools.clear();
        }
        let mut rejected = Vec::new();
        let selected = Self::select(&config, initial, &mut rejected)?;
        let adapters = Self::adapters(&selected);
        let mut next = BTreeMap::new();
        for (id, (selection, package, source)) in selected {
            let assets = if package.assets.is_empty() {
                BTreeMap::new()
            } else {
                let (_, _, hash, files) = store::package_with_assets(&selection.path)?;
                if hash != selection.sha256 {
                    return Err(failure(format!("untrusted_source: {}", package.id)));
                }
                if files.values().map(String::len).sum::<usize>() > 128 * 1024 {
                    return Err(failure(format!(
                        "package_text_asset_input_limit: {}",
                        package.id
                    )));
                }
                files
                    .into_iter()
                    .map(|(name, text)| {
                        let sha256 = digest(text.as_bytes());
                        (name, json!({"text": text, "sha256": sha256}))
                    })
                    .collect()
            };
            let adapter = package.adapter.as_deref().map(|name| {
                adapters
                    .get(name)
                    .cloned()
                    .ok_or_else(|| failure(format!("adapter_unavailable: {name}")))
            });
            let mut loaded = Loaded {
                adapter: adapter
                    .as_ref()
                    .and_then(|value| value.as_ref().ok().cloned()),
                package,
                source,
                assets,
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
                if let Some(Err(error)) = &adapter {
                    return Err(failure(error.to_string()));
                }
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
        Self::resolve_virtual_readers(&mut next, initial)?;
        let order = Self::resolve_dependencies(&mut next, initial)?;
        self.selections = (
            config
                .mods
                .iter()
                .map(|m| &m.path)
                .collect::<BTreeSet<_>>()
                .len(),
            config
                .mods
                .iter()
                .filter(|m| m.enabled)
                .map(|m| &m.path)
                .collect::<BTreeSet<_>>()
                .len(),
        );
        self.node = config.node;
        self.loaded = next;
        self.order = order;
        self.rejected = rejected;
        self.configuration_sha256 = hash;
        self.generation += 1;
        self.dynamic_tools.clear();
        self.reload_error = None;
        self.write_installed_service_types()?;
        Ok(true)
    }

    fn adapters(
        selected: &BTreeMap<String, (ModSelection, ModPackage, String)>,
    ) -> BTreeMap<String, Value> {
        selected
            .iter()
            .filter_map(|(id, (selection, package, _))| {
                let module = package.adapter_module.as_ref()?;
                let (_, _, hash, assets) = store::package_with_assets(&selection.path).ok()?;
                if hash != selection.sha256 {
                    return None;
                }
                let file = |asset: &String| {
                    assets.get(asset).map(|source| {
                        json!({"source": source, "filename": selection.path.join(asset)})
                    })
                };
                let entry = file(&module.entry)?;
                let aliases = module
                    .aliases
                    .iter()
                    .map(|(specifier, asset)| Some((specifier.clone(), file(asset)?)))
                    .collect::<Option<serde_json::Map<_, _>>>()?;
                Some((
                    id.clone(),
                    json!({"source": entry["source"], "filename": entry["filename"], "aliases": aliases}),
                ))
            })
            .collect()
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
                    .entry(contract["id"].as_str().unwrap_or_default().to_owned())
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
        conflicts.extend(contested("contract_conflict", contracts));
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
            || ((!registrations.tools.is_empty() || registrations.dynamic_tools) && !has("tools"))
            || (!registrations.commands.is_empty() && !has("commands"))
            || (!registrations.contracts.is_empty() && !has("contracts"))
            || (!registrations.services.is_empty() && !has("services"))
            || (!registrations.builtins.is_empty() && !has("builtins"))
            || registrations.contracts.len() > 4
            || registrations.builtins.len() > 1
            || registrations.services.len() > 8
        {
            return Err(failure("registration_limit_or_capability_denied"));
        }
        if registrations.services != package.services.exports {
            return Err(failure(
                "registered_service_contracts_do_not_match_manifest",
            ));
        }
        resources::validate_registrations(package, &registrations.virtual_reads)?;
        let mut contract_ids = BTreeSet::new();
        for contract in &registrations.contracts {
            let id = crate::ContractDocument::parse(contract)
                .map_err(failure)?
                .id;
            if !contract_ids.insert(id) {
                return Err(failure("invalid_or_duplicate_contract_registration"));
            }
        }
        for controls in &registrations.builtins {
            crate::BuiltinControls::parse(controls).map_err(failure)?;
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
            if let Some(cli) = &command.cli
                && (!package
                    .compatibility
                    .required_features
                    .iter()
                    .any(|feature| feature == "plugin_dispatch_v1")
                    || cli.is_empty()
                    || cli.len() > 64
                    || !cli.bytes().all(|byte| {
                        byte.is_ascii_lowercase()
                            || byte.is_ascii_digit()
                            || matches!(byte, b'-' | b'_')
                    }))
            {
                return Err(failure("cli_command_version_or_name_invalid"));
            }
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
            &InvocationScope::default(),
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
        progress: impl FnMut(String),
    ) -> Result<Value> {
        self.invoke_scoped_streaming(
            id,
            generation,
            event,
            name,
            payload,
            active,
            |caller, call| {
                if caller != id {
                    return Err(failure("service_provider_host_dispatch_unavailable"));
                }
                host(call)
            },
            progress,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn invoke_scoped_with(
        &mut self,
        id: &str,
        generation: u64,
        event: &str,
        name: &str,
        payload: Value,
        active: impl Fn() -> bool,
        host: impl FnMut(&str, ModHostCall) -> Result<Value>,
    ) -> Result<Value> {
        self.invoke_scoped_streaming(id, generation, event, name, payload, active, host, |_| {})
    }

    #[allow(clippy::too_many_arguments)]
    pub fn invoke_scoped_streaming(
        &mut self,
        id: &str,
        generation: u64,
        event: &str,
        name: &str,
        payload: Value,
        active: impl Fn() -> bool,
        mut host: impl FnMut(&str, ModHostCall) -> Result<Value>,
        mut progress: impl FnMut(String),
    ) -> Result<Value> {
        let scope = InvocationScope::default();
        self.invoke_scoped_inner(
            id,
            generation,
            event,
            name,
            payload,
            &active,
            &mut host,
            &mut progress,
            &scope,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn invoke_scoped_inner(
        &mut self,
        id: &str,
        generation: u64,
        event: &str,
        name: &str,
        payload: Value,
        active: &dyn Fn() -> bool,
        host: &mut dyn FnMut(&str, ModHostCall) -> Result<Value>,
        progress: &mut dyn FnMut(String),
        scope: &InvocationScope,
    ) -> Result<Value> {
        invoke(
            &mut Access::Held(self),
            id,
            generation,
            event,
            name,
            payload,
            active,
            host,
            progress,
            scope,
        )
    }

    fn begin(
        &mut self,
        id: &str,
        generation: u64,
        active: &dyn Fn() -> bool,
    ) -> Result<Invocation> {
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
        Ok(Invocation {
            dynamic: self
                .dynamic_tools
                .get(id)
                .into_iter()
                .flatten()
                .map(|tool| tool.name.clone())
                .collect(),
            previous_state: loaded.state.clone(),
            loaded,
            node: self.node.clone(),
            virtual_time_ms: self.virtual_time_ms,
            started: Instant::now(),
        })
    }

    fn accept(
        &mut self,
        loaded: &Loaded,
        event: &str,
        reply: Reply,
        active: &dyn Fn() -> bool,
    ) -> Result<(Value, Value)> {
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
        if matches!(event, "routing" | "compaction") && !reply.value.is_null() && !replaces(event) {
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
        if event == "routing" && !reply.value.is_null() {
            let valid = reply.value.as_object().is_some_and(|object| {
                object.len() == 1
                    && object
                        .get("route")
                        .and_then(Value::as_str)
                        .is_some_and(crate::resource_data::token)
            });
            if !valid {
                return Err(failure("invalid_routing_result"));
            }
        }
        if event == "tool_before"
            && reply.value.get("arguments").is_some()
            && !replaces("tool_before")
        {
            return Err(failure("exclusive_replacement_registration_required"));
        }
        if event == "terminal" && !reply.value.is_null() {
            if replaces("terminal") {
                ModView::parse(reply.value.clone())?;
            } else {
                ModViewPatch::parse(reply.value.clone())?;
            }
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
            if !loaded.package.capabilities.iter().any(|c| c == "store") {
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
    }

    #[allow(clippy::too_many_arguments)]
    fn finish(
        &mut self,
        id: &str,
        generation: u64,
        event: &str,
        name: &str,
        invocation: Invocation,
        reply: Result<Reply>,
        active: &dyn Fn() -> bool,
    ) -> Result<Value> {
        let result = reply.and_then(|reply| self.accept(&invocation.loaded, event, reply, active));
        if generation != self.generation {
            return result.map(|(value, _)| value);
        }
        let (started, previous_state) = (invocation.started, invocation.previous_state);
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
                let message = error.to_string();
                if ![
                    "state_conflict",
                    "callback_cancelled",
                    "host_receipt_limit",
                    "host_result_limit",
                    "host_call_limit",
                    "callback_execution_budget",
                ]
                .iter()
                .any(|transient| message.trim_start_matches("Error: ").starts_with(transient))
                {
                    current.error = Some(message);
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
        scope: &InvocationScope,
    ) -> Vec<(String, Result<Value>)> {
        let ids: Vec<_> = self
            .active()
            .filter(|(id, loaded)| {
                id.as_str() != excluded
                    && !scope.contains(id)
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
                let result = self.invoke_scoped_inner(
                    &id,
                    self.generation,
                    event,
                    "",
                    payload.clone(),
                    active,
                    &mut |_, _| Err(failure("observer_host_operation_unavailable")),
                    &mut |_| {},
                    scope,
                );
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
        host: &mut dyn FnMut(&str, ModHostCall) -> Result<Value>,
        scope: &InvocationScope,
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
        if provider == caller {
            return Err(failure(format!("service_self_import: {}", call.name)));
        }
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
        let result = self.invoke_scoped_inner(
            &provider,
            generation,
            "service",
            &qualified,
            call.input,
            active,
            host,
            &mut |_| {},
            scope,
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

    pub fn history(
        &mut self,
        payload: Value,
        active: impl Fn() -> bool,
    ) -> Result<Option<(String, Value)>> {
        let Some(owner) = self.replacement_owner("history") else {
            return Ok(None);
        };
        let value = self.invoke_guarded(&owner, self.generation, "history", "", payload, active)?;
        Ok((!value.is_null()).then_some((owner, value)))
    }

    pub fn model_request(
        &mut self,
        mut payload: Value,
        active: impl Fn() -> bool,
    ) -> Result<Value> {
        let routes = payload["routes"]
            .as_array()
            .ok_or_else(|| failure("routes_required"))?
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
                .get("route")
                .and_then(Value::as_str)
                .ok_or_else(|| failure("invalid_model_request_result"))?;
            let route = routes
                .iter()
                .find(|route| route["name"].as_str() == Some(selected))
                .and_then(Value::as_object)
                .ok_or_else(|| failure(format!("unauthorized_request_route: {selected}")))?;
            let previous = effective.get("name").cloned().unwrap_or(Value::Null);
            effective = route.clone();
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
        let boundary = payload["boundary"].as_bool().unwrap_or(false);
        let original = payload.get("text").cloned().unwrap_or(Value::Null);
        let mut effective = original.clone();
        let mut provenance = Vec::new();
        let mut fallback = Vec::new();
        let mut control = Value::Null;
        for (order, id) in self.event_ids("response_stream").into_iter().enumerate() {
            if !control.is_null() {
                break;
            }
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
            if let Some(stop) = value.get("stop") {
                let reason = stop
                    .get("reason")
                    .and_then(Value::as_str)
                    .filter(|reason| !reason.is_empty() && reason.len() <= 256);
                let inject = value.get("retry").map(|retry| {
                    retry
                        .get("inject")
                        .and_then(Value::as_str)
                        .filter(|text| !text.trim().is_empty() && text.len() <= 4096)
                });
                let shape = value
                    .as_object()
                    .is_some_and(|object| object.keys().all(|key| key == "stop" || key == "retry"))
                    && stop.as_object().is_some_and(|object| object.len() == 1)
                    && value.get("retry").is_none_or(|retry| {
                        retry.as_object().is_some_and(|object| object.len() == 1)
                    });
                let error = if !boundary {
                    Some("stream_control_requires_output_boundary")
                } else if !shape || reason.is_none() || inject == Some(None) {
                    Some("invalid_stream_control")
                } else {
                    None
                };
                if let Some(error) = error {
                    if let Some(loaded) = self.loaded.get_mut(&id) {
                        loaded.error = Some(error.to_owned());
                    }
                    fallback.push(json!({"origin":id,"error":error}));
                    continue;
                }
                control = json!({"origin": id, "order": order, "reason": reason,
                    "retry": inject.flatten().map(|inject| json!({"inject": inject}))});
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
        payload["control"] = control;
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

    pub fn has_event(&self, event: &str) -> bool {
        self.active().any(|(_, loaded)| {
            loaded
                .registrations
                .events
                .iter()
                .any(|registered| registered == event)
        })
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

    pub fn event_guarded_with(
        &mut self,
        event: &str,
        payload: Value,
        active: impl Fn() -> bool,
        host: impl FnMut(&str, ModHostCall) -> Result<Value>,
    ) -> Vec<(String, Result<Value>)> {
        self.event_scoped_with(event, |_| payload.clone(), active, host)
    }

    pub fn event_scoped_with(
        &mut self,
        event: &str,
        mut payload: impl FnMut(&str) -> Value,
        active: impl Fn() -> bool,
        mut host: impl FnMut(&str, ModHostCall) -> Result<Value>,
    ) -> Vec<(String, Result<Value>)> {
        let ids = self.event_ids(event);
        ids.into_iter()
            .map(|id| {
                let result = self.invoke_scoped_with(
                    &id,
                    self.generation,
                    event,
                    "",
                    payload(&id),
                    &active,
                    &mut host,
                );
                (id, result)
            })
            .collect()
    }

    pub fn subscribers_with_capability(&self, event: &str, capability: &str) -> Vec<String> {
        self.active()
            .filter(|(_, loaded)| {
                loaded
                    .package
                    .capabilities
                    .iter()
                    .any(|cap| cap == capability)
                    && loaded.registrations.events.iter().any(|name| name == event)
            })
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn subscriptions(&self) -> Vec<(String, ModSubscriptions)> {
        self.active()
            .filter(|(_, loaded)| !loaded.package.subscriptions.is_empty())
            .map(|(id, loaded)| (id.clone(), loaded.package.subscriptions.clone()))
            .collect()
    }

    pub fn holds_capability(&self, capability: &str) -> bool {
        self.active().any(|(_, loaded)| {
            loaded
                .package
                .capabilities
                .iter()
                .any(|cap| cap == capability)
        })
    }

    pub fn terminal_view(&mut self, payload: Value, active: impl Fn() -> bool) -> ModTerminalView {
        let owner = self.replacement_owner("terminal");
        let results = self.event_guarded("terminal", payload, active);
        let mut view = ModView::default();
        let mut patches = Vec::new();
        let mut diagnostics = Vec::new();
        for (id, result) in results {
            match result {
                Ok(value) if value.is_null() => {}
                Ok(value) if owner.as_deref() == Some(id.as_str()) => match ModView::parse(value) {
                    Ok(candidate) => view = candidate,
                    Err(error) => diagnostics.push(format!("{id}: {error}")),
                },
                Ok(value) => match ModViewPatch::parse(value) {
                    Ok(patch) => patches.push((id, patch)),
                    Err(error) => diagnostics.push(format!("{id}: {error}")),
                },
                Err(error) => diagnostics.push(format!("{id}: {error}")),
            }
        }
        let mut replaced_sites = BTreeSet::new();
        let mut completed_tools_owner = false;
        let mut contributors = Vec::new();
        for (id, patch) in patches {
            match patch.apply(&mut view, &mut replaced_sites, &mut completed_tools_owner) {
                Ok(()) => contributors.push(id),
                Err(error) => {
                    diagnostics.push(format!("{id}: {error}"));
                    if let Some(loaded) = self.loaded.get_mut(&id) {
                        loaded.error = Some(error.to_string());
                    }
                }
            }
        }
        ModTerminalView {
            view,
            owner,
            contributors,
            diagnostics,
        }
    }

    pub fn list_view(
        &mut self,
        payload: Value,
        active: impl Fn() -> bool,
    ) -> Option<(String, Vec<ModComponent>)> {
        let owner = self.replacement_owner("list")?;
        let value = self
            .invoke_guarded(&owner, self.generation, "list", "", payload, active)
            .ok()?;
        if value.is_null() {
            return None;
        }
        let site = ModRenderSite {
            mode: ModSiteMode::Replace,
            components: serde_json::from_value(value).ok()?,
        };
        let view = ModView::parse(json!({"sites": {"dialog": site}})).ok()?;
        view.sites
            .get("dialog")
            .map(|site| (owner, site.components.clone()))
    }

    pub fn selection_decision(
        &mut self,
        payload: Value,
        active: impl Fn() -> bool,
    ) -> Option<bool> {
        let owner = self.replacement_owner("selection")?;
        match self.invoke_guarded(&owner, self.generation, "selection", "", payload, active) {
            Ok(Value::Null) => Some(false),
            Ok(value) if value == json!({"copy": true}) => Some(true),
            _ => Some(false),
        }
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
        let mut tools: Vec<_> = self
            .active()
            .flat_map(|(id, m)| {
                m.registrations
                    .tools
                    .iter()
                    .chain(self.dynamic_tools.get(id).into_iter().flatten())
                    .map(|tool| (id.clone(), self.generation, tool.clone()))
            })
            .collect();
        if !self.virtual_readers().is_empty() {
            tools.push((String::new(), self.generation, resources::read_tool()));
        }
        tools
    }

    pub fn define_tool(&mut self, id: &str, generation: u64, arguments: Value) -> Result<Value> {
        let tool: ModTool = serde_json::from_value(arguments)?;
        let loaded = self
            .loaded
            .get(id)
            .filter(|loaded| loaded.error.is_none() && generation == self.generation)
            .ok_or_else(|| failure("stale_mod_generation: retry on the next turn"))?;
        if !loaded.registrations.dynamic_tools {
            return Err(failure("dynamic_tools_unregistered"));
        }
        if !identifier(&tool.name)
            || tool.description.is_empty()
            || tool.description.len() > 4096
            || tool.task_scoped
            || loaded
                .registrations
                .tools
                .iter()
                .any(|t| t.name == tool.name)
        {
            return Err(failure("dynamic_tool_invalid"));
        }
        (self.tool_validator)(&tool.parameters)?;
        let tools = self.dynamic_tools.entry(id.to_owned()).or_default();
        tools.retain(|existing| existing.name != tool.name);
        if tools.len() >= 64 {
            return Err(failure("dynamic_tool_limit"));
        }
        let name = tool.name.clone();
        tools.push(tool);
        Ok(json!({"name": name, "effective_at": "next_request"}))
    }

    pub fn undefine_tool(&mut self, id: &str, arguments: &Value) -> Result<Value> {
        let name = arguments["name"]
            .as_str()
            .ok_or_else(|| failure("dynamic_tool_invalid"))?;
        let tools = self.dynamic_tools.entry(id.to_owned()).or_default();
        let before = tools.len();
        tools.retain(|tool| tool.name != name);
        Ok(json!({"removed": tools.len() != before}))
    }

    pub fn has_task_scoped_tools(&self) -> bool {
        self.active().any(|(_, loaded)| {
            loaded
                .registrations
                .tools
                .iter()
                .any(|tool| tool.task_scoped)
        })
    }

    pub fn tools_for_step(
        &mut self,
        thread_id: Option<String>,
        ledger: Value,
        active: impl Fn() -> bool,
    ) -> Vec<(String, u64, ModTool)> {
        let ids: Vec<String> = self
            .active()
            .filter(|(_, loaded)| {
                loaded
                    .registrations
                    .tools
                    .iter()
                    .any(|tool| tool.task_scoped)
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut enabled = BTreeSet::new();
        for id in ids {
            let Some(loaded) = self.loaded.get(&id) else {
                continue;
            };
            let available: BTreeSet<String> = loaded
                .registrations
                .tools
                .iter()
                .filter(|tool| tool.task_scoped)
                .map(|tool| tool.name.clone())
                .collect();
            if !loaded
                .registrations
                .events
                .iter()
                .any(|event| event == "tool_exposure")
            {
                continue;
            }
            let payload = json!({"thread_id":thread_id,"ledger":ledger,"available":available});
            let result =
                self.invoke_guarded(&id, self.generation, "tool_exposure", "", payload, &active);
            let selection = result.ok().and_then(|value| {
                let object = value.as_object().filter(|object| object.len() == 1)?;
                let names = object.get("enable")?.as_array()?;
                if names.len() > available.len() {
                    return None;
                }
                let selected: Option<BTreeSet<String>> = names
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .filter(|name| available.contains(*name))
                            .map(str::to_owned)
                    })
                    .collect();
                selected.filter(|selected| selected.len() == names.len())
            });
            if let Some(selection) = selection {
                enabled.extend(selection.into_iter().map(|name| (id.clone(), name)));
            } else if self
                .loaded
                .get(&id)
                .is_some_and(|loaded| loaded.error.is_none())
                && let Some(loaded) = self.loaded.get_mut(&id)
            {
                loaded.error = Some(
                    "invalid_tool_exposure: only owned task-scoped tools may be selected".into(),
                );
            }
        }
        self.tools()
            .into_iter()
            .filter(|(id, _, tool)| {
                !tool.task_scoped || enabled.contains(&(id.clone(), tool.name.clone()))
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

    pub fn grants(&self, id: &str) -> Option<ModGrants> {
        self.loaded
            .get(id)
            .filter(|m| m.error.is_none())
            .map(|m| ModGrants {
                api: m.package.api.clone(),
                source_sha256: m.selection.sha256.clone(),
                capabilities: m.package.capabilities.clone(),
                exec_environment: m.package.exec_environment.clone(),
            })
    }

    /// The mod holding the exclusive replacement slot for a decision point.
    pub fn replacement_owner(&self, point: &str) -> Option<String> {
        self.active()
            .find(|(_, m)| m.registrations.replacements.iter().any(|p| p == point))
            .map(|(id, _)| id.clone())
    }

    fn owner(loaded: &Loaded) -> crate::PolicyOwner {
        crate::PolicyOwner {
            id: loaded.package.id.clone(),
            version: loaded.package.version.clone(),
            source: loaded.selection.path.display().to_string(),
            sha256: loaded.selection.sha256.clone(),
        }
    }

    pub fn contract_documents(&self) -> Vec<(crate::ContractDocument, crate::PolicyOwner)> {
        self.active()
            .map(|(_, m)| m)
            .flat_map(|m| {
                m.registrations.contracts.iter().filter_map(|contract| {
                    crate::ContractDocument::parse(contract)
                        .ok()
                        .map(|contract| (contract, Self::owner(m)))
                })
            })
            .collect()
    }

    pub fn builtin_controls(&self) -> Vec<(String, crate::BuiltinControls)> {
        self.active()
            .flat_map(|(id, m)| {
                m.registrations.builtins.iter().filter_map(move |controls| {
                    crate::BuiltinControls::parse(controls)
                        .ok()
                        .map(|controls| (id.clone(), controls))
                })
            })
            .collect()
    }

    pub fn registered(&self, id: &str, event: &str) -> bool {
        self.loaded
            .get(id)
            .is_some_and(|m| m.error.is_none() && m.registrations.events.iter().any(|e| e == event))
    }

    /// Read-only launch identity for `Events.terminal.input.identity`.
    pub fn identity(
        &self,
        codex_version: &str,
        install_profile: Option<&str>,
        mode: &str,
    ) -> Value {
        let install_profile = match install_profile {
            Some(profile @ ("full" | "platform_only" | "private")) => profile,
            Some(_) => "unknown",
            None => "unreported",
        };
        json!({"codex_version": codex_version, "install_profile": install_profile, "mode": mode,
            "mods": {"installed": self.selections.0, "enabled": self.selections.1, "active": self.active().count()}})
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn configuration_sha256(&self) -> &str {
        &self.configuration_sha256
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
            "model_request": {"request_id":"observe_only","scope":"observe_only","routes":"observe_only","original":"observe_only","effective":"alterable","provenance":"observe_only"},
            "response_stream": {"kind":"observe_only","raw_sha256":"observe_only","raw_usage":"observe_only","opaque_reasoning":"observe_only","protected":"observe_only","text":"alterable","original":"observe_only","effective":"observe_only","provenance":"observe_only","fallback":"observe_only"},
            "prompt": {"thread_id":"observe_only","turn_id":"observe_only","original":"observe_only","effective":"replaceable","provenance":"observe_only"},
            "session": {"phase":"observe_only","thread_id":"observe_only","cause":"observe_only"},
            "agent": {"phase":"observe_only","agent_id":"observe_only","parent_agent_id":"observe_only","role":"observe_only","status":"observe_only"},
            "tool_call": {"call_id":"observe_only","agent_id":"observe_only","tool":"observe_only","arguments":"observe_only"},
            "tool_before": {"call_id":"observe_only","thread_id":"observe_only","tool":"replaceable","arguments":"replaceable","deny":"alterable","schema":"observe_only","raw_arguments":"observe_only","batch":"observe_only"},
            "tool_exposure": {"thread_id":"observe_only","ledger":"observe_only","available":"observe_only","enable":"alterable"},
            "tool_result": {"call_id":"observe_only","agent_id":"observe_only","thread_id":"observe_only","tool":"observe_only","outcome":"observe_only","call_sha256":"observe_only","result_sha256":"observe_only","result_complete":"observe_only"},
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
                "sha256": m.selection.sha256, "capabilities": m.package.capabilities, "subscriptions": m.package.subscriptions,
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
