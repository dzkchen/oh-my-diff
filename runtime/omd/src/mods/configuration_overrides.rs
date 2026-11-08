use super::*;

#[derive(Clone, Debug, Default)]
pub struct ConfigurationOverrides {
    revision: u64,
    entries: BTreeMap<String, Override>,
}

#[derive(Clone, Debug, Default)]
struct Override {
    source: Option<(PathBuf, String)>,
    enabled: Option<bool>,
    settings: BTreeMap<String, Value>,
}

impl ConfigurationOverrides {
    pub fn values(
        &self,
        selection: &ModSelection,
        package: &ModPackage,
        inherited: &BTreeMap<String, Value>,
    ) -> Value {
        let Some(entry) = self
            .entries
            .get(&Self::key(selection))
            .filter(|_| Self::writable(selection).is_ok())
        else {
            return json!({"settings": {}});
        };
        let settings = Self::resolve_settings(entry, package, inherited).unwrap_or_default();
        let base = effective_settings(package.settings_schema.as_ref(), inherited);
        let mut value = json!({"settings": entry
            .settings
            .iter()
            .filter(|(name, _)| settings.get(*name) != base.get(*name))
            .collect::<BTreeMap<_, _>>()});
        if let Some(enabled) = entry
            .enabled
            .filter(|enabled| !selection.required && *enabled != selection.enabled)
        {
            value["enabled"] = json!(enabled);
        }
        value
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn set_enabled(&mut self, selection: &ModSelection, enabled: bool) -> Result<()> {
        Self::writable(selection)?;
        if selection.required {
            return Err(failure("configuration_override_forbidden"));
        }
        let key = Self::key(selection);
        let mut entry = self.entries.get(&key).cloned().unwrap_or_default();
        entry.source = Some((selection.path.clone(), selection.sha256.clone()));
        entry.enabled = (enabled != selection.enabled).then_some(enabled);
        self.bump()?;
        self.put(key, entry);
        Ok(())
    }

    pub fn clear(
        &mut self,
        selection: &ModSelection,
        enabled: bool,
        settings: &[String],
    ) -> Result<()> {
        let key = Self::key(selection);
        let Some(current) = self.entries.get(&key) else {
            return Ok(());
        };
        let mut entry = current.clone();
        if enabled {
            entry.enabled = None;
        }
        entry.settings.retain(|name, _| !settings.contains(name));
        if entry.enabled == current.enabled && entry.settings == current.settings {
            return Ok(());
        }
        self.bump()?;
        self.put(key, entry);
        Ok(())
    }

    fn put(&mut self, key: String, entry: Override) {
        if entry.enabled.is_none() && entry.settings.is_empty() {
            self.entries.remove(&key);
        } else {
            self.entries.insert(key, entry);
        }
    }

    pub fn write_settings(
        &mut self,
        selection: &ModSelection,
        package: &ModPackage,
        inherited: &BTreeMap<String, Value>,
        values: &serde_json::Map<String, Value>,
    ) -> Result<BTreeMap<String, Value>> {
        Self::writable(selection)?;
        let key = Self::key(selection);
        let mut entry = self.entries.get(&key).cloned().unwrap_or_default();
        entry.source = Some((selection.path.clone(), selection.sha256.clone()));
        entry.settings.extend(values.clone());
        let settings = Self::resolve_settings(&entry, package, inherited)?;
        let base = effective_settings(package.settings_schema.as_ref(), inherited);
        entry
            .settings
            .retain(|name, _| settings.get(name) != base.get(name));
        self.bump()?;
        self.put(key, entry);
        Ok(settings)
    }

    pub fn reset(&mut self, selection: &ModSelection) -> Result<()> {
        self.bump()?;
        self.entries.remove(&Self::key(selection));
        Ok(())
    }

    pub fn reset_setting(&mut self, selection: &ModSelection, name: &str) -> Result<()> {
        self.clear(selection, false, &[name.to_owned()])
    }

    pub fn enabled(&self, selection: &ModSelection) -> bool {
        if selection.required || Self::writable(selection).is_err() {
            return selection.enabled;
        }
        self.entries
            .get(&Self::key(selection))
            .and_then(|entry| entry.enabled)
            .unwrap_or(selection.enabled)
    }

    pub fn settings(
        &self,
        selection: &ModSelection,
        package: &ModPackage,
        inherited: &BTreeMap<String, Value>,
    ) -> Result<BTreeMap<String, Value>> {
        match self.entries.get(&Self::key(selection)) {
            Some(entry) if Self::writable(selection).is_ok() => {
                Self::resolve_settings(entry, package, inherited)
            }
            _ => Ok(effective_settings(
                package.settings_schema.as_ref(),
                inherited,
            )),
        }
    }

    pub fn retain(&mut self, selections: &[ModSelection]) -> Result<()> {
        let current: BTreeSet<_> = selections
            .iter()
            .filter(|selection| Self::writable(selection).is_ok())
            .map(Self::key)
            .collect();
        if self.entries.keys().any(|key| !current.contains(key)) {
            self.bump()?;
            self.entries.retain(|key, _| current.contains(key));
        }
        Ok(())
    }

    pub(super) fn retain_unblocked(&mut self, store: &ModStore) -> Result<()> {
        let lock = store.read_package_lock()?;
        let blocked: BTreeSet<_> = lock
            .packages
            .values()
            .filter(|package| {
                lock.blocked_reason(&package.id, &package.version, &package.integrity)
                    .is_some()
            })
            .map(|package| &package.path)
            .collect();
        if self.entries.values().any(|entry| {
            entry
                .source
                .as_ref()
                .is_some_and(|(path, _)| blocked.contains(path))
        }) {
            self.bump()?;
            self.entries.retain(|_, entry| {
                !entry
                    .source
                    .as_ref()
                    .is_some_and(|(path, _)| blocked.contains(path))
            });
        }
        Ok(())
    }

    pub(super) fn sources_current(&self) -> bool {
        self.entries.values().all(|entry| {
            entry.source.as_ref().is_none_or(|(path, sha256)| {
                store::verified(path).is_ok_and(|package| &package.sha256 == sha256)
            })
        })
    }

    pub(super) fn retain_sources(&mut self) -> Result<()> {
        let invalid: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, entry)| {
                entry.source.as_ref().is_some_and(|(path, sha256)| {
                    !store::verified(path).is_ok_and(|package| &package.sha256 == sha256)
                })
            })
            .map(|(key, _)| key.clone())
            .collect();
        if !invalid.is_empty() {
            self.bump()?;
            for key in invalid {
                self.entries.remove(&key);
            }
        }
        Ok(())
    }

    fn resolve_settings(
        entry: &Override,
        package: &ModPackage,
        inherited: &BTreeMap<String, Value>,
    ) -> Result<BTreeMap<String, Value>> {
        let mut settings = declared_settings(package.settings_schema.as_ref(), inherited);
        for (name, value) in &entry.settings {
            if value.is_null() {
                settings.remove(name);
            } else {
                settings.insert(name.clone(), value.clone());
            }
        }
        validate_settings(package, &settings)?;
        Ok(effective_settings(
            package.settings_schema.as_ref(),
            &settings,
        ))
    }

    fn key(selection: &ModSelection) -> String {
        format!(
            "{}:{}",
            selection.configuration_epoch,
            store::grant(&json!(selection))
        )
    }

    fn writable(selection: &ModSelection) -> Result<()> {
        if selection.scope == MANAGED_SCOPE {
            return Err(failure("configuration_override_forbidden"));
        }
        if !selection.authority_current() {
            return Err(failure("grant_expired: trust the package again"));
        }
        Ok(())
    }

    fn bump(&mut self) -> Result<()> {
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selection() -> ModSelection {
        serde_json::from_value(json!({
            "path": "/example/package", "sha256": "trusted", "enabled": true,
            "capabilities": [], "scope": "user"
        }))
        .unwrap()
    }

    #[test]
    fn legacy_epoch_preserves_security_grant_and_defaults_writes_keep_binding() {
        let mut saved = selection();
        assert_eq!(saved.configuration_epoch, 0);
        assert!(json!(saved).get("configuration_epoch").is_none());
        let grant = store::grant(&json!(saved));
        let mut owner = ConfigurationOverrides::default();
        owner.set_enabled(&saved, false).unwrap();
        saved.settings.insert("value".into(), json!(1));
        saved.enabled = false;
        owner.set_enabled(&saved, true).unwrap();
        assert!(owner.enabled(&saved));
        saved.configuration_epoch = 1;
        assert_eq!(store::grant(&json!(saved)), grant);
        assert!(!owner.enabled(&saved));
        owner.retain(&[saved.clone()]).unwrap();
        let package: ModPackage = serde_json::from_value(json!({
            "schema": 1, "id": "example", "version": "1.0.0", "api": "1.0.0",
            "state_version": 1, "capabilities": []
        }))
        .unwrap();
        assert_eq!(
            owner.values(&saved, &package, &BTreeMap::new()),
            json!({"settings":{}})
        );
    }

    #[test]
    fn independent_owners_inherit_current_defaults_after_reset() {
        let mut saved = selection();
        let mut a = ConfigurationOverrides::default();
        let b = ConfigurationOverrides::default();
        let grant = store::grant(&json!(saved));
        a.set_enabled(&saved, false).unwrap();
        assert!(!a.enabled(&saved));
        assert!(b.enabled(&saved));
        assert!(saved.enabled);
        assert_eq!(grant, store::grant(&json!(saved)));
        saved.enabled = false;
        a.set_enabled(&saved, true).unwrap();
        assert!(a.enabled(&saved));
        assert!(!b.enabled(&saved));
        a.reset(&saved).unwrap();
        assert!(!a.enabled(&saved));
        assert!(!ConfigurationOverrides::default().enabled(&saved));
    }

    #[test]
    fn authority_changes_and_removal_discard_bindings() {
        let mut saved = selection();
        let mut overrides = ConfigurationOverrides::default();
        overrides.set_enabled(&saved, false).unwrap();
        saved.sha256 = "replacement".into();
        assert!(overrides.enabled(&saved));
        overrides.retain(&[saved.clone()]).unwrap();
        saved.sha256 = "trusted".into();
        assert!(overrides.enabled(&saved));
        overrides.set_enabled(&saved, false).unwrap();
        overrides.retain(&[]).unwrap();
        assert!(overrides.enabled(&saved));
    }

    #[test]
    fn required_managed_and_expired_selections_are_authoritative() {
        for change in ["required", "managed", "expired"] {
            let mut saved = selection();
            let mut overrides = ConfigurationOverrides::default();
            overrides.set_enabled(&saved, false).unwrap();
            match change {
                "required" => saved.required = true,
                "managed" => saved.scope = MANAGED_SCOPE.into(),
                _ => saved.expires_at = Some(0),
            }
            let error = overrides
                .set_enabled(&saved, false)
                .unwrap_err()
                .to_string();
            assert_eq!(
                error.starts_with("grant_expired"),
                change == "expired",
                "{error}"
            );
            assert!(overrides.enabled(&saved));
        }
    }

    #[test]
    fn authoritative_restrictions_discard_previous_overrides() {
        for change in ["managed", "expired"] {
            let saved = selection();
            let mut overrides = ConfigurationOverrides::default();
            overrides.set_enabled(&saved, false).unwrap();
            let mut restricted = saved.clone();
            match change {
                "managed" => restricted.scope = MANAGED_SCOPE.into(),
                _ => restricted.expires_at = Some(0),
            }
            overrides.retain(&[restricted]).unwrap();
            assert!(overrides.enabled(&saved), "{change}");
        }
    }

    #[test]
    fn overrides_equal_to_inherited_values_are_dropped() {
        let saved = selection();
        let package: ModPackage = serde_json::from_value(json!({
            "schema": 1, "id": "example", "version": "1.0.0", "api": "1.0.0",
            "state_version": 1, "capabilities": [],
            "settings_schema": {"type": "object",
                "properties": {"color": {"type": "string", "default": "blue"}}}
        }))
        .unwrap();
        let inherited = BTreeMap::from([("color".into(), json!("red"))]);
        let mut owner = ConfigurationOverrides::default();
        owner.set_enabled(&saved, false).unwrap();
        owner.set_enabled(&saved, true).unwrap();
        owner
            .write_settings(
                &saved,
                &package,
                &inherited,
                json!({"color":"green"}).as_object().unwrap(),
            )
            .unwrap();
        owner
            .write_settings(
                &saved,
                &package,
                &inherited,
                json!({"color":"red"}).as_object().unwrap(),
            )
            .unwrap();
        assert_eq!(
            owner.values(&saved, &package, &inherited),
            json!({"settings":{}})
        );
    }

    #[test]
    fn overrides_matching_a_changed_inherited_value_read_as_inherited() {
        let saved = selection();
        let package: ModPackage = serde_json::from_value(json!({
            "schema": 1, "id": "example", "version": "1.0.0", "api": "1.0.0",
            "state_version": 1, "capabilities": [],
            "settings_schema": {"type": "object",
                "properties": {"color": {"type": "string", "default": "blue"}}}
        }))
        .unwrap();
        let mut owner = ConfigurationOverrides::default();
        owner
            .write_settings(
                &saved,
                &package,
                &BTreeMap::from([("color".into(), json!("red"))]),
                json!({"color":"green"}).as_object().unwrap(),
            )
            .unwrap();
        owner.set_enabled(&saved, false).unwrap();
        let mut shared = saved.clone();
        shared.enabled = false;
        let inherited: BTreeMap<String, Value> = BTreeMap::from([("color".into(), json!("green"))]);
        assert_eq!(
            owner.values(&shared, &package, &inherited),
            json!({"settings":{}})
        );
    }

    #[test]
    fn settings_validate_atomically_and_null_differs_from_reset() {
        let saved = selection();
        let package: ModPackage = serde_json::from_value(json!({
            "schema": 1, "id": "example", "version": "1.0.0", "api": "1.0.0",
            "state_version": 1, "capabilities": [],
            "settings_schema": {"type": "object", "additionalProperties": false,
                "properties": {"color": {"type": "string", "default": "blue"}}}
        }))
        .unwrap();
        let mut required = saved.clone();
        required.required = true;
        let mut owner = ConfigurationOverrides::default();
        owner
            .write_settings(
                &required,
                &package,
                &BTreeMap::new(),
                json!({"color":"green"}).as_object().unwrap(),
            )
            .unwrap();
        assert_eq!(
            owner
                .settings(&required, &package, &BTreeMap::new())
                .unwrap()["color"],
            "green"
        );
        assert!(owner.set_enabled(&required, false).is_err());
        let inherited =
            BTreeMap::from([("color".into(), json!("red")), ("removed".into(), json!(1))]);
        let mut overrides = ConfigurationOverrides::default();
        let values = json!({"color": "green"});
        overrides
            .write_settings(&saved, &package, &inherited, values.as_object().unwrap())
            .unwrap();
        let revision = overrides.revision();
        let bad = json!({"color": 42});
        assert!(
            overrides
                .write_settings(&saved, &package, &inherited, bad.as_object().unwrap())
                .is_err()
        );
        assert_eq!(overrides.revision(), revision);
        let unknown = json!({"removed": 2});
        assert!(
            overrides
                .write_settings(&saved, &package, &inherited, unknown.as_object().unwrap())
                .is_err()
        );
        assert_eq!(overrides.revision(), revision);
        assert_eq!(
            overrides.settings(&saved, &package, &inherited).unwrap()["color"],
            "green"
        );
        let null = json!({"color": null});
        assert_eq!(
            overrides
                .write_settings(&saved, &package, &inherited, null.as_object().unwrap())
                .unwrap()["color"],
            "blue"
        );
        overrides.reset_setting(&saved, "color").unwrap();
        assert_eq!(
            overrides.settings(&saved, &package, &inherited).unwrap()["color"],
            "red"
        );
        assert_eq!(inherited["color"], "red");
    }
}

