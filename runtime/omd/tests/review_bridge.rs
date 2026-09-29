use codex_omd::resource_data::hash;
use codex_omd::{ModHost, ModStore};
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;

#[test]
fn independent_reviewer_owns_prompt_wait_interpretation_and_denial_handling() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let node = PathBuf::from(std::env::var_os("OMD_TEST_NODE").expect("OMD_TEST_NODE required"));
    let store = ModStore::create(root.join("store"), node).unwrap();
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
    let mut host = ModHost::open(root.join("store")).unwrap();
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
    host.invoke_with("example_review_probe", generation, "turn_end", "", event.clone(), || true, |call| {
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
    }).unwrap();
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
        )
        .unwrap();
    assert_eq!(status["status"], "recorded");
    host.invoke_with(
        "example_review_probe",
        generation,
        "turn_end",
        "",
        event,
        || true,
        |call| match call.operation.as_str() {
            "evidence.read" => {
                Ok(json!({"reference":reference,"text":"fixture","cursor":null,"bytes":7}))
            }
            "workspace.snapshot" => {
                Ok(json!({"snapshot":snapshot,"candidate_sha256":snapshot["sha256"]}))
            }
            "agents.spawn" => Err(std::io::Error::other("allowance_exhausted")),
            _ => panic!("must not start another operation after denial"),
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
        )
        .unwrap();
    assert_eq!(status["status"], "denied");
    assert_eq!(status["reason"], "allowance_exhausted");
    store.enable(&package, false).unwrap();
    host.turn_boundary();
    assert!(
        host.subscribers_with_capability("turn_end", "lifecycle")
            .is_empty()
    );
    assert!(
        host.event_guarded_with("turn_end", json!({}), || true, |_, _| panic!())
            .is_empty()
    );
}
