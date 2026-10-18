use super::*;
use codex_omd::Limits;
use codex_omd::MOD_API_VERSION;
use codex_omd::ModHost;
use codex_omd::ModStore;
use codex_omd::WorkerLimits;
use serde_json::json;
use std::path::Path;

fn rates() -> Rates {
    Rates {
        input_microusd_per_million: 100000,
        cached_microusd_per_million: 2000,
        cache_write_microusd_per_million: None,
        output_microusd_per_million: 200000,
        reservation_microusd: 10000,
        max_output_tokens: 128,
        input_token_ceiling: 5000,
        included_subscription: false,
        external_subscription: false,
        provider_billed: false,
    }
}

fn account(task: &Arc<Task>, root: &Path, owner: &str) -> Account {
    Account {
        task: task.clone(),
        owner: owner.into(),
        model: "fixture-model".into(),
        provider: "fixture".into(),
        url: "http://localhost/responses".into(),
        max_request_bytes: 2048,
        rates: Some(rates()),
        repository_identity: "fixture".into(),
        cost_capture: root.join("evidence").join("task-cost.json"),
        route: Some("worker".into()),
        lead_routes: Vec::new(),
        worker_authorization: None,
        credential: None,
        context_window: Some(1000),
        max_output_tokens: None,
        cache_through: None,
        capture_tools: false,
    }
}

fn setup() -> (
    tempfile::TempDir,
    Accounts,
    Arc<Task>,
    Request,
    EncodedJsonBody,
) {
    let root = tempfile::tempdir().unwrap();
    let task = Arc::new(
        Task::create(
            Limits {
                requests: 3,
                exposure_microusd: 20000,
                seconds: 30,
                concurrent_workers: 2,
                max_depth: 2,
            },
            root.path().join("evidence"),
        )
        .unwrap(),
    );
    let accounts = Accounts::default();
    accounts
        .by_thread
        .lock()
        .unwrap()
        .insert("child".into(), account(&task, root.path(), "worker"));
    task.start_worker(
        "worker".into(),
        "lead".into(),
        1,
        WorkerLimits {
            requests: 2,
            exposure_microusd: 20000,
            seconds: 20,
        },
    )
    .unwrap();
    task.authorize_worker_route("worker", "fixture", "fixture-model")
        .unwrap();
    let mut request = Request::new(http::Method::POST, "http://localhost/responses".into());
    request
        .headers
        .insert("thread-id", "child".parse().unwrap());
    let body = EncodedJsonBody::encode(
        &json!({"model": "fixture-model", "reasoning":{"effort":"high"}, "stream": true, "max_output_tokens": 128}),
    )
    .unwrap();
    (root, accounts, task, request, body)
}

fn install_middleware(accounts: &Accounts, root: &Path, source: &str) {
    install_package(accounts, root, source, &["middleware"]);
}

fn install_package(
    accounts: &Accounts,
    root: &Path,
    source: &str,
    capabilities: &[&str],
) -> (ModStore, std::path::PathBuf, Arc<Mutex<ModHost>>) {
    let node = std::path::PathBuf::from(std::env::var_os("OMD_TEST_NODE").unwrap());
    let store = ModStore::create(root.join("mod-store"), node).unwrap();
    let package = root.join("request_router");
    std::fs::create_dir(&package).unwrap();
    std::fs::write(
        package.join("mod.json"),
        serde_json::to_vec(&json!({"schema":1,"id":"request_router","version":"1.0.0",
            "api":MOD_API_VERSION,"state_version":1,"capabilities":capabilities}))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(package.join("index.ts"), source).unwrap();
    let package = package.canonicalize().unwrap();
    let inspected = ModStore::inspect_package(&package).unwrap();
    store
        .trust(
            package.clone(),
            inspected["sha256"].as_str().unwrap(),
            capabilities
                .iter()
                .map(|capability| (*capability).to_owned())
                .collect(),
            "user",
        )
        .unwrap();
    store.enable(&package, true).unwrap();
    let runtime = ModHost::open(root.join("mod-store").canonicalize().unwrap()).unwrap();
    let required = runtime.required_surfaces();
    let runtime = Arc::new(Mutex::new(runtime));
    accounts.install_mod_runtime(runtime.clone(), required);
    (store, package, runtime)
}

fn prepared(accounts: &Accounts, thread: &str, body: &Value) -> Result<Value, TransportError> {
    let mut request = Request::new(http::Method::POST, "http://localhost/responses".into());
    request.headers.insert("thread-id", thread.parse().unwrap());
    let mut encoded = Some(EncodedJsonBody::encode(body).unwrap());
    accounts.prepare(&mut request, &mut encoded)?;
    Ok(serde_json::from_slice(encoded.unwrap().as_bytes()).unwrap())
}

fn final_records(root: &Path) -> Vec<Value> {
    std::fs::read_to_string(root.join("evidence").join("mod-middleware.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|record| {
            record["kind"]
                .as_str()
                .is_some_and(|kind| kind.starts_with("final_request"))
        })
        .collect()
}

#[test]
fn final_request_policies_edit_the_exact_body_reuse_verdicts_and_fail_closed() {
    let (root, accounts, _task, _request, _body) = setup();
    let source = r"export default api => {
        api.intercept('model_request', (e, next) => next({...e, sections: [...e.sections, {id: 'mod:late', text: 'late SECRET-2'}]}));
        api.intercept('model_send', async (e, next) => { await next(e); return {edits: []}; });
        api.intercept('model_send', {required: true}, async (e, next) => {
            const inner = await next(e);
            if (e.segments.some(s => s.text.includes('BLOCK'))) return {deny: 'blocked marker'};
            const edits = e.segments.filter(s => s.editable).flatMap(s =>
                [...s.text.matchAll(/SECRET-\d+|LOOP/g)].map(m => ({segment: s.id, start: m.index, end: m.index + m[0].length,
                    text: m[0] === 'LOOP' ? 'LOOP+' : '[secret]'})));
            const fresh = e.segments.some(s => s.text.includes('FRESH')) ? {cache: false} : {};
            return {edits: [...inner.edits, ...edits], ...fresh};
        });
    }";
    install_package(
        &accounts,
        root.path(),
        source,
        &["middleware", "request_policy"],
    );
    assert!(ResponseObserver::policed(&accounts));
    let long = format!("{} SECRET-4", "é".repeat(140_000));
    let body = |user: &str| {
        json!({"model":"fixture-model","reasoning":{"effort":"high"},"stream":true,"instructions":"base",
            "input":[
                {"type":"message","role":"developer","content":[{"type":"input_text","text":"sandbox SECRET-9"}],
                    "internal_chat_message_metadata_passthrough":{"content_item_kinds":["permissions.instructions"]}},
                {"type":"message","role":"user","content":[{"type":"input_text","text":user}]},
                {"type":"function_call","name":"exec","call_id":"c1","arguments":"{\"cmd\":\"echo SECRET-3\"}"},
                {"type":"message","role":"user","content":[{"type":"input_text","text":long}]}]})
    };
    let sent = prepared(&accounts, "child", &body("token SECRET-1 é")).unwrap();
    let input = &sent["input"];
    assert_eq!(input[0]["content"][0]["text"], "sandbox SECRET-9");
    assert!(
        input[0]["content"][1]["text"]
            .as_str()
            .unwrap()
            .ends_with("late [secret]")
    );
    assert_eq!(input[1]["content"][0]["text"], "token [secret] é");
    assert_eq!(input[2]["arguments"], "{\"cmd\":\"echo [secret]\"}");
    assert!(
        input[3]["content"][0]["text"]
            .as_str()
            .unwrap()
            .ends_with("é [secret]")
    );
    let first = final_records(root.path());
    assert_eq!(first[0]["pages"], 10);
    assert_eq!(first[0]["edits"].as_array().unwrap().len(), 4);

    assert_eq!(
        prepared(&accounts, "child", &body("token SECRET-1 é")).unwrap(),
        sent
    );
    let second = final_records(root.path());
    assert_eq!(
        (second[1]["pages"].clone(), second[1]["scanned"].clone()),
        (json!(1), json!(0))
    );
    let records = serde_json::to_string(&second).unwrap();
    assert!(!records.contains("SECRET") && !records.contains("token"));

    for _ in 0..2 {
        let fresh = prepared(&accounts, "child", &body("FRESH SECRET-7")).unwrap();
        assert_eq!(fresh["input"][1]["content"][0]["text"], "FRESH [secret]");
        assert_ne!(final_records(root.path()).last().unwrap()["scanned"], 0);
    }

    let internal = prepared(&accounts, "title-thread", &body("name SECRET-5")).unwrap();
    assert_eq!(internal["input"][1]["content"][0]["text"], "name [secret]");

    let blocked = prepared(&accounts, "child", &body("BLOCK"))
        .unwrap_err()
        .to_string();
    assert!(
        blocked.contains("final_request_refused: request_router: blocked marker"),
        "{blocked}"
    );
    let looping = prepared(&accounts, "child", &body("LOOP"))
        .unwrap_err()
        .to_string();
    assert!(
        looping.contains("final_request_unsettled: /input/1/content/0/text"),
        "{looping}"
    );
    assert_eq!(
        final_records(root.path()).last().unwrap()["kind"],
        "final_request_refused"
    );
}

