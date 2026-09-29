use codex_omd::{ModHost, scoped_data::ScopedDataHost};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn configuration(path: &Path) -> io::Result<toml::Value> {
    if !path.try_exists()? {
        return Ok(toml::Value::Table(Default::default()));
    }
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() > 262144 {
        return Err(io::Error::other("session_configuration_limit"));
    }
    toml::from_str(&std::fs::read_to_string(path)?)
        .map_err(|_| io::Error::other("session_configuration_invalid"))
}

fn database(
    home: &Path,
    repository: &Path,
    explicit: Option<PathBuf>,
    environment: Option<PathBuf>,
) -> io::Result<PathBuf> {
    let sqlite = if let Some(path) = explicit {
        path
    } else {
        let custom = |value: &toml::Value| -> bool { value.to_string().contains("sqlite_home") };
        if custom(&configuration(&repository.join(".codex/config.toml"))?)
            || custom(&configuration(Path::new("/etc/codex/config.toml"))?)
        {
            return Err(io::Error::other(
                "explicit_sqlite_home_required_for_layered_configuration",
            ));
        }
        let config = configuration(&home.join("config.toml"))?;
        let profile = config
            .get("profile")
            .and_then(toml::Value::as_str)
            .and_then(|name| config.get("profiles")?.get(name));
        let selected = profile
            .and_then(|value| value.get("sqlite_home"))
            .or_else(|| config.get("sqlite_home"));
        match selected {
            Some(value) => PathBuf::from(
                value
                    .as_str()
                    .ok_or_else(|| io::Error::other("session_database_scope_invalid"))?,
            ),
            None => environment.unwrap_or_else(|| home.to_path_buf()),
        }
    };
    if !sqlite.is_absolute() {
        return Err(io::Error::other("absolute_sqlite_home_required"));
    }
    Ok(sqlite.join("state_5.sqlite"))
}

fn store(args: &[String]) -> io::Result<Value> {
    let usage = || {
        io::Error::other(
            "usage: omd store export|reset --mod ID [--repo PATH] [--store PATH] [--scope repository|user]",
        )
    };
    let (action, rest) = args.split_first().ok_or_else(usage)?;
    if action != "export" && action != "reset" {
        return Err(usage());
    }
    let mut id = None;
    let mut repository = None;
    let mut root = std::env::var_os(codex_omd::MOD_STORE_ENV).map(PathBuf::from);
    let mut scope = "repository".to_owned();
    let mut remaining = rest.iter();
    while let Some(argument) = remaining.next() {
        let value = remaining.next().ok_or_else(usage)?;
        match argument.as_str() {
            "--mod" => id = Some(value.clone()),
            "--repo" => repository = Some(PathBuf::from(value).canonicalize()?),
            "--store" => root = Some(PathBuf::from(value)),
            "--scope" => scope = value.clone(),
            _ => return Err(usage()),
        }
    }
    let id = id.ok_or_else(usage)?;
    let root = root
        .ok_or_else(|| io::Error::other("explicit_mod_store_required"))?
        .canonicalize()?;
    let key = match (&repository, scope.as_str()) {
        (Some(repository), "repository") => codex_omd::host::repository_key(repository),
        (None, "repository") => return Err(io::Error::other("explicit_repository_required")),
        _ => String::new(),
    };
    let data = codex_omd::data_store::DataStore {
        root: &root,
        repository_key: &key,
        owner: &id,
        provenance: codex_omd::data_store::StoreProvenance {
            r#mod: id.clone(),
            source_sha256: String::new(),
            thread_id: None,
            origin: codex_omd::data_store::Origin::Cli,
            at: 0,
        },
    };
    let mut exported = data.call("store.export", json!({"scope": scope}))?;
    while !exported["cursor"].is_null() {
        let page = data.call(
            "store.export",
            json!({"scope": scope, "cursor": exported["cursor"]}),
        )?;
        if let (Some(entries), Some(more)) = (
            exported["entries"].as_object_mut(),
            page["entries"].as_object(),
        ) {
            entries.extend(more.clone());
        }
        exported["cursor"] = page["cursor"].clone();
    }
    if let Some(exported) = exported.as_object_mut() {
        exported.remove("cursor");
    }
    if action == "export" {
        return Ok(exported);
    }
    data.call(
        "store.reset",
        json!({"scope": scope, "expected_generation": exported["generation"]}),
    )
}

