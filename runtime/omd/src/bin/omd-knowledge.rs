use codex_omd::KnowledgeApproval;
use codex_omd::KnowledgeMode;
use codex_omd::KnowledgeRemoval;
use codex_omd::KnowledgeReset;
use codex_omd::KnowledgeStore;
use codex_omd::LessonCandidate;
use codex_omd::SourceFactInput;
use codex_omd::TaskEvidenceInput;
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::error::Error;
use std::io;
use std::path::Path;
use std::path::PathBuf;

type AppResult<T> = Result<T, Box<dyn Error>>;

fn read<T: DeserializeOwned>(path: &Path) -> AppResult<T> {
    let bytes = std::fs::read(path)?;
    if bytes.len() > 1_048_576 {
        return Err(io::Error::other("input exceeds size limit").into());
    }
    Ok(serde_json::from_slice(&bytes)?)
}

fn print<T: Serialize>(value: &T) -> AppResult<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn mode(value: &str) -> AppResult<KnowledgeMode> {
    match value {
        "cold" => Ok(KnowledgeMode::Cold),
        "reuse" => Ok(KnowledgeMode::Reuse),
        _ => Err(io::Error::other("knowledge state must be cold or reuse").into()),
    }
}

fn run(args: Vec<String>) -> AppResult<()> {
    let [_, command, root, rest @ ..] = args.as_slice() else {
        return Err(io::Error::other("usage: omd-knowledge COMMAND STORE [ARG ...]").into());
    };
    let root = PathBuf::from(root)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(root));
    if command == "init" {
        let [repository_identity] = rest else {
            return Err(io::Error::other("usage: omd-knowledge init STORE REPOSITORY_ID").into());
        };
        return print(
            &KnowledgeStore::create(root, repository_identity.clone())?
                .inspect(Path::new(".").canonicalize()?.as_path())?,
        );
    }
    let store = KnowledgeStore::open(root)?;
    match (command.as_str(), rest) {
        ("retain-evidence", [path]) => {
            print(&store.retain_evidence(read::<TaskEvidenceInput>(Path::new(path))?)?)
        }
        ("retain-fact", [repository, path]) => print(&store.retain_source_fact(
            &Path::new(repository).canonicalize()?,
            read::<SourceFactInput>(Path::new(path))?,
        )?),
        ("propose-lesson", [path]) => {
            print(&store.propose_lesson(read::<LessonCandidate>(Path::new(path))?)?)
        }
        ("approve-lesson", [path]) => {
            print(&store.approve_lesson(read::<KnowledgeApproval>(Path::new(path))?)?)
        }
        ("inspect", [repository]) => print(&store.inspect(&Path::new(repository).canonicalize()?)?),
        ("session", [repository, state]) => print(&store.session(
            &Path::new(repository).canonicalize()?,
            mode(state)?,
            262_144,
        )?),
        ("remove", [path]) => {
            store.remove(read::<KnowledgeRemoval>(Path::new(path))?)?;
            print(&store.revision()?)
        }
        ("reset", [path]) => print(&store.reset(read::<KnowledgeReset>(Path::new(path))?)?),
        _ => Err(io::Error::other("usage: omd-knowledge COMMAND STORE [ARG ...]").into()),
    }
}

fn main() {
    if let Err(error) = run(std::env::args().collect()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
