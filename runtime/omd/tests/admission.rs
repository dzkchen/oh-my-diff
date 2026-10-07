use codex_omd::Limits;
use codex_omd::Task;
use codex_omd::VersionMarker;
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

#[test]
fn granted_subscription_route_records_usage_without_a_settled_cash_charge() {
    let directory = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), directory.path().join("task")).unwrap();
    task.authorize_route("openai", "gpt-5.6-sol").unwrap();
    assert!(
        task.admit_with_billing("lead", "vendor", "model-a", 20, true)
            .is_err()
    );
    assert!(task.authorize_route("", "model-a").is_err());
    task.authorize_route("vendor", "model-a").unwrap();
    assert!(
        task.admit_with_billing("lead", "vendor", "model-b", 20, true)
            .is_err()
    );
    let admitted = task
        .admit_with_billing("lead", "vendor", "model-a", 20, true)
        .unwrap();
    task.dispatch(&admitted, || Ok(())).unwrap();
    task.settle(&admitted, json!({"input_tokens": 5, "output_tokens": 2}), 7)
        .unwrap();
    let capture = task.cost_capture().unwrap();
    assert_eq!(capture.settled_task_charge_microusd, 0);
    assert_eq!(capture.subscription_list_equivalent_microusd, 7);
    assert_eq!(capture.raw_usage_attempts, 1);
}

#[test]
fn cost_summary_totals_every_attempt_but_keeps_only_the_newest() {
    let directory = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), directory.path().join("task")).unwrap();
    task.authorize_route("vendor", "model-a").unwrap();
    for charge in [3, 4, 5] {
        let admitted = task.admit("lead", "vendor", "model-a", 20).unwrap();
        task.dispatch(&admitted, || Ok(())).unwrap();
        task.settle(&admitted, json!({"input_tokens": 1}), charge)
            .unwrap();
    }
    let full = task.cost_capture().unwrap();
    let (summary, observed) = task.cost_summary(2).unwrap();
    assert_eq!(observed, 0);
    assert!(summary.observed.is_empty());
    assert_eq!(summary.attempts, full.attempts[1..]);
    assert_eq!(summary.settled_task_charge_microusd, 12);
    assert_eq!(
        summary.settled_task_charge_microusd,
        full.settled_task_charge_microusd
    );
    assert_eq!(summary.raw_usage_attempts, 3);
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

fn marker(label: &str, hash: char) -> VersionMarker {
    VersionMarker {
        label: label.into(),
        sha256: hash.to_string().repeat(64),
        evidence: format!("evidence/{label}.json"),
        evidence_sha256: "f".repeat(64),
    }
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
fn failure_keeps_exposure_and_survives_later_usage_reconciliation() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), dir.path().join("task")).unwrap();
    task.authorize_route("openai", "gpt-5.6-sol").unwrap();
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

#[test]
fn dispatch_callback_can_reenter_without_overwriting_completed_usage() {
    let dir = tempfile::tempdir().unwrap();
    let evidence = dir.path().join("task");
    let task = Task::create(limits(), evidence.clone()).unwrap();
    task.authorize_route("openai", "gpt-5.6-sol").unwrap();
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
    task.authorize_route("openai", "gpt-5.6-sol").unwrap();
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
fn recursion_requires_an_active_parent_and_shared_depth_capacity() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), dir.path().join("task")).unwrap();
    task.authorize_route("openai", "gpt-5.6-sol").unwrap();
    assert!(
        task.start_worker("orphan".into(), "missing".into(), 2, worker())
            .is_err()
    );
    task.start_worker("parent".into(), "lead".into(), 1, worker())
        .unwrap();
    task.start_worker("child".into(), "parent".into(), 2, worker())
        .unwrap();
    assert!(
        task.start_worker("too-deep".into(), "child".into(), 3, worker())
            .is_err()
    );
    assert!(task.finish_worker("parent").is_err());
    task.finish_worker("child").unwrap();
    task.finish_worker("parent").unwrap();
}

#[test]
fn explicit_resume_preserves_allowance_and_uncertain_requests() {
    let dir = tempfile::tempdir().unwrap();
    let evidence = dir.path().join("task");
    let task = Task::create(limits(), evidence.clone()).unwrap();
    task.authorize_route("openai", "gpt-5.6-sol").unwrap();
    let request = task.admit("lead", "openai", "gpt-5.6-sol", 30).unwrap();
    task.dispatch(&request, || Ok(())).unwrap();
    task.pause("client_loss", task.uncertain_requests().unwrap())
        .unwrap();
    drop(task);
    assert!(Task::open(limits(), evidence.clone(), None).is_err());
    let resumed = Task::open(limits(), evidence, Some("user requested resume")).unwrap();
    resumed.authorize_route("openai", "gpt-5.6-sol").unwrap();
    assert_eq!(resumed.remaining().unwrap().1, 2);
    assert_eq!(resumed.remaining().unwrap().2, 70);
    assert_eq!(resumed.uncertain_requests().unwrap(), vec![1]);
    resumed.check_active().unwrap();
}

#[test]
fn provider_billed_costs_stay_outside_exposure_after_resume() {
    let dir = tempfile::tempdir().unwrap();
    let evidence = dir.path().join("task");
    let task = Task::create(limits(), evidence.clone()).unwrap();
    task.authorize_route("cursor", "auto").unwrap();
    for cost in [Some(90), None] {
        let request = task.admit("lead", "cursor", "auto", 0).unwrap();
        task.dispatch(&request, || Ok(())).unwrap();
        task.settle_reported(&request, None, cost).unwrap();
    }
    task.settle_provider(2, 80, "fixture").unwrap();
    assert_eq!(task.remaining().unwrap().2, 100);
    drop(task);
    let resumed = Task::open(limits(), evidence, Some("user requested resume")).unwrap();
    assert_eq!(resumed.remaining().unwrap().2, 100);
}

#[test]
fn discarded_worker_result_replays_without_claiming_consumption() {
    let dir = tempfile::tempdir().unwrap();
    let evidence = dir.path().join("task");
    let task = Task::create(limits(), evidence.clone()).unwrap();
    task.authorize_route("openai", "gpt-5.6-sol").unwrap();
    task.start_worker("unused".into(), "lead".into(), 1, worker())
        .unwrap();
    assert!(task.discard_worker_result("unused").is_err());
    task.complete_worker("unused", marker("unused-result", 'e'))
        .unwrap();
    task.discard_worker_result("unused").unwrap();
    assert!(task.consume_worker_result("unused").is_err());
    task.pause("restart", Vec::new()).unwrap();
    drop(task);
    std::fs::write(evidence.join("mod-view.json"), b"{\"panels\":[]}").unwrap();
    let resumed = Task::open(limits(), evidence.clone(), Some("discard replay")).unwrap();
    resumed.authorize_route("openai", "gpt-5.6-sol").unwrap();
    assert!(resumed.consume_worker_result("unused").is_err());
    let records = std::fs::read_dir(evidence)
        .unwrap()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(entry.path()).ok()?).ok()
        })
        .collect::<Vec<_>>();
    assert!(
        records
            .iter()
            .any(|record| record["record"]["event"] == "worker_archived"
                && record["record"]["archive"]["status"] == "stopped")
    );
    assert!(
        !records
            .iter()
            .any(|record| record["record"]["event"] == "worker_result_consumed")
    );
}
