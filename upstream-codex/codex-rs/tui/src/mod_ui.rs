use codex_omd::ModActivity;
use codex_omd::ModBorder;
use codex_omd::ModColor;
use codex_omd::ModCommandAction;
use codex_omd::ModCompletedTools;
use codex_omd::ModComponent;
use codex_omd::ModComponentAction;
use codex_omd::ModDensity;
use codex_omd::ModIcons;
use codex_omd::ModKeyAction;
use codex_omd::ModPanel;
use codex_omd::ModRenderSite;
use codex_omd::ModSidebarSide;
use codex_omd::ModTheme;
use codex_omd::ModTone;
use codex_omd::ModView;
use codex_omd::ModViewSnapshot;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::widgets::Block;
use ratatui::widgets::BorderType;
use ratatui::widgets::Borders;
use ratatui::widgets::Clear;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Widget;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Mutex;
use std::sync::RwLock;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ThemeSlot {
    Accent,
    UserMessageBackground,
    Success,
    Attention,
    Failure,
    DiffAdded,
    DiffRemoved,
    Muted,
}

#[derive(Default)]
struct Cache {
    snapshot: ModViewSnapshot,
    terminal: bool,
    colors: [Option<Color>; 8],
    seen: Option<(u64, u64)>,
    preview: bool,
}

#[derive(Clone)]
enum ComponentTarget {
    Button(ModComponentAction),
    Input(ModCommandAction),
    Select {
        action: ModCommandAction,
        options: Vec<(String, String)>,
    },
    Pane,
}

#[derive(Clone)]
struct HitBox {
    id: String,
    label: String,
    area: Rect,
    target: ComponentTarget,
}

#[derive(Default)]
struct Interaction {
    focused: Option<String>,
    ids: BTreeSet<String>,
    targets: BTreeMap<String, ComponentTarget>,
    order: Vec<String>,
    hitboxes: Vec<HitBox>,
    input_values: BTreeMap<String, String>,
    selected: BTreeMap<String, usize>,
    collapsed: BTreeMap<String, bool>,
    scroll: BTreeMap<String, u16>,
}

struct ComponentRow {
    id: Option<String>,
    label: Option<String>,
    line: Line<'static>,
    target: Option<ComponentTarget>,
}

pub(crate) enum ModInput {
    Consumed,
    Interaction(String, ModKeyAction),
    Binding(String, ModKeyAction),
}

pub(crate) enum ModPointer {
    Consumed,
    Action(String, ModKeyAction),
}

static CACHE: RwLock<Option<Cache>> = RwLock::new(None);
static INTERACTION: Mutex<Interaction> = Mutex::new(Interaction {
    focused: None,
    ids: BTreeSet::new(),
    targets: BTreeMap::new(),
    order: Vec::new(),
    hitboxes: Vec::new(),
    input_values: BTreeMap::new(),
    selected: BTreeMap::new(),
    collapsed: BTreeMap::new(),
    scroll: BTreeMap::new(),
});
static APPLIED_SYNTAX: Mutex<Option<String>> = Mutex::new(None);
static WARNED: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub(crate) fn first_warning(key: &str) -> bool {
    let mut warned = WARNED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if warned.iter().any(|seen| seen == key) {
        return false;
    }
    warned.push(key.to_owned());
    true
}

pub(crate) fn sync_syntax_theme() -> Option<String> {
    let requested = syntax_theme();
    let mut applied = APPLIED_SYNTAX
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if *applied == requested {
        return None;
    }
    let previous = std::mem::replace(&mut *applied, requested.clone());
    match requested {
        Some(name) => match crate::render::highlight::resolve_theme_with_configured_home(&name) {
            Some(theme) => {
                crate::render::highlight::set_syntax_theme(theme);
                None
            }
            None => Some(format!(
                "Mod syntax theme '{name}' is not installed; keeping the configured theme"
            )),
        },
        None => {
            if previous.is_some()
                && let Some(theme) = crate::render::highlight::resolve_theme_with_configured_home(
                    &crate::render::highlight::configured_theme_name(),
                )
            {
                crate::render::highlight::set_syntax_theme(theme);
            }
            None
        }
    }
}

#[expect(
    clippy::disallowed_methods,
    reason = "The mod theme contract explicitly selects 256-color palette indices"
)]
pub(crate) fn color(color: ModColor) -> Color {
    match color {
        ModColor::Indexed(index) => Color::Indexed(index),
        ModColor::Rgb(red, green, blue) => crate::terminal_palette::best_color((red, green, blue)),
    }
}

fn slot_index(slot: ThemeSlot) -> usize {
    match slot {
        ThemeSlot::Accent => 0,
        ThemeSlot::UserMessageBackground => 1,
        ThemeSlot::Success => 2,
        ThemeSlot::Attention => 3,
        ThemeSlot::Failure => 4,
        ThemeSlot::DiffAdded => 5,
        ThemeSlot::DiffRemoved => 6,
        ThemeSlot::Muted => 7,
    }
}

