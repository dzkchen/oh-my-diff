mod author;
mod operation_validation;
mod bridge;
mod chain;
mod persisted;
mod render;
pub use chain::ModChain;
pub use chain::ModInterceptor;
pub use chain::SendPolicy;
pub use chain::access_receipt;
pub use chain::compose_rows;
pub use chain::continue_operation;
pub use chain::intercept_shared;
pub use persisted::PERSIST_CHUNK_BYTES;
pub use persisted::PERSIST_WITHHELD;
pub use persisted::PersistedRewrite;
pub use persisted::persist_changed_by;
pub use persisted::persist_chunks;
pub use persisted::persist_cut;
pub use persisted::persist_texts;
pub use render::MOD_RENDER_COMPONENTS;
pub use render::client_component_unmount;
pub use render::component_detach;
pub use render::component_events;
pub use render::component_shared;
pub use render::component_unmount;
pub use render::render_shared;
mod packages;
mod view;
pub use view::MOD_KEY_LIMIT;
pub use view::MOD_TEXT_BYTES;
pub use view::ModActivity;
pub use view::ModAnchor;
pub use view::ModBorder;
pub use view::ModBoxAccent;
pub use view::ModBoxBorder;
pub use view::ModBoxStyle;
pub use view::ModColor;
pub use view::ModCommandAction;
pub use view::ModComponent;
pub use view::ModComponentAction;
pub use view::ModDensity;
pub use view::ModDirection;
pub use view::ModFind;
pub use view::ModIcons;
pub use view::ModKeyAction;
pub use view::ModLayout;
pub use view::ModLayoutLeaf;
pub use view::ModLayoutSplit;
pub use view::ModLayoutTabs;
pub use view::ModListRow;
pub use view::ModOffset;
pub use view::ModOverlay;
pub use view::ModOverlayClip;
pub use view::ModPaint;
pub use view::ModPanel;
pub use view::ModRange;
pub use view::ModRenderSite;
pub use view::ModScreenAnchor;
pub use view::ModSelectOption;
pub use view::ModSidebarSide;
pub use view::ModSiteMode;
pub use view::ModSpacing;
pub use view::ModSpan;
pub use view::ModSplit;
pub use view::ModStyle;
pub use view::ModSurfacePaint;
pub use view::ModTab;
pub use view::ModTheme;
pub use view::ModThemePatch;
pub use view::ModTone;
pub use view::ModView;
pub use view::ModViewConflict;
pub use view::ModViewPatch;
pub use view::ModViewSnapshot;
pub use view::component_ids_of;
pub use view::invalid_render_tree;
pub use view::mod_command_reference;
pub use view::owned_command;
pub use view::mod_component_id;
pub use view::mod_key_name;
pub use view::valid_glyphs;
mod outcome;
pub use outcome::ModCommandOutcome;
mod package_manager;
mod policy;
pub use policy::MANAGED_POLICY_FILE;
pub use policy::MANAGED_POLICY_KEY;
pub use policy::MANAGED_SCOPE;
pub use policy::Managed;
pub use policy::ManagedPolicy;
pub use policy::ManagedTier;
pub use policy::load_managed;
pub use policy::load_managed_from;
pub use policy::managed;
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
use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;

fn profiling() -> bool {
    static PROFILING: OnceLock<bool> = OnceLock::new();
    *PROFILING.get_or_init(|| std::env::var_os("OMD_PROFILE_STARTUP").is_some())
}

/// Records the time since `started` under `name` when `OMD_PROFILE_STARTUP` is set.
pub fn profile(name: &str, started: Instant) {
    if !profiling() {
        return;
    }
    use std::io::Write;
    let line = format!("OMD_PROFILE {name} {}\n", started.elapsed().as_micros());
    if let Some(path) = std::env::var_os("OMD_PROFILE_LOG") {
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = file.write_all(line.as_bytes());
        }
    } else {
        eprint!("{line}");
    }
}

