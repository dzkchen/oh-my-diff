use super::*;

fn sha(value: char) -> String {
    std::iter::repeat_n(value, 64).collect()
}

fn marker(label: &str, value: char) -> VersionMarker {
    VersionMarker {
        label: label.into(),
        sha256: sha(value),
        evidence: format!("/evidence/{label}.json"),
        evidence_sha256: sha('e'),
    }
}

fn finding(fingerprint: char, summary: &str) -> ReviewFindingInput {
    ReviewFindingInput {
        fingerprint: sha(fingerprint),
        severity: ReviewSeverity::Warning,
        summary: summary.into(),
        paths: vec!["src/lib.rs".into()],
    }
}

fn submission(cadence: ReviewCadence, candidate: char) -> ReviewSubmission {
    ReviewSubmission {
        cadence,
        candidate: marker("candidate", candidate),
        stable: true,
        risk: None,
        reviewer: "astra".into(),
        separate_reviewer: true,
        checks: Vec::new(),
        findings: Vec::new(),
        resolved_finding_ids: Vec::new(),
    }
}

#[test]
fn every_turn_is_off_by_default_and_independently_switchable() {
    let mut review = UnifiedReview::new(ReviewPolicy::default()).unwrap();
    let request = submission(ReviewCadence::EveryTurn, 'a');
    assert_eq!(
        review.submit(request.clone()).unwrap_err().to_string(),
        "every-turn advice is disabled"
    );
    let policy = ReviewPolicy {
        every_turn_advice: true,
        ..ReviewPolicy::default()
    };
    UnifiedReview::new(policy).unwrap().submit(request).unwrap();
}

#[test]
fn repair_scope_entries_are_unique_and_normalized() {
    let duplicate = ReviewPolicy {
        repair_scope: vec!["src".into(), "src".into()],
        ..ReviewPolicy::default()
    };
    assert!(duplicate.validate().is_err());
    let dotted = ReviewPolicy {
        repair_scope: vec!["./src".into()],
        ..ReviewPolicy::default()
    };
    assert!(dotted.validate().is_err());
}

#[test]
fn cadence_specific_preconditions_fail_closed() {
    let mut review = UnifiedReview::new(ReviewPolicy::default()).unwrap();
    let mut milestone = submission(ReviewCadence::StableMilestone, 'a');
    milestone.stable = false;
    assert!(review.submit(milestone).is_err());
    let risk = submission(ReviewCadence::RiskTriggered, 'a');
    assert!(review.submit(risk).is_err());
    let final_review = submission(ReviewCadence::Final, 'a');
    assert!(review.submit(final_review).is_err());
}

#[test]
fn cadence_can_be_rejected_before_dispatch() {
    let policy = ReviewPolicy::default();
    assert_eq!(
        policy
            .validate_request(ReviewCadence::EveryTurn, true, None)
            .unwrap_err()
            .to_string(),
        "every-turn advice is disabled"
    );
    assert!(
        policy
            .validate_request(
                ReviewCadence::RiskTriggered,
                true,
                Some("dependency boundary")
            )
            .is_ok()
    );
}

#[test]
fn duplicate_findings_collapse_and_reappear_on_new_versions() {
    let mut review = UnifiedReview::new(ReviewPolicy::default()).unwrap();
    let mut first = submission(ReviewCadence::StableMilestone, 'a');
    first.findings = vec![finding('1', "first"), finding('1', "updated")];
    let cycle = review.submit(first).unwrap();
    assert_eq!(cycle.duplicate_findings, 1);
    assert_eq!(review.snapshot().findings.len(), 1);
    let mut second = submission(ReviewCadence::StableMilestone, 'b');
    second.findings = vec![finding('1', "still present")];
    review.submit(second).unwrap();
    let finding = &review.snapshot().findings[0];
    assert_eq!(finding.id, 1);
    assert_eq!(finding.duplicate_observations, 1);
    assert_eq!(finding.last_seen_candidate_sha256, sha('b'));
}

