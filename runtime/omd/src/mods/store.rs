use super::FileStamp;
use super::ModConfiguration;
use super::ModPackage;
use super::ModSelection;
use super::Result;
use super::digest;
use super::failure;
use super::file_stamp;
use super::identifier;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;

pub struct Trust {
    pub path: PathBuf,
    pub sha256: String,
    pub capabilities: Vec<String>,
    pub scope: String,
    pub secret_environment: Vec<String>,
    pub expires_at: Option<u64>,
}

pub(super) fn grant(selection: &Value) -> String {
    let mut grant = json!({"path": selection["path"], "sha256": selection["sha256"],
        "capabilities": selection["capabilities"], "scope": selection["scope"],
        "secret_environment": selection.get("secret_environment").unwrap_or(&json!([]))});
    if let Some(expires_at) = selection.get("expires_at").filter(|value| !value.is_null()) {
        grant["expires_at"] = expires_at.clone();
    }
    crate::broker::canonical(&grant)
}

type RunnerDigests = HashMap<PathBuf, (FileStamp, String)>;

static RUNNER_DIGESTS: LazyLock<Mutex<RunnerDigests>> = LazyLock::new(Default::default);
static VERIFIED_RUNNERS: LazyLock<Mutex<HashMap<PathBuf, String>>> =
    LazyLock::new(Default::default);

/// The runner binary's digest, rehashed only when its file stamp changes.
fn runner_digest(node: &Path) -> Result<String> {
    let stamp = file_stamp(&std::fs::metadata(node)?);
    let mut digests = RUNNER_DIGESTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((cached, digest)) = digests.get(node)
        && *cached == stamp
    {
        return Ok(digest.clone());
    }
    let mut hasher = Sha256::new();
    std::io::copy(&mut File::open(node)?, &mut hasher)?;
    let digest = format!("{:x}", hasher.finalize());
    digests.insert(node.to_path_buf(), (stamp, digest.clone()));
    Ok(digest)
}

fn runner_record(node: &Path, sha256: &str) -> String {
    crate::broker::canonical(&json!({"runner": {"path": node, "sha256": sha256}}))
}

/// The protected record that lets this exact `node` binary serve a store's mods.
pub(super) fn runner_grant(node: &Path) -> Result<String> {
    let node = node.canonicalize()?;
    Ok(runner_record(&node, &runner_digest(&node)?))
}

/// With brokered `grants`, mods run only under a runner whose path and digest the broker holds.
pub(super) fn verify_runner(node: &Path, grants: Option<&BTreeSet<String>>) -> Result<()> {
    let Some(grants) = grants else {
        return Ok(());
    };
    let unverified = || {
        failure(format!(
            "node_unverified: {} has no protected runner grant; run omd-mod set-node STORE NODE",
            node.display()
        ))
    };
    let canonical = node.canonicalize().map_err(|_| unverified())?;
    let digest = runner_digest(&canonical)?;
    if !grants.contains(&runner_record(&canonical, &digest)) {
        return Err(unverified());
    }
    VERIFIED_RUNNERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(canonical, digest);
    Ok(())
}

/// Refuses to start a verified runner path whose binary changed since its verification.
pub(super) fn check_runner(node: &Path) -> Result<()> {
    let verified = VERIFIED_RUNNERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(node)
        .cloned();
    match verified {
        Some(digest) if digest != runner_digest(node)? => Err(failure(format!(
            "node_changed: {} differs from its protected runner grant",
            node.display()
        ))),
        _ => Ok(()),
    }
}

pub(super) fn package_provenance(package: &super::package_manager::ModLockedPackage) -> String {
    crate::broker::canonical(&json!({"package_source": {
        "id": package.id, "path": package.path, "sha256": package.integrity,
        "source": super::policy::source_reference(&package.source)
    }}))
}

pub(super) fn authenticated_source(
    selection: &ModSelection,
    id: &str,
    grants: Option<&BTreeSet<String>>,
) -> Option<String> {
    grants?.iter().find_map(|record| {
        let record: Value = serde_json::from_str(record).ok()?;
        let source = &record["package_source"];
        (source["id"] == id
            && source["path"] == json!(selection.path)
            && source["sha256"] == selection.sha256)
            .then(|| source["source"].as_str().map(str::to_owned))
            .flatten()
    })
}

#[cfg(test)]
mod runner_tests {
    use super::*;

    #[test]
    fn brokered_runners_need_their_exact_protected_grant() {
        let directory = tempfile::tempdir().unwrap();
        let node = directory.path().canonicalize().unwrap().join("node");
        std::fs::write(&node, "first").unwrap();
        let refusal = |result: Result<()>| result.unwrap_err().to_string();
        verify_runner(&node, None).unwrap();
        let mut grants = BTreeSet::new();
        assert!(refusal(verify_runner(&node, Some(&grants))).starts_with("node_unverified"));
        grants.insert(runner_grant(&node).unwrap());
        verify_runner(&node, Some(&grants)).unwrap();
        check_runner(&node).unwrap();
        std::fs::write(&node, "replaced binary").unwrap();
        assert!(refusal(check_runner(&node)).starts_with("node_changed"));
        assert!(refusal(verify_runner(&node, Some(&grants))).starts_with("node_unverified"));
    }
}

#[cfg(test)]
mod provenance_tests {
    use super::*;

