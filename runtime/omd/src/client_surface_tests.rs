use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Echo;

#[test]
fn raw_snapshot_waits_for_admission_and_shares_the_accepted_frame() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pixels");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let received = seen.clone();
    let mut binding = crate::process_raster::bind(
        None,
        "raw-admission",
        vec![(
            "raw-admission-frame".into(),
            crate::process_raster::Role::Raster,
        )],
        Arc::new(move |value| {
            received.lock().unwrap().push(value);
            true
        }),
    );
    let initialized = binding.pixels(&path, None).unwrap();
    std::fs::write(&path, [1, 2, 3]).unwrap();
    let cancelled = Arc::new(AtomicBool::new(true));
    let lifetime = CallLifetime {
        upstream_cancelled: Some(cancelled.clone()),
        ..Default::default()
    };
    let retained = lifetime.pixels.clone();
    let call = SurfaceCall {
        validity: Validity(Arc::new(|| true)),
        caller: "raw-admission".into(),
        operation: "terminal.blit".into(),
        arguments: json!({"key":"raw-admission-frame","pixels":{"source":initialized["pixels"]["source"],"format":"rgb","width":1,"height":1,"sequence":1}}),
        context: InvocationContext::Event,
        remote: false,
        thread: None,
        authority: None,
        confirm: None,
        reply: sync_channel(1).0,
        lifetime,
    };
    assert!(call.snapshot_pixels().is_err());
    assert!(seen.lock().unwrap().is_empty());
    assert!(retained.get().is_none());
    cancelled.store(false, Ordering::Release);
    let accepted = call.snapshot_pixels().unwrap().unwrap();
    assert!(Arc::ptr_eq(retained.get().unwrap(), &accepted));
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert!(call.snapshot_pixels().is_err());
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[test]
fn encoded_blits_need_ownership_but_not_cell_dimensions() {
    let image = json!({"key":"frame","image":{"media_type":"image/png","base64":"AA=="}});
    assert!(blit_request("owner", Some("owner"), None, &image).is_ok());
    assert!(blit_request("other", Some("owner"), None, &image).is_err());
    let cells = json!({"key":"frame","rect":{"x":0,"y":0,"width":1,"height":1},"cells":["x"]});
    assert!(blit_request("owner", Some("owner"), None, &cells).is_err());
}

#[test]
fn dropping_a_pending_reply_revokes_queued_effects() {
    let (reply, receiver) = sync_channel(1);
    let lifetime = CallLifetime::default();
    let pending = PendingReply {
        receiver,
        lifetime: lifetime.clone(),
    };
    assert!(lifetime.active());
    drop(pending);
    assert!(!lifetime.active());
    assert!(lifetime.begin_execution().is_err());
    assert!(reply.send(Ok(Value::Null)).is_err());
    let expired = CallLifetime::default();
    *expired.deadline.lock().unwrap() = Some(Instant::now());
    assert!(!expired.active());
    assert!(expired.begin_execution().is_err());
    let cancelled = Arc::new(AtomicBool::new(false));
    let admitted = CallLifetime {
        upstream_cancelled: Some(cancelled.clone()),
        ..Default::default()
    };
    assert!(admitted.active());
    cancelled.store(true, Ordering::Release);
    assert!(!admitted.active());
    assert!(admitted.begin_execution().is_err());
}

impl ClientSurface for Echo {
    fn submit(&self, call: SurfaceCall) -> Result<(), String> {
        let value = json!({"operation": call.operation, "caller": call.caller,
            "confirm": call.confirm, "arguments": call.arguments,
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

struct Answers(Result<Value, String>);

impl ClientSurface for Answers {
    fn submit(&self, call: SurfaceCall) -> Result<(), String> {
        call.reply
            .send(self.0.clone())
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
fn only_accepted_mirrored_operations_are_mirrored() {
    let _serial = hub_test();
    let mirrored = Arc::new(AtomicUsize::new(0));
    let counter = mirrored.clone();
    let observer = register_observer(Arc::new(move |observed| {
        if matches!(observed, Observed::Mirrored { .. }) {
            counter.fetch_add(1, Ordering::SeqCst);
        }
    }));
    for (answer, count) in [
        (Err("terminal_blit_not_owned".to_owned()), 0),
        (
            Ok(json!({"status": "backpressure", "retry_after_ms": 5})),
            0,
        ),
        (Ok(json!({"frame": 1, "queued": 1, "frame_ms": 16})), 1),
    ] {
        let registration = register(Arc::new(Answers(answer.clone())));
        let blit = call(
            "m",
            "terminal.blit",
            json!({"key": "r"}),
            InvocationContext::Event,
            false,
            None,
            None,
            Arc::new(|| true),
        );
        assert_eq!(blit, answer);
        assert_eq!(mirrored.swap(0, Ordering::SeqCst), count, "{answer:?}");
        drop(registration);
    }
    drop(observer);
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
}

#[test]
fn presentation_reports_the_terminal_screen_mode() {
    set_screen("inline");
    assert_eq!(
        presented(json!({"thread_id": null, "phase": "fresh"})),
        json!({"thread_id": null, "phase": "fresh", "surface": "inline"})
    );
    assert_eq!(presented(Value::Null), Value::Null);
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
fn image_frames_become_full_raster_half_block_cells_for_cell_clients() {
    let mut png = Vec::new();
    image::RgbImage::from_pixel(8, 2, image::Rgb([255, 0, 0]))
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    let arguments =
        json!({"key": "r", "image": {"media_type": "image/png", "base64": STANDARD.encode(png)}});
    let cells = frame_cells(&arguments, (4, 2)).unwrap();
    assert_eq!(
        cells["rect"],
        json!({"x": 0, "y": 0, "width": 4, "height": 2})
    );
    let red = serde_json::to_value(crate::ModColor::Rgb(255, 0, 0)).unwrap();
    let black = serde_json::to_value(crate::ModColor::Rgb(0, 0, 0)).unwrap();
    assert_eq!(cells["cells"][0], json!(["▀", red, black]));
    assert_eq!(cells["cells"][4], json!(" "));
    assert_eq!(cells["cells"].as_array().unwrap().len(), 8);
    assert!(frame_cells(&json!({"key": "r"}), (4, 2)).is_none());
}