#[test]
fn declared_request_policies_refuse_until_disabled_and_are_inert_without_policies() {
    let (root, accounts, _task, _request, _body) = setup();
    let source = "export default api => { throw new Error('policy failed to start'); }";
    let (store, package, runtime) = install_package(
        &accounts,
        root.path(),
        source,
        &["middleware", "request_policy"],
    );
    let body = json!({"model":"fixture-model","reasoning":{"effort":"high"},"stream":true,
        "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]});
    for thread in ["child", "title-thread"] {
        let refused = prepared(&accounts, thread, &body).unwrap_err().to_string();
        assert!(
            refused.contains("request_policy_unavailable: request_router: "),
            "{refused}"
        );
        assert!(refused.contains("policy failed to start"), "{refused}");
    }
    assert!(ResponseObserver::policed(&accounts));

    store.enable(&package, false).unwrap();
    runtime.lock().unwrap().reload().unwrap();
    assert!(!ResponseObserver::policed(&accounts));
    let internal = prepared(&accounts, "title-thread", &body).unwrap();
    assert_eq!(internal, body);
    assert!(prepared(&accounts, "child", &body).is_ok());
    assert!(
        final_records(root.path())
            .iter()
            .all(|record| record["kind"] == "final_request_refused")
    );
}

fn fast_route() -> RequestRoute {
    RequestRoute {
        name: "fast".into(),
        model: "fixture-fast".into(),
        provider: "fixture".into(),
        reasoning: "xhigh".into(),
        rates: rates(),
        credential: None,
        url: String::new(),
    }
}

#[test]
fn credential_routes_replace_auth_only_for_the_enrolled_origin() {
    let (root, accounts, task, mut request, body) = setup();
    let store = root.path().join("store");
    std::fs::create_dir(&store).unwrap();
    let store = store.canonicalize().unwrap();
    set_credential_root(store.clone());
    let profiles = codex_omd::credentials::CredentialProfiles::local(&store).unwrap();
    let profile = profiles.create("work key", "api_key", None, None).unwrap();
    let route = |url: &str| {
        let mut accounts = accounts.by_thread.lock().unwrap();
        let account = accounts.get_mut("child").unwrap();
        account.credential = Some(profile.id.clone());
        account.url = url.into();
    };
    request.headers.insert(
        http::header::AUTHORIZATION,
        "Bearer session".parse().unwrap(),
    );
    request.url = "https://api.openai.com/v1/responses".into();
    route(&request.url);
    let refused = accounts
        .before_send(&mut request, Some(&body))
        .err()
        .unwrap();
    assert!(format!("{refused:?}").contains("credential_not_enrolled"));
    profiles
        .store_auth(&profile.id, r#"{"OPENAI_API_KEY":"sk-profile"}"#)
        .unwrap();
    request.url = "http://localhost/responses".into();
    route(&request.url);
    let refused = accounts
        .before_send(&mut request, Some(&body))
        .err()
        .unwrap();
    assert!(format!("{refused:?}").contains("credential_origin_mismatch"));
    request.url = "https://api.openai.com/v1/responses".into();
    route(&request.url);
    assert!(accounts.before_send(&mut request, Some(&body)).is_ok());
    assert_eq!(
        request.headers.get(http::header::AUTHORIZATION).unwrap(),
        "Bearer sk-profile"
    );
    assert!(
        request
            .headers
            .get(http::header::AUTHORIZATION)
            .unwrap()
            .is_sensitive()
    );

    task.authorize_route("fixture", "fixture-fast").unwrap();
    let routed = EncodedJsonBody::encode(
        &json!({"model": "fixture-fast", "reasoning":{"effort":"xhigh"}, "stream": true, "max_output_tokens": 128}),
    )
    .unwrap();
    request.headers.insert("thread-id", "main".parse().unwrap());
    for (session, target, allowed) in [
        (
            "http://localhost/responses",
            "https://api.openai.com/v1/responses",
            true,
        ),
        (
            "https://api.openai.com/v1/responses",
            "http://localhost/responses",
            false,
        ),
    ] {
        let mut lead = account(&task, root.path(), "lead");
        lead.url = String::new();
        let mut remote = fast_route();
        remote.credential = Some(profile.id.clone());
        remote.url = target.into();
        lead.lead_routes = vec![remote];
        accounts
            .by_thread
            .lock()
            .unwrap()
            .insert("main".into(), lead);
        request
            .headers
            .insert("x-omd-route", "fast".parse().unwrap());
        request.url = session.into();
        let sent = accounts.before_send(&mut request, Some(&routed));
        assert_eq!(sent.is_ok(), allowed, "{session} -> {target}");
        if allowed {
            assert_eq!(request.url, target);
        }
    }
}

#[test]
fn middleware_switches_only_configured_lead_routes_and_transforms_text() {
    let (root, accounts, task, mut request, body) = setup();
    let source = "export default api => { api.intercept('model_request', (e, next) => next({...e, route: 'fast'})); api.intercept('response_stream', {match: {kind: 'text'}}, (e, next) => next({...e, text: e.text.toUpperCase()})); }";
    install_middleware(&accounts, root.path(), source);
    let mut prepared = Some(body.clone());
    assert!(accounts.prepare(&mut request, &mut prepared).is_err());

    let mut lead = account(&task, root.path(), "lead");
    lead.route = Some("main".into());
    lead.lead_routes = vec![fast_route()];
    accounts
        .by_thread
        .lock()
        .unwrap()
        .insert("main".into(), lead);
    task.authorize_route("fixture", "fixture-model").unwrap();
    task.authorize_route("fixture", "fixture-fast").unwrap();
    request.headers.insert("thread-id", "main".parse().unwrap());
    let mut prepared = Some(body.clone());
    accounts.prepare(&mut request, &mut prepared).unwrap();
    let routed: Value = serde_json::from_slice(prepared.as_ref().unwrap().as_bytes()).unwrap();
    assert_eq!(routed["model"], "fixture-fast");
    assert_eq!(routed["reasoning"]["effort"], "xhigh");

    let mut attempt = accounts
        .before_send(&mut request, prepared.as_ref())
        .unwrap()
        .unwrap();
    let mut delta =
        json!({"type":"response.output_text.delta","output_index":0,"item_id":"m","delta":"hello"});
    attempt.observe(&mut delta, true).unwrap();
    assert_eq!(delta["delta"], "HELLO");
    let mut done = json!({"type":"response.output_item.done","output_index":0,"item":{"type":"message",
        "id":"m","role":"assistant","content":[{"type":"output_text","text":"hello"}]}});
    attempt.observe(&mut done, true).unwrap();
    assert_eq!(
        done["item"]["content"][0]["text"], "HELLO",
        "the recorded text matches what streamed"
    );
    let usage =
        json!({"input_tokens":100,"input_tokens_details":{"cached_tokens":50},"output_tokens":10});
    let mut completed = json!({"type":"response.completed","response":{"usage":usage}});
    attempt.observe(&mut completed, true).unwrap();
    drop(attempt);
    let recorded = task.attempts().unwrap().remove(0);
    assert_eq!(recorded.model, "fixture-fast");
    assert_eq!(recorded.raw_usage, Some(usage));
    let log = std::fs::read_to_string(root.path().join("evidence/mod-middleware.jsonl")).unwrap();
    assert!(log.contains("fast") && log.contains("response_stream"));
}

#[test]
fn request_interceptors_edit_sections_answer_synthetically_and_rewrite_stream_tool_calls() {
    let (root, accounts, task, mut request, _body) = setup();
    let source = "export default api => {
        api.intercept('model_request', (e, next) => {
            const last = e.sections.at(-1)?.text;
            if (last === 'cache me') return {response: {output: [{type: 'message', text: 'cached answer'}, {type: 'tool_call', tool: 'exec_command', arguments: {cmd: 'ls'}}]}};
            if (last === 'elsewhere') return next({...e, route: 'other', sections: [...e.sections, {id: 'mod:note', text: 'routed'}]});
            return next({...e, effort: 'low', sections: [...e.sections.filter(s => s.id !== 'apps.instructions'), {id: 'mod:note', text: 'hint'}]});
        });
        api.intercept('response_stream', (e, next) => {
            if (e.kind === 'tool_call' && e.tool === 'blocked') return {chunks: []};
            if (e.kind === 'tool_done') return next({...e, arguments: JSON.stringify({cmd: 'pwd'})});
            if (e.kind === 'stop') return {chunks: [{kind: 'message', text: 'appended'}, e]};
            return next(e);
        });
    }";
    install_middleware(&accounts, root.path(), source);
    let notified = Arc::new(Mutex::new(Vec::new()));
    let sink = notified.clone();
    accounts.install_mod_notifier(Arc::new(move |event, payload| {
        sink.lock().unwrap().push((event, payload));
    }));
    let mut lead = account(&task, root.path(), "lead");
    lead.route = Some("main".into());
    let mut other = fast_route();
    other.name = "other".into();
    other.provider = "elsewhere".into();
    other.model = "elsewhere-model".into();
    lead.lead_routes = vec![fast_route(), other];
    accounts
        .by_thread
        .lock()
        .unwrap()
        .insert("main".into(), lead);
    for model in ["fixture-model", "fixture-fast"] {
        task.authorize_route("fixture", model).unwrap();
    }
    task.authorize_route("elsewhere", "elsewhere-model")
        .unwrap();
    request.headers.insert("thread-id", "main".parse().unwrap());
    let body = |last: &str| {
        let mut input = vec![json!({"type":"message","role":"developer",
            "content":[{"type":"input_text","text":"sandbox"},{"type":"input_text","text":"apps"},{"type":"input_text","text":last}],
            "internal_chat_message_metadata_passthrough":{"content_item_kinds":
                ["permissions.instructions","apps.instructions","hooks.additional_context"]}})];
        if last == "elsewhere" {
            input.insert(
                0,
                json!({"type":"reasoning","summary":[],"encrypted_content":"opaque"}),
            );
        }
        EncodedJsonBody::encode(
            &json!({"model":"fixture-model","reasoning":{"effort":"high"},"stream":true,
            "max_output_tokens":128,"instructions":"base","input":input}),
        )
        .unwrap()
    };

    let mut prepared = Some(body("cache me"));
    accounts.prepare(&mut request, &mut prepared).unwrap();
    let mut attempt = accounts
        .before_send(&mut request, prepared.as_ref())
        .unwrap()
        .unwrap();
    let mut delivered = Vec::new();
    for mut event in accounts.answer(&request).unwrap() {
        attempt.observe(&mut event, true).unwrap();
        delivered.extend(Some(event).filter(|event| !event.is_null()));
        delivered.extend(attempt.injected());
    }
    drop(attempt);
    let done = delivered
        .iter()
        .filter(|event| event["type"] == "response.output_item.done")
        .map(|event| event["item"].clone())
        .collect::<Vec<_>>();
    assert_eq!(done[0]["content"][0]["text"], "cached answer");
    assert_eq!(done[1]["arguments"], "{\"cmd\":\"pwd\"}");
    assert!(
        done[1]["call_id"]
            .as_str()
            .unwrap()
            .starts_with("mod-request_router-req-")
    );
    assert_eq!(done[2]["content"][0]["text"], "appended");
    assert_eq!(delivered.last().unwrap()["type"], "response.completed");
    assert!(
        task.attempts().unwrap().is_empty(),
        "no provider attempt was admitted"
    );
    let (event, synthetic) = notified.lock().unwrap().remove(0);
    assert_eq!(event, "model_response");
    assert_eq!(synthetic["synthetic"], "request_router");
    assert_eq!(synthetic["cost"]["basis"], "synthetic");
    assert_eq!(synthetic["usage"], Value::Null);
    assert_eq!(
        synthetic["output"]["tool_calls"].as_array().unwrap().len(),
        1
    );

    request.headers.remove("x-omd-synthetic");
    let mut prepared = Some(body("plain"));
    accounts.prepare(&mut request, &mut prepared).unwrap();
    let edited: Value = serde_json::from_slice(prepared.as_ref().unwrap().as_bytes()).unwrap();
    assert_eq!(edited["reasoning"]["effort"], "low");
    let parts = edited["input"][0]["content"].as_array().unwrap();
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0]["text"], "sandbox");
    assert_eq!(parts[1]["text"], "plain");
    assert!(parts[2]["text"].as_str().unwrap().ends_with("hint"));
    let mut attempt = accounts
        .before_send(&mut request, prepared.as_ref())
        .unwrap()
        .unwrap();
    let mut delivered = Vec::new();
    for mut event in [
        json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"f","call_id":"c","name":"blocked","arguments":""}}),
        json!({"type":"response.function_call_arguments.delta","output_index":1,"item_id":"f","delta":"{}"}),
        json!({"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"f","call_id":"c","name":"blocked","arguments":"{}"}}),
        json!({"type":"response.completed","response":{"model":"fixture-model-2026","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":40},"output_tokens":10}}}),
    ] {
        attempt.observe(&mut event, true).unwrap();
        delivered.extend(Some(event).filter(|event| !event.is_null()));
        delivered.extend(attempt.injected());
    }
    drop(attempt);
    assert_eq!(
        delivered.len(),
        3,
        "the dropped call left nothing but the appended message"
    );
    let (_, settled) = notified.lock().unwrap().remove(0);
    assert_eq!(settled["status"], "completed");
    assert_eq!(settled["stop_reason"], "end_turn");
    assert_eq!(settled["served_model"], "fixture-model-2026");
    assert_eq!(settled["cache"]["read_tokens"], 40);
    assert_eq!(settled["cost"]["basis"], "settled");
    assert_eq!(settled["context_window"], 1000);
    assert_eq!(settled["synthetic"], Value::Null);
    let partial = accounts
        .before_send(&mut request, prepared.as_ref())
        .unwrap()
        .unwrap();
    drop(partial);
    let (_, cancelled) = notified.lock().unwrap().remove(0);
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(cancelled["cost"]["basis"], "unsettled");

    let mut prepared = Some(body("elsewhere"));
    let refused = accounts.prepare(&mut request, &mut prepared).unwrap_err();
    assert!(format!("{refused:?}").contains("own credential profile"));
    accounts
        .by_thread
        .lock()
        .unwrap()
        .get_mut("main")
        .unwrap()
        .lead_routes[1]
        .credential = Some("profile".into());
    let mut prepared = Some(body("elsewhere"));
    accounts.prepare(&mut request, &mut prepared).unwrap();
    let switched: Value = serde_json::from_slice(prepared.as_ref().unwrap().as_bytes()).unwrap();
    assert_eq!(switched["model"], "elsewhere-model");
    assert_eq!(
        switched["input"].as_array().unwrap().len(),
        1,
        "foreign reasoning left out"
    );
    assert!(
        switched["input"][0]["content"][3]["text"]
            .as_str()
            .unwrap()
            .ends_with("routed"),
        "{switched}"
    );
    assert!(
        request
            .headers
            .contains_key(codex_api::request_observer::STRIP_ITEM_METADATA)
    );
}

