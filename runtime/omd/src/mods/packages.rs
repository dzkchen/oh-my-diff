use super::*;

impl ModStore {
    pub fn settings(&self, path: &Path, settings: BTreeMap<String, Value>) -> Result<()> {
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
        validate_settings(&package, &settings)?;
        selection.settings = settings;
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        self.write("mods.json", &serde_json::to_value(config)?)
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

    pub fn migrate(&self, path: &Path) -> Result<Value> {
        let _lock = self.lock()?;
        self.recover_package_transaction()?;
        let config = self.configuration()?;
        let selection = config
            .mods
            .iter()
            .find(|m| m.path == path)
            .ok_or_else(|| failure("package_not_trusted"))?;
        let (package, source, hash) = store::package(path)?;
        if selection.enabled
            || hash != selection.sha256
            || selection.capabilities != package.capabilities
            || !package.capabilities.iter().any(|c| c == "store")
        {
            return Err(failure(
                "migration_requires_disabled_trusted_store_capability",
            ));
        }
        let name = ModStore::state_name(&package.id, &selection.scope);
        let previous: Value =
            serde_json::from_slice(&store::read(&self.root.join(&name), 65_536)?)?;
        let from = previous["version"]
            .as_u64()
            .ok_or_else(|| failure("invalid_state_version"))?;
        if previous["schema"] != MOD_STATE_STORAGE_SCHEMA_VERSION
            || from == u64::from(package.state_version)
        {
            return Err(failure("migration_requires_different_state_version"));
        }
        let to = package.state_version;
        let mut loaded = Loaded {
            package,
            source,
            assets: BTreeMap::new(),
            selection: selection.clone(),
            adapter: None,
            state: previous["value"].clone(),
            registrations: Registrations::default(),
            source_use: ModSourceUse::default(),
            unused_grants: Vec::new(),
            unused_environment: Vec::new(),
            error: None,
            telemetry: ModTelemetry::default(),
        };
        let inspected = ModHost::run(&config.node, &loaded, "inspect", "", Value::Null, &|| true)?;
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
        loaded.registrations = inspected.registrations.clone();
        let reply = ModHost::run(
            &config.node,
            &loaded,
            "migrate",
            "",
            json!({"from":from,"to":to}),
            &|| true,
        )?;
        if reply.registrations != inspected.registrations {
            return Err(failure("migration_changed_registration"));
        }
        let state_name = ModStore::state_name(&loaded.package.id, &selection.scope);
        let backup = format!(
            "{}-backup-{}",
            state_name,
            digest(&serde_json::to_vec(&previous)?)
        );
        self.write(&backup, &previous)?;
        self.write(
            &name,
            &json!({"schema":MOD_STATE_STORAGE_SCHEMA_VERSION,"version":to,"value":reply.state}),
        )?;
        Ok(
            json!({"id":loaded.package.id,"from":from,"to":to,"backup":self.root.join(backup),
            "source_sha256":hash,"settings_sha256":digest(&serde_json::to_vec(&selection.settings)?)}),
        )
    }

    pub fn rollback(&self, path: &Path, backup: &Path) -> Result<Value> {
        let _lock = self.lock()?;
        self.recover_package_transaction()?;
        let config = self.configuration()?;
        let selection = config
            .mods
            .iter()
            .find(|selection| selection.path == path)
            .ok_or_else(|| failure("package_not_trusted"))?;
        let (package, _, hash) = store::package(path)?;
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
        let restored: Value = serde_json::from_slice(&store::read(&backup, 65_536)?)?;
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
        let current: Value = serde_json::from_slice(&store::read(&current_path, 65_536)?)?;
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
