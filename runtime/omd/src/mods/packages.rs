use super::*;

impl ModStore {
    pub fn settings(&self, path: &Path, settings: BTreeMap<String, Value>) -> Result<()> {
        self.update_settings(path, |current| *current = settings)
            .map(drop)
    }

    pub fn merge_settings(
        &self,
        path: &Path,
        values: &serde_json::Map<String, Value>,
    ) -> Result<BTreeMap<String, Value>> {
        self.update_settings(path, |settings| {
            for (name, value) in values {
                if value.is_null() {
                    settings.remove(name);
                } else {
                    settings.insert(name.clone(), value.clone());
                }
            }
        })
    }

    fn update_settings(
        &self,
        path: &Path,
        change: impl FnOnce(&mut BTreeMap<String, Value>),
    ) -> Result<BTreeMap<String, Value>> {
        let _lock = self.lock()?;
        self.recover_package_transaction()?;
        let mut config = self.configuration()?;
        let selection = config
            .mods
            .iter_mut()
            .find(|m| m.path == path)
            .ok_or_else(|| failure("package_not_trusted"))?;
        let (package, _, hash) = store::package(path)?;
        if hash != selection.sha256 {
            return Err(failure("source_changed: inspect and trust the new digest"));
        }
        let mut settings = declared_settings(package.settings_schema.as_ref(), &selection.settings);
        change(&mut settings);
        validate_settings(&package, &settings)?;
        if settings == selection.settings {
            return Ok(settings);
        }
        selection.settings = settings.clone();
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        self.write("mods.json", &serde_json::to_value(config)?)?;
        Ok(settings)
    }

    pub fn discover(user: &Path, project: &Path) -> Result<Value> {
        let mut selected: BTreeMap<String, Value> = BTreeMap::new();
        let mut errors = Vec::new();
        for (scope, root) in [("user", user), ("project", project)] {
            if !root.exists() {
                continue;
            }
            let mut paths = std::fs::read_dir(root)?
                .map(|e| e.map(|e| e.path()))
                .collect::<std::io::Result<Vec<_>>>()?;
            if paths.len() > 256 {
                return Err(failure("discovery_limit"));
            }
            paths.sort();
            for path in paths {
                if !path.is_dir() {
                    continue;
                }
                let result = path
                    .canonicalize()
                    .and_then(|path| Self::inspect_package(&path));
                match result {
                    Ok(mut value) => {
                        let id = value["manifest"]["id"]
                            .as_str()
                            .ok_or_else(|| failure("missing_mod_id"))?
                            .to_owned();
                        value["scope"] = json!(scope);
                        value["shadows"] = selected
                            .get(&id)
                            .map(|v| v["path"].clone())
                            .unwrap_or(Value::Null);
                        value["trusted"] = json!(false);
                        selected.insert(id, value);
                    }
                    Err(error) => errors.push(json!({"path":path,"error":error.to_string()})),
                }
            }
        }
        Ok(
            json!({"packages":selected.into_values().collect::<Vec<_>>(),"errors":errors,"precedence":"project over user; discovery never grants trust"}),
        )
    }

    pub fn migrate(&self, target: &Path) -> Result<Value> {
        let _lock = self.lock()?;
        self.recover_package_transaction()?;
        let config = self.configuration()?;
        let selection = selected(&config, target)?;
        let (package, source, hash, assets) = store::package_with_assets(&selection.path)?;
        if hash != selection.sha256
            || selection.capabilities != package.capabilities
            || !package.capabilities.iter().any(|c| c == "store")
        {
            return Err(failure("migration_requires_trusted_store_capability"));
        }
        let name = ModStore::state_name(&package.id, &selection.scope);
        let previous: Value = serde_json::from_slice(
            &store::read(&self.root.join(&name), store::STATE_LIMIT as u64).map_err(|error| {
                if error.kind() == io::ErrorKind::NotFound {
                    failure("migration_requires_saved_state")
                } else {
                    error
                }
            })?,
        )?;
        let from = previous["version"]
            .as_u64()
            .ok_or_else(|| failure("invalid_state_version"))?;
        if previous["schema"] != MOD_STATE_STORAGE_SCHEMA_VERSION
            || from == u64::from(package.state_version)
        {
            return Err(failure("migration_requires_different_state_version"));
        }
        let to = package.state_version;
        let mut loaded = detached(
            package,
            source,
            assets,
            selection.clone(),
            previous["value"].clone(),
        );
        self.verified_runner()?;
        loaded.registrations = migration_registrations(&loaded)?;
        let state = run_migration(&loaded, from, &|| true)?;
        let backup = format!("{name}-backup-{}", digest(&serde_json::to_vec(&previous)?));
        self.write(&backup, &previous)?;
        self.write(
            &name,
            &json!({"schema":MOD_STATE_STORAGE_SCHEMA_VERSION,"version":to,"value":state}),
        )?;
        Ok(
            json!({"id":loaded.package.id,"from":from,"to":to,"backup":self.root.join(backup),
            "source_sha256":hash,"settings_sha256":digest(&serde_json::to_vec(&selection.settings)?)}),
        )
    }

