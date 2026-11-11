use super::*;

pub const SETTINGS_FILE_EXTENSIONS: [&str; 3] = ["json", "yaml", "yml"];

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SettingsFile {
    pub path: String,
    pub status: &'static str,
    pub error: Option<String>,
}

impl ModStore {
    pub fn save_configuration(
        &self,
        path: &Path,
        values: &serde_json::Map<String, Value>,
        enabled: Option<bool>,
        revision: Option<u64>,
        action: &str,
    ) -> Result<BTreeMap<String, Value>> {
        let _lock = self.transaction()?;
        let mut config = self.configuration()?;
        if revision.is_some_and(|revision| revision != config.revision) {
            return Err(failure("package_state_changed: preview again"));
        }
        let index = config
            .mods
            .iter()
            .position(|item| item.path == path)
            .ok_or_else(|| failure("package_not_trusted"))?;
        let selection = config.mods[index].clone();
        if selection.scope == MANAGED_SCOPE || enabled.is_some() && selection.required {
            return Err(failure("configuration_override_forbidden"));
        }
        if !selection.authority_current() {
            return Err(failure("grant_expired: trust the package again"));
        }
        let (package, hash) = store::verified_package(path)?;
        if hash != selection.sha256 {
            return Err(failure("source_changed: inspect and trust the new digest"));
        }
        let (file, file_values) = self.settings_file(&package, &selection);
        if let Some(error) = file.error {
            return Err(failure(format!("settings_file_invalid: {error}")));
        }
        let mut saved = declared_settings(package.settings_schema.as_ref(), &selection.settings);
        let mut from_file = file_values.clone();
        for (name, value) in values {
            if value.is_null() {
                from_file.remove(name);
                saved.remove(name);
            } else if file_values.contains_key(name) {
                from_file.insert(name.clone(), value.clone());
            } else {
                saved.insert(name.clone(), value.clone());
            }
        }
        let mut merged = saved.clone();
        merged.extend(from_file.clone());
        validate_settings(&package, &merged)?;
        let file_write = (from_file != file_values)
            .then(|| edited_settings_file(Path::new(&file.path), &file_values, &from_file))
            .transpose()?;
        let mut lock = self.read_package_lock()?;
        let installed = lock
            .packages
            .values()
            .find(|item| item.path == path)
            .map(|item| item.id.clone());
        let lock_changed = enabled.is_some() && installed.is_some();
        if enabled == Some(true) {
            self.admit_enable(&package, &selection, &|selection| selection.enabled)?;
        }
        if let (Some(enabled), Some(id)) = (enabled, &installed) {
            let item = &lock.packages[id];
            if item.integrity != hash || item.state_version != package.state_version {
                return Err(failure("package_state_changed"));
            }
            if enabled && let Some(reason) = lock.blocked_reason(id, &item.version, &item.integrity)
            {
                return Err(failure(format!("package_blocked: {reason}")));
            }
            if let Some(item) = lock.packages.get_mut(id) {
                item.enabled = enabled;
            }
            package_manager::validate_locked_graph(&lock.packages)?;
            store::next_revision(&mut lock.revision)?;
        }
        config.mods[index].settings = saved;
        config.mods[index].enabled = enabled.unwrap_or(selection.enabled);
        if config.mods[index].settings == selection.settings
            && config.mods[index].enabled == selection.enabled
            && file_write.is_none()
        {
            return Ok(merged);
        }
        store::next_revision(&mut config.revision)?;
        if lock_changed || file_write.is_some() {
            self.commit_configuration_transaction(
                lock,
                config,
                &[],
                action,
                json!({"mod":package.id}),
                &[],
                file_write
                    .as_ref()
                    .map(|(name, bytes)| (name.as_str(), bytes.as_slice())),
            )?;
        } else {
            self.write("mods.json", &serde_json::to_value(config)?)?;
        }
        Ok(merged)
    }

    pub(super) fn admit_enable(
        &self,
        package: &ModPackage,
        selection: &ModSelection,
        enabled: &dyn Fn(&ModSelection) -> bool,
    ) -> Result<()> {
        if package
            .capabilities
            .iter()
            .any(|capability| !selection.capabilities.contains(capability))
        {
            return Err(failure("capability_denied: trust the package again"));
        }
        self.check_service_providers(package, &selection.path, enabled)?;
        store::refuse_second_copy(
            &self.configuration()?,
            &selection.path,
            &selection.scope,
            &package.id,
            enabled,
        )
    }

