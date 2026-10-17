use super::*;
use serde_json::json;

fn view(extra: Value) -> Result<ModView> {
    let mut value = json!({"title": "t"});
    value
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    ModView::parse(value)
}

#[test]
fn box_styles_are_bounded_and_render_hook_trees_refuse_them() {
    let still = json!({"border": "thick", "padding": [0, 4], "margin": 1, "gap": 2, "background": "accent",
        "foreground": "#c0ffee", "direction": "row"});
    let mut card = still.clone();
    card.as_object_mut().unwrap().extend(
        json!({"hover": {"border": "double", "background": 238}, "focus": {"foreground": "muted"}})
            .as_object()
            .unwrap()
            .clone(),
    );
    let pane = |style: Value, flex: Value| {
        json!({"sites": {"sidebar": {"components": [{"type": "pane", "id": "p", "label": "P", "style": style,
            "flex": flex, "min_width": 10, "max_width": 40, "pointer": true}]}}})
    };
    let parsed = view(pane(card.clone(), json!(12))).unwrap();
    let ModComponent::Pane { style, .. } = &parsed.sites["sidebar"].components[0] else {
        panic!("pane");
    };
    assert_eq!(
        style.unwrap().background,
        Some(ModPaint::Tone(ModTone::Accent))
    );
    assert_eq!(style.unwrap().padding.unwrap().axes(), (0, 4));
    assert!(
        view(json!({"sidebar_style": still.clone(), "layout": {"split": "horizontal", "gap": 4, "children": [
            {"content": "site:a/b", "style": still.clone()},
            {"split": "vertical", "children": [{"content": "transcript"}, {"content": "composer"}]}]},
            "sites": {"dialog": {"components": [{"type": "dialog", "id": "d", "label": "D", "title": "D", "style": still}]}}}))
        .is_ok()
    );
    for invalid in [
        pane(json!({"padding": 5}), json!(1)),
        pane(json!({"margin": [0, 5]}), json!(1)),
        pane(json!({"gap": 5}), json!(1)),
        pane(json!({"border": "dotted"}), json!(1)),
        pane(json!({"background": "#12"}), json!(1)),
        pane(json!({"hover": {"padding": 1}}), json!(1)),
        pane(json!({}), json!(0)),
        pane(json!({}), json!(13)),
        json!({"sidebar_style": {"gap": 9}}),
        json!({"sidebar_style": card.clone()}),
        json!({"sites": {"dialog": {"components": [{"type": "dialog", "id": "d", "label": "D", "title": "D", "style": card.clone()}]}}}),
        json!({"layout": {"split": "horizontal", "children": [{"content": "site:a/b", "style": card.clone()},
            {"split": "vertical", "children": [{"content": "transcript"}, {"content": "composer"}]}]}}),
        json!({"layout": {"split": "vertical", "gap": 5, "children": [{"content": "transcript"}, {"content": "composer"}]}}),
        json!({"layout": {"split": "vertical", "children": [{"content": "transcript", "style": {}}, {"content": "composer"}]}}),
    ] {
        assert!(view(invalid.clone()).is_err(), "{invalid}");
        assert!(ModViewPatch::parse(invalid).is_err());
    }
    let tree = |extra: Value| {
        let mut component =
            json!({"type": "box", "id": "b", "label": "B", "children": [{"type": "native"}]});
        component
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value::<Vec<ModComponent>>(json!([component])).unwrap()
    };
    assert_eq!(invalid_render_tree(&tree(json!({}))), None);
    assert!(invalid_render_tree(&tree(json!({"style": {"border": "plain"}}))).is_some());
    assert!(invalid_render_tree(&tree(json!({"flex": 2}))).is_some());
}

