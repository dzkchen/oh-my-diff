use super::*;
use crate::ActiveContract;
use crate::ContractRequirements;
use crate::TaskBinding;
use crate::confirmation_token;
use crate::resolve_selection;

fn binding() -> TaskBinding {
    TaskBinding {
        acceptance_contract_sha256: digest(b"acceptance"),
        initial_candidate_sha256: digest(b"candidate"),
        repository_identity: "synthetic-fixture".into(),
    }
}

fn write(path: &Path, value: serde_json::Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
}

fn mod_owner() -> PolicyOwner {
    PolicyOwner {
        kind: OwnerKind::Mod,
        id: "strict_pairs".into(),
        version: "1.2.0".into(),
        source: "/user/mods/strict-pairs".into(),
        sha256: digest(b"strict-pairs"),
    }
}

fn stricter_contract() -> WorkflowContract {
    WorkflowContract {
        schema: crate::CONTRACT_SCHEMA,
        id: "strict_pairs".into(),
        version: 1,
        requirements: ContractRequirements {
            delegation: false,
            child_agents: false,
            opposite_lead: true,
            escalation: true,
            checkpoints: true,
            milestone_review: true,
            final_review: crate::FinalReview::Separate,
            completion: crate::CompletionMode::AdversarialSeparate,
        },
    }
}

#[test]
fn the_bundled_catalog_offers_both_decided_contracts() {
    let catalog = ContractCatalog::bundled();
    let reviewed = catalog
        .get(&ContractChoice::parse("reviewed_omd@1").unwrap())
        .unwrap();
    let solo = catalog
        .get(&ContractChoice::parse("solo_evidence@1").unwrap())
        .unwrap();
    assert_eq!(reviewed.0, WorkflowContract::reviewed_omd_v1());
    assert_eq!(solo.0, WorkflowContract::solo_evidence_v1());
    assert_eq!(reviewed.1, PolicyOwner::bundled());
    assert!(
        catalog
            .get(&ContractChoice::parse("no_review@1").unwrap())
            .unwrap_err()
            .to_string()
            .contains("prior contract is retained")
    );
    let listed = catalog.list().unwrap();
    assert_eq!(listed["contracts"].as_array().unwrap().len(), 2);
}

#[test]
fn a_mod_contract_registers_exclusively_and_never_shadows_a_host_contract() {
    let mut catalog = ContractCatalog::bundled();
    assert!(
        catalog
            .register(WorkflowContract::solo_evidence_v1(), mod_owner())
            .unwrap_err()
            .to_string()
            .contains("shadow a host-owned contract")
    );
    assert!(
        catalog
            .register(stricter_contract(), PolicyOwner::bundled())
            .unwrap_err()
            .to_string()
            .contains("mod policy owner")
    );
    catalog.register(stricter_contract(), mod_owner()).unwrap();
    let mut other = mod_owner();
    other.id = "other_pairs".into();
    other.sha256 = digest(b"other");
    assert!(
        catalog
            .register(stricter_contract(), other)
            .unwrap_err()
            .to_string()
            .contains("replacement conflict")
    );
    assert!(catalog.register(stricter_contract(), mod_owner()).is_err());
    assert_eq!(
        catalog
            .get(&ContractChoice::parse("strict_pairs@1").unwrap())
            .unwrap()
            .1,
        mod_owner()
    );
}

#[test]
fn a_registered_contract_is_selectable_only_through_the_native_surface() {
    let temporary = tempfile::TempDir::new().unwrap();
    let user = temporary.path().join(USER_SELECTION_FILE);
    let mut catalog = ContractCatalog::bundled();
    catalog.register(stricter_contract(), mod_owner()).unwrap();
    write(
        &user,
        serde_json::json!({"schema": 1, "contract": {"id": "strict_pairs", "version": 1}}),
    );
    let selections = collect(&catalog, None, Some(&user), None, None).unwrap();
    let resolution = resolve_selection(selections.offers, selections.floor).unwrap();
    assert_eq!(resolution.effective.owner, mod_owner());
    assert!(!resolution.requires_confirmation);
    let active = ActiveContract::activate(resolution, None, binding(), None).unwrap();
    assert_eq!(active.contract().id, "strict_pairs");
    assert_eq!(active.provenance().owners, vec![mod_owner()]);
    assert_eq!(active.provenance().source, SelectionSource::UserDefault);
}

#[test]
fn a_legacy_manifest_keeps_its_exact_capabilities_as_the_default() {
    let catalog = ContractCatalog::bundled();
    let default = WorkflowContract::reviewed_omd_v1().legacy_capabilities();
    let selections = collect(&catalog, Some(default), None, None, None).unwrap();
    assert_eq!(selections.offers.len(), 1);
    let resolution = resolve_selection(selections.offers, None).unwrap();
    assert_eq!(resolution.effective.source, SelectionSource::Bundle);
    assert!(!resolution.weakens_default);

    let direct = LegacyCapabilities {
        delegation: false,
        escalation: true,
        checkpoints: false,
        unified_review: false,
        completion_gate: false,
    };
    let selections = collect(&catalog, Some(direct), None, None, None).unwrap();
    let resolution = resolve_selection(selections.offers, selections.floor).unwrap();
    assert_eq!(resolution.effective.source, SelectionSource::LegacyManifest);
    assert!(resolution.weakens_default);
    assert!(!resolution.requires_confirmation);
    let active = ActiveContract::activate(resolution, None, binding(), None).unwrap();
    assert_eq!(active.contract().legacy_capabilities(), direct);
    assert_eq!(active.assurance(), AssuranceLabel::Unreviewed);
}

