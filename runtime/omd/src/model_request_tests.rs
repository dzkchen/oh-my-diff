use super::*;

fn message(role: &str, parts: &[(&str, &str)]) -> Value {
    json!({"type": "message", "role": role,
        "content": parts.iter().map(|(_, text)| json!({"type": "input_text", "text": text})).collect::<Vec<_>>(),
        "internal_chat_message_metadata_passthrough": {"content_item_kinds": parts.iter().map(|(kind, _)| *kind).collect::<Vec<_>>()}})
}

fn request() -> Value {
    json!({"instructions": "base", "tools": [],
    "input": [
        message("developer", &[("permissions.instructions", "sandbox"), ("apps.instructions", "apps"), ("plugins.instructions", "plugins")]),
        message("user", &[("agents_md.instructions", "agents"), ("environments.environment_context", "env")]),
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hello"}]},
        message("user", &[("skills.selected_skill_instructions", "<skill>\n<name>review</name>\nbody\n</skill>")]),
        {"type": "function_call", "name": "read", "namespace": "skills", "call_id": "c1", "arguments": "{}"},
        {"type": "function_call_output", "name": "read", "namespace": "skills", "call_id": "c1", "output": "{\"package\":\"lint\",\"content\":\"x\"}"},
    ]})
}

fn ids(sections: &[Value]) -> Vec<&str> {
    sections
        .iter()
        .filter_map(|section| section["id"].as_str())
        .collect()
}

#[test]
fn sections_name_every_classified_item_and_protect_policy() {
    let sections = sections(&request());
    assert_eq!(
        ids(&sections),
        vec![
            "instructions",
            "permissions.instructions",
            "apps.instructions",
            "plugins.instructions",
            "agents_md.instructions",
            "environments.environment_context",
            "skill:review",
            "skill:lint"
        ]
    );
    assert_eq!(sections[1]["protected"], true);
    assert_eq!(sections[2]["protected"], false);
    assert_eq!(sections[7]["role"], "tool");
}

