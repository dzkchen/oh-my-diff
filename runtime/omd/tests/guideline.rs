use codex_omd::EvidenceReference;
use codex_omd::EvidenceSplit;
use codex_omd::GuidelineProposal;
use codex_omd::GuidelineRule;
use codex_omd::GuidelineSelection;
use codex_omd::GuidelineStore;
use codex_omd::GuidelineVariant;
use codex_omd::MaintainerAction;
use codex_omd::PromotionRequest;
use codex_omd::RollbackRequest;
use codex_omd::ValidationOutcome;
use codex_omd::ValidationRecord;

fn rule(id: &str, text: &str) -> GuidelineRule {
    GuidelineRule {
        id: id.into(),
        text: text.into(),
    }
}

fn evidence(task_id: &str, split: EvidenceSplit, hash: char) -> EvidenceReference {
    EvidenceReference {
        task_id: task_id.into(),
        artifact: format!("evidence/{task_id}.json"),
        sha256: hash.to_string().repeat(64),
        split,
    }
}

fn full(version: &str, task_id: &str) -> GuidelineProposal {
    GuidelineProposal {
        schema: 1,
        version: version.into(),
        replaces: None,
        rationale: "Candidate derived from bounded development traces".into(),
        variant: GuidelineVariant::FullChecklist {
            checklist: vec![
                rule("requirements", "Preserve every explicit requirement."),
                rule("existing", "Prefer existing code before adding machinery."),
                rule("native", "Prefer suitable native or standard capabilities."),
                rule("smallest", "Make the smallest clear correct change."),
            ],
        },
        development_evidence: vec![evidence(task_id, EvidenceSplit::Development, 'a')],
    }
}

fn tiny(version: &str, task_id: &str) -> GuidelineProposal {
    GuidelineProposal {
        schema: 1,
        version: version.into(),
        replaces: None,
        rationale: "A tiny shared core with task-selected rules".into(),
        variant: GuidelineVariant::TinyCore {
            core: vec![
                rule("requirements", "Preserve every explicit requirement."),
                rule("smallest", "Make the smallest clear correct change."),
            ],
            selected_rules: vec![rule(
                "installed",
                "Use a suitable installed dependency before adding one.",
            )],
        },
        development_evidence: vec![evidence(task_id, EvidenceSplit::Development, 'b')],
    }
}

fn validation(
    id: &str,
    proposal: &GuidelineSelection,
    task_id: &str,
    outcome: ValidationOutcome,
) -> ValidationRecord {
    ValidationRecord {
        schema: 1,
        id: id.into(),
        proposal_version: proposal.version.clone(),
        proposal_sha256: proposal.proposal_sha256.clone(),
        validator: "separate-validator".into(),
        outcome,
        summary: "Correctness checks completed on the declared validation task".into(),
        validation_evidence: vec![evidence(task_id, EvidenceSplit::Validation, 'c')],
    }
}

fn maintainer(reason: &str) -> MaintainerAction {
    MaintainerAction {
        actor: "maintainer@example.test".into(),
        reason: reason.into(),
    }
}

#[test]
fn proposals_support_both_variants_without_selecting_a_default() {
    let root = tempfile::tempdir().unwrap();
    let store = GuidelineStore::create(root.path().join("guidelines")).unwrap();
    let full = store.propose(full("full-v1", "dev-full")).unwrap();
    let tiny = store.propose(tiny("tiny-v1", "dev-tiny")).unwrap();
    assert_ne!(full.proposal_sha256, tiny.proposal_sha256);
    assert_eq!(store.active().unwrap(), None);
    assert!(store.transitions().unwrap().is_empty());
    assert!(
        store
            .load_proposal("full-v1")
            .unwrap()
            .0
            .variant
            .render()
            .contains("complete short")
    );
    assert!(
        store
            .load_proposal("tiny-v1")
            .unwrap()
            .0
            .variant
            .render()
            .contains("selected one-line")
    );
}

#[test]
fn proposal_rules_are_bounded_unique_and_one_line() {
    let root = tempfile::tempdir().unwrap();
    let store = GuidelineStore::create(root.path().join("guidelines")).unwrap();
    let mut multiline = full("full-v1", "dev-full");
    let GuidelineVariant::FullChecklist { checklist } = &mut multiline.variant else {
        unreachable!();
    };
    checklist[0].text = "first\nsecond".into();
    assert!(store.propose(multiline).is_err());

    let mut duplicate = tiny("tiny-v1", "dev-tiny");
    let GuidelineVariant::TinyCore { selected_rules, .. } = &mut duplicate.variant else {
        unreachable!();
    };
    selected_rules[0].id = "requirements".into();
    assert!(store.propose(duplicate).is_err());
}