#[test]
fn omitted_old_findings_become_stale_until_explicitly_resolved() {
    let mut review = UnifiedReview::new(ReviewPolicy::default()).unwrap();
    let mut first = submission(ReviewCadence::StableMilestone, 'a');
    first.findings = vec![finding('1', "bug")];
    review.submit(first).unwrap();
    review
        .submit(submission(ReviewCadence::StableMilestone, 'b'))
        .unwrap();
    assert_eq!(review.snapshot().findings[0].status, FindingStatus::Stale);
    let mut resolved = submission(ReviewCadence::StableMilestone, 'c');
    resolved.resolved_finding_ids = vec![1];
    review.submit(resolved).unwrap();
    assert!(review.unresolved().is_empty());
}

#[test]
fn final_review_requires_current_checks_and_no_unresolved_findings() {
    let mut review = UnifiedReview::new(ReviewPolicy::default()).unwrap();
    let mut first = submission(ReviewCadence::StableMilestone, 'a');
    first.findings = vec![finding('1', "bug")];
    review.submit(first).unwrap();
    let mut final_review = submission(ReviewCadence::Final, 'b');
    final_review.checks = vec![marker("checks", 'b')];
    let cycle = review.submit(final_review).unwrap();
    assert!(!cycle.final_approved);
    let mut accepted = submission(ReviewCadence::Final, 'c');
    accepted.checks = vec![marker("checks", 'c')];
    accepted.resolved_finding_ids = vec![1];
    assert!(review.submit(accepted).unwrap().final_approved);
    assert_eq!(review.snapshot().final_candidate_sha256, Some(sha('c')));
}

#[test]
fn repairs_are_scoped_counted_and_invalidate_final_approval() {
    let policy = ReviewPolicy {
        max_repairs: 1,
        repair_scope: vec!["src".into()],
        ..ReviewPolicy::default()
    };
    let mut review = UnifiedReview::new(policy).unwrap();
    let mut first = submission(ReviewCadence::StableMilestone, 'a');
    first.findings = vec![finding('1', "bug")];
    review.submit(first).unwrap();
    review
        .record_repair(
            &sha('a'),
            &sha('b'),
            vec!["src/lib.rs".into()],
            vec![1],
            marker("repair", 'b'),
        )
        .unwrap();
    assert_eq!(
        review
            .recorded_repair(&sha('a'), &sha('b'))
            .unwrap()
            .finding_ids,
        vec![1]
    );
    assert!(
        review
            .record_repair(
                &sha('b'),
                &sha('c'),
                vec!["src/lib.rs".into()],
                vec![1],
                marker("repair", 'c'),
            )
            .is_err()
    );
}

#[test]
fn repair_scope_does_not_accept_prefix_collisions() {
    let policy = ReviewPolicy {
        repair_scope: vec!["src/domain".into()],
        ..ReviewPolicy::default()
    };
    let mut review = UnifiedReview::new(policy).unwrap();
    let mut first = submission(ReviewCadence::StableMilestone, 'a');
    first.findings = vec![finding('1', "bug")];
    review.submit(first).unwrap();
    assert!(
        review
            .record_repair(
                &sha('a'),
                &sha('b'),
                vec!["src/domain-old/lib.rs".into()],
                vec![1],
                marker("repair", 'b'),
            )
            .is_err()
    );
}

#[test]
fn persisted_state_round_trips_and_rejects_tampering() {
    let mut review = UnifiedReview::new(ReviewPolicy::default()).unwrap();
    review
        .submit(submission(ReviewCadence::StableMilestone, 'a'))
        .unwrap();
    let snapshot = review.snapshot();
    assert_eq!(
        UnifiedReview::restore(snapshot.clone()).unwrap().snapshot(),
        snapshot
    );
    let mut changed = snapshot;
    changed.cycles[0].id = 7;
    assert!(UnifiedReview::restore(changed).is_err());
}
