use super::WARM;
use super::evaluate_warm;
use super::sandboxed;
use serde_json::json;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

const BUDGET: Duration = Duration::from_secs(2);

#[test]
fn reused_process_resets_callback_globals_and_reloads_source() {
    let mut request = json!({"source":"let count = 0; export default api => api.command('count', () => { globalThis.marker = (globalThis.marker ?? 0) + 1; Array.prototype.marker = (Array.prototype.marker ?? 0) + 1; return { count: ++count, marker: globalThis.marker, intrinsic: [].marker, state: api.state.get() }; });",
        "filename":"/fixture/fresh/index.ts", "api":crate::MOD_API_VERSION, "capabilities":["commands", "store"],
        "surface":{"events":{},"replacements":[],"middleware":[],"state":"store","contracts":"contracts"},
        "state":null,"settings":{},"event":"command","name":"count","interactive":true,"reuse":true,"hook_budget_ms":1000,"payload":null});
    for state in 0..1000 {
        request["state"] = json!({"current":state});
        let reply = super::evaluate_warm(
            "fresh-context",
            &request,
            None,
            BUDGET,
            &|| true,
            &mut |_| unreachable!(),
        )
        .unwrap();
        assert_eq!(
            reply["value"],
            json!({"count":1,"marker":1,"intrinsic":1,"state":{"current":state}})
        );
    }
    request["source"] =
        json!("export default api => api.command('count', () => { while (true) {} });");
    let started = std::time::Instant::now();
    let error = super::evaluate_warm(
        "fresh-context",
        &request,
        None,
        BUDGET,
        &|| started.elapsed() < Duration::from_millis(100),
        &mut |_| unreachable!(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("callback_cancelled"), "{error}");
    assert!(
        !WARM
            .lock()
            .unwrap()
            .iter()
            .any(|runner| runner.key == "fresh-context")
    );
    request["source"] =
        json!("export default api => api.command('count', () => ({ changed: true }));");
    let reply = super::evaluate_warm(
        "fresh-context",
        &request,
        None,
        BUDGET,
        &|| true,
        &mut |_| unreachable!(),
    )
    .unwrap();
    assert_eq!(reply["value"], json!({"changed":true}));
    request["reuse"] = json!(false);
    let once = super::evaluate(&request, None, BUDGET, &|| true, &mut |_| unreachable!()).unwrap();
    assert_eq!(reply, once);
    super::invalidate_warm("fresh-context");
}

#[test]
fn reused_process_resends_changed_package_fields_and_replaces_a_runner_that_died_idle() {
    let mut request = json!({"source":"export default api => api.command('v', () => 1);",
        "filename":"/fixture/kept/index.ts", "api":crate::MOD_API_VERSION, "capabilities":["commands"],
        "surface":{"events":{},"replacements":[],"middleware":[],"state":"store","contracts":"contracts"},
        "state":null,"settings":{},"event":"command","name":"v","interactive":true,"reuse":true,"hook_budget_ms":1000,"payload":null});
    let run = |request: &serde_json::Value| {
        evaluate_warm(
            "kept-fields",
            request,
            None,
            BUDGET,
            &|| true,
            &mut |_| unreachable!(),
        )
        .unwrap()["value"]
            .clone()
    };
    assert_eq!(run(&request), json!(1));
    assert_eq!(run(&request), json!(1));
    request["source"] = json!("export default api => api.command('v', () => 2);");
    assert_eq!(
        run(&request),
        json!(2),
        "a live runner gets the changed source"
    );
    watchdog_kill("kept-fields");
    assert_eq!(
        run(&request),
        json!(2),
        "a runner that died idle is replaced"
    );
    super::invalidate_warm("kept-fields");
}

fn watchdog_kill(key: &str) {
    let pid = WARM
        .lock()
        .unwrap()
        .iter()
        .find(|runner| runner.key == key)
        .unwrap()
        .child
        .id();
    let mut tracked = super::TRACKED.lock().unwrap();
    // SAFETY: the pooled runner is an unreaped child of this process.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    tracked.get_mut(&pid).unwrap().0 = true;
    drop(tracked);
    std::thread::sleep(Duration::from_millis(100));
}

#[test]
fn a_render_runner_killed_idle_by_the_watchdog_fails_the_next_render_once() {
    let input = json!({"component":"tool_call"});
    let request = json!({"source":"export default api => api.intercept('render', () => ({ ok: true }));",
        "filename":"/fixture/index.ts", "api":crate::MOD_API_VERSION, "capabilities":["terminal"],
        "surface":{"events":{},"replacements":[],"middleware":[],"intercept":{"render":"terminal"},"state":"store","contracts":"contracts"},
        "state":null,"settings":{},"event":"intercept","name":"0","interactive":true,"serve":true,"hook_budget_ms":1000,
        "payload":{"surface":"render","input":input,"original":input,"origin":{"caller":"engine"}}});
    let run = || {
        evaluate_warm(
            "idle-watchdog",
            &request,
            None,
            BUDGET,
            &|| true,
            &mut |_| unreachable!(),
        )
    };
    run().unwrap();
    watchdog_kill("idle-watchdog");
    let error = run().unwrap_err().to_string();
    assert!(error.starts_with("mod_out_of_memory:"), "{error}");
    run().unwrap();
    super::invalidate_warm("idle-watchdog");
}

#[test]
fn reused_process_keeps_each_packages_authority_and_host_identity() {
    let mut request = json!({"source":"export default api => { if (globalThis.activated) throw new Error('activation_leaked'); globalThis.activated = true; api.command('identity', () => { let writable = true; try { api.state.set(1); } catch { writable = false; } return {settings:api.settings, package:api.package.id, writable, caller:api.host.call('identity')}; }); };",
        "filename":"/fixture/a/index.ts", "api":crate::MOD_API_VERSION, "capabilities":["commands","store"],
        "surface":{"events":{},"replacements":[],"middleware":[],"state":"store","contracts":"contracts"},
        "state":null,"settings":{},"event":"command","name":"identity","interactive":true,"reuse":true,"hook_budget_ms":1000,"payload":null});
    for (package, writable) in [("a", true), ("b", false), ("a", true)] {
        request["filename"] = json!(format!("/fixture/{package}/index.ts"));
        request["package"] = json!({"id":package,"version":"1.0.0"});
        request["settings"] = json!({"owner":package});
        request["capabilities"] = if writable {
            json!(["commands", "store"])
        } else {
            json!(["commands"])
        };
        for event in ["inspect", "command", "inspect"] {
            request["event"] = json!(event);
            let reply = evaluate_warm(
                "cross-package",
                &request,
                None,
                BUDGET,
                &|| true,
                &mut |frame| {
                    assert_eq!(event, "command");
                    assert_eq!(frame["call"]["operation"], "identity");
                    Ok(json!({"value":package}))
                },
            )
            .unwrap();
            assert_eq!(
                reply["registrations"]["commands"],
                json!([{"name":"identity"}])
            );
            if event == "command" {
                assert_eq!(
                    reply["value"],
                    json!({"settings":{"owner":package},"package":package,"writable":writable,"caller":package})
                );
            } else {
                assert!(reply["value"].is_null());
            }
        }
    }
    super::invalidate_warm("cross-package");
}

#[test]
fn array_buffers_past_the_memory_limit_kill_the_runner_with_a_memory_failure() {
    let mut request = json!({"source":"export default api => api.command('fill', () => { const buffers = []; for (let i = 0; i < 1024; i++) buffers.push(new Uint8Array(1 << 20).fill(1)); return buffers.length; });",
        "filename":"/fixture/memory/index.ts", "api":crate::MOD_API_VERSION, "capabilities":["commands"],
        "surface":{"events":{},"replacements":[],"middleware":[],"state":"store","contracts":"contracts"},
        "state":null,"settings":{},"event":"command","name":"fill","interactive":true,"reuse":true,"hook_budget_ms":5000,"payload":null});
    let run = |request: &serde_json::Value| {
        evaluate_warm(
            "memory-limit",
            request,
            None,
            Duration::from_secs(5),
            &|| true,
            &mut |_| unreachable!(),
        )
    };
    let error = run(&request).unwrap_err().to_string();
    assert!(error.starts_with("mod_out_of_memory:"), "{error}");
    request["reuse"] = json!(false);
    let error = super::evaluate(
        &request,
        None,
        Duration::from_secs(5),
        &|| true,
        &mut |_| unreachable!(),
    )
    .unwrap_err()
    .to_string();
    assert!(error.starts_with("mod_out_of_memory:"), "{error}");
    request["reuse"] = json!(true);
    request["source"] = json!("export default api => api.command('fill', () => 1);");
    assert_eq!(run(&request).unwrap()["value"], 1);
}

#[test]
fn render_registration_mutations_are_refused_and_invalidation_retires_runner() {
    for mutation in [
        "api.on('terminal', () => {})",
        "api.middleware('approval', () => {})",
        "api.replace('completion', () => {})",
        "api.tool({name:'late'}, () => {})",
        "api.command('late', () => {})",
    ] {
        let input = json!({"component":"tool_call"});
        let request = json!({"source":format!("export default api => api.intercept('render', () => {{ {mutation}; return {{}}; }});"),
            "filename":"/fixture/index.ts", "api":crate::MOD_API_VERSION, "capabilities":["terminal","tools","commands","middleware","approvals"],
            "surface":{"events":{"terminal":"terminal","completion":"terminal"},"replacements":["completion"],"middleware":["approval"],"intercept":{"render":"terminal"},"state":"store","contracts":"contracts"},
            "state":null,"settings":{},"event":"intercept","name":"0","interactive":true,"serve":true,"hook_budget_ms":1000,
            "payload":{"surface":"render","input":input,"original":input,"origin":{"caller":"engine"}}});
        let error = evaluate_warm(
            "registration-mutation",
            &request,
            None,
            BUDGET,
            &|| true,
            &mut |_| unreachable!(),
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("registration_outside_activation"),
            "{error}"
        );
        assert!(
            !WARM
                .lock()
                .unwrap()
                .iter()
                .any(|runner| runner.key == "registration-mutation")
        );
    }
    let input = json!({"component":"tool_call"});
    let request = json!({"source":"export default api => { const spec = {name:'original'}; api.tool(spec, () => {}); api.intercept('render', () => { spec.name = 'changed'; return {}; }); };",
        "filename":"/fixture/index.ts", "api":crate::MOD_API_VERSION, "capabilities":["terminal","tools"],
        "surface":{"events":{},"replacements":[],"middleware":[],"intercept":{"render":"terminal"},"state":"store","contracts":"contracts"},
        "state":null,"settings":{},"event":"intercept","name":"0","interactive":true,"serve":true,"hook_budget_ms":1000,
        "payload":{"surface":"render","input":input,"original":input,"origin":{"caller":"engine"}}});
    let reply = evaluate_warm(
        "registration-input",
        &request,
        None,
        BUDGET,
        &|| true,
        &mut |_| unreachable!(),
    )
    .unwrap();
    assert_eq!(reply["registrations"]["tools"][0]["name"], "original");
    super::invalidate_warm("registration-input");
    assert!(
        !WARM
            .lock()
            .unwrap()
            .iter()
            .any(|runner| runner.key == "registration-input")
    );
    let error = evaluate_warm(
        "cancelled-render",
        &request,
        None,
        BUDGET,
        &|| false,
        &mut |_| unreachable!(),
    )
    .unwrap_err();
    assert!(error.to_string().contains("callback_cancelled"));
    assert!(
        !WARM
            .lock()
            .unwrap()
            .iter()
            .any(|runner| runner.key == "cancelled-render")
    );
}

#[test]
fn os_sandbox_denies_host_files_network_and_children() {
    let temp = tempfile::TempDir::new().unwrap();
    let secret = temp.path().join("fixture-secret");
    std::fs::write(&secret, "synthetic secret\n").unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let script = r#"
        exec 2>&1
        echo started
        read -r line < "$1" && echo read=allowed
        printf bad > "$1" && echo write=allowed
        : 3<>"/dev/tcp/127.0.0.1/$2" && echo network=allowed
        /usr/bin/true && echo child=allowed
    "#;
    let probe = |mut command: std::process::Command| {
        let result = command
            .args(["-c", script, "probe"])
            .arg(&secret)
            .arg(&port)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        String::from_utf8_lossy(&result.stdout).into_owned()
    };
    let output = probe(sandboxed(Path::new("/bin/bash")).unwrap());
    let denied = format!("{}: Operation not permitted", secret.display());
    assert!(output.starts_with("started\n"), "{output}");
    assert_eq!(output.matches(&denied).count(), 2, "{output}");
    assert!(
        output.contains("connect: Operation not permitted"),
        "{output}"
    );
    assert!(output.contains("fork: Operation not permitted"), "{output}");
    assert!(!output.contains("allowed"), "{output}");
    assert_eq!(
        std::fs::read_to_string(&secret).unwrap(),
        "synthetic secret\n"
    );
    assert_eq!(
        probe(std::process::Command::new("/bin/bash")),
        "started\nread=allowed\nwrite=allowed\nnetwork=allowed\nchild=allowed\n"
    );
}
