use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Echo;

impl ClientSurface for Echo {
    fn submit(&self, call: SurfaceCall) -> Result<(), String> {
        let value = json!({"operation": call.operation, "caller": call.caller,
            "confirm": call.confirm, "arguments": call.arguments});
        call.reply
            .send(Ok(value))
            .map_err(|error| error.to_string())
    }
}

struct Password;

impl ClientSurface for Password {
    fn submit(&self, call: SurfaceCall) -> Result<(), String> {
        let host_prompt = call.caller == crate::broker::HOST_CALLER
            && call.operation == "terminal.prompt"
            && call.arguments["masked"] == true;
        call.reply
            .send(Ok(
                json!({"status": "accepted", "value": if host_prompt { "pw" } else { "" }}),
            ))
            .map_err(|error| error.to_string())
    }
}

struct Reject;

impl ClientSurface for Reject {
    fn submit(&self, call: SurfaceCall) -> Result<(), String> {
        call.reply
            .send(Err("terminal_blit_not_owned".into()))
            .map_err(|error| error.to_string())
    }
}

struct Silent;

impl ClientSurface for Silent {
    fn submit(&self, call: SurfaceCall) -> Result<(), String> {
        std::mem::forget(call.reply);
        Ok(())
    }
}

static HUB_TESTS: Mutex<()> = Mutex::new(());

fn hub_test() -> std::sync::MutexGuard<'static, ()> {
    HUB_TESTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[test]
fn surface_routes_enforces_user_context_cancels_and_unregisters() {
    let _serial = hub_test();
    let active = || true;
    let event = InvocationContext::Event;
    assert!(
        call(
            "m",
            "composer.read",
            Value::Null,
            event,
            false,
            None,
            None,
            &active
        )
        .unwrap_err()
        .starts_with("client_surface_unavailable")
    );
    let registration = register(Arc::new(Echo));
    assert!(hub().surface.is_some());
    let mirrored = Arc::new(Mutex::new(Vec::new()));
    let log = mirrored.clone();
    let observer = register_observer(Arc::new(move |observed| {
        if let Observed::Mirrored {
            caller,
            operation,
            arguments,
        } = observed
        {
            log.lock().unwrap().push((caller, operation, arguments));
        }
    }));
    call(
        "m",
        "terminal.notice",
        json!({"text": "hi"}),
        event,
        false,
        None,
        None,
        &active,
    )
    .unwrap();
    call(
        "m",
        "composer.read",
        Value::Null,
        event,
        false,
        None,
        None,
        &active,
    )
    .unwrap();
    drop(observer);
    assert_eq!(
        *mirrored.lock().unwrap(),
        vec![(
            "m".to_owned(),
            "terminal.notice".to_owned(),
            json!({"text": "hi"})
        )]
    );
    let value = call(
        "m",
        "app.request",
        json!({"method": "thread/list"}),
        event,
        false,
        Some("t"),
        Some("Allow m to list threads?".into()),
        &active,
    )
    .unwrap();
    assert_eq!(value["operation"], "app.request");
    assert_eq!(value["confirm"], "Allow m to list threads?");
    let password = register(Arc::new(Password));
    assert_eq!(crate::broker::password().unwrap().as_deref(), Some("pw"));
    drop(password);
    assert_eq!(
        call(
            "m",
            "packages.apply",
            Value::Null,
            event,
            false,
            None,
            None,
            &active
        )
        .unwrap_err(),
        "host_operation_user_only: packages.apply"
    );
    assert!(
        call(
            "m",
            "exec.run",
            Value::Null,
            InvocationContext::User,
            false,
            None,
            None,
            &active
        )
        .unwrap_err()
        .starts_with("unsupported_host_operation")
    );
    let replaced = register(Arc::new(Silent));
    drop(registration);
    assert!(
        hub().surface.is_some(),
        "a stale registration must not remove its replacement"
    );
    let receiver = submit(
        "m",
        "terminal.notify",
        json!({"title": "t"}),
        event,
        false,
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        wait(receiver, &|| false, None).unwrap_err(),
        "callback_cancelled"
    );
    let receiver = submit(
        "m",
        "terminal.notify",
        json!({"title": "t"}),
        event,
        false,
        None,
        None,
    )
    .unwrap();
    assert!(
        wait(receiver, &|| true, Some(std::time::Instant::now()))
            .unwrap_err()
            .starts_with("callback_execution_budget")
    );
    drop(replaced);
    assert!(hub().surface.is_none());

    let woken = Arc::new(AtomicUsize::new(0));
    let counter = woken.clone();
    let wake_registration = register_wake(Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    }));
    wake();
    drop(wake_registration);
    wake();
    assert_eq!(woken.load(Ordering::SeqCst), 1);
}

