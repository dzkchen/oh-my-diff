use super::*;

fn fixture_package(
    root: &std::path::Path,
    id: &str,
    capabilities: &[&str],
    dependencies: Value,
) -> PathBuf {
    let path = root.join(id);
    std::fs::create_dir_all(&path).unwrap();
    let manifest = json!({
        "schema": 1, "id": id, "version": "1.0.0", "api": crate::MOD_API_VERSION, "entrypoint": "main.ts",
        "state_version": 1, "license": "Apache-2.0", "provenance": {"maintainer": "Fixture Author", "source": "fixture"},
        "capabilities": capabilities, "dependencies": dependencies,
    });
    std::fs::write(
        path.join("mod.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(path.join("main.ts"), "export default () => {}\n").unwrap();
    path.canonicalize().unwrap()
}

fn setup() -> (tempfile::TempDir, ModStore, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), std::env::current_exe().unwrap()).unwrap();
    (temp, store, root)
}

#[test]
fn install_enable_disable_and_remove_through_previewed_controls() {
    let (_temp, store, root) = setup();
    let path = fixture_package(&root, "sample_mod", &["commands"], json!([]));
    let install = preview(
        &store,
        json!({"action": "install", "source": {"kind": "local", "path": path}}),
    )
    .unwrap();
    assert_eq!(
        (
            install.public["id"].as_str(),
            install.public["grants_added"].clone()
        ),
        (Some("sample_mod"), json!(["commands"]))
    );
    assert!(install.public.get("confirmation").is_none());
    assert!(
        !install
            .public
            .to_string()
            .contains(install.control.confirmation.as_deref().unwrap())
    );
    assert_eq!(
        apply(&store, &install.control).unwrap()["status"],
        "applied"
    );

    let listed = list(&store, None).unwrap();
    let package = &listed["packages"][0];
    assert_eq!(
        (
            package["id"].as_str(),
            package["enabled"].as_bool(),
            package["compatible"].as_bool()
        ),
        (Some("sample_mod"), Some(false), Some(true))
    );
    let generation = listed["generation"].as_u64().unwrap();
    assert_eq!(list_fields(&store, None, Value::Null).unwrap(), listed);
    let narrow = list_fields(&store, None, json!({"fields": ["id", "enabled"]})).unwrap();
    assert_eq!(
        (narrow["packages"].clone(), narrow["generation"].as_u64()),
        (
            json!([{"id": "sample_mod", "enabled": false}]),
            Some(generation)
        )
    );
    for invalid in [
        json!({}),
        json!({"fields": "id"}),
        json!({"fields": [], "page": 1}),
    ] {
        assert!(list_fields(&store, None, invalid).is_err());
    }

    let enable = preview(
        &store,
        json!({"action": "enable", "id": "sample_mod", "expected_generation": generation}),
    )
    .unwrap();
    apply(&store, &enable.control).unwrap();
    assert_eq!(list(&store, None).unwrap()["packages"][0]["enabled"], true);

    let disable = preview(&store, json!({"action": "disable", "id": "sample_mod"})).unwrap();
    apply(&store, &disable.control).unwrap();
    assert_eq!(list(&store, None).unwrap()["packages"][0]["enabled"], false);

    let remove = preview(&store, json!({"action": "remove", "id": "sample_mod"})).unwrap();
    apply(&store, &remove.control).unwrap();
    assert_eq!(list(&store, None).unwrap()["packages"], json!([]));
}

#[test]
fn stale_previews_and_invalid_requests_are_refused() {
    let (_temp, store, root) = setup();
    let path = fixture_package(&root, "sample_mod", &["commands"], json!([]));
    let install = preview(
        &store,
        json!({"action": "install", "source": {"kind": "local", "path": path}}),
    )
    .unwrap();
    let again = preview(
        &store,
        json!({"action": "install", "source": {"kind": "local", "path": path}}),
    )
    .unwrap();
    apply(&store, &install.control).unwrap();
    assert!(
        apply(&store, &again.control)
            .unwrap_err()
            .to_string()
            .starts_with("package_state_changed")
    );
    assert!(
        preview(
            &store,
            json!({"action": "enable", "id": "sample_mod", "expected_generation": 0})
        )
        .is_err()
    );
    assert!(preview(&store, json!({"action": "enable", "id": "missing"})).is_err());
    assert!(preview(&store, json!({"action": "explode", "id": "sample_mod"})).is_err());
    assert!(preview(&store, json!({"action": "install"})).is_err());
    assert!(
        preview(
            &store,
            json!({"action": "install", "source": {"kind": "repository", "repository": "x"}})
        )
        .is_err()
    );
}

#[test]
fn dependency_trees_preview_every_grant_and_install_as_confirmed() {
    let (_temp, store, root) = setup();
    let library = fixture_package(&root, "library_mod", &["store"], json!([]));
    let integrity = ModStore::inspect_package(&library).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    let index = root.join("index.json");
    std::fs::write(
        &index,
        serde_json::to_vec(&json!({"schema": 1, "packages": {"library_mod": [
            {"version": "1.0.0", "source": {"kind": "local", "path": library}, "integrity": integrity}]}}))
        .unwrap(),
    )
    .unwrap();
    let dependent = fixture_package(
        &root,
        "dependent_mod",
        &["commands"],
        json!([{"id": "library_mod", "version": "^1.0.0"}]),
    );
    let request = json!({"action": "install", "source": {"kind": "local", "path": dependent}, "index": index});
    let preview = preview(&store, request).unwrap();
    assert_eq!(preview.public["id"], "dependent_mod");
    assert_eq!(
        preview.public["grants_added"],
        json!(["commands", "library_mod:store"])
    );
    apply(&store, &preview.control).unwrap();
    let installed = list(&store, None).unwrap();
    assert_eq!(installed["packages"].as_array().unwrap().len(), 2);
    fixture_package(
        &root,
        "dependent_mod",
        &["commands", "network"],
        json!([{"id": "library_mod", "version": "^1.0.0"}]),
    );
    let update =
        super::preview(&store, json!({"action": "update", "id": "dependent_mod"})).unwrap();
    assert_eq!(update.public["grants_added"], json!(["network"]));
    apply(&store, &update.control).unwrap();
}