#[test]
fn welcome_and_header_presentation_are_bounded_and_greeting_overrides_compose() {
    let welcome = json!({"greeting":"", "session_title_suffix":" | Project tools",
        "welcome":{"show_while_composing":true},
        "sites":{"welcome":{"components":[{"type":"text","id":"guide","label":"Guide","text":"Start a project"}]}}});
    assert!(view(welcome.clone()).is_ok());
    for invalid in [
        json!({"greeting":"a\u{001b}[2J"}),
        json!({"greeting":"x".repeat(257)}),
        json!({"session_title_suffix":"x".repeat(81)}),
        json!({"welcome":{"unknown":true}}),
    ] {
        assert!(view(invalid.clone()).is_err(), "{invalid}");
        assert!(ModViewPatch::parse(invalid).is_err());
    }
    let mut target = ModView::default();
    let mut claims = BTreeMap::new();
    ModViewPatch::parse(welcome)
        .unwrap()
        .apply(&mut target, &mut claims, "first", "idle")
        .unwrap();
    ModViewPatch::parse(json!({"greeting":"Ready to work?"}))
        .unwrap()
        .apply(&mut target, &mut claims, "first", "idle")
        .unwrap();
    assert_eq!(target.greeting.as_deref(), Some("Ready to work?"));
    assert_eq!(
        target.session_title_suffix.as_deref(),
        Some(" | Project tools")
    );
    let conflicts = ModViewPatch::parse(json!({"sites":{"welcome":{"components":[]}}}))
        .unwrap()
        .apply(&mut target, &mut claims, "second", "idle")
        .unwrap();
    assert_eq!(conflicts[0].field, "sites.welcome");
    assert_eq!(conflicts[0].owner, "first");
}

#[test]
fn patches_claim_layout_once() {
    let mut target = ModView::default();
    let mut claims = BTreeMap::new();
    let layout = json!({"layout": {"content": "transcript"}});
    ModViewPatch::parse(layout.clone())
        .unwrap()
        .apply(&mut target, &mut claims, "first", "idle")
        .unwrap();
    assert!(target.layout.is_some());
    let conflicts = ModViewPatch::parse(json!({"layout": {"split": "vertical", "children": [{"content": "transcript"}, {"content": "composer"}]}}))
        .unwrap()
        .apply(&mut target, &mut claims, "second", "idle")
        .unwrap();
    assert_eq!(
        target.layout,
        Some(serde_json::from_value(layout["layout"].clone()).unwrap())
    );
    assert_eq!(
        conflicts,
        vec![ModViewConflict {
            field: "layout".into(),
            owner: "first".into(),
            rejected: "second".into(),
            origin: "idle".into(),
        }]
    );
}

#[test]
fn appearance_styles_are_bounded_and_merge_by_surface() {
    assert!(view(json!({"surface_styles":{"approval":{"border":"#888888"}}})).is_ok());
    assert!(
        view(json!({"surface_styles":{"composer":{"top":"#123456","bottom":235,"opacity":0.7}}}))
            .is_ok()
    );
    for value in [
        json!({"surface_styles":{"transcript":{"top":0}}}),
        json!({"surface_styles":{"composer":{"opacity":1.01}}}),
    ] {
        assert!(view(value.clone()).is_err(), "{value}");
    }
    let mut target = ModView::default();
    let mut claims = BTreeMap::new();
    for patch in [
        json!({"surface_styles":{"composer":{"top":"#123456"}}}),
        json!({"surface_styles":{"approval":{"top":"#abcdef"}}}),
        json!({"surface_styles":{"composer":{"top":"#654321"}}}),
    ] {
        ModViewPatch::parse(patch)
            .unwrap()
            .apply(&mut target, &mut claims, "first", "idle")
            .unwrap();
    }
    assert_eq!(target.surface_styles.len(), 2);
    assert_eq!(
        target.surface_styles["composer"].top,
        Some(ModColor::Rgb(0x65, 0x43, 0x21))
    );
}

#[test]
fn a_wrap_encloses_a_replacement_composed_after_it() {
    let mut target = ModView::default();
    let mut claims = BTreeMap::new();
    for (id, patch) in [
        (
            "frame",
            json!({"sites": {"sidebar": {"mode": "wrap", "components": [{"type": "box", "id": "frame",
                "label": "Frame", "children": [{"type": "slot"}]}]}}}),
        ),
        (
            "files",
            json!({"sites": {"sidebar": {"components": [{"type": "text", "id": "tree", "label": "Tree", "text": "src"}]}}}),
        ),
    ] {
        let conflicts = ModViewPatch::parse(patch)
            .unwrap()
            .apply(&mut target, &mut claims, id, "idle")
            .unwrap();
        assert!(conflicts.is_empty());
    }
    target.close_wraps();
    let sidebar = serde_json::to_value(&target.sites["sidebar"]).unwrap();
    assert_eq!(sidebar["mode"], "replace");
    assert_eq!(sidebar["components"][0]["children"][0]["id"], "tree");
}

