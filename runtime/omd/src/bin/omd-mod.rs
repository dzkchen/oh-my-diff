use codex_omd::ModHost;
use codex_omd::ModStore;
use serde_json::Value;
use std::io;
use std::path::PathBuf;

fn run(args: &[String]) -> io::Result<Value> {
    let bad = || {
        io::Error::other(
            "usage: omd-mod init STORE NODE | inspect PACKAGE | trust STORE PACKAGE SHA256 CAPABILITIES_CSV [user|project] | enable/disable STORE PACKAGE | status/reload/report/events/declarations STORE | test STORE SCENARIO_JSON | diagnostics STORE OUTPUT_JSON | explain DENIAL | discover USER_DIR PROJECT_DIR | pi-discover USER_AGENT_DIR PROJECT_ROOT | settings STORE PACKAGE JSON | migrate STORE PACKAGE | rollback STORE PACKAGE BACKUP | command STORE MOD NAME JSON",
        )
    };
    match args {
        [command, user, project] if command == "pi-discover" => {
            ModStore::discover_pi(&PathBuf::from(user), &PathBuf::from(project))
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
        [command, root, path, sha, capabilities] | [command, root, path, sha, capabilities, _]
            if command == "trust" =>
        {
            let scope = match args {
                [.., scope] if args.len() == 6 => scope.as_str(),
                _ => "user",
            };
            ModStore::open(PathBuf::from(root).canonicalize()?)?.trust(
                PathBuf::from(path).canonicalize()?,
                sha,
                capabilities
                    .split(',')
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect(),
                scope,
            )?;
            Ok(Value::String(format!(
                "trusted in the {scope} scope; disabled until explicitly enabled"
            )))
        }
        [command, root, path] if command == "enable" || command == "disable" => {
            ModStore::open(PathBuf::from(root).canonicalize()?)?
                .enable(&PathBuf::from(path), command == "enable")?;
            Ok(Value::String(
                "selection saved; takes effect at the next turn boundary".into(),
            ))
        }
        [command, root] if command == "reload" => {
            ModStore::open(PathBuf::from(root).canonicalize()?)?.reload()?;
            Ok(Value::String(
                "reload queued for the next turn boundary".into(),
            ))
        }
        [command, root] if command == "status" => {
            Ok(ModHost::open(PathBuf::from(root).canonicalize()?)?.status())
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
        [command, root, scenario] if command == "test" => {
            let scenario: Value = serde_json::from_slice(&std::fs::read(scenario)?)?;
            ModHost::open(PathBuf::from(root).canonicalize()?)?.offline_test(scenario)
        }
        [command, root, output] if command == "diagnostics" => {
            let bundle = ModHost::open(PathBuf::from(root).canonicalize()?)?.diagnostic_bundle();
            let output = PathBuf::from(output);
            std::fs::write(&output, serde_json::to_vec_pretty(&bundle)?)?;
            Ok(serde_json::json!({"bundle":output,"redacted":true}))
        }
        [command, denial] if command == "explain" => Ok(ModHost::capability_explanation(denial)),
        [command, root, id, name, payload] if command == "command" => {
            let mut host = ModHost::open(PathBuf::from(root).canonicalize()?)?;
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
