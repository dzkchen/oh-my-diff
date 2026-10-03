use crate::ContractDocument;
use crate::ContractResolution;
use crate::ContractSelection;
use crate::ModHost;
use crate::PolicyOwner;
use serde_json::Value;
use serde_json::json;
use std::io;
use std::path::Path;
use std::path::PathBuf;

pub fn documents(store: &Path) -> io::Result<Vec<(ContractDocument, PolicyOwner)>> {
    let root = store.canonicalize()?;
    Ok(ModHost::open(root)?.contract_documents())
}

pub fn user_path(store: &Path) -> io::Result<PathBuf> {
    let config = store.join("host.json");
    let configured = match std::fs::read(&config) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)?["contract"]["user"]
            .as_str()
            .map(PathBuf::from),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    Ok(configured.unwrap_or_else(|| store.join(crate::USER_CONTRACT_SELECTION)))
}

pub fn project_path(repository: &Path) -> PathBuf {
    repository.join(crate::PROJECT_CONTRACT_SELECTION)
}

pub fn read(path: &Path) -> io::Result<Option<ContractSelection>> {
    ContractSelection::read(path).map_err(io::Error::other)
}

pub fn summary(document: &ContractDocument, owner: &PolicyOwner) -> Value {
    json!({"key": document.key(), "description": document.description, "assurance": document.assurance,
        "gates": document.gates, "restrict": document.restrict, "digest": document.digest(), "owner": owner})
}

pub fn effective(
    documents: &[(ContractDocument, PolicyOwner)],
    store: &Path,
    repository: &Path,
) -> io::Result<ContractResolution> {
    let user = read(&user_path(store)?)?;
    let project = read(&project_path(repository))?;
    Ok(crate::resolve_contract(
        documents,
        user.as_ref(),
        project.as_ref(),
    ))
}

pub fn describe(resolution: &ContractResolution) -> Value {
    match resolution {
        ContractResolution::None => {
            json!({"status": "none", "note": "no contract is selected; completion and integration are not gated"})
        }
        ContractResolution::Active {
            document,
            owner,
            source,
            overrode,
        } => json!({"status": "active", "contract": summary(document, owner), "source": source,
            "overrode": overrode}),
        ContractResolution::Unavailable(error) => json!({"status": "unavailable", "error": error,
            "note": "completion and integration fail closed until the selection is fixed"}),
    }
}

pub fn find(
    documents: &[(ContractDocument, PolicyOwner)],
    key: &str,
) -> io::Result<(ContractDocument, PolicyOwner)> {
    documents
        .iter()
        .find(|(document, _)| document.key() == key)
        .cloned()
        .ok_or_else(|| io::Error::other(format!("no active mod registers contract {key}")))
}

pub fn current(resolution: &ContractResolution) -> Option<&ContractDocument> {
    match resolution {
        ContractResolution::Active { document, .. } => Some(document),
        _ => None,
    }
}

pub fn plan(
    documents: &[(ContractDocument, PolicyOwner)],
    store: &Path,
    repository: &Path,
    key: &str,
) -> io::Result<Value> {
    let (next, owner) = find(documents, key)?;
    let resolution = effective(documents, store, repository)?;
    let before = current(&resolution);
    let weakens = before.is_some_and(|before| next.weaker_than(before));
    Ok(
        json!({"schema": 2, "before": describe(&resolution), "after": summary(&next, &owner),
        "weakens": weakens,
        "confirmation": weakens.then(|| crate::contract_confirmation(before, &next)),
        "note": if weakens {
            "this selection reduces assurance; pass the confirmation to omd-contract select"
        } else {
            "this selection does not reduce assurance"
        }}),
    )
}

pub fn select(
    documents: &[(ContractDocument, PolicyOwner)],
    store: &Path,
    repository: &Path,
    key: &str,
    confirmation: Option<String>,
) -> io::Result<Value> {
    let (next, owner) = find(documents, key)?;
    let resolution = effective(documents, store, repository)?;
    let before = current(&resolution);
    if before.is_some_and(|before| next.weaker_than(before))
        && confirmation.as_deref() != Some(crate::contract_confirmation(before, &next).as_str())
    {
        return Err(io::Error::other(
            "this selection reduces assurance; run omd-contract plan and pass its confirmation",
        ));
    }
    let path = user_path(store)?;
    ContractSelection {
        schema: 2,
        contract: Some(next.key()),
        contract_digest: Some(next.digest()),
        confirmation,
        ..ContractSelection::default()
    }
    .write(&path)?;
    Ok(
        json!({"schema": 2, "selected": summary(&next, &owner), "path": path,
        "note": "the selection applies to the next session"}),
    )
}
