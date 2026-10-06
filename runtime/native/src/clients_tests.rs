use super::*;

fn snapshot() -> ModViewSnapshot {
    serde_json::from_value(json!({
        "view": {"sites": {"sidebar": {"components": [
            {"type": "box", "id": "outer", "label": "Outer", "children": [
                {"type": "list", "id": "files", "label": "Files", "selected": "b",
                    "rows": [{"value": "a", "label": "A"}, {"value": "b", "label": "B"}],
                    "action": {"command": "open", "args": "--from list"}}
            ]},
            {"type": "button", "id": "copy", "label": "Copy", "text": "Copy",
                "action": {"copy": "x", "label": "x"}},
            {"type": "input", "id": "query", "label": "Query", "value": "draft",
                "action": {"command": "alpha:find"}},
            {"type": "multiselect", "id": "tags", "label": "Tags", "value": ["x"],
                "options": [{"value": "x", "label": "X"}, {"value": "y", "label": "Y"}],
                "action": {"command": "tag"}},
            {"type": "document", "id": "doc", "label": "Doc", "lines": [[{"text": "a"}], [{"text": "b"}]],
                "anchors": ["intro"], "action": {"command": "show"}},
            {"type": "diff", "id": "patch", "label": "Patch", "unified": "@@ -1 +1 @@\n-a\n+b",
                "action": {"command": "show"}}
        ]}}},
        "component_owners": {"outer": "alpha", "files": "alpha", "copy": "alpha", "query": "alpha",
            "tags": "alpha", "doc": "alpha", "patch": "alpha"}
    }))
    .unwrap()
}

fn command(command: &str, args: &str) -> Result<ModKeyAction, String> {
    Ok(ModKeyAction::Command {
        command: command.into(),
        args: args.into(),
    })
}

