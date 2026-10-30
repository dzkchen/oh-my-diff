use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::path::PathBuf;

pub const OPERATION: &str = "program.trust";

fn pins_path(store: &Path) -> PathBuf {
    store.join("pty-pins.json")
}

pub fn pinned(store: &Path, owner: &str, program: &Path) -> Option<String> {
    let pins: Value = serde_json::from_slice(&std::fs::read(pins_path(store)).ok()?).ok()?;
    pins["pins"][owner][program.to_string_lossy().as_ref()]
        .as_str()
        .map(str::to_owned)
}

pub fn pin(store: &Path, owner: &str, program: &Path, hash: &str) -> Result<(), String> {
    let path = pins_path(store);
    let mut pins = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(|pins| pins["pins"].is_object())
        .unwrap_or_else(|| json!({"pins": {}}));
    let owners = pins["pins"].as_object_mut().ok_or("pty_pins_invalid")?;
    let programs = owners.entry(owner.to_owned()).or_insert_with(|| json!({}));
    if !programs.is_object() {
        *programs = json!({});
    }
    programs[program.to_string_lossy().as_ref()] = Value::String(hash.to_owned());
    let temporary = path.with_extension("json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(&pins).map_err(|error| error.to_string())?,
    )
    .and_then(|()| std::fs::rename(&temporary, &path))
    .map_err(|error| format!("pty_pin_failed: {error}"))
}

fn short(hash: &str) -> &str {
    &hash[..hash.floor_char_boundary(12)]
}

pub fn prompt(
    owner: &str,
    program: &Path,
    hash: &str,
    previous: Option<&str>,
    pane: bool,
) -> (String, String) {
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
    let (place, control) = if pane {
        (
            " in a terminal pane",
            " The mod can type into it and read its screen.",
        )
    } else {
        ("", "")
    };
    (
        format!("Run {name} for mod {owner}?"),
        format!(
            "Mod {owner} wants to run {} (sha256 {}){place} outside the sandbox, with your HOME and your user's permissions. {history}{control}",
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
    )?;
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
        let (title, first) = prompt("m", program, &"a".repeat(64), None, true);
        assert_eq!(title, "Run lazygit for mod m?");
        assert!(first.contains("in a terminal pane") && first.contains("first run"));
        let (_, changed) = prompt(
            "m",
            program,
            &"b".repeat(64),
            Some("é".repeat(10).as_str()),
            false,
        );
        assert!(changed.contains("It changed since you allowed sha256 éééééé,"));
        assert!(!changed.contains("terminal pane"));
    }
}