struct ConfigurationContext {
    status: Value,
    config: ModConfiguration,
    lock: ModPackageLock,
}

fn settings_diff(before: &Value, after: &Value) -> Vec<Value> {
    let empty = serde_json::Map::new();
    let before = before.as_object().unwrap_or(&empty);
    let after = after.as_object().unwrap_or(&empty);
    before
        .keys()
        .chain(after.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|key| before.get(*key) != after.get(*key))
        .map(|key| json!({"key":key,"before":before.get(key),"after":after.get(key)}))
        .collect()
}

impl ModHost {
    fn configuration_context(&self) -> Result<ConfigurationContext> {
        Ok(ConfigurationContext {
            status: self.store.selection_status_in(self.project.as_deref())?,
            config: self.store.configuration()?,
            lock: self.store.read_package_lock()?,
        })
    }

    fn configuration_selection_in(
        &self,
        id: &str,
        scope: Option<&str>,
    ) -> Result<(ModSelection, ModPackage)> {
        let context = self.configuration_context()?;
        Self::select_configuration(&context, &self.current_overrides(), id, scope)
    }

    fn select_configuration(
        context: &ConfigurationContext,
        owner: &ConfigurationOverrides,
        id: &str,
        scope: Option<&str>,
    ) -> Result<(ModSelection, ModPackage)> {
        let rows = || {
            context.status["selections"]
                .as_array()
                .into_iter()
                .flatten()
        };
        if rows()
            .any(|row| row["id"] == id && row["scope"] == MANAGED_SCOPE && row["error"].is_null())
        {
            return Err(failure("configuration_override_forbidden"));
        }
        let candidates: Vec<_> = context
            .config
            .mods
            .iter()
            .filter(|item| scope.is_none_or(|scope| item.scope == scope))
            .filter(|item| {
                rows().any(|row| {
                    row["id"] == id
                        && row["path"] == json!(item.path)
                        && row["scope"] == item.scope
                        && row["error"].is_null()
                })
            })
            .collect();
        let candidates = if scope.is_none() {
            let enabled: Vec<_> = candidates
                .iter()
                .copied()
                .filter(|selection| owner.enabled(selection))
                .collect();
            if enabled.is_empty() {
                candidates
            } else {
                enabled
            }
        } else {
            candidates
        };
        let ranked = precedence(
            &candidates
                .iter()
                .map(|item| (id, *item))
                .collect::<Vec<_>>(),
        );
        let selection = candidates
            .into_iter()
            .zip(ranked)
            .find(|(_, loss)| loss.is_none())
            .map(|(item, _)| item.clone())
            .ok_or_else(|| failure(format!("mod_not_selected: {id}")))?;
        if let Some(package) = context
            .lock
            .packages
            .values()
            .find(|package| package.path == selection.path)
            && let Some(reason) =
                context
                    .lock
                    .blocked_reason(&package.id, &package.version, &package.integrity)
        {
            return Err(failure(format!("package_blocked: {reason}")));
        }
        let (package, hash) = store::verified_package(&selection.path)?;
        if hash != selection.sha256 {
            return Err(failure("source_changed"));
        }
        Ok((selection, package))
    }

