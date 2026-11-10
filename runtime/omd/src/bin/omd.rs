use codex_omd::ModHostCallback;
use codex_omd::ModInvokeOptions;
use codex_omd::ModOpenOptions;
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

fn shell_quote(text: &str) -> String {
    if !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/._-+=:@".contains(&byte))
    {
        text.to_owned()
    } else {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
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

const MODS_USAGE: &str = "usage: omd install REFERENCE [--version V] [--scope user|project] [--yes] [--details] [--store PATH] | omd mods list | catalog [QUERY] | inspect REFERENCE | enable|disable|update|remove|rollback|revoke|unblock ID | quarantine ID REASON | events | reset-lock | sync [--offline|--rollback] (same flags); REFERENCE is ID[@VERSION] from the curated index, npm:NAME[@VERSION], git+URL[#REF[:DIRECTORY]] or a folder (./PATH or /PATH)";

const APPROVAL_REQUIRED: &str = "package_approval_required";

fn mods(action: &str, args: &[String]) -> io::Result<Value> {
    use codex_omd::package_controls;
    let usage = || io::Error::other(MODS_USAGE);
    let mut positional = Vec::new();
    let mut scope = "user".to_owned();
    let mut version = None;
    let (mut yes, mut details) = (false, false);
    let (mut offline, mut rollback) = (false, false);
    let mut root = None;
    let mut remaining = args.iter();
    while let Some(argument) = remaining.next() {
        match argument.as_str() {
            "--yes" => yes = true,
            "--details" => details = true,
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
    let explicit_store = root.is_some();
    let root = store_root(root)?;
    let flags = |scope: &str| {
        let store = if explicit_store {
            format!(" --store {}", shell_quote(&root.display().to_string()))
        } else {
            String::new()
        };
        let scope = if scope == "user" {
            String::new()
        } else {
            format!(" --scope {scope}")
        };
        store + &scope
    };
    let store = codex_omd::ModStore::open(root.clone())?;
    let first = || positional.first().cloned().ok_or_else(usage);
    let done = |display: String| Ok(json!({"display": display}));
    match action {
        "list" => {
            let listed = package_controls::list(&store, None)?;
            // The CLI has no runtime; the last session's status records its load rejections and faults.
            let path = root.join("mod-status.json");
            let status = std::fs::symlink_metadata(&path)
                .ok()
                .filter(|metadata| metadata.is_file() && metadata.len() <= 262_144)
                .and_then(|_| std::fs::read(&path).ok())
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .unwrap_or_default();
            let last_session = |package: &Value| {
                let failed = |key: &str, field: &str, matches: &dyn Fn(&Value) -> bool| {
                    status[key].as_array()?.iter().find(|item| matches(item))?[field].as_str()
                };
                failed("mods", "error", &|item| {
                    item["id"] == package["id"] && item["scope"] == package["scope"]
                })
                .or_else(|| {
                    failed("rejected", "reason", &|item| {
                        item["path"] == package["path"]
                    })
                })
                .filter(|_| package["enabled"] == true)
            };
            let rows = listed["packages"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|package| {
                    let id = package["id"].as_str().unwrap_or("?");
                    let flags = flags(package["scope"].as_str().unwrap_or("user"));
                    let failed = package["failed"].as_str();
                    let (state, note) = if let Some(reason) = package["blocked"].as_str() {
                        (
                            "quarantined",
                            format!(": {reason}; `omd mods unblock {id}{flags}` lifts it"),
                        )
                    } else if package["needs_approval"] == true {
                        (
                            "needs approval",
                            format!(": review it with `omd mods update {id}{flags}`"),
                        )
                    } else {
                        (
                            if package["enabled"] == true {
                                "on"
                            } else {
                                "off"
                            },
                            failed
                                .map(|failed| format!(" failed: {failed}"))
                                .or_else(|| {
                                    last_session(package).map(|failed| {
                                        format!(" failed in the last session: {failed}")
                                    })
                                })
                                .unwrap_or_default(),
                        )
                    };
                    format!(
                        "{id} {} {} {state}{}{note}",
                        package["version"].as_str().unwrap_or("-"),
                        package["scope"].as_str().unwrap_or("-"),
                        package["source"]
                            .as_str()
                            .map_or(String::new(), |source| format!(" ({source})")),
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
            let flags = flags(&scope);
            done(format!(
                "Unblocked {id}. It stays off until `omd mods enable {id}{flags}`."
            ))
        }
        "revoke" => {
            let id = first()?;
            store.revoke(&id)?;
            let flags = flags(&scope);
            done(format!(
                "Revoked {id}: it is off and its grant is dropped. `omd mods update {id}{flags}` approves it again."
            ))
        }
        "install" | "inspect" | "enable" | "disable" | "update" | "remove" | "rollback" => {
            let target = first()?;
            let locked_scope = store
                .package_lock()?
                .packages
                .get(&target)
                .map(|package| package.scope.clone());
            let reviewed = action == "update" && locked_scope.as_deref() != Some(scope.as_str());
            if reviewed
                && let Some(other) = &locked_scope
                && !store.selection_status()?["selections"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|item| {
                        item["id"] == target.as_str()
                            && item["scope"] == scope.as_str()
                            && item["packaged"] != true
                    })
            {
                return Err(io::Error::other(format!(
                    "package_not_installed: {target} is installed at scope {other}; pass --scope {other}"
                )));
            }
            let mut arguments = json!({"action": match action {
                "inspect" => "install",
                _ if reviewed => "trust",
                _ => action,
            }, "scope": scope, "target": "shared"});
            if matches!(action, "install" | "inspect") {
                arguments["reference"] = json!(folder_reference(&target)?);
                arguments["version"] = json!(version);
            } else {
                arguments["id"] = json!(target);
            }
            let preview = package_controls::preview(&store, arguments).map_err(|error| {
                let text = error.to_string();
                let hint = match action {
                    "rollback" if text == "package_rollback_unavailable" => {
                        format!(": {target} has no earlier version to go back to")
                    }
                    _ if text == "package_unavailable" => {
                        format!(": {target} is not in the catalog; `omd mods catalog` lists what is")
                    }
                    _ if text == "package_version_unavailable" => format!(
                        ": that version of {target} is not available; `omd mods catalog {target}` shows the latest"
                    ),
                    _ => return error,
                };
                io::Error::other(text + &hint)
            })?;
            let detailed = describe(&preview.public, true);
            if action == "inspect" {
                return Ok(json!({"display": detailed, "preview": preview.public}));
            }
            let summary = if details {
                detailed.clone()
            } else {
                describe(&preview.public, false)
            };
            if action != "disable" && !yes {
                if !io::IsTerminal::is_terminal(&io::stdin()) {
                    return Err(io::Error::other(format!(
                        "{APPROVAL_REQUIRED}: review `omd mods inspect` or run interactively, then pass --yes\n{summary}"
                    )));
                }
                if !confirm(&summary, &detailed)? {
                    return Err(io::Error::other(format!("{APPROVAL_REQUIRED}: declined")));
                }
            }
            package_controls::apply(&store, &preview.control)?;
            let id = &preview.control.id;
            let scope = preview.control.scope().unwrap_or(&scope);
            let flags = flags(scope);
            done(match action {
                "install" | "update" => {
                    let done = if action == "install" {
                        format!("Installed {id} ({scope}).")
                    } else {
                        format!("Updated {id}.")
                    };
                    match package_controls::list(&store, None) {
                        Ok(listed)
                            if !listed["packages"].as_array().into_iter().flatten().any(
                                |package| {
                                    package["id"] == id.as_str()
                                        && package["scope"] == scope
                                        && package["enabled"] == true
                                },
                            ) =>
                        {
                            format!(
                                "{done} It is off: run `omd mods enable {id}{flags}` to turn it on."
                            )
                        }
                        _ => done,
                    }
                }
                "remove" => format!("Removed {id}. Its cache, state and local sources are kept."),
                "rollback" => format!("Rolled {id} back to its previous version."),
                _ => format!("{id} is {action}d."),
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
    let resolved = path.canonicalize().map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("package_folder_unavailable: {reference}: {error}"),
        )
    })?;
    Ok(resolved.display().to_string())
}

fn phrases(capabilities: &Value) -> Vec<String> {
    let capabilities = capabilities
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    codex_omd::package_controls::grant_phrases(&capabilities)
        .iter()
        .map(|phrase| {
            format!(
                "    {} {}",
                if phrase["risky"] == true { "!" } else { "-" },
                phrase["phrase"].as_str().unwrap_or_default()
            )
        })
        .collect()
}

fn describe(preview: &Value, details: bool) -> String {
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
        lines.push(format!("  license: {}", text(&package["license"]["to"])));
        let can = phrases(&package["capabilities"]["to"]);
        if can.is_empty() {
            lines.push("  It needs no permissions.".to_owned());
        } else {
            lines.push("  It can:".to_owned());
            lines.extend(can);
        }
        if details {
            lines.push(format!("  source: {}", package["source"]["to"]));
            lines.push(format!(
                "  integrity: {}",
                text(&package["integrity"]["to"])
            ));
        }
        for exposure in package["authority"]["to"]["exposure"]
            .as_array()
            .into_iter()
            .flatten()
        {
            lines.push(format!("  authority: {}", text(exposure)));
        }
        for (key, value) in package["authority"]["to"].as_object().into_iter().flatten() {
            if key != "exposure"
                && !value.is_null()
                && value.as_object().is_none_or(|fields| !fields.is_empty())
            {
                lines.push(format!("  {}: {}", key.replace('_', " "), text(value)));
            }
        }
        for (label, key) in [
            ("dependencies", "dependencies"),
            ("install scripts", "lifecycle"),
            ("exec environment", "exec_environment"),
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
        if details && package["state_version"]["handler_required"] == true {
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
    for (label, key) in [
        ("source sha256", "sha256"),
        ("exec environment", "exec_environment"),
        ("secret environment", "secret_environment"),
        ("codex config", "codex_config"),
    ] {
        if (details || key != "sha256")
            && !changes[key].is_null()
            && changes[key]
                .as_array()
                .is_none_or(|values| !values.is_empty())
        {
            lines.push(format!("  {label}: {}", text(&changes[key])));
        }
    }
    if let Some(warning) = preview["identity_warning"].as_str() {
        lines.push(format!("  WARNING: {warning}"));
    }
    let added = phrases(&preview["grants_added"]);
    if !added.is_empty() {
        lines.push("  New permissions:".to_owned());
        lines.extend(added);
    }
    lines.join("\n")
}

fn confirm(summary: &str, details: &str) -> io::Result<bool> {
    use std::io::{BufRead, Write};
    let mut terminal = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")?;
    let mut reader = io::BufReader::new(terminal.try_clone()?);
    writeln!(terminal, "{summary}")?;
    loop {
        write!(terminal, "Proceed? [y/N] (d shows source and integrity) ")?;
        terminal.flush()?;
        let mut answer = String::new();
        reader.read_line(&mut answer)?;
        match answer.trim().to_lowercase().as_str() {
            "d" => writeln!(terminal, "{details}")?,
            answer => return Ok(matches!(answer, "y" | "yes")),
        }
    }
}

const HELP: &str = "Usage:
  omd install REFERENCE [--version V] [--scope user|project] [--yes] [--details] [--store PATH]
  omd mods list | catalog [QUERY] | inspect REFERENCE | events | reset-lock
  omd mods enable|disable|update|remove|rollback|revoke|unblock ID [FLAGS]
  omd mods quarantine ID REASON [FLAGS]
  omd mods sync [--offline|--rollback] [FLAGS]
      Manage mod packages. REFERENCE is ID[@VERSION] from the curated index, npm:NAME[@VERSION],
      git+URL[#REF[:DIRECTORY]] or a folder (./PATH or /PATH). FLAGS are those of omd install.
  omd store export|reset --mod ID [--repo PATH] [--store PATH] [--scope repository|user]
      Export or reset one mod's namespaced store without running mod code.
  omd COMMAND --repo PATH [--store PATH] [--home PATH] [--sqlite-home PATH] [ARGS]
      Run a command an enabled mod exports. Model requests and process execution are unavailable here.
  omd update, omd uninstall [--purge]
      Update or remove OMD itself.
  omd --version
      The OMD, Codex and mod API versions.";

fn run(args: Vec<String>) -> io::Result<Value> {
    if args.is_empty() || matches!(args[0].as_str(), "help" | "-h" | "--help") {
        return Ok(json!({"display": HELP}));
    }
    if args[0] == "--version" || args[0] == "-V" {
        return Ok(json!({"display": format!(
            "oh-my-diff {} (Codex {}, mod API {})",
            codex_omd::OMD_HOST_RELEASE,
            codex_omd::CODEX_HOST_RELEASE,
            codex_omd::MOD_API_VERSION
        )}));
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
    let unknown = || {
        io::Error::other(format!(
            "unknown command: {command} (`omd help` lists the commands; a mod's command needs --repo PATH)"
        ))
    };
    let repository = repository.ok_or_else(unknown)?;
    let root = store_root(store)?;
    let home = home
        .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|path| PathBuf::from(path).join(".codex")));
    let sessions = home.as_ref().map(|path| path.join("sessions"));
    let mut runtime = ModHost::open(root.clone(), ModOpenOptions::default())?;
    let exports: Vec<_> = runtime
        .commands()
        .into_iter()
        .filter(|(_, export)| export.cli.as_deref() == Some(command))
        .collect();
    if exports.is_empty() {
        return Err(unknown());
    }
    if exports.len() > 1 {
        return Err(io::Error::other("plugin_command_collision"));
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
    runtime.invoke(
        owner,
        runtime.generation(),
        "command",
        &export.name,
        json!(payload),
        ModInvokeOptions {
            active: &|| Instant::now() < deadline,
            host: ModHostCallback::Scoped(&mut |caller, request| {
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
            }),
            ..ModInvokeOptions::default()
        },
    )
}

fn main() {
    match run(std::env::args().skip(1).collect()) {
        Ok(value) => {
            if let Some(display) = value.get("display").and_then(Value::as_str) {
                codex_omd::print_output(
                    &display
                        .chars()
                        .filter(|character| {
                            !character.is_control() || matches!(character, '\n' | '\t')
                        })
                        .collect::<String>(),
                );
            } else {
                codex_omd::print_output(&serde_json::to_string_pretty(&value).unwrap_or_default());
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
    fn trust_summary_lists_risky_phrases_first_and_keeps_detail_for_d() {
        let preview = json!({"action": "install", "id": "demo", "changes": {"packages": [{
            "id": "demo", "version": {"from": null, "to": "1.0.0"}, "source": {"to": "npm:demo"},
            "integrity": {"to": "sha512-x"}, "license": {"to": "MIT"},
            "capabilities": {"to": ["fs.read", "os"]},
            "authority": {"to": {"exposure": ["os: unsandboxed"]}},
            "state_version": {"handler_required": true}}]}, "grants_added": []});
        let summary = describe(&preview, false);
        let risky = summary
            .find("    ! run listed programs unsandboxed")
            .unwrap();
        assert!(risky < summary.find("    - read files in this repository").unwrap());
        assert!(!summary.contains("integrity") && summary.contains("authority: os: unsandboxed"));
        let detailed = describe(&preview, true);
        assert!(
            detailed.contains("integrity: sha512-x")
                && detailed.contains("authority: os: unsandboxed")
        );
    }

    #[test]
    fn shell_quote_leaves_plain_paths_and_quotes_the_rest() {
        assert_eq!(shell_quote("/Users/me/.omd/store"), "/Users/me/.omd/store");
        assert_eq!(shell_quote("/Users/me/My Store"), "'/Users/me/My Store'");
        assert_eq!(shell_quote("/tmp/it's"), "'/tmp/it'\\''s'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn version_help_and_unknown_commands_need_no_repository() {
        let version = format!(
            "oh-my-diff {} (Codex {}, mod API {})",
            codex_omd::OMD_HOST_RELEASE,
            codex_omd::CODEX_HOST_RELEASE,
            codex_omd::MOD_API_VERSION
        );
        for flag in ["--version", "-V"] {
            assert_eq!(run(vec![flag.into()]).unwrap()["display"], version);
        }
        for flag in ["help", "-h", "--help"] {
            assert!(
                run(vec![flag.into()]).unwrap()["display"]
                    .as_str()
                    .unwrap()
                    .contains("\n  omd COMMAND --repo PATH")
            );
        }
        let unknown = "unknown command: bogus (`omd help` lists the commands; a mod's command needs --repo PATH)";
        assert_eq!(run(vec!["bogus".into()]).unwrap_err().to_string(), unknown);
        let temp = tempfile::tempdir().unwrap();
        let store = temp.path().join("store");
        codex_omd::ModStore::create(store.clone()).unwrap();
        let arguments = ["bogus", "--store", store.to_str().unwrap(), "--repo"]
            .map(str::to_owned)
            .into_iter()
            .chain([temp.path().to_str().unwrap().to_owned()])
            .collect();
        assert_eq!(run(arguments).unwrap_err().to_string(), unknown);
        let missing = folder_reference("./definitely-missing-folder")
            .unwrap_err()
            .to_string();
        assert!(
            missing.starts_with("package_folder_unavailable: ./definitely-missing-folder: "),
            "{missing}"
        );
    }

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
}
