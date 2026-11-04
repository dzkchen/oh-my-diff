use super::*;
use std::path::Path;

pub(super) fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match codex_omd::fsio::create_new(path, bytes) {
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = std::fs::read(path).map_err(|e| e.to_string())?;
            if serde_json::from_slice::<Value>(&existing).is_err() {
                write_bytes(path, bytes, Durability::Durable).map_err(|e| e.to_string())?;
            } else if existing != bytes {
                return Err(error.to_string());
            }
        }
        result => result.map_err(|e| e.to_string())?,
    }
    Ok(())
}
