use codex_omd::WorkerReport;
use codex_omd::WorkerReportStatus;

fn report(status: WorkerReportStatus) -> WorkerReport {
    WorkerReport {
        schema: 1,
        status,
        summary: "Implemented the requested parser change.".into(),
        scope: vec!["parser.rs only".into()],
        uncertainty: vec!["The platform-specific path was not exercised.".into()],
        evidence: vec!["cargo test -p parser".into()],
        required_clarification: vec![],
    }
}

#[test]
fn structured_report_round_trips_all_required_information() {
    let expected = report(WorkerReportStatus::Partial);
    let encoded = serde_json::to_string(&expected).unwrap();
    assert_eq!(WorkerReport::parse(&encoded).unwrap(), expected);
}

#[test]
fn blocked_report_requires_explicit_clarification() {
    let blocked = report(WorkerReportStatus::Blocked);
    assert!(blocked.validate().is_err());
    let valid = WorkerReport {
        required_clarification: vec!["Which compatibility target should be retained?".into()],
        ..blocked
    };
    assert!(valid.validate().is_ok());
}

#[test]
fn completed_report_cannot_hide_required_clarification() {
    let invalid = WorkerReport {
        required_clarification: vec!["Should I change the public API?".into()],
        ..report(WorkerReportStatus::Completed)
    };
    assert!(invalid.validate().is_err());
}

#[test]
fn report_rejects_missing_or_unknown_fields() {
    let missing = r#"{"schema":1,"status":"partial","summary":"Work remains.","scope":["parser.rs"],"uncertainty":[],"evidence":[]}"#;
    let unknown = r#"{"schema":1,"status":"completed","summary":"Done.","scope":["parser.rs"],"uncertainty":[],"evidence":[],"required_clarification":[],"extra":true}"#;
    assert!(WorkerReport::parse(missing).is_err());
    assert!(WorkerReport::parse(unknown).is_err());
}