#[test]
fn rejected_mirrored_operations_are_not_mirrored() {
    let _serial = hub_test();
    let registration = register(Arc::new(Reject));
    let mirrored = Arc::new(AtomicUsize::new(0));
    let counter = mirrored.clone();
    let observer = register_observer(Arc::new(move |observed| {
        if matches!(observed, Observed::Mirrored { .. }) {
            counter.fetch_add(1, Ordering::SeqCst);
        }
    }));
    let blit = call(
        "m",
        "terminal.blit",
        json!({"key": "r"}),
        InvocationContext::Event,
        false,
        None,
        None,
        &|| true,
    );
    assert_eq!(blit, Err("terminal_blit_not_owned".into()));
    assert_eq!(mirrored.load(Ordering::SeqCst), 0);
    drop(observer);
    drop(registration);
}

#[test]
fn roster_changes_and_redraws_reach_observers_outside_the_hub_lock() {
    let _serial = hub_test();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let observer = register_observer(Arc::new(move |observed| {
        let entry = match observed {
            Observed::Roster => json!(
                roster()
                    .into_iter()
                    .filter(|entry| entry["id"] == "roster-client")
                    .map(|entry| entry["name"].clone())
                    .collect::<Vec<_>>()
            ),
            Observed::Redraw => json!("redraw"),
            Observed::Mirrored { .. } => return,
        };
        log.lock().unwrap().push(entry);
    }));
    let entry = |name: &str| ClientEntry {
        id: "roster-client".into(),
        name: name.into(),
        renderer: json!({"kind": "gui"}),
        viewport: Value::Null,
        operations: vec!["terminal.notify".into()],
        attached_ms: 7,
        focused: false,
    };
    let first = attach(entry("first"));
    let second = attach(entry("second"));
    drop(first);
    update(
        "roster-client",
        None,
        Some(json!({"width": 800, "height": 600, "unit": "px"})),
        Some(true),
    );
    assert_eq!(
        clients()
            .into_iter()
            .find(|client| client["id"] == "roster-client"),
        Some(
            json!({"id": "roster-client", "name": "second", "renderer": {"kind": "gui"},
            "viewport": {"width": 800, "height": 600, "unit": "px"}, "attached_ms": 7,
            "focused": true})
        )
    );
    assert!(
        roster().iter().any(|entry| entry["id"] == "roster-client"
            && entry["operations"] == json!(["terminal.notify"]))
    );
    redraw();
    drop(second);
    drop(observer);
    drop(attach(entry("unobserved")));
    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            json!(["first"]),
            json!(["second"]),
            json!(["second"]),
            json!("redraw"),
            json!([])
        ]
    );
}

#[test]
fn confirmations_name_the_exact_request() {
    assert_eq!(
        confirmation(
            "m",
            "config/value/write",
            &json!({"keyPath": "mcp_servers.docs.enabled", "value": false})
        )
        .unwrap(),
        r#"Mod m requests config/value/write with {"keyPath":"mcp_servers.docs.enabled","value":false}."#
    );
    assert_eq!(
        confirmation(
            "m",
            "mcpServer/tool/call",
            &json!({"arguments": "x".repeat(2000)})
        ),
        Err("app_confirmation_too_large: mcpServer/tool/call".to_owned())
    );
}

