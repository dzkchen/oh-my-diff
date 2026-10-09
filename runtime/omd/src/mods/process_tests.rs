use super::WARM;
use super::command;
use super::evaluate_warm;
use serde_json::json;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

#[test]
fn warm_runner_retirement_joins_readers_and_retains_bounded_diagnostics() {
    let node = PathBuf::from(std::env::var_os("OMD_TEST_NODE").unwrap());
    let mut runner = super::warm_runner(&node, "invalid-request").unwrap();
    let (output, _) = super::converse(
        &mut runner.stdin,
        &runner.lines,
        b"{\n",
        Duration::from_secs(2),
        &|| true,
        &mut |_| unreachable!(),
    );
    assert!(output.unwrap().is_empty());
    let errors = runner.stop();
    assert!(errors.len() <= 769);
    assert!(String::from_utf8_lossy(&errors).contains("SyntaxError"));
}

#[test]
fn render_heap_exhaustion_retains_the_memory_failure_diagnostic() {
    let node = PathBuf::from(std::env::var_os("OMD_TEST_NODE").unwrap());
    let input = json!({"component":"tool_call"});
    let request = json!({"source":"export default api => api.intercept('render', () => { const arrays = []; for (let i = 0; i < 100; i++) arrays.push(new Array(1000000).fill(i)); return { count: arrays.length }; });",
        "filename":"/fixture/index.ts", "api":crate::MOD_API_VERSION, "capabilities":["terminal"],
        "surface":{"events":{},"replacements":[],"middleware":[],"intercept":{"render":"terminal"},"state":"store","contracts":"contracts"},
        "state":null,"settings":{},"event":"intercept","name":"0","interactive":true,"serve":true,"hook_budget_ms":1000,
        "payload":{"surface":"render","input":input,"original":input,"origin":{"caller":"engine"}}});
    let error = evaluate_warm(
        &node,
        "heap-exhaustion",
        &request,
        Duration::from_secs(2),
        &|| true,
        &mut |_| unreachable!(),
    )
    .unwrap_err();
    assert!(
        error.to_string().starts_with("mod_out_of_memory:"),
        "{error}"
    );
    assert!(
        !WARM
            .lock()
            .unwrap()
            .iter()
            .any(|runner| runner.key == "heap-exhaustion")
    );
}

#[test]
fn render_reuse_preserves_activation_state_across_suspensions() {
    let node = PathBuf::from(std::env::var_os("OMD_TEST_NODE").unwrap());
    let input = json!({"component":"tool_call"});
    let mut request = json!({"source":"export default api => { const a = api.atom('value', 0); a.set(a.get() + 1); api.intercept('render', (e, next) => e.replay ? next({...e, value: a.get()}) : {value: a.get()}); };",
        "filename":"/fixture/index.ts", "api":crate::MOD_API_VERSION, "capabilities":["terminal","store"],
        "surface":{"events":{},"replacements":[],"middleware":[],"intercept":{"render":"terminal"},"state":"store","contracts":"contracts"},
        "state":{"value":0}, "settings":{}, "event":"intercept", "name":"0", "interactive":true,"serve":true,"hook_budget_ms":1000,
        "payload":{"surface":"render","input":input,"original":input,"origin":{"caller":"engine"}}});
    for _ in 0..2 {
        let reply = evaluate_warm(
            &node,
            "activation-state",
            &request,
            Duration::from_secs(2),
            &|| true,
            &mut |_| unreachable!(),
        )
        .unwrap();
        assert_eq!(reply["value"]["result"]["value"], 1);
        assert_eq!(reply["state"], json!({"value":0}));
    }
    request["payload"]["input"]["replay"] = json!(true);
    let reply = evaluate_warm(
        &node,
        "activation-state",
        &request,
        Duration::from_secs(2),
        &|| true,
        &mut |_| unreachable!(),
    )
    .unwrap();
    assert!(!reply["host_call"].is_null());
    let pid = || {
        WARM.lock()
            .unwrap()
            .iter()
            .find(|runner| runner.key == "activation-state")
            .map(|runner| runner.child.id())
    };
    let suspended = pid().expect("a suspended render keeps its runner");
    request["receipts"] =
        json!([{"call":reply["host_call"],"value":{"result":{"value":1},"trace":[]}}]);
    let replay = evaluate_warm(
        &node,
        "activation-state",
        &request,
        Duration::from_secs(2),
        &|| true,
        &mut |_| unreachable!(),
    )
    .unwrap();
    assert_eq!(replay["value"]["result"]["value"], 1);
    assert_eq!(pid(), Some(suspended));
}

