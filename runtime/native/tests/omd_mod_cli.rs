use codex_omd::MOD_API_VERSION;
use codex_omd::ModStore;
use serde_json::Value;
use serde_json::json;
use std::ffi::OsStr;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use tempfile::TempDir;


fn omd_mod(cwd: &Path, args: &[&OsStr]) -> Result<Value, String> {
    let output = Command::new(env!("CARGO_BIN_EXE_omd-mod"))
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    if output.status.success() {
        Ok(serde_json::from_slice::<Value>(&output.stdout).unwrap())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

fn package(
    root: &Path,
    id: &str,
    source: &str,
    capabilities: &[&str],
    state_scope: Option<&str>,
) -> PathBuf {
    let path = root.join(id);
    std::fs::create_dir(&path).unwrap();
    let mut manifest = json!({"schema":1,"id":id,"version":"1.0.0",
        "api":MOD_API_VERSION,"state_version":1,"capabilities":capabilities});
    if let Some(scope) = state_scope {
        manifest["state_scope"] = json!(scope);
    }
    std::fs::write(
        path.join("mod.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(path.join("index.ts"), source).unwrap();
    path
}

fn trust(store: &ModStore, path: &Path, capabilities: &[&str]) {
    let inspected = ModStore::inspect_package(path).unwrap();
    let granted: Vec<String> = capabilities.iter().map(|value| value.to_string()).collect();
    let sha256 = inspected["sha256"].as_str().unwrap();
    store
        .trust(path.to_path_buf(), sha256, granted, "user")
        .unwrap();
    store.enable(path, true).unwrap();
}

#[test]
fn credentials_cli_stores_and_replaces_a_mod_owned_secret_from_stdin() {
    use std::io::Write;
    let temp = TempDir::new().unwrap();
    let store = temp.path().canonicalize().unwrap();
    let add = |value: &str| {
        let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_omd-mod"))
            .arg("credentials")
            .arg(&store)
            .args([
                "add-secret",
                "fixture_mod",
                "fixture",
                "https://api.example.com",
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(value.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    let first = add("first-key\n");
    assert_eq!(
        (&first["kind"], &first["label"], &first["status"]),
        (&json!("secret"), &json!("fixture"), &json!("ready"))
    );
    let second = add("second-key");
    assert_eq!(second["id"], first["id"]);
    let profiles = codex_omd::credentials::CredentialProfiles::local(&store).unwrap();
    let id = first["id"].as_str().unwrap();
    assert_eq!(
        profiles.owned_secret(id, "fixture_mod").unwrap()["value"],
        "second-key"
    );
    assert!(profiles.owned_secret(id, "another_mod").is_err());
    assert!(profiles.visible("").unwrap().is_empty());
}

#[test]
fn omd_mod_reset_moves_only_resettable_store_files_aside() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap().join("store");
    ModStore::create(root.clone()).unwrap();
    std::fs::write(root.join("host.json"), b"{broken").unwrap();
    let reset = |name: &str| {
        omd_mod(
            temp.path(),
            &[OsStr::new("reset"), root.as_os_str(), OsStr::new(name)],
        )
    };
    let aside = root.join("host.json.corrupt");
    assert_eq!(
        reset("host.json"),
        Ok(json!({"reset": "host.json", "aside": aside}))
    );
    assert_eq!(std::fs::read(&aside).unwrap(), b"{broken");
    assert!(!root.join("host.json").exists());
    assert!(
        reset("grants.json")
            .unwrap_err()
            .contains("store_file_not_resettable")
    );
}

#[test]
fn command_cli_scopes_state_to_the_thread_or_the_checkout_of_its_cwd() {
    let source = "export default api => { api.command('count', () => { api.state.set(Number(api.state.get() ?? 0)+1); return api.state.get(); }); }";
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let checkout = root.join("checkout");
    std::fs::create_dir_all(checkout.join(".git")).unwrap();
    std::fs::create_dir_all(checkout.join("sub")).unwrap();
    let store = ModStore::create(root.join("store")).unwrap();
    for (id, scope) in [("threaded", "thread"), ("shared", "checkout")] {
        let path = package(&root, id, source, &["commands", "store"], Some(scope));
        trust(&store, &path, &["commands", "store"]);
    }
    let cli = |cwd: &Path, args: &[&str]| {
        let store = root.join("store");
        let mut arguments = vec![OsStr::new("command"), store.as_os_str()];
        arguments.extend(args.iter().map(OsStr::new));
        omd_mod(cwd, &arguments)
    };
    assert_eq!(
        cli(&checkout, &["threaded", "count", "null", "t5"]),
        Ok(json!(1))
    );
    assert_eq!(
        cli(&checkout, &["threaded", "count", "null", "t5"]),
        Ok(json!(2))
    );
    assert!(
        cli(&checkout, &["threaded", "count", "null"])
            .unwrap_err()
            .contains("state_thread_unavailable")
    );
    assert_eq!(
        cli(&checkout.join("sub"), &["shared", "count", "null"]),
        Ok(json!(1))
    );
    assert_eq!(cli(&checkout, &["shared", "count", "null"]), Ok(json!(2)));
    assert!(checkout.join(".git/omd/state/shared.json").is_file());
}

#[test]
fn omd_mod_rejects_a_tool_schema_the_host_validator_refuses() {
    let status = |parameters: &str| {
        let source = format!(
            "export default api => api.tool({{name:'probe',description:'probe',parameters:{parameters}}},()=>null)"
        );
        let temp = TempDir::new().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let store_path = root.join("store");
        let store = ModStore::create(store_path.clone()).unwrap();
        let path = package(&root, "fixture", &source, &["tools"], None);
        trust(&store, &path, &["tools"]);
        let status = omd_mod(&root, &[OsStr::new("status"), store_path.as_os_str()]).unwrap();
        status["mods"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "fixture")
            .cloned()
            .unwrap()
    };
    let accepted = status("{type:'object',properties:{}}");
    assert!(accepted["error"].is_null(), "{accepted}");
    let rejected = status("{type:'null'}");
    assert!(
        rejected["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty()),
        "{rejected}"
    );
}
