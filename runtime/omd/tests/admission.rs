use codex_omd::AcceptanceEvidence;
use codex_omd::CallDecision;
use codex_omd::CheckpointTaskStatus;
use codex_omd::CheckpointUpdate;
use codex_omd::FailureClass;
use codex_omd::Limits;
use codex_omd::LiveState;
use codex_omd::ProcessSnapshot;
use codex_omd::ProcessStatus;
use codex_omd::Task;
use codex_omd::TaskContract;
use codex_omd::VersionMarker;
use codex_omd::WorkerLimits;
use codex_omd::WorkerStatus;
use serde_json::json;
use std::sync::Arc;

fn limits() -> Limits {
    Limits {
        requests: 3,
        exposure_microusd: 100,
        seconds: 30,
        concurrent_workers: 2,
        max_depth: 2,
        max_reassessments: 1,
    }
}

#[test]
fn granted_subscription_route_records_usage_without_a_settled_cash_charge() {
    let directory = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), directory.path().join("task")).unwrap();
    assert!(
        task.admit_with_billing("lead", "vendor", "model-a", 20, true)
            .is_err()
    );
    assert!(task.authorize_external_route("openai", "model-a").is_err());
    task.authorize_external_route("vendor", "model-a").unwrap();
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

fn worker() -> WorkerLimits {
    WorkerLimits {
        requests: 2,
        exposure_microusd: 60,
        seconds: 20,
    }
}

fn contract() -> TaskContract {
    TaskContract {
        objective: "Persist task progress independently of conversation".into(),
        acceptance_criteria: vec!["candidate checked".into(), "restart reconciled".into()],
        max_no_progress_calls: 2,
    }
}

fn live(workspace: char, processes: Vec<ProcessSnapshot>) -> LiveState {
    LiveState {
        workspace_sha256: workspace.to_string().repeat(64),
        tracked_paths_sha256: "b".repeat(64),
        processes,
    }
}

fn marker(label: &str, hash: char) -> VersionMarker {
    VersionMarker {
        label: label.into(),
        sha256: hash.to_string().repeat(64),
        evidence: format!("evidence/{label}.json"),
        evidence_sha256: "f".repeat(64),
    }
}

fn completed_update() -> CheckpointUpdate {
    let candidate = marker("candidate-v1", 'c');
    let check = marker("check-v1", 'd');
    CheckpointUpdate {
        completed_acceptance: vec![
            AcceptanceEvidence {
                criterion: "candidate checked".into(),
                evidence: vec![candidate.clone(), check.clone()],
            },
            AcceptanceEvidence {
                criterion: "restart reconciled".into(),
                evidence: vec![check.clone()],
            },
        ],
        completed_steering: vec!["keep the user's dirty files".into()],
        remaining_work: Vec::new(),
        failed_hypotheses: vec!["conversation summary is durable state".into()],
        candidate_versions: vec![candidate],
        check_versions: vec![check],
    }
}

#[test]
fn task_limits_reject_unbounded_request_and_worker_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut excessive_requests = limits();
    excessive_requests.requests = 10_001;
    assert!(Task::create(excessive_requests, dir.path().join("requests")).is_err());
    let mut excessive_workers = limits();
    excessive_workers.concurrent_workers = 129;
    assert!(Task::create(excessive_workers, dir.path().join("workers")).is_err());
}

#[test]
fn live_call_and_failure_caches_fail_closed_at_their_ceiling() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create_checkpointed(
        limits(),
        dir.path().join("task"),
        contract(),
        live('a', Vec::new()),
    )
    .unwrap();
    for value in 0..256u64 {
        task.observe_call(&format!("{value:064x}"), &"a".repeat(64), false)
            .unwrap();
    }
    assert!(
        task.observe_call(&format!("{:064x}", 256), &"b".repeat(64), false)
            .is_err()
    );
    let checkpoint = task.checkpoint().unwrap().unwrap();
    task.save_checkpoint(
        CheckpointUpdate {
            completed_acceptance: checkpoint.completed_acceptance,
            completed_steering: vec!["bounded cache rotation".into()],
            remaining_work: checkpoint.remaining_work,
            failed_hypotheses: checkpoint.failed_hypotheses,
            candidate_versions: checkpoint.candidate_versions,
            check_versions: checkpoint.check_versions,
        },
        live('a', Vec::new()),
    )
    .unwrap();
    task.observe_call(&format!("{:064x}", 256), &"b".repeat(64), false)
        .unwrap();

    for value in 0..128 {
        task.record_failure(
            FailureClass::Diagnosis,
            format!("failure {value}"),
            vec![json!({"id": value})],
        )
        .unwrap();
    }
    assert!(
        task.record_failure(
            FailureClass::Diagnosis,
            "failure overflow".into(),
            vec![json!({"id": 128})],
        )
        .is_err()
    );
}

