use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::io;

pub const CONTRACT_SCHEMA: u32 = 1;
pub const MAX_DENIED_OPERATIONS: usize = 64;
pub const LEGACY_CONTRACT_ID: &str = "legacy_capabilities";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FinalReview {
    None,
    SelfReview,
    #[default]
    Separate,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CompletionMode {
    None,
    SelfVerified,
    AdversarialSeparate,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "snake_case")]
pub enum AssuranceLabel {
    Unreviewed,
    SelfReviewed,
    IndependentlyReviewed,
    IndependentlyVerified,
}

impl AssuranceLabel {
    pub fn label(self) -> &'static str {
        match self {
            Self::Unreviewed => "unreviewed",
            Self::SelfReviewed => "self-reviewed",
            Self::IndependentlyReviewed => "independently-reviewed",
            Self::IndependentlyVerified => "independently-verified",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Self::Unreviewed => "no final review of the completed candidate",
            Self::SelfReviewed => {
                "final self-review by the implementing lead; no independent review occurred"
            }
            Self::IndependentlyReviewed => {
                "separate final reviewer; no adversarial completion verifier"
            }
            Self::IndependentlyVerified => {
                "separate final reviewer and separate adversarial completion verifier"
            }
        }
    }

    pub fn claims_independent_verification(self) -> bool {
        self == Self::IndependentlyVerified
    }

    pub fn independent(self) -> bool {
        matches!(
            self,
            Self::IndependentlyReviewed | Self::IndependentlyVerified
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ContractRequirements {
    pub delegation: bool,
    pub child_agents: bool,
    pub opposite_lead: bool,
    pub escalation: bool,
    pub checkpoints: bool,
    pub milestone_review: bool,
    pub final_review: FinalReview,
    pub completion: CompletionMode,
}

impl ContractRequirements {
    pub fn assurance(&self) -> AssuranceLabel {
        match (self.final_review, self.completion) {
            (FinalReview::Separate, CompletionMode::AdversarialSeparate) => {
                AssuranceLabel::IndependentlyVerified
            }
            (FinalReview::Separate, _) => AssuranceLabel::IndependentlyReviewed,
            (FinalReview::SelfReview, _) => AssuranceLabel::SelfReviewed,
            (FinalReview::None, _) => AssuranceLabel::Unreviewed,
        }
    }

    pub fn validate(&self) -> io::Result<()> {
        if self.completion != CompletionMode::None && !self.checkpoints {
            return Err(invalid("a completion gate requires checkpoint evidence"));
        }
        if self.completion == CompletionMode::AdversarialSeparate
            && (self.final_review != FinalReview::Separate || !self.opposite_lead)
        {
            return Err(invalid(
                "an adversarial completion gate requires a separate final reviewer and verifier",
            ));
        }
        if self.completion == CompletionMode::SelfVerified
            && self.final_review != FinalReview::SelfReview
        {
            return Err(invalid(
                "self-verified completion requires a final self-review",
            ));
        }
        if self.final_review == FinalReview::Separate
            && (!self.milestone_review || !self.opposite_lead)
        {
            return Err(invalid(
                "a separate final reviewer requires the unified review ledger and opposite-lead calls",
            ));
        }
        if self.final_review == FinalReview::SelfReview && self.opposite_lead {
            return Err(invalid(
                "a final self-review contract may not retain opposite-lead calls",
            ));
        }
        if self.delegation && !self.milestone_review {
            return Err(invalid(
                "delegation requires unified review for conflict-checked integration",
            ));
        }
        if self.delegation && !self.opposite_lead {
            return Err(invalid(
                "delegation requires opposite-lead review of the contributed candidate",
            ));
        }
        if self.child_agents && !self.delegation {
            return Err(invalid("child agents require delegation authority"));
        }
        if self.escalation && !self.opposite_lead {
            return Err(invalid("escalation requires opposite-lead advice"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WorkflowContract {
    pub schema: u32,
    pub id: String,
    pub version: u32,
    pub requirements: ContractRequirements,
}

impl WorkflowContract {
    pub fn reviewed_omd_v1() -> Self {
        Self {
            schema: CONTRACT_SCHEMA,
            id: "reviewed_omd".into(),
            version: 1,
            requirements: ContractRequirements {
                delegation: true,
                child_agents: true,
                opposite_lead: true,
                escalation: true,
                checkpoints: true,
                milestone_review: true,
                final_review: FinalReview::Separate,
                completion: CompletionMode::AdversarialSeparate,
            },
        }
    }

    pub fn solo_evidence_v1() -> Self {
        Self {
            schema: CONTRACT_SCHEMA,
            id: "solo_evidence".into(),
            version: 1,
            requirements: ContractRequirements {
                delegation: false,
                child_agents: false,
                opposite_lead: false,
                escalation: false,
                checkpoints: true,
                milestone_review: false,
                final_review: FinalReview::SelfReview,
                completion: CompletionMode::SelfVerified,
            },
        }
    }

    pub fn bundled() -> Vec<Self> {
        vec![Self::reviewed_omd_v1(), Self::solo_evidence_v1()]
    }

    pub fn bundled_default() -> Self {
        Self::reviewed_omd_v1()
    }

    pub fn is_bundled(&self) -> bool {
        Self::bundled().contains(self)
    }

    pub fn host_owned(&self) -> bool {
        self.is_bundled() || (self.id == LEGACY_CONTRACT_ID && self.version == 1)
    }

    pub fn validate(&self) -> io::Result<()> {
        if self.schema != CONTRACT_SCHEMA
            || self.version == 0
            || !identifier(&self.id)
            || Self::bundled()
                .iter()
                .any(|bundled| bundled.id == self.id && bundled != self)
        {
            return Err(invalid(
                "workflow contract identity is invalid or redefines a bundled contract",
            ));
        }
        self.requirements.validate()
    }

    pub fn assurance(&self) -> AssuranceLabel {
        self.requirements.assurance()
    }

    pub fn name(&self) -> String {
        format!("{} v{}", self.id, self.version)
    }

    pub fn digest(&self) -> io::Result<String> {
        self.validate()?;
        Ok(digest(&serde_json::to_vec(self).map_err(io::Error::other)?))
    }

    pub fn summary(&self) -> io::Result<ContractSummary> {
        Ok(ContractSummary {
            id: self.id.clone(),
            version: self.version,
            sha256: self.digest()?,
            assurance: self.assurance(),
            assurance_description: self.assurance().description().into(),
        })
    }

    pub fn from_legacy(capabilities: LegacyCapabilities) -> io::Result<Self> {
        if capabilities == Self::reviewed_omd_v1().legacy_capabilities() {
            return Ok(Self::reviewed_omd_v1());
        }
        let contract = Self {
            schema: CONTRACT_SCHEMA,
            id: LEGACY_CONTRACT_ID.into(),
            version: 1,
            requirements: ContractRequirements {
                delegation: capabilities.delegation,
                child_agents: capabilities.delegation,
                opposite_lead: capabilities.delegation
                    || capabilities.escalation
                    || capabilities.unified_review
                    || capabilities.completion_gate,
                escalation: capabilities.escalation,
                checkpoints: capabilities.checkpoints,
                milestone_review: capabilities.unified_review,
                final_review: if capabilities.unified_review {
                    FinalReview::Separate
                } else {
                    FinalReview::None
                },
                completion: if capabilities.completion_gate {
                    CompletionMode::AdversarialSeparate
                } else {
                    CompletionMode::None
                },
            },
        };
        contract.validate()?;
        Ok(contract)
    }

    pub fn legacy_capabilities(&self) -> LegacyCapabilities {
        LegacyCapabilities {
            delegation: self.requirements.delegation,
            escalation: self.requirements.escalation,
            checkpoints: self.requirements.checkpoints,
            unified_review: self.requirements.milestone_review,
            completion_gate: self.requirements.completion == CompletionMode::AdversarialSeparate,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LegacyCapabilities {
    pub delegation: bool,
    pub escalation: bool,
    pub checkpoints: bool,
    pub unified_review: bool,
    pub completion_gate: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct ContractSummary {
    pub id: String,
    pub version: u32,
    pub sha256: String,
    pub assurance: AssuranceLabel,
    pub assurance_description: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "snake_case")]
pub enum SelectionSource {
    Bundle,
    LegacyManifest,
    ProjectRecommendation,
    UserDefault,
    TaskSelection,
}

impl SelectionSource {
    fn priority(self) -> u8 {
        match self {
            Self::Bundle => 0,
            Self::LegacyManifest => 1,
            Self::ProjectRecommendation => 2,
            Self::UserDefault => 3,
            Self::TaskSelection => 4,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Bundle => "bundled default",
            Self::LegacyManifest => "legacy manifest capabilities",
            Self::ProjectRecommendation => "project recommendation",
            Self::UserDefault => "explicit user default",
            Self::TaskSelection => "explicit task selection",
        }
    }

    pub fn explicit_user_choice(self) -> bool {
        matches!(self, Self::UserDefault | Self::TaskSelection)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SelectionScope {
    Session,
    Task,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OwnerKind {
    Bundled,
    Mod,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PolicyOwner {
    pub kind: OwnerKind,
    pub id: String,
    pub version: String,
    pub source: String,
    pub sha256: String,
}

impl PolicyOwner {
    pub fn bundled() -> Self {
        Self {
            kind: OwnerKind::Bundled,
            id: "oh-my-diff".into(),
            version: crate::PINNED_UPSTREAM.into(),
            source: "bundled native host".into(),
            sha256: digest(crate::PINNED_UPSTREAM.as_bytes()),
        }
    }

    fn validate(&self) -> io::Result<()> {
        if !bounded(&self.id, 64)
            || !bounded(&self.version, 128)
            || !bounded(&self.source, 512)
            || validate_sha256(&self.sha256).is_err()
            || (self.kind == OwnerKind::Bundled && *self != Self::bundled())
        {
            return Err(invalid("policy owner provenance is incomplete or forged"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationSource {
    pub scope: SelectionSource,
    pub path: Option<String>,
    pub sha256: String,
}

impl ConfigurationSource {
    fn validate(&self) -> io::Result<()> {
        if self
            .path
            .as_deref()
            .is_some_and(|path| !bounded(path, 4096))
            || validate_sha256(&self.sha256).is_err()
        {
            return Err(invalid("configuration provenance is incomplete"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ContractOffer {
    pub source: SelectionSource,
    pub scope: SelectionScope,
    pub contract: WorkflowContract,
    pub configuration: ConfigurationSource,
    pub owner: PolicyOwner,
}

impl ContractOffer {
    fn validate(&self) -> io::Result<()> {
        self.contract.validate()?;
        self.configuration.validate()?;
        self.owner.validate()?;
        if self.configuration.scope != self.source {
            return Err(invalid(
                "offer configuration provenance does not match its selection source",
            ));
        }
        if self.owner.kind == OwnerKind::Bundled && !self.contract.host_owned() {
            return Err(invalid(
                "only a registered policy owner may offer a non-bundled contract",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AssuranceFloor {
    pub source: SelectionSource,
    pub minimum: AssuranceLabel,
    pub configuration: ConfigurationSource,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct OfferSummary {
    pub source: SelectionSource,
    pub scope: SelectionScope,
    pub contract: ContractSummary,
    pub owner: PolicyOwner,
    pub configuration: ConfigurationSource,
    pub effective: bool,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct Resolution {
    pub effective: ContractOffer,
    pub bundled_default: ContractSummary,
    pub considered: Vec<OfferSummary>,
    pub floor: Option<AssuranceFloor>,
    pub weakens_default: bool,
    pub requires_confirmation: bool,
    pub confirmation_token: Option<String>,
}

pub fn confirmation_token(prior: &ContractSummary, next: &ContractSummary) -> String {
    digest(format!("omd-workflow-confirm\n{}\n{}", prior.sha256, next.sha256).as_bytes())
}

pub fn resolve_selection(
    offers: Vec<ContractOffer>,
    floor: Option<AssuranceFloor>,
) -> io::Result<Resolution> {
    if offers.is_empty() || offers.len() > 8 {
        return Err(invalid("workflow selection requires one bundled default"));
    }
    for offer in &offers {
        offer.validate()?;
    }
    if let Some(floor) = &floor {
        floor.configuration.validate()?;
        if floor.source != SelectionSource::ProjectRecommendation {
            return Err(invalid("only a project may declare an assurance floor"));
        }
    }
    let sources = offers
        .iter()
        .map(|offer| offer.source)
        .collect::<BTreeSet<_>>();
    if sources.len() != offers.len() {
        return Err(invalid(
            "conflicting workflow offers from one source; resolve the conflict before activation",
        ));
    }
    let bundled = offers
        .iter()
        .find(|offer| offer.source == SelectionSource::Bundle)
        .ok_or_else(|| invalid("workflow selection requires one bundled default"))?
        .clone();
    if bundled.contract != WorkflowContract::bundled_default() {
        return Err(invalid("the bundled default contract was replaced"));
    }
    let effective = offers
        .iter()
        .max_by_key(|offer| offer.source.priority())
        .expect("validated non-empty offers")
        .clone();
    let bundled_default = bundled.contract.summary()?;
    let effective_summary = effective.contract.summary()?;
    let considered = offers
        .iter()
        .map(|offer| {
            Ok(OfferSummary {
                source: offer.source,
                scope: offer.scope,
                contract: offer.contract.summary()?,
                owner: offer.owner.clone(),
                configuration: offer.configuration.clone(),
                effective: offer.source == effective.source,
                reason: if offer.source == effective.source {
                    format!("{} has the highest precedence", offer.source.label())
                } else {
                    format!(
                        "{} is overridden by {}",
                        offer.source.label(),
                        effective.source.label()
                    )
                },
            })
        })
        .collect::<io::Result<Vec<_>>>()?;
    if let Some(floor) = &floor
        && effective.contract.assurance() < floor.minimum
    {
        return Err(invalid(&format!(
            "workflow conflict: {} offers {} ({}) but the project requires at least {}; resolve the conflict explicitly",
            effective.source.label(),
            effective.contract.name(),
            effective.contract.assurance().label(),
            floor.minimum.label(),
        )));
    }
    let weakens_default = effective.contract.assurance() < bundled.contract.assurance();
    let requires_confirmation =
        weakens_default && effective.source != SelectionSource::LegacyManifest;
    let confirmation_token =
        requires_confirmation.then(|| confirmation_token(&bundled_default, &effective_summary));
    Ok(Resolution {
        effective,
        bundled_default,
        considered,
        floor,
        weakens_default,
        requires_confirmation,
        confirmation_token,
    })
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TaskBinding {
    pub acceptance_contract_sha256: String,
    pub initial_candidate_sha256: String,
    pub repository_identity: String,
}

impl TaskBinding {
    fn validate(&self) -> io::Result<()> {
        validate_sha256(&self.acceptance_contract_sha256)?;
        validate_sha256(&self.initial_candidate_sha256)?;
        if !bounded(&self.repository_identity, 256) {
            return Err(invalid("task binding is incomplete"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct ConfirmationReceipt {
    pub prior: ContractSummary,
    pub next: ContractSummary,
    pub weakens: bool,
    pub token: String,
    pub at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct MigrationReceipt {
    pub from: ContractSummary,
    pub to: ContractSummary,
    pub boundary: String,
    pub revalidated: Vec<String>,
    pub confirmation: ConfirmationReceipt,
    pub at: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ContractOperation {
    Delegate,
    SpawnChildAgent,
    OppositeLeadAdvice,
    Escalate,
    Checkpoint,
    MilestoneReview,
    FinalReview,
    Completion,
}

impl ContractOperation {
    pub fn restrictable(self) -> bool {
        matches!(
            self,
            Self::Delegate | Self::SpawnChildAgent | Self::OppositeLeadAdvice | Self::Escalate
        )
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Delegate => "delegation.contribute",
            Self::SpawnChildAgent => "agents.spawn",
            Self::OppositeLeadAdvice => "opposite_lead.advice",
            Self::Escalate => "recovery.escalate",
            Self::Checkpoint => "checkpoint.update",
            Self::MilestoneReview => "review.run",
            Self::FinalReview => "review.final",
            Self::Completion => "review.complete",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct DeniedOperation {
    pub operation: ContractOperation,
    pub contract_sha256: String,
    pub reason: String,
    pub at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct ContractProvenance {
    pub schema: u32,
    pub contract_schema: u32,
    pub contract: WorkflowContract,
    pub contract_sha256: String,
    pub assurance: AssuranceLabel,
    pub assurance_description: String,
    pub bundled_default_sha256: String,
    pub owners: Vec<PolicyOwner>,
    pub configuration_sha256: String,
    pub configuration_sources: Vec<ConfigurationSource>,
    pub source: SelectionSource,
    pub scope: SelectionScope,
    pub considered: Vec<OfferSummary>,
    pub floor: Option<AssuranceFloor>,
    pub weakens_default: bool,
    pub confirmation: Option<ConfirmationReceipt>,
    pub prior: Option<ContractSummary>,
    pub binding: TaskBinding,
    pub migrations: Vec<MigrationReceipt>,
    pub selected_at: u64,
}

impl ContractProvenance {
    pub fn summary(&self) -> io::Result<ContractSummary> {
        self.contract.summary()
    }

    fn validate(&self) -> io::Result<()> {
        self.contract.validate()?;
        self.binding.validate()?;
        if self.schema != 1
            || self.contract_schema != CONTRACT_SCHEMA
            || self.contract_sha256 != self.contract.digest()?
            || self.assurance != self.contract.assurance()
            || self.assurance_description != self.assurance.description()
            || self.bundled_default_sha256 != WorkflowContract::bundled_default().digest()?
            || self.owners.is_empty()
            || self.owners.len() > 8
            || self.configuration_sources.is_empty()
            || self.configuration_sources.len() > 8
            || self.considered.is_empty()
            || self.considered.len() > 8
            || self.migrations.len() > 8
            || self.weakens_default
                != (self.assurance < WorkflowContract::bundled_default().assurance())
            || validate_sha256(&self.configuration_sha256).is_err()
        {
            return Err(invalid(
                "workflow provenance is incomplete or does not match its contract",
            ));
        }
        for owner in &self.owners {
            owner.validate()?;
        }
        for source in &self.configuration_sources {
            source.validate()?;
        }
        if self.configuration_sha256 != configuration_digest(&self.configuration_sources)? {
            return Err(invalid(
                "workflow configuration digest does not match its sources",
            ));
        }
        if !self
            .considered
            .iter()
            .any(|offer| offer.effective && offer.source == self.source)
        {
            return Err(invalid(
                "workflow provenance does not record the effective selection",
            ));
        }
        if let Some(floor) = &self.floor {
            floor.configuration.validate()?;
            if self.assurance < floor.minimum {
                return Err(invalid(
                    "active contract is weaker than the recorded project assurance floor",
                ));
            }
        }
        let confirmation_required =
            self.weakens_default && self.source != SelectionSource::LegacyManifest;
        match (&self.confirmation, confirmation_required) {
            (None, true) => Err(invalid(
                "a weaker contract requires an explicit native confirmation receipt",
            )),
            (Some(receipt), _) => {
                if receipt.next != self.contract.summary()?
                    || receipt.token != confirmation_token(&receipt.prior, &receipt.next)
                    || receipt.weakens != (receipt.next.assurance < receipt.prior.assurance)
                {
                    return Err(invalid("workflow confirmation receipt is forged or stale"));
                }
                Ok(())
            }
            (None, false) => Ok(()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct ContractSnapshot {
    pub schema: u32,
    pub provenance: ContractProvenance,
    pub provenance_sha256: String,
    pub denied: Vec<DeniedOperation>,
    #[serde(default)]
    pub restrictions: Vec<Restriction>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct Restriction {
    pub operation: ContractOperation,
    pub owner: PolicyOwner,
    pub reason: String,
    pub at: u64,
}

#[derive(Debug)]
pub struct ActiveContract {
    snapshot: ContractSnapshot,
}

impl ActiveContract {
    pub fn activate(
        resolution: Resolution,
        confirmation: Option<&str>,
        binding: TaskBinding,
        prior: Option<ContractSummary>,
    ) -> io::Result<Self> {
        binding.validate()?;
        let summary = resolution.effective.contract.summary()?;
        let before = prior.clone().unwrap_or(resolution.bundled_default.clone());
        let expected = resolution
            .requires_confirmation
            .then(|| confirmation_token(&before, &summary));
        let confirmation_receipt = match (&expected, confirmation) {
            (Some(expected), Some(supplied)) if expected == supplied => Some(ConfirmationReceipt {
                weakens: summary.assurance < before.assurance,
                prior: before,
                next: summary.clone(),
                token: expected.clone(),
                at: now(),
            }),
            (Some(_), _) => {
                return Err(invalid(
                    "explicit confirmation is required before a weaker workflow contract activates",
                ));
            }
            (None, Some(_)) => {
                return Err(invalid(
                    "no confirmation is expected for this workflow selection",
                ));
            }
            (None, None) => None,
        };
        let owners = vec![resolution.effective.owner.clone()];
        let configuration_sources = resolution
            .considered
            .iter()
            .map(|offer| offer.configuration.clone())
            .collect::<Vec<_>>();
        let provenance = ContractProvenance {
            schema: 1,
            contract_schema: CONTRACT_SCHEMA,
            contract: resolution.effective.contract.clone(),
            contract_sha256: summary.sha256.clone(),
            assurance: summary.assurance,
            assurance_description: summary.assurance.description().into(),
            bundled_default_sha256: resolution.bundled_default.sha256.clone(),
            owners,
            configuration_sha256: configuration_digest(&configuration_sources)?,
            configuration_sources,
            source: resolution.effective.source,
            scope: resolution.effective.scope,
            considered: resolution.considered,
            floor: resolution.floor,
            weakens_default: resolution.weakens_default,
            confirmation: confirmation_receipt,
            prior,
            binding,
            migrations: Vec::new(),
            selected_at: now(),
        };
        provenance.validate()?;
        Ok(Self {
            snapshot: seal(provenance, Vec::new())?,
        })
    }

    /// Abrupt client loss can leave the workspace legitimately changed, so a resumed task is
    /// identified by its acceptance contract and repository and keeps its original candidate.
    pub fn resume(snapshot: ContractSnapshot, binding: &TaskBinding) -> io::Result<Self> {
        binding.validate()?;
        let persisted = snapshot.provenance.binding.clone();
        if persisted.acceptance_contract_sha256 != binding.acceptance_contract_sha256
            || persisted.repository_identity != binding.repository_identity
        {
            return Err(invalid(
                "persisted workflow contract belongs to a different task or workspace",
            ));
        }
        Self::restore(snapshot, &persisted)
    }

    pub fn restore(snapshot: ContractSnapshot, binding: &TaskBinding) -> io::Result<Self> {
        binding.validate()?;
        if snapshot.schema != 1
            || snapshot.denied.len() > MAX_DENIED_OPERATIONS
            || snapshot.restrictions.len() > 8
            || snapshot.restrictions.iter().any(|entry| {
                !entry.operation.restrictable()
                    || entry.owner.validate().is_err()
                    || !bounded(&entry.reason, 512)
            })
        {
            return Err(invalid("persisted workflow state is invalid"));
        }
        snapshot.provenance.validate()?;
        if snapshot.provenance_sha256 != provenance_digest(&snapshot.provenance)? {
            return Err(invalid(
                "persisted workflow provenance was modified outside the host",
            ));
        }
        if &snapshot.provenance.binding != binding {
            return Err(invalid(
                "persisted workflow contract belongs to a different task or workspace",
            ));
        }
        for denial in &snapshot.denied {
            if denial.contract_sha256 != snapshot.provenance.contract_sha256
                || !bounded(&denial.reason, 512)
            {
                return Err(invalid("persisted workflow denial record is invalid"));
            }
        }
        Ok(Self { snapshot })
    }

    pub fn snapshot(&self) -> ContractSnapshot {
        self.snapshot.clone()
    }

    pub fn contract(&self) -> &WorkflowContract {
        &self.snapshot.provenance.contract
    }

    pub fn requirements(&self) -> &ContractRequirements {
        &self.snapshot.provenance.contract.requirements
    }

    pub fn assurance(&self) -> AssuranceLabel {
        self.snapshot.provenance.assurance
    }

    pub fn provenance(&self) -> &ContractProvenance {
        &self.snapshot.provenance
    }

    pub fn restrict(
        &mut self,
        operations: Vec<ContractOperation>,
        owner: PolicyOwner,
        reason: String,
    ) -> io::Result<Vec<Restriction>> {
        owner.validate()?;
        if operations.is_empty()
            || operations.len() > 4
            || operations.iter().any(|operation| !operation.restrictable())
            || !bounded(&reason, 512)
        {
            return Err(invalid(
                "a workflow restriction may only remove delegation, child-agent, opposite-lead, or escalation authority",
            ));
        }
        let mut staged = self.snapshot.restrictions.clone();
        for operation in operations {
            if staged.iter().any(|entry| entry.operation == operation) {
                continue;
            }
            staged.push(Restriction {
                operation,
                owner: owner.clone(),
                reason: reason.clone(),
                at: now(),
            });
        }
        if staged.len() > 8 {
            return Err(invalid("workflow restriction limit"));
        }
        self.snapshot.restrictions = staged;
        Ok(self.snapshot.restrictions.clone())
    }

    pub fn restrictions(&self) -> &[Restriction] {
        &self.snapshot.restrictions
    }

    pub fn permits(&self, operation: ContractOperation) -> bool {
        if self
            .snapshot
            .restrictions
            .iter()
            .any(|entry| entry.operation == operation)
        {
            return false;
        }
        let requirements = self.requirements();
        match operation {
            ContractOperation::Delegate => requirements.delegation,
            ContractOperation::SpawnChildAgent => requirements.child_agents,
            ContractOperation::OppositeLeadAdvice => requirements.opposite_lead,
            ContractOperation::Escalate => requirements.escalation,
            ContractOperation::Checkpoint => requirements.checkpoints,
            ContractOperation::MilestoneReview => requirements.milestone_review,
            ContractOperation::FinalReview => requirements.final_review != FinalReview::None,
            ContractOperation::Completion => requirements.completion != CompletionMode::None,
        }
    }

    pub fn authorize(&mut self, operation: ContractOperation) -> Result<(), String> {
        if self.permits(operation) {
            return Ok(());
        }
        let reason = match self
            .snapshot
            .restrictions
            .iter()
            .find(|entry| entry.operation == operation)
        {
            Some(restriction) => format!(
                "{} is restricted by {}: {}",
                operation.label(),
                restriction.owner.id,
                restriction.reason
            ),
            None => format!(
                "{} is denied by the selected {} contract ({})",
                operation.label(),
                self.contract().name(),
                self.assurance().label()
            ),
        };
        if self.snapshot.denied.len() < MAX_DENIED_OPERATIONS
            && !self
                .snapshot
                .denied
                .iter()
                .any(|denial| denial.operation == operation)
        {
            self.snapshot.denied.push(DeniedOperation {
                operation,
                contract_sha256: self.snapshot.provenance.contract_sha256.clone(),
                reason: reason.clone(),
                at: now(),
            });
        }
        Err(reason)
    }

    pub fn denied(&self) -> &[DeniedOperation] {
        &self.snapshot.denied
    }

    pub fn migrate(
        &mut self,
        next: WorkflowContract,
        confirmation: &str,
        boundary: &str,
        revalidated: Vec<String>,
    ) -> io::Result<MigrationReceipt> {
        const BOUNDARIES: [&str; 2] = ["task_start", "turn_boundary"];
        const REQUIRED: [&str; 6] = [
            "candidate",
            "evidence",
            "checks",
            "workers",
            "allowance",
            "resume",
        ];
        let prior = self.contract().summary()?;
        let target = next.summary()?;
        if !BOUNDARIES.contains(&boundary) {
            return Err(invalid(
                "a mid-task contract change requires a host-declared safe boundary",
            ));
        }
        let revalidation = revalidated
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if REQUIRED.iter().any(|item| !revalidation.contains(item))
            || revalidation.len() != revalidated.len()
            || revalidated.len() > 16
        {
            return Err(invalid(
                "migration must revalidate the candidate, evidence, checks, workers, allowance, and resume state",
            ));
        }
        if target == prior {
            return Err(invalid("the requested contract is already active"));
        }
        if confirmation != confirmation_token(&prior, &target) {
            return Err(invalid(
                "a mid-task contract change requires an explicit native confirmation",
            ));
        }
        if let Some(floor) = &self.snapshot.provenance.floor
            && target.assurance < floor.minimum
        {
            return Err(invalid(
                "the requested contract is weaker than the project assurance floor",
            ));
        }
        let receipt = MigrationReceipt {
            from: prior.clone(),
            to: target.clone(),
            boundary: boundary.into(),
            revalidated,
            confirmation: ConfirmationReceipt {
                prior: prior.clone(),
                next: target.clone(),
                weakens: target.assurance < prior.assurance,
                token: confirmation.into(),
                at: now(),
            },
            at: now(),
        };
        let mut staged = self.snapshot.provenance.clone();
        staged.contract = next;
        staged.contract_sha256 = target.sha256.clone();
        staged.assurance = target.assurance;
        staged.assurance_description = target.assurance.description().into();
        staged.weakens_default = target.assurance < WorkflowContract::bundled_default().assurance();
        staged.prior = Some(prior);
        staged.confirmation = Some(receipt.confirmation.clone());
        staged.migrations.push(receipt.clone());
        if staged.migrations.len() > 8 {
            return Err(invalid("workflow migration limit exhausted"));
        }
        staged.validate()?;
        let restrictions = self.snapshot.restrictions.clone();
        self.snapshot = seal(staged, self.snapshot.denied.clone())?;
        self.snapshot.restrictions = restrictions;
        Ok(receipt)
    }

    pub fn view(&self) -> io::Result<serde_json::Value> {
        serde_json::to_value(&self.snapshot).map_err(io::Error::other)
    }
}

fn seal(
    provenance: ContractProvenance,
    denied: Vec<DeniedOperation>,
) -> io::Result<ContractSnapshot> {
    Ok(ContractSnapshot {
        schema: 1,
        provenance_sha256: provenance_digest(&provenance)?,
        provenance,
        denied,
        restrictions: Vec::new(),
    })
}

fn provenance_digest(provenance: &ContractProvenance) -> io::Result<String> {
    Ok(digest(
        &serde_json::to_vec(provenance).map_err(io::Error::other)?,
    ))
}

pub fn configuration_digest(sources: &[ConfigurationSource]) -> io::Result<String> {
    let normalized = sources
        .iter()
        .map(|source| {
            (
                source.scope,
                source.path.clone().unwrap_or_default(),
                source.sha256.clone(),
            )
        })
        .collect::<Vec<_>>();
    Ok(digest(
        &serde_json::to_vec(&normalized).map_err(io::Error::other)?,
    ))
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}

fn bounded(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

fn validate_sha256(value: &str) -> io::Result<()> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid("expected a lowercase sha256 digest"));
    }
    Ok(())
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

#[cfg(test)]
#[path = "contract_tests.rs"]
mod tests;
