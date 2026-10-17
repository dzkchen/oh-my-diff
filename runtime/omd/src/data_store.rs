use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::io::Write;
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::path::PathBuf;

pub const KEY_BYTES: usize = 256;
pub const VALUE_BYTES: usize = crate::mods::HOST_RECEIPT_BYTES / 2;
pub const SCOPE_BYTES: usize = 16 * 1024 * 1024;
pub const KEY_LIMIT: usize = 4096;
const LIST_LIMIT: usize = 256;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    UserCommand,
    Tool,
    Event,
    Cli,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StoreProvenance {
    pub r#mod: String,
    pub source_sha256: String,
    pub thread_id: Option<String>,
    pub origin: Origin,
    pub at: u128,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    value: Value,
    revision: u64,
    provenance: StoreProvenance,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Document {
    schema: u32,
    generation: u64,
    next_revision: u64,
    entries: BTreeMap<String, Entry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    value: Option<Value>,
    #[serde(default)]
    expected_revision: Option<u64>,
    #[serde(default)]
    expected_generation: Option<u64>,
    #[serde(default)]
    prefix: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default = "repository_scope")]
    scope: String,
}
fn repository_scope() -> String {
    "repository".into()
}

fn parse_request(operation: &str, arguments: &Value) -> io::Result<Input> {
    let input: Input = serde_json::from_value(arguments.clone())?;
    if !matches!(input.scope.as_str(), "repository" | "user" | "thread") {
        return Err(failure("store_scope_invalid"));
    }
    if matches!(operation, "store.get" | "store.put" | "store.delete")
        && !input.key.as_deref().is_some_and(key)
    {
        return Err(failure("store_key_invalid"));
    }
    match operation {
        "store.put" => {
            let value = input
                .value
                .as_ref()
                .ok_or_else(|| failure("store_value_required"))?;
            if serde_json::to_vec(value)?.len() > VALUE_BYTES {
                return Err(failure("store_value_limit"));
            }
            if arguments.get("expected_revision").is_none() {
                return Err(failure("store_expected_revision_required"));
            }
        }
        "store.delete" if input.expected_revision.is_none() => {
            return Err(failure("store_expected_revision_required"));
        }
        "store.reset" if input.expected_generation.is_none() => {
            return Err(failure("store_expected_generation_required"));
        }
        _ => {}
    }
    Ok(input)
}

pub(crate) fn validate_request(operation: &str, arguments: &Value) -> io::Result<()> {
    parse_request(operation, arguments).map(|_| ())
}

pub struct DataStore<'a> {
    pub root: &'a Path,
    pub repository_key: &'a str,
    pub owner: &'a str,
    pub provenance: StoreProvenance,
}

fn failure(message: impl ToString) -> io::Error {
    io::Error::other(message.to_string())
}

fn key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= KEY_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && byte != b'\\')
}

fn newest_change(path: &Path) -> Option<std::time::SystemTime> {
    let mut newest = fs::symlink_metadata(path).ok()?.modified().ok()?;
    for entry in fs::read_dir(path).ok()?.filter_map(Result::ok) {
        if entry.file_type().is_ok_and(|kind| kind.is_dir())
            && let Some(changed) = newest_change(&entry.path())
        {
            newest = newest.max(changed);
        }
    }
    Some(newest)
}

