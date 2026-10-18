use std::fs::{self, File};
use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub struct Lease {
    _file: File,
}

fn temporary() -> PathBuf {
    PathBuf::from("/tmp")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

fn name() -> String {
    format!(
        "codex-workspace-leases-{}",
        rustix::process::geteuid().as_raw()
    )
}

pub fn directory() -> PathBuf {
    crate::workspace::private_path(&temporary(), &[&name()], "workspace_ownership_unavailable")
        .unwrap_or_else(|_| temporary().join(name()))
}

fn identity(path: &Path, exclusive: bool) -> io::Result<(PathBuf, String)> {
    let path = path.canonicalize()?;
    let root = path
        .ancestors()
        .find(|parent| parent.join(".git").exists())
        .unwrap_or(&path);
    let metadata = fs::metadata(root)?;
    let created = metadata
        .created()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|time| time.as_nanos());
    if exclusive && created.is_none() {
        return Err(io::Error::other("workspace_ownership_unavailable"));
    }
    let key = crate::resource_data::hash(
        format!("{}:{}:{created:?}", metadata.dev(), metadata.ino()).as_bytes(),
    );
    Ok((root.to_owned(), key))
}

fn acquire(path: &Path, exclusive: bool) -> io::Result<Lease> {
    let (_, key) = identity(path, exclusive)?;
    let uid = rustix::process::geteuid().as_raw();
    let directory = crate::workspace::private_path(
        &temporary(),
        &[&name()],
        "workspace_ownership_unavailable",
    )?;
    let directory_file = File::from(rustix::fs::open(
        &directory,
        rustix::fs::OFlags::RDONLY
            | rustix::fs::OFlags::DIRECTORY
            | rustix::fs::OFlags::NOFOLLOW
            | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::empty(),
    )?);
    let metadata = directory_file.metadata()?;
    if !metadata.is_dir() || metadata.uid() != uid || metadata.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::other("workspace_ownership_unavailable"));
    }
    let mut flags =
        rustix::fs::OFlags::RDWR | rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::CLOEXEC;
    if !exclusive {
        flags |= rustix::fs::OFlags::CREATE;
    }
    let file = File::from(
        rustix::fs::openat(
            &directory_file,
            key,
            flags,
            rustix::fs::Mode::from_raw_mode(0o600),
        )
        .map_err(|_| io::Error::other("workspace_ownership_unavailable"))?,
    );
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != uid
        || metadata.nlink() != 1
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(io::Error::other("workspace_ownership_unavailable"));
    }
    if exclusive {
        file.try_lock()
    } else {
        file.try_lock_shared()
    }
    .map_err(|_| io::Error::other("workspace_in_use"))?;
    Ok(Lease { _file: file })
}

pub fn shared(path: &Path) -> io::Result<Lease> {
    acquire(path, false)
}
pub fn exclusive(path: &Path) -> io::Result<Lease> {
    acquire(path, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_child() {
        let Some(path) = std::env::var_os("LEASE_TEST_PATH") else {
            return;
        };
        let lease = exclusive(Path::new(&path));
        assert_eq!(
            lease.is_ok(),
            std::env::var_os("LEASE_TEST_ALLOWED").is_some()
        );
    }

    #[test]
    fn workspace_leases_exclude_other_processes_and_release_on_drop() {
        let root = tempfile::tempdir().unwrap();
        assert!(exclusive(root.path()).is_err());
        let lease = shared(root.path()).unwrap();
        let child = |allowed: bool| {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", "workspace_lease::tests::lease_child"])
                .env("LEASE_TEST_PATH", root.path())
                .env_remove("LEASE_TEST_ALLOWED");
            if allowed {
                command.env("LEASE_TEST_ALLOWED", "1");
            }
            assert!(command.output().unwrap().status.success());
        };
        child(false);
        let other = shared(root.path()).unwrap();
        drop(lease);
        child(false);
        drop(other);
        child(true);
        let exclusive = exclusive(root.path()).unwrap();
        assert!(shared(root.path()).is_err());
        drop(exclusive);
        assert!(shared(root.path()).is_ok());
    }
}
