use super::*;
use pretty_assertions::assert_eq;

fn rows(buffer: &Buffer, area: Rect) -> String {
    (0..area.height)
        .map(|y| {
            (0..area.width)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn snapshot(value: serde_json::Value) -> ModViewSnapshot {
    ModViewSnapshot {
        view: ModView::parse(value).unwrap(),
        ..ModViewSnapshot::default()
    }
}

#[test]
#[serial_test::serial]
fn custom_panel_reserves_space_and_narrow_terminal_preserves_native_composer() {
    let snapshot = snapshot(
        serde_json::json!({"title":"Workspace","sidebar_width":30,"panels":[{"title":"Worker","lines":["running"]}]}),
    );
    let area = Rect::new(0, 0, 90, 8);
    let chat = chat_area(area, &snapshot, header_rows(area.height, &snapshot));
    assert_eq!(chat, Rect::new(0, 0, 60, 8));
    let mut buffer = Buffer::empty(area);
    buffer[(1, 7)].set_symbol("X");
    render(area, chat, &mut buffer, &snapshot);
    assert_eq!(buffer[(1, 7)].symbol(), "X");
    assert_eq!(
        chat_area(Rect::new(0, 0, 40, 10), &snapshot, 0),
        Rect::new(0, 0, 40, 10)
    );
    insta::assert_snapshot!("mod_workspace_panel", rows(&buffer, area));
}

#[test]
#[serial_test::serial]
fn left_sidebar_header_progress_and_diagnostics_share_the_layout() {
    let mut snapshot = snapshot(serde_json::json!({
        "title":"Left","sidebar_side":"left","sidebar_width":24,
        "header":{"title":"Build","lines":["main · clean"]},
        "panels":[{"title":"Agents","lines":["2 running"]}]
    }));
    snapshot.progress = Some(ModPanel {
        title: "Echo".into(),
        lines: vec!["almost done".into()],
    });
    snapshot.diagnostics = vec!["Ctrl+t conflicts".into()];
    let area = Rect::new(0, 0, 90, 18);
    assert_eq!(header_rows(18, &snapshot), 3);
    assert_eq!(header_rows(12, &snapshot), 0);
    let chat = chat_area(area, &snapshot, header_rows(18, &snapshot));
    assert_eq!(chat, Rect::new(24, 3, 66, 15));
    let mut buffer = Buffer::empty(area);
    render(area, chat, &mut buffer, &snapshot);
    insta::assert_snapshot!("mod_left_sidebar_header", rows(&buffer, area));
    let short = Rect::new(0, 0, 90, 12);
    assert_eq!(
        chat_area(short, &snapshot, header_rows(12, &snapshot)),
        Rect::new(24, 0, 66, 12)
    );
}

#[test]
#[serial_test::serial]
fn native_escape_and_cancel_keys_cannot_be_intercepted() {
    let view = ModView::parse(serde_json::json!({"keybindings":{"F6":"draft","Ctrl+r":{"submit":"run"},"Alt+x":{"command":"counter:reset"}}})).unwrap();
    assert_eq!(
        action_for(&view, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
        None
    );
    assert_eq!(
        action_for(
            &view,
            KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)
        ),
        None
    );
    assert_eq!(
        action_for(&view, KeyEvent::new(KeyCode::F(6), KeyModifiers::NONE)),
        Some(("F6".to_string(), ModKeyAction::Draft("draft".into())))
    );
    assert_eq!(
        action_for(
            &view,
            KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL)
        ),
        Some((
            "Ctrl+r".to_string(),
            ModKeyAction::Submit {
                submit: "run".into()
            }
        ))
    );
    assert_eq!(
        action_for(&view, KeyEvent::new(KeyCode::Char('x'), KeyModifiers::ALT))
            .map(|(name, _)| name),
        Some("Alt+x".to_string())
    );
    assert_eq!(
        action_for(
            &view,
            KeyEvent::new(KeyCode::Char('x'), KeyModifiers::ALT | KeyModifiers::SHIFT)
        ),
        None
    );
    assert_eq!(
        action_for(&view, KeyEvent::new(KeyCode::F(6), KeyModifiers::SHIFT)),
        None
    );
}

#[test]
#[serial_test::serial]
#[expect(
    clippy::disallowed_methods,
    reason = "The mod theme contract explicitly selects 256-color palette indices"
)]
fn theme_slots_map_indexed_and_rgb_colors() {
    let snapshot = snapshot(serde_json::json!({"theme":{"accent":81,"failure":"#ff0000"}}));
    let colors = colors(&snapshot);
    assert_eq!(colors[0], Some(Color::Indexed(81)));
    assert_eq!(colors[1], None);
    assert_eq!(
        colors[4],
        Some(crate::terminal_palette::best_color((255, 0, 0)))
    );
}

