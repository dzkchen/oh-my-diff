use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

pub const PAGE_BYTES: usize = 65_536;
pub const SNAPSHOT_BYTES: usize = 262_144;

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub fn redact(text: &str) -> String {
    let mut private_key = false;
    text.split_inclusive('\n')
        .map(|segment| {
            let line = segment.strip_suffix('\n').unwrap_or(segment);
            let line = line.strip_suffix('\r').unwrap_or(line);
            let lower = line.to_ascii_lowercase();
            let begins_key = lower.contains("-----begin") && lower.contains("private key-----");
            let ends_key = lower.contains("-----end") && lower.contains("private key-----");
            private_key |= begins_key;
            let sensitive = private_key
                || [
                    "authorization:",
                    "authorization=",
                    "bearer ",
                    "api_key",
                    "api-key",
                    "apikey",
                    "access_token",
                    "refresh_token",
                    "client_secret",
                    "password=",
                    "password:",
                    "password\":",
                    "secret=",
                    "secret:",
                ]
                .iter()
                .any(|needle| lower.contains(needle))
                || ["sk-", "ghp_", "gho_", "github_pat_", "xoxb-", "xoxp-"]
                    .iter()
                    .any(|prefix| {
                        lower.match_indices(prefix).any(|(offset, _)| {
                            offset == 0 || !lower.as_bytes()[offset - 1].is_ascii_alphanumeric()
                        })
                    })
                || assigns_secret(line)
                || line.match_indices("AKIA").any(|(offset, _)| {
                    (offset == 0 || !line.as_bytes()[offset - 1].is_ascii_alphanumeric())
                        && line.as_bytes()[offset + 4..]
                            .iter()
                            .take_while(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
                            .count()
                            >= 16
                })
                || line.match_indices("://").any(|(offset, _)| {
                    let authority = line[offset + 3..]
                        .split(|c: char| c == '/' || c.is_whitespace() || c == '"' || c == '\'')
                        .next()
                        .unwrap_or_default();
                    authority
                        .find('@')
                        .is_some_and(|at| authority[..at].contains(':'))
                });
            if ends_key {
                private_key = false;
            }
            if sensitive {
                format!("[redacted]{}", &segment[line.len()..])
            } else {
                segment.to_owned()
            }
        })
        .collect()
}

/// `NAME=value`, `NAME: value` or `"name": value` where a segment of the name reads as a secret.
fn assigns_secret(line: &str) -> bool {
    line.match_indices(['=', ':']).any(|(offset, _)| {
        let before = line[..offset].trim_end().trim_end_matches(['"', '\'']);
        let start = before.len()
            - before
                .bytes()
                .rev()
                .take_while(|byte| byte.is_ascii_alphanumeric() || b"_-.".contains(byte))
                .count();
        let value = line[offset + 1..]
            .trim_start()
            .trim_start_matches(['"', '\'', '=']);
        !value.is_empty() && secret_name(&before[start..])
    })
}

/// Whether a `_`, `-`, `.` or camelCase segment of a field or variable name reads as a secret.
pub fn secret_name(name: &str) -> bool {
    let mut segments = vec![String::new()];
    let mut previous_lower = false;
    for character in name.chars() {
        if matches!(character, '_' | '-' | '.')
            || (previous_lower && character.is_ascii_uppercase())
        {
            segments.push(String::new());
        }
        previous_lower = character.is_ascii_lowercase() || character.is_ascii_digit();
        if !matches!(character, '_' | '-' | '.') {
            segments
                .last_mut()
                .expect("segments start non-empty")
                .push(character.to_ascii_lowercase());
        }
    }
    segments.iter().enumerate().any(|(index, segment)| {
        [
            "token",
            "secret",
            "password",
            "passwd",
            "apikey",
            "authorization",
        ]
        .iter()
        .any(|word| segment.ends_with(word))
            || segment == "pwd"
            || segment.starts_with("credential")
            || (segment == "key"
                && index > 0
                && [
                    "api", "access", "private", "secret", "signing", "client", "master",
                ]
                .contains(&segments[index - 1].as_str()))
    })
}

pub fn contains_secret(text: &str) -> bool {
    redact(text).lines().any(|line| line == "[redacted]")
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ResourceBinding {
    pub repository: String,
    pub owner: String,
    pub thread: String,
    pub generation: u64,
    pub source_sha256: String,
}

impl ResourceBinding {
    pub fn validate(&self) -> io::Result<()> {
        if self.source_sha256.len() != 64
            || !self
                .source_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || self.repository.len() != 64
            || !self.repository.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !token(&self.owner)
            || !token(&self.thread)
        {
            return Err(io::Error::other("resource_binding_invalid"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ResourceRef {
    pub reference: String,
    pub sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredResource {
    binding: ResourceBinding,
    kind: String,
    payload: Value,
}

pub struct ResourceStore<'a> {
    pub root: &'a Path,
    pub binding: &'a ResourceBinding,
}

impl ResourceStore<'_> {
    pub(crate) fn directory(&self) -> io::Result<PathBuf> {
        self.binding.validate()?;
        if self.root.canonicalize()? != self.root || !fs::symlink_metadata(self.root)?.is_dir() {
            return Err(io::Error::other("resource_root_invalid"));
        }
        let path = crate::workspace::private_path(
            self.root,
            &["resources", &self.binding.repository, &self.binding.owner],
            "resource_directory_invalid",
        )?;
        if path.canonicalize()? != path {
            return Err(io::Error::other("resource_directory_invalid"));
        }
        Ok(path)
    }

    pub fn save(&self, kind: &str, payload: Value) -> io::Result<ResourceRef> {
        if !token(kind) {
            return Err(io::Error::other("resource_kind_invalid"));
        }
        let value = StoredResource {
            binding: self.binding.clone(),
            kind: kind.to_owned(),
            payload,
        };
        let bytes = serde_json::to_vec(&value)?;
        if bytes.len() > SNAPSHOT_BYTES {
            return Err(io::Error::other("resource_snapshot_limit"));
        }
        let sha256 = hash(&bytes);
        let name = format!("{sha256}.json");
        let directory = self.directory()?;
        let path = directory.join(&name);
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(directory.join(".resources.lock"))?;
        lock.try_lock()
            .map_err(|_| io::Error::other("resource_store_busy"))?;
        if !path.try_exists()? {
            let mut total = 0u64;
            let mut entries = 0;
            for entry in fs::read_dir(&directory)?.take(1025) {
                let entry = entry?;
                entries += 1;
                if entry.file_type()?.is_symlink() {
                    return Err(io::Error::other("resource_directory_invalid"));
                }
                if entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
                {
                    total = total.saturating_add(entry.metadata()?.len());
                }
            }
            if entries >= 1024 || total.saturating_add(bytes.len() as u64) > 64 * 1024 * 1024 {
                return Err(io::Error::other("resource_store_quota"));
            }
        }
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(&bytes).and_then(|()| file.sync_all()) {
                    drop(file);
                    let _ = fs::remove_file(&path);
                    return Err(error);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let snapshot = crate::Snapshot::capture(
                    &directory,
                    &BTreeSet::from([name.clone()]),
                    SNAPSHOT_BYTES,
                )?;
                if snapshot
                    .files
                    .get(&name)
                    .is_none_or(|file| file.bytes != bytes)
                {
                    return Err(io::Error::other("resource_integrity_failed"));
                }
            }
            Err(error) => return Err(error),
        }
        Ok(ResourceRef {
            reference: sha256.clone(),
            sha256,
        })
    }

    pub(crate) fn record(&self, kind: &str, payload: Value) -> io::Result<Vec<u8>> {
        Ok(serde_json::to_vec(&StoredResource {
            binding: self.binding.clone(),
            kind: kind.to_owned(),
            payload,
        })?)
    }

    pub fn load(&self, reference: &ResourceRef, kind: &str) -> io::Result<Value> {
        if reference.reference != reference.sha256
            || reference.sha256.len() != 64
            || !reference
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(io::Error::other("resource_reference_invalid"));
        }
        let name = format!("{}.json", reference.reference);
        let mut directory = self.directory()?;
        if !directory.join(&name).try_exists()? {
            directory = self.rotating_directory()?;
        }
        let snapshot =
            crate::Snapshot::capture(&directory, &BTreeSet::from([name.clone()]), SNAPSHOT_BYTES)?;
        let bytes = &snapshot
            .files
            .get(&name)
            .ok_or_else(|| io::Error::other("resource_unavailable"))?
            .bytes;
        if hash(bytes) != reference.sha256 {
            return Err(io::Error::other("resource_integrity_failed"));
        }
        let value: StoredResource = serde_json::from_slice(bytes)?;
        let package_asset = value.binding.thread == "package"
            && value.binding.generation == 0
            && value.binding.repository == self.binding.repository
            && value.binding.owner == self.binding.owner
            && value.binding.source_sha256 == self.binding.source_sha256;
        if (value.binding != *self.binding && !package_asset) || value.kind != kind {
            return Err(io::Error::other("resource_scope_mismatch"));
        }
        Ok(value.payload)
    }

    pub fn page(
        &self,
        reference: &ResourceRef,
        kind: &str,
        cursor: usize,
        max_bytes: usize,
    ) -> io::Result<Value> {
        if !(1..=PAGE_BYTES).contains(&max_bytes) {
            return Err(io::Error::other("resource_page_limit"));
        }
        let loaded = self.load(reference, kind)?;
        let payload = match self.blob_text(&loaded)? {
            Some(text) => text,
            None => serde_json::to_string(&loaded)?,
        };
        if cursor > payload.len() || !payload.is_char_boundary(cursor) {
            return Err(io::Error::other("resource_cursor_invalid"));
        }
        let end = payload.floor_char_boundary(cursor.saturating_add(max_bytes));
        if end == cursor && end < payload.len() {
            return Err(io::Error::other("resource_page_too_small"));
        }
        Ok(
            json!({"reference":reference,"text":&payload[cursor..end],"cursor":(end<payload.len()).then_some(end),"bytes":payload.len()}),
        )
    }
}
