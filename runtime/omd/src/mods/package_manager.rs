use super::*;
use serde_json::Map;
use std::io::Read;
use std::process::Command;

const PACKAGE_LOCK_SCHEMA: u32 = 1;
const PACKAGE_HISTORY_LIMIT: usize = 8;
const NPM_METADATA_LIMIT: usize = 16 * 1024 * 1024;
const NPM_TARBALL_LIMIT: usize = 4 * 1024 * 1024;
const NPM_UNPACKED_LIMIT: usize = 16 * 1024 * 1024;
const NPM_ARCHIVE_ENTRIES: usize = 1024;

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
    Npm {
        package: String,
        #[serde(default)]
        version: String,
        #[serde(default)]
        registry: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        integrity: String,
    },
}

#[derive(Default)]
struct NpmConfig {
    registry: Option<String>,
    scopes: BTreeMap<String, String>,
    tokens: Vec<(String, String)>,
}

impl NpmConfig {
    fn load() -> Self {
        let path = std::env::var_os("NPM_CONFIG_USERCONFIG")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".npmrc")));
        let text = path
            .filter(|path| {
                std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() <= 65_536)
            })
            .and_then(|path| std::fs::read_to_string(path).ok())
            .unwrap_or_default();
        let expand = |value: &str| {
            interpolate(value.trim().trim_matches('"'), |name| {
                std::env::var(name).ok()
            })
        };
        let mut config = Self::default();
        for line in text.lines().map(str::trim) {
            let Some((key, value)) = line
                .split_once('=')
                .filter(|_| !line.starts_with(['#', ';']))
            else {
                continue;
            };
            let (key, value) = (key.trim(), expand(value));
            if key == "registry" {
                config.registry = Some(value);
            } else if let Some(scope) = key
                .strip_suffix(":registry")
                .filter(|scope| scope.starts_with('@'))
            {
                config.scopes.insert(scope.to_owned(), value);
            } else if let Some(prefix) = key
                .strip_suffix(":_authToken")
                .filter(|prefix| prefix.starts_with("//"))
            {
                config
                    .tokens
                    .push((format!("{}/", prefix.trim_end_matches('/')), value));
            }
        }
        config
    }

    fn registry(&self, package: &str) -> String {
        package
            .split_once('/')
            .and_then(|(scope, _)| self.scopes.get(scope))
            .or(self.registry.as_ref())
            .map_or("https://registry.npmjs.org", String::as_str)
            .trim_end_matches('/')
            .to_owned()
    }

    fn token(&self, url: &str) -> Option<&str> {
        let target = format!("//{}", url.split_once("://")?.1);
        self.tokens
            .iter()
            .filter(|(prefix, _)| target.starts_with(prefix.as_str()))
            .max_by_key(|(prefix, _)| prefix.len())
            .map(|(_, token)| token.as_str())
            .filter(|token| !token.is_empty())
    }
}

fn interpolate(value: &str, resolve: impl Fn(&str) -> Option<String>) -> String {
    let (mut expanded, mut rest) = (String::new(), value);
    while let Some(start) = rest.find("${") {
        let Some(length) = rest[start..].find('}') else {
            break;
        };
        expanded.push_str(&rest[..start]);
        expanded.push_str(&resolve(&rest[start + 2..start + length]).unwrap_or_default());
        rest = &rest[start + length + 1..];
    }
    expanded + rest
}

impl ModPackageSource {
    pub fn parse(reference: &str, index: Option<PathBuf>) -> Result<Self> {
        let reference = reference.trim();
        let versioned = |value: &str| match value.get(1..).and_then(|rest| rest.rfind('@')) {
            Some(at) => (value[..=at].to_owned(), value[at + 2..].to_owned()),
            None => (value.to_owned(), String::new()),
        };
        if let Some(npm) = reference.strip_prefix("npm:") {
            let (package, version) = versioned(npm);
            return Ok(Self::Npm {
                package,
                version,
                registry: String::new(),
                integrity: String::new(),
            });
        }
        if let Some(git) = reference.strip_prefix("git+") {
            let (repository, fragment) = git.split_once('#').unwrap_or((git, "HEAD"));
            let (revision, subdirectory) = fragment.split_once(':').unwrap_or((fragment, ""));
            return Ok(Self::Repository {
                repository: repository
                    .strip_prefix("file://")
                    .unwrap_or(repository)
                    .to_owned(),
                revision: revision.to_owned(),
                subdirectory: subdirectory.to_owned(),
            });
        }
        if reference.starts_with('/') {
            return Ok(Self::Local {
                path: reference.into(),
            });
        }
        let (id, version) = versioned(reference);
        if !identifier(&id) || !version_selector(&version) {
            return Err(failure(
                "package_reference_invalid: use ID[@VERSION], npm:NAME[@VERSION], git+URL[#REF[:DIRECTORY]] or an absolute folder",
            ));
        }
        Ok(Self::Package {
            index: index.ok_or_else(|| {
                failure("package_index_unavailable: install from npm:, git+ or a folder instead")
            })?,
            id,
            version,
        })
    }

    pub fn with_version(self, requested: &str) -> Result<Self> {
        match self {
            Self::Package { index, id, .. } => Ok(Self::Package {
                index,
                id,
                version: requested.to_owned(),
            }),
            Self::Npm {
                package, registry, ..
            } => Ok(Self::Npm {
                package,
                version: requested.to_owned(),
                registry,
                integrity: String::new(),
            }),
            _ => Err(failure(
                "package_version_unsupported: pin a Git source with #REF; folders have no versions",
            )),
        }
    }

