use crate::AssuranceFloor;
use crate::AssuranceLabel;
use crate::ConfigurationSource;
use crate::ContractOffer;
use crate::LegacyCapabilities;
use crate::OwnerKind;
use crate::PolicyOwner;
use crate::SelectionScope;
use crate::SelectionSource;
use crate::WorkflowContract;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::io;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

pub const SELECTION_LIMIT: u64 = 8192;
pub const USER_SELECTION_FILE: &str = "workflow.json";
pub const PROJECT_SELECTION_FILE: &str = ".codex/workflow.json";

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ContractChoice {
    pub id: String,
    pub version: u32,
}

impl ContractChoice {
    pub fn parse(value: &str) -> io::Result<Self> {
        let (id, version) = value
            .split_once('@')
            .ok_or_else(|| invalid("expected a contract choice as id@version"))?;
        Ok(Self {
            id: id.to_string(),
            version: version
                .parse()
                .map_err(|_| invalid("contract version must be a positive integer"))?,
        })
    }

    pub fn label(&self) -> String {
        format!("{}@{}", self.id, self.version)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SelectionFile {
    pub schema: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract: Option<ContractChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_assurance: Option<AssuranceLabel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmation: Option<String>,
}

impl SelectionFile {
    fn validate(&self, scope: SelectionSource) -> io::Result<()> {
        if self.schema != 1 {
            return Err(invalid("unsupported workflow selection schema"));
        }
        if self.contract.is_none() && self.minimum_assurance.is_none() {
            return Err(invalid("workflow selection file selects nothing"));
        }
        if self.minimum_assurance.is_some() && scope != SelectionSource::ProjectRecommendation {
            return Err(invalid(
                "only a project may declare a minimum assurance floor",
            ));
        }
        if self.confirmation.is_some() && !scope.explicit_user_choice() {
            return Err(invalid(
                "only an explicit user selection may carry a confirmation",
            ));
        }
        if self
            .confirmation
            .as_deref()
            .is_some_and(|token| token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(invalid("workflow confirmation token is malformed"));
        }
        Ok(())
    }
}

pub struct ContractCatalog {
    entries: Vec<(WorkflowContract, PolicyOwner)>,
}

impl Default for ContractCatalog {
    fn default() -> Self {
        Self::bundled()
    }
}

impl ContractCatalog {
    pub fn bundled() -> Self {
        Self {
            entries: WorkflowContract::bundled()
                .into_iter()
                .map(|contract| (contract, PolicyOwner::bundled()))
                .collect(),
        }
    }

    pub fn register(&mut self, contract: WorkflowContract, owner: PolicyOwner) -> io::Result<()> {
        contract.validate()?;
        if owner.kind != OwnerKind::Mod {
            return Err(invalid("a registered contract requires a mod policy owner"));
        }
        if contract.host_owned() {
            return Err(invalid(
                "a registered contract may not shadow a host-owned contract",
            ));
        }
        if self.entries.len() >= 8 {
            return Err(invalid("registered workflow contract limit"));
        }
        if self.entries.iter().any(|(existing, existing_owner)| {
            existing.id == contract.id && *existing_owner != owner
        }) {
            return Err(invalid(
                "workflow replacement conflict: two owners registered the same contract",
            ));
        }
        if self
            .entries
            .iter()
            .any(|(existing, _)| existing.id == contract.id && existing.version == contract.version)
        {
            return Err(invalid("duplicate workflow contract registration"));
        }
        self.entries.push((contract, owner));
        Ok(())
    }

    pub fn get(&self, choice: &ContractChoice) -> io::Result<(WorkflowContract, PolicyOwner)> {
        self.entries
            .iter()
            .find(|(contract, _)| contract.id == choice.id && contract.version == choice.version)
            .map(|(contract, owner)| (contract.clone(), owner.clone()))
            .ok_or_else(|| {
                invalid(&format!(
                    "unknown workflow contract {}; the prior contract is retained",
                    choice.label()
                ))
            })
    }

    pub fn list(&self) -> io::Result<serde_json::Value> {
        let entries = self
            .entries
            .iter()
            .map(|(contract, owner)| {
                Ok(serde_json::json!({
                    "choice": ContractChoice { id: contract.id.clone(), version: contract.version },
                    "contract": contract.summary()?,
                    "requirements": contract.requirements,
                    "owner": owner,
                    "bundled_default": *contract == WorkflowContract::bundled_default(),
                }))
            })
            .collect::<io::Result<Vec<_>>>()?;
        Ok(serde_json::json!({
            "schema": 1,
            "api": crate::CONTRACT_SCHEMA,
            "contracts": entries,
        }))
    }
}

pub fn read_selection(path: &Path, scope: SelectionSource) -> io::Result<(SelectionFile, String)> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid("workflow selection must be a regular file"));
    }
    let mut bytes = Vec::new();
    file.take(SELECTION_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > SELECTION_LIMIT {
        return Err(invalid("workflow selection file exceeds its bound"));
    }
    let selection: SelectionFile = serde_json::from_slice(&bytes)?;
    selection.validate(scope)?;
    Ok((selection, digest(&bytes)))
}

