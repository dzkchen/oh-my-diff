//! V8 bytecode of package modules kept across runner processes, by module source and runner build.
//!
//! Entries hold bytecode only: the runner always compiles the request's trusted source, so the cache can't supply code.

use super::Result;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::os::unix::fs::DirBuilderExt;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::OnceLock;

const LIMIT: u64 = 32 << 20;
/// Bytes written to a cache root between prunes.
const PRUNE_EVERY: u64 = LIMIT / 8;

/// The runner's key for a module: the hex SHA-256 of `"{typescript}:{source}"`.
fn key(typescript: bool, source: &str) -> String {
    format!("{:x}", Sha256::digest(format!("{typescript}:{source}")))
}

/// Every module a runner may compile for `request`, as the runner keys them.
fn keys<R>(request: &R) -> BTreeSet<String>
where
    R: for<'a> std::ops::Index<&'a str, Output = Value>,
{
    let mut modules = vec![(true, &request["source"])];
    for (name, asset) in request["assets"].as_object().into_iter().flatten() {
        if !name.ends_with(".json") {
            modules.push((name.ends_with(".ts"), &asset["text"]));
        }
    }
    let adapter = &request["surface"]["adapter"];
    modules.push((true, &adapter["source"]));
    for alias in adapter["aliases"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(_, alias)| alias)
    {
        let typescript = alias["filename"]
            .as_str()
            .is_some_and(|name| name.ends_with(".ts"));
        modules.push((typescript, &alias["source"]));
    }
    modules
        .into_iter()
        .filter_map(|(typescript, source)| Some(key(typescript, source.as_str()?)))
        .collect()
}

/// A mod's cache root and, once computed, the modules its requests may compile.
pub(super) struct CacheRoot {
    root: PathBuf,
    expected: OnceLock<BTreeSet<String>>,
}

impl CacheRoot {
    pub(super) fn new(root: PathBuf) -> Self {
        Self {
            root,
            expected: OnceLock::new(),
        }
    }
}

pub(super) struct CodeCache {
    directory: PathBuf,
    expected: BTreeSet<String>,
}

impl CodeCache {
    /// The cache for `request` under `cache`, keyed by the runner's file stamp; `None` without a runner.
    pub(super) fn open<R>(cache: &CacheRoot, request: &R) -> Option<Self>
    where
        R: for<'a> std::ops::Index<&'a str, Output = Value>,
    {
        let runner = super::process::runner_path().ok()?;
        let stamp = super::file_stamp(&std::fs::metadata(runner).ok()?);
        let name = format!("{:x}", Sha256::digest(format!("{stamp:?}")));
        Some(Self {
            directory: cache.root.join(&name[..16]),
            expected: cache.expected.get_or_init(|| keys(request)).clone(),
        })
    }

    /// The line offering a fresh runner the intact cached bytecode within `budget` bytes. It lists every expected
    /// module (`null` where none is cached), so the runner reports exactly those it compiles fresh.
    pub(super) fn line(&self, budget: usize) -> Option<Vec<u8>> {
        let mut entries = Map::new();
        // `{"code_cache":{}}` plus a newline, then per entry its quoted name, colon and comma.
        let mut size = 20;
        for name in &self.expected {
            let cached = self
                .read(name)
                .filter(|entry| size + entry.to_string().len() + name.len() + 4 <= budget);
            size += cached.as_ref().map_or(4, |entry| entry.to_string().len()) + name.len() + 4;
            entries.insert(name.clone(), cached.unwrap_or(Value::Null));
        }
        let mut line = serde_json::to_vec(&json!({"code_cache": entries})).ok()?;
        line.push(b'\n');
        Some(line)
    }

    /// An intact entry: its SHA-256 then a JSON body holding the bytecode.
    fn read(&self, name: &str) -> Option<Value> {
        let bytes = std::fs::read(self.directory.join(name)).ok()?;
        let (sum, body) = bytes.split_at_checked(32)?;
        let entry = serde_json::from_slice::<Value>(body).ok()?;
        (Sha256::digest(body).as_slice() == sum && entry["data"].is_string()).then_some(entry)
    }

    /// Keeps bytecode the runner compiled for this request; anything else it reports is ignored.
    pub(super) fn keep(&self, reported: &Value) {
        let Some(name) = reported["key"]
            .as_str()
            .filter(|name| self.expected.contains(*name))
        else {
            return;
        };
        let Some(data) = reported["data"].as_str() else {
            return;
        };
        let _ = self.write(name, &json!({"data": data}));
    }

    fn write(&self, name: &str, entry: &Value) -> Result<()> {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.directory)?;
        let body = serde_json::to_vec(entry)?;
        let mut bytes = Sha256::digest(&body).to_vec();
        bytes.extend_from_slice(&body);
        crate::fsio::write_bytes(
            &self.directory.join(name),
            &bytes,
            crate::fsio::Durability::Volatile,
        )?;
        static WRITTEN: Mutex<Vec<(PathBuf, u64)>> = Mutex::new(Vec::new());
        let due = {
            let mut written = WRITTEN
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let root = self
                .directory
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_default();
            let index = match written.iter().position(|(seen, _)| *seen == root) {
                Some(index) => index,
                // A process prunes a root at its first write there, then every `PRUNE_EVERY` bytes.
                None => {
                    written.push((root, PRUNE_EVERY));
                    written.len() - 1
                }
            };
            let since = &mut written[index].1;
            *since += bytes.len() as u64;
            let due = *since >= PRUNE_EVERY;
            if due {
                *since = 0;
            }
            due
        };
        if due {
            self.prune();
        }
        Ok(())
    }

    /// Drops the oldest entries of every runner build beyond `LIMIT`, then emptied directories.
    fn prune(&self) {
        let Some(root) = self.directory.parent() else {
            return;
        };
        let directories: Vec<_> = std::fs::read_dir(root)
            .into_iter()
            .flatten()
            .flatten()
            .map(|directory| directory.path())
            .collect();
        let mut entries: Vec<_> = directories
            .iter()
            .flat_map(|directory| std::fs::read_dir(directory).into_iter().flatten().flatten())
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                Some((metadata.modified().ok()?, metadata.len(), entry.path()))
            })
            .collect();
        let mut total: u64 = entries.iter().map(|(_, size, _)| size).sum();
        entries.sort();
        for (_, size, path) in entries {
            if total <= LIMIT {
                break;
            }
            if std::fs::remove_file(path).is_ok() {
                total -= size;
            }
        }
        for directory in directories {
            if directory != self.directory {
                let _ = std::fs::remove_dir(directory);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_corrupt_entry_is_not_offered() {
        let temp = tempfile::tempdir().unwrap();
        let cache = CodeCache {
            directory: temp.path().join("runner"),
            expected: ["a", "b"].map(String::from).into(),
        };
        for name in ["a", "b"] {
            cache.keep(&json!({"key": name, "code": "c", "data": "d"}));
        }
        assert_eq!(
            std::fs::read(cache.directory.join("a")).unwrap()[32..],
            *br#"{"data":"d"}"#
        );
        let path = cache.directory.join("b");
        let bytes = std::fs::read(&path).unwrap();
        let at = bytes.len() - 3;
        assert_eq!(&bytes[at..], b"d\"}");
        let mut corrupt = bytes;
        corrupt[at] = b'e';
        std::fs::write(&path, corrupt).unwrap();
        let line: Value = serde_json::from_slice(&cache.line(1 << 20).unwrap()).unwrap();
        assert_eq!(line, json!({"code_cache": {"a": {"data": "d"}, "b": null}}));
    }
}