    pub fn settings_file(
        &self,
        package: &ModPackage,
        selection: &ModSelection,
    ) -> (SettingsFile, BTreeMap<String, Value>) {
        let path = |extension: &str| {
            self.root
                .join("settings")
                .join(format!("{}.{extension}", package.id))
        };
        let present: Vec<PathBuf> = SETTINGS_FILE_EXTENSIONS
            .iter()
            .map(|extension| path(extension))
            .filter(|path| std::fs::symlink_metadata(path).is_ok())
            .collect();
        let chosen = present.first().cloned().unwrap_or_else(|| path("json"));
        let mut file = SettingsFile {
            path: chosen.to_string_lossy().into_owned(),
            status: "missing",
            error: None,
        };
        if present.is_empty() {
            return (file, BTreeMap::new());
        }
        if selection.scope == MANAGED_SCOPE {
            file.status = "ignored";
            return (file, BTreeMap::new());
        }
        let values = (|| {
            if present.len() > 1 {
                return Err(failure("more_than_one_settings_file"));
            }
            let bytes = store::read(&chosen, 65_536)?;
            let parsed: Value = match chosen.extension().and_then(|name| name.to_str()) {
                Some("json") => serde_json::from_slice(&bytes).map_err(failure)?,
                _ => serde_yaml::from_slice(&bytes).map_err(failure)?,
            };
            let Value::Object(object) = parsed else {
                return Err(failure("settings_file_must_be_object"));
            };
            let values: BTreeMap<String, Value> = object.into_iter().collect();
            let mut merged =
                declared_settings(package.settings_schema.as_ref(), &selection.settings);
            merged.extend(values.clone());
            validate_settings(package, &merged)?;
            Ok(values)
        })();
        match values {
            Ok(values) => {
                file.status = "loaded";
                (file, values)
            }
            Err(error) => {
                file.status = "invalid";
                file.error = Some(error.to_string());
                (file, BTreeMap::new())
            }
        }
    }

    pub fn settings(&self, path: &Path, settings: BTreeMap<String, Value>) -> Result<()> {
        self.update_settings(path, |current| *current = settings)
            .map(drop)
    }

    fn update_settings(
        &self,
        path: &Path,
        change: impl FnOnce(&mut BTreeMap<String, Value>),
    ) -> Result<BTreeMap<String, Value>> {
        let _lock = self.transaction()?;
        let mut config = self.configuration()?;
        let selection = config
            .mods
            .iter_mut()
            .find(|m| m.path == path)
            .ok_or_else(|| failure("package_not_trusted"))?;
        let (package, _, hash) = store::package(path)?;
        if hash != selection.sha256 {
            return Err(failure(format!(
                "source_changed: {}: review it again with omd mods update {}",
                package.id, package.id
            )));
        }
        let mut settings = declared_settings(package.settings_schema.as_ref(), &selection.settings);
        change(&mut settings);
        validate_settings(&package, &settings)?;
        if settings == selection.settings {
            return Ok(settings);
        }
        selection.settings = settings.clone();
        store::next_revision(&mut config.revision)?;
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
        let _lock = self.transaction()?;
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
        let backup = format!(
            "{name}-backup-{}",
            crate::sha256_hex(&serde_json::to_vec(&previous)?)
        );
        self.write(&backup, &previous)?;
        self.write(
            &name,
            &json!({"schema":MOD_STATE_STORAGE_SCHEMA_VERSION,"version":to,"value":state}),
        )?;
        Ok(
            json!({"id":loaded.package.id,"from":from,"to":to,"backup":self.root.join(backup),
            "source_sha256":hash,"settings_sha256":crate::sha256_hex(&serde_json::to_vec(&selection.settings)?)}),
        )
    }