    fn inherited_settings(
        &self,
        selection: &ModSelection,
        package: &ModPackage,
    ) -> BTreeMap<String, Value> {
        let mut inherited = selection.settings.clone();
        inherited.extend(self.store.settings_file(package, selection).1);
        inherited
    }

    pub fn write_configuration(
        &mut self,
        id: &str,
        values: &Value,
        target: &str,
        reset: &[String],
    ) -> Result<Value> {
        self.write_configuration_in(id, values, target, reset, None)
    }

    pub fn write_configuration_in(
        &mut self,
        id: &str,
        values: &Value,
        target: &str,
        reset: &[String],
        scope: Option<&str>,
    ) -> Result<Value> {
        if scope.is_some_and(|scope| !matches!(scope, "user" | "project")) {
            return Err(failure("configuration_scope_invalid"));
        }
        if target == "shared" {
            if !reset.is_empty() {
                return Err(failure("configuration_reset_requires_terminal"));
            }
            let values = values
                .as_object()
                .ok_or_else(|| failure("settings_values_must_be_object"))?;
            let (selection, package) = self.configuration_selection_in(id, scope)?;
            let settings =
                self.store
                    .save_configuration(&selection.path, values, None, None, "settings")?;
            let result = json!({"settings": effective_settings(package.settings_schema.as_ref(), &settings)});
            let written: Vec<String> = values.keys().cloned().collect();
            self.configuration_overrides
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clear(&selection, false, &written)?;
            return Ok(result);
        }
        if target != "terminal" {
            return Err(failure("configuration_target_invalid"));
        }
        let values = values
            .as_object()
            .ok_or_else(|| failure("settings_values_must_be_object"))?;
        let (selection, package) = self.configuration_selection_in(id, scope)?;
        ConfigurationOverrides::writable(&selection)?;
        let inherited = self.inherited_settings(&selection, &package);
        let mut owner = self
            .configuration_overrides
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mut next = owner.clone();
        for key in reset {
            next.reset_setting(&selection, key)?;
        }
        let settings = next.write_settings(&selection, &package, &inherited, values)?;
        *owner = next;
        Ok(json!({"settings": settings}))
    }

