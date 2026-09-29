const CURRENT_API: &str = codex_omd::MOD_API_VERSION;
use codex_omd::ModInstallRequest;
use codex_omd::ModPackageGrant;
use codex_omd::ModPackageSource;
use codex_omd::ModPackageTrust;
use codex_omd::ModStore;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use tempfile::TempDir;

fn mod_package(
    root: &Path,
    id: &str,
    version: &str,
    capabilities: &[&str],
    dependencies: serde_json::Value,
) -> PathBuf {
    let path = root.join(id);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(
        path.join("mod.json"),
        serde_json::to_vec_pretty(&json!({
            "schema":1,
            "id":id,
            "version":version,
            "api":CURRENT_API,
            "entrypoint":"main.ts",
            "state_version":1,
            "license":"Apache-2.0",
            "provenance":{"maintainer":"Fixture Author","source":"fixture"},
            "capabilities":capabilities,
            "dependencies":dependencies,
            "settings_schema":{"type":"object","properties":{"mode":{"type":"string","enum":["safe","fast"],"default":"safe"}},"additionalProperties":false}
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(path.join("main.ts"), "export default () => {}\n").unwrap();
    path.canonicalize().unwrap()
}

fn store(temp: &TempDir) -> ModStore {
    ModStore::create(temp.path().join("store"), std::env::current_exe().unwrap()).unwrap()
}

fn store_with_node(temp: &TempDir) -> ModStore {
    ModStore::create(
        temp.path().join("store"),
        PathBuf::from(std::env::var_os("OMD_TEST_NODE").unwrap()),
    )
    .unwrap()
}

fn request(path: &Path, capabilities: &[&str]) -> ModInstallRequest {
    ModInstallRequest {
        source: ModPackageSource::Local {
            path: path.to_path_buf(),
        },
        index: None,
        scope: "user".into(),
        activate: true,
        offline: false,
        trust: ModPackageTrust {
            packages: BTreeMap::from([(
                path.file_name().unwrap().to_str().unwrap().to_owned(),
                ModPackageGrant {
                    capabilities: capabilities.iter().map(|value| value.to_string()).collect(),
                    dependencies: false,
                    lifecycle: Vec::new(),
                },
            )]),
        },
        settings: BTreeMap::from([(
            path.file_name().unwrap().to_str().unwrap().to_owned(),
            BTreeMap::from([("mode".into(), json!("safe"))]),
        )]),
    }
}

#[test]
fn installed_package_keeps_hash_bound_text_assets() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let package = mod_package(&root, "asset_fixture", "1.0.0", &["commands"], json!([]));
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(package.join("mod.json")).unwrap()).unwrap();
    manifest["assets"] = json!(["worker.mjs"]);
    std::fs::write(
        package.join("mod.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(package.join("worker.mjs"), "export default 1\n").unwrap();
    let store = store(&temp);
    let install = request(&package, &["commands"]);
    let plan = store.package_plan(install.clone()).unwrap();
    let lock = store.package_apply(install, &plan.confirmation).unwrap();
    let cache = root
        .join("store/package-cache/asset_fixture")
        .join(&lock.packages["asset_fixture"].integrity);
    assert_eq!(
        std::fs::read_to_string(cache.join("worker.mjs")).unwrap(),
        "export default 1\n"
    );
    std::fs::write(cache.join("worker.mjs"), "changed\n").unwrap();
    assert!(
        ModStore::inspect_package(&cache).unwrap()["sha256"]
            != lock.packages["asset_fixture"].integrity
    );
}

#[test]
fn installed_collection_can_exceed_sixteen_without_activating_packages() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = store(&temp);
    for number in 0..17 {
        let id = format!("catalog_{number:02}");
        let package = mod_package(&root, &id, "1.0.0", &["commands"], json!([]));
        let mut install = request(&package, &["commands"]);
        install.activate = false;
        let plan = store.package_plan(install.clone()).unwrap();
        store.package_apply(install, &plan.confirmation).unwrap();
    }
    let lock = store.package_lock().unwrap();
    assert_eq!(lock.packages.len(), 17);
    assert!(lock.packages.values().all(|package| !package.enabled));
    assert_eq!(store.configuration().unwrap().mods.len(), 17);
}

#[test]
fn selection_status_explains_precedence_and_changed_source() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let user = root.join("user");
    let project = root.join("project");
    std::fs::create_dir(&user).unwrap();
    std::fs::create_dir(&project).unwrap();
    let user_mod = mod_package(&user, "fixture", "1.0.0", &[], json!([]));
    let project_mod = mod_package(&project, "fixture", "1.1.0", &[], json!([]));
    let store = store(&temp);
    for (path, scope) in [(&user_mod, "user"), (&project_mod, "project")] {
        let digest = ModStore::inspect_package(path).unwrap()["sha256"]
            .as_str()
            .unwrap()
            .to_owned();
        store
            .trust(path.clone(), &digest, Vec::new(), scope)
            .unwrap();
        store.enable(path, true).unwrap();
    }
    let status = store.selection_status().unwrap();
    assert_eq!(
        status["selections"][0]["reason"],
        "shadowed_by_project_scope"
    );
    assert_eq!(status["selections"][1]["effective"], true);
    std::fs::write(
        project_mod.join("main.ts"),
        "export default () => { throw Error('broken') }\n",
    )
    .unwrap();
    let status = store.selection_status().unwrap();
    assert_eq!(status["selections"][0]["effective"], true);
    assert!(
        status["selections"][1]["error"]
            .as_str()
            .unwrap()
            .contains("source_changed")
    );
    store.enable(&project_mod, false).unwrap();
    assert_eq!(
        store.selection_status().unwrap()["selections"][1]["reason"],
        "disabled"
    );
}

#[test]
fn selection_status_explains_duplicate_scope_conflict() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let first_root = root.join("first");
    let second_root = root.join("second");
    std::fs::create_dir(&first_root).unwrap();
    std::fs::create_dir(&second_root).unwrap();
    let store = store(&temp);
    for parent in [&first_root, &second_root] {
        let path = mod_package(parent, "fixture", "1.0.0", &[], json!([]));
        let digest = ModStore::inspect_package(&path).unwrap()["sha256"]
            .as_str()
            .unwrap()
            .to_owned();
        store
            .trust(path.clone(), &digest, Vec::new(), "user")
            .unwrap();
        store.enable(&path, true).unwrap();
    }
    let status = store.selection_status().unwrap();
    assert!(
        status["selections"]
            .as_array()
            .unwrap()
            .iter()
            .all(|selection| {
                selection["effective"] == false && selection["reason"] == "duplicate_scope_conflict"
            })
    );
    for parent in [&first_root, &second_root] {
        let project = parent.join("project");
        std::fs::create_dir(&project).unwrap();
        let path = mod_package(&project, "fixture", "1.0.0", &[], json!([]));
        let digest = ModStore::inspect_package(&path).unwrap()["sha256"]
            .as_str()
            .unwrap()
            .to_owned();
        store
            .trust(path.clone(), &digest, Vec::new(), "project")
            .unwrap();
        store.enable(&path, true).unwrap();
    }
    let status = store.selection_status().unwrap();
    assert!(
        status["selections"]
            .as_array()
            .unwrap()
            .iter()
            .all(|selection| {
                selection["effective"] == false
                    && selection["reason"]
                        == if selection["scope"] == "project" {
                            "duplicate_scope_conflict"
                        } else {
                            "shadowed_by_project_scope_conflict"
                        }
            })
    );
}

#[test]
fn local_updates_preview_preserve_edits_settings_and_rollback() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let package = mod_package(&root, "fixture", "1.0.0", &["commands"], json!([]));
    let store = store(&temp);
    let first = request(&package, &["commands"]);
    let mut invalid = first.clone();
    invalid
        .settings
        .get_mut("fixture")
        .unwrap()
        .insert("mode".into(), json!("unsafe"));
    assert!(
        store
            .package_plan(invalid)
            .unwrap_err()
            .to_string()
            .contains("invalid_setting: mode")
    );
    let plan = store.package_plan(first.clone()).unwrap();
    assert_eq!(plan.action, "install");
    assert_eq!(plan.changes["packages"][0]["activation"]["to"], true);
    let lock = store.package_apply(first, &plan.confirmation).unwrap();
    assert_eq!(lock.packages["fixture"].version, "1.0.0");
    assert!(store.configuration().unwrap().mods[0].enabled);
    let status = store.selection_status().unwrap();
    assert_eq!(status["selections"][0]["effective"], true);
    assert_eq!(status["selections"][0]["managed"], true);
    assert_eq!(status["selections"][0]["settings_keys"], json!(["mode"]));
    store.package_disable("fixture").unwrap();
    assert_eq!(
        store.selection_status().unwrap()["selections"][0]["reason"],
        "disabled"
    );
    let config_path = root.join("store/mods.json");
    let original_config = std::fs::read(&config_path).unwrap();
    let mut untrusted: serde_json::Value = serde_json::from_slice(&original_config).unwrap();
    untrusted["mods"][0]["sha256"] = json!("untrusted");
    std::fs::write(&config_path, serde_json::to_vec_pretty(&untrusted).unwrap()).unwrap();
    assert!(
        store
            .package_enable("fixture")
            .unwrap_err()
            .to_string()
            .contains("source_changed")
    );
    std::fs::write(&config_path, original_config).unwrap();
    store.package_enable("fixture").unwrap();
    assert_eq!(
        store.selection_status().unwrap()["selections"][0]["effective"],
        true
    );
    std::fs::write(
        root.join("store/state-fixture.json"),
        serde_json::to_vec_pretty(&json!({"schema":1,"version":1,"value":null})).unwrap(),
    )
    .unwrap();

    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(package.join("mod.json")).unwrap()).unwrap();
    manifest["version"] = json!("1.1.0");
    manifest["state_version"] = json!(2);
    manifest["capabilities"] = json!(["commands", "store"]);
    std::fs::write(
        package.join("mod.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(
        package.join("main.ts"),
        "export default api => api.command('value', () => api.state.get())\n",
    )
    .unwrap();
    assert!(
        store.selection_status().unwrap()["selections"][0]["error"]
            .as_str()
            .unwrap()
            .contains("source_changed")
    );
    store.package_disable("fixture").unwrap();
    assert!(
        store
            .package_enable("fixture")
            .unwrap_err()
            .to_string()
            .contains("source_changed")
    );
    let mut update = request(&package, &["commands", "store"]);
    update.settings.clear();
    let plan = store.package_plan(update.clone()).unwrap();
    assert_eq!(plan.action, "update");
    assert_eq!(
        plan.changes["packages"][0]["capabilities"]["from"],
        json!(["commands"])
    );
    assert_eq!(plan.changes["packages"][0]["activation"]["to"], false);
    assert_eq!(
        plan.changes["packages"][0]["state_version"]["migration_required"],
        true
    );
    let lock = store.package_apply(update, &plan.confirmation).unwrap();
    assert_eq!(lock.packages["fixture"].settings["mode"], "safe");
    assert!(
        store
            .package_enable("fixture")
            .unwrap_err()
            .to_string()
            .contains("state_migration_required")
    );
    assert_eq!(lock.history["fixture"].len(), 1);
    assert_eq!(
        std::fs::read_to_string(package.join("main.ts")).unwrap(),
        "export default api => api.command('value', () => api.state.get())\n"
    );

    let rollback = store.package_rollback_plan("fixture").unwrap();
    assert_eq!(rollback.changes["version"]["to"], "1.0.0");
    let lock = store
        .package_rollback("fixture", &rollback.confirmation)
        .unwrap();
    assert_eq!(lock.packages["fixture"].version, "1.0.0");
    assert!(!lock.packages["fixture"].enabled);
    assert_ne!(lock.packages["fixture"].path, package);
    assert_eq!(lock.packages["fixture"].settings["mode"], "safe");

    store.package_disable("fixture").unwrap();
    let uninstall = store.package_uninstall_plan("fixture").unwrap();
    let lock = store
        .package_uninstall("fixture", &uninstall.confirmation)
        .unwrap();
    assert!(!lock.packages.contains_key("fixture"));
    assert!(package.exists());
}

