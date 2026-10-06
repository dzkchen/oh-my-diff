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
fn layouts_need_one_transcript_and_composer_below_it() {
    let leaf = |content: &str| json!({"content": content});
    assert!(view(json!({"layout": {"split": "horizontal", "children": [
        leaf("site:files/tree"),
        {"split": "vertical", "ratio": [3, 1], "children": [leaf("transcript"), leaf("composer")]}
    ]}})).is_ok());
    for layout in [
        leaf("site:files/tree"),
        json!({"split": "vertical", "children": [leaf("composer"), leaf("transcript")]}),
        json!({"split": "horizontal", "children": [leaf("transcript"), leaf("composer")]}),
        json!({"split": "vertical", "children": [leaf("transcript"), leaf("transcript")]}),
        json!({"split": "vertical", "ratio": [0, 1], "children": [leaf("transcript"), leaf("site:header")]}),
        json!({"split": "vertical", "children": [leaf("transcript")]}),
        json!({"tabs": [{"title": "a", "node": leaf("transcript")}], "active": 3}),
        json!({"split": "vertical", "children": [leaf("transcript"), leaf("site:Bad/Name")]}),
        json!({"split": "vertical", "children": [leaf("transcript"), leaf("panel")]}),
    ] {
        assert!(view(json!({"layout": layout})).is_err(), "{layout}");
    }
}

#[test]
fn backdrops_bound_text_dim_and_position() {
    assert!(view(json!({"backdrop": {"ascii": {"text": "~ ~", "dim": 0.4}}})).is_ok());
    let reference = json!({"reference": "r", "sha256": "0".repeat(64)});
    assert!(
        view(
            json!({"backdrop": {"image": {"resource": reference, "position": "fill"},
        "fallback": {"ascii": {"text": "#"}}}})
        )
        .is_ok()
    );
    for backdrop in [
        json!({"ascii": {"text": ""}}),
        json!({"ascii": {"text": "x", "dim": 2.0}}),
        json!({"image": {"resource": reference, "position": "stretch"}}),
    ] {
        assert!(view(json!({"backdrop": backdrop})).is_err(), "{backdrop}");
    }
}

#[test]
fn documents_and_diffs_validate_and_named_sites_are_allowed() {
    let document = json!({"type": "document", "id": "doc", "label": "Doc",
        "lines": [[{"text": "one"}], [{"text": "two"}]], "anchors": ["a.rs:1", "a.rs:2"],
        "selected": {"start": 0, "end": 1}, "find": {"query": "o"}, "height": 10,
        "action": {"command": "notes:open"}});
    let diff = json!({"type": "diff", "id": "diff", "label": "Diff", "unified": "+++ b/a\n@@ -1 +1 @@\n+x"});
    assert!(view(json!({"sites": {"notes/pad": {"components": [document, diff]}}})).is_ok());
    let reference = json!({"reference": "r", "sha256": "0".repeat(64)});
    for component in [
        json!({"type": "document", "id": "d", "label": "D", "lines": [[{"text": "x"}]], "source": reference}),
        json!({"type": "document", "id": "d", "label": "D", "selected": {"start": 3, "end": 1}}),
        json!({"type": "document", "id": "d", "label": "D", "height": 0}),
        json!({"type": "diff", "id": "d", "label": "D", "unified": "x", "extra": true}),
    ] {
        assert!(
            view(json!({"sites": {"sidebar": {"components": [component]}}})).is_err(),
            "{component}"
        );
    }
    assert!(view(json!({"sites": {"Notes/pad": {"components": []}}})).is_err());
}

#[test]
fn patches_claim_layout_and_backdrop_once() {
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
fn appearance_styles_and_backdrop_transforms_are_bounded_and_merge_by_surface() {
    assert!(view(json!({"surface_styles":{"approval":{"border":"#888888"}}})).is_ok());
    assert!(view(json!({"surface_styles":{"composer":{"top":"#123456","bottom":235,"opacity":0.7}},"backdrop":{"ascii":{"text":"+", "scale":2.0,"opacity":0.5,"tint":"#123456","offset":{"x":-4,"y":2},"position":"center"}}})).is_ok());
    for value in [
        json!({"surface_styles":{"transcript":{"top":0}}}),
        json!({"surface_styles":{"composer":{"opacity":1.01}}}),
        json!({"backdrop":{"ascii":{"text":"x","scale":0.01}}}),
        json!({"backdrop":{"ascii":{"text":"x","offset":{"x":4097,"y":0}}}}),
        json!({"backdrop":{"ascii":{"text":"x","tint":"red"}}}),
    ] {
        assert!(view(value.clone()).is_err(), "{value}");
    }
    let mut target = ModView::default();
    let mut claims = BTreeMap::new();
    for patch in [
        json!({"surface_styles":{"composer":{"top":"#123456"}}}),
        json!({"surface_styles":{"backdrop":{"top":"#abcdef"}}}),
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
fn each_patch_keeps_twelve_keys_while_the_composed_view_holds_more() {
    let keys = |letters: &str| {
        Value::Object(
            letters
                .chars()
                .map(|letter| (format!("Alt+{letter}"), json!("draft")))
                .collect(),
        )
    };
    assert!(ModViewPatch::parse(json!({"keybindings": keys("abcdefghijklm")})).is_err());
    let mut target = ModView::default();
    let mut claims = BTreeMap::new();
    for (id, letters) in [("first", "abcdefghijkl"), ("second", "nopqrstuvwyz")] {
        ModViewPatch::parse(json!({"keybindings": keys(letters)}))
            .unwrap()
            .apply(&mut target, &mut claims, id, "idle")
            .unwrap();
    }
    assert_eq!(target.keybindings.len(), 24);
    let conflicts = ModViewPatch::parse(json!({"keybindings": keys("a")}))
        .unwrap()
        .apply(&mut target, &mut claims, "third", "idle")
        .unwrap();
    assert_eq!(conflicts[0].field, "keybindings.Alt+a");
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

#[test]
fn links_multiselects_and_control_hotkeys_are_validated() {
    let site = |component: Value| json!({"sites": {"sidebar": {"components": [component]}}});
    let line = |link: &str| {
        site(
            json!({"type": "line", "id": "l", "label": "L", "spans": [{"text": "x", "link": link}]}),
        )
    };
    let choice = |value: Value| {
        site(
            json!({"type": "multiselect", "id": "m", "label": "M", "value": value,
        "options": [{"value": "a", "label": "A"}, {"value": "b", "label": "B"}], "action": {"command": "pick"}}),
        )
    };
    let button = |hotkey: &str| {
        site(
            json!({"type": "button", "id": "b", "label": "B", "text": "Go",
        "action": {"command": "go"}, "hotkey": hotkey, "autofocus": true}),
        )
    };
    for valid in [
        line("https://example.com/a?b#c"),
        line("HTTP://host"),
        choice(json!(["b", "a"])),
        choice(json!([])),
        button("Alt+g"),
    ] {
        assert!(view(valid.clone()).is_ok(), "{valid}");
    }
    for invalid in [
        line("javascript:alert(1)"),
        line("https:///path"),
        line("https://a b"),
        line(&format!("https://h/{}", "x".repeat(2048))),
        site(
            json!({"type": "document", "id": "d", "label": "D", "lines": [[{"text": "x", "link": "https://h"}]]}),
        ),
        choice(json!(["c"])),
        choice(json!(["a", "a"])),
        button("Ctrl+c"),
        button("g"),
    ] {
        assert!(view(invalid.clone()).is_err(), "{invalid}");
    }
}
