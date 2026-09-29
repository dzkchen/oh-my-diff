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
        _ => None,
    }
}

fn editable(item: &Value) -> bool {
    text(item).is_some()
        && item.get("encrypted_content").is_none()
        && item["content"].as_array().is_none_or(|parts| {
            parts
                .iter()
                .all(|part| matches!(part["type"].as_str(), Some("input_text" | "output_text")))
        })
}

fn call_id(item: &Value) -> Option<&str> {
    item["call_id"].as_str()
}

fn preview(text: &str) -> &str {
    let mut end = text.len().min(PREVIEW_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
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
                    "text": body.as_deref().map(preview), "bytes": body.map_or(0, |body| body.len())})
            })
            .collect(),
    )
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
            if item["type"] == "message" {
                let kind = if item["role"] == "assistant" {
                    "output_text"
                } else {
                    "input_text"
                };
                item["content"] = json!([{"type": kind, "text": text}]);
            } else {
                item["output"] = Value::String(text);
            }
        }
        result.push(item);
    }
    Ok(result)
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