#[test]
fn dependency_resolution_requires_separate_exact_trust_and_rejects_cycles() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let dependency = mod_package(&root, "dependency", "1.2.0", &["context"], json!([]));
    let root_package = mod_package(
        &root,
        "root_mod",
        "1.0.0",
        &["commands"],
        json!([{"id":"dependency","version":"^1.0.0"}]),
    );
    let dependency_integrity = ModStore::inspect_package(&dependency).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    let index = root.join("index.json");
    std::fs::write(
        &index,
        serde_json::to_vec_pretty(&json!({"schema":1,"packages":{"dependency":[{
            "version":"1.2.0","source":{"kind":"local","path":dependency},"integrity":dependency_integrity
        }]}}))
        .unwrap(),
    )
    .unwrap();
    let store = store(&temp);
    let mut install = request(&root_package, &["commands"]);
    install
        .trust
        .packages
        .get_mut("root_mod")
        .unwrap()
        .dependencies = true;
    install.trust.packages.insert(
        "dependency".into(),
        ModPackageGrant {
            capabilities: vec!["context".into()],
            dependencies: false,
            lifecycle: Vec::new(),
        },
    );
    assert!(
        store
            .package_plan(install.clone())
            .unwrap_err()
            .to_string()
            .contains("dependency_index_required")
    );
    install.index = Some(index.clone());
    install.trust.packages.remove("dependency");
    assert!(
        store
            .package_plan(install.clone())
            .unwrap_err()
            .to_string()
            .contains("package_trust_required: dependency")
    );
    install.trust.packages.insert(
        "dependency".into(),
        ModPackageGrant {
            capabilities: vec!["context".into()],
            dependencies: false,
            lifecycle: Vec::new(),
        },
    );
    let plan = store.package_plan(install.clone()).unwrap();
    assert_eq!(
        plan.packages
            .iter()
            .map(|package| package.id.as_str())
            .collect::<Vec<_>>(),
        ["dependency", "root_mod"]
    );
    assert_eq!(
        plan.changes["authority"],
        "dependency resolution installs no capability, lifecycle, permission, credential, provider, or spending grant"
    );

    std::fs::write(
        &index,
        serde_json::to_vec_pretty(&json!({"schema":1,"packages":{"dependency":[{
            "version":"1.2.0","source":{"kind":"local","path":dependency},"integrity":"00"
        }]}}))
        .unwrap(),
    )
    .unwrap();
    assert!(
        store
            .package_plan(install.clone())
            .unwrap_err()
            .to_string()
            .contains("package_integrity_failure")
    );

    let mut dependency_manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dependency.join("mod.json")).unwrap()).unwrap();
    dependency_manifest["dependencies"] = json!([{"id":"root_mod","version":"1.0.0"}]);
    std::fs::write(
        dependency.join("mod.json"),
        serde_json::to_vec_pretty(&dependency_manifest).unwrap(),
    )
    .unwrap();
    let dependency_integrity = ModStore::inspect_package(&dependency).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    std::fs::write(
        &index,
        serde_json::to_vec_pretty(&json!({"schema":1,"packages":{
            "dependency":[{"version":"1.2.0","source":{"kind":"local","path":dependency},"integrity":dependency_integrity}],
            "root_mod":[{"version":"1.0.0","source":{"kind":"local","path":root_package},"integrity":ModStore::inspect_package(&root_package).unwrap()["sha256"]}]
        }}))
        .unwrap(),
    )
    .unwrap();
    install
        .trust
        .packages
        .get_mut("dependency")
        .unwrap()
        .dependencies = true;
    assert!(
        store
            .package_plan(install)
            .unwrap_err()
            .to_string()
            .contains("dependency_cycle")
    );
}

