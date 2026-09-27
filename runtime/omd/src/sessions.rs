use crate::resource_data::{PAGE_BYTES, hash, redact, token};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const SOURCE_BYTES: usize = 32 * 1024 * 1024;
const SCAN_FILES: usize = 4096;
const SCAN_BYTES: u64 = 128 * 1024 * 1024;

pub struct SessionIndex<'a> {
    pub root: &'a Path,
    pub database: Option<&'a Path>,
    pub repository: &'a Path,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub task_id: String,
    pub parent_id: Option<String>,
    pub timestamp: String,
    pub revision: String,
    pub history_mode: String,
    pub inherited_history: bool,
    pub incomplete_tail: bool,
    pub projection_truncated: bool,
}

struct Session {
    summary: SessionSummary,
    records: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListRequest {
    since: Option<String>,
    until: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadRequest {
    session_id: String,
    revision: String,
    cursor: Option<usize>,
    max_bytes: Option<usize>,
}

fn date(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, byte)| matches!(i, 4 | 7) || byte.is_ascii_digit())
        && value[5..7]
            .parse::<u32>()
            .is_ok_and(|month| (1..=12).contains(&month))
        && value[8..10]
            .parse::<u32>()
            .is_ok_and(|day| (1..=31).contains(&day))
}

