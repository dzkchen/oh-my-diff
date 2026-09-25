use super::*;
use codex_omd::Limits;
use codex_omd::MOD_API_VERSION;
use codex_omd::ModHost;
use codex_omd::ModStore;
use codex_omd::WorkerLimits;
use serde_json::json;
use std::path::Path;

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
                concurrent_workers: 1,
                max_depth: 2,
                max_reassessments: 1,
            },
            root.path().join("evidence"),
        )
        .unwrap(),
    );
    let authorization = root.path().join("grant.json");
    std::fs::write(&authorization, serde_json::to_vec(&json!({"schema": 1, "split": "development", "data_authorized": true, "revocable": true, "repositories": ["fixture"]})).unwrap()).unwrap();
    let accounts = Accounts::default();
    accounts.0.lock().unwrap().insert(
        "child".into(),
        Account {
            task: task.clone(),
            owner: "worker".into(),
            model: "muse-spark-1.3-contributor".into(),
            provider: "meta".into(),
            url: "http://localhost/responses".into(),
            max_request_bytes: 2048,
            rates: Rates {
                input_microusd_per_million: 100000,
                cached_microusd_per_million: 2000,
                cache_write_microusd_per_million: None,
                output_microusd_per_million: 200000,
                reservation_microusd: 10000,
                max_output_tokens: 128,
                input_token_ceiling: 5000,
                included_subscription: false,
                external_subscription: false,
            },
            authorization_sha256: crate::execution::hash(&std::fs::read(&authorization).unwrap()),
            authorization,
            repository_identity: "fixture".into(),
            revocation: root.path().join("evidence").join(REVOCATION_FILE),
            cost_capture: root.path().join("evidence").join("task-cost.json"),
            preset: "worker".into(),
            authorized_presets: vec![RequestPreset {
                name: "worker".into(),
                model: "muse-spark-1.3-contributor".into(),
                provider: "meta".into(),
                reasoning: "high".into(),
                url: "http://localhost/responses".into(),
                accounting_provider: "meta".into(),
            }],
        },
    );
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
    let mut request = Request::new(http::Method::POST, "http://localhost/responses".into());
    request
        .headers
        .insert("thread-id", "child".parse().unwrap());
    let body = EncodedJsonBody::encode(
        &json!({"model": "muse-spark-1.3-contributor", "reasoning":{"effort":"high"}, "stream": true, "max_output_tokens": 128}),
    )
    .unwrap();
    (root, accounts, task, request, body)
}

#[test]
fn host_tool_schema_fields_are_not_mistaken_for_nontext_input() {
    let (_root, accounts, _task, mut request, _body) = setup();
    let base = json!({"model":"muse-spark-1.3-contributor","reasoning":{"effort":"high"},
        "stream":true,"max_output_tokens":128,
        "tools":[{"type":"function","name":"inspect","parameters":{"type":"object",
            "properties":{"image_url":{"type":"string"}}}}],
        "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"inspect"}]},
            {"type":"additional_tools","tools":[{"name":"functions","tools":[{
                "type":"function","name":"view_image","parameters":{"type":"object",
                    "properties":{"image_url":{"type":"string"}}}}]}]}]});
    let body = EncodedJsonBody::encode(&base).unwrap();
    assert!(accounts.before_send(&mut request, Some(&body)).is_ok());
    let mut charged = base.clone();
    charged["tools"] = json!([{"type":"web_search"}]);
    let charged = EncodedJsonBody::encode(&charged).unwrap();
    assert!(accounts.before_send(&mut request, Some(&charged)).is_err());
    let mut image = base;
    image["input"][0]["content"] = json!([{"type":"input_image","image_url":"fixture"}]);
    let image = EncodedJsonBody::encode(&image).unwrap();
    assert!(accounts.before_send(&mut request, Some(&image)).is_err());
}

fn install_middleware(accounts: &Accounts, root: &Path, source: &str) {
    let node = std::path::PathBuf::from(std::env::var_os("OMD_TEST_NODE").unwrap());
    let store = ModStore::create(root.join("mod-store"), node).unwrap();
    let package = root.join("request_router");
    std::fs::create_dir(&package).unwrap();
    std::fs::write(
        package.join("mod.json"),
        serde_json::to_vec(&json!({"schema":1,"id":"request_router","version":"1.0.0",
            "api":MOD_API_VERSION,"state_version":1,"capabilities":["middleware"]}))
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
            vec!["middleware".into()],
            "user",
        )
        .unwrap();
    store.enable(&package, true).unwrap();
    accounts.install_mod_runtime(Arc::new(Mutex::new(
        ModHost::open(root.join("mod-store").canonicalize().unwrap()).unwrap(),
    )));
}