pub(crate) fn colors(snapshot: &ModViewSnapshot) -> [Option<Color>; 8] {
    let theme = &snapshot.view.theme;
    [
        theme.accent,
        theme.user_message_background,
        theme.success,
        theme.attention,
        theme.failure,
        theme.diff_added,
        theme.diff_removed,
        theme.muted,
    ]
    .map(|slot| slot.map(color))
}

pub(crate) fn preserve_preview(preview: &ModViewSnapshot, incoming: &ModViewSnapshot) -> bool {
    (preview.epoch == incoming.epoch && preview.revision > incoming.revision)
        || (site(&preview.view, "dialog").is_some()
            && !incoming
                .view
                .panels
                .iter()
                .any(|panel| panel.title == "Mod errors"))
}

fn collect_component(component: &ModComponent, interaction: &mut Interaction) {
    match component {
        ModComponent::Box { id, children, .. } | ModComponent::Dialog { id, children, .. } => {
            interaction.ids.insert(id.clone());
            for child in children {
                collect_component(child, interaction);
            }
        }
        ModComponent::Pane {
            id,
            collapsed,
            scroll,
            children,
            ..
        } => {
            interaction.ids.insert(id.clone());
            interaction
                .collapsed
                .entry(id.clone())
                .or_insert(*collapsed);
            interaction.scroll.entry(id.clone()).or_insert(*scroll);
            for child in children {
                collect_component(child, interaction);
            }
        }
        ModComponent::Input { id, value, .. } => {
            interaction.ids.insert(id.clone());
            interaction
                .input_values
                .entry(id.clone())
                .or_insert_with(|| value.clone());
        }
        ModComponent::Select {
            id, value, options, ..
        } => {
            interaction.ids.insert(id.clone());
            let selected = options
                .iter()
                .position(|option| option.value == *value)
                .unwrap_or_default();
            interaction.selected.entry(id.clone()).or_insert(selected);
        }
        ModComponent::Text { id, .. }
        | ModComponent::Button { id, .. }
        | ModComponent::Markdown { id, .. }
        | ModComponent::Code { id, .. } => {
            interaction.ids.insert(id.clone());
        }
        ModComponent::Slot => {}
    }
}

fn sync_interaction(view: &ModView) {
    let mut interaction = INTERACTION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    interaction.ids.clear();
    for site in view.sites.values() {
        for component in &site.components {
            collect_component(component, &mut interaction);
        }
    }
    let ids = interaction.ids.clone();
    interaction.input_values.retain(|id, _| ids.contains(id));
    interaction.selected.retain(|id, _| ids.contains(id));
    interaction.collapsed.retain(|id, _| ids.contains(id));
    interaction.scroll.retain(|id, _| ids.contains(id));
    if interaction
        .focused
        .as_ref()
        .is_some_and(|id| !ids.contains(id))
    {
        interaction.focused = None;
    }
}

pub(crate) fn refresh() {
    let (terminal, snapshot) = crate::omd::mod_snapshot();
    {
        let cache = CACHE
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if cache.as_ref().is_some_and(|cache| {
            (terminal && snapshot.epoch == 0)
                || (cache.preview && preserve_preview(&cache.snapshot, &snapshot))
        }) {
            return;
        }
    }
    sync_interaction(&snapshot.view);
    let mut cache = CACHE
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let seen = cache.as_ref().and_then(|cache| cache.seen).or_else(|| {
        Some((
            snapshot.epoch,
            snapshot
                .activity
                .iter()
                .map(|activity| activity.sequence)
                .max()
                .unwrap_or_default(),
        ))
    });
    *cache = Some(Cache {
        colors: colors(&snapshot),
        snapshot,
        terminal,
        seen,
        preview: false,
    });
}

pub(crate) fn preview(snapshot: ModViewSnapshot) {
    sync_interaction(&snapshot.view);
    let mut cache = CACHE
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let seen = cache.as_ref().and_then(|cache| cache.seen);
    *cache = Some(Cache {
        colors: colors(&snapshot),
        snapshot,
        terminal: true,
        seen,
        preview: true,
    });
}

fn with_cache<T>(read: impl FnOnce(&Cache) -> T) -> Option<T> {
    let cache = CACHE
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache.as_ref().map(read)
}

pub(crate) fn theme_color(slot: ThemeSlot) -> Option<Color> {
    if matches!(
        crate::terminal_palette::effective_stdout_color_level(),
        crate::terminal_palette::StdoutColorLevel::Unknown
    ) {
        return None;
    }
    with_cache(|cache| cache.colors[slot_index(slot)]).flatten()
}

