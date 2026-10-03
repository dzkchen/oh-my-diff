use super::*;

pub const MOD_KEY_LIMIT: usize = 12;
pub const MOD_COMPOSED_KEY_LIMIT: usize = 64;
pub const MOD_COMPONENT_LIMIT: usize = 64;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModWelcome {
    #[serde(default)]
    pub show_while_composing: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModView {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub welcome: Option<ModWelcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_title_suffix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub greeting: Option<String>,
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
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<ModLayout>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backdrop: Option<ModBackdrop>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub surface_styles: BTreeMap<String, ModSurfacePaint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_sites: Option<ModInlineSites>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModViewPatch {
    #[serde(default)]
    pub welcome: Option<ModWelcome>,
    #[serde(default)]
    pub session_title_suffix: Option<String>,
    #[serde(default)]
    pub greeting: Option<String>,
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
    pub placeholder: Option<String>,
    #[serde(default)]
    pub layout: Option<ModLayout>,
    #[serde(default)]
    pub backdrop: Option<ModBackdrop>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub surface_styles: BTreeMap<String, ModSurfacePaint>,
    #[serde(default)]
    pub inline_sites: Option<ModInlineSites>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModInlineSites {
    Hidden,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModSplit {
    Horizontal,
    Vertical,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModLayoutLeaf {
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModLayoutSplit {
    pub split: ModSplit,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ratio: Vec<u16>,
    pub children: Vec<ModLayout>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModTab {
    pub title: String,
    pub node: ModLayout,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModLayoutTabs {
    pub tabs: Vec<ModTab>,
    #[serde(default)]
    pub active: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ModLayout {
    Leaf(ModLayoutLeaf),
    Split(ModLayoutSplit),
    Tabs(ModLayoutTabs),
}

impl ModLayout {
    fn walk(&self, depth: usize, leaves: &mut Vec<String>) -> bool {
        if depth > 4 {
            return false;
        }
        match self {
            Self::Leaf(leaf) => {
                leaves.push(leaf.content.clone());
                matches!(leaf.content.as_str(), "transcript" | "composer")
                    || leaf.content.strip_prefix("site:").is_some_and(valid_site)
            }
            Self::Split(split) => {
                (2..=4).contains(&split.children.len())
                    && (split.ratio.is_empty() || split.ratio.len() == split.children.len())
                    && split.ratio.iter().all(|ratio| (1..=100).contains(ratio))
                    && split
                        .children
                        .iter()
                        .all(|child| child.walk(depth + 1, leaves))
            }
            Self::Tabs(tabs) => {
                (1..=6).contains(&tabs.tabs.len())
                    && tabs.active < tabs.tabs.len()
                    && tabs.tabs.iter().all(|tab| {
                        !tab.title.is_empty()
                            && visible(&tab.title, 32)
                            && tab.node.walk(depth + 1, leaves)
                    })
            }
        }
    }

    fn composer_follows_transcript(&self) -> bool {
        match self {
            Self::Leaf(_) => true,
            Self::Split(split) => {
                let position = |content: &str| {
                    split.children.iter().position(
                        |child| matches!(child, Self::Leaf(leaf) if leaf.content == content),
                    )
                };
                match position("composer") {
                    Some(composer) => {
                        split.split == ModSplit::Vertical
                            && position("transcript")
                                .is_some_and(|transcript| transcript + 1 == composer)
                    }
                    None => split.children.iter().all(Self::composer_follows_transcript),
                }
            }
            Self::Tabs(tabs) => tabs
                .tabs
                .iter()
                .all(|tab| tab.node.composer_follows_transcript()),
        }
    }

    pub fn valid(&self) -> bool {
        let mut leaves = Vec::new();
        self.walk(1, &mut leaves)
            && leaves.len() <= 12
            && leaves.iter().filter(|leaf| *leaf == "transcript").count() == 1
            && leaves.iter().filter(|leaf| *leaf == "composer").count() <= 1
            && leaves.iter().collect::<BTreeSet<_>>().len() == leaves.len()
            && self.composer_follows_transcript()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModBackdropOffset {
    pub x: i16,
    pub y: i16,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModSurfacePaint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top: Option<ModColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bottom: Option<ModColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground: Option<ModColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border: Option<ModColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f32>,
}

fn valid_surface_styles(styles: &BTreeMap<String, ModSurfacePaint>) -> bool {
    styles.iter().all(|(name, paint)| {
        matches!(name.as_str(), "composer" | "backdrop" | "approval")
            && paint
                .opacity
                .is_none_or(|value| value.is_finite() && (0.0..=1.0).contains(&value))
    })
}

fn valid_backdrop_transform(
    position: &Option<String>,
    scale: Option<f32>,
    opacity: Option<f32>,
    offset: &Option<ModBackdropOffset>,
) -> bool {
    position
        .as_deref()
        .is_none_or(|value| matches!(value, "center" | "fill" | "fit" | "tile"))
        && scale.is_none_or(|value| value.is_finite() && (0.1..=4.0).contains(&value))
        && opacity.is_none_or(|value| value.is_finite() && (0.0..=1.0).contains(&value))
        && offset.as_ref().is_none_or(|value| {
            (-4096..=4096).contains(&value.x) && (-4096..=4096).contains(&value.y)
        })
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModAsciiBackdrop {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dim: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint: Option<ModColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<ModBackdropOffset>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModImageBackdrop {
    pub resource: crate::resource_data::ResourceRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dim: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint: Option<ModColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<ModBackdropOffset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlay: Option<ModSurfacePaint>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModAsciiFallback {
    pub ascii: ModAsciiBackdrop,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum ModBackdrop {
    Ascii {
        ascii: ModAsciiBackdrop,
    },
    Image {
        image: ModImageBackdrop,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fallback: Option<ModAsciiFallback>,
    },
}

impl ModBackdrop {
    pub fn valid(&self) -> bool {
        let dim = |dim: &Option<f32>| dim.is_none_or(|dim| (0.0..=1.0).contains(&dim));
        let ascii = |ascii: &ModAsciiBackdrop| {
            !ascii.text.is_empty()
                && ascii.text.len() <= 8192
                && multiline(&ascii.text, 8192)
                && dim(&ascii.dim)
                && valid_backdrop_transform(
                    &ascii.position,
                    ascii.scale,
                    ascii.opacity,
                    &ascii.offset,
                )
        };
        match self {
            Self::Ascii { ascii: backdrop } => ascii(backdrop),
            Self::Image { image, fallback } => {
                dim(&image.dim)
                    && image.overlay.as_ref().is_none_or(|paint| {
                        paint
                            .opacity
                            .is_none_or(|value| value.is_finite() && (0.0..=1.0).contains(&value))
                    })
                    && valid_backdrop_transform(
                        &image.position,
                        image.scale,
                        image.opacity,
                        &image.offset,
                    )
                    && fallback
                        .as_ref()
                        .is_none_or(|fallback| ascii(&fallback.ascii))
            }
        }
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
        keys: bool,
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
    Document {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        lines: Vec<Vec<ModSpan>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<crate::resource_data::ResourceRef>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        anchors: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selected: Option<ModRange>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        find: Option<ModFind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        height: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        action: Option<ModCommandAction>,
        #[serde(default)]
        keys: bool,
    },
    Terminal {
        id: String,
        label: String,
        session: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        height: Option<u16>,
    },
    Image {
        id: String,
        label: String,
        image: crate::resource_data::ResourceRef,
        alt: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        height: Option<u16>,
    },
    Diff {
        id: String,
        label: String,
        unified: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selected: Option<ModRange>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        height: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        action: Option<ModCommandAction>,
    },
    Slot,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModFind {
    pub query: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModListRow {
    pub value: String,
    pub label: String,
    #[serde(default)]
    pub spans: Vec<ModSpan>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModSpan {
    pub text: String,
    #[serde(default)]
    pub tone: ModTone,
    #[serde(default)]
    pub bold: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub italic: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub underline: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fg: Option<ModColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg: Option<ModColor>,
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
    pub rendered_ms: u64,
    #[serde(default)]
    pub view: ModView,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub contributors: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub component_owners: BTreeMap<String, String>,
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

pub const MOD_NAMED_KEYS: &[&str] = &[
    "Up",
    "Down",
    "Left",
    "Right",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Delete",
    "Insert",
    "Tab",
    "Enter",
    "Esc",
    "Backspace",
    "Space",
];

pub fn mod_key_name(key: &str) -> bool {
    let mut parts = key.split('+').collect::<Vec<_>>();
    let Some(base) = parts.pop() else {
        return false;
    };
    let order = ["Ctrl", "Alt", "Shift"];
    let ordered = parts
        .iter()
        .map(|modifier| order.iter().position(|known| known == modifier))
        .collect::<Option<Vec<_>>>()
        .is_some_and(|positions| positions.windows(2).all(|pair| pair[0] < pair[1]));
    let function = base
        .strip_prefix('F')
        .and_then(|number| number.parse::<u8>().ok())
        .is_some_and(|number| (2..=12).contains(&number) && base == format!("F{number}"));
    let character = base.len() == 1
        && base
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    let named = MOD_NAMED_KEYS.contains(&base);
    let modified = parts.iter().any(|modifier| *modifier != "Shift");
    let reserved = [
        "Ctrl+c",
        "Ctrl+d",
        "Ctrl+z",
        "Ctrl+h",
        "Ctrl+i",
        "Ctrl+j",
        "Ctrl+m",
        "Shift+Tab",
    ];
    ordered
        && !reserved.contains(&key)
        && (function || modified && (character || named) || parts == ["Shift"] && named)
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
            Self::Document {
                id,
                label,
                lines,
                source,
                anchors,
                selected,
                find,
                height,
                action,
                ..
            } => {
                identified(id, label, ids)
                    && (source.is_none() || lines.is_empty())
                    && lines.len() <= 2000
                    && lines.iter().all(|spans| {
                        spans.len() <= 12 && spans.iter().all(|span| visible(&span.text, 1024))
                    })
                    && lines
                        .iter()
                        .flatten()
                        .map(|span| span.text.chars().count())
                        .sum::<usize>()
                        <= 49_152
                    && anchors.len() <= lines.len().max(2000)
                    && anchors.iter().all(|anchor| visible(anchor, 128))
                    && selected.is_none_or(|range| range.start <= range.end)
                    && find
                        .as_ref()
                        .is_none_or(|find| !find.query.is_empty() && visible(&find.query, 256))
                    && height.is_none_or(|height| (1..=40).contains(&height))
                    && action.as_ref().is_none_or(ModCommandAction::valid)
            }
            Self::Diff {
                id,
                label,
                unified,
                selected,
                height,
                action,
            } => {
                identified(id, label, ids)
                    && multiline(unified, 49_152)
                    && selected.is_none_or(|range| range.start <= range.end)
                    && height.is_none_or(|height| (1..=40).contains(&height))
                    && action.as_ref().is_none_or(ModCommandAction::valid)
            }
            Self::Terminal {
                id,
                label,
                session,
                height,
            } => {
                identified(id, label, ids)
                    && visible(session, 64)
                    && height.is_none_or(|height| (2..=60).contains(&height))
            }
            Self::Image {
                id,
                label,
                alt,
                height,
                ..
            } => {
                identified(id, label, ids)
                    && visible(alt, 256)
                    && height.is_none_or(|height| (1..=40).contains(&height))
            }
            Self::Slot => {
                *slots += 1;
                *slots <= 1
            }
        }
    }
}

impl ModRenderSite {
    fn invalid(&self, patch: bool, ids: &mut BTreeSet<String>) -> Option<String> {
        let mut count = 0;
        let mut slots = 0;
        if let Some(index) = self
            .components
            .iter()
            .position(|component| !component.validate(1, &mut count, ids, &mut slots))
        {
            return Some(format!("components[{index}]"));
        }
        let expected = usize::from(patch && self.mode == ModSiteMode::Wrap);
        (slots != expected).then(|| "slot".to_owned())
    }
}

fn valid_site(name: &str) -> bool {
    let part = |part: &str, limit: usize| {
        !part.is_empty()
            && part.len() <= limit
            && part.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
            })
    };
    ["sidebar", "header", "above_composer", "dialog", "welcome"].contains(&name)
        || name
            .split_once('/')
            .is_some_and(|(owner, site)| part(owner, 24) && part(site, 32))
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

fn valid_bindings(bindings: &BTreeMap<String, ModKeyAction>, limit: usize) -> bool {
    bindings.len() <= limit
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

fn invalid_sites(sites: &BTreeMap<String, ModRenderSite>, patch: bool) -> Option<String> {
    if sites.len() > 8 {
        return Some("sites".into());
    }
    let mut ids = BTreeSet::new();
    sites.iter().find_map(|(name, site)| {
        if !valid_site(name) {
            return Some(format!("sites.{name}"));
        }
        site.invalid(patch, &mut ids)
            .map(|field| format!("sites.{name}.{field}"))
    })
}

/// Every component id rendered in these sites, including nested children.
pub fn site_component_ids(sites: &BTreeMap<String, ModRenderSite>) -> BTreeSet<String> {
    component_ids_of(sites.values().flat_map(|site| &site.components))
}

pub fn component_ids_of<'a>(
    components: impl IntoIterator<Item = &'a ModComponent>,
) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for component in components {
        component_ids(component, &mut ids);
    }
    ids
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
        | ModComponent::List { id, .. }
        | ModComponent::Document { id, .. }
        | ModComponent::Diff { id, .. }
        | ModComponent::Terminal { id, .. }
        | ModComponent::Image { id, .. } => {
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
                keys,
                children,
            } => vec![ModComponent::Pane {
                id,
                label,
                title,
                collapsed,
                scroll,
                keys,
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
        let invalid = [
            (
                "session_title_suffix",
                patch
                    .session_title_suffix
                    .as_ref()
                    .is_some_and(|text| !visible(text, 80)),
            ),
            (
                "greeting",
                patch
                    .greeting
                    .as_ref()
                    .is_some_and(|text| !visible(text, 256)),
            ),
            (
                "sidebar_width",
                patch.sidebar_width.is_some_and(|width| width > 60),
            ),
            (
                "title",
                patch
                    .title
                    .as_ref()
                    .is_some_and(|title| !visible(title, 1024)),
            ),
            ("status", !valid_status(&patch.status)),
            (
                "keybindings",
                !valid_bindings(&patch.keybindings, MOD_KEY_LIMIT),
            ),
            (
                "templates",
                !valid_templates(&patch.message_template, &patch.tool_template),
            ),
            (
                "theme.syntax",
                patch
                    .theme
                    .syntax
                    .as_ref()
                    .is_some_and(|syntax| syntax.is_empty() || !visible(syntax, 128)),
            ),
            (
                "placeholder",
                patch
                    .placeholder
                    .as_ref()
                    .is_some_and(|placeholder| placeholder.is_empty() || !visible(placeholder, 80)),
            ),
            ("theme.glyphs", !valid_glyphs(&patch.theme.glyphs)),
            (
                "layout",
                patch.layout.as_ref().is_some_and(|layout| !layout.valid()),
            ),
            (
                "backdrop",
                patch
                    .backdrop
                    .as_ref()
                    .is_some_and(|backdrop| !backdrop.valid()),
            ),
            (
                "surface_styles",
                !valid_surface_styles(&patch.surface_styles),
            ),
            ("size", serde_json::to_vec(&patch)?.len() > 65_536),
        ]
        .into_iter()
        .find_map(|(field, invalid)| invalid.then(|| field.to_owned()))
        .or_else(|| invalid_sites(&patch.sites, true));
        if let Some(field) = invalid {
            return Err(failure(format!("invalid_terminal_patch: {field}")));
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
        if self.welcome.is_some() {
            target.welcome = self.welcome;
        }
        if self.session_title_suffix.is_some() {
            target.session_title_suffix = self.session_title_suffix;
        }
        if self.greeting.is_some() {
            target.greeting = self.greeting;
        }
        if let Some(title) = self.title {
            target.title = Some(title);
        }
        if let Some(layout) = self.layout {
            if !replaced_sites.insert("@layout".into()) {
                return Err(failure("terminal_layout_conflict"));
            }
            target.layout = Some(layout);
        }
        if let Some(backdrop) = self.backdrop {
            if !replaced_sites.insert("@backdrop".into()) {
                return Err(failure("terminal_backdrop_conflict"));
            }
            target.backdrop = Some(backdrop);
        }
        target.surface_styles.extend(self.surface_styles);
        if self.inline_sites.is_some() {
            target.inline_sites = self.inline_sites;
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
        ModView::parse_with(
            serde_json::to_value(target.clone())?,
            MOD_COMPOSED_KEY_LIMIT,
        )?;
        Ok(())
    }
}

impl ModView {
    pub fn parse(value: Value) -> Result<Self> {
        Self::parse_with(value, MOD_KEY_LIMIT)
    }

    /// Each mod's view or patch keeps 12 keys; the view composed from every mod may hold more.
    fn parse_with(value: Value, key_limit: usize) -> Result<Self> {
        let view: Self = serde_json::from_value(value)?;
        let invalid = [
            (
                "session_title_suffix",
                view.session_title_suffix
                    .as_ref()
                    .is_some_and(|text| !visible(text, 80)),
            ),
            (
                "greeting",
                view.greeting
                    .as_ref()
                    .is_some_and(|text| !visible(text, 256)),
            ),
            ("sidebar_width", view.sidebar_width > 60),
            (
                "panels",
                view.panels.len() > 8 || view.panels.iter().any(|panel| !panel.valid(32)),
            ),
            (
                "title",
                view.title
                    .as_ref()
                    .is_some_and(|title| !visible(title, 1024)),
            ),
            (
                "templates",
                !valid_templates(&view.message_template, &view.tool_template),
            ),
            (
                "header",
                view.header.as_ref().is_some_and(|panel| !panel.valid(3)),
            ),
            (
                "footer",
                view.footer.as_ref().is_some_and(|panel| !panel.valid(3)),
            ),
            ("status", !valid_status(&view.status)),
            ("keybindings", !valid_bindings(&view.keybindings, key_limit)),
            (
                "keybindings.focus",
                !valid_focus_targets(&view.keybindings, &view.sites),
            ),
            (
                "theme.syntax",
                view.theme
                    .syntax
                    .as_ref()
                    .is_some_and(|syntax| syntax.is_empty() || !visible(syntax, 128)),
            ),
            (
                "placeholder",
                view.placeholder
                    .as_ref()
                    .is_some_and(|placeholder| placeholder.is_empty() || !visible(placeholder, 80)),
            ),
            ("theme.glyphs", !valid_glyphs(&view.theme.glyphs)),
            (
                "layout",
                view.layout.as_ref().is_some_and(|layout| !layout.valid()),
            ),
            (
                "backdrop",
                view.backdrop
                    .as_ref()
                    .is_some_and(|backdrop| !backdrop.valid()),
            ),
            (
                "surface_styles",
                !valid_surface_styles(&view.surface_styles),
            ),
            ("size", serde_json::to_vec(&view)?.len() > 262_144),
        ]
        .into_iter()
        .find_map(|(field, invalid)| invalid.then(|| field.to_owned()))
        .or_else(|| invalid_sites(&view.sites, false));
        if let Some(field) = invalid {
            return Err(failure(format!("invalid_terminal_view: {field}")));
        }
        Ok(view)
    }

    pub fn read(path: &Path) -> Result<Self> {
        Ok(ModViewSnapshot::read(path)?.view)
    }
}

impl ModViewSnapshot {
    pub fn clock() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
            .unwrap_or_default()
    }

    pub fn read(path: &Path) -> Result<Self> {
        let value: Value = serde_json::from_slice(&store::read(path, 524_288)?)?;
        let mut snapshot: Self = serde_json::from_value(value)?;
        snapshot.view = ModView::parse_with(
            serde_json::to_value(&snapshot.view)?,
            MOD_COMPOSED_KEY_LIMIT,
        )?;
        if snapshot
            .progress
            .as_ref()
            .is_some_and(|panel| !panel.valid(8))
            || snapshot.activity.len() > 32
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

#[cfg(test)]
#[path = "view_surface_tests.rs"]
mod surface_tests;
