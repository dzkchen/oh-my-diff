use super::*;

impl ModStore {
    pub fn settings(&self, path: &Path, settings: BTreeMap<String, Value>) -> Result<()> {
        let _lock = self.lock()?;
        let mut config = self.configuration()?;
        let selection = config
            .mods
            .iter_mut()
            .find(|m| m.path == path)
            .ok_or_else(|| failure("package_not_trusted"))?;
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
            || !package.capabilities.iter().any(|c| c == "state")
        {
            return Err(failure(
                "migration_requires_disabled_trusted_state_capability",
            ));
        }
        let name = ModStore::state_name(&package.id, &selection.scope);
        let previous: Value =
            serde_json::from_slice(&store::read(&self.root.join(&name), 65_536)?)?;
        let from = previous["version"]
            .as_u64()
            .ok_or_else(|| failure("invalid_state_version"))?;
        if previous["schema"] != 1 || from == u64::from(package.state_version) {
            return Err(failure("migration_requires_different_state_version"));
        }
        let to = package.state_version;
        let mut loaded = Loaded {
            package,
            source,
            selection: selection.clone(),
            state: previous["value"].clone(),
            registrations: Registrations::default(),
            source_use: ModSourceUse::default(),
            unused_grants: Vec::new(),
            unused_environment: Vec::new(),
            error: None,
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
        let backup = format!(
            "state-{}-backup-{}.json",
            loaded.package.id,
            digest(&serde_json::to_vec(&previous)?)
        );
        self.write(&backup, &previous)?;
        self.write(&name, &json!({"schema":1,"version":to,"value":reply.state}))?;
        Ok(json!({"id":loaded.package.id,"from":from,"to":to,"backup":self.root.join(backup)}))
    }
}
