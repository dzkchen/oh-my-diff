use super::*;
use crate::credentials::CredentialProfiles;

fn check(_: &Path, host: &Value) -> Result<(), String> {
    match host["routes"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|route| route["name"] == "invalid")
    {
        true => Err("route invalid is invalid".into()),
        false => Ok(()),
    }
}

fn route(name: &str, provider: &str, subscription: bool) -> Value {
    json!({"name": name, "roles": ["lead"], "provider": provider, "model": name, "reasoning_effort": "medium",
        "responses_url": "http://127.0.0.1:9/v1/responses", "data": {"upstream": "gpt-6.1"},
        "rates": {"input_microusd_per_million": 1, "cached_microusd_per_million": 1, "output_microusd_per_million": 1,
            "reservation_microusd": if subscription { 0 } else { 5 }, "max_output_tokens": 10, "input_token_ceiling": 100,
            "included_subscription": subscription}})
}

fn store() -> (tempfile::TempDir, std::path::PathBuf, String, String) {
    set_host_check(check);
    let temp = tempfile::tempdir().unwrap();
    let store = temp.path().canonicalize().unwrap();
    let profiles = CredentialProfiles::local(&store).unwrap();
    let work = profiles.create("work", "chatgpt", None, None).unwrap().id;
    let home = profiles.create("home", "chatgpt", None, None).unwrap().id;
    std::fs::write(
        store.join("host.json"),
        json!({"schema": 1, "secret_refs": {"token": "/private/tmp/token"},
            "routes": [route("old", "fixture_router", true), route("theirs", "other", true)],
            "services": [
                {"id": "router", "mod_id": "fixture_router", "program": "/bin/node", "program_sha256": "a",
                    "secrets": {"TOKEN": "token"}, "network": true, "credentials": [work]},
                {"id": "spare", "mod_id": "fixture_router", "program": "/bin/node", "program_sha256": "a"},
                {"id": "foreign", "mod_id": "other", "program": "/bin/node", "program_sha256": "a"}]})
        .to_string(),
    )
    .unwrap();
    (temp, store, work, home)
}

#[test]
fn a_write_replaces_only_the_callers_routes_and_merges_its_services() {
    let (_temp, store, work, home) = store();
    let arguments = json!({"routes": [route("work", "fixture_router", true), route("home", "fixture_router", true)],
        "services": [{"id": "router", "credentials": [work, home]}]});
    let (write, changes) = plan(&store, Path::new("/repo"), "fixture_router", &arguments).unwrap();
    assert!(
        changes.contains(&"Route home responses_url: http://127.0.0.1:9/v1/responses".to_owned())
    );
    assert_eq!(
        changes
            .iter()
            .filter(|line| !line.starts_with("Route "))
            .collect::<Vec<_>>(),
        [
            "Add model route home: home, subscription",
            "Add model route work: work, subscription",
            "Remove model route old",
            "Let service router use home (chatgpt)",
        ]
    );
    assert_eq!(
        apply(&store, Path::new("/repo"), &write).unwrap(),
        json!({"routes": ["work", "home"], "services": ["router", "spare"]})
    );
    let host: Value =
        serde_json::from_slice(&std::fs::read(store.join("host.json")).unwrap()).unwrap();
    let names = host["routes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["name"].clone())
        .collect::<Vec<_>>();
    assert_eq!(names, [json!("theirs"), json!("work"), json!("home")]);
    assert_eq!(host["routes"][1]["data"], json!({"upstream": "gpt-6.1"}));
    let services = host["services"].as_array().unwrap();
    assert_eq!(services.len(), 3);
    assert_eq!(services[0]["program"], "/bin/node");
    assert_eq!(services[0]["secrets"], json!({"TOKEN": "token"}));
    assert_eq!(services[0]["credentials"], json!([work, home]));
}

#[test]
fn a_write_refuses_what_the_caller_does_not_own_or_cannot_pay_for() {
    let (_temp, store, work, _) = store();
    let refused = |arguments: Value| {
        plan(&store, Path::new("/repo"), "fixture_router", &arguments)
            .err()
            .unwrap()
    };
    let mut worker = route("w", "fixture_router", true);
    worker["roles"] = json!(["worker"]);
    for (arguments, code) in [
        (
            json!({"routes": [route("x", "other", true)]}),
            "routes_write_provider_mismatch: x",
        ),
        (json!({"routes": [worker]}), "routes_write_lead_only: w"),
        (
            json!({"routes": [route("paid", "fixture_router", false)]}),
            "routes_write_allowance_required: paid",
        ),
        (
            json!({"routes": [route("invalid", "fixture_router", true)]}),
            "routes_write_invalid: route invalid is invalid",
        ),
        (
            json!({"routes": [], "services": [{"id": "foreign", "credentials": []}]}),
            "routes_write_service_unknown: foreign",
        ),
        (
            json!({"routes": [], "services": [{"id": "new", "credentials": [work]}]}),
            "routes_write_service_unknown: new",
        ),
        (
            json!({"routes": [], "services": [{"id": "router", "secrets": {"TOKEN": "token"}}]}),
            "routes_write_service_field: router",
        ),
        (
            json!({"routes": [], "services": [{"id": "router", "program": "/bin/sh"}]}),
            "routes_write_service_field: router",
        ),
        (
            json!({"routes": [], "services": [{"id": "router", "credentials": [work, "p404"]}]}),
            "routes_write_credential_unknown: router",
        ),
        (
            json!({"routes": [], "extra": true}),
            "routes_write_arguments_invalid",
        ),
    ] {
        assert_eq!(refused(arguments), code);
    }
}

#[test]
fn a_grant_route_change_is_shown_and_a_changed_host_refuses_the_confirmed_write() {
    let (_temp, store, work, _) = store();
    let arguments = json!({"routes": [route("old", "fixture_router", true)],
        "services": [{"id": "spare", "credentials": [work], "route": route("old", "fixture_router", true)}]});
    let (write, changes) = plan(&store, Path::new("/repo"), "fixture_router", &arguments).unwrap();
    assert_eq!(
        changes,
        [
            "Let service spare use work (chatgpt)",
            "Service spare route: old (old)",
        ]
    );
    let mut host: Value =
        serde_json::from_slice(&std::fs::read(store.join("host.json")).unwrap()).unwrap();
    host["routes"]
        .as_array_mut()
        .unwrap()
        .push(route("late", "fixture_router", true));
    std::fs::write(store.join("host.json"), host.to_string()).unwrap();
    assert_eq!(
        apply(&store, Path::new("/repo"), &write).unwrap_err(),
        "routes_write_changed: host.json changed after the confirmation; try again"
    );
}

#[test]
fn a_changed_route_shows_each_field_it_changes() {
    let (_temp, store, _, _) = store();
    let mut moved = route("old", "fixture_router", true);
    moved["responses_url"] = json!("https://elsewhere.example/v1/responses");
    moved["rates"]["input_token_ceiling"] = json!(50);
    let (_, changes) = plan(
        &store,
        Path::new("/repo"),
        "fixture_router",
        &json!({"routes": [moved]}),
    )
    .unwrap();
    assert_eq!(changes.len(), 3);
    assert_eq!(changes[0], "Change model route old: old, subscription");
    assert_eq!(changes[1], "Route old rates: input_token_ceiling=50");
    assert_eq!(
        changes[2],
        "Route old responses_url: https://elsewhere.example/v1/responses"
    );
}
