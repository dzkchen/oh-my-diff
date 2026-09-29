use super::*;

fn items() -> Vec<Value> {
    vec![
        json!({"type": "message", "role": "user", "content": [{"type": "input_text", "text": "old question"}]}),
        json!({"type": "reasoning", "encrypted_content": "sealed", "summary": []}),
        json!({"type": "function_call", "call_id": "c1", "name": "read", "arguments": "{}"}),
        json!({"type": "function_call_output", "call_id": "c1", "output": "long output"}),
        json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "answer"}]}),
        json!({"type": "message", "role": "user", "content": [{"type": "input_text", "text": "current"}]}),
    ]
}

fn edit(value: Value) -> HistoryEdit {
    serde_json::from_value(value).unwrap()
}

#[test]
fn edits_fold_text_drop_paired_calls_and_insert_notes_without_touching_protected_items() {
    let items = items();
    let view = view(&items);
    assert_eq!(view[1]["editable"], false);
    assert_eq!(view[5]["editable"], false);
    let folded = apply(
        &items,
        edit(
            json!({"drop": [1, 2, 3], "replace": [{"index": 4, "text": "short"}],
            "insert": [{"before": 5, "role": "developer", "text": "folded c1"}]}),
        ),
    )
    .unwrap();
    assert_eq!(folded.len(), 4);
    assert_eq!(
        folded[1]["content"][0],
        json!({"type": "output_text", "text": "short"})
    );
    assert_eq!(folded[2]["content"][0]["text"], "folded c1");
    assert_eq!(folded[3], items[5]);
}

#[test]
fn unsafe_edits_are_refused() {
    let items = items();
    for refused in [
        json!({"drop": [1]}),
        json!({"drop": [2]}),
        json!({"drop": [2, 3]}),
        json!({"drop": [5]}),
        json!({"replace": [{"index": 1, "text": "x"}]}),
        json!({"replace": [{"index": 5, "text": "x"}]}),
        json!({"insert": [{"before": 0, "role": "assistant", "text": "x"}]}),
        json!({"insert": [{"before": 2, "role": "developer", "text": "x"}]}),
    ] {
        assert!(apply(&items, edit(refused)).is_err());
    }
}

#[test]
fn call_arguments_and_image_messages_can_be_rewritten() {
    let items = vec![
        json!({"type": "message", "role": "user", "content": [
            {"type": "input_text", "text": "see"}, {"type": "input_image", "image_url": "data:image/png;base64,AAA"}]}),
        json!({"type": "function_call", "call_id": "c1", "name": "login", "arguments": "{\"token\":\"secret\"}"}),
        json!({"type": "function_call_output", "call_id": "c1", "output": "ok"}),
        json!({"type": "message", "role": "user", "content": [{"type": "input_text", "text": "current"}]}),
    ];
    assert_eq!(view(&items)[0]["images"], 1);
    let edited = apply(
        &items,
        edit(
            json!({"replace": [{"index": 0, "text": "see [screenshot folded]"},
            {"index": 1, "text": "{\"token\":\"[redacted]\"}"}]}),
        ),
    )
    .unwrap();
    assert_eq!(
        edited[0]["content"],
        json!([{"type": "input_text", "text": "see [screenshot folded]"}])
    );
    assert_eq!(edited[1]["arguments"], "{\"token\":\"[redacted]\"}");
    assert_eq!(edited[2], items[2]);
}