#[test]
fn config_reads_redact_secret_values() {
    let mut config = json!({
        "model": "m",
        "mcp_servers": {"plain": {"command": "plain"}, "web": {"url": "https://user:s8@web.example:8443/mcp?token=s9&mode=full#s10"}, "local": {"url": "http://127.0.0.1:3920/mcp"}, "docs": {"command": "docs", "env": {"TOKEN": "s1"}, "http_headers": {"Authorization": "s2"}, "bearer_token": "s3", "oauth": {"client_id": "id", "client_secret": "s4"}}},
        "model_providers": {"p": {"base_url": "https://p/v1?key=s11", "http_headers": {"X-Key": "s5"}, "query_params": {"key": "s6"}, "experimental_bearer_token": "s7"}}
    });
    redact_config(&mut config);
    let text = config.to_string();
    assert!((1..=11).all(|index| !text.contains(&format!("s{index}"))));
    assert_eq!(config["mcp_servers"]["docs"]["env"]["TOKEN"], "<redacted>");
    assert_eq!(config["mcp_servers"]["docs"]["oauth"]["client_id"], "id");
    assert_eq!(
        config["model_providers"]["p"]["base_url"],
        "https://p/<redacted>"
    );
    assert_eq!(
        config["mcp_servers"]["web"]["url"],
        "https://<redacted>@web.example:8443/<redacted>"
    );
    assert_eq!(
        config["mcp_servers"]["local"]["url"],
        "http://127.0.0.1:3920/<redacted>"
    );
    assert_eq!(config["mcp_servers"]["plain"], json!({"command": "plain"}));
}

#[test]
fn config_rows_mark_managed_and_writable_keys_and_never_carry_secrets() {
    let read = json!({
        "config": {"model": "m", "agents": {"max_depth": 2}, "approval_policy": "never",
            "mcp_servers": {"docs": {"command": "docs", "env": {"TOKEN": "s1"}}}},
        "origins": {
            "model": {"name": {"type": "system", "file": "/etc/codex/config.toml"}, "version": "v1"},
            "agents.max_depth": {"name": {"type": "user", "file": "/u/config.toml"}, "version": "v2"}
        }
    });
    let packages = json!({"packages": [
        {"id": "notes", "effective": true, "settings": {"limit": 3},
            "settings_schema": {"properties": {"limit": {"type": "number", "default": 5}}}},
        {"id": "off", "effective": false, "settings": {"x": 1},
            "settings_schema": {"properties": {"x": {"type": "number"}}}}
    ]});
    let rows = config_rows(&read, &packages);
    let row = |key: &str| rows.iter().find(|row| row["key"] == key).cloned();
    assert_eq!(rows[0]["key"], "mods.notes.limit");
    assert_eq!(rows[0]["value"], 3);
    assert!(row("mods.off.x").is_none());
    let depth = row("agents.max_depth").unwrap();
    assert_eq!(
        (
            depth["editable"].clone(),
            depth["source"].clone(),
            depth["version"].clone()
        ),
        (json!(true), json!("user"), json!("v2"))
    );
    let model = row("model").unwrap();
    assert_eq!(
        (model["managed"].clone(), model["editable"].clone()),
        (json!(true), json!(false))
    );
    assert!(
        row("approval_policy").is_none(),
        "authority keys are not rows"
    );
    assert!(!serde_json::to_string(&rows).unwrap().contains("s1"));
}

#[test]
fn remote_actions_cannot_cause_terminal_only_operations() {
    for (operation, arguments) in [
        ("config.set", Value::Null),
        ("prompts.consent", Value::Null),
        ("terminal.pty", json!({"action": "start"})),
    ] {
        assert_eq!(
            submit(
                "m",
                operation,
                arguments,
                InvocationContext::User,
                true,
                None,
                None
            )
            .unwrap_err(),
            needs_terminal_error(operation)
        );
    }
    assert!(!needs_terminal("terminal.pty", &json!({"action": "write"})));
}
