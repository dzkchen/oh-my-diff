use super::ModConfiguration;
use super::ModPackage;
use super::ModSelection;
use super::Result;
use super::digest;
use super::failure;
use super::identifier;
use serde_json::Value;
use serde_json::json;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
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
    if !path.is_absolute() || path.canonicalize()? != path {
        return Err(failure("canonical_package_path_required"));
    }
    let manifest = read(&path.join("mod.json"), 8192)?;
    let source = read(&path.join("index.ts"), 65_536)?;
    let package: ModPackage = serde_json::from_slice(&manifest)?;
    package.validate()?;
    let mut bytes = manifest;
    bytes.push(0);
    bytes.extend_from_slice(&source);
    Ok((
        package,
        String::from_utf8(source).map_err(failure)?,
        digest(&bytes),
    ))
}

pub struct ModStore {
    pub(super) root: PathBuf,
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
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(self.root.join("store.lock"))?;
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

    pub(super) fn write(&self, name: &str, value: &Value) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(value)?;
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
            file.write_all(&bytes)?;
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
        let state: Value = serde_json::from_slice(&bytes)?;
        if state["schema"] != 1 || state["version"] != version {
            return Err(failure(
                "state_migration_required: previous state preserved",
            ));
        }
        Ok(state["value"].clone())
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
        if &self.state(id, scope, version)? != previous {
            return Err(failure("state_conflict: reload before retry"));
        }
        self.write(
            &Self::state_name(id, scope),
            &json!({"schema": 1, "version": version, "value": value}),
        )
    }
}
