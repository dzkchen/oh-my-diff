use codex_omd::Limits;
use codex_omd::Task;
use codex_omd::WorkerLimits;
use serde_json::json;
use std::sync::Arc;

fn limits() -> Limits {
    Limits {
        requests: 3,
        exposure_microusd: 100,
        seconds: 30,
        concurrent_workers: 2,
        max_depth: 2,
    }
}

fn worker() -> WorkerLimits {
    WorkerLimits {
        requests: 2,
        exposure_microusd: 60,
        seconds: 20,
    }
}

#[test]
fn worker_route_grants_are_exact_nontransferable_and_share_allowances() {
    let directory = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), directory.path().join("task")).unwrap();
    task.authorize_route("openai", "gpt-5.6-sol").unwrap();
    task.start_worker("one".into(), "lead".into(), 1, worker())
        .unwrap();
    task.start_worker("two".into(), "lead".into(), 1, worker())
        .unwrap();
    assert!(task.admit("one", "openai", "selected-model", 20).is_err());
    task.authorize_worker_route("one", "openai", "selected-model")
        .unwrap();
    assert!(
        task.authorize_worker_route("one", "meta", "selected-model")
            .is_err()
    );
    assert!(task.admit("lead", "openai", "selected-model", 20).is_err());
    assert!(task.admit("two", "openai", "selected-model", 20).is_err());
    assert!(task.admit("one", "openai", "other-model", 20).is_err());
    assert!(
        task.admit("one", "other-provider", "selected-model", 20)
            .is_err()
    );
    for _ in 0..2 {
        let admission = task.admit("one", "openai", "selected-model", 20).unwrap();
        task.dispatch(&admission, || Ok(())).unwrap();
        task.settle(&admission, json!({"input_tokens":1,"output_tokens":1}), 2)
            .unwrap();
    }
    assert!(task.admit("one", "openai", "selected-model", 20).is_err());
    task.finish_worker("one").unwrap();
    assert!(
        task.authorize_worker_route("one", "openai", "selected-model")
            .is_err()
    );
    assert!(task.admit("one", "openai", "selected-model", 0).is_err());
}

#[test]
fn unknown_usage_remains_reserved_after_worker_exit() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), dir.path().join("task")).unwrap();
    task.authorize_route("openai", "gpt-5.6-sol").unwrap();
    task.start_worker("first".into(), "lead".into(), 1, worker())
        .unwrap();
    task.admit("first", "openai", "gpt-5.6-sol", 60).unwrap();
    task.finish_worker("first").unwrap();
    assert!(
        task.start_worker("first".into(), "lead".into(), 1, worker())
            .is_err()
    );
    task.start_worker("second".into(), "lead".into(), 1, worker())
        .unwrap();
    assert!(task.admit("second", "openai", "gpt-5.6-sol", 41).is_err());
    assert_eq!(task.remaining().unwrap().2, 40);
    let attempt = task.attempts().unwrap().remove(0);
    assert_eq!(
        (
            attempt.status.as_str(),
            attempt.raw_usage,
            attempt.settled_microusd
        ),
        ("unknown", None, None)
    );
}

#[test]
fn settlement_releases_only_proven_unused_exposure_and_never_request_count() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), dir.path().join("task")).unwrap();
    task.authorize_route("openai", "gpt-5.6-sol").unwrap();
    task.start_worker("worker".into(), "lead".into(), 1, worker())
        .unwrap();
    let admission = task.admit("worker", "openai", "gpt-5.6-sol", 60).unwrap();
    task.dispatch(&admission, || Ok(())).unwrap();
    task.settle(
        &admission,
        json!({"input_tokens": 5, "output_tokens": 2}),
        10,
    )
    .unwrap();
    assert!(task.settle(&admission, json!({}), 0).is_err());
    task.admit("worker", "openai", "gpt-5.6-sol", 50).unwrap();
    assert!(task.admit("worker", "openai", "gpt-5.6-sol", 0).is_err());
    assert_eq!(task.remaining().unwrap().1, 1);
    assert_eq!(task.remaining().unwrap().2, 40);
}

