use rustix::fs::Mode;
use rustix::fs::OFlags;
use rustix::fs::mkdirat;
use rustix::fs::open;
use rustix::fs::openat;
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

fn invalid(message: &str) -> io::Error {
    io::Error::other(message)
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
