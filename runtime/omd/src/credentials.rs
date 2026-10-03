use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub const PROFILE_LIMIT: usize = 32;
const KINDS: &[&str] = &["chatgpt", "api_key", "provider"];
pub const SECRET_BYTES: usize = 4096;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CredentialProfile {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub provider: Option<String>,
    pub default: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Index {
    schema: u32,
    next: u64,
    profiles: Vec<CredentialProfile>,
}

pub struct CredentialProfiles {
    root: PathBuf,
    broker: Option<(PathBuf, PathBuf)>,
}

pub struct CredentialSecret {
    pub token: String,
    pub account_id: Option<String>,
}

impl std::fmt::Debug for CredentialSecret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CredentialSecret")
            .field("account_id", &self.account_id)
            .finish_non_exhaustive()
    }
}

fn expired(token: &str, now: u64) -> bool {
    use base64::Engine;
    let Some(payload) = token.split('.').nth(1) else {
        return false;
    };
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|claims| claims["exp"].as_u64())
        .is_some_and(|exp| exp <= now + 60)
}

fn failure(message: impl Into<String>) -> io::Error {
    io::Error::other(message.into())
}

fn text(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

pub fn origin(value: &str) -> bool {
    let Some((scheme, rest)) = value.split_once("://") else {
        return false;
    };
    let host = rest.rsplit_once(':').map_or(rest, |(host, port)| {
        if port.parse::<u16>().is_ok() {
            host
        } else {
            ""
        }
    });
    matches!(scheme, "https" | "http")
        && value.len() <= 256
        && !host.is_empty()
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-'))
}

impl CredentialProfiles {
    pub fn open(store: &Path) -> io::Result<Self> {
        if !crate::broker::deployed() {
            return Self::local(store);
        }
        if store.canonicalize()? != store {
            return Err(failure("credential_root_invalid"));
        }
        Ok(Self::brokered(store, Path::new(crate::broker::SOCKET)))
    }

    pub fn brokered(store: &Path, socket: &Path) -> Self {
        Self {
            root: store.join("credentials"),
            broker: Some((store.to_path_buf(), socket.to_path_buf())),
        }
    }

    pub fn local(store: &Path) -> io::Result<Self> {
        if store.canonicalize()? != store {
            return Err(failure("credential_root_invalid"));
        }
        let root = store.join("credentials");
        match fs::DirBuilder::new().mode(0o700).create(&root) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error),
        }
        let metadata = fs::symlink_metadata(&root)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(failure("credential_root_invalid"));
        }
        Ok(Self { root, broker: None })
    }

    fn remote(
        &self,
        op: &str,
        mut arguments: serde_json::Value,
        authorized: bool,
    ) -> Option<io::Result<serde_json::Value>> {
        let (store, socket) = self.broker.as_ref()?;
        arguments["store"] = serde_json::json!(store);
        let op = format!("credentials.{op}");
        Some(crate::broker::Client::at(socket).and_then(|mut client| {
            if authorized {
                client.authorized(&op, arguments)
            } else {
                client.call(&op, arguments)
            }
        }))
    }

    fn with_index<T>(
        &self,
        write: bool,
        change: impl FnOnce(&mut Index) -> io::Result<T>,
    ) -> io::Result<T> {
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(self.root.join(".profiles.lock"))?;
        lock.lock()?;
        let path = self.root.join("profiles.json");
        let mut index = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Index>(&bytes)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Index {
                schema: 1,
                next: 1,
                profiles: Vec::new(),
            },
            Err(error) => return Err(error),
        };
        if index.schema != 1 {
            return Err(failure("credential_index_unsupported"));
        }
        let value = change(&mut index)?;
        if write {
            let temporary = self
                .root
                .join(format!(".profiles.json.{}", std::process::id()));
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)?;
            let written = file
                .write_all(&serde_json::to_vec_pretty(&index)?)
                .and_then(|()| file.sync_all());
            if let Err(error) = written.and_then(|()| fs::rename(&temporary, &path)) {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
        }
        Ok(value)
    }

    pub fn list(&self) -> io::Result<Vec<CredentialProfile>> {
        if let Some(value) = self.remote("list", serde_json::json!({}), false) {
            return Ok(serde_json::from_value(value?)?);
        }
        self.with_index(false, |index| Ok(index.profiles.clone()))
    }

    pub fn visible(&self, caller: &str) -> io::Result<Vec<serde_json::Value>> {
        if let Some(value) = self.remote("visible", serde_json::json!({"caller": caller}), false) {
            return Ok(serde_json::from_value(value?)?);
        }
        self.list()?
            .iter()
            .filter(|profile| profile.kind != "secret" || profile.owner.as_deref() == Some(caller))
            .map(|profile| self.public(profile))
            .collect()
    }

    pub fn public(&self, profile: &CredentialProfile) -> io::Result<serde_json::Value> {
        if let Some(value) = self.remote("public", serde_json::json!({"id": profile.id}), false) {
            return value;
        }
        let ready = self.enrolled(&profile.id)?;
        Ok(
            serde_json::json!({"id": profile.id, "label": profile.label, "kind": profile.kind,
            "provider": profile.provider, "origin": profile.origin,
            "status": if ready { "ready" } else { "not_enrolled" }, "default": profile.default}),
        )
    }

    pub(crate) fn enrolled(&self, id: &str) -> io::Result<bool> {
        let file = if self.profile(id)?.kind == "secret" {
            "secret"
        } else {
            "auth.json"
        };
        Ok(fs::symlink_metadata(self.root.join(id).join(file))
            .is_ok_and(|metadata| metadata.is_file()))
    }

    fn home(&self, id: &str) -> io::Result<PathBuf> {
        let known =
            self.with_index(false, |index| Ok(index.profiles.iter().any(|p| p.id == id)))?;
        if !known {
            return Err(failure(format!("credential_profile_unknown: {id}")));
        }
        let home = self.root.join(id);
        match fs::DirBuilder::new().mode(0o700).create(&home) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error),
        }
        let metadata = fs::symlink_metadata(&home)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(failure("credential_home_invalid"));
        }
        Ok(home)
    }

    pub fn create(
        &self,
        label: &str,
        kind: &str,
        provider: Option<&str>,
    ) -> io::Result<CredentialProfile> {
        if let Some(value) = self.remote(
            "create",
            serde_json::json!({"label": label, "kind": kind, "provider": provider}),
            false,
        ) {
            return Ok(serde_json::from_value(value?)?);
        }
        if !text(label, 64) || !KINDS.contains(&kind) || provider.is_some_and(|p| !text(p, 64)) {
            return Err(failure("credential_profile_invalid"));
        }
        self.insert(label, kind, provider, None, None)
    }

    pub fn create_secret(
        &self,
        label: &str,
        origin_url: &str,
        owner: &str,
    ) -> io::Result<CredentialProfile> {
        if let Some(value) = self.remote(
            "create_secret",
            serde_json::json!({"label": label, "origin": origin_url, "owner": owner}),
            false,
        ) {
            return Ok(serde_json::from_value(value?)?);
        }
        if !text(label, 64) || !origin(origin_url) || !text(owner, 128) {
            return Err(failure("credential_profile_invalid"));
        }
        self.insert(label, "secret", None, Some(origin_url), Some(owner))
    }

    fn insert(
        &self,
        label: &str,
        kind: &str,
        provider: Option<&str>,
        origin: Option<&str>,
        owner: Option<&str>,
    ) -> io::Result<CredentialProfile> {
        let profile = self.with_index(true, |index| {
            if index.profiles.len() >= PROFILE_LIMIT {
                return Err(failure("credential_profile_limit"));
            }
            if index.profiles.iter().any(|p| p.label == label) {
                return Err(failure("credential_profile_label_exists"));
            }
            let profile = CredentialProfile {
                id: format!("p{}", index.next),
                label: label.to_owned(),
                kind: kind.to_owned(),
                provider: provider.map(str::to_owned),
                default: index.profiles.is_empty() && kind != "secret",
                origin: origin.map(str::to_owned),
                owner: owner.map(str::to_owned),
            };
            index.next += 1;
            index.profiles.push(profile.clone());
            Ok(profile)
        })?;
        self.home(&profile.id)?;
        Ok(profile)
    }

    pub fn remove(&self, id: &str) -> io::Result<bool> {
        if let Some(value) = self.remote("remove", serde_json::json!({"id": id}), true) {
            return Ok(value?.as_bool().unwrap_or_default());
        }
        let removed = self.with_index(true, |index| {
            let before = index.profiles.len();
            let was_default = index.profiles.iter().any(|p| p.id == id && p.default);
            index.profiles.retain(|p| p.id != id);
            if was_default
                && let Some(next) = index.profiles.iter_mut().find(|p| p.kind != "secret")
            {
                next.default = true;
            }
            Ok(index.profiles.len() != before)
        })?;
        if removed {
            match fs::remove_dir_all(self.root.join(id)) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
                _ => (),
            }
        }
        Ok(removed)
    }

    pub fn profile(&self, id: &str) -> io::Result<CredentialProfile> {
        if let Some(value) = self.remote("profile", serde_json::json!({"id": id}), false) {
            return Ok(serde_json::from_value(value?)?);
        }
        self.list()?
            .into_iter()
            .find(|profile| profile.id == id)
            .ok_or_else(|| failure(format!("credential_profile_unknown: {id}")))
    }

    pub fn store_secret(&self, id: &str, value: &str) -> io::Result<()> {
        if let Some(result) = self.remote(
            "store_secret",
            serde_json::json!({"id": id, "value": value}),
            true,
        ) {
            return result.map(drop);
        }
        if self.profile(id)?.kind != "secret" || value.is_empty() || value.len() > SECRET_BYTES {
            return Err(failure("credential_secret_invalid"));
        }
        let path = self.home(id)?.join("secret");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(path)?;
        file.write_all(value.as_bytes())?;
        file.sync_all()
    }

    pub fn store_auth(&self, id: &str, auth: &str) -> io::Result<()> {
        if let Some(result) = self.remote(
            "store_auth",
            serde_json::json!({"id": id, "auth": auth}),
            true,
        ) {
            return result.map(drop);
        }
        if self.profile(id)?.kind == "secret"
            || auth.len() > 65_536
            || serde_json::from_str::<serde_json::Value>(auth).is_err()
        {
            return Err(failure("credential_auth_invalid"));
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(self.home(id)?.join("auth.json"))?;
        file.write_all(auth.as_bytes())?;
        file.sync_all()
    }

    pub fn owned_secret(&self, id: &str, owner: &str) -> io::Result<serde_json::Value> {
        if let Some(value) = self.remote(
            "owned_secret",
            serde_json::json!({"id": id, "owner": owner}),
            false,
        ) {
            return value;
        }
        let profile = self.profile(id)?;
        if profile.kind != "secret" || profile.owner.as_deref() != Some(owner) {
            return Err(failure(format!("credential_secret_not_owned: {id}")));
        }
        let path = self.home(id)?.join("secret");
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| failure(format!("credential_not_enrolled: {id}")))?;
        if !metadata.is_file() || metadata.len() > SECRET_BYTES as u64 {
            return Err(failure("credential_store_invalid"));
        }
        Ok(serde_json::json!({"id": profile.id, "label": profile.label,
            "origin": profile.origin, "value": fs::read_to_string(path)?}))
    }

    pub fn secret(&self, id: &str) -> io::Result<CredentialSecret> {
        if let Some(value) = self.remote("secret", serde_json::json!({"id": id}), false) {
            let value = value?;
            return Ok(CredentialSecret {
                token: value["token"]
                    .as_str()
                    .filter(|token| !token.is_empty())
                    .ok_or_else(|| failure("credential_store_invalid"))?
                    .to_owned(),
                account_id: value["account_id"].as_str().map(str::to_owned),
            });
        }
        let profile = self.profile(id)?;
        let path = self.home(id)?.join("auth.json");
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| failure(format!("credential_not_enrolled: {id}")))?;
        if !metadata.is_file() || metadata.len() > 65_536 {
            return Err(failure("credential_store_invalid"));
        }
        let auth: serde_json::Value = serde_json::from_slice(&fs::read(&path)?)
            .map_err(|_| failure("credential_store_invalid"))?;
        if let Some(key) = auth["OPENAI_API_KEY"]
            .as_str()
            .filter(|key| !key.is_empty())
        {
            return Ok(CredentialSecret {
                token: key.to_owned(),
                account_id: None,
            });
        }
        let token = auth["tokens"]["access_token"]
            .as_str()
            .filter(|token| !token.is_empty())
            .ok_or_else(|| failure(format!("credential_not_enrolled: {id}")))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or_default();
        if profile.kind == "chatgpt" && expired(token, now) {
            return Err(failure(format!(
                "credential_expired: refresh profile {id} before using it"
            )));
        }
        Ok(CredentialSecret {
            token: token.to_owned(),
            account_id: auth["tokens"]["account_id"].as_str().map(str::to_owned),
        })
    }

    pub fn set_default(&self, id: &str) -> io::Result<()> {
        if let Some(result) = self.remote("set_default", serde_json::json!({"id": id}), true) {
            return result.map(drop);
        }
        self.with_index(true, |index| {
            if !index.profiles.iter().any(|p| p.id == id) {
                return Err(failure(format!("credential_profile_unknown: {id}")));
            }
            for profile in &mut index.profiles {
                profile.default = profile.id == id;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
#[path = "credentials_tests.rs"]
mod tests;