#[test]
fn concurrent_admissions_cannot_oversubscribe_the_shared_limit() {
    let dir = tempfile::tempdir().unwrap();
    let task = Arc::new(Task::create(limits(), dir.path().join("task")).unwrap());
    task.authorize_route("openai", "gpt-5.6-sol").unwrap();
    let threads: Vec<_> = (0..20)
        .map(|_| {
            let task = task.clone();
            std::thread::spawn(move || task.admit("lead", "openai", "gpt-5.6-sol", 30).is_ok())
        })
        .collect();
    let admitted = threads
        .into_iter()
        .filter_map(|thread| thread.join().ok())
        .filter(|ok| *ok)
        .count();
    assert_eq!(admitted, 3);
    assert_eq!(task.remaining().unwrap().2, 10);
}

#[test]
fn usage_exceeding_reservation_stops_all_new_requests() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), dir.path().join("task")).unwrap();
    task.authorize_route("openai", "gpt-5.6-sol").unwrap();
    let request = task.admit("lead", "openai", "gpt-5.6-sol", 20).unwrap();
    task.dispatch(&request, || Ok(())).unwrap();
    assert!(
        task.settle(&request, json!({"input_tokens": 1000}), 21)
            .is_err()
    );
    assert!(task.admit("lead", "openai", "gpt-5.6-sol", 0).is_err());
    assert_eq!(task.remaining().unwrap().2, 79);
}

#[test]
fn foreign_admission_and_evidence_reuse_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let first = Task::create(limits(), dir.path().join("first")).unwrap();
    first.authorize_route("openai", "gpt-5.6-sol").unwrap();
    let second = Task::create(limits(), dir.path().join("second")).unwrap();
    second.authorize_route("openai", "gpt-5.6-sol").unwrap();
    let request = first.admit("lead", "openai", "gpt-5.6-sol", 20).unwrap();
    second.admit("lead", "openai", "gpt-5.6-sol", 20).unwrap();
    assert!(second.settle(&request, json!({}), 0).is_err());
    assert!(Task::create(limits(), dir.path().join("first")).is_err());
}

#[test]
fn evidence_write_failure_stops_admission_without_sending_a_request() {
    let dir = tempfile::tempdir().unwrap();
    let evidence = dir.path().join("task");
    let task = Task::create(limits(), evidence.clone()).unwrap();
    task.authorize_route("openai", "gpt-5.6-sol").unwrap();
    std::fs::write(evidence.join("00000002.json"), "preexisting").unwrap();
    assert!(task.admit("lead", "openai", "gpt-5.6-sol", 20).is_err());
    assert!(task.admit("lead", "openai", "gpt-5.6-sol", 20).is_err());
    assert!(task.attempts().unwrap().is_empty());
    assert_eq!(
        std::fs::read_to_string(evidence.join("00000002.json")).unwrap(),
        "preexisting"
    );
}

#[test]
fn revoked_or_stopped_reservations_cannot_dispatch_and_dispatch_is_one_shot() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), dir.path().join("task")).unwrap();
    task.authorize_route("openai", "gpt-5.6-sol").unwrap();
    task.start_worker("worker".into(), "lead".into(), 1, worker())
        .unwrap();
    task.authorize_worker_route("worker", "vendor", "worker-model")
        .unwrap();
    let request = task.admit("worker", "vendor", "worker-model", 10).unwrap();
    task.finish_worker("worker").unwrap();
    assert!(
        task.dispatch::<()>(&request, || panic!("stopped worker request dispatched"))
            .is_err()
    );
    let request = task.admit("lead", "openai", "gpt-5.6-sol", 10).unwrap();
    task.dispatch(&request, || Ok(())).unwrap();
    assert!(
        task.dispatch::<()>(&request, || panic!("request dispatched twice"))
            .is_err()
    );
    let request = task.admit("lead", "openai", "gpt-5.6-sol", 10).unwrap();
    task.stop().unwrap();
    assert!(
        task.dispatch::<()>(&request, || panic!("stopped task dispatched"))
            .is_err()
    );
}
