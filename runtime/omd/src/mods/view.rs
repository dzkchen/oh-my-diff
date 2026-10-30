use super::*;

pub const MOD_KEY_LIMIT: usize = 24;
pub const MOD_COMPOSED_KEY_LIMIT: usize = 128;
pub const MOD_COMPONENT_LIMIT: usize = 64;
pub const MOD_TEXT_BYTES: usize = 49_152;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModWelcome {
    #[serde(default)]
    pub show_while_composing: bool,
    /// Keeps the welcome area (Codex's own welcome and animation stay off) but draws no `welcome` site in it;
    /// effective only from the mod that owns the composed underlay.
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModUnderlay {
    pub raster: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_style: Option<ModBoxStyle>,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_contexts: Vec<ModKeyContext>,
    #[serde(default)]
    pub theme: ModTheme,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<ModLayout>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub surface_styles: BTreeMap<String, ModSurfacePaint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_sites: Option<ModInlineSites>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underlay: Option<ModUnderlay>,
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
    pub sidebar_style: Option<ModBoxStyle>,
    #[serde(default)]
    pub panels: Option<Vec<ModPanel>>,
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
    pub key_contexts: Vec<ModKeyContext>,
    #[serde(default)]
    pub theme: ModThemePatch,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub layout: Option<ModLayout>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub surface_styles: BTreeMap<String, ModSurfacePaint>,
    #[serde(default)]
    pub inline_sites: Option<ModInlineSites>,
    #[serde(default)]
    pub underlay: Option<ModUnderlay>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<ModBoxStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModLayoutSplit {
    pub split: ModSplit,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ratio: Vec<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap: Option<u8>,
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
        if depth > 6 {
            return false;
        }
        match self {
            Self::Leaf(leaf) => {
                leaves.push(leaf.content.clone());
                let titled = leaf.title.as_ref().is_none_or(|title| visible(title, 64));
                match leaf.content.strip_prefix("site:") {
                    Some(site) => {
                        valid_site(site)
                            && titled
                            && leaf
                                .style
                                .as_ref()
                                .is_none_or(|style| style.valid() && style.hover.is_none())
                    }
                    None => {
                        leaf.style.is_none()
                            && match leaf.content.as_str() {
                                "transcript" => titled,
                                "composer" => leaf.title.is_none(),
                                _ => false,
                            }
                    }
                }
            }
            Self::Split(split) => {
                (2..=4).contains(&split.children.len())
                    && split.gap.is_none_or(|gap| gap <= 4)
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModOffset {
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
    let unit = |value: Option<f32>| {
        value.is_none_or(|value| value.is_finite() && (0.0..=1.0).contains(&value))
    };
    styles.iter().all(|(name, paint)| {
        matches!(name.as_str(), "composer" | "approval") && unit(paint.opacity)
    })
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlay: Option<ModOverlay>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModScreenAnchor {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    Center,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ModAnchor {
    Screen(ModScreenAnchor),
    Component { component: String },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModOverlayClip {
    #[default]
    Screen,
    Anchor,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModOverlay {
    pub anchor: ModAnchor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<ModOffset>,
    pub width: u16,
    pub height: u16,
    #[serde(default)]
    pub z: u8,
    #[serde(default)]
    pub clip: ModOverlayClip,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<ModBoxStyle>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModBoxBorder {
    None,
    Plain,
    Rounded,
    Double,
    Thick,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModDirection {
    #[default]
    Column,
    Row,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ModSpacing {
    All(u8),
    Axes([u8; 2]),
}

impl ModSpacing {
    pub fn axes(self) -> (u16, u16) {
        match self {
            Self::All(all) => (u16::from(all), u16::from(all)),
            Self::Axes([vertical, horizontal]) => (u16::from(vertical), u16::from(horizontal)),
        }
    }

    fn valid(self) -> bool {
        let (vertical, horizontal) = self.axes();
        vertical <= 4 && horizontal <= 4
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ModPaint {
    Tone(ModTone),
    Color(ModColor),
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModBoxAccent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border: Option<ModBoxBorder>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<ModPaint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground: Option<ModPaint>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModBoxStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border: Option<ModBoxBorder>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub padding: Option<ModSpacing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin: Option<ModSpacing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<ModPaint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground: Option<ModPaint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<ModDirection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hover: Option<ModBoxAccent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<ModBoxAccent>,
}

impl ModBoxStyle {
    pub fn valid(&self) -> bool {
        self.padding.is_none_or(ModSpacing::valid)
            && self.margin.is_none_or(ModSpacing::valid)
            && self.gap.is_none_or(|gap| gap <= 4)
    }

    pub fn still(&self) -> bool {
        self.valid() && self.hover.is_none() && self.focus.is_none()
    }

    pub fn over(self, base: Self) -> Self {
        Self {
            border: self.border.or(base.border),
            padding: self.padding.or(base.padding),
            margin: self.margin.or(base.margin),
            gap: self.gap.or(base.gap),
            background: self.background.or(base.background),
            foreground: self.foreground.or(base.foreground),
            direction: self.direction.or(base.direction),
            hover: self.hover.or(base.hover),
            focus: self.focus.or(base.focus),
        }
    }
}

impl ModOverlay {
    fn valid(&self) -> bool {
        (1..=200).contains(&self.width)
            && (1..=60).contains(&self.height)
            && self.z <= 9
            && self.style.as_ref().is_none_or(ModBoxStyle::still)
            && self.offset.as_ref().is_none_or(|offset| {
                offset.x.unsigned_abs() <= 500 && offset.y.unsigned_abs() <= 200
            })
            && match &self.anchor {
                ModAnchor::Screen(_) => self.clip == ModOverlayClip::Screen,
                ModAnchor::Component { component } => mod_component_id(component),
            }
    }
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
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        pointer: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        style: Option<ModBoxStyle>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        flex: Option<u8>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hotkey: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        autofocus: bool,
    },
    Input {
        id: String,
        label: String,
        #[serde(default)]
        value: String,
        #[serde(default)]
        placeholder: String,
        action: ModCommandAction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hotkey: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        autofocus: bool,
    },
    Select {
        id: String,
        label: String,
        value: String,
        options: Vec<ModSelectOption>,
        action: ModCommandAction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hotkey: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        autofocus: bool,
    },
    Multiselect {
        id: String,
        label: String,
        #[serde(default)]
        value: Vec<String>,
        options: Vec<ModSelectOption>,
        action: ModCommandAction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hotkey: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        autofocus: bool,
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
        #[serde(default)]
        start: usize,
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
        keys: ModKeys,
        #[serde(default)]
        children: Vec<ModComponent>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min_width: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_width: Option<u16>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        pointer: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        style: Option<ModBoxStyle>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        flex: Option<u8>,
    },
    Dialog {
        id: String,
        label: String,
        title: String,
        #[serde(default)]
        children: Vec<ModComponent>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        style: Option<ModBoxStyle>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hotkey: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        autofocus: bool,
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
        keys: ModKeys,
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
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        pointer: bool,
    },
    Raster {
        id: String,
        label: String,
        alt: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        width: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        height: Option<u16>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        pointer: bool,
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
    Module {
        id: String,
        label: String,
        module: String,
        #[serde(default, skip_serializing_if = "Value::is_null")]
        props: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        height: Option<u16>,
        #[serde(default, skip_serializing_if = "ModKeys::is_off")]
        keys: ModKeys,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        pointer: bool,
    },
    Slot,
    Native {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        style: Option<ModStyle>,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<ModTone>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fg: Option<ModColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg: Option<ModColor>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

impl ModComponent {
    pub fn id(&self) -> Option<&str> {
        match self {
            Self::Box { id, .. }
            | Self::Line { id, .. }
            | Self::Text { id, .. }
            | Self::Button { id, .. }
            | Self::Input { id, .. }
            | Self::Select { id, .. }
            | Self::Multiselect { id, .. }
            | Self::Markdown { id, .. }
            | Self::Code { id, .. }
            | Self::Pane { id, .. }
            | Self::Dialog { id, .. }
            | Self::List { id, .. }
            | Self::Document { id, .. }
            | Self::Terminal { id, .. }
            | Self::Image { id, .. }
            | Self::Raster { id, .. }
            | Self::Module { id, .. }
            | Self::Diff { id, .. } => Some(id),
            Self::Slot | Self::Native { .. } => None,
        }
    }

    pub fn descendants<'a>(&'a self, into: &mut Vec<&'a ModComponent>) {
        into.push(self);
        if let Self::Box { children, .. }
        | Self::Pane { children, .. }
        | Self::Dialog { children, .. } = self
        {
            for child in children {
                child.descendants(into);
            }
        }
    }

    pub fn flex(&self) -> u16 {
        match self {
            Self::Box { flex, .. } | Self::Pane { flex, .. } => u16::from(flex.unwrap_or(1)),
            _ => 1,
        }
    }

    pub fn width_bounds(&self) -> (Option<u16>, Option<u16>) {
        match self {
            Self::Box {
                min_width,
                max_width,
                ..
            }
            | Self::Pane {
                min_width,
                max_width,
                ..
            } => (*min_width, *max_width),
            _ => (None, None),
        }
    }

    pub fn fits(&self, width: u16) -> bool {
        let (min_width, max_width) = self.width_bounds();
        min_width.is_none_or(|min| width >= min) && max_width.is_none_or(|max| width <= max)
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

impl ModCommandAction {
    pub fn with_value(&self, value: Option<&str>) -> ModKeyAction {
        let args = match value {
            Some(value) if self.args.is_empty() => value.to_owned(),
            Some(value) => format!("{} {value}", self.args),
            None => self.args.clone(),
        };
        ModKeyAction::Command {
            command: self.command.clone(),
            args,
        }
    }
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ModKeys {
    #[default]
    Off,
    On,
    All,
}

impl ModKeys {
    pub fn is_off(&self) -> bool {
        *self == Self::Off
    }
}

impl Serialize for ModKeys {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Self::Off => serializer.serialize_bool(false),
            Self::On => serializer.serialize_bool(true),
            Self::All => serializer.serialize_str("all"),
        }
    }
}

impl<'de> Deserialize<'de> for ModKeys {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        match Value::deserialize(deserializer)? {
            Value::Bool(false) => Ok(Self::Off),
            Value::Bool(true) => Ok(Self::On),
            Value::String(text) if text == "all" => Ok(Self::All),
            _ => Err(serde::de::Error::custom(
                "keys must be true, false or \"all\"",
            )),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ModRegion {
    Index(u8),
    Name(String),
}

const MOD_REGION_MOVES: [&str; 7] = ["left", "right", "up", "down", "next", "previous", "chat"];

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(untagged)]
pub enum ModKeyAction {
    Draft(String),
    Insert { insert: String },
    Submit { submit: String },
    Command { command: String, args: String },
    Focus { focus: String },
    Copy { copy: String, label: String },
    Region { region: ModRegion },
    Help { help: bool },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModComposerWhen {
    Empty,
    Draft,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModKeyWhen {
    #[serde(
        default,
        deserialize_with = "one_or_many",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub focus: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composer: Option<ModComposerWhen>,
}

fn one_or_many<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Focus {
        One(String),
        Many(Vec<String>),
    }
    Ok(match Focus::deserialize(deserializer)? {
        Focus::One(focus) => vec![focus],
        Focus::Many(focus) => focus,
    })
}

impl ModKeyWhen {
    pub fn in_chat(&self) -> bool {
        self.focus.is_empty() || self.focus.iter().any(|focus| focus == "chat")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModContextKey {
    pub action: ModKeyAction,
    pub label: Option<String>,
}

impl Serialize for ModContextKey {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        match &self.label {
            Some(label) => {
                serde_json::json!({"action": self.action, "label": label}).serialize(serializer)
            }
            None => self.action.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for ModContextKey {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        if let Some(object) = value.as_object()
            && object.keys().map(String::as_str).collect::<BTreeSet<_>>()
                == BTreeSet::from(["action", "label"])
        {
            return Ok(Self {
                action: ModKeyAction::deserialize(object["action"].clone())
                    .map_err(serde::de::Error::custom)?,
                label: Some(
                    object["label"]
                        .as_str()
                        .ok_or_else(|| serde::de::Error::custom("label must be a string"))?
                        .to_owned(),
                ),
            });
        }
        Ok(Self {
            action: ModKeyAction::deserialize(value).map_err(serde::de::Error::custom)?,
            label: None,
        })
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModKeyContext {
    #[serde(default)]
    pub when: ModKeyWhen,
    pub keys: BTreeMap<String, ModContextKey>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub owner: String,
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
        if keys == BTreeSet::from(["region"]) {
            return Ok(Self::Region {
                region: ModRegion::deserialize(object["region"].clone())
                    .map_err(serde::de::Error::custom)?,
            });
        }
        if keys == BTreeSet::from(["help"]) {
            return Ok(Self::Help {
                help: object["help"]
                    .as_bool()
                    .ok_or_else(|| serde::de::Error::custom("help must be true"))?,
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
    pub contributors: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<ModViewConflict>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub component_owners: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_owner: Option<String>,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub progress: Option<ModPanel>,
    #[serde(default)]
    pub activity: Vec<ModActivity>,
    #[serde(default)]
    pub diagnostics: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<(String, String)>,
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

pub fn mod_link(link: &str) -> bool {
    visible(link, 2048)
        && !link.contains(char::is_whitespace)
        && ["https://", "http://"].iter().any(|scheme| {
            link.get(..scheme.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(scheme))
                && link[scheme.len()..]
                    .split(['/', '?', '#'])
                    .next()
                    .is_some_and(|host| !host.is_empty())
        })
}

fn valid_span(span: &ModSpan, limit: usize) -> bool {
    visible(&span.text, limit) && span.link.as_deref().is_none_or(mod_link)
}

fn valid_control(hotkey: &Option<String>) -> bool {
    hotkey.as_deref().is_none_or(mod_key_name)
}

impl ModView {
    /// The size of raster `id` when both sides are declared; a fill raster has no size a client could check a blit against.
    pub fn raster_size(&self, id: &str) -> Option<(u16, u16)> {
        let (width, height) = self.raster_declared(id)?;
        Some((width?, height?))
    }

    pub fn raster_declared(&self, id: &str) -> Option<(Option<u16>, Option<u16>)> {
        fn find(components: &[ModComponent], id: &str) -> Option<(Option<u16>, Option<u16>)> {
            components.iter().find_map(|component| match component {
                ModComponent::Raster {
                    id: raster,
                    width,
                    height,
                    ..
                } if raster == id => Some((*width, *height)),
                ModComponent::Box { children, .. }
                | ModComponent::Pane { children, .. }
                | ModComponent::Dialog { children, .. } => find(children, id),
                _ => None,
            })
        }
        self.sites
            .values()
            .find_map(|site| find(&site.components, id))
            .or_else(|| {
                self.underlay
                    .as_ref()
                    .is_some_and(|underlay| underlay.raster == id)
                    .then_some((None, None))
            })
    }

    pub fn module(&self, id: &str) -> Option<(&str, &Value)> {
        let mut found = Vec::new();
        for site in self.sites.values() {
            for component in &site.components {
                component.descendants(&mut found);
            }
        }
        found.into_iter().find_map(|component| match component {
            ModComponent::Module {
                id: instance,
                module,
                props,
                ..
            } if instance == id => Some((module.as_str(), props)),
            _ => None,
        })
    }
}

pub fn mod_component_id(value: &str) -> bool {
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
    key_name(key, false)
}

pub fn composer_key_name(key: &str) -> bool {
    key_name(key, true)
}

fn key_name(key: &str, bare: bool) -> bool {
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
        && (function
            || modified && (character || named)
            || (parts == ["Shift"] || bare && parts.is_empty()) && named)
}

/// A view action runs only its owner's commands: a bare name is the owner's, another mod's is refused.
pub fn owned_command(owner: &str, command: &str) -> Option<String> {
    match command.split_once(':') {
        Some((id, _)) if id != owner => None,
        Some(_) => Some(command.to_owned()),
        None => Some(format!("{owner}:{command}")),
    }
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
            mod_component_id(id)
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
                style,
                flex,
                ..
            }
            | Self::Pane {
                id,
                label,
                title,
                children: nested,
                min_width,
                max_width,
                style,
                flex,
                ..
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
                    && style.as_ref().is_none_or(ModBoxStyle::valid)
                    && flex.is_none_or(|flex| (1..=12).contains(&flex))
                    && children(nested, count, ids, slots)
            }
            Self::Line { id, label, spans } => {
                identified(id, label, ids)
                    && !spans.is_empty()
                    && spans.len() <= 12
                    && spans.iter().all(|span| valid_span(span, 1024))
                    && spans
                        .iter()
                        .map(|span| span.text.chars().count())
                        .sum::<usize>()
                        <= 256
            }
            Self::Dialog {
                id,
                label,
                title,
                children: nested,
                style,
            } => {
                identified(id, label, ids)
                    && !title.is_empty()
                    && visible(title, 128)
                    && style.as_ref().is_none_or(ModBoxStyle::still)
                    && children(nested, count, ids, slots)
            }
            Self::Text {
                id, label, text, ..
            }
            | Self::Markdown { id, label, text }
            | Self::Code {
                id, label, text, ..
            } => identified(id, label, ids) && multiline(text, MOD_TEXT_BYTES),
            Self::Button {
                id,
                label,
                text,
                action,
                hotkey,
                ..
            } => {
                identified(id, label, ids)
                    && !text.is_empty()
                    && visible(text, 256)
                    && action.valid()
                    && valid_control(hotkey)
            }
            Self::Input {
                id,
                label,
                value,
                placeholder,
                action,
                hotkey,
                ..
            } => {
                identified(id, label, ids)
                    && multiline(value, 1024)
                    && visible(placeholder, 256)
                    && action.valid()
                    && valid_control(hotkey)
            }
            Self::Select {
                id,
                label,
                options,
                action,
                hotkey,
                ..
            }
            | Self::Multiselect {
                id,
                label,
                options,
                action,
                hotkey,
                ..
            } => {
                let values = options
                    .iter()
                    .map(|option| option.value.as_str())
                    .collect::<BTreeSet<_>>();
                let chosen = match self {
                    Self::Select { value, .. } => values.contains(value.as_str()),
                    Self::Multiselect { value, .. } => {
                        value.iter().all(|value| values.contains(value.as_str()))
                            && value.iter().collect::<BTreeSet<_>>().len() == value.len()
                    }
                    _ => false,
                };
                identified(id, label, ids)
                    && (1..=16).contains(&options.len())
                    && values.len() == options.len()
                    && chosen
                    && options.iter().all(|option| {
                        !option.value.is_empty()
                            && visible(&option.value, 128)
                            && !option.label.is_empty()
                            && visible(&option.label, 128)
                    })
                    && action.valid()
                    && valid_control(hotkey)
            }
            Self::List {
                id,
                label,
                rows,
                selected,
                height,
                action,
                hotkey,
                ..
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
                            && row.spans.iter().all(|span| valid_span(span, 256))
                            && row
                                .spans
                                .iter()
                                .map(|span| span.text.chars().count())
                                .sum::<usize>()
                                <= 256
                    })
                    && action.valid()
                    && valid_control(hotkey)
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
                        spans.len() <= 12
                            && spans
                                .iter()
                                .all(|span| visible(&span.text, 1024) && span.link.is_none())
                    })
                    && lines
                        .iter()
                        .flatten()
                        .map(|span| span.text.chars().count())
                        .sum::<usize>()
                        <= MOD_TEXT_BYTES
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
                    && multiline(unified, MOD_TEXT_BYTES)
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
            Self::Raster {
                id,
                label,
                alt,
                width,
                height,
                ..
            } => {
                identified(id, label, ids)
                    && visible(alt, 256)
                    && width.is_none_or(|width| (1..=512).contains(&width))
                    && height.is_none_or(|height| (1..=256).contains(&height))
            }
            Self::Module {
                id,
                label,
                module,
                props,
                height,
                ..
            } => {
                identified(id, label, ids)
                    && module.len() <= 64
                    && !module.is_empty()
                    && module.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
                    })
                    && props.to_string().len() <= 4096
                    && height.is_none_or(|height| (1..=40).contains(&height))
            }
            Self::Slot | Self::Native { .. } => {
                *slots += 1;
                *slots <= 1
            }
        }
    }

    pub(super) fn contains(&self, found: &dyn Fn(&Self) -> bool) -> bool {
        found(self)
            || match self {
                Self::Box { children, .. }
                | Self::Pane { children, .. }
                | Self::Dialog { children, .. } => {
                    children.iter().any(|child| child.contains(found))
                }
                _ => false,
            }
    }
}

/// A render tree draws presentation only and holds the native drawing at most once.
pub fn invalid_render_tree(tree: &[ModComponent]) -> Option<String> {
    let (mut count, mut ids, mut natives) = (0, BTreeSet::new(), 0);
    tree.iter().enumerate().find_map(|(index, component)| {
        let presentational = !component.contains(&|component| {
            !matches!(
                component,
                ModComponent::Box {
                    style: None,
                    flex: None,
                    ..
                } | ModComponent::Line { .. }
                    | ModComponent::Text { .. }
                    | ModComponent::Markdown { .. }
                    | ModComponent::Code { .. }
                    | ModComponent::Diff { .. }
                    | ModComponent::List { .. }
                    | ModComponent::Native { .. }
            )
        });
        (!presentational || !component.validate(1, &mut count, &mut ids, &mut natives))
            .then(|| format!("tree[{index}]"))
    })
}

impl ModRenderSite {
    fn invalid(&self, ids: &mut BTreeSet<String>) -> Option<String> {
        let mut count = 0;
        let mut slots = 0;
        if let Some(index) = self.components.iter().position(|component| {
            component.contains(&|component| matches!(component, ModComponent::Native { .. }))
                || !component.validate(1, &mut count, ids, &mut slots)
        }) {
            return Some(format!("components[{index}]"));
        }
        let expected = usize::from(self.mode == ModSiteMode::Wrap);
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
    [
        "sidebar",
        "header",
        "above_composer",
        "below_composer",
        "dialog",
        "welcome",
    ]
    .contains(&name)
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
        ModKeyAction::Focus { focus } => mod_component_id(focus),
        ModKeyAction::Copy { copy, label } => {
            !copy.is_empty() && multiline(copy, 4096) && !label.is_empty() && visible(label, 128)
        }
        ModKeyAction::Region {
            region: ModRegion::Index(index),
        } => *index <= 12,
        ModKeyAction::Region {
            region: ModRegion::Name(name),
        } => MOD_REGION_MOVES.contains(&name.as_str()) || valid_site(name),
        ModKeyAction::Help { help } => *help,
    }
}

fn valid_bindings(bindings: &BTreeMap<String, ModKeyAction>, limit: usize) -> bool {
    bindings.len() <= limit
        && bindings
            .iter()
            .all(|(key, action)| mod_key_name(key) && valid_action(action))
}

fn context_key_name(key: &str) -> bool {
    mod_key_name(key)
        || key == "Shift+Tab"
        || key != "Esc" && MOD_NAMED_KEYS.contains(&key)
        || key.len() == 1 && key.bytes().all(|byte| byte.is_ascii_graphic())
}

fn valid_contexts(contexts: &[ModKeyContext], limit: usize, key_limit: usize) -> bool {
    contexts.len() <= limit
        && contexts
            .iter()
            .map(|context| context.keys.len())
            .sum::<usize>()
            <= key_limit
        && contexts.iter().all(|context| {
            context.when.focus.len() <= 8
                && context
                    .when
                    .focus
                    .iter()
                    .all(|focus| matches!(focus.as_str(), "chat" | "site") || valid_site(focus))
                && context.when.focus.iter().collect::<BTreeSet<_>>().len()
                    == context.when.focus.len()
                && !context.keys.is_empty()
                && context.keys.iter().all(|(key, binding)| {
                    (if context.when.in_chat() {
                        mod_key_name(key)
                    } else {
                        context_key_name(key)
                    }) && valid_action(&binding.action)
                        && binding
                            .label
                            .as_ref()
                            .is_none_or(|label| !label.is_empty() && visible(label, 64))
                })
        })
}

fn valid_status(status: &[String]) -> bool {
    status.len() <= 4
        && status
            .iter()
            .all(|segment| !segment.is_empty() && visible(segment, 40))
}

fn invalid_sites(sites: &BTreeMap<String, ModRenderSite>) -> Option<String> {
    if sites.len() > 8 {
        return Some("sites".into());
    }
    let mut ids = BTreeSet::new();
    sites.iter().find_map(|(name, site)| {
        if !valid_site(name) {
            return Some(format!("sites.{name}"));
        }
        if site
            .overlay
            .as_ref()
            .is_some_and(|overlay| !name.contains('/') || !overlay.valid())
        {
            return Some(format!("sites.{name}.overlay"));
        }
        site.invalid(&mut ids)
            .map(|field| format!("sites.{name}.{field}"))
    })
}

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
    let mut all = Vec::new();
    component.descendants(&mut all);
    ids.extend(
        all.into_iter()
            .filter_map(|found| found.id().map(str::to_owned)),
    );
}

fn valid_focus_targets(view: &ModView) -> bool {
    let ids = site_component_ids(&view.sites);
    view.keybindings
        .values()
        .chain(
            view.key_contexts
                .iter()
                .flat_map(|context| context.keys.values().map(|binding| &binding.action)),
        )
        .all(|action| match action {
            ModKeyAction::Focus { focus } => ids.contains(focus),
            _ => true,
        })
}

fn replace_slot(components: Vec<ModComponent>, current: &[ModComponent]) -> Vec<ModComponent> {
    components
        .into_iter()
        .flat_map(|component| match component {
            ModComponent::Slot => current.to_vec(),
            mut component @ (ModComponent::Box { .. }
            | ModComponent::Pane { .. }
            | ModComponent::Dialog { .. }) => {
                if let ModComponent::Box { children, .. }
                | ModComponent::Pane { children, .. }
                | ModComponent::Dialog { children, .. } = &mut component
                {
                    *children = replace_slot(std::mem::take(children), current);
                }
                vec![component]
            }
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
                "sidebar_style",
                patch
                    .sidebar_style
                    .as_ref()
                    .is_some_and(|style| !style.still()),
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
                "key_contexts",
                !valid_contexts(&patch.key_contexts, 8, 32)
                    || patch
                        .key_contexts
                        .iter()
                        .any(|context| !context.owner.is_empty()),
            ),
            (
                "panels",
                patch.panels.as_ref().is_some_and(|panels| {
                    panels.len() > 8 || panels.iter().any(|panel| !panel.valid(32))
                }),
            ),
            (
                "header",
                patch.header.as_ref().is_some_and(|panel| !panel.valid(3)),
            ),
            (
                "footer",
                patch.footer.as_ref().is_some_and(|panel| !panel.valid(3)),
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
                "surface_styles",
                !valid_surface_styles(&patch.surface_styles),
            ),
            (
                "underlay",
                patch
                    .underlay
                    .as_ref()
                    .is_some_and(|underlay| !mod_component_id(&underlay.raster)),
            ),
            ("size", serde_json::to_vec(&patch)?.len() > 262_144),
        ]
        .into_iter()
        .find_map(|(field, invalid)| invalid.then(|| field.to_owned()))
        .or_else(|| invalid_sites(&patch.sites));
        if let Some(field) = invalid {
            return Err(failure(format!("invalid_terminal_patch: {field}")));
        }
        Ok(patch)
    }

    pub fn drop_persistent_ui(&mut self) {
        self.sites.retain(|name, _| name == "dialog");
        self.panels = None;
        self.header = None;
        self.footer = None;
        self.layout = None;
        self.underlay = None;
        self.status.clear();
    }

    /// Exclusive fields go to the first mod in composition order; later claims become conflicts.
    pub fn apply(
        mut self,
        target: &mut ModView,
        claims: &mut BTreeMap<String, String>,
        id: &str,
        origin: &str,
    ) -> Result<Vec<ModViewConflict>> {
        let mut candidate = target.clone();
        let mut candidate_claims = claims.clone();
        let mut conflicts = Vec::new();
        self.sites.retain(|name, _| match name.split_once('/') {
            Some((owner, _)) if owner != id => {
                conflicts.push(ModViewConflict {
                    field: format!("sites.{name}"),
                    owner: owner.to_owned(),
                    rejected: id.to_owned(),
                    origin: origin.to_owned(),
                });
                false
            }
            _ => true,
        });
        let mut claim = |field: String| {
            let owner = candidate_claims
                .entry(field.clone())
                .or_insert_with(|| id.to_owned());
            if owner == id {
                return true;
            }
            conflicts.push(ModViewConflict {
                field,
                owner: owner.clone(),
                rejected: id.to_owned(),
                origin: origin.to_owned(),
            });
            false
        };
        macro_rules! last_writer {
            ($($field:ident),*) => {$(
                if self.$field.is_some() {
                    candidate.$field = self.$field;
                }
            )*};
        }
        last_writer!(
            welcome,
            session_title_suffix,
            greeting,
            title,
            foreground,
            background,
            inline_sites,
            sidebar_style
        );
        if let Some(width) = self.sidebar_width {
            candidate.sidebar_width = width;
        }
        if let Some(side) = self.sidebar_side {
            candidate.sidebar_side = side;
        }
        if let Some(panels) = self.panels
            && claim("panels".into())
        {
            candidate.panels = panels;
        }
        if self.header.is_some() && claim("header".into()) {
            candidate.header = self.header;
        }
        if self.footer.is_some() && claim("footer".into()) {
            candidate.footer = self.footer;
        }
        if self.layout.is_some() && claim("layout".into()) {
            candidate.layout = self.layout;
        }
        if self.placeholder.is_some() && claim("placeholder".into()) {
            candidate.placeholder = self.placeholder;
        }
        if self.underlay.is_some() && claim("underlay".into()) {
            candidate.underlay = self.underlay;
        }
        candidate.surface_styles.extend(self.surface_styles);
        for (name, site) in self.sites {
            if site.mode == ModSiteMode::Replace && !claim(format!("sites.{name}")) {
                continue;
            }
            // An unfilled wrap keeps its slot, so a replacement composed later lands inside it.
            let current = candidate.sites.remove(&name).unwrap_or(ModRenderSite {
                mode: ModSiteMode::Wrap,
                components: vec![ModComponent::Slot],
                overlay: None,
            });
            let overlay = site.overlay.clone().or(current.overlay);
            let composed = match (site.mode, current.mode) {
                (ModSiteMode::Replace, ModSiteMode::Replace) => ModRenderSite { overlay, ..site },
                (ModSiteMode::Replace, ModSiteMode::Wrap) => ModRenderSite {
                    mode: ModSiteMode::Replace,
                    components: replace_slot(current.components, &site.components),
                    overlay,
                },
                (ModSiteMode::Wrap, mode) => ModRenderSite {
                    mode,
                    components: replace_slot(site.components, &current.components),
                    overlay,
                },
            };
            candidate.sites.insert(name, composed);
        }
        let composed = site_component_ids(&candidate.sites);
        for (key, mut action) in self.keybindings {
            // A focus key into a site this patch lost has nothing to focus.
            if matches!(&action, ModKeyAction::Focus { focus } if !composed.contains(focus)) {
                continue;
            }
            if let ModKeyAction::Command { command, .. } = &mut action {
                let Some(owned) = owned_command(id, command) else {
                    continue;
                };
                *command = owned;
            }
            if claim(format!("keybindings.{key}")) {
                candidate.keybindings.insert(key, action);
            }
        }
        let mut dropped_contexts = false;
        for mut context in self.key_contexts {
            context.keys.retain(|_, binding| match &mut binding.action {
                ModKeyAction::Focus { focus } => composed.contains(focus),
                ModKeyAction::Command { command, .. } => owned_command(id, command)
                    .map(|owned| *command = owned)
                    .is_some(),
                _ => true,
            });
            let keys = candidate
                .key_contexts
                .iter()
                .map(|context| context.keys.len())
                .sum::<usize>();
            if context.keys.is_empty() {
                continue;
            }
            if candidate.key_contexts.len() >= 16 || keys + context.keys.len() > 128 {
                dropped_contexts = true;
                continue;
            }
            context.owner = id.to_owned();
            candidate.key_contexts.push(context);
        }
        let room = 4usize.saturating_sub(candidate.status.len());
        if !self.status.is_empty() && candidate.status.is_empty() || self.status.len() > room {
            claim("status".into());
        }
        candidate.status.extend(self.status.into_iter().take(room));
        self.theme
            .glyphs
            .retain(|glyph, _| claim(format!("theme.glyphs.{glyph}")));
        self.theme.apply(&mut candidate.theme);
        ModView::parse_with(serde_json::to_value(&candidate)?, MOD_COMPOSED_KEY_LIMIT)?;
        *target = candidate;
        *claims = candidate_claims;
        if dropped_contexts {
            conflicts.push(ModViewConflict {
                field: "key_contexts".into(),
                owner: target
                    .key_contexts
                    .iter()
                    .rev()
                    .find(|context| context.owner != id)
                    .map(|context| context.owner.clone())
                    .unwrap_or_default(),
                rejected: id.to_owned(),
                origin: origin.to_owned(),
            });
        }
        Ok(conflicts)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ModViewConflict {
    pub field: String,
    pub owner: String,
    pub rejected: String,
    pub origin: String,
}

impl ModView {
    pub fn parse(value: Value) -> Result<Self> {
        Self::parse_with(value, MOD_KEY_LIMIT)
    }

    pub(super) fn close_wraps(&mut self) {
        for site in self.sites.values_mut() {
            if site.mode == ModSiteMode::Wrap {
                site.mode = ModSiteMode::Replace;
                site.components = replace_slot(std::mem::take(&mut site.components), &[]);
            }
        }
    }

    /// Each mod's view or patch keeps 24 keys; the view composed from every mod may hold more.
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
                "sidebar_style",
                view.sidebar_style
                    .as_ref()
                    .is_some_and(|style| !style.still()),
            ),
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
                "header",
                view.header.as_ref().is_some_and(|panel| !panel.valid(3)),
            ),
            (
                "footer",
                view.footer.as_ref().is_some_and(|panel| !panel.valid(3)),
            ),
            ("status", !valid_status(&view.status)),
            ("keybindings", !valid_bindings(&view.keybindings, key_limit)),
            ("key_contexts", !valid_contexts(&view.key_contexts, 16, 128)),
            ("keybindings.focus", !valid_focus_targets(&view)),
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
                "surface_styles",
                !valid_surface_styles(&view.surface_styles),
            ),
            (
                "underlay",
                view.underlay
                    .as_ref()
                    .is_some_and(|underlay| !mod_component_id(&underlay.raster)),
            ),
            ("size", serde_json::to_vec(&view)?.len() > 1_048_576),
        ]
        .into_iter()
        .find_map(|(field, invalid)| invalid.then(|| field.to_owned()))
        .or_else(|| invalid_sites(&view.sites));
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
            || snapshot.errors.len() > 16
            || snapshot
                .errors
                .iter()
                .any(|(source, error)| !visible(source, 512) || !visible(error, 512))
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