    pub fn preview_configuration(
        &self,
        arguments: Value,
    ) -> Result<crate::package_controls::PackagePreview> {
        let mut preview = crate::package_controls::preview(&self.store, arguments)?;
        if preview.control.target == "shared"
            || !matches!(
                preview.control.action.as_str(),
                "enable" | "disable" | "reset" | "save-defaults"
            )
        {
            return Ok(preview);
        }
        let (selection, package) =
            self.configuration_selection_in(&preview.control.id, Some(&preview.control.scope))?;
        ConfigurationOverrides::writable(&selection)?;
        let action = preview.control.action.clone();
        if selection.required && matches!(action.as_str(), "enable" | "disable") {
            return Err(failure("configuration_override_forbidden"));
        }
        if action == "enable" {
            let owner = self.current_overrides();
            self.store
                .admit_enable(&package, &selection, &|other| owner.enabled(other))?;
        }
        let inherited = self.inherited_settings(&selection, &package);
        let schema = package.settings_schema.as_ref();
        let shared = json!(effective_settings(schema, &inherited));
        let owner = self
            .configuration_overrides
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let current = (
            owner.enabled(&selection),
            json!(owner.settings(&selection, &package, &inherited)?),
        );
        let overrides = owner.values(&selection, &package, &inherited);
        let (before, after) = match action.as_str() {
            "enable" | "disable" => {
                let after = (action == "enable", current.1.clone());
                (current, after)
            }
            "reset" => (current, (selection.enabled, shared.clone())),
            _ => (
                (selection.enabled, shared.clone()),
                (
                    overrides["enabled"].as_bool().unwrap_or(selection.enabled),
                    current.1,
                ),
            ),
        };
        preview.public["changes"] = json!({
            "target": if action == "save-defaults" {"shared"} else {"terminal"},
            "enabled": (before.0 != after.0).then(|| json!({"before":before.0,"after":after.0})),
            "settings": settings_diff(&before.1, &after.1),
        });
        preview.control.owner_revision = Some((
            Arc::as_ptr(&self.configuration_overrides) as usize,
            owner.revision(),
            json!({"enabled":selection.enabled,"settings":shared}),
        ));
        Ok(preview)
    }

