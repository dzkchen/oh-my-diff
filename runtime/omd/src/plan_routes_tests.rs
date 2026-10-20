use super::*;

fn plan(model: &str, mod_id: &str) -> PlanRoute {
    PlanRoute {
        model: model.into(),
        reasoning_effort: "high".into(),
        context_window: 272_000,
        mod_id: mod_id.into(),
    }
}

fn host(store: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(store.join("host.json")).unwrap()).unwrap()
}

#[test]
fn each_mod_gets_its_own_plan_route_listing_the_repositories_it_was_approved_in() {
    let temp = tempfile::tempdir().unwrap();
    let store = temp.path().canonicalize().unwrap();
    std::fs::write(
        store.join("host.json"),
        json!({"schema": 1, "routes": [{"name": "kept"}], "limits": {"requests": 3}}).to_string(),
    )
    .unwrap();
    assert_eq!(
        add(
            &store,
            Path::new("/one"),
            &plan("GPT-6.1-Sol", "omd_advisor")
        )
        .unwrap(),
        "plan-gpt-6-1-sol-omd_advisor"
    );
    add(
        &store,
        Path::new("/two"),
        &plan("GPT-6.1-Sol", "omd_advisor"),
    )
    .unwrap();
    add(
        &store,
        Path::new("/two"),
        &plan("GPT-6.1-Sol", "omd_workflow"),
    )
    .unwrap();
    let host = host(&store);
    assert_eq!(host["limits"], json!({"requests": 3}));
    assert_eq!(host["routes"][0]["name"], "kept");
    let route = &host["routes"][1];
    assert_eq!(route["mods"], json!(["omd_advisor"]));
    assert_eq!(host["routes"][2]["mods"], json!(["omd_workflow"]));
    assert_eq!(route["rates"]["max_output_tokens"], 128_000);
    let bytes = std::fs::read(route["grant"]["path"].as_str().unwrap()).unwrap();
    assert_eq!(route["grant"]["sha256"], crate::resource_data::hash(&bytes));
    let grant: Value = serde_json::from_slice(&bytes).unwrap();
    let identity = |path: &str| crate::resource_data::hash(path.as_bytes());
    assert_eq!(
        grant["repositories"],
        json!([identity("/one"), identity("/two")])
    );
}

#[test]
fn a_plan_route_never_replaces_another_route_or_model_of_the_same_name() {
    let temp = tempfile::tempdir().unwrap();
    let store = temp.path().canonicalize().unwrap();
    add(&store, Path::new("/one"), &plan("gpt-6.1", "omd_advisor")).unwrap();
    let error = add(&store, Path::new("/one"), &plan("gpt-6-1", "omd_advisor")).unwrap_err();
    assert_eq!(error.to_string(), "plan_route_name_taken");
    std::fs::write(
        store.join("host.json"),
        json!({"schema": 1, "routes": [{"name": "plan-gpt-7-omd_advisor", "grant": {"path": "/elsewhere"}}]})
            .to_string(),
    )
    .unwrap();
    let error = add(&store, Path::new("/one"), &plan("gpt-7", "omd_advisor")).unwrap_err();
    assert_eq!(error.to_string(), "plan_route_name_taken");
    assert_eq!(host(&store)["routes"][0]["grant"]["path"], "/elsewhere");
}
