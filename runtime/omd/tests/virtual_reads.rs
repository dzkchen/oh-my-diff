use codex_omd::{ModHost, ModStore};
use serde_json::json;
use std::fs;
use std::path::PathBuf;

fn fixture() -> (tempfile::TempDir, ModStore, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let node = PathBuf::from(std::env::var_os("OMD_TEST_NODE").expect("OMD_TEST_NODE required"));
    let store = ModStore::create(root.join("store"), node).unwrap();
    let source =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../mods/examples/virtual_reader");
    let package = root.join("provider");
    fs::create_dir(&package).unwrap();
    for file in ["mod.json", "index.ts"] {
        fs::copy(source.join(file), package.join(file)).unwrap();
    }
    (temp, store, package)
}

fn enable(store: &ModStore, package: &std::path::Path) {
    let inspected = ModStore::inspect_package(package).unwrap();
    store
        .trust(
            package.to_owned(),
            inspected["sha256"].as_str().unwrap(),
            vec!["virtual_reads".into()],
            "user",
        )
        .unwrap();
    store.enable(package, true).unwrap();
}

#[test]
fn independent_provider_revision_and_disabled_recovery() {
    let (temp, store, package) = fixture();
    enable(&store, &package);
    let root = temp.path().canonicalize().unwrap().join("store");
    let mut host = ModHost::open(root.clone()).unwrap();
    assert_eq!(host.virtual_readers().len(), 1, "{}", host.status());
    let result = host
        .read_virtual(
            json!({"uri":"fixture://manual/intro"}),
            || true,
            |_, _| panic!("unexpected authority"),
        )
        .unwrap();
    assert_eq!(result["resource"]["revision"], "manual-v1");
    assert_eq!(result["untrusted"], true);
    assert_eq!(result["sha256"].as_str().unwrap().len(), 64);
    assert!(
        host.read_virtual(
            json!({"uri":"fixture://manual/intro","expected_revision":"stale"}),
            || true,
            |_, _| panic!()
        )
        .unwrap_err()
        .to_string()
        .contains("revision_changed")
    );
    assert!(
        host.read_virtual(
            json!({"uri":"file:///etc/passwd"}),
            || true,
            |_, _| panic!()
        )
        .is_err()
    );
    assert!(
        host.read_virtual(
            json!({"uri":"fixture://manual/intro"}),
            || false,
            |_, _| panic!()
        )
        .is_err()
    );
    store.enable(&package, false).unwrap();
    let mut host = ModHost::open(root).unwrap();
    assert!(host.virtual_readers().is_empty());
    assert!(
        host.read_virtual(
            json!({"uri":"fixture://manual/intro"}),
            || true,
            |_, _| panic!()
        )
        .unwrap_err()
        .to_string()
        .contains("unavailable")
    );
}

#[test]
fn common_read_keeps_local_and_virtual_authority_separate() {
    let (_temp, store, package) = fixture();
    enable(&store, &package);
    let mut host = ModHost::open(package.parent().unwrap().join("store")).unwrap();
    assert!(
        host.tools()
            .iter()
            .any(|(owner, _, tool)| owner.is_empty() && tool.name == "read")
    );
    let generation = host.generation();
    let local = host
        .invoke_tool(
            "",
            generation,
            "read",
            json!({"path":"a.txt","max_bytes":2}),
            || true,
            |owner, call| {
                assert_eq!(owner, "");
                assert_eq!(call.operation, "workspace.read");
                assert_eq!(call.arguments, json!({"paths":["a.txt"]}));
                Ok(json!({"files":{"a.txt":{"text":"abcd","sha256":"ignored-untrusted-field"}}}))
            },
            |_| {},
        )
        .unwrap();
    assert_eq!(local["source"], "local");
    assert_eq!(local["text"], "ab");
    assert_eq!(local["cursor"], "2");
    assert!(
        host.invoke_tool(
            "",
            generation,
            "read",
            json!({"path":"a.txt","cursor":"2"}),
            || true,
            |_, _| Ok(json!({"files":{"a.txt":{"text":"abcd"}}})),
            |_| {}
        )
        .unwrap_err()
        .to_string()
        .contains("revision")
    );
    let remote = host
        .invoke_tool(
            "",
            generation,
            "read",
            json!({"uri":"fixture://manual/intro"}),
            || true,
            |_, _| panic!(),
            |_| {},
        )
        .unwrap();
    assert_eq!(remote["source"], "virtual");
    assert!(
        host.invoke_tool(
            "",
            generation,
            "read",
            json!({"path":"a.txt","uri":"fixture://manual/intro"}),
            || true,
            |_, _| panic!(),
            |_| {}
        )
        .is_err()
    );
    store.enable(&package, false).unwrap();
    host.turn_boundary();
    assert!(!host.tools().iter().any(|(owner, _, _)| owner.is_empty()));
    assert!(
        host.invoke_tool(
            "",
            generation,
            "read",
            json!({"path":"a.txt"}),
            || true,
            |_, _| panic!(),
            |_| {}
        )
        .is_err()
    );
}
