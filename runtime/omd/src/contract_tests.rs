use super::*;

fn source(scope: SelectionSource, seed: &str) -> ConfigurationSource {
    ConfigurationSource {
        scope,
        path: Some(format!("/host/{seed}.json")),
        sha256: digest(seed.as_bytes()),
    }
}

fn offer(source_scope: SelectionSource, contract: WorkflowContract) -> ContractOffer {
    ContractOffer {
        source: source_scope,
        scope: SelectionScope::Task,
        configuration: source(source_scope, contract.id.as_str()),
        contract,
        owner: PolicyOwner::bundled(),
    }
}

fn binding() -> TaskBinding {
    TaskBinding {
        acceptance_contract_sha256: digest(b"acceptance"),
        initial_candidate_sha256: digest(b"candidate"),
        repository_identity: "synthetic-fixture".into(),
    }
}

fn bundled_offers(alternative: Option<WorkflowContract>) -> Vec<ContractOffer> {
    let mut offers = vec![offer(
        SelectionSource::Bundle,
        WorkflowContract::bundled_default(),
    )];
    if let Some(contract) = alternative {
        offers.push(offer(SelectionSource::TaskSelection, contract));
    }
    offers
}

#[test]
fn bundled_contracts_carry_truthful_assurance_labels() {
    let reviewed = WorkflowContract::reviewed_omd_v1();
    let solo = WorkflowContract::solo_evidence_v1();
    reviewed.validate().unwrap();
    solo.validate().unwrap();
    assert_eq!(reviewed.assurance(), AssuranceLabel::IndependentlyVerified);
    assert_eq!(solo.assurance(), AssuranceLabel::SelfReviewed);
    assert!(reviewed.assurance().claims_independent_verification());
    assert!(!solo.assurance().claims_independent_verification());
    assert!(!solo.assurance().independent());
    assert!(solo.assurance() < reviewed.assurance());
    assert_ne!(reviewed.digest().unwrap(), solo.digest().unwrap());
}

#[test]
fn solo_contract_denies_every_second_party_call() {
    let mut active = ActiveContract::activate(
        resolve_selection(
            bundled_offers(Some(WorkflowContract::solo_evidence_v1())),
            None,
        )
        .unwrap(),
        Some(&confirmation_token(
            &WorkflowContract::bundled_default().summary().unwrap(),
            &WorkflowContract::solo_evidence_v1().summary().unwrap(),
        )),
        binding(),
        None,
    )
    .unwrap();
    for operation in [
        ContractOperation::Delegate,
        ContractOperation::SpawnChildAgent,
        ContractOperation::OppositeLeadAdvice,
        ContractOperation::Escalate,
        ContractOperation::MilestoneReview,
    ] {
        let error = active.authorize(operation).unwrap_err();
        assert!(error.contains("denied by the selected solo_evidence v1 contract"));
    }
    active.authorize(ContractOperation::Checkpoint).unwrap();
    active.authorize(ContractOperation::FinalReview).unwrap();
    active.authorize(ContractOperation::Completion).unwrap();
    assert_eq!(active.denied().len(), 5);
    assert!(
        active
            .denied()
            .iter()
            .all(|denial| denial.contract_sha256 == active.provenance().contract_sha256)
    );
}

#[test]
fn legacy_capabilities_migrate_without_changing_behaviour() {
    let default = LegacyCapabilities {
        delegation: true,
        escalation: true,
        checkpoints: true,
        unified_review: true,
        completion_gate: true,
    };
    let migrated = WorkflowContract::from_legacy(default).unwrap();
    assert_eq!(migrated, WorkflowContract::reviewed_omd_v1());
    assert_eq!(migrated.legacy_capabilities(), default);

    let direct = LegacyCapabilities {
        delegation: false,
        escalation: true,
        checkpoints: false,
        unified_review: false,
        completion_gate: false,
    };
    let migrated = WorkflowContract::from_legacy(direct).unwrap();
    assert_eq!(migrated.legacy_capabilities(), direct);
    assert_eq!(migrated.id, LEGACY_CONTRACT_ID);
    assert_eq!(migrated.assurance(), AssuranceLabel::Unreviewed);
    assert!(migrated.requirements.opposite_lead);
    assert!(!migrated.is_bundled() && migrated.host_owned());
    assert_ne!(migrated, WorkflowContract::solo_evidence_v1());
}