pub(crate) fn syntax_theme() -> Option<String> {
    with_cache(|cache| cache.snapshot.view.theme.syntax.clone()).flatten()
}

pub(crate) fn status_segments() -> Vec<String> {
    with_cache(|cache| cache.snapshot.view.status.clone()).unwrap_or_default()
}

pub(crate) fn completed_tools() -> ModCompletedTools {
    with_cache(|cache| cache.snapshot.view.completed_tools).unwrap_or_default()
}

pub(crate) fn take_new_activity() -> Vec<ModActivity> {
    let mut cache = CACHE
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(cache) = cache.as_mut() else {
        return Vec::new();
    };
    if !cache.terminal {
        return Vec::new();
    }
    let (epoch, last) = cache.seen.unwrap_or_default();
    let last = if epoch == cache.snapshot.epoch {
        last
    } else {
        0
    };
    let fresh = cache
        .snapshot
        .activity
        .iter()
        .filter(|activity| activity.sequence > last)
        .cloned()
        .collect::<Vec<_>>();
    let newest = fresh
        .iter()
        .map(|activity| activity.sequence)
        .max()
        .unwrap_or(last);
    cache.seen = Some((cache.snapshot.epoch, newest));
    fresh
}

pub(crate) fn snapshot() -> ModViewSnapshot {
    if !crate::omd::fullscreen_active() {
        return ModViewSnapshot::default();
    }
    with_cache(|cache| cache.snapshot.clone()).unwrap_or_default()
}

pub(crate) fn view() -> ModView {
    snapshot().view
}

pub(crate) fn dialog_visible(snapshot: &ModViewSnapshot) -> bool {
    site(&snapshot.view, "dialog").is_some_and(|dialog| !dialog.components.is_empty())
}

fn sidebar_panels(snapshot: &ModViewSnapshot) -> Vec<ModPanel> {
    let mut panels = snapshot.view.panels.clone();
    if let Some(progress) = &snapshot.progress {
        panels.push(ModPanel {
            title: format!("Progress · {}", progress.title),
            lines: progress.lines.clone(),
        });
    }
    if !snapshot.diagnostics.is_empty() {
        panels.push(ModPanel {
            title: "Mod diagnostics".into(),
            lines: snapshot.diagnostics.clone(),
        });
    }
    panels
}

fn site<'a>(view: &'a ModView, name: &str) -> Option<&'a ModRenderSite> {
    view.sites.get(name)
}

fn component_height(components: &[ModComponent]) -> u16 {
    components
        .iter()
        .map(|component| match component {
            ModComponent::Box { children, .. } | ModComponent::Dialog { children, .. } => {
                1 + component_height(children)
            }
            ModComponent::Pane {
                collapsed,
                children,
                ..
            } => {
                if *collapsed {
                    1
                } else {
                    1 + component_height(children).min(8)
                }
            }
            ModComponent::Text { text, .. }
            | ModComponent::Markdown { text, .. }
            | ModComponent::Code { text, .. } => {
                u16::try_from(text.lines().count().max(1)).unwrap_or(u16::MAX)
            }
            ModComponent::Button { .. }
            | ModComponent::Input { .. }
            | ModComponent::Select { .. } => 1,
            ModComponent::Slot => 0,
        })
        .sum()
}

pub(crate) fn header_rows(screen_height: u16, snapshot: &ModViewSnapshot) -> u16 {
    if screen_height < 16 {
        return 0;
    }
    if let Some(header) = site(&snapshot.view, "header") {
        return component_height(&header.components).clamp(1, 4) + 1;
    }
    match &snapshot.view.header {
        Some(header) => u16::try_from(header.lines.len()).unwrap_or(3).min(3) + 2,
        None => 0,
    }
}

fn has_sidebar(snapshot: &ModViewSnapshot) -> bool {
    site(&snapshot.view, "sidebar").is_some_and(|site| !site.components.is_empty())
        || !sidebar_panels(snapshot).is_empty()
}

fn sidebar(area: Rect, snapshot: &ModViewSnapshot) -> Option<Rect> {
    if area.width < 80 || !has_sidebar(snapshot) {
        return None;
    }
    let width = snapshot
        .view
        .sidebar_width
        .clamp(20, 60)
        .min(area.width / 3);
    Some(match snapshot.view.sidebar_side {
        ModSidebarSide::Left => Rect { width, ..area },
        ModSidebarSide::Right => Rect {
            x: area.right() - width,
            width,
            ..area
        },
    })
}

fn column(area: Rect, snapshot: &ModViewSnapshot) -> Rect {
    match sidebar(area, snapshot) {
        Some(bar) if snapshot.view.sidebar_side == ModSidebarSide::Left => Rect {
            x: bar.right(),
            width: area.width - bar.width,
            ..area
        },
        Some(bar) => Rect {
            width: area.width - bar.width,
            ..area
        },
        None => area,
    }
}

