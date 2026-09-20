use super::*;

pub const MOD_KEY_LIMIT: usize = 12;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModView {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub foreground: Option<u8>,
    #[serde(default)]
    pub background: Option<u8>,
    #[serde(default)]
    pub sidebar_width: u16,
    #[serde(default)]
    pub sidebar_side: ModSidebarSide,
    #[serde(default)]
    pub panels: Vec<ModPanel>,
    #[serde(default)]
    pub header: Option<ModPanel>,
    #[serde(default)]
    pub footer: Option<ModPanel>,
    #[serde(default)]
    pub status: Vec<String>,
    #[serde(default)]
    pub keybindings: BTreeMap<String, ModKeyAction>,
    #[serde(default)]
    pub theme: ModTheme,
    #[serde(default)]
    pub message_template: Option<String>,
    #[serde(default)]
    pub tool_template: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModSidebarSide {
    Left,
    #[default]
    Right,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModPanel {
    pub title: String,
    pub lines: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(untagged)]
pub enum ModKeyAction {
    Draft(String),
    Insert { insert: String },
    Submit { submit: String },
    Command { command: String, args: String },
}

impl<'de> Deserialize<'de> for ModKeyAction {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let text = |value: &Value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| serde::de::Error::custom("keybinding text must be a string"))
        };
        let value = Value::deserialize(deserializer)?;
        if let Value::String(draft) = value {
            return Ok(Self::Draft(draft));
        }
        let object = value
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("invalid keybinding action"))?;
        let keys = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
        if keys == BTreeSet::from(["insert"]) {
            return Ok(Self::Insert {
                insert: text(&object["insert"])?,
            });
        }
        if keys == BTreeSet::from(["submit"]) {
            return Ok(Self::Submit {
                submit: text(&object["submit"])?,
            });
        }
        if keys == BTreeSet::from(["command"]) || keys == BTreeSet::from(["command", "args"]) {
            return Ok(Self::Command {
                command: text(&object["command"])?,
                args: object
                    .get("args")
                    .map(text)
                    .transpose()?
                    .unwrap_or_default(),
            });
        }
        Err(serde::de::Error::custom("invalid keybinding action"))
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModTheme {
    #[serde(default)]
    pub accent: Option<ModColor>,
    #[serde(default)]
    pub user_message_background: Option<ModColor>,
    #[serde(default)]
    pub syntax: Option<String>,
    #[serde(default)]
    pub success: Option<ModColor>,
    #[serde(default)]
    pub attention: Option<ModColor>,
    #[serde(default)]
    pub failure: Option<ModColor>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModColor {
    Indexed(u8),
    Rgb(u8, u8, u8),
}

impl Serialize for ModColor {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Self::Indexed(index) => serializer.serialize_u8(*index),
            Self::Rgb(red, green, blue) => {
                serializer.serialize_str(&format!("#{red:02x}{green:02x}{blue:02x}"))
            }
        }
    }
}

