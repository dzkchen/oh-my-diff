use codex_omd::ModHost;
use codex_omd::ModInstallRequest;
use codex_omd::ModStore;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::process::Command;

fn plugin_files(root: &std::path::Path) -> io::Result<BTreeMap<String, String>> {
    let mut files = BTreeMap::new();
    let mut pending = vec![root.to_path_buf()];
    let mut total = 0_u64;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                return Err(io::Error::other("plugin_preview_symlink_refused"));
            }
            if kind.is_dir() {
                pending.push(entry.path());
                continue;
            }
            if !kind.is_file() || files.len() >= 512 {
                return Err(io::Error::other("plugin_preview_file_limit"));
            }
            let entry_path = entry.path();
            let bytes = fs::read(&entry_path)?;
            total += bytes.len() as u64;
            if total > 16_777_216 {
                return Err(io::Error::other("plugin_preview_size_limit"));
            }
            let path = entry_path.strip_prefix(root).map_err(io::Error::other)?;
            files.insert(
                path.to_string_lossy().into_owned(),
                format!("{:x}", Sha256::digest(bytes)),
            );
        }
    }
    Ok(files)
}

fn plugin_preview(codex: &str, home: &str, id: &str, candidate: &str) -> io::Result<Value> {
    let (name, marketplace) = id
        .split_once('@')
        .ok_or_else(|| io::Error::other("plugin_id_requires_name_at_marketplace"))?;
    if [name, marketplace].iter().any(|part| {
        part.is_empty()
            || !part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    }) {
        return Err(io::Error::other("invalid_plugin_id"));
    }
    let home = PathBuf::from(home).canonicalize()?;
    let candidate = PathBuf::from(candidate).canonicalize()?;
    let output = Command::new(codex)
        .env("CODEX_HOME", &home)
        .args(["plugin", "list", "--json", "--marketplace", marketplace])
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ));
    }
    let listing: Value = serde_json::from_slice(&output.stdout)?;
    let installed = listing["installed"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|entry| entry["pluginId"] == id)
        .ok_or_else(|| io::Error::other("plugin_not_installed"))?;
    if installed["source"]["source"] != "local" {
        return Err(io::Error::other("plugin_preview_requires_local_source"));
    }
    let version = installed["version"]
        .as_str()
        .ok_or_else(|| io::Error::other("installed_plugin_version_missing"))?;
    if !version
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-' || byte == b'_')
    {
        return Err(io::Error::other("invalid_installed_plugin_version"));
    }
    let installed_path = home
        .join("plugins/cache")
        .join(marketplace)
        .join(name)
        .join(version);
    let manifest: Value =
        serde_json::from_slice(&fs::read(candidate.join(".codex-plugin/plugin.json"))?)?;
    if manifest["name"] != name || !manifest["version"].is_string() {
        return Err(io::Error::other("candidate_plugin_manifest_mismatch"));
    }
    let current = plugin_files(&installed_path)?;
    let proposed = plugin_files(&candidate)?;
    let paths = current
        .keys()
        .chain(proposed.keys())
        .collect::<std::collections::BTreeSet<_>>();
    let changes = paths
        .into_iter()
        .filter_map(|path| {
            let before = current.get(path);
            let after = proposed.get(path);
            (before != after).then(
                || serde_json::json!({"path":path,"before_sha256":before,"after_sha256":after}),
            )
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "plugin": id,
        "installed_version": version,
        "candidate_version": manifest["version"],
        "installed_enabled": installed["enabled"],
        "installed_path": installed_path,
        "candidate_path": candidate,
        "changes": changes,
        "same_version_changed": manifest["version"] == version && current != proposed,
        "applied": false,
        "note": "This is a read-only local file preview. Codex still owns plugin installation and hook trust."
    }))
}