#[test]
fn equivalent_failure_fingerprint_cache_is_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), dir.path().join("task")).unwrap();
    for value in 0..128 {
        assert!(
            !task
                .observe_equivalent_failure(&format!("failure-{value}"), 2, "change route")
                .unwrap()
        );
    }
    assert!(
        task.observe_equivalent_failure("failure-overflow", 2, "change route")
            .is_err()
    );
}

#[test]
fn contributor_requires_current_authorization_and_exact_identity() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), dir.path().join("task")).unwrap();
    task.start_worker("worker".into(), "lead".into(), 1, worker())
        .unwrap();
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
    task.start_worker("worker".into(), "lead".into(), 1, worker())
        .unwrap();
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

#[test]
fn recursion_requires_an_active_parent_and_shared_depth_capacity() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), dir.path().join("task")).unwrap();
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
fn equivalent_failures_force_one_bounded_changed_action() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create(limits(), dir.path().join("task")).unwrap();
    assert!(
        !task
            .observe_equivalent_failure("provider-outage", 2, "fresh retry")
            .unwrap()
    );
    assert!(
        task.observe_equivalent_failure("provider-outage", 2, "openai fallback")
            .unwrap()
    );
    assert!(
        task.observe_equivalent_failure("provider-outage", 2, "repeat fallback")
            .is_err()
    );
}

#[test]
fn explicit_resume_preserves_allowance_and_uncertain_requests() {
    let dir = tempfile::tempdir().unwrap();
    let evidence = dir.path().join("task");
    let task = Task::create(limits(), evidence.clone()).unwrap();
    let request = task.admit("lead", "openai", "gpt-5.6-sol", 30).unwrap();
    task.dispatch(&request, || Ok(())).unwrap();
    task.pause("client_loss", task.uncertain_requests().unwrap())
        .unwrap();
    drop(task);
    assert!(Task::open(limits(), evidence.clone(), None).is_err());
    let resumed = Task::open(limits(), evidence, Some("user requested resume")).unwrap();
    assert_eq!(resumed.remaining().unwrap().1, 2);
    assert_eq!(resumed.remaining().unwrap().2, 70);
    assert_eq!(resumed.uncertain_requests().unwrap(), vec![1]);
    resumed.check_active().unwrap();
}

#[test]
fn compact_checkpoint_preserves_contract_progress_versions_and_allowance() {
    let dir = tempfile::tempdir().unwrap();
    let evidence = dir.path().join("task");
    let task = Task::create_checkpointed(
        limits(),
        evidence.clone(),
        contract(),
        live('a', Vec::new()),
    )
    .unwrap();
    let request = task.admit("lead", "openai", "gpt-5.6-sol", 30).unwrap();
    task.dispatch(&request, || Ok(())).unwrap();
    task.settle(&request, json!({"input_tokens": 1}), 10)
        .unwrap();
    let checkpoint = task
        .save_checkpoint(completed_update(), live('c', Vec::new()))
        .unwrap();
    assert_eq!(checkpoint.objective, contract().objective);
    assert_eq!(
        checkpoint.acceptance_criteria,
        contract().acceptance_criteria
    );
    assert_eq!(checkpoint.completed_steering.len(), 1);
    assert_eq!(checkpoint.failed_hypotheses.len(), 1);
    assert_eq!(checkpoint.candidate_versions[0].label, "candidate-v1");
    assert_eq!(checkpoint.check_versions[0].label, "check-v1");
    assert_eq!(checkpoint.allowance.requests_consumed, 1);
    assert_eq!(checkpoint.allowance.exposure_consumed_microusd, 10);
    let compact: serde_json::Value =
        serde_json::from_slice(&std::fs::read(evidence.join("checkpoint.json")).unwrap()).unwrap();
    assert_eq!(compact["revision"], checkpoint.revision);
    let mut discarded = completed_update();
    discarded.completed_steering.clear();
    assert!(
        task.save_checkpoint(discarded, live('c', Vec::new()))
            .is_err()
    );
}

