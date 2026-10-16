use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

pub const PREVIEW_BYTES: usize = 2048;
pub const VIEW_ITEMS: usize = 2048;
pub const EDIT_BYTES: usize = 262_144;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryEdit {
    #[serde(default)]
    drop: Vec<usize>,
    #[serde(default)]
    replace: Vec<Replace>,
    #[serde(default)]
    insert: Vec<Insert>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Replace {
    index: usize,
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Insert {
    before: usize,
    role: String,
    text: String,
}

fn text(item: &Value) -> Option<String> {
    match item["type"].as_str()? {
        "message" => Some(
            item["content"]
                .as_array()?
                .iter()
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        "function_call_output" | "custom_tool_call_output" => match &item["output"] {
            Value::String(text) => Some(text.clone()),
            other => Some(other.to_string()),
        },
        "function_call" => item["arguments"].as_str().map(str::to_owned),
        "custom_tool_call" => item["input"].as_str().map(str::to_owned),
        _ => None,
    }
}

fn images(item: &Value) -> usize {
    ["content", "output"]
        .iter()
        .filter_map(|field| item[*field].as_array())
        .flatten()
        .filter(|part| part["type"] == "input_image")
        .count()
}

fn editable(item: &Value) -> bool {
    text(item).is_some()
        && item.get("encrypted_content").is_none()
        && item["content"].as_array().is_none_or(|parts| {
            parts.iter().all(|part| {
                matches!(
                    part["type"].as_str(),
                    Some("input_text" | "output_text" | "input_image")
                )
            })
        })
}

fn call_id(item: &Value) -> Option<&str> {
    item["call_id"].as_str()
}

fn preview(text: &str) -> &str {
    &text[..text.floor_char_boundary(PREVIEW_BYTES)]
}

pub fn view(items: &[Value]) -> Value {
    let start = items.len().saturating_sub(VIEW_ITEMS);
    Value::Array(
        items
            .iter()
            .enumerate()
            .skip(start)
            .map(|(index, item)| {
                let body = text(item);
                json!({"index": index, "type": item["type"], "role": item.get("role"),
                    "call_id": call_id(item), "editable": editable(item) && index + 1 < items.len(),
                    "images": images(item),
                    "text": body.as_deref().map(preview), "bytes": body.map_or(0, |body| body.len())})
            })
            .collect(),
    )
}

const COMPACTION_PREVIEW_BYTES: usize = 512;
const COMPACTION_VIEW_ITEMS: usize = 1024;
const COMPACTION_VIEW_TEXT: usize = 131_072;

pub fn compaction_view(items: &[Value]) -> Value {
    let start = items.len().saturating_sub(COMPACTION_VIEW_ITEMS);
    let mut budget = COMPACTION_VIEW_TEXT;
    let mut view = items
        .iter()
        .enumerate()
        .skip(start)
        .rev()
        .map(|(index, item)| {
            let body = text(item);
            let preview = body.as_deref().map(|body| {
                &body[..body.floor_char_boundary(COMPACTION_PREVIEW_BYTES.min(budget))]
            });
            budget -= preview.map_or(0, str::len);
            json!({"index": index, "type": item["type"], "role": item.get("role"),
                "call_id": call_id(item), "editable": editable(item), "images": images(item),
                "text": preview, "bytes": body.as_deref().map_or(0, str::len)})
        })
        .collect::<Vec<_>>();
    view.reverse();
    Value::Array(view)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompactionEdit {
    keep: Vec<usize>,
    #[serde(default)]
    insert: Vec<Insert>,
}

pub fn compact(items: &[Value], edit: CompactionEdit) -> Result<Vec<Value>, String> {
    let invalid = |reason: &str| Err(format!("compaction_history_invalid: {reason}"));
    let bytes = edit.insert.iter().map(|i| i.text.len()).sum::<usize>();
    if bytes > EDIT_BYTES || edit.keep.len() + edit.insert.len() > 4096 {
        return invalid("limit");
    }
    let kept: BTreeSet<usize> = edit.keep.iter().copied().collect();
    if kept.iter().any(|&index| index >= items.len()) {
        return invalid("keep");
    }
    let reasoning = |index: usize| items[index]["type"] == "reasoning";
    for &index in &kept {
        if reasoning(index) && !kept.contains(&(index + 1)) {
            return invalid("reasoning_pair");
        }
        if index > 0 && reasoning(index - 1) && !kept.contains(&(index - 1)) {
            return invalid("reasoning_pair");
        }
        if let Some(id) = call_id(&items[index])
            && items
                .iter()
                .enumerate()
                .any(|(other, item)| call_id(item) == Some(id) && !kept.contains(&other))
        {
            return invalid("unpaired_call");
        }
    }
    let mut inserted: BTreeMap<usize, Vec<Value>> = BTreeMap::new();
    for insert in edit.insert {
        if insert.before > items.len()
            || !matches!(insert.role.as_str(), "user" | "developer")
            || insert.text.trim().is_empty()
        {
            return invalid("insert");
        }
        if insert.before > 0 && reasoning(insert.before - 1) && kept.contains(&(insert.before - 1))
        {
            return invalid("reasoning_pair");
        }
        inserted
            .entry(insert.before)
            .or_default()
            .push(json!({"type": "message",
            "role": insert.role, "content": [{"type": "input_text", "text": insert.text}]}));
    }
    let mut result = Vec::new();
    for (index, item) in items.iter().enumerate() {
        result.extend(inserted.remove(&index).unwrap_or_default());
        if kept.contains(&index) {
            result.push(item.clone());
        }
    }
    result.extend(inserted.remove(&items.len()).unwrap_or_default());
    if result.is_empty() {
        return invalid("empty");
    }
    Ok(result)
}

pub fn apply(items: &[Value], edit: HistoryEdit) -> Result<Vec<Value>, String> {
    let invalid = |reason: &str| Err(format!("history_edit_invalid: {reason}"));
    let last = items.len().checked_sub(1).ok_or("history_empty")?;
    let bytes = edit.replace.iter().map(|r| r.text.len()).sum::<usize>()
        + edit.insert.iter().map(|i| i.text.len()).sum::<usize>();
    if bytes > EDIT_BYTES || edit.drop.len() + edit.replace.len() + edit.insert.len() > 4096 {
        return invalid("limit");
    }
    let dropped: BTreeSet<usize> = edit.drop.iter().copied().collect();
    let mut replaced = BTreeMap::new();
    for replace in edit.replace {
        if replace.index >= last
            || !editable(&items[replace.index])
            || dropped.contains(&replace.index)
            || replaced.insert(replace.index, replace.text).is_some()
        {
            return invalid("replace");
        }
    }
    let reasoning = |index: usize| {
        items
            .get(index)
            .is_some_and(|item| item["type"] == "reasoning")
    };
    for &index in &dropped {
        let item = items.get(index).ok_or("history_edit_invalid: drop")?;
        let droppable = if reasoning(index) {
            dropped.contains(&(index + 1))
        } else {
            editable(item) || call_id(item).is_some()
        };
        if index >= last || !droppable {
            return invalid("drop");
        }
        if index > 0 && reasoning(index - 1) && !dropped.contains(&(index - 1)) {
            return invalid("reasoning_pair");
        }
        if let Some(id) = call_id(item)
            && items
                .iter()
                .enumerate()
                .any(|(other, item)| call_id(item) == Some(id) && !dropped.contains(&other))
        {
            return invalid("unpaired_call");
        }
    }
    let mut inserted: BTreeMap<usize, Vec<Value>> = BTreeMap::new();
    for insert in edit.insert {
        if insert.before > last || !matches!(insert.role.as_str(), "user" | "developer") {
            return invalid("insert");
        }
        if insert.before > 0
            && reasoning(insert.before - 1)
            && !dropped.contains(&(insert.before - 1))
        {
            return invalid("reasoning_pair");
        }
        inserted
            .entry(insert.before)
            .or_default()
            .push(json!({"type": "message",
            "role": insert.role, "content": [{"type": "input_text", "text": insert.text}]}));
    }
    let mut result = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        result.extend(inserted.remove(&index).unwrap_or_default());
        if dropped.contains(&index) {
            continue;
        }
        let mut item = item.clone();
        if let Some(text) = replaced.remove(&index) {
            match item["type"].as_str() {
                Some("message") => {
                    let kind = if item["role"] == "assistant" {
                        "output_text"
                    } else {
                        "input_text"
                    };
                    item["content"] = json!([{"type": kind, "text": text}]);
                }
                Some("function_call") => item["arguments"] = Value::String(text),
                Some("custom_tool_call") => item["input"] = Value::String(text),
                _ => item["output"] = Value::String(text),
            }
        }
        result.push(item);
    }
    Ok(result)
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
