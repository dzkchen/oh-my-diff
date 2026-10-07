use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

pub const SECTION_PREVIEW_BYTES: usize = 4096;
pub const SECTIONS_PREVIEW_BYTES: usize = 49_152;
pub const SECTION_LIMIT: usize = 256;
pub const SECTION_TEXT_BYTES: usize = 65_536;
pub const INSERTED_SECTIONS: usize = 8;
pub const INSERTED_TEXT_BYTES: usize = 16_384;
pub const MOD_SECTION_KIND: &str = "oh_my_diff.mod_section";
pub const EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh"];
pub const CHUNK_TEXT_BYTES: usize = 65_536;
pub const CHUNKS: usize = 16;
const PROTECTED_KINDS: &[&str] = &[
    "permissions.",
    "network_proxy.",
    "managed_config.",
    "collaboration_mode.",
    "guardian.",
    "user.",
];
const KINDS: &str = "/internal_chat_message_metadata_passthrough/content_item_kinds";
const INSERTED_FRAME: &str =
    "Mod-provided context; subordinate to the user's instructions and native permissions.\n";
const SECTION_FIELDS: &[&str] = &[
    "id",
    "kind",
    "role",
    "group",
    "protected",
    "text",
    "bytes",
    "truncated",
];

const TRACE_VALUE_BYTES: usize = 2048;

/// The value itself when small, else its digest and size.
pub fn bounded(value: &Value) -> Value {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    if bytes.len() <= TRACE_VALUE_BYTES {
        return value.clone();
    }
    json!({"sha256": crate::mods::digest(&bytes), "bytes": bytes.len()})
}

struct Raw<'a> {
    id: String,
    kind: String,
    role: String,
    group: String,
    protected: bool,
    text: Option<&'a str>,
}

fn walk(request: &Value) -> Vec<Raw<'_>> {
    let mut raw = Vec::new();
    let mut seen = BTreeMap::<String, usize>::new();
    let mut id = |base: String| {
        let count = seen.entry(base.clone()).or_default();
        *count += 1;
        if *count == 1 {
            base
        } else {
            format!("{base}#{count}")
        }
    };
    if let Some(text) = request["instructions"]
        .as_str()
        .filter(|text| !text.is_empty())
    {
        raw.push(Raw {
            id: id("instructions".into()),
            kind: "model.base_instructions".into(),
            role: "system".into(),
            group: "instructions".into(),
            protected: false,
            text: Some(text),
        });
    }
    for (index, item) in request["input"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        match item["type"].as_str() {
            Some("message") => {
                let (Some(kinds), Some(content)) = (
                    item.pointer(KINDS).and_then(Value::as_array),
                    item["content"].as_array(),
                ) else {
                    continue;
                };
                if kinds.len() != content.len()
                    || raw.len() + content.len() > SECTION_LIMIT
                    || !kinds.iter().all(Value::is_string)
                {
                    continue;
                }
                for (part, kind) in content.iter().zip(kinds) {
                    let kind = kind.as_str().unwrap_or_default();
                    let text = part["text"].as_str();
                    let base = match (kind, text) {
                        ("skills.selected_skill_instructions", Some(text)) => text
                            .split_once("<name>")
                            .and_then(|(_, rest)| rest.split_once("</name>"))
                            .map_or_else(
                                || kind.to_owned(),
                                |(name, _)| format!("skill:{}", name.trim()),
                            ),
                        _ => kind.to_owned(),
                    };
                    raw.push(Raw {
                        id: id(base),
                        kind: kind.to_owned(),
                        role: item["role"].as_str().unwrap_or("user").to_owned(),
                        group: index.to_string(),
                        protected: text.is_none()
                            || PROTECTED_KINDS
                                .iter()
                                .any(|prefix| kind.starts_with(prefix)),
                        text,
                    });
                }
            }
            Some("function_call_output")
                if item["namespace"] == "skills"
                    && item["name"] == "read"
                    && item["output"].is_string()
                    && raw.len() < SECTION_LIMIT =>
            {
                let package = item["output"]
                    .as_str()
                    .and_then(|output| serde_json::from_str::<Value>(output).ok())
                    .and_then(|output| output["package"].as_str().map(str::to_owned))
                    .unwrap_or_else(|| item["call_id"].as_str().unwrap_or_default().to_owned());
                raw.push(Raw {
                    id: id(format!("skill:{package}")),
                    kind: "skills.read_output".into(),
                    role: "tool".into(),
                    group: index.to_string(),
                    protected: false,
                    text: item["output"].as_str(),
                });
            }
            _ => {}
        }
    }
    raw
}