#[test]
fn repository_revision_is_immutable_and_cached_for_offline_reuse() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let repository = root.join("repository");
    std::fs::create_dir(&repository).unwrap();
    mod_package(&repository, "repo_mod", "2.0.0", &[], json!([]));
    let manifest_path = repository.join("repo_mod/mod.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    manifest["provenance"] = json!({"maintainer":"Fixture Author","source":repository.canonicalize().unwrap().display().to_string()});
    std::fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    git(&repository, &["init"]);
    git(
        &repository,
        &["config", "user.email", "fixture@example.com"],
    );
    git(&repository, &["config", "user.name", "Fixture"]);
    git(&repository, &["add", "."]);
    git(&repository, &["commit", "-m", "fixture"]);
    let revision = git_output(&repository, &["rev-parse", "HEAD"]);

    let store = store(&temp);
    let source = ModPackageSource::Repository {
        repository: repository.canonicalize().unwrap().display().to_string(),
        revision: revision.clone(),
        subdirectory: "repo_mod".into(),
    };
    let install = ModInstallRequest {
        source: source.clone(),
        index: None,
        scope: "user".into(),
        activate: false,
        offline: false,
        trust: ModPackageTrust {
            packages: BTreeMap::from([("repo_mod".into(), ModPackageGrant::default())]),
        },
        settings: BTreeMap::new(),
    };
    let plan = store.package_plan(install.clone()).unwrap();
    let lock = store.package_apply(install, &plan.confirmation).unwrap();
    assert_eq!(lock.packages["repo_mod"].source, source);
    assert_eq!(lock.packages["repo_mod"].version, "2.0.0");
    let unavailable = root.join("repository-unavailable");
    std::fs::rename(&repository, &unavailable).unwrap();
    let offline = ModInstallRequest {
        source: ModPackageSource::Repository {
            repository: repository.display().to_string(),
            revision,
            subdirectory: "repo_mod".into(),
        },
        index: None,
        scope: "user".into(),
        activate: false,
        offline: true,
        trust: ModPackageTrust {
            packages: BTreeMap::from([("repo_mod".into(), ModPackageGrant::default())]),
        },
        settings: BTreeMap::new(),
    };
    let plan = store.package_plan(offline).unwrap();
    assert_eq!(
        plan.packages[0].integrity,
        lock.packages["repo_mod"].integrity
    );

    let invalid = ModInstallRequest {
        source: ModPackageSource::Repository {
            repository: unavailable.display().to_string(),
            revision: "main".into(),
            subdirectory: "repo_mod".into(),
        },
        offline: false,
        ..request(&mod_package(&root, "unused", "1.0.0", &[], json!([])), &[])
    };
    assert!(
        store
            .package_plan(invalid)
            .unwrap_err()
            .to_string()
            .contains("immutable_repository_revision_required")
    );
}

