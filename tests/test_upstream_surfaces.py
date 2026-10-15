import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("upstream_surfaces", ROOT / "scripts/upstream_surfaces.py")
surfaces = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(surfaces)

PROTOCOL = '''
client_request_definitions! {
    Initialize => "initialize" {
        params: v1::InitializeParams,
        response: v1::InitializeResponse,
    },
    /// Docs mention "braces {" in a string.
    #[experimental("thread/fork")]
    ThreadFork => "thread/fork" {
        params: v2::ThreadForkParams,
        serialization: thread_or_path(params.thread_id, params.path),
        response: v2::ThreadForkResponse,
    },
}
server_request_definitions! {
    CommandExecutionRequestApproval => "item/commandExecution/requestApproval" {
        params: v2::P,
        response: v2::R,
    },
}
server_notification_definitions! {
    Error => "error" (v2::ErrorNotification),
    #[experimental("thread/queue/changed")]
    ThreadQueueChanged => "thread/queue/changed" (v2::ThreadQueueChangedNotification),
}
client_notification_definitions! {
    Initialized,
}
'''
PARAMS = '''
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadForkParams {
    pub thread_id: String,
    /// Rollout path, renamed.
    #[serde(rename = "path")]
    pub rollout: Option<String>,
    #[serde(skip)]
    pub internal: bool,
    #[serde(flatten)]
    pub overrides: Overrides,
}
#[serde(rename_all = "camelCase")]
pub struct Overrides {
    pub base_model: Option<String>,
}
'''
TYPES = '''
pub enum EventMsg {
    /// Error text with a comma, inside docs.
    Error(ErrorEvent),
    #[serde(rename = "turn_started", alias = "task_started")]
    TurnStarted(TurnStartedEvent),
    ShutdownComplete,
    PlanDelta { delta: String, items: Vec<(u8, u8)> },
}
pub enum Op {
    Interrupt,
    TurnInput { request: Box<TurnInputRequest>, reply: oneshot::Sender<CodexResult<TurnInputSubmission>> },
}
pub enum HookEventName { PreToolUse, Stop }
pub enum AskForApproval { Never, OnRequest }
pub enum ReviewDecision { Approved, Denied { rejection: String } }
'''
SLASH = '''
pub enum SlashCommand {
    // DO NOT ALPHA-SORT!
    Model,
    #[strum(serialize = "setup-default-sandbox")]
    ElevateSandbox,
    #[strum(to_string = "pwd", serialize = "cwd")]
    Pwd,
    DebugConfig,
}
'''
BINDINGS = '''
macro_rules! define_runtime_action_bindings { () => {} }
define_runtime_action_bindings! {
    "global" => Global, app, global [
        open_agents,
        open_warnings => runtime_only,
    ],
    "chat" => Voice, chat, chat [toggle_voice_mute],
}
'''
VIEW = '''
impl BottomPaneView for ApprovalOverlay {}
pub(crate) const MODEL_SELECTION_VIEW_ID: &str = "model-selection";
#[cfg(test)]
mod tests {
    impl BottomPaneView for TestOnlyView {}
}
'''
SCHEMA = {
    "definitions": {"Tui": {"properties": {"theme": {}, "keymap": {}}}},
    "properties": {"model": {"type": "string"}, "tui": {"allOf": [{"$ref": "#/definitions/Tui"}]}},
}


def build(root):
    files = {
        surfaces.PROTOCOL: PROTOCOL,
        surfaces.PROTOCOL_TYPES: TYPES,
        "codex-rs/protocol/src/config_types.rs": "pub enum SandboxMode { ReadOnly, WorkspaceWrite }\n",
        "codex-rs/core/src/tools/approvals.rs": "pub(crate) enum ApprovalAction { ExecCommand { id: String }, #[cfg(unix)] Execve { id: String } }\n",
        "codex-rs/tui/src/pager_overlay.rs": "pub(crate) enum Overlay { Transcript(TranscriptOverlay) }\n",
        "codex-rs/tui/src/onboarding/onboarding_screen.rs": "enum Step { Welcome(WelcomeWidget) }\n",
        "codex-rs/tui/src/slash_command.rs": SLASH,
        "codex-rs/tui/src/keymap/bindings.rs": BINDINGS,
        "codex-rs/tui/src/bottom_pane/approval_overlay.rs": VIEW,
        "codex-rs/tui/src/bottom_pane/view_tests.rs": "impl BottomPaneView for ExcludedView {}\n",
        "codex-rs/ext/extension-api/src/contributors.rs": "pub trait ToolContributor: Send + Sync {}\n",
        "codex-rs/core/src/session/mod.rs": "impl Session {\n    pub async fn request_command_approval(&self) {}\n    pub async fn request_user_input_response(&self) {}\n}\n",
        "codex-rs/core/src/session/mcp.rs": "",
        "codex-rs/core/src/mcp_tool_call.rs": "pub(crate) async fn request_mcp_tool_user_approval(\n) {}\n",
        "codex-rs/core/config.schema.json": json.dumps(SCHEMA),
        surfaces.PROTOCOL_ROOT + "/v2/thread.rs": PARAMS,
    }
    for name, text in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(text)


class UpstreamSurfaceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        build(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def ids(self):
        found, missing = surfaces.extract(self.root)
        self.assertEqual(missing, [])
        return {entry["id"]: entry for entry in found}

    def test_extracts_every_surface_kind(self):
        ids = self.ids()
        self.assertEqual(set(ids), {
            "app_request:initialize", "app_request:thread/fork", "app_server_request:item/commandExecution/requestApproval",
            "app_notification:error", "app_notification:thread/queue/changed", "app_client_notification:Initialized",
            "event:Error", "event:TurnStarted", "event:ShutdownComplete", "event:PlanDelta", "op:Interrupt", "op:TurnInput",
            "hook_event:PreToolUse", "hook_event:Stop", "approval_policy:Never", "approval_policy:OnRequest",
            "review_decision:Approved", "review_decision:Denied", "sandbox_mode:ReadOnly", "sandbox_mode:WorkspaceWrite",
            "approval_action:ExecCommand", "approval_action:Execve", "tui_view:Overlay::Transcript", "tui_view:Step::Welcome",
            "slash_command:model", "slash_command:setup-default-sandbox", "slash_command:pwd", "slash_command:debug-config",
            "keybinding:global.open_agents", "keybinding:global.open_warnings", "keybinding:chat.toggle_voice_mute",
            "tui_view:ApprovalOverlay", "tui_list:model-selection", "extension_trait:ToolContributor",
            "approval_request:request_command_approval", "approval_request:request_mcp_tool_user_approval",
            "config_key:model", "config_key:tui", "config_key:tui.theme", "config_key:tui.keymap",
        })
        self.assertTrue(ids["app_request:thread/fork"]["experimental"])
        self.assertFalse(ids["app_request:initialize"]["experimental"])

    def table(self, **surfaces_):
        entries = {name: {"route": "r"} for name in self.ids()}
        entries.update(surfaces_)
        return {"routes": {"r": "route"}, "exclusions": {"x": "reason"}, "surfaces": {k: v for k, v in entries.items() if v is not None}}

    def test_complete_table_has_no_gap(self):
        report = surfaces.check(self.root, self.table(**{"slash_command:model": {"exclude": "x"}}))
        self.assertEqual(report["gap"], 0)
        self.assertEqual(report["by_kind"]["slash_command"], {"surfaces": 4, "routed": 3, "excluded": 1})

    def test_new_upstream_surface_is_flagged(self):
        report = surfaces.check(self.root, self.table(**{"slash_command:pwd": None}))
        self.assertEqual([entry["id"] for entry in report["unrouted"]], ["slash_command:pwd"])
        self.assertEqual(report["gap"], 1)

    def test_invalid_and_removed_entries_are_reported(self):
        table = self.table(**{"slash_command:model": {"route": "missing"}, "slash_command:pwd": {"route": "r", "exclude": "x"},
                              "slash_command:gone": {"route": "r"}, "slash_command:omd-added": {"route": "r", "omd": True}})
        report = surfaces.check(self.root, table)
        self.assertEqual(sorted(report["invalid"]), ["slash_command:model", "slash_command:pwd"])
        self.assertEqual(report["removed_upstream"], ["slash_command:gone"])
        self.assertEqual(report["gap"], 2)

    def test_patterns_cover_open_families(self):
        table = self.table(**{"config_key:tui.theme": None, "config_key:tui.keymap": None})
        table["patterns"] = {"config_key:tui.*": {"route": "r"}}
        self.assertEqual(surfaces.check(self.root, table)["gap"], 0)

    def test_new_request_parameter_is_flagged(self):
        self.assertEqual(self.ids()["app_request:thread/fork"]["params"], ["baseModel", "path", "threadId"])
        routed = {"route": "app.request", "fields": ["threadId"], "refuse": ["path", "baseModel"]}
        table = self.table(**{"app_request:thread/fork": routed})
        table["routes"]["app.request"] = "route"
        self.assertEqual(surfaces.check(self.root, table)["gap"], 0)
        routed["refuse"] = ["path"]
        report = surfaces.check(self.root, table)
        self.assertEqual(report["param_drift"], [{"id": "app_request:thread/fork", "fields": ["baseModel"]}])
        self.assertEqual(report["gap"], 1)

    def test_moved_upstream_source_is_a_gap(self):
        table = self.table()
        (self.root / "codex-rs/tui/src/slash_command.rs").unlink()
        report = surfaces.check(self.root, table)
        self.assertIn("codex-rs/tui/src/slash_command.rs::SlashCommand", report["missing_sources"])
        self.assertGreater(report["gap"], 0)


class RouteTableTests(unittest.TestCase):
    def test_checked_in_table_is_consistent(self):
        table = surfaces.load_table(surfaces.TABLE)
        lock = json.loads((ROOT / "upstream.lock.json").read_text())
        self.assertEqual(table["upstream"], {"tag": lock["tag"], "commit": lock["commit"]})
        for name, entry in table["surfaces"].items():
            route, reason = entry.get("route"), entry.get("exclude")
            self.assertTrue(bool(route) != bool(reason), name)
            self.assertIn(route or reason, table["routes"] if route else table["exclusions"], name)
            if route == "app.request" and "class" in entry:
                self.assertTrue(set(entry["contexts"]) <= {"user", "event"}, name)

    def test_embedded_route_table_matches_the_mapping(self):
        embedded = json.loads((ROOT / "runtime/omd/src/app_routes.json").read_text())
        self.assertEqual(surfaces.host_table(surfaces.load_table(surfaces.TABLE)), embedded,
                         "runtime/omd/src/app_routes.json is stale; regenerate it with upstream_surfaces.py host-table")


if __name__ == "__main__":
    unittest.main()