fn cut(text: &str, limit: usize) -> &str {
    let mut end = limit.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The classified prompt items of a Responses request with bounded text previews, in request order.
pub fn sections(request: &Value) -> Vec<Value> {
    let mut room = SECTIONS_PREVIEW_BYTES;
    walk(request)
        .into_iter()
        .map(|raw| {
            let bytes = raw.text.map_or(0, str::len);
            let text = raw
                .text
                .map(|text| cut(text, SECTION_PREVIEW_BYTES))
                .filter(|preview| preview.len() <= room);
            room -= text.map_or(0, str::len);
            json!({"id": raw.id, "kind": raw.kind, "role": raw.role, "group": raw.group,
                "protected": raw.protected, "text": text, "bytes": bytes,
                "truncated": text.map_or(bytes > 0, |text| text.len() < bytes)})
        })
        .collect()
}

/// Section ids with digests of their full text, tools first, for cache-prefix comparison.
pub fn fingerprints(request: &Value) -> Vec<(String, String)> {
    let digest = |bytes: &[u8]| crate::mods::digest(bytes);
    std::iter::once((
        "tools".to_owned(),
        digest(&serde_json::to_vec(&request["tools"]).unwrap_or_default()),
    ))
    .chain(
        walk(request)
            .into_iter()
            .map(|raw| (raw.id, digest(raw.text.unwrap_or_default().as_bytes()))),
    )
    .collect()
}

/// The first id whose content differs from the previous request's, or `None` when the prefix is unchanged.
pub fn changed_from(previous: &[(String, String)], current: &[(String, String)]) -> Option<String> {
    current
        .iter()
        .enumerate()
        .find(|(index, entry)| previous.get(*index) != Some(entry))
        .map(|(_, (id, _))| id.clone())
        .or_else(|| {
            (previous.len() > current.len()).then(|| {
                current
                    .last()
                    .map_or_else(|| "tools".to_owned(), |(id, _)| id.clone())
            })
        })
}

fn writable_group(given: &[Value], group: &str) -> bool {
    given
        .iter()
        .find(|section| section["group"] == group)
        .is_some_and(|section| section["role"] == "developer" || section["role"] == "user")
}

const NEW_GROUP: &str = "new";

/// An inserted section joins the nearest developer or user message, preferring the preceding section's, else a new one.
fn insertion_group(given: &[Value], effective: &[Value], position: usize) -> String {
    let group = |section: &Value| {
        let id = section["id"].as_str()?;
        given.iter().find(|original| original["id"] == id)?["group"]
            .as_str()
            .map(str::to_owned)
    };
    let writable = |group: &String| writable_group(given, group);
    let mut before = effective[..position].iter().rev().filter_map(group);
    before
        .next()
        .filter(writable)
        .or_else(|| {
            effective[position + 1..]
                .iter()
                .filter_map(group)
                .find(writable)
        })
        .or_else(|| before.find(writable))
        .unwrap_or_else(|| NEW_GROUP.to_owned())
}

/// Ordinary sections may change; protected sections, tool outputs and section messages stay fixed in place.
pub fn valid_sections(effective: &Value, given: &Value) -> bool {
    let (Some(effective), Some(given)) = (effective.as_array(), given.as_array()) else {
        return false;
    };
    let by_id = given
        .iter()
        .filter_map(|section| Some((section["id"].as_str()?, section)))
        .collect::<BTreeMap<_, _>>();
    let groups = given
        .iter()
        .filter_map(|section| section["group"].as_str())
        .fold(Vec::new(), |mut groups, group| {
            if !groups.contains(&group) {
                groups.push(group);
            }
            groups
        });
    let segment = |id: &str| {
        given
            .iter()
            .take_while(|section| section["id"] != id)
            .filter(|section| section["protected"] == true)
            .count()
    };
    let mut ids = BTreeSet::new();
    let mut inserted = 0;
    let mut group_at = 0;
    let mut protected_seen = 0;
    for section in effective {
        let Some(id) = section["id"].as_str().filter(|id| ids.insert(*id)) else {
            return false;
        };
        let Some(object) = section.as_object() else {
            return false;
        };
        match by_id.get(id) {
            Some(original) => {
                let fixed = object
                    .keys()
                    .all(|key| SECTION_FIELDS.contains(&key.as_str()))
                    && ["kind", "role", "group", "protected", "bytes", "truncated"]
                        .iter()
                        .all(|key| {
                            object
                                .get(*key)
                                .is_none_or(|value| value == &original[*key])
                        });
                let text_ok = if original["protected"] == true {
                    section
                        .get("text")
                        .is_none_or(|text| text == &original["text"])
                } else {
                    section.get("text").is_none_or(|text| {
                        text == &original["text"]
                            || text
                                .as_str()
                                .is_some_and(|text| text.len() <= SECTION_TEXT_BYTES)
                    })
                };
                let group = original["group"].as_str().unwrap_or_default();
                let Some(index) = groups.iter().position(|item| *item == group) else {
                    return false;
                };
                if !fixed || !text_ok || index < group_at {
                    return false;
                }
                if original["protected"] == true {
                    if segment(id) != protected_seen {
                        return false;
                    }
                    protected_seen += 1;
                } else if segment(id) != protected_seen {
                    return false;
                }
                group_at = index;
            }
            None => {
                inserted += 1;
                if inserted > INSERTED_SECTIONS
                    || !id.starts_with("mod:")
                    || id.len() > 64
                    || object.len() != 2
                    || !section["text"].as_str().is_some_and(|text| {
                        !text.trim().is_empty() && text.len() <= INSERTED_TEXT_BYTES
                    })
                {
                    return false;
                }
            }
        }
    }
    given.iter().all(|section| {
        (section["protected"] != true && section["role"] != "tool")
            || section["id"].as_str().is_some_and(|id| ids.contains(id))
    })
}

fn changed(section: &Value, original: &Value) -> Option<String> {
    let text = section.get("text")?;
    (text != &original["text"])
        .then(|| text.as_str().map(str::to_owned))
        .flatten()
}

/// Applies validated effective sections to the request; returns whether anything changed.
pub fn apply_sections(request: &mut Value, given: &[Value], effective: &[Value]) -> bool {
    if given == effective {
        return false;
    }
    let by_id = given
        .iter()
        .filter_map(|section| Some((section["id"].as_str()?, section)))
        .collect::<BTreeMap<_, _>>();
    let mut placed: BTreeMap<String, Vec<(&Value, Option<&Value>)>> = BTreeMap::new();
    for (position, section) in effective.iter().enumerate() {
        let original = section["id"].as_str().and_then(|id| by_id.get(id)).copied();
        let target = match original {
            Some(original) => original["group"].as_str().unwrap_or_default().to_owned(),
            None => insertion_group(given, effective, position),
        };
        placed.entry(target).or_default().push((section, original));
    }
    let mut dropped = Vec::new();
    let mut groups = given
        .iter()
        .filter_map(|section| section["group"].as_str())
        .collect::<Vec<_>>();
    groups.dedup();
    for group in groups {
        let entries = placed.remove(group).unwrap_or_default();
        if group == "instructions" {
            request["instructions"] = match entries.first() {
                Some((section, Some(original))) => match changed(section, original) {
                    Some(text) => text.into(),
                    None => request["instructions"].clone(),
                },
                _ => "".into(),
            };
            continue;
        }
        let Ok(index) = group.parse::<usize>() else {
            continue;
        };
        let Some(item) = request["input"].get_mut(index) else {
            continue;
        };
        if item["type"] == "function_call_output" {
            if let Some((section, Some(original))) = entries.first()
                && let Some(text) = changed(section, original)
            {
                item["output"] = text.into();
            }
            continue;
        }
        let parts = item["content"].as_array().cloned().unwrap_or_default();
        let kinds = item.pointer(KINDS).cloned().unwrap_or(Value::Null);
        let part_type = parts
            .first()
            .and_then(|part| part["type"].as_str())
            .unwrap_or("input_text")
            .to_owned();
        let order = given
            .iter()
            .filter(|section| section["group"] == group)
            .map(|section| section["id"].clone())
            .collect::<Vec<_>>();
        let mut content = Vec::new();
        let mut content_kinds = Vec::new();
        for (section, original) in entries {
            match original {
                Some(original) => {
                    let Some(at) = order.iter().position(|id| *id == original["id"]) else {
                        continue;
                    };
                    let mut part = parts.get(at).cloned().unwrap_or(Value::Null);
                    if let Some(text) = changed(section, original) {
                        part["text"] = text.into();
                    }
                    content.push(part);
                    content_kinds.push(kinds.get(at).cloned().unwrap_or(Value::Null));
                }
                None => {
                    let text = section["text"].as_str().unwrap_or_default();
                    content.push(
                        json!({"type": part_type, "text": format!("{INSERTED_FRAME}{text}")}),
                    );
                    content_kinds.push(json!(MOD_SECTION_KIND));
                }
            }
        }
        if content.is_empty() {
            dropped.push(index);
            continue;
        }
        item["content"] = Value::Array(content);
        if let Some(kinds) = item.pointer_mut(KINDS) {
            *kinds = Value::Array(content_kinds);
        }
    }
    if let Some(input) = request["input"].as_array_mut() {
        for index in dropped.into_iter().rev() {
            input.remove(index);
        }
        if let Some(entries) = placed.remove(NEW_GROUP) {
            let texts = entries
                .iter()
                .map(|(section, _)| section["text"].as_str().unwrap_or_default());
            input.insert(
                0,
                json!({"type": "message", "role": "developer",
                    "content": texts.map(|text| json!({"type": "input_text", "text": format!("{INSERTED_FRAME}{text}")})).collect::<Vec<_>>(),
                    "internal_chat_message_metadata_passthrough": {"content_item_kinds": vec![MOD_SECTION_KIND; entries.len()]}}),
            );
        }
    }
    true
}

fn text_limit(value: &Value, limit: usize) -> bool {
    value.as_str().is_some_and(|text| text.len() <= limit)
}

fn tool_name(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|tool| !tool.is_empty() && tool.len() <= 128)
}