#[test]
fn completion_workers_cap_output_capture_tool_calls_and_collect_their_responses() {
    let (_root, accounts, _task, mut request, body) = setup();
    {
        let mut accounts = accounts.by_thread.lock().unwrap();
        let child = accounts.get_mut("child").unwrap();
        child.capture_tools = true;
        child.max_output_tokens = Some(64);
    }
    accounts.collect("child");
    let mut prepared = Some(body);
    accounts.prepare(&mut request, &mut prepared).unwrap();
    let capped: Value = serde_json::from_slice(prepared.as_ref().unwrap().as_bytes()).unwrap();
    assert_eq!(capped["max_output_tokens"], 64);
    let mut attempt = accounts
        .before_send(&mut request, prepared.as_ref())
        .unwrap()
        .unwrap();
    for mut event in [
        json!({"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"f","call_id":"c","name":"read_file","arguments":""}}),
        json!({"type":"response.function_call_arguments.delta","output_index":0,"item_id":"f","delta":"{\"path\":\"a\"}"}),
        json!({"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"f","call_id":"c","name":"read_file","arguments":"{\"path\":\"a\"}"}}),
    ] {
        attempt.observe(&mut event, true).unwrap();
        assert!(event.is_null(), "a captured call never reaches the engine");
    }
    let mut unindexed = json!({"type":"response.output_item.done","item":{"type":"function_call","id":"g","call_id":"d","name":"exec_command","arguments":"{}"}});
    assert!(
        attempt.observe(&mut unindexed, true).is_err(),
        "a call without an output index cannot be captured"
    );
    let mut completed = json!({"type":"response.completed","response":{"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":4},"output_tokens":5}}});
    attempt.observe(&mut completed, true).unwrap();
    drop(attempt);
    let responses = accounts.take_responses("child");
    assert_eq!(responses.len(), 1);
    let call = &responses[0]["output"]["tool_calls"][0];
    assert_eq!(call["arguments"], "{\"path\":\"a\"}");
    assert_eq!(call["executed"], false);
    assert_eq!(responses[0]["stop_reason"], "tool_use");
    assert_eq!(responses[0]["cache"]["read_tokens"], 4);
    assert!(accounts.take_responses("child").is_empty());

    accounts.collect("child");
    let mut attempt = accounts
        .before_send(&mut request, prepared.as_ref())
        .unwrap()
        .unwrap();
    for delta in ["one, two, ", "three"] {
        let mut event = json!({"type":"response.output_text.delta","output_index":0,"item_id":"m","delta":delta});
        attempt.observe(&mut event, true).unwrap();
    }
    let mut cut = json!({"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},
        "usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":0},"output_tokens":64}}});
    attempt.observe(&mut cut, true).unwrap();
    drop(attempt);
    let capped = accounts.take_responses("child").remove(0);
    assert_eq!(capped["status"], "incomplete");
    assert_eq!(capped["stop_reason"], "max_output_tokens");
    assert_eq!(
        capped["output"]["text"], "one, two, three",
        "the capped answer keeps what streamed"
    );
}

