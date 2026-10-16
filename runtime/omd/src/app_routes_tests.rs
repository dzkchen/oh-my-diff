use super::*;

struct Fixture {
    capabilities: BTreeSet<String>,
    visible: BTreeSet<String>,
    roots: Vec<PathBuf>,
    routes: Vec<(String, String)>,
    _dir: tempfile::TempDir,
}

fn fixture(capabilities: &[&str]) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::create_dir_all(root.join("sub")).unwrap();
    Fixture {
        capabilities: capabilities.iter().map(|c| c.to_string()).collect(),
        visible: ["other".to_owned()].into(),
        roots: vec![root],
        routes: vec![("gpt-test".to_owned(), "openai".to_owned())],
        _dir: dir,
    }
}

impl Fixture {
    fn caller(&self, context: InvocationContext) -> AppCaller<'_> {
        AppCaller {
            capabilities: &self.capabilities,
            context,
            current_thread: Some("current"),
            visible_threads: &self.visible,
            roots: &self.roots,
            routes: &self.routes,
        }
    }

    fn code(&self, method: &str, params: Value, context: InvocationContext) -> String {
        match authorize(method, &params, &self.caller(context)) {
            Ok(_) => "ok".to_owned(),
            Err(error) => error.to_string().split(':').next().unwrap().to_owned(),
        }
    }
}

use InvocationContext::{Event, User};

#[test]
fn capability_context_and_unrouted_methods_are_enforced() {
    let f = fixture(&["threads", "sessions"]);
    assert_eq!(
        f.code("command/exec", json!({}), User),
        "app_method_unrouted"
    );
    assert_eq!(
        f.code("model/list", json!({}), User),
        "app_capability_missing"
    );
    assert_eq!(
        f.code(
            "turn/start",
            json!({"threadId": "current", "input": []}),
            Event
        ),
        "app_context_user_only"
    );
    assert_eq!(
        f.code(
            "turn/start",
            json!({"threadId": "current", "input": []}),
            User
        ),
        "ok"
    );
    assert_eq!(
        f.code(
            "turn/steer",
            json!({"threadId": "current", "input": [], "expectedTurnId": "t"}),
            Event
        ),
        "ok"
    );
    assert_eq!(f.code("thread/list", json!(null), Event), "ok");
    assert_eq!(
        f.code("thread/list", json!([1]), Event),
        "app_params_invalid"
    );
}

#[test]
fn authority_fields_are_refused_but_null_is_absent() {
    let f = fixture(&["threads"]);
    for field in [
        "approvalPolicy",
        "sandboxPolicy",
        "permissions",
        "toolOutput",
        "serviceTier",
        "parentTurnId",
        "rootTurnId",
        "futureAuthority",
    ] {
        assert_eq!(
            f.code(
                "turn/start",
                json!({"threadId": "current", "input": [], field: "x"}),
                User
            ),
            "app_param_refused",
            "{field}"
        );
    }
    assert_eq!(
        f.code(
            "thread/resume",
            json!({"threadId": "other", "history": []}),
            User
        ),
        "app_param_refused"
    );
    assert_eq!(
        f.code(
            "thread/fork",
            json!({"threadId": "other", "path": "/tmp/rollout.jsonl"}),
            User
        ),
        "app_param_refused"
    );
    assert_eq!(
        f.code(
            "turn/start",
            json!({"threadId": "current", "input": [], "sandboxPolicy": null}),
            User
        ),
        "ok"
    );
}

#[test]
fn thread_scope_binds_current_and_visible_threads() {
    let f = fixture(&["threads", "sessions"]);
    assert_eq!(
        f.code(
            "turn/interrupt",
            json!({"threadId": "current", "turnId": "t"}),
            Event
        ),
        "ok"
    );
    assert_eq!(
        f.code(
            "turn/interrupt",
            json!({"threadId": "other", "turnId": "t"}),
            Event
        ),
        "app_thread_out_of_scope"
    );
    assert_eq!(
        f.code("thread/read", json!({"threadId": "other"}), Event),
        "ok"
    );
    assert_eq!(
        f.code("thread/read", json!({"threadId": "stranger"}), Event),
        "app_thread_out_of_scope"
    );
    assert_eq!(
        f.code("thread/read", json!({}), Event),
        "app_thread_out_of_scope"
    );
    assert_eq!(f.code("thread/start", json!({}), User), "ok");
    let fixture = fixture(&["threads"]);
    let move_before = |before: &str| {
        fixture.code(
            "thread/section/move",
            json!({"threadId": "current", "sectionId": "s", "beforeThreadId": before}),
            Event,
        )
    };
    assert_eq!(move_before("other"), "ok");
    assert_eq!(move_before("stranger"), "app_thread_out_of_scope");
}