#[test]
fn inconsistent_requirements_never_validate() {
    let mut requirements = WorkflowContract::solo_evidence_v1().requirements;
    requirements.completion = CompletionMode::AdversarialSeparate;
    assert!(
        requirements
            .validate()
            .unwrap_err()
            .to_string()
            .contains("separate final reviewer")
    );

    let mut requirements = WorkflowContract::reviewed_omd_v1().requirements;
    requirements.milestone_review = false;
    assert!(requirements.validate().is_err());

    let mut requirements = WorkflowContract::solo_evidence_v1().requirements;
    requirements.checkpoints = false;
    assert!(requirements.validate().is_err());

    let mut requirements = WorkflowContract::solo_evidence_v1().requirements;
    requirements.escalation = true;
    assert!(requirements.validate().is_err());
}

#[test]
fn a_mod_may_not_redefine_a_bundled_contract() {
    let mut forged = WorkflowContract::solo_evidence_v1();
    forged.requirements.final_review = FinalReview::None;
    forged.requirements.completion = CompletionMode::None;
    assert!(
        forged
            .validate()
            .unwrap_err()
            .to_string()
            .contains("redefines a bundled contract")
    );
}

#[test]
fn explicit_user_selection_outranks_a_project_recommendation() {
    let mut offers = bundled_offers(None);
    offers.push(offer(
        SelectionSource::ProjectRecommendation,
        WorkflowContract::solo_evidence_v1(),
    ));
    offers.push(offer(
        SelectionSource::UserDefault,
        WorkflowContract::reviewed_omd_v1(),
    ));
    let resolution = resolve_selection(offers, None).unwrap();
    assert_eq!(resolution.effective.source, SelectionSource::UserDefault);
    assert!(!resolution.requires_confirmation);
    assert!(resolution.considered.iter().any(|entry| entry.source
        == SelectionSource::ProjectRecommendation
        && entry.reason.contains("overridden by explicit user default")));
}

#[test]
fn a_project_assurance_floor_fails_closed_against_a_weaker_choice() {
    let mut offers = bundled_offers(Some(WorkflowContract::solo_evidence_v1()));
    offers.push(offer(
        SelectionSource::ProjectRecommendation,
        WorkflowContract::reviewed_omd_v1(),
    ));
    let floor = AssuranceFloor {
        source: SelectionSource::ProjectRecommendation,
        minimum: AssuranceLabel::IndependentlyVerified,
        configuration: source(SelectionSource::ProjectRecommendation, "floor"),
    };
    let error = resolve_selection(offers, Some(floor))
        .unwrap_err()
        .to_string();
    assert!(error.contains("workflow conflict"));
    assert!(error.contains("solo_evidence v1"));
    assert!(error.contains("independently-verified"));
}

#[test]
fn a_weaker_selection_requires_an_exact_confirmation() {
    let resolution = resolve_selection(
        bundled_offers(Some(WorkflowContract::solo_evidence_v1())),
        None,
    )
    .unwrap();
    assert!(resolution.weakens_default);
    assert!(resolution.requires_confirmation);
    let token = resolution.confirmation_token.clone().unwrap();

    assert!(
        ActiveContract::activate(resolution.clone(), None, binding(), None)
            .unwrap_err()
            .to_string()
            .contains("explicit confirmation is required")
    );
    assert!(ActiveContract::activate(resolution.clone(), Some("forged"), binding(), None).is_err());
    let active = ActiveContract::activate(resolution, Some(&token), binding(), None).unwrap();
    assert_eq!(active.assurance(), AssuranceLabel::SelfReviewed);
    assert!(active.provenance().weakens_default);
    assert!(active.provenance().confirmation.is_some());
}

#[test]
fn selecting_the_default_needs_no_confirmation_and_records_provenance() {
    let resolution = resolve_selection(bundled_offers(None), None).unwrap();
    assert!(!resolution.requires_confirmation);
    let active = ActiveContract::activate(resolution, None, binding(), None).unwrap();
    let provenance = active.provenance();
    assert_eq!(provenance.source, SelectionSource::Bundle);
    assert_eq!(provenance.assurance, AssuranceLabel::IndependentlyVerified);
    assert_eq!(
        provenance.contract_sha256,
        provenance.bundled_default_sha256
    );
    assert_eq!(
        provenance.configuration_sha256,
        configuration_digest(&provenance.configuration_sources).unwrap()
    );
    assert_eq!(provenance.owners, vec![PolicyOwner::bundled()]);
}

