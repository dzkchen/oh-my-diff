use super::*;
use serde_json::Map;
use std::process::Command;

const PACKAGE_LOCK_SCHEMA: u32 = 1;
const PACKAGE_HISTORY_LIMIT: usize = 8;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ModPackageSource {
    Local {
        path: PathBuf,
    },
    Repository {
        repository: String,
        revision: String,
        #[serde(default)]
        subdirectory: String,
    },
    Package {
        index: PathBuf,
        id: String,
        version: String,
    },
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModPackageGrant {
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub dependencies: bool,
    #[serde(default)]
    pub lifecycle: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModPackageTrust {
    pub packages: BTreeMap<String, ModPackageGrant>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModInstallRequest {
    pub source: ModPackageSource,
    #[serde(default)]
    pub index: Option<PathBuf>,
    #[serde(default = "user_scope")]
    pub scope: String,
    #[serde(default)]
    pub activate: bool,
    #[serde(default)]
    pub offline: bool,
    #[serde(default)]
    pub trust: ModPackageTrust,
    #[serde(default)]
    pub settings: BTreeMap<String, BTreeMap<String, Value>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModLockedPackage {
    pub id: String,
    pub version: String,
    pub integrity: String,
    pub source: ModPackageSource,
    pub path: PathBuf,
    pub cache_path: PathBuf,
    pub license: String,
    pub provenance: ModProvenance,
    pub entrypoint: String,
    pub api: String,
    pub state_version: u32,
    pub dependencies: Vec<ModDependency>,
    pub capabilities: Vec<String>,
    pub settings_schema_sha256: String,
    pub lifecycle: Vec<String>,
    pub scope: String,
    pub enabled: bool,
    pub settings: BTreeMap<String, Value>,
    pub trust: ModPackageGrant,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModPackageLock {
    pub schema: u32,
    pub revision: u64,
    pub packages: BTreeMap<String, ModLockedPackage>,
    #[serde(default)]
    pub history: BTreeMap<String, Vec<ModLockedPackage>>,
}

impl Default for ModPackageLock {
    fn default() -> Self {
        Self {
            schema: PACKAGE_LOCK_SCHEMA,
            revision: 0,
            packages: BTreeMap::new(),
            history: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModPackagePlan {
    pub schema: u32,
    pub action: String,
    pub root: String,
    pub packages: Vec<ModLockedPackage>,
    pub changes: Value,
    pub confirmation: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PackageIndex {
    schema: u32,
    packages: BTreeMap<String, Vec<IndexRelease>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexRelease {
    version: String,
    source: ModPackageSource,
    integrity: String,
}

#[derive(Clone)]
struct ResolvedPackage {
    locked: ModLockedPackage,
    package: ModPackage,
}

impl ModStore {
    pub fn package_lock(&self) -> Result<ModPackageLock> {
        let _guard = self.lock()?;
        self.recover_package_transaction()?;
        self.read_package_lock()
    }

    pub(super) fn read_package_lock(&self) -> Result<ModPackageLock> {
        match store::read(&self.root.join("packages.lock.json"), 524_288) {
            Ok(bytes) => {
                let lock: ModPackageLock = serde_json::from_slice(&bytes)?;
                if lock.schema != PACKAGE_LOCK_SCHEMA {
                    return Err(failure("unsupported_package_lock_schema"));
                }
                validate_package_lock(&lock)?;
                Ok(lock)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(ModPackageLock::default()),
            Err(error) => Err(error),
        }
    }

    pub fn package_plan(&self, request: ModInstallRequest) -> Result<ModPackagePlan> {
        let _guard = self.lock()?;
        self.recover_package_transaction()?;
        self.package_plan_locked(request)
    }

    fn package_plan_locked(&self, request: ModInstallRequest) -> Result<ModPackagePlan> {
        if !MOD_SCOPES.contains(&request.scope.as_str()) {
            return Err(failure("unsupported_scope: user or project"));
        }
        let existing = self.read_package_lock()?;
        let mut resolved = BTreeMap::new();
        let mut visiting = Vec::new();
        let root = self.resolve_requested(
            &request.source,
            None,
            &request,
            &mut resolved,
            &mut visiting,
        )?;
        let root_id = root.package.id.clone();
        resolved.insert(root_id.clone(), root);
        let mut packages = resolved
            .into_values()
            .map(|mut resolved| {
                let previous = existing.packages.get(&resolved.package.id);
                let settings = request
                    .settings
                    .get(&resolved.package.id)
                    .cloned()
                    .or_else(|| previous.map(|locked| locked.settings.clone()))
                    .unwrap_or_default();
                validate_settings(&resolved.package, &settings)?;
                resolved.locked.settings = settings;
                let state_migration_required = previous.is_some_and(|locked| {
                    locked.state_version != resolved.package.state_version
                        && self
                            .root
                            .join(ModStore::state_name(&resolved.package.id, &request.scope))
                            .exists()
                });
                resolved.locked.enabled = request.activate && !state_migration_required;
                Ok(resolved.locked)
            })
            .collect::<Result<Vec<_>>>()?;
        packages.sort_by(|a, b| a.id.cmp(&b.id));
        let action = if existing.packages.contains_key(&root_id) {
            "update"
        } else {
            "install"
        };
        let changes = package_changes(&existing, &packages);
        let mut plan = ModPackagePlan {
            schema: PACKAGE_LOCK_SCHEMA,
            action: action.to_owned(),
            root: root_id,
            packages,
            changes,
            confirmation: String::new(),
        };
        plan.confirmation = digest(&serde_json::to_vec(&plan)?);
        Ok(plan)
    }

    pub fn package_apply(
        &self,
        request: ModInstallRequest,
        confirmation: &str,
    ) -> Result<ModPackageLock> {
        let _guard = self.lock()?;
        self.recover_package_transaction()?;
        let plan = self.package_plan_locked(request)?;
        if plan.confirmation != confirmation {
            return Err(failure("package_plan_changed: preview again"));
        }
        let mut lock = self.read_package_lock()?;
        let mut config = self.configuration()?;
        let mut selection_ids = config
            .mods
            .iter()
            .map(|selection| {
                store::package(&selection.path)
                    .ok()
                    .map(|(manifest, _, _)| manifest.id)
            })
            .collect::<Vec<_>>();
        let mut lifecycle = Vec::new();
        for package in &plan.packages {
            match lock.packages.get(&package.id) {
                None => lifecycle.push((package.clone(), "install")),
                Some(previous) if previous.integrity != package.integrity => {
                    lifecycle.push((package.clone(), "update"))
                }
                Some(_) => {}
            }
            if let Some(previous) = lock.packages.insert(package.id.clone(), package.clone())
                && previous.integrity != package.integrity
            {
                push_history(&mut lock, &package.id, previous)?;
            }
            let selection = config
                .mods
                .iter()
                .zip(&selection_ids)
                .position(|(selection, id)| {
                    selection.scope == package.scope && id.as_deref() == Some(package.id.as_str())
                });
            let next = ModSelection {
                path: package.path.clone(),
                sha256: package.integrity.clone(),
                enabled: package.enabled,
                capabilities: package.trust.capabilities.clone(),
                settings: package.settings.clone(),
                scope: package.scope.clone(),
            };
            if let Some(selection) = selection {
                config.mods[selection] = next;
            } else {
                config.mods.push(next);
                selection_ids.push(Some(package.id.clone()));
            }
        }
        validate_locked_graph(&lock.packages)?;
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        lock.revision = lock
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        self.commit_package_transaction(lock, config, &lifecycle)
    }

    pub fn package_uninstall_plan(&self, id: &str) -> Result<ModPackagePlan> {
        let _guard = self.lock()?;
        self.recover_package_transaction()?;
        self.package_uninstall_plan_locked(id)
    }

    fn package_uninstall_plan_locked(&self, id: &str) -> Result<ModPackagePlan> {
        let lock = self.read_package_lock()?;
        let package = lock
            .packages
            .get(id)
            .cloned()
            .ok_or_else(|| failure("package_not_installed"))?;
        if lock.packages.values().any(|candidate| {
            candidate.id != id
                && candidate
                    .dependencies
                    .iter()
                    .any(|dependency| dependency.id == id)
        }) {
            return Err(failure("package_has_installed_dependents"));
        }
        let mut plan = ModPackagePlan {
            schema: PACKAGE_LOCK_SCHEMA,
            action: "uninstall".into(),
            root: id.to_owned(),
            packages: vec![package.clone()],
            changes: json!({"removed":[{"id":id,"version":package.version,"integrity":package.integrity}],
                "cache_retained_for_offline_reuse":true,"state_retained":true,"local_source_untouched":true}),
            confirmation: String::new(),
        };
        plan.confirmation = digest(&serde_json::to_vec(&plan)?);
        Ok(plan)
    }

    pub fn package_disable(&self, id: &str) -> Result<ModPackageLock> {
        let _guard = self.lock()?;
        self.recover_package_transaction()?;
        let mut lock = self.read_package_lock()?;
        let package = lock
            .packages
            .get_mut(id)
            .ok_or_else(|| failure("package_not_installed"))?;
        package.enabled = false;
        let path = package.path.clone();
        let scope = package.scope.clone();
        lock.revision = lock
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        let mut config = self.configuration()?;
        let selection = config
            .mods
            .iter_mut()
            .find(|selection| selection.path == path && selection.scope == scope)
            .ok_or_else(|| failure("package_selection_missing"))?;
        selection.enabled = false;
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        self.commit_package_transaction(lock, config, &[])
    }

    pub fn package_enable(&self, id: &str) -> Result<ModPackageLock> {
        let _guard = self.lock()?;
        self.recover_package_transaction()?;
        let mut lock = self.read_package_lock()?;
        let package = lock
            .packages
            .get_mut(id)
            .ok_or_else(|| failure("package_not_installed"))?;
        let (manifest, _, integrity) = store::package(&package.path)?;
        if integrity != package.integrity || manifest.id != package.id {
            return Err(failure(
                "source_changed: inspect and preview the new package",
            ));
        }
        if package.state_version != manifest.state_version {
            return Err(failure(
                "state_migration_required: previous state preserved",
            ));
        }
        self.state(&package.id, &package.scope, package.state_version)?;
        package.enabled = true;
        let path = package.path.clone();
        let scope = package.scope.clone();
        lock.revision = lock
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        validate_locked_graph(&lock.packages)?;
        let mut config = self.configuration()?;
        let selection = config
            .mods
            .iter_mut()
            .find(|selection| selection.path == path && selection.scope == scope)
            .ok_or_else(|| failure("package_selection_missing"))?;
        if selection.sha256 != integrity {
            return Err(failure("source_changed: inspect and trust the new digest"));
        }
        if manifest
            .capabilities
            .iter()
            .any(|capability| !selection.capabilities.contains(capability))
        {
            return Err(failure("capability_denied"));
        }
        super::validate_settings(&manifest, &selection.settings)?;
        selection.enabled = true;
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        self.commit_package_transaction(lock, config, &[])
    }

    pub fn package_uninstall(&self, id: &str, confirmation: &str) -> Result<ModPackageLock> {
        let _guard = self.lock()?;
        self.recover_package_transaction()?;
        let plan = self.package_uninstall_plan_locked(id)?;
        if plan.confirmation != confirmation {
            return Err(failure("package_plan_changed: preview again"));
        }
        let mut lock = self.read_package_lock()?;
        let package = lock
            .packages
            .remove(id)
            .ok_or_else(|| failure("package_not_installed"))?;
        self.run_lifecycle(&package, "uninstall")?;
        push_history(&mut lock, id, package.clone())?;
        lock.revision = lock
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        let mut config = self.configuration()?;
        config.mods.retain(|selection| {
            !(selection.scope == package.scope
                && store::package(&selection.path).is_ok_and(|(manifest, _, _)| manifest.id == id))
        });
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        self.commit_package_transaction(lock, config, &[])
    }

    pub fn package_rollback_plan(&self, id: &str) -> Result<ModPackagePlan> {
        let _guard = self.lock()?;
        self.recover_package_transaction()?;
        self.package_rollback_plan_locked(id)
    }

    fn package_rollback_plan_locked(&self, id: &str) -> Result<ModPackagePlan> {
        let lock = self.read_package_lock()?;
        let current = lock
            .packages
            .get(id)
            .ok_or_else(|| failure("package_not_installed"))?;
        let previous = lock
            .history
            .get(id)
            .and_then(|history| history.last())
            .cloned()
            .ok_or_else(|| failure("package_rollback_unavailable"))?;
        let mut plan = ModPackagePlan {
            schema: PACKAGE_LOCK_SCHEMA,
            action: "rollback".into(),
            root: id.to_owned(),
            packages: vec![previous.clone()],
            changes: json!({"version":{"from":current.version,"to":previous.version},
                "integrity":{"from":current.integrity,"to":previous.integrity},
                "capabilities":{"from":current.capabilities,"to":previous.capabilities},
                "dependencies":{"from":current.dependencies,"to":previous.dependencies},
                "settings_preserved":current.settings}),
            confirmation: String::new(),
        };
        plan.confirmation = digest(&serde_json::to_vec(&plan)?);
        Ok(plan)
    }

    pub fn package_rollback(&self, id: &str, confirmation: &str) -> Result<ModPackageLock> {
        let _guard = self.lock()?;
        self.recover_package_transaction()?;
        let plan = self.package_rollback_plan_locked(id)?;
        if plan.confirmation != confirmation {
            return Err(failure("package_plan_changed: preview again"));
        }
        let mut lock = self.read_package_lock()?;
        let mut previous = plan.packages[0].clone();
        if store::package(&previous.cache_path)?.2 != previous.integrity {
            return Err(failure("cached_package_integrity_failure"));
        }
        let current = lock
            .packages
            .remove(id)
            .ok_or_else(|| failure("package_not_installed"))?;
        let current_path = current.path.clone();
        previous.path = previous.cache_path.clone();
        previous.settings = current.settings.clone();
        previous.enabled = false;
        validate_settings(&store::package(&previous.path)?.0, &previous.settings)?;
        let history = lock.history.entry(id.to_owned()).or_default();
        history.pop();
        history.push(current);
        lock.packages.insert(id.to_owned(), previous.clone());
        validate_locked_graph(&lock.packages)?;
        lock.revision = lock
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        let mut config = self.configuration()?;
        let selection = config
            .mods
            .iter_mut()
            .find(|selection| selection.scope == previous.scope && selection.path == current_path)
            .ok_or_else(|| failure("package_selection_missing"))?;
        *selection = ModSelection {
            path: previous.path,
            sha256: previous.integrity,
            enabled: false,
            capabilities: previous.trust.capabilities,
            settings: previous.settings,
            scope: previous.scope,
        };
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        self.commit_package_transaction(lock, config, &[])
    }

    /// Runs `lifecycle` scripts and restores the previous lock and configuration on failure.
    fn commit_package_transaction(
        &self,
        lock: ModPackageLock,
        config: ModConfiguration,
        lifecycle: &[(ModLockedPackage, &str)],
    ) -> Result<ModPackageLock> {
        let old_lock = serde_json::to_value(self.read_package_lock()?)?;
        let old_config = serde_json::to_value(self.configuration()?)?;
        self.write(
            "package-transaction.json",
            &json!({"old_lock":old_lock,"old_config":old_config}),
        )?;
        let result = (|| {
            for (package, event) in lifecycle {
                self.run_lifecycle(package, event)?;
            }
            self.write("mods.json", &serde_json::to_value(&config)?)?;
            self.write("packages.lock.json", &serde_json::to_value(&lock)?)?;
            std::fs::remove_file(self.root.join("package-transaction.json"))?;
            std::fs::File::open(&self.root)?.sync_all()?;
            Ok(lock)
        })();
        if result.is_err() {
            self.recover_package_transaction()?;
        }
        result
    }

    pub(super) fn recover_package_transaction(&self) -> Result<()> {
        let path = self.root.join("package-transaction.json");
        let bytes = match store::read(&path, 1_048_576) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let transaction: Value = serde_json::from_slice(&bytes)?;
        self.write("mods.json", &transaction["old_config"])?;
        self.write("packages.lock.json", &transaction["old_lock"])?;
        std::fs::remove_file(path)?;
        std::fs::File::open(&self.root)?.sync_all()
    }

    fn resolve_requested(
        &self,
        source: &ModPackageSource,
        requirement: Option<(&str, &str)>,
        request: &ModInstallRequest,
        resolved: &mut BTreeMap<String, ResolvedPackage>,
        visiting: &mut Vec<String>,
    ) -> Result<ResolvedPackage> {
        let (path, normalized_source, expected_integrity) =
            self.materialize_source(source, request.offline)?;
        let (package, _, integrity) = store::package(&path)?;
        if let Some(expected) = expected_integrity
            && expected != integrity
        {
            return Err(failure("package_integrity_failure"));
        }
        if let Some((id, version)) = requirement
            && (package.id != id || !service_version_satisfies(version, &package.version))
        {
            return Err(failure("resolved_dependency_identity_or_version_mismatch"));
        }
        if visiting.contains(&package.id) {
            visiting.push(package.id.clone());
            return Err(failure(format!(
                "dependency_cycle: {}",
                visiting.join(" -> ")
            )));
        }
        if let Some(existing) = resolved.get(&package.id) {
            if existing.locked.integrity == integrity {
                return Ok(existing.clone());
            }
            return Err(failure("dependency_resolution_conflict"));
        }
        visiting.push(package.id.clone());
        let license = package
            .license
            .clone()
            .ok_or_else(|| failure("managed_package_license_required"))?;
        let provenance = package
            .provenance
            .clone()
            .ok_or_else(|| failure("managed_package_provenance_required"))?;
        validate_provenance(&normalized_source, &provenance)?;
        let grant = request
            .trust
            .packages
            .get(&package.id)
            .cloned()
            .ok_or_else(|| failure(format!("package_trust_required: {}", package.id)))?;
        if grant.capabilities != package.capabilities {
            return Err(failure(format!(
                "explicit_exact_capability_grant_required: {}",
                package.id
            )));
        }
        let declared_lifecycle = package.lifecycle.keys().cloned().collect::<Vec<_>>();
        if grant.lifecycle != declared_lifecycle {
            return Err(failure(format!(
                "explicit_exact_lifecycle_trust_required: {}",
                package.id
            )));
        }
        if !package.dependencies.is_empty() && !grant.dependencies {
            return Err(failure(format!(
                "dependency_installation_trust_required: {}",
                package.id
            )));
        }
        let cache_path = self.cache_package(&path, &package, &integrity)?;
        let active_path = match normalized_source {
            ModPackageSource::Local { .. } => path,
            _ => {
                if path.starts_with(&self.root) && path != cache_path {
                    std::fs::remove_dir_all(&path)?;
                }
                cache_path.clone()
            }
        };
        let locked = ModLockedPackage {
            id: package.id.clone(),
            version: package.version.clone(),
            integrity,
            source: normalized_source,
            path: active_path,
            cache_path,
            license,
            provenance,
            entrypoint: package.entrypoint.clone(),
            api: package.api.clone(),
            state_version: package.state_version,
            dependencies: package.dependencies.clone(),
            capabilities: package.capabilities.clone(),
            settings_schema_sha256: digest(
                &serde_json::to_vec(&package.settings_schema).unwrap_or_default(),
            ),
            lifecycle: declared_lifecycle,
            scope: request.scope.clone(),
            enabled: false,
            settings: BTreeMap::new(),
            trust: grant,
        };
        let provisional = ResolvedPackage {
            locked,
            package: package.clone(),
        };
        resolved.insert(package.id.clone(), provisional.clone());
        for dependency in &package.dependencies {
            let dependency_source = ModPackageSource::Package {
                index: request
                    .index
                    .clone()
                    .ok_or_else(|| failure("dependency_index_required"))?,
                id: dependency.id.clone(),
                version: dependency.version.clone(),
            };
            let dependency_package = self.resolve_requested(
                &dependency_source,
                Some((&dependency.id, &dependency.version)),
                request,
                resolved,
                visiting,
            )?;
            resolved.insert(dependency.id.clone(), dependency_package);
        }
        visiting.pop();
        Ok(provisional)
    }

    fn materialize_source(
        &self,
        source: &ModPackageSource,
        offline: bool,
    ) -> Result<(PathBuf, ModPackageSource, Option<String>)> {
        match source {
            ModPackageSource::Local { path } => {
                let path = path.canonicalize()?;
                if path.starts_with(&self.root) {
                    return Err(failure("local_package_must_be_outside_store"));
                }
                Ok((path.clone(), ModPackageSource::Local { path }, None))
            }
            ModPackageSource::Repository {
                repository,
                revision,
                subdirectory,
            } => {
                if revision.len() != 40
                    || !revision.bytes().all(|byte| byte.is_ascii_hexdigit())
                    || repository.is_empty()
                    || repository.len() > 2048
                    || !package_directory(subdirectory)
                {
                    return Err(failure("immutable_repository_revision_required"));
                }
                let local = PathBuf::from(repository);
                let (repository_path, repository_source) = if local.exists() {
                    let path = local.canonicalize()?;
                    let source = path.display().to_string();
                    (path, source)
                } else {
                    if offline
                        && let Some(package) =
                            self.read_package_lock()?.packages.values().find(|package| {
                                package.source == *source && package.cache_path.exists()
                            })
                    {
                        return Ok((
                            package.cache_path.canonicalize()?,
                            package.source.clone(),
                            Some(package.integrity.clone()),
                        ));
                    }
                    if !repository.starts_with("https://") {
                        return Err(failure("remote_repository_requires_https"));
                    }
                    let repositories = self.root.join("repository-cache");
                    std::fs::create_dir_all(&repositories)?;
                    let cached =
                        repositories.join(format!("{}.git", digest(repository.as_bytes())));
                    if !cached.exists() {
                        if offline {
                            return Err(failure("repository_unavailable_offline_and_not_cached"));
                        }
                        let staging = repositories.join(format!(
                            ".{}.{}.tmp",
                            digest(repository.as_bytes()),
                            std::process::id()
                        ));
                        let output = Command::new("git")
                            .args(["clone", "--bare", "--filter=blob:none", "--", repository])
                            .arg(&staging)
                            .env_clear()
                            .env("PATH", "/usr/bin:/bin")
                            .output()?;
                        if !output.status.success() {
                            let _ = std::fs::remove_dir_all(&staging);
                            return Err(failure(format!(
                                "repository_clone_failed: {}",
                                String::from_utf8_lossy(&output.stderr).trim()
                            )));
                        }
                        std::fs::rename(&staging, &cached)?;
                        std::fs::File::open(&repositories)?.sync_all()?;
                    }
                    if !offline {
                        let output = Command::new("git")
                            .arg("-C")
                            .arg(&cached)
                            .args(["fetch", "--force", "--no-tags", "origin", revision])
                            .env_clear()
                            .env("PATH", "/usr/bin:/bin")
                            .output()?;
                        if !output.status.success() {
                            return Err(failure(format!(
                                "repository_fetch_failed: {}",
                                String::from_utf8_lossy(&output.stderr).trim()
                            )));
                        }
                    }
                    (cached.canonicalize()?, repository.clone())
                };
                let revision = revision.to_lowercase();
                let actual = git(
                    &repository_path,
                    &["rev-parse", &format!("{revision}^{{commit}}")],
                )?;
                if actual.trim() != revision {
                    return Err(failure("repository_revision_mismatch"));
                }
                let staging = self.root.join(format!(
                    ".repository-{}.{}.tmp",
                    &revision[..12],
                    std::process::id()
                ));
                if staging.exists() {
                    return Err(failure("stale_repository_staging_directory"));
                }
                std::fs::create_dir(&staging)?;
                let result = (|| {
                    let prefix = if subdirectory.is_empty() {
                        String::new()
                    } else {
                        format!("{subdirectory}/")
                    };
                    let manifest = git_bytes(
                        &repository_path,
                        &["show", &format!("{revision}:{prefix}mod.json")],
                    )?;
                    std::fs::write(staging.join("mod.json"), &manifest)?;
                    let package: ModPackage = serde_json::from_slice(&manifest)?;
                    package.validate()?;
                    for path in
                        std::iter::once(&package.entrypoint).chain(package.lifecycle.values())
                    {
                        let bytes = git_bytes(
                            &repository_path,
                            &["show", &format!("{revision}:{prefix}{path}")],
                        )?;
                        let target = staging.join(path);
                        if let Some(parent) = target.parent() {
                            std::fs::create_dir_all(parent)?;
                        }
                        std::fs::write(target, bytes)?;
                    }
                    Ok::<_, io::Error>(())
                })();
                if let Err(error) = result {
                    let _ = std::fs::remove_dir_all(&staging);
                    return Err(error);
                }
                Ok((
                    staging,
                    ModPackageSource::Repository {
                        repository: repository_source,
                        revision,
                        subdirectory: subdirectory.clone(),
                    },
                    None,
                ))
            }
            ModPackageSource::Package { index, id, version } => {
                let index_path = match index.canonicalize() {
                    Ok(index) => index,
                    Err(_error) if offline => {
                        if let Some(package) =
                            self.read_package_lock()?.packages.values().find(|package| {
                                matches!(&package.source,
                                    ModPackageSource::Package { index: locked_index, id: locked_id, version: locked_version }
                                    if locked_index == index && locked_id == id
                                        && service_version_satisfies(version, locked_version))
                                    && package.cache_path.exists()
                            })
                        {
                            return Ok((
                                package.cache_path.canonicalize()?,
                                package.source.clone(),
                                Some(package.integrity.clone()),
                            ));
                        }
                        return Err(failure("package_index_unavailable_offline"));
                    }
                    Err(error) => return Err(error),
                };
                let index_value: PackageIndex =
                    serde_json::from_slice(&store::read(&index_path, 524_288)?)?;
                if index_value.schema != 1 {
                    return Err(failure("unsupported_package_index_schema"));
                }
                let releases = index_value
                    .packages
                    .get(id)
                    .ok_or_else(|| failure("package_unavailable"))?;
                let release = releases
                    .iter()
                    .filter_map(|release| {
                        service_version_satisfies(version, &release.version)
                            .then_some((SemanticVersion::parse(&release.version)?, release))
                    })
                    .max_by_key(|(version, _)| *version)
                    .map(|(_, release)| release)
                    .ok_or_else(|| failure("package_version_unavailable"))?;
                let (path, resolved, actual_expected) =
                    self.materialize_source(&release.source, offline)?;
                if actual_expected
                    .as_deref()
                    .is_some_and(|value| value != release.integrity)
                {
                    return Err(failure("index_integrity_conflict"));
                }
                let _ = resolved;
                Ok((
                    path,
                    ModPackageSource::Package {
                        index: index_path,
                        id: id.clone(),
                        version: release.version.clone(),
                    },
                    Some(release.integrity.clone()),
                ))
            }
        }
    }

    fn cache_package(
        &self,
        source: &Path,
        package: &ModPackage,
        integrity: &str,
    ) -> Result<PathBuf> {
        let base = self.root.join("package-cache").join(&package.id);
        std::fs::create_dir_all(&base)?;
        let destination = base.join(integrity);
        if destination.exists() {
            let destination = destination.canonicalize()?;
            if store::package(&destination)?.2 != integrity {
                return Err(failure("cached_package_integrity_failure"));
            }
            return Ok(destination);
        }
        let staging = base.join(format!(".{integrity}.{}.tmp", std::process::id()));
        std::fs::create_dir(&staging)?;
        let result = (|| {
            copy_file(source, &staging, "mod.json", 8192)?;
            copy_file(source, &staging, &package.entrypoint, 65_536)?;
            for asset in &package.assets {
                copy_file(source, &staging, asset, 65_536)?;
            }
            for script in package.lifecycle.values() {
                copy_file(source, &staging, script, 65_536)?;
            }
            if store::package(&staging.canonicalize()?)?.2 != integrity {
                return Err(failure("package_integrity_changed_during_copy"));
            }
            std::fs::rename(&staging, &destination)?;
            std::fs::File::open(&base)?.sync_all()?;
            destination.canonicalize()
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        result
    }

    fn run_lifecycle(&self, package: &ModLockedPackage, event: &str) -> Result<()> {
        if !package.lifecycle.iter().any(|declared| declared == event) {
            return Ok(());
        }
        if !package
            .trust
            .lifecycle
            .iter()
            .any(|trusted| trusted == event)
        {
            return Err(failure("lifecycle_script_not_trusted"));
        }
        let inspected = store::package(&package.path);
        if event == "uninstall" {
            match &inspected {
                Ok((_, _, integrity)) if integrity == &package.integrity => {}
                _ => return Ok(()),
            }
        }
        let (manifest, _, integrity) = inspected?;
        if integrity != package.integrity {
            return Err(failure("package_integrity_failure"));
        }
        let script = manifest
            .lifecycle
            .get(event)
            .ok_or_else(|| failure("lifecycle_script_missing"))?;
        let source =
            String::from_utf8(store::read(&package.path.join(script), 65_536)?).map_err(failure)?;
        let node = self.configuration()?.node;
        let request = json!({"source":source,"filename":script,"adapter":null,"event":"inspect",
            "name":event,"payload":null,"state":null,"settings":{"event":event,"package":package.id,
                "version":package.version,"integrity":package.integrity},"capabilities":[],"environment":[],
            "hook_budget_ms":1000,"receipts":[],"field_policies":{},"virtual_time_ms":null});
        process::evaluate(&node, &request, std::time::Duration::from_secs(1), &|| true)?;
        Ok(())
    }
}

fn copy_file(source: &Path, destination: &Path, relative: &str, limit: u64) -> Result<()> {
    let bytes = store::read(&source.join(relative), limit)?;
    let target = destination.join(relative);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(target, bytes)
}

fn git(repository: &Path, arguments: &[&str]) -> Result<String> {
    String::from_utf8(git_bytes(repository, arguments)?).map_err(failure)
}

fn git_bytes(repository: &Path, arguments: &[&str]) -> Result<Vec<u8>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .output()?;
    if !output.status.success() {
        return Err(failure(format!(
            "repository_read_failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(output.stdout)
}

fn validate_provenance(source: &ModPackageSource, provenance: &ModProvenance) -> Result<()> {
    if let ModPackageSource::Repository { repository, .. } = source
        && provenance.source != *repository
    {
        return Err(failure("repository_provenance_mismatch"));
    }
    Ok(())
}

fn package_directory(value: &str) -> bool {
    value.is_empty()
        || (!value.starts_with('/')
            && value.len() <= 256
            && value.split('/').all(|part| {
                !part.is_empty()
                    && part != "."
                    && part != ".."
                    && part.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
                    })
            }))
}

fn validate_package_lock(lock: &ModPackageLock) -> Result<()> {
    if lock
        .history
        .values()
        .any(|history| history.len() > PACKAGE_HISTORY_LIMIT)
        || lock.packages.iter().any(|(id, package)| {
            id != &package.id
                || package.integrity.len() != 64
                || !package
                    .integrity
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err(failure("invalid_package_lock"));
    }
    Ok(())
}

fn push_history(lock: &mut ModPackageLock, id: &str, package: ModLockedPackage) -> Result<()> {
    let history = lock.history.entry(id.to_owned()).or_default();
    history.push(package);
    if history.len() > PACKAGE_HISTORY_LIMIT {
        history.remove(0);
    }
    Ok(())
}

fn validate_locked_graph(packages: &BTreeMap<String, ModLockedPackage>) -> Result<()> {
    for package in packages.values() {
        for dependency in &package.dependencies {
            let resolved = packages
                .get(&dependency.id)
                .ok_or_else(|| failure(format!("dependency_unavailable: {}", dependency.id)))?;
            if !service_version_satisfies(&dependency.version, &resolved.version) {
                return Err(failure("dependency_version_incompatible"));
            }
        }
    }
    let mut remaining: BTreeSet<_> = packages.keys().cloned().collect();
    while let Some(id) = remaining
        .iter()
        .find(|id| {
            packages[*id]
                .dependencies
                .iter()
                .all(|dependency| !remaining.contains(&dependency.id))
        })
        .cloned()
    {
        remaining.remove(&id);
    }
    if remaining.is_empty() {
        Ok(())
    } else {
        Err(failure(format!(
            "dependency_cycle: {}",
            remaining.into_iter().collect::<Vec<_>>().join(" -> ")
        )))
    }
}

fn package_changes(existing: &ModPackageLock, packages: &[ModLockedPackage]) -> Value {
    let mut changes = Vec::new();
    for package in packages {
        let previous = existing.packages.get(&package.id);
        changes.push(json!({
            "id":package.id,
            "version":{"from":previous.map(|value|&value.version),"to":package.version},
            "integrity":{"from":previous.map(|value|&value.integrity),"to":package.integrity},
            "source":{"from":previous.map(|value|&value.source),"to":package.source},
            "license":{"from":previous.map(|value|&value.license),"to":package.license},
            "provenance":{"from":previous.map(|value|&value.provenance),"to":package.provenance},
            "entrypoint":{"from":previous.map(|value|&value.entrypoint),"to":package.entrypoint},
            "api":{"from":previous.map(|value|&value.api),"to":package.api},
            "state_version":{"from":previous.map(|value|value.state_version),"to":package.state_version,
                "migration_required":previous.is_some_and(|value|value.state_version != package.state_version) && !package.enabled},
            "dependencies":{"from":previous.map(|value|&value.dependencies),"to":package.dependencies},
            "capabilities":{"from":previous.map(|value|&value.capabilities),"to":package.capabilities},
            "settings_schema_sha256":{"from":previous.map(|value|&value.settings_schema_sha256),"to":package.settings_schema_sha256},
            "settings":{"from":previous.map(|value|&value.settings),"to":package.settings},
            "lifecycle":{"from":previous.map(|value|&value.lifecycle),"to":package.lifecycle},
            "activation":{"from":previous.is_some_and(|value|value.enabled),"to":package.enabled}
        }));
    }
    Value::Object(Map::from_iter([
        ("packages".to_owned(), Value::Array(changes)),
        (
            "authority".to_owned(),
            json!(
                "dependency resolution installs no capability, lifecycle, permission, credential, provider, or spending grant"
            ),
        ),
        ("local_sources_preserved".to_owned(), Value::Bool(true)),
        (
            "activation_requires_confirmation".to_owned(),
            Value::Bool(true),
        ),
    ]))
}