#[derive(Debug)]
pub struct Selections {
    pub offers: Vec<ContractOffer>,
    pub floor: Option<AssuranceFloor>,
    pub confirmation: Option<String>,
}

pub fn collect(
    catalog: &ContractCatalog,
    legacy: Option<LegacyCapabilities>,
    user: Option<&Path>,
    project: Option<&Path>,
    task: Option<&ContractChoice>,
) -> io::Result<Selections> {
    let mut offers = vec![ContractOffer {
        source: SelectionSource::Bundle,
        scope: SelectionScope::Session,
        contract: WorkflowContract::bundled_default(),
        configuration: ConfigurationSource {
            scope: SelectionSource::Bundle,
            path: None,
            sha256: digest(crate::PINNED_UPSTREAM.as_bytes()),
        },
        owner: PolicyOwner::bundled(),
    }];
    let mut floor = None;
    let mut confirmation = None;
    if let Some(capabilities) = legacy {
        let contract = WorkflowContract::from_legacy(capabilities)?;
        if contract != WorkflowContract::bundled_default() {
            offers.push(ContractOffer {
                source: SelectionSource::LegacyManifest,
                scope: SelectionScope::Task,
                contract,
                configuration: ConfigurationSource {
                    scope: SelectionSource::LegacyManifest,
                    path: None,
                    sha256: digest(&serde_json::to_vec(&capabilities)?),
                },
                owner: PolicyOwner::bundled(),
            });
        }
    }
    for (path, source) in [
        (project, SelectionSource::ProjectRecommendation),
        (user, SelectionSource::UserDefault),
    ] {
        let Some(path) = path else { continue };
        if !path.exists() {
            continue;
        }
        let (selection, sha256) = read_selection(path, source)?;
        let configuration = ConfigurationSource {
            scope: source,
            path: Some(path.display().to_string()),
            sha256,
        };
        if let Some(minimum) = selection.minimum_assurance {
            floor = Some(AssuranceFloor {
                source,
                minimum,
                configuration: configuration.clone(),
            });
        }
        if let Some(choice) = &selection.contract {
            let (contract, owner) = catalog.get(choice)?;
            offers.push(ContractOffer {
                source,
                scope: SelectionScope::Session,
                contract,
                configuration,
                owner,
            });
        }
        if source == SelectionSource::UserDefault {
            confirmation = selection.confirmation;
        }
    }
    if let Some(choice) = task {
        let (contract, owner) = catalog.get(choice)?;
        offers.push(ContractOffer {
            source: SelectionSource::TaskSelection,
            scope: SelectionScope::Task,
            contract,
            configuration: ConfigurationSource {
                scope: SelectionSource::TaskSelection,
                path: None,
                sha256: digest(choice.label().as_bytes()),
            },
            owner,
        });
    }
    let sources = offers
        .iter()
        .map(|offer| offer.source)
        .collect::<BTreeSet<_>>();
    if sources.len() != offers.len() {
        return Err(invalid(
            "conflicting workflow selections; resolve them before activation",
        ));
    }
    Ok(Selections {
        offers,
        floor,
        confirmation,
    })
}

pub fn write_selection(
    path: &Path,
    selection: &SelectionFile,
    scope: SelectionSource,
) -> io::Result<()> {
    selection.validate(scope)?;
    let bytes = serde_json::to_vec_pretty(selection)?;
    if bytes.len() as u64 > SELECTION_LIMIT {
        return Err(invalid("workflow selection exceeds its bound"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| invalid("workflow selection needs a parent directory"))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".workflow.{}.{}.tmp",
        std::process::id(),
        digest(&bytes)
    ));
    let result = (|| {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        std::fs::File::open(parent)?.sync_all()
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

#[cfg(test)]
#[path = "contract_store_tests.rs"]
mod tests;