    pub fn rollback(&self, target: &Path, backup: &Path) -> Result<Value> {
        let _lock = self.transaction()?;
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
        if crate::sha256_hex(&serde_json::to_vec(&restored)?) != expected_digest {
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
            crate::sha256_hex(&serde_json::to_vec(&current)?)
        );
        self.write(&recovery, &current)?;
        self.write(&state_name, &restored)?;
        Ok(
            json!({"id":package.id,"from":current["version"],"to":restored_version,
            "restored":backup,"recovery":self.root.join(recovery),"source_sha256":hash,
            "settings_sha256":crate::sha256_hex(&serde_json::to_vec(&selection.settings)?)}),
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
        package: Arc::new(package),
        source: source.into(),
        assets: Arc::new(store::asset_map(assets)),
        request_metadata: Arc::new(OnceLock::new()),
        session_key: None,
        code_cache: None,
        selection: Arc::new(selection),
        adapter: None,
        state,
        state_revision: 0,
        registered_state: std::sync::Arc::default(),
        ui: None,
        ui_state: Value::Null,
        ui_revision: 0,
        ui_clears: 0,
        command_view: None,
        registrations: Registered::default(),
        source_use: Arc::default(),
        unused_grants: Vec::new(),
        unused_environment: Vec::new(),
        withheld: Vec::new(),
        settings_file: SettingsFile {
            path: String::new(),
            status: "missing",
            error: None,
        },
        error: None,
        telemetry: ModTelemetry::default(),
    }
}

pub(super) fn migration_registrations(loaded: &Loaded) -> Result<Registered> {
    let inspected = ModHost::run(loaded, "inspect", "", Value::Null, &|| true)?;
    let registrations = inspected
        .registrations
        .ok_or_else(|| failure("registrations_missing"))?;
    ModHost::validate_registrations(&loaded.package, &registrations)?;
    if inspected.state != loaded.state || !registrations.events.iter().any(|e| e == "migrate") {
        return Err(failure("explicit_migration_handler_required"));
    }
    Registered::new(registrations)
}

fn run_migration(loaded: &Loaded, from: u64, active: &dyn Fn() -> bool) -> Result<Value> {
    let to = loaded.package.state_version;
    Ok(ModHost::run(loaded, "migrate", "", json!({"from":from,"to":to}), active)?.state)
}

fn edited_settings_file(
    path: &Path,
    before: &BTreeMap<String, Value>,
    after: &BTreeMap<String, Value>,
) -> Result<(String, Vec<u8>)> {
    let name = format!(
        "settings/{}",
        path.file_name()
            .ok_or_else(|| failure("settings_file_invalid"))?
            .to_string_lossy()
    );
    let json = path
        .extension()
        .is_some_and(|extension| extension == "json");
    let bytes = store::read(path, 65_536)?;
    if parsed_settings(&bytes, json).as_ref() != Some(before) {
        return Err(failure("settings_file_changed: try again"));
    }
    let edited = std::str::from_utf8(&bytes).ok().and_then(|text| {
        let mut text = text.to_owned();
        for key in before.keys().filter(|key| !after.contains_key(*key)) {
            text = removed_entry(&text, key, json)?;
        }
        for (key, value) in after {
            if before.get(key) != Some(value) {
                text = edited_entry(&text, key, value, json)?;
            }
        }
        (parsed_settings(text.as_bytes(), json).as_ref() == Some(after)).then(|| text.into_bytes())
    });
    let bytes = match edited {
        Some(bytes) => bytes,
        None if json => {
            let mut bytes = serde_json::to_vec_pretty(after)?;
            bytes.push(b'\n');
            bytes
        }
        None if !bytes.contains(&b'#') => {
            serde_yaml::to_string(after).map_err(failure)?.into_bytes()
        }
        None => {
            return Err(failure(format!(
                "settings_file_not_editable: changing this would drop the comments in {}; change it there",
                path.display()
            )));
        }
    };
    Ok((name, bytes))
}

fn parsed_settings(bytes: &[u8], json: bool) -> Option<BTreeMap<String, Value>> {
    let value: Value = if json {
        serde_json::from_slice(bytes).ok()?
    } else {
        serde_yaml::from_slice(bytes).ok()?
    };
    serde_json::from_value(value).ok()
}

fn edited_entry(text: &str, key: &str, value: &Value, json: bool) -> Option<String> {
    let span = if json {
        json_value_span(text, key)?
    } else {
        yaml_value_span(text, key)?
    };
    let quoted = serde_json::to_string(value).ok()?;
    let candidates = match (json, value.as_str(), text.as_bytes()[span.start]) {
        (false, Some(string), b'\'') => vec![format!("'{}'", string.replace('\'', "''"))],
        (false, Some(string), first) if first != b'"' => vec![string.to_owned(), quoted],
        _ => vec![quoted],
    };
    candidates.into_iter().find_map(|candidate| {
        let edited = format!("{}{candidate}{}", &text[..span.start], &text[span.end..]);
        parsed_settings(edited.as_bytes(), json)
            .is_some_and(|parsed| parsed.get(key) == Some(value))
            .then_some(edited)
    })
}

fn removed_entry(text: &str, key: &str, json: bool) -> Option<String> {
    let bytes = text.as_bytes();
    let range = if json {
        let (key_start, value) = json_entry_span(text, key)?;
        let mut start = key_start;
        while start > 0 && matches!(bytes[start - 1], b' ' | b'\t') {
            start -= 1;
        }
        let mut next = value.end;
        while bytes.get(next).is_some_and(u8::is_ascii_whitespace) {
            next += 1;
        }
        if bytes.get(next) == Some(&b',') {
            next += 1;
            while bytes
                .get(next)
                .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
            {
                next += 1;
            }
            if bytes.get(next) == Some(&b'\n') {
                next += 1;
            }
            start..next
        } else {
            let comma = bytes[..key_start]
                .iter()
                .rposition(|byte| !byte.is_ascii_whitespace())
                .filter(|index| bytes[*index] == b',');
            comma.unwrap_or(key_start)..value.end
        }
    } else {
        let value = yaml_value_span(text, key)?;
        let start = text[..value.start].rfind('\n').map_or(0, |index| index + 1);
        let end = text[value.end..]
            .find('\n')
            .map_or(text.len(), |index| value.end + index + 1);
        start..end
    };
    Some(format!("{}{}", &text[..range.start], &text[range.end..]))
}

fn quoted_end(bytes: &[u8], start: usize) -> Option<usize> {
    let quote = bytes[start];
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' if quote == b'"' => index += 2,
            b'\'' if quote == b'\'' && bytes.get(index + 1) == Some(&b'\'') => index += 2,
            byte if byte == quote => return Some(index + 1),
            _ => index += 1,
        }
    }
    None
}

