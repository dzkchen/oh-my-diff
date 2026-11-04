use super::*;

#[derive(Clone, Debug, Default)]
pub struct ConfigurationOverrides {
    revision: u64,
    entries: BTreeMap<String, Override>,
}

#[derive(Clone, Debug, Default)]
struct Override {
    enabled: Option<bool>,
    settings: BTreeMap<String, Value>,
}

impl ConfigurationOverrides {
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn set_enabled(&mut self, selection: &ModSelection, enabled: bool) -> Result<()> {
        Self::writable(selection)?;
        if selection.required {
            return Err(failure("configuration_override_forbidden"));
        }
        self.bump()?;
        self.entries.entry(Self::key(selection)).or_default().enabled = Some(enabled);
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
        let current: BTreeSet<_> = selections.iter().map(Self::key).collect();
        if self.entries.keys().any(|key| !current.contains(key)) {
            self.bump()?;
            self.entries.retain(|key, _| current.contains(key));
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
        store::grant(&json!(selection))
    }

    fn writable(selection: &ModSelection) -> Result<()> {
        if selection.scope == MANAGED_SCOPE || !selection.authority_current() {
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
    fn settings_validate_atomically_and_null_differs_from_reset() {
        let saved = selection();
        let package: ModPackage = serde_json::from_value(json!({
            "schema": 1, "id": "example", "version": "1.0.0", "api": "1.0.0",
            "state_version": 1, "capabilities": [],
            "settings_schema": {"type": "object", "additionalProperties": false,
                "properties": {"color": {"type": "string", "default": "blue"}}}
        })).unwrap();
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