#[test]
fn crashed_render_runner_reports_its_diagnostic_without_host_details() {
    let node = PathBuf::from(std::env::var_os("OMD_TEST_NODE").unwrap());
    let input = json!({"component":"tool_call"});
    let request = json!({"source":"export default api => api.intercept('render', () => { throw { get stack() { throw new Error('unprintable'); } }; });",
        "filename":"/fixture/index.ts", "api":crate::MOD_API_VERSION, "capabilities":["terminal"],
        "surface":{"events":{},"replacements":[],"middleware":[],"intercept":{"render":"terminal"},"state":"store","contracts":"contracts"},
        "state":null,"settings":{},"event":"intercept","name":"0","interactive":true,"serve":true,"hook_budget_ms":1000,
        "payload":{"surface":"render","input":input,"original":input,"origin":{"caller":"engine"}}});
    let error = evaluate_warm(
        &node,
        "crashed-runner",
        &request,
        Duration::from_secs(2),
        &|| true,
        &mut |_| unreachable!(),
    )
    .unwrap_err()
    .to_string();
    assert!(error.starts_with("mod_process_failed: "), "{error}");
    assert!(error.len() > "mod_process_failed: ".len(), "{error}");
    assert!(!error.contains("crashed-runner"), "{error}");
    assert!(!error.contains(&*node.to_string_lossy()), "{error}");
}

