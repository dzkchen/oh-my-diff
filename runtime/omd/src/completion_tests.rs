use super::*;

fn sha(value: char) -> String {
    std::iter::repeat_n(value, 64).collect()
}

fn contract() -> TaskContract {
    TaskContract {
        objective: "Ship the exact requested behavior.".into(),
        acceptance_criteria: vec![
            "public wiring reaches the implementation".into(),
            "checks cover the relevant negative case".into(),
        ],
        max_no_progress_calls: 2,
    }
}

fn marker(label: &str, candidate: char, evidence: char) -> VersionMarker {
    VersionMarker {
        label: label.into(),
        sha256: sha(candidate),
        evidence: format!("/evidence/{label}.json"),
        evidence_sha256: sha(evidence),
    }
}

fn final_review(candidate: char) -> ReviewCycle {
    ReviewCycle {
        id: 7,
        lane: Default::default(),
        cadence: ReviewCadence::Final,
        candidate: marker("review-candidate", candidate, 'r'),
        stable: true,
        risk: None,
        reviewer: "astra".into(),
        separate_reviewer: true,
        checks: vec![marker("checks", candidate, 'c')],
        observed_finding_ids: Vec::new(),
        resolved_finding_ids: Vec::new(),
        duplicate_findings: 0,
        final_approved: true,
    }
}

fn requirement_evidence(candidate: char) -> Vec<AcceptanceEvidence> {
    contract()
        .acceptance_criteria
        .into_iter()
        .enumerate()
        .map(|(index, criterion)| AcceptanceEvidence {
            criterion,
            evidence: vec![marker(
                &format!("requirement-{index}"),
                candidate,
                char::from_u32('d' as u32 + index as u32).unwrap(),
            )],
        })
        .collect()
}

fn requirements(candidate: char) -> Vec<RequirementAssessment> {
    requirement_evidence(candidate)
        .into_iter()
        .map(|entry| RequirementAssessment {
            criterion: entry.criterion,
            verdict: RequirementVerdict::Satisfied,
            summary: "The exact-candidate evidence demonstrates this requirement.".into(),
            evidence_sha256s: entry
                .evidence
                .into_iter()
                .map(|marker| marker.evidence_sha256)
                .collect(),
        })
        .collect()
}

fn challenges() -> Vec<ChallengeAssessment> {
    vec![
        ChallengeAssessment {
            kind: ChallengeKind::NegativeCases,
            verdict: ChallengeVerdict::Passed,
            summary: "The relevant failure path is asserted.".into(),
            paths: vec!["tests/completion.rs".into()],
        },
        ChallengeAssessment {
            kind: ChallengeKind::MissingWiring,
            verdict: ChallengeVerdict::Passed,
            summary: "The public entry point reaches the gate.".into(),
            paths: vec!["src/lib.rs".into()],
        },
        ChallengeAssessment {
            kind: ChallengeKind::TestWeakening,
            verdict: ChallengeVerdict::Passed,
            summary: "The prior assertions remain and new assertions are strict.".into(),
            paths: vec!["tests/completion.rs".into()],
        },
    ]
}

fn submission(candidate: char) -> CompletionSubmission {
    CompletionSubmission {
        candidate: marker("candidate", candidate, 'a'),
        contract_sha256: acceptance_contract_sha256(&contract()).unwrap(),
        verifier: "astra-verifier".into(),
        separate_verifier: true,
        final_review: final_review(candidate),
        requirement_evidence: requirement_evidence(candidate),
        requirements: requirements(candidate),
        challenges: challenges(),
        allowance_remaining: true,
    }
}

#[test]
fn completed_receipt_binds_contract_candidate_review_and_all_challenges() {
    let mut gate = CompletionGate::new(CompletionPolicy::default(), contract(), sha('0')).unwrap();
    let receipt = gate.submit(submission('a')).unwrap();
    assert_eq!(receipt.status, CompletionStatus::Completed);
    assert_eq!(
        receipt.contract_sha256,
        acceptance_contract_sha256(&contract()).unwrap()
    );
    assert_eq!(receipt.candidate.sha256, sha('a'));
    assert_eq!(receipt.final_review_cycle, Some(7));
    assert_eq!(
        receipt
            .challenges
            .iter()
            .map(|entry| entry.kind)
            .collect::<Vec<_>>(),
        ChallengeKind::all()
    );
    assert_eq!(gate.snapshot().approved_candidate_sha256, Some(sha('a')));
}

