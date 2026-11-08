use codex_omd::ModHostCallback;
use codex_omd::ModInvokeOptions;
use codex_omd::ModOpenOptions;
use codex_omd::sha256_hex as hash;
use codex_omd::{ModHost, ModStore};
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;

#[test]
fn independent_reviewer_owns_prompt_wait_interpretation_and_denial_handling() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../mods/examples/review_probe");
    let package = root.join("probe");
    fs::create_dir(&package).unwrap();
    for name in ["mod.json", "index.ts"] {
        fs::copy(source.join(name), package.join(name)).unwrap();
    }
    let inspected = ModStore::inspect_package(&package).unwrap();
    store
        .trust(
            package.clone(),
            inspected["sha256"].as_str().unwrap(),
            serde_json::from_value(inspected["manifest"]["capabilities"].clone()).unwrap(),
            "user",
        )
        .unwrap();
    store.enable(&package, true).unwrap();
    let mut host = ModHost::open(root.join("store"), ModOpenOptions::default()).unwrap();
    assert_eq!(
        host.subscribers_with_capability("turn_end", "lifecycle"),
        ["example_review_probe"]
    );
    let generation = host.generation();
    let reference = json!({"reference":hash(b"packet"),"sha256":hash(b"packet")});
    let snapshot = json!({"reference":hash(b"candidate"),"sha256":hash(b"candidate")});
    let result_ref =
        json!({"reference":"native-thread:fixture","sha256":hash(b"{\"findings\":[]}")});
    let event = json!({"turn_id":"turn-a","outcome":"completed","evidence":reference});
    let mut calls = Vec::new();
    host.invoke("example_review_probe", generation, "turn_end", "", event.clone(), ModInvokeOptions { host: ModHostCallback::Own(&mut |call| {
        calls.push(call.operation.clone());
        match call.operation.as_str() {
            "evidence.read" => Ok(json!({"reference":reference,"text":"Visible fixture evidence","cursor":null,"bytes":24})),
            "workspace.snapshot" => Ok(json!({"snapshot":snapshot,"candidate_sha256":snapshot["sha256"]})),
            "agents.spawn" => {
                assert!(call.arguments["prompt"].as_str().unwrap().contains("Visible fixture evidence"));
                assert_eq!(call.arguments["tools"], json!([]));
                assert_eq!(call.arguments["workspace"], "read_only");
                Ok(json!({"handle":"host-worker","route":"reviewer","permissions":"read_only"}))
            }
            "agents.wait" => Ok(json!({"status":"completed","text":"{\"findings\":[]}","consumed":false,"evidence":result_ref,"candidate_sha256":snapshot["sha256"]})),
            "receipts.submit" => {
                assert_eq!(call.arguments["agent"], "host-worker");
                assert_eq!(call.arguments["candidate_sha256"], snapshot["sha256"]);
                Ok(json!({"kind":"turn_review","outcome":"pass"}))
            }
            "agents.cancel" => Ok(json!({"status":"cancelled"})),
            _ => panic!("unexpected operation {}", call.operation),
        }
    }), ..ModInvokeOptions::default() }).unwrap();
    assert_eq!(
        calls,
        [
            "evidence.read",
            "workspace.snapshot",
            "agents.spawn",
            "agents.wait",
            "receipts.submit",
            "agents.cancel"
        ]
    );
    let status = host
        .invoke(
            "example_review_probe",
            generation,
            "command",
            "status",
            Value::Null,
            ModInvokeOptions::default(),
        )
        .unwrap();
    assert_eq!(status["status"], "recorded");
    host.invoke(
        "example_review_probe",
        generation,
        "turn_end",
        "",
        event,
        ModInvokeOptions {
            host: ModHostCallback::Own(&mut |call| match call.operation.as_str() {
                "evidence.read" => {
                    Ok(json!({"reference":reference,"text":"fixture","cursor":null,"bytes":7}))
                }
                "workspace.snapshot" => {
                    Ok(json!({"snapshot":snapshot,"candidate_sha256":snapshot["sha256"]}))
                }
                "agents.spawn" => Err(std::io::Error::other("allowance_exhausted")),
                _ => panic!("must not start another operation after denial"),
            }),
            ..ModInvokeOptions::default()
        },
    )
    .unwrap();
    let status = host
        .invoke(
            "example_review_probe",
            generation,
            "command",
            "status",
            Value::Null,
            ModInvokeOptions::default(),
        )
        .unwrap();
    assert_eq!(status["status"], "denied");
    assert_eq!(status["reason"], "allowance_exhausted");
    store.enable(&package, false).unwrap();
    host.turn_boundary(&|| true);
    assert!(
        host.subscribers_with_capability("turn_end", "lifecycle")
            .is_empty()
    );
    assert!(
        host.event(
            "turn_end",
            json!({}),
            ModInvokeOptions {
                host: ModHostCallback::Scoped(&mut |_, _| panic!()),
                ..ModInvokeOptions::default()
            }
        )
        .is_empty()
    );
}