fn run(args: &[String]) -> io::Result<Value> {
    let bad = || {
        io::Error::other(
            "usage: omd-mod init STORE NODE | plugin-component PLUGIN_ROOT | inspect PACKAGE | trust STORE PACKAGE SHA256 CAPABILITIES_CSV [user|project] [--allow-secret-env NAME]... [--expires SECONDS] | revoke STORE PACKAGE | trust-all STORE PACKAGES_JSON ([{path, sha256, capabilities, scope?}]) | enable/disable STORE PACKAGE | package-plan STORE REQUEST_JSON (keys: action? install|update; source {kind: local, path} or {kind: repository, ...} or {kind: package, index, id, version}; scope?; activate?; trust.packages.ID {capabilities, lifecycle?, dependencies?, secret_environment?}) | package-apply STORE REQUEST_JSON CONFIRMATION | package-lock STORE | package-enable/package-disable STORE ID | package-rollback-plan/package-uninstall-plan STORE ID | package-rollback/package-uninstall STORE ID CONFIRMATION | plugin-preview CODEX_BIN CODEX_HOME NAME@MARKETPLACE CANDIDATE | status/selection-status/reload/report/events/declarations/credentials STORE | credentials STORE add-secret MOD_ID LABEL ORIGIN (value on stdin) | test STORE SCENARIO_JSON [THREAD] | diagnostics STORE OUTPUT_JSON | explain DENIAL | discover USER_DIR PROJECT_DIR | settings STORE PACKAGE JSON | migrate STORE PACKAGE | rollback STORE PACKAGE BACKUP | command STORE MOD NAME JSON [THREAD]",
        )
    };
    match args {
        [command, root] if command == "plugin-component" => {
            codex_omd::plugin_component::inspect(&PathBuf::from(root).canonicalize()?)
        }
        [command, codex, home, id, candidate] if command == "plugin-preview" => {
            plugin_preview(codex, home, id, candidate)
        }
        [command, root, request] if command == "package-plan" => {
            ModStore::open(PathBuf::from(root).canonicalize()?)?
                .package_plan(serde_json::from_str::<ModInstallRequest>(request)?)
                .and_then(|plan| serde_json::to_value(plan).map_err(io::Error::other))
        }
        [command, root, request, confirmation] if command == "package-apply" => {
            ModStore::open(PathBuf::from(root).canonicalize()?)?
                .package_apply(
                    serde_json::from_str::<ModInstallRequest>(request)?,
                    confirmation,
                )
                .and_then(|lock| serde_json::to_value(lock).map_err(io::Error::other))
        }
        [command, root] if command == "package-lock" => {
            ModStore::open(PathBuf::from(root).canonicalize()?)?
                .package_lock()
                .and_then(|lock| serde_json::to_value(lock).map_err(io::Error::other))
        }
        [command, root, id] if command == "package-disable" => {
            ModStore::open(PathBuf::from(root).canonicalize()?)?
                .package_disable(id)
                .and_then(|lock| serde_json::to_value(lock).map_err(io::Error::other))
        }
        [command, root, id] if command == "package-enable" => {
            ModStore::open(PathBuf::from(root).canonicalize()?)?
                .package_enable(id)
                .and_then(|lock| serde_json::to_value(lock).map_err(io::Error::other))
        }
        [command, root, id]
            if command == "package-rollback-plan" || command == "package-uninstall-plan" =>
        {
            let store = ModStore::open(PathBuf::from(root).canonicalize()?)?;
            let plan = if command == "package-rollback-plan" {
                store.package_rollback_plan(id)?
            } else {
                store.package_uninstall_plan(id)?
            };
            serde_json::to_value(plan).map_err(io::Error::other)
        }
        [command, root, id, confirmation]
            if command == "package-rollback" || command == "package-uninstall" =>
        {
            let store = ModStore::open(PathBuf::from(root).canonicalize()?)?;
            let lock = if command == "package-rollback" {
                store.package_rollback(id, confirmation)?
            } else {
                store.package_uninstall(id, confirmation)?
            };
            serde_json::to_value(lock).map_err(io::Error::other)
        }
        [command, user, project] if command == "discover" => {
            ModStore::discover(&PathBuf::from(user), &PathBuf::from(project))
        }
        [command, root, path, settings] if command == "settings" => {
            ModStore::open(PathBuf::from(root).canonicalize()?)?.settings(
                &PathBuf::from(path).canonicalize()?,
                serde_json::from_str(settings)?,
            )?;
            Ok(Value::String(
                "settings saved for next turn boundary".into(),
            ))
        }
        [command, root, path] if command == "migrate" => {
            ModStore::open(PathBuf::from(root).canonicalize()?)?
                .migrate(&PathBuf::from(path).canonicalize()?)
        }
        [command, root, path, backup] if command == "rollback" => {
            ModStore::open(PathBuf::from(root).canonicalize()?)?
                .rollback(&PathBuf::from(path).canonicalize()?, &PathBuf::from(backup))
        }
        [command, root, node] if command == "init" => {
            ModStore::create(PathBuf::from(root), PathBuf::from(node))?;
            Ok(Value::String("created".into()))
        }
        [command, path] if command == "inspect" => {
            ModStore::inspect_package(&PathBuf::from(path).canonicalize()?)
        }
        [command, root, path, sha, capabilities, rest @ ..] if command == "trust" => {
            let mut scope = "user".to_owned();
            let mut secrets = Vec::new();
            let mut expires_at = None;
            let mut rest = rest.iter();
            while let Some(argument) = rest.next() {
                if argument == "--allow-secret-env" {
                    secrets.push(
                        rest.next()
                            .ok_or_else(|| io::Error::other("--allow-secret-env needs a NAME"))?
                            .clone(),
                    );
                } else if argument == "--expires" {
                    let seconds: u64 = rest
                        .next()
                        .and_then(|value| value.parse().ok())
                        .ok_or_else(|| io::Error::other("--expires needs SECONDS"))?;
                    expires_at = Some(
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_err(io::Error::other)?
                            .as_secs()
                            .checked_add(seconds)
                            .ok_or_else(|| io::Error::other("--expires is too large"))?,
                    );
                } else {
                    scope = argument.clone();
                }
            }
            let capabilities: Vec<String> = capabilities
                .split(',')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect();
            let exposure = codex_omd::authority_exposure(&capabilities);
            ModStore::open(PathBuf::from(root).canonicalize()?)?.trust_all(vec![
                codex_omd::Trust {
                    path: PathBuf::from(path).canonicalize()?,
                    sha256: sha.clone(),
                    capabilities,
                    scope: scope.clone(),
                    secret_environment: secrets,
                    expires_at,
                },
            ])?;
            Ok(json!({
                "status": format!("trusted in the {scope} scope; disabled until explicitly enabled"),
                "expires_at": expires_at,
                "exposure": exposure,
            }))
        }
        [command, root, path] if command == "revoke" => {
            ModStore::open(PathBuf::from(root).canonicalize()?)?
                .revoke_authority(&PathBuf::from(path).canonicalize()?)?;
            Ok(Value::String(
                "os and approve authority revoked; running processes stop at the next turn boundary; trust again to renew".into(),
            ))
        }
        [command, root, packages] if command == "trust-all" => {
            let packages: Vec<Value> = serde_json::from_str(packages)?;
            let packages = packages
                .iter()
                .map(|package| {
                    let text = |key: &str| {
                        package[key]
                            .as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| io::Error::other(format!("trust-all needs {key}")))
                    };
                    Ok(codex_omd::Trust {
                        path: PathBuf::from(text("path")?).canonicalize()?,
                        sha256: text("sha256")?,
                        capabilities: serde_json::from_value(package["capabilities"].clone())?,
                        scope: package["scope"].as_str().unwrap_or("user").to_owned(),
                        secret_environment: Vec::new(),
                        expires_at: None,
                    })
                })
                .collect::<io::Result<Vec<_>>>()?;
            let count = packages.len();
            ModStore::open(PathBuf::from(root).canonicalize()?)?.trust_all(packages)?;
            Ok(Value::String(format!(
                "trusted {count} packages; disabled until explicitly enabled"
            )))
        }
        [command, root, path] if command == "enable" || command == "disable" => {
            let path = PathBuf::from(path);
            ModStore::open(PathBuf::from(root).canonicalize()?)?
                .enable(&path.canonicalize().unwrap_or(path), command == "enable")?;
            Ok(Value::String(
                "selection saved; takes effect at the next turn boundary".into(),
            ))
        }
        [command, root, action, owner, label, origin]
            if command == "credentials" && action == "add-secret" =>
        {
            let mut value = String::new();
            io::Read::read_to_string(&mut io::stdin(), &mut value)?;
            let value = value.trim_end_matches(['\n', '\r']);
            let profiles = codex_omd::credentials::CredentialProfiles::open(
                &PathBuf::from(root).canonicalize()?,
            )?;
            let existing = profiles.visible(owner)?.into_iter().find(|profile| {
                profile["kind"] == "secret"
                    && profile["label"] == label.as_str()
                    && profile["origin"] == origin.as_str()
            });
            let id = match existing {
                Some(profile) => profile["id"].as_str().unwrap_or_default().to_owned(),
                None => profiles.create_secret(label, origin, owner)?.id,
            };
            profiles.store_secret(&id, value)?;
            profiles.public(&profiles.profile(&id)?)
        }
        [command, root] if command == "credentials" => Ok(Value::Array(
            codex_omd::credentials::CredentialProfiles::open(&PathBuf::from(root).canonicalize()?)?
                .visible("")?,
        )),
        [command, root] if command == "reload" => {
            ModStore::open(PathBuf::from(root).canonicalize()?)?.reload()?;
            Ok(Value::String(
                "reload queued for the next turn boundary".into(),
            ))
        }
        [command, root] if command == "status" => {
            let mut host = ModHost::open_in(
                PathBuf::from(root).canonicalize()?,
                |_| Ok(()),
                &std::env::current_dir()?,
            )?;
            let terminal = host.terminal_view(
                serde_json::json!({"event": "status", "ledger": null}),
                || true,
            );
            let mut status = host.status();
            status["terminal"] = serde_json::json!({"contributors": terminal.contributors,
                "conflicts": terminal.conflicts, "diagnostics": terminal.diagnostics});
            Ok(status)
        }
        [command, root] if command == "selection-status" => {
            ModStore::open(PathBuf::from(root).canonicalize()?)?.selection_status()
        }
        [command, root] if command == "report" => {
            let status = ModHost::open(PathBuf::from(root).canonicalize()?)?.status();
            Ok(
                serde_json::json!({"api":status["api"],"mods":status["mods"].as_array()
                .into_iter().flatten().map(|item| serde_json::json!({
                    "id":item["id"],"declared":{"capabilities":item["capabilities"],
                        "services":item["services"]},"used":item["source_use"],
                    "unused_grants":item["unused_grants"],
                    "unused_environment":item["unused_environment"],"error":item["error"]
                })).collect::<Vec<_>>() }),
            )
        }
        [command, root] if command == "events" => {
            Ok(ModHost::open(PathBuf::from(root).canonicalize()?)?.author_inspection())
        }
        [command, root] if command == "declarations" => {
            let status = ModHost::open(PathBuf::from(root).canonicalize()?)?.status();
            Ok(
                serde_json::json!({"api":status["api"],"active_host":status["active_host_types"],
                "installed_contracts":status["installed_contract_types"]}),
            )
        }
        [command, root, scenario, thread @ ..] if command == "test" && thread.len() <= 1 => {
            let scenario: Value = serde_json::from_slice(&std::fs::read(scenario)?)?;
            let mut host = ModHost::open_in(
                PathBuf::from(root).canonicalize()?,
                |_| Ok(()),
                &std::env::current_dir()?,
            )?;
            let _thread = codex_omd::StateThread::enter(thread.first().cloned());
            host.offline_test(scenario)
        }
        [command, root, output] if command == "diagnostics" => {
            let bundle = ModHost::open(PathBuf::from(root).canonicalize()?)?.diagnostic_bundle();
            let output = PathBuf::from(output);
            std::fs::write(&output, serde_json::to_vec_pretty(&bundle)?)?;
            Ok(serde_json::json!({"bundle":output,"redacted":true}))
        }
        [command, denial] if command == "explain" => Ok(ModHost::capability_explanation(denial)),
        [command, root, id, name, payload, thread @ ..]
            if command == "command" && thread.len() <= 1 =>
        {
            let mut host = ModHost::open_in(
                PathBuf::from(root).canonicalize()?,
                |_| Ok(()),
                &std::env::current_dir()?,
            )?;
            let _thread = codex_omd::StateThread::enter(thread.first().cloned());
            host.invoke(
                id,
                host.generation(),
                "command",
                name,
                serde_json::from_str(payload)?,
            )
        }
        _ => Err(bad()),
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