    pub fn apply_configuration(
        &mut self,
        control: &crate::package_controls::PackageControl,
    ) -> Result<Value> {
        if !["enable", "disable", "reset", "save-defaults"].contains(&control.action.as_str())
            || control.target == "shared"
        {
            let toggled = matches!(control.action.as_str(), "enable" | "disable")
                .then(|| {
                    self.configuration_selection_in(&control.id, Some(&control.scope))
                        .ok()
                })
                .flatten();
            let result = crate::package_controls::apply(&self.store, control)?;
            if let Some((selection, _)) = toggled {
                self.configuration_overrides
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .clear(&selection, true, &[])?;
            }
            return Ok(result);
        }
        crate::package_controls::validate_generation(&self.store, control)?;
        let (selection, package) =
            self.configuration_selection_in(&control.id, Some(&control.scope))?;
        ConfigurationOverrides::writable(&selection)?;
        if control.action == "enable" {
            let owner = self.current_overrides();
            self.store
                .admit_enable(&package, &selection, &|other| owner.enabled(other))?;
        }
        let inherited = self.inherited_settings(&selection, &package);
        let mut owner = self
            .configuration_overrides
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let reviewed = (
            Arc::as_ptr(&self.configuration_overrides) as usize,
            owner.revision(),
            json!({"enabled":selection.enabled,"settings":effective_settings(package.settings_schema.as_ref(), &inherited)}),
        );
        if control.owner_revision.as_ref() != Some(&reviewed) {
            return Err(failure("terminal_configuration_changed: preview again"));
        }
        match control.action.as_str() {
            "enable" | "disable" => owner.set_enabled(&selection, control.action == "enable")?,
            "reset" => owner.reset(&selection)?,
            _ => {
                let overrides = owner.values(&selection, &package, &inherited);
                self.store.save_configuration(
                    &selection.path,
                    overrides["settings"]
                        .as_object()
                        .unwrap_or(&serde_json::Map::new()),
                    overrides["enabled"].as_bool(),
                    Some(control.generation()),
                    &control.action,
                )?;
                owner.reset(&selection)?;
            }
        }
        Ok(json!({"status":"applied", "generation":self.store.configuration()?.revision}))
    }

