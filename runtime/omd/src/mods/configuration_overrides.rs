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
    pub fn values(&self, selection: &ModSelection) -> Value {
        self.entries.get(&Self::key(selection)).map(|entry| {
            let mut value = json!({"settings": entry.settings});
            if let Some(enabled) = entry.enabled { value["enabled"] = json!(enabled); }
            value
        }).unwrap_or_else(|| json!({"settings": {}}))
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn set_enabled(&mut self, selection: &ModSelection, enabled: bool) -> Result<()> {
        Self::writable(selection)?;
        self.bump()?;
        let entry = self.entries.entry(Self::key(selection)).or_default();
        entry.source = Some((selection.path.clone(), selection.sha256.clone()));
        entry.enabled = Some(enabled);
        Ok(())
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
        self.bump()?;
        self.entries.insert(key, entry);
        Ok(settings)
    }

    pub fn reset(&mut self, selection: &ModSelection) -> Result<()> {
        self.bump()?;
        self.entries.remove(&Self::key(selection));
        Ok(())
    }

    pub fn reset_setting(&mut self, selection: &ModSelection, name: &str) -> Result<()> {
        self.bump()?;
        if let Some(entry) = self.entries.get_mut(&Self::key(selection)) {
            entry.settings.remove(name);
        }
        Ok(())
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
            _ => Ok(effective_settings(package.settings_schema.as_ref(), inherited)),
        }
    }

    pub fn retain(&mut self, selections: &[ModSelection]) -> Result<()> {
        let current: BTreeSet<_> = selections.iter()
            .filter(|selection| !selection.required && Self::writable(selection).is_ok())
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
        let blocked: BTreeSet<_> = lock.packages.values().filter(|package| lock.blocked_reason(&package.id, &package.version, &package.integrity).is_some()).map(|package| &package.path).collect();
        if self.entries.values().any(|entry| entry.source.as_ref().is_some_and(|(path, _)| blocked.contains(path))) {
            self.bump()?;
            self.entries.retain(|_, entry| !entry.source.as_ref().is_some_and(|(path, _)| blocked.contains(path)));
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
        let invalid: Vec<_> = self.entries.iter().filter(|(_, entry)| {
            entry.source.as_ref().is_some_and(|(path, sha256)| {
                !store::verified(path).is_ok_and(|package| &package.sha256 == sha256)
            })
        }).map(|(key, _)| key.clone()).collect();
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
        Ok(effective_settings(package.settings_schema.as_ref(), &settings))
    }

    fn key(selection: &ModSelection) -> String {
        format!("{}:{}", selection.configuration_epoch, store::grant(&json!(selection)))
    }

    fn writable(selection: &ModSelection) -> Result<()> {
        if selection.required || selection.scope == MANAGED_SCOPE || !selection.authority_current() {
            return Err(failure("configuration_override_forbidden"));
        }
        Ok(())
    }

    fn bump(&mut self) -> Result<()> {
        self.revision = self.revision.checked_add(1).ok_or_else(|| failure("revision_overflow"))?;
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
        })).unwrap()
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
        assert_eq!(owner.values(&saved), json!({"settings":{}}));
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
            assert!(overrides.set_enabled(&saved, false).is_err());
            assert!(overrides.enabled(&saved));
        }
    }

    #[test]
    fn authoritative_restrictions_discard_previous_overrides() {
        for change in ["required", "managed", "expired"] {
            let saved = selection();
            let mut overrides = ConfigurationOverrides::default();
            overrides.set_enabled(&saved, false).unwrap();
            let mut restricted = saved.clone();
            match change {
                "required" => restricted.required = true,
                "managed" => restricted.scope = MANAGED_SCOPE.into(),
                _ => restricted.expires_at = Some(0),
            }
            overrides.retain(&[restricted]).unwrap();
            assert!(overrides.enabled(&saved), "{change}");
        }
    }

    #[test]
    fn settings_validate_atomically_and_null_differs_from_reset() {
        let saved = selection();
        let package: ModPackage = serde_json::from_value(json!({
            "schema": 1, "id": "example", "version": "1.0.0", "api": "1.0.0",
            "state_version": 1, "capabilities": [],
            "settings_schema": {"type": "object", "additionalProperties": false,
                "properties": {"color": {"type": "string", "default": "blue"}}}
        })).unwrap();
        let mut required = saved.clone();
        required.required = true;
        let mut forbidden = ConfigurationOverrides::default();
        assert!(forbidden.write_settings(&required, &package, &BTreeMap::new(), json!({"color":"green"}).as_object().unwrap()).is_err());
        assert_eq!(forbidden.revision(), 0);
        let inherited = BTreeMap::from([
            ("color".into(), json!("red")),
            ("removed".into(), json!(1)),
        ]);
        let mut overrides = ConfigurationOverrides::default();
        let values = json!({"color": "green"});
        overrides.write_settings(&saved, &package, &inherited, values.as_object().unwrap()).unwrap();
        let revision = overrides.revision();
        let bad = json!({"color": 42});
        assert!(overrides.write_settings(&saved, &package, &inherited, bad.as_object().unwrap()).is_err());
        assert_eq!(overrides.revision(), revision);
        let unknown = json!({"removed": 2});
        assert!(overrides.write_settings(&saved, &package, &inherited, unknown.as_object().unwrap()).is_err());
        assert_eq!(overrides.revision(), revision);
        assert_eq!(overrides.settings(&saved, &package, &inherited).unwrap()["color"], "green");
        let null = json!({"color": null});
        assert_eq!(overrides.write_settings(&saved, &package, &inherited, null.as_object().unwrap()).unwrap()["color"], "blue");
        overrides.reset_setting(&saved, "color").unwrap();
        assert_eq!(overrides.settings(&saved, &package, &inherited).unwrap()["color"], "red");
        assert_eq!(inherited["color"], "red");
    }
}

