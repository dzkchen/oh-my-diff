use super::*;
use serde_json::json;

#[test]
fn key_and_command_replacements_validate_and_drop_conflicts() {
    let first = BuiltinControls::parse(&json!({
        "commands": {"replace": {"review": "audit"}},
        "modes": {"disable": ["plan"]},
        "keys": {"composer.submit": "Ctrl+j", "chat.edit_previous": null}
    }))
    .unwrap();
    let second = BuiltinControls::parse(&json!({"keys": {"composer.submit": "Ctrl+k"}})).unwrap();
    for invalid in [
        json!({"commands": {"replace": {"quit": "leave"}}}),
        json!({"commands": {"replace": {"review": "Audit"}}}),
        json!({"keys": {"approval.accept": "y"}}),
        json!({"keys": {"composer": "y"}}),
        json!({"keys": {"composer.submit": ""}}),
        json!({"modes": {"disable": ["default"]}}),
    ] {
        assert!(BuiltinControls::parse(&invalid).is_err(), "{invalid}");
    }
    let snapshot =
        BuiltinSnapshot::from_controls(&[("one".to_owned(), first), ("two".to_owned(), second)]);
    assert_eq!(
        snapshot.command_replacement("review"),
        Some(&("one".to_owned(), "audit".to_owned()))
    );
    assert_eq!(snapshot.command_replacement("omd"), None);
    assert!(snapshot.mode_disabled("plan"));
    assert!(!snapshot.mode_disabled("default"));
    assert!(!snapshot.keys.contains_key("composer.submit"));
    assert_eq!(
        snapshot.keys.get("chat.edit_previous"),
        Some(&("one".to_owned(), None))
    );
    assert_eq!(snapshot.conflicts, vec!["keys.composer.submit".to_owned()]);
    let restored: BuiltinSnapshot =
        serde_json::from_value(json!({"schema": 1, "hidden_commands": {}, "disabled_modes": {}}))
            .unwrap();
    assert!(restored.replaced_commands.is_empty());
}

#[test]
fn removed_features_must_be_known_and_compose_from_every_owner() {
    let first =
        BuiltinControls::parse(&json!({"features": {"remove": ["prevent_idle_sleep"]}})).unwrap();
    let second =
        BuiltinControls::parse(&json!({"features": {"remove": ["prevent_idle_sleep"]}})).unwrap();
    for invalid in [
        json!({"features": {"remove": ["not_a_feature"]}}),
        json!({"features": {"remove": ["prevent_idle_sleep", "prevent_idle_sleep"]}}),
        json!({"features": {"hide": ["prevent_idle_sleep"]}}),
    ] {
        assert!(BuiltinControls::parse(&invalid).is_err(), "{invalid}");
    }
    let snapshot =
        BuiltinSnapshot::from_controls(&[("one".to_owned(), first), ("two".to_owned(), second)]);
    assert_eq!(
        snapshot.removed_features(),
        BTreeSet::from([codex_features::Feature::PreventIdleSleep])
    );
    assert_eq!(
        snapshot.removed_features["prevent_idle_sleep"],
        vec!["one".to_owned(), "two".to_owned()]
    );
}