    pub fn configuration_listing(&self, mut listed: Value) -> Result<Value> {
        let context = self.configuration_context()?;
        let owner = self.current_overrides();
        for row in listed["packages"].as_array_mut().into_iter().flatten() {
            row["inherited_enabled"] = row["enabled"].clone();
            row["inherited_settings"] = row["settings"].clone();
            row["overrides"] = json!({"settings":{}});
            let Some(id) = row["id"].as_str() else {
                continue;
            };
            let Ok((selection, package)) =
                Self::select_configuration(&context, &owner, id, row["scope"].as_str())
            else {
                continue;
            };
            if row["scope"] != selection.scope
                || row
                    .get("path")
                    .is_some_and(|path| *path != json!(selection.path))
            {
                continue;
            }
            let enabled = owner.enabled(&selection);
            let running = self
                .loaded
                .get(id)
                .is_some_and(|loaded| loaded.selection.path == selection.path);
            if enabled != selection.enabled && row.get("pending").is_some() {
                row["pending"] = json!((enabled != running).then_some("reload"));
            }
            let inherited = self.inherited_settings(&selection, &package);
            row["inherited_enabled"] = json!(selection.enabled);
            row["inherited_settings"] = json!(effective_settings(
                package.settings_schema.as_ref(),
                &inherited
            ));
            row["overrides"] = owner.values(&selection, &package, &inherited);
            row["enabled"] = json!(enabled);
            row["settings"] = json!(owner.settings(&selection, &package, &inherited)?);
        }
        Ok(listed)
    }
}