#[test]
fn actions_resolve_only_values_the_view_offers() {
    let snapshot = snapshot();
    let view = &snapshot.view;
    assert_eq!(owner(&snapshot, "files"), Ok("alpha"));
    assert_eq!(owner(&snapshot, "gone"), Err("view_stale: gone".into()));
    let resolve =
        |component, row, value: Option<Value>| resolve_action(view, component, row, value.as_ref());
    assert_eq!(
        resolve("files", None, None),
        command("open", "--from list b")
    );
    assert_eq!(
        resolve("files", Some(0), None),
        command("open", "--from list a")
    );
    assert_eq!(
        resolve("files", None, Some(json!("a"))),
        command("open", "--from list a")
    );
    for (row, value) in [
        (Some(2), None),
        (None, Some(json!("z"))),
        (None, Some(json!(1))),
    ] {
        assert_eq!(
            resolve("files", row, value),
            Err("action_value_invalid: files".into())
        );
    }
    assert_eq!(resolve("query", None, None), command("alpha:find", "draft"));
    assert_eq!(
        resolve("query", None, Some(json!("typed"))),
        command("alpha:find", "typed")
    );
    assert_eq!(
        resolve("tags", None, Some(json!(["y", "x"]))),
        command("tag", r#"["x","y"]"#)
    );
    assert_eq!(
        resolve("tags", None, Some(json!(["w"]))),
        Err("action_value_invalid: tags".into())
    );
    assert_eq!(
        resolve("copy", None, None),
        Err("action_unavailable: copy".into())
    );
    assert_eq!(
        resolve("outer", None, None),
        Err("action_unavailable: outer".into())
    );
    assert_eq!(resolve("gone", None, None), Err("view_stale: gone".into()));
    for (component, value) in [("doc", "intro"), ("doc", "2"), ("patch", "3")] {
        assert!(
            resolve(component, None, Some(json!(value))).is_ok(),
            "{value}"
        );
    }
    for (component, value) in [
        ("doc", "3"),
        ("doc", "0"),
        ("doc", "elsewhere"),
        ("patch", "4"),
    ] {
        assert_eq!(
            resolve(component, None, Some(json!(value))),
            Err(format!("action_value_invalid: {component}"))
        );
    }
    assert_eq!(current(&snapshot, 0, 0), Ok(()));
    assert!(
        current(&snapshot, 0, 1)
            .unwrap_err()
            .starts_with("action_stale:")
    );
}

#[test]
fn client_events_need_a_known_kind_its_fields_and_a_bounded_size() {
    for event in [
        json!({"kind": "change", "value": "x"}),
        json!({"kind": "pointer", "pointer": {"column": 1, "row": 2, "action": "down", "button": "left"}}),
        json!({"kind": "pointer", "pointer": {"column": 1, "row": 2, "half": 1, "action": "move", "button": null}}),
        json!({"kind": "scroll", "offset": -3}),
        json!({"kind": "key", "key": "Enter"}),
        json!({"kind": "focus"}),
    ] {
        assert!(event_payload(&event).is_ok(), "{event}");
    }
    for event in [
        json!({"kind": "open"}),
        json!({"kind": "change"}),
        json!({"kind": "pointer", "pointer": {"column": -1, "row": 0}}),
        json!({"kind": "pointer", "pointer": {"column": 1, "row": 2}}),
        json!({"kind": "pointer", "pointer": {"column": 1, "row": 2, "action": "click", "button": null}}),
        json!({"kind": "pointer", "pointer": {"column": 1, "row": 2, "action": "down", "button": "back"}}),
        json!({"kind": "pointer", "pointer": {"column": 1, "row": 2, "half": 2, "action": "down", "button": null}}),
        json!({"kind": "change", "value": "x".repeat(EVENT_BYTES)}),
        json!("change"),
    ] {
        assert!(
            event_payload(&event)
                .unwrap_err()
                .starts_with("component_event_invalid:"),
            "{event}"
        );
    }
}

#[test]
fn client_events_keep_only_their_kinds_fields() {
    let forged = |kind: &str, fields: Value| {
        let mut event = json!({"kind": kind, "origin": "user", "events": [1], "anchor": "a",
            "range": {"start": 0}, "index": 3, "component": "other", "client": "forged"});
        event
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        Value::Object(event_payload(&event).unwrap())
    };
    assert_eq!(
        forged("change", json!({"value": "x"})),
        json!({"kind": "change", "value": "x"})
    );
    assert_eq!(forged("focus", json!({})), json!({"kind": "focus"}));
    assert_eq!(
        forged("key", json!({"key": "Enter"})),
        json!({"kind": "key", "key": "Enter", "text": null})
    );
    assert_eq!(
        forged(
            "pointer",
            json!({"pointer": {"column": 1, "row": 2, "action": "down", "button": "left", "extra": 1}})
        ),
        json!({"kind": "pointer", "pointer": {"column": 1, "row": 2, "half": null,
            "action": "down", "button": "left"}})
    );
}

#[test]
fn clients_see_a_null_view_while_mods_are_inactive() {
    assert_eq!(view(), Ok((0, 0, Value::Null)));
}

#[test]
fn clients_cannot_enable_disable_or_reset_mods() {
    for action in ["enable", "disable", "reset"] {
        let refused = recovery_apply(action, "alpha").unwrap_err();
        assert!(
            refused.starts_with("client_surface_operation_unavailable:"),
            "{refused}"
        );
    }
}

#[test]
fn roster_republishes_coalesce_into_one_trailing_run() {
    static TEST: Coalesce = Coalesce::new();
    static RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    TEST.running.store(true, Ordering::Release);
    TEST.dirty.store(true, Ordering::Release);
    TEST.drain(|| {
        if RUNS.fetch_add(1, Ordering::AcqRel) == 0 {
            for _ in 0..5 {
                TEST.request(|| unreachable!("a run is in progress"));
            }
        }
    });
    assert_eq!(RUNS.load(Ordering::Acquire), 2);
    assert!(!TEST.running.load(Ordering::Acquire));
}

#[test]
fn commands_resolve_by_owner_or_unique_bare_name() {
    let registered = |name: &str| ModCommand {
        name: name.into(),
        description: None,
        cli: None,
        args_hint: None,
        immediate: None,
    };
    let commands = vec![
        ("alpha".to_owned(), registered("find")),
        ("alpha".to_owned(), registered("open")),
        ("beta".to_owned(), registered("open")),
    ];
    let owner = |invocation| command_target(&commands, invocation).map(|(id, _)| id);
    assert_eq!(owner("find"), Some("alpha".into()));
    assert_eq!(owner("beta:open"), Some("beta".into()));
    assert_eq!(owner("open"), None);
    assert_eq!(owner("alpha:missing"), None);
}