#[test]
fn modal_preview_survives_stale_redraw_but_yields_to_recovery() {
    let mut preview = snapshot(serde_json::json!({
        "sites":{"dialog":{"components":[{
            "type":"dialog","id":"settings","label":"Settings","title":"Settings","children":[]
        }]}}
    }));
    preview.epoch = 7;
    preview.revision = 4;
    preview.owner = Some("workspace".into());
    let mut stale = snapshot(serde_json::json!({}));
    stale.epoch = 7;
    stale.revision = 5;
    stale.owner = Some("workspace".into());
    assert!(preserve_preview(&preview, &stale));
    stale.view.panels.push(codex_omd::ModPanel {
        title: "Mod errors".into(),
        lines: vec!["workspace failed".into()],
    });
    assert!(!preserve_preview(&preview, &stale));
}

#[test]
#[serial_test::serial]
fn components_preserve_focus_scroll_and_values_across_redraw_and_resize() {
    let snapshot = snapshot(serde_json::json!({
        "title":"Components",
        "theme":{"density":"compact","icons":"ascii","border":"double"},
        "sites":{"dialog":{"components":[{
            "type":"dialog","id":"settings","label":"Settings dialog","title":"Settings","children":[
                {"type":"text","id":"intro","label":"Introduction","text":"Configure the workspace","tone":"accent"},
                {"type":"input","id":"review","label":"Review input","value":"seed","placeholder":"Review","action":{"command":"workspace:layout","args":"review"}},
                {"type":"select","id":"side","label":"Sidebar side","value":"left","options":[{"value":"left","label":"Left"},{"value":"right","label":"Right"}],"action":{"command":"workspace:layout","args":"side"}},
                {"type":"button","id":"copy","label":"Copy shortcuts","text":"Copy","action":{"copy":"F8 settings","label":"workspace shortcuts"}},
                {"type":"pane","id":"details","label":"Details pane","title":"Details","children":[{"type":"markdown","id":"help","label":"Help","text":"**Keyboard** help"},{"type":"code","id":"sample","label":"Code sample","text":"const ok = true;","language":"typescript"}]}
            ]
        }]}}
    }));
    assert!(dialog_visible(&snapshot));
    sync_interaction(&snapshot.view);
    let area = Rect::new(0, 0, 80, 24);
    let mut buffer = Buffer::empty(area);
    render(area, area, &mut buffer, &snapshot);
    assert_eq!(
        INTERACTION
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .focused
            .as_deref(),
        Some("review")
    );
    assert!(matches!(
        input(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE)),
        Some(ModInput::Consumed)
    ));
    match input(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)) {
        Some(ModInput::Interaction(name, ModKeyAction::Command { command, args })) => {
            assert_eq!(name, "Review input");
            assert_eq!(command, "workspace:layout");
            assert_eq!(args, "review seedx");
        }
        _ => panic!("input activation missing"),
    }
    assert!(focus("side"));
    assert!(matches!(
        input(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE)),
        Some(ModInput::Consumed)
    ));
    match input(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)) {
        Some(ModInput::Interaction(_, ModKeyAction::Command { args, .. })) => {
            assert_eq!(args, "side right");
        }
        _ => panic!("select activation missing"),
    }
    assert!(focus("details"));
    assert!(matches!(
        input(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)),
        Some(ModInput::Consumed)
    ));
    sync_interaction(&snapshot.view);
    let interaction = INTERACTION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert_eq!(interaction.focused.as_deref(), Some("details"));
    assert_eq!(interaction.input_values["review"], "seedx");
    assert_eq!(interaction.selected["side"], 1);
    assert_eq!(interaction.scroll["details"], 1);
    drop(interaction);

    let copy = INTERACTION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .hitboxes
        .iter()
        .find(|hitbox| hitbox.id == "copy")
        .cloned()
        .unwrap();
    let down = MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: copy.area.x,
        row: copy.area.y,
        modifiers: KeyModifiers::NONE,
    };
    assert!(matches!(pointer(down), Some(ModPointer::Consumed)));
    let up = MouseEvent {
        kind: MouseEventKind::Up(MouseButton::Left),
        ..down
    };
    match pointer(up) {
        Some(ModPointer::Action(name, ModKeyAction::Copy { copy, label })) => {
            assert_eq!(name, "Copy shortcuts");
            assert_eq!(copy, "F8 settings");
            assert_eq!(label, "workspace shortcuts");
        }
        _ => panic!("pointer activation missing"),
    }
    assert_eq!(border_type(&snapshot.view.theme), BorderType::Plain);
    let narrow = Rect::new(0, 0, 40, 12);
    render(narrow, narrow, &mut Buffer::empty(narrow), &snapshot);
}