fn arguments(value: &Value, format: &Value) -> bool {
    match format.as_str() {
        Some("freeform") => text_limit(value, CHUNK_TEXT_BYTES),
        _ => value.as_str().is_some_and(|text| {
            text.len() <= CHUNK_TEXT_BYTES
                && serde_json::from_str::<Value>(text).is_ok_and(|value| value.is_object())
        }),
    }
}

/// The received chunk with only `text`, `tool` or `arguments` changed, or an added index-less `message` or `tool_done`.
fn valid_chunk(chunk: &Value, input: &Value, seen: &mut bool) -> bool {
    let Some(object) = chunk.as_object() else {
        return false;
    };
    if chunk.get("index").is_some() {
        if *seen || chunk["index"] != input["index"] {
            return false;
        }
        *seen = true;
        let mutable: &[&str] = match input["kind"].as_str() {
            Some("text" | "message" | "tool_input") => &["text"],
            Some("tool_call") => &["tool"],
            Some("tool_done") => &["tool", "arguments"],
            _ => &[],
        };
        return object.keys().all(|key| input.get(key).is_some())
            && input.as_object().into_iter().flatten().all(|(key, value)| {
                chunk
                    .get(key)
                    .is_some_and(|item| mutable.contains(&key.as_str()) || item == value)
            })
            && chunk
                .get("text")
                .is_none_or(|text| text == &input["text"] || text_limit(text, CHUNK_TEXT_BYTES))
            && chunk.get("tool").is_none_or(tool_name)
            && chunk.get("arguments").is_none_or(|value| {
                value == &input["arguments"] || arguments(value, &input["format"])
            });
    }
    match chunk["kind"].as_str() {
        Some("message") => {
            object.len() == 2
                && chunk["text"]
                    .as_str()
                    .is_some_and(|text| !text.is_empty() && text.len() <= CHUNK_TEXT_BYTES)
        }
        Some("tool_done") => {
            object.keys().all(|key| {
                ["kind", "tool", "namespace", "arguments", "format"].contains(&key.as_str())
            }) && tool_name(&chunk["tool"])
                && chunk.get("namespace").is_none_or(tool_name)
                && chunk
                    .get("format")
                    .is_none_or(|format| format == "json" || format == "freeform")
                && arguments(
                    &chunk["arguments"],
                    chunk.get("format").unwrap_or(&Value::Null),
                )
        }
        _ => false,
    }
}

