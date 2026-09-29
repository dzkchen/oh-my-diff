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
        .0
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

#[test]
fn host_tool_schema_fields_are_not_mistaken_for_nontext_input() {
    let (_root, accounts, _task, mut request, _body) = setup();
    let base = json!({"model":"fixture-model","reasoning":{"effort":"high"},
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

fn fast_route() -> RequestRoute {
    RequestRoute {
        name: "fast".into(),
        model: "fixture-fast".into(),
        provider: "fixture".into(),
        reasoning: "xhigh".into(),
        rates: rates(),
        credential: None,
    }
}

#[test]
fn credential_routes_replace_auth_at_the_request_boundary_and_fail_closed() {
    let (root, accounts, _task, mut request, body) = setup();
    let store = root.path().join("store");
    std::fs::create_dir(&store).unwrap();
    let store = store.canonicalize().unwrap();
    set_credential_root(store.clone());
    let profiles = codex_omd::credentials::CredentialProfiles::open(&store).unwrap();
    let profile = profiles.create("work key", "api_key", None).unwrap();
    accounts
        .0
        .lock()
        .unwrap()
        .get_mut("child")
        .unwrap()
        .credential = Some(profile.id.clone());
    request.headers.insert(
        http::header::AUTHORIZATION,
        "Bearer session".parse().unwrap(),
    );
    let refused = accounts
        .before_send(&mut request, Some(&body))
        .err()
        .unwrap();
    assert!(format!("{refused:?}").contains("credential_not_enrolled"));
    std::fs::write(
        profiles.home(&profile.id).unwrap().join("auth.json"),
        br#"{"OPENAI_API_KEY":"sk-profile"}"#,
    )
    .unwrap();
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
}

#[test]
fn middleware_switches_only_configured_lead_routes_and_transforms_text() {
    let (root, accounts, task, mut request, body) = setup();
    let source = "export default api => { api.middleware('model_request', event => ({route:'fast'})); api.middleware('response_stream', event => event.protected?null:{text:String(event.text).toUpperCase()}); }";
    install_middleware(&accounts, root.path(), source);
    let mut prepared = Some(body.clone());
    assert!(accounts.prepare(&mut request, &mut prepared).is_err());

    let mut lead = account(&task, root.path(), "lead");
    lead.route = Some("main".into());
    lead.lead_routes = vec![fast_route()];
    accounts.0.lock().unwrap().insert("main".into(), lead);
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
    let mut delta = json!({"type":"response.output_text.delta","delta":"hello"});
    attempt.observe(&mut delta, true).unwrap();
    assert_eq!(delta["delta"], "HELLO");
    let usage =
        json!({"input_tokens":100,"input_tokens_details":{"cached_tokens":50},"output_tokens":10});
    let mut completed = json!({"type":"response.completed","response":{"usage":usage}});
    attempt.observe(&mut completed, true).unwrap();
    drop(attempt);
    let recorded = task.attempts().unwrap().remove(0);
    assert_eq!(recorded.model, "fixture-fast");
    assert_eq!(recorded.raw_usage, Some(usage));
    let log = std::fs::read_to_string(root.path().join("evidence/mod-middleware.jsonl")).unwrap();
    assert!(log.contains("fast") && log.contains("raw_usage"));
}

#[test]
fn observe_only_accounts_record_usage_without_admission() {
    let (root, accounts, task, mut request, _body) = setup();
    let mut lead = account(&task, root.path(), "lead");
    lead.rates = None;
    lead.route = None;
    accounts.0.lock().unwrap().insert("main".into(), lead);
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
    assert!(!request.headers.contains_key("x-omd-request-id"));
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
        .0
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
        let mut state = accounts.0.lock().unwrap();
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
    let source = "export default api => { api.middleware('response_stream', event => event.boundary && /forbidden/.test(event.text ?? '') ? {stop:{reason:'rule'},retry:{inject:'Avoid the forbidden word.'}} : null); }";
    install_middleware(&accounts, root.path(), source);
    let mut attempt = accounts
        .before_send(&mut request, Some(&body))
        .unwrap()
        .unwrap();
    let mut delta = json!({"type":"response.output_text.delta","delta":"forbidden"});
    attempt.observe(&mut delta, true).unwrap();
    let mut done = json!({"type":"response.output_item.done","item":{"type":"message",
        "content":[{"type":"output_text","text":"forbidden"}]}});
    let error = attempt.observe(&mut done, true).unwrap_err();
    let message = match error {
        TransportError::Build(message) => message,
        other => panic!("unexpected error {other:?}"),
    };
    let control = codex_api::request_observer::stream_control(&message).unwrap();
    assert_eq!(control["reason"], "rule");
    assert_eq!(control["retry"]["inject"], "Avoid the forbidden word.");
}
