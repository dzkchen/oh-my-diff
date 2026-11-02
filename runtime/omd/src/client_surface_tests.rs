use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Echo;

impl ClientSurface for Echo {
    fn submit(&self, call: SurfaceCall) -> Result<(), String> {
        let value = json!({"operation": call.operation, "caller": call.caller,
            "confirm": call.confirm, "arguments": call.arguments, "depth": call.depth,
            "authority": call.authority.map(|authority| json!({"epoch": authority.epoch, "admission": authority.admission, "source": authority.source, "configuration": authority.configuration}))});
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

struct Silent;

#[derive(Default)]
struct Queued(Mutex<Vec<SurfaceCall>>);

impl ClientSurface for Queued {
    fn submit(&self, call: SurfaceCall) -> Result<(), String> {
        self.0.lock().unwrap().push(call);
        Ok(())
    }
}

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
fn program_trust_without_a_client_names_the_pre_approval() {
    let _serial = hub_test();
    let store = tempfile::tempdir().unwrap();
    let error = crate::program_trust::ensure(
        store.path(),
        "m",
        std::path::Path::new("/bin/sh"),
        "aa",
        &|| true,
    )
    .unwrap_err();
    assert!(error.starts_with("program_unconfirmed:"), "{error}");
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
            Arc::new(active)
        )
        .unwrap_err()
        .starts_with("client_surface_unavailable")
    );
    let registration = register(Arc::new(Echo));
    let depth = || {
        call(
            "m",
            "composer.read",
            Value::Null,
            InvocationContext::User,
            false,
            None,
            None,
            Arc::new(active),
        )
        .unwrap()["depth"]
            .clone()
    };
    {
        let _nested = nest(3);
        assert_eq!(depth(), 3);
    }
    assert_eq!(depth(), 0);
    let authority = Authority {
        epoch: 7,
        admission: 11,
        configuration: "configuration".into(),
        source: "source".into(),
    };
    for context in [InvocationContext::User, InvocationContext::Event] {
        let _guard = authority.clone().enter();
        let value = call(
            "m",
            "terminal.pty",
            json!({"action": "read", "session": "p1"}),
            context,
            false,
            Some("thread"),
            None,
            Arc::new(active),
        )
        .unwrap();
        assert_eq!(
            value["authority"],
            json!({"epoch": 7, "admission": 11, "source": "source", "configuration": "configuration"})
        );
        assert!(
            call(
                "m",
                "terminal.pty",
                json!({"action": "read", "session": "p1"}),
                context,
                false,
                Some("thread"),
                None,
                Arc::new(|| false)
            )
            .is_err()
        );
    }
    assert!(AUTHORITY.with_borrow(Option::is_none));
    assert!(hub().surface.is_some());
    let mirrored = Arc::new(Mutex::new(Vec::new()));
    let log = mirrored.clone();
    let observer = register_observer(Arc::new(move |observed| {
        if let Observed::Mirrored {
            caller,
            operation,
            arguments,
            ..
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
        Arc::new(active),
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
        Arc::new(active),
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
        Arc::new(active),
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
            Arc::new(active)
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
            Arc::new(active)
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

    let queue = Arc::new(Queued::default());
    let _queued = register(queue.clone());
    let receiver = submit(
        "m",
        "composer.write",
        json!({"revision":0}),
        event,
        false,
        Some("a"),
        None,
    )
    .unwrap();
    let queued = queue.0.lock().unwrap().pop().unwrap();
    assert!((queued.validity.0)());
    drop(receiver);
    assert!(
        !(queued.validity.0)(),
        "dropping the waiter revokes queued effects"
    );
    let authority = Arc::new(AtomicBool::new(true));
    let check = authority.clone();
    let receiver = submit_bound(
        "m",
        "composer.write",
        json!({"revision":0}),
        event,
        false,
        Some("a"),
        Some("confirm".into()),
        Arc::new(move || check.load(Ordering::Acquire)),
    )
    .unwrap();
    let held = queue.0.lock().unwrap().pop().unwrap();
    authority.store(false, Ordering::Release);
    assert!(
        !(held.validity.0)(),
        "revocation is checked before the waiter polls"
    );
    drop(receiver);

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
fn global_attachment_owner_lookup_requires_account_user_confirmation() {
    let _serial = hub_test();
    let _registration = register(Arc::new(Echo));
    let dir = tempfile::tempdir().unwrap();
    let arguments = json!({"method": "thread/attachmentOwner/list", "params": {
        "attachmentType": "file", "identityKey": "shared", "archived": true,
        "cursor": "foreign-thread-cursor", "limit": 10
    }});
    let request = |capability: &str, context| {
        app_request(
            "m",
            &[capability.to_owned()],
            context,
            false,
            None,
            dir.path(),
            &[],
            arguments.clone(),
            Arc::new(|| true),
        )
    };
    for capability in ["sessions", "threads", "inventory"] {
        assert_eq!(
            request(capability, InvocationContext::User).unwrap_err(),
            "app_capability_missing: account"
        );
    }
    assert_eq!(
        request("account", InvocationContext::Event).unwrap_err(),
        "app_context_user_only: thread/attachmentOwner/list"
    );
    let value = request("account", InvocationContext::User).unwrap();
    assert_eq!(value["arguments"], arguments);
    assert_eq!(
        value["confirm"],
        format!(
            "Mod m requests thread/attachmentOwner/list with {}.",
            arguments["params"]
        )
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
        "model_providers": {"p": {"base_url": "https://p/v1?key=s11", "http_headers": {"X-Key": "s5"}, "query_params": {"key": "s6"}, "experimental_bearer_token": "s7", "env_key": "OPENAI_API_KEY"}, "q": {"env_key": "sk-proj-s20"}, "r": {"env_key": "f3a9c1d27b8e4s21"}, "t": {"env_key": "AKIAS22EXAMPLE"}},
        "otel": {"exporter": {"otlp-http": {"endpoint": "https://otel.example", "headers": {"x-api": "s12"}}}},
        "shell_environment_policy": {"inherit": "core", "set": {"DEPLOY": "s13"}},
        "profiles": {"w": {"mcp_servers": {"x": {"command": "x", "args": ["--auth", "s14"], "env": {"K": "s15"}}}}},
        "notify": ["notify", "--header=Authorization: Bearer s16"],
        "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "curl -H 'X-Api-Key: s17' x"}]}]},
        "tools": {"web": {"auth_token": "s18"}},
        "developer_instructions": "Be brief.\npassword: s19\nRun tests.",
        "cli_auth_credentials_store": "keyring",
        "model_auto_compact_token_limit_scope": "thread",
        "model_auto_compact_token_limit": 7
    });
    redact_config(&mut config);
    let text = config.to_string();
    assert!(
        (1..=22).all(|index| !text.contains(&format!("s{index}"))),
        "{text}"
    );
    assert_eq!(
        config["developer_instructions"],
        "Be brief.\n<redacted>\nRun tests."
    );
    assert_eq!(config["cli_auth_credentials_store"], "keyring");
    assert_eq!(config["model_auto_compact_token_limit_scope"], "thread");
    assert_eq!(config["model_auto_compact_token_limit"], 7);
    assert_eq!(config["shell_environment_policy"]["inherit"], "core");
    assert_eq!(config["notify"][0], "notify");
    assert_eq!(config["mcp_servers"]["docs"]["env"]["TOKEN"], "<redacted>");
    assert_eq!(config["mcp_servers"]["docs"]["oauth"]["client_id"], "id");
    assert_eq!(config["model_providers"]["p"]["env_key"], "OPENAI_API_KEY");
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
fn hook_lists_redact_secret_commands() {
    let mut hooks = json!({"data": [{"cwd": "/r", "warnings": [], "errors": [], "hooks": [
        {"key": "user:stop:0", "eventName": "stop", "handlerType": "command", "async": false,
            "command": "curl -H 'Authorization: Bearer s1' https://hooks.example"},
        {"key": "user:stop:1", "eventName": "stop", "handlerType": "command", "async": false,
            "command": "./notify.sh"}
    ]}]});
    redact_result("hooks/list", &mut hooks);
    let hooks = &hooks["data"][0]["hooks"];
    assert_eq!(hooks[0]["command"], "<redacted>");
    assert_eq!(hooks[0]["key"], "user:stop:0");
    assert_eq!(hooks[1]["command"], "./notify.sh");
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
        ("terminal.selection", json!({})),
        ("terminal.copy", json!({"text": "test"})),
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
            .err(),
            Some(needs_terminal_error(operation))
        );
    }
    assert!(!needs_terminal("terminal.pty", &json!({"action": "write"})));
    assert!(awaits_user("terminal.pty", &json!({"action": "start"})));
    assert!(awaits_user("terminal.open", &json!({"path": "a.rs"})));
    assert!(!awaits_user("terminal.pty", &json!({"action": "write"})));
}

#[test]
fn clipboard_operations_require_local_user_context_without_waiting_for_confirmation() {
    for operation in ["terminal.selection", "terminal.copy"] {
        assert!(!awaits_user(operation, &json!({})));
        assert_eq!(
            submit(
                "m",
                operation,
                json!({}),
                InvocationContext::Event,
                false,
                None,
                None
            )
            .err(),
            Some(format!("host_operation_user_only: {operation}"))
        );
        assert_eq!(
            submit(
                "m",
                operation,
                json!({}),
                InvocationContext::User,
                true,
                None,
                None
            )
            .err(),
            Some(needs_terminal_error(operation))
        );
    }
}

#[test]
fn notices_validate_placement_lifetime_audience_and_tool_correlation() {
    assert_eq!(
        notice_request(&json!({"text": "saved"})),
        Ok(NoticeRequest::Transient {
            id: None,
            kind: "info",
            placement: NoticePlacement::Toast,
            text: "saved",
            ttl: std::time::Duration::from_secs(5),
        })
    );
    assert_eq!(
        notice_request(
            &json!({"text": "slow", "kind": "warning", "placement": "transcript",
            "audience": "model", "tool_call_id": "call_1"})
        ),
        Ok(NoticeRequest::Transcript {
            kind: "warning",
            text: "slow",
            model: true,
            call_id: Some("call_1"),
        })
    );
    assert_eq!(
        notice_request(&json!({"id": "run", "placement": "status", "clear": true})),
        Ok(NoticeRequest::Clear { id: "run" })
    );
    for arguments in [
        json!({}),
        json!({"text": " "}),
        json!({"text": "x".repeat(513)}),
        json!({"text": "a\u{1b}b"}),
        json!({"text": "x", "kind": "fatal"}),
        json!({"text": "x", "ttl_ms": 999}),
        json!({"text": "x", "ttl_ms": 60_001}),
        json!({"text": "x", "audience": "model"}),
        json!({"text": "x", "tool_call_id": "call_1"}),
        json!({"text": "x", "placement": "transcript", "ttl_ms": 2000}),
        json!({"text": "x", "placement": "transcript", "id": "run"}),
        json!({"id": "run", "placement": "transcript", "clear": true}),
        json!({"id": "Bad Id", "clear": true}),
    ] {
        assert_eq!(
            notice_request(&arguments),
            Err("terminal_notice_invalid".to_owned()),
            "{arguments}"
        );
    }
}

#[test]
fn decoder_rejects_oversized_dimensions_before_pixel_allocation() {
    let image = image::RgbaImage::new(IMAGE_PIXELS + 1, 1);
    let mut bytes = Vec::new();
    image
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    assert!(decode_image(&bytes).is_err());
    assert!(decode_image(b"GIF89a").is_err());
    assert!(decode_image(&vec![0; 8 * 1024 * 1024 + 1]).is_err());
}

fn packed(cells: &[[u32; 3]]) -> String {
    STANDARD.encode(
        cells
            .iter()
            .flatten()
            .flat_map(|word| word.to_le_bytes())
            .collect::<Vec<_>>(),
    )
}

#[test]
fn packed_blits_decode_colors_and_refuse_invalid_cells_before_queueing() {
    let request = |rect: &Value, packed: &str| {
        blit_request(
            "demo",
            Some("demo"),
            Some((4, 2)),
            &json!({"key": "art", "rect": rect, "packed": packed}),
        )
    };
    let rect = json!({"x": 1, "y": 1, "width": 3, "height": 1});
    let cells = [
        ['▀' as u32, 0x00ff_8000, PACKED_DEFAULT],
        ['a' as u32, PACKED_INDEXED | 9, 0x0000_0001],
        [' ' as u32, PACKED_DEFAULT, PACKED_INDEXED | 255],
    ];
    let Ok(Blit {
        content: BlitContent::Cells { cells: decoded, .. },
        ..
    }) = request(&rect, &packed(&cells))
    else {
        panic!("packed cells decode");
    };
    assert_eq!(
        decoded,
        vec![
            BlitCell {
                symbol: "▀".into(),
                fg: Some(crate::ModColor::Rgb(255, 128, 0)),
                bg: None
            },
            BlitCell {
                symbol: "a".into(),
                fg: Some(crate::ModColor::Indexed(9)),
                bg: Some(crate::ModColor::Rgb(0, 0, 1))
            },
            BlitCell {
                symbol: " ".into(),
                fg: None,
                bg: Some(crate::ModColor::Indexed(255))
            },
        ]
    );
    let refused = |rect: &Value, packed: String| {
        request(rect, &packed)
            .err()
            .map(|error| (error.kind, error.message))
    };
    let fatal = |message: &str| Some((BlitErrorKind::Fatal, message.to_owned()));
    let cell = |point: u32, fg: u32| packed(&[[point, fg, PACKED_DEFAULT]]);
    let one = json!({"x": 0, "y": 0, "width": 1, "height": 1});
    assert_eq!(
        refused(&one, "***".into()),
        fatal("terminal_blit_packed_invalid: bad base64")
    );
    assert_eq!(
        refused(&rect, cell('a' as u32, 0)),
        fatal("terminal_blit_packed_invalid: 12 bytes for 3 cells, expected 36")
    );
    for point in [0x7, 0x4e00, 0x301, 0xd800, 0x11_0000] {
        assert_eq!(
            refused(&one, cell(point, 0)),
            fatal(&format!(
                "terminal_blit_packed_invalid: cell 0 code point {point:#x} is not one printable column"
            ))
        );
    }
    for color in [0x0100_0001, 0x0200_0100, 0x0300_0000] {
        assert_eq!(
            refused(&one, cell('a' as u32, color)),
            fatal(&format!(
                "terminal_blit_packed_invalid: cell 0 color {color:#010x}"
            ))
        );
    }
    for arguments in [
        json!({"key": "art", "rect": one, "packed": cell('a' as u32, 0), "cells": ["a"]}),
        json!({"key": "art", "packed": cell('a' as u32, 0)}),
        json!({"key": "art", "rect": {"x": 3, "y": 0, "width": 2, "height": 1}, "packed": cell('a' as u32, 0)}),
    ] {
        assert_eq!(
            blit_request("demo", Some("demo"), Some((4, 2)), &arguments)
                .err()
                .map(|error| error.message),
            Some("terminal_blit_invalid".to_owned())
        );
    }
    assert_eq!(
        blit_request(
            "intruder",
            Some("demo"),
            Some((4, 2)),
            &json!({"key": "art", "rect": one, "packed": "***"})
        )
        .err(),
        Some(BlitError::retryable("terminal_blit_not_owned"))
    );
    assert_eq!(
        unpacked(json!({"key": "art", "rect": rect, "packed": packed(&cells)})),
        json!({"key": "art", "rect": rect,
            "cells": [["▀", "#ff8000", null], ["a", 9, "#000001"], [" ", null, 255]]})
    );
}
