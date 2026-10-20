use codex_omd::MOD_API_VERSION;
use codex_omd::ModHost;
use codex_omd::ModInstallRequest;
use codex_omd::ModPackageGrant;
use codex_omd::ModPackageSource;
use codex_omd::ModPackageTrust;
use codex_omd::ModStore;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use std::collections::BTreeMap;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use tempfile::TempDir;

const PREFIX: &str = "export default api => api.intercept('tool', async (e, next) => { const r = await next({...e, arguments: {...e.arguments, p: true}}); return r.deny ? r : {...r, output: r.output + ' P'}; })";
const GUARD: &str = "export default api => api.intercept('tool', {required: true}, async (e, next) => { if (e.tool === 'boom') throw new Error('guard down'); if (e.tool === 'blocked') return {deny: 'blocked by guard'}; const r = await next(e); return {...r, output: r.output + ' G'}; })";
const TRANSFORM: &str = "export default api => api.intercept('tool', async (e, next) => { const r = await next({...e, arguments: {...e.arguments, a: true}}); return r.deny ? r : {...r, output: r.output + ' A'}; })";
const ANSWER: &str = "export default api => api.intercept('tool', {match: {tool: ['cached', 'refused']}}, e => e.tool === 'refused' ? {deny: 'refused here'} : {output: 'cached', success: true})";
const COMMAND: &str = "export default api => api.command('hello', () => 'hi')";
const UNREACHABLE: &str =
    "git+https://127.0.0.1:9/unreachable.git#0123456789abcdef0123456789abcdef01234567";

struct Admin {
    _temp: TempDir,
    root: PathBuf,
    policy: PathBuf,
    owner: u32,
}


impl Admin {
    fn new() -> Self {
        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let owner = std::fs::metadata(&root).unwrap().uid();
        let policy = root.join("policy.json");
        Self {
            _temp: temp,
            root,
            policy,
            owner,
        }
    }

    fn package(
        &self,
        directory: &str,
        id: &str,
        source: &str,
        capabilities: &[&str],
    ) -> (PathBuf, String) {
        self.versioned(directory, id, "1.0.0", source, capabilities, json!({}))
    }