#[test]
fn ordinary_sections_rewrite_drop_reorder_and_insert_around_fixed_policy() {
    let mut value = request();
    let given = sections(&value);
    let mut effective = vec![given[0].clone(), given[1].clone(), given[3].clone()];
    effective[2]["text"] = json!("plugins, edited");
    effective.push(json!({"id": "mod:note", "text": "remember"}));
    effective.extend([given[5].clone(), given[6].clone(), given[7].clone()]);
    let effective = Value::Array(effective);
    assert!(valid_sections(&effective, &Value::Array(given.clone())));
    assert!(apply_sections(
        &mut value,
        &given,
        effective.as_array().unwrap()
    ));
    assert_eq!(value["input"][0]["content"][1]["text"], "plugins, edited");
    assert!(
        value["input"][0]["content"][2]["text"]
            .as_str()
            .unwrap()
            .ends_with("remember")
    );
    assert_eq!(
        value["input"][0]["internal_chat_message_metadata_passthrough"]["content_item_kinds"],
        json!([
            "permissions.instructions",
            "plugins.instructions",
            MOD_SECTION_KIND
        ])
    );
    assert_eq!(
        value["input"][1]["content"],
        json!([{"type": "input_text", "text": "env"}])
    );

    let given_value = Value::Array(given.clone());
    let mut moved = given.clone();
    moved.swap(1, 2);
    assert!(
        !valid_sections(&Value::Array(moved), &given_value),
        "an ordinary section crossed a protected one"
    );
    let mut policy = given.clone();
    policy[1]["text"] = json!("no sandbox");
    assert!(
        !valid_sections(&Value::Array(policy), &given_value),
        "protected text changed"
    );
    let without_policy = given
        .iter()
        .filter(|section| section["id"] != "permissions.instructions")
        .cloned()
        .collect();
    assert!(
        !valid_sections(&Value::Array(without_policy), &given_value),
        "protected section dropped"
    );
    let without_tool = given
        .iter()
        .filter(|section| section["role"] != "tool")
        .cloned()
        .collect();
    assert!(
        !valid_sections(&Value::Array(without_tool), &given_value),
        "tool output dropped"
    );
    let mut across = given.clone();
    let agents = across.remove(4);
    across.insert(3, agents);
    assert!(
        !valid_sections(&Value::Array(across), &given_value),
        "a section left its message"
    );
    let mut after_instructions = given.clone();
    after_instructions.insert(1, json!({"id": "mod:x", "text": "y"}));
    assert!(valid_sections(
        &Value::Array(after_instructions.clone()),
        &given_value
    ));
    let mut joined = request();
    assert!(apply_sections(&mut joined, &given, &after_instructions));
    assert!(
        joined["input"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .ends_with("\ny"),
        "an insertion after the instructions joins the next developer message"
    );

    let mut bare = json!({"instructions": "base", "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}]});
    let only = sections(&bare);
    let added = vec![only[0].clone(), json!({"id": "mod:x", "text": "y"})];
    assert!(valid_sections(
        &Value::Array(added.clone()),
        &Value::Array(only.clone())
    ));
    assert!(apply_sections(&mut bare, &only, &added));
    assert_eq!(bare["input"][0]["role"], "developer");
    assert_eq!(bare["input"][1]["content"][0]["text"], "hi");
}

#[test]
fn cache_prefix_reports_the_first_changed_section() {
    let before = fingerprints(&request());
    let mut value = request();
    value["input"][1]["content"][1]["text"] = json!("env 2");
    assert_eq!(
        changed_from(&before, &fingerprints(&value)).as_deref(),
        Some("environments.environment_context")
    );
    assert_eq!(changed_from(&before, &before), None);
}

#[test]
fn stream_results_keep_identity_and_validate_tool_arguments() {
    let tool = json!({"kind": "tool_done", "index": 1, "call_id": "c", "tool": "exec_command", "format": "json",
        "arguments": "{\"cmd\":\"ls\"}", "protected": false});
    let mut renamed = tool.clone();
    renamed["arguments"] = json!("{\"cmd\":\"pwd\"}");
    let injected =
        json!({"kind": "tool_done", "tool": "exec_command", "arguments": "{\"cmd\":\"date\"}"});
    assert!(valid_stream_result(
        &json!({"chunks": [renamed, injected]}),
        &tool
    ));
    assert!(valid_stream_result(&json!({"chunks": []}), &tool));
    let mut broken = tool.clone();
    broken["arguments"] = json!("not json");
    assert!(!valid_stream_result(&json!({"chunks": [broken]}), &tool));
    let mut moved = tool.clone();
    moved["call_id"] = json!("other");
    assert!(!valid_stream_result(&json!({"chunks": [moved]}), &tool));
    assert!(valid_stream_result(
        &json!({"stop": {"reason": "r"}, "retry": {"inject": "again"}}),
        &tool
    ));
    let delta = json!({"kind": "text", "index": 0, "text": "hi", "protected": false});
    assert!(!valid_stream_result(
        &json!({"stop": {"reason": "r"}}),
        &delta
    ));
    let reasoning = json!({"kind": "reasoning", "index": 0, "protected": true});
    assert!(!valid_stream_result(&json!({"chunks": []}), &reasoning));
    assert!(valid_stream_result(
        &json!({"chunks": [reasoning.clone()]}),
        &reasoning
    ));
}

#[test]
fn synthetic_answers_stream_complete_items_without_usage() {
    let answer = json!({"response": {"output": [{"type": "message", "text": "cached"},
        {"type": "tool_call", "tool": "exec_command", "arguments": {"cmd": "ls"}}]}});
    assert!(valid_answer(&answer));
    let mut next = 0;
    let events = synthetic_events(&answer, "mod-resp", &mut || {
        next += 1;
        format!("mod-x-{next}")
    });
    let kinds = events
        .iter()
        .map(|event| event["type"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        kinds,
        vec![
            "response.created",
            "response.output_item.added",
            "response.output_text.delta",
            "response.output_item.done",
            "response.output_item.done",
            "response.completed"
        ]
    );
    assert_eq!(events[4]["item"]["arguments"], "{\"cmd\":\"ls\"}");
    assert_eq!(events[4]["item"]["call_id"], "mod-x-2");
    assert!(events[5]["response"].get("usage").is_none());
    assert!(!valid_answer(&json!({"response": {"output": []}})));
}

fn final_request() -> Value {
    json!({"model": "m", "instructions": "base", "prompt_cache_key": "thread",
    "tools": [{"type": "function", "name": "read", "description": "Reads a file", "parameters": {"type": "object", "properties": {"name": {"type": "string", "description": "path"}}}}],
    "text": {"format": {"type": "json_schema", "name": "out", "schema": {"description": "result"}}},
    "input": [
        message("developer", &[("permissions.instructions", "sandbox"), ("apps.instructions", "apps")]),
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi é"}, {"type": "input_image", "image_url": "data:image/png;base64,AA"}]},
        {"type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking"}], "encrypted_content": "opaque"},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "done"}]},
        {"type": "function_call", "name": "read", "call_id": "c1", "arguments": "{\"path\":\"a\"}"},
        {"type": "function_call_output", "call_id": "c1", "output": [{"type": "input_text", "text": "contents"}]},
        message("user", &[("user.text", "prompt")]),
    ]})
}

