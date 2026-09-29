use super::*;
use codex_omd::ContractDocument;
use codex_omd::Gate;
use codex_omd::Receipt;
use std::collections::BTreeSet;

const RECEIPT_LIMIT: usize = 256;
pub(crate) const STATE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Restriction {
    operation: String,
    when: std::collections::BTreeMap<String, Value>,
}

impl Restriction {
    fn valid(&self) -> bool {
        codex_omd::MOD_HOST_OPERATIONS.contains(&self.operation.as_str())
            && !self.when.is_empty()
            && self.when.len() <= 8
            && self.when.iter().all(|(path, value)| {
                path.starts_with('/')
                    && path.len() <= 128
                    && !value.is_array()
                    && !value.is_object()
                    && value.as_str().is_none_or(|value| value.len() <= 256)
            })
    }

    fn matches(&self, operation: &str, arguments: &Value) -> bool {
        self.operation == operation
            && self
                .when
                .iter()
                .all(|(path, value)| arguments.pointer(path) == Some(value))
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ContractStatus {
    None,
    Active,
    #[default]
    Unavailable,
}

pub(crate) enum GateOutcome {
    Missing(Vec<codex_omd::ContractRequirement>),
    Unresolved(Vec<String>),
}

impl GateOutcome {
    pub(crate) fn event(&self, gate: Gate, candidate_sha256: &str) -> Value {
        match self {
            Self::Missing(missing) => json!({"gate": gate,
                "outcome": if missing.is_empty() {"passed"} else {"refused"},
                "missing": missing, "candidate_sha256": candidate_sha256}),
            Self::Unresolved(outstanding) => json!({"gate": gate, "outcome": "refused",
                "reason": "unresolved_blocking_findings", "outstanding_findings": outstanding,
                "candidate_sha256": candidate_sha256}),
        }
    }

    pub(crate) fn refusal(&self) -> Option<Value> {
        match self {
            Self::Missing(missing) if missing.is_empty() => None,
            Self::Missing(missing) => Some(json!({"status": "refused", "missing": missing})),
            Self::Unresolved(outstanding) => Some(json!({"status": "refused",
                "reason": "unresolved_blocking_findings", "outstanding_findings": outstanding})),
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct SessionContract {
    active: Option<ContractDocument>,
    status: ContractStatus,
    provenance: Value,
    restrictions: BTreeSet<String>,
    scoped_restrictions: Vec<Restriction>,
    receipts: Vec<Receipt>,
    finding_ledger: codex_omd::FindingLedger,
}

impl SessionContract {
    pub(crate) fn invalidate(&mut self, error: String) {
        self.status = ContractStatus::Unavailable;
        self.provenance["error"] = json!(error);
    }

    pub(crate) fn revalidate(
        &mut self,
        documents: &[(ContractDocument, codex_omd::PolicyOwner)],
    ) -> bool {
        let Some(active) = &self.active else {
            return false;
        };
        let registered = documents
            .iter()
            .any(|(document, _)| document.digest() == active.digest());
        match (self.status, registered) {
            (ContractStatus::Active, false) => {
                self.invalidate("contract_withdrawn".into());
                true
            }
            (ContractStatus::Unavailable, true)
                if self.provenance["error"] == "contract_withdrawn" =>
            {
                self.status = ContractStatus::Active;
                if let Some(provenance) = self.provenance.as_object_mut() {
                    provenance.remove("error");
                }
                true
            }
            _ => false,
        }
    }

    pub(crate) fn restore(&mut self, path: &std::path::Path) -> Result<(), String> {
        use std::io::Read;
        use std::os::unix::fs::MetadataExt;
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > STATE_BYTES as u64 {
            return Err("contract_state_file_invalid".into());
        }
        let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
        let opened = file.metadata().map_err(|error| error.to_string())?;
        if opened.dev() != metadata.dev() || opened.ino() != metadata.ino() {
            return Err("contract_state_file_changed".into());
        }
        let mut bytes = Vec::new();
        file.take(STATE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() > STATE_BYTES {
            return Err("contract_state_byte_limit".into());
        }
        self.restore_value(serde_json::from_slice(&bytes).map_err(|error| error.to_string())?)
    }

    fn restore_value(&mut self, value: Value) -> Result<(), String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Saved {
            status: ContractStatus,
            active: Option<ContractDocument>,
            provenance: Value,
            restrictions: BTreeSet<String>,
            #[serde(default)]
            scoped_restrictions: Vec<Restriction>,
            receipts: Vec<Receipt>,
            finding_ledger: codex_omd::FindingLedger,
        }
        let saved: Saved = serde_json::from_value(value).map_err(|error| error.to_string())?;
        if saved.status == ContractStatus::Unavailable
            || saved.status != self.status
            || saved.active.as_ref().map(ContractDocument::digest)
                != self.active.as_ref().map(ContractDocument::digest)
            || saved.provenance.get("owner") != self.provenance.get("owner")
            || saved.receipts.len() > RECEIPT_LIMIT
            || saved
                .restrictions
                .iter()
                .any(|operation| !codex_omd::MOD_HOST_OPERATIONS.contains(&operation.as_str()))
            || !self.restrictions.is_subset(&saved.restrictions)
            || saved.scoped_restrictions.len() > 64
            || saved.scoped_restrictions.iter().any(|rule| !rule.valid())
            || self
                .scoped_restrictions
                .iter()
                .any(|rule| !saved.scoped_restrictions.contains(rule))
        {
            return Err("contract_state_selection_changed_or_invalid".into());
        }
        for receipt in &saved.receipts {
            receipt.validate()?;
        }
        let replayed = codex_omd::replay_finding_receipts(&saved.receipts)?;
        if replayed != saved.finding_ledger {
            return Err("contract_finding_ledger_mismatch".into());
        }
        self.restrictions = saved.restrictions;
        self.scoped_restrictions = saved.scoped_restrictions;
        self.receipts = saved.receipts;
        self.finding_ledger = replayed;
        Ok(())
    }
    pub(crate) fn resolve(
        host: &Host,
        documents: &[(ContractDocument, codex_omd::PolicyOwner)],
    ) -> Self {
        let user_path = host
            .config
            .contract
            .user
            .clone()
            .unwrap_or_else(|| host.root.join(codex_omd::USER_CONTRACT_SELECTION));
        let selections = codex_omd::ContractSelection::read(&user_path).and_then(|user| {
            codex_omd::ContractSelection::read(
                &host.repository.join(codex_omd::PROJECT_CONTRACT_SELECTION),
            )
            .map(|project| (user, project))
        });
        let (user, project) = match selections {
            Ok(selections) => selections,
            Err(error) => {
                return Self {
                    status: ContractStatus::Unavailable,
                    provenance: json!({"error": error}),
                    ..Self::default()
                };
            }
        };
        match codex_omd::resolve_contract(documents, user.as_ref(), project.as_ref()) {
            codex_omd::ContractResolution::None => Self {
                status: ContractStatus::None,
                ..Self::default()
            },
            codex_omd::ContractResolution::Active {
                document,
                owner,
                source,
                overrode,
            } => {
                let mut contract = Self::activate(document, owner, source);
                if let Some(overrode) = overrode {
                    contract.provenance["overrode"] = json!(overrode);
                }
                contract
            }
            codex_omd::ContractResolution::Unavailable(error) => Self {
                status: ContractStatus::Unavailable,
                provenance: json!({"error": error}),
                ..Self::default()
            },
        }
    }

    fn activate(document: ContractDocument, owner: codex_omd::PolicyOwner, source: &str) -> Self {
        Self {
            restrictions: document.restrict.iter().cloned().collect(),
            scoped_restrictions: Vec::new(),
            provenance: json!({"source": source, "owner": owner, "digest": document.digest()}),
            status: ContractStatus::Active,
            active: Some(document),
            receipts: Vec::new(),
            finding_ledger: codex_omd::FindingLedger::new(),
        }
    }

    pub(crate) fn restricted(&self, operation: &str, arguments: &Value) -> Result<(), String> {
        if self.status == ContractStatus::Unavailable {
            return Err("contract_unavailable".into());
        }
        if self.restrictions.contains(operation)
            || self
                .scoped_restrictions
                .iter()
                .any(|rule| rule.matches(operation, arguments))
        {
            return Err(format!("contract_restricted_operation: {operation}"));
        }
        Ok(())
    }

    pub(crate) fn status(&self) -> Value {
        json!({"status": self.status, "active": self.active, "provenance": self.provenance,
            "receipts": self.receipts, "finding_ledger": self.finding_ledger,
            "restrictions": self.restrictions, "scoped_restrictions": self.scoped_restrictions})
    }

    pub(crate) fn restrict(&mut self, arguments: Value) -> Result<Value, String> {
        if self.status == ContractStatus::Unavailable {
            return Err("contract_unavailable".into());
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            #[serde(default)]
            operations: Vec<String>,
            #[serde(default)]
            scoped: Vec<Restriction>,
            reason: String,
        }
        let input: Input = serde_json::from_value(arguments).map_err(|error| error.to_string())?;
        if input.operations.is_empty() && input.scoped.is_empty()
            || input.operations.len() > 16
            || input.scoped.iter().any(|rule| !rule.valid())
            || input.scoped.len() + self.scoped_restrictions.len() > 64
            || input.reason.is_empty()
            || input.reason.len() > 512
            || input
                .operations
                .iter()
                .any(|operation| !codex_omd::MOD_HOST_OPERATIONS.contains(&operation.as_str()))
        {
            return Err("contract_restriction_invalid".into());
        }
        self.restrictions.extend(input.operations);
        for rule in input.scoped {
            if !self.scoped_restrictions.contains(&rule) {
                self.scoped_restrictions.push(rule);
            }
        }
        Ok(
            json!({"restrictions": self.restrictions, "scoped_restrictions": self.scoped_restrictions}),
        )
    }

    pub(crate) fn admit(&self, receipt: &Receipt) -> Result<(), String> {
        self.clone().submit(receipt.clone()).map(|_| ())
    }

    pub(crate) fn submit(&mut self, receipt: Receipt) -> Result<Value, String> {
        if self.status == ContractStatus::Unavailable {
            return Err("contract_unavailable".into());
        }
        receipt.validate()?;
        if self.receipts.len() >= RECEIPT_LIMIT {
            return Err("receipt_limit".into());
        }
        let mut finding_ledger = self.finding_ledger.clone();
        codex_omd::apply_finding_receipt(&mut finding_ledger, &receipt, self.receipts.len())?;
        self.receipts.push(receipt.clone());
        let prior_ledger = std::mem::replace(&mut self.finding_ledger, finding_ledger);
        if serde_json::to_vec(&self.status())
            .map_err(|error| error.to_string())?
            .len()
            > STATE_BYTES
        {
            self.receipts.pop();
            self.finding_ledger = prior_ledger;
            return Err("contract_state_byte_limit".into());
        }
        serde_json::to_value(receipt).map_err(|error| error.to_string())
    }

    pub(crate) fn gate(
        &self,
        gate: Gate,
        candidate_sha256: &str,
        acceptance_sha256: Option<&str>,
    ) -> Result<GateOutcome, String> {
        match (self.status, &self.active) {
            (ContractStatus::None, _) => Ok(GateOutcome::Missing(Vec::new())),
            (ContractStatus::Active, Some(document)) => {
                let outstanding = if gate == Gate::Complete {
                    self.outstanding_findings()
                } else {
                    Vec::new()
                };
                if !outstanding.is_empty() {
                    return Ok(GateOutcome::Unresolved(outstanding));
                }
                Ok(GateOutcome::Missing(document.missing(
                    gate,
                    &self.receipts,
                    candidate_sha256,
                    acceptance_sha256,
                )))
            }
            _ => Err(
                "selected contract is unavailable; completion and integration fail closed".into(),
            ),
        }
    }

    pub(crate) fn outstanding_findings(&self) -> Vec<String> {
        self.finding_ledger
            .iter()
            .filter(|(_, entry)| entry.resolution.is_none())
            .map(|(fingerprint, _)| fingerprint.clone())
            .collect()
    }

    pub(crate) fn resolution_context(
        &self,
        candidate_sha256: &str,
        acceptance_sha256: &str,
        fingerprints: &[String],
    ) -> Result<Vec<codex_omd::FindingLedgerEntry>, String> {
        if self.status != ContractStatus::Active || self.active.is_none() {
            return Err("finding_resolution_contract_inactive".into());
        }
        if fingerprints.is_empty()
            || fingerprints.len() > 32
            || fingerprints.iter().collect::<BTreeSet<_>>().len() != fingerprints.len()
        {
            return Err("finding_resolution_context_invalid".into());
        }
        fingerprints
            .iter()
            .map(|fingerprint| {
                let entry = self
                    .finding_ledger
                    .get(fingerprint)
                    .ok_or("finding_resolution_unknown")?;
                if entry.resolution.is_some() {
                    return Err("finding_already_resolved".into());
                }
                if entry.reported_candidate_sha256 == candidate_sha256 {
                    return Err("finding_resolution_candidate_unchanged".into());
                }
                if entry.acceptance_sha256 != acceptance_sha256 {
                    return Err("finding_resolution_acceptance_changed".into());
                }
                Ok(entry.clone())
            })
            .collect()
    }
}

pub(crate) fn current_candidate(host: &Host) -> Result<String, String> {
    let approved = host.config.approved_untracked.iter().cloned().collect();
    codex_omd::capture_tracked(&host.repository, &approved, host.config.snapshot_bytes)
        .and_then(|snapshot| snapshot.hash())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> codex_omd::PolicyOwner {
        codex_omd::PolicyOwner {
            id: "fixture".into(),
            version: "1.0.0".into(),
            source: "fixture".into(),
            sha256: "0".repeat(64),
        }
    }

    trait Missing {
        fn missing(self) -> Result<Vec<codex_omd::ContractRequirement>, String>;
    }

    impl Missing for Result<GateOutcome, String> {
        fn missing(self) -> Result<Vec<codex_omd::ContractRequirement>, String> {
            match self? {
                GateOutcome::Missing(missing) => Ok(missing),
                GateOutcome::Unresolved(outstanding) => Err(outstanding.join(",")),
            }
        }
    }

    fn document(value: Value) -> ContractDocument {
        ContractDocument::parse(&value).unwrap()
    }

    #[test]
    fn admission_reports_a_full_contract_without_recording_the_probe() {
        let active = document(
            json!({"schema":2,"id":"checked","version":1,"description":"Checks",
            "assurance":"checked","gates":{"complete":[{"receipt":"checks","bind":["candidate"]}]}}),
        );
        let mut contract = SessionContract::activate(active, owner(), "user");
        let receipt = |index: usize| -> Receipt {
            serde_json::from_value(json!({"kind":"checks","candidate_sha256":"a".repeat(64),
            "outcome":"pass","evidence":{"reference":format!("fixture-{index}"),"sha256":"b".repeat(64)},
            "producer":{"kind":"lead","handle":null},"submitted_by":"fixture","at":1}))
            .unwrap()
        };
        contract.admit(&receipt(0)).unwrap();
        assert!(contract.receipts.is_empty());
        for index in 0..RECEIPT_LIMIT {
            contract.submit(receipt(index)).unwrap();
        }
        assert_eq!(
            contract.admit(&receipt(RECEIPT_LIMIT)).unwrap_err(),
            "receipt_limit"
        );
        assert_eq!(contract.receipts.len(), RECEIPT_LIMIT);
    }

    #[test]
    fn no_selection_means_no_gate_and_restrictions_are_enforced() {
        let mut contract = SessionContract {
            status: ContractStatus::None,
            ..Default::default()
        };
        assert!(
            contract
                .gate(Gate::Complete, &"a".repeat(64), None)
                .missing()
                .unwrap()
                .is_empty()
        );
        contract
            .restrict(json!({"operations":["agents.spawn"],"reason":"solo"}))
            .unwrap();
        assert!(contract.restricted("agents.spawn", &Value::Null).is_err());
        assert!(contract.restricted("exec.run", &Value::Null).is_ok());
        assert!(
            contract
                .restrict(json!({"operations":["unknown.operation"],"reason":"x"}))
                .is_err()
        );
    }

    #[test]
    fn active_contracts_require_bound_receipts_and_unavailable_contracts_fail_closed() {
        let active = document(
            json!({"schema":2,"id":"checked","version":1,"description":"Checks",
            "assurance":"checked","gates":{"complete":[{"receipt":"checks","bind":["candidate"]}]}}),
        );
        let mut contract = SessionContract::activate(active, owner(), "user");
        let candidate = "a".repeat(64);
        assert_eq!(
            contract
                .gate(Gate::Complete, &candidate, None)
                .missing()
                .unwrap()
                .len(),
            1
        );
        let receipt: Receipt =
            serde_json::from_value(json!({"kind":"checks","candidate_sha256":candidate,
            "outcome":"pass","evidence":{"reference":"b".repeat(64),"sha256":"b".repeat(64)},
            "producer":{"kind":"lead","handle":null},"submitted_by":"fixture","at":1}))
            .unwrap();
        contract.submit(receipt).unwrap();
        assert!(
            contract
                .gate(Gate::Complete, &candidate, None)
                .missing()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            contract
                .gate(Gate::Complete, &"c".repeat(64), None)
                .missing()
                .unwrap()
                .len(),
            1
        );
        let registered = [(contract.active.clone().unwrap(), owner())];
        assert!(!contract.revalidate(&registered));
        assert!(contract.revalidate(&[]));
        assert!(
            contract
                .gate(Gate::Complete, &candidate, None)
                .missing()
                .is_err()
        );
        assert!(contract.submit(contract.receipts[0].clone()).is_err());
        assert!(contract.revalidate(&registered));
        assert!(
            contract
                .gate(Gate::Complete, &candidate, None)
                .missing()
                .unwrap()
                .is_empty()
        );
        let mut failed = contract.receipts[0].clone();
        failed.outcome = codex_omd::ReceiptOutcome::Fail;
        contract.submit(failed).unwrap();
        assert_eq!(
            contract
                .gate(Gate::Complete, &candidate, None)
                .missing()
                .unwrap()
                .len(),
            1
        );
        let unavailable = SessionContract {
            status: ContractStatus::Unavailable,
            ..Default::default()
        };
        assert!(
            unavailable
                .gate(Gate::Integrate, &candidate, None)
                .missing()
                .is_err()
        );
    }

    #[test]
    fn restart_restores_bound_receipts_and_restrictions_without_accepting_changed_selection() {
        let definition = document(
            json!({"schema":2,"id":"checked","version":1,"description":"Checks",
            "assurance":"checked","gates":{"complete":[{"receipt":"checks","bind":["candidate","acceptance"]}],
            "integrate":[{"receipt":"checks","bind":["candidate","acceptance"]}]}}),
        );
        let mut before = SessionContract::activate(definition.clone(), owner(), "user");
        let candidate = "a".repeat(64);
        let acceptance = "c".repeat(64);
        before
            .submit(
                serde_json::from_value(json!({"kind":"checks","candidate_sha256":candidate,
            "acceptance_sha256":acceptance,"outcome":"pass",
            "evidence":{"reference":"fixture","sha256":"b".repeat(64)},
            "producer":{"kind":"lead","handle":null},"submitted_by":"fixture","at":1}))
                .unwrap(),
            )
            .unwrap();
        before
            .restrict(json!({"operations":["agents.spawn"],"reason":"sealed"}))
            .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("contract.json");
        std::fs::write(&path, serde_json::to_vec(&before.status()).unwrap()).unwrap();
        let mut after = SessionContract::activate(definition.clone(), owner(), "user");
        after.restore(&path).unwrap();
        assert!(after.restricted("agents.spawn", &Value::Null).is_err());
        for gate in [Gate::Complete, Gate::Integrate] {
            assert!(
                after
                    .gate(gate, &candidate, Some(&acceptance))
                    .missing()
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(
                after.gate(gate, &candidate, None).missing().unwrap().len(),
                1
            );
            assert_eq!(
                after
                    .gate(gate, &candidate, Some(&"d".repeat(64)))
                    .missing()
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(
                after
                    .gate(gate, &"e".repeat(64), Some(&acceptance))
                    .missing()
                    .unwrap()
                    .len(),
                1
            );
        }
        let mut changed = definition;
        changed.assurance = "changed".into();
        let mut changed = SessionContract::activate(changed, owner(), "user");
        let error = changed.restore(&path).unwrap_err();
        changed.invalidate(error);
        assert!(
            changed
                .gate(Gate::Complete, &candidate, Some(&acceptance))
                .missing()
                .is_err()
        );
        std::fs::write(&path, b"{").unwrap();
        assert!(after.restore(&path).is_err());
        let link = directory.path().join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(after.restore(&link).is_err());
    }

    #[test]
    fn argument_restrictions_are_monotone_and_survive_restart() {
        let mut contract = SessionContract {
            status: ContractStatus::None,
            ..Default::default()
        };
        contract.restrict(json!({"scoped":[{"operation":"agents.spawn","when":{"/workspace":"isolated_worktree"}},
            {"operation":"exec.run","when":{"/write":true}}],"reason":"sealed"})).unwrap();
        assert!(
            contract
                .restricted("agents.spawn", &json!({"workspace":"isolated_worktree"}))
                .is_err()
        );
        assert!(
            contract
                .restricted("agents.spawn", &json!({"workspace":"read_only"}))
                .is_ok()
        );
        assert!(contract.restricted("agents.spawn", &json!({})).is_ok());
        assert!(
            contract
                .restricted("exec.run", &json!({"write":true}))
                .is_err()
        );
        assert!(
            contract
                .restricted("exec.run", &json!({"write":false}))
                .is_ok()
        );
        let mut restored = SessionContract {
            status: ContractStatus::None,
            ..Default::default()
        };
        restored.restore_value(contract.status()).unwrap();
        assert!(
            restored
                .restricted("agents.spawn", &json!({"workspace":"isolated_worktree"}))
                .is_err()
        );
        let mut weakened = restored.status();
        weakened["scoped_restrictions"] = json!([]);
        assert!(restored.restore_value(weakened).is_err());
        for scoped in [
            json!([{"operation":"unknown","when":{"/write":true}}]),
            json!([{"operation":"exec.run","when":{}}]),
            json!([{"operation":"exec.run","when":{"/argv":[]}}]),
        ] {
            assert!(
                restored
                    .restrict(json!({"scoped":scoped,"reason":"bad"}))
                    .is_err()
            );
        }
    }

    #[test]
    fn blocking_findings_survive_clean_receipts_until_changed_candidate_separate_agent_resolution()
    {
        let definition = document(json!({"schema":2,"id":"checked","version":1,
            "description":"Checks","assurance":"checked"}));
        let mut contract = SessionContract::activate(definition, owner(), "user");
        let candidate = "a".repeat(64);
        let changed = "b".repeat(64);
        let acceptance = "c".repeat(64);
        let receipt =
            |candidate: &str, acceptance: &str, agent: &str, findings: Value, resolves: Value| {
                serde_json::from_value::<Receipt>(json!({"kind":"review",
                "candidate_sha256":candidate,"acceptance_sha256":acceptance,"outcome":"pass",
                "evidence":{"reference":"native-thread:fixture","sha256":"d".repeat(64)},
                "producer":{"kind":"agent","handle":agent},"findings":findings,
                "resolves":resolves,"submitted_by":"fixture","at":1}))
                .unwrap()
            };
        contract
            .submit(receipt(
                &candidate,
                &acceptance,
                "first",
                json!([{"fingerprint":"issue.one","severity":"blocking","summary":"Broken"}]),
                json!([]),
            ))
            .unwrap();
        let issue = vec!["issue.one".to_owned()];
        assert!(
            contract
                .resolution_context(&candidate, &acceptance, &issue)
                .is_err()
        );
        assert!(
            contract
                .resolution_context(&changed, &"e".repeat(64), &issue)
                .is_err()
        );
        assert!(
            contract
                .resolution_context(&changed, &acceptance, &["invented".into()])
                .is_err()
        );
        assert!(
            contract
                .resolution_context(
                    &changed,
                    &acceptance,
                    &["issue.one".into(), "issue.one".into()]
                )
                .is_err()
        );
        assert_eq!(
            contract
                .resolution_context(&changed, &acceptance, &issue)
                .unwrap()[0]
                .reported_candidate_sha256,
            candidate
        );
        contract
            .submit(receipt(
                &changed,
                &acceptance,
                "second",
                json!([]),
                json!([]),
            ))
            .unwrap();
        assert!(
            contract
                .gate(Gate::Complete, &changed, Some(&acceptance))
                .missing()
                .unwrap_err()
                .contains("issue.one")
        );
        assert!(
            contract
                .gate(Gate::Integrate, &changed, Some(&acceptance))
                .missing()
                .is_ok()
        );
        assert_eq!(
            contract.status()["finding_ledger"]["issue.one"]["reported_producer"]["handle"],
            "first"
        );
        assert!(
            contract
                .submit(receipt(
                    &candidate,
                    &acceptance,
                    "second",
                    json!([]),
                    json!(["issue.one"])
                ))
                .unwrap_err()
                .contains("candidate_unchanged")
        );
        assert!(
            contract
                .submit(receipt(
                    &changed,
                    &acceptance,
                    "first",
                    json!([]),
                    json!(["issue.one"])
                ))
                .unwrap_err()
                .contains("agent_not_separate")
        );
        assert!(
            contract
                .submit(receipt(
                    &changed,
                    &"e".repeat(64),
                    "second",
                    json!([]),
                    json!(["issue.one"])
                ))
                .unwrap_err()
                .contains("acceptance_changed")
        );
        assert!(
            contract
                .submit(receipt(
                    &changed,
                    &acceptance,
                    "second",
                    json!([]),
                    json!(["invented"])
                ))
                .unwrap_err()
                .contains("unknown")
        );
        contract
            .submit(receipt(
                &changed,
                &acceptance,
                "second",
                json!([]),
                json!(["issue.one"]),
            ))
            .unwrap();
        assert!(
            contract
                .gate(Gate::Complete, &changed, Some(&acceptance))
                .missing()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            contract.status()["finding_ledger"]["issue.one"]["resolution"]["producer"]["handle"],
            "second"
        );
        assert!(
            contract
                .resolution_context(&"f".repeat(64), &acceptance, &issue)
                .is_err()
        );
    }

    #[test]
    fn finding_ledger_replays_on_restore_and_rejects_tampering() {
        let definition = document(json!({"schema":2,"id":"checked","version":1,
            "description":"Checks","assurance":"checked"}));
        let make_contract = || SessionContract::activate(definition.clone(), owner(), "user");
        let mut before = make_contract();
        before
            .submit(
                serde_json::from_value(json!({"kind":"review",
            "candidate_sha256":"a".repeat(64),"acceptance_sha256":"b".repeat(64),
            "outcome":"pass","evidence":{"reference":"fixture","sha256":"c".repeat(64)},
            "producer":{"kind":"agent","handle":"first"},
            "findings":[{"fingerprint":"issue.one","severity":"blocking","summary":"Broken"}],
            "submitted_by":"fixture","at":1}))
                .unwrap(),
            )
            .unwrap();
        let status = before.status();
        let mut restored = make_contract();
        restored.restore_value(status.clone()).unwrap();
        assert!(
            restored
                .gate(Gate::Complete, &"d".repeat(64), Some(&"b".repeat(64)))
                .missing()
                .is_err()
        );
        let mut no_ledger = status.clone();
        no_ledger.as_object_mut().unwrap().remove("finding_ledger");
        assert!(make_contract().restore_value(no_ledger).is_err());
        let mut erased = status.clone();
        erased["finding_ledger"] = json!({});
        assert_eq!(
            make_contract().restore_value(erased).unwrap_err(),
            "contract_finding_ledger_mismatch"
        );
        let mut changed_receipt = status;
        changed_receipt["receipts"][0]["findings"] = json!([]);
        assert_eq!(
            make_contract().restore_value(changed_receipt).unwrap_err(),
            "contract_finding_ledger_mismatch"
        );
        let mut none = SessionContract {
            status: ContractStatus::None,
            ..Default::default()
        };
        none.submit(before.receipts[0].clone()).unwrap();
        assert!(
            none.gate(Gate::Complete, &"d".repeat(64), None)
                .missing()
                .unwrap()
                .is_empty()
        );
    }
}