#[test]
fn an_explicit_task_selection_outranks_the_legacy_manifest() {
    let catalog = ContractCatalog::bundled();
    let direct = LegacyCapabilities {
        delegation: false,
        escalation: true,
        checkpoints: false,
        unified_review: false,
        completion_gate: false,
    };
    let choice = ContractChoice::parse("reviewed_omd@1").unwrap();
    let selections = collect(&catalog, Some(direct), None, None, Some(&choice)).unwrap();
    let resolution = resolve_selection(selections.offers, selections.floor).unwrap();
    assert_eq!(resolution.effective.source, SelectionSource::TaskSelection);
    assert!(!resolution.weakens_default);
}

#[test]
fn a_project_floor_and_a_user_downgrade_fail_closed_together() {
    let temporary = tempfile::TempDir::new().unwrap();
    let user = temporary.path().join(USER_SELECTION_FILE);
    let project = temporary.path().join(PROJECT_SELECTION_FILE);
    write(
        &project,
        serde_json::json!({"schema": 1, "minimum_assurance": "independently_verified"}),
    );
    write(
        &user,
        serde_json::json!({"schema": 1, "contract": {"id": "solo_evidence", "version": 1}}),
    );
    let catalog = ContractCatalog::bundled();
    let selections = collect(&catalog, None, Some(&user), Some(&project), None).unwrap();
    assert_eq!(
        selections.floor.as_ref().unwrap().minimum,
        AssuranceLabel::IndependentlyVerified
    );
    let error = resolve_selection(selections.offers, selections.floor)
        .unwrap_err()
        .to_string();
    assert!(error.contains("workflow conflict"));
    assert!(error.contains("explicit user default"));
}

#[test]
fn a_user_downgrade_activates_only_with_the_recorded_confirmation() {
    let temporary = tempfile::TempDir::new().unwrap();
    let user = temporary.path().join(USER_SELECTION_FILE);
    let catalog = ContractCatalog::bundled();
    write(
        &user,
        serde_json::json!({"schema": 1, "contract": {"id": "solo_evidence", "version": 1}}),
    );
    let selections = collect(&catalog, None, Some(&user), None, None).unwrap();
    let resolution = resolve_selection(selections.offers, selections.floor).unwrap();
    assert!(resolution.requires_confirmation);
    assert!(
        ActiveContract::activate(
            resolution.clone(),
            selections.confirmation.as_deref(),
            binding(),
            None
        )
        .unwrap_err()
        .to_string()
        .contains("explicit confirmation is required")
    );

    let token = confirmation_token(
        &WorkflowContract::bundled_default().summary().unwrap(),
        &WorkflowContract::solo_evidence_v1().summary().unwrap(),
    );
    write(
        &user,
        serde_json::json!({"schema": 1, "contract": {"id": "solo_evidence", "version": 1}, "confirmation": token}),
    );
    let selections = collect(&catalog, None, Some(&user), None, None).unwrap();
    let resolution = resolve_selection(selections.offers, selections.floor).unwrap();
    let active = ActiveContract::activate(
        resolution,
        selections.confirmation.as_deref(),
        binding(),
        None,
    )
    .unwrap();
    assert_eq!(active.assurance(), AssuranceLabel::SelfReviewed);
    assert_eq!(
        active.provenance().configuration_sources.len(),
        active.provenance().considered.len()
    );
}

#[test]
fn tampered_and_unsupported_selection_files_fail_closed() {
    let temporary = tempfile::TempDir::new().unwrap();
    let user = temporary.path().join(USER_SELECTION_FILE);
    let catalog = ContractCatalog::bundled();

    write(
        &user,
        serde_json::json!({"schema": 2, "contract": {"id": "solo_evidence", "version": 1}}),
    );
    assert!(collect(&catalog, None, Some(&user), None, None).is_err());

    write(&user, serde_json::json!({"schema": 1}));
    assert!(collect(&catalog, None, Some(&user), None, None).is_err());

    write(
        &user,
        serde_json::json!({"schema": 1, "minimum_assurance": "self_reviewed"}),
    );
    assert!(
        collect(&catalog, None, Some(&user), None, None)
            .unwrap_err()
            .to_string()
            .contains("only a project may declare")
    );

    write(
        &user,
        serde_json::json!({"schema": 1, "contract": {"id": "solo_evidence", "version": 1}, "confirmation": "short"}),
    );
    assert!(
        collect(&catalog, None, Some(&user), None, None)
            .unwrap_err()
            .to_string()
            .contains("malformed")
    );

    write(
        &user,
        serde_json::json!({"schema": 1, "contract": {"id": "solo_evidence", "version": 4}}),
    );
    assert!(
        collect(&catalog, None, Some(&user), None, None)
            .unwrap_err()
            .to_string()
            .contains("prior contract is retained")
    );
}

#[test]
fn a_written_selection_round_trips_with_its_exact_digest() {
    let temporary = tempfile::TempDir::new().unwrap();
    let user = temporary.path().join(USER_SELECTION_FILE);
    let selection = SelectionFile {
        schema: 1,
        contract: Some(ContractChoice::parse("reviewed_omd@1").unwrap()),
        minimum_assurance: None,
        confirmation: None,
    };
    write_selection(&user, &selection, SelectionSource::UserDefault).unwrap();
    let (read_back, sha256) = read_selection(&user, SelectionSource::UserDefault).unwrap();
    assert_eq!(read_back, selection);
    assert_eq!(sha256, digest(&std::fs::read(&user).unwrap()));

    let floor = SelectionFile {
        schema: 1,
        contract: None,
        minimum_assurance: Some(AssuranceLabel::IndependentlyVerified),
        confirmation: None,
    };
    assert!(write_selection(&user, &floor, SelectionSource::UserDefault).is_err());
    write_selection(&user, &floor, SelectionSource::ProjectRecommendation).unwrap();
}
