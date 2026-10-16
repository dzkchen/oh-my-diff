use super::*;
use serde_json::json;

#[test]
fn key_and_command_replacements_validate_and_drop_conflicts() {
    let first = BuiltinControls::parse(&json!({
        "commands": {"replace": {"review": "audit"}},
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
fn only_known_surfaces_can_be_disabled() {
    let controls =
        BuiltinControls::parse(&json!({"surfaces": {"disable": ["status_line"]}})).unwrap();
    for invalid in [
        json!({"surfaces": {"disable": ["composer"]}}),
        json!({"surfaces": {"disable": ["status_line", "status_line"]}}),
    ] {
        assert!(BuiltinControls::parse(&invalid).is_err(), "{invalid}");
    }
    let snapshot = BuiltinSnapshot::from_controls(&[("line".to_owned(), controls)]);
    assert!(snapshot.surface_disabled("status_line"));
    assert!(!BuiltinSnapshot::default().surface_disabled("status_line"));
}
