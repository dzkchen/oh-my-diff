use super::WARM;
use super::command;
use super::evaluate_warm;
use serde_json::json;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

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
        evaluate_warm(&node, key, &request(key, text), Duration::from_secs(2), &|| true, &mut |_| unreachable!())
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
    assert!(render("a", "boom").unwrap_err().to_string().contains("boom"));
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
