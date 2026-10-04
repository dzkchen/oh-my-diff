use codex_omd::BuiltinControls;
use codex_omd::ContractDocument;
use codex_omd::ContractResolution;
use codex_omd::ContractSelection;
use codex_omd::Gate;
use codex_omd::MOD_API_VERSION;
use codex_omd::ModHost;
use codex_omd::ModStore;
use codex_omd::PolicyOwner;
use codex_omd::Receipt;
use codex_omd::contract_confirmation;
use codex_omd::data_store::Origin;
use codex_omd::host::Authority;
use codex_omd::host::Caller;
use codex_omd::host::ExecAccess;
use codex_omd::host::Host;
use codex_omd::resolve_contract;
use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use tempfile::TempDir;

struct TestAuthority {
    repository: PathBuf,
    read_denied: Vec<PathBuf>,
    write_denied: Vec<PathBuf>,
    sandboxed: std::cell::RefCell<Vec<(bool, bool)>>,
    sockets: std::cell::RefCell<Vec<PathBuf>>,
}

impl Authority for TestAuthority {
    fn repository(&self) -> &Path {
        &self.repository
    }

    fn readable(&self, path: &Path) -> bool {
        !self
            .read_denied
            .iter()
            .any(|denied| path.starts_with(denied))
    }

    fn writable(&self, path: &Path) -> bool {
        self.readable(path)
            && !self
                .write_denied
                .iter()
                .any(|denied| path.starts_with(denied))
    }

    fn command(&self, argv: Vec<String>, access: &ExecAccess<'_>) -> Result<Command, String> {
        self.sandboxed
            .borrow_mut()
            .push((access.write, access.loopback));
        *self.sockets.borrow_mut() = access.unix_sockets.to_vec();
        let mut command = Command::new(&argv[0]);
        command.args(&argv[1..]);
        Ok(command)
    }
}

fn setup() -> (TempDir, PathBuf, PathBuf, TestAuthority) {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let repository = root.join("repo");
    let data = root.join("data");
    std::fs::create_dir_all(repository.join("src")).unwrap();
    std::fs::create_dir_all(repository.join(".git")).unwrap();
    std::fs::create_dir(&data).unwrap();
    std::fs::write(repository.join("src/lib.rs"), "fn main() {}\n").unwrap();
    std::fs::write(repository.join("README.md"), "readme\n").unwrap();
    std::fs::write(repository.join(".gitignore"), "ignored.txt\n").unwrap();
    std::fs::write(repository.join("ignored.txt"), "ignored\n").unwrap();
    std::fs::write(repository.join(".git/config"), "[core]\n").unwrap();
    let authority = TestAuthority {
        repository: repository.clone(),
        read_denied: vec![repository.join("secret")],
        write_denied: vec![repository.join("locked")],
        sandboxed: Default::default(),
        sockets: Default::default(),
    };
    (temp, repository, data, authority)
}

fn caller<'a>(capabilities: &'a [String], environment: &'a [String], origin: Origin) -> Caller<'a> {
    Caller {
        id: "fixture",
        source_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        capabilities,
        exec_environment: environment,
        os_access: None,
        fs_access: None,
        origin,
        thread: Some("thread-1"),
    }
}

