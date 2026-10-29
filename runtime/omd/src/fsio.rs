//! The host's one file writer: every write stages a 0600 temporary beside the target and renames it over, so a crash
//! leaves the old or the new file, never a torn one.

use std::fs;
use std::io;
use std::io::Write;
use std::path::Path;

/// Staging files start with this; directory scans skip them.
pub const STAGING_PREFIX: &str = ".tmp";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Durability {
    /// The data and the rename survive power loss: the file and its directory are synced.
    Durable,
    /// Crash consistency without durability: a write barrier orders the data before the rename (mod state, stored data, exec output, cost snapshots).
    Ordered,
    /// Atomic but unsynced: a crash leaves the old or new file, power loss may lose the write.
    Volatile,
}

/// Replaces `path` with `value` as JSON, durably.
pub fn write_json(path: &Path, value: &impl serde::Serialize) -> io::Result<()> {
    write_bytes(path, &serde_json::to_vec(value)?, Durability::Durable)
}

pub fn write_bytes(path: &Path, bytes: &[u8], durability: Durability) -> io::Result<()> {
    write_bytes_before(path, bytes, durability, || Ok(()))
}

/// Replaces `path`, running `before_replace` once the bytes are staged; its error leaves `path` untouched.
pub fn write_bytes_before(
    path: &Path,
    bytes: &[u8],
    durability: Durability,
    before_replace: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let (parent, file) = staged(path, bytes, durability)?;
    before_replace()?;
    file.persist(path).map_err(|error| error.error)?;
    if durability == Durability::Durable {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

/// Creates `path` durably, failing if it exists; the file is removed again if its directory can't be synced.
pub fn create_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let (parent, file) = staged(path, bytes, Durability::Durable)?;
    file.persist_noclobber(path).map_err(|error| error.error)?;
    fs::File::open(parent)
        .and_then(|parent| parent.sync_all())
        .inspect_err(|_| {
            let _ = fs::remove_file(path);
        })
}

fn staged<'a>(
    path: &'a Path,
    bytes: &[u8],
    durability: Durability,
) -> io::Result<(&'a Path, tempfile::NamedTempFile)> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("write_parent_missing"))?;
    let mut file = tempfile::Builder::new()
        .prefix(STAGING_PREFIX)
        .tempfile_in(parent)?;
    file.write_all(bytes)?;
    match durability {
        Durability::Durable => file.as_file().sync_all()?,
        Durability::Ordered => barrier(file.as_file())?,
        Durability::Volatile => {}
    }
    Ok((parent, file))
}

fn barrier(file: &fs::File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    #[cfg(target_os = "macos")]
    // SAFETY: `file` owns an open descriptor for the duration of the call.
    let status = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_BARRIERFSYNC) };
    #[cfg(not(target_os = "macos"))]
    // SAFETY: `file` owns an open descriptor for the duration of the call.
    let status = unsafe { libc::fsync(file.as_raw_fd()) };
    match status {
        -1 => Err(io::Error::last_os_error()),
        _ => Ok(()),
    }
}

/// Durably replaces `path` unless it already holds exactly `bytes`.
pub fn write_if_changed(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let unchanged = fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() == bytes.len() as u64)
        && fs::read(path).is_ok_and(|existing| existing == bytes);
    if unchanged {
        return Ok(());
    }
    write_bytes(path, bytes, Durability::Durable)
}
