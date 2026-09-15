use codex_omd::GuidelineProposal;
use codex_omd::GuidelineStore;
use codex_omd::PromotionRequest;
use codex_omd::RollbackRequest;
use codex_omd::ValidationRecord;
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::error::Error;
use std::io;
use std::path::Path;
use std::path::PathBuf;

type AppResult<T> = Result<T, Box<dyn Error>>;

fn read<T: DeserializeOwned>(path: &Path) -> AppResult<T> {
    let bytes = std::fs::read(path)?;
    if bytes.len() > 65_536 {
        return Err(io::Error::other("input exceeds size limit").into());
    }
    Ok(serde_json::from_slice(&bytes)?)
}

fn print<T: Serialize>(value: &T) -> AppResult<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn run(args: Vec<String>) -> AppResult<()> {
    let [_, command, root, rest @ ..] = args.as_slice() else {
        return Err(io::Error::other("usage: omd-guidelines COMMAND STORE [ACTION.json]").into());
    };
    let root = PathBuf::from(root)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(root));
    if command == "init" {
        if !rest.is_empty() {
            return Err(io::Error::other("init does not accept an action file").into());
        }
        return print(&GuidelineStore::create(root)?.active()?);
    }
    let store = GuidelineStore::open(root)?;
    match (command.as_str(), rest) {
        ("propose", [path]) => print(&store.propose(read::<GuidelineProposal>(Path::new(path))?)?),
        ("validate", [path]) => print(&store.validate(read::<ValidationRecord>(Path::new(path))?)?),
        ("promote", [path]) => print(&store.promote(read::<PromotionRequest>(Path::new(path))?)?),
        ("rollback", [path]) => print(&store.rollback(read::<RollbackRequest>(Path::new(path))?)?),
        ("active", []) => print(&store.active()?),
        ("history", []) => print(&store.transitions()?),
        _ => Err(io::Error::other("usage: omd-guidelines COMMAND STORE [ACTION.json]").into()),
    }
}

fn main() {
    if let Err(error) = run(std::env::args().collect()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
