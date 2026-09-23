use crate::slash_command::SlashCommand;
use codex_omd::ModCommandOutcome;
use codex_omd::ModHost;
use codex_omd::ModStore;
use codex_omd::ModViewSnapshot;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::str::FromStr;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

const CATALOG_TTL: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ModSlashTarget {
    Mod { id: String, command: String },
    PiPrompt { name: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ModSlashCommand {
    pub(crate) invocation: String,
    pub(crate) description: String,
    pub(crate) target: ModSlashTarget,
}

#[derive(Debug)]
pub(crate) struct ModCommandResult {
    pub(crate) outcome: ModCommandOutcome,
    pub(crate) preview: Option<ModViewSnapshot>,
}

pub(crate) struct Entry {
    namespaced: String,
    bare: String,
    description: String,
    target: ModSlashTarget,
}

static CATALOG: Mutex<Option<(Instant, Vec<ModSlashCommand>)>> = Mutex::new(None);
static HOST: Mutex<Option<ModHost>> = Mutex::new(None);

fn builtin(name: &str) -> bool {
    SlashCommand::from_str(name).is_ok()
}

fn prompt_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

fn protected(path: &Path, roots: &[std::path::PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

fn entries() -> Vec<Entry> {
    let Some(paths) = crate::omd::mod_paths() else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    if paths.store.is_some()
        && let Some(status) = crate::omd::mod_status()
    {
        for item in status["mods"].as_array().into_iter().flatten() {
            let Some(id) = item["id"].as_str() else {
                continue;
            };
            if !item["error"].is_null()
                || !item["capabilities"]
                    .as_array()
                    .is_some_and(|c| c.iter().any(|c| c == "commands"))
            {
                continue;
            }
            for command in item["registrations"]["commands"]
                .as_array()
                .into_iter()
                .flatten()
            {
                let Some(name) = command["name"].as_str() else {
                    continue;
                };
                let description = command["description"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("{id} mod command"));
                entries.push(Entry {
                    namespaced: format!("{id}:{name}"),
                    bare: name.to_owned(),
                    description,
                    target: ModSlashTarget::Mod {
                        id: id.to_owned(),
                        command: name.to_owned(),
                    },
                });
            }
        }
    }
    if let Some(user) = &paths.pi_user
        && let Ok((prompts, _)) = ModStore::pi_prompts(user, &paths.repository)
    {
        for prompt in prompts {
            if !prompt_name(&prompt.name) || protected(&prompt.path, &paths.protected) {
                continue;
            }
            let description = match &prompt.argument_hint {
                Some(hint) => format!("{} {hint} (Pi prompt)", prompt.description),
                None => format!("{} (Pi prompt)", prompt.description),
            };
            entries.push(Entry {
                namespaced: format!("pi:{}", prompt.name),
                bare: prompt.name.clone(),
                description,
                target: ModSlashTarget::PiPrompt { name: prompt.name },
            });
        }
    }
    entries
}

pub(crate) fn build(entries: Vec<Entry>) -> Vec<ModSlashCommand> {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for entry in &entries {
        *counts.entry(entry.bare.as_str()).or_default() += 1;
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut commands = Vec::new();
    for entry in &entries {
        if !seen.insert(entry.namespaced.clone()) {
            continue;
        }
        let conflict = if builtin(&entry.bare) {
            Some(format!("conflicts with built-in /{}", entry.bare))
        } else if counts[entry.bare.as_str()] > 1 {
            Some("defined by more than one mod or prompt".to_owned())
        } else {
            None
        };
        let description = match &conflict {
            Some(reason) => format!(
                "{} · bare /{} unavailable: {reason}",
                entry.description, entry.bare
            ),
            None => entry.description.clone(),
        };
        commands.push(ModSlashCommand {
            invocation: entry.namespaced.clone(),
            description: description.clone(),
            target: entry.target.clone(),
        });
        if conflict.is_none() && seen.insert(entry.bare.clone()) {
            commands.push(ModSlashCommand {
                invocation: entry.bare.clone(),
                description: format!("{} (/{})", entry.description, entry.namespaced),
                target: entry.target.clone(),
            });
        }
    }
    commands
}

pub(crate) fn slash_commands() -> Vec<ModSlashCommand> {
    let mut cache = CATALOG
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((loaded, commands)) = cache.as_ref()
        && loaded.elapsed() < CATALOG_TTL
    {
        return commands.clone();
    }
    let commands = build(entries());
    *cache = Some((Instant::now(), commands.clone()));
    commands
}

pub(crate) fn find(invocation: &str) -> Option<ModSlashCommand> {
    slash_commands()
        .into_iter()
        .find(|command| command.invocation == invocation)
}

pub(crate) fn run(target: &ModSlashTarget, args: &str) -> Result<ModCommandResult, String> {
    let paths = crate::omd::mod_paths().ok_or("mods are not configured for this session")?;
    match target {
        ModSlashTarget::Mod { id, command } => {
            let store = paths.store.ok_or("mod store is not configured")?;
            let mut host = HOST
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match host.as_mut() {
                Some(runtime) => {
                    runtime.reload().map_err(|e| e.to_string())?;
                }
                None => *host = Some(ModHost::open(store).map_err(|e| e.to_string())?),
            }
            let runtime = host.as_mut().ok_or("mod runtime unavailable")?;
            let generation = runtime.generation();
            let value = runtime
                .invoke(
                    id,
                    generation,
                    "command",
                    command,
                    Value::String(args.to_owned()),
                )
                .map_err(|e| e.to_string())?;
            let outcome = ModCommandOutcome::parse(&value).map_err(|e| e.to_string())?;
            let preview = match ModViewSnapshot::read(&paths.evidence.join("mod-view.json")) {
                Ok(mut snapshot) => {
                    let terminal = runtime.terminal_view(snapshot.input.clone(), || true);
                    snapshot.revision = snapshot.revision.saturating_add(1);
                    snapshot.view = terminal.view;
                    snapshot.owner = terminal.owner;
                    snapshot.contributors = terminal.contributors;
                    snapshot.diagnostics.extend(terminal.diagnostics);
                    snapshot.diagnostics.truncate(16);
                    Some(snapshot)
                }
                Err(_) => None,
            };
            Ok(ModCommandResult { outcome, preview })
        }
        ModSlashTarget::PiPrompt { name } => {
            let user = paths
                .pi_user
                .ok_or("Pi resource directory is not approved")?;
            let expanded = ModStore::expand_pi_prompt(&user, &paths.repository, name, args)
                .map_err(|e| e.to_string())?;
            if expanded["path"]
                .as_str()
                .is_none_or(|path| protected(Path::new(path), &paths.protected))
            {
                return Err("pi_protected_resource".into());
            }
            let text = expanded["text"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .ok_or("Pi prompt expanded to empty text")?;
            let outcome = ModCommandOutcome::parse(&serde_json::json!({ "submit": text }))
                .map_err(|e| e.to_string())?;
            Ok(ModCommandResult {
                outcome,
                preview: None,
            })
        }
    }
}

#[cfg(test)]
pub(crate) fn test_entry(
    namespaced: &str,
    bare: &str,
    description: &str,
    target: ModSlashTarget,
) -> Entry {
    Entry {
        namespaced: namespaced.to_owned(),
        bare: bare.to_owned(),
        description: description.to_owned(),
        target,
    }
}

#[cfg(test)]
#[path = "mod_runtime_tests.rs"]
mod tests;
