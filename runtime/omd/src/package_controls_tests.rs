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

    let listed = list(&store).unwrap();
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

    let enable = preview(
        &store,
        json!({"action": "enable", "id": "sample_mod", "expected_generation": generation}),
    )
    .unwrap();
    apply(&store, &enable.control).unwrap();
    assert_eq!(list(&store).unwrap()["packages"][0]["enabled"], true);

    let disable = preview(&store, json!({"action": "disable", "id": "sample_mod"})).unwrap();
    apply(&store, &disable.control).unwrap();
    assert_eq!(list(&store).unwrap()["packages"][0]["enabled"], false);

    let remove = preview(&store, json!({"action": "remove", "id": "sample_mod"})).unwrap();
    apply(&store, &remove.control).unwrap();
    assert_eq!(list(&store).unwrap()["packages"], json!([]));
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
    let installed = list(&store).unwrap();
    assert_eq!(installed["packages"].as_array().unwrap().len(), 2);
}
