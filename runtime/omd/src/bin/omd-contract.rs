use codex_omd::ContractDocument;
use codex_omd::ContractResolution;
use codex_omd::ContractSelection;
use codex_omd::ModHost;
use codex_omd::PolicyOwner;
use serde_json::Value;
use serde_json::json;
use std::io;
use std::path::Path;
use std::path::PathBuf;

fn usage() -> io::Error {
    io::Error::other(
        "usage: omd-contract list STORE | status STORE REPOSITORY | plan STORE REPOSITORY ID@VERSION | select STORE REPOSITORY ID@VERSION [CONFIRMATION] | require STORE REPOSITORY ID@VERSION | clear STORE REPOSITORY user|project",
    )
}

fn documents(store: &Path) -> io::Result<Vec<(ContractDocument, PolicyOwner)>> {
    let root = store.canonicalize()?;
    Ok(ModHost::open(root)?.contract_documents())
}

fn user_path(store: &Path) -> io::Result<PathBuf> {
    let config = store.join("host.json");
    let configured = match std::fs::read(&config) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)?["contract"]["user"]
            .as_str()
            .map(PathBuf::from),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    Ok(configured.unwrap_or_else(|| store.join(codex_omd::USER_CONTRACT_SELECTION)))
}

fn project_path(repository: &Path) -> PathBuf {
    repository.join(codex_omd::PROJECT_CONTRACT_SELECTION)
}

fn read(path: &Path) -> io::Result<Option<ContractSelection>> {
    ContractSelection::read(path).map_err(io::Error::other)
}

fn summary(document: &ContractDocument, owner: &PolicyOwner) -> Value {
    json!({"key": document.key(), "description": document.description, "assurance": document.assurance,
        "gates": document.gates, "restrict": document.restrict, "digest": document.digest(), "owner": owner})
}

fn effective(
    documents: &[(ContractDocument, PolicyOwner)],
    store: &Path,
    repository: &Path,
) -> io::Result<ContractResolution> {
    let user = read(&user_path(store)?)?;
    let project = read(&project_path(repository))?;
    Ok(codex_omd::resolve_contract(
        documents,
        user.as_ref(),
        project.as_ref(),
    ))
}

fn describe(resolution: &ContractResolution) -> Value {
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

fn find(
    documents: &[(ContractDocument, PolicyOwner)],
    key: &str,
) -> io::Result<(ContractDocument, PolicyOwner)> {
    documents
        .iter()
        .find(|(document, _)| document.key() == key)
        .cloned()
        .ok_or_else(|| io::Error::other(format!("no active mod registers contract {key}")))
}

fn current(resolution: &ContractResolution) -> Option<&ContractDocument> {
    match resolution {
        ContractResolution::Active { document, .. } => Some(document),
        _ => None,
    }
}

fn plan(store: &Path, repository: &Path, key: &str) -> io::Result<Value> {
    let documents = documents(store)?;
    let (next, owner) = find(&documents, key)?;
    let resolution = effective(&documents, store, repository)?;
    let before = current(&resolution);
    let weakens = before.is_some_and(|before| next.weaker_than(before));
    Ok(
        json!({"schema": 2, "before": describe(&resolution), "after": summary(&next, &owner),
        "weakens": weakens,
        "confirmation": weakens.then(|| codex_omd::contract_confirmation(before, &next)),
        "note": if weakens {
            "this selection reduces assurance; pass the confirmation to omd-contract select"
        } else {
            "this selection does not reduce assurance"
        }}),
    )
}

fn run(args: &[String]) -> io::Result<Value> {
    match args {
        [command, store] if command == "list" => {
            let documents = documents(Path::new(store))?;
            Ok(json!({"schema": 2, "contracts": documents
                .iter()
                .map(|(document, owner)| summary(document, owner))
                .collect::<Vec<_>>()}))
        }
        [command, store, repository] if command == "status" => {
            let (store, repository) = (Path::new(store), Path::new(repository));
            let documents = documents(store)?;
            let mut value = describe(&effective(&documents, store, repository)?);
            value["schema"] = json!(2);
            value["user_selection"] = json!(user_path(store)?);
            value["project_selection"] = json!(project_path(repository));
            Ok(value)
        }
        [command, store, repository, key] if command == "plan" => {
            plan(Path::new(store), Path::new(repository), key)
        }
        [command, store, repository, key] | [command, store, repository, key, _]
            if command == "select" =>
        {
            let confirmation = args.get(4).cloned();
            let (store, repository) = (Path::new(store), Path::new(repository));
            let documents = documents(store)?;
            let (next, owner) = find(&documents, key)?;
            let resolution = effective(&documents, store, repository)?;
            let before = current(&resolution);
            if before.is_some_and(|before| next.weaker_than(before))
                && confirmation.as_deref()
                    != Some(codex_omd::contract_confirmation(before, &next).as_str())
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
        [command, store, repository, key] if command == "require" => {
            let documents = documents(Path::new(store))?;
            let (floor, owner) = find(&documents, key)?;
            let path = project_path(Path::new(repository));
            let mut selection = read(&path)?.unwrap_or(ContractSelection {
                schema: 2,
                ..ContractSelection::default()
            });
            selection.floor = Some(floor.key());
            selection.floor_digest = Some(floor.digest());
            selection.write(&path)?;
            Ok(
                json!({"schema": 2, "floor": summary(&floor, &owner), "path": path,
                "note": "weaker selections now resolve to this floor"}),
            )
        }
        [command, store, repository, scope] if command == "clear" => {
            let path = match scope.as_str() {
                "user" => user_path(Path::new(store))?,
                "project" => project_path(Path::new(repository)),
                _ => return Err(usage()),
            };
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            Ok(json!({"schema": 2, "cleared": path}))
        }
        _ => Err(usage()),
    }
}

fn main() {
    match run(&std::env::args().skip(1).collect::<Vec<_>>()) {
        Ok(value) => println!(
            "{}",
            serde_json::to_string_pretty(&value).unwrap_or_default()
        ),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