pub(crate) fn chat_area(area: Rect, snapshot: &ModViewSnapshot, header: u16) -> Rect {
    let column = column(area, snapshot);
    let header = header.min(area.height.saturating_sub(1));
    Rect {
        y: column.y + header,
        height: column.height.saturating_sub(header),
        ..column
    }
}

fn panel_style(view: &ModView) -> Style {
    let mut style = Style::default();
    if let Some(index) = view.foreground {
        style = style.fg(color(ModColor::Indexed(index)));
    }
    if let Some(index) = view.background {
        style = style.bg(color(ModColor::Indexed(index)));
    }
    style
}

fn tone_style(tone: ModTone) -> Style {
    let slot = match tone {
        ModTone::Normal => return Style::default(),
        ModTone::Accent => ThemeSlot::Accent,
        ModTone::Success => ThemeSlot::Success,
        ModTone::Attention => ThemeSlot::Attention,
        ModTone::Failure => ThemeSlot::Failure,
        ModTone::Muted => ThemeSlot::Muted,
    };
    theme_color(slot)
        .map(|color| Style::default().fg(color))
        .unwrap_or_else(|| match tone {
            ModTone::Success => Style::default().fg(Color::Green),
            ModTone::Failure => Style::default().fg(Color::Red),
            ModTone::Attention => Style::default().fg(Color::Yellow),
            ModTone::Muted => Style::default().dim(),
            _ => Style::default(),
        })
}

fn panel_lines(panel: &ModPanel) -> Vec<Line<'static>> {
    std::iter::once(Line::from(panel.title.clone()).bold())
        .chain(panel.lines.iter().cloned().map(Line::from))
        .collect()
}

fn component_action(action: &ModComponentAction) -> ModKeyAction {
    match action {
        ModComponentAction::Command(action) => ModKeyAction::Command {
            command: action.command.clone(),
            args: action.args.clone(),
        },
        ModComponentAction::Copy { copy, label } => ModKeyAction::Copy {
            copy: copy.clone(),
            label: label.clone(),
        },
    }
}

