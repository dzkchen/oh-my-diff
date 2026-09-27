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
pub const BUILTINS_SNAPSHOT: &str = "builtins.json";

#[derive(Clone, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HiddenCommands {
    #[serde(default)]
    pub hide: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DisabledModes {
    #[serde(default)]
    pub disable: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BuiltinControls {
    #[serde(default)]
    pub commands: HiddenCommands,
    #[serde(default)]
    pub modes: DisabledModes,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BuiltinSnapshot {
    pub schema: u32,
    pub hidden_commands: BTreeMap<String, Vec<String>>,
    pub disabled_modes: BTreeMap<String, Vec<String>>,
}

fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_'))
}

impl BuiltinControls {
    pub fn parse(value: &Value) -> Result<Self, String> {
        let controls: Self =
            serde_json::from_value(value.clone()).map_err(|error| format!("invalid_builtins: {error}"))?;
        let unique = |values: &[String]| values.iter().collect::<BTreeSet<_>>().len() == values.len();
        if controls.commands.hide.len() > 32
            || controls.modes.disable.len() > 8
            || !unique(&controls.commands.hide)
            || !unique(&controls.modes.disable)
            || controls.commands.hide.iter().any(|command| {
                !name(command) || PROTECTED_COMMANDS.contains(&command.as_str())
            })
            || controls
                .modes
                .disable
                .iter()
                .any(|mode| !name(mode) || PROTECTED_MODES.contains(&mode.as_str()))
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
        }
        snapshot
    }

    pub fn read(directory: &Path) -> Self {
        let path = directory.join(BUILTINS_SNAPSHOT);
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
}
