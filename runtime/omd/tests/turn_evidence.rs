use codex_omd::turn_evidence::project;

#[test]
fn redaction_preserves_task_identifiers_but_removes_credential_tokens() {
    let value = codex_omd::resource_data::redact(
        "task-example is complete\nvalue=sk-private-token\nvalue=ghp_private_token",
    );
    assert_eq!(value, "task-example is complete\n[redacted]\n[redacted]");
}
use serde_json::json;

#[test]
fn projection_contains_visible_messages_and_references_only() {
    let records = vec![
        json!({"type":"message","role":"user","content":[{"type":"input_text","text":"Please inspect the change.\npassword=secret-sentinel"}]}),
        json!({"type":"reasoning","summary":[],"encrypted_content":"opaque-sentinel"}),
        json!({"type":"message","role":"assistant","channel":"analysis","content":[{"type":"output_text","text":"reasoning-sentinel"}]}),
        json!({"type":"function_call","name":"shell","call_id":"call-1","arguments":"private-arguments-sentinel"}),
        json!({"type":"function_call_output","call_id":"call-1","output":"private-output-sentinel"}),
        json!({"type":"message","role":"assistant","channel":"final","content":[{"type":"output_text","text":"The check passed."}]}),
    ];
    let packet = project(records.into_iter(), "turn-a", 2).unwrap();
    assert_eq!(packet["records"].as_array().unwrap().len(), 4);
    assert_eq!(packet["records"][0]["redacted"], true);
    let text = packet.to_string();
    assert!(!text.contains("sentinel"));
    assert!(text.contains("The check passed."));
    assert_eq!(packet["records"][2]["output_included"], false);
}

#[test]
fn packet_is_bounded_and_discloses_omissions() {
    let message = json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"字".repeat(20_000)}]});
    let packet = project(std::iter::repeat_n(message, 5000), "turn-b", 3).unwrap();
    assert_eq!(packet["truncated"], true);
    assert_eq!(packet["records"][0]["truncated"], true);
    assert!(packet.to_string().len() < codex_omd::resource_data::SNAPSHOT_BYTES);
}

#[test]
fn compaction_segments_preserve_original_visible_records_and_bounds() {
    let message = |text: &str| json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]});
    let before = project([message("before")].into_iter(), "turn", 1).unwrap();
    let after = project([message("after")].into_iter(), "turn", 2).unwrap();
    let combined = codex_omd::turn_evidence::combine(Some(before), after).unwrap();
    assert_eq!(combined["compacted"], true);
    assert_eq!(combined["records"][0]["text"], "before");
    assert_eq!(combined["records"][0]["history_revision"], 1);
    assert_eq!(combined["records"][1]["text"], "after");
    assert_eq!(combined["records"][1]["history_revision"], 2);
    let large = project(
        std::iter::repeat_n(message(&"x".repeat(8192)), 40),
        "turn",
        3,
    )
    .unwrap();
    let bounded = codex_omd::turn_evidence::combine(Some(large.clone()), large).unwrap();
    assert_eq!(bounded["truncated"], true);
    assert!(bounded.to_string().len() < codex_omd::resource_data::SNAPSHOT_BYTES);
}