#[test]
fn middleware_routes_main_and_subagent_requests_and_only_transforms_text() {
    let (root, accounts, task, mut request, body) = setup();
    let source = "export default api => { api.middleware('model_request', event => ({preset:event.scope.kind==='subagent'?'astra':'worker'})); api.middleware('response_stream', event => event.protected?null:{text:String(event.text).toUpperCase()}); }";
    install_middleware(&accounts, root.path(), source);
    let astra = RequestPreset {
        name: "astra".into(),
        model: "muse-spark-1.3-contributor".into(),
        provider: "meta".into(),
        reasoning: "xhigh".into(),
        url: "http://localhost/astra".into(),
        accounting_provider: "meta".into(),
    };
    let mut main = accounts.0.lock().unwrap().get("child").unwrap().clone();
    main.owner = "lead".into();
    main.authorized_presets.push(astra.clone());
    accounts
        .0
        .lock()
        .unwrap()
        .get_mut("child")
        .unwrap()
        .authorized_presets
        .push(astra);

    let mut prepared = Some(body.clone());
    accounts.prepare(&mut request, &mut prepared).unwrap();
    let routed: Value = serde_json::from_slice(prepared.as_ref().unwrap().as_bytes()).unwrap();
    assert_eq!(routed["model"], "muse-spark-1.3-contributor");
    assert_eq!(routed["reasoning"]["effort"], "xhigh");

    let mut main_request = request.clone();
    main_request
        .headers
        .insert("thread-id", "main".parse().unwrap());
    accounts.0.lock().unwrap().insert("main".into(), main);
    let mut main_body = Some(body.clone());
    accounts.prepare(&mut main_request, &mut main_body).unwrap();
    let unchanged: Value = serde_json::from_slice(main_body.as_ref().unwrap().as_bytes()).unwrap();
    assert_eq!(unchanged["model"], "muse-spark-1.3-contributor");

    let mut attempt = accounts
        .before_send(&mut request, prepared.as_ref())
        .unwrap()
        .unwrap();
    assert_eq!(request.url, "http://localhost/astra");
    let mut delta = json!({"type":"response.output_text.delta","delta":"hello"});
    attempt.observe(&mut delta, true).unwrap();
    assert_eq!(delta["delta"], "HELLO");
    let usage =
        json!({"input_tokens":100,"input_tokens_details":{"cached_tokens":50},"output_tokens":10});
    let mut completed = json!({"type":"response.completed","response":{"usage":usage}});
    attempt.observe(&mut completed, true).unwrap();
    assert_eq!(completed["response"]["usage"], usage);
    drop(attempt);
    assert_eq!(task.attempts().unwrap()[0].raw_usage, Some(usage));
    let log = std::fs::read_to_string(root.path().join("evidence/mod-middleware.jsonl")).unwrap();
    assert!(log.contains("subagent") && log.contains("main") && log.contains("raw_usage"));
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
fn authorization_is_rechecked_and_route_model_identity_cannot_drift() {
    let (root, accounts, task, mut request, body) = setup();
    request.url.push_str("/elsewhere");
    let admitted = accounts
        .before_send(&mut request, Some(&body))
        .unwrap()
        .unwrap();
    assert_eq!(request.url, "http://localhost/responses");
    drop(admitted);
    let wrong = EncodedJsonBody::encode(
        &json!({"model": "muse-spark-1.3", "stream": true, "max_output_tokens": 128}),
    )
    .unwrap();
    assert!(accounts.before_send(&mut request, Some(&wrong)).is_err());
    std::fs::write(
        root.path().join("grant.json"),
        "{\"data_authorized\":false}",
    )
    .unwrap();
    assert!(accounts.before_send(&mut request, Some(&body)).is_err());
    assert_eq!(task.attempts().unwrap().len(), 1);
}

#[test]
fn durable_revocation_marker_blocks_future_contributor_dispatch() {
    let (root, accounts, task, mut request, body) = setup();
    std::fs::write(
        root.path().join("evidence").join(REVOCATION_FILE),
        serde_json::to_vec(&json!({
            "schema": 1,
            "revoked": true,
            "source": "Oh My Diff inspector"
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(accounts.before_send(&mut request, Some(&body)).is_err());
    assert!(task.attempts().unwrap().is_empty());
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
        .0
        .lock()
        .unwrap()
        .get_mut("child")
        .unwrap()
        .rates
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
    assert_eq!(request.headers["x-omd-request-id"], "1");
    let usage = json!({"input_tokens": 100, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 129});
    let mut event = json!({"type": "response.completed", "response": {"usage": usage}});
    assert!(attempt.observe(&mut event, true).is_err());
    drop(attempt);
    assert!(task.check_active().is_err());
    let record = task.attempts().unwrap().remove(0);
    assert_eq!(record.raw_usage, Some(usage));
    assert_eq!(record.settled_microusd, None);
}
