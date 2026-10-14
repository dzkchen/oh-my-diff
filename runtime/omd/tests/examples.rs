use codex_omd::{ModHost, ModStore};
use std::path::Path;

const HOST_FEATURES: &[&str] = &[
    "app_v1",
    "approval_v1",
    "unrestricted_process_v1",
    "delegated_approval_v1",
    "tool_batch_v1",
    "tool_continuation_v2",
    "events_v1",
    "store_thread_v1",
    "turn_activity_v1",
    "binary_evidence_v1",
    "package_controls_v1",
    "terminal_surface_v1",
    "credentials_v1",
    "completion_v1",
    "tool_feedback_v1",
    "terminal_media_v1",
    "secrets_v1",
    "terminal_prompt_v1",
    "model_complete_v2",
    "history_v1",
    "terminal_pty_v1",
    "dynamic_tools_v1",
    "timers_v1",
    "terminal_input_v1",
    "terminal_style_v1",
    "completion_arguments_v1",
    "terminal_editor_v1",
    "pty_programs_v1",
    "terminal_tabs_v1",
    "terminal_inline_sites_v1",
    "session_ports_v1",
    "command_config_middleware_v1",
    "admission_api_policy_v1",
    "state_scopes_v1",
    "composer_key_v1",
    "completion_tokens_v1",
    "mention_read_v1",
];

#[test]
fn missing_node_is_a_failure() {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "host_feature_examples_load_and_register_together",
            "--nocapture",
        ])
        .env_remove("OMD_TEST_NODE")
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "missing Node must fail the required suite"
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("OMD_TEST_NODE"));
}

#[test]
fn host_feature_examples_load_and_register_together() {
    let node = std::env::var_os("OMD_TEST_NODE")
        .expect("OMD_TEST_NODE required; sandbox tests must actually execute");
    let examples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mods/examples");
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node.into()).unwrap();
    let mut covered = std::collections::BTreeSet::new();
    for entry in std::fs::read_dir(&examples).unwrap() {
        let path = entry.unwrap().path();
        let Ok(manifest) = std::fs::read_to_string(path.join("mod.json")) else {
            continue;
        };
        let manifest: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        let required = manifest["compatibility"]["required_features"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|feature| feature.as_str())
            .filter(|feature| HOST_FEATURES.contains(feature))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if required.is_empty() {
            continue;
        }
        covered.extend(required);
        let copy = root.join(path.file_name().unwrap());
        std::fs::create_dir(&copy).unwrap();
        for file in ["mod.json", "index.ts"] {
            std::fs::copy(path.join(file), copy.join(file)).unwrap();
        }
        let copy = copy.canonicalize().unwrap();
        let inspected = ModStore::inspect_package(&copy).unwrap();
        let capabilities = inspected["manifest"]["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|capability| capability.as_str().unwrap().to_owned())
            .collect();
        store
            .trust(
                copy.clone(),
                inspected["sha256"].as_str().unwrap(),
                capabilities,
                "user",
            )
            .unwrap();
        store.enable(&copy, true).unwrap();
    }
    assert_eq!(covered.len(), HOST_FEATURES.len(), "{covered:?}");
    let status = ModHost::open(root.join("store").canonicalize().unwrap())
        .unwrap()
        .status();
    for item in status["mods"].as_array().unwrap() {
        assert!(item["error"].is_null(), "{item}");
        let registered = [
            "events",
            "commands",
            "tools",
            "replacements",
            "interceptors",
            "completions",
        ]
        .iter()
        .any(|kind| {
            item["registrations"][kind]
                .as_array()
                .is_some_and(|values| !values.is_empty())
        });
        assert!(registered, "{item}");
    }
    assert!(
        status["rejected"].as_array().is_none_or(Vec::is_empty),
        "{}",
        status["rejected"]
    );
}