#[test]
fn terminal_worker_detail_is_archived_and_live_checkpoint_stays_compact() {
    let dir = tempfile::tempdir().unwrap();
    let evidence = dir.path().join("task");
    let task = Task::create_checkpointed(
        limits(),
        evidence.clone(),
        contract(),
        live('a', Vec::new()),
    )
    .unwrap();
    task.start_worker("first".into(), "lead".into(), 1, worker())
        .unwrap();
    task.start_worker("second".into(), "lead".into(), 1, worker())
        .unwrap();
    task.claim_worker_objective("first", "Inspect   the parser")
        .unwrap();
    assert!(
        task.claim_worker_objective("second", "inspect the PARSER")
            .is_err()
    );
    task.claim_worker_objective("second", "Inspect the renderer")
        .unwrap();
    let request = task.admit("first", "openai", "gpt-5.6-sol", 60).unwrap();
    task.dispatch(&request, || Ok(())).unwrap();
    task.settle(&request, json!({"input_tokens": 1}), 50)
        .unwrap();
    task.finish_worker("second").unwrap();
    task.complete_worker("first", marker("worker-result", 'e'))
        .unwrap();
    let statuses = task
        .checkpoint()
        .unwrap()
        .unwrap()
        .workers
        .into_iter()
        .map(|worker| (worker.id, worker.status))
        .collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(statuses["first"], WorkerStatus::Completed);
    assert!(!statuses.contains_key("second"));
    assert_eq!(task.checkpoint().unwrap().unwrap().archived_workers, 1);
    task.consume_worker_result("first").unwrap();
    let compact = task.checkpoint().unwrap().unwrap();
    assert!(compact.workers.is_empty());
    assert_eq!(compact.archived_workers, 2);
    assert!(
        task.start_worker("first".into(), "lead".into(), 1, worker())
            .is_err()
    );
    let archives = std::fs::read_dir(&evidence)
        .unwrap()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(entry.path()).ok()?).ok()
        })
        .filter(|record| record["record"]["event"] == "worker_archived")
        .collect::<Vec<_>>();
    assert_eq!(archives.len(), 2);
    assert!(archives.iter().any(|record| {
        record["record"]["archive"]["id"] == "first"
            && record["record"]["archive"]["status"] == "consumed"
            && record["record"]["archive"]["result"]["label"] == "worker-result"
            && record["record"]["archive"]["requests"] == 1
            && record["record"]["archive"]["exposure_microusd"] == 50
    }));
    task.start_worker("third".into(), "lead".into(), 1, worker())
        .unwrap();
    task.claim_worker_objective("third", "Verify pause archive replay")
        .unwrap();
    task.pause("restart", Vec::new()).unwrap();
    assert_eq!(task.checkpoint().unwrap().unwrap().archived_workers, 3);
    drop(task);
    let resumed = Task::open_checkpointed(
        limits(),
        evidence,
        Some("archive replay"),
        contract(),
        live('a', Vec::new()),
    )
    .unwrap();
    let resumed_checkpoint = resumed.checkpoint().unwrap().unwrap();
    assert!(resumed_checkpoint.workers.is_empty());
    assert_eq!(resumed_checkpoint.archived_workers, 3);
    assert!(
        resumed
            .start_worker("second".into(), "lead".into(), 1, worker())
            .is_err()
    );
    assert!(
        resumed
            .start_worker("third".into(), "lead".into(), 1, worker())
            .is_err()
    );
}

#[test]
fn unchanged_calls_reassess_then_pause_but_waits_remain_bounded_by_task_time() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create_checkpointed(
        limits(),
        dir.path().join("task"),
        contract(),
        live('a', Vec::new()),
    )
    .unwrap();
    let signature = "1".repeat(64);
    let result = "2".repeat(64);
    assert_eq!(
        task.observe_call(&signature, &result, false).unwrap(),
        CallDecision::Progress
    );
    assert_eq!(
        task.observe_call(&signature, &result, true).unwrap(),
        CallDecision::LegitimateWait
    );
    assert_eq!(
        task.observe_call(&signature, &result, false).unwrap(),
        CallDecision::Paused
    );
    assert_eq!(
        task.checkpoint().unwrap().unwrap().task_status,
        CheckpointTaskStatus::Paused
    );
    assert!(task.admit("lead", "openai", "gpt-5.6-sol", 1).is_err());
}