/// `{chunks}` built from the received chunk, or a stop at an output boundary; protected chunks pass unchanged.
pub fn valid_stream_result(result: &Value, input: &Value) -> bool {
    let boundary = matches!(
        input["kind"].as_str(),
        Some("message" | "tool_done" | "stop")
    );
    if let Some(stop) = result.get("stop") {
        let reason = stop["reason"]
            .as_str()
            .is_some_and(|reason| !reason.is_empty() && reason.len() <= 256);
        let retry = result.get("retry").is_none_or(|retry| {
            retry.as_object().is_some_and(|object| object.len() == 1)
                && retry["inject"]
                    .as_str()
                    .is_some_and(|text| !text.trim().is_empty() && text.len() <= 4096)
        });
        return boundary
            && reason
            && retry
            && stop.as_object().is_some_and(|object| object.len() == 1)
            && result
                .as_object()
                .is_some_and(|object| object.keys().all(|key| key == "stop" || key == "retry"));
    }
    let Some(chunks) = result["chunks"].as_array() else {
        return false;
    };
    let mut seen = false;
    result.as_object().is_some_and(|object| object.len() == 1)
        && chunks.len() <= CHUNKS
        && chunks.iter().all(|chunk| {
            (boundary || chunk.get("index").is_some()) && valid_chunk(chunk, input, &mut seen)
        })
        && (input["protected"] != true
            || chunks
                .iter()
                .filter(|chunk| chunk.get("index").is_some())
                .any(|chunk| chunk == input))
}

