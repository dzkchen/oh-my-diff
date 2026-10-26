use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;

pub const PROTECTED_COMMANDS: &[&str] = &[
    "omd",
    "quit",
    "exit",
    "approvals",
    "permissions",
    "status",
    "logout",
];
pub const PROTECTED_MODES: &[&str] = &["default"];
pub const SURFACES: &[&str] = &["status_line"];

pub fn builtins_snapshot(repository: &Path) -> String {
    let repository = repository
        .canonicalize()
        .unwrap_or_else(|_| repository.to_path_buf());
    let digest = crate::broker::sha256(repository.to_string_lossy().as_bytes());
    format!("builtins-{}.json", &digest[..16])
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HiddenCommands {
    #[serde(default)]
    pub hide: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub replace: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Disabled {
    #[serde(default)]
    pub disable: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Removed {
    #[serde(default)]
    pub remove: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BuiltinControls {
    #[serde(default)]
    pub commands: HiddenCommands,
    #[serde(default)]
    pub modes: Disabled,
    #[serde(default)]
    pub surfaces: Disabled,
    #[serde(default, skip_serializing_if = "Removed::is_empty")]
    pub features: Removed,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub keys: BTreeMap<String, Option<String>>,
}

impl Removed {
    fn is_empty(&self) -> bool {
        self.remove.is_empty()
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BuiltinSnapshot {
    pub schema: u32,
    pub hidden_commands: BTreeMap<String, Vec<String>>,
    pub disabled_modes: BTreeMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub disabled_surfaces: BTreeMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub removed_features: BTreeMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub replaced_commands: BTreeMap<String, (String, String)>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub keys: BTreeMap<String, (String, Option<String>)>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<String>,
}

fn action(value: &str) -> bool {
    value.len() <= 64
        && value.split_once('.').is_some_and(|(context, name)| {
            context != "approval"
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
                && !name.is_empty()
                && context
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        })
}

fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
}

impl BuiltinControls {
    pub fn parse(value: &Value) -> Result<Self, String> {
        let controls: Self = serde_json::from_value(value.clone())
            .map_err(|error| format!("invalid_builtins: {error}"))?;
        let unique =
            |values: &[String]| values.iter().collect::<BTreeSet<_>>().len() == values.len();
        if controls.commands.replace.len() > 32
            || controls.keys.len() > 64
            || controls.commands.replace.iter().any(|(command, target)| {
                !name(command) || !name(target) || PROTECTED_COMMANDS.contains(&command.as_str())
            })
            || controls.keys.iter().any(|(action_name, key)| {
                !action(action_name)
                    || key
                        .as_ref()
                        .is_some_and(|key| key.is_empty() || key.len() > 16 || !key.is_ascii())
            })
        {
            return Err("invalid_builtins".into());
        }
        if controls.commands.hide.len() > 32
            || controls.modes.disable.len() > 8
            || !unique(&controls.commands.hide)
            || !unique(&controls.modes.disable)
            || controls
                .commands
                .hide
                .iter()
                .any(|command| !name(command) || PROTECTED_COMMANDS.contains(&command.as_str()))
            || controls
                .modes
                .disable
                .iter()
                .any(|mode| !name(mode) || PROTECTED_MODES.contains(&mode.as_str()))
            || !unique(&controls.surfaces.disable)
            || controls
                .surfaces
                .disable
                .iter()
                .any(|surface| !SURFACES.contains(&surface.as_str()))
            || controls.features.remove.len() > 32
            || !unique(&controls.features.remove)
            || controls
                .features
                .remove
                .iter()
                .any(|feature| !name(feature) || codex_features::feature_for_key(feature).is_none())
        {
            return Err("invalid_builtins".into());
        }
        Ok(controls)
    }
}

impl BuiltinSnapshot {
    pub fn from_controls(controls: &[(String, BuiltinControls)]) -> Self {
        let mut snapshot = Self {
            schema: 1,
            ..Self::default()
        };
        for (owner, controls) in controls {
            for command in &controls.commands.hide {
                snapshot
                    .hidden_commands
                    .entry(command.clone())
                    .or_default()
                    .push(owner.clone());
            }
            for mode in &controls.modes.disable {
                snapshot
                    .disabled_modes
                    .entry(mode.clone())
                    .or_default()
                    .push(owner.clone());
            }
            for surface in &controls.surfaces.disable {
                snapshot
                    .disabled_surfaces
                    .entry(surface.clone())
                    .or_default()
                    .push(owner.clone());
            }
            for feature in &controls.features.remove {
                snapshot
                    .removed_features
                    .entry(feature.clone())
                    .or_default()
                    .push(owner.clone());
            }
        }
        let mut contested = BTreeSet::new();
        for (owner, controls) in controls {
            for (command, target) in &controls.commands.replace {
                if snapshot
                    .replaced_commands
                    .insert(command.clone(), (owner.clone(), target.clone()))
                    .is_some()
                {
                    contested.insert(format!("commands.replace.{command}"));
                }
            }
            for (action, key) in &controls.keys {
                if snapshot
                    .keys
                    .insert(action.clone(), (owner.clone(), key.clone()))
                    .is_some()
                {
                    contested.insert(format!("keys.{action}"));
                }
            }
        }
        for conflict in &contested {
            if let Some(command) = conflict.strip_prefix("commands.replace.") {
                snapshot.replaced_commands.remove(command);
            }
            if let Some(action) = conflict.strip_prefix("keys.") {
                snapshot.keys.remove(action);
            }
        }
        snapshot.conflicts = contested.into_iter().collect();
        snapshot
    }

    pub fn command_replacement(&self, command: &str) -> Option<&(String, String)> {
        (!PROTECTED_COMMANDS.contains(&command))
            .then(|| self.replaced_commands.get(command))
            .flatten()
    }

    pub fn read(directory: &Path, repository: &Path) -> Self {
        let path = directory.join(builtins_snapshot(repository));
        std::fs::symlink_metadata(&path)
            .ok()
            .filter(|metadata| metadata.is_file() && metadata.len() <= 65_536)
            .and_then(|_| std::fs::read(&path).ok())
            .and_then(|bytes| serde_json::from_slice::<Self>(&bytes).ok())
            .filter(|snapshot| snapshot.schema == 1)
            .unwrap_or_default()
    }

    pub fn command_hidden(&self, command: &str) -> bool {
        !PROTECTED_COMMANDS.contains(&command) && self.hidden_commands.contains_key(command)
    }

    pub fn mode_disabled(&self, mode: &str) -> bool {
        !PROTECTED_MODES.contains(&mode) && self.disabled_modes.contains_key(mode)
    }

    pub fn surface_disabled(&self, surface: &str) -> bool {
        self.disabled_surfaces.contains_key(surface)
    }

    pub fn removed_features(&self) -> BTreeSet<codex_features::Feature> {
        self.removed_features
            .keys()
            .filter_map(|key| codex_features::feature_for_key(key))
            .collect()
    }
}

#[cfg(test)]
#[path = "builtins_tests.rs"]
mod tests;
