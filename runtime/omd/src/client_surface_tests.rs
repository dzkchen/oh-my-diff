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
            .send(Ok(json!({"status": "accepted", "value": if host_prompt { "pw" } else { "" }})))
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

#[test]
fn surface_routes_enforces_user_context_cancels_and_unregisters() {
    let active = || true;
    let event = InvocationContext::Event;
    assert!(
        call(
            "m",
            "composer.read",
            Value::Null,
            event,
            None,
            None,
            &active
        )
        .unwrap_err()
        .starts_with("client_surface_unavailable")
    );
    let registration = register(Arc::new(Echo));
    assert!(hub().surface.is_some());
    let value = call(
        "m",
        "app.request",
        json!({"method": "thread/list"}),
        event,
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