#[test]
fn completion_cache_marks_set_a_prefix_key_and_breakpoint_for_provider_transports() {
    let (_root, accounts, _task, mut request, _) = setup();
    let mut mark = |through: Value, prompt: &str| {
        accounts
            .by_thread
            .lock()
            .unwrap()
            .get_mut("child")
            .unwrap()
            .cache_through = Some(through);
        let body = json!({"model":"fixture-model","stream":true,"max_output_tokens":128,"instructions":"base","input":[
            {"type":"message","id":format!("msg_{prompt}"),"role":"developer","content":[{"type":"input_text","text":"system"}]},
            {"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>"}]},
            {"type":"message","role":"user","content":[{"type":"input_text","text":"document"},{"type":"input_text","text":prompt}]}]});
        let mut encoded = Some(EncodedJsonBody::encode(&body).unwrap());
        accounts.prepare(&mut request, &mut encoded).unwrap();
        let prepared: Value = serde_json::from_slice(encoded.unwrap().as_bytes()).unwrap();
        assert_eq!(
            request.headers["session-id"],
            prepared["prompt_cache_key"].as_str().unwrap()
        );
        (
            request.headers["x-omd-cache-breakpoint"]
                .to_str()
                .unwrap()
                .to_owned(),
            prepared["prompt_cache_key"].as_str().unwrap().to_owned(),
        )
    };
    let (first_breakpoint, first) = mark(json!(0), "first question");
    let (_, second) = mark(json!(0), "second question");
    let (system_breakpoint, system) = mark(json!("system"), "first question");
    assert_eq!(first_breakpoint, "2:0");
    assert_eq!(system_breakpoint, "0:0");
    assert!(first.starts_with("omd-cache-"));
    assert_eq!(first, second, "calls sharing the marked prefix share a key");
    assert_ne!(first, system);
}