#[test]
fn a_checkpoint_revision_resets_unchanged_call_detection() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create_checkpointed(
        limits(),
        dir.path().join("task"),
        contract(),
        live('a', Vec::new()),
    )
    .unwrap();
    let signature = "3".repeat(64);
    let result = "4".repeat(64);
    assert_eq!(
        task.observe_call(&signature, &result, false).unwrap(),
        CallDecision::Progress
    );
    let checkpoint = task.checkpoint().unwrap().unwrap();
    task.save_checkpoint(
        CheckpointUpdate {
            completed_acceptance: checkpoint.completed_acceptance,
            completed_steering: vec!["used a different bounded approach".into()],
            remaining_work: checkpoint.remaining_work,
            failed_hypotheses: checkpoint.failed_hypotheses,
            candidate_versions: checkpoint.candidate_versions,
            check_versions: checkpoint.check_versions,
        },
        live('a', Vec::new()),
    )
    .unwrap();
    assert_eq!(
        task.observe_call(&signature, &result, false).unwrap(),
        CallDecision::Progress
    );
}

#[test]
fn restart_reconciles_workspace_processes_and_preserves_terminal_semantics() {
    let dir = tempfile::tempdir().unwrap();
    let evidence = dir.path().join("task");
    let prior_process = ProcessSnapshot {
        identity: "process-1".into(),
        owner: "worker".into(),
        status: ProcessStatus::Running,
    };
    let task = Task::create_checkpointed(
        limits(),
        evidence.clone(),
        contract(),
        live('a', vec![prior_process.clone()]),
    )
    .unwrap();
    let signature = "7".repeat(64);
    let result = "8".repeat(64);
    assert_eq!(
        task.observe_call(&signature, &result, false).unwrap(),
        CallDecision::Progress
    );
    task.pause("compaction", Vec::new()).unwrap();
    drop(task);
    let stopped_process = ProcessSnapshot {
        status: ProcessStatus::Stopped,
        ..prior_process
    };
    let resumed = Task::open_checkpointed(
        limits(),
        evidence,
        Some("explicit restart"),
        contract(),
        live('f', vec![stopped_process.clone()]),
    )
    .unwrap();
    let checkpoint = resumed.checkpoint().unwrap().unwrap();
    let reconciliation = checkpoint.reconciliation.unwrap();
    assert!(reconciliation.changed_workspace);
    assert_eq!(reconciliation.current_processes, vec![stopped_process]);
    assert_eq!(checkpoint.task_status, CheckpointTaskStatus::Active);
    assert_eq!(
        resumed.observe_call(&signature, &result, false).unwrap(),
        CallDecision::Reassess
    );
    assert!(resumed.complete("not ready").is_err());
    resumed
        .save_checkpoint(completed_update(), live('f', Vec::new()))
        .unwrap();
    resumed
        .complete("all acceptance evidence retained")
        .unwrap();
    assert_eq!(
        resumed.checkpoint().unwrap().unwrap().task_status,
        CheckpointTaskStatus::Completed
    );
}

#[test]
fn direct_completion_does_not_require_checkpoint_acceptance() {
    let dir = tempfile::tempdir().unwrap();
    let task = Task::create_checkpointed(
        limits(),
        dir.path().join("task"),
        contract(),
        live('a', Vec::new()),
    )
    .unwrap();

    task.complete_direct("direct single-agent completion")
        .unwrap();

    assert_eq!(
        task.checkpoint().unwrap().unwrap().task_status,
        CheckpointTaskStatus::Completed
    );
}

#[test]
fn discarded_worker_result_replays_without_claiming_consumption() {
    let dir = tempfile::tempdir().unwrap();
    let evidence = dir.path().join("task");
    let task = Task::create_checkpointed(
        limits(),
        evidence.clone(),
        contract(),
        live('a', Vec::new()),
    )
    .unwrap();
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
    let resumed = Task::open_checkpointed(
        limits(),
        evidence.clone(),
        Some("discard replay"),
        contract(),
        live('a', Vec::new()),
    )
    .unwrap();
    let checkpoint = resumed.checkpoint().unwrap().unwrap();
    assert!(checkpoint.workers.is_empty());
    assert_eq!(checkpoint.archived_workers, 1);
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
