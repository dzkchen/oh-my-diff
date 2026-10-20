use super::*;
use std::os::unix::fs::MetadataExt;

#[cfg(target_os = "macos")]
pub const MANAGED_POLICY_FILE: &str = "/Library/Application Support/OhMyDiff/policy.json";
#[cfg(not(target_os = "macos"))]
pub const MANAGED_POLICY_FILE: &str = "/etc/oh-my-diff/policy.json";
pub const MANAGED_POLICY_KEY: &str = "mods";
pub const MANAGED_SCOPE: &str = "managed";
const MANAGED_POLICY_BYTES: u64 = 65_536;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ManagedUpdates {
    #[default]
    User,
    Managed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ManagedTier {
    Prepend,
    Append,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ManagedPackage {
    pub id: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub version: String,
    pub sha256: String,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub dependencies: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secret_environment: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub settings: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<ManagedTier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub users: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projects: Option<Vec<PathBuf>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mirrors: Vec<String>,
}

/// An immutable package index: the first location holding exactly `sha256` is used.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ManagedIndex {
    pub sha256: String,
    pub locations: Vec<PathBuf>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ManagedPolicy {
    pub schema: u32,
    #[serde(default)]
    pub managed_only: bool,
    #[serde(default = "allowed")]
    pub sideload: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<String>>,
    #[serde(default)]
    pub updates: ManagedUpdates,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deny: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub packages: Vec<ManagedPackage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<ManagedIndex>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry: Option<String>,
}

fn allowed() -> bool {
    true
}

impl ManagedIndex {
    pub fn location(&self) -> Result<PathBuf> {
        self.locations
            .iter()
            .find(|location| {
                store::read(location, 524_288).is_ok_and(|bytes| digest(&bytes) == self.sha256)
            })
            .cloned()
            .ok_or_else(|| {
                failure(format!(
                    "managed_index_unavailable: no location holds index {}",
                    self.sha256
                ))
            })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Managed {
    pub origin: String,
    pub sha256: String,
    pub policy: ManagedPolicy,
}

impl ManagedPolicy {
    pub fn parse(value: Value) -> Result<Self> {
        let policy: Self = serde_json::from_value(value)
            .map_err(|error| failure(format!("managed_policy_invalid: {error}")))?;
        let invalid = |reason: &str| failure(format!("managed_policy_invalid: {reason}"));
        let capabilities = |list: &[String]| {
            list.iter()
                .all(|capability| MOD_CAPABILITIES.contains(&capability.as_str()))
        };
        let sha256 = crate::contract_document::sha256_hex;
        if policy.schema != 1 {
            return Err(invalid("schema must be 1"));
        }
        if policy.index.as_ref().is_some_and(|index| {
            !sha256(&index.sha256)
                || index.locations.is_empty()
                || !index
                    .locations
                    .iter()
                    .all(|location| location.is_absolute())
        }) {
            return Err(invalid("index needs a sha256 and absolute locations"));
        }
        if !policy.deny.iter().all(|id| identifier(id)) {
            return Err(invalid("deny lists mod IDs"));
        }
        if policy
            .sources
            .iter()
            .flatten()
            .any(|source| source.trim().is_empty())
        {
            return Err(invalid("sources are non-empty reference prefixes"));
        }
        if policy
            .capabilities
            .as_ref()
            .is_some_and(|ceiling| !capabilities(ceiling))
        {
            return Err(invalid("capabilities lists host capabilities"));
        }
        for package in &policy.packages {
            if !identifier(&package.id)
                || !sha256(&package.sha256)
                || !capabilities(&package.capabilities)
                || package
                    .percent
                    .is_some_and(|percent| !(1..=100).contains(&percent))
                || package
                    .projects
                    .iter()
                    .flatten()
                    .any(|project| !project.is_absolute())
            {
                return Err(invalid(&format!(
                    "package {} needs an ID, a sha256, host capabilities, absolute projects and percent 1-100",
                    package.id
                )));
            }
        }
        Ok(policy)
    }

    pub fn refusal(
        &self,
        id: &str,
        capabilities: &[String],
        source: Option<&str>,
    ) -> Option<String> {
        if self.deny.iter().any(|denied| denied == id) {
            return Some(format!(
                "managed_denied: {id} is revoked by administrator policy"
            ));
        }
        if self.managed_only {
            return Some(format!(
                "managed_only: administrator policy loads only managed mods, not {id}"
            ));
        }
        if let Some(capability) = self.capabilities.as_ref().and_then(|ceiling| {
            capabilities
                .iter()
                .find(|capability| !ceiling.contains(capability))
        }) {
            return Some(format!(
                "managed_capability_denied: administrator policy withholds {capability} from {id}"
            ));
        }
        match source {
            None if self.sources.is_some() => Some(format!(
                "managed_source_unverified: {id} needs broker-protected package provenance; reinstall from a verified source"
            )),
            None if !self.sideload => Some(format!(
                "managed_sideload_denied: administrator policy loads {id} only from an installed package"
            )),
            Some(source) if !self.source_allowed(source) => Some(format!(
                "managed_source_denied: administrator policy does not allow {source}"
            )),
            _ => None,
        }
    }

    pub fn install_refusal(
        &self,
        id: &str,
        capabilities: &[String],
        source: &str,
        update: bool,
    ) -> Option<String> {
        if update && self.updates == ManagedUpdates::Managed {
            return Some(format!(
                "managed_updates_denied: administrator policy manages package versions; {id} stays as installed"
            ));
        }
        self.refusal(id, capabilities, Some(source))
    }

    pub fn source_allowed(&self, reference: &str) -> bool {
        if reference.split('/').any(|segment| {
            let segment = segment.to_ascii_lowercase().replace("%2e", ".");
            segment == "."
                || segment == ".."
                || segment.contains("%2f")
                || segment.contains("%5c")
                || segment.contains('\\')
        }) {
            return false;
        }
        self.sources.as_ref().is_none_or(|allowed| {
            allowed.iter().any(|prefix| {
                reference == prefix
                    || reference
                        .strip_prefix(prefix.trim_end_matches('/'))
                        .is_some_and(|rest| rest.starts_with('/') || rest.starts_with('#'))
            })
        })
    }
}

pub fn managed(value: Value, origin: String) -> Result<Managed> {
    let sha256 = digest(crate::broker::canonical(&value).as_bytes());
    Ok(Managed {
        origin,
        sha256,
        policy: ManagedPolicy::parse(value)?,
    })
}

/// The administrator policy: the broker's when deployed and set, otherwise the root-owned policy file.
pub fn load_managed() -> Result<Option<Managed>> {
    load_managed_from(Path::new(MANAGED_POLICY_FILE), 0)
}

pub fn load_managed_from(file: &Path, owner: u32) -> Result<Option<Managed>> {
    if crate::broker::deployed() {
        let value = crate::broker::call("policy.get", json!({"key": MANAGED_POLICY_KEY}))?;
        if !value.is_null() {
            return managed(value, "broker".to_owned()).map(Some);
        }
    }
    let canonical = match file.canonicalize() {
        Ok(canonical) => canonical,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let trusted = |path: &Path, folder: bool| {
        std::fs::symlink_metadata(path).is_ok_and(|metadata| {
            (metadata.uid() == 0 || metadata.uid() == owner)
                && (metadata.mode() & 0o022 == 0 || folder && metadata.mode() & 0o1000 != 0)
        })
    };
    if !trusted(&canonical, false)
        || !canonical
            .ancestors()
            .skip(1)
            .all(|folder| trusted(folder, true))
    {
        return Err(failure(format!(
            "managed_policy_untrusted: {} and its folders must be owned by root and writable only by their owner",
            file.display()
        )));
    }
    let value = serde_json::from_slice(&store::read(&canonical, MANAGED_POLICY_BYTES)?)
        .map_err(|error| failure(format!("managed_policy_invalid: {error}")))?;
    managed(value, canonical.display().to_string()).map(Some)
}

pub fn login() -> String {
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buffer = vec![0 as libc::c_char; 4096];
    let mut found = std::ptr::null_mut();
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut entry,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut found,
        )
    };
    if status != 0 || found.is_null() {
        return format!("uid:{}", rustix::process::getuid().as_raw());
    }
    unsafe { std::ffi::CStr::from_ptr(entry.pw_name) }
        .to_string_lossy()
        .into_owned()
}

fn cohort(user: &str, id: &str) -> u8 {
    let hash = digest(format!("{user}\0{id}").as_bytes());
    (u64::from_str_radix(&hash[..8], 16).unwrap_or_default() % 100) as u8
}

impl ManagedPackage {
    pub fn assigned(&self, user: &str) -> bool {
        self.users
            .as_ref()
            .is_none_or(|users| users.iter().any(|name| name == user))
            && self
                .percent
                .is_none_or(|percent| cohort(user, &self.id) < percent)
    }

    pub fn applies(&self, user: &str, project: Option<&Path>) -> bool {
        self.assigned(user)
            && self.projects.as_ref().is_none_or(|projects| {
                project.is_some_and(|project| {
                    projects.iter().any(|root| {
                        project.starts_with(root.canonicalize().as_deref().unwrap_or(root))
                    })
                })
            })
    }
}

/// What `package-sync` last deployed to a store; only fully installed generations are recorded.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ManagedDeployment {
    pub generation: u64,
    pub policy_sha256: String,
    pub packages: Vec<DeployedPackage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<Box<ManagedDeployment>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DeployedPackage {
    pub id: String,
    pub version: String,
    pub sha256: String,
    pub path: PathBuf,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<String>,
}

impl Managed {
    /// The first applicable entry per ID is the target; later entries are fallbacks outside a rollout.
    pub fn targets(&self, user: &str, project: Option<&Path>) -> Vec<&ManagedPackage> {
        let mut seen = BTreeSet::new();
        self.policy
            .packages
            .iter()
            .filter(|package| package.applies(user, project) && seen.insert(package.id.clone()))
            .collect()
    }

    pub fn deployable(&self, user: &str) -> Vec<&ManagedPackage> {
        let mut seen = BTreeSet::new();
        self.policy
            .packages
            .iter()
            .filter(|package| {
                package.assigned(user) && seen.insert((package.id.clone(), package.sha256.clone()))
            })
            .collect()
    }

    /// Each target loads when deployed; otherwise the first applicable deployed entry keeps running until the next sync; deployed dependencies of running entries load under their own policy entry; content the policy no longer lists never loads.
    pub(super) fn selections(
        &self,
        deployment: &ManagedDeployment,
        user: &str,
        project: Option<&Path>,
    ) -> (Vec<ModSelection>, Vec<ModRejection>) {
        let (mut selections, mut pending) = (Vec::new(), Vec::new());
        let selection = |package: &ManagedPackage, deployed: &DeployedPackage| ModSelection {
            path: deployed.path.clone(),
            sha256: deployed.sha256.clone(),
            enabled: true,
            capabilities: package.capabilities.clone(),
            settings: package.settings.clone(),
            scope: MANAGED_SCOPE.to_owned(),
            secret_environment: package.secret_environment.clone(),
            expires_at: None,
            tier: package.tier,
            required: false,
        };
        let targets = self.targets(user, project);
        let mut loading: BTreeSet<&str> = targets.iter().map(|target| target.id.as_str()).collect();
        let mut dependencies = Vec::new();
        let verified_dependencies = |package: &ManagedPackage, deployed: &DeployedPackage| {
            store::package(&deployed.path)
                .ok()
                .filter(|(manifest, _, hash)| {
                    package.dependencies && *hash == package.sha256 && manifest.id == package.id
                })
                .map(|(manifest, _, _)| manifest.dependencies)
                .unwrap_or_default()
        };
        for target in targets {
            let chosen = self
                .policy
                .packages
                .iter()
                .filter(|package| package.id == target.id && package.applies(user, project))
                .find_map(|package| {
                    let deployed = deployment.packages.iter().find(|deployed| {
                        deployed.id == package.id && deployed.sha256 == package.sha256
                    })?;
                    Some((package, deployed))
                });
            if chosen.is_none_or(|(package, _)| package.sha256 != target.sha256) {
                pending.push(ModRejection {
                    path: PathBuf::from(&target.source),
                    id: Some(target.id.clone()),
                    scope: MANAGED_SCOPE.to_owned(),
                    reason: format!(
                        "managed_pending_sync: {} {} is not deployed to this store; run omd-mod package-sync",
                        target.id, target.sha256
                    ),
                });
            }
            if let Some((package, deployed)) = chosen {
                selections.push(selection(package, deployed));
                dependencies.extend(verified_dependencies(package, deployed));
            }
        }
        while let Some(dependency) = dependencies.pop() {
            let Some((package, deployed)) = self.policy.packages.iter().find_map(|package| {
                if package.id != dependency.id {
                    return None;
                }
                let deployed = deployment.packages.iter().find(|deployed| {
                    deployed.id == package.id
                        && deployed.sha256 == package.sha256
                        && store::package(&deployed.path).is_ok_and(|(manifest, _, hash)| {
                            hash == package.sha256
                                && manifest.id == package.id
                                && service_version_satisfies(&dependency.version, &manifest.version)
                        })
                })?;
                Some((package, deployed))
            }) else {
                continue;
            };
            if loading.insert(&package.id) {
                selections.push(selection(package, deployed));
                dependencies.extend(verified_dependencies(package, deployed));
            }
        }
        (selections, pending)
    }
}

pub fn source_reference(source: &package_manager::ModPackageSource) -> String {
    match source {
        package_manager::ModPackageSource::Local { path } => path.display().to_string(),
        package_manager::ModPackageSource::Repository { repository, .. } => {
            format!("git+{repository}")
        }
        package_manager::ModPackageSource::Package { index, id, .. } => {
            format!("index:{}#{id}", index.display())
        }
        package_manager::ModPackageSource::Npm {
            package, registry, ..
        } => format!("npm:{registry}/{package}"),
    }
}