#[test]
fn observe_only_accounts_record_usage_without_admission() {
    let (root, accounts, task, mut request, _body) = setup();
    let mut lead = account(&task, root.path(), "lead");
    lead.rates = None;
    lead.route = None;
    accounts
        .by_thread
        .lock()
        .unwrap()
        .insert("main".into(), lead);
    request.headers.insert("thread-id", "main".parse().unwrap());
    assert!(!accounts.requires_observation(Some("main")));
    assert!(accounts.requires_observation(Some("child")));
    let body = EncodedJsonBody::encode(&json!({"model":"any-model","stream":true,
        "tools":[{"type":"web_search"}]}))
    .unwrap();
    let mut prepared = Some(body.clone());
    accounts.prepare(&mut request, &mut prepared).unwrap();
    assert_eq!(prepared.unwrap().as_bytes(), body.as_bytes());
    let mut attempt = accounts
        .before_send(&mut request, Some(&body))
        .unwrap()
        .unwrap();
    assert!(!request.headers.contains_key("x-omd-owner"));
    let usage = json!({"input_tokens":7,"output_tokens":3});
    let mut completed = json!({"type":"response.completed","response":{"usage":usage}});
    attempt.observe(&mut completed, true).unwrap();
    drop(attempt);
    assert!(task.attempts().unwrap().is_empty());
    let capture = task.cost_capture().unwrap();
    assert_eq!(capture.observed.len(), 1);
    assert_eq!(capture.observed[0].model, "any-model");
    assert_eq!(capture.observed[0].raw_usage, Some(usage));
}

