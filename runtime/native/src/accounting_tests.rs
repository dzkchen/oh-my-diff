use super::*;
use codex_omd::Limits;
use codex_omd::WorkerLimits;
use serde_json::json;

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
                output_microusd_per_million: 200000,
                reservation_microusd: 10000,
                max_output_tokens: 128,
                input_token_ceiling: 5000,
                included_subscription: false,
            },
            authorization_sha256: crate::execution::hash(&std::fs::read(&authorization).unwrap()),
            authorization,
            repository_identity: "fixture".into(),
        },
    );
    task.start_worker(
        "worker".into(),
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
        &json!({"model": "muse-spark-1.3-contributor", "stream": true, "max_output_tokens": 128}),
    )
    .unwrap();
    (root, accounts, task, request, body)
}

#[test]
fn raw_usage_keeps_unknown_fields_and_prices_cached_input_once() {
    let (_root, accounts, task, mut request, body) = setup();
    let mut attempt = accounts
        .before_send(&mut request, Some(&body))
        .unwrap()
        .unwrap();
    let usage = json!({"input_tokens": 100, "input_tokens_details": {"cached_tokens": 50}, "output_tokens": 10, "future_field": "preserved"});
    attempt
        .observe(
            &json!({"type": "response.completed", "response": {"usage": usage}}),
            true,
        )
        .unwrap();
    drop(attempt);
    let record = task.attempts().unwrap().remove(0);
    assert_eq!(record.raw_usage, Some(usage));
    assert_eq!(record.settled_microusd, Some(8));
    assert_eq!(record.status, "completed");
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
    second
        .observe(
            &json!({"type": "response.incomplete", "response": {"usage": usage}}),
            false,
        )
        .unwrap();
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
    assert!(accounts.before_send(&mut request, Some(&body)).is_err());
    request.url = "http://localhost/responses".into();
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
    assert!(task.attempts().unwrap().is_empty());
}

#[test]
fn paid_preparation_caps_output_and_rejects_unbounded_or_underreserved_requests() {
    let (_root, accounts, task, mut request, body) = setup();
    let mut prepared = Some(body.clone());
    accounts.prepare(&request, &mut prepared).unwrap();
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
    assert!(
        attempt
            .observe(
                &json!({"type": "response.completed", "response": {"usage": usage}}),
                true
            )
            .is_err()
    );
    drop(attempt);
    assert!(task.check_active().is_err());
    let record = task.attempts().unwrap().remove(0);
    assert_eq!(record.raw_usage, Some(usage));
    assert_eq!(record.settled_microusd, None);
}