#[test]
fn validation_is_immutable_hash_bound_and_separate_from_development() {
    let root = tempfile::tempdir().unwrap();
    let store = GuidelineStore::create(root.path().join("guidelines")).unwrap();
    let proposal = store.propose(full("full-v1", "task-a")).unwrap();
    assert!(
        store
            .validate(validation(
                "overlap",
                &proposal,
                "task-a",
                ValidationOutcome::Passed
            ))
            .is_err()
    );
    let accepted = validation("separate", &proposal, "task-b", ValidationOutcome::Passed);
    store.validate(accepted.clone()).unwrap();
    assert!(store.validate(accepted).is_err());
    let mut wrong_hash = validation("wrong-hash", &proposal, "task-c", ValidationOutcome::Passed);
    wrong_hash.proposal_sha256 = "d".repeat(64);
    assert!(store.validate(wrong_hash).is_err());
}

#[test]
fn promotion_requires_a_pass_and_explicit_expected_active_state() {
    let root = tempfile::tempdir().unwrap();
    let store = GuidelineStore::create(root.path().join("guidelines")).unwrap();
    let proposal = store.propose(full("full-v1", "task-a")).unwrap();
    let failed = validation("failed", &proposal, "task-b", ValidationOutcome::Failed);
    let failed_hash = store.validate(failed).unwrap();
    assert!(
        store
            .promote(PromotionRequest {
                expected_active: None,
                proposal: proposal.clone(),
                validation_id: "failed".into(),
                validation_sha256: failed_hash,
                maintainer: maintainer("Promote candidate"),
            })
            .is_err()
    );
    let passed_hash = store
        .validate(validation(
            "passed",
            &proposal,
            "task-c",
            ValidationOutcome::Passed,
        ))
        .unwrap();
    let active = store
        .promote(PromotionRequest {
            expected_active: None,
            proposal: proposal.clone(),
            validation_id: "passed".into(),
            validation_sha256: passed_hash.clone(),
            maintainer: maintainer("Validation supports an explicit trial"),
        })
        .unwrap();
    assert_eq!(active.selection, proposal);
    assert!(
        store
            .promote(PromotionRequest {
                expected_active: None,
                proposal: active.selection.clone(),
                validation_id: "passed".into(),
                validation_sha256: passed_hash,
                maintainer: maintainer("Stale action"),
            })
            .is_err()
    );
    let state_path = store.root().join("state.json");
    let mut state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    state["active"]["variant"]["checklist"][0]["text"] = "Tampered rule.".into();
    std::fs::write(state_path, serde_json::to_vec(&state).unwrap()).unwrap();
    assert!(store.active().is_err());
}

#[test]
fn rollback_restores_the_prior_explicit_selection_then_no_guideline() {
    let root = tempfile::tempdir().unwrap();
    let store = GuidelineStore::create(root.path().join("guidelines")).unwrap();
    let path = store.root().to_path_buf();
    let full = store.propose(full("full-v1", "dev-full")).unwrap();
    let full_validation = store
        .validate(validation(
            "full-pass",
            &full,
            "validation-full",
            ValidationOutcome::Passed,
        ))
        .unwrap();
    store
        .promote(PromotionRequest {
            expected_active: None,
            proposal: full.clone(),
            validation_id: "full-pass".into(),
            validation_sha256: full_validation,
            maintainer: maintainer("Choose measured full candidate"),
        })
        .unwrap();

    let tiny = store.propose(tiny("tiny-v1", "dev-tiny")).unwrap();
    let tiny_validation = store
        .validate(validation(
            "tiny-pass",
            &tiny,
            "validation-tiny",
            ValidationOutcome::Passed,
        ))
        .unwrap();
    store
        .promote(PromotionRequest {
            expected_active: Some(full.clone()),
            proposal: tiny.clone(),
            validation_id: "tiny-pass".into(),
            validation_sha256: tiny_validation,
            maintainer: maintainer("Choose measured tiny candidate"),
        })
        .unwrap();
    assert_eq!(store.active().unwrap().unwrap().selection, tiny);

    let restored = store
        .rollback(RollbackRequest {
            expected_active: tiny.clone(),
            maintainer: maintainer("Restore prior validated version"),
        })
        .unwrap()
        .unwrap();
    assert_eq!(restored.selection, full);
    assert_eq!(
        GuidelineStore::open(path).unwrap().active().unwrap(),
        Some(restored)
    );

    assert_eq!(
        store
            .rollback(RollbackRequest {
                expected_active: full,
                maintainer: maintainer("Return to unchanged default"),
            })
            .unwrap(),
        None
    );
    assert_eq!(store.transitions().unwrap().len(), 4);
}