impl ModHost {
    fn configuration_selection_in(&self, id: &str, scope: Option<&str>) -> Result<(ModSelection, ModPackage)> {
        let status = self.store.selection_status_in(self.project.as_deref())?;
        if status["selections"].as_array().into_iter().flatten().any(|row| row["id"] == id && row["scope"] == MANAGED_SCOPE && row["error"].is_null()) { return Err(failure("configuration_override_forbidden")); }
        let config = self.store.configuration()?;
        let candidates: Vec<_> = config.mods.iter().filter(|item| scope.is_none_or(|scope| item.scope == scope)).filter(|item| {
            status["selections"].as_array().into_iter().flatten().any(|row| {
                row["id"] == id && row["path"] == json!(item.path) && row["scope"] == item.scope && row["error"].is_null()
            })
        }).collect();
        let candidates = if scope.is_none() {
            let owner = self.configuration_overrides.lock().unwrap_or_else(PoisonError::into_inner);
            let enabled: Vec<_> = candidates.iter().copied().filter(|selection| owner.enabled(selection)).collect();
            if enabled.is_empty() { candidates } else { enabled }
        } else { candidates };
        let ranked = precedence(&candidates.iter().map(|item| (id, *item)).collect::<Vec<_>>());
        let selection = candidates.into_iter().zip(ranked).find(|(_, loss)| loss.is_none())
            .map(|(item, _)| item.clone()).ok_or_else(|| failure(format!("mod_not_selected: {id}")))?;
        let path = selection.path.clone();
        let lock = self.store.read_package_lock()?;
        if let Some(package) = lock.packages.values().find(|package| package.path == path)
            && let Some(reason) = lock.blocked_reason(&package.id, &package.version, &package.integrity) {
            return Err(failure(format!("package_blocked: {reason}")));
        }
        let (package, _, hash) = store::package(&path)?;
        if hash != selection.sha256 { return Err(failure("source_changed")); }
        Ok((selection, package))
    }

    pub fn write_configuration(&mut self, id: &str, values: &Value, target: &str, reset: &[String]) -> Result<Value> {
        self.write_configuration_in(id, values, target, reset, None)
    }

    pub fn write_configuration_in(&mut self, id: &str, values: &Value, target: &str, reset: &[String], scope: Option<&str>) -> Result<Value> {
        if scope.is_some_and(|scope| !matches!(scope, "user" | "project")) { return Err(failure("configuration_scope_invalid")); }
        if target == "shared" {
            if !reset.is_empty() { return Err(failure("configuration_reset_requires_terminal")); }
            let (selection, _) = self.configuration_selection_in(id, scope)?;
            return write_settings_in(&self.store, id, values, Some(&selection.scope));
        }
        if target != "terminal" { return Err(failure("configuration_target_invalid")); }
        let values = values.as_object().ok_or_else(|| failure("settings_values_must_be_object"))?;
        let (selection, package) = self.configuration_selection_in(id, scope)?;
        ConfigurationOverrides::writable(&selection)?;
        let mut inherited = selection.settings.clone();
        inherited.extend(self.store.settings_file(&package, &selection).1);
        let mut owner = self.configuration_overrides.lock().unwrap_or_else(PoisonError::into_inner);
        let mut next = owner.clone();
        for key in reset { next.reset_setting(&selection, key)?; }
        let settings = next.write_settings(&selection, &package, &inherited, values)?;
        *owner = next;
        Ok(json!({"settings": settings}))
    }

