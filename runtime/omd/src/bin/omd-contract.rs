use codex_omd::ContractSelection;
use codex_omd::contract_cli::describe;
use codex_omd::contract_cli::documents;
use codex_omd::contract_cli::effective;
use codex_omd::contract_cli::find;
use codex_omd::contract_cli::plan;
use codex_omd::contract_cli::project_path;
use codex_omd::contract_cli::read;
use codex_omd::contract_cli::summary;
use codex_omd::contract_cli::user_path;
use serde_json::Value;
use serde_json::json;
use std::io;
use std::path::Path;

fn usage() -> io::Error {
    io::Error::other(
        "usage: omd-contract list STORE | status STORE REPOSITORY | plan STORE REPOSITORY ID@VERSION | select STORE REPOSITORY ID@VERSION [CONFIRMATION] | require STORE REPOSITORY ID@VERSION | clear STORE REPOSITORY user|project",
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
            let store = Path::new(store);
            plan(&documents(store)?, store, Path::new(repository), key)
        }
        [command, store, repository, key] | [command, store, repository, key, _]
            if command == "select" =>
        {
            let store = Path::new(store);
            codex_omd::contract_cli::select(
                &documents(store)?,
                store,
                Path::new(repository),
                key,
                args.get(4).cloned(),
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
