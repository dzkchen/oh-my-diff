use super::*;

pub const MOD_KEY_LIMIT: usize = 12;
pub const MOD_COMPONENT_LIMIT: usize = 64;

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
    pub sites: BTreeMap<String, ModRenderSite>,
    #[serde(default)]
    pub status: Vec<String>,
    #[serde(default)]
    pub keybindings: BTreeMap<String, ModKeyAction>,
    #[serde(default)]
    pub theme: ModTheme,
    #[serde(default)]
    pub completed_tools: ModCompletedTools,
    #[serde(default)]
    pub message_template: Option<String>,
    #[serde(default)]
    pub tool_template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<ModSelectionPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModViewPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub foreground: Option<u8>,
    #[serde(default)]
    pub background: Option<u8>,
    #[serde(default)]
    pub sidebar_width: Option<u16>,
    #[serde(default)]
    pub sidebar_side: Option<ModSidebarSide>,
    #[serde(default)]
    pub sites: BTreeMap<String, ModRenderSite>,
    #[serde(default)]
    pub status: Vec<String>,
    #[serde(default)]
    pub keybindings: BTreeMap<String, ModKeyAction>,
    #[serde(default)]
    pub theme: ModThemePatch,
    #[serde(default)]
    pub completed_tools: Option<ModCompletedTools>,
    #[serde(default)]
    pub message_template: Option<String>,
    #[serde(default)]
    pub tool_template: Option<String>,
    #[serde(default)]
    pub selection: Option<ModSelectionPolicy>,
    #[serde(default)]
    pub placeholder: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ModSelectionSource {
    Transcript,
    Composer,
    Pager,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModSelectionPolicy {
    #[serde(default = "copy_on_release_default")]
    pub copy_on_release: bool,
    #[serde(default)]
    pub sources: Vec<ModSelectionSource>,
    #[serde(default = "min_chars_default")]
    pub min_chars: u32,
}

fn copy_on_release_default() -> bool {
    true
}

fn min_chars_default() -> u32 {
    1
}

impl ModSelectionPolicy {
    fn valid(&self) -> bool {
        (1..=10_000).contains(&self.min_chars)
            && self.sources.len() <= 3
            && self.sources.iter().collect::<BTreeSet<_>>().len() == self.sources.len()
    }

    pub fn copies(&self, source: ModSelectionSource, chars: usize) -> bool {
        self.copy_on_release
            && (self.sources.is_empty() || self.sources.contains(&source))
            && chars >= self.min_chars as usize
    }
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

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModSiteMode {
    #[default]
    Replace,
    Wrap,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModRenderSite {
    #[serde(default)]
    pub mode: ModSiteMode,
    #[serde(default)]
    pub components: Vec<ModComponent>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ModComponent {
    Box {
        id: String,
        label: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        children: Vec<ModComponent>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min_width: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_width: Option<u16>,
    },
    Line {
        id: String,
        label: String,
        spans: Vec<ModSpan>,
    },
    Text {
        id: String,
        label: String,
        text: String,
        #[serde(default)]
        tone: ModTone,
    },
    Button {
        id: String,
        label: String,
        text: String,
        action: ModComponentAction,
    },
    Input {
        id: String,
        label: String,
        #[serde(default)]
        value: String,
        #[serde(default)]
        placeholder: String,
        action: ModCommandAction,
    },
    Select {
        id: String,
        label: String,
        value: String,
        options: Vec<ModSelectOption>,
        action: ModCommandAction,
    },
    Markdown {
        id: String,
        label: String,
        text: String,
    },
    Code {
        id: String,
        label: String,
        text: String,
        #[serde(default)]
        language: Option<String>,
    },
    Pane {
        id: String,
        label: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        collapsed: bool,
        #[serde(default)]
        scroll: u16,
        #[serde(default)]
        children: Vec<ModComponent>,
    },
    Dialog {
        id: String,
        label: String,
        title: String,
        #[serde(default)]
        children: Vec<ModComponent>,
    },
    List {
        id: String,
        label: String,
        rows: Vec<ModListRow>,
        #[serde(default)]
        selected: Option<String>,
        #[serde(default)]
        height: Option<u16>,
        action: ModCommandAction,
    },
    Slot,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModListRow {
    pub value: String,
    pub label: String,
    #[serde(default)]
    pub spans: Vec<ModSpan>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModSpan {
    pub text: String,
    #[serde(default)]
    pub tone: ModTone,
    #[serde(default)]
    pub bold: bool,
}

impl ModComponent {
    pub fn fits(&self, width: u16) -> bool {
        match self {
            Self::Box {
                min_width,
                max_width,
                ..
            } => {
                min_width.is_none_or(|min| width >= min) && max_width.is_none_or(|max| width <= max)
            }
            _ => true,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModSelectOption {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum ModComponentAction {
    Command(ModCommandAction),
    Copy { copy: String, label: String },
    Insert { insert: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModCommandAction {
    pub command: String,
    #[serde(default)]
    pub args: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModTone {
    #[default]
    Normal,
    Accent,
    Success,
    Attention,
    Failure,
    Muted,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModCompletedTools {
    #[default]
    Normal,
    Compact,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(untagged)]
pub enum ModKeyAction {
    Draft(String),
    Insert { insert: String },
    Submit { submit: String },
    Command { command: String, args: String },
    Focus { focus: String },
    Copy { copy: String, label: String },
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
        if keys == BTreeSet::from(["command"]) || keys == BTreeSet::from(["args", "command"]) {
            return Ok(Self::Command {
                command: text(&object["command"])?,
                args: object
                    .get("args")
                    .map(text)
                    .transpose()?
                    .unwrap_or_default(),
            });
        }
        if keys == BTreeSet::from(["focus"]) {
            return Ok(Self::Focus {
                focus: text(&object["focus"])?,
            });
        }
        if keys == BTreeSet::from(["copy", "label"]) {
            return Ok(Self::Copy {
                copy: text(&object["copy"])?,
                label: text(&object["label"])?,
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
    #[serde(default)]
    pub diff_added: Option<ModColor>,
    #[serde(default)]
    pub diff_removed: Option<ModColor>,
    #[serde(default)]
    pub muted: Option<ModColor>,
    #[serde(default)]
    pub border: ModBorder,
    #[serde(default)]
    pub density: ModDensity,
    #[serde(default)]
    pub icons: ModIcons,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub glyphs: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModThemePatch {
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
    #[serde(default)]
    pub diff_added: Option<ModColor>,
    #[serde(default)]
    pub diff_removed: Option<ModColor>,
    #[serde(default)]
    pub muted: Option<ModColor>,
    #[serde(default)]
    pub border: Option<ModBorder>,
    #[serde(default)]
    pub density: Option<ModDensity>,
    #[serde(default)]
    pub icons: Option<ModIcons>,
    #[serde(default)]
    pub glyphs: BTreeMap<String, String>,
}

pub const MOD_GLYPH_LIMIT: usize = 16;

pub fn valid_glyphs(glyphs: &BTreeMap<String, String>) -> bool {
    glyphs.len() <= MOD_GLYPH_LIMIT
        && glyphs.iter().all(|(source, display)| {
            (2..=4).contains(&source.len())
                && source.bytes().all(|byte| byte.is_ascii_graphic())
                && display.chars().count() == source.chars().count()
                && !display.chars().any(char::is_control)
        })
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModBorder {
    #[default]
    Plain,
    Rounded,
    Double,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModDensity {
    Compact,
    #[default]
    Comfortable,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModIcons {
    #[default]
    Unicode,
    Ascii,
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
    pub revision: u64,
    #[serde(default)]
    pub view: ModView,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub contributors: Vec<String>,
    #[serde(default)]
    pub input: Value,
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

fn component_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 48
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
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

impl ModCommandAction {
    fn valid(&self) -> bool {
        mod_command_reference(&self.command) && multiline(&self.args, 4096)
    }
}

impl ModComponentAction {
    fn valid(&self) -> bool {
        match self {
            Self::Command(action) => action.valid(),
            Self::Copy { copy, label } => {
                !copy.is_empty()
                    && multiline(copy, 4096)
                    && !label.is_empty()
                    && visible(label, 128)
            }
            Self::Insert { insert } => !insert.is_empty() && multiline(insert, 4096),
        }
    }
}

impl ModComponent {
    fn validate(
        &self,
        depth: usize,
        count: &mut usize,
        ids: &mut BTreeSet<String>,
        slots: &mut usize,
    ) -> bool {
        if depth > 6 {
            return false;
        }
        *count += 1;
        if *count > MOD_COMPONENT_LIMIT {
            return false;
        }
        let identified = |id: &str, label: &str, ids: &mut BTreeSet<String>| {
            component_id(id)
                && !label.is_empty()
                && visible(label, 128)
                && ids.insert(id.to_owned())
        };
        let children = |children: &[Self],
                        count: &mut usize,
                        ids: &mut BTreeSet<String>,
                        slots: &mut usize| {
            children
                .iter()
                .all(|child| child.validate(depth + 1, count, ids, slots))
        };
        match self {
            Self::Box {
                id,
                label,
                title,
                children: nested,
                min_width,
                max_width,
            } => {
                let bound =
                    |width: &Option<u16>| width.is_none_or(|width| (1..=500).contains(&width));
                identified(id, label, ids)
                    && title.as_ref().is_none_or(|title| visible(title, 128))
                    && bound(min_width)
                    && bound(max_width)
                    && min_width
                        .zip(*max_width)
                        .is_none_or(|(min, max)| min <= max)
                    && children(nested, count, ids, slots)
            }
            Self::Line { id, label, spans } => {
                identified(id, label, ids)
                    && !spans.is_empty()
                    && spans.len() <= 12
                    && spans.iter().all(|span| visible(&span.text, 1024))
                    && spans
                        .iter()
                        .map(|span| span.text.chars().count())
                        .sum::<usize>()
                        <= 256
            }
            Self::Pane {
                id,
                label,
                title,
                children: nested,
                ..
            } => {
                identified(id, label, ids)
                    && title.as_ref().is_none_or(|title| visible(title, 128))
                    && children(nested, count, ids, slots)
            }
            Self::Dialog {
                id,
                label,
                title,
                children: nested,
            } => {
                identified(id, label, ids)
                    && !title.is_empty()
                    && visible(title, 128)
                    && children(nested, count, ids, slots)
            }
            Self::Text {
                id, label, text, ..
            }
            | Self::Markdown { id, label, text }
            | Self::Code {
                id, label, text, ..
            } => identified(id, label, ids) && multiline(text, 4096),
            Self::Button {
                id,
                label,
                text,
                action,
            } => {
                identified(id, label, ids)
                    && !text.is_empty()
                    && visible(text, 256)
                    && action.valid()
            }
            Self::Input {
                id,
                label,
                value,
                placeholder,
                action,
            } => {
                identified(id, label, ids)
                    && multiline(value, 1024)
                    && visible(placeholder, 256)
                    && action.valid()
            }
            Self::Select {
                id,
                label,
                value,
                options,
                action,
            } => {
                let values = options
                    .iter()
                    .map(|option| option.value.as_str())
                    .collect::<BTreeSet<_>>();
                identified(id, label, ids)
                    && (1..=16).contains(&options.len())
                    && values.len() == options.len()
                    && options.iter().any(|option| option.value == *value)
                    && options.iter().all(|option| {
                        !option.value.is_empty()
                            && visible(&option.value, 128)
                            && !option.label.is_empty()
                            && visible(&option.label, 128)
                    })
                    && action.valid()
            }
            Self::List {
                id,
                label,
                rows,
                selected,
                height,
                action,
            } => {
                let values = rows
                    .iter()
                    .map(|row| row.value.as_str())
                    .collect::<BTreeSet<_>>();
                identified(id, label, ids)
                    && rows.len() <= 200
                    && values.len() == rows.len()
                    && selected
                        .as_ref()
                        .is_none_or(|value| values.contains(value.as_str()))
                    && height.is_none_or(|height| (1..=40).contains(&height))
                    && rows.iter().all(|row| {
                        !row.value.is_empty()
                            && visible(&row.value, 256)
                            && !row.label.is_empty()
                            && visible(&row.label, 256)
                            && row.spans.len() <= 12
                            && row.spans.iter().all(|span| visible(&span.text, 256))
                            && row
                                .spans
                                .iter()
                                .map(|span| span.text.chars().count())
                                .sum::<usize>()
                                <= 256
                    })
                    && action.valid()
            }
            Self::Slot => {
                *slots += 1;
                *slots <= 1
            }
        }
    }
}

impl ModRenderSite {
    fn valid(&self, patch: bool, ids: &mut BTreeSet<String>) -> bool {
        let mut count = 0;
        let mut slots = 0;
        let valid = self
            .components
            .iter()
            .all(|component| component.validate(1, &mut count, ids, &mut slots));
        valid
            && if patch && self.mode == ModSiteMode::Wrap {
                slots == 1
            } else {
                slots == 0
            }
    }
}

fn valid_site(name: &str) -> bool {
    ["sidebar", "header", "above_composer", "dialog"].contains(&name)
}

fn valid_action(action: &ModKeyAction) -> bool {
    match action {
        ModKeyAction::Draft(text)
        | ModKeyAction::Insert { insert: text }
        | ModKeyAction::Submit { submit: text } => !text.is_empty() && multiline(text, 4096),
        ModKeyAction::Command { command, args } => {
            mod_command_reference(command) && multiline(args, 4096)
        }
        ModKeyAction::Focus { focus } => component_id(focus),
        ModKeyAction::Copy { copy, label } => {
            !copy.is_empty() && multiline(copy, 4096) && !label.is_empty() && visible(label, 128)
        }
    }
}

fn valid_templates(message: &Option<String>, tool: &Option<String>) -> bool {
    [message, tool]
        .into_iter()
        .flatten()
        .all(|template| visible(template, 1024) && template.matches("{text}").count() == 1)
}

fn valid_bindings(bindings: &BTreeMap<String, ModKeyAction>) -> bool {
    bindings.len() <= MOD_KEY_LIMIT
        && bindings
            .iter()
            .all(|(key, action)| mod_key_name(key) && valid_action(action))
}

fn valid_status(status: &[String]) -> bool {
    status.len() <= 4
        && status
            .iter()
            .all(|segment| !segment.is_empty() && visible(segment, 40))
}

fn valid_sites(sites: &BTreeMap<String, ModRenderSite>, patch: bool) -> bool {
    let mut ids = BTreeSet::new();
    sites.len() <= 4
        && sites
            .iter()
            .all(|(name, site)| valid_site(name) && site.valid(patch, &mut ids))
}

fn component_ids(component: &ModComponent, ids: &mut BTreeSet<String>) {
    match component {
        ModComponent::Box { id, children, .. }
        | ModComponent::Pane { id, children, .. }
        | ModComponent::Dialog { id, children, .. } => {
            ids.insert(id.clone());
            for child in children {
                component_ids(child, ids);
            }
        }
        ModComponent::Text { id, .. }
        | ModComponent::Line { id, .. }
        | ModComponent::Button { id, .. }
        | ModComponent::Input { id, .. }
        | ModComponent::Select { id, .. }
        | ModComponent::Markdown { id, .. }
        | ModComponent::Code { id, .. }
        | ModComponent::List { id, .. } => {
            ids.insert(id.clone());
        }
        ModComponent::Slot => {}
    }
}

fn valid_focus_targets(
    bindings: &BTreeMap<String, ModKeyAction>,
    sites: &BTreeMap<String, ModRenderSite>,
) -> bool {
    let mut ids = BTreeSet::new();
    for site in sites.values() {
        for component in &site.components {
            component_ids(component, &mut ids);
        }
    }
    bindings.values().all(|action| match action {
        ModKeyAction::Focus { focus } => ids.contains(focus),
        _ => true,
    })
}

fn replace_slot(components: Vec<ModComponent>, current: &[ModComponent]) -> Vec<ModComponent> {
    components
        .into_iter()
        .flat_map(|component| match component {
            ModComponent::Slot => current.to_vec(),
            ModComponent::Box {
                id,
                label,
                title,
                children,
                min_width,
                max_width,
            } => vec![ModComponent::Box {
                id,
                label,
                title,
                children: replace_slot(children, current),
                min_width,
                max_width,
            }],
            ModComponent::Pane {
                id,
                label,
                title,
                collapsed,
                scroll,
                children,
            } => vec![ModComponent::Pane {
                id,
                label,
                title,
                collapsed,
                scroll,
                children: replace_slot(children, current),
            }],
            ModComponent::Dialog {
                id,
                label,
                title,
                children,
            } => vec![ModComponent::Dialog {
                id,
                label,
                title,
                children: replace_slot(children, current),
            }],
            component => vec![component],
        })
        .collect()
}

impl ModThemePatch {
    fn apply(self, target: &mut ModTheme) {
        macro_rules! assign {
            ($field:ident) => {
                if self.$field.is_some() {
                    target.$field = self.$field;
                }
            };
        }
        assign!(accent);
        assign!(user_message_background);
        assign!(syntax);
        assign!(success);
        assign!(attention);
        assign!(failure);
        assign!(diff_added);
        assign!(diff_removed);
        assign!(muted);
        if let Some(border) = self.border {
            target.border = border;
        }
        if let Some(density) = self.density {
            target.density = density;
        }
        if let Some(icons) = self.icons {
            target.icons = icons;
        }
        target.glyphs.extend(self.glyphs);
    }
}

impl ModViewPatch {
    pub fn parse(value: Value) -> Result<Self> {
        let patch: Self = serde_json::from_value(value)?;
        if patch.sidebar_width.is_some_and(|width| width > 60)
            || patch
                .title
                .as_ref()
                .is_some_and(|title| !visible(title, 1024))
            || !valid_sites(&patch.sites, true)
            || !valid_status(&patch.status)
            || !valid_bindings(&patch.keybindings)
            || !valid_templates(&patch.message_template, &patch.tool_template)
            || patch
                .theme
                .syntax
                .as_ref()
                .is_some_and(|syntax| syntax.is_empty() || !visible(syntax, 128))
            || patch
                .selection
                .as_ref()
                .is_some_and(|policy| !policy.valid())
            || patch
                .placeholder
                .as_ref()
                .is_some_and(|placeholder| placeholder.is_empty() || !visible(placeholder, 80))
            || !valid_glyphs(&patch.theme.glyphs)
            || serde_json::to_vec(&patch)?.len() > 16_384
        {
            return Err(failure("invalid_terminal_patch"));
        }
        Ok(patch)
    }

    pub fn apply(
        self,
        target: &mut ModView,
        replaced_sites: &mut BTreeSet<String>,
        completed_tools_owner: &mut bool,
    ) -> Result<()> {
        let mut candidate = target.clone();
        let mut candidate_sites = replaced_sites.clone();
        let mut candidate_completed_tools = *completed_tools_owner;
        self.apply_to(
            &mut candidate,
            &mut candidate_sites,
            &mut candidate_completed_tools,
        )?;
        *target = candidate;
        *replaced_sites = candidate_sites;
        *completed_tools_owner = candidate_completed_tools;
        Ok(())
    }

    fn apply_to(
        self,
        target: &mut ModView,
        replaced_sites: &mut BTreeSet<String>,
        completed_tools_owner: &mut bool,
    ) -> Result<()> {
        if let Some(title) = self.title {
            target.title = Some(title);
        }
        if let Some(foreground) = self.foreground {
            target.foreground = Some(foreground);
        }
        if let Some(background) = self.background {
            target.background = Some(background);
        }
        if let Some(width) = self.sidebar_width {
            target.sidebar_width = width;
        }
        if let Some(side) = self.sidebar_side {
            target.sidebar_side = side;
        }
        for (name, site) in self.sites {
            match site.mode {
                ModSiteMode::Replace => {
                    if !replaced_sites.insert(name.clone()) {
                        return Err(failure(format!("terminal_site_conflict: {name}")));
                    }
                    target.sites.insert(name, site);
                }
                ModSiteMode::Wrap => {
                    let current = target
                        .sites
                        .get(&name)
                        .map(|site| site.components.as_slice())
                        .unwrap_or_default();
                    target.sites.insert(
                        name,
                        ModRenderSite {
                            mode: ModSiteMode::Replace,
                            components: replace_slot(site.components, current),
                        },
                    );
                }
            }
        }
        for (key, action) in self.keybindings {
            if target.keybindings.insert(key.clone(), action).is_some() {
                return Err(failure(format!("terminal_key_conflict: {key}")));
            }
        }
        target.status.extend(self.status);
        if target.status.len() > 4 {
            return Err(failure("terminal_status_limit"));
        }
        if self
            .theme
            .glyphs
            .keys()
            .any(|glyph| target.theme.glyphs.contains_key(glyph))
        {
            return Err(failure("terminal_glyph_conflict"));
        }
        self.theme.apply(&mut target.theme);
        if let Some(mode) = self.completed_tools {
            if *completed_tools_owner {
                return Err(failure("terminal_completed_tools_conflict"));
            }
            *completed_tools_owner = true;
            target.completed_tools = mode;
        }
        if let Some(selection) = self.selection {
            if target.selection.is_some() {
                return Err(failure("terminal_selection_conflict"));
            }
            target.selection = Some(selection);
        }
        if let Some(placeholder) = self.placeholder {
            if target.placeholder.is_some() {
                return Err(failure("terminal_placeholder_conflict"));
            }
            target.placeholder = Some(placeholder);
        }

        if let Some(template) = self.message_template {
            target.message_template = Some(match target.message_template.take() {
                Some(current) => template.replace("{text}", &current),
                None => template,
            });
        }
        if let Some(template) = self.tool_template {
            target.tool_template = Some(match target.tool_template.take() {
                Some(current) => template.replace("{text}", &current),
                None => template,
            });
        }
        ModView::parse(serde_json::to_value(target.clone())?)?;
        Ok(())
    }
}

impl ModView {
    pub fn parse(value: Value) -> Result<Self> {
        let view: Self = serde_json::from_value(value)?;
        if view.sidebar_width > 60
            || view.panels.len() > 8
            || view
                .title
                .as_ref()
                .is_some_and(|title| !visible(title, 1024))
            || !valid_templates(&view.message_template, &view.tool_template)
            || view.panels.iter().any(|panel| !panel.valid(32))
            || [&view.header, &view.footer]
                .into_iter()
                .flatten()
                .any(|panel| !panel.valid(3))
            || !valid_sites(&view.sites, false)
            || !valid_status(&view.status)
            || !valid_bindings(&view.keybindings)
            || !valid_focus_targets(&view.keybindings, &view.sites)
            || view
                .theme
                .syntax
                .as_ref()
                .is_some_and(|syntax| syntax.is_empty() || !visible(syntax, 128))
            || view
                .selection
                .as_ref()
                .is_some_and(|policy| !policy.valid())
            || view
                .placeholder
                .as_ref()
                .is_some_and(|placeholder| placeholder.is_empty() || !visible(placeholder, 80))
            || !valid_glyphs(&view.theme.glyphs)
            || serde_json::to_vec(&view)?.len() > 16_384
        {
            return Err(failure("invalid_terminal_view"));
        }
        Ok(view)
    }

    pub fn read(path: &Path) -> Result<Self> {
        Ok(ModViewSnapshot::read(path)?.view)
    }
}

impl ModViewSnapshot {
    pub fn read(path: &Path) -> Result<Self> {
        let value: Value = serde_json::from_slice(&store::read(path, 131_072)?)?;
        let mut snapshot: Self = serde_json::from_value(value)?;
        snapshot.view = ModView::parse(serde_json::to_value(&snapshot.view)?)?;
        if snapshot
            .progress
            .as_ref()
            .is_some_and(|panel| !panel.valid(8))
            || snapshot.activity.len() > 32
            || snapshot.contributors.len() > 16
            || snapshot
                .contributors
                .iter()
                .any(|contributor| !identifier(contributor))
            || serde_json::to_vec(&snapshot.input)?.len() > 65_536
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