#[test]
fn lifecycle_scripts_are_exactly_trusted_and_host_sandboxed() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let package = mod_package(&root, "scripted", "1.0.0", &[], json!([]));
    let manifest_path = package.join("mod.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    manifest["lifecycle"] = json!({"install":"install.ts","update":"update.ts"});
    std::fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(
        package.join("install.ts"),
        "export default api => { if (api.settings.event !== 'install') throw new Error('wrong event') }\n",
    )
    .unwrap();
    std::fs::write(
        package.join("update.ts"),
        "export default api => { if (api.settings.event !== 'update') throw new Error('wrong event') }\n",
    )
    .unwrap();
    let store = store_with_node(&temp);
    let mut install = request(&package, &[]);
    assert!(
        store
            .package_plan(install.clone())
            .unwrap_err()
            .to_string()
            .contains("explicit_exact_lifecycle_trust_required")
    );
    install
        .trust
        .packages
        .get_mut("scripted")
        .unwrap()
        .lifecycle = vec!["install".into(), "update".into()];
    let plan = store.package_plan(install.clone()).unwrap();
    store.package_apply(install, &plan.confirmation).unwrap();

    std::fs::write(
        package.join("update.ts"),
        "export default () => process.exit(0)\n",
    )
    .unwrap();
    let mut update = request(&package, &[]);
    update.trust.packages.get_mut("scripted").unwrap().lifecycle =
        vec!["install".into(), "update".into()];
    let plan = store.package_plan(update.clone()).unwrap();
    let error = store
        .package_apply(update, &plan.confirmation)
        .unwrap_err()
        .to_string();
    assert!(error.contains("process is not defined"), "{error}");
    assert_eq!(store.package_lock().unwrap().revision, 1);
}