/// `{response: {output}}`: messages and tool calls a handler answers with instead of a provider call.
pub fn valid_answer(result: &Value) -> bool {
    let Some(output) = result
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|_| result["response"].as_object())
        .filter(|response| response.len() == 1)
        .and_then(|response| response.get("output"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    !output.is_empty()
        && output.len() <= CHUNKS
        && output.iter().all(|item| match item["type"].as_str() {
            Some("message") => {
                item.as_object().is_some_and(|object| object.len() == 2)
                    && item["text"]
                        .as_str()
                        .is_some_and(|text| !text.is_empty() && text.len() <= CHUNK_TEXT_BYTES)
            }
            Some("tool_call") => {
                item.as_object().is_some_and(|object| {
                    object.keys().all(|key| {
                        ["type", "tool", "namespace", "arguments"].contains(&key.as_str())
                    })
                }) && tool_name(&item["tool"])
                    && item.get("namespace").is_none_or(tool_name)
                    && (item["arguments"].is_object()
                        && serde_json::to_vec(&item["arguments"])
                            .is_ok_and(|bytes| bytes.len() <= CHUNK_TEXT_BYTES)
                        || text_limit(&item["arguments"], CHUNK_TEXT_BYTES))
            }
            _ => false,
        })
}

/// One raw output item for an injected or synthetic message or tool call.
pub fn output_item(item: &Value, id: &str) -> Value {
    match item["kind"].as_str().or(item["type"].as_str()) {
        Some("message") => {
            json!({"type": "message", "id": id, "role": "assistant", "status": "completed",
            "content": [{"type": "output_text", "text": item["text"], "annotations": []}]})
        }
        _ => {
            let freeform = match item.get("kind") {
                Some(_) => item["format"] == "freeform",
                None => item["arguments"].is_string(),
            };
            let mut call = if freeform {
                json!({"type": "custom_tool_call", "id": id, "call_id": id, "name": item["tool"],
                    "input": item["arguments"], "status": "completed"})
            } else {
                let arguments = match &item["arguments"] {
                    Value::String(text) => text.clone(),
                    value => value.to_string(),
                };
                json!({"type": "function_call", "id": id, "call_id": id, "name": item["tool"],
                    "arguments": arguments, "status": "completed"})
            };
            if let Some(namespace) = item.get("namespace") {
                call["namespace"] = namespace.clone();
            }
            call
        }
    }
}

/// A complete Responses event stream for a synthetic answer; it carries no usage because no provider ran.
pub fn synthetic_events(
    answer: &Value,
    response_id: &str,
    ids: &mut impl FnMut() -> String,
) -> Vec<Value> {
    let mut events = vec![json!({"type": "response.created", "response": {"id": response_id}})];
    for (index, item) in answer["response"]["output"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let id = ids();
        let done = output_item(item, &id);
        if done["type"] == "message" {
            let mut added = done.clone();
            added["status"] = "in_progress".into();
            added["content"] = json!([]);
            events.push(
                json!({"type": "response.output_item.added", "output_index": index, "item": added}),
            );
            events.push(
                json!({"type": "response.output_text.delta", "output_index": index, "item_id": id,
                "content_index": 0, "delta": item["text"]}),
            );
        }
        events.push(
            json!({"type": "response.output_item.done", "output_index": index, "item": done}),
        );
    }
    events.push(json!({"type": "response.completed", "response": {"id": response_id}}));
    events
}

pub const SEND_PAGE_BYTES: usize = 98_304;
pub const SEND_CONTEXT_BYTES: usize = 1024;
pub const SEND_PAGES: usize = 128;
const SEND_SEGMENT_OVERHEAD: usize = 256;
const SEND_PIECE_BYTES: usize = SEND_PAGE_BYTES - 16 * SEND_CONTEXT_BYTES;
pub const SEND_EDITS: usize = 256;
pub const SEND_EDIT_BYTES: usize = 4096;
const SEND_OPAQUE: usize = 256;
/// Policy floors stay fixed in the final request; user text may be redacted there.
const SEND_PROTECTED_KINDS: &[&str] = &[
    "permissions.",
    "network_proxy.",
    "managed_config.",
    "collaboration_mode.",
    "guardian.",
];
const SEND_FIELDS: &[&str] = &["instructions", "input", "tools", "text"];
const STRUCTURAL_KEYS: &[&str] = &[
    "type",
    "id",
    "call_id",
    "status",
    "role",
    "name",
    "namespace",
    "detail",
];
const METADATA_KEY: &str = "internal_chat_message_metadata_passthrough";
const OPAQUE_KEYS: &[&str] = &[
    "encrypted_content",
    "image_url",
    "file_data",
    "file_id",
    "file_url",
    "audio",
    "data",
];

fn pointer_token(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

fn leaves<'a>(
    value: &'a Value,
    pointer: String,
    texts: &mut Vec<(String, &'a str)>,
    opaque: &mut Vec<(String, String)>,
) {
    match value {
        Value::String(text) => texts.push((pointer, text)),
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                leaves(item, format!("{pointer}/{index}"), texts, opaque);
            }
        }
        Value::Object(object) => {
            for (key, item) in object {
                let child = format!("{pointer}/{}", pointer_token(key));
                match item {
                    _ if key == METADATA_KEY => {}
                    Value::String(_) if OPAQUE_KEYS.contains(&key.as_str()) => {
                        opaque.push((child, key.clone()));
                    }
                    Value::String(_) if STRUCTURAL_KEYS.contains(&key.as_str()) => {}
                    _ => leaves(item, child, texts, opaque),
                }
            }
        }
        _ => {}
    }
}

