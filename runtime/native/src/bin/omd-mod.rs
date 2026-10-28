use codex_omd::MANAGED_POLICY_FILE;
use codex_omd::MANAGED_POLICY_KEY;
use codex_omd::Managed;
use codex_omd::ModHost;
use codex_omd::ModInstallRequest;
use codex_omd::ModStore;
use codex_omd::load_managed;
use codex_omd_extension::validate_tool_schema;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::process::Command;

fn store(root: &str) -> io::Result<PathBuf> {
    PathBuf::from(root).canonicalize().map_err(|error| {
        let hint = if error.kind() == io::ErrorKind::NotFound {
            "; create it with omd-mod init STORE"
        } else {
            ""
        };
        io::Error::new(
            error.kind(),
            format!("store_unavailable: {root}: {error}{hint}"),
        )
    })
}

fn open(root: &str) -> io::Result<ModStore> {
    ModStore::open(store(root)?)
}

fn json(value: impl serde::Serialize) -> io::Result<Value> {
    serde_json::to_value(value).map_err(io::Error::other)
}

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

fn policy(action: &str, rest: &[String]) -> io::Result<Value> {
    let summary = |managed: Option<Managed>| {
        json!(managed.map(|managed| json!({"origin": managed.origin, "sha256": managed.sha256, "policy": managed.policy})))
    };
    let broker = |op: &str, value: Value| {
        if !codex_omd::broker::deployed() {
            return Err(io::Error::other(format!(
                "policy_requires_broker: without the OS-separated broker, install the root-owned {MANAGED_POLICY_FILE} with omd-package policy install FILE"
            )));
        }
        codex_omd::broker::authorized(op, value)
    };
    let file = |path: &str| -> io::Result<Managed> {
        codex_omd::managed(
            serde_json::from_slice(&fs::read(path)?).map_err(io::Error::other)?,
            path.to_owned(),
        )
    };
    match (action, rest) {
        ("show", []) => Ok(summary(load_managed()?)),
        ("check", [path]) => Ok(summary(Some(file(path)?))),
        ("set", [path]) => {
            let managed = file(path)?;
            broker(
                "policy.put",
                json!({"key": MANAGED_POLICY_KEY, "value": managed.policy}),
            )?;
            Ok(summary(load_managed()?))
        }
        ("clear", []) => {
            broker(
                "policy.put",
                json!({"key": MANAGED_POLICY_KEY, "value": null}),
            )?;
            Ok(summary(load_managed()?))
        }
        ("rollback", []) => {
            broker("policy.rollback", json!({"key": MANAGED_POLICY_KEY}))?;
            Ok(summary(load_managed()?))
        }
        ("explain", [root, project @ ..]) if project.len() <= 1 => {
            let store = open(root)?;
            let project = project
                .first()
                .map(|project| PathBuf::from(project).canonicalize())
                .transpose()?;
            let user = store.managed_user();
            let deployment = store.managed_deployment().unwrap_or_default();
            let targets = match store.managed() {
                Ok(Some(managed)) => managed
                    .targets(&user, project.as_deref())
                    .into_iter()
                    .map(|target| {
                        json!({"id": target.id, "version": target.version, "sha256": target.sha256,
                            "source": target.source, "tier": target.tier,
                            "deployed": deployment.packages.iter().any(|deployed|
                                deployed.id == target.id && deployed.sha256 == target.sha256)})
                    })
                    .collect(),
                _ => Vec::new(),
            };
            let mut status = store.selection_status_in(project.as_deref())?;
            status["user"] = json!(user);
            status["targets"] = json!(targets);
            status["deployment"] = json!({"generation": deployment.generation,
                "policy_sha256": deployment.policy_sha256, "packages": deployment.packages,
                "previous_generation": deployment.previous.map(|previous| previous.generation)});
            Ok(status)
        }
        _ => Err(io::Error::other(
            "usage: omd-mod policy show|clear|rollback | policy check/set FILE | policy explain STORE [PROJECT_DIR]",
        )),
    }
}

/// A mod id stays a bare name; anything with a `/` is a package folder.
fn package_target(target: &str) -> io::Result<PathBuf> {
    if target.contains('/') || matches!(target, "." | "..") {
        PathBuf::from(target).canonicalize()
    } else {
        Ok(PathBuf::from(target))
    }
}