// Tests share the `fixture` caller, so parallel exec runs would hit its concurrency cap.
static EXEC: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn exec_slot() -> std::sync::MutexGuard<'static, ()> {
    EXEC.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn owner() -> PolicyOwner {
    PolicyOwner {
        id: "fixture".into(),
        version: "1.0.0".into(),
        source: "fixture".into(),
        sha256: "0".repeat(64),
    }
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn exec_output_artifact_is_paged_and_bound_to_the_caller() {
    let _exec = exec_slot();
    let (_temp, repository, data, authority) = setup();
    let active = || true;
    let host = Host {
        authority: &authority,
        data_root: &data,
        active: &active,
        record_changes: false,
    };
    let capabilities = strings(&["exec"]);
    let owner = caller(&capabilities, &[], Origin::Tool);
    let output = host
        .call(
            &owner,
            "exec.run",
            json!({
                "program":"sh", "argv":["-c", "printf 'é'; printf '%05000d' 0"],
                "output_artifact":true,
            }),
        )
        .unwrap();
    assert_eq!(output["exit_code"], 0);
    assert_eq!(output["stdout_bytes"], 5002);
    assert_eq!(output["stdout_truncated"], false);
    assert_eq!(output["stdout_preview_truncated"], true);
    assert_eq!(output["stdout"].as_str().unwrap().len(), 4096);
    let artifact = output["output_artifact"].clone();
    let first = host
        .call(
            &owner,
            "exec.output_page",
            json!({"artifact":artifact,"max_bytes":1}),
        )
        .unwrap();
    assert_eq!(first["text"], "é");
    assert_eq!(first["cursor"], 2);
    let second = host
        .call(
            &owner,
            "exec.output_page",
            json!({"artifact":artifact,"cursor":2,"max_bytes":16384}),
        )
        .unwrap();
    assert_eq!(second["text"].as_str().unwrap().len(), 5000);
    assert!(second["cursor"].is_null());
    let other = Caller {
        thread: Some("thread-2"),
        ..caller(&capabilities, &[], Origin::Tool)
    };
    assert!(
        host.call(&other, "exec.output_page", json!({"artifact":artifact}))
            .is_err()
    );
    assert!(
        host.call(
            &owner,
            "exec.output_page",
            json!({"artifact":artifact,"cursor":1})
        )
        .is_err()
    );
    let path = data
        .join("exec-output")
        .join(codex_omd::host::repository_key(&repository))
        .join("fixture")
        .join("thread-1")
        .join(owner.source_sha256)
        .join(format!("{}.txt", artifact["sha256"].as_str().unwrap()));
    std::fs::write(path, "changed").unwrap();
    assert!(
        host.call(&owner, "exec.output_page", json!({"artifact":artifact}))
            .is_err()
    );
}

#[test]
fn exec_output_store_evicts_oldest_artifacts_instead_of_failing() {
    let _exec = exec_slot();
    let (_temp, _repository, data, authority) = setup();
    let active = || true;
    let host = Host {
        authority: &authority,
        data_root: &data,
        active: &active,
        record_changes: false,
    };
    let capabilities = strings(&["exec"]);
    let owner = Caller {
        id: "evicting",
        ..caller(&capabilities, &[], Origin::Tool)
    };
    let run = |index: usize| {
        host.call(
            &owner,
            "exec.run",
            json!({"program":"printf", "argv":[format!("artifact-{index}")], "output_artifact":true}),
        )
        .unwrap()["output_artifact"]
            .clone()
    };
    let first = run(0);
    std::thread::sleep(std::time::Duration::from_millis(20));
    let artifacts: Vec<_> = (1..=128).map(run).collect();
    assert!(
        host.call(&owner, "exec.output_page", json!({"artifact":first}))
            .is_err()
    );
    let last = host
        .call(
            &owner,
            "exec.output_page",
            json!({"artifact":artifacts.last().unwrap()}),
        )
        .unwrap();
    assert_eq!(last["text"], "artifact-128");
}

#[test]
fn exec_output_quota_spans_every_thread_and_source_of_a_mod() {
    let _exec = exec_slot();
    let (_temp, _repository, data, authority) = setup();
    let active = || true;
    let host = Host {
        authority: &authority,
        data_root: &data,
        active: &active,
        record_changes: false,
    };
    let capabilities = strings(&["exec"]);
    let threads: Vec<String> = (0..130).map(|index| format!("thread-{index}")).collect();
    let run = |index: usize| {
        let owner = Caller {
            id: "spanning",
            thread: Some(&threads[index]),
            ..caller(&capabilities, &[], Origin::Tool)
        };
        host.call(
            &owner,
            "exec.run",
            json!({"program":"printf", "argv":[format!("artifact-{index}")], "output_artifact":true}),
        )
        .unwrap();
    };
    run(0);
    std::thread::sleep(std::time::Duration::from_millis(20));
    for index in 1..130 {
        run(index);
    }
    let owner = std::fs::read_dir(data.join("exec-output"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .join("spanning");
    let stored = std::fs::read_dir(&owner)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .count();
    assert_eq!(stored, 128);
    assert!(!owner.join("thread-0").exists());
}

#[test]
fn exec_guards_recheck_output_before_a_write() {
    let _exec = exec_slot();
    let (_temp, repository, data, authority) = setup();
    let active = || true;
    let host = Host {
        authority: &authority,
        data_root: &data,
        active: &active,
        record_changes: false,
    };
    let capabilities = strings(&["exec", "fs.write"]);
    let writer = caller(&capabilities, &[], Origin::Tool);
    let input = repository.join("guard-input");
    std::fs::write(&input, "first").unwrap();
    let probe = json!({"program":"sh","argv":["-c","cat guard-input"]});
    let observed = host.call(&writer, "exec.run", probe).unwrap();
    let expected = observed["stdout_sha256"].as_str().unwrap();
    let write = |digest: &str| {
        json!({
            "program":"sh",
            "argv":["-c","printf written > guarded-output"],
            "write":true,
            "guards":[{"program":"sh","argv":["-c","cat guard-input"],"stdout_sha256":digest}],
        })
    };
    let result = host.call(&writer, "exec.run", write(expected)).unwrap();
    assert_eq!(result["guards_verified"], 1);
    assert_eq!(
        std::fs::read_to_string(repository.join("guarded-output")).unwrap(),
        "written"
    );
    assert_eq!(
        &*authority.sandboxed.borrow(),
        &[(false, false), (false, false), (true, false)]
    );

    std::fs::remove_file(repository.join("guarded-output")).unwrap();
    std::fs::write(&input, "changed").unwrap();
    assert_eq!(
        host.call(&writer, "exec.run", write(expected)).unwrap_err(),
        "exec_guard_changed"
    );
    assert!(!repository.join("guarded-output").exists());
    assert_eq!(
        host.call(
            &writer,
            "exec.run",
            json!({"program":"sh","guards":[{"program":"sh","stdout_sha256":expected}]})
        )
        .unwrap_err(),
        "exec_guards_invalid"
    );
    assert_eq!(
        host.call(&writer, "exec.run", write("invalid"))
            .unwrap_err(),
        "exec_guards_invalid"
    );
    let reader_capabilities = strings(&["exec"]);
    let reader = caller(&reader_capabilities, &[], Origin::Tool);
    assert_eq!(
        host.call(&reader, "exec.run", write(expected)).unwrap_err(),
        "capability_denied: fs.write"
    );
}

#[test]
fn exec_guards_fail_closed_on_command_failure_and_truncation() {
    let _exec = exec_slot();
    let (_temp, repository, data, authority) = setup();
    let active = || true;
    let host = Host {
        authority: &authority,
        data_root: &data,
        active: &active,
        record_changes: false,
    };
    let capabilities = strings(&["exec", "fs.write"]);
    let writer = caller(&capabilities, &[], Origin::Tool);
    let digest = "0".repeat(64);
    for script in ["exit 3", "printf err >&2; exit 2"] {
        assert_eq!(
            host.call(
                &writer,
                "exec.run",
                json!({
                    "program":"sh","argv":["-c","touch guarded-output"],"write":true,
                    "guards":[{"program":"sh","argv":["-c",script],"stdout_sha256":digest}],
                })
            )
            .unwrap_err(),
            "exec_guard_failed"
        );
    }
    assert_eq!(
        host.call(&writer, "exec.run", json!({
            "program":"sh","argv":["-c","touch guarded-output"],"write":true,
            "guards":[{"program":"sh","argv":["-c","head -c 1048577 /dev/zero"],"stdout_sha256":digest}],
        })).unwrap_err(),
        "exec_guard_failed"
    );
    assert!(!repository.join("guarded-output").exists());
}

#[test]
fn workspace_access_checks_named_paths_and_guarded_write_authority() {
    let _exec = exec_slot();
    let (_temp, repository, data, authority) = setup();
    let active = || true;
    let host = Host {
        authority: &authority,
        data_root: &data,
        active: &active,
        record_changes: false,
    };
    let write_capabilities = strings(&["exec", "fs.write"]);
    let reader_capabilities = strings(&["exec", "fs.read"]);
    let writer = caller(&write_capabilities, &[], Origin::Tool);
    let reader = caller(&reader_capabilities, &[], Origin::Tool);
    assert_eq!(
        host.call(
            &writer,
            "workspace.check_access",
            json!({"paths":["README.md"],"write":true})
        )
        .unwrap(),
        json!({"paths":["README.md"],"write":true})
    );
    assert_eq!(
        host.call(
            &reader,
            "workspace.check_access",
            json!({"paths":["README.md"],"write":true})
        )
        .unwrap_err(),
        "capability_denied: fs.write"
    );
    assert_eq!(
        host.call(
            &writer,
            "workspace.check_access",
            json!({"paths":["locked/file"],"write":true})
        )
        .unwrap_err(),
        "workspace_write_permission_denied"
    );
    let observed = host
        .call(
            &writer,
            "exec.run",
            json!({"program":"sh","argv":["-c","printf unchanged"]}),
        )
        .unwrap();
    let guard = json!({"program":"sh","argv":["-c","printf unchanged"],"stdout_sha256":observed["stdout_sha256"]});
    assert_eq!(
        host.call(
            &writer,
            "exec.run",
            json!({
                "program":"sh","argv":["-c","printf written > guarded-output"],"write":true,
                "guards":[guard],"required_access":{"write":["locked/file"]},
            })
        )
        .unwrap_err(),
        "workspace_write_permission_denied"
    );
    assert!(!repository.join("guarded-output").exists());
    assert_eq!(
        host.call(
            &writer,
            "exec.run",
            json!({
                "program":"sh","write":false,"required_access":{"write":["README.md"]},
            })
        )
        .unwrap_err(),
        "exec_access_requires_write"
    );
}

#[test]
fn exec_run_admits_only_inherited_user_sockets() {
    let _exec = exec_slot();
    let (temp, repository, data, authority) = setup();
    let active = || true;
    let host = Host {
        authority: &authority,
        data_root: &data,
        active: &active,
        record_changes: false,
    };
    let socket = temp.path().canonicalize().unwrap().join("integration.sock");
    let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let inside = repository.join("integration.sock");
    let _inside = std::os::unix::net::UnixListener::bind(&inside).unwrap();
    let name = "EXEC_SOCKET_FIXTURE";
    let environment = strings(&[name]);
    let capabilities = strings(&["exec", "unix_sockets"]);
    let run = |capabilities: &[String], name: &str| {
        host.call(
            &caller(capabilities, &environment, Origin::Tool),
            "exec.run",
            json!({"program":"sh","argv":["-c","true"],"unix_sockets":[name]}),
        )
    };
    assert_eq!(
        run(&strings(&["exec", "network"]), name).unwrap_err(),
        "capability_denied: unix_sockets"
    );
    assert_eq!(
        run(&capabilities, "UNDECLARED").unwrap_err(),
        "exec_arguments_invalid"
    );
    for value in [
        None,
        Some(Path::new("integration.sock")),
        Some(repository.join("README.md").as_path()),
        Some(inside.as_path()),
        Some(socket.as_path()),
    ] {
        // SAFETY: only this test reads this variable.
        unsafe {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        let result = run(&capabilities, name);
        if value == Some(socket.as_path()) {
            assert_eq!(result.unwrap()["exit_code"], 0);
            assert_eq!(*authority.sockets.borrow(), vec![socket.clone()]);
        } else {
            assert_eq!(result.unwrap_err(), "exec_socket_unavailable");
        }
    }
}

#[test]
fn exec_run_bounds_program_environment_output_time_and_authority() {
    let _exec = exec_slot();
    let (_temp, repository, data, authority) = setup();
    let active = || true;
    let host = Host {
        authority: &authority,
        data_root: &data,
        active: &active,
        record_changes: false,
    };
    let capabilities = strings(&["exec"]);
    let environment = strings(&["OMD_EXEC_FIXTURE_NAME"]);
    let reader = caller(&capabilities, &environment, Origin::Tool);
    assert_eq!(
        host.call(
            &reader,
            "exec.run",
            json!({"program":"sh","env":{"FIXTURE_ENV":"x"}})
        )
        .unwrap_err(),
        "exec_arguments_invalid"
    );
    let environment = strings(&["FIXTURE_ENV"]);
    let reader = caller(&capabilities, &environment, Origin::Tool);
    let result = host
        .call(
            &reader,
            "exec.run",
            json!({"program":"sh","argv":["-c","printf \"$FIXTURE_ENV|%s|$HOME\" \"$(pwd -P)\"; printf err >&2"],
                "cwd":"src","env":{"FIXTURE_ENV":"value"}}),
        )
        .unwrap();
    let stdout = result["stdout"].as_str().unwrap();
    assert!(
        stdout.starts_with(&format!("value|{}|", repository.join("src").display())),
        "{stdout}"
    );
    assert!(!stdout.ends_with(&repository.display().to_string()));
    assert_eq!(result["stderr"], "err");
    assert_eq!(result["exit_code"], 0);
    assert_eq!(result["timed_out"], false);
    assert_eq!(result["program"]["sha256"].as_str().unwrap().len(), 64);
    assert_eq!(authority.sandboxed.borrow().last(), Some(&(false, false)));

    let denied = host
        .call(
            &reader,
            "exec.run",
            json!({"program":"sh","argv":["-c","true"],"env":{"PATH":"/tmp"}}),
        )
        .unwrap_err();
    assert_eq!(denied, "exec_arguments_invalid");
    assert_eq!(
        host.call(&reader, "exec.run", json!({"program":"sh","write":true}))
            .unwrap_err(),
        "capability_denied: fs.write"
    );
    assert_eq!(
        host.call(
            &reader,
            "exec.run",
            json!({"program":"sh","network":"loopback"})
        )
        .unwrap_err(),
        "capability_denied: network"
    );
    assert_eq!(
        host.call(&reader, "exec.run", json!({"program":"sh","cwd":"../"}))
            .unwrap_err(),
        "exec_cwd_invalid"
    );
    assert_eq!(
        host.call(
            &reader,
            "exec.run",
            json!({"program":"sh","sha256":"0".repeat(64)})
        )
        .unwrap_err(),
        "exec_program_changed"
    );
    assert_eq!(
        host.call(&reader, "exec.run", json!({"program":"../sh"}))
            .unwrap_err(),
        "exec_program_unavailable"
    );
    let truncated = host
        .call(
            &reader,
            "exec.run",
            json!({"program":"sh","argv":["-c","printf 0123456789"],"max_output_bytes":4}),
        )
        .unwrap();
    assert_eq!(truncated["stdout"], "0123");
    assert_eq!(truncated["stdout_truncated"], true);
    let slow = host
        .call(
            &reader,
            "exec.run",
            json!({"program":"sh","argv":["-c","sleep 5"],"timeout_ms":100}),
        )
        .unwrap();
    assert_eq!(slow["timed_out"], true);
    assert!(slow["duration_ms"].as_u64().unwrap() < 4000);
    let started = std::time::Instant::now();
    let detached = host
        .call(
            &reader,
            "exec.run",
            json!({"program":"sh","argv":["-c","perl -e 'setpgrp(0,0); sleep 5' & sleep 0.1; exit 0"],"timeout_ms":300}),
        )
        .unwrap();
    assert_eq!(detached["timed_out"], true);
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    let wide = host
        .call(
            &reader,
            "exec.run",
            json!({"program":"sh","argv":["-c","head -c 100000 /dev/zero | tr '\\0' x"]}),
        )
        .unwrap();
    assert_eq!(wide["stdout"].as_str().unwrap().len(), 65_536);
    assert_eq!(wide["stdout_bytes"], 100_000);
    assert_eq!(wide["stdout_truncated"], false);
    assert_eq!(wide["stdout_preview_truncated"], true);

    let writer_capabilities = strings(&["exec", "fs.write", "network"]);
    let writer = caller(&writer_capabilities, &[], Origin::UserCommand);
    let written = host
        .call(&writer, "exec.run", json!({"program":"sh","argv":["-c","printf x > out.txt"],"write":true,"network":"loopback"}))
        .unwrap();
    assert_eq!(written["exit_code"], 0);
    assert_eq!(
        std::fs::read_to_string(repository.join("out.txt")).unwrap(),
        "x"
    );
    assert_eq!(authority.sandboxed.borrow().last(), Some(&(true, true)));
    std::fs::create_dir(repository.join("locked")).unwrap();
    assert_eq!(
        host.call(
            &writer,
            "exec.run",
            json!({"program":"sh","cwd":"locked","write":true})
        )
        .unwrap_err(),
        "exec_cwd_unavailable"
    );

    let cancelled = std::cell::Cell::new(0);
    let active = || {
        cancelled.set(cancelled.get() + 1);
        cancelled.get() < 20
    };
    let host = Host {
        authority: &authority,
        data_root: &data,
        active: &active,
        record_changes: false,
    };
    let started = std::time::Instant::now();
    assert_eq!(
        host.call(
            &reader,
            "exec.run",
            json!({"program":"sh","argv":["-c","sleep 5"]})
        )
        .unwrap_err(),
        "exec_cancelled"
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(4));
}

#[test]
fn workspace_listing_stat_backup_and_restore_respect_scope_and_preconditions() {
    let (_temp, repository, data, authority) = setup();
    let active = || true;
    let host = Host {
        authority: &authority,
        data_root: &data,
        active: &active,
        record_changes: true,
    };
    codex_omd::observe_workspace_changes(&repository, true);
    std::fs::create_dir(repository.join("secret")).unwrap();
    std::fs::write(repository.join("secret/key"), "k").unwrap();
    let capabilities = strings(&["fs.read", "fs.write"]);
    let reader = caller(&capabilities, &[], Origin::Tool);
    let listed = host
        .call(&reader, "workspace.list", json!({"recursive":true}))
        .unwrap();
    let paths = listed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert!(paths.contains(&"src/lib.rs".to_owned()));
    assert!(paths.contains(&"README.md".to_owned()));
    assert!(
        !paths
            .iter()
            .any(|path| path.starts_with(".git/") || path == ".git")
    );
    assert!(!paths.contains(&"ignored.txt".to_owned()));
    assert!(!paths.iter().any(|path| path.starts_with("secret")));
    let all = host
        .call(&reader, "workspace.list", json!({"include_ignored":true}))
        .unwrap();
    assert!(
        all["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == "ignored.txt")
    );
    let limited = host
        .call(
            &reader,
            "workspace.list",
            json!({"recursive":true,"max_entries":1}),
        )
        .unwrap();
    assert_eq!(limited["truncated"], true);

    let stat = host
        .call(
            &reader,
            "workspace.stat",
            json!({"paths":["README.md","missing.md","src"],"hash":true}),
        )
        .unwrap();
    assert_eq!(stat["files"]["README.md"]["kind"], "file");
    assert_eq!(stat["files"]["README.md"]["size"], 7);
    assert_eq!(
        stat["files"]["README.md"]["sha256"].as_str().unwrap().len(),
        64
    );
    assert!(stat["files"]["missing.md"].is_null());
    assert_eq!(stat["files"]["src"]["kind"], "dir");
    assert_eq!(
        host.call(&reader, "workspace.stat", json!({"paths":["secret/key"]}))
            .unwrap_err(),
        "workspace_read_permission_denied"
    );

    let readme = stat["files"]["README.md"].clone();
    let fingerprint = json!({"size": readme["size"], "mtime_ms": readme["mtime_ms"]});
    let backup = host
        .call(
            &reader,
            "workspace.backup",
            json!({"expected":{"README.md":fingerprint,"new.md":null}}),
        )
        .unwrap()["backup"]
        .clone();
    let changed = host
        .call(
            &reader,
            "workspace.transaction",
            json!({"expected":{"README.md":readme["sha256"],"new.md":null},
                "writes":{"new.md":"new\n"},"deletes":["README.md"],"backup":true}),
        )
        .unwrap();
    assert!(!repository.join("README.md").exists());
    assert_eq!(changed["backup"]["sha256"].as_str().unwrap().len(), 64);
    let recorded = codex_omd::take_workspace_changes(&repository);
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].source, "transaction");
    let paths = recorded[0]
        .changes
        .as_ref()
        .unwrap()
        .iter()
        .map(|change| change.path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(paths, ["README.md", "new.md"]);
    let new_hash = changed["files"]["new.md"].clone();
    let stale = host
        .call(
            &reader,
            "workspace.restore",
            json!({"backup":backup,"expected":{"README.md":null,"new.md":"0".repeat(64)}}),
        )
        .unwrap_err();
    assert!(stale.contains("stale"), "{stale}");
    host.call(
        &reader,
        "workspace.restore",
        json!({"backup":backup,"expected":{"README.md":null,"new.md":new_hash}}),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(repository.join("README.md")).unwrap(),
        "readme\n"
    );
    assert!(!repository.join("new.md").exists());
    let other_capabilities = strings(&["fs.write"]);
    let other = Caller {
        id: "other",
        ..caller(&other_capabilities, &[], Origin::Tool)
    };
    assert_eq!(
        host.call(
            &other,
            "workspace.restore",
            json!({"backup":backup,"expected":{"README.md":null,"new.md":null}})
        )
        .unwrap_err(),
        "backup_unavailable"
    );
    std::fs::create_dir(repository.join("locked")).unwrap();
    assert_eq!(
        host.call(
            &reader,
            "workspace.transaction",
            json!({"expected":{"locked/a":null},"writes":{"locked/a":"x"}})
        )
        .unwrap_err(),
        "workspace_write_permission_denied"
    );
}

#[test]
fn store_is_namespaced_compare_and_set_with_host_attested_provenance() {
    let (_temp, _repository, data, authority) = setup();
    let active = || true;
    let host = Host {
        authority: &authority,
        data_root: &data,
        active: &active,
        record_changes: false,
    };
    let capabilities = strings(&["store"]);
    let tool = caller(&capabilities, &[], Origin::Tool);
    let command = caller(&capabilities, &[], Origin::UserCommand);
    assert!(
        host.call(&tool, "store.get", json!({"key":"lesson/1"}))
            .unwrap()
            .is_null()
    );
    assert_eq!(
        host.call(
            &tool,
            "store.put",
            json!({"key":"lesson/1","value":{"text":"x"}})
        )
        .unwrap_err(),
        "store_expected_revision_required"
    );
    let first = host
        .call(
            &tool,
            "store.put",
            json!({"key":"lesson/1","value":{"text":"x"},"expected_revision":null}),
        )
        .unwrap();
    let revision = first["revision"].as_u64().unwrap();
    assert!(
        host.call(
            &tool,
            "store.put",
            json!({"key":"lesson/1","value":1,"expected_revision":null})
        )
        .unwrap_err()
        .starts_with("store_revision_conflict")
    );
    let promoted = host
        .call(&command, "store.put", json!({"key":"lesson/1","value":{"text":"x","promoted":true},"expected_revision":revision}))
        .unwrap();
    let read = host
        .call(&tool, "store.get", json!({"key":"lesson/1"}))
        .unwrap();
    assert_eq!(read["revision"], promoted["revision"]);
    assert_eq!(read["provenance"]["origin"], "user_command");
    assert_eq!(read["provenance"]["mod"], "fixture");
    assert_eq!(read["provenance"]["thread_id"], "thread-1");
    for index in 0..3 {
        host.call(
            &tool,
            "store.put",
            json!({"key":format!("note/{index}"),"value":index,"expected_revision":null}),
        )
        .unwrap();
    }
    let page = host
        .call(&tool, "store.list", json!({"prefix":"note/","limit":2}))
        .unwrap();
    assert_eq!(page["keys"].as_array().unwrap().len(), 2);
    let rest = host
        .call(
            &tool,
            "store.list",
            json!({"prefix":"note/","cursor":page["cursor"]}),
        )
        .unwrap();
    assert_eq!(rest["keys"][0]["key"], "note/2");
    assert!(rest["cursor"].is_null());
    host.call(
        &tool,
        "store.put",
        json!({"key":"pref","value":true,"expected_revision":null,"scope":"user"}),
    )
    .unwrap();
    assert!(
        host.call(&tool, "store.get", json!({"key":"pref"}))
            .unwrap()
            .is_null()
    );
    let other = Caller {
        id: "other",
        ..caller(&capabilities, &[], Origin::Tool)
    };
    assert!(
        host.call(&other, "store.get", json!({"key":"lesson/1"}))
            .unwrap()
            .is_null()
    );
    let exported = host.call(&tool, "store.export", json!({})).unwrap();
    assert_eq!(exported["entries"].as_object().unwrap().len(), 4);
    assert!(exported["cursor"].is_null());
    for key in ["wide/1", "wide/2"] {
        host.call(
            &tool,
            "store.put",
            json!({"key":key,"value":"x".repeat(40_000),"expected_revision":null}),
        )
        .unwrap();
    }
    let first = host.call(&tool, "store.export", json!({})).unwrap();
    let rest = host
        .call(&tool, "store.export", json!({"cursor":first["cursor"]}))
        .unwrap();
    assert_eq!(first["entries"].as_object().unwrap().len(), 5);
    assert_eq!(rest["entries"].as_object().unwrap().len(), 1);
    assert!(rest["cursor"].is_null());
    assert_eq!(
        host.call(&tool, "store.reset", json!({"expected_generation":9}))
            .unwrap_err(),
        "store_generation_conflict"
    );
    let generation = page["generation"].as_u64().unwrap();
    assert_eq!(
        host.call(
            &tool,
            "store.reset",
            json!({"expected_generation":generation})
        )
        .unwrap()["generation"],
        generation + 1
    );
    assert!(
        host.call(&tool, "store.get", json!({"key":"lesson/1"}))
            .unwrap()
            .is_null()
    );
    assert!(
        host.call(&tool, "store.get", json!({"key":"pref","scope":"user"}))
            .unwrap()
            .is_object()
    );
    assert_eq!(
        host.call(
            &tool,
            "store.put",
            json!({"key":"big","value":"x".repeat(300_000),"expected_revision":null})
        )
        .unwrap_err(),
        "store_value_limit"
    );
    assert_eq!(
        host.call(&tool, "store.get", json!({"key":"bad\\key"}))
            .unwrap_err(),
        "store_key_invalid"
    );
    let inactive = || false;
    let cancelled = Host {
        authority: &authority,
        data_root: &data,
        active: &inactive,
        record_changes: false,
    };
    assert_eq!(
        cancelled
            .call(
                &tool,
                "store.put",
                json!({"key":"late","value":1,"expected_revision":null})
            )
            .unwrap_err(),
        "host_operation_cancelled"
    );
}

#[test]
fn contract_documents_gate_on_bound_receipts_and_detect_weaker_selections() {
    let strict = ContractDocument::parse(&json!({
        "schema":2,"id":"reviewed","version":1,"description":"Separate review before completion",
        "assurance":"independently_reviewed",
        "gates":{"complete":[{"receipt":"review","producer":"separate_agent","bind":["candidate"]},
                             {"receipt":"checks","bind":["candidate","acceptance"]}],
                 "integrate":[{"receipt":"checks","bind":["candidate"]}]},
        "restrict":["agents.spawn"]}))
    .unwrap();
    let solo = ContractDocument::parse(&json!({
        "schema":2,"id":"solo","version":1,"description":"Self review","assurance":"self_reviewed",
        "gates":{"complete":[{"receipt":"review","producer":"lead","bind":["candidate"]}]}}))
    .unwrap();
    assert!(solo.weaker_than(&strict));
    assert!(!strict.weaker_than(&solo) || strict.restrict != solo.restrict);
    assert!(!strict.weaker_than(&strict));
    for invalid in [
        json!({"schema":1,"id":"x","version":1,"description":"d","assurance":"a"}),
        json!({"schema":2,"id":"X","version":1,"description":"d","assurance":"a"}),
        json!({"schema":2,"id":"x","version":1,"description":"d","assurance":"a","restrict":["git.status"]}),
        json!({"schema":2,"id":"x","version":1,"description":"d","assurance":"a","gates":{"complete":[{"receipt":"a"},{"receipt":"a"}]}}),
    ] {
        assert!(ContractDocument::parse(&invalid).is_err(), "{invalid}");
    }
    let candidate = "a".repeat(64);
    let acceptance = "b".repeat(64);
    let receipt = |kind: &str, producer: &str, handle: Option<&str>, blocking: bool| -> Receipt {
        serde_json::from_value(json!({
            "kind":kind,"candidate_sha256":candidate,"acceptance_sha256":acceptance,"outcome":"pass",
            "evidence":{"reference":"c".repeat(64),"sha256":"c".repeat(64)},
            "producer":{"kind":producer,"handle":handle},
            "findings": if blocking { json!([{"fingerprint":"f","severity":"blocking","summary":"s"}]) } else { json!([]) },
            "submitted_by":"fixture","at":1}))
        .unwrap()
    };
    let missing = strict.missing(Gate::Complete, &[], &candidate, Some(&acceptance));
    assert_eq!(missing.len(), 2);
    let lead_review = receipt("review", "lead", None, false);
    let checks = receipt("checks", "lead", None, false);
    assert_eq!(
        strict.missing(
            Gate::Complete,
            &[lead_review, checks.clone()],
            &candidate,
            Some(&acceptance)
        )[0]
        .receipt,
        "review"
    );
    let blocked = receipt("review", "agent", Some("h1"), true);
    assert_eq!(
        strict
            .missing(
                Gate::Complete,
                &[blocked, checks.clone()],
                &candidate,
                Some(&acceptance)
            )
            .len(),
        1
    );
    let clean = receipt("review", "agent", Some("h1"), false);
    assert!(clean.validate().is_ok());
    assert!(
        strict
            .missing(
                Gate::Complete,
                &[clean.clone(), checks.clone()],
                &candidate,
                Some(&acceptance)
            )
            .is_empty()
    );
    assert_eq!(
        strict
            .missing(
                Gate::Complete,
                &[clean, checks],
                &"d".repeat(64),
                Some(&acceptance)
            )
            .len(),
        2
    );
    let integration = ContractDocument::parse(&json!({
        "schema":2,"id":"integration","version":1,"description":"Host-integrated result","assurance":"checked",
        "gates":{"complete":[{"receipt":"workspace_integration","producer":"integration","bind":["acceptance"]}]}})).unwrap();
    let command = receipt("workspace_integration", "host", None, false);
    assert_eq!(
        integration
            .missing(Gate::Complete, &[command], &candidate, Some(&acceptance))
            .len(),
        1
    );
    let applied = receipt("workspace_integration", "integration", None, false);
    assert!(
        integration
            .missing(Gate::Complete, &[applied], &candidate, Some(&acceptance))
            .is_empty()
    );
}

#[test]
fn finding_receipt_replay_requires_explicit_independent_resolution() {
    let receipt =
        |candidate: &str, acceptance: &str, agent: &str, findings: Value, resolves: Value| {
            serde_json::from_value::<Receipt>(json!({"kind":"review","candidate_sha256":candidate,
            "acceptance_sha256":acceptance,"outcome":"pass",
            "evidence":{"reference":"native-thread:fixture","sha256":"d".repeat(64)},
            "producer":{"kind":"agent","handle":agent},"findings":findings,
            "resolves":resolves,"submitted_by":"fixture","at":1}))
            .unwrap()
        };
    let candidate = "a".repeat(64);
    let changed = "b".repeat(64);
    let acceptance = "c".repeat(64);
    let blocker = receipt(
        &candidate,
        &acceptance,
        "first",
        json!([{"fingerprint":"issue.one","severity":"blocking","summary":"Broken"}]),
        json!([]),
    );
    let clean = receipt(&changed, &acceptance, "second", json!([]), json!([]));
    let ledger = codex_omd::replay_finding_receipts(&[blocker.clone(), clean]).unwrap();
    assert!(ledger["issue.one"].resolution.is_none());
    let repeated = receipt(
        &changed,
        &"e".repeat(64),
        "second",
        json!([{"fingerprint":"issue.one","severity":"blocking","summary":"Still broken"}]),
        json!([]),
    );
    let replayed = codex_omd::replay_finding_receipts(&[blocker.clone(), repeated]).unwrap();
    assert_eq!(replayed["issue.one"].reported_candidate_sha256, candidate);
    assert_eq!(replayed["issue.one"].acceptance_sha256, acceptance);
    assert_eq!(
        replayed["issue.one"].reported_producer.handle.as_deref(),
        Some("first")
    );
    assert!(replayed["issue.one"].resolution.is_none());
    for invalid in [
        receipt(
            &candidate,
            &acceptance,
            "second",
            json!([]),
            json!(["issue.one"]),
        ),
        receipt(
            &changed,
            &acceptance,
            "first",
            json!([]),
            json!(["issue.one"]),
        ),
        receipt(
            &changed,
            &"e".repeat(64),
            "second",
            json!([]),
            json!(["issue.one"]),
        ),
    ] {
        assert!(codex_omd::replay_finding_receipts(&[blocker.clone(), invalid]).is_err());
    }
    let resolved = codex_omd::replay_finding_receipts(&[
        blocker,
        receipt(
            &changed,
            &acceptance,
            "second",
            json!([]),
            json!(["issue.one"]),
        ),
    ])
    .unwrap();
    assert_eq!(
        resolved["issue.one"]
            .resolution
            .as_ref()
            .unwrap()
            .producer
            .handle
            .as_deref(),
        Some("second")
    );
    let reopened = codex_omd::replay_finding_receipts(&[
        receipt(
            &candidate,
            &acceptance,
            "first",
            json!([{"fingerprint":"issue.one","severity":"blocking","summary":"Broken"}]),
            json!([]),
        ),
        receipt(
            &changed,
            &acceptance,
            "second",
            json!([]),
            json!(["issue.one"]),
        ),
        receipt(
            &"f".repeat(64),
            &acceptance,
            "third",
            json!([{"fingerprint":"issue.one","severity":"blocking","summary":"Regressed"}]),
            json!([]),
        ),
    ])
    .unwrap();
    assert!(reopened["issue.one"].resolution.is_none());
    assert_eq!(
        reopened["issue.one"].reported_producer.handle.as_deref(),
        Some("third")
    );
}

#[test]
fn contract_selection_pins_digests_applies_the_project_floor_and_fails_closed() {
    let document = |id: &str, gates: Value| {
        ContractDocument::parse(&json!({"schema":2,"id":id,"version":1,"description":"d",
            "assurance":"a","gates":gates}))
        .unwrap()
    };
    let strict = document(
        "strict",
        json!({"complete":[{"receipt":"review","producer":"separate_agent"}]}),
    );
    let solo = document(
        "solo",
        json!({"complete":[{"receipt":"review","producer":"lead"}]}),
    );
    let documents = vec![(strict.clone(), owner()), (solo.clone(), owner())];
    let pick = |key: &str, digest: Option<String>| ContractSelection {
        schema: 2,
        contract: Some(key.into()),
        contract_digest: digest,
        ..ContractSelection::default()
    };
    let floor = ContractSelection {
        schema: 2,
        floor: Some("strict@1".into()),
        floor_digest: Some(strict.digest()),
        ..ContractSelection::default()
    };
    assert_eq!(
        resolve_contract(&documents, None, None),
        ContractResolution::None
    );
    let solo_pick = pick("solo@1", Some(solo.digest()));
    match resolve_contract(&documents, Some(&solo_pick), None) {
        ContractResolution::Active {
            document, source, ..
        } => {
            assert_eq!((document.key(), source), ("solo@1".to_owned(), "user"));
        }
        other => panic!("{other:?}"),
    }
    match resolve_contract(&documents, Some(&solo_pick), Some(&floor)) {
        ContractResolution::Active {
            document,
            source,
            overrode,
            ..
        } => {
            assert_eq!(document.key(), "strict@1");
            assert_eq!(source, "project_floor");
            assert_eq!(overrode.as_deref(), Some("solo@1"));
        }
        other => panic!("{other:?}"),
    }
    let changed = pick("solo@1", Some("0".repeat(64)));
    assert!(matches!(
        resolve_contract(&documents, Some(&changed), None),
        ContractResolution::Unavailable(_)
    ));
    assert!(matches!(
        resolve_contract(&documents, Some(&pick("missing@1", None)), None),
        ContractResolution::Unavailable(_)
    ));
    let before = contract_confirmation(Some(&strict), &solo);
    assert_eq!(before.len(), 16);
    assert_ne!(before, contract_confirmation(None, &solo));
    let directory = TempDir::new().unwrap();
    let path = directory.path().join(".omd/contract-selection.json");
    floor.write(&path).unwrap();
    assert_eq!(ContractSelection::read(&path).unwrap(), Some(floor));
    std::fs::write(&path, br#"{"schema":2,"contract":"Bad Key"}"#).unwrap();
    assert!(ContractSelection::read(&path).is_err());
    std::fs::write(&path, br#"{"schema":1,"contract":"solo@1"}"#).unwrap();
    assert!(ContractSelection::read(&path).is_err());
}

#[test]
fn builtin_controls_protect_recovery_commands() {
    assert!(
        BuiltinControls::parse(&json!({"commands":{"hide":["plan"]},"modes":{"disable":["plan"]}}))
            .is_ok()
    );
    for invalid in [
        json!({"commands":{"hide":["omd"]}}),
        json!({"modes":{"disable":["default"]}}),
        json!({"commands":{"hide":["Plan"]}}),
        json!({"other":true}),
    ] {
        assert!(BuiltinControls::parse(&invalid).is_err(), "{invalid}");
    }
}

fn node() -> PathBuf {
    PathBuf::from(std::env::var_os("OMD_TEST_NODE").expect("set OMD_TEST_NODE to Node 24.18.0"))
}

fn package(
    root: &Path,
    id: &str,
    manifest: Value,
    source: &str,
    files: &[(&str, &str)],
) -> PathBuf {
    let path = root.join(id);
    std::fs::create_dir(&path).unwrap();
    let mut manifest = manifest;
    manifest["schema"] = json!(1);
    manifest["id"] = json!(id);
    manifest["version"] = json!("1.0.0");
    manifest["api"] = json!(MOD_API_VERSION);
    manifest["state_version"] = json!(1);
    std::fs::write(
        path.join("mod.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(path.join("index.ts"), source).unwrap();
    for (name, content) in files {
        std::fs::write(path.join(name), content).unwrap();
    }
    path
}

fn trust(store: &ModStore, path: &Path) {
    let inspected = ModStore::inspect_package(path).unwrap();
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(path.join("mod.json")).unwrap()).unwrap();
    let granted = manifest["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    for _ in 0..200 {
        match store.trust(
            path.to_path_buf(),
            inspected["sha256"].as_str().unwrap(),
            granted.clone(),
            "user",
        ) {
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            result => {
                result.unwrap();
                break;
            }
        }
    }
    store.enable(path, true).unwrap();
}

#[test]
fn outside_author_uses_owned_asset_and_paged_exec_output() {
    let (temp, repository, data, authority) = setup();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    let package = package(
        &root,
        "asset_probe",
        json!({"capabilities":["commands","exec"],"assets":["worker.mjs"]}),
        "export default api => api.command('run', () => { const script = api.assets.read('worker.mjs'); const own = api.assets.read('index.ts'); const output = api.host.call('exec.run', {program:'node', argv:['--input-type=module'], stdin:script.text, output_artifact:true}); const page = api.host.call('exec.output_page', {artifact:output.output_artifact}); return {text:page.text, asset_sha256:script.sha256, own_sha256:own.sha256}; });",
        &[("worker.mjs", "process.stdout.write('X'.repeat(5000))")],
    );
    trust(&store, &package);
    let mut runtime = ModHost::open(root.join("store")).unwrap();
    assert_eq!(error_of(&runtime, "asset_probe"), "");
    let selected = ModStore::inspect_package(&package).unwrap()["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    let capabilities = strings(&["exec"]);
    let owner = Caller {
        id: "asset_probe",
        source_sha256: &selected,
        capabilities: &capabilities,
        exec_environment: &[],
        os_access: None,
        fs_access: None,
        origin: Origin::UserCommand,
        thread: Some("thread-1"),
    };
    let active = || true;
    let host = Host {
        authority: &authority,
        data_root: &data,
        active: &active,
        record_changes: false,
    };
    let result = runtime
        .invoke_with(
            "asset_probe",
            runtime.generation(),
            "command",
            "run",
            Value::Null,
            || true,
            |call| {
                host.call(&owner, &call.operation, call.arguments)
                    .map_err(std::io::Error::other)
            },
        )
        .unwrap();
    assert_eq!(result["text"].as_str().unwrap(), "X".repeat(5000));
    assert_eq!(result["asset_sha256"].as_str().unwrap().len(), 64);
    assert_eq!(result["own_sha256"].as_str().unwrap().len(), 64);
    assert!(!repository.join("worker.mjs").exists());
}

fn error_of(host: &ModHost, id: &str) -> String {
    let status = host.status();
    status["mods"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == id)
        .and_then(|item| item["error"].as_str())
        .map(str::to_owned)
        .or_else(|| {
            status["rejected"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["path"].as_str().is_some_and(|path| path.ends_with(id)))
                .and_then(|item| item["reason"].as_str())
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

#[test]
fn current_api_packages_use_authority_classes_builtins_contracts_and_adapters() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    let modern = package(
        &root,
        "modern",
        json!({"capabilities":["commands","store","exec","builtins","contracts","terminal"],"exec_environment":["FIXTURE_ENV"]}),
        "export default api => { api.builtins({commands:{hide:['plan']},modes:{disable:['plan']}}); \
         api.contract({schema:2,id:'fixture',version:1,description:'Fixture gate',assurance:'checked',gates:{complete:[{receipt:'checks',bind:['candidate']}]}}); \
         api.command('run', () => { api.state.set({ran:true}); const out = api.host.call('exec.run', {program:'sh', argv:['-c','true']}); return api.host.call('store.put', {key:'k', value:out.exit_code, expected_revision:null}); }); }",
        &[],
    );
    trust(&store, &modern);
    let legacy_names = package(
        &root,
        "legacy_names",
        json!({"capabilities":["state","commands"]}),
        "export default api => api.command('x', () => api.state.get())",
        &[],
    );
    assert!(
        ModStore::inspect_package(&legacy_names)
            .unwrap_err()
            .to_string()
            .contains("capability")
    );
    let old_event = package(
        &root,
        "old_event",
        json!({"capabilities":["lifecycle"]}),
        "export default api => api.on('worker_context', () => null)",
        &[],
    );
    trust(&store, &old_event);
    let adapter = package(
        &root,
        "adapter",
        json!({"capabilities":[],"assets":["adapt.ts","shim.mjs"],"adapter_module":{"entry":"adapt.ts","aliases":{"shim":"shim.mjs"}}}),
        "export default () => {}",
        &[
            (
                "adapt.ts",
                "export default api => ({ register(name: string, value: number) { api.command(name, () => value); } });",
            ),
            ("shim.mjs", "export const answer = 42;"),
        ],
    );
    trust(&store, &adapter);
    let adapted = package(
        &root,
        "adapted",
        json!({"capabilities":["commands"],"adapter":"adapter","dependencies":[{"id":"adapter","version":"^1.0.0"}]}),
        "import { answer } from 'shim'; export default host => host.register('answer', answer);",
        &[],
    );
    trust(&store, &adapted);
    let mut runtime = ModHost::open(root.join("store")).unwrap();
    assert!(
        error_of(&runtime, "old_event").contains("unsupported_event"),
        "{}",
        error_of(&runtime, "old_event")
    );
    assert_eq!(error_of(&runtime, "modern"), "");
    assert_eq!(error_of(&runtime, "adapted"), "");
    assert_eq!(
        runtime
            .invoke(
                "adapted",
                runtime.generation(),
                "command",
                "answer",
                Value::Null
            )
            .unwrap(),
        json!(42)
    );
    let controls = runtime.builtin_controls();
    assert_eq!(controls.len(), 1);
    assert_eq!(controls[0].1.commands.hide, vec!["plan"]);
    let documents = runtime.contract_documents();
    assert_eq!(documents[0].0.key(), "fixture@1");
    let mut calls = Vec::new();
    let result = runtime
        .invoke_with(
            "modern",
            runtime.generation(),
            "command",
            "run",
            Value::Null,
            || true,
            |call| {
                calls.push(call.operation.clone());
                Ok(if call.operation == "exec.run" {
                    json!({"exit_code":0})
                } else {
                    json!({"revision":1})
                })
            },
        )
        .unwrap();
    assert_eq!(result, json!({"revision":1}));
    assert_eq!(calls, vec!["exec.run", "store.put"]);
    let grants = runtime.grants("modern").unwrap();
    assert_eq!(grants.exec_environment, vec!["FIXTURE_ENV"]);
    assert!(grants.capabilities.contains(&"exec".to_owned()));
    let stream = runtime
        .response_stream(json!({"kind":"response.output_item.done","raw_sha256":"x","raw_usage":null,"opaque_reasoning":false,"protected":false,"text":"x","boundary":true,"attempt":0}), || true)
        .unwrap();
    assert!(stream["control"].is_null());
}

#[test]
fn stream_control_is_bounded_to_output_boundaries_and_current_api() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    let guard = package(
        &root,
        "guard",
        json!({"capabilities":["middleware"]}),
        "export default api => api.middleware('response_stream', event => event.text?.includes('forbidden') ? {stop:{reason:'rule'}, retry:{inject:'Avoid the forbidden pattern.'}} : null)",
        &[],
    );
    trust(&store, &guard);
    let mut runtime = ModHost::open(root.join("store")).unwrap();
    let event = |boundary: bool, text: &str| {
        json!({"kind":"response.output_item.done","raw_sha256":"x","raw_usage":null,"opaque_reasoning":false,
            "protected":false,"text":text,"boundary":boundary,"attempt":0})
    };
    let stopped = runtime
        .response_stream(event(true, "a forbidden word"), || true)
        .unwrap();
    assert_eq!(stopped["control"]["reason"], "rule");
    assert_eq!(
        stopped["control"]["retry"]["inject"],
        "Avoid the forbidden pattern."
    );
    assert_eq!(stopped["control"]["origin"], "guard");
    let passed = runtime
        .response_stream(event(true, "fine"), || true)
        .unwrap();
    assert!(passed["control"].is_null());
    let mid = runtime
        .response_stream(event(false, "forbidden"), || true)
        .unwrap();
    assert!(mid["control"].is_null());
    assert_eq!(
        mid["fallback"][0]["error"],
        "stream_control_requires_output_boundary"
    );
}

#[test]
fn registration_primitives_need_their_capability_and_withdraw_on_disable_or_with_no_mods() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = ModStore::create(root.join("store"), node()).unwrap();
    let empty = ModHost::open(root.join("store")).unwrap();
    assert!(empty.builtin_controls().is_empty());
    assert!(empty.contract_documents().is_empty());
    assert!(!empty.has_event("response_stream"));
    assert!(!empty.has_event("workspace_change"));
    let registering = "export default api => { api.builtins({modes:{disable:['plan']}}); \
         api.contract({schema:2,id:'gate',version:1,description:'Gate',assurance:'checked',gates:{integrate:[{receipt:'checks'}]}}); }";
    let undeclared = package(
        &root,
        "undeclared",
        json!({"capabilities":["commands"]}),
        registering,
        &[],
    );
    trust(&store, &undeclared);
    let declared = package(
        &root,
        "declared",
        json!({"capabilities":["builtins","contracts"]}),
        registering,
        &[],
    );
    trust(&store, &declared);
    let runtime = ModHost::open(root.join("store")).unwrap();
    assert!(
        error_of(&runtime, "undeclared").contains("capability_denied"),
        "{}",
        error_of(&runtime, "undeclared")
    );
    assert_eq!(runtime.builtin_controls().len(), 1);
    assert_eq!(runtime.contract_documents().len(), 1);
    store.enable(&declared, false).unwrap();
    let reloaded = ModHost::open(root.join("store")).unwrap();
    assert!(reloaded.builtin_controls().is_empty());
    assert!(reloaded.contract_documents().is_empty());
}

#[test]
fn writable_pty_panes_also_need_workspace_write_authority() {
    let call = |arguments: Value| codex_omd::ModHostCall {
        operation: "terminal.pty".into(),
        arguments,
    };
    assert_eq!(
        call(json!({"action": "start", "session": "s"}))
            .capabilities()
            .unwrap(),
        ["pty"]
    );
    assert_eq!(
        call(json!({"action": "start", "session": "s", "write": true}))
            .capabilities()
            .unwrap(),
        ["pty", "fs.write"]
    );
    assert_eq!(
        call(json!({"action": "start", "session": "s", "network": "loopback"}))
            .capabilities()
            .unwrap(),
        ["pty", "network"]
    );
}

#[test]
fn contract_select_writes_the_user_selection_and_needs_the_plan_confirmation_to_lower_assurance() {
    let document = |id: &str, producer: &str| {
        ContractDocument::parse(&json!({"schema":2,"id":id,"version":1,"description":"d",
            "assurance":"a","gates":{"complete":[{"receipt":"review","producer":producer}]}}))
        .unwrap()
    };
    let documents = vec![
        (document("strict", "separate_agent"), owner()),
        (document("solo", "lead"), owner()),
    ];
    let store = tempfile::tempdir().unwrap();
    let repository = tempfile::tempdir().unwrap();
    let selected = codex_omd::contract_cli::select(
        &documents,
        store.path(),
        repository.path(),
        "strict@1",
        None,
    )
    .unwrap();
    assert_eq!(selected["selected"]["key"], "strict@1");
    let refused = codex_omd::contract_cli::select(
        &documents,
        store.path(),
        repository.path(),
        "solo@1",
        None,
    );
    assert!(
        refused
            .unwrap_err()
            .to_string()
            .contains("reduces assurance")
    );
    let plan = codex_omd::contract_cli::plan(&documents, store.path(), repository.path(), "solo@1")
        .unwrap();
    assert_eq!(plan["weakens"], true);
    let confirmation = plan["confirmation"].as_str().map(str::to_owned);
    codex_omd::contract_cli::select(
        &documents,
        store.path(),
        repository.path(),
        "solo@1",
        confirmation,
    )
    .unwrap();
}

#[test]
fn unrestricted_exec_runs_granted_programs_outside_the_sandbox() {
    let _exec = exec_slot();
    let (temp, repository, data, authority) = setup();
    let outside = temp.path().canonicalize().unwrap().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("dummy-secret"), "isolated dummy secret\n").unwrap();
    let active = || true;
    let host = Host {
        authority: &authority,
        data_root: &data,
        active: &active,
        record_changes: false,
    };
    let capabilities = strings(&["exec", "os"]);
    let access = codex_omd::ModOsAccess {
        programs: strings(&["cat", "env"]),
        network: true,
    };
    let granted = Caller {
        os_access: Some(&access),
        ..caller(&capabilities, &[], Origin::Tool)
    };
    let read = host
        .call(
            &granted,
            "exec.run",
            json!({"program": "cat", "argv": ["dummy-secret"], "cwd": outside, "sandbox": "none"}),
        )
        .unwrap();
    assert_eq!(read["stdout"], "isolated dummy secret\n");
    assert!(
        authority.sandboxed.borrow().is_empty(),
        "an unrestricted run bypasses the session sandbox"
    );
    let environment = host
        .call(
            &granted,
            "exec.run",
            json!({"program": "env", "sandbox": "none", "env": {}}),
        )
        .unwrap();
    let environment = environment["stdout"].as_str().unwrap();
    assert!(environment.contains(&format!("HOME={}", std::env::var("HOME").unwrap())));
    assert!(!environment.contains("CODEX_HOME=") && !environment.contains("OPENAI_API_KEY="));
    let refused = |caller: &Caller<'_>, arguments: Value| {
        host.call(caller, "exec.run", arguments).unwrap_err()
    };
    assert_eq!(
        refused(&granted, json!({"program": "ls", "sandbox": "none"})),
        "os_access_denied: ls"
    );
    assert_eq!(
        refused(
            &caller(&capabilities, &[], Origin::Tool),
            json!({"program": "cat", "sandbox": "none"})
        ),
        "capability_denied: os"
    );
    for invalid in [
        json!({"program": "cat", "sandbox": "none", "network": "loopback"}),
        json!({"program": "cat", "sandbox": "none", "unix_sockets": ["X"]}),
    ] {
        refused(&granted, invalid);
    }
    assert_eq!(
        refused(&granted, json!({"program": "cat", "sandbox": "lenient"})),
        "exec_sandbox_invalid"
    );
    let offline = codex_omd::ModOsAccess {
        programs: strings(&["*"]),
        network: false,
    };
    let offline = Caller {
        os_access: Some(&offline),
        ..caller(&capabilities, &[], Origin::Tool)
    };
    let fetched = host
        .call(
            &offline,
            "exec.run",
            json!({"program": "/usr/bin/nc", "argv": ["-z", "-w", "2", "1.1.1.1", "443"], "sandbox": "none"}),
        )
        .unwrap();
    assert_ne!(
        fetched["exit_code"], 0,
        "os_access.network false denies IP networking"
    );
    assert_eq!(
        host.call(
            &offline,
            "exec.run",
            json!({"program": "cat", "argv": [outside.join("dummy-secret")], "sandbox": "none"})
        )
        .unwrap()["stdout"],
        "isolated dummy secret\n",
        "denying the network still leaves user-readable files exposed"
    );
    assert!(repository.exists());
}

#[test]
fn external_roots_keep_canonical_paths_expected_versions_and_grant_scope() {
    let (temp, repository, data, authority) = setup();
    let outside = temp.path().canonicalize().unwrap().join("outside");
    let notes = outside.join("notes");
    let readonly = outside.join("readonly");
    std::fs::create_dir_all(notes.join("sub")).unwrap();
    std::fs::create_dir_all(&readonly).unwrap();
    std::fs::write(notes.join("a.md"), "a\n").unwrap();
    std::fs::write(readonly.join("r.md"), "r\n").unwrap();
    std::os::unix::fs::symlink(&repository, notes.join("escape")).unwrap();
    std::os::unix::fs::symlink(&notes, outside.join("linked")).unwrap();
    let path = |path: &Path| path.to_str().unwrap().to_owned();
    let access = codex_omd::ModFsAccess {
        roots: [
            (&notes, true),
            (&readonly, false),
            (&outside.join("linked"), true),
            (&repository, true),
        ]
        .into_iter()
        .map(|(root, write)| codex_omd::ModFsRoot {
            path: path(root),
            write,
        })
        .collect(),
    };
    let capabilities = strings(&["fs.read", "fs.write", "fs.external"]);
    let mut external = caller(&capabilities, &[], Origin::Tool);
    external.fs_access = Some(&access);
    let active = || true;
    let host = Host {
        authority: &authority,
        data_root: &data,
        active: &active,
        record_changes: true,
    };
    let call = |operation: &str, arguments: Value| host.call(&external, operation, arguments);
    let read = call(
        "workspace.read",
        json!({"root": path(&notes), "paths": ["a.md"]}),
    )
    .unwrap();
    assert_eq!(read["files"]["a.md"]["text"], "a\n");
    let listed = call(
        "workspace.list",
        json!({"root": path(&notes), "recursive": true}),
    )
    .unwrap();
    assert!(
        listed["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == "a.md")
    );
    let stat = call(
        "workspace.stat",
        json!({"root": path(&notes), "paths": ["a.md"], "hash": true}),
    )
    .unwrap();
    let hash = stat["files"]["a.md"]["sha256"].clone();
    let error = call(
        "workspace.read",
        json!({"root": path(&notes), "paths": ["escape/README.md"]}),
    )
    .unwrap_err();
    assert!(error.contains("symlink"), "{error}");
    let error = call(
        "workspace.read",
        json!({"root": path(&notes), "paths": ["../readonly/r.md"]}),
    )
    .unwrap_err();
    assert!(!error.is_empty());
    let stale = call(
        "workspace.transaction",
        json!({"root": path(&notes), "expected": {"a.md": "0".repeat(64)}, "writes": {"a.md": "b\n"}}),
    )
    .unwrap_err();
    assert!(stale.starts_with("stale expected version"), "{stale}");
    call(
        "workspace.transaction",
        json!({"root": path(&notes), "expected": {"a.md": hash, "sub/new.md": null},
            "writes": {"a.md": "b\n", "sub/new.md": "new\n"}}),
    )
    .unwrap();
    assert_eq!(std::fs::read_to_string(notes.join("a.md")).unwrap(), "b\n");
    assert!(codex_omd::take_workspace_changes(&repository).is_empty());
    assert_eq!(
        call(
            "workspace.transaction",
            json!({"root": path(&readonly), "expected": {"r.md": null}, "writes": {"x.md": "x"}}),
        )
        .unwrap_err(),
        "workspace_write_permission_denied"
    );
    let linked = path(&outside.join("linked"));
    assert_eq!(
        call("workspace.read", json!({"root": linked, "paths": ["a.md"]})).unwrap_err(),
        format!("fs_root_not_canonical: {linked}")
    );
    assert_eq!(
        call(
            "workspace.read",
            json!({"root": path(&repository), "paths": ["README.md"]})
        )
        .unwrap_err(),
        format!("fs_root_protected: {}", path(&repository))
    );
    assert_eq!(
        call(
            "workspace.read",
            json!({"root": path(&outside), "paths": ["notes/a.md"]})
        )
        .unwrap_err(),
        format!("fs_root_not_granted: {}", path(&outside))
    );

    let environment = strings(&[
        "OMD_FIXTURE_PLAIN",
        "OMD_FIXTURE_TOKEN",
        "OMD_FIXTURE_UNSET",
    ]);
    let plain = caller(&capabilities, &environment, Origin::Tool);
    unsafe {
        std::env::set_var("OMD_FIXTURE_PLAIN", "visible");
        std::env::set_var("OMD_FIXTURE_TOKEN", "hidden");
    }
    let values = host
        .call(&plain, "environment.read", json!({"names": environment}))
        .unwrap();
    assert_eq!(
        values["values"]["OMD_FIXTURE_PLAIN"],
        json!({"set": true, "value": "visible"})
    );
    assert_eq!(values["values"]["OMD_FIXTURE_TOKEN"], json!({"set": true}));
    assert_eq!(
        values["values"]["OMD_FIXTURE_UNSET"],
        json!({"set": false, "value": null})
    );
    assert_eq!(
        host.call(&plain, "environment.read", json!({"names": ["HOME"]}))
            .unwrap_err(),
        "exec_environment_undeclared: HOME"
    );
}