/// One provider-bound text leaf, borrowing its text from the request.
#[derive(Debug, PartialEq)]
pub struct SendSegment<'a> {
    pub id: String,
    pub kind: String,
    pub role: String,
    pub editable: bool,
    pub text: &'a str,
    pub sha256: String,
}

impl SendSegment<'_> {
    pub fn to_json(&self) -> Value {
        json!({"id": self.id, "kind": self.kind, "role": self.role, "editable": self.editable,
            "text": self.text, "bytes": self.text.len(), "sha256": self.sha256})
    }
}

/// Every provider-bound text leaf of a Responses request in request order, the opaque values it carries
/// (unscanned media before encrypted content, capped) and their total count.
pub fn send_segments(request: &Value) -> (Vec<Value>, Vec<Value>, usize) {
    let (segments, opaque, total) = send_segment_refs(request);
    (
        segments.iter().map(SendSegment::to_json).collect(),
        opaque,
        total,
    )
}

/// `send_segments` without copying text, so callers can build JSON only for the segments they forward.
pub fn send_segment_refs(request: &Value) -> (Vec<SendSegment<'_>>, Vec<Value>, usize) {
    let mut texts = Vec::new();
    let mut opaque = Vec::new();
    for field in SEND_FIELDS {
        if let Some(value) = request.get(*field) {
            leaves(value, format!("/{field}"), &mut texts, &mut opaque);
        }
    }
    let segments = texts
        .into_iter()
        .filter(|(_, text)| !text.is_empty())
        .map(|(id, text)| {
            let (kind, role, editable) = classify(request, &id);
            SendSegment {
                sha256: crate::mods::digest(text.as_bytes()),
                id,
                kind,
                role,
                editable,
                text,
            }
        })
        .collect();
    let total = opaque.len();
    opaque.sort_by_key(|(_, kind)| kind == "encrypted_content");
    let opaque = opaque
        .into_iter()
        .take(SEND_OPAQUE)
        .map(|(id, kind)| json!({"id": id, "kind": kind}))
        .collect();
    (segments, opaque, total)
}

fn classify(request: &Value, id: &str) -> (String, String, bool) {
    let parts = id.split('/').skip(1).collect::<Vec<_>>();
    match parts.as_slice() {
        ["instructions"] => ("instructions".into(), "system".into(), true),
        ["tools", ..] => ("tool_spec".into(), "system".into(), false),
        ["text", ..] => ("output_schema".into(), "system".into(), false),
        ["input", index, rest @ ..] => {
            let item = &request["input"][index.parse::<usize>().unwrap_or(usize::MAX)];
            let kind = item["type"].as_str().unwrap_or("item");
            match (kind, rest) {
                ("message", ["content", rest @ ..]) => {
                    let role = item["role"].as_str().unwrap_or("user");
                    let tagged = match rest {
                        [part, "text"] => item
                            .pointer(KINDS)
                            .and_then(|kinds| kinds.get(part.parse::<usize>().ok()?))
                            .and_then(Value::as_str),
                        _ => None,
                    };
                    let kind = tagged.map_or_else(|| format!("message.{role}"), str::to_owned);
                    let editable = matches!(rest, [] | [_, "text"])
                        && !SEND_PROTECTED_KINDS
                            .iter()
                            .any(|prefix| kind.starts_with(prefix));
                    (kind, role.into(), editable)
                }
                ("function_call", ["arguments"]) => {
                    ("tool_call.arguments".into(), "assistant".into(), true)
                }
                ("custom_tool_call", ["input"]) => {
                    ("tool_call.input".into(), "assistant".into(), true)
                }
                ("function_call_output" | "custom_tool_call_output", ["output", ..]) => (
                    "tool_output".into(),
                    "tool".into(),
                    matches!(rest, ["output"] | ["output", _, "text"]),
                ),
                _ => (kind.to_owned(), "assistant".into(), false),
            }
        }
        _ => ("other".into(), "system".into(), false),
    }
}

fn encoded(character: char) -> usize {
    match character {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
        '\0'..='\u{1f}' => 6,
        _ => character.len_utf8(),
    }
}

/// The longest prefix whose JSON-encoded size fits `limit`, cut on a character boundary.
fn encoded_cut(text: &str, limit: usize) -> &str {
    let mut size = 0;
    for (at, character) in text.char_indices() {
        size += encoded(character);
        if size > limit {
            return &text[..at];
        }
    }
    text
}