impl<'de> Deserialize<'de> for ModColor {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let invalid = || serde::de::Error::custom("color must be 0-255 or #rrggbb");
        match Value::deserialize(deserializer)? {
            Value::Number(number) => number
                .as_u64()
                .and_then(|index| u8::try_from(index).ok())
                .map(Self::Indexed)
                .ok_or_else(invalid),
            Value::String(text) => {
                let digits = text
                    .strip_prefix('#')
                    .filter(|digits| {
                        digits.len() == 6 && digits.bytes().all(|b| b.is_ascii_hexdigit())
                    })
                    .ok_or_else(invalid)?;
                let channel = |index: usize| {
                    u8::from_str_radix(&digits[index..index + 2], 16).map_err(|_| invalid())
                };
                Ok(Self::Rgb(channel(0)?, channel(2)?, channel(4)?))
            }
            _ => Err(invalid()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModActivity {
    pub sequence: u64,
    pub mod_id: String,
    pub tool: String,
    pub label: String,
    pub status: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModViewSnapshot {
    #[serde(default)]
    pub epoch: u64,
    #[serde(default)]
    pub view: ModView,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub progress: Option<ModPanel>,
    #[serde(default)]
    pub activity: Vec<ModActivity>,
    #[serde(default)]
    pub diagnostics: Vec<String>,
}

fn visible(text: &str, limit: usize) -> bool {
    text.len() <= limit && !text.chars().any(char::is_control)
}

fn multiline(text: &str, limit: usize) -> bool {
    text.len() <= limit
        && !text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
}

pub fn mod_key_name(key: &str) -> bool {
    let function = key
        .strip_prefix('F')
        .and_then(|number| number.parse::<u8>().ok())
        .is_some_and(|number| (2..=12).contains(&number) && key == format!("F{number}"));
    let letter = |rest: Option<&str>| {
        rest.is_some_and(|rest| rest.len() == 1 && rest.bytes().all(|b| b.is_ascii_lowercase()))
    };
    let reserved = [
        "Ctrl+c", "Ctrl+d", "Ctrl+z", "Ctrl+h", "Ctrl+i", "Ctrl+j", "Ctrl+m",
    ];
    !reserved.contains(&key)
        && (function || letter(key.strip_prefix("Ctrl+")) || letter(key.strip_prefix("Alt+")))
}

pub fn mod_command_reference(value: &str) -> bool {
    match value.split_once(':') {
        Some((id, name)) => identifier(id) && id.len() <= 24 && identifier(name),
        None => identifier(value),
    }
}

impl ModPanel {
    fn valid(&self, lines: usize) -> bool {
        visible(&self.title, 1024)
            && self.lines.len() <= lines
            && self.lines.iter().all(|line| visible(line, 1024))
    }
}

impl ModView {
    pub fn parse(value: Value) -> Result<Self> {
        let view: Self = serde_json::from_value(value)?;
        let action = |action: &ModKeyAction| match action {
            ModKeyAction::Draft(text)
            | ModKeyAction::Insert { insert: text }
            | ModKeyAction::Submit { submit: text } => !text.is_empty() && multiline(text, 4096),
            ModKeyAction::Command { command, args } => {
                mod_command_reference(command) && multiline(args, 4096)
            }
        };
        if view.sidebar_width > 60
            || view.panels.len() > 8
            || view.keybindings.len() > MOD_KEY_LIMIT
            || view.status.len() > 4
            || view.title.as_ref().is_some_and(|s| !visible(s, 1024))
            || [&view.message_template, &view.tool_template]
                .into_iter()
                .flatten()
                .any(|s| !visible(s, 1024) || s.matches("{text}").count() != 1)
            || view.panels.iter().any(|p| !p.valid(32))
            || [&view.header, &view.footer]
                .into_iter()
                .flatten()
                .any(|p| !p.valid(3))
            || view.status.iter().any(|s| s.is_empty() || !visible(s, 40))
            || view
                .theme
                .syntax
                .as_ref()
                .is_some_and(|s| s.is_empty() || !visible(s, 128))
            || view
                .keybindings
                .iter()
                .any(|(key, value)| !mod_key_name(key) || !action(value))
        {
            return Err(failure("invalid_terminal_view"));
        }
        if serde_json::to_vec(&view)?.len() > 16_384 {
            return Err(failure("terminal_view_limit"));
        }
        Ok(view)
    }

    pub fn read(path: &Path) -> Result<Self> {
        Ok(ModViewSnapshot::read(path)?.view)
    }
}

impl ModViewSnapshot {
    pub fn read(path: &Path) -> Result<Self> {
        let value: Value = serde_json::from_slice(&store::read(path, 65_536)?)?;
        let mut snapshot: Self = serde_json::from_value(value)?;
        snapshot.view = ModView::parse(serde_json::to_value(&snapshot.view)?)?;
        if snapshot.progress.as_ref().is_some_and(|p| !p.valid(8))
            || snapshot.activity.len() > 32
            || snapshot.diagnostics.len() > 16
            || snapshot
                .diagnostics
                .iter()
                .any(|diagnostic| !visible(diagnostic, 512))
            || snapshot.activity.iter().any(|activity| {
                !visible(&activity.label, 128)
                    || !visible(&activity.tool, 128)
                    || !visible(&activity.status, 32)
                    || !identifier(&activity.mod_id)
            })
        {
            return Err(failure("invalid_terminal_snapshot"));
        }
        Ok(snapshot)
    }
}
