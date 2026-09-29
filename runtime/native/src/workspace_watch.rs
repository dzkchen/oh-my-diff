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
        debounce_ms: Option<u64>,
        sink: ChangeSink,
    ) -> io::Result<String> {
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
        let mut watches = self
            .watches
            .lock()
            .map_err(|_| io::Error::other("watch_state_poisoned"))?;
        if watches.keys().filter(|(mod_id, _)| mod_id == owner).count()
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
        let registration = subscriber.register_paths(
            resolved
                .iter()
                .map(|path| WatchPath {
                    path: path.clone(),
                    recursive,
                })
                .collect(),
        );
        let mut receiver = DebouncedWatchReceiver::new(receiver, Duration::from_millis(debounce));
        let (root, protected, watch_id) = (self.root.clone(), self.protected.clone(), id.clone());
        let task = tokio::spawn(async move {
            let _subscriber = subscriber;
            while let Some(event) = receiver.recv().await {
                let changed: Vec<String> = event
                    .paths
                    .iter()
                    .filter(|path| !protected.iter().any(|p| path.starts_with(p)))
                    .filter_map(|path| relative(&root, path))
                    .collect();
                if !changed.is_empty() {
                    sink(&watch_id, changed);
                }
            }
        });
        watches.insert(
            (owner.to_owned(), id.clone()),
            Watch {
                source: source.to_owned(),
                _registration: registration,
                task,
            },
        );
        Ok(id)
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
