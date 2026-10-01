use super::ModConfiguration;
use super::ModPackage;
use super::ModSelection;
use super::Result;
use super::digest;
use super::failure;
use super::identifier;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::path::PathBuf;

pub(super) fn read(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags((rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(failure("regular_file_required"));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(failure("file_limit"));
    }
    Ok(bytes)
}

pub(super) fn package(path: &Path) -> Result<(ModPackage, String, String)> {
    let (package, source, hash, _) = package_with_assets(path)?;
    Ok((package, source, hash))
}

pub(super) fn package_with_assets(
    path: &Path,
) -> Result<(ModPackage, String, String, BTreeMap<String, String>)> {
    if !path.is_absolute() || path.canonicalize()? != path {
        return Err(failure("canonical_package_path_required"));
    }
    let manifest = read(&path.join("mod.json"), 8192)?;
    let package: ModPackage = serde_json::from_slice(&manifest)?;
    package.validate()?;
    let source = read(&path.join(&package.entrypoint), 65_536)?;
    let mut bytes = manifest;
    bytes.push(0);
    bytes.extend_from_slice(package.entrypoint.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(&source);
    for (event, script) in &package.lifecycle {
        bytes.push(0);
        bytes.extend_from_slice(event.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(script.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(&read(&path.join(script), 65_536)?);
    }
    let mut assets = BTreeMap::new();
    for asset in &package.assets {
        let content = read(&path.join(asset), 65_536)?;
        bytes.push(0);
        bytes.extend_from_slice(asset.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(&content);
        if let Ok(text) = String::from_utf8(content) {
            assets.insert(asset.clone(), text);
        }
    }
    Ok((
        package,
        String::from_utf8(source).map_err(failure)?,
        digest(&bytes),
        assets,
    ))
}

pub struct ModStore {
    pub(super) root: PathBuf,
}

pub(super) const SCOPED_STATE_LIMIT: usize = 196_608;

#[derive(Clone, Debug)]
pub(super) enum StateLocation {
    Store { id: String, scope: String },
    Directory(PathBuf, String),
    Unavailable(&'static str),
}

fn lock(path: &Path) -> Result<File> {
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
    match read(&directory.join(name), SCOPED_STATE_LIMIT as u64) {
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
    let bytes = serde_json::to_vec(
        &json!({"schema": super::MOD_STATE_STORAGE_SCHEMA_VERSION, "version": version, "value": value}),
    )?;
    if bytes.len() > SCOPED_STATE_LIMIT {
        return Err(failure("state_limit"));
    }
    let temporary = directory.join(format!(".{name}.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&temporary);
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(&bytes)?;
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
        std::fs::create_dir(&root)?;
        let store = Self::open(root.canonicalize()?)?;
        let config = ModConfiguration {
            schema: 1,
            revision: 0,
            node: node.canonicalize()?,
            mods: Vec::new(),
        };
        store.write("mods.json", &serde_json::to_value(config)?)?;
        Ok(store)
    }

    pub fn open(root: PathBuf) -> Result<Self> {
        if !root.is_absolute() || root.canonicalize()? != root || !root.is_dir() {
            return Err(failure("canonical_store_path_required"));
        }
        Ok(Self { root })
    }

    pub(super) fn lock(&self) -> Result<File> {
        lock(&self.root.join("store.lock"))
    }

    pub(super) fn write(&self, name: &str, value: &Value) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(value)?;
        self.write_bytes(name, &bytes)
    }

    pub(super) fn write_bytes(&self, name: &str, bytes: &[u8]) -> Result<()> {
        if bytes.len() > 65_536 {
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
            std::fs::rename(&temporary, &path)?;
            File::open(&self.root)?.sync_all()
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }

    pub fn configuration(&self) -> Result<ModConfiguration> {
        serde_json::from_slice(&read(&self.root.join("mods.json"), 65_536)?).map_err(failure)
    }

    pub fn selection_status(&self) -> Result<Value> {
        let configuration = self.configuration()?;
        let lock = self.package_lock()?;
        let mut selections: Vec<Value> = Vec::new();
        let mut groups = std::collections::BTreeMap::<String, Vec<usize>>::new();
        for selection in &configuration.mods {
            let inspected = package(&selection.path);
            let (mut id, error) = match inspected {
                Ok((manifest, _, integrity)) => {
                    let error = if integrity != selection.sha256 {
                        Some("source_changed: inspect and trust the new digest".to_owned())
                    } else if !super::MOD_SCOPES.contains(&selection.scope.as_str()) {
                        Some(format!("unsupported_scope: {}", selection.scope))
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
                        super::validate_settings(&manifest, &selection.settings)
                            .err()
                            .map(|error| error.to_string())
                    };
                    (Some(manifest.id), error)
                }
                Err(error) => (None, Some(error.to_string())),
            };
            if id.is_none() {
                id = lock
                    .packages
                    .values()
                    .find(|item| item.path == selection.path && item.scope == selection.scope)
                    .map(|item| item.id.clone());
            }
            let managed = id
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
                "selected": selection.enabled,
                "managed": managed,
                "sha256": selection.sha256,
                "capabilities": selection.capabilities,
                "settings_keys": selection.settings.keys().collect::<Vec<_>>(),
                "settings_sha256": digest(&serde_json::to_vec(&selection.settings)?),
                "error": error,
                "effective": false,
                "reason": if selection.enabled { "pending_runtime_validation" } else { "disabled" },
            }));
        }
        for indices in groups.values() {
            let project = indices
                .iter()
                .copied()
                .filter(|index| selections[*index]["scope"] == "project")
                .collect::<Vec<_>>();
            let candidates = if project.is_empty() {
                indices.clone()
            } else {
                project
            };
            if candidates.len() != 1 {
                for index in indices {
                    selections[*index]["reason"] = if candidates.contains(index) {
                        json!("duplicate_scope_conflict")
                    } else {
                        json!("shadowed_by_project_scope_conflict")
                    };
                }
                continue;
            }
            let winner = candidates[0];
            selections[winner]["effective"] = json!(true);
            selections[winner]["reason"] = json!("selected");
            for index in indices.iter().copied().filter(|index| *index != winner) {
                selections[index]["reason"] = json!("shadowed_by_project_scope");
            }
        }
        Ok(json!({
            "revision": configuration.revision,
            "precedence": "valid enabled project selection over valid enabled user selection; runtime conflicts can still reject activation",
            "selections": selections,
            "managed_packages": lock.packages.keys().collect::<Vec<_>>(),
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
        let _lock = self.lock()?;
        self.recover_package_transaction()?;
        if !super::MOD_SCOPES.contains(&scope) {
            return Err(failure("unsupported_scope: user or project"));
        }
        let (package, _, actual) = package(&path)?;
        if sha256 != actual {
            return Err(failure("trust_digest_mismatch"));
        }
        if capabilities != package.capabilities {
            return Err(failure("explicit_exact_capability_grant_required"));
        }
        let mut config = self.configuration()?;
        let settings = config
            .mods
            .iter()
            .find(|m| m.path == path)
            .map(|m| m.settings.clone())
            .unwrap_or_default();
        super::validate_settings(&package, &settings)?;
        config.mods.retain(|m| m.path != path);
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        config.mods.push(ModSelection {
            path,
            sha256: actual,
            enabled: false,
            capabilities,
            settings,
            scope: scope.to_owned(),
        });
        self.write("mods.json", &serde_json::to_value(config)?)
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
        let selection = config
            .mods
            .iter_mut()
            .find(|m| m.path == path)
            .ok_or_else(|| failure("package_not_trusted"))?;
        if enabled {
            let (_, _, hash) = package(path)?;
            if hash != selection.sha256 {
                return Err(failure("source_changed: inspect and trust the new digest"));
            }
        }
        selection.enabled = enabled;
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        self.write("mods.json", &serde_json::to_value(config)?)
    }

    pub fn reload(&self) -> Result<()> {
        let _lock = self.lock()?;
        self.recover_package_transaction()?;
        let mut config = self.configuration()?;
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        self.write("mods.json", &serde_json::to_value(config)?)
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
        let bytes = match read(&self.root.join(Self::state_name(id, scope)), 65_536) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
            Err(e) => return Err(e),
        };
        state_value(&bytes, version)
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