fn component_rows(
    components: &[ModComponent],
    width: u16,
    interaction: &mut Interaction,
    indent: usize,
) -> Vec<ComponentRow> {
    let mut rows = Vec::new();
    let prefix = " ".repeat(indent);
    for component in components {
        match component {
            ModComponent::Box {
                title, children, ..
            } => {
                if let Some(title) = title {
                    rows.push(ComponentRow {
                        id: None,
                        label: None,
                        line: Line::from(format!("{prefix}{title}")).bold(),
                        target: None,
                    });
                }
                rows.extend(component_rows(children, width, interaction, indent + 1));
            }
            ModComponent::Text {
                id,
                label,
                text,
                tone,
            } => {
                for (index, text) in text.lines().enumerate() {
                    rows.push(ComponentRow {
                        id: (index == 0).then(|| id.clone()),
                        label: (index == 0).then(|| label.clone()),
                        line: Line::from(format!("{prefix}{text}")).patch_style(tone_style(*tone)),
                        target: None,
                    });
                }
            }
            ModComponent::Button {
                id,
                label,
                text,
                action,
            } => rows.push(ComponentRow {
                id: Some(id.clone()),
                label: Some(label.clone()),
                line: Line::from(format!("{prefix}[ {text} ]")),
                target: Some(ComponentTarget::Button(action.clone())),
            }),
            ModComponent::Input {
                id,
                label,
                value,
                placeholder,
                action,
            } => {
                let current = interaction
                    .input_values
                    .entry(id.clone())
                    .or_insert_with(|| value.clone());
                let shown = if current.is_empty() {
                    placeholder
                } else {
                    current
                };
                rows.push(ComponentRow {
                    id: Some(id.clone()),
                    label: Some(label.clone()),
                    line: Line::from(format!("{prefix}{label}: {shown}")),
                    target: Some(ComponentTarget::Input(action.clone())),
                });
            }
            ModComponent::Select {
                id,
                label,
                value,
                options,
                action,
            } => {
                let fallback = options
                    .iter()
                    .position(|option| option.value == *value)
                    .unwrap_or_default();
                let selected = interaction.selected.entry(id.clone()).or_insert(fallback);
                *selected = (*selected).min(options.len().saturating_sub(1));
                let shown = options
                    .get(*selected)
                    .map(|option| option.label.as_str())
                    .unwrap_or("—");
                rows.push(ComponentRow {
                    id: Some(id.clone()),
                    label: Some(label.clone()),
                    line: Line::from(format!("{prefix}{label}: ‹ {shown} ›")),
                    target: Some(ComponentTarget::Select {
                        action: action.clone(),
                        options: options
                            .iter()
                            .map(|option| (option.value.clone(), option.label.clone()))
                            .collect(),
                    }),
                });
            }
            ModComponent::Markdown { id, label, text } => {
                let mut rendered = Vec::new();
                crate::markdown::append_markdown(
                    text,
                    Some(usize::from(
                        width.saturating_sub(u16::try_from(indent).unwrap_or(0)),
                    )),
                    None,
                    &mut rendered,
                );
                for (index, line) in rendered.into_iter().enumerate() {
                    rows.push(ComponentRow {
                        id: (index == 0).then(|| id.clone()),
                        label: (index == 0).then(|| label.clone()),
                        line,
                        target: None,
                    });
                }
            }
            ModComponent::Code {
                id,
                label,
                text,
                language,
            } => {
                if let Some(language) = language {
                    rows.push(ComponentRow {
                        id: Some(id.clone()),
                        label: Some(label.clone()),
                        line: Line::from(format!("{prefix}{language}")).dim(),
                        target: None,
                    });
                }
                for line in text.lines() {
                    rows.push(ComponentRow {
                        id: None,
                        label: None,
                        line: Line::from(format!("{prefix}{line}")).cyan(),
                        target: None,
                    });
                }
            }
            ModComponent::Pane {
                id,
                label,
                title,
                collapsed,
                scroll,
                children,
            } => {
                let collapsed = interaction
                    .collapsed
                    .entry(id.clone())
                    .or_insert(*collapsed);
                let marker = if *collapsed {
                    if crate::omd::ligatures_enabled() {
                        "▸"
                    } else {
                        ">"
                    }
                } else if crate::omd::ligatures_enabled() {
                    "▾"
                } else {
                    "v"
                };
                rows.push(ComponentRow {
                    id: Some(id.clone()),
                    label: Some(label.clone()),
                    line: Line::from(format!(
                        "{prefix}{marker} {}",
                        title.as_deref().unwrap_or(label)
                    ))
                    .bold(),
                    target: Some(ComponentTarget::Pane),
                });
                if !*collapsed {
                    let nested = component_rows(children, width, interaction, indent + 1);
                    let offset =
                        usize::from(*interaction.scroll.entry(id.clone()).or_insert(*scroll))
                            .min(nested.len().saturating_sub(1));
                    rows.extend(nested.into_iter().skip(offset).take(8));
                }
            }
            ModComponent::Dialog {
                title, children, ..
            } => {
                rows.push(ComponentRow {
                    id: None,
                    label: None,
                    line: Line::from(format!("{prefix}{title}")).bold(),
                    target: None,
                });
                rows.extend(component_rows(children, width, interaction, indent));
            }
            ModComponent::Slot => {}
        }
    }
    rows
}

fn render_site(
    area: Rect,
    components: &[ModComponent],
    style: Style,
    buffer: &mut Buffer,
    interaction: &mut Interaction,
    block: Option<Block<'static>>,
    comfortable_spacing: bool,
) {
    if area.is_empty() {
        return;
    }
    let inner = block
        .as_ref()
        .map(|block| block.inner(area))
        .unwrap_or(area);
    let rows = component_rows(components, inner.width.max(1), interaction, 0);
    let rows = if comfortable_spacing
        && with_cache(|cache| cache.snapshot.view.theme.density) == Some(ModDensity::Comfortable)
    {
        rows.into_iter()
            .flat_map(|row| {
                [
                    row,
                    ComponentRow {
                        id: None,
                        label: None,
                        line: Line::from(""),
                        target: None,
                    },
                ]
            })
            .collect::<Vec<_>>()
    } else {
        rows
    };
    let lines = rows.iter().map(|row| row.line.clone()).collect::<Vec<_>>();
    let paragraph = Paragraph::new(lines).style(style);
    match block {
        Some(block) => paragraph.block(block).render(area, buffer),
        None => paragraph.render(area, buffer),
    }
    for (index, row) in rows.into_iter().enumerate() {
        let Some(target) = row.target else {
            continue;
        };
        let Ok(offset) = u16::try_from(index) else {
            continue;
        };
        if offset >= inner.height {
            break;
        }
        let id = row.id.unwrap_or_default();
        let label = row.label.unwrap_or_else(|| id.clone());
        interaction.targets.insert(id.clone(), target.clone());
        if !interaction.order.contains(&id) {
            interaction.order.push(id.clone());
        }
        interaction.hitboxes.push(HitBox {
            id,
            label,
            area: Rect::new(inner.x, inner.y + offset, inner.width, 1),
            target,
        });
    }
}

fn border_type(theme: &ModTheme) -> BorderType {
    if !crate::omd::ligatures_enabled() || theme.icons == ModIcons::Ascii {
        return BorderType::Plain;
    }
    match theme.border {
        ModBorder::Plain => BorderType::Plain,
        ModBorder::Rounded => BorderType::Rounded,
        ModBorder::Double => BorderType::Double,
    }
}

