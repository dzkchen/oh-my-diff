use crate::resource_data::{SNAPSHOT_BYTES, redact};
use serde_json::{Value, json};
use std::io;

pub fn project(
    items: impl Iterator<Item = Value>,
    turn: &str,
    history_revision: u64,
) -> io::Result<Value> {
    let mut records = Vec::new();
    let mut bytes = 0;
    let mut truncated = false;
    for (ordinal, item) in items.enumerate() {
        if ordinal >= 4096 {
            truncated = true;
            break;
        }
        let record = match item["type"].as_str() {
            Some("message")
                if matches!(item["role"].as_str(), Some("user" | "assistant"))
                    && item["channel"] != "analysis" =>
            {
                let text = item["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|part| {
                        matches!(part["type"].as_str(), Some("input_text" | "output_text"))
                    })
                    .filter_map(|part| part["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                if text.is_empty() {
                    continue;
                }
                let safe = redact(&text);
                let bounded: String = safe.chars().take(8192).collect();
                json!({"item":ordinal,"role":item["role"],"text":bounded,"redacted":safe!=text,"truncated":bounded.len()<safe.len()})
            }
            Some("function_call" | "custom_tool_call") => {
                json!({"item":ordinal,"type":"tool_call","name":item["name"].as_str().unwrap_or_default().chars().take(128).collect::<String>(),"call_id":item["call_id"].as_str().unwrap_or_default().chars().take(128).collect::<String>()})
            }
            Some("function_call_output" | "custom_tool_call_output") => {
                json!({"item":ordinal,"type":"tool_result","call_id":item["call_id"].as_str().unwrap_or_default().chars().take(128).collect::<String>(),"output_included":false})
            }
            _ => continue,
        };
        bytes += serde_json::to_vec(&record)?.len();
        if bytes > SNAPSHOT_BYTES / 2 {
            truncated = true;
            break;
        }
        records.push(record);
    }
    Ok(
        json!({"turn_id":turn,"history_revision":history_revision,"records":records,"truncated":truncated,"untrusted":true,"projection":"visible_messages_and_tool_references"}),
    )
}

pub fn combine(prefix: Option<Value>, mut packet: Value) -> io::Result<Value> {
    let mut records = Vec::new();
    let mut bytes = 0;
    let mut truncated = false;
    let mut compacted = false;
    for source in prefix.iter().chain(std::iter::once(&packet)) {
        compacted |= prefix.is_some();
        truncated |= source["truncated"] == true;
        for mut record in source["records"]
            .as_array()
            .ok_or_else(|| io::Error::other("evidence_records_missing"))?
            .clone()
        {
            if record.get("history_revision").is_none() {
                record["history_revision"] = source["history_revision"].clone();
            }
            bytes += serde_json::to_vec(&record)?.len();
            if bytes > SNAPSHOT_BYTES / 2 || records.len() == 4096 {
                truncated = true;
                break;
            }
            records.push(record);
        }
    }
    packet["records"] = json!(records);
    packet["truncated"] = json!(truncated);
    packet["compacted"] = json!(compacted);
    Ok(packet)
}
