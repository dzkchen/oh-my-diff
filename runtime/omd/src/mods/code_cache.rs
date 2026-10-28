//! Compiled package modules kept across runner processes, by module source and runner build.

use super::Result;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

const LIMIT: u64 = 32 << 20;

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

pub(super) struct CodeCache {
    directory: PathBuf,
    expected: BTreeSet<String>,
}

impl CodeCache {
    /// The cache for `request` under `root`, keyed by the runner's file stamp; `None` without a runner.
    pub(super) fn open<R>(root: &Path, request: &R) -> Option<Self>
    where
        R: for<'a> std::ops::Index<&'a str, Output = Value>,
    {
        let runner = super::process::runner_path().ok()?;
        let stamp = super::file_stamp(&std::fs::metadata(runner).ok()?);
        let name = format!("{:x}", Sha256::digest(format!("{stamp:?}")));
        Some(Self {
            directory: root.join(&name[..16]),
            expected: keys(request),
        })
    }

    /// The line offering a fresh runner the intact cached modules within `budget` bytes; even an empty offer asks it to report what it compiles.
    pub(super) fn line(&self, budget: usize) -> Option<Vec<u8>> {
        let mut entries = Map::new();
        let mut size = 20;
        for name in &self.expected {
            let Ok(bytes) = std::fs::read(self.directory.join(name)) else {
                continue;
            };
            let Some((sum, body)) = bytes.split_at_checked(32) else {
                continue;
            };
            let Ok(entry) = serde_json::from_slice::<Value>(body) else {
                continue;
            };
            if Sha256::digest(body).as_slice() != sum || size + body.len() + name.len() + 4 > budget
            {
                continue;
            }
            size += body.len() + name.len() + 4;
            entries.insert(name.clone(), entry);
        }
        let mut line = serde_json::to_vec(&json!({"code_cache": entries})).ok()?;
        line.push(b'\n');
        Some(line)
    }

    /// Keeps a module the runner compiled for this request; anything else it reports is ignored.
    pub(super) fn keep(&self, reported: &Value) {
        let Some(name) = reported["key"]
            .as_str()
            .filter(|name| self.expected.contains(*name))
        else {
            return;
        };
        let (Some(code), Some(data)) = (reported["code"].as_str(), reported["data"].as_str())
        else {
            return;
        };
        let _ = self.write(name, &json!({"code": code, "data": data}));
    }

    fn write(&self, name: &str, entry: &Value) -> Result<()> {
        std::fs::create_dir_all(&self.directory)?;
        let body = serde_json::to_vec(entry)?;
        let mut bytes = Sha256::digest(&body).to_vec();
        bytes.extend_from_slice(&body);
        let temporary = self.directory.join(format!(
            ".{name}.{}.{:?}.tmp",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::write(&temporary, &bytes)?;
        std::fs::rename(&temporary, self.directory.join(name))?;
        static PRUNED: AtomicBool = AtomicBool::new(false);
        if !PRUNED.swap(true, Ordering::Relaxed) {
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
        let path = cache.directory.join("b");
        let bytes = std::fs::read(&path).unwrap();
        let at = bytes.len() - 3;
        assert_eq!(&bytes[at..], b"d\"}");
        let mut corrupt = bytes;
        corrupt[at] = b'e';
        std::fs::write(&path, corrupt).unwrap();
        let line: Value = serde_json::from_slice(&cache.line(1 << 20).unwrap()).unwrap();
        assert_eq!(
            line,
            json!({"code_cache": {"a": {"code": "c", "data": "d"}}})
        );
    }
}
