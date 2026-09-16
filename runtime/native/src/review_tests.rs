use super::*;

struct ModeEnvGuard {
    mode: Option<std::ffi::OsString>,
    manifest: Option<std::ffi::OsString>,
}

impl ModeEnvGuard {
    fn direct() -> Self {
        let guard = Self {
            mode: std::env::var_os(codex_omd::MODE_ENV),
            manifest: std::env::var_os(codex_omd::MANIFEST_ENV),
        };
        unsafe {
            std::env::set_var(codex_omd::MODE_ENV, "upstream_direct");
            std::env::remove_var(codex_omd::MANIFEST_ENV);
        }
        guard
    }
}

impl Drop for ModeEnvGuard {
    fn drop(&mut self) {
        unsafe {
            match &self.mode {
                Some(value) => std::env::set_var(codex_omd::MODE_ENV, value),
                None => std::env::remove_var(codex_omd::MODE_ENV),
            }
            match &self.manifest {
                Some(value) => std::env::set_var(codex_omd::MANIFEST_ENV, value),
                None => std::env::remove_var(codex_omd::MANIFEST_ENV),
            }
        }
    }
}

#[test]
fn upstream_direct_install_registers_no_omd_task_behavior() {
    let _environment = ModeEnvGuard::direct();
    let mut builder = ExtensionRegistryBuilder::<Config>::new();

    install(&mut builder, Weak::new()).unwrap();
    let registry = builder.build();

    assert!(registry.thread_lifecycle_contributors().is_empty());
    assert!(registry.context_contributors().is_empty());
    assert!(registry.tool_contributors().is_empty());
    assert!(registry.tool_lifecycle_contributors().is_empty());
    assert!(registry.tool_reaction_contributors().is_empty());
    assert!(registry.turn_item_contributors().is_empty());
}

#[test]
fn capabilities_are_independent_with_only_required_dependencies() {
    let mut capabilities = Capabilities {
        delegation: false,
        escalation: true,
        checkpoints: false,
        guidelines: true,
        repository_knowledge: false,
        code_graph: true,
        code_health: false,
        semantic_lsp: false,
        reactive_rules: true,
        unified_review: false,
        completion_gate: false,
        terminal: false,
    };
    capabilities.validate().unwrap();
    assert_eq!(
        capabilities.enabled_names(&CommunicationPolicy::default()),
        vec!["escalation", "guidelines", "code_graph", "reactive_rules"]
    );

    capabilities.completion_gate = true;
    assert!(capabilities.validate().unwrap_err().contains("requires"));
    capabilities.completion_gate = false;
    capabilities.delegation = true;
    assert!(capabilities.validate().unwrap_err().contains("requires"));
}

#[test]
fn legacy_manifests_keep_the_pre_integration_capability_set() {
    let capabilities = Capabilities::default();
    assert!(capabilities.delegation);
    assert!(capabilities.checkpoints);
    assert!(capabilities.unified_review);
    assert!(capabilities.completion_gate);
    assert!(capabilities.terminal);
}

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