    /// The source an update resolves: newer compatible index and npm releases; pinned commits and local folders as is.
    pub fn updatable(&self) -> Self {
        let compatible = |version: &str| match SemanticVersion::parse(version) {
            Some(_) => format!("^{version}"),
            None => String::new(),
        };
        match self {
            Self::Package { index, id, version } => Self::Package {
                index: index.clone(),
                id: id.clone(),
                version: compatible(version),
            },
            Self::Npm {
                package,
                version,
                registry,
                ..
            } => Self::Npm {
                package: package.clone(),
                version: compatible(version),
                registry: registry.clone(),
                integrity: String::new(),
            },
            source => source.clone(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModPackageGrant {
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub dependencies: bool,
    #[serde(default)]
    pub lifecycle: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secret_environment: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModPackageTrust {
    pub packages: BTreeMap<String, ModPackageGrant>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModInstallRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    pub source: ModPackageSource,
    #[serde(default)]
    pub index: Option<PathBuf>,
    #[serde(default = "user_scope")]
    pub scope: String,
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
    pub authority: Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exec_environment: Vec<String>,
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
    #[serde(default)]
    pub blocked: Vec<ModBlockedPackage>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModBlockedPackage {
    pub id: String,
    pub version: String,
    pub integrity: String,
    pub reason: String,
}

impl Default for ModPackageLock {
    fn default() -> Self {
        Self {
            schema: PACKAGE_LOCK_SCHEMA,
            revision: 0,
            packages: BTreeMap::new(),
            history: BTreeMap::new(),
            blocked: Vec::new(),
        }
    }
}

impl ModPackageLock {
    pub fn blocked_reason(&self, id: &str, version: &str, integrity: &str) -> Option<&str> {
        self.blocked
            .iter()
            .find(|blocked| {
                blocked.id == id && (blocked.version == version || blocked.integrity == integrity)
            })
            .map(|blocked| blocked.reason.as_str())
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
    #[serde(default)]
    blocked: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    support: Option<String>,
}

fn read_index(path: &Path) -> Result<PackageIndex> {
    let index: PackageIndex = serde_json::from_slice(&store::read(path, 524_288)?)?;
    if index.schema != 1 {
        return Err(failure("unsupported_package_index_schema"));
    }
    if index
        .packages
        .values()
        .flatten()
        .any(|release| matches!(release.source, ModPackageSource::Package { .. }))
    {
        return Err(failure("index_release_source_invalid"));
    }
    Ok(index)
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
                let lock: ModPackageLock = serde_json::from_slice(&bytes).map_err(|error| {
                    failure(format!(
                        "package_lock_unreadable: {error}; run `omd mods reset-lock` to set it aside"
                    ))
                })?;
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

    pub fn package_index(&self) -> Option<PathBuf> {
        let path = self.root.join("package-index.json");
        path.is_file().then_some(path)
    }

    pub fn package_index_entries(
        &self,
        index: &Path,
        query: &str,
        start: usize,
        limit: usize,
    ) -> Result<Value> {
        let lock = self.package_lock()?;
        let query = query.trim().to_lowercase();
        let mut packages = Vec::new();
        let mut total = 0;
        for (id, releases) in read_index(index)?.packages {
            let mut releases = releases;
            releases.reverse();
            releases
                .sort_by_key(|release| std::cmp::Reverse(SemanticVersion::parse(&release.version)));
            let Some(newest) = releases
                .iter()
                .find(|release| release.blocked.is_none())
                .or(releases.first())
            else {
                continue;
            };
            let description = newest.description.clone().unwrap_or_default();
            if !query.is_empty()
                && !id.to_lowercase().contains(&query)
                && !description.to_lowercase().contains(&query)
            {
                continue;
            }
            total += 1;
            if total <= start || packages.len() == limit {
                continue;
            }
            packages.push(json!({
                "id": id,
                "latest": newest.version,
                "description": description,
                "support": newest.support,
                "versions": releases.iter().map(|release| json!({"version": release.version,
                    "blocked": release.blocked})).collect::<Vec<_>>(),
                "installed": lock.packages.get(&id).map(|package| &package.version),
            }));
        }
        let end = start + packages.len();
        Ok(json!({"index": index, "packages": packages, "total": total,
            "cursor": (end < total).then(|| end.to_string())}))
    }

    pub fn package_plan(&self, request: ModInstallRequest) -> Result<ModPackagePlan> {
        if request
            .action
            .as_deref()
            .is_some_and(|action| !matches!(action, "install" | "update"))
        {
            return Err(failure(
                "package_plan_action_invalid: use install or update; remove, rollback, enable and disable have their own commands",
            ));
        }
        let _guard = self.lock()?;
        self.recover_package_transaction()?;
        self.package_plan_locked(request, false, None)
    }

    pub fn package_requirements(&self, request: ModInstallRequest) -> Result<ModPackagePlan> {
        let _guard = self.lock()?;
        self.recover_package_transaction()?;
        self.package_plan_locked(request, true, None)
    }

    /// A `deployment` plan resolves administrator packages: the user's blocks and policy refusals do not apply.
    fn package_plan_locked(
        &self,
        request: ModInstallRequest,
        inspect: bool,
        deployment: Option<&policy::ManagedPackage>,
    ) -> Result<ModPackagePlan> {
        if !MOD_SCOPES.contains(&request.scope.as_str()) {
            return Err(failure("unsupported_scope: user or project"));
        }
        let (existing, config) = if deployment.is_some() {
            (
                ModPackageLock::default(),
                ModConfiguration {
                    schema: 1,
                    revision: 0,
                    node: None,
                    mods: Vec::new(),
                },
            )
        } else {
            (self.read_package_lock()?, self.configuration()?)
        };
        let managed = match deployment.is_some() || inspect {
            true => None,
            false => self.managed()?,
        };
        let mut resolved = BTreeMap::new();
        let mut visiting = Vec::new();
        let mut handlers = BTreeSet::new();
        let cached = deployment.map(|entry| {
            self.root
                .join("package-cache")
                .join(&entry.id)
                .join(&entry.sha256)
        });
        let root = match (deployment, cached) {
            (Some(entry), Some(path))
                if store::package(&path).is_ok_and(|(manifest, _, hash)| {
                    manifest.id == entry.id && hash == entry.sha256
                }) =>
            {
                self.resolve_materialized(
                    path,
                    request.source.clone(),
                    Some(entry.sha256.clone()),
                    None,
                    &request,
                    &existing,
                    &mut resolved,
                    &mut visiting,
                    inspect,
                )
            }
            _ => self.resolve_requested(
                &request.source,
                None,
                &request,
                &existing,
                &mut resolved,
                &mut visiting,
                inspect,
            ),
        }?;
        let root_id = root.package.id.clone();
        resolved.insert(root_id.clone(), root);
        let mut packages = resolved
            .into_values()
            .map(|mut resolved| {
                if let Some(reason) = existing.blocked_reason(
                    &resolved.locked.id,
                    &resolved.locked.version,
                    &resolved.locked.integrity,
                ) && deployment.is_none()
                {
                    return Err(failure(format!(
                        "package_blocked: {} {}: {reason}",
                        resolved.locked.id, resolved.locked.version
                    )));
                }
                let previous = existing.packages.get(&resolved.package.id);
                if let Some(locked) = previous
                    && locked.scope != request.scope
                {
                    return Err(failure(format!(
                        "package_scope_conflict: {} is installed in {} scope",
                        locked.id, locked.scope
                    )));
                }
                if let Some(reason) = managed.as_ref().and_then(|managed| {
                    managed.policy.install_refusal(
                        &resolved.locked.id,
                        &resolved.locked.capabilities,
                        &policy::source_reference(&resolved.locked.source),
                        previous
                            .is_some_and(|locked| locked.integrity != resolved.locked.integrity),
                    )
                }) {
                    return Err(failure(reason));
                }
                let settings = request
                    .settings
                    .get(&resolved.package.id)
                    .cloned()
                    .or_else(|| {
                        previous.map(|locked| {
                            declared_settings(
                                resolved.package.settings_schema.as_ref(),
                                &selected_settings(&config, locked),
                            )
                        })
                    })
                    .unwrap_or_default();
                validate_settings(&resolved.package, &settings)?;
                resolved.locked.settings = settings;
                let state_version_changed = previous
                    .is_some_and(|locked| locked.state_version != resolved.package.state_version);
                let state_migration_required = state_version_changed
                    && self
                        .root
                        .join(ModStore::state_name(&resolved.package.id, &request.scope))
                        .exists();
                // An adapter-wrapped package cannot be inspected outside the host.
                if state_version_changed
                    && matches!(resolved.package.state_scope.as_str(), "thread" | "checkout")
                    && resolved.package.adapter.is_none()
                    && resolved.package.capabilities.iter().any(|c| c == "store")
                {
                    handlers.insert(resolved.package.id.clone());
                }
                resolved.locked.enabled = previous.is_some_and(|locked| {
                    locked.enabled && same_approval(locked, &resolved.locked)
                }) && !state_migration_required;
                Ok(resolved.locked)
            })
            .collect::<Result<Vec<_>>>()?;
        packages.sort_by(|a, b| a.id.cmp(&b.id));
        let action = if existing.packages.contains_key(&root_id) {
            "update"
        } else {
            "install"
        };
        if let Some(requested) = request.action.as_deref()
            && requested != action
        {
            return Err(failure(format!(
                "package_plan_action_mismatch: {requested} requested, {action} computed"
            )));
        }
        let changes = package_changes(&existing, &packages, &handlers);
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
        let source = redacted_source(&request.source);
        let result = self.package_apply_locked(request, confirmation);
        if let Err(error) = &result {
            let _ = self.record_security_event(
                "package_refused",
                json!({"source": source, "reason": error_code(error)}),
            );
        }
        result
    }

    fn package_apply_locked(
        &self,
        request: ModInstallRequest,
        confirmation: &str,
    ) -> Result<ModPackageLock> {
        let online = !request.offline;
        let scope = request.scope.clone();
        let plan = self.package_plan_locked(request, false, None)?;
        if plan.confirmation != confirmation {
            return Err(failure("package_plan_changed: preview again"));
        }
        let mut lock = self.read_package_lock()?;
        let mut config = self.configuration()?;
        self.verified_runner()?;
        require_migration_handlers(&plan, &scope)?;
        let mut selection_ids = config
            .mods
            .iter()
            .map(|selection| {
                store::package(&selection.path)
                    .ok()
                    .map(|(manifest, _, _)| manifest.id)
                    .or_else(|| {
                        lock.packages
                            .values()
                            .find(|locked| {
                                locked.scope == selection.scope
                                    && (locked.path == selection.path
                                        || locked.cache_path == selection.path)
                            })
                            .map(|locked| locked.id.clone())
                    })
            })
            .collect::<Vec<_>>();
        let mut lifecycle = Vec::new();
        let mut evicted = Vec::new();
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
                evicted.extend(push_history(&mut lock, &package.id, previous));
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
                secret_environment: package.trust.secret_environment.clone(),
                expires_at: None,
                tier: None,
                required: selection.is_some_and(|selection| config.mods[selection].required),
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
        let event =
            json!({"packages": plan.packages.iter().map(package_event).collect::<Vec<_>>()});
        let lock = self.commit_package_transaction(
            lock,
            config,
            &lifecycle,
            &plan.action,
            event,
            if online { &plan.packages } else { &[] },
        )?;
        self.prune_evicted_local_snapshots(&lock, &evicted);
        Ok(lock)
    }

    fn prune_evicted_local_snapshots(&self, lock: &ModPackageLock, evicted: &[ModLockedPackage]) {
        if evicted.is_empty() {
            return;
        }
        let (Ok(config), Ok(managed)) = (self.configuration(), self.managed_deployment()) else {
            return;
        };
        let mut paths = lock
            .packages
            .values()
            .chain(lock.history.values().flatten())
            .flat_map(|package| [&package.path, &package.cache_path])
            .chain(config.mods.iter().map(|selection| &selection.path))
            .collect::<Vec<_>>();
        let mut integrities = config
            .mods
            .iter()
            .map(|selection| &selection.sha256)
            .collect::<BTreeSet<_>>();
        let mut generation = Some(&managed);
        while let Some(deployment) = generation {
            for package in &deployment.packages {
                paths.push(&package.path);
                integrities.insert(&package.sha256);
                integrities.extend(&package.dependencies);
            }
            generation = deployment.previous.as_deref();
        }
        let paths = paths
            .into_iter()
            .map(|path| path.canonicalize().unwrap_or_else(|_| path.clone()))
            .collect::<Vec<_>>();
        for package in evicted {
            let ModPackageSource::Local { path: source } = &package.source else {
                continue;
            };
            if !identifier(&package.id)
                || package.integrity.len() != 64
                || !package
                    .integrity
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || !source.is_absolute()
                || source.starts_with(&self.root)
                || source
                    .canonicalize()
                    .is_ok_and(|path| path.starts_with(&self.root))
            {
                continue;
            }
            let cache = self.root.join("package-cache");
            let base = cache.join(&package.id);
            let expected = base.join(&package.integrity);
            if package.cache_path != expected
                || [&cache, &base, &expected].iter().any(|path| {
                    !std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
                })
                || !expected.canonicalize().is_ok_and(|path| path == expected)
                || paths.iter().any(|path| path.starts_with(&expected))
                || integrities.contains(&package.integrity)
                || !store::package(&expected).is_ok_and(|(manifest, _, integrity)| {
                    manifest.id == package.id && integrity == package.integrity
                })
            {
                continue;
            }
            let _ = std::fs::remove_dir_all(expected);
        }
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
        self.package_disable_blocking(id, None)
    }

    /// Disables `id` and blocks its installed version so it cannot be enabled, reinstalled or rolled back to.
    pub fn package_quarantine(&self, id: &str, reason: &str) -> Result<ModPackageLock> {
        let reason = reason.trim();
        if reason.is_empty() || reason.len() > 256 || reason.chars().any(char::is_control) {
            return Err(failure(
                "quarantine_reason_invalid: one line of 1 to 256 bytes",
            ));
        }
        self.package_disable_blocking(id, Some(reason))
    }

    pub fn package_unblock(&self, id: &str) -> Result<ModPackageLock> {
        let _guard = self.lock()?;
        self.recover_package_transaction()?;
        let mut lock = self.read_package_lock()?;
        let before = lock.blocked.len();
        lock.blocked.retain(|blocked| blocked.id != id);
        if lock.blocked.len() == before {
            return Err(failure("package_not_blocked"));
        }
        lock.revision = lock
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        let config = self.configuration()?;
        self.commit_package_transaction(lock, config, &[], "unblock", json!({"mod": id}), &[])
    }

    fn package_disable_blocking(&self, id: &str, block: Option<&str>) -> Result<ModPackageLock> {
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
        let event = package_event(package);
        if let Some(reason) = block {
            let blocked = ModBlockedPackage {
                id: id.to_owned(),
                version: package.version.clone(),
                integrity: package.integrity.clone(),
                reason: reason.to_owned(),
            };
            lock.blocked.retain(|existing| {
                !(existing.id == blocked.id && existing.integrity == blocked.integrity)
            });
            lock.blocked.push(blocked);
        }
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
        match block {
            Some(reason) => self.commit_package_transaction(
                lock,
                config,
                &[],
                "quarantine",
                json!({"package": event, "reason": reason}),
                &[],
            ),
            None => self.commit_package_transaction(
                lock,
                config,
                &[],
                "disable",
                json!({"package": event}),
                &[],
            ),
        }
    }

    pub fn package_enable(&self, id: &str) -> Result<ModPackageLock> {
        let _guard = self.lock()?;
        self.recover_package_transaction()?;
        let mut lock = self.read_package_lock()?;
        let blocked = lock.packages.get(id).and_then(|package| {
            lock.blocked_reason(id, &package.version, &package.integrity)
                .map(str::to_owned)
        });
        if let Some(reason) = blocked {
            return Err(failure(format!("package_blocked: {id}: {reason}")));
        }
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
        self.check_service_providers(&manifest, &package.path)?;
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
        super::validate_stored_settings(&manifest, &selection.settings)?;
        selection.enabled = true;
        store::refuse_second_copy(&config, &path, &scope, &manifest.id)?;
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        let event = json!({"package": package_event(&lock.packages[id])});
        self.commit_package_transaction(lock, config, &[], "enable", event, &[])
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
        if let Err(error) = self.run_lifecycle(&package, "uninstall") {
            let _ = self.record_security_event(
                "lifecycle_failed",
                json!({"package": package_event(&package), "script": "uninstall", "reason": error_code(&error)}),
            );
        }
        let installed = lock.packages.keys().cloned().collect::<BTreeSet<_>>();
        lock.history.retain(|name, _| installed.contains(name));
        lock.revision = lock
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        let mut config = self.configuration()?;
        // Earlier cached versions of this package go too; another copy of the same mod, such as a bundled source, stays.
        let cached = package.cache_path.parent().unwrap_or(&package.cache_path);
        config.mods.retain(|selection| {
            !(selection.scope == package.scope
                && (selection.path == package.path
                    || selection.path == package.cache_path
                    || selection.path.starts_with(cached)
                        && store::package(&selection.path)
                            .is_ok_and(|(manifest, _, _)| manifest.id == id)))
        });
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        let event = json!({"package": package_event(&package)});
        self.commit_package_transaction(lock, config, &[], "uninstall", event, &[])
    }

    pub fn package_rollback_plan(&self, id: &str) -> Result<ModPackagePlan> {
        let _guard = self.lock()?;
        self.recover_package_transaction()?;
        self.package_rollback_plan_locked(id)
    }

    fn package_rollback_plan_locked(&self, id: &str) -> Result<ModPackagePlan> {
        if self
            .managed()?
            .is_some_and(|managed| managed.policy.updates == policy::ManagedUpdates::Managed)
        {
            return Err(failure(format!(
                "managed_updates_denied: administrator policy manages package versions; {id} stays as installed"
            )));
        }
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
        if let Some(reason) = lock.blocked_reason(id, &previous.version, &previous.integrity) {
            return Err(failure(format!(
                "package_blocked: {id} {}: {reason}",
                previous.version
            )));
        }
        if current.trust == ModPackageGrant::default()
            && previous.trust != ModPackageGrant::default()
        {
            return Err(failure(format!(
                "package_trust_revoked: grant {id} again with an install or update before rolling back"
            )));
        }
        let mut plan = ModPackagePlan {
            schema: PACKAGE_LOCK_SCHEMA,
            action: "rollback".into(),
            root: id.to_owned(),
            packages: vec![previous.clone()],
            changes: json!({"version":{"from":current.version,"to":previous.version},
                "integrity":{"from":current.integrity,"to":previous.integrity},
                "capabilities":{"from":current.capabilities,"to":previous.capabilities},
                "dependencies":{"from":current.dependencies,"to":previous.dependencies},
                "settings_preserved":selected_settings(&self.configuration()?, current)}),
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
        let package = store::package(&previous.path)?.0;
        previous.settings = declared_settings(
            package.settings_schema.as_ref(),
            &selected_settings(&self.configuration()?, &current),
        );
        previous.enabled = current.enabled
            && same_approval(&previous, &current)
            && previous.state_version == current.state_version;
        validate_settings(&package, &previous.settings)?;
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
            enabled: previous.enabled,
            capabilities: previous.trust.capabilities,
            settings: previous.settings,
            scope: previous.scope,
            secret_environment: previous.trust.secret_environment,
            expires_at: None,
            tier: None,
            required: selection.required,
        };
        config.revision = config
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("revision_overflow"))?;
        let event = json!({"package": package_event(&plan.packages[0])});
        self.commit_package_transaction(lock, config, &[], "rollback", event, &[])
    }

    pub(super) fn commit_package_transaction(
        &self,
        lock: ModPackageLock,
        config: ModConfiguration,
        lifecycle: &[(ModLockedPackage, &str)],
        event: &str,
        detail: Value,
        provenance: &[ModLockedPackage],
    ) -> Result<ModPackageLock> {
        let old_lock = serde_json::to_value(self.read_package_lock()?)?;
        let old_config = serde_json::to_value(self.configuration()?)?;
        self.write(
            "package-transaction.json",
            &json!({"old_lock":old_lock,"old_config":old_config}),
        )?;
        let result: Result<ModPackageLock> = (|| {
            for (package, event) in lifecycle {
                self.run_lifecycle(package, event)?;
            }
            let previous = old_config["mods"]
                .as_array()
                .into_iter()
                .flatten()
                .map(store::grant)
                .collect::<BTreeSet<_>>();
            let mut approved: BTreeSet<String> = config
                .mods
                .iter()
                .map(|selection| store::grant(&json!(selection)))
                .filter(|grant| !previous.contains(grant))
                .collect();
            approved.extend(provenance.iter().map(store::package_provenance));
            approved.extend(
                config
                    .mods
                    .iter()
                    .filter(|selection| {
                        provenance.iter().any(|package| {
                            package.path == selection.path && package.integrity == selection.sha256
                        })
                    })
                    .map(|selection| store::grant(&json!(selection))),
            );
            self.write_granting("mods.json", &serde_json::to_value(&config)?, &approved)?;
            self.write("packages.lock.json", &serde_json::to_value(&lock)?)?;
            std::fs::remove_file(self.root.join("package-transaction.json"))?;
            std::fs::File::open(&self.root)?.sync_all()?;
            Ok(lock)
        })();
        if result.is_err() {
            self.recover_package_transaction()?;
        }
        let lock = result?;
        let _ = self.record_security_event(event, detail);
        Ok(lock)
    }

    pub(super) fn recover_package_transaction(&self) -> Result<()> {
        let path = self.root.join("package-transaction.json");
        let bytes = match store::read(&path, 1_048_576) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let transaction: Value = serde_json::from_slice(&bytes)?;
        let restored = transaction["old_config"]["mods"]
            .as_array()
            .into_iter()
            .flatten()
            .map(store::grant)
            .collect();
        self.write_granting("mods.json", &transaction["old_config"], &restored)?;
        self.write("packages.lock.json", &transaction["old_lock"])?;
        std::fs::remove_file(path)?;
        std::fs::File::open(&self.root)?.sync_all()
    }

    /// Installs every package administrator policy assigns to this account and records a new deployment generation only when all verify; otherwise the active generation stays.
    pub fn package_sync(&self, offline: bool) -> Result<Value> {
        let managed = self
            .managed()?
            .ok_or_else(|| failure("managed_policy_absent: no administrator policy applies"))?;
        let user = self.managed_user();
        let _guard = self.lock()?;
        let current = self.managed_deployment()?;
        let index = managed
            .policy
            .index
            .as_ref()
            .map(policy::ManagedIndex::location)
            .transpose()
            .map_err(|error| error.to_string());
        let mut deployed: Vec<policy::DeployedPackage> = Vec::new();
        let mut failures = BTreeMap::new();
        for entry in managed.deployable(&user) {
            match self.deploy(entry, &managed, &index, offline) {
                Ok(packages) => {
                    for package in packages {
                        if !deployed.contains(&package) {
                            deployed.push(package);
                        }
                    }
                }
                Err(error) => {
                    failures.insert(format!("{} {}", entry.id, entry.sha256), error.to_string());
                }
            }
        }
        if !failures.is_empty() {
            let _ =
                self.record_security_event("managed_sync_refused", json!({"failures": failures}));
            return Err(failure(format!(
                "managed_sync_incomplete: generation {} stays active: {}",
                current.generation,
                serde_json::to_string(&failures)?
            )));
        }
        deployed.sort_by(|a, b| (&a.id, &a.sha256).cmp(&(&b.id, &b.sha256)));
        if deployed == current.packages && managed.sha256 == current.policy_sha256 {
            return Ok(
                json!({"generation": current.generation, "changed": false, "packages": deployed}),
            );
        }
        self.deploy_generation(current, managed.sha256, deployed)
    }

    pub fn package_sync_rollback(&self) -> Result<Value> {
        let _guard = self.lock()?;
        let current = self.managed_deployment()?;
        let previous = current
            .previous
            .clone()
            .ok_or_else(|| failure("managed_rollback_unavailable: no previous generation"))?;
        self.deploy_generation(current, previous.policy_sha256, previous.packages)
    }

    fn deploy_generation(
        &self,
        current: policy::ManagedDeployment,
        policy_sha256: String,
        packages: Vec<policy::DeployedPackage>,
    ) -> Result<Value> {
        let next = policy::ManagedDeployment {
            generation: current.generation + 1,
            policy_sha256,
            packages,
            previous: Some(Box::new(policy::ManagedDeployment {
                previous: None,
                ..current
            })),
        };
        self.write("managed.json", &serde_json::to_value(&next)?)?;
        let packages = next
            .packages
            .iter()
            .map(|package| json!({"id": package.id, "version": package.version, "sha256": package.sha256}))
            .collect::<Vec<_>>();
        let _ = self.record_security_event(
            "managed_deploy",
            json!({"generation": next.generation, "packages": packages}),
        );
        Ok(json!({"generation": next.generation, "changed": true, "packages": next.packages}))
    }

    fn deploy(
        &self,
        entry: &policy::ManagedPackage,
        managed: &policy::Managed,
        index: &std::result::Result<Option<PathBuf>, String>,
        offline: bool,
    ) -> Result<Vec<policy::DeployedPackage>> {
        let cached = self
            .root
            .join("package-cache")
            .join(&entry.id)
            .join(&entry.sha256);
        if let Ok(path) = cached.canonicalize()
            && let Ok((package, _, sha256)) = store::package(&path)
            && sha256 == entry.sha256
            && package.dependencies.is_empty()
        {
            if !package.lifecycle.is_empty() {
                return Err(lifecycle_refused(&entry.id));
            }
            return Ok(vec![policy::DeployedPackage {
                id: package.id,
                version: package.version,
                sha256,
                path,
                dependencies: Vec::new(),
            }]);
        }
        let mut errors = Vec::new();
        for reference in std::iter::once(&entry.source).chain(&entry.mirrors) {
            let indexed = !(reference.starts_with('/')
                || reference.starts_with("npm:")
                || reference.starts_with("git+"));
            let attempt = match index {
                Err(error) if indexed => Err(failure(error)),
                index => self.deploy_from(
                    reference,
                    entry,
                    managed,
                    index.clone().ok().flatten(),
                    offline,
                ),
            };
            match attempt {
                Ok(packages) => return Ok(packages),
                Err(error) => errors.push(format!("{reference}: {error}")),
            }
        }
        Err(failure(errors.join("; ")))
    }

    fn deploy_from(
        &self,
        reference: &str,
        entry: &policy::ManagedPackage,
        managed: &policy::Managed,
        index: Option<PathBuf>,
        offline: bool,
    ) -> Result<Vec<policy::DeployedPackage>> {
        let mut source = ModPackageSource::parse(reference, index.clone())?;
        if !entry.version.is_empty()
            && matches!(
                source,
                ModPackageSource::Package { .. } | ModPackageSource::Npm { .. }
            )
        {
            source = source.with_version(&entry.version)?;
        }
        if let (ModPackageSource::Npm { registry, .. }, Some(admin)) =
            (&mut source, &managed.policy.registry)
            && registry.is_empty()
        {
            registry.clone_from(admin);
        }
        let grant = |package: &policy::ManagedPackage| ModPackageGrant {
            capabilities: package.capabilities.clone(),
            dependencies: package.dependencies,
            lifecycle: Vec::new(),
            secret_environment: package.secret_environment.clone(),
        };
        let mut packages: BTreeMap<String, ModPackageGrant> = managed
            .policy
            .packages
            .iter()
            .rev()
            .map(|package| (package.id.clone(), grant(package)))
            .collect();
        packages.insert(entry.id.clone(), grant(entry));
        let request = ModInstallRequest {
            action: None,
            source,
            index,
            scope: "user".to_owned(),
            offline,
            trust: ModPackageTrust { packages },
            settings: BTreeMap::from([(entry.id.clone(), entry.settings.clone())]),
        };
        let plan = self
            .package_plan_locked(request, false, Some(entry))
            .map_err(|error| {
                match error
                    .to_string()
                    .strip_prefix("explicit_exact_lifecycle_trust_required: ")
                {
                    Some(id) => lifecycle_refused(id),
                    None => error,
                }
            })?;
        if !plan
            .packages
            .iter()
            .any(|locked| locked.id == entry.id && locked.integrity == entry.sha256)
        {
            return Err(failure(format!(
                "managed_integrity_mismatch: {reference} does not hold the {} content administrator policy pins",
                entry.id
            )));
        }
        plan.packages
            .iter()
            .map(|locked| {
                if !managed
                    .policy
                    .packages
                    .iter()
                    .any(|listed| listed.id == locked.id && listed.sha256 == locked.integrity)
                {
                    return Err(failure(format!(
                        "managed_integrity_mismatch: dependency {} {} is not pinned by administrator policy",
                        locked.id, locked.integrity
                    )));
                }
                Ok(policy::DeployedPackage {
                    id: locked.id.clone(),
                    version: locked.version.clone(),
                    sha256: locked.integrity.clone(),
                    path: locked.cache_path.clone(),
                    dependencies: locked
                        .dependencies
                        .iter()
                        .filter_map(|dependency| {
                            plan.packages
                                .iter()
                                .find(|resolved| resolved.id == dependency.id)
                                .map(|resolved| resolved.integrity.clone())
                        })
                        .collect(),
                })
            })
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    fn resolve_requested(
        &self,
        source: &ModPackageSource,
        requirement: Option<(&str, &str)>,
        request: &ModInstallRequest,
        lock: &ModPackageLock,
        resolved: &mut BTreeMap<String, ResolvedPackage>,
        visiting: &mut Vec<String>,
        inspect: bool,
    ) -> Result<ResolvedPackage> {
        let (path, normalized_source, expected_integrity) =
            self.materialize_source(source, request.offline, lock)?;
        let staged =
            path.starts_with(&self.root) && !path.starts_with(self.root.join("package-cache"));
        let result = self.resolve_materialized(
            path.clone(),
            normalized_source,
            expected_integrity,
            requirement,
            request,
            lock,
            resolved,
            visiting,
            inspect,
        );
        if result.is_err() && staged {
            let _ = std::fs::remove_dir_all(&path);
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn resolve_materialized(
        &self,
        path: PathBuf,
        normalized_source: ModPackageSource,
        expected_integrity: Option<String>,
        requirement: Option<(&str, &str)>,
        request: &ModInstallRequest,
        lock: &ModPackageLock,
        resolved: &mut BTreeMap<String, ResolvedPackage>,
        visiting: &mut Vec<String>,
        inspect: bool,
    ) -> Result<ResolvedPackage> {
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
        let declared = ModPackageGrant {
            capabilities: package.capabilities.clone(),
            dependencies: !package.dependencies.is_empty(),
            lifecycle: package.lifecycle.keys().cloned().collect(),
            secret_environment: package.secret_environment(),
        };
        let grant = match request.trust.packages.get(&package.id) {
            Some(grant) => grant.clone(),
            None if inspect => declared,
            None => return Err(failure(format!("package_trust_required: {}", package.id))),
        };
        if grant.capabilities != package.capabilities {
            return Err(failure(format!(
                "explicit_exact_capability_grant_required: {}",
                package.id
            )));
        }
        super::check_secret_environment(&package, &grant.secret_environment)?;
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
            authority: {
                let mut authority = json!({"exposure":authority_exposure(&package.capabilities),
                    "os_access":package.os_access,"approves":package.approves,"http_access":package.http_access,
                    "fs_access":package.fs_access,"mcp_servers":package.mcp_servers,"policy":package.policy,
                    "peer_access":package.peer_access,"autonomy":package.autonomy});
                if !package.codex_config.is_empty() {
                    authority["codex_config"] = json!(package.codex_config);
                }
                authority
            },
            exec_environment: package.exec_environment.clone(),
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
                lock,
                resolved,
                visiting,
                inspect,
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
        lock: &ModPackageLock,
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
                let commit =
                    revision.len() == 40 && revision.bytes().all(|byte| byte.is_ascii_hexdigit());
                if !(commit || git_reference(revision))
                    || repository.is_empty()
                    || repository.len() > 2048
                    || repository.starts_with('-')
                    || !package_directory(subdirectory)
                {
                    return Err(failure("repository_reference_invalid"));
                }
                let local = PathBuf::from(repository);
                let (repository_path, repository_source, _repository_view) = if local.exists() {
                    let path = local.canonicalize()?;
                    let source = path.display().to_string();
                    (path, source, None)
                } else {
                    if offline && !commit {
                        return Err(failure(
                            "repository_reference_requires_network: pin a commit for offline installs",
                        ));
                    }
                    if offline
                        && let Some(package) = lock.packages.values().find(|package| {
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
                    if offline && !cached.exists() {
                        return Err(failure("repository_unavailable_offline_and_not_cached"));
                    }
                    let view =
                        repository_view(&repositories, &cached, repository, revision, offline)?;
                    (view.path().to_path_buf(), repository.clone(), Some(view))
                };
                let revision = if commit {
                    revision.to_lowercase()
                } else {
                    let target = if local.exists() {
                        format!("{revision}^{{commit}}")
                    } else {
                        "FETCH_HEAD^{commit}".to_owned()
                    };
                    git(
                        &repository_path,
                        &["rev-parse", "--verify", "--end-of-options", &target],
                    )?
                    .trim()
                    .to_owned()
                };
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
                    let manifest = git_blob(
                        &repository_path,
                        &format!("{revision}:{prefix}mod.json"),
                        8192,
                    )?;
                    std::fs::write(staging.join("mod.json"), &manifest)?;
                    let package: ModPackage = serde_json::from_slice(&manifest)?;
                    package.validate()?;
                    for path in std::iter::once(&package.entrypoint)
                        .chain(package.lifecycle.values())
                        .chain(package.assets.iter())
                    {
                        let bytes = git_blob(
                            &repository_path,
                            &format!("{revision}:{prefix}{path}"),
                            store::PACKAGE_FILE_LIMIT as usize,
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
                            lock.packages.values().find(|package| {
                                matches!(&package.source,
                                    ModPackageSource::Package { index: locked_index, id: locked_id, version: locked_version }
                                    if locked_index == index && locked_id == id
                                        && release_matches(version, locked_version))
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
                let index_value = read_index(&index_path)?;
                let releases = index_value
                    .packages
                    .get(id)
                    .ok_or_else(|| failure("package_unavailable"))?;
                let candidates = releases
                    .iter()
                    .filter(|release| release_matches(version, &release.version));
                let release = candidates
                    .clone()
                    .filter(|release| release.blocked.is_none())
                    .max_by_key(|release| SemanticVersion::parse(&release.version))
                    .ok_or_else(|| {
                        match candidates
                            .filter_map(|release| release.blocked.as_deref())
                            .next()
                        {
                            Some(reason) => failure(format!("package_version_blocked: {reason}")),
                            None => failure("package_version_unavailable"),
                        }
                    })?;
                let (path, resolved, actual_expected) =
                    self.materialize_source(&release.source, offline, lock)?;
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
            ModPackageSource::Npm {
                package,
                version,
                registry,
                integrity,
            } => self.materialize_npm(package, version, registry, integrity, offline, lock),
        }
    }

    fn materialize_npm(
        &self,
        package: &str,
        requirement: &str,
        registry: &str,
        pinned: &str,
        offline: bool,
        lock: &ModPackageLock,
    ) -> Result<(PathBuf, ModPackageSource, Option<String>)> {
        let config = NpmConfig::load();
        let registry = if registry.is_empty() {
            config.registry(package)
        } else {
            registry.trim_end_matches('/').to_owned()
        };
        let registry = registry.as_str();
        if !npm_name(package)
            || !version_selector(requirement)
            || !npm_url(registry)
            || !(pinned.is_empty() || pinned.starts_with("sha512-"))
        {
            return Err(failure("npm_reference_invalid"));
        }
        if offline {
            let package = lock
                .packages
                .values()
                .chain(lock.history.values().flatten())
                .find(|locked| {
                    matches!(&locked.source, ModPackageSource::Npm {
                        package: name, version, registry: origin, integrity }
                        if name == package && origin == registry
                            && (pinned.is_empty() || pinned == integrity)
                            && release_matches(requirement, version))
                        && locked.cache_path.exists()
                })
                .ok_or_else(|| failure("npm_package_unavailable_offline_and_not_cached"))?;
            return Ok((
                package.cache_path.canonicalize()?,
                package.source.clone(),
                Some(package.integrity.clone()),
            ));
        }
        let metadata_url = format!("{registry}/{}", package.replace('/', "%2f"));
        let metadata: Value = serde_json::from_slice(&npm_fetch(
            &metadata_url,
            NPM_METADATA_LIMIT,
            "application/vnd.npm.install-v1+json",
            config.token(&metadata_url),
        )?)
        .map_err(|_| failure("npm_metadata_invalid"))?;
        let exact = if requirement.is_empty() {
            metadata["dist-tags"]["latest"]
                .as_str()
                .ok_or_else(|| failure("npm_version_unavailable"))?
                .to_owned()
        } else {
            metadata["versions"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(version, _)| version)
                .filter(|version| release_matches(requirement, version))
                .max_by_key(|version| SemanticVersion::parse(version))
                .cloned()
                .ok_or_else(|| failure("npm_version_unavailable"))?
        };
        let dist = &metadata["versions"][&exact]["dist"];
        let tarball = dist["tarball"]
            .as_str()
            .filter(|tarball| npm_url(tarball))
            .ok_or_else(|| failure("npm_tarball_unavailable"))?;
        let expected = dist["integrity"]
            .as_str()
            .and_then(|value| {
                value
                    .split_whitespace()
                    .find(|hash| hash.starts_with("sha512-"))
            })
            .ok_or_else(|| {
                failure("npm_integrity_required: the registry lists no sha512 integrity")
            })?
            .to_owned();
        if !pinned.is_empty() && pinned != expected {
            return Err(failure(
                "npm_integrity_changed: the registry now serves different content",
            ));
        }
        let staging = self.root.join(format!(
            ".npm-{}.{}.tmp",
            &digest(expected.as_bytes())[..12],
            std::process::id()
        ));
        if staging.exists() {
            return Err(failure("stale_npm_staging_directory"));
        }
        std::fs::create_dir(&staging)?;
        let result = (|| {
            let archive = npm_fetch(
                tarball,
                NPM_TARBALL_LIMIT,
                "application/octet-stream",
                config.token(tarball),
            )?;
            if npm_integrity(&archive) != expected {
                return Err(failure("npm_tarball_integrity_failure"));
            }
            let archive_path = self.root.join(format!(
                ".npm-{}.{}.tgz",
                &digest(expected.as_bytes())[..12],
                std::process::id()
            ));
            std::fs::write(&archive_path, &archive)?;
            let files = npm_archive_files(&archive_path);
            let _ = std::fs::remove_file(&archive_path);
            let files = files?;
            let manifest: Value = serde_json::from_slice(
                files
                    .get("package.json")
                    .ok_or_else(|| failure("npm_package_json_missing"))?,
            )
            .map_err(|_| failure("npm_package_json_invalid"))?;
            if manifest["name"] != package || manifest["version"] != exact.as_str() {
                return Err(failure("npm_package_identity_mismatch"));
            }
            if manifest["dependencies"]
                .as_object()
                .is_some_and(|dependencies| !dependencies.is_empty())
            {
                return Err(failure(
                    "npm_runtime_dependencies_unsupported: bundle dependencies into the mod entrypoint",
                ));
            }
            let mod_manifest = files.get("mod.json").ok_or_else(|| {
                failure("npm_mod_manifest_missing: publish mod.json in the package")
            })?;
            let mod_package: ModPackage = serde_json::from_slice(mod_manifest)?;
            mod_package.validate()?;
            if mod_package.version != exact {
                return Err(failure(
                    "npm_mod_version_mismatch: mod.json and package.json versions differ",
                ));
            }
            for relative in std::iter::once("mod.json")
                .chain(std::iter::once(mod_package.entrypoint.as_str()))
                .chain(mod_package.lifecycle.values().map(String::as_str))
                .chain(mod_package.assets.iter().map(String::as_str))
            {
                let bytes = files
                    .get(relative)
                    .ok_or_else(|| failure(format!("npm_package_file_missing: {relative}")))?;
                let target = staging.join(relative);
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(target, bytes)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
        Ok((
            staging,
            ModPackageSource::Npm {
                package: package.to_owned(),
                version: exact,
                registry: registry.to_owned(),
                integrity: expected,
            },
            None,
        ))
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
            copy_file(
                source,
                &staging,
                &package.entrypoint,
                store::PACKAGE_FILE_LIMIT,
            )?;
            for asset in &package.assets {
                copy_file(source, &staging, asset, store::PACKAGE_FILE_LIMIT)?;
            }
            for script in package.lifecycle.values() {
                copy_file(source, &staging, script, store::PACKAGE_FILE_LIMIT)?;
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
            if event == "uninstall" {
                return Ok(());
            }
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
        let source = String::from_utf8(store::package_read(
            &package.path,
            script,
            store::PACKAGE_FILE_LIMIT,
        )?)
        .map_err(failure)?;
        self.verified_runner()?;
        let request = json!({"source":source,"filename":script,"adapter":null,"event":"inspect",
            "name":event,"payload":null,"state":null,"settings":{"event":event,"package":package.id,
                "version":package.version,"integrity":package.integrity},"capabilities":[],"environment":[],
            "hook_budget_ms":1000,"receipts":[],"field_policies":{},"virtual_time_ms":null});
        process::evaluate(
            &request,
            std::time::Duration::from_secs(1),
            &|| true,
            &mut |_| Err(failure("host_operation_unavailable")),
        )?;
        let _ = self.record_security_event(
            "lifecycle",
            json!({"package": package_event(package), "script": event}),
        );
        Ok(())
    }
}

fn lifecycle_refused(id: &str) -> std::io::Error {
    failure(format!(
        "managed_lifecycle_requires_approval: {id} runs install scripts; install it interactively"
    ))
}

fn copy_file(source: &Path, destination: &Path, relative: &str, limit: u64) -> Result<()> {
    let bytes = store::package_read(source, relative, limit)?;
    let target = destination.join(relative);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(target, bytes)
}

fn repository_view(
    repositories: &Path,
    cached: &Path,
    repository: &str,
    revision: &str,
    offline: bool,
) -> Result<tempfile::TempDir> {
    std::fs::create_dir_all(cached.join("objects"))?;
    let fresh = || -> Result<tempfile::TempDir> {
        let view = tempfile::tempdir_in(repositories)?;
        git(
            repositories,
            &[
                "init",
                "--bare",
                "--template=",
                &view.path().display().to_string(),
            ],
        )?;
        Ok(view)
    };
    let view = fresh()?;
    std::fs::remove_dir_all(view.path().join("objects"))?;
    std::os::unix::fs::symlink(cached.join("objects"), view.path().join("objects"))?;
    if !offline {
        let fetched = fresh()?;
        // A stalled transfer under the store lock gives up after 30 s below 1 byte/s.
        git(
            fetched.path(),
            &[
                "-c",
                "http.lowSpeedLimit=1",
                "-c",
                "http.lowSpeedTime=30",
                "fetch",
                "--force",
                "--no-tags",
                "--",
                repository,
                &format!("{revision}:refs/heads/pinned"),
            ],
        )?;
        git(
            view.path(),
            &[
                "fetch",
                "--force",
                "--no-tags",
                "--",
                &fetched.path().display().to_string(),
                "refs/heads/pinned",
            ],
        )?;
        return Ok(fetched);
    }
    Ok(view)
}

fn git(repository: &Path, arguments: &[&str]) -> Result<String> {
    String::from_utf8(git_bytes(repository, arguments)?).map_err(failure)
}

fn git_command(repository: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("--no-replace-objects")
        .arg("-C")
        .arg(repository)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
    command
}

fn git_blob(repository: &Path, object: &str, limit: usize) -> Result<Vec<u8>> {
    bounded_output(
        git_command(repository).args(["show", object]),
        None,
        limit,
        "repository_read_failed",
    )
}

fn git_bytes(repository: &Path, arguments: &[&str]) -> Result<Vec<u8>> {
    let output = git_command(repository).args(arguments).output()?;
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
        return Err(failure(format!(
            "repository_provenance_mismatch: mod.json provenance.source is {:?}; this install needs {repository:?}",
            provenance.source
        )));
    }
    Ok(())
}

fn package_event(package: &ModLockedPackage) -> Value {
    json!({"id": package.id, "version": package.version, "integrity": package.integrity,
        "scope": package.scope, "source": redacted_source(&package.source),
        "capabilities": package.trust.capabilities, "enabled": package.enabled})
}

pub(super) fn redacted_source(source: &ModPackageSource) -> Value {
    let url = |value: &str| {
        let value = value.split(['?', '#']).next().unwrap_or_default();
        match value.split_once("://") {
            Some((scheme, rest)) => format!(
                "{scheme}://{}",
                rest.rsplit_once('@')
                    .filter(|(userinfo, _)| !userinfo.contains('/'))
                    .map_or(rest, |(_, host)| host)
            ),
            None => value.to_owned(),
        }
    };
    match source {
        ModPackageSource::Repository {
            repository,
            revision,
            subdirectory,
        } => json!({"kind": "repository", "repository": url(repository), "revision": revision,
            "subdirectory": subdirectory}),
        ModPackageSource::Npm {
            package,
            version,
            registry,
            integrity,
        } => json!({"kind": "npm", "package": package, "version": version,
            "registry": url(registry), "integrity": integrity}),
        source => json!(source),
    }
}

pub(super) fn error_code(error: &io::Error) -> String {
    let message = error.to_string();
    message
        .split(':')
        .next()
        .unwrap_or_default()
        .chars()
        .take(96)
        .collect()
}

fn same_approval(previous: &ModLockedPackage, next: &ModLockedPackage) -> bool {
    previous.trust == next.trust
        && previous.authority == next.authority
        && previous.exec_environment == next.exec_environment
        && same_origin(&previous.source, &next.source)
}

fn same_origin(previous: &ModPackageSource, next: &ModPackageSource) -> bool {
    match (previous, next) {
        (ModPackageSource::Local { path: a }, ModPackageSource::Local { path: b }) => a == b,
        (
            ModPackageSource::Repository {
                repository: a,
                subdirectory: c,
                ..
            },
            ModPackageSource::Repository {
                repository: b,
                subdirectory: d,
                ..
            },
        ) => a == b && c == d,
        (
            ModPackageSource::Package {
                index: a, id: c, ..
            },
            ModPackageSource::Package {
                index: b, id: d, ..
            },
        ) => a == b && c == d,
        (
            ModPackageSource::Npm {
                package: a,
                registry: c,
                ..
            },
            ModPackageSource::Npm {
                package: b,
                registry: d,
                ..
            },
        ) => a == b && c == d,
        _ => false,
    }
}

fn release_matches(requirement: &str, version: &str) -> bool {
    requirement.is_empty()
        || requirement == version
        || service_version_satisfies(requirement, version)
}

fn version_selector(value: &str) -> bool {
    value.is_empty()
        || (value.len() <= 64
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+' | b'^')
            }))
}

fn git_reference(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.starts_with(['-', '/', '.'])
        && !value.ends_with(['/', '.'])
        && !value.contains("..")
        && !value.contains("//")
        && !value.ends_with(".lock")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
}

fn npm_name(value: &str) -> bool {
    let name = |part: &str| {
        !part.is_empty()
            && !part.starts_with(['.', '_'])
            && part.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'-' | b'.' | b'_' | b'~')
            })
    };
    value.len() <= 214
        && match value.strip_prefix('@').map(|rest| rest.split_once('/')) {
            Some(Some((scope, package))) => name(scope) && name(package),
            Some(None) => false,
            None => name(value),
        }
}

fn npm_url(value: &str) -> bool {
    value.len() <= 2048
        && !value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        && (value.starts_with("https://")
            || ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"]
                .iter()
                .any(|prefix| value.starts_with(prefix)))
}

fn npm_integrity(bytes: &[u8]) -> String {
    use base64::Engine;
    format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(sha2::Sha512::digest(bytes))
    )
}

fn bounded_output(
    command: &mut Command,
    input: Option<String>,
    limit: usize,
    code: &str,
) -> Result<Vec<u8>> {
    let mut child = command
        .stdin(if input.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    let mut bytes = Vec::new();
    let read = (|| {
        if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
            std::io::Write::write_all(&mut stdin, input.as_bytes())?;
        }
        child
            .stdout
            .take()
            .ok_or_else(|| failure(code))?
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
    })();
    if read.is_err() || bytes.len() > limit {
        let _ = child.kill();
        let _ = child.wait();
        read?;
        return Err(failure(format!("{code}: larger than {limit} bytes")));
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(failure(format!(
            "{code}: {}",
            String::from_utf8_lossy(&output.stderr)
                .trim()
                .chars()
                .take(256)
                .collect::<String>()
        )));
    }
    Ok(bytes)
}

fn npm_fetch(url: &str, limit: usize, accept: &str, token: Option<&str>) -> Result<Vec<u8>> {
    if token.is_some_and(|token| {
        token
            .chars()
            .any(|character| character == '"' || character == '\\' || character.is_control())
    }) {
        return Err(failure("npm_token_invalid: check _authToken in .npmrc"));
    }
    let mut command = Command::new("/usr/bin/curl");
    command.env_clear().env("PATH", "/usr/bin:/bin").envs(
        [
            "HTTPS_PROXY",
            "https_proxy",
            "HTTP_PROXY",
            "http_proxy",
            "ALL_PROXY",
            "all_proxy",
            "NO_PROXY",
            "no_proxy",
        ]
        .iter()
        .filter_map(|name| Some((*name, std::env::var_os(name)?))),
    );
    if token.is_some() {
        command.args(["--config", "-"]);
    }
    bounded_output(
        command
            .args([
                "--silent",
                "--show-error",
                "--fail",
                "--location",
                "--max-redirs",
                "3",
                "--proto",
                "=https,http",
                "--proto-redir",
                "=https",
                "--connect-timeout",
                "20",
                "--max-time",
                "120",
                "--header",
            ])
            .arg(format!("Accept: {accept}"))
            .arg(url),
        token.map(|token| format!("header = \"Authorization: Bearer {token}\"\n")),
        limit,
        "npm_fetch_failed",
    )
}

fn npm_archive_files(archive: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    let tar = bounded_output(
        Command::new("/usr/bin/gzip")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .arg("-dc")
            .arg(archive),
        None,
        NPM_UNPACKED_LIMIT,
        "npm_archive_invalid",
    )?;
    let field = |bytes: &[u8]| {
        String::from_utf8_lossy(
            &bytes[..bytes
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(bytes.len())],
        )
        .into_owned()
    };
    let mut files = BTreeMap::new();
    let mut offset = 0;
    let mut long_name = None;
    while offset + 512 <= tar.len() {
        let header = &tar[offset..offset + 512];
        if header.iter().all(|byte| *byte == 0) {
            break;
        }
        let size = usize::from_str_radix(field(&header[124..136]).trim(), 8)
            .map_err(|_| failure("npm_archive_invalid: entry size"))?;
        let start = offset + 512;
        let end = start
            .checked_add(size)
            .filter(|end| *end <= tar.len())
            .ok_or_else(|| failure("npm_archive_invalid: truncated"))?;
        let data = &tar[start..end];
        offset = start + size.div_ceil(512) * 512;
        let name = long_name.take().unwrap_or_else(|| {
            let prefix = field(&header[345..500]);
            let name = field(&header[..100]);
            if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            }
        });
        match header[156] {
            b'x' => {
                long_name = String::from_utf8_lossy(data).lines().find_map(|record| {
                    record
                        .split_once(' ')
                        .and_then(|(_, record)| record.strip_prefix("path="))
                        .map(str::to_owned)
                });
                continue;
            }
            b'L' => {
                long_name = Some(field(data));
                continue;
            }
            b'g' | b'5' => continue,
            b'0' | 0 => {}
            _ => return Err(failure(format!("npm_archive_link_rejected: {name}"))),
        }
        let relative = name
            .split_once('/')
            .map(|(_, relative)| relative)
            .filter(|relative| {
                relative
                    .split('/')
                    .all(|part| !part.is_empty() && part != "." && part != "..")
            })
            .ok_or_else(|| failure(format!("npm_archive_path_rejected: {name}")))?;
        if files.len() >= NPM_ARCHIVE_ENTRIES
            || files.insert(relative.to_owned(), data.to_vec()).is_some()
        {
            return Err(failure(
                "npm_archive_invalid: too many or duplicate entries",
            ));
        }
    }
    Ok(files)
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

fn push_history(
    lock: &mut ModPackageLock,
    id: &str,
    package: ModLockedPackage,
) -> Option<ModLockedPackage> {
    let history = lock.history.entry(id.to_owned()).or_default();
    history.push(package);
    (history.len() > PACKAGE_HISTORY_LIMIT).then(|| history.remove(0))
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

fn package_changes(
    existing: &ModPackageLock,
    packages: &[ModLockedPackage],
    handlers: &BTreeSet<String>,
) -> Value {
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
                "migration_required":previous.is_some_and(|value|value.state_version != package.state_version) && !package.enabled,
                "handler_required":handlers.contains(&package.id)},
            "dependencies":{"from":previous.map(|value|&value.dependencies),"to":package.dependencies},
            "capabilities":{"from":previous.map(|value|&value.capabilities),"to":package.capabilities},
            "authority":{"from":previous.map(|value|&value.authority),"to":package.authority},
            "grant":{"from":previous.map(|value|&value.trust),"to":package.trust},
            "renewed_approval":previous.is_none_or(|value|!same_approval(value, package)),
            "exec_environment":{"from":previous.map(|value|&value.exec_environment),"to":package.exec_environment},
            "secret_environment":{"from":previous.map(|value|&value.trust.secret_environment),"to":package.trust.secret_environment},
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
            "activation".to_owned(),
            json!(
                "installing never enables a package; an update keeps a package on only when its grant, authority, origin and exec environment are unchanged"
            ),
        ),
    ]))
}

fn selected_settings(
    config: &ModConfiguration,
    locked: &ModLockedPackage,
) -> BTreeMap<String, Value> {
    config
        .mods
        .iter()
        .find(|selection| selection.scope == locked.scope && selection.path == locked.path)
        .map_or_else(
            || locked.settings.clone(),
            |selection| selection.settings.clone(),
        )
}

fn require_migration_handlers(plan: &ModPackagePlan, scope: &str) -> Result<()> {
    let changes = plan.changes["packages"]
        .as_array()
        .map_or(&[][..], Vec::as_slice);
    for (locked, change) in plan.packages.iter().zip(changes) {
        if change["state_version"]["handler_required"] != true {
            continue;
        }
        let (package, source, _, assets) = store::package_with_assets(&locked.path)?;
        let state_scope = package.state_scope.clone();
        let selection = ModSelection {
            path: locked.path.clone(),
            sha256: locked.integrity.clone(),
            enabled: false,
            capabilities: package.capabilities.clone(),
            settings: locked.settings.clone(),
            scope: scope.to_owned(),
            secret_environment: Vec::new(),
            expires_at: None,
            tier: None,
            required: false,
        };
        let loaded = packages::detached(package, source, assets, selection, Value::Null);
        packages::migration_registrations(&loaded).map_err(|error| {
            if error.to_string() != "explicit_migration_handler_required" {
                return error;
            }
            failure(format!(
                "migration_handler_required: {} changes its {state_scope} state_version without a migrate handler",
                locked.id
            ))
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod repository_tests {
    use super::*;

    #[test]
    fn npmrc_interpolation_expands_only_original_references_once() {
        let environment = BTreeMap::from([
            ("LITERAL", "${TOKEN}"),
            ("TOKEN", "secret"),
            ("SELF", "${SELF}"),
            ("A", "${B}"),
            ("B", "${A}"),
        ]);
        let resolve = |name: &str| environment.get(name).map(|value| value.to_string());
        for (value, expected) in [
            ("${LITERAL}", "${TOKEN}"),
            ("${TOKEN}-${LITERAL}", "secret-${TOKEN}"),
            ("${MISSING}x${TOKEN}", "xsecret"),
            ("${SELF}", "${SELF}"),
            ("${A}:${B}", "${B}:${A}"),
            ("a${TOKEN}${unclosed", "asecret${unclosed"),
        ] {
            assert_eq!(interpolate(value, resolve), expected, "{value}");
        }
    }

    #[test]
    fn online_repository_content_does_not_trust_cached_objects_or_origins() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let origin = root.join("origin");
        let other = root.join("other");
        for (path, value) in [(&origin, "good"), (&other, "evil")] {
            std::fs::create_dir(path).unwrap();
            std::fs::write(path.join("value"), value).unwrap();
            git(path, &["init"]).unwrap();
            git(path, &["add", "."]).unwrap();
            git(
                path,
                &[
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.com",
                    "commit",
                    "-m",
                    "fixture",
                ],
            )
            .unwrap();
        }
        let revision = git(&origin, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_owned();
        let other_revision = git(&other, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_owned();
        let cached = root.join("cached.git");
        git(
            &root,
            &[
                "clone",
                "--bare",
                "--no-hardlinks",
                origin.to_str().unwrap(),
                cached.to_str().unwrap(),
            ],
        )
        .unwrap();
        git(&cached, &["fetch", other.to_str().unwrap(), "HEAD"]).unwrap();
        git(
            &cached,
            &[
                "config",
                &format!("url.{}.insteadOf", other.display()),
                origin.to_str().unwrap(),
            ],
        )
        .unwrap();
        let blob = git(&origin, &["rev-parse", "HEAD:value"])
            .unwrap()
            .trim()
            .to_owned();
        let other_blob = git(&other, &["rev-parse", "HEAD:value"])
            .unwrap()
            .trim()
            .to_owned();
        std::fs::copy(
            other
                .join(".git/objects")
                .join(&other_blob[..2])
                .join(&other_blob[2..]),
            cached.join("objects").join(&blob[..2]).join(&blob[2..]),
        )
        .unwrap();
        assert!(
            repository_view(
                &root,
                &cached,
                origin.to_str().unwrap(),
                &other_revision,
                false
            )
            .is_err()
        );
        let online =
            repository_view(&root, &cached, origin.to_str().unwrap(), &revision, false).unwrap();
        assert_eq!(
            git_bytes(online.path(), &["show", &format!("{revision}:value")]).unwrap(),
            b"good"
        );
    }
}