#[test]
fn stale_plans_and_interrupted_transactions_preserve_the_previous_lock() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let package = mod_package(&root, "fixture", "1.0.0", &[], json!([]));
    let store = store(&temp);
    let install = request(&package, &[]);
    let stale = store.package_plan(install.clone()).unwrap();
    std::fs::write(
        package.join("main.ts"),
        "export default () => { const changed = true; return changed }\n",
    )
    .unwrap();
    assert!(
        store
            .package_apply(install.clone(), &stale.confirmation)
            .unwrap_err()
            .to_string()
            .contains("package_plan_changed")
    );
    assert!(store.package_lock().unwrap().packages.is_empty());
    let plan = store.package_plan(install.clone()).unwrap();
    let lock = store.package_apply(install, &plan.confirmation).unwrap();
    let config = store.configuration().unwrap();
    let store_path = root.join("store");
    std::fs::write(
        store_path.join("package-transaction.json"),
        serde_json::to_vec_pretty(&json!({"old_lock":lock,"old_config":config})).unwrap(),
    )
    .unwrap();
    std::fs::write(
        store_path.join("packages.lock.json"),
        serde_json::to_vec_pretty(&json!({"schema":1,"revision":999,"packages":{},"history":{}}))
            .unwrap(),
    )
    .unwrap();
    std::fs::write(
        store_path.join("mods.json"),
        serde_json::to_vec_pretty(
            &json!({"schema":1,"revision":999,"node":std::env::current_exe().unwrap(),"mods":[]}),
        )
        .unwrap(),
    )
    .unwrap();
    let recovered = store.package_lock().unwrap();
    assert_eq!(recovered.revision, 1);
    assert!(recovered.packages.contains_key("fixture"));
    assert_eq!(store.configuration().unwrap().revision, 1);
    assert!(!store_path.join("package-transaction.json").exists());
}

fn git(repository: &Path, arguments: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .status()
        .unwrap();
    assert!(status.success());
}

fn git_output(repository: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}
