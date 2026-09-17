use codex_omd::ModHost;
use codex_omd::ModStore;
use serde_json::Value;
use std::io;
use std::path::PathBuf;

fn run(args: &[String]) -> io::Result<Value> {
    let bad = || {
        io::Error::other(
            "usage: omd-mod init STORE NODE | inspect PACKAGE | trust STORE PACKAGE SHA256 CAPABILITIES_CSV | enable/disable STORE PACKAGE | status/reload STORE | command STORE MOD NAME JSON",
        )
    };
    match args {
        [command, root, node] if command == "init" => {
            ModStore::create(PathBuf::from(root), PathBuf::from(node))?;
            Ok(Value::String("created".into()))
        }
        [command, path] if command == "inspect" => {
            ModStore::inspect_package(&PathBuf::from(path).canonicalize()?)
        }
        [command, root, path, sha, capabilities] if command == "trust" => {
            ModStore::open(PathBuf::from(root).canonicalize()?)?.trust(
                PathBuf::from(path).canonicalize()?,
                sha,
                capabilities
                    .split(',')
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect(),
            )?;
            Ok(Value::String(
                "trusted; disabled until explicitly enabled".into(),
            ))
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
