use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::path::PathBuf;

pub const OPERATION: &str = "program.trust";

fn pins_path(store: &Path) -> PathBuf {
    store.join("program-pins.json")
}

fn read_pins(path: &Path) -> Option<Value> {
    serde_json::from_slice::<Value>(&std::fs::read(path).ok()?)
        .ok()
        .filter(|pins| pins["pins"].is_object())
}

pub fn pinned(store: &Path, owner: &str, program: &Path) -> Option<String> {
    read_pins(&pins_path(store))?["pins"][owner][program.to_string_lossy().as_ref()]
        .as_str()
        .map(str::to_owned)
}

pub fn pin(store: &Path, owner: &str, program: &Path, hash: &str) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("program_pin_failed: {error}");
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(store.join("program-pins.lock"))
        .map_err(failed)?;
    rustix::fs::flock(&lock, rustix::fs::FlockOperation::LockExclusive)
        .map_err(|error| failed(error.into()))?;
    let path = pins_path(store);
    let mut pins = read_pins(&path).unwrap_or_else(|| json!({"pins": {}}));
    let programs = &mut pins["pins"][owner];
    if !programs.is_object() {
        *programs = json!({});
    }
    programs[program.to_string_lossy().as_ref()] = Value::String(hash.to_owned());
    crate::fsio::write_json(&path, &pins).map_err(failed)
}

pub fn allow(store: &Path, owner: &str, name: &str) -> Result<(PathBuf, String), String> {
    let any = crate::ModOsAccess {
        programs: vec!["*".to_owned()],
        network: false,
    };
    let program = crate::host::unrestricted_program(&any, name, Path::new("/dev/null"))?;
    let hash = crate::host::program_hash(&program)?;
    pin(store, owner, &program, &hash)?;
    Ok((program, hash))
}

fn short(hash: &str) -> &str {
    &hash[..hash.floor_char_boundary(12)]
}

pub fn prompt(owner: &str, program: &Path, hash: &str, previous: Option<&str>) -> (String, String) {
    let name = program
        .file_name()
        .map_or_else(|| program.to_string_lossy(), |name| name.to_string_lossy());
    let history = match previous {
        Some(previous) => format!(
            "It changed since you allowed sha256 {}, for example after an update.",
            short(previous)
        ),
        None => "This is its first run for this mod.".to_owned(),
    };
    (
        format!("Run {name} for mod {owner}?"),
        format!(
            "Mod {owner} wants to run {} (sha256 {}) outside the sandbox, with your HOME and your user's permissions. {history} Allowing it also lets the mod run it in a terminal pane, where it can type into it and read its screen.",
            program.display(),
            short(hash)
        ),
    )
}

pub fn ensure(
    store: &Path,
    owner: &str,
    program: &Path,
    hash: &str,
    active: &dyn Fn() -> bool,
) -> Result<bool, String> {
    let previous = pinned(store, owner, program);
    if previous.as_deref() == Some(hash) {
        return Ok(true);
    }
    let answer = crate::client_surface::trust(
        owner,
        json!({"program": program, "sha256": hash, "previous": previous}),
        active,
    )
    .map_err(|error| {
        if error.starts_with("client_surface_unavailable") {
            format!(
                "program_unconfirmed: allow {} once in the TUI, or run omd-mod trust-program STORE {owner} {}",
                program.display(),
                program.display()
            )
        } else {
            error
        }
    })?;
    if answer["status"] == "declined" {
        return Ok(false);
    }
    pin(store, owner, program, hash)?;
    Ok(true)
}

pub fn request(arguments: &Value) -> Option<(PathBuf, String, Option<String>)> {
    Some((
        PathBuf::from(arguments["program"].as_str()?),
        arguments["sha256"].as_str()?.to_owned(),
        arguments["previous"].as_str().map(str::to_owned),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_round_trip_per_owner_and_prompts_name_the_change() {
        let store = tempfile::tempdir().unwrap();
        let program = Path::new("/opt/homebrew/bin/lazygit");
        assert_eq!(pinned(store.path(), "m", program), None);
        pin(store.path(), "m", program, "aa").unwrap();
        pin(store.path(), "m", program, "bb").unwrap();
        assert_eq!(pinned(store.path(), "m", program).as_deref(), Some("bb"));
        assert_eq!(pinned(store.path(), "other", program), None);
        let (title, _) = prompt("m", program, &"a".repeat(64), None);
        assert_eq!(title, "Run lazygit for mod m?");
        let (_, changed) = prompt("m", program, &"b".repeat(64), Some("é".repeat(10).as_str()));
        assert!(changed.contains("It changed since you allowed sha256 éééééé,"));
    }

    #[test]
    fn allow_pins_the_resolved_program_hash() {
        let store = tempfile::tempdir().unwrap();
        let (program, hash) = allow(store.path(), "m", "sh").unwrap();
        assert_eq!(pinned(store.path(), "m", &program), Some(hash));
    }

    #[test]
    fn concurrent_pins_keep_every_approval() {
        let store = tempfile::tempdir().unwrap();
        std::thread::scope(|scope| {
            for index in 0..16 {
                let store = store.path();
                scope.spawn(move || {
                    pin(store, "m", Path::new(&format!("/bin/p{index}")), "aa").unwrap()
                });
            }
        });
        for index in 0..16 {
            let program = format!("/bin/p{index}");
            assert_eq!(
                pinned(store.path(), "m", Path::new(&program)).as_deref(),
                Some("aa")
            );
        }
    }
}