/// Pages of at most `SEND_PAGE_BYTES` of encoded text; a longer segment arrives in pieces with read-only context.
pub fn send_pages(segments: Vec<Value>) -> Vec<Vec<Value>> {
    let mut pages: Vec<Vec<Value>> = Vec::new();
    let mut room = 0;
    for segment in segments {
        let text = segment["text"].as_str().unwrap_or_default().to_owned();
        let size = text.chars().map(encoded).sum::<usize>() + SEND_SEGMENT_OVERHEAD;
        if size > SEND_PAGE_BYTES {
            let mut offset = 0;
            while offset < text.len() {
                let end = offset + encoded_cut(&text[offset..], SEND_PIECE_BYTES).len();
                let start = offset - cut_back(&text[..offset], SEND_CONTEXT_BYTES).len();
                let after = end + cut(&text[end..], SEND_CONTEXT_BYTES).len();
                let mut piece = segment.clone();
                piece["text"] = text[offset..end].into();
                piece["offset"] = text[..offset].encode_utf16().count().into();
                piece["before"] = text[start..offset].into();
                piece["after"] = text[end..after].into();
                pages.push(vec![piece]);
                offset = end;
            }
            room = 0;
            continue;
        }
        if size > room || pages.is_empty() {
            pages.push(Vec::new());
            room = SEND_PAGE_BYTES;
        }
        room -= size;
        if let Some(page) = pages.last_mut() {
            page.push(segment);
        }
    }
    pages
}

