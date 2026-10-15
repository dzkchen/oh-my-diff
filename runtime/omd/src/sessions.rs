use crate::mods::{FileStamp, file_stamp};
use crate::resource_data::{PAGE_BYTES, hash, redact, token};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, BufRead, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const SOURCE_BYTES: usize = 32 * 1024 * 1024;
const HEAD_BYTES: u64 = 1024 * 1024;
const SCAN_FILES: usize = 4096;
const SCAN_BYTES: u64 = 128 * 1024 * 1024;
const META_FIELDS: [&str; 11] = [
    "id",
    "session_id",
    "parent_thread_id",
    "cwd",
    "timestamp",
    "memory_mode",
    "session_review",
    "history_mode",
    "history_base",
    "forked_from_id",
    "subagent_history_start_ordinal",
];

/// Rollout heads by path, valid while the file keeps its stamp; `None` marks a file that is not a session.
static PARSED: Mutex<BTreeMap<PathBuf, (FileStamp, Option<Arc<Parsed>>)>> =
    Mutex::new(BTreeMap::new());
/// The most recently read sessions' projections, newest first.
static PROJECTIONS: Mutex<Vec<Arc<Projection>>> = Mutex::new(Vec::new());
const PROJECTIONS_KEPT: usize = 4;
#[cfg(test)]
static READS: Mutex<BTreeMap<PathBuf, usize>> = Mutex::new(BTreeMap::new());

pub struct SessionIndex<'a> {
    pub root: &'a Path,
    pub database: Option<&'a Path>,
    pub repository: &'a Path,
    pub enabled: bool,
    pub tools: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub task_id: String,
    pub parent_id: Option<String>,
    pub timestamp: String,
    pub revision: String,
    pub handle: String,
    pub history_mode: String,
    pub inherited_history: bool,
    pub incomplete_tail: bool,
}

struct Parsed {
    head: Value,
    meta: Value,
    revision: String,
    incomplete_tail: bool,
}

struct Session {
    summary: SessionSummary,
    meta: Value,
    stamp: FileStamp,
    bytes: Option<Vec<u8>>,
}

type Records = Arc<(Vec<Value>, bool)>;

struct Projection {
    path: PathBuf,
    stamp: FileStamp,
    repository: PathBuf,
    tools: bool,
    scopes: BTreeMap<String, bool>,
    records: Records,
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
    handle: String,
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

fn segment(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.trim_end_matches(".zst").to_owned())
}

fn cancelled() -> io::Error {
    io::Error::other("session_read_cancelled")
}

fn in_range(timestamp: Option<&str>, since: Option<&String>, until: Option<&String>) -> bool {
    timestamp
        .and_then(|value| value.get(..10))
        .is_some_and(|day| {
            since.is_none_or(|since| day >= since.as_str())
                && until.is_none_or(|until| day < until.as_str())
        })
}

