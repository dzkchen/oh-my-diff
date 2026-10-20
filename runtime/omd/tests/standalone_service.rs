use codex_omd::{MOD_API_VERSION, ModStore};
use serde_json::{Value, json};
use std::fs;
use std::process::Command;

#[test]
fn standalone_service_uses_provider_scoped_host_access() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let repository = root.join("repo");
    fs::create_dir(&repository).unwrap();
    let store_path = root.join("store");
    let store = ModStore::create(store_path.clone()).unwrap();
    for (id, source, services, capabilities) in [
        (
            "provider",
            "export default api => api.provide({name:'example.evidence',version:'1.0.0',methods:{write:{input:'null',output:'object'}}},{write:()=>api.host.call('evidence.write',{media_type:'application/json',content:{owner:'provider'}})})",
            json!({"exports":[{"name":"example.evidence","version":"1.0.0","methods":{"write":{"input":"null","output":"object"}}}]}),
            vec!["services", "store"],
        ),
        (
            "consumer",
            "export default api => api.command('write',()=>api.services.call('example.evidence','write',null),{cli:'example-evidence'})",
            json!({"imports":[{"name":"example.evidence","version":"1.0.0"}]}),
            vec!["commands", "services"],
        ),
    ] {
        let package = root.join(id);
        fs::create_dir(&package).unwrap();
        fs::write(package.join("index.ts"), source).unwrap();
        fs::write(package.join("mod.json"), serde_json::to_vec(&json!({
            "schema":1,"id":id,"version":"1.0.0","api":MOD_API_VERSION,
            "state_version":1,"capabilities":capabilities,"services":services,
            "compatibility":{"required_features":if id == "consumer" { vec!["plugin_dispatch_v1", "service_dispatch_v1"] } else { vec!["service_dispatch_v1"] }}
        })).unwrap()).unwrap();
        let inspected = ModStore::inspect_package(&package).unwrap();
        store
            .trust(
                package.clone(),
                inspected["sha256"].as_str().unwrap(),
                capabilities.into_iter().map(str::to_owned).collect(),
                "user",
            )
            .unwrap();
        store.enable(&package, true).unwrap();
    }
    let output = Command::new(env!("CARGO_BIN_EXE_omd"))
        .args([
            "example-evidence",
            "--repo",
            repository.to_str().unwrap(),
            "--store",
            store_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["sha256"].as_str().unwrap().len(), 64);
}