    #[test]
    fn source_provenance_is_bound_to_protected_content_identity() {
        let selection: ModSelection = serde_json::from_value(json!({
            "path":"/package", "sha256":"a".repeat(64), "enabled":true,
            "capabilities":[], "settings":{}, "scope":"user"
        }))
        .unwrap();
        let record = crate::broker::canonical(&json!({"package_source": {
            "id":"package", "path":selection.path, "sha256":selection.sha256,
            "source":"git+https://github.com/acme/package"
        }}));
        let grants = BTreeSet::from([record]);
        assert_eq!(
            authenticated_source(&selection, "package", Some(&grants)).as_deref(),
            Some("git+https://github.com/acme/package")
        );
        assert!(authenticated_source(&selection, "package", None).is_none());
        assert!(authenticated_source(&selection, "other", Some(&grants)).is_none());
        let mut changed = selection.clone();
        changed.sha256 = "b".repeat(64);
        assert!(authenticated_source(&changed, "package", Some(&grants)).is_none());
        changed = selection.clone();
        changed.path = "/other".into();
        assert!(authenticated_source(&changed, "package", Some(&grants)).is_none());
    }
}

pub(super) fn brokered_grants(root: &Path) -> Result<Option<(u64, BTreeSet<String>)>> {
    if !crate::broker::deployed() {
        return Ok(None);
    }
    let current = crate::broker::call("grants.get", json!({"store": root}))?;
    Ok(Some((
        current["generation"].as_u64().unwrap_or_default(),
        current["grants"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
    )))
}

#[cfg(test)]
thread_local! { pub(super) static READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

type VerifiedPackage = (Vec<(PathBuf, FileStamp)>, ModPackage, String);

static VERIFIED_PACKAGES: LazyLock<Mutex<HashMap<PathBuf, Arc<VerifiedPackage>>>> =
    LazyLock::new(Default::default);

pub(super) fn read(path: &Path, limit: u64) -> Result<Vec<u8>> {
    read_identified(path, limit).map(|(bytes, _)| bytes)
}

fn read_identified(path: &Path, limit: u64) -> Result<(Vec<u8>, FileStamp)> {
    #[cfg(test)]
    READS.set(READS.get() + 1);
    let file = OpenOptions::new()
        .read(true)
        .custom_flags((rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(failure("regular_file_required"));
    }
    let mut bytes = Vec::with_capacity(metadata.len().saturating_add(1).min(limit + 1) as usize);
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        return Err(failure(format!("file_limit: {name} exceeds {limit} bytes")));
    }
    Ok((bytes, file_stamp(&metadata)))
}

pub(super) fn package_read(root: &Path, relative: &str, limit: u64) -> Result<Vec<u8>> {
    package_read_identified(root, relative, limit).map(|(bytes, _)| bytes)
}

fn package_read_identified(
    root: &Path,
    relative: &str,
    limit: u64,
) -> Result<(Vec<u8>, FileStamp)> {
    let path = root.join(relative);
    if !path
        .parent()
        .ok_or_else(|| failure("package_path_escape"))?
        .canonicalize()?
        .starts_with(root)
    {
        return Err(failure(format!("package_path_escape: {relative}")));
    }
    read_identified(&path, limit)
}

pub(super) fn package(path: &Path) -> Result<(ModPackage, String, String)> {
    let (package, source, hash, _, _) = inspect_package(path, false)?;
    Ok((package, source, hash))
}

pub(super) fn package_with_assets(
    path: &Path,
) -> Result<(ModPackage, String, String, BTreeMap<String, String>)> {
    let (package, source, hash, assets, _) = inspect_package(path, true)?;
    Ok((package, source, hash, assets))
}

pub(super) fn asset_map(assets: BTreeMap<String, String>) -> BTreeMap<String, Value> {
    assets
        .into_iter()
        .map(|(name, text)| {
            let sha256 = digest(text.as_bytes());
            (name, serde_json::json!({"text": text, "sha256": sha256}))
        })
        .collect()
}

pub(super) fn verified_package(path: &Path) -> Result<(ModPackage, String)> {
    match reused_package(path) {
        Some(verified) => Ok(verified),
        None => inspect_verified(path),
    }
}

fn inspect_verified(path: &Path) -> Result<(ModPackage, String)> {
    let (package, _, hash, _, files) = inspect_package(path, false)?;
    let mut verified = VERIFIED_PACKAGES.lock().map_err(failure)?;
    if verified.len() >= 256 {
        verified.clear();
    }
    verified.insert(
        path.to_owned(),
        Arc::new((files, package.clone(), hash.clone())),
    );
    Ok((package, hash))
}

fn reused_package(path: &Path) -> Option<(ModPackage, String)> {
    if !path.is_absolute() || path.canonicalize().ok()? != path {
        return None;
    }
    let verified = VERIFIED_PACKAGES.lock().ok()?.get(path).cloned()?;
    ModStore::stamps_unchanged(&verified.0).then(|| (verified.1.clone(), verified.2.clone()))
}

type InspectedPackage = (
    ModPackage,
    String,
    String,
    BTreeMap<String, String>,
    Vec<(PathBuf, FileStamp)>,
);

fn inspect_package(path: &Path, collect_assets: bool) -> Result<InspectedPackage> {
    if !path.is_absolute() || path.canonicalize()? != path {
        return Err(failure("canonical_package_path_required"));
    }
    let manifest_path = path.join("mod.json");
    let (manifest, manifest_identity) = read_identified(&manifest_path, 8192)?;
    let mut files = vec![(manifest_path, manifest_identity)];
    let mut read_file = |relative: &str| {
        let (bytes, identity) = package_read_identified(path, relative, PACKAGE_FILE_LIMIT)?;
        files.push((path.join(relative), identity));
        Ok::<_, std::io::Error>(bytes)
    };
    let package: ModPackage = serde_json::from_slice(&manifest)?;
    package.validate()?;
    let source = read_file(&package.entrypoint)?;
    let mut hash = Sha256::new();
    hash.update(&manifest);
    hash.update([0]);
    hash.update(package.entrypoint.as_bytes());
    hash.update([0]);
    hash.update(&source);
    for (event, script) in &package.lifecycle {
        hash.update([0]);
        hash.update(event.as_bytes());
        hash.update([0]);
        hash.update(script.as_bytes());
        hash.update([0]);
        hash.update(read_file(script)?);
    }
    let mut assets = BTreeMap::new();
    let mut text = source.len();
    for asset in &package.assets {
        let content = read_file(asset)?;
        text += std::str::from_utf8(&content).map_or(0, str::len);
        if text > 256 * 1024 {
            return Err(failure(format!("package_text_input_limit: {}", package.id)));
        }
        hash.update([0]);
        hash.update(asset.as_bytes());
        hash.update([0]);
        hash.update(&content);
        if collect_assets && let Ok(text) = String::from_utf8(content) {
            assets.insert(asset.clone(), text);
        }
    }
    Ok((
        package,
        String::from_utf8(source).map_err(failure)?,
        format!("{:x}", hash.finalize()),
        assets,
        files,
    ))
}

pub struct ModStore {
    pub(super) root: PathBuf,
    policy: (PathBuf, u32),
    user: Option<String>,
}

pub(super) const STATE_LIMIT: usize = 196_608;
pub(super) const PACKAGE_FILE_LIMIT: u64 = 131_072;
const SECURITY_EVENTS: &str = "security-events.jsonl";
const SECURITY_EVENT_LIMIT: usize = 65_536;

#[derive(Clone, Debug)]
pub(super) enum StateLocation {
    Store { id: String, scope: String },
    Directory(PathBuf, String),
    Unavailable(&'static str),
}

pub(crate) fn lock(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(path)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match rustix::fs::flock(&file, rustix::fs::FlockOperation::NonBlockingLockExclusive) {
            Ok(()) => return Ok(file),
            Err(rustix::io::Errno::WOULDBLOCK) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn state_value(bytes: &[u8], version: u32) -> Result<Value> {
    let state: Value = serde_json::from_slice(bytes)?;
    if state["schema"] != super::MOD_STATE_STORAGE_SCHEMA_VERSION || state["version"] != version {
        return Err(failure(
            "state_migration_required: previous state preserved",
        ));
    }
    Ok(state["value"].clone())
}

fn directory_state(directory: &Path, name: &str, version: u32) -> Result<Value> {
    match read(&directory.join(name), STATE_LIMIT as u64) {
        Ok(bytes) => state_value(&bytes, version),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(error) => Err(error),
    }
}

fn write_directory_state(
    directory: &Path,
    name: &str,
    version: u32,
    previous: &Value,
    value: &Value,
) -> Result<()> {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)?;
    if directory.canonicalize()? != directory {
        return Err(failure("state_directory_invalid"));
    }
    let _lock = lock(&directory.join(".lock"))?;
    if &directory_state(directory, name, version)? != previous {
        return Err(failure("state_conflict: reload before retry"));
    }
    replace_directory_file(directory, name, &stored_state(version, value)?)
}

fn stored_state(version: u32, value: &Value) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(
        &json!({"schema": super::MOD_STATE_STORAGE_SCHEMA_VERSION, "version": version, "value": value}),
    )?;
    if bytes.len() > STATE_LIMIT {
        return Err(failure("state_limit"));
    }
    Ok(bytes)
}

/// Rewrites thread or checkout state stored at another version through `migrate`, keeping the previous file beside it; the handler runs unlocked and a concurrent change wins and is re-read.
pub(super) fn migrate_directory_state(
    directory: &Path,
    name: &str,
    version: u32,
    migrate: impl FnOnce(u64, Value) -> Result<Value>,
) -> Result<Value> {
    let path = directory.join(name);
    let bytes = read(&path, STATE_LIMIT as u64)?;
    let previous: Value = serde_json::from_slice(&bytes)?;
    let from = match previous["version"].as_u64() {
        Some(from)
            if previous["schema"] == super::MOD_STATE_STORAGE_SCHEMA_VERSION
                && from != u64::from(version) =>
        {
            from
        }
        _ => return state_value(&bytes, version),
    };
    let value = migrate(from, previous["value"].clone())?;
    let migrated = stored_state(version, &value)?;
    if directory.canonicalize()? != directory {
        return Err(failure("state_directory_invalid"));
    }
    let _lock = lock(&directory.join(".lock"))?;
    if read(&path, STATE_LIMIT as u64)? != bytes {
        return directory_state(directory, name, version);
    }
    replace_directory_file(
        directory,
        &format!("{name}-backup-{}", digest(&bytes)),
        &bytes,
    )?;
    replace_directory_file(directory, name, &migrated)?;
    Ok(value)
}

fn replace_directory_file(directory: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let temporary = directory.join(format!(".{name}.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&temporary);
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, directory.join(name))?;
        File::open(directory)?.sync_all()
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

impl ModStore {
    pub fn create(root: PathBuf, node: PathBuf) -> Result<Self> {
        std::fs::DirBuilder::new().mode(0o700).create(&root)?;
        let store = Self::open(root.canonicalize()?)?;
        let config = ModConfiguration {
            schema: 1,
            revision: 0,
            node: node.canonicalize()?,
            mods: Vec::new(),
        };
        let approved = BTreeSet::from([runner_grant(&config.node)?]);
        store.write_granting("mods.json", &serde_json::to_value(config)?, &approved)?;
        Ok(store)
    }

    /// The configured `node`, refused when the broker holds no runner grant for it.
    pub(super) fn verified_node(&self, node: &Path) -> Result<()> {
        verify_runner(
            node,
            brokered_grants(&self.root)?
                .as_ref()
                .map(|(_, grants)| grants),
        )
    }

    /// Points the store at another `node` binary, authorizing it as the runner when the broker is deployed.
    pub fn set_node(&self, node: &Path) -> Result<()> {
        let _lock = self.lock()?;
        self.recover_package_transaction()?;
        let node = node.canonicalize()?;
        if !node.is_file() {
            return Err(failure("node_unavailable"));
        }
        let mut config = self.configuration()?;
        // The same path still needs a fresh grant after an in-place Node upgrade.
        if config.node == node && self.verified_node(&node).is_ok() {
            return Ok(());
        }
        config.node = node;
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        let approved = BTreeSet::from([runner_grant(&config.node)?]);
        self.write_granting("mods.json", &serde_json::to_value(config)?, &approved)
    }

    /// Moves a corrupt store file aside; a reset `mods.json` keeps no mods selected and a reset `packages.lock.json` leaves its packages as plain trusted selections.
    pub fn reset(&self, name: &str) -> Result<PathBuf> {
        if !matches!(
            name,
            "mods.json" | "host.json" | "packages.lock.json" | "managed.json"
        ) {
            return Err(failure("store_file_not_resettable"));
        }
        let path = self.root.join(name);
        let aside = self.root.join(format!("{name}.corrupt"));
        let empty = match name {
            "mods.json" => Some(serde_json::to_value(ModConfiguration {
                schema: 1,
                revision: 0,
                node: super::node_on_path().ok_or_else(|| failure("node_unavailable"))?,
                mods: Vec::new(),
            })?),
            _ => None,
        };
        std::fs::rename(&path, &aside)?;
        if let Some(config) = empty
            && let Err(error) = self.write(name, &config)
        {
            let _ = std::fs::rename(&aside, &path);
            return Err(error);
        }
        Ok(aside)
    }

    pub fn open(root: PathBuf) -> Result<Self> {
        if !root.is_absolute() || root.canonicalize()? != root || !root.is_dir() {
            return Err(failure("canonical_store_path_required"));
        }
        Ok(Self {
            root,
            policy: (PathBuf::from(super::MANAGED_POLICY_FILE), 0),
            user: None,
        })
    }

    pub fn set_managed_policy(&mut self, file: PathBuf, owner: u32, user: &str) {
        self.policy = (file, owner);
        self.user = Some(user.to_owned());
    }

    pub fn managed(&self) -> Result<Option<super::Managed>> {
        super::load_managed_from(&self.policy.0, self.policy.1)
    }

    pub fn managed_user(&self) -> String {
        self.user.clone().unwrap_or_else(super::policy::login)
    }

    pub(super) fn lock(&self) -> Result<File> {
        lock(&self.root.join("store.lock"))
    }

    pub(super) fn write(&self, name: &str, value: &Value) -> Result<()> {
        self.write_granting(name, value, &BTreeSet::new())
    }

    /// Adds broker grants only for `approved` selections; dropped selections lose theirs without authorization.
    pub(super) fn write_granting(
        &self,
        name: &str,
        value: &Value,
        approved: &BTreeSet<String>,
    ) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(value)?;
        let brokered = match name {
            "mods.json" => brokered_grants(&self.root)?,
            _ => None,
        };
        let Some((mut generation, current)) = brokered else {
            return self.write_staged(name, &bytes, || Ok(()));
        };
        let runner = value["node"]
            .as_str()
            .and_then(|node| runner_grant(Path::new(node)).ok());
        let selected = value["mods"]
            .as_array()
            .into_iter()
            .flatten()
            .map(grant)
            .collect::<BTreeSet<_>>();
        let selected_record = |record: &String| {
            if selected.contains(record) || runner.as_ref() == Some(record) {
                return true;
            }
            let Ok(record) = serde_json::from_str::<Value>(record) else {
                return false;
            };
            let Some(source) = record.get("package_source") else {
                return false;
            };
            value["mods"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|selection| {
                    source["path"] == selection["path"] && source["sha256"] == selection["sha256"]
                })
        };
        let added = approved
            .iter()
            .filter(|grant| selected_record(grant) && !current.contains(*grant))
            .cloned()
            .collect::<BTreeSet<_>>();
        self.write_staged(name, &bytes, || {
            if !added.is_empty() {
                let granted = current.union(&added).collect::<BTreeSet<_>>();
                generation = crate::broker::authorized(
                    "grants.put",
                    json!({"store": self.root, "generation": generation, "grants": granted}),
                )?["generation"]
                    .as_u64()
                    .unwrap_or_default();
            }
            Ok(())
        })?;
        let kept = current
            .union(&added)
            .filter(|grant| selected_record(grant))
            .cloned()
            .collect::<BTreeSet<_>>();
        if kept.len() != current.len() + added.len() {
            let _ = crate::broker::call(
                "grants.put",
                json!({"store": self.root, "generation": generation, "grants": kept}),
            );
        }
        Ok(())
    }

    pub(super) fn write_bytes(&self, name: &str, bytes: &[u8]) -> Result<()> {
        self.write_staged(name, bytes, || Ok(()))
    }

    fn write_staged(
        &self,
        name: &str,
        bytes: &[u8],
        commit: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        let limit = match name {
            "packages.lock.json" => 524_288,
            "package-transaction.json" => 1_048_576,
            name if name.starts_with("state-") => STATE_LIMIT,
            _ => 65_536,
        };
        if bytes.len() > limit {
            return Err(failure("state_or_configuration_limit"));
        }
        let path = self.root.join(name);
        let temporary = self
            .root
            .join(format!(".{name}.{}.tmp", std::process::id()));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        let result = (|| {
            file.write_all(bytes)?;
            file.sync_all()?;
            commit()?;
            std::fs::rename(&temporary, &path)?;
            File::open(&self.root)?.sync_all()
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }

    pub fn configuration(&self) -> Result<ModConfiguration> {
        let path = self.root.join("mods.json");
        ModConfiguration::parse(&read(&path, 65_536)?, &path)
    }

    pub(super) fn record_security_event(&self, event: &str, detail: Value) -> Result<()> {
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(failure)?
            .as_secs();
        let mut entry = json!({"at": at, "event": event});
        if let (Some(entry), Value::Object(detail)) = (entry.as_object_mut(), detail) {
            entry.extend(detail);
        }
        let mut line = serde_json::to_vec(&entry)?;
        line.push(b'\n');
        let mut bytes = self.security_event_bytes()?;
        if bytes.len() + line.len() > SECURITY_EVENT_LIMIT {
            let start = bytes.len() / 2;
            let keep = bytes[start..]
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(bytes.len(), |offset| start + offset + 1);
            bytes.drain(..keep);
        }
        bytes.extend_from_slice(&line);
        self.write_staged(SECURITY_EVENTS, &bytes, || Ok(()))
    }

    pub fn security_events(&self) -> Result<Vec<Value>> {
        self.security_event_bytes()?
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).map_err(Into::into))
            .collect()
    }

    fn security_event_bytes(&self) -> Result<Vec<u8>> {
        match read(
            &self.root.join(SECURITY_EVENTS),
            SECURITY_EVENT_LIMIT as u64,
        ) {
            Ok(bytes) => Ok(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(error),
        }
    }

    pub fn managed_deployment(&self) -> Result<super::policy::ManagedDeployment> {
        match read(&self.root.join("managed.json"), 524_288) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
                failure(format!(
                    "managed_deployment_unreadable: {error}; run omd-mod reset STORE managed.json, then omd-mod package-sync"
                ))
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
            Err(error) => Err(error),
        }
    }

    pub fn selection_status(&self) -> Result<Value> {
        self.selection_status_in(None)
    }

    /// Stamps of the store files a package listing reads; `None` under administrator policy or the broker.
    pub fn listing_stamp(&self) -> Option<Value> {
        if crate::broker::deployed() || std::fs::symlink_metadata(&self.policy.0).is_ok() {
            return None;
        }
        let stamps = [
            self.root.join("mods.json"),
            self.root.join("packages.lock.json"),
            self.root.join("package-transaction.json"),
            self.root.join("managed.json"),
        ]
        .iter()
        .map(|path| super::configuration_stamp(path))
        .collect::<Vec<_>>();
        Some(json!([self.root, stamps]))
    }

    pub fn package_stamps<'a>(
        paths: impl IntoIterator<Item = &'a Path>,
    ) -> Option<Vec<(PathBuf, FileStamp)>> {
        let verified = VERIFIED_PACKAGES.lock().ok()?;
        paths
            .into_iter()
            .map(|path| verified.get(path).map(|package| package.0.clone()))
            .collect::<Option<Vec<_>>>()
            .map(|files| files.concat())
    }

    pub fn stamps_unchanged(stamps: &[(PathBuf, FileStamp)]) -> bool {
        stamps
            .iter()
            .all(|(file, expected)| super::configuration_stamp(file) == Some(*expected))
    }

    pub fn verify_selections(&self) -> Result<()> {
        for selection in self.configuration()?.mods {
            let _ = verified_package(&selection.path);
        }
        Ok(())
    }

    pub fn selection_status_in(&self, project: Option<&Path>) -> Result<Value> {
        let configuration = self.configuration()?;
        let lock = self.package_lock()?;
        self.selection_status_inspected_in(project, &configuration, &lock, None)
    }

    pub(crate) fn selection_status_inspected_in(
        &self,
        project: Option<&Path>,
        configuration: &ModConfiguration,
        lock: &crate::ModPackageLock,
        mut manifests: Option<&mut Vec<Value>>,
    ) -> Result<Value> {
        let brokered = brokered_grants(&self.root)?;
        let (managed, mut managed_error) = match self.managed() {
            Ok(managed) => (managed, None),
            Err(error) => (None, Some(error.to_string())),
        };
        let mut entries = configuration.mods.clone();
        let mut pending = Vec::new();
        let mut administered = 0;
        if let Some(managed) = &managed {
            let deployment = self.managed_deployment().unwrap_or_else(|error| {
                managed_error = Some(error.to_string());
                Default::default()
            });
            let (selections, unsynced) =
                managed.selections(&deployment, &self.managed_user(), project);
            administered = selections.len();
            entries.splice(0..0, selections);
            pending = unsynced;
        }
        let mut selections: Vec<Value> = Vec::new();
        let mut groups = std::collections::BTreeMap::<String, Vec<usize>>::new();
        let mut inspections = entries
            .iter()
            .map(|selection| reused_package(&selection.path).map(Ok))
            .collect::<Vec<_>>();
        let misses = (0..entries.len())
            .filter(|index| inspections[*index].is_none())
            .collect::<Vec<_>>();
        let inspect = |index: usize| (index, inspect_verified(&entries[index].path));
        let inspected = if misses.len() > 4 {
            let next = std::sync::atomic::AtomicUsize::new(0);
            std::thread::scope(|scope| {
                let workers = (0..misses.len().min(8))
                    .map(|_| {
                        scope.spawn(|| {
                            let mut inspected = Vec::new();
                            loop {
                                let next = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                let Some(index) = misses.get(next) else {
                                    break;
                                };
                                inspected.push(inspect(*index));
                            }
                            inspected
                        })
                    })
                    .collect::<Vec<_>>();
                workers
                    .into_iter()
                    .flat_map(|worker| {
                        worker
                            .join()
                            .unwrap_or_else(|error| std::panic::resume_unwind(error))
                    })
                    .collect::<Vec<_>>()
            })
        } else {
            misses.into_iter().map(inspect).collect()
        };
        for (index, result) in inspected {
            inspections[index] = Some(result);
        }
        for (index, (selection, inspected)) in entries
            .iter()
            .zip(inspections.into_iter().flatten())
            .enumerate()
        {
            let administered = index < administered;
            let mut settings_origin = BTreeMap::new();
            let (mut id, error, environment) = match inspected {
                Ok((manifest, integrity)) => {
                    if let Some(manifests) = manifests.as_mut() {
                        manifests.push(json!({
                            "api": manifest.api,
                            "version": manifest.version,
                            "description": manifest.description,
                            "settings_schema": manifest.settings_schema,
                        }));
                    }
                    let defaults = manifest
                        .settings_schema
                        .as_ref()
                        .and_then(|schema| schema["properties"].as_object())
                        .into_iter()
                        .flatten()
                        .filter(|(_, property)| property.get("default").is_some())
                        .map(|(key, _)| key);
                    for key in selection.settings.keys().chain(defaults) {
                        let origin = match selection.settings.contains_key(key) {
                            false => "default",
                            true if administered => "managed",
                            true => "user",
                        };
                        settings_origin.insert(key.clone(), origin);
                    }
                    let source = authenticated_source(
                        selection,
                        &manifest.id,
                        brokered.as_ref().map(|(_, grants)| grants),
                    );
                    let error = if integrity != selection.sha256 {
                        Some("source_changed: inspect and trust the new digest".to_owned())
                    } else if !administered
                        && (!super::MOD_SCOPES.contains(&selection.scope.as_str())
                            || selection.tier.is_some())
                    {
                        Some(format!(
                            "unsupported_scope: {}; the managed scope and tiers come only from administrator policy",
                            selection.scope
                        ))
                    } else if let Some(refusal) = managed
                        .as_ref()
                        .filter(|_| !administered)
                        .and_then(|managed| {
                            managed.policy.refusal(
                                &manifest.id,
                                &manifest.capabilities,
                                source.as_deref(),
                            )
                        })
                    {
                        Some(refusal)
                    } else if manifest
                        .capabilities
                        .iter()
                        .any(|capability| !selection.capabilities.contains(capability))
                        || selection.capabilities.iter().any(|capability| {
                            !super::MOD_CAPABILITIES.contains(&capability.as_str())
                        })
                    {
                        Some("capability_denied".to_owned())
                    } else {
                        super::check_secret_environment(&manifest, &selection.secret_environment)
                            .and_then(|()| super::validate_settings(&manifest, &selection.settings))
                            .err()
                            .map(|error| error.to_string())
                    };
                    (Some(manifest.id), error, manifest.exec_environment)
                }
                Err(error) => {
                    if let Some(manifests) = manifests.as_mut() {
                        manifests.push(Value::Null);
                    }
                    (None, Some(error.to_string()), Vec::new())
                }
            };
            if id.is_none() {
                id = lock
                    .packages
                    .values()
                    .find(|item| item.path == selection.path && item.scope == selection.scope)
                    .map(|item| item.id.clone());
            }
            let packaged = id
                .as_ref()
                .and_then(|id| lock.packages.get(id))
                .is_some_and(|item| item.path == selection.path && item.scope == selection.scope);
            let index = selections.len();
            if selection.enabled
                && error.is_none()
                && let Some(id) = &id
            {
                groups.entry(id.clone()).or_default().push(index);
            }
            selections.push(json!({
                "id": id,
                "path": selection.path,
                "scope": selection.scope,
                "tier": selection.tier,
                "selected": selection.enabled,
                "required": selection.required,
                "packaged": packaged,
                "settings_origin": settings_origin,
                "sha256": selection.sha256,
                "capabilities": selection.capabilities,
                "exec_environment": environment,
                "secret_environment": selection.secret_environment,
                "expires_at": selection.expires_at,
                "authority_current": selection.authority_current(),
                "settings_keys": selection.settings.keys().collect::<Vec<_>>(),
                "settings_sha256": digest(&serde_json::to_vec(&selection.settings)?),
                "error": error,
                "effective": false,
                "reason": if selection.enabled { "pending_runtime_validation" } else { "disabled" },
            }));
        }
        for rejection in pending {
            if let Some(manifests) = manifests.as_mut() {
                manifests.push(Value::Null);
            }
            selections.push(
                json!({"id": rejection.id, "path": rejection.path, "scope": rejection.scope,
                "selected": true, "packaged": false, "error": rejection.reason, "effective": false,
                "reason": "managed_pending_sync"}),
            );
        }
        let rank = |scope: &Value| match scope.as_str() {
            Some(super::MANAGED_SCOPE) => 2,
            Some("project") => 1,
            _ => 0,
        };
        for indices in groups.values() {
            let top = indices
                .iter()
                .map(|index| rank(&selections[*index]["scope"]))
                .max()
                .unwrap_or_default();
            let candidates = indices
                .iter()
                .copied()
                .filter(|index| rank(&selections[*index]["scope"]) == top)
                .collect::<Vec<_>>();
            let shadow = format!(
                "shadowed_by_{}_scope",
                selections[candidates[0]]["scope"]
                    .as_str()
                    .unwrap_or_default()
            );
            if candidates.len() != 1 {
                for index in indices {
                    selections[*index]["reason"] = if candidates.contains(index) {
                        json!("duplicate_scope_conflict")
                    } else {
                        json!(format!("{shadow}_conflict"))
                    };
                }
                continue;
            }
            let winner = candidates[0];
            selections[winner]["effective"] = json!(true);
            selections[winner]["reason"] = json!("selected");
            for index in indices.iter().copied().filter(|index| *index != winner) {
                selections[index]["reason"] = json!(shadow);
            }
        }
        Ok(json!({
            "revision": configuration.revision,
            "precedence": "valid enabled managed selection over project over user; administrator policy refuses user and project selections it does not allow; runtime conflicts can still reject activation",
            "managed": managed.map(|managed| json!({"origin": managed.origin, "sha256": managed.sha256, "policy": managed.policy})),
            "managed_error": managed_error,
            "selections": selections,
            "packaged": lock.packages.keys().collect::<Vec<_>>(),
        }))
    }

    pub fn inspect_package(path: &Path) -> Result<Value> {
        let (manifest, _, sha256) = package(path)?;
        Ok(json!({"manifest": manifest, "sha256": sha256, "path": path}))
    }

    pub fn trust(
        &self,
        path: PathBuf,
        sha256: &str,
        capabilities: Vec<String>,
        scope: &str,
    ) -> Result<()> {
        self.trust_with_secrets(path, sha256, capabilities, scope, Vec::new())
    }

    pub fn trust_with_secrets(
        &self,
        path: PathBuf,
        sha256: &str,
        capabilities: Vec<String>,
        scope: &str,
        secret_environment: Vec<String>,
    ) -> Result<()> {
        self.trust_all(vec![Trust {
            path,
            sha256: sha256.to_owned(),
            capabilities,
            scope: scope.to_owned(),
            secret_environment,
            expires_at: None,
        }])
    }

    pub fn trust_all(&self, packages: Vec<Trust>) -> Result<()> {
        if self
            .managed()?
            .is_some_and(|managed| !managed.policy.sideload)
        {
            return Err(failure(
                "managed_sideload_denied: administrator policy loads mods only from installed packages",
            ));
        }
        let _lock = self.lock()?;
        self.recover_package_transaction()?;
        let mut config = self.configuration()?;
        let mut trusted = BTreeSet::new();
        for Trust {
            path,
            sha256,
            capabilities,
            scope,
            secret_environment,
            expires_at,
        } in packages
        {
            if !super::MOD_SCOPES.contains(&scope.as_str()) {
                return Err(failure("unsupported_scope: user or project"));
            }
            let (package, _, actual) = package(&path)?;
            if sha256 != actual {
                return Err(failure("trust_digest_mismatch"));
            }
            if capabilities != package.capabilities {
                return Err(failure("explicit_exact_capability_grant_required"));
            }
            super::check_secret_environment(&package, &secret_environment)?;
            let (settings, required) = config
                .mods
                .iter()
                .find(|m| m.path == path)
                .map(|m| (m.settings.clone(), m.required))
                .unwrap_or_default();
            super::validate_settings(&package, &settings)?;
            config.mods.retain(|m| m.path != path);
            trusted.insert(path.clone());
            config.mods.push(ModSelection {
                path,
                sha256: actual,
                enabled: false,
                capabilities,
                settings,
                scope,
                secret_environment: package.secret_environment(),
                expires_at,
                tier: None,
                required,
            });
        }
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        let approved = config
            .mods
            .iter()
            .filter(|selection| trusted.contains(&selection.path))
            .map(|selection| grant(&json!(selection)))
            .collect();
        let event = json!({"selections": config.mods.iter()
            .filter(|selection| trusted.contains(&selection.path))
            .map(|selection| json!({"path": selection.path, "sha256": selection.sha256,
                "capabilities": selection.capabilities, "scope": selection.scope,
                "expires_at": selection.expires_at}))
            .collect::<Vec<_>>()});
        self.write_granting("mods.json", &serde_json::to_value(config)?, &approved)?;
        let _ = self.record_security_event("trust", event);
        Ok(())
    }

    pub fn broker_grants_import(&self, snapshot: Option<Value>) -> Result<Value> {
        let _lock = self.lock()?;
        self.recover_package_transaction()?;
        let config = self.configuration()?;
        let current = serde_json::to_value(&config)?;
        let Some(snapshot) = snapshot else {
            return Ok(current);
        };
        if snapshot != current {
            return Err(failure("broker_import_configuration_changed"));
        }
        let mut approved = BTreeSet::from([runner_grant(&config.node)?]);
        let mut skipped = Vec::new();
        for selection in &config.mods {
            let eligible = (|| {
                let (manifest, _, hash) = package(&selection.path)?;
                if hash != selection.sha256
                    || !super::MOD_SCOPES.contains(&selection.scope.as_str())
                    || selection.tier.is_some()
                    || manifest
                        .capabilities
                        .iter()
                        .any(|capability| !selection.capabilities.contains(capability))
                    || selection
                        .capabilities
                        .iter()
                        .any(|capability| !super::MOD_CAPABILITIES.contains(&capability.as_str()))
                {
                    return Err(failure("broker_import_selection_changed"));
                }
                super::check_secret_environment(&manifest, &selection.secret_environment)?;
                super::validate_settings(&manifest, &selection.settings)?;
                Ok::<_, std::io::Error>(())
            })();
            match eligible {
                Ok(()) => {
                    approved.insert(grant(&json!(selection)));
                }
                Err(error) => {
                    skipped.push(json!({"path":selection.path,"reason":error.to_string()}))
                }
            }
        }
        self.write_granting("mods.json", &current, &approved)?;
        Ok(json!({"imported": approved.len() - 1, "skipped": skipped}))
    }

    pub fn revoke(&self, target: &str) -> Result<()> {
        let _lock = self.lock()?;
        self.recover_package_transaction()?;
        let mut lock = self.read_package_lock().unwrap_or_default();
        let managed = lock.packages.get_mut(target).map(|package| {
            package.enabled = false;
            package.trust = Default::default();
            (package.path.clone(), package.scope.clone())
        });
        let mut config = self.configuration()?;
        let mut revoked = Vec::new();
        for selection in &mut config.mods {
            if managed
                .as_ref()
                .is_some_and(|(path, scope)| &selection.path == path && &selection.scope == scope)
                || selection.path == Path::new(target)
                || package(&selection.path).is_ok_and(|(manifest, _, _)| manifest.id == target)
            {
                selection.enabled = false;
                selection.capabilities.clear();
                selection.secret_environment.clear();
                selection.expires_at = None;
                revoked.push(json!({"path": selection.path, "scope": selection.scope}));
            }
        }
        if revoked.is_empty() {
            return Err(failure("package_not_trusted"));
        }
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        let event = json!({"mod": target, "selections": revoked});
        if managed.is_some() {
            lock.revision = lock
                .revision
                .checked_add(1)
                .ok_or_else(|| failure("revision_overflow"))?;
            self.commit_package_transaction(lock, config, &[], "revoke", event, &[])?;
            Ok(())
        } else {
            self.write("mods.json", &serde_json::to_value(config)?)?;
            let _ = self.record_security_event("revoke", event);
            Ok(())
        }
    }

    pub fn enable(&self, path: &Path, enabled: bool) -> Result<()> {
        let _lock = self.lock()?;
        self.recover_package_transaction()?;
        if self
            .read_package_lock()?
            .packages
            .values()
            .any(|package| package.path == path)
        {
            return Err(failure(if enabled {
                "managed_package_activation_requires_package_plan"
            } else {
                "managed_package_disable_requires_package_disable"
            }));
        }
        let mut config = self.configuration()?;
        let Some(selection) = config.mods.iter_mut().find(|m| m.path == path) else {
            return Err(failure(
                if self
                    .managed_deployment()
                    .is_ok_and(|deployment| deployment.packages.iter().any(|p| p.path == path))
                {
                    "managed_by_policy: administrator policy requires this mod; ask your administrator to change the policy"
                } else {
                    "package_not_trusted"
                },
            ));
        };
        if enabled {
            let (manifest, _, hash) = package(path)?;
            if hash != selection.sha256 {
                return Err(failure("source_changed: inspect and trust the new digest"));
            }
            if manifest
                .capabilities
                .iter()
                .any(|capability| !selection.capabilities.contains(capability))
            {
                return Err(failure("capability_denied: trust the package again"));
            }
            self.check_service_providers(&manifest, path)?;
        }
        selection.enabled = enabled;
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        self.write("mods.json", &serde_json::to_value(config)?)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn require(&self, path: &Path) -> Result<()> {
        let _lock = self.lock()?;
        let mut config = self.configuration()?;
        let selection = config
            .mods
            .iter_mut()
            .find(|m| m.path == path)
            .ok_or_else(|| failure("package_not_trusted"))?;
        selection.required = true;
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        self.write("mods.json", &serde_json::to_value(config)?)
    }

    pub(super) fn check_service_providers(&self, package: &ModPackage, path: &Path) -> Result<()> {
        let selections = self.configuration()?.mods;
        for import in package
            .services
            .imports
            .iter()
            .filter(|import| !import.optional)
        {
            let providers = selections
                .iter()
                .filter(|selection| selection.path != path)
                .filter_map(|selection| {
                    let (manifest, _, _) = super::store::package(&selection.path).ok()?;
                    manifest
                        .services
                        .exports
                        .iter()
                        .any(|export| export.name == import.name)
                        .then(|| {
                            let cyclic = manifest.services.imports.iter().any(|import| {
                                package
                                    .services
                                    .exports
                                    .iter()
                                    .any(|export| export.name == import.name)
                            });
                            (manifest.id, selection.enabled || cyclic)
                        })
                })
                .collect::<Vec<_>>();
            // A cyclic provider is left to activation, which reports the dependency cycle.
            if providers.iter().any(|(_, ready)| *ready) {
                continue;
            }
            let names = providers.into_iter().map(|(id, _)| id).collect::<Vec<_>>();
            return Err(failure(if names.is_empty() {
                format!(
                    "service_provider_missing: {} needs the {} service and no installed mod provides it",
                    package.id, import.name
                )
            } else {
                format!(
                    "service_provider_missing: {} needs the {} service; enable {} first",
                    package.id,
                    import.name,
                    names.join(" or ")
                )
            }));
        }
        Ok(())
    }

    pub fn reload(&self) -> Result<()> {
        let _lock = self.lock()?;
        self.recover_package_transaction()?;
        let mut config = self.configuration()?;
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        let revision = config.revision;
        self.write("mods.json", &serde_json::to_value(config)?)?;
        drop(_lock);
        super::reset_ui_states(&self.root, revision);
        Ok(())
    }

    pub(super) fn state_name(id: &str, scope: &str) -> String {
        match scope {
            "project" => format!("state-{id}.project.json"),
            _ => format!("state-{id}.json"),
        }
    }

    pub(super) fn state(&self, id: &str, scope: &str, version: u32) -> Result<Value> {
        if !identifier(id) {
            return Err(failure("invalid_mod_id"));
        }
        let bytes = match read(
            &self.root.join(Self::state_name(id, scope)),
            STATE_LIMIT as u64,
        ) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
            Err(e) => return Err(e),
        };
        state_value(&bytes, version)
    }

    pub(super) fn state_file(&self, location: &StateLocation) -> Option<PathBuf> {
        match location {
            StateLocation::Store { id, scope } => Some(self.root.join(Self::state_name(id, scope))),
            StateLocation::Directory(directory, name) => Some(directory.join(name)),
            StateLocation::Unavailable(_) => None,
        }
    }

    pub(super) fn scoped_state(&self, location: &StateLocation, version: u32) -> Result<Value> {
        match location {
            StateLocation::Store { id, scope } => self.state(id, scope, version),
            StateLocation::Directory(directory, name) => directory_state(directory, name, version),
            StateLocation::Unavailable(_) => Ok(Value::Null),
        }
    }

    pub(super) fn write_scoped_state(
        &self,
        location: &StateLocation,
        version: u32,
        previous: &Value,
        value: &Value,
    ) -> Result<()> {
        match location {
            StateLocation::Store { id, scope } => {
                self.write_state(id, scope, version, previous, value)
            }
            StateLocation::Directory(directory, name) => {
                write_directory_state(directory, name, version, previous, value)
            }
            StateLocation::Unavailable(reason) => Err(failure(*reason)),
        }
    }

    pub(super) fn write_state(
        &self,
        id: &str,
        scope: &str,
        version: u32,
        previous: &Value,
        value: &Value,
    ) -> Result<()> {
        let _lock = self.lock()?;
        self.recover_package_transaction()?;
        if &self.state(id, scope, version)? != previous {
            return Err(failure("state_conflict: reload before retry"));
        }
        self.write(
            &Self::state_name(id, scope),
            &json!({"schema": super::MOD_STATE_STORAGE_SCHEMA_VERSION, "version": version, "value": value}),
        )
    }
}
