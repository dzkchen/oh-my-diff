use super::command;
use std::path::PathBuf;
use std::process::Stdio;

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
