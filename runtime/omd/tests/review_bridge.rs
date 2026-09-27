use codex_omd::resource_data::hash;
use codex_omd::{ModHost, ModStore};
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;

#[test]
#[ignore = "the native review lane was retired in Batch 2.5; Batch 2.55 rewrites review_probe over agents.spawn and receipts.submit"]
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
        host.subscribers_with_capability("turn_end", "turn_evidence"),
        ["example_review_probe"]
    );
    let generation = host.generation();
    let reference = json!({"reference":hash(b"packet"),"sha256":hash(b"packet")});
    let event = json!({"turn_id":"turn-a","outcome":"completed","evidence":reference});
    let mut calls = Vec::new();
    let text = "{\"findings\":[]}";
    host.invoke_with("example_review_probe",generation,"turn_end","",event.clone(),||true,|call| {
        calls.push(call.operation.clone());
        match call.operation.as_str() {
            "evidence.read"=>Ok(json!({"reference":reference,"text":"Visible fixture evidence","cursor":null,"bytes":24})),
            "review.request"=>{assert!(call.arguments["prompt"].as_str().unwrap().contains("Visible fixture evidence"));assert_eq!(call.arguments["tools"],json!([]));Ok(json!({"handle":"host-worker","route":"astra","permissions":"read_only"}))},
            "review.wait"=>Ok(json!({"status":"completed","text":text,"consumed":false,"evidence":{"ref":"native-thread:fixture","sha256":hash(text.as_bytes())}})),
            "review.submit"=>{assert_eq!(call.arguments["result_sha256"],hash(text.as_bytes()));Ok(json!({"cycle":{"id":1}}))},
            _=>panic!("unexpected operation {}",call.operation),
        }
    }).unwrap();
    assert_eq!(
        calls,
        [
            "evidence.read",
            "review.request",
            "review.wait",
            "review.submit"
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
            "review.request" => Err(std::io::Error::other("allowance_exhausted")),
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
        host.subscribers_with_capability("turn_end", "turn_evidence")
            .is_empty()
    );
    assert!(
        host.event_guarded_with("turn_end", json!({}), || true, |_, _| panic!())
            .is_empty()
    );
}