impl SessionIndex<'_> {
    fn paths(&self, active: &dyn Fn() -> bool) -> io::Result<(Vec<PathBuf>, bool)> {
        if !self.enabled {
            return Err(io::Error::other("session_access_disabled"));
        }
        if !active() {
            return Err(cancelled());
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
        let mut truncated = false;
        while let Some((directory, depth)) = pending.pop() {
            if !active() {
                return Err(cancelled());
            }
            let mut entries = fs::read_dir(directory)?
                .take(SCAN_FILES + 1 - seen)
                .collect::<Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                seen += 1;
                if seen > SCAN_FILES {
                    truncated = true;
                    pending.clear();
                    break;
                }
                let kind = entry.file_type()?;
                if kind.is_dir() && depth < 3 {
                    pending.push((entry.path(), depth + 1));
                } else if kind.is_file()
                    && entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "jsonl")
                {
                    paths.push(entry.path());
                }
            }
        }
        paths.sort();
        let listed = |path: &Path| {
            !path.starts_with(self.root)
                || paths
                    .binary_search_by(|listed| listed.as_path().cmp(path))
                    .is_ok()
        };
        if let Ok(mut parsed) = PARSED.lock() {
            parsed.retain(|path, _| listed(path));
        }
        if let Ok(mut projections) = PROJECTIONS.lock() {
            projections.retain(|projection| listed(&projection.path));
        }
        Ok((paths, truncated))
    }

    fn name<'p>(&self, path: &'p Path) -> io::Result<&'p str> {
        path.strip_prefix(self.root)
            .map_err(io::Error::other)?
            .to_str()
            .ok_or_else(|| io::Error::other("session_path_encoding"))
    }

    fn scoped(&self, meta: &Value) -> bool {
        meta["cwd"]
            .as_str()
            .and_then(|path| Path::new(path).canonicalize().ok())
            .as_deref()
            == Some(self.repository)
    }

    fn head(&self, path: &Path) -> io::Result<Option<Value>> {
        let mut line = Vec::new();
        io::BufReader::new(crate::workspace::open_contained(
            self.root,
            self.name(path)?,
        )?)
        .take(HEAD_BYTES)
        .read_until(b'\n', &mut line)?;
        let first: Value = serde_json::from_slice(&line)?;
        Ok((first["type"] == "session_meta").then(|| first["payload"].clone()))
    }

    /// The database's current segment and the segments its `history_base` chain continues.
    fn lineage(&self, current: &Path, paths: &[PathBuf]) -> BTreeSet<String> {
        let mut names = BTreeSet::new();
        let mut next = segment(current);
        while let Some(name) = next.take()
            && names.insert(name.clone())
        {
            let base = paths
                .iter()
                .find(|path| segment(path).as_ref() == Some(&name))
                .and_then(|path| self.head(path).ok().flatten())
                .and_then(|head| {
                    head["history_base"]["thread_id"]
                        .as_str()
                        .map(str::to_owned)
                });
            next = base.and_then(|base| {
                paths.iter().filter_map(|path| segment(path)).find(|name| {
                    let stem = name.trim_end_matches(".jsonl");
                    stem.ends_with(&format!("-{base}")) || stem.ends_with(&format!("_{base}"))
                })
            });
        }
        names
    }

    /// The rollout's complete lines; a trailing partial record is dropped and reported.
    fn read(&self, path: &Path) -> io::Result<(Vec<u8>, bool)> {
        let name = self.name(path)?;
        #[cfg(test)]
        if let Ok(mut reads) = READS.lock() {
            *reads.entry(path.to_path_buf()).or_default() += 1;
        }
        let mut snapshot =
            crate::Snapshot::capture(self.root, &BTreeSet::from([name.to_owned()]), SOURCE_BYTES)?;
        let mut bytes = snapshot
            .files
            .remove(name)
            .ok_or_else(|| io::Error::other("session_missing"))?
            .bytes;
        let complete = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |index| index + 1);
        let incomplete_tail = complete != bytes.len();
        bytes.truncate(complete);
        Ok((bytes, incomplete_tail))
    }

    fn parse(
        bytes: &[u8],
        incomplete_tail: bool,
        active: &dyn Fn() -> bool,
    ) -> io::Result<Option<Parsed>> {
        let mut lines = bytes
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
        let mut meta = initial.clone();
        for line in
            lines.filter(|line| line.windows(14).any(|window| window == b"\"session_meta\""))
        {
            if !active() {
                return Err(cancelled());
            }
            let record: Value = serde_json::from_slice(line)?;
            if record["type"] == "session_meta" {
                if record["payload"]["id"] != initial["id"]
                    || record["payload"]["cwd"] != initial["cwd"]
                {
                    return Err(io::Error::other("session_metadata_changed_identity"));
                }
                meta = record["payload"].clone();
            }
        }
        let meta = META_FIELDS
            .iter()
            .filter_map(|field| Some(((*field).to_owned(), meta.get(field)?.clone())))
            .collect::<Map<_, _>>();
        Ok(Some(Parsed {
            head: json!({"cwd": initial["cwd"], "timestamp": initial["timestamp"]}),
            meta: Value::Object(meta),
            revision: hash(bytes),
            incomplete_tail,
        }))
    }

    fn cached(path: &Path, stamp: &FileStamp) -> Option<Option<Arc<Parsed>>> {
        PARSED
            .lock()
            .ok()?
            .get(path)
            .filter(|(seen, _)| seen == stamp)
            .map(|(_, parsed)| parsed.clone())
    }

    fn load(&self, path: &Path, active: &dyn Fn() -> bool) -> io::Result<Option<Session>> {
        if !active() {
            return Err(cancelled());
        }
        let name = self.name(path)?;
        let stamp = file_stamp(&fs::symlink_metadata(path)?);
        let (parsed, bytes) = match Self::cached(path, &stamp) {
            Some(parsed) => (parsed, None),
            None => {
                let (bytes, incomplete_tail) = self.read(path)?;
                let parsed = Self::parse(&bytes, incomplete_tail, active)?.map(Arc::new);
                if let Ok(mut cache) = PARSED.lock() {
                    if cache.len() >= SCAN_FILES && !cache.contains_key(path) {
                        cache.pop_first();
                    }
                    cache.insert(path.to_path_buf(), (stamp, parsed.clone()));
                }
                (parsed, Some(bytes))
            }
        };
        let Some(parsed) = parsed else {
            return Ok(None);
        };
        let meta = &parsed.meta;
        if !self.scoped(meta)
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
        let summary = SessionSummary {
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
            revision: parsed.revision.clone(),
            handle: hash(name.as_bytes()),
            history_mode: meta["history_mode"].as_str().unwrap_or("legacy").to_owned(),
            inherited_history: !meta["history_base"].is_null() || !meta["forked_from_id"].is_null(),
            incomplete_tail: parsed.incomplete_tail,
        };
        Ok(Some(Session {
            summary,
            meta: parsed.meta.clone(),
            stamp,
            bytes,
        }))
    }

    /// The session's projected records, reusing a recent projection while the rollout keeps its stamp.
    fn projection(
        &self,
        path: &Path,
        session: Session,
        active: &dyn Fn() -> bool,
    ) -> io::Result<Records> {
        let recent = PROJECTIONS.lock().ok().and_then(|mut projections| {
            let index = projections.iter().position(|projection| {
                projection.path == path
                    && projection.stamp == session.stamp
                    && projection.repository == self.repository
                    && projection.tools == self.tools
            })?;
            let projection = projections.remove(index);
            projections.insert(0, projection.clone());
            Some(projection)
        });
        if let Some(projection) = recent.filter(|projection| {
            projection
                .scopes
                .iter()
                .all(|(cwd, scoped)| self.scoped(&json!({ "cwd": cwd })) == *scoped)
        }) {
            return Ok(projection.records.clone());
        }
        let reread;
        let bytes = match &session.bytes {
            Some(bytes) => bytes,
            None => {
                reread = self.read(path)?.0;
                if hash(&reread) != session.summary.revision {
                    return Err(io::Error::other("session_revision_changed"));
                }
                &reread
            }
        };
        let mut scopes = BTreeMap::new();
        let records = Arc::new(self.records(&session, bytes, &mut scopes, active)?);
        if let Ok(mut projections) = PROJECTIONS.lock() {
            projections.retain(|projection| projection.path != path);
            projections.insert(
                0,
                Arc::new(Projection {
                    path: path.to_path_buf(),
                    stamp: session.stamp,
                    repository: self.repository.to_path_buf(),
                    tools: self.tools,
                    scopes,
                    records: records.clone(),
                }),
            );
            projections.truncate(PROJECTIONS_KEPT);
        }
        Ok(records)
    }

    fn records(
        &self,
        session: &Session,
        bytes: &[u8],
        scopes: &mut BTreeMap<String, bool>,
        active: &dyn Fn() -> bool,
    ) -> io::Result<(Vec<Value>, bool)> {
        let id = &session.summary.session_id;
        let mut records = Vec::new();
        let mut turn = String::new();
        let mut in_scope = false;
        let lines = bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .skip(1);
        for (index, line) in lines.enumerate() {
            if !active() {
                return Err(cancelled());
            }
            let value: Value = serde_json::from_slice(line)?;
            let payload = &value["payload"];
            if let Some(start) = session.meta["subagent_history_start_ordinal"].as_u64() {
                let ordinal = value["ordinal"].as_u64().unwrap_or(index as u64 + 1);
                if ordinal < start {
                    continue;
                }
            }
            if value["type"] == "turn_context" {
                in_scope = self.scoped(payload);
                if let Some(cwd) = payload["cwd"].as_str() {
                    scopes.insert(cwd.to_owned(), in_scope);
                }
                turn = payload["turn_id"]
                    .as_str()
                    .filter(|id| token(id))
                    .unwrap_or_default()
                    .to_owned();
                continue;
            }
            if !in_scope || value["type"] != "response_item" {
                continue;
            }
            let parts = |content: &Value| {
                content
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|item| {
                        matches!(item["type"].as_str(), Some("input_text" | "output_text"))
                    })
                    .filter_map(|item| item["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            let mut record = json!({"session_id":id,"turn_id":turn,"item":index+1,"timestamp":value["timestamp"],"untrusted":true});
            let (field, text) = match payload["type"].as_str() {
                Some("message")
                    if matches!(payload["role"].as_str(), Some("user" | "assistant"))
                        && payload["channel"] != "analysis" =>
                {
                    let text = parts(&payload["content"]);
                    if text.is_empty() {
                        continue;
                    }
                    record["kind"] = json!("message");
                    record["role"] = payload["role"].clone();
                    ("text", text)
                }
                Some(kind @ ("function_call" | "custom_tool_call" | "local_shell_call")) => {
                    let name = if kind == "local_shell_call" {
                        "local_shell"
                    } else {
                        payload["name"].as_str().unwrap_or_default()
                    };
                    let arguments = match kind {
                        "function_call" => {
                            payload["arguments"].as_str().unwrap_or_default().to_owned()
                        }
                        "custom_tool_call" => {
                            payload["input"].as_str().unwrap_or_default().to_owned()
                        }
                        _ => payload["action"].to_string(),
                    };
                    record["kind"] = json!("tool_call");
                    record["name"] = json!(name.chars().take(128).collect::<String>());
                    record["call_id"] = payload["call_id"].clone();
                    ("arguments", arguments)
                }
                Some("function_call_output" | "custom_tool_call_output") => {
                    record["kind"] = json!("tool_result");
                    record["call_id"] = payload["call_id"].clone();
                    let output = match &payload["output"] {
                        Value::String(text) => text.clone(),
                        content => parts(content),
                    };
                    ("output", output)
                }
                _ => continue,
            };
            if field == "text" || self.tools {
                let redacted = redact(&text);
                let limited: String = redacted.chars().take(2048).collect();
                record["truncated"] = json!(limited.len() < redacted.len());
                record["redacted"] = json!(redacted != text);
                record[field] = json!(limited);
            } else {
                record["bytes"] = json!(text.len());
                record["sha256"] = json!(hash(text.as_bytes()));
            }
            records.push(record);
            if records.len() >= 4096 {
                return Ok((records, true));
            }
        }
        Ok((records, false))
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
        let allowed = |id: &str| policy.as_ref().is_none_or(|ids| ids.contains_key(id));
        let lineages = std::cell::RefCell::new(std::collections::BTreeMap::new());
        let current = |id: &str, path: &Path, paths: &[PathBuf]| {
            policy
                .as_ref()
                .and_then(|ids| ids.get(id))
                .and_then(Option::as_ref)
                .is_none_or(|current| {
                    segment(path).is_some_and(|name| {
                        lineages
                            .borrow_mut()
                            .entry(id.to_owned())
                            .or_insert_with(|| self.lineage(current, paths))
                            .contains(&name)
                    })
                })
        };
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
                let (paths, mut truncated) = self.paths(&active)?;
                let (since, until) = (input.since.as_ref(), input.until.as_ref());
                let mut unavailable = 0;
                let mut scanned = 0u64;
                let mut rows = Vec::new();
                let mut ids = BTreeSet::new();
                for path in paths.iter().rev() {
                    let metadata = fs::symlink_metadata(path).ok();
                    let head = match metadata
                        .as_ref()
                        .and_then(|metadata| Self::cached(path, &file_stamp(metadata)))
                    {
                        Some(parsed) => Ok(parsed.map(|parsed| parsed.head.clone())),
                        None => self.head(path),
                    };
                    let head = match head {
                        Ok(Some(head)) => head,
                        Ok(None) => continue,
                        Err(_) if !active() => return Err(cancelled()),
                        Err(_) => {
                            unavailable += 1;
                            continue;
                        }
                    };
                    if !self.scoped(&head) || !in_range(head["timestamp"].as_str(), since, until) {
                        continue;
                    }
                    scanned = scanned.saturating_add(metadata.map_or(0, |meta| meta.len()));
                    if scanned > SCAN_BYTES {
                        truncated = true;
                        break;
                    }
                    match self.load(path, &active) {
                        Ok(Some(session))
                            if allowed(&session.summary.session_id)
                                && current(&session.summary.session_id, path, &paths)
                                && in_range(Some(&session.summary.timestamp), since, until) =>
                        {
                            if !ids.insert((
                                session.summary.session_id.clone(),
                                session.meta["history_base"].to_string(),
                            )) {
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
                    json!({"sessions":rows[start..end],"cursor":(end<rows.len()).then(||format!("{revision}:{end}")),"revision":revision,"scan_truncated":truncated,"unavailable":unavailable,"projection":"local_visible_records"}),
                )
            }
            "sessions.read" => {
                let input: ReadRequest = serde_json::from_value(arguments)?;
                let limit = input.max_bytes.unwrap_or(PAGE_BYTES);
                if !token(&input.session_id)
                    || input.revision.len() != 64
                    || input.handle.len() != 64
                    || !(1024..=PAGE_BYTES).contains(&limit)
                {
                    return Err(io::Error::other("session_read_bounds"));
                }
                if !allowed(&input.session_id) {
                    return Err(io::Error::other("session_opted_out_or_unavailable"));
                }
                let (paths, _) = self.paths(&active)?;
                let path = paths
                    .iter()
                    .find(|path| {
                        self.name(path)
                            .is_ok_and(|name| hash(name.as_bytes()) == input.handle)
                    })
                    .ok_or_else(|| io::Error::other("session_unavailable"))?;
                let session = self
                    .load(path, &active)?
                    .filter(|session| {
                        session.summary.session_id == input.session_id
                            && current(&input.session_id, path, &paths)
                    })
                    .ok_or_else(|| io::Error::other("session_unavailable"))?;
                if input.revision != session.summary.revision {
                    return Err(io::Error::other("session_revision_changed"));
                }
                let summary = session.summary.clone();
                let projection = self.projection(path, session, &active)?;
                let (records, projection_truncated) = (&projection.0, projection.1);
                let start = input.cursor.unwrap_or(0);
                if start > records.len() {
                    return Err(io::Error::other("session_cursor_invalid"));
                }
                let mut end = start;
                let mut bytes = 0;
                while let Some(record) = records.get(end) {
                    let size = serde_json::to_vec(record)?.len();
                    if bytes + size > limit {
                        break;
                    }
                    bytes += size;
                    end += 1;
                }
                if end == start && end < records.len() {
                    return Err(io::Error::other("session_record_exceeds_page"));
                }
                Ok(
                    json!({"session":summary,"records":records[start..end],"cursor":(end<records.len()).then_some(end),"bytes":bytes,"projection":"local_visible_records","projection_truncated":projection_truncated}),
                )
            }
            _ => Err(io::Error::other("session_operation_unavailable")),
        }?;
        if !active() {
            return Err(cancelled());
        }
        if policy
            != crate::session_policy::permitted(self.root, self.repository, self.database, &active)?
        {
            return Err(io::Error::other("session_policy_changed"));
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paging_large_rollouts_in_turn_reads_each_once_after_listing() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let (repo, root) = (base.join("repo"), base.join("sessions"));
        fs::create_dir(&repo).unwrap();
        fs::create_dir(&root).unwrap();
        let text = "x".repeat(2000);
        let paths = ["large", "other"].map(|id| {
            let mut rows = vec![
                json!({"type":"session_meta","payload":{"id":id,"cwd":repo,"timestamp":"2026-09-26T12:00:00Z"}}),
                json!({"type":"turn_context","payload":{"turn_id":"turn","cwd":repo}}),
            ];
            rows.extend((0..2048).map(|_| json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}})));
            let path = root.join(format!("{id}.jsonl"));
            fs::write(
                &path,
                rows.iter()
                    .map(|row| row.to_string() + "\n")
                    .collect::<String>(),
            )
            .unwrap();
            assert!(fs::metadata(&path).unwrap().len() > 4 * 1024 * 1024);
            path
        });
        let index = SessionIndex {
            root: &root,
            database: None,
            repository: &repo,
            enabled: true,
            tools: false,
        };
        let reads = || {
            paths
                .each_ref()
                .map(|path| READS.lock().unwrap().get(path).copied())
        };
        let sessions = index.call("sessions.list", json!({}), || true).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(sessions.len(), 2);
        assert_eq!(reads(), [Some(1); 2]);
        let (mut cursors, mut pages, mut records) = ([Some(0); 2], 0, 0);
        while cursors.iter().any(Option::is_some) {
            for (summary, cursor) in sessions.iter().zip(&mut cursors) {
                let Some(start) = *cursor else { continue };
                let page = index
                    .call(
                        "sessions.read",
                        json!({"session_id":summary["session_id"],"revision":summary["revision"],"handle":summary["handle"],"cursor":start}),
                        || true,
                    )
                    .unwrap();
                records += page["records"].as_array().unwrap().len();
                *cursor = page["cursor"].as_u64().map(|cursor| cursor as usize);
                pages += 1;
            }
        }
        assert!(pages > 200);
        assert_eq!(records, 4096);
        assert_eq!(reads(), [Some(2); 2]);
    }
}