    pub fn rollback(&self, target: &Path, backup: &Path) -> Result<Value> {
        let _lock = self.lock()?;
        self.recover_package_transaction()?;
        let config = self.configuration()?;
        let selection = selected(&config, target)?;
        let (package, _, hash) = store::package(&selection.path)?;
        if selection.enabled
            || hash != selection.sha256
            || selection.capabilities != package.capabilities
            || !package
                .capabilities
                .iter()
                .any(|capability| capability == "store")
        {
            return Err(failure(
                "rollback_requires_disabled_trusted_store_capability",
            ));
        }
        let backup = backup.canonicalize()?;
        if backup.parent() != Some(self.root.as_path()) {
            return Err(failure("rollback_backup_must_be_in_store"));
        }
        let state_name = ModStore::state_name(&package.id, &selection.scope);
        let prefix = format!("{state_name}-backup-");
        let backup_name = backup
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| failure("rollback_backup_does_not_match_package_scope"))?;
        let Some(expected_digest) = backup_name.strip_prefix(&prefix) else {
            return Err(failure("rollback_backup_does_not_match_package_scope"));
        };
        let restored: Value =
            serde_json::from_slice(&store::read(&backup, store::STATE_LIMIT as u64)?)?;
        if digest(&serde_json::to_vec(&restored)?) != expected_digest {
            return Err(failure("rollback_backup_digest_mismatch"));
        }
        let restored_version = restored["version"]
            .as_u64()
            .ok_or_else(|| failure("invalid_state_version"))?;
        if restored["schema"] != MOD_STATE_STORAGE_SCHEMA_VERSION {
            return Err(failure("incompatible_state_storage_schema"));
        }
        let current_path = self.root.join(&state_name);
        let current: Value =
            serde_json::from_slice(&store::read(&current_path, store::STATE_LIMIT as u64)?)?;
        if current["schema"] != MOD_STATE_STORAGE_SCHEMA_VERSION
            || current["version"].as_u64().is_none()
        {
            return Err(failure("incompatible_current_state"));
        }
        let recovery = format!(
            "{state_name}-rollback-{}",
            digest(&serde_json::to_vec(&current)?)
        );
        self.write(&recovery, &current)?;
        self.write(&state_name, &restored)?;
        Ok(
            json!({"id":package.id,"from":current["version"],"to":restored_version,
            "restored":backup,"recovery":self.root.join(recovery),"source_sha256":hash,
            "settings_sha256":digest(&serde_json::to_vec(&selection.settings)?)}),
        )
    }
}

/// The selection for a package folder or, given a bare name, the one selected copy with that mod id.
fn selected<'a>(config: &'a ModConfiguration, target: &Path) -> Result<&'a ModSelection> {
    let id = (target.components().count() == 1 && target.is_relative())
        .then(|| target.to_str())
        .flatten();
    let mut matches = config.mods.iter().filter(|selection| match id {
        Some(id) => store::package(&selection.path).is_ok_and(|(package, _, _)| package.id == id),
        None => selection.path == target,
    });
    match (matches.next(), matches.next()) {
        (Some(selection), None) => Ok(selection),
        (Some(_), Some(_)) => Err(failure(
            "mod_ambiguous: more than one selected copy has this id; pass its package folder",
        )),
        _ => Err(failure("package_not_trusted")),
    }
}

/// Whether a state read failed on thread or checkout state stored at another version that the mod can migrate; store-scope state migrates only through `ModStore::migrate`.
pub(super) fn migratable(
    loaded: &Loaded,
    location: &store::StateLocation,
    error: &io::Error,
) -> bool {
    matches!(location, store::StateLocation::Directory(..))
        && error.to_string().starts_with("state_migration_required")
        && loaded.package.capabilities.iter().any(|c| c == "store")
        && loaded.registrations.events.iter().any(|e| e == "migrate")
}

pub(super) fn migrate_state(
    loaded: &Loaded,
    location: &store::StateLocation,
    active: &dyn Fn() -> bool,
) -> Result<Value> {
    let store::StateLocation::Directory(directory, name) = location else {
        return Err(failure(
            "state_migration_required: previous state preserved",
        ));
    };
    store::migrate_directory_state(
        directory,
        name,
        loaded.package.state_version,
        |from, value| {
            let mut previous = loaded.clone();
            previous.state = value;
            previous.registrations = migration_registrations(&previous)?;
            run_migration(&previous, from, active)
        },
    )
}

pub(super) fn detached(
    package: ModPackage,
    source: String,
    assets: BTreeMap<String, String>,
    selection: ModSelection,
    state: Value,
) -> Loaded {
    Loaded {
        package,
        source: source.into(),
        assets: Arc::new(store::asset_map(assets)),
        request_metadata: Arc::new(OnceLock::new()),
        selection,
        adapter: None,
        state,
        ui: None,
        ui_state: Value::Null,
        ui_revision: 0,
        ui_clears: 0,
        command_view: None,
        registrations: Registrations::default(),
        source_use: ModSourceUse::default(),
        unused_grants: Vec::new(),
        unused_environment: Vec::new(),
        withheld: Vec::new(),
        error: None,
        telemetry: ModTelemetry::default(),
    }
}

pub(super) fn migration_registrations(loaded: &Loaded) -> Result<Registrations> {
    let inspected = ModHost::run(loaded, "inspect", "", Value::Null, &|| true)?;
    ModHost::validate_registrations(&loaded.package, &inspected.registrations)?;
    if inspected.state != loaded.state
        || !inspected
            .registrations
            .events
            .iter()
            .any(|e| e == "migrate")
    {
        return Err(failure("explicit_migration_handler_required"));
    }
    Ok(inspected.registrations)
}

fn run_migration(loaded: &Loaded, from: u64, active: &dyn Fn() -> bool) -> Result<Value> {
    let to = loaded.package.state_version;
    let reply = ModHost::run(loaded, "migrate", "", json!({"from":from,"to":to}), active)?;
    if reply.registrations != loaded.registrations {
        return Err(failure("migration_changed_registration"));
    }
    Ok(reply.state)
}
