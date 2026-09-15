use super::*;

#[test]
fn every_turn_review_stays_off_in_the_default_manifest_policy() {
    let policy = ReviewPolicy::default();
    assert!(!policy.every_turn_advice);
    assert!(policy.max_cycles > 0);
    assert!(policy.max_repairs > 0);
}

#[test]
fn review_schema_keeps_typed_findings_and_optional_report_independent() {
    let plain = review_schema(ReviewReportMode::Plain);
    let structured = review_schema(ReviewReportMode::Structured);
    let plain_required = plain["required"].as_array().unwrap();
    let structured_required = structured["required"].as_array().unwrap();
    assert!(!plain_required.iter().any(|field| field == "report"));
    assert!(structured_required.iter().any(|field| field == "report"));
    assert_eq!(plain["properties"]["findings"]["items"]["type"], "object");
    assert_eq!(
        plain["properties"]["findings"]["items"]["properties"]["severity"]["enum"],
        json!(["advice", "warning", "blocking"])
    );
    assert!(plain["properties"].get("approved").is_none());
}
