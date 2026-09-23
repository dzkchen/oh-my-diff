use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::fs;
use std::fs::OpenOptions;
use std::io;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

const MAX_RECORD_BYTES: usize = 65_536;
const MAX_HISTORY: usize = 256;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceSplit {
    Development,
    Validation,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(deny_unknown_fields)]
pub struct EvidenceReference {
    pub task_id: String,
    pub artifact: String,
    pub sha256: String,
    pub split: EvidenceSplit,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(deny_unknown_fields)]
pub struct GuidelineRule {
    pub id: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum GuidelineVariant {
    FullChecklist {
        checklist: Vec<GuidelineRule>,
    },
    TinyCore {
        core: Vec<GuidelineRule>,
        selected_rules: Vec<GuidelineRule>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct GuidelineProposal {
    pub schema: u32,
    pub version: String,
    pub replaces: Option<String>,
    pub rationale: String,
    pub variant: GuidelineVariant,
    pub development_evidence: Vec<EvidenceReference>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ValidationOutcome {
    Passed,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ValidationRecord {
    pub schema: u32,
    pub id: String,
    pub proposal_version: String,
    pub proposal_sha256: String,
    pub validator: String,
    pub outcome: ValidationOutcome,
    pub summary: String,
    pub validation_evidence: Vec<EvidenceReference>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct GuidelineSelection {
    pub version: String,
    pub proposal_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MaintainerAction {
    pub actor: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PromotionRequest {
    pub expected_active: Option<GuidelineSelection>,
    pub proposal: GuidelineSelection,
    pub validation_id: String,
    pub validation_sha256: String,
    pub maintainer: MaintainerAction,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RollbackRequest {
    pub expected_active: GuidelineSelection,
    pub maintainer: MaintainerAction,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ActiveGuideline {
    pub selection: GuidelineSelection,
    pub variant: GuidelineVariant,
    pub promoted_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum TransitionKind {
    Promotion,
    Rollback,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct GuidelineTransition {
    revision: u64,
    kind: TransitionKind,
    from: Option<GuidelineSelection>,
    to: Option<GuidelineSelection>,
    validation_id: Option<String>,
    validation_sha256: Option<String>,
    maintainer: MaintainerAction,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct StoreState {
    schema: u32,
    revision: u64,
    active: Option<ActiveGuideline>,
    rollback: Vec<Option<ActiveGuideline>>,
    transitions: Vec<GuidelineTransition>,
}

#[derive(Clone, Debug)]
pub struct GuidelineStore {
    root: PathBuf,
}

struct StoreLock(PathBuf);

impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::other(message)
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.trim() == value
        && !value.contains(['\r', '\n'])
}

fn validate_rules(rules: &[GuidelineRule], min: usize, max: usize) -> io::Result<()> {
    if !(min..=max).contains(&rules.len()) {
        return Err(invalid("invalid guideline rule count"));
    }
    let mut ids = BTreeSet::new();
    for rule in rules {
        if !valid_token(&rule.id) || !valid_text(&rule.text, 240) || !ids.insert(rule.id.as_str()) {
            return Err(invalid("invalid one-line guideline rule"));
        }
    }
    Ok(())
}

impl GuidelineVariant {
    fn validate(&self) -> io::Result<()> {
        match self {
            Self::FullChecklist { checklist } => validate_rules(checklist, 4, 16),
            Self::TinyCore {
                core,
                selected_rules,
            } => {
                validate_rules(core, 1, 4)?;
                validate_rules(selected_rules, 1, 12)?;
                let core_ids = core.iter().map(|rule| &rule.id).collect::<BTreeSet<_>>();
                if selected_rules
                    .iter()
                    .any(|rule| core_ids.contains(&rule.id))
                {
                    return Err(invalid("duplicate rule across tiny core and selection"));
                }
                Ok(())
            }
        }
    }

    pub fn render(&self) -> String {
        let mut output = String::new();
        match self {
            Self::FullChecklist { checklist } => {
                output.push_str("Apply the complete short simplicity checklist:\n");
                for rule in checklist {
                    output.push_str("- [");
                    output.push_str(&rule.id);
                    output.push_str("] ");
                    output.push_str(&rule.text);
                    output.push('\n');
                }
            }
            Self::TinyCore {
                core,
                selected_rules,
            } => {
                output.push_str("Apply the tiny shared simplicity core:\n");
                for rule in core {
                    output.push_str("- [");
                    output.push_str(&rule.id);
                    output.push_str("] ");
                    output.push_str(&rule.text);
                    output.push('\n');
                }
                output.push_str("Apply these selected one-line rules:\n");
                for rule in selected_rules {
                    output.push_str("- [");
                    output.push_str(&rule.id);
                    output.push_str("] ");
                    output.push_str(&rule.text);
                    output.push('\n');
                }
            }
        }
        output
    }
}

fn validate_evidence(
    evidence: &[EvidenceReference],
    required_split: EvidenceSplit,
) -> io::Result<BTreeSet<&str>> {
    if evidence.is_empty() || evidence.len() > 32 {
        return Err(invalid("invalid guideline evidence count"));
    }
    let mut records = BTreeSet::new();
    let mut tasks = BTreeSet::new();
    for item in evidence {
        if item.split != required_split
            || !valid_token(&item.task_id)
            || !valid_text(&item.artifact, 4096)
            || !valid_sha256(&item.sha256)
            || !records.insert((
                item.task_id.as_str(),
                item.artifact.as_str(),
                item.sha256.as_str(),
            ))
        {
            return Err(invalid("invalid guideline evidence"));
        }
        tasks.insert(item.task_id.as_str());
    }
    Ok(tasks)
}

impl GuidelineProposal {
    fn validate(&self) -> io::Result<()> {
        if self.schema != 1
            || !valid_token(&self.version)
            || self
                .replaces
                .as_deref()
                .is_some_and(|value| !valid_token(value))
            || !valid_text(&self.rationale, 4096)
        {
            return Err(invalid("invalid guideline proposal"));
        }
        self.variant.validate()?;
        validate_evidence(&self.development_evidence, EvidenceSplit::Development)?;
        if serde_json::to_vec(self)?.len() > MAX_RECORD_BYTES {
            return Err(invalid("guideline proposal exceeds size limit"));
        }
        Ok(())
    }
}

impl ValidationRecord {
    fn validate(&self) -> io::Result<()> {
        if self.schema != 1
            || !valid_token(&self.id)
            || !valid_token(&self.proposal_version)
            || !valid_sha256(&self.proposal_sha256)
            || !valid_text(&self.validator, 256)
            || !valid_text(&self.summary, 4096)
        {
            return Err(invalid("invalid guideline validation"));
        }
        validate_evidence(&self.validation_evidence, EvidenceSplit::Validation)?;
        if serde_json::to_vec(self)?.len() > MAX_RECORD_BYTES {
            return Err(invalid("guideline validation exceeds size limit"));
        }
        Ok(())
    }
}

impl MaintainerAction {
    fn validate(&self) -> io::Result<()> {
        if !valid_text(&self.actor, 256) || !valid_text(&self.reason, 4096) {
            return Err(invalid("invalid maintainer action"));
        }
        Ok(())
    }
}

impl GuidelineStore {
    pub fn create(root: PathBuf) -> io::Result<Self> {
        let parent = root
            .parent()
            .ok_or_else(|| invalid("guideline store parent missing"))?;
        let name = root
            .file_name()
            .ok_or_else(|| invalid("guideline store name missing"))?;
        let root = parent.canonicalize()?.join(name);
        if root.exists() {
            return Err(invalid("guideline store requires a canonical new path"));
        }
        fs::create_dir(&root)?;
        fs::create_dir(root.join("proposals"))?;
        fs::create_dir(root.join("validations"))?;
        let store = Self { root };
        store.write_state(&StoreState {
            schema: 1,
            revision: 0,
            active: None,
            rollback: Vec::new(),
            transitions: Vec::new(),
        })?;
        Ok(store)
    }

    pub fn open(root: PathBuf) -> io::Result<Self> {
        if root.canonicalize()? != root
            || !fs::symlink_metadata(&root)?.file_type().is_dir()
            || !fs::symlink_metadata(root.join("proposals"))?
                .file_type()
                .is_dir()
            || !fs::symlink_metadata(root.join("validations"))?
                .file_type()
                .is_dir()
        {
            return Err(invalid("invalid guideline store"));
        }
        let store = Self { root };
        store.read_state()?;
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn lock(&self) -> io::Result<StoreLock> {
        let path = self.root.join("state.lock");
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        Ok(StoreLock(path))
    }

    fn read_record<T: for<'de> Deserialize<'de>>(&self, path: &Path) -> io::Result<(T, String)> {
        if path.canonicalize()? != path
            || !path.starts_with(&self.root)
            || !fs::symlink_metadata(path)?.file_type().is_file()
        {
            return Err(invalid("invalid guideline record path"));
        }
        let bytes = fs::read(path)?;
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(invalid("guideline record exceeds size limit"));
        }
        let value = serde_json::from_slice(&bytes)?;
        Ok((value, hash(&bytes)))
    }

    fn write_new<T: Serialize>(&self, path: &Path, value: &T) -> io::Result<String> {
        let bytes = serde_json::to_vec(value)?;
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(invalid("guideline record exceeds size limit"));
        }
        let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok(hash(&bytes))
    }

    fn read_state(&self) -> io::Result<StoreState> {
        let (state, _) = self.read_record::<StoreState>(&self.root.join("state.json"))?;
        if state.schema != 1
            || state.transitions.len() > MAX_HISTORY
            || state.rollback.len() > MAX_HISTORY
            || state.transitions.last().map(|item| item.revision)
                != (state.revision > 0).then_some(state.revision)
        {
            return Err(invalid("invalid guideline state"));
        }
        let mut active: Option<ActiveGuideline> = None;
        let mut rollback = Vec::new();
        for (index, transition) in state.transitions.iter().enumerate() {
            if transition.revision != index as u64 + 1
                || transition.from != active.as_ref().map(|value| value.selection.clone())
            {
                return Err(invalid("invalid guideline transition chain"));
            }
            transition.maintainer.validate()?;
            match transition.kind {
                TransitionKind::Promotion => {
                    let selection = transition
                        .to
                        .as_ref()
                        .ok_or_else(|| invalid("promotion target missing"))?;
                    let validation_id = transition
                        .validation_id
                        .as_deref()
                        .ok_or_else(|| invalid("promotion validation missing"))?;
                    let validation_sha256 = transition
                        .validation_sha256
                        .as_deref()
                        .ok_or_else(|| invalid("promotion validation hash missing"))?;
                    let (validation, actual_validation_sha256) = self
                        .read_record::<ValidationRecord>(
                            &self.validation_path(&selection.version, validation_id)?,
                        )?;
                    if actual_validation_sha256 != validation_sha256
                        || validation.id != validation_id
                        || validation.proposal_version != selection.version
                        || validation.proposal_sha256 != selection.proposal_sha256
                        || validation.outcome != ValidationOutcome::Passed
                    {
                        return Err(invalid("invalid promoted validation"));
                    }
                    rollback.push(active.clone());
                    active = Some(self.load_active(selection, transition.revision)?);
                }
                TransitionKind::Rollback => {
                    if transition.validation_id.is_some() || transition.validation_sha256.is_some()
                    {
                        return Err(invalid("rollback cannot cite promotion validation"));
                    }
                    let prior = rollback
                        .pop()
                        .ok_or_else(|| invalid("invalid rollback history"))?;
                    if transition.to != prior.as_ref().map(|value| value.selection.clone()) {
                        return Err(invalid("invalid rollback target"));
                    }
                    active = prior;
                }
            }
        }
        if active != state.active || rollback != state.rollback {
            return Err(invalid("guideline state does not match its history"));
        }
        Ok(state)
    }

    fn load_active(
        &self,
        selection: &GuidelineSelection,
        promoted_revision: u64,
    ) -> io::Result<ActiveGuideline> {
        let (proposal, proposal_sha256) = self.load_proposal(&selection.version)?;
        if proposal_sha256 != selection.proposal_sha256 {
            return Err(invalid("active proposal hash mismatch"));
        }
        proposal.variant.validate()?;
        Ok(ActiveGuideline {
            selection: selection.clone(),
            variant: proposal.variant,
            promoted_revision,
        })
    }

    fn write_state(&self, state: &StoreState) -> io::Result<()> {
        let next = self.root.join("state.next.json");
        self.write_new(&next, state)?;
        fs::rename(next, self.root.join("state.json"))?;
        fs::File::open(&self.root)?.sync_all()
    }

    fn proposal_path(&self, version: &str) -> io::Result<PathBuf> {
        if !valid_token(version) {
            return Err(invalid("invalid guideline version"));
        }
        Ok(self.root.join("proposals").join(format!("{version}.json")))
    }

    fn validation_path(&self, version: &str, id: &str) -> io::Result<PathBuf> {
        if !valid_token(version) || !valid_token(id) {
            return Err(invalid("invalid guideline validation identity"));
        }
        Ok(self
            .root
            .join("validations")
            .join(format!("{version}--{id}.json")))
    }

    pub fn propose(&self, proposal: GuidelineProposal) -> io::Result<GuidelineSelection> {
        proposal.validate()?;
        let _lock = self.lock()?;
        if let Some(replaces) = &proposal.replaces {
            self.load_proposal(replaces)?;
        }
        let version = proposal.version.clone();
        let proposal_sha256 = self.write_new(&self.proposal_path(&version)?, &proposal)?;
        Ok(GuidelineSelection {
            version,
            proposal_sha256,
        })
    }

    pub fn validate(&self, validation: ValidationRecord) -> io::Result<String> {
        validation.validate()?;
        let _lock = self.lock()?;
        let (proposal, proposal_sha256) = self.load_proposal(&validation.proposal_version)?;
        if proposal_sha256 != validation.proposal_sha256 {
            return Err(invalid("validation proposal hash mismatch"));
        }
        let development_tasks =
            validate_evidence(&proposal.development_evidence, EvidenceSplit::Development)?;
        let validation_tasks =
            validate_evidence(&validation.validation_evidence, EvidenceSplit::Validation)?;
        if !development_tasks.is_disjoint(&validation_tasks) {
            return Err(invalid("development and validation tasks overlap"));
        }
        self.write_new(
            &self.validation_path(&validation.proposal_version, &validation.id)?,
            &validation,
        )
    }

    pub fn promote(&self, request: PromotionRequest) -> io::Result<ActiveGuideline> {
        request.maintainer.validate()?;
        let _lock = self.lock()?;
        let mut state = self.read_state()?;
        let active = state.active.as_ref().map(|value| value.selection.clone());
        if active != request.expected_active {
            return Err(invalid("active guideline changed before promotion"));
        }
        let (proposal, proposal_sha256) = self.load_proposal(&request.proposal.version)?;
        if proposal_sha256 != request.proposal.proposal_sha256 {
            return Err(invalid("promotion proposal hash mismatch"));
        }
        let (validation, validation_sha256) = self.read_record::<ValidationRecord>(
            &self.validation_path(&request.proposal.version, &request.validation_id)?,
        )?;
        if validation_sha256 != request.validation_sha256
            || validation.id != request.validation_id
            || validation.proposal_version != request.proposal.version
            || validation.proposal_sha256 != proposal_sha256
            || validation.outcome != ValidationOutcome::Passed
        {
            return Err(invalid("promotion requires exact passed validation"));
        }
        if state.transitions.len() >= MAX_HISTORY || state.rollback.len() >= MAX_HISTORY {
            return Err(invalid("guideline history limit reached"));
        }
        state.revision += 1;
        let promoted = ActiveGuideline {
            selection: request.proposal.clone(),
            variant: proposal.variant,
            promoted_revision: state.revision,
        };
        state.rollback.push(state.active.clone());
        state.transitions.push(GuidelineTransition {
            revision: state.revision,
            kind: TransitionKind::Promotion,
            from: active,
            to: Some(request.proposal),
            validation_id: Some(request.validation_id),
            validation_sha256: Some(request.validation_sha256),
            maintainer: request.maintainer,
        });
        state.active = Some(promoted.clone());
        self.write_state(&state)?;
        Ok(promoted)
    }

    pub fn rollback(&self, request: RollbackRequest) -> io::Result<Option<ActiveGuideline>> {
        request.maintainer.validate()?;
        let _lock = self.lock()?;
        let mut state = self.read_state()?;
        if state.active.as_ref().map(|value| &value.selection) != Some(&request.expected_active) {
            return Err(invalid("active guideline changed before rollback"));
        }
        let prior = state
            .rollback
            .pop()
            .ok_or_else(|| invalid("no promoted guideline to roll back"))?;
        if state.transitions.len() >= MAX_HISTORY {
            return Err(invalid("guideline history limit reached"));
        }
        state.revision += 1;
        state.transitions.push(GuidelineTransition {
            revision: state.revision,
            kind: TransitionKind::Rollback,
            from: state.active.as_ref().map(|value| value.selection.clone()),
            to: prior.as_ref().map(|value| value.selection.clone()),
            validation_id: None,
            validation_sha256: None,
            maintainer: request.maintainer,
        });
        state.active = prior;
        self.write_state(&state)?;
        Ok(state.active)
    }

    pub fn active(&self) -> io::Result<Option<ActiveGuideline>> {
        Ok(self.read_state()?.active)
    }

    pub fn transitions(&self) -> io::Result<Vec<GuidelineTransition>> {
        Ok(self.read_state()?.transitions)
    }

    pub fn load_proposal(&self, version: &str) -> io::Result<(GuidelineProposal, String)> {
        self.read_record(&self.proposal_path(version)?)
    }
}
