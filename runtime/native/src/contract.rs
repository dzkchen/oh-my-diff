use super::*;
use codex_omd::ContractDocument;
use codex_omd::Gate;
use codex_omd::Receipt;
use std::collections::BTreeSet;

const RECEIPT_LIMIT: usize = 256;

#[derive(Default)]
pub(crate) struct SessionContract {
    active: Option<ContractDocument>,
    status: String,
    provenance: Value,
    restrictions: BTreeSet<String>,
    receipts: Vec<Receipt>,
}

impl SessionContract {
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
            codex_omd::ContractSelection::read(&host.repository.join(codex_omd::PROJECT_CONTRACT_SELECTION))
                .map(|project| (user, project))
        });
        let (user, project) = match selections {
            Ok(selections) => selections,
            Err(error) => {
                return Self {
                    status: "unavailable".into(),
                    provenance: json!({"error": error}),
                    ..Self::default()
                };
            }
        };
        match codex_omd::resolve_contract(documents, user.as_ref(), project.as_ref()) {
            codex_omd::ContractResolution::None => Self {
                status: "none".into(),
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
                status: "unavailable".into(),
                provenance: json!({"error": error}),
                ..Self::default()
            },
        }
    }

    fn activate(document: ContractDocument, owner: codex_omd::PolicyOwner, source: &str) -> Self {
        Self {
            restrictions: document.restrict.iter().cloned().collect(),
            provenance: json!({"source": source, "owner": owner, "digest": document.digest()}),
            status: "active".into(),
            active: Some(document),
            receipts: Vec::new(),
        }
    }

    pub(crate) fn restricted(&self, operation: &str) -> Result<(), String> {
        if self.restrictions.contains(operation) {
            return Err(format!("contract_restricted_operation: {operation}"));
        }
        Ok(())
    }

    pub(crate) fn status(&self) -> Value {
        json!({"status": self.status, "active": self.active, "provenance": self.provenance,
            "receipts": self.receipts, "restrictions": self.restrictions})
    }

    pub(crate) fn restrict(&mut self, arguments: Value) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            operations: Vec<String>,
            reason: String,
        }
        let input: Input = serde_json::from_value(arguments).map_err(|error| error.to_string())?;
        if input.operations.is_empty()
            || input.operations.len() > 16
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
        Ok(json!({"restrictions": self.restrictions}))
    }

    pub(crate) fn submit(&mut self, receipt: Receipt) -> Result<Value, String> {
        receipt.validate()?;
        if self.receipts.len() >= RECEIPT_LIMIT {
            return Err("receipt_limit".into());
        }
        self.receipts.push(receipt.clone());
        serde_json::to_value(receipt).map_err(|error| error.to_string())
    }

    pub(crate) fn gate(
        &self,
        gate: Gate,
        candidate_sha256: &str,
        acceptance_sha256: Option<&str>,
    ) -> Result<Vec<codex_omd::ContractRequirement>, String> {
        match (self.status.as_str(), &self.active) {
            ("none", _) => Ok(Vec::new()),
            ("active", Some(document)) => {
                Ok(document.missing(gate, &self.receipts, candidate_sha256, acceptance_sha256))
            }
            _ => Err("selected contract is unavailable; completion and integration fail closed".into()),
        }
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

    fn document(value: Value) -> ContractDocument {
        ContractDocument::parse(&value).unwrap()
    }

    #[test]
    fn no_selection_means_no_gate_and_restrictions_are_enforced() {
        let mut contract = SessionContract {
            status: "none".into(),
            ..Default::default()
        };
        assert!(contract.gate(Gate::Complete, &"a".repeat(64), None).unwrap().is_empty());
        contract
            .restrict(json!({"operations":["agents.spawn"],"reason":"solo"}))
            .unwrap();
        assert!(contract.restricted("agents.spawn").is_err());
        assert!(contract.restricted("exec.run").is_ok());
        assert!(contract.restrict(json!({"operations":["git.status"],"reason":"x"})).is_err());
    }

    #[test]
    fn active_contracts_require_bound_receipts_and_unavailable_contracts_fail_closed() {
        let active = document(json!({"schema":2,"id":"checked","version":1,"description":"Checks",
            "assurance":"checked","gates":{"complete":[{"receipt":"checks","bind":["candidate"]}]}}));
        let mut contract = SessionContract::activate(
            active,
            codex_omd::PolicyOwner::bundled(),
            "user",
        );
        let candidate = "a".repeat(64);
        assert_eq!(contract.gate(Gate::Complete, &candidate, None).unwrap().len(), 1);
        let receipt: Receipt = serde_json::from_value(json!({"kind":"checks","candidate_sha256":candidate,
            "outcome":"pass","evidence":{"reference":"b".repeat(64),"sha256":"b".repeat(64)},
            "producer":{"kind":"lead","handle":null},"submitted_by":"fixture","at":1}))
        .unwrap();
        contract.submit(receipt).unwrap();
        assert!(contract.gate(Gate::Complete, &candidate, None).unwrap().is_empty());
        assert_eq!(contract.gate(Gate::Complete, &"c".repeat(64), None).unwrap().len(), 1);
        let unavailable = SessionContract {
            status: "unavailable".into(),
            ..Default::default()
        };
        assert!(unavailable.gate(Gate::Integrate, &candidate, None).is_err());
    }
}