fn run(args: Vec<String>) -> io::Result<Value> {
    if args.is_empty() || args[0] == "--help" {
        return Ok(
            json!({"usage":"omd COMMAND --repo PATH [--store PATH] [--home PATH] [--sqlite-home PATH] [ARGS] | omd store export|reset --mod ID [--repo PATH] [--store PATH] [--scope repository|user]","commands":"Only explicitly enabled extensions with a CLI export may run. Model requests and process execution are unavailable here. `omd store` exports or resets one mod's namespaced store without running mod code."}),
        );
    }
    if args[0] == "store" {
        return store(&args[1..]);
    }
    if args.len() > 128 || args.iter().map(String::len).sum::<usize>() > 8192 {
        return Err(io::Error::other("command_argument_limit"));
    }
    let command = &args[0];
    let mut repository = None;
    let mut store = std::env::var_os(codex_omd::MOD_STORE_ENV).map(PathBuf::from);
    let mut home = std::env::var_os("CODEX_HOME").map(PathBuf::from);
    let mut sqlite = None;
    let mut payload = Vec::new();
    let mut remaining = args[1..].iter();
    while let Some(argument) = remaining.next() {
        match argument.as_str() {
            "--repo" => {
                if repository.is_some() {
                    return Err(io::Error::other("duplicate_repository"));
                }
                repository = Some(
                    PathBuf::from(
                        remaining
                            .next()
                            .ok_or_else(|| io::Error::other("repository_required"))?,
                    )
                    .canonicalize()?,
                );
            }
            "--store" => {
                store = Some(PathBuf::from(
                    remaining
                        .next()
                        .ok_or_else(|| io::Error::other("store_required"))?,
                ));
            }
            "--home" => {
                home = Some(PathBuf::from(
                    remaining
                        .next()
                        .ok_or_else(|| io::Error::other("home_required"))?,
                ));
            }
            "--sqlite-home" => {
                if sqlite.is_some() {
                    return Err(io::Error::other("duplicate_sqlite_home"));
                }
                sqlite = Some(PathBuf::from(
                    remaining
                        .next()
                        .ok_or_else(|| io::Error::other("sqlite_home_required"))?,
                ));
            }
            _ => payload.push(argument.clone()),
        }
    }
    let repository = repository.ok_or_else(|| io::Error::other("explicit_repository_required"))?;
    let root = store
        .ok_or_else(|| io::Error::other("explicit_mod_store_required"))?
        .canonicalize()?;
    let home =
        home.or_else(|| std::env::var_os("HOME").map(|path| PathBuf::from(path).join(".codex")));
    let sessions = home.as_ref().map(|path| path.join("sessions"));
    let mut runtime = ModHost::open(root.clone())?;
    let exports: Vec<_> = runtime
        .commands()
        .into_iter()
        .filter(|(_, export)| export.cli.as_deref() == Some(command))
        .collect();
    if exports.len() != 1 {
        return Err(io::Error::other(if exports.is_empty() {
            "plugin_command_unavailable"
        } else {
            "plugin_command_collision"
        }));
    }
    let (owner, export) = &exports[0];
    let sources: BTreeMap<String, String> = runtime
        .owners()
        .into_iter()
        .map(|(id, owner)| (id, owner.sha256))
        .collect();
    let mut providers = BTreeMap::<String, ScopedDataHost>::new();
    let mut data = ScopedDataHost::new(
        root.clone(),
        repository.clone(),
        sessions.clone(),
        None,
        owner.clone(),
        "user-command".into(),
        sources
            .get(owner)
            .cloned()
            .ok_or_else(|| io::Error::other("command_owner_missing"))?,
    )?;
    let deadline = Instant::now() + Duration::from_secs(30);
    runtime.invoke_scoped_with(
        owner,
        runtime.generation(),
        "command",
        &export.name,
        json!(payload),
        || Instant::now() < deadline,
        |caller, request| {
            if !codex_omd::scoped_data::operation(&request.operation) {
                return Err(io::Error::other("standalone_host_operation_unavailable"));
            }
            let needs_sessions = request.operation.starts_with("sessions.");
            let session_database = if needs_sessions {
                Some(database(
                    home.as_deref()
                        .ok_or_else(|| io::Error::other("session_home_required"))?,
                    &repository,
                    sqlite.clone(),
                    std::env::var_os("CODEX_SQLITE_HOME").map(PathBuf::from),
                )?)
            } else {
                None
            };
            if caller == owner {
                if needs_sessions {
                    data.session_database = session_database;
                }
                return data.call(&request.operation, request.arguments, || {
                    Instant::now() < deadline
                });
            }
            let source = sources
                .get(caller)
                .ok_or_else(|| io::Error::other("service_provider_missing"))?;
            let provider = match providers.entry(caller.to_owned()) {
                std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert(ScopedDataHost::new(
                        root.clone(),
                        repository.clone(),
                        sessions.clone(),
                        session_database.clone(),
                        caller.to_owned(),
                        "user-command".into(),
                        source.clone(),
                    )?)
                }
            };
            if provider.binding.source_sha256 != *source {
                return Err(io::Error::other("data_selection_changed_or_revoked"));
            }
            if needs_sessions {
                provider.session_database = session_database;
            }
            provider.call(&request.operation, request.arguments, || {
                Instant::now() < deadline
            })
        },
    )
}