pub(crate) fn render(area: Rect, chat: Rect, buffer: &mut Buffer, snapshot: &ModViewSnapshot) {
    let style = panel_style(&snapshot.view);
    let mut interaction = INTERACTION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    interaction.targets.clear();
    interaction.order.clear();
    interaction.hitboxes.clear();
    if let Some(bar) = sidebar(area, snapshot) {
        let mut components = site(&snapshot.view, "sidebar")
            .map(|site| site.components.clone())
            .unwrap_or_default();
        for (index, panel) in sidebar_panels(snapshot).into_iter().enumerate() {
            components.push(ModComponent::Pane {
                id: format!("@native_panel_{index}"),
                label: panel.title.clone(),
                title: Some(panel.title),
                collapsed: false,
                scroll: 0,
                children: panel
                    .lines
                    .into_iter()
                    .enumerate()
                    .map(|(line, text)| ModComponent::Text {
                        id: format!("@native_panel_{index}_{line}"),
                        label: format!("Native panel line {}", line + 1),
                        text,
                        tone: ModTone::Normal,
                    })
                    .collect(),
            });
        }
        let borders = match snapshot.view.sidebar_side {
            ModSidebarSide::Left => Borders::RIGHT,
            ModSidebarSide::Right => Borders::LEFT,
        };
        let block = Block::default()
            .borders(borders)
            .border_type(border_type(&snapshot.view.theme))
            .title(snapshot.view.title.clone().unwrap_or_else(|| "Mods".into()));
        render_site(
            bar,
            &components,
            style,
            buffer,
            &mut interaction,
            Some(block),
            true,
        );
    }
    let column = column(area, snapshot);
    let height = chat.y.saturating_sub(column.y);
    if height > 0 {
        if let Some(header) = site(&snapshot.view, "header") {
            render_site(
                Rect { height, ..column },
                &header.components,
                style,
                buffer,
                &mut interaction,
                Some(Block::default().borders(Borders::BOTTOM)),
                true,
            );
        } else if let Some(header) = &snapshot.view.header {
            Paragraph::new(panel_lines(header))
                .style(style)
                .block(Block::default().borders(Borders::BOTTOM))
                .render(Rect { height, ..column }, buffer);
        }
    }
    if let Some(dialog) = site(&snapshot.view, "dialog")
        && !dialog.components.is_empty()
        && area.width >= 48
        && area.height >= 14
    {
        let dialog_start = interaction.order.len();
        let width = area.width.saturating_sub(8).min(76);
        let height = component_height(&dialog.components)
            .saturating_add(2)
            .clamp(8, area.height.saturating_sub(4));
        let dialog_area = Rect::new(
            area.x + (area.width - width) / 2,
            area.y + (area.height - height) / 2,
            width,
            height,
        );
        Clear.render(dialog_area, buffer);
        render_site(
            dialog_area,
            &dialog.components,
            style,
            buffer,
            &mut interaction,
            Some(
                Block::default()
                    .borders(Borders::ALL)
                    .border_type(border_type(&snapshot.view.theme))
                    .title("Oh My Diff"),
            ),
            false,
        );
        let dialog_order = interaction.order[dialog_start..].to_vec();
        let dialog_ids = dialog_order.iter().cloned().collect::<BTreeSet<_>>();
        interaction.order = dialog_order;
        interaction.targets.retain(|id, _| dialog_ids.contains(id));
        interaction
            .hitboxes
            .retain(|hitbox| dialog_ids.contains(&hitbox.id));
        if interaction
            .focused
            .as_ref()
            .is_none_or(|focused| !dialog_ids.contains(focused))
        {
            interaction.focused = interaction.order.first().cloned();
        }
    }
    if let Some(focused) = interaction.focused.clone()
        && let Some(hitbox) = interaction
            .hitboxes
            .iter()
            .find(|hitbox| hitbox.id == focused)
    {
        buffer.set_style(hitbox.area, crate::style::accent_style());
    }
}

pub(crate) fn footer_lines(width: u16) -> Vec<Line<'static>> {
    let snapshot = snapshot();
    let style = panel_style(&snapshot.view);
    if let Some(site) = site(&snapshot.view, "above_composer") {
        let mut interaction = INTERACTION
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        return component_rows(&site.components, width, &mut interaction, 0)
            .into_iter()
            .map(|row| row.line.patch_style(style))
            .collect();
    }
    let Some(footer) = &snapshot.view.footer else {
        return Vec::new();
    };
    panel_lines(footer)
        .into_iter()
        .map(|line| line.patch_style(style))
        .collect()
}

