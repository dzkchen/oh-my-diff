use codex_omd::data_store::Origin;
use codex_omd::data_store::fork_thread_data;
use codex_omd::data_store::remove_thread_data;
use codex_omd::host::Authority;
use codex_omd::host::Caller;
use codex_omd::host::ExecAccess;
use codex_omd::host::Host;
use serde_json::json;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

struct Repository(PathBuf);

impl Authority for Repository {
    fn repository(&self) -> &Path {
        &self.0
    }

    fn readable(&self, _path: &Path) -> bool {
        true
    }

    fn writable(&self, _path: &Path) -> bool {
        true
    }

    fn command(&self, _argv: Vec<String>, _access: &ExecAccess<'_>) -> Result<Command, String> {
        Err("unused".into())
    }
}

fn caller<'a>(capabilities: &'a [String], thread: Option<&'a str>) -> Caller<'a> {
    Caller {
        id: "fixture",
        source_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        capabilities,
        exec_environment: &[],
        os_access: None,
        fs_access: None,
        origin: Origin::Tool,
        thread,
    }
}

#[test]
fn thread_scope_is_per_thread_forks_by_copy_and_is_removed_with_the_thread() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let (repository, data) = (root.join("repo"), root.join("data"));
    std::fs::create_dir_all(&repository).unwrap();
    std::fs::create_dir(&data).unwrap();
    let authority = Repository(repository);
    let active = || true;
    let host = Host {
        authority: &authority,
        data_root: &data,
        environment: None,
        active: &active,
        record_changes: false,
    };
    let capabilities = vec!["store".to_owned()];
    let (one, two) = (
        caller(&capabilities, Some("thread-1")),
        caller(&capabilities, Some("thread-2")),
    );
    let put = json!({"key": "goal", "value": {"text": "ship"}, "expected_revision": null, "scope": "thread"});
    host.call(&one, "store.put", put).unwrap();
    assert_eq!(
        host.call(&one, "store.get", json!({"key": "goal", "scope": "thread"}))
            .unwrap()["value"]["text"],
        "ship"
    );
    assert!(
        host.call(&two, "store.get", json!({"key": "goal", "scope": "thread"}))
            .unwrap()
            .is_null()
    );
    assert!(
        host.call(&one, "store.get", json!({"key": "goal"}))
            .unwrap()
            .is_null()
    );
    assert!(
        host.call(
            &caller(&capabilities, None),
            "store.get",
            json!({"key": "goal", "scope": "thread"})
        )
        .is_err()
    );

    assert!(fork_thread_data(&data, "thread-1", "thread-3").unwrap());
    let three = caller(&capabilities, Some("thread-3"));
    assert_eq!(
        host.call(
            &three,
            "store.get",
            json!({"key": "goal", "scope": "thread"})
        )
        .unwrap()["value"]["text"],
        "ship"
    );
    assert_eq!(
        fork_thread_data(&data, "thread-1", "thread-3")
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::AlreadyExists
    );
    assert!(!fork_thread_data(&data, "absent", "thread-4").unwrap());
    assert!(fork_thread_data(&data, "../x", "thread-5").is_err());

    assert!(remove_thread_data(&data, "thread-1").unwrap());
    assert!(!remove_thread_data(&data, "thread-1").unwrap());
    assert!(
        host.call(&one, "store.get", json!({"key": "goal", "scope": "thread"}))
            .unwrap()
            .is_null()
    );
    assert_eq!(
        host.call(
            &three,
            "store.get",
            json!({"key": "goal", "scope": "thread"})
        )
        .unwrap()["value"]["text"],
        "ship"
    );
}

#[test]
fn a_failed_fork_publishes_nothing_and_never_merges_into_an_existing_thread() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().canonicalize().unwrap();
    let threads = data.join("data/threads");
    for owner in ["a", "b"] {
        std::fs::create_dir_all(threads.join("parent").join(owner)).unwrap();
        std::fs::write(threads.join("parent").join(owner).join("store.json"), owner).unwrap();
    }
    let unreadable = threads.join("parent/b/store.json");
    std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000)).unwrap();
    let failed = fork_thread_data(&data, "parent", "child");
    std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        failed.unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied
    );
    let entries = || {
        let mut names = std::fs::read_dir(&threads)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        names.sort();
        names
    };
    assert_eq!(entries(), ["parent"]);
    assert!(fork_thread_data(&data, "parent", "child").unwrap());
    assert_eq!(
        std::fs::read(threads.join("child/b/store.json")).unwrap(),
        b"b"
    );
    std::fs::create_dir_all(threads.join("empty")).unwrap();
    std::fs::create_dir_all(threads.join("full/a")).unwrap();
    std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000)).unwrap();
    let repeated =
        ["child", "empty", "full"].map(|existing| fork_thread_data(&data, "parent", existing));
    std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o600)).unwrap();
    for result in repeated {
        assert_eq!(
            result.unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
    }
    assert_eq!(entries(), ["child", "empty", "full", "parent"]);
    assert_eq!(std::fs::read_dir(threads.join("empty")).unwrap().count(), 0);
    assert_eq!(
        std::fs::read_dir(threads.join("full/a")).unwrap().count(),
        0
    );
}
