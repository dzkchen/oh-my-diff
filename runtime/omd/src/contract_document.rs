use crate::resource_data::ResourceRef;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use std::collections::{BTreeMap, BTreeSet};

pub const CONTRACT_DOCUMENT_SCHEMA: u32 = 2;
const REQUIREMENT_LIMIT: usize = 16;
const FINDING_LIMIT: usize = 32;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, Eq, PartialEq, Ord, PartialOrd)]
#[serde(rename_all = "snake_case")]
pub enum Producer {
    #[default]
    Any,
    Lead,
    SeparateAgent,
    Host,
    Integration,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq, Ord, PartialOrd)]
#[serde(rename_all = "snake_case")]
pub enum Binding {
    Candidate,
    Acceptance,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BlockingFindings {
    #[default]
    Reject,
    Allow,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ContractRequirement {
    pub receipt: String,
    #[serde(default)]
    pub producer: Producer,
    #[serde(default)]
    pub bind: Vec<Binding>,
    #[serde(default)]
    pub blocking_findings: BlockingFindings,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ContractGates {
    #[serde(default)]
    pub complete: Vec<ContractRequirement>,
    #[serde(default)]
    pub integrate: Vec<ContractRequirement>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Gate {
    Complete,
    Integrate,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ContractDocument {
    pub schema: u32,
    pub id: String,
    pub version: u32,
    pub description: String,
    pub assurance: String,
    #[serde(default)]
    pub gates: ContractGates,
    #[serde(default)]
    pub restrict: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptOutcome {
    Pass,
    Fail,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FindingSeverity {
    Advice,
    Warning,
    Blocking,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReceiptFinding {
    pub fingerprint: String,
    pub severity: FindingSeverity,
    pub summary: String,
    #[serde(default)]
    pub paths: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ProducerKind {
    Lead,
    Agent,
    Host,
    Integration,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReceiptProducer {
    pub kind: ProducerKind,
    pub handle: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub kind: String,
    pub candidate_sha256: String,
    #[serde(default)]
    pub acceptance_sha256: Option<String>,
    pub outcome: ReceiptOutcome,
    pub evidence: ResourceRef,
    pub producer: ReceiptProducer,
    #[serde(default)]
    pub findings: Vec<ReceiptFinding>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resolves: Vec<String>,
    pub submitted_by: String,
    pub at: u128,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FindingResolution {
    pub candidate_sha256: String,
    pub producer: ReceiptProducer,
    pub receipt_index: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FindingLedgerEntry {
    pub finding: ReceiptFinding,
    pub reported_candidate_sha256: String,
    pub acceptance_sha256: String,
    pub reported_producer: ReceiptProducer,
    pub report_receipt_index: usize,
    pub resolution: Option<FindingResolution>,
}

pub type FindingLedger = BTreeMap<String, FindingLedgerEntry>;

pub fn token(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-' | b'.')
        })
}

pub fn sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), canonical(&object[key])))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

impl ContractDocument {
    pub fn parse(value: &Value) -> Result<Self, String> {
        let document: Self =
            serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
        document.validate()?;
        Ok(document)
    }

    pub fn key(&self) -> String {
        format!("{}@{}", self.id, self.version)
    }

    pub fn digest(&self) -> String {
        let value = canonical(&serde_json::to_value(self).unwrap_or(Value::Null));
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&value).unwrap_or_default())
        )
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema != CONTRACT_DOCUMENT_SCHEMA
            || !token(&self.id, 64)
            || self.version == 0
            || self.description.trim().is_empty()
            || self.description.len() > 512
            || self.description.chars().any(char::is_control)
            || !token(&self.assurance, 64)
            || self.restrict.len() > 16
            || self.restrict.iter().collect::<BTreeSet<_>>().len() != self.restrict.len()
            || self
                .restrict
                .iter()
                .any(|operation| !crate::MOD_HOST_OPERATIONS.contains(&operation.as_str()))
        {
            return Err("invalid_contract_document".into());
        }
        for requirements in [&self.gates.complete, &self.gates.integrate] {
            if requirements.len() > REQUIREMENT_LIMIT
                || requirements
                    .iter()
                    .map(|r| &r.receipt)
                    .collect::<BTreeSet<_>>()
                    .len()
                    != requirements.len()
                || requirements.iter().any(|requirement| {
                    !token(&requirement.receipt, 64)
                        || requirement.bind.len() > 2
                        || requirement.bind.iter().collect::<BTreeSet<_>>().len()
                            != requirement.bind.len()
                })
            {
                return Err("invalid_contract_requirements".into());
            }
        }
        Ok(())
    }

    pub fn requirements(&self, gate: Gate) -> &[ContractRequirement] {
        match gate {
            Gate::Complete => &self.gates.complete,
            Gate::Integrate => &self.gates.integrate,
        }
    }

    pub fn weaker_than(&self, other: &ContractDocument) -> bool {
        let covers = |mine: &[ContractRequirement], theirs: &[ContractRequirement]| {
            theirs.iter().all(|required| {
                mine.iter().any(|candidate| {
                    candidate.receipt == required.receipt
                        && (candidate.producer == required.producer
                            || required.producer == Producer::Any)
                        && required
                            .bind
                            .iter()
                            .all(|bind| candidate.bind.contains(bind))
                        && (candidate.blocking_findings == BlockingFindings::Reject
                            || required.blocking_findings == BlockingFindings::Allow)
                })
            })
        };
        !covers(&self.gates.complete, &other.gates.complete)
            || !covers(&self.gates.integrate, &other.gates.integrate)
            || other
                .restrict
                .iter()
                .any(|operation| !self.restrict.contains(operation))
    }

    pub fn missing(
        &self,
        gate: Gate,
        receipts: &[Receipt],
        candidate_sha256: &str,
        acceptance_sha256: Option<&str>,
    ) -> Vec<ContractRequirement> {
        self.requirements(gate)
            .iter()
            .filter(|requirement| {
                !receipts
                    .iter()
                    .rev()
                    .find(|receipt| {
                        receipt.kind == requirement.receipt
                            && (!requirement.bind.contains(&Binding::Candidate)
                                || receipt.candidate_sha256 == candidate_sha256)
                            && (!requirement.bind.contains(&Binding::Acceptance)
                                || acceptance_sha256.is_some()
                                    && receipt.acceptance_sha256.as_deref() == acceptance_sha256)
                            && match requirement.producer {
                                Producer::Any => true,
                                Producer::Lead => receipt.producer.kind == ProducerKind::Lead,
                                Producer::SeparateAgent => {
                                    receipt.producer.kind == ProducerKind::Agent
                                }
                                Producer::Host => receipt.producer.kind == ProducerKind::Host,
                                Producer::Integration => {
                                    receipt.producer.kind == ProducerKind::Integration
                                }
                            }
                    })
                    .is_some_and(|receipt| {
                        receipt.outcome == ReceiptOutcome::Pass
                            && (requirement.blocking_findings == BlockingFindings::Allow
                                || !receipt
                                    .findings
                                    .iter()
                                    .any(|finding| finding.severity == FindingSeverity::Blocking))
                    })
            })
            .cloned()
            .collect()
    }
}

impl Receipt {
    pub fn validate(&self) -> Result<(), String> {
        if !token(&self.kind, 64)
            || !sha256_hex(&self.candidate_sha256)
            || self
                .acceptance_sha256
                .as_deref()
                .is_some_and(|value| !sha256_hex(value))
            || !sha256_hex(&self.evidence.sha256)
            || self.findings.len() > FINDING_LIMIT
            || self.resolves.len() > FINDING_LIMIT
            || self
                .findings
                .iter()
                .map(|finding| &finding.fingerprint)
                .collect::<BTreeSet<_>>()
                .len()
                != self.findings.len()
            || self.resolves.iter().collect::<BTreeSet<_>>().len() != self.resolves.len()
            || self.findings.iter().any(|finding| {
                !token(&finding.fingerprint, 128)
                    || finding.summary.is_empty()
                    || finding.summary.len() > 512
                    || finding.paths.len() > 32
                    || finding
                        .paths
                        .iter()
                        .any(|path| path.is_empty() || path.len() > 1024)
            })
            || self.resolves.iter().any(|fingerprint| {
                !token(fingerprint, 128)
                    || self
                        .findings
                        .iter()
                        .any(|finding| &finding.fingerprint == fingerprint)
            })
            || self
                .findings
                .iter()
                .any(|finding| finding.severity == FindingSeverity::Blocking)
                && self.acceptance_sha256.is_none()
            || !self.resolves.is_empty()
                && (self.outcome != ReceiptOutcome::Pass
                    || self.producer.kind != ProducerKind::Agent
                    || self.acceptance_sha256.is_none())
            || (self.producer.kind == ProducerKind::Agent) != self.producer.handle.is_some()
        {
            return Err("invalid_receipt".into());
        }
        Ok(())
    }
}

pub fn apply_finding_receipt(
    ledger: &mut FindingLedger,
    receipt: &Receipt,
    receipt_index: usize,
) -> Result<(), String> {
    receipt.validate()?;
    for fingerprint in &receipt.resolves {
        let entry = ledger
            .get(fingerprint)
            .ok_or("finding_resolution_unknown")?;
        if entry.resolution.is_some() {
            return Err("finding_already_resolved".into());
        }
        if entry.reported_candidate_sha256 == receipt.candidate_sha256 {
            return Err("finding_resolution_candidate_unchanged".into());
        }
        if receipt.acceptance_sha256.as_deref() != Some(entry.acceptance_sha256.as_str()) {
            return Err("finding_resolution_acceptance_changed".into());
        }
        if entry.reported_producer.kind == ProducerKind::Agent
            && entry.reported_producer.handle == receipt.producer.handle
        {
            return Err("finding_resolution_agent_not_separate".into());
        }
    }
    for fingerprint in &receipt.resolves {
        ledger
            .get_mut(fingerprint)
            .ok_or("finding_resolution_unknown")?
            .resolution = Some(FindingResolution {
            candidate_sha256: receipt.candidate_sha256.clone(),
            producer: receipt.producer.clone(),
            receipt_index,
        });
    }
    for finding in &receipt.findings {
        if finding.severity == FindingSeverity::Blocking {
            if ledger
                .get(&finding.fingerprint)
                .is_some_and(|entry| entry.resolution.is_none())
            {
                continue;
            }
            ledger.insert(
                finding.fingerprint.clone(),
                FindingLedgerEntry {
                    finding: finding.clone(),
                    reported_candidate_sha256: receipt.candidate_sha256.clone(),
                    acceptance_sha256: receipt
                        .acceptance_sha256
                        .clone()
                        .ok_or("finding_acceptance_required")?,
                    reported_producer: receipt.producer.clone(),
                    report_receipt_index: receipt_index,
                    resolution: None,
                },
            );
        }
    }
    Ok(())
}

pub fn replay_finding_receipts(receipts: &[Receipt]) -> Result<FindingLedger, String> {
    let mut ledger = FindingLedger::new();
    for (index, receipt) in receipts.iter().enumerate() {
        apply_finding_receipt(&mut ledger, receipt, index)?;
    }
    Ok(ledger)
}

pub const USER_CONTRACT_SELECTION: &str = "contract-selection.json";
pub const PROJECT_CONTRACT_SELECTION: &str = ".omd/contract-selection.json";
const SELECTION_BYTES: u64 = 16_384;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContractSelection {
    pub schema: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub floor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub floor_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmation: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum ContractResolution {
    None,
    Active {
        document: ContractDocument,
        owner: crate::PolicyOwner,
        source: &'static str,
        overrode: Option<String>,
    },
    Unavailable(String),
}

impl ContractSelection {
    fn validate(&self) -> Result<(), String> {
        let key = |value: &Option<String>| {
            value.as_deref().is_none_or(|key| {
                key.split_once('@').is_some_and(|(id, version)| {
                    token(id, 64) && version.parse::<u32>().is_ok_and(|version| version > 0)
                })
            })
        };
        let digest = |value: &Option<String>| value.as_deref().is_none_or(sha256_hex);
        if self.schema != CONTRACT_DOCUMENT_SCHEMA
            || !key(&self.contract)
            || !key(&self.floor)
            || !digest(&self.contract_digest)
            || !digest(&self.floor_digest)
            || self.contract.is_none() && self.contract_digest.is_some()
            || self.floor.is_none() && self.floor_digest.is_some()
            || self.confirmation.as_deref().is_some_and(|value| {
                value.len() != 16 || !value.bytes().all(|b| b.is_ascii_hexdigit())
            })
        {
            return Err("invalid_contract_selection".into());
        }
        Ok(())
    }

    pub fn read(path: &std::path::Path) -> Result<Option<Self>, String> {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_file() && metadata.len() <= SELECTION_BYTES => {
                let selection: Self = serde_json::from_slice(
                    &std::fs::read(path).map_err(|error| error.to_string())?,
                )
                .map_err(|error| format!("invalid contract selection: {error}"))?;
                selection.validate()?;
                Ok(Some(selection))
            }
            Ok(_) => Err("contract selection must be a bounded regular file".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn write(&self, path: &std::path::Path) -> std::io::Result<()> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        self.validate().map_err(std::io::Error::other)?;
        let bytes = serde_json::to_vec_pretty(self)?;
        let parent = path
            .parent()
            .ok_or_else(|| std::io::Error::other("contract selection needs a parent directory"))?;
        std::fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(
            ".contract-selection.{}.{:x}.tmp",
            std::process::id(),
            Sha256::digest(&bytes)
        ));
        let result = (|| {
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
}

pub fn contract_confirmation(from: Option<&ContractDocument>, to: &ContractDocument) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{}\0{}",
                from.map(ContractDocument::digest).unwrap_or_default(),
                to.digest()
            )
            .as_bytes()
        )
    )[..16]
        .to_owned()
}

pub fn resolve_contract(
    documents: &[(ContractDocument, crate::PolicyOwner)],
    user: Option<&ContractSelection>,
    project: Option<&ContractSelection>,
) -> ContractResolution {
    let find = |key: &str, digest: Option<&String>| {
        let (document, owner) = documents
            .iter()
            .find(|(document, _)| document.key() == key)?;
        digest
            .is_none_or(|digest| *digest == document.digest())
            .then(|| (document.clone(), owner.clone()))
    };
    let unavailable = |key: &str| {
        ContractResolution::Unavailable(format!(
            "selected contract {key} is not registered by an active mod or its document changed since selection"
        ))
    };
    let floor = project.and_then(|selection| {
        selection
            .floor
            .clone()
            .map(|key| (key, selection.floor_digest.clone()))
    });
    let choice = user
        .and_then(|selection| {
            selection
                .contract
                .clone()
                .map(|key| (key, selection.contract_digest.clone(), "user"))
        })
        .or_else(|| {
            project.and_then(|selection| {
                selection
                    .contract
                    .clone()
                    .map(|key| (key, selection.contract_digest.clone(), "project"))
            })
        });
    let minimum = match &floor {
        Some((key, digest)) => match find(key, digest.as_ref()) {
            Some(found) => Some(found),
            None => return unavailable(key),
        },
        None => None,
    };
    let Some((key, digest, source)) = choice else {
        return match minimum {
            Some((document, owner)) => ContractResolution::Active {
                document,
                owner,
                source: "project_floor",
                overrode: None,
            },
            None => ContractResolution::None,
        };
    };
    let Some((document, owner)) = find(&key, digest.as_ref()) else {
        return unavailable(&key);
    };
    match minimum {
        Some((floor, floor_owner)) if document.weaker_than(&floor) => ContractResolution::Active {
            document: floor,
            owner: floor_owner,
            source: "project_floor",
            overrode: Some(key),
        },
        _ => ContractResolution::Active {
            document,
            owner,
            source,
            overrode: None,
        },
    }
}