#[test]
fn every_thread_addressed_route_has_a_scope() {
    let unscoped: Vec<_> = TABLE
        .requests
        .iter()
        .filter(|(method, route)| {
            route
                .fields
                .iter()
                .any(|field| field.ends_with("ThreadId") || field == "threadId")
                && route.scope.is_none()
                && !method.starts_with("app/")
                && !matches!(
                    method.as_str(),
                    "account/usage/read"
                        | "experimentalFeature/list"
                        | "mcpServerStatus/list"
                        | "thread/list"
                )
        })
        .map(|(method, _)| method.as_str())
        .collect();
    assert_eq!(unscoped, Vec::<&str>::new());
}

#[test]
fn root_fields_stay_inside_the_session_roots() {
    let f = fixture(&["threads", "config"]);
    let root = f.roots[0].display().to_string();
    assert_eq!(f.code("thread/start", json!({"cwd": root}), User), "ok");
    assert_eq!(f.code("thread/start", json!({"cwd": "sub"}), User), "ok");
    assert_eq!(
        f.code("thread/start", json!({"cwd": "/"}), User),
        "app_root_invalid"
    );
    assert_eq!(
        f.code("thread/start", json!({"cwd": "sub/../../"}), User),
        "app_root_invalid"
    );
    assert_eq!(
        f.code("thread/start", json!({"cwd": "missing"}), User),
        "app_root_invalid"
    );
    assert_eq!(
        f.code("config/read", json!({"cwd": "/"}), Event),
        "app_root_invalid"
    );
}

#[test]
fn config_writes_refuse_authority_and_unknown_keys() {
    let f = fixture(&["config.write"]);
    let write = |key: &str| {
        f.code(
            "config/value/write",
            json!({"keyPath": key, "value": 1, "mergeStrategy": "replace"}),
            User,
        )
    };
    assert_eq!(write("model"), "ok");
    assert_eq!(write("tui.theme"), "ok");
    assert_eq!(write("tui.keymap.global.copy"), "ok");
    assert_eq!(write("sandbox_mode"), "app_config_key_refused");
    assert_eq!(write("mcp_servers.x.command"), "app_config_key_refused");
    assert_eq!(write("mcp_servers.x.enabled"), "ok");
    assert_eq!(write("mcp_servers.x"), "app_config_key_refused");
    assert_eq!(write("mcp_servers"), "app_config_key_refused");
    assert_eq!(write("plugins.p@m.enabled"), "ok");
    assert_eq!(write("plugins.p@m.mcp_servers.s.disabled_tools"), "ok");
    assert_eq!(
        write("plugins.p@m.mcp_servers.s.default_tools_approval_mode"),
        "app_config_key_refused"
    );
    assert_eq!(
        write("plugins.p@m.mcp_servers.s.tools.t.approval_mode"),
        "app_config_key_refused"
    );
    assert_eq!(write("plugins"), "app_config_key_refused");
    assert_eq!(
        write("profiles.work.approval_policy"),
        "app_config_key_refused"
    );
    assert_eq!(write("tui.unknown_key"), "app_config_key_refused");
    assert_eq!(write("not_a_key"), "app_config_key_refused");
    assert_eq!(write("tui..theme"), "app_config_key_refused");
    let table = |key: &str, value: Value| {
        f.code(
            "config/value/write",
            json!({"keyPath": key, "value": value, "mergeStrategy": "upsert"}),
            User,
        )
    };
    assert_eq!(write("features.goals"), "ok");
    assert_eq!(
        table("features", json!({"goals": true})),
        "app_config_key_refused"
    );
    assert_eq!(
        table(
            "agents",
            json!({"reviewer": {"config_file": "/tmp/role.toml"}})
        ),
        "app_config_key_refused"
    );
    assert_eq!(table("agents", json!({"max_depth": 2})), "ok");
    assert_eq!(table("tui", json!({"theme": "x"})), "ok");
    assert_eq!(
        f.code(
            "config/batchWrite",
            json!({"edits": [{"keyPath": "tui", "value": {"theme": "x", "keymap": {"global": {"copy": "c"}}}}]}),
            User
        ),
        "ok"
    );
    assert_eq!(
        f.code(
            "config/batchWrite",
            json!({"edits": [{"keyPath": "agents", "value": {"enabled": true, "r": {"config_file": "x"}}}]}),
            User
        ),
        "app_config_key_refused"
    );
    assert_eq!(
        f.code(
            "config/value/write",
            json!({"keyPath": "model", "value": 1, "filePath": "/etc/x"}),
            User
        ),
        "app_param_refused"
    );
    let batch = json!({"edits": [{"keyPath": "model", "value": 1}, {"keyPath": "sandbox_mode", "value": "danger-full-access"}]});
    assert_eq!(
        f.code("config/batchWrite", batch, User),
        "app_config_key_refused"
    );
    assert_eq!(
        f.code(
            "experimentalFeature/enablement/set",
            json!({"enablement": {"goals": true}}),
            User
        ),
        "ok"
    );
    assert_eq!(
        f.code(
            "experimentalFeature/enablement/set",
            json!({"enablement": {"network_proxy": true}}),
            User
        ),
        "app_config_key_refused"
    );
    assert_eq!(
        f.code("config/value/write", json!({"value": 1}), User),
        "app_params_invalid"
    );
    assert_eq!(
        f.code(
            "config/value/write",
            json!({"keyPath": "developer_instructions", "value": "Be brief.\n<redacted>\n"}),
            User
        ),
        "app_config_value_redacted"
    );
    assert_eq!(
        f.code(
            "config/batchWrite",
            json!({"edits": [{"keyPath": "tui", "value": {"theme": "<redacted>"}}]}),
            User
        ),
        "app_config_value_redacted"
    );
}