fn main() {
    match run(std::env::args().skip(1).collect()) {
        Ok(value) => {
            if let Some(display) = value.get("display").and_then(Value::as_str) {
                println!(
                    "{}",
                    display
                        .chars()
                        .filter(
                            |character| !character.is_control() || matches!(character, '\n' | '\t')
                        )
                        .collect::<String>()
                );
            } else {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&value).unwrap_or_default()
                );
            }
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_recovery_exports_and_resets_one_mod_without_running_it() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let repository = root.join("repo");
        std::fs::create_dir(&repository).unwrap();
        let key = codex_omd::host::repository_key(&repository);
        codex_omd::data_store::DataStore {
            root: &root,
            repository_key: &key,
            owner: "stuck",
            provenance: codex_omd::data_store::StoreProvenance {
                r#mod: "stuck".into(),
                source_sha256: "a".repeat(64),
                thread_id: None,
                origin: codex_omd::data_store::Origin::Tool,
                at: 0,
            },
        }
        .call(
            "store.put",
            json!({"key":"state","value":"x".repeat(40_000),"expected_revision":null}),
        )
        .unwrap();
        let args = |action: &str| {
            [
                "store",
                action,
                "--mod",
                "stuck",
                "--repo",
                repository.to_str().unwrap(),
                "--store",
                root.to_str().unwrap(),
            ]
            .map(str::to_owned)
            .to_vec()
        };
        let exported = run(args("export")).unwrap();
        assert_eq!(exported["entries"]["state"]["revision"], 1);
        assert!(exported.get("cursor").is_none());
        assert_eq!(run(args("reset")).unwrap()["generation"], 2);
        assert!(
            run(args("export")).unwrap()["entries"]
                .as_object()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn session_database_selection_honors_config_profile_and_explicit_scope() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let home = root.join("home");
        let repository = root.join("repo");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(repository.join(".codex")).unwrap();
        let environment = root.join("environment");
        assert_eq!(
            database(&home, &repository, None, Some(environment.clone())).unwrap(),
            environment.join("state_5.sqlite")
        );
        let configured = root.join("configured");
        std::fs::write(
            home.join("config.toml"),
            format!(
                "profile='selected'\n[profiles.selected]\nsqlite_home='{}'\n",
                configured.display()
            ),
        )
        .unwrap();
        assert_eq!(
            database(&home, &repository, None, Some(environment.clone())).unwrap(),
            configured.join("state_5.sqlite")
        );
        std::fs::write(
            repository.join(".codex/config.toml"),
            "\"\\u0073qlite_home\"='/unknown'\n",
        )
        .unwrap();
        assert!(database(&home, &repository, None, None).is_err());
        assert_eq!(
            database(&home, &repository, Some(environment.clone()), None).unwrap(),
            environment.join("state_5.sqlite")
        );
        assert!(database(&home, &repository, Some(PathBuf::from("relative")), None).is_err());
    }
}
