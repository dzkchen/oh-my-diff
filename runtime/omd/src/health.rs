use crate::CodeGraph;
use crate::GraphAnchor;
use crate::GraphConfidence;
use crate::GraphFreshness;
use crate::GraphLimits;
use crate::GraphNode;
use crate::GraphNodeKind;
use crate::GraphRelationship;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fs;
use std::fs::OpenOptions;
use std::io;
use std::io::Write;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

pub const HEALTH_SCHEMA: u32 = 1;
pub const HEALTH_GENERATOR: &str = "omd-focused-code-health-v1";
const MAX_CONSTRAINT_BYTES: usize = 1024 * 1024;
const MAX_BASELINE_BYTES: usize = 24 * 1024 * 1024;
const MAX_REPORT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HealthApproval {
    pub actor: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DependencyConstraint {
    pub id: String,
    pub from_prefix: PathBuf,
    pub denied_to_prefix: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DuplicationConstraint {
    pub id: String,
    pub path_prefixes: Vec<PathBuf>,
    pub minimum_logical_lines: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct VerificationConstraint {
    pub id: String,
    pub test_path_prefix: PathBuf,
    pub minimum_tests: usize,
    pub minimum_assertions_per_test: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HealthConstraints {
    pub schema: u32,
    pub version: String,
    pub repository_identity: String,
    pub approval: HealthApproval,
    pub dependency_boundaries: Vec<DependencyConstraint>,
    pub duplication_scopes: Vec<DuplicationConstraint>,
    pub verification: Vec<VerificationConstraint>,
    pub repair_scope: Vec<PathBuf>,
    pub max_findings: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum HealthFindingKind {
    DependencyBoundary,
    DuplicatedDomainLogic,
    WeakenedCheck,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum HealthCertainty {
    Deterministic,
    Inferred,
    Uncertain,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HealthFindingOrigin {
    Introduced,
    ExistingDebt,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RepairDisposition {
    AuthorizedScope,
    RequiresAuthorization,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HealthCheckSignature {
    pub key: String,
    pub path: PathBuf,
    pub name: String,
    pub body_sha256: String,
    pub normalized_sha256: String,
    pub assertion_markers: usize,
    pub skipped: bool,
    pub evidence: GraphAnchor,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HealthObservation {
    pub fingerprint: String,
    pub kind: HealthFindingKind,
    pub constraint_id: String,
    pub certainty: HealthCertainty,
    pub subject: String,
    pub detail: String,
    pub evidence: Vec<GraphAnchor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HealthBaseline {
    pub schema: u32,
    pub generator: String,
    pub repository_identity: String,
    pub revision: String,
    pub source_digest: String,
    pub constraints_version: String,
    pub constraints_sha256: String,
    pub graph: CodeGraph,
    pub checks: Vec<HealthCheckSignature>,
    pub existing_observations: Vec<HealthObservation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HealthFinding {
    pub fingerprint: String,
    pub kind: HealthFindingKind,
    pub constraint_id: String,
    pub certainty: HealthCertainty,
    pub origin: HealthFindingOrigin,
    pub subject: String,
    pub detail: String,
    pub baseline_evidence: Vec<GraphAnchor>,
    pub current_evidence: Vec<GraphAnchor>,
    pub repair: RepairDisposition,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HealthReport {
    pub schema: u32,
    pub generator: String,
    pub repository_identity: String,
    pub baseline_revision: String,
    pub baseline_source_digest: String,
    pub current_revision: String,
    pub current_source_digest: String,
    pub constraints_version: String,
    pub constraints_sha256: String,
    pub introduced_findings: Vec<HealthFinding>,
    pub existing_debt: Vec<HealthFinding>,
    pub uncertain_findings: Vec<HealthFinding>,
}

#[derive(Clone)]
struct BodySignature {
    key: String,
    path: PathBuf,
    name: String,
    body_sha256: String,
    normalized_sha256: String,
    logical_lines: usize,
    assertion_markers: usize,
    skipped: bool,
    evidence: GraphAnchor,
    is_test: bool,
}

#[derive(Clone)]
struct CandidateObservation {
    kind: HealthFindingKind,
    constraint_id: String,
    certainty: HealthCertainty,
    subject: String,
    detail: String,
    baseline_evidence: Vec<GraphAnchor>,
    current_evidence: Vec<GraphAnchor>,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn bounded_text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= maximum
        && !value.chars().any(|value| value.is_control())
}

fn clean_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn canonical_paths(paths: &[PathBuf]) -> bool {
    paths.iter().all(|path| clean_relative(path)) && paths.windows(2).all(|pair| pair[0] < pair[1])
}

fn safe_source_path(root: &Path, relative: &Path) -> io::Result<PathBuf> {
    if !clean_relative(relative) {
        return Err(invalid("unsafe health source path"));
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(invalid("unsafe health source path"));
        };
        current.push(component);
        if fs::symlink_metadata(&current)?.file_type().is_symlink() {
            return Err(invalid("symlink in health source path"));
        }
    }
    Ok(current)
}

fn atomic_write(path: &Path, prefix: &str, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("health output parent is missing"))?;
    fs::create_dir_all(parent)?;
    for attempt in 0..16 {
        let temporary = parent.join(format!(".{prefix}-{}-{attempt}.tmp", std::process::id()));
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
        {
            Ok(mut file) => {
                file.write_all(bytes)?;
                file.sync_all()?;
                drop(file);
                let result = fs::hard_link(&temporary, path);
                let _ = fs::remove_file(&temporary);
                return result;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(invalid("could not reserve health output"))
}

fn validate_id(value: &str) -> bool {
    bounded_text(value, 96)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
}

impl HealthConstraints {
    pub fn read(path: &Path) -> io::Result<Self> {
        let bytes = fs::read(path)?;
        if bytes.len() > MAX_CONSTRAINT_BYTES {
            return Err(invalid("health constraints exceed size limit"));
        }
        let value: Self =
            serde_json::from_slice(&bytes).map_err(|error| invalid(error.to_string()))?;
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> io::Result<()> {
        if self.schema != HEALTH_SCHEMA
            || !bounded_text(&self.version, 128)
            || !bounded_text(&self.repository_identity, 256)
            || !bounded_text(&self.approval.actor, 128)
            || !bounded_text(&self.approval.reason, 512)
            || !(1..=4_096).contains(&self.max_findings)
            || self.dependency_boundaries.len() > 256
            || self.duplication_scopes.len() > 128
            || self.verification.len() > 128
            || self.repair_scope.len() > 128
        {
            return Err(invalid("invalid health constraint metadata or bounds"));
        }
        let mut ids = BTreeSet::new();
        for rule in &self.dependency_boundaries {
            if !validate_id(&rule.id)
                || !ids.insert(rule.id.clone())
                || !clean_relative(&rule.from_prefix)
                || !clean_relative(&rule.denied_to_prefix)
            {
                return Err(invalid("invalid dependency boundary constraint"));
            }
        }
        for rule in &self.duplication_scopes {
            if !validate_id(&rule.id)
                || !ids.insert(rule.id.clone())
                || rule.path_prefixes.is_empty()
                || rule.path_prefixes.len() > 32
                || !canonical_paths(&rule.path_prefixes)
                || !(2..=200).contains(&rule.minimum_logical_lines)
            {
                return Err(invalid("invalid duplication constraint"));
            }
        }
        for rule in &self.verification {
            if !validate_id(&rule.id)
                || !ids.insert(rule.id.clone())
                || !clean_relative(&rule.test_path_prefix)
                || rule.minimum_tests > 10_000
                || rule.minimum_assertions_per_test > 64
            {
                return Err(invalid("invalid verification constraint"));
            }
        }
        if !canonical_paths(&self.repair_scope) && !self.repair_scope.is_empty() {
            return Err(invalid("invalid repair scope"));
        }
        Ok(())
    }

    pub fn digest(&self) -> io::Result<String> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|error| invalid(error.to_string()))?;
        Ok(sha256(&bytes))
    }
}

fn count_assertions(text: &str) -> usize {
    [
        "assert!",
        "assert_eq!",
        "assert_ne!",
        "assert ",
        "pytest.raises",
        "expect(",
        "assert(",
        "assert.",
        "assertEquals(",
        "assertTrue(",
        "assertFalse(",
        "assertThrows(",
    ]
    .iter()
    .map(|marker| text.matches(marker).count())
    .sum()
}

fn skipped(text: &str) -> bool {
    [
        "#[ignore]",
        "@disabled",
        ".skip(",
        "test.skip",
        "pytest.mark.skip",
        "@unittest.skip",
    ]
    .iter()
    .any(|marker| text.to_ascii_lowercase().contains(marker))
}

fn skip_context(lines: &[&str], start: usize, end: usize) -> String {
    let mut first = start - 1;
    while first > 0 && start - first <= 4 {
        let previous = lines[first - 1].trim();
        if previous.is_empty() || previous.starts_with('#') || previous.starts_with('@') {
            first -= 1;
        } else {
            break;
        }
    }
    lines[first..end].join("\n")
}

fn normalized_body(text: &str, name: &str) -> (String, usize) {
    let mut lines = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || matches!(trimmed, "{" | "}" | "};")
            || trimmed.starts_with("//")
            || trimmed.starts_with('#')
        {
            continue;
        }
        lines.push(trimmed.split_whitespace().collect::<Vec<_>>().join(" "));
    }
    let mut value = lines.join("\n");
    if let Some(index) = value.find(name) {
        value.replace_range(index..index + name.len(), "<symbol>");
    }
    (value, lines.len())
}

fn body_signatures(repository: &Path, graph: &CodeGraph) -> io::Result<Vec<BodySignature>> {
    let root = repository.canonicalize()?;
    let mut by_path: BTreeMap<PathBuf, Vec<&GraphNode>> = BTreeMap::new();
    for node in &graph.nodes {
        if node.kind != GraphNodeKind::Unknown
            && let Some(anchor) = &node.anchor
        {
            by_path.entry(anchor.path.clone()).or_default().push(node);
        }
    }
    let mut bodies = Vec::new();
    for (path, mut nodes) in by_path {
        nodes.sort_by_key(|node| node.anchor.as_ref().map(|anchor| anchor.start_line));
        let text = fs::read_to_string(safe_source_path(&root, &path)?)?;
        let lines = text.lines().collect::<Vec<_>>();
        let mut ordinals = BTreeMap::<String, usize>::new();
        for (index, node) in nodes.iter().enumerate() {
            if !matches!(node.kind, GraphNodeKind::Symbol | GraphNodeKind::Test)
                || node.symbol_kind.as_deref() != Some("function")
            {
                continue;
            }
            let anchor = node
                .anchor
                .as_ref()
                .ok_or_else(|| invalid("health symbol is missing evidence"))?;
            let start = anchor.start_line;
            let end = nodes
                .iter()
                .skip(index + 1)
                .filter_map(|next| next.anchor.as_ref().map(|anchor| anchor.start_line))
                .find(|line| *line > start)
                .map_or(lines.len(), |line| line - 1);
            if start == 0 || end < start || end > lines.len() {
                return Err(invalid("invalid health symbol extent"));
            }
            let body = lines[start - 1..end].join("\n");
            let context = skip_context(&lines, start, end);
            let (normalized, logical_lines) = normalized_body(&body, &node.name);
            let ordinal = ordinals.entry(node.name.clone()).or_default();
            let key = format!("{}:{}:{}", path.display(), node.name, *ordinal);
            *ordinal += 1;
            bodies.push(BodySignature {
                key,
                path: path.clone(),
                name: node.name.clone(),
                body_sha256: sha256(body.as_bytes()),
                normalized_sha256: sha256(normalized.as_bytes()),
                logical_lines,
                assertion_markers: count_assertions(&body),
                skipped: skipped(&context),
                evidence: GraphAnchor {
                    path: path.clone(),
                    start_line: start,
                    end_line: end,
                    sha256: sha256(body.as_bytes()),
                },
                is_test: node.kind == GraphNodeKind::Test,
            });
        }
    }
    bodies.sort_by(|left, right| left.key.cmp(&right.key));
    Ok(bodies)
}

fn check_inventory(bodies: &[BodySignature]) -> Vec<HealthCheckSignature> {
    bodies
        .iter()
        .filter(|body| body.is_test)
        .map(|body| HealthCheckSignature {
            key: body.key.clone(),
            path: body.path.clone(),
            name: body.name.clone(),
            body_sha256: body.body_sha256.clone(),
            normalized_sha256: body.normalized_sha256.clone(),
            assertion_markers: body.assertion_markers,
            skipped: body.skipped,
            evidence: body.evidence.clone(),
        })
        .collect()
}

fn normalized_import(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("crate::")
        .trim_start_matches("self::")
        .trim_start_matches("./")
        .replace("::", "/")
        .replace('.', "/")
}

fn comparable_prefix(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches("src/")
        .trim_start_matches("./")
        .to_string()
}

fn fingerprint(kind: HealthFindingKind, constraint_id: &str, subject: &str) -> String {
    sha256(format!("{kind:?}\0{constraint_id}\0{subject}").as_bytes())
}

fn observation(candidate: CandidateObservation) -> HealthObservation {
    HealthObservation {
        fingerprint: fingerprint(candidate.kind, &candidate.constraint_id, &candidate.subject),
        kind: candidate.kind,
        constraint_id: candidate.constraint_id,
        certainty: candidate.certainty,
        subject: candidate.subject,
        detail: candidate.detail,
        evidence: candidate.current_evidence,
    }
}

fn dependency_observations(
    graph: &CodeGraph,
    constraints: &HealthConstraints,
) -> Vec<CandidateObservation> {
    let nodes = graph
        .nodes
        .iter()
        .map(|node| (&node.id, node))
        .collect::<BTreeMap<_, _>>();
    let mut observations = Vec::new();
    for rule in &constraints.dependency_boundaries {
        for edge in &graph.edges {
            if edge.relationship != GraphRelationship::Imports
                || !edge.evidence.path.starts_with(&rule.from_prefix)
            {
                continue;
            }
            let target = nodes
                .get(&edge.to)
                .and_then(|node| node.anchor.as_ref())
                .map(|anchor| anchor.path.clone());
            if target
                .as_ref()
                .is_some_and(|path| path.starts_with(&rule.denied_to_prefix))
            {
                let target = target.expect("checked target");
                observations.push(CandidateObservation {
                    kind: HealthFindingKind::DependencyBoundary,
                    constraint_id: rule.id.clone(),
                    certainty: if edge.confidence == GraphConfidence::Extracted {
                        HealthCertainty::Deterministic
                    } else {
                        HealthCertainty::Inferred
                    },
                    subject: format!("{}->{}", edge.evidence.path.display(), target.display()),
                    detail: format!(
                        "{} imports denied boundary {}",
                        edge.evidence.path.display(),
                        target.display()
                    ),
                    baseline_evidence: Vec::new(),
                    current_evidence: vec![edge.evidence.clone()],
                });
            } else if edge.confidence == GraphConfidence::Unknown {
                let raw = edge
                    .detail
                    .strip_prefix("unresolved import ")
                    .unwrap_or(&edge.detail);
                let normalized = normalized_import(raw);
                let denied = rule.denied_to_prefix.to_string_lossy();
                let comparable = comparable_prefix(&rule.denied_to_prefix);
                if Path::new(&normalized).starts_with(Path::new(denied.as_ref()))
                    || Path::new(&normalized).starts_with(Path::new(&comparable))
                {
                    observations.push(CandidateObservation {
                        kind: HealthFindingKind::DependencyBoundary,
                        constraint_id: rule.id.clone(),
                        certainty: HealthCertainty::Uncertain,
                        subject: format!(
                            "{}->unresolved:{normalized}",
                            edge.evidence.path.display()
                        ),
                        detail: format!(
                            "{} may import denied boundary {}; the graph target is unresolved",
                            edge.evidence.path.display(),
                            rule.denied_to_prefix.display()
                        ),
                        baseline_evidence: Vec::new(),
                        current_evidence: vec![edge.evidence.clone()],
                    });
                }
            }
        }
    }
    observations
}

fn duplication_observations(
    bodies: &[BodySignature],
    constraints: &HealthConstraints,
) -> Vec<CandidateObservation> {
    let mut observations = Vec::new();
    for rule in &constraints.duplication_scopes {
        let mut groups: BTreeMap<&str, Vec<&BodySignature>> = BTreeMap::new();
        for body in bodies.iter().filter(|body| {
            !body.is_test
                && body.logical_lines >= rule.minimum_logical_lines
                && rule
                    .path_prefixes
                    .iter()
                    .any(|prefix| body.path.starts_with(prefix))
        }) {
            groups
                .entry(&body.normalized_sha256)
                .or_default()
                .push(body);
        }
        for group in groups.values_mut().filter(|group| group.len() > 1) {
            group.sort_by(|left, right| left.key.cmp(&right.key));
            let first = group[0];
            for duplicate in group.iter().skip(1) {
                observations.push(CandidateObservation {
                    kind: HealthFindingKind::DuplicatedDomainLogic,
                    constraint_id: rule.id.clone(),
                    certainty: HealthCertainty::Inferred,
                    subject: format!("{}=={}", first.key, duplicate.key),
                    detail: format!(
                        "{} and {} contain the same normalized domain logic",
                        first.key, duplicate.key
                    ),
                    baseline_evidence: Vec::new(),
                    current_evidence: vec![first.evidence.clone(), duplicate.evidence.clone()],
                });
            }
        }
    }
    observations
}

fn verification_observations(
    checks: &[HealthCheckSignature],
    constraints: &HealthConstraints,
) -> Vec<CandidateObservation> {
    let mut observations = Vec::new();
    for rule in &constraints.verification {
        let selected = checks
            .iter()
            .filter(|check| check.path.starts_with(&rule.test_path_prefix))
            .collect::<Vec<_>>();
        if selected.len() < rule.minimum_tests {
            observations.push(CandidateObservation {
                kind: HealthFindingKind::WeakenedCheck,
                constraint_id: rule.id.clone(),
                certainty: HealthCertainty::Inferred,
                subject: format!("{}:minimum-tests", rule.test_path_prefix.display()),
                detail: format!(
                    "{} contains {} extracted tests; approved minimum is {}",
                    rule.test_path_prefix.display(),
                    selected.len(),
                    rule.minimum_tests
                ),
                baseline_evidence: Vec::new(),
                current_evidence: selected
                    .iter()
                    .take(8)
                    .map(|check| check.evidence.clone())
                    .collect(),
            });
        }
        for check in selected {
            if check.assertion_markers < rule.minimum_assertions_per_test {
                observations.push(CandidateObservation {
                    kind: HealthFindingKind::WeakenedCheck,
                    constraint_id: rule.id.clone(),
                    certainty: HealthCertainty::Inferred,
                    subject: format!("{}:minimum-assertions", check.key),
                    detail: format!(
                        "{} has {} assertion markers; approved minimum is {}",
                        check.key, check.assertion_markers, rule.minimum_assertions_per_test
                    ),
                    baseline_evidence: Vec::new(),
                    current_evidence: vec![check.evidence.clone()],
                });
            }
            if check.skipped {
                observations.push(CandidateObservation {
                    kind: HealthFindingKind::WeakenedCheck,
                    constraint_id: rule.id.clone(),
                    certainty: HealthCertainty::Inferred,
                    subject: format!("{}:skipped", check.key),
                    detail: format!("{} is marked skipped or ignored", check.key),
                    baseline_evidence: Vec::new(),
                    current_evidence: vec![check.evidence.clone()],
                });
            }
        }
    }
    observations
}

fn static_observations(
    graph: &CodeGraph,
    bodies: &[BodySignature],
    checks: &[HealthCheckSignature],
    constraints: &HealthConstraints,
) -> io::Result<Vec<CandidateObservation>> {
    let mut observations = dependency_observations(graph, constraints);
    observations.extend(duplication_observations(bodies, constraints));
    observations.extend(verification_observations(checks, constraints));
    canonicalize_candidates(observations, constraints.max_findings)
}

fn weakened_observations(
    baseline: &[HealthCheckSignature],
    current: &[HealthCheckSignature],
    constraints: &HealthConstraints,
) -> Vec<CandidateObservation> {
    let current = current
        .iter()
        .map(|check| (&check.key, check))
        .collect::<BTreeMap<_, _>>();
    let mut observations = Vec::new();
    for rule in &constraints.verification {
        for before in baseline
            .iter()
            .filter(|check| check.path.starts_with(&rule.test_path_prefix))
        {
            match current.get(&before.key) {
                None => observations.push(CandidateObservation {
                    kind: HealthFindingKind::WeakenedCheck,
                    constraint_id: rule.id.clone(),
                    certainty: HealthCertainty::Inferred,
                    subject: format!("{}:removed", before.key),
                    detail: format!(
                        "baseline test {} is absent from the current source graph",
                        before.key
                    ),
                    baseline_evidence: vec![before.evidence.clone()],
                    current_evidence: Vec::new(),
                }),
                Some(after) => {
                    if after.assertion_markers < before.assertion_markers {
                        observations.push(CandidateObservation {
                            kind: HealthFindingKind::WeakenedCheck,
                            constraint_id: rule.id.clone(),
                            certainty: HealthCertainty::Inferred,
                            subject: format!("{}:assertions-reduced", before.key),
                            detail: format!(
                                "{} assertion markers decreased from {} to {}",
                                before.key, before.assertion_markers, after.assertion_markers
                            ),
                            baseline_evidence: vec![before.evidence.clone()],
                            current_evidence: vec![after.evidence.clone()],
                        });
                    }
                    if !before.skipped && after.skipped {
                        observations.push(CandidateObservation {
                            kind: HealthFindingKind::WeakenedCheck,
                            constraint_id: rule.id.clone(),
                            certainty: HealthCertainty::Inferred,
                            subject: format!("{}:newly-skipped", before.key),
                            detail: format!(
                                "{} became skipped or ignored after the baseline",
                                before.key
                            ),
                            baseline_evidence: vec![before.evidence.clone()],
                            current_evidence: vec![after.evidence.clone()],
                        });
                    }
                }
            }
        }
    }
    observations
}

fn candidate_fingerprint(candidate: &CandidateObservation) -> String {
    fingerprint(candidate.kind, &candidate.constraint_id, &candidate.subject)
}

fn canonicalize_candidates(
    candidates: Vec<CandidateObservation>,
    maximum: usize,
) -> io::Result<Vec<CandidateObservation>> {
    if candidates.len() > maximum {
        return Err(invalid("health finding limit exceeded"));
    }
    let mut values: BTreeMap<String, CandidateObservation> = BTreeMap::new();
    for candidate in candidates {
        let key = candidate_fingerprint(&candidate);
        if let Some(existing) = values.get_mut(&key) {
            if existing.kind != candidate.kind
                || existing.constraint_id != candidate.constraint_id
                || existing.certainty != candidate.certainty
                || existing.subject != candidate.subject
                || existing.detail != candidate.detail
            {
                return Err(invalid("conflicting duplicate health finding"));
            }
            existing
                .baseline_evidence
                .extend(candidate.baseline_evidence);
            existing.current_evidence.extend(candidate.current_evidence);
            existing.baseline_evidence.sort();
            existing.baseline_evidence.dedup();
            existing.current_evidence.sort();
            existing.current_evidence.dedup();
            if existing.baseline_evidence.len() > 32 || existing.current_evidence.len() > 32 {
                return Err(invalid("health finding evidence limit exceeded"));
            }
        } else {
            values.insert(key, candidate);
        }
    }
    Ok(values.into_values().collect())
}

fn repair_disposition(candidate: &CandidateObservation, scope: &[PathBuf]) -> RepairDisposition {
    let evidence = candidate
        .baseline_evidence
        .iter()
        .chain(&candidate.current_evidence)
        .collect::<Vec<_>>();
    if !evidence.is_empty()
        && evidence
            .iter()
            .all(|anchor| scope.iter().any(|prefix| anchor.path.starts_with(prefix)))
    {
        RepairDisposition::AuthorizedScope
    } else {
        RepairDisposition::RequiresAuthorization
    }
}

fn finding(
    candidate: CandidateObservation,
    origin: HealthFindingOrigin,
    constraints: &HealthConstraints,
) -> HealthFinding {
    let repair = repair_disposition(&candidate, &constraints.repair_scope);
    HealthFinding {
        fingerprint: candidate_fingerprint(&candidate),
        kind: candidate.kind,
        constraint_id: candidate.constraint_id,
        certainty: candidate.certainty,
        origin,
        subject: candidate.subject,
        detail: candidate.detail,
        baseline_evidence: candidate.baseline_evidence,
        current_evidence: candidate.current_evidence,
        repair,
    }
}

fn validate_anchor(anchor: &GraphAnchor) -> bool {
    clean_relative(&anchor.path)
        && anchor.start_line > 0
        && anchor.end_line >= anchor.start_line
        && valid_sha256(&anchor.sha256)
}

fn validate_check(check: &HealthCheckSignature) -> bool {
    bounded_text(&check.key, 1_024)
        && clean_relative(&check.path)
        && bounded_text(&check.name, 256)
        && valid_sha256(&check.body_sha256)
        && valid_sha256(&check.normalized_sha256)
        && check.assertion_markers <= 10_000
        && validate_anchor(&check.evidence)
        && check.evidence.path == check.path
}

fn validate_observation(observation: &HealthObservation) -> bool {
    valid_sha256(&observation.fingerprint)
        && validate_id(&observation.constraint_id)
        && bounded_text(&observation.subject, 2_048)
        && bounded_text(&observation.detail, 4_096)
        && observation.evidence.len() <= 32
        && observation.evidence.iter().all(validate_anchor)
        && observation.fingerprint
            == fingerprint(
                observation.kind,
                &observation.constraint_id,
                &observation.subject,
            )
}

impl HealthBaseline {
    pub fn build(
        repository: &Path,
        constraints: &HealthConstraints,
        revision: String,
        limits: GraphLimits,
    ) -> io::Result<Self> {
        constraints.validate()?;
        let graph = CodeGraph::build(
            repository,
            constraints.repository_identity.clone(),
            revision.clone(),
            limits,
        )?;
        let bodies = body_signatures(repository, &graph)?;
        if graph.freshness(repository)? != GraphFreshness::Fresh {
            return Err(invalid("repository changed while building health baseline"));
        }
        let checks = check_inventory(&bodies);
        let existing_observations = static_observations(&graph, &bodies, &checks, constraints)?
            .into_iter()
            .map(observation)
            .collect();
        let baseline = Self {
            schema: HEALTH_SCHEMA,
            generator: HEALTH_GENERATOR.to_string(),
            repository_identity: constraints.repository_identity.clone(),
            revision,
            source_digest: graph.repository.source_digest.clone(),
            constraints_version: constraints.version.clone(),
            constraints_sha256: constraints.digest()?,
            graph,
            checks,
            existing_observations,
        };
        baseline.validate()?;
        Ok(baseline)
    }

    pub fn read(path: &Path) -> io::Result<Self> {
        let bytes = fs::read(path)?;
        if bytes.len() > MAX_BASELINE_BYTES {
            return Err(invalid("health baseline exceeds size limit"));
        }
        let baseline: Self =
            serde_json::from_slice(&bytes).map_err(|error| invalid(error.to_string()))?;
        baseline.validate()?;
        Ok(baseline)
    }

    pub fn write(&self, path: &Path) -> io::Result<()> {
        self.validate()?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| invalid(error.to_string()))?;
        if bytes.len() > MAX_BASELINE_BYTES {
            return Err(invalid("health baseline exceeds size limit"));
        }
        atomic_write(path, "omd-health-baseline", &bytes)
    }

    pub fn validate(&self) -> io::Result<()> {
        self.graph.validate()?;
        if self.schema != HEALTH_SCHEMA
            || self.generator != HEALTH_GENERATOR
            || !bounded_text(&self.repository_identity, 256)
            || !bounded_text(&self.revision, 256)
            || !bounded_text(&self.constraints_version, 128)
            || !valid_sha256(&self.source_digest)
            || !valid_sha256(&self.constraints_sha256)
            || self.repository_identity != self.graph.repository.identity
            || self.revision != self.graph.repository.revision
            || self.source_digest != self.graph.repository.source_digest
            || self.checks.len() > 10_000
            || self.existing_observations.len() > 4_096
            || self.checks.iter().any(|check| !validate_check(check))
            || self
                .existing_observations
                .iter()
                .any(|finding| !validate_observation(finding))
            || self
                .checks
                .windows(2)
                .any(|pair| pair[0].key >= pair[1].key)
            || self
                .existing_observations
                .windows(2)
                .any(|pair| pair[0].fingerprint >= pair[1].fingerprint)
        {
            return Err(invalid("invalid health baseline"));
        }
        Ok(())
    }

    pub fn check(
        &self,
        repository: &Path,
        constraints: &HealthConstraints,
        current_revision: String,
    ) -> io::Result<HealthReport> {
        self.validate()?;
        constraints.validate()?;
        if constraints.repository_identity != self.repository_identity
            || constraints.version != self.constraints_version
            || constraints.digest()? != self.constraints_sha256
            || current_revision.trim().is_empty()
            || current_revision.len() > 256
        {
            return Err(invalid(
                "health baseline and approved constraints do not match",
            ));
        }
        let graph = CodeGraph::build(
            repository,
            self.repository_identity.clone(),
            current_revision.clone(),
            self.graph.limits,
        )?;
        let bodies = body_signatures(repository, &graph)?;
        let checks = check_inventory(&bodies);
        let mut candidates = static_observations(&graph, &bodies, &checks, constraints)?;
        candidates.extend(weakened_observations(&self.checks, &checks, constraints));
        let candidates = canonicalize_candidates(candidates, constraints.max_findings)?;
        if graph.freshness(repository)? != GraphFreshness::Fresh {
            return Err(invalid("repository changed while running health check"));
        }
        let existing = self
            .existing_observations
            .iter()
            .map(|finding| finding.fingerprint.as_str())
            .collect::<BTreeSet<_>>();
        let mut introduced_findings = Vec::new();
        let mut existing_debt = Vec::new();
        let mut uncertain_findings = Vec::new();
        for candidate in candidates {
            let origin = if existing.contains(candidate_fingerprint(&candidate).as_str()) {
                HealthFindingOrigin::ExistingDebt
            } else {
                HealthFindingOrigin::Introduced
            };
            let uncertain = candidate.certainty == HealthCertainty::Uncertain;
            let finding = finding(candidate, origin, constraints);
            if uncertain {
                uncertain_findings.push(finding);
            } else if origin == HealthFindingOrigin::ExistingDebt {
                existing_debt.push(finding);
            } else {
                introduced_findings.push(finding);
            }
        }
        let report = HealthReport {
            schema: HEALTH_SCHEMA,
            generator: HEALTH_GENERATOR.to_string(),
            repository_identity: self.repository_identity.clone(),
            baseline_revision: self.revision.clone(),
            baseline_source_digest: self.source_digest.clone(),
            current_revision,
            current_source_digest: graph.repository.source_digest,
            constraints_version: constraints.version.clone(),
            constraints_sha256: self.constraints_sha256.clone(),
            introduced_findings,
            existing_debt,
            uncertain_findings,
        };
        report.validate(constraints.max_findings)?;
        Ok(report)
    }
}

impl HealthReport {
    pub fn has_introduced_findings(&self) -> bool {
        !self.introduced_findings.is_empty()
    }

    pub fn write(&self, path: &Path) -> io::Result<()> {
        self.validate(4_096)?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| invalid(error.to_string()))?;
        if bytes.len() > MAX_REPORT_BYTES {
            return Err(invalid("health report exceeds size limit"));
        }
        atomic_write(path, "omd-health-report", &bytes)
    }

    fn validate(&self, maximum: usize) -> io::Result<()> {
        let findings = self
            .introduced_findings
            .iter()
            .chain(&self.existing_debt)
            .chain(&self.uncertain_findings)
            .collect::<Vec<_>>();
        if self.schema != HEALTH_SCHEMA
            || self.generator != HEALTH_GENERATOR
            || !bounded_text(&self.repository_identity, 256)
            || !bounded_text(&self.baseline_revision, 256)
            || !bounded_text(&self.current_revision, 256)
            || !bounded_text(&self.constraints_version, 128)
            || !valid_sha256(&self.baseline_source_digest)
            || !valid_sha256(&self.current_source_digest)
            || !valid_sha256(&self.constraints_sha256)
            || findings.len() > maximum
        {
            return Err(invalid("invalid health report"));
        }
        let mut fingerprints = BTreeSet::new();
        for finding in findings {
            if !valid_sha256(&finding.fingerprint)
                || !validate_id(&finding.constraint_id)
                || !bounded_text(&finding.subject, 2_048)
                || !bounded_text(&finding.detail, 4_096)
                || finding.baseline_evidence.len() > 32
                || finding.current_evidence.len() > 32
                || finding
                    .baseline_evidence
                    .iter()
                    .chain(&finding.current_evidence)
                    .any(|anchor| !validate_anchor(anchor))
                || !fingerprints.insert(&finding.fingerprint)
                || finding.fingerprint
                    != fingerprint(finding.kind, &finding.constraint_id, &finding.subject)
            {
                return Err(invalid("invalid health finding"));
            }
        }
        if self.introduced_findings.iter().any(|finding| {
            finding.origin != HealthFindingOrigin::Introduced
                || finding.certainty == HealthCertainty::Uncertain
        }) || self.existing_debt.iter().any(|finding| {
            finding.origin != HealthFindingOrigin::ExistingDebt
                || finding.certainty == HealthCertainty::Uncertain
        }) || self
            .uncertain_findings
            .iter()
            .any(|finding| finding.certainty != HealthCertainty::Uncertain)
        {
            return Err(invalid("health finding classification mismatch"));
        }
        Ok(())
    }
}