#[test]
fn queue_coalesces_deltas_and_drops_oldest_with_a_count() {
    let mut queue = NotificationQueue::new(3, 1 << 20);
    let delta = |text: &str| json!({"threadId": "t", "turnId": "u", "itemId": "i", "delta": text});
    queue.push("item/agentMessage/delta", delta("a"));
    queue.push("item/agentMessage/delta", delta("b"));
    queue.push(
        "item/agentMessage/delta",
        json!({"threadId": "t", "turnId": "u", "itemId": "j", "delta": "c"}),
    );
    let drained = queue.drain();
    assert_eq!(drained.len(), 2);
    assert_eq!(drained[0].params["delta"], "ab");
    assert_eq!(
        (drained[0].coalesced, drained[0].thread_id.as_deref()),
        (1, Some("t"))
    );
    for n in 0..5 {
        queue.push("turn/started", json!({"threadId": "t", "n": n}));
    }
    let drained = queue.drain();
    assert_eq!(
        (
            drained.len(),
            drained[0].dropped,
            drained[0].params["n"].as_i64()
        ),
        (3, 2, Some(2))
    );
    queue.push("turn/started", json!({}));
    assert_eq!(queue.drain()[0].dropped, 0);
}

#[test]
fn mod_responses_never_grant_authority() {
    let allowed = [
        (
            "item/commandExecution/requestApproval",
            json!({"decision": "decline"}),
        ),
        (
            "item/fileChange/requestApproval",
            json!({"decision": "cancel"}),
        ),
        (
            "item/permissions/requestApproval",
            json!({"permissions": {}}),
        ),
        (
            "mcpServer/elicitation/request",
            json!({"action": "decline", "content": null}),
        ),
        (
            "item/tool/requestUserInput",
            json!({"answers": {"q1": {"answers": ["No reply; use your judgment."]}}}),
        ),
    ];
    for (method, result) in allowed {
        assert_eq!(response_allowed(method, &result), Ok(()), "{method}");
    }
    let refused = [
        (
            "item/commandExecution/requestApproval",
            json!({"decision": "accept"}),
        ),
        (
            "item/commandExecution/requestApproval",
            json!({"decision": "acceptForSession"}),
        ),
        (
            "item/commandExecution/requestApproval",
            json!({"decision": "decline", "extra": 1}),
        ),
        (
            "item/fileChange/requestApproval",
            json!({"decision": "accept"}),
        ),
        (
            "item/permissions/requestApproval",
            json!({"permissions": {"network": {"enabled": true}}}),
        ),
        (
            "item/permissions/requestApproval",
            json!({"permissions": {}, "scope": "session"}),
        ),
        (
            "mcpServer/elicitation/request",
            json!({"action": "accept", "content": {}}),
        ),
        (
            "item/tool/requestUserInput",
            json!({"answers": {"q1": {"answers": [1]}}}),
        ),
        (
            "item/tool/requestUserInput",
            json!({"answers": {"q1": {"answers": ["x".repeat(20_000)]}}}),
        ),
        ("thread/start", json!({})),
    ];
    for (method, result) in refused {
        assert!(
            response_allowed(method, &result)
                .unwrap_err()
                .starts_with("app_response_refused"),
            "{method} {result}"
        );
    }
}