struct Profile(&'static str, Option<Instant>);

impl Profile {
    fn new(name: &'static str) -> Self {
        Self(name, profiling().then(Instant::now))
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        if let Some(started) = self.1 {
            profile(self.0, started);
        }
    }
}

use crate::credentials::url_origin;

pub use package_manager::ModInstallRequest;
pub use package_manager::ModPackageGrant;
pub use package_manager::ModPackageLock;
pub use package_manager::ModPackagePlan;
pub use package_manager::ModPackageSource;
pub use package_manager::ModPackageTrust;
pub use store::ModStore;
pub use store::Trust;

pub const CODEX_HOST_RELEASE: &str = "0.162.1";
pub const OMD_HOST_RELEASE: &str = env!("CARGO_PKG_VERSION");
pub const MOD_API_VERSION: &str = "0.2.0-experimental.5";
pub const MOD_CALLBACK_TOTAL_BUDGET_MS: u64 = 5_000;
pub const MOD_SERVICE_DEPTH_LIMIT: usize = 8;

thread_local! {
    static STATE_THREAD: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Binds `state_scope: "thread"` mod state to a session thread for invocations on this OS thread.
pub struct StateThread(Option<String>);

impl StateThread {
    pub fn enter(thread: Option<String>) -> Self {
        Self(STATE_THREAD.with(|current| current.replace(thread)))
    }
}

impl Drop for StateThread {
    fn drop(&mut self) {
        STATE_THREAD.with(|current| *current.borrow_mut() = self.0.take());
    }
}

fn bound_thread() -> Option<String> {
    STATE_THREAD.with(|current| current.borrow().clone())
}

fn state_thread(payload: &Value) -> Option<String> {
    bound_thread().or_else(|| {
        [
            &payload["thread_id"],
            &payload["ledger"]["thread_id"],
            &payload["scope"]["thread_id"],
        ]
        .into_iter()
        .find_map(|value| value.as_str().map(str::to_owned))
    })
}

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

    fn child(&self) -> InvocationScope {
        InvocationScope {
            stack: RefCell::new(self.stack.borrow().clone()),
            ..InvocationScope::default()
        }
    }

    fn check_execution(&self, elapsed: Duration) -> Result<()> {
        if self.execution.get().saturating_add(elapsed)
            > Duration::from_millis(MOD_CALLBACK_TOTAL_BUDGET_MS)
        {
            return Err(failure("callback_execution_budget"));
        }
        Ok(())
    }

    fn charge_execution(&self, elapsed: Duration) -> Result<()> {
        self.check_execution(elapsed)?;
        self.execution
            .set(self.execution.get().saturating_add(elapsed));
        Ok(())
    }

    fn charge_call(&self) -> Result<()> {
        let calls = self.calls.get();
        if calls >= MAX_HOST_CALLS {
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
pub const MAX_HOST_CALLS: usize = 128;

pub const MOD_PACKAGE_SCHEMA_VERSION: u32 = 1;
pub const MOD_STATE_STORAGE_SCHEMA_VERSION: u32 = 1;
pub const INSTALLED_CONTRACT_TYPES_VERSION: u32 = 1;
pub const MOD_HOST_FEATURES: &[&str] = &[
    "turn_abort_v1",
    "terminal_selection_v1",
    "terminal_copy_v1",
    "environment_overrides_v1",
    "timers_16ms_v1",
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
    "terminal_welcome_v1",
    "terminal_rich_line_v1",
    "terminal_box_model_v1",
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
    "package_imports_v1",
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
    "model_turn_interception_v1",
    "final_request_policy_v1",
    "continuation_middleware_v1",
    "builtins_v1",
    "contracts_v2",
    "framed_process_v1",
    "process_streams_v1",
    "process_raster_v1",
    "raster_pixels_v1",
    "kernels_v1",
    "terminal_lists_v1",
    "adapters_v1",
    "app_v1",
    "app_respond_v1",
    "approval_v1",
    "unrestricted_process_v1",
    "delegated_approval_v1",
    "tool_batch_v1",
    "tool_continuation_v2",
    "events_v1",
    "store_thread_v1",
    "state_scopes_v1",
    "turn_activity_v1",
    "binary_evidence_v1",
    "package_controls_v1",
    "terminal_surface_v1",
    "credentials_v1",
    "completion_v1",
    "tool_feedback_v1",
    "terminal_media_v1",
    "terminal_surface_paint_v1",
    "codex_config_v1",
    "terminal_image_sample_v1",
    "terminal_import_lifetime_v1",
    "secrets_v1",
    "terminal_prompt_v1",
    "model_complete_v2",
    "sdk_helpers_v1",
    "history_v1",
    "history_rewrite_v1",
    "terminal_pty_v1",
    "dynamic_tools_v1",
    "timers_v1",
    "terminal_input_v1",
    "terminal_style_v1",
    "completion_arguments_v1",
    "terminal_editor_v1",
    "pty_programs_v1",
    "route_reload_v1",
    "terminal_tabs_v1",
    "terminal_inline_sites_v1",
    "render_hooks_v1",
    "component_modules_v1",
    "ui_composition_v1",
    "ui_controls_v1",
    "reactive_state_v1",
    "session_ports_v1",
    "structured_access_v1",
    "command_config_middleware_v1",
    "admission_api_policy_v1",
    "agent_lifecycle_v1",
    "peer_sessions_v1",
    "autonomous_turns_v1",
    "provider_billing_v1",
    "compaction_intercept_v1",
    "composer_v2",
    "lifecycle_events_v1",
    "user_submissions_v1",
    "terminal_raster_v1",
    "svg_assets_v1",
    "history_persist_v1",
    "model_cache_v1",
    "composer_key_v1",
    "completion_tokens_v1",
    "mention_read_v1",
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
    "contract.select",
    "agents.spawn",
    "agents.message",
    "agents.cancel",
    "agents.result",
    "agents.wait",
    "agents.list",
    "agents.inventory",
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
    "app.respond",
    "app.routes",
    "workspace.watch",
    "workspace.unwatch",
    "events.publish",
    "credentials.list",
    "credentials.request",
    "routes.select",
    "turns.activity",
    "turns.abort",
    "terminal.notify",
    "terminal.show_thread",
    "commands.list",
    "commands.describe",
    "commands.invoke",
    "config.describe",
    "config.set",
    "sessions.ports",
    "terminal.import_file",
    "terminal.image_sample",
    "composer.read",
    "composer.write",
    "composer.suggest",
    "prompts.consent",
    "prompts.submit",
    "prompts.status",
    "prompts.revoke",
    "builtins.invoke",
    "packages.list",
    "packages.index",
    "packages.preview",
    "packages.apply",
    "packages.reload",
    "settings.write",
    "terminal.open",
    "terminal.prompt",
    "terminal.pane",
    "terminal.panes",
    "terminal.notice",
    "terminal.selection",
    "terminal.copy",
    "terminal.blit",
    "terminal.pty",
    "model.complete",
    "model.fork",
    "session.info",
    "ledger.settle",
    "time.sleep",
    "tools.list",
    "tools.define",
    "tools.invoke",
    "tools.check",
    "tools.undefine",
    "events.schedule",
    "events.cancel",
    "http.request",
    "http.open",
    "http.read",
    "http.close",
    "mcp.connect",
    "mcp.disconnect",
    "environment.read",
    "environment.set",
    "peers.list",
    "peers.send",
    "turns.queue",
    "turns.queued",
    "turns.dequeue",
];
pub const SUPPORTED_MOD_APIS: &[(&str, &str, &str)] =
    &[(MOD_API_VERSION, "experimental", "2027-03-20")];
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
    "unix_sockets",
    "model",
    "agents",
    "store",
    "sessions",
    "sessions_tools",
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
    "os",
    "approve",
    "approve.override",
    "http",
    "fs.external",
    "mcp",
    "policy",
    "request_policy",
    "peers",
    "autonomous",
    "history_write",
    "history_persist",
];
pub const AUTHORITY_CAPABILITIES: &[&str] = &[
    "os",
    "approve",
    "approve.override",
    "http",
    "fs.external",
    "mcp",
    "policy",
    "peers",
    "autonomous",
    "history_write",
    "history_persist",
];

/// What a user accepts by granting the authority capabilities, shown before trust and in status.
pub fn authority_exposure(capabilities: &[String]) -> Vec<&'static str> {
    let granted = |name: &str| capabilities.iter().any(|c| c == name);
    let mut exposure = Vec::new();
    if granted("os") {
        exposure.push("os: listed programs run unsandboxed as your account; they can read every file your account can read (including secret files such as ~/.ssh, ~/.codex/auth.json and browser profiles), change mod stores and control files, use the network as os_access allows and start processes OMD does not supervise. OMD sanitizes their environment and supervises, cancels and limits the processes it starts, but cannot undo their side effects. Only the OS-separated broker protects grants, credentials and evidence anchors from them.");
    }
    if granted("approve") {
        exposure.push("approve: this mod may approve exec, patch, MCP and network requests inside its approves scope without asking you; managed-policy and host denials still apply and any error asks you.");
    }
    if granted("approve.override") {
        exposure.push("approve.override: this mod may also approve commands your own execpolicy rules forbid.");
    }
    if granted("http") {
        exposure.push("http: this mod may send requests, including non-loopback ones, to the origins in http_access and have OMD attach the listed credential profiles, and with `owned` every secret this mod enrolls now or later, to requests for their enrolled origin; it never sees the tokens.");
    }
    if granted("fs.external") {
        exposure.push("fs.external: this mod may read, list and stat, and where write is set change, files under the fs_access roots outside the workspace; credential locations and protected paths stay refused.");
    }
    if granted("mcp") {
        exposure.push("mcp: this mod may connect the MCP servers in mcp_servers to its thread; command servers run as your account outside the sandbox like any configured MCP server, a URL server's credential profile (another mod's secret is refused) is sent to that origin, and their tools go through normal tool approvals.");
    }
    if granted("policy") {
        exposure.push("policy: this mod may refuse other mods at load and withhold the host namespaces listed in policy.namespaces from them; it cannot grant anything, change managed policy or judge itself, and disabling it in /omd restores the other mods.");
    }
    if granted("peers") {
        exposure.push("peers: this mod may discover and message instances of mods in your other OMD sessions on this mod store (in other repositories only when peer_access.projects is \"any\" on both sides) and receive their messages as untrusted data; delivery never starts a turn or shares authority, and messages are countersigned by the authority broker, so peers work only while it is deployed.");
    }
    if granted("autonomous") {
        exposure.push("autonomous: this mod may queue prompts that start turns while you are idle and continue a finished turn, within its autonomy limits; queued turns are labelled with the mod, keep your permissions and route, pause when you interrupt, and stop when you disable or revoke the mod.");
    }
    if granted("middleware") {
        exposure.push("middleware: this mod sees and may change prompts, tool calls and results, model requests and response streams, and through host_operation interceptors the arguments and results of other mods' host operations, including store, environment, credential, http and exec calls; its host_operation events hide the arguments and results of store, environment, credential, http, exec, sessions and evidence calls, and sessions and evidence calls are never intercepted.");
    }
    if granted("request_policy") {
        exposure.push("request_policy: every model request must pass this mod's final-request check; whenever the mod is not loaded, faults or fails to serve, OMD refuses every model request until it serves again or the mod is disabled. While it is enabled, realtime, image generation, web search and memory summarization are refused.");
    }
    if granted("history_write") {
        exposure.push("history_write: this mod may durably insert, edit, reorder and delete messages and tool rows in this session's transcript and in sessions it started, which changes what resume, search and export show and what the model sees next; replaced transcripts are kept and undo restores them, and rewritten rows are marked and never count as proof that a tool ran.");
    }
    if granted("history_persist") {
        exposure.push("history_persist: this mod sees every text OMD stores for your sessions (prompts, instructions, replies, reasoning, tool arguments and results, command output, file changes and prompt recall) and may replace any of it before it is written, which changes what resume, fork, search and export show and what the model sees next; the live session keeps the original, and rewritten rows are marked.");
    }
    exposure
}

/// The bounded install-profile label reported for an `OMD_INSTALL_PROFILE` value.
pub fn install_profile(value: &str) -> &'static str {
    match value {
        "full" => "full",
        "platform_only" => "platform_only",
        "private" => "private",
        _ => "unknown",
    }
}
pub const MOD_EVENTS: &[(&str, &str)] = &[
    ("context", "context"),
    ("migrate", "store"),
    ("tool_exposure", "tools"),
    ("routing", "model"),
    ("terminal", "terminal"),
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
    ("model_response", "model"),
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
    ("process_event", "exec"),
    ("channel", "events"),
    ("timer", "events"),
    ("component_event", "terminal"),
    ("component_post", "terminal"),
    ("view", "terminal"),
    ("focus", "terminal"),
    ("completion", "composer"),
    ("history", "history"),
    ("config_change", "config"),
    ("peer_message", "peers"),
    ("peer_receipt", "peers"),
    ("turn_queue", "autonomous"),
    ("tool_batch_end", "lifecycle"),
    ("instructions_loaded", "lifecycle"),
    ("thread_settings", "lifecycle"),
    ("worktree", "lifecycle"),
    ("elicitation_result", "approvals"),
    ("composer", "composer"),
    ("prompt_expanded", "middleware"),
];
pub const MOD_REPLACEMENT_POINTS: &[&str] = &[
    "routing",
    "compaction",
    "context",
    "tool_batch",
    "completion",
    "history",
];
pub const MOD_INTERCEPT_SURFACES: &[(&str, &str)] = &[
    ("tool", "interception"),
    ("host_operation", "middleware"),
    ("model_request", "middleware"),
    ("response_stream", "middleware"),
    ("model_send", "middleware"),
    ("input", "input"),
    ("tool_specs", "tools"),
    ("command_list", "commands"),
    ("command", "commands"),
    ("config_list", "config"),
    ("config_set", "config.write"),
    ("admission", "policy"),
    ("render", "terminal"),
    ("agent_offers", "agents"),
    ("agent_spawn", "agents"),
    ("peer_send", "peers"),
    ("peer_receive", "peers"),
    ("turn_stop", "autonomous"),
    ("compaction", "compaction"),
    ("history_persist", "history_persist"),
    ("elicitation", "approvals"),
    ("composer_edit", "composer"),
    ("composer_key", "composer"),
    ("component_change", "terminal"),
    ("mention", "input"),
];
pub const MOD_MIDDLEWARE_EVENTS: &[&str] = &[
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

pub(crate) fn digest(bytes: &[u8]) -> String {
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

/// Non-mod `origin.caller` labels, which a mod ID must never equal.
const HOST_CALLERS: [&str; 4] = ["model", "engine", "code_mode", "user"];

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
            let required = ModHostCall {
                operation: operation.clone(),
                arguments: Value::Null,
            }
            .capabilities()?;
            if operation == "model.fork"
                && required.iter().any(|capability| !package.capabilities.iter().any(|declared| declared.as_str() == *capability)) {
                return Err(failure(format!("undeclared_operation_use: {operation}")));
            }
            let mut used = package
                .capabilities
                .iter()
                .filter(|declared| required.contains(&declared.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            let declared = |name: &str| package.capabilities.iter().any(|cap| cap == name);
            if !used.is_empty()
                && matches!(
                    operation.as_str(),
                    "exec.run" | "process.start" | "terminal.pty"
                )
                && visible.contains("network:")
                && declared("network")
            {
                used.push("network".to_owned());
            }
            if !used.is_empty()
                && matches!(
                    operation.as_str(),
                    "exec.run" | "process.start" | "terminal.pty"
                )
                && visible.contains("sandbox:")
                && declared("os")
            {
                used.push("os".to_owned());
            }
            if !used.is_empty()
                && operation == "exec.run"
                && visible.contains("unix_sockets")
                && declared("unix_sockets")
            {
                used.push("unix_sockets".to_owned());
            }
            if (!used.is_empty() || operation == "workspace.check_access")
                && matches!(
                    operation.as_str(),
                    "exec.run" | "terminal.pty" | "workspace.check_access"
                )
                && visible.contains("write:")
                && declared("fs.write")
            {
                used.push("fs.write".to_owned());
            }
            if !used.is_empty()
                && matches!(operation.as_str(), "sessions.read" | "sessions.snapshot")
                && declared("sessions_tools")
            {
                used.push("sessions_tools".to_owned());
            }
            used
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
    if registrations.events.iter().any(|event| event == "approval") {
        capabilities.extend(
            ["approve", "approve.override"]
                .into_iter()
                .filter(|name| package.capabilities.iter().any(|cap| cap == name))
                .map(str::to_owned),
        );
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
    if !registrations.completions.is_empty() {
        capabilities.insert("composer".to_owned());
    }
    for interceptor in &registrations.interceptors {
        capabilities.extend(
            MOD_INTERCEPT_SURFACES
                .iter()
                .filter(|(surface, _)| {
                    chain::selects(&interceptor.pattern, surface, &package.capabilities)
                })
                .map(|(_, capability)| (*capability).to_owned()),
        );
        if interceptor.required
            && chain::selects(&interceptor.pattern, "model_send", &package.capabilities)
        {
            capabilities.insert("request_policy".to_owned());
        }
    }
    if [".state.get", ".state.set", ".atom", ".member"]
        .iter()
        .any(|call| source.contains(&format!("{call}(")) || source.contains(&format!("{call}<")))
    {
        capabilities.insert("store".to_owned());
    }
    // SDK helpers call host operations on the mod's behalf.
    for (call, capability) in [
        (".time.", "events"),
        (".session(", "inventory"),
        (".fs.", "fs.read"),
        (".classify(", "agents"),
        (".classify<", "agents"),
        (".rateLimits(", "account"),
        ("parent_history", "sessions"),
        ("parent_history", "sessions_tools"),
    ] {
        if source.contains(call) {
            capabilities.insert(capability.to_owned());
        }
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
    #[serde(
        default = "default_state_scope",
        skip_serializing_if = "is_store_scope"
    )]
    pub state_scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_access: Option<ModOsAccess>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approves: Option<ModApprovalScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_access: Option<ModHttpAccess>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fs_access: Option<ModFsAccess>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mcp_servers: BTreeMap<String, ModMcpServer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<ModPolicyScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer_access: Option<ModPeerAccess>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autonomy: Option<ModAutonomy>,
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
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub codex_config: BTreeMap<String, Value>,
}

pub const CODEX_CONFIG_UPDATE_PLAN: &str = "tools.update_plan.enabled";
const CODEX_CONFIG_KEYS: &[&str] = &[CODEX_CONFIG_UPDATE_PLAN];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModOsAccess {
    pub programs: Vec<String>,
    #[serde(default)]
    pub network: bool,
}

impl ModOsAccess {
    pub fn allows(&self, program: &str, resolved: &Path) -> bool {
        self.programs.iter().any(|allowed| {
            allowed == "*"
                || allowed == program && !program.contains('/')
                || Path::new(allowed) == resolved
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModApprovalScope {
    pub kinds: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roots: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hosts: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModHttpAccess {
    pub origins: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub credentials: Vec<String>,
}

impl ModHttpAccess {
    /// `origin` is `scheme://host[:port]`; a granted `scheme://*.suffix[:port]` covers subdomains.
    pub fn allows(&self, origin: &str) -> bool {
        self.origins.iter().any(|allowed| {
            allowed == origin
                || allowed.split_once("://*.").is_some_and(|(scheme, suffix)| {
                    origin
                        .strip_prefix(scheme)
                        .and_then(|rest| rest.strip_prefix("://"))
                        .is_some_and(|host| {
                            host.len() > suffix.len() + 1
                                && host.ends_with(suffix)
                                && host.as_bytes()[host.len() - suffix.len() - 1] == b'.'
                        })
                })
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModFsAccess {
    pub roots: Vec<ModFsRoot>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModFsRoot {
    pub path: String,
    #[serde(default)]
    pub write: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModMcpServer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModPolicyScope {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub namespaces: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModPeerAccess {
    pub projects: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModAutonomy {
    pub max_queued: u32,
    pub max_turns: u32,
    #[serde(default)]
    pub max_continuations: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spend_microusd: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModAgent {
    pub name: String,
    pub description: String,
    pub instructions: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub offer: bool,
}

/// A registered agent definition with the package source that registered it.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ModAgentDefinition {
    pub owner: String,
    pub source_sha256: String,
    #[serde(flatten)]
    pub agent: ModAgent,
}

/// The policy namespace of a host call: `service:<provider>/<method>` for service calls, else the operation's prefix.
pub fn host_namespace(operation: &str, arguments: &Value) -> String {
    match operation {
        "mods.service" => format!(
            "service:{}/{}",
            arguments["name"].as_str().unwrap_or_default(),
            arguments["method"].as_str().unwrap_or_default()
        ),
        _ => operation
            .split_once('.')
            .map_or(operation, |(namespace, _)| namespace)
            .to_owned(),
    }
}

/// `*` matches any run of characters in a namespace pattern.
pub fn namespace_matches(pattern: &str, namespace: &str) -> bool {
    match pattern.split_once('*') {
        None => pattern == namespace,
        Some((prefix, rest)) => {
            namespace.starts_with(prefix)
                && (0..=namespace.len() - prefix.len()).any(|skip| {
                    namespace
                        .get(prefix.len() + skip..)
                        .is_some_and(|tail| namespace_matches(rest, tail))
                })
        }
    }
}

pub const DELEGABLE_APPROVAL_KINDS: &[&str] =
    &["exec", "stdin", "execve", "patch", "mcp_tool", "network"];

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

fn default_state_scope() -> String {
    "store".to_owned()
}

fn is_store_scope(scope: &str) -> bool {
    scope == "store"
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
            || HOST_CALLERS.contains(&self.id.as_str())
            || self.version.is_empty()
            || self.version.len() > 64
            || self.state_version == 0
            || !matches!(self.state_scope.as_str(), "store" | "thread" | "checkout")
            || !version(&self.version)
            || !(25..=2000).contains(&self.hook_budget_ms)
            || !package_file(&self.entrypoint)
        {
            return Err(failure(
                "incompatible_package: valid identity/version, supported API, positive state_version and state_scope store, thread or checkout required",
            ));
        }
        if self.description.as_deref().is_some_and(|text| {
            text.is_empty() || text.chars().count() > 160 || text.chars().any(char::is_control)
        }) {
            return Err(failure("invalid_description: 1-160 printable characters"));
        }
        if !self.codex_config.is_empty()
            && (!self
                .compatibility
                .required_features
                .iter()
                .any(|feature| feature == "codex_config_v1")
                || self.codex_config.iter().any(|(key, value)| {
                    !CODEX_CONFIG_KEYS.contains(&key.as_str()) || *value != Value::Bool(true)
                }))
        {
            return Err(failure(
                "invalid_codex_config: keys from the host allowlist set to true, with codex_config_v1 required",
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
        let declared = |name: &str| self.capabilities.iter().any(|c| c == name);
        let entries = |values: &[String], valid: &dyn Fn(&str) -> bool| {
            values.len() <= 32
                && values.iter().collect::<BTreeSet<_>>().len() == values.len()
                && values
                    .iter()
                    .all(|value| !value.is_empty() && value.len() <= 256 && valid(value))
        };
        let absolute = |value: &str| {
            let path = Path::new(value);
            path.is_absolute()
                && path
                    .components()
                    .all(|part| !matches!(part, std::path::Component::ParentDir))
        };
        if declared("os") != self.os_access.is_some()
            || declared("os") && !declared("exec")
            || self.os_access.as_ref().is_some_and(|access| {
                access.programs.is_empty()
                    || !entries(&access.programs, &|program| {
                        program == "*"
                            || absolute(program)
                            || !program.contains('/') && !program.contains('\0')
                    })
            })
        {
            return Err(failure(
                "invalid_os_access: the os capability needs exec and os_access.programs (*, names or absolute paths)",
            ));
        }
        if declared("approve") != self.approves.is_some()
            || declared("approve") && !(declared("approvals") && declared("middleware"))
            || declared("approve.override") && !declared("approve")
            || self.approves.as_ref().is_some_and(|scope| {
                scope.kinds.is_empty()
                    || !entries(&scope.kinds, &|kind| {
                        DELEGABLE_APPROVAL_KINDS.contains(&kind)
                    })
                    || !entries(&scope.tools, &|_| true)
                    || !entries(&scope.roots, &|root| root == "*" || absolute(root))
                    || !entries(&scope.hosts, &|host| !host.contains('/'))
            })
        {
            return Err(failure(
                "invalid_approves: the approve capability needs approvals, middleware and approves.kinds from exec, stdin, execve, patch, mcp_tool, network",
            ));
        }
        let origin = |value: &str| {
            let concrete = value.replacen("://*.", "://", 1);
            url_origin(&concrete).as_deref() == Some(concrete.as_str())
        };
        if declared("http") != self.http_access.is_some()
            || self.http_access.as_ref().is_some_and(|access| {
                access.origins.is_empty()
                    || !entries(&access.origins, &origin)
                    || !entries(&access.credentials, &|id| identifier(id))
            })
        {
            return Err(failure(
                "invalid_http_access: the http capability needs http_access.origins (scheme://host[:port], scheme://*.suffix) and credential profile IDs",
            ));
        }
        if declared("fs.external") != self.fs_access.is_some()
            || declared("fs.external") && !declared("fs.read")
            || self.fs_access.as_ref().is_some_and(|access| {
                access.roots.is_empty()
                    || access.roots.len() > 16
                    || access.roots.iter().any(|root| {
                        root.path.len() > 256
                            || !absolute(&root.path)
                            || root.path == "/"
                            || root.write && !declared("fs.write")
                    })
            })
        {
            return Err(failure(
                "invalid_fs_access: the fs.external capability needs fs.read and up to 16 absolute fs_access.roots (write needs fs.write)",
            ));
        }
        if declared("mcp") == self.mcp_servers.is_empty()
            || self.mcp_servers.len() > 8
            || self.mcp_servers.iter().any(|(name, server)| {
                !identifier(name)
                    || name.len() > 32
                    || match (&server.command, &server.url) {
                        (Some(command), None) => {
                            command.is_empty()
                                || command.contains('\0')
                                || server.credential.is_some()
                                || server.args.len() > 32
                                || server
                                    .args
                                    .iter()
                                    .any(|arg| arg.len() > 1024 || arg.contains('\0'))
                        }
                        (None, Some(url)) => {
                            url_origin(url).is_none()
                                || !server.args.is_empty()
                                || server
                                    .credential
                                    .as_deref()
                                    .is_some_and(|id| !identifier(id))
                        }
                        _ => true,
                    }
            })
        {
            return Err(failure(
                "invalid_mcp_servers: the mcp capability needs up to 8 mcp_servers, each a command (with args) or an http(s) url (with an optional credential)",
            ));
        }
        if declared("policy") != self.policy.is_some()
            || self.policy.as_ref().is_some_and(|scope| {
                scope.namespaces.len() > 16
                    || !entries(&scope.namespaces, &|pattern| {
                        pattern.len() <= 64
                            && pattern.bytes().all(|byte| {
                                byte.is_ascii_lowercase()
                                    || byte.is_ascii_digit()
                                    || matches!(byte, b'_' | b'.' | b':' | b'/' | b'*')
                            })
                    })
            })
        {
            return Err(failure(
                "invalid_policy: the policy capability needs policy.namespaces (up to 16 namespace patterns)",
            ));
        }
        if declared("peers") != self.peer_access.is_some()
            || self
                .peer_access
                .as_ref()
                .is_some_and(|scope| !["same", "any"].contains(&scope.projects.as_str()))
        {
            return Err(failure(
                "invalid_peer_access: the peers capability needs peer_access.projects (\"same\" or \"any\")",
            ));
        }
        if declared("autonomous") != self.autonomy.is_some()
            || self.autonomy.as_ref().is_some_and(|scope| {
                !(1..=16).contains(&scope.max_queued)
                    || !(1..=100).contains(&scope.max_turns)
                    || scope.max_continuations > 4
            })
        {
            return Err(failure(
                "invalid_autonomy: the autonomous capability needs autonomy.max_queued (1-16), max_turns (1-100) and optional max_continuations (0-4) and spend_microusd",
            ));
        }
        if declared("request_policy") && !declared("middleware") {
            return Err(failure(
                "invalid_request_policy: the request_policy capability needs middleware",
            ));
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
        let assets: BTreeSet<_> = self.assets.iter().collect();
        if self.assets.len() > 16
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

/// Explicit settings over the schema's `default` values.
pub fn effective_settings(
    schema: Option<&Value>,
    settings: &BTreeMap<String, Value>,
) -> BTreeMap<String, Value> {
    let mut effective: BTreeMap<String, Value> = schema
        .and_then(|schema| schema["properties"].as_object())
        .into_iter()
        .flatten()
        .filter_map(|(name, definition)| Some((name.clone(), definition.get("default")?.clone())))
        .collect();
    effective.extend(settings.clone());
    effective
}

/// Merges `values` into a mod's stored settings (`null` removes one) and saves them schema-checked.
pub fn write_settings(store: &ModStore, id: &str, values: &Value) -> Result<Value> {
    let values = values
        .as_object()
        .ok_or_else(|| failure("settings_values_must_be_object"))?;
    let path = store.selection_status()?["selections"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|selection| selection["id"] == id && selection["effective"] == true)
        .and_then(|selection| selection["path"].as_str().map(PathBuf::from))
        .ok_or_else(|| failure(format!("mod_not_enabled: {id}")))?;
    let settings = store.merge_settings(&path, values)?;
    let (package, _, _) = store::package(&path)?;
    Ok(json!({"settings": effective_settings(package.settings_schema.as_ref(), &settings)}))
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
        if required.as_str().is_none_or(|name| {
            !settings.contains_key(name)
                && properties
                    .get(name)
                    .and_then(|property| property.get("default"))
                    .is_none()
        }) {
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secret_environment: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<ManagedTier>,
}

impl ModSelection {
    pub fn authority_current(&self) -> bool {
        self.expires_at.is_none_or(|expires| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .is_ok_and(|now| now.as_secs() < expires)
        })
    }
}

impl ModPackage {
    pub fn secret_environment(&self) -> Vec<String> {
        self.exec_environment
            .iter()
            .filter(|name| crate::host::secret_like(name))
            .cloned()
            .collect()
    }
}

/// Refuses secret-like `exec_environment` names the user did not trust by name.
pub(crate) fn check_secret_environment(package: &ModPackage, trusted: &[String]) -> Result<()> {
    match package
        .secret_environment()
        .into_iter()
        .find(|name| !trusted.contains(name))
    {
        Some(name) => Err(failure(format!(
            "secret_environment_requires_explicit_trust: {} {name}",
            package.id
        ))),
        None => Ok(()),
    }
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

impl ModConfiguration {
    pub fn parse(bytes: &[u8], path: &Path) -> Result<Self> {
        let mut config: Self = serde_json::from_slice(bytes)
            .map_err(|error| failure(format!("invalid {}: {error}", path.display())))?;
        if !config.node.is_file() {
            config.node = node_on_path().ok_or_else(|| {
                failure(format!(
                    "node_unavailable: {} is missing and no node is on PATH",
                    config.node.display()
                ))
            })?;
        }
        Ok(config)
    }
}

/// Active and failed mod counts from a host status: failed covers erroring and rejected mods.
pub fn mod_counts(status: &Value) -> (usize, usize) {
    let mods = status["mods"].as_array().map_or(&[][..], Vec::as_slice);
    let failed = mods.iter().filter(|item| !item["error"].is_null()).count();
    let rejected = status["rejected"].as_array().map_or(0, Vec::len);
    (mods.len() - failed, failed + rejected)
}

pub fn activation_failures(status: &Value) -> Vec<String> {
    let mods = status["mods"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            Some(format!(
                "{}: {}",
                item["id"].as_str().unwrap_or("mod"),
                item["error"].as_str()?
            ))
        });
    let rejected = status["rejected"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            format!(
                "{}: {}",
                item["id"]
                    .as_str()
                    .or_else(|| item["path"].as_str())
                    .unwrap_or("mod"),
                item["reason"].as_str().unwrap_or("rejected")
            )
        });
    status["activation_error"]
        .as_str()
        .map(str::to_owned)
        .into_iter()
        .chain(mods)
        .chain(rejected)
        .collect()
}

/// The first real `node` executable on PATH; version-manager shims resolve to other programs.
pub fn node_on_path() -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .filter_map(|directory| directory.join("node").canonicalize().ok())
        .find(|node| node.file_name() == Some("node".as_ref()) && node.is_file())
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub immediate: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModTerminalView {
    pub view: ModView,
    #[serde(default)]
    pub contributors: Vec<String>,
    #[serde(default)]
    pub component_owners: BTreeMap<String, String>,
    #[serde(default)]
    pub conflicts: Vec<ModViewConflict>,
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
    #[serde(default)]
    interceptors: Vec<ModInterceptor>,
    #[serde(default)]
    agents: Vec<ModAgent>,
    #[serde(default)]
    modules: Vec<String>,
    #[serde(default)]
    components: Vec<String>,
    #[serde(default)]
    completions: Vec<ModCompletion>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct ModCompletion {
    trigger: String,
}

/// One ASCII punctuation character that the native `@`, `/` and `$` completions don't own.
fn completion_trigger(trigger: &str) -> bool {
    matches!(trigger.as_bytes(), [byte] if byte.is_ascii_punctuation() && !b"@/$".contains(byte))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    registrations: Registrations,
    state: Value,
    #[serde(default)]
    ui_state: Option<String>,
    #[serde(default)]
    ui_read: bool,
    #[serde(default)]
    ui_written: bool,
    #[serde(default)]
    clock_read: bool,
    value: Value,
    #[serde(default)]
    calls: Vec<ModHostCall>,
    #[serde(default)]
    host_call: Option<ModHostCall>,
    #[serde(default)]
    updates: Vec<String>,
    #[serde(skip)]
    receipts: Vec<Value>,
}

#[derive(Clone)]
struct AcceptedCommandView {
    value: Value,
    stamp: String,
    parsed: Option<Arc<ModViewPatch>>,
}

#[derive(Clone)]
struct Loaded {
    package: ModPackage,
    selection: ModSelection,
    source: Arc<str>,
    assets: Arc<BTreeMap<String, Value>>,
    request_metadata: Arc<OnceLock<(Value, String)>>,
    adapter: Option<Value>,
    state: Value,
    ui: Option<(String, Arc<Mutex<UiState>>)>,
    ui_state: Value,
    ui_revision: u64,
    ui_clears: u64,
    command_view: Option<AcceptedCommandView>,
    registrations: Registrations,
    source_use: ModSourceUse,
    unused_grants: Vec<String>,
    unused_environment: Vec<String>,
    withheld: Vec<String>,
    error: Option<String>,
    telemetry: ModTelemetry,
}

#[derive(Default)]
struct UiState {
    value: Value,
    revision: u64,
    clears: u64,
}

static UI_STATES: Mutex<BTreeMap<String, std::sync::Weak<Mutex<UiState>>>> =
    Mutex::new(BTreeMap::new());
static UI_RESETS: Mutex<BTreeMap<PathBuf, u64>> = Mutex::new(BTreeMap::new());

/// Clears a store's UI states once per explicit reload, whether this process made it or a host
/// noticed another process's.
fn reset_ui_states(root: &Path, revision: u64) {
    if UI_RESETS.lock().map_or(true, |mut resets| {
        resets.insert(root.to_path_buf(), revision) == Some(revision)
    }) {
        return;
    }
    let prefix = format!("{}:", root.display());
    if let Ok(states) = UI_STATES.lock() {
        for (_, weak) in states.iter().filter(|(key, _)| key.starts_with(&prefix)) {
            if let Some(state) = weak.upgrade()
                && let Ok(mut state) = state.lock()
            {
                state.value = Value::Null;
                state.revision = state.revision.wrapping_add(1);
                state.clears = state.clears.wrapping_add(1);
            }
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
struct ModTelemetry {
    invocations: u64,
    total_micros: u128,
    last_micros: u128,
    faults: u32,
    last_error: Option<String>,
    logs: Vec<Value>,
}

const MOD_FAULT_LIMIT: u32 = 5;
const BROKER_REFRESH: Duration = Duration::from_secs(2);

pub type FileStamp = (u64, u64, u64, i64, i64, i64, i64);

pub fn file_stamp(metadata: &std::fs::Metadata) -> FileStamp {
    use std::os::unix::fs::MetadataExt;
    (
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec(),
    )
}

fn configuration_stamp(path: &Path) -> Option<FileStamp> {
    std::fs::symlink_metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| file_stamp(&metadata))
}

/// The returned stamp is `None` if the file changed during the read.
fn read_configuration(
    path: &Path,
    stamp: Option<FileStamp>,
) -> (Option<FileStamp>, String, Result<Vec<u8>>) {
    let bytes = store::read(path, 65_536);
    let sha256 = digest(bytes.as_deref().unwrap_or_default());
    (
        stamp.filter(|_| configuration_stamp(path) == stamp),
        sha256,
        bytes,
    )
}

type Brokered = Option<(u64, BTreeSet<String>)>;

#[cfg(test)]
mod reload_tests {
    use super::*;

    #[test]
    fn raw_frame_authority_poll_skips_reads_but_detects_rewrites_and_refreshes_policy() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("store");
        ModStore::create(
            root.clone(),
            std::env::var_os("OMD_TEST_NODE").unwrap().into(),
        )
        .unwrap();
        let mut host = ModHost::open(root.clone()).unwrap();
        let reads = store::READS.get();
        for _ in 0..100 {
            assert!(!host.refresh_authority().unwrap());
        }
        assert_eq!(store::READS.get(), reads);
        host.brokered.as_mut().unwrap().0 -= BROKER_REFRESH;
        assert!(!host.refresh_authority().unwrap());
        assert!(store::READS.get() > reads);
        let path = root.join("mods.json");
        let original = std::fs::read(&path).unwrap();
        std::fs::write(&path, b"invalid").unwrap();
        assert!(host.refresh_authority().is_err());
        assert!(host.refresh_authority().is_err());
        std::fs::write(&path, original).unwrap();
        assert!(!host.refresh_authority().unwrap());
        let moved = root.join("moved.json");
        std::fs::rename(&path, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &path).unwrap();
        assert!(host.refresh_authority().is_err());
    }
}
type Authority = (
    Brokered,
    Option<Managed>,
    std::result::Result<policy::ManagedDeployment, String>,
);

impl Loaded {
    fn clear_ui(&mut self) {
        self.command_view = None;
        if let Some((_, state)) = self.ui.take()
            && let Ok(mut state) = state.lock()
        {
            state.value = Value::Null;
            state.revision = state.revision.wrapping_add(1);
            state.clears = state.clears.wrapping_add(1);
        }
    }

    fn fault(&mut self, error: String) {
        self.telemetry.faults = self.telemetry.faults.saturating_add(1);
        if self.telemetry.faults >= MOD_FAULT_LIMIT && self.error.is_none() {
            self.error = Some(error.clone());
            self.clear_ui();
        }
        self.telemetry.last_error = Some(error);
    }
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

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModGrants {
    pub surface_authority: crate::client_surface::Authority,
    pub api: String,
    pub source_sha256: String,
    pub capabilities: Vec<String>,
    pub exec_environment: Vec<String>,
    pub os_access: Option<ModOsAccess>,
    pub approves: Option<ModApprovalScope>,
    pub http_access: Option<ModHttpAccess>,
    pub fs_access: Option<ModFsAccess>,
    pub mcp_servers: BTreeMap<String, ModMcpServer>,
    pub peer_access: Option<ModPeerAccess>,
    pub autonomy: Option<ModAutonomy>,
}

pub struct ModHost {
    store: ModStore,
    node: PathBuf,
    generation: u64,
    configuration_sha256: String,
    configuration_stamp: Option<FileStamp>,
    ui_configuration: Option<(u64, String)>,
    selections: (usize, usize),
    loaded: BTreeMap<String, Loaded>,
    order: Vec<String>,
    rejected: Vec<ModRejection>,
    reload_error: Option<String>,
    service_calls: Vec<Value>,
    tool_validator: fn(&Value) -> Result<()>,
    virtual_time_ms: Option<u64>,
    tier_selections: BTreeMap<String, ModSelection>,
    dynamic_tools: BTreeMap<String, Vec<ModTool>>,
    checkout: Option<PathBuf>,
    valid_views: BTreeMap<String, Value>,
    renders: BTreeMap<String, (String, Value, Option<Instant>)>,
    clock_reads: BTreeSet<String>,
    rendered: HashMap<String, render::Rendered>,
    chains: Vec<Value>,
    access: Vec<Value>,
    admissions: BTreeMap<String, std::result::Result<Vec<String>, String>>,
    brokered: Option<(Instant, String, Authority)>,
    callback_configuration: Mutex<Option<(FileStamp, String, Arc<ModConfiguration>)>>,
    required_surfaces: Arc<Mutex<Vec<&'static str>>>,
    intercepted_surfaces: Arc<Mutex<Vec<&'static str>>>,
    codex_config: Arc<Mutex<BTreeSet<String>>>,
    environment: Arc<crate::host::Environment>,
    policies: Vec<PathBuf>,
    managed: Option<Managed>,
    unserved: Vec<(String, Vec<String>, String)>,
    project: Option<PathBuf>,
    pool: u64,
}

impl Drop for ModHost {
    fn drop(&mut self) {
        process::size_reused_pool(self.pool, None);
    }
}

enum Access<'a> {
    Held(&'a mut ModHost),
    Shared(&'a Mutex<ModHost>),
    Bounded(&'a Mutex<ModHost>, Duration),
}

impl Access<'_> {
    fn with<T>(&mut self, run: impl FnOnce(&mut ModHost) -> Result<T>) -> Result<T> {
        match self {
            Access::Held(runtime) => run(runtime),
            Access::Shared(runtime) => run(&mut *runtime
                .lock()
                .map_err(|_| failure("mod_runtime_poisoned"))?),
            Access::Bounded(runtime, wait) => {
                let deadline = Instant::now() + *wait;
                loop {
                    match runtime.try_lock() {
                        Ok(mut runtime) => return run(&mut runtime),
                        Err(std::sync::TryLockError::Poisoned(_)) => {
                            return Err(failure("mod_runtime_poisoned"));
                        }
                        Err(std::sync::TryLockError::WouldBlock) if Instant::now() < deadline => {
                            std::thread::sleep(Duration::from_millis(2));
                        }
                        Err(std::sync::TryLockError::WouldBlock) => {
                            return Err(failure("mod_runtime_busy"));
                        }
                    }
                }
            }
        }
    }

    fn bounded(&mut self, wait: Duration) -> Access<'_> {
        match self {
            Access::Held(runtime) => Access::Held(runtime),
            Access::Shared(runtime) | Access::Bounded(runtime, _) => Access::Bounded(runtime, wait),
        }
    }
}

type NextFn<'n> = dyn FnMut(
        &mut Access<'_>,
        &mut dyn FnMut(&str, ModHostCall) -> Result<Value>,
        Value,
    ) -> Result<Value>
    + 'n;

struct Invocation {
    authority_current: bool,
    location: store::StateLocation,
    thread: Option<String>,
    loaded: Loaded,
    dynamic: Vec<String>,
    node: PathBuf,
    virtual_time_ms: Option<u64>,
    started: Instant,
    /// Older thread or checkout state to migrate before the callback, outside the runtime lock.
    migrate: bool,
}

fn registered_call(loaded: &Loaded, dynamic: &[String], event: &str, name: &str) -> Result<()> {
    match event {
        "tool" if loaded.registrations.tools.iter().any(|t| t.name == name) => (),
        "tool" if dynamic.iter().any(|tool| tool == name) => (),
        "command" if loaded.registrations.commands.iter().any(|c| c.name == name) => (),
        "component" if loaded.registrations.components.iter().any(|c| c == name) => (),
        "intercept"
            if name
                .parse::<usize>()
                .is_ok_and(|index| index < loaded.registrations.interceptors.len()) => {}
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
        "completion" if !loaded.registrations.completions.is_empty() => {}
        e if loaded
            .registrations
            .events
            .iter()
            .any(|registered| registered == e) => {}
        _ => return Err(failure("unsupported_or_unregistered_operation")),
    }
    Ok(())
}

const SLEEP_LIMIT_MS: u64 = 60_000;

/// Callbacks documented to run without host operations.
fn hostless(event: &str, payload: &Value) -> bool {
    matches!(event, "terminal" | "component")
        || event == "intercept"
            && matches!(
                payload["surface"].as_str(),
                Some(
                    "render"
                        | "command_list"
                        | "config_list"
                        | "tool_specs"
                        | "agent_offers"
                        | "admission"
                        | "composer_edit"
                        | "composer_key"
                        | "component_change"
                        | "history_persist"
                )
            )
}

/// Interceptors the engine runs synchronously while a model request is built, sent or streamed; a sleep there would stall that request's worker.
fn request_path(event: &str, payload: &Value) -> Option<&'static str> {
    if event != "intercept" {
        return None;
    }
    ["model_request", "model_send", "response_stream"]
        .into_iter()
        .find(|surface| payload["surface"] == *surface)
}

/// `time.sleep` waits outside the runtime lock and wakes early when the callback is cancelled.
fn sleep(
    access: &mut Access<'_>,
    arguments: &Value,
    virtual_time_ms: Option<u64>,
    active: &dyn Fn() -> bool,
) -> Result<Value> {
    let ms = arguments
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|_| arguments["ms"].as_u64())
        .filter(|ms| *ms <= SLEEP_LIMIT_MS)
        .ok_or_else(|| failure("time_sleep_ms_invalid: 0 to 60000"))?;
    if virtual_time_ms.is_some() {
        return Ok(json!({"slept_ms": ms, "cancelled": false}));
    }
    if matches!(access, Access::Held(_)) {
        return Err(failure(
            "time_sleep_unavailable: this callback holds the mod runtime",
        ));
    }
    let started = Instant::now();
    let deadline = started + Duration::from_millis(ms);
    while Instant::now() < deadline {
        if !active() {
            return Ok(
                json!({"slept_ms": started.elapsed().as_millis() as u64, "cancelled": true}),
            );
        }
        std::thread::sleep((deadline - Instant::now()).min(Duration::from_millis(25)));
    }
    Ok(json!({"slept_ms": ms, "cancelled": false}))
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
    mut next: Option<&mut NextFn<'_>>,
) -> Result<Value> {
    let _frame = scope.enter(id)?;
    let thread = state_thread(&payload);
    let started = Instant::now();
    let budget = Duration::from_millis(MOD_CALLBACK_TOTAL_BUDGET_MS);
    let now_ms = crate::peers::now_ms();
    let mut replay: Vec<Value> = Vec::new();
    loop {
        let replaying = !replay.is_empty();
        let mut invocation =
            access.with(|runtime| runtime.begin(id, generation, active, thread.as_deref()))?;
        if invocation.migrate {
            invocation.loaded.state = packages::migrate_state(
                &invocation.node,
                &invocation.loaded,
                &invocation.location,
                active,
            )?;
        }
        let mut reply = registered_call(&invocation.loaded, &invocation.dynamic, event, name).and_then(|()| {
        bridge::run(
            &invocation.node,
            &invocation.loaded,
            event,
            name,
            payload.clone(),
            &replay,
            active,
            &mut |call| {
                if call.operation == "continuation.next" {
                    let input = call.arguments.get("input").cloned().unwrap_or(Value::Null);
                    return match next.as_mut() {
                        Some(next) => next(&mut *access, &mut *host, input),
                        None => Err(failure("continuation_outside_interceptor")),
                    };
                }
                if call.operation == "time.sleep" {
                    if hostless(event, &payload) {
                        return Err(failure(format!(
                            "host_operation_unavailable: time.sleep is not available during {event}"
                        )));
                    }
                    if let Some(surface) = request_path(event, &payload) {
                        return Err(failure(format!(
                            "time_sleep_unavailable: {surface} runs on the request path"
                        )));
                    }
                    return sleep(&mut *access, &call.arguments, invocation.virtual_time_ms, active);
                }
                if matches!(event, "terminal" | "component") {
                    return host(id, call);
                }
                let mut call = call;
                if call.operation == "turns.queue"
                    && let Some(arguments) = call.arguments.as_object_mut()
                {
                    arguments.insert("event".into(), json!(event));
                }
                let private = call.operation.starts_with("sessions.")
                    || call.operation.starts_with("evidence.");
                let masked = private
                    || ["store.", "credentials.", "http.", "exec."]
                        .iter()
                        .any(|prefix| call.operation.starts_with(prefix))
                    || matches!(call.operation.as_str(), "environment.read" | "environment.set");
                let before = json!({"phase":"before","caller":id,"operation":call.operation,"arguments":if masked {Value::Null} else {call.arguments.clone()}});
                let _ = access.with(|runtime| {
                    Ok(runtime.event_except("host_operation", before, id, active, scope))
                });
                let intercepted = (!private && event != "intercept")
                    .then(|| access.with(|runtime| Ok(runtime.intercepts("host_operation"))))
                    .and_then(|intercepts| intercepts.ok().flatten());
                let result = if let Some(required) = intercepted {
                    let namespace = host_namespace(&call.operation, &call.arguments);
                    let input = json!({"operation": call.operation, "namespace": namespace, "arguments": call.arguments});
                    let chain = scope.stack.borrow().clone();
                    let provider = (chain.len() > 1).then(|| id.to_owned());
                    let origin = json!({"caller": id, "thread_id": thread, "provider": provider, "chain": chain});
                    chain::intercept(
                        &mut *access,
                        &mut *host,
                        &mut chain::Core::Host { caller: id.to_owned(), generation },
                        "host_operation",
                        required,
                        input,
                        origin,
                        active,
                        scope,
                    )
                    .and_then(|chain| match chain.result.get("error").and_then(Value::as_str) {
                        Some(error) => Err(failure(error)),
                        None => Ok(chain.result["value"].clone()),
                    })
                } else {
                    chain::dispatch(&mut *access, &mut *host, id, generation, call.clone(), active, scope)
                };
                let after = match &result {
                    Ok(value) => {
                        json!({"phase":"after","caller":id,"operation":call.operation,"result":if masked {Value::Null} else {value.clone()}})
                    }
                    Err(error) => {
                        json!({"phase":"after","caller":id,"operation":call.operation,"error":if masked {"private_operation_failed".to_owned()} else {error.to_string()}})
                    }
                };
                let _ = access.with(|runtime| {
                    Ok(runtime.event_except("host_operation", after, id, active, scope))
                });
                result
            },
            progress,
            Some(invocation.virtual_time_ms.unwrap_or(now_ms)),
            scope,
        )
    });
        // A retry replays recorded host results; a divergent replay of read-only calls runs fresh.
        if replaying && reply.is_err() {
            if replay.iter().all(read_only_receipt) && started.elapsed() < budget {
                replay.clear();
                continue;
            }
            reply = Err(failure("state_conflict: reload before retry"));
        }
        let receipts = reply.as_ref().ok().map(|reply| reply.receipts.clone());
        match access
            .with(|runtime| runtime.finish(id, generation, event, name, invocation, reply, active))
        {
            Err(error)
                if started.elapsed() < budget
                    && error.to_string().starts_with("state_conflict") =>
            {
                let Some(receipts) = receipts else {
                    return Err(error);
                };
                replay = receipts;
            }
            result => return result,
        }
    }
}

fn read_only_receipt(receipt: &Value) -> bool {
    let arguments = &receipt["call"]["arguments"];
    match receipt["call"]["operation"].as_str().unwrap_or_default() {
        "workspace.read"
        | "workspace.list"
        | "workspace.stat"
        | "workspace.fingerprint"
        | "store.get"
        | "store.list"
        | "store.export"
        | "evidence.read"
        | "sessions.list"
        | "sessions.read"
        | "routes.list"
        | "task.status"
        | "contract.status"
        | "agents.list"
        | "process.which"
        | "process.status"
        | "sidecars.status"
        | "app.routes"
        | "credentials.list"
        | "turns.activity"
        | "composer.read"
        | "prompts.status"
        | "packages.list"
        | "packages.index"
        | "packages.preview"
        | "exec.output_page"
        | "terminal.image_sample" => true,
        "workspace.check_access" => arguments["write"] != true,
        "exec.run" => {
            arguments["write"] != true
                && arguments["network"]
                    .as_str()
                    .is_none_or(|network| network == "none")
                && arguments["unix_sockets"].is_null()
                && arguments["sandbox"].is_null()
        }
        _ => false,
    }
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
        None,
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
        Self::open_with(root, tool_validator, None, &|| true)
    }

    /// Opens the host for a session repository so checkout-scoped state is known at registration.
    pub fn open_in(
        root: PathBuf,
        tool_validator: fn(&Value) -> Result<()>,
        repository: &Path,
    ) -> Result<Self> {
        Self::open_in_guarded(root, tool_validator, repository, &|| true)
    }

    pub fn open_in_guarded(
        root: PathBuf,
        tool_validator: fn(&Value) -> Result<()>,
        repository: &Path,
        active: &dyn Fn() -> bool,
    ) -> Result<Self> {
        Self::open_with(root, tool_validator, Some(repository), active)
    }

    fn open_with(
        root: PathBuf,
        tool_validator: fn(&Value) -> Result<()>,
        repository: Option<&Path>,
        active: &dyn Fn() -> bool,
    ) -> Result<Self> {
        let _profile = Profile::new("host_open");
        let store = ModStore::open(root)?;
        let mut host = Self {
            store,
            node: PathBuf::new(),
            generation: 0,
            configuration_sha256: String::new(),
            configuration_stamp: None,
            ui_configuration: None,
            selections: (0, 0),
            loaded: BTreeMap::new(),
            order: Vec::new(),
            rejected: Vec::new(),
            reload_error: None,
            service_calls: Vec::new(),
            tool_validator,
            virtual_time_ms: None,
            tier_selections: BTreeMap::new(),
            dynamic_tools: BTreeMap::new(),
            checkout: None,
            valid_views: BTreeMap::new(),
            renders: BTreeMap::new(),
            clock_reads: BTreeSet::new(),
            rendered: HashMap::new(),
            chains: Vec::new(),
            access: Vec::new(),
            admissions: BTreeMap::new(),
            brokered: None,
            callback_configuration: Mutex::default(),
            required_surfaces: Arc::default(),
            intercepted_surfaces: Arc::default(),
            codex_config: Arc::default(),
            environment: Arc::default(),
            policies: Vec::new(),
            managed: None,
            unserved: Vec::new(),
            project: None,
            pool: {
                static HOSTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                HOSTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            },
        };
        if let Some(repository) = repository {
            host.set_checkout(repository);
        }
        host.reload_guarded(active)?;
        Ok(host)
    }

    /// Selects where `state_scope: "checkout"` mod state lives: the Git directory, else nowhere.
    pub fn set_checkout(&mut self, repository: &Path) {
        self.configuration_stamp = None;
        if self.project.as_deref() != repository.canonicalize().ok().as_deref() {
            for loaded in self.loaded.values_mut() {
                loaded.clear_ui();
            }
        }
        self.project = repository.canonicalize().ok();
        self.checkout = repository
            .ancestors()
            .find_map(|directory| {
                let marker = directory.join(".git");
                let metadata = std::fs::symlink_metadata(&marker).ok()?;
                let git = if metadata.is_dir() {
                    marker
                } else if metadata.is_file() {
                    let text = std::fs::read_to_string(&marker).ok()?;
                    directory.join(text.strip_prefix("gitdir:")?.trim())
                } else {
                    return None;
                };
                git.canonicalize().ok()
            })
            .map(|git| git.join("omd").join("state"));
    }

    fn state_location(
        &self,
        package: &ModPackage,
        scope: &str,
        thread: Option<&str>,
    ) -> store::StateLocation {
        let name = format!("{}.json", package.id);
        match package.state_scope.as_str() {
            "thread" => match thread.filter(|thread| crate::resource_data::token(thread)) {
                Some(thread) => store::StateLocation::Directory(
                    self.store
                        .root
                        .join("data")
                        .join("threads")
                        .join(thread)
                        .join(".state"),
                    ModStore::state_name(&package.id, scope),
                ),
                None => store::StateLocation::Unavailable("state_thread_unavailable"),
            },
            "checkout" => match &self.checkout {
                Some(directory) => store::StateLocation::Directory(directory.clone(), name),
                None => store::StateLocation::Unavailable("state_checkout_unavailable"),
            },
            _ => store::StateLocation::Store {
                id: package.id.clone(),
                scope: scope.to_owned(),
            },
        }
    }

    pub fn reload(&mut self) -> Result<bool> {
        for loaded in self.loaded.values_mut() {
            loaded.clear_ui();
        }
        self.refresh_authority()
    }

    /// Refresh package authority without resetting UI state when configuration is unchanged.
    pub fn refresh_authority(&mut self) -> Result<bool> {
        self.reload_guarded(&|| true)
    }

    fn reload_guarded(&mut self, active: &dyn Fn() -> bool) -> Result<bool> {
        let result = self.reload_active(active);
        if result.is_err() && !active() {
            self.fail_closed("callback_cancelled".to_owned());
            return Err(failure("callback_cancelled"));
        }
        result
    }

    fn fail_closed(&mut self, reason: String) {
        for loaded in self.loaded.values_mut() {
            loaded.clear_ui();
        }
        if !self.loaded.is_empty() {
            self.loaded.clear();
            self.environment.clear(None, None);
            self.order.clear();
            self.generation += 1;
            self.dynamic_tools.clear();
        }
        self.unserved = vec![(
            "authority".to_owned(),
            MOD_CAPABILITIES
                .iter()
                .map(|capability| (*capability).to_owned())
                .collect(),
            reason,
        )];
        self.publish_surfaces();
        self.configuration_sha256.clear();
    }

    fn current(&self, stamp: Option<FileStamp>) -> bool {
        stamp.is_some()
            && stamp == self.configuration_stamp
            && self
                .brokered
                .as_ref()
                .is_some_and(|(at, _, _)| at.elapsed() < BROKER_REFRESH)
    }

    /// Whether a refresh would re-read the configuration and authority instead of keeping them.
    pub fn refresh_due(&self) -> bool {
        !self.current(configuration_stamp(&self.store.root.join("mods.json")))
    }

    fn reload_active(&mut self, active: &dyn Fn() -> bool) -> Result<bool> {
        if !active() {
            return Err(failure("callback_cancelled"));
        }
        let _profile = Profile::new("reload");
        let config_profile = Profile::new("configuration_read_hash");
        let path = self.store.root.join("mods.json");
        let stamp = configuration_stamp(&path);
        if self.current(stamp) {
            return Ok(false);
        }
        self.configuration_stamp = None;
        let (stamp, sha256, bytes) = read_configuration(&path, stamp);
        drop(config_profile);
        let (brokered, managed, deployment) = match self.authority(&sha256) {
            Ok(authority) => authority,
            Err(error) => {
                self.fail_closed(format!("authority_unavailable: {error}"));
                return Err(error);
            }
        };
        let (deployment, unreadable) = match deployment {
            Ok(deployment) => (deployment, None),
            Err(error) => (policy::ManagedDeployment::default(), Some(error)),
        };
        let hash = format!(
            "{sha256}:{}:{}:{}:{}",
            brokered.as_ref().map_or(0, |(generation, _)| *generation),
            managed
                .as_ref()
                .map_or("", |managed| managed.sha256.as_str()),
            deployment.generation,
            self.project.as_deref().unwrap_or(Path::new("")).display()
        );
        if hash == self.configuration_sha256 {
            self.configuration_stamp = stamp.filter(|_| configuration_stamp(&path) == stamp);
            return Ok(false);
        }
        let configured = bytes
            .and_then(|bytes| ModConfiguration::parse(&bytes, &path))
            .and_then(
                |config| match config.schema != 1 || !config.node.is_absolute() {
                    true => Err(failure("invalid_mod_configuration")),
                    false => Ok(config),
                },
            );
        let mut rejected = Vec::new();
        let config = match configured {
            Ok(config) => config,
            Err(error) if managed.is_some() => {
                // Administrator policy still loads when the user's configuration is broken.
                rejected.push(ModRejection {
                    path: path.clone(),
                    id: None,
                    scope: user_scope(),
                    reason: format!("invalid_mod_configuration: {error}"),
                });
                ModConfiguration {
                    schema: 1,
                    revision: 0,
                    node: Some(self.node.clone())
                        .filter(|node| node.is_file())
                        .or_else(node_on_path)
                        .unwrap_or_default(),
                    mods: Vec::new(),
                }
            }
            Err(error) => return Err(error),
        };
        let ui_signature = digest(serde_json::to_vec(&(&config.node, &config.mods))?.as_slice());
        if self
            .ui_configuration
            .as_ref()
            .is_some_and(|(revision, signature)| {
                *revision != config.revision && signature == &ui_signature
            })
        {
            reset_ui_states(&self.store.root, config.revision);
        }
        self.ui_configuration = Some((config.revision, ui_signature));
        let mut selections = Vec::new();
        let user = self.store.managed_user();
        if let Some(managed) = &managed {
            if let Some(reason) = unreadable {
                rejected.push(ModRejection {
                    path: self.store.root.join("managed.json"),
                    id: None,
                    scope: MANAGED_SCOPE.to_owned(),
                    reason,
                });
            }
            let (administered, pending) =
                managed.selections(&deployment, &user, self.project.as_deref());
            selections = administered;
            rejected.extend(pending);
        }
        let administered = selections.len();
        selections.extend(config.mods.iter().cloned());
        self.managed = managed;
        self.policies = selections
            .iter()
            .filter(|m| m.enabled && m.capabilities.iter().any(|c| c == "request_policy"))
            .map(|m| m.path.clone())
            .collect();
        self.publish_surfaces();
        let initial = self.configuration_sha256.is_empty() || self.managed.is_some();
        let retained = self.loaded.len();
        self.loaded.retain(|_, loaded| {
            let keep = selections.iter().enumerate().any(|(index, m)| {
                m.enabled
                    && m.path == loaded.selection.path
                    && m.scope == loaded.selection.scope
                    && loaded
                        .package
                        .capabilities
                        .iter()
                        .all(|cap| m.capabilities.contains(cap))
                    && (index < administered
                        || brokered
                            .as_ref()
                            .is_none_or(|(_, grants)| grants.contains(&store::grant(&json!(m)))))
            });
            if !keep {
                loaded.clear_ui();
            }
            keep
        });
        if self.loaded.len() != retained {
            self.retain_environment();
            self.generation += 1;
            self.dynamic_tools.clear();
        }
        self.unserved = self.unserved_targets(&user);
        self.publish_surfaces();
        let selection_profile = Profile::new("selection_verification");
        let selected = Self::select(
            &selections,
            administered,
            initial,
            brokered.as_ref().map(|(_, grants)| grants),
            self.managed.as_ref().map(|managed| &managed.policy),
            &mut rejected,
            store::package,
        )?;
        drop(selection_profile);
        let adapters = Self::adapters(&selected);
        let mut next = BTreeMap::new();
        for (id, (selection, package, source)) in selected {
            if !active() {
                return Err(failure("callback_cancelled"));
            }
            // An unchanged trusted selection and adapter keep their inspection; only changed mods run again.
            if let Some(previous) = self.loaded.get(&id).filter(|previous| {
                previous.error.is_none()
                    && previous.adapter.as_ref()
                        == package
                            .adapter
                            .as_deref()
                            .and_then(|name| adapters.get(name))
                    && serde_json::to_value(&previous.selection).ok()
                        == serde_json::to_value(&selection).ok()
            }) {
                next.insert(id, previous.clone());
                continue;
            }
            let assets = (|| {
                if package.assets.is_empty() {
                    return Ok(BTreeMap::new());
                }
                let (_, _, hash, files) = store::package_with_assets(&selection.path)?;
                if hash != selection.sha256 {
                    return Err(failure(format!(
                        "untrusted_source: {} changed after it was trusted; review it, then re-trust it in /omd or with omd-mod trust",
                        package.id
                    )));
                }
                Ok(store::asset_map(files))
            })();
            let assets = match assets {
                Ok(assets) => assets,
                Err(error) => {
                    reject(
                        initial,
                        &mut rejected,
                        &selection,
                        Some(&package.id),
                        error.to_string(),
                    )?;
                    continue;
                }
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
                source: source.into(),
                assets: Arc::new(assets),
                request_metadata: Arc::new(OnceLock::new()),
                selection,
                state: Value::Null,
                ui: None,
                ui_state: Value::Null,
                ui_revision: 0,
                ui_clears: 0,
                command_view: None,
                registrations: Registrations::default(),
                source_use: ModSourceUse::default(),
                unused_grants: Vec::new(),
                unused_environment: Vec::new(),
                withheld: Vec::new(),
                error: None,
                telemetry: ModTelemetry::default(),
            };
            let prepared = (|| {
                if let Some(Err(error)) = &adapter {
                    return Err(failure(error.to_string()));
                }
                let location = self.state_location(
                    &loaded.package,
                    &loaded.selection.scope,
                    bound_thread().as_deref(),
                );
                loaded.state = match self
                    .store
                    .scoped_state(&location, loaded.package.state_version)
                {
                    // Older thread or checkout state migrates at the mod's first callback there.
                    Err(error)
                        if matches!(location, store::StateLocation::Directory(..))
                            && error.to_string().starts_with("state_migration_required") =>
                    {
                        Value::Null
                    }
                    state => state?,
                };
                let inspection_profile = Profile::new("inspection_callback");
                let reply = Self::run(&config.node, &loaded, "inspect", "", Value::Null, active)?;
                drop(inspection_profile);
                if reply.state != loaded.state {
                    return Err(failure("state_write_during_registration"));
                }
                let registrations = reply.registrations;
                Self::validate_registrations(&loaded.package, &registrations)?;
                for tool in &registrations.tools {
                    (self.tool_validator)(&tool.parameters)?;
                }
                let mut code = loaded.source.to_string();
                for name in registrations
                    .modules
                    .iter()
                    .filter(|name| !name.ends_with(".json"))
                {
                    if let Some(text) = loaded
                        .assets
                        .get(name)
                        .and_then(|asset| asset["text"].as_str())
                    {
                        code.push('\n');
                        code.push_str(text);
                    }
                }
                let (source_use, unused_grants, unused_environment) =
                    source_use(&code, &loaded.package, &registrations)?;
                Ok((registrations, source_use, unused_grants, unused_environment))
            })();
            if !active() {
                return Err(failure("callback_cancelled"));
            }
            match prepared {
                Ok((registrations, source_use, unused_grants, unused_environment)) => {
                    loaded.registrations = registrations;
                    loaded.source_use = source_use;
                    loaded.unused_grants = unused_grants;
                    loaded.unused_environment = unused_environment;
                }
                // A mod without a working previous version fails alone instead of blocking the reload.
                Err(error) => fail(
                    initial
                        || self
                            .loaded
                            .get(&id)
                            .is_none_or(|previous| previous.error.is_some()),
                    &mut loaded,
                    error,
                )?,
            }
            next.insert(id, loaded);
        }
        // Mods without a working previous version fail alone; working ones keep reloads transactional.
        let working: BTreeSet<String> = self
            .loaded
            .iter()
            .filter(|(_, loaded)| loaded.error.is_none())
            .map(|(id, _)| id.clone())
            .collect();
        let lenient = |id: &str| initial || !working.contains(id);
        Self::resolve_conflicts(&mut next, &lenient)?;
        Self::resolve_services(&mut next, &lenient)?;
        Self::resolve_virtual_readers(&mut next, &lenient)?;
        let order = Self::resolve_dependencies(&mut next, &lenient)?;
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
        for (id, previous) in &mut self.loaded {
            if next.get(id).is_none_or(|loaded| {
                !Arc::ptr_eq(&loaded.request_metadata, &previous.request_metadata)
            }) {
                previous.clear_ui();
            }
        }
        self.loaded = next;
        self.order = order;
        let denied = rejected
            .iter()
            .filter(|rejection| {
                !self.rejected.iter().any(|previous| {
                    previous.path == rejection.path && previous.reason == rejection.reason
                })
            })
            .map(|rejection| {
                json!({"path": rejection.path, "mod": rejection.id,
                "scope": rejection.scope, "reason": rejection.reason.split(':').next()})
            })
            .collect::<Vec<_>>();
        if !denied.is_empty()
            && let Ok(_guard) = self.store.lock()
        {
            let _ = self
                .store
                .record_security_event("load_denied", json!({"selections": denied}));
        }
        self.rejected = rejected;
        let admission_profile = Profile::new("admission");
        self.admit(active);
        if !active() {
            return Err(failure("callback_cancelled"));
        }
        drop(admission_profile);
        self.retain_environment();
        self.unserved = self.unserved_targets(&user);
        self.configuration_sha256 = hash;
        self.configuration_stamp = stamp.filter(|_| configuration_stamp(&path) == stamp);
        self.generation += 1;
        self.dynamic_tools.clear();
        self.reload_error = None;
        self.publish_surfaces();
        if let Err(error) = self.write_installed_service_types() {
            self.reload_error = Some(format!("derived_types_unavailable: {error}"));
        }
        Ok(true)
    }

    /// Intercept surfaces with a required interceptor, readable while another caller holds the runtime.
    pub fn required_surfaces(&self) -> Arc<Mutex<Vec<&'static str>>> {
        self.required_surfaces.clone()
    }

    /// Intercept surfaces with any interceptor, readable while another caller holds the runtime.
    pub fn intercepted_surfaces(&self) -> Arc<Mutex<Vec<&'static str>>> {
        self.intercepted_surfaces.clone()
    }

    pub fn environment(&self) -> Arc<crate::host::Environment> {
        self.environment.clone()
    }

    /// Codex config keys the active packages turn on, readable while another caller holds the runtime.
    pub fn codex_config(&self) -> Arc<Mutex<BTreeSet<String>>> {
        self.codex_config.clone()
    }

    fn retain_environment(&self) {
        self.environment.retain(
            &self
                .owners()
                .into_iter()
                .map(|(id, owner)| (id, owner.sha256))
                .collect(),
        );
    }

    fn publish_surfaces(&self) {
        process::size_reused_pool(
            self.pool,
            Some(
                self.loaded
                    .keys()
                    .filter(|id| self.registered(id, "terminal"))
                    .count(),
            ),
        );
        let surfaces = MOD_INTERCEPT_SURFACES
            .iter()
            .map(|(surface, _)| *surface)
            .filter(|surface| {
                self.intercepts(surface) == Some(true)
                    || *surface == "model_send" && !self.policies.is_empty()
            })
            .collect();
        if let Ok(mut published) = self.required_surfaces.lock() {
            *published = surfaces;
        }
        let intercepted = MOD_INTERCEPT_SURFACES
            .iter()
            .map(|(surface, _)| *surface)
            .filter(|surface| self.intercepts(surface).is_some())
            .collect();
        if let Ok(mut published) = self.intercepted_surfaces.lock() {
            *published = intercepted;
        }
        if let Ok(mut published) = self.codex_config.lock() {
            *published = self
                .active()
                .flat_map(|(_, loaded)| loaded.package.codex_config.keys().cloned())
                .collect();
        }
    }

    /// Applicable managed targets without a successfully inspected instance: ID, granted capabilities and why.
    fn unserved_targets(&self, user: &str) -> Vec<(String, Vec<String>, String)> {
        let Some(managed) = &self.managed else {
            return Vec::new();
        };
        managed
            .targets(user, self.project.as_deref())
            .into_iter()
            .filter(|target| {
                !self.loaded.get(&target.id).is_some_and(|loaded| {
                    loaded.selection.scope == MANAGED_SCOPE
                        && (loaded.error.is_none()
                            || loaded.registrations != Registrations::default())
                })
            })
            .map(|target| {
                let reason = self
                    .rejected
                    .iter()
                    .find(|rejection| {
                        rejection.scope == MANAGED_SCOPE
                            && rejection.id.as_ref() == Some(&target.id)
                    })
                    .map(|rejection| rejection.reason.clone())
                    .or_else(|| self.loaded.get(&target.id)?.error.clone())
                    .unwrap_or_else(|| {
                        format!(
                            "managed_not_running: {}; see omd-mod policy explain",
                            target.id
                        )
                    });
                (target.id.clone(), target.capabilities.clone(), reason)
            })
            .collect()
    }

    /// Re-asks the broker and policy source and re-reads the deployment record when `mods.json`
    /// changes or the last answer is older than `BROKER_REFRESH`.
    fn authority(&mut self, digest: &str) -> Result<Authority> {
        let _profile = Profile::new("authority");
        if let Some((at, cached, authority)) = &self.brokered
            && cached == digest
            && at.elapsed() < BROKER_REFRESH
        {
            return Ok(authority.clone());
        }
        self.brokered = None;
        let grants = store::brokered_grants(&self.store.root)?;
        let managed = self.store.managed()?;
        let deployment = match managed {
            Some(_) => self
                .store
                .managed_deployment()
                .map_err(|error| error.to_string()),
            None => Ok(policy::ManagedDeployment::default()),
        };
        let authority = (grants, managed, deployment);
        self.brokered = Some((Instant::now(), digest.to_owned(), authority.clone()));
        Ok(authority)
    }

    /// Reads administrator policy from `file`, trusting `owner` besides root, as `user`; for isolated hosts.
    pub fn set_managed_policy(&mut self, file: PathBuf, owner: u32, user: &str) -> Result<bool> {
        self.store.set_managed_policy(file, owner, user);
        self.brokered = None;
        self.reload()
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

    /// Trusted, enabled selections keyed by mod ID after administrator policy and scope precedence;
    /// the first `administered` selections come from the policy.
    fn select(
        selections: &[ModSelection],
        administered: usize,
        initial: bool,
        grants: Option<&BTreeSet<String>>,
        managed: Option<&ManagedPolicy>,
        rejected: &mut Vec<ModRejection>,
        inspect: fn(&Path) -> Result<(ModPackage, String, String)>,
    ) -> Result<BTreeMap<String, (ModSelection, ModPackage, String)>> {
        let rank = |scope: &str| match scope {
            MANAGED_SCOPE => 2,
            "project" => 1,
            _ => 0,
        };
        let mut selected: BTreeMap<String, (ModSelection, ModPackage, String)> = BTreeMap::new();
        for (index, selection) in selections.iter().enumerate().filter(|(_, m)| m.enabled) {
            let administered = index < administered;
            let loaded = (|| {
                if !administered
                    && (!MOD_SCOPES.contains(&selection.scope.as_str()) || selection.tier.is_some())
                {
                    return Err(failure(format!(
                        "unsupported_scope: {}; the managed scope and tiers come only from administrator policy",
                        selection.scope
                    )));
                }
                if !administered
                    && grants
                        .is_some_and(|grants| !grants.contains(&store::grant(&json!(selection))))
                {
                    return Err(failure(format!(
                        "grant_not_brokered: {} has no protected grant; re-trust it in /omd or with omd-mod trust",
                        selection.path.display()
                    )));
                }
                let (package, source, hash) = inspect(&selection.path)?;
                if hash != selection.sha256 {
                    return Err(failure(if administered {
                        format!(
                            "managed_content_stale: {} differs from the administrator-pinned sha256; run omd-mod package-sync",
                            package.id
                        )
                    } else {
                        format!(
                            "untrusted_source: {} changed after it was trusted; review it, then re-trust it in /omd or with omd-mod trust",
                            package.id
                        )
                    }));
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
                check_secret_environment(&package, &selection.secret_environment)?;
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
            // Policy refusals apply on every reload: the user cannot repair them.
            if !administered
                && let Some(reason) = managed.and_then(|policy| {
                    policy.refusal(
                        &id,
                        &package.capabilities,
                        store::authenticated_source(selection, &id, grants).as_deref(),
                    )
                })
            {
                rejected.push(ModRejection {
                    path: selection.path.clone(),
                    id: Some(id),
                    scope: selection.scope.clone(),
                    reason,
                });
                continue;
            }
            let Some((previous, ..)) = selected.get(&id) else {
                selected.insert(id, (selection.clone(), package, source));
                continue;
            };
            if previous.scope != selection.scope {
                let (loser, winner) = if rank(&selection.scope) > rank(&previous.scope) {
                    let (previous, ..) = selected
                        .insert(id.clone(), (selection.clone(), package, source))
                        .expect("checked above");
                    (previous, selection.clone())
                } else {
                    (selection.clone(), previous.clone())
                };
                rejected.push(ModRejection {
                    path: loser.path,
                    id: Some(id),
                    scope: loser.scope,
                    reason: format!(
                        "shadowed_by_{}_scope: {}",
                        winner.scope,
                        winner.path.display()
                    ),
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
    fn resolve_conflicts(
        next: &mut BTreeMap<String, Loaded>,
        lenient: &dyn Fn(&str) -> bool,
    ) -> Result<()> {
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
        if let Err(cycle) = chain::order(next) {
            let reason = format!("interceptor_order_conflict: {}", cycle.join(", "));
            conflicts.extend(cycle.into_iter().map(|id| (id, reason.clone())));
        }
        for (id, reason) in conflicts {
            if let Some(loaded) = next.get_mut(&id) {
                fail(lenient(&id), loaded, failure(reason))?;
            }
        }
        Ok(())
    }

    fn resolve_services(
        next: &mut BTreeMap<String, Loaded>,
        lenient: &dyn Fn(&str) -> bool,
    ) -> Result<()> {
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
                    fail(lenient(provider), loaded, failure(reason.clone()))?;
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
                    fail(lenient(&id), loaded, failure(reason))?;
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
        lenient: &dyn Fn(&str) -> bool,
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
                    fail(lenient(&id), loaded, failure(reason))?;
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
                    fail(lenient(&id), loaded, failure(reason.clone()))?;
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
            || registrations.components.len() > 16
        {
            return Err(failure("registration_limit_or_capability_denied"));
        }
        if registrations.services != package.services.exports {
            return Err(failure(
                "registered_service_contracts_do_not_match_manifest",
            ));
        }
        resources::validate_registrations(package, &registrations.virtual_reads)?;
        let triggers = registrations
            .completions
            .iter()
            .map(|completion| completion.trigger.as_str())
            .collect::<BTreeSet<_>>();
        if !registrations.completions.is_empty()
            && (!has("composer")
                || registrations.completions.len() > 4
                || triggers.len() != registrations.completions.len()
                || !triggers.iter().all(|trigger| completion_trigger(trigger)))
        {
            return Err(failure("invalid_completion_registration"));
        }
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
        for agent in &registrations.agents {
            if !has("agents")
                || registrations.agents.len() > 8
                || !identifier(&agent.name)
                || agent.name.len() > 32
                || !names.insert(&agent.name)
                || !visible(&agent.description, 512)
                || agent.instructions.trim().is_empty()
                || agent.instructions.len() > 16_384
                || agent
                    .route
                    .as_deref()
                    .is_some_and(|route| !visible(route, 64))
                || agent
                    .effort
                    .as_deref()
                    .is_some_and(|effort| !crate::model_request::EFFORTS.contains(&effort))
                || agent.tools.as_ref().is_some_and(|tools| {
                    tools.len() > 32 || tools.iter().any(|tool| !visible(tool, 128))
                })
            {
                return Err(failure("invalid_agent_registration"));
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
                || command
                    .args_hint
                    .as_deref()
                    .is_some_and(|hint| !visible(hint, 64))
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
        chain::validate(&registrations.interceptors, &package.capabilities)
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
            &[],
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
            None,
        )
    }

    fn check_callback_authority(&self, loaded: &Loaded) -> Result<()> {
        let managed = self.store.managed()?;
        let brokered = store::brokered_grants(&self.store.root)?;
        let deployment = if managed.is_some() {
            self.store.managed_deployment()?
        } else {
            policy::ManagedDeployment::default()
        };
        let mut selections = match &managed {
            Some(managed) => managed.selections(
                &deployment,
                &self.store.managed_user(),
                self.project.as_deref(),
            ).0,
            None => Vec::new(),
        };
        let mut administered = selections.len();
        let configured = self.tier_selections.get(&loaded.package.id).unwrap_or(&loaded.selection);
        let (configuration_sha256, configuration) = self.callback_configuration();
        let hash = format!("{}:{}:{}:{}:{}",
            configuration_sha256,
            brokered.as_ref().map_or(0, |(generation, _)| *generation),
            managed.as_ref().map_or("", |managed| managed.sha256.as_str()),
            deployment.generation,
            self.project.as_deref().unwrap_or(Path::new("")).display());
        // An unchanged authority inventory cannot introduce a different precedence winner.
        let unchanged = hash == self.configuration_sha256;
        match configuration {
            Ok(config) if config.schema == 1 && config.node == self.node => selections.extend(
                config.mods.iter().filter(|selection| !unchanged || selection.path == loaded.selection.path).cloned(),
            ),
            _ if configured.scope == MANAGED_SCOPE && managed.is_some() => (),
            _ => return Err(failure("callback_authority_changed")),
        }
        if unchanged {
            administered = selections.iter().take(administered).filter(|selection| selection.path == loaded.selection.path).count();
            selections.retain(|selection| selection.path == loaded.selection.path);
        }
        let selected = Self::select(
            &selections, administered, false,
            brokered.as_ref().map(|(_, grants)| grants),
            managed.as_ref().map(|managed| &managed.policy),
            &mut Vec::new(),
            |path| store::verified_package(path).map(|(package, hash)| (package, String::new(), hash)),
        )?;
        let Some((selection, _, _)) = selected.get(&loaded.package.id) else {
            return Err(failure("callback_authority_changed"));
        };
        if selection.path != configured.path
            || selection.scope != configured.scope
            || store::grant(&json!(selection)) != store::grant(&json!(configured))
        {
            return Err(failure("callback_authority_changed"));
        }
        Ok(())
    }

    fn callback_configuration(&self) -> (String, Result<Arc<ModConfiguration>>) {
        let path = self.store.root.join("mods.json");
        let stamp = configuration_stamp(&path);
        let mut cached = self
            .callback_configuration
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let (Some(stamp), Some((cached_stamp, sha256, configuration))) = (stamp, cached.as_ref())
            && stamp == *cached_stamp
            && configuration.node.is_file()
        {
            return (sha256.clone(), Ok(configuration.clone()));
        }
        let (stamp, sha256, bytes) = read_configuration(&path, stamp);
        let configuration = bytes
            .and_then(|bytes| ModConfiguration::parse(&bytes, &path))
            .map(Arc::new);
        *cached = stamp
            .zip(configuration.as_ref().ok())
            .map(|(stamp, configuration)| (stamp, sha256.clone(), configuration.clone()));
        (sha256, configuration)
    }

    fn begin(
        &mut self,
        id: &str,
        generation: u64,
        active: &dyn Fn() -> bool,
        thread: Option<&str>,
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
        self.check_callback_authority(&loaded)?;
        let location = self.state_location(&loaded.package, &loaded.selection.scope, thread);
        let mut migrate = false;
        loaded.state = match self
            .store
            .scoped_state(&location, loaded.package.state_version)
        {
            Err(error) if packages::migratable(&loaded, &location, &error) => {
                migrate = true;
                Value::Null
            }
            state => state?,
        };
        let key = self.ui_key(&loaded, thread);
        if loaded
            .ui
            .as_ref()
            .is_none_or(|(previous, _)| previous != &key)
        {
            let mut states = UI_STATES
                .lock()
                .map_err(|_| failure("ui_state_unavailable"))?;
            states.retain(|_, state| state.strong_count() > 0);
            let state = states
                .get(&key)
                .and_then(std::sync::Weak::upgrade)
                .unwrap_or_default();
            states.insert(key.clone(), Arc::downgrade(&state));
            loaded.ui = Some((key, state));
            self.loaded.get_mut(id).unwrap().ui = loaded.ui.clone();
        }
        if let Some((_, state)) = &loaded.ui {
            let state = state.lock().map_err(|_| failure("ui_state_unavailable"))?;
            loaded.ui_state = state.value.clone();
            loaded.ui_revision = state.revision;
            loaded.ui_clears = state.clears;
        }
        Ok(Invocation {
            authority_current: loaded.selection.authority_current(),
            location,
            thread: thread.map(str::to_owned),
            dynamic: self
                .dynamic_tools
                .get(id)
                .into_iter()
                .flatten()
                .map(|tool| tool.name.clone())
                .collect(),
            loaded,
            node: self.node.clone(),
            virtual_time_ms: self.virtual_time_ms,
            started: Instant::now(),
            migrate,
        })
    }

    fn accept(
        &mut self,
        loaded: &Loaded,
        location: &store::StateLocation,
        thread: Option<&str>,
        event: &str,
        reply: Reply,
        active: &dyn Fn() -> bool,
    ) -> Result<(Value, Value)> {
        let ui_state = validate_ui_state(reply.ui_state.as_deref().unwrap_or("null"))?;
        if !active() {
            return Err(failure("callback_cancelled"));
        }
        if reply.registrations != loaded.registrations {
            return Err(failure("registration_changed_during_callback"));
        }
        let mut ui = loaded
            .ui
            .as_ref()
            .map(|(_, state)| state.lock())
            .transpose()
            .map_err(|_| failure("ui_state_unavailable"))?;
        let current = self.loaded.get(&loaded.package.id);
        let rebind = loaded
            .ui
            .as_ref()
            .zip(current)
            .is_some_and(|((key, _), current)| {
                current.ui.is_none() && key == &self.ui_key(current, thread)
            });
        if reply.ui_read {
            if !rebind
                && current
                    .and_then(|current| current.ui.as_ref())
                    .zip(loaded.ui.as_ref())
                    .is_none_or(|((_, current), (_, prior))| !Arc::ptr_eq(current, prior))
            {
                return Err(failure("callback_cancelled"));
            }
            if !loaded
                .package
                .capabilities
                .iter()
                .any(|capability| capability == "terminal")
            {
                return Err(failure("ui_state_capability_denied"));
            }
            if ui.as_ref().is_none_or(|state| {
                state.revision.wrapping_sub(loaded.ui_revision)
                    != state.clears.wrapping_sub(loaded.ui_clears)
            }) {
                return Err(failure("state_conflict: ui revision changed"));
            }
        }
        if ui_state != loaded.ui_state {
            if !reply.ui_read || !matches!(event, "command" | "component_event") {
                return Err(failure("ui_state_write_unavailable"));
            }
        }
        let mut parsed_command = None;
        if event == "command"
            && let Some(patch) = reply.value.get("terminal")
        {
            if !loaded
                .package
                .capabilities
                .iter()
                .any(|capability| capability == "terminal")
            {
                return Err(failure("terminal_capability_denied"));
            }
            if !patch.is_null() {
                parsed_command = Some(Arc::new(ModViewPatch::parse(patch.clone())?));
            }
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
            self.store.write_scoped_state(
                location,
                loaded.package.state_version,
                &loaded.state,
                &reply.state,
            )?;
        }
        if let Some(state) = ui.as_mut()
            && (ui_state != loaded.ui_state || reply.ui_written && ui_state != state.value)
        {
            state.value = ui_state;
            state.revision = state.revision.wrapping_add(1);
        }
        if rebind
            && reply.ui_read
            && let Some(current) = self.loaded.get_mut(&loaded.package.id)
        {
            current.ui = loaded.ui.clone();
        }
        if event == "command"
            && let Some(patch) = reply.value.get("terminal")
        {
            let stamp = Self::terminal_stamp(
                loaded,
                &reply.state,
                loaded
                    .ui
                    .as_ref()
                    .map(|(scope, _)| scope.as_str())
                    .zip(ui.as_ref().map(|state| &state.value)),
            );
            if let Some(current) = self.loaded.get_mut(&loaded.package.id) {
                current.command_view = Some(AcceptedCommandView {
                    value: patch.clone(),
                    stamp,
                    parsed: parsed_command,
                });
            }
        }
        if event == "terminal" {
            if reply.clock_read {
                self.clock_reads.insert(loaded.package.id.clone());
            } else {
                self.clock_reads.remove(&loaded.package.id);
            }
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
        if !active() {
            return Err(failure("callback_cancelled"));
        }
        // A reload that keeps this package binding (such as the callback's own
        // `packages.apply`) must not discard a result whose host calls already ran.
        let thread = invocation.thread.as_deref();
        if generation != self.generation
            && self.loaded.get(id).is_none_or(|current| {
                self.ui_key(current, thread) != self.ui_key(&invocation.loaded, thread)
            })
        {
            return Err(failure("stale_mod_generation: retry on the next turn"));
        }
        self.check_callback_authority(&invocation.loaded)?;
        if invocation.authority_current && !invocation.loaded.selection.authority_current()
            && invocation.loaded.package.capabilities.iter().any(|cap| AUTHORITY_CAPABILITIES.contains(&cap.as_str()))
        {
            return Err(failure("callback_authority_changed"));
        }
        let result = reply.and_then(|reply| {
            self.accept(
                &invocation.loaded,
                &invocation.location,
                invocation.thread.as_deref(),
                event,
                reply,
                active,
            )
        });
        let (started, previous_state) = (invocation.started, invocation.loaded.state);
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
                current.telemetry.faults = 0;
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
                    "state_thread_unavailable",
                    "state_checkout_unavailable",
                    "callback_cancelled",
                    "host_receipt_limit",
                    "host_result_limit",
                    "host_call_limit",
                    "callback_execution_budget",
                ]
                .iter()
                .any(|transient| message.trim_start_matches("Error: ").starts_with(transient))
                    && !matches!(event, "service" | "component")
                {
                    current.fault(message);
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

    pub fn uses_operation(&self, operation: &str) -> bool {
        self.active().any(|(_, loaded)| {
            loaded
                .source_use
                .operations
                .iter()
                .any(|used| used == operation)
        })
    }

    fn ui_key(&self, loaded: &Loaded, thread: Option<&str>) -> String {
        let mut selection = json!(loaded.selection);
        if let Some(selection) = selection.as_object_mut() {
            selection.remove("settings");
        }
        format!(
            "{}:{}",
            self.store.root.display(),
            digest(
                json!([self.project, thread, selection, loaded.adapter])
                    .to_string()
                    .as_bytes()
            )
        )
    }

    fn terminal_stamp(loaded: &Loaded, state: &Value, ui: Option<(&str, &Value)>) -> String {
        digest(
            json!([
                loaded.selection.sha256,
                loaded.selection.settings,
                state,
                ui.map(|(scope, _)| scope),
                ui.map(|(_, value)| value)
            ])
            .to_string()
            .as_bytes(),
        )
    }

    fn terminal_state_key(&self, id: &str, thread: Option<&str>) -> Option<String> {
        let loaded = self.loaded.get(id)?;
        let scope = self.ui_key(loaded, thread);
        let ui = match &loaded.ui {
            Some((current, state)) if current == &scope => Some(state.clone()),
            _ => UI_STATES
                .lock()
                .ok()?
                .get(&scope)
                .and_then(std::sync::Weak::upgrade),
        };
        let ui = match ui {
            Some(state) => state.lock().ok()?.value.clone(),
            None => Value::Null,
        };
        let location = self.state_location(&loaded.package, &loaded.selection.scope, thread);
        let state = self
            .store
            .scoped_state(&location, loaded.package.state_version)
            .ok()?;
        Some(Self::terminal_stamp(loaded, &state, Some((&scope, &ui))))
    }

    pub fn terminal_view(&mut self, payload: Value, active: impl Fn() -> bool) -> ModTerminalView {
        let thread = state_thread(&payload);
        let payload_hash = digest(payload.to_string().as_bytes());
        let results: Vec<_> = self
            .event_ids("terminal")
            .into_iter()
            .map(|id| {
                let key = self
                    .terminal_state_key(&id, thread.as_deref())
                    .map(|stamp| format!("{stamp}:{payload_hash}"));
                // A handler that read the clock is rerun once its result is a second old.
                if let (Some(key), Some((cached, value, clock))) = (&key, self.renders.get(&id))
                    && key == cached
                    && clock.is_none_or(|at| at.elapsed() < Duration::from_secs(1))
                {
                    return (id, Ok(value.clone()));
                }
                let result = self.invoke_guarded(
                    &id,
                    self.generation,
                    "terminal",
                    "",
                    payload.clone(),
                    &active,
                );
                match (&result, key) {
                    (Ok(value), Some(key)) => {
                        let clock = self.clock_reads.contains(&id).then(Instant::now);
                        self.renders.insert(id.clone(), (key, value.clone(), clock));
                    }
                    _ => {
                        self.renders.remove(&id);
                    }
                }
                (id, result)
            })
            .collect();
        let origin = payload["event"].as_str().unwrap_or_default().to_owned();
        self.compose_terminal(results, &origin, None)
    }

    pub fn command_view(
        &mut self,
        id: &str,
        generation: u64,
        patch: Value,
        payload: &Value,
    ) -> Result<ModTerminalView> {
        if generation != self.generation
            || !self.active().any(|(owner, loaded)| {
                owner == id
                    && loaded
                        .package
                        .capabilities
                        .iter()
                        .any(|capability| capability == "terminal")
            })
        {
            return Err(failure("terminal_owner_unavailable"));
        }
        let stamp = self.terminal_state_key(id, state_thread(payload).as_deref());
        let accepted = self
            .loaded
            .get(id)
            .and_then(|loaded| loaded.command_view.as_ref())
            .filter(|accepted| accepted.value == patch && Some(&accepted.stamp) == stamp.as_ref());
        let matched = accepted.is_some();
        let validated = accepted
            .and_then(|accepted| accepted.parsed.as_ref())
            .map(|parsed| parsed.as_ref().clone());
        let parsed = if patch.is_null() {
            self.valid_views.remove(id);
            None
        } else {
            let parsed = validated
                .map(Ok)
                .unwrap_or_else(|| ModViewPatch::parse(patch.clone()))?;
            self.valid_views.insert(id.to_owned(), patch.clone());
            Some((id, parsed))
        };
        self.renders.remove(id);
        // A command's result stands in for the `terminal` handler for a second, like a clock read.
        if matched && let Some(stamp) = stamp {
            let key = format!("{stamp}:{}", digest(payload.to_string().as_bytes()));
            self.renders
                .insert(id.to_owned(), (key, patch, Some(Instant::now())));
        }
        let results = self
            .active()
            .map(|(owner, _)| {
                (
                    owner.clone(),
                    Ok(self.valid_views.get(owner).cloned().unwrap_or(Value::Null)),
                )
            })
            .collect();
        Ok(self.compose_terminal(results, "command", parsed))
    }

    fn compose_terminal(
        &mut self,
        results: Vec<(String, Result<Value>)>,
        origin: &str,
        mut accepted_patch: Option<(&str, ModViewPatch)>,
    ) -> ModTerminalView {
        let mut view = ModView::default();
        let mut claims = BTreeMap::new();
        let mut component_owners = BTreeMap::new();
        let mut contributors = Vec::new();
        let mut conflicts = Vec::new();
        let mut diagnostics = Vec::new();
        for (id, result) in results {
            let parsed = match result {
                Ok(value) if value.is_null() => {
                    self.valid_views.remove(&id);
                    continue;
                }
                Ok(value) => {
                    if accepted_patch
                        .as_ref()
                        .is_some_and(|(owner, _)| *owner == id)
                    {
                        Ok(accepted_patch.take().expect("matched command owner").1)
                    } else {
                        ModViewPatch::parse(value.clone()).inspect(|_| {
                            self.valid_views.insert(id.clone(), value);
                        })
                    }
                }
                Err(error) => Err(error),
            };
            let parsed = parsed.or_else(|error| {
                // An interrupted turn cancels in-flight renders; the last view stands without a fault.
                if !error.to_string().contains("callback_cancelled") {
                    diagnostics.push(format!("{id}: {error}"));
                }
                ModViewPatch::parse(self.valid_views.get(&id).cloned().ok_or(error)?)
            });
            let Ok(mut patch) = parsed else {
                continue;
            };
            if view.sites.get("dialog").is_some_and(|dialog| {
                dialog.mode == ModSiteMode::Replace && !dialog.components.is_empty()
            }) {
                patch.sites.remove("dialog");
            }
            let before = view::site_component_ids(&view.sites);
            match patch.apply(&mut view, &mut claims, &id, &origin) {
                Ok(lost) => {
                    conflicts.extend(lost);
                    component_owners.extend(
                        view::site_component_ids(&view.sites)
                            .into_iter()
                            .filter(|component| {
                                !before.contains(component)
                                    && !component_owners.contains_key(component)
                            })
                            .map(|component| (component, id.clone()))
                            .collect::<Vec<_>>(),
                    );
                    contributors.push(id);
                }
                Err(error) => diagnostics.push(format!("{id}: {error}")),
            }
        }
        view.close_wraps();
        conflicts.truncate(32);
        ModTerminalView {
            view,
            contributors,
            component_owners,
            conflicts,
            diagnostics,
        }
    }

    pub fn turn_boundary(&mut self) {
        self.turn_boundary_guarded(&|| true);
    }

    pub fn refresh_guarded(&mut self, active: &dyn Fn() -> bool) -> Result<bool> {
        self.reload_guarded(active)
    }

    pub fn turn_boundary_guarded(&mut self, active: &dyn Fn() -> bool) {
        if let Err(error) = self.reload_guarded(active) {
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
        let exposed = format!("mod_{id}_{}", tool.name);
        if self.active().any(|(other, m)| {
            other.as_str() != id
                && m.registrations
                    .tools
                    .iter()
                    .chain(self.dynamic_tools.get(other).into_iter().flatten())
                    .any(|t| format!("mod_{other}_{}", t.name) == exposed)
        }) {
            return Err(failure(format!("tool_name_conflict: {exposed}")));
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

    pub fn launch_sources(
        &self,
        id: &str,
        generation: u64,
    ) -> io::Result<(PathBuf, BTreeMap<PathBuf, Vec<u8>>)> {
        if generation != self.generation {
            return Err(failure("service_generation_changed"));
        }
        let loaded = self
            .active()
            .find(|(owner, _)| owner.as_str() == id)
            .map(|(_, loaded)| loaded)
            .ok_or_else(|| failure("host_caller_inactive"))?;
        if !loaded.selection.authority_current() {
            return Err(failure("service_authority_changed"));
        }
        let root = loaded.selection.path.canonicalize()?;
        if root != loaded.selection.path {
            return Err(failure("service_source_path_changed"));
        }
        let mut files = BTreeMap::from([(
            root.join(&loaded.package.entrypoint),
            loaded.source.as_bytes().to_vec(),
        )]);
        for (name, value) in loaded.assets.iter() {
            let text = value["text"]
                .as_str()
                .ok_or_else(|| failure("service_asset_unavailable"))?;
            files.insert(root.join(name), text.as_bytes().to_vec());
        }
        Ok((root, files))
    }

    /// Keeps the latest structured-access receipts (HTTP, external files, MCP) for status.
    pub fn record_access(&mut self, receipt: Value) {
        self.access.push(receipt);
        if self.access.len() > 32 {
            self.access.remove(0);
        }
    }

    pub fn grants(&self, id: &str) -> Option<ModGrants> {
        self.loaded.get(id).filter(|m| m.error.is_none()).map(|m| {
            let current = m.selection.authority_current();
            ModGrants {
                surface_authority: crate::client_surface::Authority {
                    epoch: crate::client_surface::epoch(),
                    admission: crate::client_surface::admission(),
                    configuration: self.configuration_sha256.clone(),
                    source: m.selection.sha256.clone(),
                },
                api: m.package.api.clone(),
                source_sha256: m.selection.sha256.clone(),
                capabilities: m
                    .package
                    .capabilities
                    .iter()
                    .filter(|c| current || !AUTHORITY_CAPABILITIES.contains(&c.as_str()))
                    .cloned()
                    .collect(),
                exec_environment: m.package.exec_environment.clone(),
                os_access: m.package.os_access.clone().filter(|_| current),
                approves: m.package.approves.clone().filter(|_| current),
                http_access: m.package.http_access.clone().filter(|_| current),
                fs_access: m.package.fs_access.clone().filter(|_| current),
                mcp_servers: if current {
                    m.package.mcp_servers.clone()
                } else {
                    BTreeMap::new()
                },
                peer_access: m.package.peer_access.clone().filter(|_| current),
                autonomy: m.package.autonomy.clone().filter(|_| current),
            }
        })
    }

    /// Agent definitions registered by active mods, in load order.
    pub fn agent_definitions(&self) -> Vec<ModAgentDefinition> {
        self.active()
            .flat_map(|(id, m)| {
                m.registrations
                    .agents
                    .iter()
                    .map(|agent| ModAgentDefinition {
                        owner: id.to_owned(),
                        source_sha256: m.selection.sha256.clone(),
                        agent: agent.clone(),
                    })
            })
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
        self.loaded.get(id).is_some_and(|m| {
            m.error.is_none()
                && (m.registrations.events.iter().any(|e| e == event)
                    || event == "completion" && !m.registrations.completions.is_empty())
        })
    }

    /// Read-only launch identity for `Events.terminal.input.identity`.
    pub fn identity(
        &self,
        codex_version: &str,
        install_profile: Option<&str>,
        mode: &str,
    ) -> Value {
        let install_profile = install_profile.map_or("unreported", self::install_profile);
        json!({"codex_version": codex_version, "install_profile": install_profile, "mode": mode,
            "mods": {"installed": self.selections.0, "enabled": self.selections.1, "active": self.active().count(),
                "failed": self.loaded.len() - self.active().count() + self.rejected.len()}})
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn ui_revision(&self, id: &str) -> Option<u64> {
        self.loaded
            .get(id)?
            .ui
            .as_ref()?
            .1
            .lock()
            .ok()
            .map(|state| state.revision)
    }

    /// The UI state key and revision, or those a first invocation would bind, so binding alone is no change.
    fn ui_binding(&self, id: &str, thread: Option<&str>) -> Option<(String, Option<u64>)> {
        let loaded = self.loaded.get(id)?;
        if let Some((key, _)) = &loaded.ui {
            return Some((key.clone(), self.ui_revision(id)));
        }
        let key = self.ui_key(loaded, thread);
        let revision = UI_STATES
            .lock()
            .ok()?
            .get(&key)
            .and_then(std::sync::Weak::upgrade)
            .map_or(Some(0), |state| {
                state.lock().ok().map(|state| state.revision)
            });
        Some((key, revision))
    }

    pub fn state(&self, id: &str) -> Option<&Value> {
        self.loaded.get(id).map(|loaded| &loaded.state)
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
            .write_bytes("active-host.d.ts", output.as_bytes())?;
        crate::tool_schema::write_types(&self.store.root)
    }

    pub fn field_policies() -> Value {
        let mut policies = json!({
            "terminal": {"identity":"observe_only","presentation":"observe_only","greeting":"last_writer","session_title_suffix":"last_writer","welcome":"last_writer"},
            "prompt": {"thread_id":"observe_only","turn_id":"observe_only","original":"observe_only","effective":"observe_only","provenance":"observe_only"},
            "session": {"phase":"observe_only","thread_id":"observe_only","cause":"observe_only"},
            "agent": {"phase":"observe_only","agent":"observe_only"},
            "tool_call": {"call_id":"observe_only","agent_id":"observe_only","tool":"observe_only","arguments":"observe_only"},
            "intercept.tool": {"call_id":"observe_only","thread_id":"observe_only","agent_id":"observe_only","tool":"replaceable","arguments":"replaceable","schema":"observe_only","raw_arguments":"observe_only","batch":"observe_only"},
            "intercept.input": {"thread_id":"observe_only","text":"replaceable","revision":"observe_only","attachments":"observe_only","elements":"observe_only"},
            "intercept.composer_edit": {"source":"observe_only","caller":"observe_only","revision":"observe_only","edit":"replaceable"},
            "intercept.composer_key": {"key":"replaceable","text":"observe_only","revision":"observe_only","cursor":"observe_only"},
            "intercept.mention": {"thread_id":"observe_only","path":"replaceable"},
            "intercept.component_change": {"kind":"observe_only","id":"observe_only","from":"observe_only","to":"replaceable","origin":"observe_only"},
            "intercept.model_request": {"request_id":"observe_only","attempt":"observe_only","scope":"observe_only","routes":"observe_only","original":"observe_only","route":"replaceable","model":"observe_only","provider":"observe_only","effort":"replaceable","sections":"replaceable","tools":"observe_only"},
            "intercept.response_stream": {"request_id":"observe_only","scope":"observe_only","synthetic":"observe_only","kind":"observe_only","index":"observe_only","item_id":"observe_only","protected":"observe_only","call_id":"observe_only","format":"observe_only","text":"replaceable","tool":"replaceable","arguments":"replaceable","status":"observe_only","usage":"observe_only"},            "tool_exposure": {"thread_id":"observe_only","ledger":"observe_only","available":"observe_only","enable":"alterable"},
            "tool_result": {"call_id":"observe_only","agent_id":"observe_only","thread_id":"observe_only","tool":"observe_only","outcome":"observe_only","call_sha256":"observe_only","result_sha256":"observe_only","result_complete":"observe_only"},
            "host_operation": {"phase":"observe_only","caller":"observe_only","operation":"observe_only","arguments":"observe_only","result":"observe_only","error":"observe_only"}
        });
        for (surface, fields) in [
            (
                "intercept.host_operation",
                json!({"operation":"observe_only","namespace":"observe_only","arguments":"replaceable"}),
            ),
            ("intercept.command_list", json!({"commands":"replaceable"})),
            (
                "intercept.command",
                json!({"command":"observe_only","args":"replaceable","owner":"observe_only","immediate":"observe_only","active_turn":"observe_only"}),
            ),
            ("intercept.config_list", json!({"rows":"replaceable"})),
            (
                "intercept.config_set",
                json!({"key":"observe_only","value":"replaceable","original":"observe_only","source":"observe_only","scope":"observe_only"}),
            ),
            (
                "intercept.admission",
                json!({"package":"observe_only","reason":"observe_only"}),
            ),
            (
                "intercept.model_send",
                json!({"request_id":"observe_only","attempt":"observe_only","scope":"observe_only","provider":"observe_only","route":"observe_only","model":"observe_only","page":"observe_only","pages":"observe_only","cached":"observe_only","segments":"observe_only","opaque":"observe_only","opaque_total":"observe_only"}),
            ),
            (
                "intercept.agent_offers",
                json!({"thread_id":"observe_only","offers":"replaceable"}),
            ),
            (
                "intercept.agent_spawn",
                json!({"origin":"observe_only","caller":"observe_only","thread_id":"observe_only","agent_id":"observe_only","definition":"replaceable","prompt":"replaceable","model":"replaceable","effort":"replaceable","cwd":"replaceable","tools":"replaceable"}),
            ),
            (
                "intercept.peer_send",
                json!({"to":"observe_only","correlation":"observe_only","data":"replaceable"}),
            ),
            (
                "intercept.peer_receive",
                json!({"id":"observe_only","from":"observe_only","to":"observe_only","correlation":"observe_only","untrusted":"observe_only","data":"replaceable"}),
            ),
            (
                "intercept.turn_stop",
                json!({"thread_id":"observe_only","turn_id":"observe_only","message":"observe_only","continued":"observe_only","limit":"observe_only","provenance":"observe_only"}),
            ),
            (
                "intercept.elicitation",
                json!({"thread_id":"observe_only","turn_id":"observe_only","server":"observe_only","request_id":"observe_only","mode":"observe_only","message":"observe_only","schema":"observe_only"}),
            ),
            (
                "intercept.compaction",
                json!({"thread_id":"observe_only","turn_id":"observe_only","trigger":"observe_only","reason":"observe_only","phase":"observe_only","implementation":"observe_only","budget":"observe_only","items":"observe_only","history":"observe_only","summary_prompt":"replaceable"}),
            ),
        ] {
            policies[surface] = fields;
        }
        policies
    }

    pub fn status(&self) -> Value {
        let mut status = json!({"api": MOD_API_VERSION, "host": {"codex":CODEX_HOST_RELEASE,"omd":OMD_HOST_RELEASE,
            "package_schema":MOD_PACKAGE_SCHEMA_VERSION,"state_storage_schema":MOD_STATE_STORAGE_SCHEMA_VERSION,
            "installed_contract_types":INSTALLED_CONTRACT_TYPES_VERSION,"features":MOD_HOST_FEATURES,
            "supported_apis":SUPPORTED_MOD_APIS.iter().map(|(version,stability,support_until)|
                json!({"version":version,"stability":stability,"support_until":support_until})).collect::<Vec<_>>()},
            "generation": self.generation, "reload_error": self.reload_error,
            "authority": crate::broker::status(), "order": self.order, "rejected": self.rejected, "field_policies": Self::field_policies(),
            "installed_contract_types": self.store.root.join("installed-contracts.d.ts"),
            "active_host_types": self.store.root.join("active-host.d.ts"),
            "service_calls": self.service_calls,
            "chains": self.chains,
            "mods": self.loaded.iter().map(|(id, m)| { let mut status = json!({"id": id, "version": m.package.version,
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
                "registrations": m.registrations, "telemetry":m.telemetry, "error": m.error});
                status["authority"] = json!({"os_access": m.package.os_access, "approves": m.package.approves,
                    "http_access": m.package.http_access, "fs_access": m.package.fs_access, "mcp_servers": m.package.mcp_servers,
                    "policy": m.package.policy, "peer_access": m.package.peer_access,
                    "autonomy": m.package.autonomy, "codex_config": m.package.codex_config, "withheld": m.withheld,
                    "expires_at": m.selection.expires_at, "current": m.selection.authority_current(),
                    "exposure": authority_exposure(&m.selection.capabilities)});
                status }).collect::<Vec<_>>()});
        status["request_policy_unavailable"] =
            json!(self.send_policy().and_then(|policy| policy.unavailable));
        status["access"] = json!(self.access);
        status["tool_types"] = json!(crate::tool_schema::types_path(&self.store.root));
        status["managed"] = json!(self.managed.as_ref().map(|managed| json!({
            "origin": managed.origin, "sha256": managed.sha256, "policy": managed.policy,
            "unserved": self.unserved.iter().map(|(id, _, reason)| json!({"id": id, "reason": reason}))
                .collect::<Vec<_>>()})));
        status
    }
}

fn validate_ui_state(encoded: &str) -> Result<Value> {
    if encoded.len() > 65_536 {
        return Err(failure("ui_state_limit"));
    }
    serde_json::from_str(encoded).map_err(|_| failure("ui_state_invalid_json"))
}

#[cfg(test)]
#[test]
fn ui_state_serialized_boundaries() {
    let cases: Value = serde_json::from_str(include_str!("../tests/fixtures/ui_state.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let encoded = format!(
            "{}{}{}",
            case["prefix"].as_str().unwrap(),
            case["unit"]
                .as_str()
                .unwrap()
                .repeat(case["repeat"].as_u64().unwrap() as usize),
            case["suffix"].as_str().unwrap()
        );
        assert_eq!(
            validate_ui_state(&encoded).is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
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