    pub fn preview_configuration(&self, arguments: Value) -> Result<crate::package_controls::PackagePreview> {
        let mut preview = crate::package_controls::preview(&self.store, arguments)?;
        if preview.control.target == "shared" || !matches!(preview.control.action.as_str(), "enable" | "disable" | "reset" | "save-defaults") { return Ok(preview); }
        let (selection, package) = self.configuration_selection_in(&preview.control.id, Some(&preview.control.scope))?;
        ConfigurationOverrides::writable(&selection)?;
        let mut inherited = selection.settings.clone();
        inherited.extend(self.store.settings_file(&package, &selection).1);
        let inherited = json!({"enabled":selection.enabled,"settings":effective_settings(package.settings_schema.as_ref(), &inherited)});
        let owner = self.configuration_overrides.lock().unwrap_or_else(PoisonError::into_inner);
        let values: BTreeMap<String, Value> = serde_json::from_value(inherited["settings"].clone())?;
        let before = json!({"enabled":owner.enabled(&selection),"settings":owner.settings(&selection, &package, &values)?});
        let mut after = before.clone();
        match preview.control.action.as_str() {
            "enable" | "disable" => after["enabled"] = json!(preview.control.action == "enable"),
            "reset" => after = inherited.clone(),
            _ => (),
        }
        preview.public["changes"] = json!({"enabled":after["enabled"],"settings":after["settings"],"before":before,"inherited":inherited,"target":if preview.control.action == "save-defaults" {"shared"} else {"terminal"}});
        preview.control.owner_revision = Some((Arc::as_ptr(&self.configuration_overrides) as usize, owner.revision(), inherited));
        Ok(preview)
    }

    pub fn apply_configuration(&mut self, control: &crate::package_controls::PackageControl) -> Result<Value> {
        if !["enable", "disable", "reset", "save-defaults"].contains(&control.action.as_str()) || control.target == "shared" {
            return crate::package_controls::apply(&self.store, control);
        }
        crate::package_controls::validate_generation(&self.store, control)?;
        let (selection, package) = self.configuration_selection_in(&control.id, Some(&control.scope))?;
        ConfigurationOverrides::writable(&selection)?;
        let mut owner = self.configuration_overrides.lock().unwrap_or_else(PoisonError::into_inner);
        let mut inherited = selection.settings.clone();
        inherited.extend(self.store.settings_file(&package, &selection).1);
        let reviewed = (Arc::as_ptr(&self.configuration_overrides) as usize, owner.revision(), json!({"enabled":selection.enabled,"settings":effective_settings(package.settings_schema.as_ref(), &inherited)}));
        if control.owner_revision.as_ref() != Some(&reviewed) { return Err(failure("terminal_configuration_changed: preview again")); }
        match control.action.as_str() {
            "enable" | "disable" => owner.set_enabled(&selection, control.action == "enable")?,
            "reset" => owner.reset(&selection)?,
            "save-defaults" => {
                let mut inherited = selection.settings.clone();
                inherited.extend(self.store.settings_file(&package, &selection).1);
                let settings = owner.settings(&selection, &package, &inherited)?;
                self.store.save_configuration(&selection.path, settings, owner.enabled(&selection))?;
                owner.reset(&selection)?;
            }
            _ => unreachable!(),
        }
        Ok(json!({"status":"applied", "generation":self.store.configuration()?.revision}))
    }

    pub fn configuration_listing(&self, mut listed: Value) -> Result<Value> {
        let owner = self.configuration_overrides.lock().unwrap_or_else(PoisonError::into_inner);
        for row in listed["packages"].as_array_mut().into_iter().flatten() {
            row["inherited_enabled"] = row["enabled"].clone();
            row["inherited_settings"] = row["settings"].clone();
            row["overrides"] = json!({"settings":{}});
            let Some(id) = row["id"].as_str() else { continue; };
            let Ok((selection, package)) = self.configuration_selection_in(id, row["scope"].as_str()) else { continue; };
            if row["scope"] != selection.scope || row.get("path").is_some_and(|path| *path != json!(selection.path)) { continue; }
            let mut inherited = selection.settings.clone();
            inherited.extend(self.store.settings_file(&package, &selection).1);
            row["inherited_enabled"] = json!(selection.enabled);
            row["inherited_settings"] = json!(effective_settings(package.settings_schema.as_ref(), &inherited));
            row["overrides"] = owner.values(&selection);
            row["enabled"] = json!(owner.enabled(&selection));
            row["settings"] = json!(owner.settings(&selection, &package, &inherited)?);
        }
        Ok(listed)
    }
}

pub fn terminal_configuration_owner(token: &str) -> Arc<Mutex<ConfigurationOverrides>> {
    static OWNERS: std::sync::OnceLock<Mutex<BTreeMap<String, std::sync::Weak<Mutex<ConfigurationOverrides>>>>> = std::sync::OnceLock::new();
    let mut owners = OWNERS.get_or_init(Mutex::default).lock().unwrap_or_else(PoisonError::into_inner);
    owners.retain(|_, owner| owner.strong_count() > 0);
    if let Some(owner) = owners.get(token).and_then(std::sync::Weak::upgrade) { return owner; }
    let owner = Arc::new(Mutex::new(ConfigurationOverrides::default()));
    owners.insert(token.into(), Arc::downgrade(&owner));
    owner
}