impl SessionIndex<'_> {
    fn paths(&self, active: &dyn Fn() -> bool) -> io::Result<(Vec<PathBuf>, bool)> {
        if !self.enabled {
            return Err(io::Error::other("session_access_disabled"));
        }
        if !active() {
            return Err(io::Error::other("session_read_cancelled"));
        }
        if self.repository.canonicalize()? != self.repository
            || self.root.canonicalize()? != self.root
            || !fs::symlink_metadata(self.root)?.is_dir()
        {
            return Err(io::Error::other("session_scope_not_canonical"));
        }
        let mut pending = vec![(self.root.to_path_buf(), 0)];
        let mut paths = Vec::new();
        let mut seen = 0;
        let mut bytes = 0u64;
        while let Some((directory, depth)) = pending.pop() {
            if !active() {
                return Err(io::Error::other("session_read_cancelled"));
            }
            let mut entries = fs::read_dir(directory)?
                .take(SCAN_FILES + 1 - seen)
                .collect::<Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                seen += 1;
                if seen > SCAN_FILES {
                    return Ok((paths, true));
                }
                let kind = entry.file_type()?;
                if kind.is_symlink() {
                    continue;
                }
                if kind.is_dir() && depth < 3 {
                    pending.push((entry.path(), depth + 1));
                } else if kind.is_file()
                    && entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "jsonl")
                {
                    bytes = bytes.saturating_add(entry.metadata()?.len());
                    if bytes > SCAN_BYTES {
                        return Ok((paths, true));
                    }
                    paths.push(entry.path());
                }
            }
        }
        paths.sort();
        Ok((paths, false))
    }

    fn load(&self, path: &Path, active: &dyn Fn() -> bool) -> io::Result<Option<Session>> {
        if !active() {
            return Err(io::Error::other("session_read_cancelled"));
        }
        let name = path
            .strip_prefix(self.root)
            .map_err(io::Error::other)?
            .to_str()
            .ok_or_else(|| io::Error::other("session_path_encoding"))?;
        let selected = BTreeSet::from([name.to_owned()]);
        let snapshot = crate::Snapshot::capture(self.root, &selected, SOURCE_BYTES)?;
        let bytes = &snapshot
            .files
            .get(name)
            .ok_or_else(|| io::Error::other("session_missing"))?
            .bytes;
        let complete = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |index| index + 1);
        let mut lines = bytes[..complete]
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty());
        let first: Value = serde_json::from_slice(
            lines
                .next()
                .ok_or_else(|| io::Error::other("session_empty"))?,
        )?;
        if first["type"] != "session_meta" {
            return Ok(None);
        }
        let initial = &first["payload"];
        let mut latest = initial.clone();
        for line in lines.clone() {
            if !active() {
                return Err(io::Error::other("session_read_cancelled"));
            }
            let record: Value = serde_json::from_slice(line)?;
            if record["type"] == "session_meta" {
                if record["payload"]["id"] != initial["id"]
                    || record["payload"]["cwd"] != initial["cwd"]
                {
                    return Err(io::Error::other("session_metadata_changed_identity"));
                }
                latest = record["payload"].clone();
            }
        }
        let meta = &latest;
        let cwd = meta["cwd"].as_str().map(Path::new);
        if cwd.and_then(|path| path.canonicalize().ok()).as_deref() != Some(self.repository)
            || meta["memory_mode"]
                .as_str()
                .is_some_and(|mode| mode != "enabled")
            || meta["session_review"] == false
        {
            return Ok(None);
        }
        let id = meta["id"]
            .as_str()
            .filter(|id| token(id))
            .ok_or_else(|| io::Error::other("session_id_invalid"))?;
        let timestamp = meta["timestamp"]
            .as_str()
            .filter(|value| value.len() <= 40 && value.get(..10).is_some_and(date))
            .ok_or_else(|| io::Error::other("session_timestamp_invalid"))?;
        let mut summary = SessionSummary {
            session_id: id.to_owned(),
            task_id: meta["session_id"]
                .as_str()
                .filter(|id| token(id))
                .unwrap_or(id)
                .to_owned(),
            parent_id: meta["parent_thread_id"]
                .as_str()
                .filter(|id| token(id))
                .map(str::to_owned),
            timestamp: timestamp.to_owned(),
            revision: hash(&bytes[..complete]),
            history_mode: meta["history_mode"].as_str().unwrap_or("legacy").to_owned(),
            inherited_history: !meta["history_base"].is_null() || !meta["forked_from_id"].is_null(),
            incomplete_tail: complete != bytes.len(),
            projection_truncated: false,
        };
        let mut records = Vec::new();
        let mut turn = String::new();
        let mut in_scope = false;
        for (index, line) in lines.enumerate() {
            if !active() {
                return Err(io::Error::other("session_read_cancelled"));
            }
            let value: Value = serde_json::from_slice(line)?;
            let payload = &value["payload"];
            if let Some(start) = meta["subagent_history_start_ordinal"].as_u64() {
                let ordinal = value["ordinal"].as_u64().unwrap_or(index as u64 + 1);
                if ordinal < start {
                    continue;
                }
            }
            if value["type"] == "turn_context" {
                in_scope = payload["cwd"]
                    .as_str()
                    .and_then(|path| Path::new(path).canonicalize().ok())
                    .as_deref()
                    == Some(self.repository);
                turn = payload["turn_id"]
                    .as_str()
                    .filter(|id| token(id))
                    .unwrap_or_default()
                    .to_owned();
                continue;
            }
            if !in_scope
                || value["type"] != "response_item"
                || payload["type"] != "message"
                || !matches!(payload["role"].as_str(), Some("user" | "assistant"))
                || payload["channel"] == "analysis"
            {
                continue;
            }
            let text = payload["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| matches!(item["type"].as_str(), Some("input_text" | "output_text")))
                .filter_map(|item| item["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            if text.is_empty() {
                continue;
            }
            let redacted = redact(&text);
            let limited: String = redacted.chars().take(2048).collect();
            records.push(json!({"session_id":id,"turn_id":turn,"item":index+1,"role":payload["role"],"text":limited,"truncated":limited.len()<redacted.len(),"redacted":redacted!=text,"timestamp":value["timestamp"],"untrusted":true}));
            if records.len() >= 4096 {
                summary.projection_truncated = true;
                break;
            }
        }
        Ok(Some(Session { summary, records }))
    }

    pub fn call(
        &self,
        operation: &str,
        arguments: Value,
        active: impl Fn() -> bool,
    ) -> io::Result<Value> {
        if !self.enabled {
            return Err(io::Error::other("session_access_disabled"));
        }
        let policy =
            crate::session_policy::permitted(self.root, self.repository, self.database, &active)?;
        let allowed = |id: &str| policy.as_ref().is_none_or(|ids| ids.contains(id));
        let result = match operation {
            "sessions.list" => {
                let input: ListRequest = serde_json::from_value(arguments)?;
                let limit = input.limit.unwrap_or(20);
                if !(1..=100).contains(&limit)
                    || input.since.as_ref().is_some_and(|value| !date(value))
                    || input.until.as_ref().is_some_and(|value| !date(value))
                    || matches!((&input.since, &input.until), (Some(since), Some(until)) if since >= until)
                {
                    return Err(io::Error::other("session_list_bounds"));
                }
                let (paths, truncated) = self.paths(&active)?;
                let mut unavailable = 0;
                let mut rows = Vec::new();
                let mut ids = BTreeSet::new();
                for path in paths {
                    match self.load(&path, &active) {
                        Ok(Some(session))
                            if allowed(&session.summary.session_id)
                                && input.since.as_ref().is_none_or(|date| {
                                    session.summary.timestamp[..10] >= **date
                                })
                                && input.until.as_ref().is_none_or(|date| {
                                    session.summary.timestamp[..10] < **date
                                }) =>
                        {
                            if !ids.insert(session.summary.session_id.clone()) {
                                return Err(io::Error::other("session_identity_ambiguous"));
                            }
                            rows.push(session.summary);
                        }
                        Ok(_) => (),
                        Err(error) if !active() => return Err(error),
                        Err(_) => unavailable += 1,
                    }
                }
                rows.sort_by(|a, b| {
                    (&b.timestamp, &b.session_id).cmp(&(&a.timestamp, &a.session_id))
                });
                let revision = hash(&serde_json::to_vec(&rows)?);
                let start = match input.cursor {
                    Some(cursor) => {
                        let (digest, offset) = cursor
                            .split_once(':')
                            .ok_or_else(|| io::Error::other("session_cursor_invalid"))?;
                        if digest != revision {
                            return Err(io::Error::other("session_index_changed"));
                        }
                        offset.parse::<usize>().map_err(io::Error::other)?
                    }
                    None => 0,
                };
                if start > rows.len() {
                    return Err(io::Error::other("session_cursor_invalid"));
                }
                let end = start.saturating_add(limit).min(rows.len());
                Ok(
                    json!({"sessions":rows[start..end],"cursor":(end<rows.len()).then(||format!("{revision}:{end}")),"revision":revision,"scan_truncated":truncated,"unavailable":unavailable,"projection":"local_visible_message_records"}),
                )
            }
            "sessions.read" => {
                let input: ReadRequest = serde_json::from_value(arguments)?;
                let limit = input.max_bytes.unwrap_or(PAGE_BYTES);
                if !token(&input.session_id)
                    || input.revision.len() != 64
                    || !(1024..=PAGE_BYTES).contains(&limit)
                {
                    return Err(io::Error::other("session_read_bounds"));
                }
                if !allowed(&input.session_id) {
                    return Err(io::Error::other("session_opted_out_or_unavailable"));
                }
                let (paths, truncated) = self.paths(&active)?;
                if truncated {
                    return Err(io::Error::other("session_scan_incomplete"));
                }
                let mut found = None;
                for path in paths {
                    if let Ok(Some(session)) = self.load(&path, &active)
                        && session.summary.session_id == input.session_id
                    {
                        if found.is_some() {
                            return Err(io::Error::other("session_identity_ambiguous"));
                        }
                        found = Some(session);
                    }
                    if !active() {
                        return Err(io::Error::other("session_read_cancelled"));
                    }
                }
                let session = found.ok_or_else(|| io::Error::other("session_unavailable"))?;
                if input.revision != session.summary.revision {
                    return Err(io::Error::other("session_revision_changed"));
                }
                let start = input.cursor.unwrap_or(0);
                if start > session.records.len() {
                    return Err(io::Error::other("session_cursor_invalid"));
                }
                let mut end = start;
                let mut bytes = 0;
                while let Some(record) = session.records.get(end) {
                    let size = serde_json::to_vec(record)?.len();
                    if bytes + size > limit {
                        break;
                    }
                    bytes += size;
                    end += 1;
                }
                if end == start && end < session.records.len() {
                    return Err(io::Error::other("session_record_exceeds_page"));
                }
                Ok(
                    json!({"session":session.summary,"records":session.records[start..end],"cursor":(end<session.records.len()).then_some(end),"bytes":bytes,"projection":"local_visible_message_records"}),
                )
            }
            _ => Err(io::Error::other("session_operation_unavailable")),
        }?;
        if !active() {
            return Err(io::Error::other("session_read_cancelled"));
        }
        if policy
            != crate::session_policy::permitted(self.root, self.repository, self.database, &active)?
        {
            return Err(io::Error::other("session_policy_changed"));
        }
        Ok(result)
    }
}
