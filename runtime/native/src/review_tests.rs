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

#[test]
fn completion_schema_requires_exact_requirements_and_all_challenge_kinds() {
    let plain = completion_schema(ReviewReportMode::Plain);
    let structured = completion_schema(ReviewReportMode::Structured);
    assert_eq!(
        plain["properties"]["challenges"]["items"]["properties"]["kind"]["enum"],
        json!(["missing_wiring", "test_weakening", "negative_cases"])
    );
    assert_eq!(plain["properties"]["challenges"]["minItems"], 3);
    assert_eq!(plain["properties"]["challenges"]["maxItems"], 3);
    assert_eq!(
        plain["properties"]["requirements"]["items"]["properties"]["verdict"]["enum"],
        json!(["satisfied", "unsatisfied", "blocked", "unverified"])
    );
    assert!(
        plain["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|field| field == "contract_sha256")
    );
    assert!(
        !plain["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|field| field == "report")
    );
    assert!(
        structured["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|field| field == "report")
    );
    let prompt = completion_report_prompt();
    for required in [
        "byte-for-byte",
        "evidence SHA256s",
        "missing wiring",
        "test weakening",
        "negative cases",
        "unavailable evidence",
    ] {
        assert!(prompt.contains(required));
    }
}
