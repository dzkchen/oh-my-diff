use codex_omd::DependencyConstraint;
use codex_omd::DuplicationConstraint;
use codex_omd::GraphLimits;
use codex_omd::HealthApproval;
use codex_omd::HealthBaseline;
use codex_omd::HealthConstraints;
use codex_omd::HealthFindingKind;
use codex_omd::HealthFindingOrigin;
use codex_omd::HealthReport;
use codex_omd::RepairDisposition;
use codex_omd::VerificationConstraint;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn repository() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("src/domain")).unwrap();
    fs::create_dir_all(temp.path().join("src/infra")).unwrap();
    fs::create_dir_all(temp.path().join("tests")).unwrap();
    fs::write(
        temp.path().join("src/domain/legacy.rs"),
        "use crate::infra::db;\npub fn legacy() {\n    db();\n    finalize();\n}\n",
    )
    .unwrap();
    fs::write(
        temp.path().join("src/domain/order.rs"),
        "pub fn calculate() {\n    validate();\n    persist();\n}\n",
    )
    .unwrap();
    fs::write(
        temp.path().join("src/infra/db.rs"),
        "pub fn db() {}\npub fn finalize() {}\n",
    )
    .unwrap();
    fs::write(
        temp.path().join("tests/order_test.rs"),
        "#[test]\nfn order_test() {\n    assert_eq!(1 + 1, 2);\n}\n",
    )
    .unwrap();
    temp
}

fn constraints() -> HealthConstraints {
    HealthConstraints {
        schema: 1,
        version: "approved-v1".into(),
        repository_identity: "fixture/repository".into(),
        approval: HealthApproval {
            actor: "fixture-maintainer".into(),
            reason: "exercise the approved repository boundaries".into(),
        },
        dependency_boundaries: vec![DependencyConstraint {
            id: "domain-must-not-import-infra".into(),
            from_prefix: PathBuf::from("src/domain"),
            denied_to_prefix: PathBuf::from("src/infra"),
        }],
        duplication_scopes: vec![DuplicationConstraint {
            id: "domain-logic".into(),
            path_prefixes: vec![PathBuf::from("src/domain")],
            minimum_logical_lines: 3,
        }],
        verification: vec![VerificationConstraint {
            id: "domain-tests".into(),
            test_path_prefix: PathBuf::from("tests"),
            minimum_tests: 1,
            minimum_assertions_per_test: 1,
        }],
        repair_scope: vec![PathBuf::from("src/domain")],
        max_findings: 64,
    }
}

fn baseline(temp: &tempfile::TempDir, constraints: &HealthConstraints) -> HealthBaseline {
    HealthBaseline::build(
        temp.path(),
        constraints,
        "baseline-revision".into(),
        GraphLimits::default(),
    )
    .unwrap()
}