pub(crate) fn key_name(key: KeyEvent) -> Option<String> {
    if key.kind != KeyEventKind::Press {
        return None;
    }
    match (key.code, key.modifiers) {
        (KeyCode::F(number @ 2..=12), KeyModifiers::NONE) => Some(format!("F{number}")),
        (KeyCode::Char(letter), KeyModifiers::CONTROL) if letter.is_ascii_alphabetic() => {
            Some(format!("Ctrl+{}", letter.to_ascii_lowercase()))
        }
        (KeyCode::Char(letter), KeyModifiers::ALT) if letter.is_ascii_lowercase() => {
            Some(format!("Alt+{letter}"))
        }
        _ => None,
    }
}

pub(crate) fn action_for(view: &ModView, key: KeyEvent) -> Option<(String, ModKeyAction)> {
    let name = key_name(key)?;
    if !codex_omd::mod_key_name(&name) {
        return None;
    }
    let action = view.keybindings.get(&name).cloned()?;
    Some((name, action))
}

fn command_action(action: &ModCommandAction, value: Option<&str>) -> ModKeyAction {
    let args = match value {
        Some(value) if action.args.is_empty() => value.to_owned(),
        Some(value) => format!("{} {value}", action.args),
        None => action.args.clone(),
    };
    ModKeyAction::Command {
        command: action.command.clone(),
        args,
    }
}

fn activate_target(
    id: &str,
    label: &str,
    target: &ComponentTarget,
    interaction: &mut Interaction,
) -> Option<ModInput> {
    match target {
        ComponentTarget::Button(action) => Some(ModInput::Interaction(
            label.to_owned(),
            component_action(action),
        )),
        ComponentTarget::Input(action) => {
            let value = interaction.input_values.get(id).map(String::as_str);
            Some(ModInput::Interaction(
                label.to_owned(),
                command_action(action, value),
            ))
        }
        ComponentTarget::Select { action, options } => {
            let selected = *interaction.selected.get(id).unwrap_or(&0);
            let value = options.get(selected).map(|option| option.0.as_str());
            Some(ModInput::Interaction(
                label.to_owned(),
                command_action(action, value),
            ))
        }
        ComponentTarget::Pane => {
            let collapsed = interaction.collapsed.entry(id.to_owned()).or_default();
            *collapsed = !*collapsed;
            Some(ModInput::Consumed)
        }
    }
}

pub(crate) fn focus(id: &str) -> bool {
    let mut interaction = INTERACTION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !interaction.ids.contains(id) {
        return false;
    }
    interaction.focused = Some(id.to_owned());
    true
}

pub(crate) fn input(key: KeyEvent) -> Option<ModInput> {
    if key.kind != KeyEventKind::Press {
        return None;
    }
    let mut interaction = INTERACTION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if matches!(
        (key.code, key.modifiers),
        (KeyCode::Tab, KeyModifiers::NONE) | (KeyCode::BackTab, KeyModifiers::SHIFT)
    ) && interaction.focused.is_none()
        && !interaction.order.is_empty()
    {
        interaction.focused = if key.code == KeyCode::BackTab {
            interaction.order.last().cloned()
        } else {
            interaction.order.first().cloned()
        };
        return Some(ModInput::Consumed);
    }
    if let Some(focused) = interaction.focused.clone()
        && let Some(target) = interaction.targets.get(&focused).cloned()
    {
        match (key.code, key.modifiers) {
            (KeyCode::Tab, KeyModifiers::NONE) | (KeyCode::BackTab, KeyModifiers::SHIFT) => {
                let mut index = interaction
                    .order
                    .iter()
                    .position(|id| id == &focused)
                    .unwrap_or_default();
                if key.code == KeyCode::BackTab {
                    index = index
                        .checked_sub(1)
                        .unwrap_or(interaction.order.len().saturating_sub(1));
                } else if !interaction.order.is_empty() {
                    index = (index + 1) % interaction.order.len();
                }
                interaction.focused = interaction.order.get(index).cloned();
                return Some(ModInput::Consumed);
            }
            (KeyCode::Enter, KeyModifiers::NONE) => {
                let label = interaction
                    .hitboxes
                    .iter()
                    .find(|hitbox| hitbox.id == focused)
                    .map(|hitbox| hitbox.label.clone())
                    .unwrap_or_else(|| focused.clone());
                return activate_target(&focused, &label, &target, &mut interaction);
            }
            (KeyCode::Left | KeyCode::Up, KeyModifiers::NONE) => match target {
                ComponentTarget::Select { ref options, .. } => {
                    let selected = interaction.selected.entry(focused).or_default();
                    *selected = selected
                        .checked_sub(1)
                        .unwrap_or(options.len().saturating_sub(1));
                    return Some(ModInput::Consumed);
                }
                ComponentTarget::Pane => {
                    let scroll = interaction.scroll.entry(focused).or_default();
                    *scroll = scroll.saturating_sub(1);
                    return Some(ModInput::Consumed);
                }
                _ => {}
            },
            (KeyCode::Right | KeyCode::Down, KeyModifiers::NONE) => match target {
                ComponentTarget::Select { ref options, .. } => {
                    let selected = interaction.selected.entry(focused).or_default();
                    if !options.is_empty() {
                        *selected = (*selected + 1) % options.len();
                    }
                    return Some(ModInput::Consumed);
                }
                ComponentTarget::Pane => {
                    let scroll = interaction.scroll.entry(focused).or_default();
                    *scroll = scroll.saturating_add(1);
                    return Some(ModInput::Consumed);
                }
                _ => {}
            },
            (KeyCode::Backspace, KeyModifiers::NONE)
                if matches!(target, ComponentTarget::Input(_)) =>
            {
                interaction.input_values.entry(focused).or_default().pop();
                return Some(ModInput::Consumed);
            }
            (KeyCode::Char(character), KeyModifiers::NONE)
                if matches!(target, ComponentTarget::Input(_)) =>
            {
                let value = interaction.input_values.entry(focused).or_default();
                if value.len() < 1024 {
                    value.push(character);
                }
                return Some(ModInput::Consumed);
            }
            _ => {}
        }
    }
    with_cache(|cache| action_for(&cache.snapshot.view, key))
        .flatten()
        .map(|(name, action)| ModInput::Binding(name, action))
}