pub fn prune_thread_directories(directory: &Path, keep: impl Fn(&str) -> bool) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 86_400);
    for entry in entries.filter_map(Result::ok) {
        if entry.file_type().is_ok_and(|kind| kind.is_dir())
            && !keep(&entry.file_name().to_string_lossy())
            && newest_change(&entry.path()).is_some_and(|changed| changed < cutoff)
        {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn thread_directory(root: &Path, thread: &str) -> io::Result<PathBuf> {
    if !crate::resource_data::token(thread) || root.canonicalize()? != root {
        return Err(failure("store_thread_invalid"));
    }
    Ok(root.join("data").join("threads").join(thread))
}

fn copy_regular_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_regular_tree(&entry.path(), &target)?;
        } else if kind.is_file() && !entry.file_name().to_string_lossy().starts_with('.') {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

pub fn fork_thread_data(root: &Path, from: &str, to: &str) -> io::Result<bool> {
    let (source, target) = (thread_directory(root, from)?, thread_directory(root, to)?);
    match fs::symlink_metadata(&source) {
        Ok(metadata) if metadata.is_dir() => {
            if target.try_exists()? {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "store_thread_exists",
                ));
            }
            let threads = target
                .parent()
                .ok_or_else(|| failure("store_thread_invalid"))?;
            let stage = tempfile::Builder::new()
                .prefix(".fork-")
                .tempdir_in(threads)?;
            copy_regular_tree(&source, stage.path())?;
            // A writer may create the target directory meanwhile; an exclusive rename never replaces even an empty one.
            crate::workspace::rename_exclusive(
                rustix::fs::CWD,
                stage.path(),
                rustix::fs::CWD,
                target.as_path(),
            )?;
            let _ = stage.keep();
            Ok(true)
        }
        Ok(_) => Err(failure("store_directory_invalid")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub fn remove_thread_data(root: &Path, thread: &str) -> io::Result<bool> {
    crate::turn_activity::TurnActivityLog::open(&root.join("turn-activity"), thread)?.remove()?;
    let directory = thread_directory(root, thread)?;
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(&directory).map(|()| true),
        Ok(_) => Err(failure("store_directory_invalid")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

impl DataStore<'_> {
    fn directory(&self, scope: &str) -> io::Result<PathBuf> {
        let components = match scope {
            "repository" => vec!["data", self.repository_key, self.owner],
            "user" => vec!["data", "user", self.owner],
            "thread" => {
                let thread = self
                    .provenance
                    .thread_id
                    .as_deref()
                    .ok_or_else(|| failure("store_thread_unavailable"))?;
                if !crate::resource_data::token(thread) {
                    return Err(failure("store_thread_invalid"));
                }
                vec!["data", "threads", thread, self.owner]
            }
            _ => return Err(failure("store_scope_invalid")),
        };
        if !crate::resource_data::token(self.owner)
            || !(scope != "repository"
                || self.repository_key.len() == 64
                    && self
                        .repository_key
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit()))
            || self.root.canonicalize()? != self.root
        {
            return Err(failure("store_root_invalid"));
        }
        crate::workspace::private_path(self.root, &components, "store_directory_invalid")
    }

    fn with_document<T>(
        &self,
        scope: &str,
        write: bool,
        change: impl FnOnce(&mut Document) -> io::Result<T>,
    ) -> io::Result<T> {
        let directory = self.directory(scope)?;
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(directory.join(".store.lock"))?;
        lock.lock()?;
        let path = directory.join("store.json");
        let mut document = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() && metadata.len() <= (SCOPE_BYTES * 2) as u64 => {
                serde_json::from_slice::<Document>(&fs::read(&path)?)?
            }
            Ok(_) => return Err(failure("store_document_invalid")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Document {
                schema: 1,
                generation: 1,
                next_revision: 1,
                entries: BTreeMap::new(),
            },
            Err(error) => return Err(error),
        };
        if document.schema != 1 {
            return Err(failure("store_schema_unsupported"));
        }
        let value = change(&mut document)?;
        if write {
            let bytes = serde_json::to_vec(&document)?;
            if bytes.len() > SCOPE_BYTES || document.entries.len() > KEY_LIMIT {
                return Err(failure("store_quota"));
            }
            let temporary = directory.join(format!(".store.json.{}", std::process::id()));
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)?;
            let written = file.write_all(&bytes).and_then(|()| file.sync_all());
            if let Err(error) = written.and_then(|()| fs::rename(&temporary, &path)) {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
        }
        Ok(value)
    }

    pub fn call(&self, operation: &str, arguments: Value) -> io::Result<Value> {
        let input = parse_request(operation, &arguments)?;
        let checked_key = || {
            input
                .key
                .as_deref()
                .ok_or_else(|| failure("store_key_invalid"))
        };
        match operation {
            "store.get" => {
                let name = checked_key()?.to_owned();
                self.with_document(&input.scope, false, |document| {
                    Ok(document.entries.get(&name).map_or(Value::Null, |entry| {
                        json!({"value": entry.value, "revision": entry.revision, "provenance": entry.provenance})
                    }))
                })
            }
            "store.put" => {
                let name = checked_key()?.to_owned();
                let value = input
                    .value
                    .clone()
                    .ok_or_else(|| failure("store_value_required"))?;
                let expected = input.expected_revision;
                let provenance = StoreProvenance {
                    at: u128::from(crate::peers::now_ms()),
                    ..self.provenance.clone()
                };
                self.with_document(&input.scope, true, |document| {
                    let current = document.entries.get(&name).map(|entry| entry.revision);
                    if current != expected {
                        return Err(failure(format!(
                            "store_revision_conflict: current {}",
                            current.map_or("absent".to_owned(), |value| value.to_string())
                        )));
                    }
                    let revision = document.next_revision;
                    document.next_revision += 1;
                    document.entries.insert(
                        name,
                        Entry {
                            value,
                            revision,
                            provenance,
                        },
                    );
                    Ok(json!({"revision": revision}))
                })
            }
            "store.delete" => {
                let name = checked_key()?.to_owned();
                let expected = input
                    .expected_revision
                    .ok_or_else(|| failure("store_expected_revision_required"))?;
                self.with_document(&input.scope, true, |document| {
                    match document.entries.get(&name) {
                        Some(entry) if entry.revision == expected => {
                            document.entries.remove(&name);
                            Ok(json!({"deleted": true}))
                        }
                        Some(_) => Err(failure("store_revision_conflict")),
                        None => Ok(json!({"deleted": false})),
                    }
                })
            }
            "store.list" => {
                let prefix = input.prefix.clone().unwrap_or_default();
                let limit = input.limit.unwrap_or(LIST_LIMIT).clamp(1, LIST_LIMIT);
                self.with_document(&input.scope, false, |document| {
                    let keys = document
                        .entries
                        .iter()
                        .filter(|(name, _)| name.starts_with(&prefix))
                        .filter(|(name, _)| input.cursor.as_ref().is_none_or(|cursor| *name > cursor))
                        .take(limit + 1)
                        .map(|(name, entry)| {
                            Ok(json!({"key": name, "revision": entry.revision,
                                "bytes": serde_json::to_vec(&entry.value)?.len(), "provenance": entry.provenance}))
                        })
                        .collect::<io::Result<Vec<_>>>()?;
                    let cursor = (keys.len() > limit).then(|| keys[limit - 1]["key"].clone());
                    Ok(json!({"keys": &keys[..keys.len().min(limit)], "cursor": cursor.unwrap_or(Value::Null),
                        "generation": document.generation}))
                })
            }
            "store.export" => {
                self.with_document(&input.scope, false, |document| {
                    let mut entries = serde_json::Map::new();
                    let mut bytes = 0;
                    let mut cursor = Value::Null;
                    for (name, entry) in document.entries.iter().filter(|(name, _)| {
                        input.cursor.as_ref().is_none_or(|cursor| *name > cursor)
                    }) {
                        let value = serde_json::to_value(entry)?;
                        let size = name.len() + serde_json::to_vec(&value)?.len();
                        if !entries.is_empty() && bytes + size > VALUE_BYTES {
                            cursor = json!(entries.keys().next_back());
                            break;
                        }
                        bytes += size;
                        entries.insert(name.clone(), value);
                    }
                    Ok(
                        json!({"schema": 1, "owner": self.owner, "scope": input.scope,
                    "generation": document.generation, "entries": entries, "cursor": cursor}),
                    )
                })
            }
            "store.reset" => {
                let expected = input
                    .expected_generation
                    .ok_or_else(|| failure("store_expected_generation_required"))?;
                self.with_document(&input.scope, true, |document| {
                    if document.generation != expected {
                        return Err(failure("store_generation_conflict"));
                    }
                    document.entries.clear();
                    document.generation += 1;
                    Ok(json!({"generation": document.generation}))
                })
            }
            _ => Err(failure(format!("unsupported_host_operation: {operation}"))),
        }
    }
}
