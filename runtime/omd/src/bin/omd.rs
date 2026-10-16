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

fn set_once(slot: &mut Option<PathBuf>, value: Option<&String>, name: &str) -> io::Result<()> {
    if slot.is_some() {
        return Err(io::Error::other(format!("duplicate_{name}")));
    }
    let value = value.ok_or_else(|| io::Error::other(format!("{name}_required")))?;
    *slot = Some(PathBuf::from(value));
    Ok(())
}

fn store_root(flag: Option<PathBuf>) -> io::Result<PathBuf> {
    flag.or_else(|| std::env::var_os(codex_omd::MOD_STORE_ENV).map(PathBuf::from))
        .ok_or_else(|| io::Error::other("explicit_mod_store_required"))?
        .canonicalize()
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
    let mut root = None;
    let mut scope = "repository".to_owned();
    let mut remaining = rest.iter();
    while let Some(argument) = remaining.next() {
        let value = remaining.next().ok_or_else(usage)?;
        match argument.as_str() {
            "--mod" => id = Some(value.clone()),
            "--repo" => repository = Some(PathBuf::from(value).canonicalize()?),
            "--store" => set_once(&mut root, Some(value), "store")?,
            "--scope" => scope = value.clone(),
            _ => return Err(usage()),
        }
    }
    let id = id.ok_or_else(usage)?;
    let root = store_root(root)?;
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

const MODS_USAGE: &str = "usage: omd install REFERENCE [--version V] [--scope user|project] [--yes] [--store PATH] | omd mods list | catalog [QUERY] | inspect REFERENCE | enable|disable|update|remove|rollback|revoke|unblock ID | quarantine ID REASON | events | reset-lock | sync [--offline|--rollback] (same flags); REFERENCE is ID[@VERSION] from the curated index, npm:NAME[@VERSION], git+URL[#REF[:DIRECTORY]] or a folder (./PATH or /PATH)";

const APPROVAL_REQUIRED: &str = "package_approval_required";

fn mods(action: &str, args: &[String]) -> io::Result<Value> {
    use codex_omd::package_controls;
    let usage = || io::Error::other(MODS_USAGE);
    let mut positional = Vec::new();
    let mut scope = "user".to_owned();
    let mut version = None;
    let mut yes = false;
    let (mut offline, mut rollback) = (false, false);
    let mut root = None;
    let mut remaining = args.iter();
    while let Some(argument) = remaining.next() {
        match argument.as_str() {
            "--yes" => yes = true,
            "--offline" => offline = true,
            "--rollback" => rollback = true,
            "--scope" => scope = remaining.next().ok_or_else(usage)?.clone(),
            "--version" => version = Some(remaining.next().ok_or_else(usage)?.clone()),
            "--store" => {
                if root.is_some() {
                    return Err(io::Error::other("duplicate_store"));
                }
                root = Some(PathBuf::from(remaining.next().ok_or_else(usage)?));
            }
            flag if flag.starts_with("--") => return Err(usage()),
            _ => positional.push(argument.clone()),
        }
    }
    let store = codex_omd::ModStore::open(store_root(root)?)?;
    let first = || positional.first().cloned().ok_or_else(usage);
    let done = |display: String| Ok(json!({"display": display}));
    match action {
        "list" => {
            let listed = package_controls::list(&store, None)?;
            let rows = listed["packages"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|package| {
                    format!(
                        "{} {} {} {}{}",
                        package["id"].as_str().unwrap_or("?"),
                        package["version"].as_str().unwrap_or("-"),
                        package["scope"].as_str().unwrap_or("-"),
                        if package["enabled"] == true {
                            "on"
                        } else {
                            "off"
                        },
                        package["source"]
                            .as_str()
                            .map_or(String::new(), |source| format!(" ({source})"))
                    )
                })
                .collect::<Vec<_>>();
            Ok(
                json!({"display": if rows.is_empty() { "No mods installed.".to_owned() } else { rows.join("\n") }, "packages": listed["packages"]}),
            )
        }
        "catalog" => {
            let found = package_controls::index(&store, json!({"query": positional.join(" ")}))?;
            let rows = found["packages"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|package| {
                    format!(
                        "{}@{}  {}{}",
                        package["id"].as_str().unwrap_or("?"),
                        package["latest"].as_str().unwrap_or("?"),
                        package["description"].as_str().unwrap_or(""),
                        package["installed"]
                            .as_str()
                            .map_or(String::new(), |installed| format!(
                                " [installed {installed}]"
                            ))
                    )
                })
                .collect::<Vec<_>>();
            done(if rows.is_empty() {
                "No catalog mods match.".to_owned()
            } else {
                rows.join("\n")
            })
        }
        "events" => Ok(Value::Array(store.security_events()?)),
        "sync" => {
            let synced = match rollback {
                true => store.package_sync_rollback()?,
                false => store.package_sync(offline)?,
            };
            Ok(
                json!({"display": format!("Managed deployment generation {} is active{}.",
                synced["generation"], if synced["changed"] == true { "" } else { " and current" }),
                "sync": synced}),
            )
        }
        "reset-lock" => {
            let aside = store.reset("packages.lock.json")?;
            done(format!(
                "Moved the package lock to {}. Installed mods keep running as trusted selections; reinstall one to manage it as a package again.",
                aside.display()
            ))
        }
        "quarantine" => {
            let id = first()?;
            store.package_quarantine(&id, &positional[1..].join(" "))?;
            done(format!(
                "Quarantined {id}: it is off and this version cannot be enabled, reinstalled or rolled back to. Its data is kept; `omd mods unblock {id}` lifts the block."
            ))
        }
        "unblock" => {
            let id = first()?;
            store.package_unblock(&id)?;
            done(format!(
                "Unblocked {id}. It stays off until `omd mods enable {id}`."
            ))
        }
        "revoke" => {
            let id = first()?;
            store.revoke(&id)?;
            done(format!(
                "Revoked {id}: it is off and its grant is dropped. Install or trust it again to restore it."
            ))
        }
        "install" | "inspect" | "enable" | "disable" | "update" | "remove" | "rollback" => {
            let target = first()?;
            let mut arguments = json!({"action": if action == "inspect" { "install" } else { action }, "scope": scope});
            if matches!(action, "install" | "inspect") {
                arguments["reference"] = json!(folder_reference(&target)?);
                arguments["version"] = json!(version);
            } else {
                arguments["id"] = json!(target);
            }
            let preview = package_controls::preview(&store, arguments)?;
            let summary = describe(&preview.public);
            if action == "inspect" {
                return Ok(json!({"display": summary, "preview": preview.public}));
            }
            if action != "disable" && !yes {
                if !io::IsTerminal::is_terminal(&io::stdin()) {
                    return Err(io::Error::other(format!(
                        "{APPROVAL_REQUIRED}: review `omd mods inspect` or run interactively, then pass --yes\n{summary}"
                    )));
                }
                if !confirm(&summary)? {
                    return Err(io::Error::other(format!("{APPROVAL_REQUIRED}: declined")));
                }
            }
            package_controls::apply(&store, &preview.control)?;
            let id = &preview.control.id;
            done(match action {
                "install" => format!(
                    "Installed {id} ({scope}). It is off: run `omd mods enable {id}` to turn it on."
                ),
                "update" => format!(
                    "Updated {id}. A changed grant, authority or origin leaves it off until `omd mods enable {id}`."
                ),
                "remove" => format!("Removed {id}. Its cache, state and local sources are kept."),
                "rollback" => format!("Rolled {id} back to its previous version."),
                _ => format!("{id} is {}d.", action),
            })
        }
        _ => Err(usage()),
    }
}

fn folder_reference(reference: &str) -> io::Result<String> {
    let path = if let Some(rest) = reference.strip_prefix("~/") {
        PathBuf::from(std::env::var_os("HOME").ok_or_else(|| io::Error::other("home_unavailable"))?)
            .join(rest)
    } else if reference == "." || reference.starts_with("./") || reference.starts_with("../") {
        PathBuf::from(reference)
    } else {
        return Ok(reference.to_owned());
    };
    Ok(path.canonicalize()?.display().to_string())
}

fn describe(preview: &Value) -> String {
    let text = |value: &Value| match value {
        Value::Null => "-".to_owned(),
        Value::String(value) => value.clone(),
        Value::Array(values) if values.is_empty() => "none".to_owned(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map_or_else(|| value.to_string(), str::to_owned)
            })
            .collect::<Vec<_>>()
            .join(", "),
        value => value.to_string(),
    };
    let changes = &preview["changes"];
    let mut lines = vec![format!(
        "{} {}",
        text(&preview["action"]),
        text(&preview["id"])
    )];
    for package in changes["packages"].as_array().into_iter().flatten() {
        let from = &package["version"]["from"];
        lines.push(format!(
            "- {} {}{}",
            text(&package["id"]),
            if from.is_null() {
                String::new()
            } else {
                format!("{} -> ", text(from))
            },
            text(&package["version"]["to"])
        ));
        lines.push(format!("  source: {}", package["source"]["to"]));
        lines.push(format!(
            "  integrity: {}",
            text(&package["integrity"]["to"])
        ));
        lines.push(format!("  license: {}", text(&package["license"]["to"])));
        lines.push(format!(
            "  capabilities: {}",
            text(&package["capabilities"]["to"])
        ));
        for exposure in package["authority"]["to"]["exposure"]
            .as_array()
            .into_iter()
            .flatten()
        {
            lines.push(format!("  authority: {}", text(exposure)));
        }
        for (label, key) in [
            ("dependencies", "dependencies"),
            ("install scripts", "lifecycle"),
            ("secret environment", "secret_environment"),
        ] {
            if package[key]["to"]
                .as_array()
                .is_some_and(|values| !values.is_empty())
            {
                lines.push(format!("  {label}: {}", text(&package[key]["to"])));
            }
        }
        if package["renewed_approval"] == true {
            lines.push(
                "  needs your approval: new or changed grant, authority or origin".to_owned(),
            );
        }
        if package["state_version"]["handler_required"] == true {
            lines.push(
                "  state version changes: apply loads this version and refuses it without a migrate handler"
                    .to_owned(),
            );
        }
    }
    if let Some(removed) = changes["removed"].as_array() {
        lines.push(format!(
            "  removes {}; cache, state and local sources are kept",
            removed
                .iter()
                .map(|item| text(&item["version"]))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !changes["version"].is_null() {
        lines.push(format!(
            "  version: {} -> {}",
            text(&changes["version"]["from"]),
            text(&changes["version"]["to"])
        ));
    }
    if preview["grants_added"]
        .as_array()
        .is_some_and(|grants| !grants.is_empty())
    {
        lines.push(format!("  grants: {}", text(&preview["grants_added"])));
    }
    lines.join("\n")
}

fn confirm(summary: &str) -> io::Result<bool> {
    use std::io::{BufRead, Write};
    let mut terminal = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")?;
    write!(terminal, "{summary}\nProceed? [y/N] ")?;
    terminal.flush()?;
    let mut answer = String::new();
    io::BufReader::new(terminal).read_line(&mut answer)?;
    Ok(matches!(answer.trim().to_lowercase().as_str(), "y" | "yes"))
}

fn run(args: Vec<String>) -> io::Result<Value> {
    if args.is_empty() || args[0] == "--help" {
        return Ok(
            json!({"usage":format!("omd COMMAND --repo PATH [--store PATH] [--home PATH] [--sqlite-home PATH] [ARGS] | omd store export|reset --mod ID [--repo PATH] [--store PATH] [--scope repository|user] | {MODS_USAGE}"),"commands":"Only explicitly enabled extensions with a CLI export may run. Model requests and process execution are unavailable here. `omd store` exports or resets one mod's namespaced store without running mod code. `omd install` and `omd mods` manage mod packages; `omd update` updates OMD itself."}),
        );
    }
    if args[0] == "store" {
        return store(&args[1..]);
    }
    if args[0] == "install" {
        return mods("install", &args[1..]);
    }
    if args[0] == "mods" {
        let (action, rest) = args[1..]
            .split_first()
            .ok_or_else(|| io::Error::other(MODS_USAGE))?;
        return mods(action, rest);
    }
    if args.len() > 128 || args.iter().map(String::len).sum::<usize>() > 8192 {
        return Err(io::Error::other("command_argument_limit"));
    }
    let command = &args[0];
    let mut repository = None;
    let mut store = None;
    let mut home = None;
    let mut sqlite = None;
    let mut payload = Vec::new();
    let mut remaining = args[1..].iter();
    while let Some(argument) = remaining.next() {
        match argument.as_str() {
            "--repo" => {
                set_once(&mut repository, remaining.next(), "repository")?;
                repository = repository.map(|path| path.canonicalize()).transpose()?;
            }
            "--store" => set_once(&mut store, remaining.next(), "store")?,
            "--home" => set_once(&mut home, remaining.next(), "home")?,
            "--sqlite-home" => set_once(&mut sqlite, remaining.next(), "sqlite_home")?,
            _ => payload.push(argument.clone()),
        }
    }
    let repository = repository.ok_or_else(|| io::Error::other("explicit_repository_required"))?;
    let root = store_root(store)?;
    let home = home
        .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|path| PathBuf::from(path).join(".codex")));
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
            std::process::exit(if error.to_string().starts_with(APPROVAL_REQUIRED) {
                2
            } else {
                1
            });
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
