use codex_omd::FailureClass;
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
        concurrent_workers: 1,
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
fn contributor_requires_current_authorization_and_exact_identity() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), dir.path().join("task")).unwrap();
    task.start_worker("worker".into(), worker()).unwrap();
    assert!(
        task.admit("worker", "meta", "muse-spark-1.3-contributor", 10)
            .is_err()
    );
    task.set_contributor_authorization(true, "host-consent")
        .unwrap();
    assert!(task.admit("worker", "meta", "muse-spark-1.3", 10).is_err());
    assert!(
        task.admit("lead", "meta", "muse-spark-1.3-contributor", 10)
            .is_err()
    );
    task.admit("worker", "meta", "muse-spark-1.3-contributor", 10)
        .unwrap();
    task.set_contributor_authorization(false, "host-revocation")
        .unwrap();
    assert!(
        task.admit("worker", "meta", "muse-spark-1.3-contributor", 10)
            .is_err()
    );
    assert_eq!(task.attempts().unwrap().len(), 1);
}

#[test]
fn unknown_usage_remains_reserved_after_worker_exit() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), dir.path().join("task")).unwrap();
    task.start_worker("first".into(), worker()).unwrap();
    task.admit("first", "openai", "gpt-5.6-sol", 60).unwrap();
    task.finish_worker("first").unwrap();
    assert!(task.start_worker("first".into(), worker()).is_err());
    task.start_worker("second".into(), worker()).unwrap();
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
    task.start_worker("worker".into(), worker()).unwrap();
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
    let second = Task::create(limits(), dir.path().join("second")).unwrap();
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
fn failure_keeps_exposure_and_survives_later_usage_reconciliation() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), dir.path().join("task")).unwrap();
    let request = task.admit("lead", "openai", "gpt-5.6-sol", 60).unwrap();
    task.fail(&request, "connection_lost").unwrap();
    assert_eq!(task.remaining().unwrap().2, 40);
    assert!(task.fail(&request, "second_failure").is_err());
    task.settle(&request, json!({"input_tokens": 5, "output_tokens": 2}), 10)
        .unwrap();
    let attempt = task.attempts().unwrap().remove(0);
    assert_eq!(
        (
            attempt.status.as_str(),
            attempt.failure_reason.as_deref(),
            attempt.settled_microusd
        ),
        ("failed", Some("connection_lost"), Some(10))
    );
    assert_eq!(task.remaining().unwrap().2, 90);
}

#[test]
fn revoked_or_stopped_reservations_cannot_dispatch_and_dispatch_is_one_shot() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), dir.path().join("task")).unwrap();
    task.start_worker("worker".into(), worker()).unwrap();
    task.set_contributor_authorization(true, "grant").unwrap();
    let request = task
        .admit("worker", "meta", "muse-spark-1.3-contributor", 10)
        .unwrap();
    task.set_contributor_authorization(false, "revoked")
        .unwrap();
    assert!(
        task.dispatch::<()>(&request, || panic!("revoked request dispatched"))
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

#[test]
fn dispatch_callback_can_reenter_without_overwriting_completed_usage() {
    let dir = tempfile::tempdir().unwrap();
    let evidence = dir.path().join("task");
    let task = Task::create(limits(), evidence.clone()).unwrap();
    let request = task.admit("lead", "openai", "gpt-5.6-sol", 60).unwrap();
    assert!(
        task.dispatch::<()>(&request, || {
            task.settle(&request, json!({"input_tokens": 5}), 10)?;
            task.stop()?;
            Err(std::io::Error::other("callback failed after completion"))
        })
        .is_err()
    );
    assert_eq!(task.attempts().unwrap()[0].status, "completed");
    assert_eq!(task.remaining().unwrap().2, 90);
    let last: serde_json::Value =
        serde_json::from_slice(&std::fs::read(evidence.join("00000006.json")).unwrap()).unwrap();
    assert_eq!(last["record"]["event"], "dispatch_callback_failed");
}

#[test]
fn unpriced_raw_usage_is_retained_without_refunding_exposure() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), dir.path().join("task")).unwrap();
    let admission = task.admit("lead", "openai", "gpt-5.6-sol", 60).unwrap();
    task.dispatch(&admission, || Ok(())).unwrap();
    let usage = json!({"input_tokens": 12, "provider_specific_cache": 3});
    task.retain_usage(&admission, usage.clone()).unwrap();
    task.fail(&admission, "unknown cache billing").unwrap();
    assert_eq!(task.remaining().unwrap().2, 40);
    assert_eq!(task.attempts().unwrap()[0].raw_usage, Some(usage));
    assert_eq!(task.attempts().unwrap()[0].settled_microusd, None);
    task.check_active().unwrap();
    task.stop().unwrap();
    assert!(task.check_active().is_err());
}

#[test]
fn classified_failures_are_preserved_and_escalation_is_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let evidence = dir.path().join("task");
    let task = Task::create(limits(), evidence.clone()).unwrap();
    for class in [
        FailureClass::Environment,
        FailureClass::Edit,
        FailureClass::Diagnosis,
        FailureClass::Model,
    ] {
        let failure = task
            .record_failure(
                class,
                format!("{class:?} failure"),
                vec![json!({"path": "evidence.json", "sha256": "abc"})],
            )
            .unwrap();
        assert_eq!(failure.class, class);
    }
    let remaining = task.permit_escalation(1, 2).unwrap();
    assert_eq!(remaining.1, limits().requests);
    assert!(task.permit_escalation(1, 2).is_err());
    task.permit_escalation(2, 2).unwrap();
    assert!(task.permit_escalation(3, 2).is_err());
    let records = std::fs::read_dir(evidence).unwrap().count();
    assert_eq!(records, 7);
}

#[test]
fn failure_and_escalation_validation_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), dir.path().join("task")).unwrap();
    assert!(
        task.record_failure(FailureClass::Edit, String::new(), vec![json!({})])
            .is_err()
    );
    assert!(
        task.record_failure(FailureClass::Edit, "missing evidence".into(), vec![])
            .is_err()
    );
    assert!(task.permit_escalation(1, 1).is_err());
    let failure = task
        .record_failure(
            FailureClass::Diagnosis,
            "bounded evidence".into(),
            vec![json!({"call_id": "failed-call"})],
        )
        .unwrap();
    assert!(task.permit_escalation(failure.id, 0).is_err());
}