#[test]
fn send_segments_cover_every_text_leaf_and_name_opaque_values() {
    let (segments, opaque) = send_segments(&final_request());
    let view = segments
        .iter()
        .map(|segment| {
            (
                segment["id"].as_str().unwrap(),
                segment["kind"].as_str().unwrap(),
                segment["editable"] == true,
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        view,
        [
            ("/instructions", "instructions", true),
            ("/input/0/content/0/text", "permissions.instructions", false),
            ("/input/0/content/1/text", "apps.instructions", true),
            ("/input/1/content/0/text", "message.user", true),
            ("/input/2/summary/0/text", "reasoning", false),
            ("/input/3/content/0/text", "message.assistant", true),
            ("/input/4/arguments", "tool_call.arguments", true),
            ("/input/5/output/0/text", "tool_output", true),
            ("/input/6/content/0/text", "user.text", true),
            ("/tools/0/description", "tool_spec", false),
            (
                "/tools/0/parameters/properties/name/description",
                "tool_spec",
                false
            ),
            ("/text/format/schema/description", "output_schema", false),
        ]
    );
    assert_eq!(segments[3]["bytes"], 5);
    assert_eq!(
        opaque,
        [
            json!({"id": "/input/1/content/1/image_url", "kind": "image_url"}),
            json!({"id": "/input/2/encrypted_content", "kind": "encrypted_content"}),
        ]
    );
}

#[test]
fn send_pages_pack_short_segments_and_split_long_ones_with_context() {
    let long = "é".repeat(SEND_PAGE_BYTES);
    let segment = |id: &str, text: &str| json!({"id": id, "editable": true, "text": text});
    let pages = send_pages(vec![
        segment("/a", "one"),
        segment("/b", "two"),
        segment("/c", &long),
        segment("/d", "three"),
    ]);
    assert_eq!(pages[0].len(), 2);
    let pieces = pages[1..pages.len() - 1]
        .iter()
        .map(|page| &page[0])
        .collect::<Vec<_>>();
    assert_eq!(pieces.len(), 3);
    assert_eq!(
        pieces
            .iter()
            .map(|piece| piece["text"].as_str().unwrap())
            .collect::<String>(),
        long
    );
    assert_eq!(pieces[0]["before"], "");
    assert_eq!(pieces[2]["after"], "");
    assert_eq!(
        pieces[1]["offset"],
        pieces[0]["text"].as_str().unwrap().chars().count()
    );
    assert_eq!(
        pieces[1]["before"].as_str().unwrap().len(),
        SEND_CONTEXT_BYTES
    );
    assert_eq!(
        pieces[1]["after"].as_str().unwrap().len(),
        SEND_CONTEXT_BYTES
    );
    assert_eq!(pages.last().unwrap()[0]["id"], "/d");
}

#[test]
fn send_results_keep_inner_edits_and_stay_inside_editable_text() {
    let input = json!({"segments": [
        {"id": "/a", "editable": true, "text": "a😀b secret"},
        {"id": "/p", "editable": false, "text": "policy"},
    ]});
    let edit = |segment: &str, start: usize, end: usize| json!({"segment": segment, "start": start, "end": end, "text": "[x]"});
    let edits = |items: Vec<Value>| json!({"edits": items});
    let none = edits(vec![]);
    let inner = edits(vec![edit("/a", 5, 11)]);
    assert!(valid_send_result(&inner, &none, &input));
    assert!(valid_send_result(
        &edits(vec![edit("/a", 5, 11), edit("/a", 0, 1)]),
        &inner,
        &input
    ));
    assert!(!valid_send_result(
        &edits(vec![edit("/a", 0, 1)]),
        &inner,
        &input
    ));
    assert!(!valid_send_result(
        &edits(vec![edit("/a", 2, 3)]),
        &none,
        &input
    ));
    assert!(!valid_send_result(
        &edits(vec![edit("/a", 4, 12)]),
        &none,
        &input
    ));
    assert!(!valid_send_result(
        &edits(vec![edit("/a", 0, 6), edit("/a", 5, 7)]),
        &none,
        &input
    ));
    assert!(!valid_send_result(
        &edits(vec![edit("/p", 0, 1)]),
        &none,
        &input
    ));
    assert!(!valid_send_result(
        &json!({"edits": [], "extra": 1}),
        &none,
        &input
    ));
    let fresh = json!({"edits": [], "cache": false});
    assert!(valid_send_result(&fresh, &none, &input));
    assert!(!valid_send_result(&none, &fresh, &input));
    assert!(!valid_send_result(
        &json!({"edits": [], "cache": true}),
        &none,
        &input
    ));

    let mut request = json!({"a": "a😀b secret", "arguments": "{\"k\":\"secret\"}"});
    let page = vec![json!({"id": "/a", "text": "a😀b secret"})];
    let ranges = page_edits(&inner, &page, &json!({"a": "a😀b secret"})).unwrap();
    assert_eq!(ranges, [("/a".to_owned(), 7, 13, "[x]".to_owned())]);
    let unchanged = edits(vec![
        json!({"segment": "/a", "start": 0, "end": 1, "text": "a"}),
    ]);
    assert!(
        page_edits(&unchanged, &page, &json!({"a": "a😀b secret"}))
            .unwrap()
            .is_empty()
    );
    let mut applied = BTreeMap::new();
    applied.insert("/a".to_owned(), vec![(7, 13, "[x]".to_owned())]);
    applied.insert("/arguments".to_owned(), vec![(6, 12, "[x]".to_owned())]);
    apply_send_edits(&mut request, &applied).unwrap();
    assert_eq!(
        request,
        json!({"a": "a😀b [x]", "arguments": "{\"k\":\"[x]\"}"})
    );
    let mut broken = BTreeMap::new();
    broken.insert("/arguments".to_owned(), vec![(0, 1, String::new())]);
    assert!(
        apply_send_edits(&mut request, &broken)
            .unwrap_err()
            .contains("no longer JSON")
    );
}

#[test]
fn queued_sections_reach_the_next_request_once_and_its_retries() {
    let thread = "thread-queued-sections";
    assert!(!apply_queued_sections(&mut request(), thread, false));
    queue_section(thread, "checks", "build failed").unwrap();
    let mut first = request();
    assert!(apply_queued_sections(&mut first, thread, false));
    let text = first.to_string();
    assert!(
        text.contains("Mod-provided context") && text.contains("build failed"),
        "{text}"
    );
    let mut retry = request();
    assert!(apply_queued_sections(&mut retry, thread, true));
    assert_eq!(retry, first);
    assert!(!apply_queued_sections(&mut request(), thread, false));
    for _ in 0..INSERTED_SECTIONS {
        queue_section(thread, "checks", "note").unwrap();
    }
    assert_eq!(
        queue_section(thread, "checks", "one too many"),
        Err("model_context_queue_full".to_owned())
    );
    assert_eq!(
        queue_section("other-thread", "checks", " "),
        Err("model_context_invalid".to_owned())
    );
}