#[test]
fn persisted_state_is_task_bound_and_tamper_evident() {
    let resolution = resolve_selection(bundled_offers(None), None).unwrap();
    let active = ActiveContract::activate(resolution, None, binding(), None).unwrap();
    let snapshot = active.snapshot();
    ActiveContract::restore(snapshot.clone(), &binding()).unwrap();

    let mut other = binding();
    other.initial_candidate_sha256 = digest(b"intervening change");
    assert!(
        ActiveContract::restore(snapshot.clone(), &other)
            .unwrap_err()
            .to_string()
            .contains("different task or workspace")
    );

    let mut relabelled = snapshot.clone();
    relabelled.provenance.assurance = AssuranceLabel::IndependentlyVerified;
    relabelled.provenance.contract = WorkflowContract::solo_evidence_v1();
    assert!(ActiveContract::restore(relabelled, &binding()).is_err());

    let mut downgraded = snapshot.clone();
    downgraded.provenance.contract = WorkflowContract::solo_evidence_v1();
    downgraded.provenance.contract_sha256 = WorkflowContract::solo_evidence_v1().digest().unwrap();
    downgraded.provenance.assurance = AssuranceLabel::SelfReviewed;
    downgraded.provenance.assurance_description = AssuranceLabel::SelfReviewed.description().into();
    downgraded.provenance.weakens_default = true;
    assert!(
        ActiveContract::restore(downgraded, &binding())
            .unwrap_err()
            .to_string()
            .contains("requires an explicit native confirmation receipt")
    );

    let mut resealed = snapshot.clone();
    resealed.provenance.selected_at += 3600;
    assert!(
        ActiveContract::restore(resealed, &binding())
            .unwrap_err()
            .to_string()
            .contains("modified outside the host")
    );
}

#[test]
fn mid_task_downgrade_requires_a_safe_boundary_and_full_revalidation() {
    let resolution = resolve_selection(bundled_offers(None), None).unwrap();
    let mut active = ActiveContract::activate(resolution, None, binding(), None).unwrap();
    let solo = WorkflowContract::solo_evidence_v1();
    let token = confirmation_token(
        &WorkflowContract::bundled_default().summary().unwrap(),
        &solo.summary().unwrap(),
    );
    let full = [
        "candidate",
        "evidence",
        "checks",
        "workers",
        "allowance",
        "resume",
    ]
    .map(str::to_string)
    .to_vec();

    assert!(
        active
            .migrate(solo.clone(), &token, "mid_turn", full.clone())
            .unwrap_err()
            .to_string()
            .contains("safe boundary")
    );
    assert!(
        active
            .migrate(
                solo.clone(),
                &token,
                "turn_boundary",
                vec!["candidate".into(), "evidence".into()]
            )
            .unwrap_err()
            .to_string()
            .contains("revalidate")
    );
    assert!(
        active
            .migrate(solo.clone(), "forged", "turn_boundary", full.clone())
            .unwrap_err()
            .to_string()
            .contains("explicit native confirmation")
    );
    assert_eq!(active.assurance(), AssuranceLabel::IndependentlyVerified);

    let receipt = active
        .migrate(solo.clone(), &token, "turn_boundary", full)
        .unwrap();
    assert!(receipt.confirmation.weakens);
    assert_eq!(receipt.to.assurance, AssuranceLabel::SelfReviewed);
    assert_eq!(active.assurance(), AssuranceLabel::SelfReviewed);
    assert!(!active.permits(ContractOperation::Delegate));
    ActiveContract::restore(active.snapshot(), &binding()).unwrap();
}

