use codex_omd::LspPreferenceStore;
use codex_omd::detect_installed_servers;
use serde::Serialize;
use serde_json::json;
use std::error::Error;
use std::io;
use std::path::PathBuf;

type AppResult<T> = Result<T, Box<dyn Error>>;

fn print<T: Serialize>(value: &T) -> AppResult<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn run(args: Vec<String>) -> AppResult<()> {
    match args.as_slice() {
        [_, command] if command == "detect" => print(&detect_installed_servers()),
        [_, command, store, repository_identity, enabled] if command == "preference" => {
            let enabled = match enabled.as_str() {
                "enabled" => true,
                "disabled" => false,
                _ => return Err(io::Error::other("preference must be enabled or disabled").into()),
            };
            let mut store = LspPreferenceStore::open(PathBuf::from(store))?;
            print(&store.set(repository_identity.clone(), enabled)?)
        }
        [_, command, store, repository_identity] if command == "status" => {
            let store = LspPreferenceStore::open(PathBuf::from(store))?;
            print(&json!({
                "repository_identity": repository_identity,
                "preference": store.preference(repository_identity),
                "installed_servers": detect_installed_servers(),
            }))
        }
        _ => Err(io::Error::other(
            "usage: omd-lsp detect | preference STORE REPOSITORY_ID enabled|disabled | status STORE REPOSITORY_ID",
        )
        .into()),
    }
}

fn main() {
    if let Err(error) = run(std::env::args().collect()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