#[test]
fn render_registration_mutations_are_refused_and_invalidation_retires_runner() {
    let node = PathBuf::from(std::env::var_os("OMD_TEST_NODE").unwrap());
    for mutation in [
        "api.on('terminal', () => {})",
        "api.middleware('approval', () => {})",
        "api.replace('completion', () => {})",
        "api.tool({name:'late'}, () => {})",
        "api.command('late', () => {})",
    ] {
        let input = json!({"component":"tool_call"});
        let request = json!({"source":format!("export default api => api.intercept('render', () => {{ {mutation}; return {{}}; }});"),
            "filename":"/fixture/index.ts", "api":crate::MOD_API_VERSION, "capabilities":["terminal","tools","commands","middleware","approvals"],
            "surface":{"events":{"terminal":"terminal","completion":"terminal"},"replacements":["completion"],"middleware":["approval"],"intercept":{"render":"terminal"},"state":"store","contracts":"contracts"},
            "state":null,"settings":{},"event":"intercept","name":"0","interactive":true,"serve":true,"hook_budget_ms":1000,
            "payload":{"surface":"render","input":input,"original":input,"origin":{"caller":"engine"}}});
        let error = evaluate_warm(
            &node,
            "registration-mutation",
            &request,
            Duration::from_secs(2),
            &|| true,
            &mut |_| unreachable!(),
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("registration_outside_activation"),
            "{error}"
        );
        assert!(
            !WARM
                .lock()
                .unwrap()
                .iter()
                .any(|runner| runner.key == "registration-mutation")
        );
    }
    let input = json!({"component":"tool_call"});
    let request = json!({"source":"export default api => { const spec = {name:'original'}; api.tool(spec, () => {}); api.intercept('render', () => { spec.name = 'changed'; return {}; }); };",
        "filename":"/fixture/index.ts", "api":crate::MOD_API_VERSION, "capabilities":["terminal","tools"],
        "surface":{"events":{},"replacements":[],"middleware":[],"intercept":{"render":"terminal"},"state":"store","contracts":"contracts"},
        "state":null,"settings":{},"event":"intercept","name":"0","interactive":true,"serve":true,"hook_budget_ms":1000,
        "payload":{"surface":"render","input":input,"original":input,"origin":{"caller":"engine"}}});
    let reply = evaluate_warm(
        &node,
        "registration-input",
        &request,
        Duration::from_secs(2),
        &|| true,
        &mut |_| unreachable!(),
    )
    .unwrap();
    assert_eq!(reply["registrations"]["tools"][0]["name"], "original");
    super::invalidate_warm("registration-input");
    assert!(
        !WARM
            .lock()
            .unwrap()
            .iter()
            .any(|runner| runner.key == "registration-input")
    );
    let error = evaluate_warm(
        &node,
        "cancelled-render",
        &request,
        Duration::from_secs(2),
        &|| false,
        &mut |_| unreachable!(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("callback_cancelled"));
    assert!(
        !WARM
            .lock()
            .unwrap()
            .iter()
            .any(|runner| runner.key == "cancelled-render")
    );
}

#[test]
fn render_runners_stay_activated_per_key_and_retire_on_errors() {
    let node = PathBuf::from(std::env::var_os("OMD_TEST_NODE").expect("OMD_TEST_NODE required"));
    let request = |key: &str, text: &str| {
        let input = json!({"component": "tool_call", "id": "c", "props": {"text": text}});
        json!({"source": format!("let renders = 0; export default api => api.intercept('render', e => {{ if (e.props.text === 'boom') throw new Error('boom'); renders += 1; return {{tree: [{{type: 'text', id: 't', label: 'T', text: '{key}:' + renders + ':' + e.props.text}}]}}; }});"),
            "filename": "/fixture/index.ts", "api": crate::MOD_API_VERSION, "capabilities": ["terminal"],
            "surface": {"events": {}, "replacements": [], "middleware": [], "intercept": {"render": "terminal"}, "state": "store", "contracts": "contracts"},
            "state": null, "settings": {}, "event": "intercept", "name": "0", "interactive": true, "serve": true, "hook_budget_ms": 1000,
            "receipts": [], "payload": {"surface": "render", "input": input, "original": input, "origin": {"caller": "engine"}}})
    };
    let render = |key: &str, text: &str| {
        evaluate_warm(
            &node,
            key,
            &request(key, text),
            Duration::from_secs(2),
            &|| true,
            &mut |_| unreachable!(),
        )
        .map(|reply| reply["value"]["result"]["tree"][0]["text"].clone())
    };
    let pid = |key: &str| {
        WARM.lock()
            .unwrap()
            .iter()
            .find(|runner| runner.key == key)
            .map(|runner| runner.child.id())
    };
    assert_eq!(render("a", "one").unwrap(), "a:1:one");
    let first = pid("a").unwrap();
    assert_eq!(render("a", "two").unwrap(), "a:2:two");
    assert_eq!(pid("a"), Some(first));
    assert_eq!(render("b", "one").unwrap(), "b:1:one");
    assert!(
        render("a", "boom")
            .unwrap_err()
            .to_string()
            .contains("boom")
    );
    assert_eq!(pid("a"), None);
    assert_eq!(render("a", "three").unwrap(), "a:1:three");
}

#[test]
fn os_sandbox_denies_host_files_network_and_children_even_outside_vm() {
    let node = PathBuf::from(std::env::var_os("OMD_TEST_NODE").expect("OMD_TEST_NODE required"));
    let temp = tempfile::TempDir::new().unwrap();
    let secret = temp.path().join("fixture-secret");
    std::fs::write(&secret, "synthetic secret").unwrap();
    let script = format!(
        r#"
        const fs = require('node:fs');
        const cp = require('node:child_process');
        const net = require('node:net');
        const result = {{}};
        try {{ fs.readFileSync({}); result.read = 'allowed'; }} catch(e) {{ result.read = e.code; }}
        try {{ fs.writeFileSync({}, 'bad'); result.write = 'allowed'; }} catch(e) {{ result.write = e.code; }}
        result.child = cp.spawnSync('/bin/sh', ['-c', 'exit 0']).error?.code ?? 'allowed';
        const socket = net.connect(9, '127.0.0.1');
        socket.on('error', error => {{ result.network = error.code; console.log(JSON.stringify(result)); }});
        socket.on('connect', () => {{ result.network = 'allowed'; socket.destroy(); console.log(JSON.stringify(result)); }});
        setTimeout(() => process.exit(2), 2000).unref();
    "#,
        serde_json::to_string(&secret).unwrap(),
        serde_json::to_string(&secret).unwrap()
    );
    let result = command(&node)
        .unwrap()
        .args(["--eval", &script])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(result.status.success(), "{:?}", result);
    let value: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    for name in ["read", "write", "child", "network"] {
        assert!(
            matches!(value[name].as_str(), Some("EPERM" | "EACCES")),
            "{name}: {value}"
        );
    }
    assert_eq!(std::fs::read_to_string(secret).unwrap(), "synthetic secret");
}