pub fn terminal_configuration_owner(token: &str) -> Arc<Mutex<ConfigurationOverrides>> {
    static OWNERS: std::sync::OnceLock<
        Mutex<BTreeMap<String, std::sync::Weak<Mutex<ConfigurationOverrides>>>>,
    > = std::sync::OnceLock::new();
    let mut owners = OWNERS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    owners.retain(|_, owner| owner.strong_count() > 0);
    if let Some(owner) = owners.get(token).and_then(std::sync::Weak::upgrade) {
        return owner;
    }
    let owner = Arc::new(Mutex::new(ConfigurationOverrides::default()));
    owners.insert(token.into(), Arc::downgrade(&owner));
    owner
}

#[allow(clippy::too_many_arguments)]
pub fn write_settings_shared(
    runtime: &Mutex<ModHost>,
    id: &str,
    values: &Value,
    target: &str,
    reset: &[String],
    scope: Option<&str>,
    caller: &str,
    thread: Option<&str>,
    active: &dyn Fn() -> bool,
    mut host: impl FnMut(&str, ModHostCall) -> Result<Value>,
) -> Result<Value> {
    let _thread = crate::StateThread::enter(thread.map(str::to_owned));
    match target {
        "terminal" => {}
        "shared" if reset.is_empty() => {}
        "shared" => return Err(failure("configuration_reset_requires_terminal")),
        _ => return Err(failure("configuration_target_invalid")),
    }
    let mut values = values
        .as_object()
        .ok_or_else(|| failure("settings_values_must_be_object"))?
        .clone();
    let (before, inherited, selected_scope, binding) = {
        let mut runtime = runtime
            .lock()
            .map_err(|_| failure("mod_runtime_poisoned"))?;
        runtime.refresh(&|| true)?;
        let (selection, package) = runtime.configuration_selection_in(id, scope)?;
        if target == "terminal" {
            ConfigurationOverrides::writable(&selection)?;
        }
        let inherited = runtime.inherited_settings(&selection, &package);
        let before = runtime
            .current_overrides()
            .settings(&selection, &package, &inherited)?;
        (
            before,
            effective_settings(package.settings_schema.as_ref(), &inherited),
            selection.scope.clone(),
            ConfigurationOverrides::key(&selection),
        )
    };
    let mut resets = reset.to_vec();
    let names: BTreeSet<String> = values
        .keys()
        .cloned()
        .chain(reset.iter().cloned())
        .collect();
    for name in &names {
        let resetting = !values.contains_key(name) && resets.contains(name);
        let proposed = values
            .get(name)
            .cloned()
            .unwrap_or_else(|| inherited.get(name).cloned().unwrap_or(Value::Null));
        let result = continue_operation(
            runtime,
            "config_set",
            json!({"key":format!("mods.{id}.{name}"),"value":proposed,"original":before.get(name),"source":"mod_settings","scope":"mod"}),
            json!({"caller":caller,"thread_id":thread}),
            active,
            &mut host,
            |effective| Ok(json!({"value":effective["value"]})),
        )?;
        if !resetting || result["value"] != proposed {
            values.insert(name.clone(), result["value"].clone());
            resets.retain(|key| key != name);
        }
    }
    let result = {
        let mut runtime = runtime
            .lock()
            .map_err(|_| failure("mod_runtime_poisoned"))?;
        if !active() {
            return Err(failure("callback_cancelled"));
        }
        let (selection, _) = runtime.configuration_selection_in(id, Some(&selected_scope))?;
        if ConfigurationOverrides::key(&selection) != binding {
            return Err(failure("callback_authority_changed"));
        }
        runtime.write_configuration_in(
            id,
            &Value::Object(values),
            target,
            &resets,
            Some(&selected_scope),
        )?
    };
    let (generation, listeners) = {
        let runtime = runtime
            .lock()
            .map_err(|_| failure("mod_runtime_poisoned"))?;
        (
            runtime.generation(),
            runtime
                .owners()
                .into_iter()
                .map(|(id, _)| id)
                .filter(|id| id != caller && runtime.registered(id, "config_change"))
                .collect::<Vec<_>>(),
        )
    };
    for name in names {
        let payload = json!({"key":format!("mods.{id}.{name}"),"original":before.get(&name),"effective":result["settings"][&name],"source":"mod_settings","scope":"mod","caller":caller});
        for listener in &listeners {
            let _ = invoke_shared(
                runtime,
                listener,
                generation,
                "config_change",
                "",
                payload.clone(),
                super::ModInvokeOptions {
                    active,
                    host: super::ModHostCallback::Scoped(&mut host),
                    ..super::ModInvokeOptions::default()
                },
            );
        }
    }
    Ok(result)
}