fn cut_back(text: &str, limit: usize) -> &str {
    let mut start = text.len().saturating_sub(limit);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// The byte offset of a JavaScript string index (UTF-16 code units) on a character boundary.
fn byte_index(text: &str, index: usize) -> Option<usize> {
    let mut units = 0;
    for (at, character) in text.char_indices() {
        if units == index {
            return Some(at);
        }
        units += character.len_utf16();
        if units > index {
            return None;
        }
    }
    (units == index).then_some(text.len())
}

fn send_edits(result: &Value) -> Option<Vec<(&str, usize, usize, &str)>> {
    let object = result.as_object()?;
    if !object.keys().all(|key| key == "edits" || key == "cache")
        || object.get("cache").is_some_and(|cache| cache != false)
    {
        return None;
    }
    let edits = object.get("edits")?.as_array()?;
    if edits.len() > SEND_EDITS {
        return None;
    }
    edits
        .iter()
        .map(|edit| {
            (edit.as_object()?.len() == 4).then_some(())?;
            Some((
                edit["segment"].as_str()?,
                usize::try_from(edit["start"].as_u64()?).ok()?,
                usize::try_from(edit["end"].as_u64()?).ok()?,
                edit["text"]
                    .as_str()
                    .filter(|text| text.len() <= SEND_EDIT_BYTES)?,
            ))
        })
        .collect()
}

/// `{edits, cache?}` keeping every edit and `cache: false` beneath it, in non-overlapping ranges of editable segments.
pub fn valid_send_result(result: &Value, last: &Value, input: &Value) -> bool {
    let (Some(edits), Some(inner)) = (send_edits(result), send_edits(last)) else {
        return false;
    };
    if !inner.iter().all(|edit| edits.contains(edit))
        || last["cache"] == false && result["cache"] != false
    {
        return false;
    }
    let segments = input["segments"].as_array().into_iter().flatten();
    let texts = segments
        .filter(|segment| segment["editable"] == true)
        .filter_map(|segment| Some((segment["id"].as_str()?, segment["text"].as_str()?)))
        .collect::<BTreeMap<_, _>>();
    let mut sorted = edits.clone();
    sorted.sort_by_key(|(segment, start, end, _)| (*segment, *start, *end));
    sorted
        .windows(2)
        .all(|pair| pair[0].0 != pair[1].0 || pair[0].2 <= pair[1].1 && pair[0].1 != pair[1].1)
        && sorted.iter().all(|(segment, start, end, _)| {
            texts.get(segment).is_some_and(|text| {
                start <= end
                    && byte_index(text, *start).is_some()
                    && byte_index(text, *end).is_some()
            })
        })
}

/// Byte ranges in the whole segment text for a validated page result, without edits that change nothing.
pub fn page_edits(
    result: &Value,
    page: &[Value],
    request: &Value,
) -> Result<Vec<(String, usize, usize, String)>, String> {
    let mut edits = Vec::new();
    for (segment, start, end, text) in send_edits(result).unwrap_or_default() {
        let located = (|| {
            let item = page.iter().find(|item| item["id"] == segment)?;
            let piece = item["text"].as_str()?;
            let whole = request.pointer(segment)?.as_str()?;
            let offset = match item.get("offset") {
                Some(offset) => byte_index(whole, usize::try_from(offset.as_u64()?).ok()?)?,
                None => 0,
            };
            let (start, end) = (
                offset + byte_index(piece, start)?,
                offset + byte_index(piece, end)?,
            );
            Some((whole.get(start..end)? != text).then_some((start, end)))
        })();
        match located {
            Some(Some((start, end))) => {
                edits.push((segment.to_owned(), start, end, text.to_owned()))
            }
            Some(None) => {}
            None => {
                return Err(format!(
                    "final_request_edit_invalid: {segment} cannot be located"
                ));
            }
        }
    }
    Ok(edits)
}

/// Applies absolute edits to their segments; tool-call arguments that were JSON must stay JSON.
pub fn apply_send_edits(
    request: &mut Value,
    edits: &BTreeMap<String, Vec<(usize, usize, String)>>,
) -> Result<(), String> {
    for (segment, ranges) in edits {
        let Some(Value::String(text)) = request.pointer_mut(segment) else {
            return Err(format!("final_request_edit_invalid: {segment} is not text"));
        };
        let json = segment.ends_with("/arguments") && serde_json::from_str::<Value>(text).is_ok();
        let mut ranges = ranges.clone();
        ranges.sort_by_key(|(start, end, _)| std::cmp::Reverse((*start, *end)));
        let mut floor = usize::MAX;
        for (start, end, replacement) in ranges {
            if end > floor
                || end > text.len()
                || start > end
                || !text.is_char_boundary(start)
                || !text.is_char_boundary(end)
            {
                return Err(format!(
                    "final_request_edit_invalid: {segment} ranges overlap"
                ));
            }
            text.replace_range(start..end, &replacement);
            floor = start;
        }
        if json && serde_json::from_str::<Value>(text).is_err() {
            return Err(format!(
                "final_request_edit_invalid: {segment} is no longer JSON"
            ));
        }
    }
    Ok(())
}

#[derive(Default)]
struct Queue {
    pending: Vec<Value>,
    /// Request id and the batch it was sent with, repeated until a response to it completes and by its retries.
    sent: (String, Vec<Value>),
    delivered: bool,
    issued: usize,
}

static QUEUED: std::sync::Mutex<BTreeMap<String, Queue>> = std::sync::Mutex::new(BTreeMap::new());

/// Queues mod text for the thread's next model request as an inserted section.
pub fn queue_section(thread: &str, owner: &str, text: &str) -> Result<(), String> {
    let mut queued = QUEUED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let queue = queued.entry(thread.to_owned()).or_default();
    if queue.pending.len() >= INSERTED_SECTIONS {
        return Err("model_context_queue_full".into());
    }
    let id = format!("mod:{owner}:notice:{}", queue.issued + 1);
    if id.len() > 64 || text.trim().is_empty() || text.len() > INSERTED_TEXT_BYTES {
        return Err("model_context_invalid".into());
    }
    queue.issued += 1;
    queue.pending.push(json!({"id": id, "text": text}));
    Ok(())
}

/// Adds the thread's queued sections to an outgoing request without taking them: the last sent batch while no
/// response to it has completed or when retrying it, then pending sections, within the room `inserted` sections leave.
/// Returns whether the request changed and the sections it carries.
pub fn apply_queued_sections(
    request: &mut Value,
    thread: &str,
    retry_of: Option<&str>,
    inserted: usize,
) -> (bool, Vec<Value>) {
    let batch = {
        let queued = QUEUED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(queue) = queued.get(thread) else {
            return (false, Vec::new());
        };
        let resent = (!queue.delivered || retry_of.is_some_and(|of| of == queue.sent.0))
            .then_some(&queue.sent.1);
        resent
            .into_iter()
            .flatten()
            .chain(&queue.pending)
            .take(INSERTED_SECTIONS.saturating_sub(inserted))
            .cloned()
            .collect::<Vec<_>>()
    };
    if batch.is_empty() {
        return (false, Vec::new());
    }
    let given = sections(request);
    let effective = given
        .iter()
        .cloned()
        .chain(batch.clone())
        .collect::<Vec<_>>();
    (apply_sections(request, &given, &effective), batch)
}

/// Records what request `request_id` sent once it is ready to send, so a denied request leaves its sections queued.
pub fn commit_queued_sections(thread: &str, request_id: &str, carried: &[Value]) {
    if carried.is_empty() {
        return;
    }
    let mut queued = QUEUED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(queue) = queued.get_mut(thread) else {
        return;
    };
    queue.pending.retain(|section| !carried.contains(section));
    if !queue.delivered {
        let mut omitted = queue
            .sent
            .1
            .iter()
            .filter(|section| !carried.contains(section))
            .cloned()
            .collect::<Vec<_>>();
        omitted.append(&mut queue.pending);
        queue.pending = omitted;
    }
    queue.sent = (request_id.to_owned(), carried.to_vec());
    queue.delivered = false;
}

/// A response to `request_id` completed, so the batch it carried reached the model.
pub fn queued_sections_delivered(thread: &str, request_id: &str) {
    let mut queued = QUEUED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(queue) = queued.get_mut(thread)
        && queue.sent.0 == request_id
    {
        queue.delivered = true;
    }
}

#[cfg(test)]
#[path = "model_request_tests.rs"]
mod tests;
