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
    let mut replaced = BTreeSet::new();
    let mut completed = false;
    ModViewPatch::parse(welcome)
        .unwrap()
        .apply(&mut target, &mut replaced, &mut completed)
        .unwrap();
    ModViewPatch::parse(json!({"greeting":"Ready to work?"}))
        .unwrap()
        .apply(&mut target, &mut replaced, &mut completed)
        .unwrap();
    assert_eq!(target.greeting.as_deref(), Some("Ready to work?"));
    assert_eq!(
        target.session_title_suffix.as_deref(),
        Some(" | Project tools")
    );
    assert!(
        ModViewPatch::parse(json!({"sites":{"welcome":{"components":[]}}}))
            .unwrap()
            .apply(&mut target, &mut replaced, &mut completed)
            .is_err()
    );
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
    let mut replaced = BTreeSet::new();
    let mut completed = false;
    let layout = json!({"layout": {"content": "transcript"}});
    ModViewPatch::parse(layout.clone())
        .unwrap()
        .apply(&mut target, &mut replaced, &mut completed)
        .unwrap();
    assert!(target.layout.is_some());
    assert!(
        ModViewPatch::parse(layout)
            .unwrap()
            .apply(&mut target, &mut replaced, &mut completed)
            .is_err()
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
    let mut sites = BTreeSet::new();
    let mut completed = false;
    for patch in [
        json!({"surface_styles":{"composer":{"top":"#123456"}}}),
        json!({"surface_styles":{"backdrop":{"top":"#abcdef"}}}),
        json!({"surface_styles":{"composer":{"top":"#654321"}}}),
    ] {
        ModViewPatch::parse(patch)
            .unwrap()
            .apply(&mut target, &mut sites, &mut completed)
            .unwrap();
    }
    assert_eq!(target.surface_styles.len(), 2);
    assert_eq!(
        target.surface_styles["composer"].top,
        Some(ModColor::Rgb(0x65, 0x43, 0x21))
    );
}