fn contains(area: Rect, column: u16, row: u16) -> bool {
    column >= area.x && column < area.right() && row >= area.y && row < area.bottom()
}

pub(crate) fn pointer(event: MouseEvent) -> Option<ModPointer> {
    let mut interaction = INTERACTION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let hit = interaction
        .hitboxes
        .iter()
        .find(|hitbox| contains(hitbox.area, event.column, event.row))
        .cloned();
    let Some(hit) = hit else {
        if matches!(event.kind, MouseEventKind::Down(MouseButton::Left)) {
            interaction.focused = None;
        }
        return None;
    };
    match event.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            interaction.focused = Some(hit.id);
            Some(ModPointer::Consumed)
        }
        MouseEventKind::Up(MouseButton::Left) => {
            interaction.focused = Some(hit.id.clone());
            activate_target(&hit.id, &hit.label, &hit.target, &mut interaction).map(|input| {
                match input {
                    ModInput::Consumed => ModPointer::Consumed,
                    ModInput::Interaction(name, action) | ModInput::Binding(name, action) => {
                        ModPointer::Action(name, action)
                    }
                }
            })
        }
        MouseEventKind::ScrollUp => {
            match hit.target {
                ComponentTarget::Select { ref options, .. } => {
                    let selected = interaction.selected.entry(hit.id).or_default();
                    *selected = selected
                        .checked_sub(1)
                        .unwrap_or(options.len().saturating_sub(1));
                }
                ComponentTarget::Pane => {
                    let scroll = interaction.scroll.entry(hit.id).or_default();
                    *scroll = scroll.saturating_sub(1);
                }
                _ => {}
            }
            Some(ModPointer::Consumed)
        }
        MouseEventKind::ScrollDown => {
            match hit.target {
                ComponentTarget::Select { ref options, .. } => {
                    let selected = interaction.selected.entry(hit.id).or_default();
                    if !options.is_empty() {
                        *selected = (*selected + 1) % options.len();
                    }
                }
                ComponentTarget::Pane => {
                    let scroll = interaction.scroll.entry(hit.id).or_default();
                    *scroll = scroll.saturating_add(1);
                }
                _ => {}
            }
            Some(ModPointer::Consumed)
        }
        _ => Some(ModPointer::Consumed),
    }
}

#[expect(
    clippy::disallowed_methods,
    reason = "The mod theme contract explicitly selects 256-color palette indices"
)]
pub(crate) fn history(
    kind: &str,
    lines: Vec<crate::terminal_hyperlinks::HyperlinkLine>,
) -> Vec<crate::terminal_hyperlinks::HyperlinkLine> {
    let view = view();
    let template = match kind {
        "message" => view.message_template,
        "tool" => view.tool_template,
        _ => None,
    };
    let Some(template) = template else {
        return lines;
    };
    crate::terminal_hyperlinks::plain_hyperlink_lines(
        lines
            .into_iter()
            .map(|line| {
                let text = line.line.to_string();
                let mut result = Line::from(template.replace("{text}", &text));
                if let Some(foreground) = view.foreground {
                    result = result.style(Style::default().fg(Color::Indexed(foreground)));
                }
                result
            })
            .collect(),
    )
}

#[cfg(test)]
#[path = "mod_ui_tests.rs"]
mod tests;