fn run(args: &[String]) -> io::Result<Value> {
    let bad = || {
        io::Error::other(concat!(
            "usage: omd-mod init STORE | authorize-runner STORE | plugin-component PLUGIN_ROOT | inspect PACKAGE | trust STORE PACKAGE SHA256 CAPABILITIES_CSV [user|project] [--allow-secret-env NAME]... [--expires SECONDS] | revoke STORE MOD_ID_OR_PACKAGE | trust-all STORE PACKAGES_JSON ([{path, sha256, capabilities, scope?}]) | enable/disable STORE PACKAGE | require STORE PACKAGE | package-plan STORE REQUEST_JSON (keys: action? install|update; source {kind: local, path} or {kind: repository, repository, revision (commit, branch or tag), subdirectory?} or {kind: package, index, id, version} or {kind: npm, package, version?, registry?, integrity?}; scope?; offline?; trust.packages.ID {capabilities, lifecycle?, dependencies?, secret_environment?}) | package-apply STORE REQUEST_JSON CONFIRMATION | package-lock STORE | package-enable/package-disable/package-unblock STORE ID | package-quarantine STORE ID REASON | security-events STORE | package-rollback-plan/package-uninstall-plan STORE ID | package-rollback/package-uninstall STORE ID CONFIRMATION | plugin-preview CODEX_BIN CODEX_HOME NAME@MARKETPLACE CANDIDATE | status/selection-status/reload/report/events/declarations/credentials STORE | reset STORE host.json|mods.json|packages.lock.json|managed.json | policy show|clear|rollback | policy check/set FILE | policy explain STORE [PROJECT_DIR] | package-sync STORE [--offline|--rollback] | credentials STORE add-secret MOD_ID LABEL ORIGIN (value on stdin) | test STORE SCENARIO_JSON [THREAD] | diagnostics STORE OUTPUT_JSON | explain DENIAL | discover USER_DIR PROJECT_DIR | settings STORE PACKAGE JSON | migrate STORE MOD_ID_OR_PACKAGE | rollback STORE MOD_ID_OR_PACKAGE BACKUP | command STORE MOD NAME JSON [THREAD] | cost STORE MOD RUNS [COMMAND [ARGS_JSON]]",
            " | broker-grants-import STORE [SNAPSHOT_JSON]"
        ))
    };
    match args {
        [command, root] if command == "plugin-component" => {
            codex_omd::plugin_component::inspect(&PathBuf::from(root).canonicalize()?)
        }
        [command, codex, home, id, candidate] if command == "plugin-preview" => {
            plugin_preview(codex, home, id, candidate)
        }
        [command, root, request] if command == "package-plan" => open(root)?
            .package_plan(serde_json::from_str::<ModInstallRequest>(request)?)
            .and_then(json),
        [command, root, request, confirmation] if command == "package-apply" => open(root)?
            .package_apply(
                serde_json::from_str::<ModInstallRequest>(request)?,
                confirmation,
            )
            .and_then(json),
        [command, root] if command == "package-lock" => open(root)?.package_lock().and_then(json),
        [command, root, id] if command == "package-disable" => {
            open(root)?.package_disable(id).and_then(json)
        }
        [command, root, id] if command == "package-enable" => {
            open(root)?.package_enable(id).and_then(json)
        }
        [command, root, id]
            if command == "package-rollback-plan" || command == "package-uninstall-plan" =>
        {
            let store = open(root)?;
            let plan = if command == "package-rollback-plan" {
                store.package_rollback_plan(id)?
            } else {
                store.package_uninstall_plan(id)?
            };
            json(plan)
        }
        [command, root, id, confirmation]
            if command == "package-rollback" || command == "package-uninstall" =>
        {
            let store = open(root)?;
            let lock = if command == "package-rollback" {
                store.package_rollback(id, confirmation)?
            } else {
                store.package_uninstall(id, confirmation)?
            };
            json(lock)
        }
        [command, user, project] if command == "discover" => {
            ModStore::discover(&PathBuf::from(user), &PathBuf::from(project))
        }
        [command, root, path, settings] if command == "settings" => {
            open(root)?.settings(
                &PathBuf::from(path).canonicalize()?,
                serde_json::from_str(settings)?,
            )?;
            Ok(Value::String(
                "settings saved for next turn boundary".into(),
            ))
        }
        [command, root, target] if command == "migrate" => {
            open(root)?.migrate(&package_target(target)?)
        }
        [command, root, target, backup] if command == "rollback" => {
            open(root)?.rollback(&package_target(target)?, &PathBuf::from(backup))
        }
        [command, root] if command == "init" => {
            ModStore::create(PathBuf::from(root))?;
            Ok(Value::String("created".into()))
        }
        [command, root] if command == "authorize-runner" => {
            open(root)?.authorize_runner()?;
            Ok(Value::String("updated".into()))
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
            open(root)?.trust_all(vec![codex_omd::Trust {
                path: PathBuf::from(path).canonicalize()?,
                sha256: sha.clone(),
                capabilities,
                scope: scope.clone(),
                secret_environment: secrets,
                expires_at,
            }])?;
            Ok(json!({
                "status": format!("trusted in the {scope} scope; disabled until explicitly enabled"),
                "expires_at": expires_at,
                "exposure": exposure,
            }))
        }
        [command, root, target] if command == "revoke" => {
            let target = match PathBuf::from(target).canonicalize() {
                Ok(path) if target.contains('/') => path.display().to_string(),
                _ => target.clone(),
            };
            open(root)?.revoke(&target)?;
            Ok(Value::String(
                "disabled and every grant dropped; owned work stops at the next reload; trust or install again to renew".into(),
            ))
        }
        [command, root, id, reason @ ..] if command == "package-quarantine" => open(root)?
            .package_quarantine(id, &reason.join(" "))
            .and_then(json),
        [command, root, id] if command == "package-unblock" => {
            open(root)?.package_unblock(id).and_then(json)
        }
        [command, root] if command == "security-events" => {
            Ok(Value::Array(open(root)?.security_events()?))
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
            open(root)?.trust_all(packages)?;
            Ok(Value::String(format!(
                "trusted {count} packages; disabled until explicitly enabled"
            )))
        }
        [command, root, rest @ ..] if command == "broker-grants-import" && rest.len() <= 1 => {
            open(root)?.broker_grants_import(
                rest.first()
                    .map(|snapshot| serde_json::from_str(snapshot))
                    .transpose()?,
            )
        }
        [command, root, path] if command == "require" => {
            let path = PathBuf::from(path);
            open(root)?.require(&path.canonicalize().unwrap_or(path))?;
            Ok(Value::String(
                "selection required; in-app mod screens keep it on".into(),
            ))
        }
        [command, root, path] if command == "enable" || command == "disable" => {
            let path = PathBuf::from(path);
            open(root)?.enable(&path.canonicalize().unwrap_or(path), command == "enable")?;
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
            let profiles = codex_omd::credentials::CredentialProfiles::open(&store(root)?)?;
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
            codex_omd::credentials::CredentialProfiles::open(&store(root)?)?.visible("")?,
        )),
        [command, root] if command == "reload" => {
            open(root)?.reload()?;
            Ok(Value::String(
                "reload queued for the next turn boundary".into(),
            ))
        }
        [command, root, name] if command == "reset" => {
            let aside = open(root)?.reset(name)?;
            Ok(json!({"reset": name, "aside": aside}))
        }
        [command, root] if command == "status" => {
            let mut host = ModHost::open_in(
                store(root)?,
                validate_tool_schema,
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
        [command, root] if command == "selection-status" => open(root)?.selection_status(),
        [command, action, rest @ ..] if command == "policy" => policy(action, rest),
        [command, root, flags @ ..] if command == "package-sync" && flags.len() <= 1 => {
            let store = open(root)?;
            match flags {
                [] => store.package_sync(false),
                [flag] if flag == "--offline" => store.package_sync(true),
                [flag] if flag == "--rollback" => store.package_sync_rollback(),
                _ => Err(io::Error::other(
                    "usage: omd-mod package-sync STORE [--offline|--rollback]",
                )),
            }
        }
        [command, root] if command == "report" => {
            let status = ModHost::open_validated(store(root)?, validate_tool_schema)?.status();
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
            Ok(ModHost::open_validated(store(root)?, validate_tool_schema)?.author_inspection())
        }
        [command, root] if command == "declarations" => {
            let status = ModHost::open_validated(store(root)?, validate_tool_schema)?.status();
            Ok(
                serde_json::json!({"api":status["api"],"active_host":status["active_host_types"],
                "installed_contracts":status["installed_contract_types"],
                "tool_types":status["tool_types"]}),
            )
        }
        [command, root, scenario, thread @ ..] if command == "test" && thread.len() <= 1 => {
            let scenario: Value = serde_json::from_slice(&std::fs::read(scenario)?)?;
            let mut host = ModHost::open_in(
                store(root)?,
                validate_tool_schema,
                &std::env::current_dir()?,
            )?;
            let _thread = codex_omd::StateThread::enter(thread.first().cloned());
            host.offline_test(scenario)
        }
        [command, root, output] if command == "diagnostics" => {
            let bundle =
                ModHost::open_validated(store(root)?, validate_tool_schema)?.diagnostic_bundle();
            let output = PathBuf::from(output);
            std::fs::write(&output, serde_json::to_vec_pretty(&bundle)?)?;
            Ok(serde_json::json!({"bundle":output,"redacted":true}))
        }
        [command, denial] if command == "explain" => Ok(ModHost::capability_explanation(denial)),
        [command, root, id, runs, call @ ..] if command == "cost" && call.len() <= 2 => {
            let runs = runs
                .parse::<usize>()
                .ok()
                .filter(|runs| (1..=100).contains(runs))
                .ok_or_else(bad)?;
            let call = match call {
                [] => None,
                [name] => Some((name.as_str(), Value::String(String::new()))),
                [name, payload] => Some((name.as_str(), serde_json::from_str(payload)?)),
                _ => None,
            };
            ModHost::cost(
                store(root)?,
                validate_tool_schema,
                &std::env::current_dir()?,
                id,
                call,
                runs,
            )
        }
        [command, root, id, name, payload, thread @ ..]
            if command == "command" && thread.len() <= 1 =>
        {
            let mut host = ModHost::open_in(
                store(root)?,
                validate_tool_schema,
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