#[test]
fn migration_may_not_break_the_project_assurance_floor() {
    let mut offers = bundled_offers(None);
    offers.push(offer(
        SelectionSource::ProjectRecommendation,
        WorkflowContract::reviewed_omd_v1(),
    ));
    let floor = AssuranceFloor {
        source: SelectionSource::ProjectRecommendation,
        minimum: AssuranceLabel::IndependentlyReviewed,
        configuration: source(SelectionSource::ProjectRecommendation, "floor"),
    };
    let resolution = resolve_selection(offers, Some(floor)).unwrap();
    let mut active = ActiveContract::activate(resolution, None, binding(), None).unwrap();
    let solo = WorkflowContract::solo_evidence_v1();
    let token = confirmation_token(
        &WorkflowContract::reviewed_omd_v1().summary().unwrap(),
        &solo.summary().unwrap(),
    );
    let full = [
        "candidate",
        "evidence",
        "checks",
        "workers",
        "allowance",
        "resume",
    ]
    .map(str::to_string)
    .to_vec();
    assert!(
        active
            .migrate(solo, &token, "turn_boundary", full)
            .unwrap_err()
            .to_string()
            .contains("assurance floor")
    );
    assert_eq!(active.assurance(), AssuranceLabel::IndependentlyVerified);
}

#[test]
fn conflicting_offers_from_one_source_fail_before_activation() {
    let mut offers = bundled_offers(Some(WorkflowContract::solo_evidence_v1()));
    offers.push(offer(
        SelectionSource::TaskSelection,
        WorkflowContract::reviewed_omd_v1(),
    ));
    assert!(
        resolve_selection(offers, None)
            .unwrap_err()
            .to_string()
            .contains("conflicting workflow offers")
    );
}

#[test]
fn a_replaced_bundled_default_is_rejected() {
    let mut forged = WorkflowContract::bundled_default();
    forged.requirements.delegation = false;
    forged.requirements.child_agents = false;
    let offers = vec![offer(SelectionSource::Bundle, forged)];
    assert!(resolve_selection(offers, None).is_err());
}

fn mod_owner() -> PolicyOwner {
    PolicyOwner {
        kind: OwnerKind::Mod,
        id: "house_rules".into(),
        version: "0.3.1".into(),
        source: "/user/mods/house-rules".into(),
        sha256: digest(b"house-rules"),
    }
}

#[test]
fn a_mod_may_restrict_authority_but_never_widen_it() {
    let resolution = resolve_selection(bundled_offers(None), None).unwrap();
    let mut active = ActiveContract::activate(resolution, None, binding(), None).unwrap();
    assert!(active.permits(ContractOperation::Delegate));

    for forbidden in [
        ContractOperation::MilestoneReview,
        ContractOperation::FinalReview,
        ContractOperation::Completion,
        ContractOperation::Checkpoint,
    ] {
        assert!(
            active
                .restrict(vec![forbidden], mod_owner(), "house rule".into())
                .unwrap_err()
                .to_string()
                .contains("only remove delegation")
        );
    }

    active
        .restrict(
            vec![
                ContractOperation::Delegate,
                ContractOperation::SpawnChildAgent,
            ],
            mod_owner(),
            "this repository forbids delegated contributions".into(),
        )
        .unwrap();
    assert!(!active.permits(ContractOperation::Delegate));
    let error = active.authorize(ContractOperation::Delegate).unwrap_err();
    assert!(error.contains("restricted by house_rules"));
    assert!(error.contains("forbids delegated contributions"));

    assert_eq!(active.assurance(), AssuranceLabel::IndependentlyVerified);
    assert!(active.permits(ContractOperation::Completion));
    ActiveContract::restore(active.snapshot(), &binding()).unwrap();
}

#[test]
fn restrictions_survive_migration_and_cannot_be_forged_on_disk() {
    let resolution = resolve_selection(bundled_offers(None), None).unwrap();
    let mut active = ActiveContract::activate(resolution, None, binding(), None).unwrap();
    active
        .restrict(
            vec![ContractOperation::Escalate],
            mod_owner(),
            "escalation is disabled for this repository".into(),
        )
        .unwrap();
    let solo = WorkflowContract::solo_evidence_v1();
    let token = confirmation_token(
        &WorkflowContract::bundled_default().summary().unwrap(),
        &solo.summary().unwrap(),
    );
    active
        .migrate(
            solo,
            &token,
            "turn_boundary",
            [
                "candidate",
                "evidence",
                "checks",
                "workers",
                "allowance",
                "resume",
            ]
            .map(str::to_string)
            .to_vec(),
        )
        .unwrap();
    assert_eq!(active.restrictions().len(), 1);
    assert!(!active.permits(ContractOperation::Escalate));

    let mut forged = active.snapshot();
    forged.restrictions[0].operation = ContractOperation::Completion;
    assert!(ActiveContract::restore(forged, &binding()).is_err());
}
