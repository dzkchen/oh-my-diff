use super::*;
use serde_json::json;
use std::path::Path;

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "-c",
            "user.name=OMD",
            "-c",
            "user.email=omd@example.invalid",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git");
    assert!(
        status.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&status.stderr)
    );
}

fn repository() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path();
    git(root, &["init", "--quiet", "--initial-branch=main"]);
    git(root, &["config", "user.name", "OMD"]);
    git(root, &["config", "user.email", "omd@example.invalid"]);
    git(root, &["config", "commit.gpgsign", "false"]);
    std::fs::write(root.join("a.txt"), "one\n").expect("write");
    std::fs::write(root.join("b.txt"), "two\n").expect("write");
    git(root, &["add", "."]);
    git(root, &["commit", "--quiet", "-m", "initial"]);
    dir
}

struct Fixture {
    dir: tempfile::TempDir,
    backups: tempfile::TempDir,
    protected: Vec<PathBuf>,
}

impl Fixture {
    fn new() -> Self {
        let dir = repository();
        let protected = vec![dir.path().join(".omd-store")];
        Self {
            dir,
            backups: tempfile::tempdir().expect("backups"),
            protected,
        }
    }

    fn root(&self) -> &Path {
        self.dir.path()
    }

    fn call(&self, operation: &str, arguments: Value) -> Result<Value, String> {
        let access = GitAccess {
            repository: self.root(),
            protected: &self.protected,
            backups: Some(self.backups.path()),
            write: Ok(()),
            command: None,
            writable: &|_| true,
        };
        call(&access, operation, arguments, &|| true)
    }