    fn versioned(
        &self,
        directory: &str,
        id: &str,
        version: &str,
        source: &str,
        capabilities: &[&str],
        extra: Value,
    ) -> (PathBuf, String) {
        let path = self.root.join(directory);
        std::fs::create_dir(&path).unwrap();
        let mut manifest = json!({"schema":1,"id":id,"version":version,"api":MOD_API_VERSION,
            "state_version":1,"capabilities":capabilities,"license":"Apache-2.0",
            "provenance":{"maintainer":"Fixture Admin","source":"fixture"},
            "settings_schema":{"type":"object","properties":{"mode":{"type":"string","default":"open"}}}});
        manifest
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        std::fs::write(
            path.join("mod.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        std::fs::write(path.join("index.ts"), source).unwrap();
        let sha256 = ModStore::inspect_package(&path).unwrap()["sha256"]
            .as_str()
            .unwrap()
            .to_owned();
        (path, sha256)
    }

    fn write_policy(&self, policy: Value) {
        std::fs::write(&self.policy, serde_json::to_vec(&policy).unwrap()).unwrap();
    }

    fn store(&self, user: &str) -> ModStore {
        let root = self.root.join(format!("store-{user}"));
        let mut store = match root.exists() {
            true => ModStore::open(root.canonicalize().unwrap()).unwrap(),
            false => ModStore::create(root).unwrap(),
        };
        store.set_managed_policy(self.policy.clone(), self.owner, user);
        store
    }

    fn administer(&self, policy: Value, user: &str) -> Value {
        self.write_policy(policy);
        self.store(user).package_sync(false).unwrap()
    }

    fn host(&self, user: &str) -> ModHost {
        self.store(user);
        let mut host = ModHost::open(
            self.root
                .join(format!("store-{user}"))
                .canonicalize()
                .unwrap(),
        )
        .unwrap();
        host.set_managed_policy(self.policy.clone(), self.owner, user)
            .unwrap();
        host
    }
}

fn trust(store: &ModStore, path: &Path, sha256: &str, capabilities: &[&str], scope: &str) {
    let capabilities = capabilities.iter().map(|c| c.to_string()).collect();
    store
        .trust(path.to_path_buf(), sha256, capabilities, scope)
        .unwrap();
    store.enable(path, true).unwrap();
}

fn entry(id: &str, source: &Path, sha256: &str, extra: Value) -> Value {
    let mut entry =
        json!({"id": id, "source": source, "sha256": sha256, "capabilities": ["interception"]});
    entry
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    entry
}

fn rejection(host: &ModHost, id: &str) -> String {
    host.status()["rejected"]
        .as_array()
        .unwrap()
        .iter()
        .find(|rejection| rejection["id"] == id)
        .and_then(|rejection| rejection["reason"].as_str())
        .unwrap_or_default()
        .to_owned()
}

fn active(host: &ModHost) -> Vec<String> {
    host.status()["mods"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["error"].is_null())
        .map(|m| {
            format!(
                "{}@{}",
                m["id"].as_str().unwrap(),
                m["version"].as_str().unwrap()
            )
        })
        .collect()
}

fn deployed(store: &ModStore) -> Vec<String> {
    store
        .managed_deployment()
        .unwrap()
        .packages
        .iter()
        .map(|package| format!("{}@{}", package.id, package.version))
        .collect()
}

fn tool(
    runtime: &Mutex<ModHost>,
    name: &str,
    calls: &mut Vec<Value>,
) -> std::io::Result<codex_omd::ModChain> {
    codex_omd::intercept_shared(
        runtime,
        "tool",
        true,
        json!({"tool": name, "arguments": {}}),
        json!({"caller": "model"}),
        || true,
        |_, _| Err(std::io::Error::other("unexpected host call")),
        |input| {
            calls.push(input);
            Ok(json!({"output": "ran", "success": true}))
        },
    )
}

fn cohort(user: &str, id: &str) -> u8 {
    let hash = format!(
        "{:x}",
        sha2::Sha256::digest(format!("{user}\0{id}").as_bytes())
    );
    (u64::from_str_radix(&hash[..8], 16).unwrap() % 100) as u8
}

#[test]
fn managed_tiers_wrap_user_mods_and_required_guards_cannot_be_skipped() {
    let admin = Admin::new();
    let (prefix, prefix_sha) = admin.package("prefix", "prefix", PREFIX, &["interception"]);
    let (guard, guard_sha) = admin.package("guard", "guard", GUARD, &["interception"]);
    let store = admin.store("alice");
    for (id, source) in [("transform", TRANSFORM), ("answer", ANSWER)] {
        let (path, sha256) = admin.package(id, id, source, &["interception"]);
        trust(&store, &path, &sha256, &["interception"], "user");
    }
    admin.administer(
        json!({"schema": 1, "packages": [
            entry("prefix", &prefix, &prefix_sha, json!({"tier": "prepend"})),
            entry("guard", &guard, &guard_sha, json!({"tier": "append"}))]}),
        "alice",
    );
    let runtime = Mutex::new(admin.host("alice"));
    let mut calls = Vec::new();
    let chain = tool(&runtime, "exec", &mut calls).unwrap();
    assert_eq!(
        chain.result,
        json!({"output": "ran G A P", "success": true})
    );
    assert_eq!(
        calls,
        [json!({"tool": "exec", "arguments": {"p": true, "a": true}})]
    );
    calls.clear();
    let cached = tool(&runtime, "cached", &mut calls).unwrap();
    assert_eq!(
        cached.answered_by, None,
        "a user answer cannot skip the managed guard"
    );
    assert_eq!(
        cached.result,
        json!({"output": "ran G A P", "success": true})
    );
    assert_eq!(calls.len(), 1);
    calls.clear();
    let refused = tool(&runtime, "refused", &mut calls).unwrap();
    assert_eq!(
        refused.result["deny"], "refused here",
        "a deny may still end the chain"
    );
    assert!(calls.is_empty());
    let blocked = tool(&runtime, "blocked", &mut calls).unwrap();
    assert_eq!(blocked.result["deny"], "blocked by guard");
    let failed = tool(&runtime, "boom", &mut calls).unwrap_err().to_string();
    assert!(failed.contains("intercept_required_failed"), "{failed}");
    assert!(calls.is_empty());
}

#[test]
fn administrator_controls_override_user_and_project_selections_with_provenance() {
    let admin = Admin::new();
    let store = admin.store("alice");
    let (guard, guard_sha) = admin.package("guard", "guard", GUARD, &["interception"]);
    let (twin, twin_sha) = admin.package("twin", "guard", TRANSFORM, &["interception"]);
    trust(&store, &twin, &twin_sha, &["interception"], "project");
    let (plain, plain_sha) = admin.package("plain", "plain", TRANSFORM, &["interception"]);
    trust(&store, &plain, &plain_sha, &["interception"], "user");
    let (denied, denied_sha) = admin.package("denied", "denied", TRANSFORM, &["interception"]);
    trust(&store, &denied, &denied_sha, &["interception"], "user");
    let (wide, wide_sha) = admin.package("wide", "wide", COMMAND, &["commands"]);
    trust(&store, &wide, &wide_sha, &["commands"], "user");
    let base = json!({"schema": 1, "deny": ["denied"], "capabilities": ["interception"], "packages": [
        entry("guard", &guard, &guard_sha, json!({"settings": {"mode": "strict"}}))]});
    admin.administer(base.clone(), "alice");
    let host = admin.host("alice");
    assert_eq!(active(&host), ["guard@1.0.0", "plain@1.0.0"]);
    assert!(
        rejection(&host, "guard").starts_with("shadowed_by_managed_scope"),
        "{}",
        rejection(&host, "guard")
    );
    assert!(rejection(&host, "denied").starts_with("managed_denied"));
    assert!(rejection(&host, "wide").starts_with("managed_capability_denied"));
    let status = store.selection_status().unwrap();
    let row = |id: &str, scope: &str| {
        status["selections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == id && row["scope"] == scope)
            .unwrap()
            .clone()
    };
    assert_eq!(row("guard", "managed")["effective"], true);
    assert_eq!(
        row("guard", "managed")["settings_origin"],
        json!({"mode": "managed"})
    );
    assert_eq!(
        row("plain", "user")["settings_origin"],
        json!({"mode": "default"})
    );
    assert_eq!(
        row("guard", "project")["reason"],
        "shadowed_by_managed_scope"
    );
    assert!(
        row("denied", "user")["error"]
            .as_str()
            .unwrap()
            .starts_with("managed_denied")
    );
    assert_eq!(status["managed"]["origin"], json!(admin.policy));
    let deployed_guard = store.managed_deployment().unwrap().packages[0].path.clone();
    let toggled = store
        .enable(&deployed_guard, false)
        .unwrap_err()
        .to_string();
    assert!(toggled.starts_with("managed_by_policy"), "{toggled}");

    let mut sideload = base.clone();
    sideload["sideload"] = json!(false);
    admin.write_policy(sideload);
    let host = admin.host("alice");
    assert_eq!(active(&host), ["guard@1.0.0"]);
    assert!(rejection(&host, "plain").starts_with("managed_sideload_denied"));
    let refused = store
        .trust(
            plain.clone(),
            &plain_sha,
            vec!["interception".into()],
            "user",
        )
        .unwrap_err()
        .to_string();
    assert!(refused.starts_with("managed_sideload_denied"), "{refused}");

    let mut only = base.clone();
    only["managed_only"] = json!(true);
    admin.write_policy(only);
    let host = admin.host("alice");
    assert_eq!(active(&host), ["guard@1.0.0"]);
    assert!(rejection(&host, "plain").starts_with("managed_only"));

    admin.write_policy(base);
    store.reset("mods.json").unwrap();
    assert_eq!(
        active(&admin.host("alice")),
        ["guard@1.0.0"],
        "mod-only recovery keeps managed packages"
    );
}

#[test]
fn tampered_policy_fails_closed_and_stale_or_revoked_managed_content_never_loads() {
    let admin = Admin::new();
    let store = admin.store("alice");
    let (guard, guard_sha) = admin.package("guard", "guard", GUARD, &["interception"]);
    let (plain, plain_sha) = admin.package("plain", "plain", TRANSFORM, &["interception"]);
    trust(&store, &plain, &plain_sha, &["interception"], "user");
    let policy = json!({"schema": 1, "packages": [entry("guard", &guard, &guard_sha, json!({"tier": "append"}))]});
    admin.administer(policy.clone(), "alice");
    let mut host = admin.host("alice");
    assert_eq!(active(&host), ["guard@1.0.0", "plain@1.0.0"]);

    std::fs::set_permissions(&admin.policy, std::fs::Permissions::from_mode(0o666)).unwrap();
    let tampered = host
        .set_managed_policy(admin.policy.clone(), admin.owner, "alice")
        .unwrap_err()
        .to_string();
    assert!(
        tampered.starts_with("managed_policy_untrusted"),
        "{tampered}"
    );
    assert!(
        active(&host).is_empty(),
        "an untrusted policy source loads no mods"
    );
    assert_eq!(host.intercepts("tool"), Some(true));
    let runtime = Mutex::new(host);
    let mut calls = Vec::new();
    assert!(tool(&runtime, "exec", &mut calls).is_err());
    assert!(calls.is_empty());
    let mut host = runtime.into_inner().unwrap();
    assert!(
        store.selection_status().unwrap()["managed_error"]
            .as_str()
            .unwrap()
            .starts_with("managed_policy_untrusted")
    );
    std::fs::set_permissions(&admin.policy, std::fs::Permissions::from_mode(0o644)).unwrap();
    host.set_managed_policy(admin.policy.clone(), admin.owner, "alice")
        .unwrap();
    assert_eq!(active(&host), ["guard@1.0.0", "plain@1.0.0"]);

    admin.write_policy(json!({"schema": 1}));
    host.set_managed_policy(admin.policy.clone(), admin.owner, "alice")
        .unwrap();
    assert_eq!(
        active(&host),
        ["plain@1.0.0"],
        "removing a package from policy revokes it at once"
    );

    let mut pinned = policy.clone();
    pinned["packages"][0]["sha256"] = json!("0".repeat(64));
    admin.write_policy(pinned);
    host.set_managed_policy(admin.policy.clone(), admin.owner, "alice")
        .unwrap();
    assert_eq!(
        active(&host),
        ["plain@1.0.0"],
        "content the policy no longer lists stays unloaded"
    );
    assert!(rejection(&host, "guard").starts_with("managed_pending_sync"));

    admin.write_policy(policy);
    let cached = store.managed_deployment().unwrap().packages[0].path.clone();
    std::fs::write(cached.join("index.ts"), TRANSFORM).unwrap();
    let mut host = ModHost::open(admin.root.join("store-alice")).unwrap();
    host.set_managed_policy(admin.policy.clone(), admin.owner, "alice")
        .unwrap();
    let stale = host.status()["rejected"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|item| item["reason"].as_str())
        .find(|reason| reason.starts_with("managed_content_stale"))
        .unwrap()
        .to_owned();
    assert!(stale.starts_with("managed_content_stale"), "{stale}");
    assert_eq!(host.intercepts("tool"), Some(true));
}

#[test]
fn user_selections_cannot_claim_the_managed_scope_or_a_tier() {
    let admin = Admin::new();
    let store = admin.store("alice");
    let (spoof, spoof_sha) = admin.package("spoof", "spoof", PREFIX, &["interception"]);
    trust(&store, &spoof, &spoof_sha, &["interception"], "user");
    let (tiered, tiered_sha) = admin.package("tiered", "tiered", TRANSFORM, &["interception"]);
    trust(&store, &tiered, &tiered_sha, &["interception"], "user");
    let path = admin.root.join("store-alice/mods.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for selection in config["mods"].as_array_mut().unwrap() {
        match selection["path"] == json!(spoof) {
            true => selection["scope"] = json!("managed"),
            false => selection["tier"] = json!("prepend"),
        }
    }
    std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    let host = ModHost::open(admin.root.join("store-alice")).unwrap();
    assert!(active(&host).is_empty());
    let status = host.status();
    for path in [&spoof, &tiered] {
        let reason = status["rejected"]
            .as_array()
            .unwrap()
            .iter()
            .find(|rejection| rejection["path"] == json!(path))
            .and_then(|rejection| rejection["reason"].as_str())
            .unwrap_or_default();
        assert!(reason.starts_with("unsupported_scope"), "{reason}");
    }
    for row in store.selection_status().unwrap()["selections"]
        .as_array()
        .unwrap()
    {
        assert!(
            row["error"]
                .as_str()
                .unwrap()
                .starts_with("unsupported_scope"),
            "{row}"
        );
    }
}

#[test]
fn managed_targets_that_are_not_running_fail_their_surfaces_closed() {
    let admin = Admin::new();
    let store = admin.store("alice");
    let (guard, guard_sha) = admin.package("guard", "guard", GUARD, &["interception"]);
    let (plain, plain_sha) = admin.package("plain", "plain", TRANSFORM, &["interception"]);
    trust(&store, &plain, &plain_sha, &["interception"], "user");
    let (wide, wide_sha) = admin.package("wide", "wide", COMMAND, &["commands"]);
    admin.write_policy(json!({"schema": 1, "packages": [
        entry("guard", &guard, &guard_sha, json!({})),
        entry("wide", &wide, &wide_sha, json!({"capabilities": ["commands"]}))]}));
    let refused = |host: ModHost| {
        let runtime = Mutex::new(host);
        let mut calls = Vec::new();
        let error = tool(&runtime, "exec", &mut calls).unwrap_err().to_string();
        assert!(calls.is_empty(), "{calls:?}");
        error
    };
    let pending = refused(admin.host("alice"));
    assert!(
        pending.starts_with("intercept_required_failed: guard: managed_pending_sync"),
        "{pending}"
    );
    assert_eq!(admin.host("alice").intercepts("command"), Some(true));

    let listed = codex_omd::package_controls::list(&store, None).unwrap();
    let pending = listed["packages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "guard")
        .unwrap();
    assert_eq!(pending["version"], "1.0.0");
    assert_eq!(pending["api"], MOD_API_VERSION);
    assert_eq!(pending["effective"], false);
    assert!(
        pending["failed"]
            .as_str()
            .unwrap()
            .contains("managed_pending_sync")
    );

    store.package_sync(false).unwrap();
    let runtime = Mutex::new(admin.host("alice"));
    assert!(tool(&runtime, "exec", &mut Vec::new()).is_ok());
    store.reset("managed.json").unwrap();
    let reset = refused(admin.host("alice"));
    assert!(
        reset.starts_with("intercept_required_failed: guard: managed_pending_sync"),
        "{reset}"
    );
    std::fs::write(admin.root.join("store-alice/managed.json"), "{").unwrap();
    let corrupt = refused(admin.host("alice"));
    assert!(
        corrupt.starts_with("intercept_required_failed: guard"),
        "{corrupt}"
    );
    let status = store.selection_status().unwrap();
    assert!(
        status["managed_error"]
            .as_str()
            .unwrap()
            .starts_with("managed_deployment_unreadable"),
        "{status}"
    );

    store.reset("managed.json").unwrap();
    store.package_sync(false).unwrap();
    let mut host = admin.host("alice");
    std::fs::write(admin.root.join("store-alice/mods.json"), "{").unwrap();
    host.reload().unwrap();
    assert_eq!(
        active(&host),
        ["guard@1.0.0", "wide@1.0.0"],
        "a broken mods.json drops only user mods"
    );
    let runtime = Mutex::new(host);
    let mut calls = Vec::new();
    assert_eq!(
        tool(&runtime, "exec", &mut calls).unwrap().result["output"],
        "ran G"
    );
}

#[test]
fn policy_source_namespaces_do_not_include_siblings() {
    let policy = codex_omd::ManagedPolicy::parse(
        json!({"schema":1,"sources":["git+https://github.com/acme"]}),
    )
    .unwrap();
    assert!(policy.source_allowed("git+https://github.com/acme/repo"));
    assert!(!policy.source_allowed("git+https://github.com/acme-evil/repo"));
    assert!(!policy.source_allowed("git+https://github.com/acme/../evil/repo"));
    assert!(!policy.source_allowed("git+https://github.com/acme/%2e%2e/evil/repo"));
}

#[test]
fn forged_deployment_dependencies_cannot_load_unassigned_packages() {
    let admin = Admin::new();
    let (app, app_sha) = admin.package("app", "app", TRANSFORM, &["interception"]);
    let (hidden, hidden_sha) = admin.package("hidden", "hidden", COMMAND, &["commands"]);
    admin.administer(json!({"schema":1,"packages":[
        entry("app", &app, &app_sha, json!({"dependencies":true})),
        entry("hidden", &hidden, &hidden_sha, json!({"capabilities":["commands"],"users":["bob"]}))
    ]}), "bob");
    let mut deployment = admin.store("bob").managed_deployment().unwrap();
    deployment
        .packages
        .iter_mut()
        .find(|package| package.id == "app")
        .unwrap()
        .dependencies
        .push(hidden_sha);
    admin.store("alice");
    std::fs::write(
        admin.root.join("store-alice/managed.json"),
        serde_json::to_vec(&deployment).unwrap(),
    )
    .unwrap();
    assert_eq!(active(&admin.host("alice")), ["app@1.0.0"]);
}

#[test]
fn forged_deployment_versions_cannot_load_incompatible_dependencies() {
    let admin = Admin::new();
    let (library, library_sha) = admin.package("alpha", "alpha", COMMAND, &["commands"]);
    let (other, other_sha) = admin.versioned(
        "alpha2",
        "alpha",
        "2.0.0",
        COMMAND,
        &["commands"],
        json!({}),
    );
    let index = admin.root.join("index.json");
    let index_bytes = serde_json::to_vec(&json!({"schema":1,"packages":{"alpha":[{
        "version":"1.0.0","source":{"kind":"local","path":library},"integrity":library_sha
    }]}}))
    .unwrap();
    std::fs::write(&index, &index_bytes).unwrap();
    let (app, app_sha) = admin.versioned(
        "app",
        "app",
        "1.0.0",
        TRANSFORM,
        &["interception"],
        json!({"dependencies":[{"id":"alpha","version":"1.0.0"}]}),
    );
    admin.administer(json!({"schema":1,"index":{
        "sha256":format!("{:x}",sha2::Sha256::digest(&index_bytes)),"locations":[index]
    },"packages":[
        entry("app", &app, &app_sha, json!({"dependencies":true})),
        entry("alpha", &other, &other_sha, json!({"capabilities":["commands"],"users":["bob"]})),
        entry("alpha", &library, &library_sha, json!({"capabilities":["commands"],"users":["bob"]}))
    ]}), "alice");
    assert_eq!(active(&admin.host("alice")), ["alpha@1.0.0", "app@1.0.0"]);
    let mut deployment = admin.store("alice").managed_deployment().unwrap();
    let dependency = deployment
        .packages
        .iter_mut()
        .find(|package| package.id == "alpha")
        .unwrap();
    dependency.path = other;
    dependency.sha256 = other_sha;
    dependency.version = "1.0.0".into();
    std::fs::write(
        admin.root.join("store-alice/managed.json"),
        serde_json::to_vec(&deployment).unwrap(),
    )
    .unwrap();
    assert!(!active(&admin.host("alice")).contains(&"alpha@2.0.0".to_owned()));
}

#[test]
fn project_entries_match_the_resolved_project_through_symlinks() {
    let admin = Admin::new();
    let (scoped, scoped_sha) = admin.package("scoped", "scoped", TRANSFORM, &["interception"]);
    std::fs::create_dir(admin.root.join("repo")).unwrap();
    std::os::unix::fs::symlink(admin.root.join("repo"), admin.root.join("link")).unwrap();
    admin.administer(
        json!({"schema": 1, "packages": [
            entry("scoped", &scoped, &scoped_sha, json!({"projects": [admin.root.join("link")]}))]}),
        "alice",
    );
    let mut host = admin.host("alice");
    assert!(active(&host).is_empty());
    host.set_checkout(&admin.root.join("repo"));
    host.reload().unwrap();
    assert_eq!(active(&host), ["scoped@1.0.0"]);
}

#[test]
fn managed_collections_deploy_per_user_through_mirrors_offline_and_roll_back_cleanly() {
    let admin = Admin::new();
    let (guard, guard_sha) = admin.package("guard", "guard", GUARD, &["interception"]);
    let (guard2, guard2_sha) = admin.versioned(
        "guard2",
        "guard",
        "2.0.0",
        GUARD,
        &["interception"],
        json!({}),
    );
    let (tool_dir, tool_sha) = admin.package("tool", "tool", TRANSFORM, &["interception"]);
    let (mirror, mirror_sha) = admin.package("mirror", "mirrored", PREFIX, &["interception"]);
    std::fs::create_dir(admin.root.join("catalog")).unwrap();
    let index = admin.root.join("catalog/index.json");
    let index_bytes = serde_json::to_vec(
        &json!({"schema": 1, "packages": {"tool": [{"version": "1.0.0",
        "source": {"kind": "local", "path": tool_dir}, "integrity": tool_sha}]}}),
    )
    .unwrap();
    std::fs::write(&index, &index_bytes).unwrap();
    let index_sha = format!("{:x}", sha2::Sha256::digest(&index_bytes));
    let canary = (0..100)
        .map(|n| format!("guard{n}"))
        .find(|id| cohort("alice", id) != cohort("bob", id))
        .unwrap();
    let (early, late) = if cohort("alice", &canary) < cohort("bob", &canary) {
        ("alice", "bob")
    } else {
        ("bob", "alice")
    };
    let (canary_v2, canary_v2_sha) = admin.versioned(
        "canary2",
        &canary,
        "2.0.0",
        COMMAND,
        &["commands"],
        json!({}),
    );
    let (canary_v1, canary_v1_sha) = admin.versioned(
        "canary1",
        &canary,
        "1.0.0",
        COMMAND,
        &["commands"],
        json!({}),
    );
    let percent = cohort("alice", &canary).max(cohort("bob", &canary));
    let commands = json!({"capabilities": ["commands"]});
    let mut extra = commands.as_object().unwrap().clone();
    extra.insert("percent".into(), json!(percent));
    let policy = json!({"schema": 1,
        "index": {"sha256": index_sha, "locations": [admin.root.join("offline/index.json"), index]},
        "packages": [
            entry("guard", &guard, &guard_sha, json!({"tier": "append"})),
            {"id": "tool", "source": "tool@1.0.0", "sha256": tool_sha, "capabilities": ["interception"], "users": ["alice"]},
            entry("mirrored", Path::new(UNREACHABLE), &mirror_sha, json!({"mirrors": [mirror]})),
            entry(&canary, &canary_v2, &canary_v2_sha, Value::Object(extra)),
            entry(&canary, &canary_v1, &canary_v1_sha, commands)]});
    let alice = admin.administer(policy.clone(), "alice");
    assert_eq!(alice["generation"], 1);
    admin.store("bob").package_sync(false).unwrap();
    let alice = deployed(&admin.store("alice"));
    for package in [
        "guard@1.0.0",
        "tool@1.0.0",
        "mirrored@1.0.0",
        &format!("{canary}@1.0.0"),
    ] {
        assert!(
            alice.contains(&package.to_owned()),
            "{package} in {alice:?}"
        );
    }
    assert!(
        !deployed(&admin.store("bob")).contains(&"tool@1.0.0".to_owned()),
        "tool targets alice only"
    );
    assert!(deployed(&admin.store(early)).contains(&format!("{canary}@2.0.0")));
    assert!(
        !deployed(&admin.store(late)).contains(&format!("{canary}@2.0.0")),
        "outside the rollout cohort"
    );
    assert!(active(&admin.host(early)).contains(&format!("{canary}@2.0.0")));
    assert!(active(&admin.host(late)).contains(&format!("{canary}@1.0.0")));
    assert!(active(&admin.host("alice")).contains(&"tool@1.0.0".to_owned()));
    assert!(!active(&admin.host("bob")).contains(&"tool@1.0.0".to_owned()));
    let unchanged = admin.store("alice").package_sync(false).unwrap();
    assert_eq!(
        (
            unchanged["generation"].clone(),
            unchanged["changed"].clone()
        ),
        (json!(1), json!(false))
    );

    let mut upgraded = policy.clone();
    upgraded["packages"][0] = entry("guard", &guard2, &guard2_sha, json!({"tier": "append"}));
    upgraded["packages"].as_array_mut().unwrap().push(entry(
        "guard",
        &guard,
        &guard_sha,
        json!({"tier": "append"}),
    ));
    admin.write_policy(upgraded);
    assert!(
        active(&admin.host("alice")).contains(&"guard@1.0.0".to_owned()),
        "the listed fallback keeps running until sync"
    );
    assert_eq!(
        admin.store("alice").package_sync(false).unwrap()["generation"],
        2
    );
    assert!(active(&admin.host("alice")).contains(&"guard@2.0.0".to_owned()));
    assert_eq!(
        admin.store("alice").package_sync_rollback().unwrap()["generation"],
        3
    );
    let host = admin.host("alice");
    assert!(active(&host).contains(&"guard@1.0.0".to_owned()));
    assert!(rejection(&host, "guard").starts_with("managed_pending_sync"));
    admin.write_policy(policy.clone());
    let fresh = admin.store("carol");
    let offline = fresh.package_sync(true).unwrap();
    assert_eq!(
        offline["generation"], 1,
        "local folders, the catalog and mirrors deploy offline"
    );
    assert!(deployed(&fresh).contains(&"mirrored@1.0.0".to_owned()));
}

#[test]
fn managed_sync_refuses_tampered_unavailable_or_scripted_content_and_keeps_the_generation() {
    let admin = Admin::new();
    let (guard, guard_sha) = admin.package("guard", "guard", GUARD, &["interception"]);
    let (scripted, scripted_sha) = admin.versioned(
        "scripted",
        "scripted",
        "1.0.0",
        TRANSFORM,
        &["interception"],
        json!({"lifecycle": {"install": "index.ts"}}),
    );
    let policy = json!({"schema": 1, "packages": [entry("guard", &guard, &guard_sha, json!({}))]});
    admin.administer(policy.clone(), "alice");
    let mut unavailable = policy.clone();
    unavailable["packages"].as_array_mut().unwrap().push(entry(
        "remote",
        Path::new(UNREACHABLE),
        &guard_sha,
        json!({}),
    ));
    admin.write_policy(unavailable);
    let error = admin
        .store("alice")
        .package_sync(false)
        .unwrap_err()
        .to_string();
    assert!(
        error.starts_with("managed_sync_incomplete: generation 1 stays active"),
        "{error}"
    );
    assert_eq!(
        admin
            .store("alice")
            .managed_deployment()
            .unwrap()
            .generation,
        1
    );
    assert!(active(&admin.host("alice")).contains(&"guard@1.0.0".to_owned()));

    let mut with_script = policy.clone();
    with_script["packages"].as_array_mut().unwrap().push(entry(
        "scripted",
        &scripted,
        &scripted_sha,
        json!({}),
    ));
    admin.write_policy(with_script.clone());
    let error = admin
        .store("alice")
        .package_sync(false)
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("managed_lifecycle_requires_approval"),
        "{error}"
    );
    with_script["packages"][1]["lifecycle"] = json!(["install"]);
    admin.write_policy(with_script);
    let error = admin
        .store("alice")
        .package_sync(false)
        .unwrap_err()
        .to_string();
    assert!(
        error.starts_with("managed_policy_invalid"),
        "policy can't grant install scripts: {error}"
    );

    admin.write_policy(policy);
    std::fs::write(guard.join("index.ts"), TRANSFORM).unwrap();
    let error = admin
        .store("bob")
        .package_sync(false)
        .unwrap_err()
        .to_string();
    assert!(error.contains("managed_integrity_mismatch"), "{error}");
    assert_eq!(
        admin.store("bob").managed_deployment().unwrap().generation,
        0
    );
    assert!(
        admin.store("alice").package_sync(false).is_ok(),
        "already deployed content stays verified in the cache"
    );
}

#[test]
fn managed_policy_refuses_user_installs_outside_allowed_sources_and_versions() {
    let admin = Admin::new();
    let (allowed, _) = admin.package("allowed", "allowed", TRANSFORM, &["interception"]);
    std::fs::create_dir(admin.root.join("elsewhere")).unwrap();
    let outside = admin
        .versioned(
            "elsewhere/outside",
            "outside",
            "1.0.0",
            TRANSFORM,
            &["interception"],
            json!({}),
        )
        .0;
    let install = |path: &Path, id: &str| ModInstallRequest {
        action: None,
        source: ModPackageSource::Local {
            path: path.to_path_buf(),
        },
        index: None,
        scope: "user".into(),
        offline: false,
        trust: ModPackageTrust {
            packages: BTreeMap::from([(
                id.to_owned(),
                ModPackageGrant {
                    capabilities: vec!["interception".into()],
                    dependencies: false,
                    lifecycle: Vec::new(),
                    secret_environment: Vec::new(),
                },
            )]),
        },
        settings: BTreeMap::new(),
    };
    let store = admin.store("alice");
    let plan = store.package_plan(install(&allowed, "allowed")).unwrap();
    store
        .package_apply(install(&allowed, "allowed"), &plan.confirmation)
        .unwrap();
    store.package_enable("allowed").unwrap();
    admin.write_policy(json!({"schema": 1, "updates": "managed",
        "sources": [admin.root.join("allowed").display().to_string()]}));
    let host = admin.host("alice");
    assert!(active(&host).is_empty());
    assert!(rejection(&host, "allowed").starts_with("managed_source_unverified"));
    let refused = store
        .package_plan(install(&outside, "outside"))
        .unwrap_err()
        .to_string();
    assert!(refused.starts_with("managed_source_denied"), "{refused}");
    std::fs::write(allowed.join("index.ts"), PREFIX).unwrap();
    let update = store
        .package_plan(install(&allowed, "allowed"))
        .unwrap_err()
        .to_string();
    assert!(update.starts_with("managed_updates_denied"), "{update}");
    let rollback = store
        .package_rollback_plan("allowed")
        .unwrap_err()
        .to_string();
    assert!(rollback.starts_with("managed_updates_denied"), "{rollback}");
}
