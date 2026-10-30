use codex_file_watcher::DebouncedWatchReceiver;
use codex_file_watcher::FileWatcher;
use codex_file_watcher::WatchPath;
use codex_file_watcher::WatchRegistration;
use std::collections::BTreeMap;
use std::io;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

pub(crate) const DEBOUNCE_MS: (u64, u64, u64) = (50, 200, 10_000);

pub(crate) type ChangeSink = Arc<dyn Fn(&str, Vec<String>) + Send + Sync>;

struct Watch {
    source: String,
    key: Option<(String, String)>,
    _registration: WatchRegistration,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(crate) struct WorkspaceWatches {
    watcher: Arc<FileWatcher>,
    root: PathBuf,
    protected: Vec<PathBuf>,
    watches: Mutex<BTreeMap<(String, String), Watch>>,
    next: Mutex<u64>,
    limits: codex_omd::mod_limits::ModLimits,
}

fn relative(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    if relative.components().any(|c| c.as_os_str() == ".git") {
        return None;
    }
    relative.to_str().map(str::to_owned)
}

const GIT_FILES: [&str; 3] = ["HEAD", "index", "packed-refs"];

fn git_dirs(root: &Path) -> Option<(PathBuf, PathBuf)> {
    let top = root.ancestors().find(|dir| dir.join(".git").exists())?;
    let dot = top.join(".git").canonicalize().ok()?;
    if dot.is_dir() {
        return Some((dot.clone(), dot));
    }
    let text = std::fs::read_to_string(&dot).ok()?;
    let git = top
        .join(text.strip_prefix("gitdir:")?.trim())
        .canonicalize()
        .ok()?;
    let Ok(common) = std::fs::read_to_string(git.join("commondir")) else {
        return (git.join("HEAD").is_file()
            && git.join("refs").is_dir()
            && git.join("objects").is_dir())
        .then(|| (git.clone(), git));
    };
    let common = git.join(common.trim()).canonicalize().ok()?;
    let backlink = std::fs::read_to_string(git.join("gitdir")).ok()?;
    (git.parent() == Some(common.join("worktrees").as_path())
        && git.join(backlink.trim()).canonicalize().ok()? == dot)
        .then_some((git, common))
}

fn git_change(dirs: &(PathBuf, PathBuf), path: &Path) -> Option<String> {
    let own = path
        .strip_prefix(&dirs.0)
        .ok()
        .and_then(Path::to_str)
        .filter(|name| GIT_FILES[..2].contains(name));
    let shared = || {
        path.strip_prefix(&dirs.1)
            .ok()
            .and_then(Path::to_str)
            .filter(|name| *name == GIT_FILES[2] || name.starts_with("refs/"))
    };
    own.or_else(shared)
        .filter(|name| !name.ends_with(".lock"))
        .map(|name| format!(".git/{name}"))
}

fn keyed(watches: &BTreeMap<(String, String), Watch>, owner: &str, key: &str) -> Option<String> {
    watches
        .iter()
        .find(|((mod_id, _), watch)| {
            mod_id == owner && watch.key.as_ref().is_some_and(|(kept, _)| kept == key)
        })
        .map(|((_, id), _)| id.clone())
}

impl WorkspaceWatches {
    pub(crate) fn new(
        watcher: Arc<FileWatcher>,
        root: PathBuf,
        protected: Vec<PathBuf>,
        limits: codex_omd::mod_limits::ModLimits,
    ) -> io::Result<Self> {
        let root = root.canonicalize()?;
        Ok(Self {
            watcher,
            root,
            protected,
            watches: Mutex::new(BTreeMap::new()),
            next: Mutex::new(0),
            limits: limits.bounded(),
        })
    }

