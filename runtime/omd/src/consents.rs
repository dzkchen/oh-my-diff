//! Single-use user consents for prompts a mod captured, kept per thread outside mod state.

use crate::resource_data::ResourceRef;
use crate::resource_data::hash;
use serde::Deserialize;
use serde::Serialize;
use std::fs;
use std::io;
use std::io::Read;
use std::io::Seek;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

const OWNER_LIMIT: usize = 64;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Consent {
    pub id: String,
    pub owner: String,
    pub sha256: String,
    /// Set when the consent was spent on a submission.
    pub client_id: Option<String>,
    /// Set when the submitted message was committed to the thread.
    pub turn_id: Option<String>,
}

pub fn digest(text: &str, attachments: &[ResourceRef]) -> String {
    hash(&serde_json::to_vec(&(text, attachments)).unwrap_or_default())
}

fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// Runs `change` on the thread's consents under an exclusive file lock.
fn with<T>(
    root: &Path,
    thread: &str,
    change: impl FnOnce(&mut Vec<Consent>) -> io::Result<T>,
) -> io::Result<T> {
    if !token(thread) {
        return Err(io::Error::other("consent_thread_invalid"));
    }
    let directory = root.join("consents");
    fs::create_dir_all(&directory)?;
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(directory.join(format!("{thread}.json")))?;
    file.lock()?;
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    let mut consents: Vec<Consent> = if text.is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(&text)?
    };
    let result = change(&mut consents)?;
    // Status reads and no-op deliveries leave the file as it was.
    let bytes = serde_json::to_vec(&consents)?;
    if bytes != text.as_bytes() && !(text.is_empty() && consents.is_empty()) {
        file.set_len(0)?;
        file.rewind()?;
        file.write_all(&bytes)?;
    }
    Ok(result)
}

pub fn grant(root: &Path, thread: &str, owner: &str, sha256: &str, id: &str) -> io::Result<()> {
    with(root, thread, |consents| {
        if consents
            .iter()
            .filter(|consent| consent.owner == owner && consent.client_id.is_none())
            .count()
            >= OWNER_LIMIT
        {
            return Err(io::Error::other("consent_limit"));
        }
        consents.push(Consent {
            id: id.to_owned(),
            owner: owner.to_owned(),
            sha256: sha256.to_owned(),
            ..Consent::default()
        });
        Ok(())
    })
}

/// Spends a pending consent on exactly this content and client message id.
pub fn consume(
    root: &Path,
    thread: &str,
    owner: &str,
    id: &str,
    sha256: &str,
    client_id: &str,
) -> io::Result<()> {
    with(root, thread, |consents| {
        let consent = consents
            .iter_mut()
            .find(|consent| consent.id == id && consent.owner == owner)
            .ok_or_else(|| io::Error::other("consent_missing"))?;
        if consent.client_id.is_some() {
            return Err(io::Error::other("consent_spent"));
        }
        if consent.sha256 != sha256 {
            return Err(io::Error::other("consent_content_changed"));
        }
        consent.client_id = Some(client_id.to_owned());
        Ok(())
    })
}

/// Returns a consent to pending after the host established nothing was submitted.
pub fn restore(root: &Path, thread: &str, id: &str) -> io::Result<()> {
    with(root, thread, |consents| {
        if let Some(consent) = consents.iter_mut().find(|consent| consent.id == id) {
            consent.client_id = None;
        }
        Ok(())
    })
}

/// Marks the consent spent on `client_id` as delivered once its message is committed.
pub fn delivered(root: &Path, thread: &str, client_id: &str, turn_id: &str) -> io::Result<()> {
    if !token(thread)
        || !root
            .join("consents")
            .join(format!("{thread}.json"))
            .exists()
    {
        return Ok(());
    }
    with(root, thread, |consents| {
        if let Some(consent) = consents
            .iter_mut()
            .find(|consent| consent.client_id.as_deref() == Some(client_id))
        {
            consent.turn_id = Some(turn_id.to_owned());
        }
        Ok(())
    })
}

pub fn status(root: &Path, thread: &str, owner: &str, id: &str) -> io::Result<Option<Consent>> {
    with(root, thread, |consents| {
        Ok(consents
            .iter()
            .find(|consent| consent.id == id && consent.owner == owner)
            .cloned())
    })
}

/// Keeps only the consents `keep` accepts and returns how many were dropped.
pub fn retain(root: &Path, thread: &str, keep: impl Fn(&Consent) -> bool) -> io::Result<usize> {
    with(root, thread, |consents| {
        let before = consents.len();
        consents.retain(|consent| keep(consent));
        Ok(before - consents.len())
    })
}

#[cfg(test)]
#[path = "consents_tests.rs"]
mod tests;
