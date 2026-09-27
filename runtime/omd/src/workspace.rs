use rustix::fs::AtFlags;
use rustix::fs::Mode;
use rustix::fs::OFlags;
use rustix::fs::RenameFlags;
use rustix::fs::mkdirat;
use rustix::fs::open;
use rustix::fs::openat;
use rustix::fs::renameat_with;
use rustix::fs::unlinkat;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::io::Write;
use std::io::{self};
use std::os::unix::fs::PermissionsExt;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct File {
    pub bytes: Vec<u8>,
    pub executable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Snapshot {
    pub files: BTreeMap<String, File>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceRename {
    pub old: String,
    pub new: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceTransaction {
    pub expected: BTreeMap<String, Option<Fingerprint>>,
    #[serde(default)]
    pub writes: BTreeMap<String, String>,
    #[serde(default)]
    pub deletes: Vec<String>,
    #[serde(default)]
    pub renames: Vec<WorkspaceRename>,
    #[serde(default)]
    pub backup: bool,
    #[serde(skip)]
    pub byte_writes: BTreeMap<String, Vec<u8>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum Fingerprint {
    Hash(String),
    Stat { size: u64, mtime_ms: u64 },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WorkspaceTransactionResult {
    pub files: BTreeMap<String, Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup: Option<serde_json::Value>,
}

pub type BackupSink<'a> = dyn Fn(&BTreeMap<String, Option<Vec<u8>>>) -> io::Result<serde_json::Value> + 'a;

fn fingerprint_matches(
    expected: &Option<Fingerprint>,
    entry: &Option<(Vec<u8>, fs::Permissions)>,
    metadata: Option<(u64, u64)>,
) -> bool {
    match (expected, entry) {
        (None, None) => true,
        (Some(Fingerprint::Hash(hash)), Some((bytes, _))) => *hash == content_hash(bytes),
        (Some(Fingerprint::Stat { size, mtime_ms }), Some(_)) => {
            metadata == Some((*size, *mtime_ms))
        }
        _ => false,
    }
}

fn stat_fingerprint(root: &Path, name: &str) -> io::Result<Option<(u64, u64)>> {
    let path = safe_path(root, name)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => Ok(Some((
            metadata.len(),
            metadata
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(io::Error::other)?
                .as_millis() as u64,
        ))),
        Ok(_) => Err(invalid("workspace path is not a regular file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct WorkspaceIndex {
    pub files: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct WorkspaceChange {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::other(message)
}

fn content_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_version(
    root: &Path,
    name: &str,
    max_bytes: usize,
) -> io::Result<Option<(Vec<u8>, fs::Permissions)>> {
    safe_path(root, name)?;
    let directory = open_directory(root)?;
    match open_source(&directory, name) {
        Ok(mut input) => {
            let metadata = input.metadata()?;
            if !metadata.is_file() {
                return Err(invalid("workspace path is not a regular file"));
            }
            if metadata.len() > max_bytes as u64 {
                return Err(invalid("workspace file exceeds limit"));
            }
            let mut bytes = Vec::new();
            Read::take(&mut input, max_bytes as u64 + 1).read_to_end(&mut bytes)?;
            if bytes.len() > max_bytes {
                return Err(invalid("workspace file exceeds limit"));
            }
            let after = input.metadata()?;
            if !same_file(&metadata, &after)? {
                return Err(invalid("workspace file changed during read"));
            }
            Ok(Some((bytes, metadata.permissions())))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn write_version(
    root: &Path,
    name: &str,
    bytes: &[u8],
    permissions: &fs::Permissions,
) -> io::Result<()> {
    safe_path(root, name)?;
    let (parent, target) = open_parent(root, name)?;
    let temporary = format!(
        ".{}.omd-transaction-{}-{}",
        target.to_string_lossy(),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos(),
    );
    let mut output = fs::File::from(openat(
        &parent,
        temporary.as_str(),
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o600),
    )?);
    let result = (|| {
        output.write_all(bytes)?;
        output.set_permissions(permissions.clone())?;
        output.sync_all()?;
        rustix::fs::renameat(&parent, temporary.as_str(), &parent, &target)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = unlinkat(&parent, temporary.as_str(), AtFlags::empty());
    }
    result
}

impl WorkspaceTransaction {
    pub fn apply(
        &self,
        repository: &Path,
        active: impl Fn() -> bool,
    ) -> io::Result<WorkspaceTransactionResult> {
        self.apply_with_backup(repository, active, None)
    }

    pub fn apply_with_backup(
        &self,
        repository: &Path,
        active: impl Fn() -> bool,
        backup: Option<&BackupSink<'_>>,
    ) -> io::Result<WorkspaceTransactionResult> {
        if !repository.is_absolute() || repository.canonicalize()? != repository {
            return Err(invalid("repository must be canonical"));
        }
        if self.backup && backup.is_none() {
            return Err(invalid("transaction backup unavailable"));
        }
        let writes = self
            .writes
            .iter()
            .map(|(name, text)| (name.clone(), text.as_bytes().to_vec()))
            .chain(self.byte_writes.clone())
            .collect::<BTreeMap<_, _>>();
        if writes.len() != self.writes.len() + self.byte_writes.len() {
            return Err(invalid("duplicate write"));
        }
        let deletes = self.deletes.iter().cloned().collect::<BTreeSet<_>>();
        if deletes.len() != self.deletes.len() || deletes.iter().any(|name| writes.contains_key(name)) {
            return Err(invalid("duplicate or overlapping delete"));
        }
        let mut affected = writes.keys().cloned().collect::<BTreeSet<_>>();
        affected.extend(deletes.iter().cloned());
        let mut rename_sources = BTreeSet::new();
        let mut rename_destinations = BTreeSet::new();
        for rename in &self.renames {
            if rename.old == rename.new
                || !rename_sources.insert(rename.old.clone())
                || !rename_destinations.insert(rename.new.clone())
            {
                return Err(invalid("duplicate or overlapping rename"));
            }
            affected.insert(rename.old.clone());
            affected.insert(rename.new.clone());
        }
        if affected.is_empty()
            || affected.len() > 128
            || affected.len() != self.expected.len()
            || affected
                .iter()
                .any(|name| !self.expected.contains_key(name))
            || writes.values().map(Vec::len).sum::<usize>() > 4 * 1024 * 1024
            || rename_sources
                .iter()
                .any(|name| rename_destinations.contains(name) || deletes.contains(name))
            || rename_destinations
                .iter()
                .any(|name| writes.contains_key(name) || deletes.contains(name))
        {
            return Err(invalid("transaction scope or size invalid"));
        }
        let mut before = BTreeMap::new();
        let mut observed_bytes = 0_usize;
        for name in &affected {
            if !active() {
                return Err(invalid("transaction cancelled"));
            }
            let entry = read_version(repository, name, 4 * 1024 * 1024)?;
            observed_bytes =
                observed_bytes.saturating_add(entry.as_ref().map_or(0, |(bytes, _)| bytes.len()));
            if observed_bytes > 4 * 1024 * 1024 {
                return Err(invalid("transaction source bytes exceed limit"));
            }
            let expected = self.expected.get(name).cloned().flatten();
            if !fingerprint_matches(&expected, &entry, stat_fingerprint(repository, name)?) {
                return Err(invalid(&format!("stale expected version for {name}")));
            }
            before.insert(name.clone(), entry);
        }
        for name in &deletes {
            if before.get(name).is_none_or(Option::is_none) {
                return Err(invalid("delete target must exist"));
            }
        }
        let backup = match backup.filter(|_| self.backup) {
            Some(sink) => Some(sink(
                &before
                    .iter()
                    .map(|(name, entry)| (name.clone(), entry.as_ref().map(|(bytes, _)| bytes.clone())))
                    .collect(),
            )?),
            None => None,
        };
        let current_hash = |name: &str| -> io::Result<Option<String>> {
            Ok(read_version(repository, name, 4 * 1024 * 1024)?
                .as_ref()
                .map(|(bytes, _)| content_hash(bytes)))
        };
        let before_hash = |name: &str| {
            before
                .get(name)
                .and_then(Option::as_ref)
                .map(|(bytes, _)| content_hash(bytes))
        };
        for rename in &self.renames {
            if before.get(&rename.old).is_none_or(Option::is_none)
                || before.get(&rename.new).is_some_and(Option::is_some)
            {
                return Err(invalid(
                    "rename source must exist and destination must be absent",
                ));
            }
        }
        let mut applied = BTreeMap::new();
        let result = (|| -> io::Result<()> {
            for (name, bytes) in &writes {
                if !active() {
                    return Err(invalid("transaction cancelled"));
                }
                let current = read_version(repository, name, 4 * 1024 * 1024)?;
                if current.as_ref().map(|(bytes, _)| content_hash(bytes)) != before_hash(name) {
                    return Err(invalid("workspace changed before write"));
                }
                let permissions = current
                    .as_ref()
                    .map(|(_, permissions)| permissions.clone())
                    .unwrap_or_else(|| fs::Permissions::from_mode(0o644));
                write_version(repository, name, bytes, &permissions)?;
                applied.insert(name.clone(), Some(content_hash(bytes)));
            }
            for name in &deletes {
                if !active() {
                    return Err(invalid("transaction cancelled"));
                }
                if current_hash(name)? != before_hash(name) {
                    return Err(invalid("workspace changed before delete"));
                }
                let (parent, target) = open_parent(repository, name)?;
                unlinkat(&parent, &target, AtFlags::empty())?;
                applied.insert(name.clone(), None);
            }
            for rename in &self.renames {
                if !active() {
                    return Err(invalid("transaction cancelled"));
                }
                safe_path(repository, &rename.old)?;
                safe_path(repository, &rename.new)?;
                let (old_parent, old_name) = open_parent(repository, &rename.old)?;
                let (new_parent, new_name) = open_parent(repository, &rename.new)?;
                let expected_old = applied
                    .get(&rename.old)
                    .cloned()
                    .unwrap_or_else(|| before_hash(&rename.old));
                if read_version(repository, &rename.old, 4 * 1024 * 1024)?
                    .as_ref()
                    .map(|(bytes, _)| content_hash(bytes))
                    != expected_old
                    || read_version(repository, &rename.new, 4 * 1024 * 1024)?.is_some()
                {
                    return Err(invalid("workspace changed before rename"));
                }
                renameat_with(
                    &old_parent,
                    &old_name,
                    &new_parent,
                    &new_name,
                    RenameFlags::NOREPLACE,
                )?;
                applied.insert(rename.old.clone(), None);
                applied.insert(rename.new.clone(), expected_old);
            }
            Ok(())
        })();
        if let Err(error) = result {
            for (name, expected_after) in &applied {
                let current = read_version(repository, name, 4 * 1024 * 1024)?
                    .as_ref()
                    .map(|(bytes, _)| content_hash(bytes));
                if &current != expected_after {
                    return Err(invalid(&format!(
                        "transaction failed: {error}; rollback conflict at {name}"
                    )));
                }
            }
            for name in applied.keys() {
                match &before[name] {
                    None => {
                        safe_path(repository, name)?;
                        let (parent, target) = open_parent(repository, name)?;
                        if read_version(repository, name, 4 * 1024 * 1024)?.is_some() {
                            unlinkat(&parent, &target, AtFlags::empty())?;
                        }
                    }
                    Some((bytes, permissions)) => {
                        write_version(repository, name, bytes, permissions)?;
                    }
                }
            }
            return Err(error);
        }
        let mut files = BTreeMap::new();
        for name in &affected {
            files.insert(
                name.clone(),
                read_version(repository, name, 4 * 1024 * 1024)?
                    .as_ref()
                    .map(|(bytes, _)| content_hash(bytes)),
            );
        }
        Ok(WorkspaceTransactionResult { files, backup })
    }
}

impl WorkspaceIndex {
    pub fn capture(repository: &Path, max_files: usize, max_bytes: usize) -> io::Result<Self> {
        if !repository.is_absolute() || repository.canonicalize()? != repository {
            return Err(invalid("repository must be canonical"));
        }
        let mut stack = vec![repository.to_path_buf()];
        let mut files = BTreeMap::new();
        let mut bytes = 0_usize;
        while let Some(directory) = stack.pop() {
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path)?;
                if metadata.file_type().is_symlink() {
                    continue;
                }
                if metadata.is_dir() {
                    if !matches!(
                        entry.file_name().to_str(),
                        Some(
                            ".git"
                                | ".omd"
                                | ".docs"
                                | ".pnpm-store"
                                | ".pytest_cache"
                                | ".ruff_cache"
                                | ".mypy_cache"
                                | ".tox"
                                | ".gradle"
                                | "__pycache__"
                                | "target"
                                | "node_modules"
                                | ".venv"
                                | "venv"
                                | "build"
                                | "dist"
                        )
                    ) {
                        stack.push(path);
                    }
                } else if metadata.is_file() {
                    bytes = bytes.saturating_add(metadata.len() as usize);
                    if files.len() >= max_files || bytes > max_bytes {
                        return Err(invalid("workspace index exceeds bounds"));
                    }
                    let name = path
                        .strip_prefix(repository)
                        .map_err(|_| invalid("workspace path escaped repository"))?
                        .to_str()
                        .ok_or_else(|| invalid("non-UTF8 workspace path"))?
                        .to_owned();
                    let (content, _) = read_version(repository, &name, max_bytes)?
                        .ok_or_else(|| invalid("workspace file disappeared during index"))?;
                    files.insert(name, content_hash(&content));
                }
            }
        }
        Ok(Self { files })
    }

    pub fn changed(&self, after: &Self) -> Vec<WorkspaceChange> {
        self.files
            .keys()
            .chain(after.files.keys())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter_map(|path| {
                let before_hash = self.files.get(path).cloned();
                let after_hash = after.files.get(path).cloned();
                (before_hash != after_hash).then(|| WorkspaceChange {
                    path: path.clone(),
                    before: before_hash,
                    after: after_hash,
                })
            })
            .collect()
    }
}

fn safe_path(root: &Path, name: &str) -> io::Result<PathBuf> {
    let path = Path::new(name);
    if name.is_empty()
        || name.len() > 4096
        || name.contains('\\')
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(value) if !value.to_string_lossy().eq_ignore_ascii_case(".git")))
        || path.to_string_lossy() != name
        || name.split('/').any(|part| part.is_empty() || part == ".")
    {
        return Err(invalid("unsafe snapshot path"));
    }
    let mut resolved = root.to_path_buf();
    for part in path.components() {
        resolved.push(part);
        match fs::symlink_metadata(&resolved) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(invalid("snapshot symlink rejected"));
            }
            Ok(_) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
    }
    Ok(resolved)
}

pub fn workspace_path(root: &Path, name: &str) -> io::Result<PathBuf> {
    safe_path(root, name)
}

pub(crate) fn open_contained(root: &Path, name: &str) -> io::Result<fs::File> {
    open_source(&open_directory(&root.canonicalize()?)?, name)
}

fn open_directory(path: &Path) -> io::Result<fs::File> {
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mut directory = fs::File::from(open("/", flags, Mode::empty())?);
    for component in path.components() {
        if let Component::Normal(name) = component {
            directory = fs::File::from(openat(&directory, name, flags, Mode::empty())?);
        }
    }
    Ok(directory)
}

fn open_parent(root: &Path, name: &str) -> io::Result<(fs::File, std::ffi::OsString)> {
    let mut directory = open_directory(root)?;
    let mut parts = Path::new(name).components().peekable();
    while let Some(Component::Normal(part)) = parts.next() {
        if parts.peek().is_none() {
            return Ok((directory, part.to_os_string()));
        }
        directory = fs::File::from(openat(
            &directory,
            part,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
    }
    Err(invalid("workspace parent missing"))
}

fn open_source(root: &fs::File, name: &str) -> io::Result<fs::File> {
    let mut directory = root.try_clone()?;
    let mut parts = Path::new(name).components().peekable();
    while let Some(Component::Normal(name)) = parts.next() {
        let flags = OFlags::RDONLY
            | OFlags::NOFOLLOW
            | OFlags::CLOEXEC
            | if parts.peek().is_some() {
                OFlags::DIRECTORY
            } else {
                OFlags::NONBLOCK
            };
        directory = fs::File::from(openat(&directory, name, flags, Mode::empty())?);
    }
    Ok(directory)
}

fn same_file(before: &fs::Metadata, after: &fs::Metadata) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    Ok(before.is_file()
        && after.is_file()
        && before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.len() == after.len()
        && before.modified()? == after.modified()?
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
        && before.mode() == after.mode()
        && before.nlink() == 1
        && after.nlink() == 1)
}

impl Snapshot {
    pub fn capture(root: &Path, paths: &BTreeSet<String>, max_bytes: usize) -> io::Result<Self> {
        let root = root.canonicalize()?;
        let directory = open_directory(&root)?;
        let mut files = BTreeMap::new();
        let mut observed = BTreeMap::new();
        let mut remaining = max_bytes;
        for name in paths {
            let path = safe_path(&root, name)?;
            let mut input = match open_source(&directory, name) {
                Ok(input) => input,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    observed.insert(name.clone(), None);
                    continue;
                }
                Err(error) => return Err(error),
            };
            let metadata = input.metadata()?;
            if !metadata.is_file() {
                return Err(invalid("snapshot requires regular files"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.nlink() != 1 {
                    return Err(invalid("snapshot hardlink rejected"));
                }
            }
            let mut bytes = Vec::new();
            (&mut input)
                .take(remaining.saturating_add(1) as u64)
                .read_to_end(&mut bytes)?;
            let cost = bytes
                .len()
                .checked_add(name.len())
                .ok_or_else(|| invalid("snapshot size overflow"))?;
            remaining = remaining
                .checked_sub(cost)
                .ok_or_else(|| invalid("snapshot size limit"))?;
            let after = fs::symlink_metadata(&path)?;
            if !same_file(&metadata, &input.metadata()?)? || !same_file(&metadata, &after)? {
                return Err(invalid("source changed during snapshot"));
            }
            #[cfg(unix)]
            let executable = {
                use std::os::unix::fs::PermissionsExt;
                metadata.permissions().mode() & 0o111 != 0
            };
            #[cfg(not(unix))]
            let executable = false;
            files.insert(name.clone(), File { bytes, executable });
            observed.insert(name.clone(), Some(metadata));
        }
        for (name, before) in observed {
            match (before, open_source(&directory, &name)) {
                (None, Err(error)) if error.kind() == io::ErrorKind::NotFound => (),
                (Some(before), Ok(current)) if same_file(&before, &current.metadata()?)? => (),
                _ => return Err(invalid("source tree changed during snapshot")),
            }
        }
        Ok(Self { files })
    }

    pub fn hash(&self) -> io::Result<String> {
        Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(self)?)))
    }

    pub fn write_new(&self, root: &Path, max_bytes: usize) -> io::Result<()> {
        let mut total = 0usize;
        for (name, file) in &self.files {
            safe_path(root, name)?;
            total = total
                .checked_add(name.len())
                .and_then(|total| total.checked_add(file.bytes.len()))
                .ok_or_else(|| invalid("snapshot size overflow"))?;
            if total > max_bytes {
                return Err(invalid("snapshot size limit"));
            }
            if Path::new(name)
                .ancestors()
                .skip(1)
                .any(|parent| self.files.contains_key(parent.to_string_lossy().as_ref()))
            {
                return Err(invalid("snapshot file/directory collision"));
            }
        }
        let parent = root
            .parent()
            .ok_or_else(|| invalid("missing snapshot parent"))?
            .canonicalize()?;
        let parent = open_directory(&parent)?;
        let name = root
            .file_name()
            .ok_or_else(|| invalid("missing snapshot directory"))?;
        mkdirat(&parent, name, Mode::from_raw_mode(0o700))?;
        let directory = fs::File::from(openat(
            &parent,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        for (name, file) in &self.files {
            let mut parent = directory.try_clone()?;
            let mut parts = Path::new(name).components().peekable();
            while let Some(Component::Normal(name)) = parts.next() {
                if parts.peek().is_some() {
                    match mkdirat(&parent, name, Mode::from_raw_mode(0o700)) {
                        Ok(()) | Err(rustix::io::Errno::EXIST) => (),
                        Err(error) => return Err(error.into()),
                    }
                    parent = fs::File::from(openat(
                        &parent,
                        name,
                        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                        Mode::empty(),
                    )?);
                } else {
                    parent = fs::File::from(openat(
                        &parent,
                        name,
                        OFlags::WRONLY
                            | OFlags::CREATE
                            | OFlags::EXCL
                            | OFlags::NOFOLLOW
                            | OFlags::CLOEXEC,
                        Mode::from_raw_mode(0o600),
                    )?);
                }
            }
            let mut output = parent;
            output.write_all(&file.bytes)?;
            output.sync_all()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                output.set_permissions(fs::Permissions::from_mode(if file.executable {
                    0o755
                } else {
                    0o644
                }))?;
            }
        }
        if Self::capture(root, &self.files.keys().cloned().collect(), max_bytes)? != *self {
            return Err(invalid(
                "snapshot destination changed during materialization",
            ));
        }
        Ok(())
    }

    pub fn changed_paths(&self, candidate: &Self) -> BTreeSet<String> {
        self.files
            .keys()
            .chain(candidate.files.keys())
            .filter(|name| self.files.get(*name) != candidate.files.get(*name))
            .cloned()
            .collect()
    }

    pub fn merge_candidate(&self, candidate: &Self, current: &Self) -> io::Result<Self> {
        let changed = self.changed_paths(candidate);
        for name in &changed {
            if self.files.get(name) != current.files.get(name) {
                return Err(invalid(&format!("intervening edit conflicts: {name}")));
            }
        }
        let mut merged = current.clone();
        for name in changed {
            match candidate.files.get(&name) {
                Some(file) => {
                    merged.files.insert(name, file.clone());
                }
                None => {
                    merged.files.remove(&name);
                }
            }
        }
        for name in merged.files.keys() {
            if Path::new(name)
                .ancestors()
                .skip(1)
                .any(|parent| merged.files.contains_key(parent.to_string_lossy().as_ref()))
            {
                return Err(invalid("intervening file/directory conflict"));
            }
        }
        Ok(merged)
    }
}

pub fn tracked_paths(
    root: &Path,
    approved_untracked: &BTreeSet<String>,
) -> io::Result<BTreeSet<String>> {
    let output = git(root).args(["ls-files", "--cached", "-z"]).output()?;
    if !output.status.success() {
        return Err(invalid("cannot enumerate tracked source"));
    }
    let mut paths = approved_untracked.clone();
    for path in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        paths.insert(
            String::from_utf8(path.to_vec()).map_err(|_| invalid("non-UTF8 tracked path"))?,
        );
    }
    Ok(paths)
}

pub fn capture_tracked(
    root: &Path,
    approved_untracked: &BTreeSet<String>,
    max_bytes: usize,
) -> io::Result<Snapshot> {
    let paths = tracked_paths(root, approved_untracked)?;
    let snapshot = Snapshot::capture(root, &paths, max_bytes)?;
    if tracked_paths(root, approved_untracked)? != paths {
        return Err(invalid("tracked path set changed during snapshot"));
    }
    Ok(snapshot)
}

fn git(root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "commit.gpgsign=false",
            "-C",
        ])
        .arg(root);
    command
}

pub fn create_worktree(
    snapshot: &Snapshot,
    directory: &Path,
    max_bytes: usize,
) -> io::Result<PathBuf> {
    fs::create_dir(directory)?;
    let directory = directory.canonicalize()?;
    let depot = directory.join("depot");
    snapshot.write_new(&depot, max_bytes)?;
    let worker = directory.join("worker");
    for arguments in [
        vec!["init", "--quiet"],
        vec!["add", "--all"],
        vec![
            "-c",
            "user.name=Oh My Diff",
            "-c",
            "user.email=omd@localhost",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "Isolated task input",
        ],
        vec![
            "worktree",
            "add",
            "--quiet",
            "--detach",
            worker
                .to_str()
                .ok_or_else(|| invalid("non-UTF8 workspace"))?,
            "HEAD",
        ],
    ] {
        let output = git(&depot).args(arguments).output()?;
        if !output.status.success() {
            return Err(invalid(
                "isolated worktree preparation failed; retained depot for diagnosis",
            ));
        }
        if !depot.join(".git/info/attributes").exists() {
            fs::write(
                depot.join(".git/info/attributes"),
                "* -text -filter -ident -working-tree-encoding -eol\n",
            )?;
        }
    }
    let paths = snapshot.files.keys().cloned().collect();
    if Snapshot::capture(&worker, &paths, max_bytes)? != *snapshot {
        return Err(invalid("worktree bytes differ from captured input"));
    }
    Ok(worker)
}

pub fn cleanup_owned_directory(parent: &Path, directory: &Path) -> io::Result<()> {
    if !directory.exists() {
        return Ok(());
    }
    let parent = parent.canonicalize()?;
    let directory_parent = directory
        .parent()
        .ok_or_else(|| invalid("owned directory parent missing"))?
        .canonicalize()?;
    if directory_parent != parent
        || directory.file_name().is_none()
        || fs::symlink_metadata(directory)?.file_type().is_symlink()
    {
        return Err(invalid("cleanup target is not a direct owned directory"));
    }
    fs::remove_dir_all(directory)
}

#[cfg(test)]
mod transaction_tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn transaction_renames_and_updates_exact_scope() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        fs::write(root.join("old.ts"), "export const value = 1;\n").unwrap();
        fs::write(root.join("barrel.ts"), "export * from './old';\n").unwrap();
        let transaction = WorkspaceTransaction {
            expected: BTreeMap::from([
                (
                    "old.ts".into(),
                    Some(Fingerprint::Hash(content_hash(b"export const value = 1;\n"))),
                ),
                ("new.ts".into(), None),
                (
                    "barrel.ts".into(),
                    Some(Fingerprint::Hash(content_hash(b"export * from './old';\n"))),
                ),
            ]),
            writes: BTreeMap::from([("barrel.ts".into(), "export * from './new';\n".into())]),
            renames: vec![WorkspaceRename {
                old: "old.ts".into(),
                new: "new.ts".into(),
            }],
            ..Default::default()
        };
        let result = transaction.apply(&root, || true).unwrap();
        assert!(!root.join("old.ts").exists());
        assert_eq!(
            fs::read_to_string(root.join("new.ts")).unwrap(),
            "export const value = 1;\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("barrel.ts")).unwrap(),
            "export * from './new';\n"
        );
        assert_eq!(result.files["old.ts"], None);
        assert_eq!(
            result.files["new.ts"],
            Some(content_hash(b"export const value = 1;\n"))
        );
    }

    #[test]
    fn transaction_rejects_stale_versions_without_writing() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        fs::write(root.join("file.py"), "changed\n").unwrap();
        let transaction = WorkspaceTransaction {
            expected: BTreeMap::from([("file.py".into(), Some(Fingerprint::Hash(content_hash(b"old\n"))))]),
            writes: BTreeMap::from([("file.py".into(), "new\n".into())]),
            renames: Vec::new(),
            ..Default::default()
        };
        assert!(
            transaction
                .apply(&root, || true)
                .unwrap_err()
                .to_string()
                .contains("stale")
        );
        assert_eq!(
            fs::read_to_string(root.join("file.py")).unwrap(),
            "changed\n"
        );
    }

    #[test]
    fn transaction_rolls_back_after_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        fs::write(root.join("a.py"), "a\n").unwrap();
        fs::write(root.join("b.py"), "b\n").unwrap();
        let transaction = WorkspaceTransaction {
            expected: BTreeMap::from([
                ("a.py".into(), Some(Fingerprint::Hash(content_hash(b"a\n")))),
                ("b.py".into(), Some(Fingerprint::Hash(content_hash(b"b\n")))),
            ]),
            writes: BTreeMap::from([
                ("a.py".into(), "new a\n".into()),
                ("b.py".into(), "new b\n".into()),
            ]),
            renames: Vec::new(),
            ..Default::default()
        };
        let calls = Cell::new(0);
        assert!(
            transaction
                .apply(&root, || {
                    calls.set(calls.get() + 1);
                    calls.get() < 4
                })
                .unwrap_err()
                .to_string()
                .contains("cancelled")
        );
        assert_eq!(fs::read_to_string(root.join("a.py")).unwrap(), "a\n");
        assert_eq!(fs::read_to_string(root.join("b.py")).unwrap(), "b\n");
    }

    #[test]
    fn transaction_rejects_symlinks_and_git_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        fs::write(root.join("outside"), "safe").unwrap();
        std::os::unix::fs::symlink(root.join("outside"), root.join("link")).unwrap();
        for name in ["link", ".git/config"] {
            let transaction = WorkspaceTransaction {
                expected: BTreeMap::from([(name.into(), None)]),
                writes: BTreeMap::from([(name.into(), "bad".into())]),
                renames: Vec::new(),
                ..Default::default()
            };
            assert!(transaction.apply(&root, || true).is_err());
        }
        assert_eq!(fs::read_to_string(root.join("outside")).unwrap(), "safe");
    }

    #[test]
    fn transaction_rejects_oversized_source_without_writing() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let original = vec![b'x'; 4 * 1024 * 1024 + 1];
        fs::write(root.join("large.py"), &original).unwrap();
        let transaction = WorkspaceTransaction {
            expected: BTreeMap::from([("large.py".into(), Some(Fingerprint::Hash(content_hash(&original))))]),
            writes: BTreeMap::from([("large.py".into(), "small\n".into())]),
            renames: Vec::new(),
            ..Default::default()
        };
        assert!(
            transaction
                .apply(&root, || true)
                .unwrap_err()
                .to_string()
                .contains("limit")
        );
        assert_eq!(fs::read(root.join("large.py")).unwrap(), original);
    }

    #[test]
    fn transaction_deletes_with_stat_precondition_and_backup() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        fs::write(root.join("keep.txt"), "keep\n").unwrap();
        fs::write(root.join("drop.txt"), "drop\n").unwrap();
        let (size, mtime_ms) = stat_fingerprint(&root, "drop.txt").unwrap().unwrap();
        let saved = std::cell::RefCell::new(BTreeMap::new());
        let sink = |files: &BTreeMap<String, Option<Vec<u8>>>| {
            *saved.borrow_mut() = files.clone();
            Ok(serde_json::json!({"backup": "ok"}))
        };
        let transaction = WorkspaceTransaction {
            expected: BTreeMap::from([
                ("drop.txt".into(), Some(Fingerprint::Stat { size, mtime_ms })),
                ("keep.txt".into(), Some(Fingerprint::Hash(content_hash(b"keep\n")))),
            ]),
            writes: BTreeMap::from([("keep.txt".into(), "kept\n".into())]),
            deletes: vec!["drop.txt".into()],
            backup: true,
            ..Default::default()
        };
        let result = transaction.apply_with_backup(&root, || true, Some(&sink)).unwrap();
        assert!(!root.join("drop.txt").exists());
        assert_eq!(fs::read_to_string(root.join("keep.txt")).unwrap(), "kept\n");
        assert_eq!(result.files["drop.txt"], None);
        assert_eq!(result.backup, Some(serde_json::json!({"backup": "ok"})));
        assert_eq!(saved.borrow()["drop.txt"], Some(b"drop\n".to_vec()));
        let stale = WorkspaceTransaction {
            expected: BTreeMap::from([("keep.txt".into(), Some(Fingerprint::Stat { size: 1, mtime_ms: 1 }))]),
            deletes: vec!["keep.txt".into()],
            ..Default::default()
        };
        assert!(stale.apply(&root, || true).unwrap_err().to_string().contains("stale"));
        let missing_sink = WorkspaceTransaction {
            expected: BTreeMap::from([("keep.txt".into(), Some(Fingerprint::Hash(content_hash(b"kept\n"))))]),
            deletes: vec!["keep.txt".into()],
            backup: true,
            ..Default::default()
        };
        assert!(missing_sink.apply(&root, || true).is_err());
        assert!(root.join("keep.txt").exists());
    }

    #[test]
    fn workspace_index_detects_write_create_and_delete() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        fs::write(root.join("modified.py"), "old").unwrap();
        fs::write(root.join("removed.py"), "gone").unwrap();
        let before = WorkspaceIndex::capture(&root, 16, 1024).unwrap();
        fs::write(root.join("modified.py"), "new").unwrap();
        fs::remove_file(root.join("removed.py")).unwrap();
        fs::write(root.join("created.py"), "added").unwrap();
        let after = WorkspaceIndex::capture(&root, 16, 1024).unwrap();
        assert_eq!(
            before.changed(&after),
            vec![
                WorkspaceChange {
                    path: "created.py".into(),
                    before: None,
                    after: Some(content_hash(b"added")),
                },
                WorkspaceChange {
                    path: "modified.py".into(),
                    before: Some(content_hash(b"old")),
                    after: Some(content_hash(b"new")),
                },
                WorkspaceChange {
                    path: "removed.py".into(),
                    before: Some(content_hash(b"gone")),
                    after: None,
                },
            ]
        );
    }
}