    fn entry(&self, path: &str) -> Value {
        let status = self.call("git.status", Value::Null).expect("status");
        status["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .find(|entry| entry["path"] == path)
            .cloned()
            .unwrap_or(Value::Null)
    }
}

#[test]
fn status_reports_staged_unstaged_untracked_and_renamed_entries() {
    let fixture = Fixture::new();
    let root = fixture.root();
    std::fs::write(root.join("a.txt"), "one\nmore\n").expect("write");
    std::fs::write(root.join("new.txt"), "new\n").expect("write");
    git(root, &["mv", "b.txt", "c.txt"]);
    let status = fixture.call("git.status", Value::Null).expect("status");
    assert_eq!(status["head"]["branch"], "main");
    assert_eq!(status["head"]["detached"], false);
    let entries = status["entries"].as_array().expect("entries");
    let short = |path: &str| {
        entries
            .iter()
            .find(|entry| entry["path"] == path)
            .map(|entry| {
                format!(
                    "{}{}",
                    entry["index"].as_str().unwrap(),
                    entry["worktree"].as_str().unwrap()
                )
            })
    };
    assert_eq!(short("a.txt").as_deref(), Some(" M"));
    assert_eq!(short("new.txt").as_deref(), Some("??"));
    assert_eq!(short("c.txt").as_deref(), Some("R "));
    let renamed = entries
        .iter()
        .find(|entry| entry["path"] == "c.txt")
        .unwrap();
    assert_eq!(renamed["orig_path"], "b.txt");
    assert_eq!(status["truncated"], false);
    assert_eq!(status["fingerprint"].as_str().map(str::len), Some(64));
}

#[test]
fn scoped_fingerprint_ignores_unrelated_changes_but_tracks_the_target() {
    let fixture = Fixture::new();
    let root = fixture.root();
    std::fs::write(root.join("a.txt"), "changed\n").expect("write");
    let before = fixture.entry("a.txt")["fingerprint"].clone();
    std::fs::write(root.join("unrelated.txt"), "x\n").expect("write");
    assert_eq!(fixture.entry("a.txt")["fingerprint"], before);
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(root.join("a.txt"), "changed again\n").expect("write");
    assert_ne!(fixture.entry("a.txt")["fingerprint"], before);
}

#[test]
fn stage_and_unstage_reject_stale_previews() {
    let fixture = Fixture::new();
    let root = fixture.root();
    std::fs::write(root.join("a.txt"), "changed\n").expect("write");
    let seen = fixture.entry("a.txt")["fingerprint"].clone();
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(root.join("a.txt"), "changed later\n").expect("write");
    let error = fixture
        .call(
            "git.stage",
            json!({"paths": ["a.txt"], "fingerprint": seen}),
        )
        .unwrap_err();
    assert!(error.starts_with("stale_git_state"), "{error}");
    let fresh = fixture.entry("a.txt")["fingerprint"].clone();
    fixture
        .call(
            "git.stage",
            json!({"paths": ["a.txt"], "fingerprint": fresh}),
        )
        .expect("stage");
    assert_eq!(fixture.entry("a.txt")["index"], "M");
    let staged = fixture.entry("a.txt")["fingerprint"].clone();
    fixture
        .call(
            "git.unstage",
            json!({"paths": ["a.txt"], "fingerprint": staged}),
        )
        .expect("unstage");
    assert_eq!(fixture.entry("a.txt")["index"], " ");
    assert_eq!(fixture.entry("a.txt")["worktree"], "M");
}

#[test]
fn commit_uses_exactly_the_staged_index() {
    let fixture = Fixture::new();
    let root = fixture.root();
    let empty = fixture.call("git.status", Value::Null).unwrap()["staged_fingerprint"].clone();
    assert_eq!(
        fixture
            .call(
                "git.commit",
                json!({"message": "nothing", "fingerprint": empty})
            )
            .unwrap_err(),
        "nothing_staged"
    );
    std::fs::write(root.join("a.txt"), "staged\n").expect("write");
    std::fs::write(root.join("b.txt"), "not staged\n").expect("write");
    git(root, &["add", "a.txt"]);
    let staged = fixture.call("git.status", Value::Null).unwrap()["staged_fingerprint"].clone();
    git(root, &["add", "b.txt"]);
    let error = fixture
        .call(
            "git.commit",
            json!({"message": "stale", "fingerprint": staged}),
        )
        .unwrap_err();
    assert!(error.starts_with("stale_git_state"), "{error}");
    git(root, &["restore", "--staged", "b.txt"]);
    let staged = fixture.call("git.status", Value::Null).unwrap()["staged_fingerprint"].clone();
    let result = fixture
        .call(
            "git.commit",
            json!({"message": "  commit a\n", "fingerprint": staged}),
        )
        .expect("commit");
    assert_eq!(result["oid"].as_str().map(str::len), Some(40));
    assert_eq!(fixture.entry("b.txt")["worktree"], "M");
    assert_eq!(fixture.entry("a.txt"), Value::Null);
    let log = fixture.call("git.log", json!({"limit": 1})).expect("log");
    assert_eq!(log["commits"][0]["subject"], "commit a");
    assert_eq!(log["truncated"], true);
}

#[test]
fn discard_backs_up_tracked_and_untracked_files_first() {
    let fixture = Fixture::new();
    let root = fixture.root();
    std::fs::write(root.join("a.txt"), "local edit\n").expect("write");
    std::fs::write(root.join("scratch.txt"), "scratch\n").expect("write");
    let status = fixture
        .call("git.status", json!({"paths": ["a.txt", "scratch.txt"]}))
        .expect("status");
    let result = fixture
        .call(
            "git.discard",
            json!({"paths": ["a.txt", "scratch.txt"], "fingerprint": status["fingerprint"]}),
        )
        .expect("discard");
    let backup = PathBuf::from(result["backup"].as_str().unwrap());
    assert!(backup.starts_with(fixture.backups.path()));
    assert_eq!(
        std::fs::read_to_string(backup.join("a.txt")).unwrap(),
        "local edit\n"
    );
    assert_eq!(
        std::fs::read_to_string(backup.join("scratch.txt")).unwrap(),
        "scratch\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "one\n"
    );
    assert!(!root.join("scratch.txt").exists());
}

#[test]
fn discard_refuses_staged_only_paths_and_unsafe_paths() {
    let fixture = Fixture::new();
    let root = fixture.root();
    std::fs::write(root.join("a.txt"), "staged\n").expect("write");
    git(root, &["add", "a.txt"]);
    let seen = fixture.entry("a.txt")["fingerprint"].clone();
    assert!(
        fixture
            .call(
                "git.discard",
                json!({"paths": ["a.txt"], "fingerprint": seen})
            )
            .unwrap_err()
            .starts_with("no_unstaged_changes")
    );
    for path in [
        "../outside",
        "/etc/passwd",
        ".git/config",
        ".omd-store/state.json",
        "",
    ] {
        let error = fixture
            .call("git.discard", json!({"paths": [path], "fingerprint": seen}))
            .unwrap_err();
        assert!(
            error.starts_with("invalid_git_path") || error.starts_with("protected_git_path"),
            "{path}: {error}"
        );
    }
}

#[test]
fn switch_requires_a_known_branch_and_fresh_state() {
    let fixture = Fixture::new();
    let root = fixture.root();
    git(root, &["branch", "feature"]);
    let branches = fixture.call("git.branches", Value::Null).expect("branches");
    assert_eq!(branches["current"], "main");
    assert_eq!(branches["local"], json!(["feature", "main"]));
    let whole = fixture.call("git.status", Value::Null).unwrap()["fingerprint"].clone();
    assert!(
        fixture
            .call(
                "git.switch",
                json!({"branch": "missing", "fingerprint": whole})
            )
            .unwrap_err()
            .starts_with("unknown_git_branch")
    );
    assert_eq!(
        fixture
            .call(
                "git.switch",
                json!({"branch": "--orphan", "fingerprint": whole})
            )
            .unwrap_err(),
        "invalid_git_branch"
    );
    std::fs::write(root.join("new.txt"), "x\n").expect("write");
    assert!(
        fixture
            .call(
                "git.switch",
                json!({"branch": "feature", "fingerprint": whole})
            )
            .unwrap_err()
            .starts_with("stale_git_state")
    );
    let whole = fixture.call("git.status", Value::Null).unwrap()["fingerprint"].clone();
    let result = fixture
        .call(
            "git.switch",
            json!({"branch": "feature", "fingerprint": whole}),
        )
        .expect("switch");
    assert_eq!(result["head"]["branch"], "feature");
    assert!(root.join("new.txt").exists());
}

#[test]
fn detached_head_diff_and_untracked_diff_are_reported() {
    let fixture = Fixture::new();
    let root = fixture.root();
    git(root, &["checkout", "--quiet", "--detach"]);
    std::fs::write(root.join("a.txt"), "one\ntwo\n").expect("write");
    std::fs::write(root.join("new.txt"), "fresh\n").expect("write");
    let status = fixture.call("git.status", Value::Null).expect("status");
    assert_eq!(status["head"]["detached"], true);
    assert_eq!(status["head"]["branch"], Value::Null);
    let diff = fixture
        .call("git.diff", json!({"path": "a.txt"}))
        .expect("diff");
    assert!(diff["text"].as_str().unwrap().contains("+two"));
    assert_eq!(diff["fingerprint"], fixture.entry("a.txt")["fingerprint"]);
    let untracked = fixture
        .call("git.diff", json!({"path": "new.txt"}))
        .expect("diff");
    assert!(untracked["text"].as_str().unwrap().contains("+fresh"));
    assert_eq!(untracked["binary"], false);
}

#[test]
fn writes_require_permission_and_repositories_are_required() {
    let fixture = Fixture::new();
    let access = GitAccess {
        repository: fixture.root(),
        protected: &[],
        backups: None,
        write: Err("git_write_requires_user_command"),
        command: None,
        writable: &|_| false,
    };
    assert_eq!(
        call(
            &access,
            "git.stage",
            json!({"paths": ["a.txt"], "fingerprint": "0".repeat(64)}),
            &|| true
        )
        .unwrap_err(),
        "git_write_requires_user_command"
    );
    assert!(call(&access, "git.status", Value::Null, &|| true).is_ok());
    let plain = tempfile::tempdir().expect("tempdir");
    let access = GitAccess {
        repository: plain.path(),
        protected: &[],
        backups: None,
        write: Ok(()),
        command: None,
        writable: &|_| true,
    };
    assert_eq!(
        call(&access, "git.status", Value::Null, &|| true).unwrap_err(),
        "not_a_git_repository"
    );
    assert!(
        call(&access, "git.push", Value::Null, &|| true)
            .unwrap_err()
            .starts_with("unsupported_host_operation")
    );
}

#[test]
fn closeout_commit_refuses_a_staged_protected_path() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(fixture.root().join(".omd-store")).unwrap();
    std::fs::write(fixture.root().join(".omd-store/state.json"), "private").unwrap();
    git(fixture.root(), &["add", ".omd-store/state.json"]);
    let status = fixture.call("git.status", Value::Null).unwrap();
    let result = fixture.call(
        "git.commit",
        json!({"message":"must refuse", "fingerprint":status["staged_fingerprint"]}),
    );
    assert!(result.is_err(), "committed a protected path: {result:?}");
}