#[test]
fn exact_contract_cannot_be_omitted_duplicated_or_silently_reworded() {
    let mut gate = CompletionGate::new(CompletionPolicy::default(), contract(), sha('0')).unwrap();
    let mut missing = submission('a');
    missing.requirements.pop();
    assert!(gate.submit(missing).is_err());
    let mut duplicate = submission('a');
    duplicate.requirements[1].criterion = duplicate.requirements[0].criterion.clone();
    assert!(gate.submit(duplicate).is_err());
    let mut reworded = submission('a');
    reworded.requirements[0].criterion.push_str(" eventually");
    assert!(gate.submit(reworded).is_err());
}

#[test]
fn stale_candidate_evidence_and_stale_final_review_fail_closed() {
    let mut gate = CompletionGate::new(CompletionPolicy::default(), contract(), sha('0')).unwrap();
    let mut stale_evidence = submission('b');
    stale_evidence.requirement_evidence[0].evidence[0].sha256 = sha('a');
    assert!(gate.submit(stale_evidence).is_err());
    let mut stale_review = submission('b');
    stale_review.final_review.candidate.sha256 = sha('a');
    assert!(gate.submit(stale_review).is_err());
}

#[test]
fn all_three_adversarial_categories_are_mandatory() {
    let mut gate = CompletionGate::new(CompletionPolicy::default(), contract(), sha('0')).unwrap();
    let mut missing = submission('a');
    missing
        .challenges
        .retain(|entry| entry.kind != ChallengeKind::TestWeakening);
    assert!(gate.submit(missing).is_err());
    let mut duplicate = submission('a');
    duplicate.challenges[2].kind = ChallengeKind::MissingWiring;
    assert!(gate.submit(duplicate).is_err());
}

#[test]
fn actionable_findings_continue_only_while_allowance_remains() {
    let mut gate = CompletionGate::new(CompletionPolicy::default(), contract(), sha('0')).unwrap();
    let mut actionable = submission('a');
    actionable.challenges[0].verdict = ChallengeVerdict::Finding;
    assert_eq!(
        gate.submit(actionable).unwrap().status,
        CompletionStatus::Continue
    );
    let mut exhausted = submission('b');
    exhausted.challenges[0].verdict = ChallengeVerdict::Finding;
    exhausted.allowance_remaining = false;
    assert_eq!(
        gate.submit(exhausted).unwrap().status,
        CompletionStatus::Blocked
    );
}

#[test]
fn unavailable_evidence_is_never_success() {
    let mut gate = CompletionGate::new(CompletionPolicy::default(), contract(), sha('0')).unwrap();
    let mut unavailable = submission('a');
    unavailable.requirements[0].verdict = RequirementVerdict::Unverified;
    unavailable.requirements[0].evidence_sha256s.clear();
    assert_eq!(
        gate.submit(unavailable).unwrap().status,
        CompletionStatus::Unverified
    );
    let receipt = gate
        .record_unavailable(
            marker("candidate", 'b', 'b'),
            &acceptance_contract_sha256(&contract()).unwrap(),
            CompletionStatus::Blocked,
            false,
            "shared request allowance is exhausted".into(),
        )
        .unwrap();
    assert_eq!(receipt.status, CompletionStatus::Blocked);
    assert!(receipt.verifier.is_none());
}

#[test]
fn a_later_failed_attempt_invalidates_an_earlier_completion() {
    let mut gate = CompletionGate::new(CompletionPolicy::default(), contract(), sha('0')).unwrap();
    gate.submit(submission('a')).unwrap();
    let mut failed = submission('a');
    failed.challenges[0].verdict = ChallengeVerdict::Finding;
    assert_eq!(
        gate.submit(failed).unwrap().status,
        CompletionStatus::Continue
    );
    let snapshot = gate.snapshot();
    assert_eq!(snapshot.receipts.len(), 2);
    assert_eq!(snapshot.receipts[0].status, CompletionStatus::Completed);
    assert_eq!(snapshot.receipts[1].status, CompletionStatus::Continue);
    assert_eq!(snapshot.approved_candidate_sha256, None);
}