fn read_report(path: &std::path::Path) -> HealthReport {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn unchanged_repository_retains_existing_debt_without_blocking() {
    let temp = repository();
    let constraints = constraints();
    let baseline = baseline(&temp, &constraints);
    assert_eq!(baseline.existing_observations.len(), 1);
    let report = baseline
        .check(temp.path(), &constraints, "current-revision".into())
        .unwrap();
    assert!(report.introduced_findings.is_empty());
    assert_eq!(report.existing_debt.len(), 1);
    assert!(report.uncertain_findings.is_empty());
    assert!(!report.has_introduced_findings());
}

#[test]
fn introduced_boundaries_duplicates_and_weakened_checks_are_separated() {
    let temp = repository();
    let constraints = constraints();
    let baseline = baseline(&temp, &constraints);
    fs::write(
        temp.path().join("src/domain/new.rs"),
        "use crate::infra::db;\nuse crate::infra::missing;\npub fn calculate_copy() {\n    validate();\n    persist();\n}\n",
    )
    .unwrap();
    fs::write(
        temp.path().join("tests/order_test.rs"),
        "#[test]\nfn order_test() {\n    calculate();\n}\n",
    )
    .unwrap();
    let report = baseline
        .check(temp.path(), &constraints, "candidate-revision".into())
        .unwrap();
    assert_eq!(report.existing_debt.len(), 1);
    assert_eq!(report.uncertain_findings.len(), 1);
    assert_eq!(
        report.uncertain_findings[0].origin,
        HealthFindingOrigin::Introduced
    );
    assert!(report.introduced_findings.iter().any(|finding| {
        finding.kind == HealthFindingKind::DependencyBoundary
            && finding.repair == RepairDisposition::AuthorizedScope
    }));
    assert!(report.introduced_findings.iter().any(|finding| {
        finding.kind == HealthFindingKind::DuplicatedDomainLogic
            && finding.repair == RepairDisposition::AuthorizedScope
    }));
    assert!(report.introduced_findings.iter().any(|finding| {
        finding.kind == HealthFindingKind::WeakenedCheck
            && finding.repair == RepairDisposition::RequiresAuthorization
    }));
    assert!(report.has_introduced_findings());
}

#[test]
fn uncertain_only_changes_do_not_fail_the_guard() {
    let temp = repository();
    let constraints = constraints();
    let baseline = baseline(&temp, &constraints);
    fs::write(
        temp.path().join("src/domain/unclear.rs"),
        "use crate::infra::missing;\npub fn unclear() {\n    inspect();\n    return_value();\n}\n",
    )
    .unwrap();
    let report = baseline
        .check(temp.path(), &constraints, "candidate-revision".into())
        .unwrap();
    assert!(report.introduced_findings.is_empty());
    assert_eq!(report.uncertain_findings.len(), 1);
    assert_eq!(
        report.uncertain_findings[0].origin,
        HealthFindingOrigin::Introduced
    );
    assert!(!report.has_introduced_findings());
}

#[test]
fn baseline_and_constraints_are_version_bound_and_tamper_evident() {
    let temp = repository();
    let constraints = constraints();
    let baseline = baseline(&temp, &constraints);
    let root = tempfile::tempdir().unwrap();
    let baseline_path = root.path().join("baseline.json");
    let report_path = root.path().join("report.json");
    baseline.write(&baseline_path).unwrap();
    assert!(baseline.write(&baseline_path).is_err());
    let loaded = HealthBaseline::read(&baseline_path).unwrap();
    let report = loaded
        .check(temp.path(), &constraints, "current-revision".into())
        .unwrap();
    report.write(&report_path).unwrap();
    assert_eq!(read_report(&report_path), report);

    let mut changed = constraints.clone();
    changed.version = "approved-v2".into();
    assert!(
        loaded
            .check(temp.path(), &changed, "current-revision".into())
            .is_err()
    );

    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&baseline_path).unwrap()).unwrap();
    value["source_digest"] = serde_json::Value::String("0".repeat(64));
    fs::write(&baseline_path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(HealthBaseline::read(&baseline_path).is_err());
}

#[test]
fn invalid_or_unapproved_constraint_shapes_fail_closed() {
    let mut missing_approval = constraints();
    missing_approval.approval.actor.clear();
    assert!(missing_approval.validate().is_err());
    let mut weak_duplicate_rule = constraints();
    weak_duplicate_rule.duplication_scopes[0].minimum_logical_lines = 1;
    assert!(weak_duplicate_rule.validate().is_err());
    let mut escaped_repair_scope = constraints();
    escaped_repair_scope.repair_scope = vec![PathBuf::from("../outside")];
    assert!(escaped_repair_scope.validate().is_err());
}

#[test]
fn one_shot_operator_writes_versioned_artifacts_and_blocks_introduced_findings() {
    let temp = repository();
    let constraints = constraints();
    let output = tempfile::tempdir().unwrap();
    let constraints_path = output.path().join("constraints.json");
    let baseline_path = output.path().join("baseline.json");
    let report_path = output.path().join("report.json");
    fs::write(
        &constraints_path,
        serde_json::to_vec_pretty(&constraints).unwrap(),
    )
    .unwrap();
    let baseline_output = Command::new(env!("CARGO_BIN_EXE_omd-health"))
        .args([
            "baseline",
            temp.path().to_str().unwrap(),
            constraints_path.to_str().unwrap(),
            baseline_path.to_str().unwrap(),
            "baseline-revision",
        ])
        .output()
        .unwrap();
    assert!(baseline_output.status.success());
    fs::write(
        temp.path().join("src/domain/new.rs"),
        "use crate::infra::db;\npub fn new_path() {\n    inspect();\n    finish();\n}\n",
    )
    .unwrap();
    let check_output = Command::new(env!("CARGO_BIN_EXE_omd-health"))
        .args([
            "check",
            temp.path().to_str().unwrap(),
            constraints_path.to_str().unwrap(),
            baseline_path.to_str().unwrap(),
            report_path.to_str().unwrap(),
            "candidate-revision",
        ])
        .output()
        .unwrap();
    assert_eq!(check_output.status.code(), Some(2));
    assert!(read_report(&report_path).has_introduced_findings());
}