fn json_value_span(text: &str, key: &str) -> Option<std::ops::Range<usize>> {
    json_entry_span(text, key).map(|(_, value)| value)
}

fn json_entry_span(text: &str, key: &str) -> Option<(usize, std::ops::Range<usize>)> {
    let bytes = text.as_bytes();
    let skip = |mut index: usize| {
        while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
            index += 1;
        }
        index
    };
    let (mut depth, mut expect_key, mut index) = (0usize, false, 0);
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                let end = quoted_end(bytes, index)?;
                if depth == 1 && expect_key {
                    let name: String = serde_json::from_str(&text[index..end]).ok()?;
                    let colon = skip(end);
                    (bytes.get(colon) == Some(&b':')).then_some(())?;
                    let start = skip(colon + 1);
                    if name == key {
                        let end = match bytes.get(start)? {
                            b'"' => quoted_end(bytes, start)?,
                            b'{' | b'[' => return None,
                            _ => {
                                start
                                    + bytes[start..]
                                        .iter()
                                        .position(|byte| {
                                            matches!(byte, b',' | b'}')
                                                || byte.is_ascii_whitespace()
                                        })
                                        .unwrap_or(bytes.len() - start)
                            }
                        };
                        return Some((index, start..end));
                    }
                    expect_key = false;
                    index = start;
                    continue;
                }
                index = end;
                continue;
            }
            b'{' => {
                depth += 1;
                expect_key = depth == 1;
            }
            b'[' => depth += 1,
            b'}' | b']' => depth = depth.checked_sub(1)?,
            b',' => expect_key = depth == 1,
            _ => {}
        }
        index += 1;
    }
    None
}

fn yaml_value_span(text: &str, key: &str) -> Option<std::ops::Range<usize>> {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let mut offset = 0;
    for (index, line) in lines.iter().enumerate() {
        let start = offset;
        offset += line.len();
        let content = line.trim_end_matches(['\n', '\r']);
        if content.is_empty()
            || content.starts_with([' ', '\t', '#', '-', '.', '%', '?', '{', '[', '&', '*', '!'])
        {
            continue;
        }
        let bytes = content.as_bytes();
        let key_end = if matches!(bytes[0], b'"' | b'\'') {
            quoted_end(bytes, 0)
        } else {
            content
                .match_indices(':')
                .map(|(end, _)| end)
                .find(|end| matches!(bytes.get(end + 1), None | Some(b' ' | b'\t')))
        };
        let Some(key_end) = key_end else {
            continue;
        };
        if bytes.get(key_end) != Some(&b':') {
            continue;
        }
        let Ok(name) = serde_yaml::from_str::<String>(&content[..key_end]) else {
            continue;
        };
        if name != key {
            continue;
        }
        let rest = &content[key_end + 1..];
        let value_start = key_end + 1 + (rest.len() - rest.trim_start().len());
        let value = &content[value_start..];
        if value.is_empty() || value.starts_with(['|', '>', '&', '*', '!', '{', '[', '#']) {
            return None;
        }
        if lines[index + 1..]
            .iter()
            .map(|line| line.trim_end_matches(['\n', '\r']))
            .find(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
            .is_some_and(|line| line.starts_with([' ', '\t']))
        {
            return None;
        }
        let value_end = match value.as_bytes()[0] {
            b'"' | b'\'' => value_start + quoted_end(value.as_bytes(), 0)?,
            _ => {
                value_start
                    + value
                        .find(" #")
                        .into_iter()
                        .chain(value.find("\t#"))
                        .min()
                        .unwrap_or(value.len())
            }
        };
        let value_end = value_start + content[value_start..value_end].trim_end().len();
        return Some(start + value_start..start + value_end);
    }
    None
}