#[test]
fn unrated_requests_are_included_only_on_a_chatgpt_login() {
    let (root, accounts, task, mut request, body) = setup();
    let mut lead = account(&task, root.path(), "lead");
    lead.rates = None;
    accounts
        .by_thread
        .lock()
        .unwrap()
        .insert("main".into(), lead);
    let notified = Arc::new(Mutex::new(Vec::new()));
    let sink = notified.clone();
    accounts.install_mod_notifier(Arc::new(move |_, payload| {
        sink.lock().unwrap().push(payload["cost"].clone());
    }));
    request.headers.insert("thread-id", "main".parse().unwrap());
    for (login, url) in [
        (false, SUBSCRIPTION_RESPONSES_URL),
        (true, "http://localhost/responses"),
        (true, SUBSCRIPTION_RESPONSES_URL),
    ] {
        if login {
            request
                .headers
                .insert("chatgpt-account-id", "fixture".parse().unwrap());
        }
        request.url = url.into();
        drop(accounts.before_send(&mut request, Some(&body)).unwrap());
    }
    assert_eq!(
        *notified.lock().unwrap(),
        [
            json!({"microusd": null, "basis": "unpriced"}),
            json!({"microusd": null, "basis": "unpriced"}),
            json!({"microusd": 0, "basis": "included_subscription"}),
        ]
    );
}