#[test]
#[cfg(unix)]
fn closeout_timeout_stops_hook_descendants() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    std::fs::write(fixture.root().join("a.txt"), "staged").unwrap();
    git(fixture.root(), &["add", "a.txt"]);
    let hook = fixture.root().join(".git/hooks/pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\ntouch hook-started\nsleep 3\ntouch hook-survived\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let result = run(
        &Repository {
            path: fixture.root().to_path_buf(),
            command: None,
        },
        &["commit", "-m", "timeout"],
        None,
        false,
        Duration::from_secs(2),
        &|| true,
    );
    assert!(matches!(result, Err(ref error) if error == "git_timeout"));
    assert!(fixture.root().join("hook-started").exists());
    std::thread::sleep(Duration::from_millis(1500));
    assert!(
        !fixture.root().join("hook-survived").exists(),
        "hook continued after timeout"
    );
}

#[test]
fn closeout_all_writes_check_target_permissions() {
    let fixture = Fixture::new();
    git(fixture.root(), &["branch", "feature"]);
    std::fs::write(fixture.root().join("a.txt"), "staged\n").unwrap();
    git(fixture.root(), &["add", "a.txt"]);
    std::fs::write(fixture.root().join("a.txt"), "unstaged\n").unwrap();
    let status = fixture.call("git.status", Value::Null).unwrap();
    let fingerprint = fixture.entry("a.txt")["fingerprint"].clone();
    let allowed = |path: &Path| canonical(path) != canonical(&fixture.root().join("a.txt"));
    let access = GitAccess {
        repository: fixture.root(),
        protected: &fixture.protected,
        backups: Some(fixture.backups.path()),
        write: Ok(()),
        command: None,
        writable: &allowed,
    };
    let index = std::fs::read(fixture.root().join(".git/index")).unwrap();
    for (operation, args) in [
        (
            "git.stage",
            json!({"paths":["a.txt"],"fingerprint":fingerprint}),
        ),
        (
            "git.unstage",
            json!({"paths":["a.txt"],"fingerprint":fingerprint}),
        ),
        (
            "git.discard",
            json!({"paths":["a.txt"],"fingerprint":fingerprint}),
        ),
        (
            "git.commit",
            json!({"message":"denied","fingerprint":status["staged_fingerprint"]}),
        ),
        (
            "git.switch",
            json!({"branch":"feature","fingerprint":status["fingerprint"]}),
        ),
    ] {
        let error = call(&access, operation, args, &|| true).unwrap_err();
        assert!(
            error.starts_with("git_write_denied_by_permissions"),
            "{operation}: {error}"
        );
    }
    assert_eq!(
        std::fs::read(fixture.root().join(".git/index")).unwrap(),
        index
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root().join("a.txt")).unwrap(),
        "unstaged\n"
    );
    assert_eq!(
        fixture.call("git.status", Value::Null).unwrap()["head"],
        status["head"]
    );
}