#[test]
fn trusted_selections_toggle_retrust_and_report_session_state() {
    let (_temp, store, root) = setup();
    let path = fixture_package(&root, "author_mod", &["commands"], json!([]));
    let sha256 = |path: &PathBuf| {
        ModStore::inspect_package(path).unwrap()["sha256"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    store
        .trust(
            path.clone(),
            &sha256(&path),
            vec!["commands".into()],
            "user",
        )
        .unwrap();
    let enable = preview(&store, json!({"action": "enable", "id": "author_mod"})).unwrap();
    assert_eq!(enable.public["grants_added"], json!(["commands"]));
    apply(&store, &enable.control).unwrap();
    let idle = json!({"mods": [], "rejected": [], "reload_error": null});
    let package = list(&store, Some(&idle)).unwrap()["packages"][0].clone();
    assert_eq!(
        (
            &package["source"],
            &package["effective"],
            &package["pending"]
        ),
        (&json!("selection"), &json!(false), &json!("reload"))
    );

    fixture_package(&root, "author_mod", &["commands", "store"], json!([]));
    assert!(
        list(&store, None).unwrap()["packages"][0]["failed"]
            .as_str()
            .unwrap()
            .starts_with("source_changed")
    );
    let trust = preview(&store, json!({"action": "trust", "id": "author_mod"})).unwrap();
    assert_eq!(trust.public["grants_added"], json!(["store"]));
    apply(&store, &trust.control).unwrap();
    let running = json!({"mods": [{"id": "author_mod", "scope": "user", "sha256": sha256(&path),
        "error": null}], "rejected": [], "reload_error": null});
    let package = list(&store, Some(&running)).unwrap()["packages"][0].clone();
    assert_eq!(
        (
            &package["enabled"],
            &package["effective"],
            &package["pending"],
            &package["failed"]
        ),
        (&json!(true), &json!(true), &Value::Null, &Value::Null)
    );

    let copy = root.join("managed_copy");
    std::fs::create_dir(&copy).unwrap();
    for name in ["mod.json", "main.ts"] {
        std::fs::copy(path.join(name), copy.join(name)).unwrap();
    }
    let install = preview(
        &store,
        json!({"action": "install", "source": {"kind": "local", "path": copy.canonicalize().unwrap()}, "scope": "project"}),
    )
    .unwrap();
    apply(&store, &install.control).unwrap();
    let disable = preview(&store, json!({"action": "disable", "id": "author_mod"})).unwrap();
    apply(&store, &disable.control).unwrap();
    let states = list(&store, None).unwrap()["packages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|package| {
            (
                package["scope"].clone(),
                package["source"].clone(),
                package["enabled"].clone(),
            )
        })
        .collect::<Vec<_>>();
    assert!(states.contains(&(json!("user"), json!("selection"), json!(false))));
    let enable = preview(&store, json!({"action": "enable", "id": "author_mod"})).unwrap();
    apply(&store, &enable.control).unwrap();

    let before = list(&store, None).unwrap()["generation"].as_u64().unwrap();
    assert!(reload(&store).unwrap()["generation"].as_u64().unwrap() > before);
    let disable = preview(&store, json!({"action": "disable", "id": "author_mod"})).unwrap();
    apply(&store, &disable.control).unwrap();
    assert_eq!(
        list(&store, Some(&running)).unwrap()["packages"][0]["pending"],
        "reload"
    );
}

#[test]
fn listing_offers_host_routes_and_marks_required_selections() {
    let (_temp, store, root) = setup();
    let path = fixture_package(&root, "routed_mod", &["commands"], json!([]));
    let mut manifest: Value =
        serde_json::from_slice(&std::fs::read(path.join("mod.json")).unwrap()).unwrap();
    let setting = json!({"type": "string", "title": "Route", "description": "Where it runs", "choices": "routes"});
    manifest["settings_schema"] = json!({"type": "object", "properties": {"route": setting}});
    std::fs::write(path.join("mod.json"), manifest.to_string()).unwrap();
    let sha256 = ModStore::inspect_package(&path).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    store
        .trust(path.clone(), &sha256, vec!["commands".into()], "user")
        .unwrap();
    store.set_required(&path, true).unwrap();
    std::fs::write(
        store.root().join("host.json"),
        json!({"routes": [{"name": "open", "roles": ["worker"]}, {"name": "lead", "roles": ["lead"]},
            {"name": "scoped", "roles": ["worker"], "mods": ["routed_mod"]},
            {"name": "other", "roles": ["worker"], "mods": ["another_mod"]}]})
        .to_string(),
    )
    .unwrap();
    let listed = list(&store, None).unwrap();
    let package = &listed["packages"][0];
    assert_eq!(package["required"], true);
    assert_eq!(
        package["settings_schema"]["properties"]["route"],
        json!({"type": "string", "title": "Route", "description": "Where it runs", "choices": "routes",
            "enum": ["open", "scoped"]})
    );

    manifest["settings_schema"]["properties"]["route"] =
        json!({"type": "number", "choices": "routes"});
    std::fs::write(path.join("mod.json"), manifest.to_string()).unwrap();
    assert!(
        ModStore::inspect_package(&path)
            .unwrap_err()
            .to_string()
            .contains("invalid_setting_choices")
    );
}