#[test]
fn raw_usage_keeps_unknown_fields_and_prices_cached_input_once() {
    let (root, accounts, task, mut request, body) = setup();
    let mut attempt = accounts
        .before_send(&mut request, Some(&body))
        .unwrap()
        .unwrap();
    let usage = json!({"input_tokens": 100, "input_tokens_details": {"cached_tokens": 50}, "output_tokens": 10, "future_field": "preserved"});
    let mut event = json!({"type": "response.completed", "response": {"usage": usage}});
    attempt.observe(&mut event, true).unwrap();
    drop(attempt);
    let record = task.attempts().unwrap().remove(0);
    assert_eq!(record.raw_usage, Some(usage));
    assert_eq!(record.settled_microusd, Some(8));
    assert_eq!(record.status, "completed");
    assert_eq!(
        std::os::unix::fs::PermissionsExt::mode(
            &std::fs::metadata(root.path().join("evidence/task-cost.json"))
                .unwrap()
                .permissions()
        ) & 0o777,
        0o600
    );
    let capture: codex_omd::TaskCostCapture = serde_json::from_slice(
        &std::fs::read(root.path().join("evidence/task-cost.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(capture.settled_task_charge_microusd, 8);
    assert_eq!(capture.retained_exposure_upper_bound_microusd, 8);
    assert_eq!(capture.raw_usage_attempts, 1);
}

#[test]
fn dropping_or_unpriced_usage_keeps_the_full_reservation() {
    let (_root, accounts, task, mut request, body) = setup();
    drop(accounts.before_send(&mut request, Some(&body)).unwrap());
    let mut second = accounts
        .before_send(&mut request, Some(&body))
        .unwrap()
        .unwrap();
    let usage = json!({"input_tokens": 10, "future_cache_schema": 5});
    let mut event = json!({"type": "response.incomplete", "response": {"usage": usage}});
    second.observe(&mut event, false).unwrap();
    drop(second);
    assert_eq!(task.remaining().unwrap().2, 0);
    let records = task.attempts().unwrap();
    assert_eq!(records[0].status, "failed");
    assert_eq!(records[1].raw_usage, Some(usage));
    assert_eq!(records[1].settled_microusd, None);
}

#[test]
fn route_url_and_model_identity_cannot_drift() {
    let (_root, accounts, task, mut request, body) = setup();
    request.url.push_str("/elsewhere");
    let admitted = accounts
        .before_send(&mut request, Some(&body))
        .unwrap()
        .unwrap();
    assert_eq!(request.url, "http://localhost/responses");
    drop(admitted);
    let wrong = EncodedJsonBody::encode(
        &json!({"model": "fixture-other", "stream": true, "max_output_tokens": 128}),
    )
    .unwrap();
    assert!(accounts.before_send(&mut request, Some(&wrong)).is_err());
    assert_eq!(task.attempts().unwrap().len(), 1);
}

#[test]
fn paid_preparation_caps_output_and_rejects_unbounded_or_underreserved_requests() {
    let (_root, accounts, task, mut request, body) = setup();
    let mut prepared = Some(body.clone());
    accounts.prepare(&mut request, &mut prepared).unwrap();
    let value: Value = serde_json::from_slice(prepared.as_ref().unwrap().as_bytes()).unwrap();
    assert_eq!(value["max_output_tokens"], 128);
    assert_eq!(value["service_tier"], "default");
    for (key, payload) in [
        ("previous_response_id", json!("remote")),
        ("conversation", json!("remote")),
        ("background", json!(true)),
        ("service_tier", json!("priority")),
        (
            "input",
            json!([{"type": "input_image", "image_url": "https://example.com/image"}]),
        ),
        ("tools", json!([{"type": "web_search"}])),
    ] {
        let mut invalid = value.clone();
        invalid[key] = payload;
        let encoded = EncodedJsonBody::encode(&invalid).unwrap();
        assert!(accounts.before_send(&mut request, Some(&encoded)).is_err());
    }
    accounts
        .by_thread
        .lock()
        .unwrap()
        .get_mut("child")
        .unwrap()
        .rates
        .as_mut()
        .unwrap()
        .reservation_microusd = 1;
    assert!(
        accounts
            .before_send(&mut request, prepared.as_ref())
            .is_err()
    );
    assert!(task.attempts().unwrap().is_empty());
}

#[test]
fn provider_ceiling_violation_keeps_usage_and_stops_admission() {
    let (_root, accounts, task, mut request, body) = setup();
    let mut attempt = accounts
        .before_send(&mut request, Some(&body))
        .unwrap()
        .unwrap();
    assert_eq!(request.headers["x-omd-owner"], "worker");
    let usage = json!({"input_tokens": 100, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 129});
    let mut event = json!({"type": "response.completed", "response": {"usage": usage}});
    assert!(attempt.observe(&mut event, true).is_err());
    drop(attempt);
    assert!(task.check_active().is_err());
    let record = task.attempts().unwrap().remove(0);
    assert_eq!(record.raw_usage, Some(usage));
    assert_eq!(record.settled_microusd, None);
}

#[test]
fn paid_preset_grants_bind_repository_route_and_current_bytes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("paid.json");
    let grant = json!({"schema":1,"paid_api_key":true,"revocable":true,"repository":"repo-a","provider":"provider-a","model":"model-a","responses_url":"https://example.invalid/responses"});
    std::fs::write(&path, grant.to_string()).unwrap();
    let sha = crate::execution::hash(&std::fs::read(&path).unwrap());
    let allowed = || {
        worker_authorized(
            &path,
            &sha,
            "repo-a",
            "provider-a",
            "model-a",
            "https://example.invalid/responses",
            false,
        )
    };
    assert!(allowed());
    assert!(!worker_authorized(
        &path,
        &sha,
        "repo-b",
        "provider-a",
        "model-a",
        "https://example.invalid/responses",
        false,
    ));
    assert!(!worker_authorized(
        &path,
        &sha,
        "repo-a",
        "provider-a",
        "other-model",
        "https://example.invalid/responses",
        false,
    ));
    std::fs::write(&path, "revoked").unwrap();
    assert!(!allowed());
    std::fs::remove_file(&path).unwrap();
    let target = root.path().join("target.json");
    std::fs::write(&target, grant.to_string()).unwrap();
    std::os::unix::fs::symlink(target, &path).unwrap();
    assert!(!allowed());
}

#[test]
fn subscription_worker_requests_recheck_grants_and_reject_paid_fallback() {
    let (root, accounts, task, mut request, _body) = setup();
    let path = root.path().join("subscription.json");
    let grant = json!({"schema":1,"included_subscription":true,"revocable":true,"repository":"fixture","provider":"openai","model":"fixture-model","responses_url":SUBSCRIPTION_RESPONSES_URL});
    std::fs::write(&path, grant.to_string()).unwrap();
    let sha = crate::execution::hash(&std::fs::read(&path).unwrap());
    assert!(worker_authorized(
        &path,
        &sha,
        "fixture",
        "openai",
        "fixture-model",
        SUBSCRIPTION_RESPONSES_URL,
        true
    ));
    assert!(!worker_authorized(
        &path,
        &sha,
        "fixture",
        "openai",
        "fixture-model",
        SUBSCRIPTION_RESPONSES_URL,
        false
    ));
    assert!(!worker_authorized(
        &path,
        &sha,
        "other-repo",
        "openai",
        "fixture-model",
        SUBSCRIPTION_RESPONSES_URL,
        true
    ));
    assert!(!worker_authorized(
        &path,
        &sha,
        "fixture",
        "openai",
        "other-model",
        SUBSCRIPTION_RESPONSES_URL,
        true
    ));
    task.start_worker(
        "subscriber".into(),
        "lead".into(),
        1,
        WorkerLimits {
            requests: 2,
            exposure_microusd: 0,
            seconds: 20,
        },
    )
    .unwrap();
    {
        let mut state = accounts.by_thread.lock().unwrap();
        let account = state.get_mut("child").unwrap();
        account.owner = "subscriber".into();
        account.provider = "openai".into();
        account.url = SUBSCRIPTION_RESPONSES_URL.into();
        let rates = account.rates.as_mut().unwrap();
        rates.included_subscription = true;
        rates.reservation_microusd = 0;
        account.worker_authorization = Some((path.clone(), sha.clone()));
    }
    let body = EncodedJsonBody::encode(
        &json!({"model":"fixture-model","reasoning":{"effort":"high"},"stream":true}),
    )
    .unwrap();
    assert!(
        task.authorize_worker_route("lead", "openai", "fixture-model")
            .is_err()
    );
    assert!(
        task.authorize_worker_route("absent", "openai", "fixture-model")
            .is_err()
    );
    task.authorize_worker_route("subscriber", "openai", "fixture-model")
        .unwrap();
    assert!(
        task.authorize_worker_route("subscriber", "openai", "other-model")
            .is_err()
    );
    assert!(task.admit("lead", "openai", "fixture-model", 0).is_err());
    request.url = "https://api.openai.com/v1/responses".into();
    request
        .headers
        .insert("chatgpt-account-id", "fixture".parse().unwrap());
    assert!(accounts.before_send(&mut request, Some(&body)).is_err());
    request.url = SUBSCRIPTION_RESPONSES_URL.into();
    request.headers.remove("chatgpt-account-id");
    assert!(accounts.before_send(&mut request, Some(&body)).is_err());
    request
        .headers
        .insert("chatgpt-account-id", "fixture".parse().unwrap());
    let mut mixed = grant.clone();
    mixed["paid_api_key"] = true.into();
    std::fs::write(&path, mixed.to_string()).unwrap();
    let mixed_sha = crate::execution::hash(&std::fs::read(&path).unwrap());
    assert!(!worker_authorized(
        &path,
        &mixed_sha,
        "fixture",
        "openai",
        "fixture-model",
        SUBSCRIPTION_RESPONSES_URL,
        true
    ));
    assert!(accounts.before_send(&mut request, Some(&body)).is_err());
    std::fs::write(&path, grant.to_string()).unwrap();
    assert!(task.attempts().unwrap().is_empty());
    let mut attempt = accounts
        .before_send(&mut request, Some(&body))
        .unwrap()
        .unwrap();
    let usage =
        json!({"input_tokens":100,"input_tokens_details":{"cached_tokens":20},"output_tokens":32});
    let mut event = json!({"type":"response.completed","response":{"usage":usage}});
    attempt.observe(&mut event, true).unwrap();
    drop(attempt);
    let record = task.attempts().unwrap().remove(0);
    assert_eq!(record.raw_usage, Some(usage));
    assert_eq!(record.settled_microusd, Some(0));
    std::fs::remove_file(path).unwrap();
    assert!(accounts.before_send(&mut request, Some(&body)).is_err());
}

#[test]
fn stream_control_stops_only_at_output_boundaries_and_carries_the_retry() {
    let (root, accounts, _task, mut request, body) = setup();
    let source = "export default api => { api.intercept('response_stream', async (e, next) => { const result = await next(e); if (/forbidden/.test(e.text ?? '') && e.kind === 'text') return {stop:{reason:'rule'}}; return e.kind === 'message' && /forbidden/.test(e.text) ? {stop:{reason:'rule'},retry:{inject:'Avoid the forbidden word.'}} : result; }); }";
    install_middleware(&accounts, root.path(), source);
    let mut attempt = accounts
        .before_send(&mut request, Some(&body))
        .unwrap()
        .unwrap();
    let mut delta = json!({"type":"response.output_text.delta","output_index":0,"item_id":"m","delta":"forbidden"});
    attempt.observe(&mut delta, true).unwrap();
    assert_eq!(
        delta["delta"], "forbidden",
        "a stop outside a boundary is rejected and the text kept"
    );
    let mut done = json!({"type":"response.output_item.done","output_index":0,"item":{"type":"message",
        "id":"m","content":[{"type":"output_text","text":"forbidden"}]}});
    let error = attempt.observe(&mut done, true).unwrap_err();
    let message = match error {
        TransportError::Build(message) => message,
        other => panic!("unexpected error {other:?}"),
    };
    let control = codex_api::request_observer::stream_control(&message).unwrap();
    assert_eq!(control["reason"], "rule");
    assert_eq!(control["retry"]["inject"], "Avoid the forbidden word.");
    drop(attempt);
    let mut retried = Some(body);
    accounts.prepare(&mut request, &mut retried).unwrap();
    assert_eq!(
        request.headers["x-omd-attempt"], "2",
        "the retry is a new, numbered attempt"
    );
    let mut attempt = accounts
        .before_send(&mut request, retried.as_ref())
        .unwrap()
        .unwrap();
    assert!(attempt.observe(&mut done.clone(), true).is_err());
    drop(attempt);
    accounts.forget_retry("child");
    let mut next = retried.clone();
    accounts.prepare(&mut request, &mut next).unwrap();
    assert_eq!(
        request.headers["x-omd-attempt"], "1",
        "a retry core declined does not number the next turn's request"
    );
    accounts
        .requests
        .lock()
        .unwrap()
        .fingerprints
        .insert("child".into(), vec![("i0".into(), "sha".into())]);
    accounts.forget_thread("child");
    assert!(
        accounts.requests.lock().unwrap().fingerprints.is_empty(),
        "a closed thread keeps no request fingerprints"
    );
}

#[test]
fn provider_billed_requests_skip_reservations_record_provider_cost_and_settle_late_once() {
    let (root, accounts, task, mut request, _body) = setup();
    {
        let mut accounts = accounts.by_thread.lock().unwrap();
        let child = accounts.get_mut("child").unwrap();
        child.rates = Some(Rates {
            reservation_microusd: 0,
            provider_billed: true,
            ..rates()
        });
    }
    let body = EncodedJsonBody::encode(&json!({"model": "served-model", "stream": true,
        "input": [{"type": "message", "role": "user", "content": [{"type": "input_image", "image_url": "data:image/png;base64,AA=="}]}]}))
    .unwrap();
    let mut finish = |request_id: &str, usage: Value| {
        request
            .headers
            .insert("x-omd-request-id", request_id.parse().unwrap());
        let mut attempt = accounts
            .before_send(&mut request, Some(&body))
            .unwrap()
            .unwrap();
        let mut event = json!({"type": "response.completed", "response": {"usage": usage}});
        attempt.observe(&mut event, true).unwrap();
    };
    finish("req-1", json!({"input_tokens": 10, "output_tokens": 2}));
    finish(
        "req-2",
        json!({"input_tokens": 10, "output_tokens": 2, "cost_microusd": 700}),
    );
    let records = task.attempts().unwrap();
    assert!(records.iter().all(|record| record.provider_billed
        && record.reserved_microusd == 0
        && record.model == "served-model"
        && record.status == "completed"));
    assert_eq!(
        records
            .iter()
            .map(|record| record.settled_microusd)
            .collect::<Vec<_>>(),
        vec![None, Some(700)]
    );
    assert_eq!(
        accounts.settle_provider("req-1", 500, "fixture", |_| false),
        Err("ledger_settle_not_route_owner".into())
    );
    assert_eq!(
        accounts.settle_provider("req-2", 500, "fixture", |_| true),
        Err("ledger_request_not_awaiting_settlement".into())
    );
    let settled = accounts
        .settle_provider("req-1", 500, "fixture", |provider| provider == "fixture")
        .unwrap();
    assert_eq!(settled["cost"]["basis"], "provider_reported");
    assert!(
        accounts
            .settle_provider("req-1", 500, "fixture", |_| true)
            .is_err()
    );
    let capture: codex_omd::TaskCostCapture = serde_json::from_slice(
        &std::fs::read(root.path().join("evidence/task-cost.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(capture.settled_task_charge_microusd, 1200);
    let resumed = Task::open(
        Limits {
            requests: 3,
            exposure_microusd: 20000,
            seconds: 30,
            concurrent_workers: 2,
            max_depth: 2,
        },
        root.path().join("evidence"),
        Some("resume"),
    )
    .unwrap();
    assert_eq!(
        resumed
            .attempts()
            .unwrap()
            .iter()
            .map(|record| (record.provider_billed, record.settled_microusd))
            .collect::<Vec<_>>(),
        vec![(true, Some(500)), (true, Some(700))]
    );
}