    fn resolve(&self, path: &str) -> io::Result<PathBuf> {
        let candidate = Path::new(path);
        if candidate.is_absolute()
            || candidate
                .components()
                .any(|c| matches!(c, Component::ParentDir))
        {
            return Err(io::Error::other(format!("watch_path_invalid: {path}")));
        }
        let resolved = self
            .root
            .join(candidate)
            .canonicalize()
            .map_err(|_| io::Error::other(format!("watch_path_missing: {path}")))?;
        let protected = self
            .protected
            .iter()
            .any(|p| resolved.starts_with(p) || p.starts_with(&resolved));
        if !resolved.starts_with(&self.root)
            || relative(&self.root, &resolved).is_none() && resolved != self.root
            || protected
        {
            return Err(io::Error::other(format!("watch_path_denied: {path}")));
        }
        Ok(resolved)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn watch(
        &self,
        owner: &str,
        source: &str,
        paths: &[String],
        recursive: bool,
        git: bool,
        debounce_ms: Option<u64>,
        key: Option<(&str, &str)>,
        sink: ChangeSink,
    ) -> io::Result<(String, Option<String>)> {
        if paths.is_empty() || paths.len() > self.limits.paths_per_watch {
            return Err(io::Error::other("watch_paths_invalid"));
        }
        let debounce = debounce_ms.unwrap_or(DEBOUNCE_MS.1);
        if !(DEBOUNCE_MS.0..=DEBOUNCE_MS.2).contains(&debounce) {
            return Err(io::Error::other("watch_debounce_invalid"));
        }
        let resolved = paths
            .iter()
            .map(|path| self.resolve(path))
            .collect::<io::Result<Vec<_>>>()?;
        let dirs = if git {
            Some(git_dirs(&self.root).ok_or_else(|| io::Error::other("watch_git_unavailable"))?)
        } else {
            None
        };
        let mut watches = self
            .watches
            .lock()
            .map_err(|_| io::Error::other("watch_state_poisoned"))?;
        let replaced = key.and_then(|(key, _)| keyed(&watches, owner, key));
        if let (Some(previous), Some((_, shape))) = (&replaced, key)
            && watches
                .get(&(owner.to_owned(), previous.clone()))
                .is_some_and(|watch| {
                    watch.source == source
                        && watch.key.as_ref().is_some_and(|(_, kept)| kept == shape)
                })
        {
            return Ok((previous.clone(), None));
        }
        if replaced.is_none()
            && watches.keys().filter(|(mod_id, _)| mod_id == owner).count()
                >= self.limits.watches_per_mod
        {
            return Err(io::Error::other("watch_limit"));
        }
        let id = {
            let mut next = self
                .next
                .lock()
                .map_err(|_| io::Error::other("watch_state_poisoned"))?;
            *next += 1;
            format!("w{}", *next)
        };
        let (subscriber, receiver) = self.watcher.add_subscriber();
        let mut targets: Vec<WatchPath> = resolved
            .iter()
            .map(|path| WatchPath {
                path: path.clone(),
                recursive,
            })
            .collect();
        if let Some((git, common)) = &dirs {
            for (path, recursive) in [(git, false), (common, false), (&common.join("refs"), true)] {
                if !targets.iter().any(|target| target.path == *path) {
                    targets.push(WatchPath {
                        path: path.clone(),
                        recursive,
                    });
                }
            }
        }
        let registration = subscriber.register_paths(targets);
        let mut receiver = DebouncedWatchReceiver::new(receiver, Duration::from_millis(debounce));
        let (root, protected, watch_id) = (self.root.clone(), self.protected.clone(), id.clone());
        let task = tokio::spawn(async move {
            let _subscriber = subscriber;
            while let Some(event) = receiver.recv().await {
                let mut changed: Vec<String> = event
                    .paths
                    .iter()
                    .filter(|path| !protected.iter().any(|p| path.starts_with(p)))
                    .filter_map(|path| {
                        dirs.as_ref()
                            .and_then(|dirs| git_change(dirs, path))
                            .or_else(|| relative(&root, path))
                    })
                    .collect();
                changed.sort();
                changed.dedup();
                if !changed.is_empty() {
                    sink(&watch_id, changed);
                }
            }
        });
        if let Some(previous) = &replaced {
            watches.remove(&(owner.to_owned(), previous.clone()));
        }
        watches.insert(
            (owner.to_owned(), id.clone()),
            Watch {
                source: source.to_owned(),
                key: key.map(|(key, shape)| (key.to_owned(), shape.to_owned())),
                _registration: registration,
                task,
            },
        );
        Ok((id, replaced))
    }

    pub(crate) fn unwatch_key(&self, owner: &str, key: &str) -> bool {
        self.watches.lock().is_ok_and(|mut watches| {
            keyed(&watches, owner, key)
                .is_some_and(|id| watches.remove(&(owner.to_owned(), id)).is_some())
        })
    }

    pub(crate) fn unwatch(&self, owner: &str, id: &str) -> bool {
        self.watches
            .lock()
            .is_ok_and(|mut watches| watches.remove(&(owner.to_owned(), id.to_owned())).is_some())
    }

    pub(crate) fn retain_sources(&self, sources: &BTreeMap<String, String>) {
        if let Ok(mut watches) = self.watches.lock() {
            watches.retain(|(owner, _), watch| sources.get(owner) == Some(&watch.source));
        }
    }

    pub(crate) fn unwatch_all(&self, owner: &str) -> usize {
        self.watches.lock().map_or(0, |mut watches| {
            let before = watches.len();
            watches.retain(|(mod_id, _), _| mod_id != owner);
            before - watches.len()
        })
    }
}

#[cfg(test)]
#[path = "workspace_watch_tests.rs"]
mod tests;