#[test]
fn closeout_writes_refuse_subdirectory_scope_and_read_only_metadata() {
    let fixture = Fixture::new();
    let nested = fixture.root().join("nested");
    std::fs::create_dir(&nested).unwrap();
    std::fs::write(fixture.root().join("a.txt"), "changed\n").unwrap();
    let fingerprint = fixture.entry("a.txt")["fingerprint"].clone();
    let args = json!({"paths":["a.txt"],"fingerprint":fingerprint});
    let mut access = GitAccess {
        repository: &nested,
        protected: &[],
        backups: None,
        write: Ok(()),
        command: None,
        writable: &|_| true,
    };
    assert_eq!(
        call(&access, "git.stage", args.clone(), &|| true).unwrap_err(),
        "git_write_requires_repository_root"
    );
    let allowed =
        |path: &Path| !canonical(path).starts_with(canonical(&fixture.root().join(".git")));
    access.repository = fixture.root();
    access.writable = &allowed;
    assert!(
        call(&access, "git.stage", args, &|| true)
            .unwrap_err()
            .starts_with("git_write_denied_by_permissions")
    );
    assert_eq!(fixture.entry("a.txt")["index"], " ");
}

#[test]
fn closeout_directory_stage_checks_children_and_tracks_their_changes() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.root().join("nested")).unwrap();
    std::fs::write(fixture.root().join("nested/a.txt"), "one").unwrap();
    std::fs::write(fixture.root().join("nested/b.txt"), "two").unwrap();
    let status = fixture
        .call("git.status", json!({"paths":["nested"]}))
        .unwrap();
    assert_eq!(status["entries"].as_array().unwrap().len(), 2);
    let allowed = |path: &Path| canonical(path) != canonical(&fixture.root().join("nested/b.txt"));
    let access = GitAccess {
        repository: fixture.root(),
        protected: &[],
        backups: None,
        write: Ok(()),
        command: None,
        writable: &allowed,
    };
    let args = json!({"paths":["nested"], "fingerprint":status["fingerprint"]});
    assert!(
        call(&access, "git.stage", args.clone(), &|| true)
            .unwrap_err()
            .starts_with("git_write_denied_by_permissions")
    );
    std::fs::write(fixture.root().join("nested/a.txt"), "changed after preview").unwrap();
    assert!(
        fixture
            .call("git.stage", args)
            .unwrap_err()
            .starts_with("stale_git_state")
    );
    assert_eq!(fixture.entry("nested/a.txt")["index"], "?");
}

#[test]
#[cfg(unix)]
fn closeout_cancel_stops_hook_descendants() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    std::fs::write(fixture.root().join("a.txt"), "staged").unwrap();
    git(fixture.root(), &["add", "a.txt"]);
    let hook = fixture.root().join(".git/hooks/pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\ntouch hook-started\nsleep 0.3\ntouch hook-survived\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let result = run(
        &Repository {
            path: fixture.root().to_path_buf(),
            command: None,
        },
        &["commit", "-m", "cancelled"],
        None,
        false,
        COMMIT_TIMEOUT,
        &|| !fixture.root().join("hook-started").exists(),
    );
    assert!(matches!(result, Err(ref error) if error == "callback_cancelled"));
    std::thread::sleep(Duration::from_millis(400));
    assert!(!fixture.root().join("hook-survived").exists());
}