#[test]
fn persisted_contract_and_receipts_reject_tampering() {
    let mut gate = CompletionGate::new(CompletionPolicy::default(), contract(), sha('0')).unwrap();
    gate.submit(submission('a')).unwrap();
    let snapshot = gate.snapshot();
    assert_eq!(
        CompletionGate::restore(snapshot.clone())
            .unwrap()
            .snapshot(),
        snapshot
    );
    let mut weakened = snapshot.clone();
    weakened.contract.acceptance_criteria.pop();
    assert!(CompletionGate::restore(weakened).is_err());
    let mut changed_receipt = snapshot;
    changed_receipt.receipts[0].requirements.pop();
    assert!(CompletionGate::restore(changed_receipt).is_err());

    let mut unsafe_path = gate.snapshot();
    unsafe_path.receipts[0].challenges[0].paths[0] = "../outside".into();
    assert!(CompletionGate::restore(unsafe_path).is_err());

    let mut oversized_verifier = gate.snapshot();
    oversized_verifier.receipts[0].verifier = Some("x".repeat(129));
    assert!(CompletionGate::restore(oversized_verifier).is_err());
}

#[test]
fn pre_implementation_contract_is_forced_to_stay_short() {
    let mut too_many = contract();
    too_many.acceptance_criteria = (0..13)
        .map(|index| format!("requirement {index}"))
        .collect();
    assert!(CompletionGate::new(CompletionPolicy::default(), too_many, sha('0')).is_err());
    let mut too_long = contract();
    too_long.acceptance_criteria[0] = "x".repeat(513);
    assert!(CompletionGate::new(CompletionPolicy::default(), too_long, sha('0')).is_err());
}

fn solo_gate() -> CompletionGate {
    CompletionGate::new_for(
        CompletionPolicy::default(),
        contract(),
        sha('0'),
        CompletionMode::SelfVerified,
    )
    .unwrap()
}

fn solo_submission(candidate: char) -> CompletionSubmission {
    let mut submission = submission(candidate);
    submission.verifier = "sol".into();
    submission.separate_verifier = false;
    submission.final_review.reviewer = "sol".into();
    submission.final_review.separate_reviewer = false;
    submission
}

#[test]
fn self_verified_completion_never_claims_independent_verification() {
    let mut gate = solo_gate();
    assert_eq!(gate.snapshot().assurance, AssuranceLabel::SelfReviewed);
    let receipt = gate.submit(solo_submission('a')).unwrap();
    assert_eq!(receipt.status, CompletionStatus::Completed);
    assert_eq!(receipt.assurance, AssuranceLabel::SelfReviewed);
    assert!(!receipt.independent_review);
    assert!(!receipt.separate_verifier);
    assert!(!receipt.assurance.claims_independent_verification());
    assert_eq!(receipt.assurance.label(), "self-reviewed");
    assert_eq!(gate.snapshot().approved_candidate_sha256, Some(sha('a')));
}

#[test]
fn a_solo_contract_rejects_a_borrowed_independent_review() {
    let mut gate = solo_gate();
    assert!(gate.submit(submission('a')).is_err());
    let mut borrowed = solo_submission('a');
    borrowed.separate_verifier = true;
    assert!(gate.submit(borrowed).is_err());
    let mut borrowed_review = solo_submission('a');
    borrowed_review.final_review.separate_reviewer = true;
    assert!(gate.submit(borrowed_review).is_err());
}

#[test]
fn a_reviewed_contract_still_requires_independent_verification() {
    let mut gate = CompletionGate::new(CompletionPolicy::default(), contract(), sha('0')).unwrap();
    assert!(gate.submit(solo_submission('a')).is_err());
    assert_eq!(
        gate.snapshot().assurance,
        AssuranceLabel::IndependentlyVerified
    );
}

#[test]
fn a_self_reviewed_receipt_cannot_be_relabelled_on_disk() {
    let mut gate = solo_gate();
    gate.submit(solo_submission('a')).unwrap();
    let mut snapshot = gate.snapshot();
    snapshot.assurance = AssuranceLabel::IndependentlyVerified;
    assert!(
        CompletionGate::restore(snapshot.clone())
            .map(|_| ())
            .unwrap_err()
            .to_string()
            .contains("invalid or contract-weakened")
    );
    let mut promoted = gate.snapshot();
    promoted.receipts[0].assurance = AssuranceLabel::IndependentlyVerified;
    promoted.receipts[0].independent_review = true;
    assert!(CompletionGate::restore(promoted).is_err());
}

#[test]
fn an_unavailable_self_verified_receipt_stays_unverified() {
    let mut gate = solo_gate();
    let receipt = gate
        .record_unavailable(
            marker("candidate", 'a', 'a'),
            &acceptance_contract_sha256(&contract()).unwrap(),
            CompletionStatus::Unverified,
            true,
            "host evidence is unavailable for this candidate".into(),
        )
        .unwrap();
    assert_eq!(receipt.assurance, AssuranceLabel::SelfReviewed);
    assert!(!receipt.independent_review);
    assert_eq!(gate.snapshot().approved_candidate_sha256, None);
}
