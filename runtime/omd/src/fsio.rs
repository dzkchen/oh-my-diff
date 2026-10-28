use std::fs;
use std::io;
use std::io::Write;
use std::path::Path;

pub const STAGING_PREFIX: &str = ".tmp";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Durability {
    Durable,
    Volatile,
}

pub fn write_private(path: &Path, value: &impl serde::Serialize) -> io::Result<()> {
    write_bytes(path, &serde_json::to_vec(value)?, Durability::Durable)
}

pub fn write_bytes(path: &Path, bytes: &[u8], durability: Durability) -> io::Result<()> {
    write_bytes_before(path, bytes, durability, || Ok(()))
}

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

pub fn create_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
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
    if durability == Durability::Durable {
        file.as_file().sync_all()?;
    }
    Ok((parent, file))
}

pub fn write_if_changed(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let unchanged = fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() == bytes.len() as u64)
        && fs::read(path).is_ok_and(|existing| existing == bytes);
    if unchanged {
        return Ok(());
    }
    write_bytes(path, bytes, Durability::Durable)
}
