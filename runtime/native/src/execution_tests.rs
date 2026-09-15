use super::*;

#[test]
fn review_finding_keys_are_host_normalized_and_bounded() {
    let finding = |key: &str| ModelFinding {
        key: key.into(),
        severity: codex_omd::ReviewSeverity::Warning,
        summary: "check this path".into(),
        paths: vec!["src/lib.rs".into()],
    };
    assert!(review_findings(vec![finding("   ")]).is_err());
    let normalized = review_findings(vec![finding("  Stable-Key  ")]).unwrap();
    assert_eq!(normalized[0].fingerprint, hash(b"stable-key"));
}

#[test]
fn structured_worker_results_are_validated_without_changing_plain_results() {
    let plain = "ordinary worker answer".to_owned();
    assert_eq!(worker_result(plain.clone(), false).unwrap(), (plain, None));

    let value = json!({
        "schema": 1,
        "status": "partial",
        "summary": "The parser changed, but one target remains unverified.",
        "scope": ["parser.rs only"],
        "uncertainty": ["Windows was not exercised."],
        "evidence": ["cargo test -p parser"],
        "required_clarification": []
    })
    .to_string();
    let (summary, report) = worker_result(value, true).unwrap();
    assert_eq!(
        summary,
        "The parser changed, but one target remains unverified."
    );
    assert_eq!(report.unwrap().status, WorkerReportStatus::Partial);
    assert!(worker_result(r#"{"schema":1,"status":"completed"}"#.into(), true).is_err());
}

#[test]
fn platform_defaults_require_both_authorities_and_never_erase_denies() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().canonicalize().unwrap();
    let entry = |access| {
        Entry::new(
            FileSystemPath::Special {
                value: FileSystemSpecialPath::Minimal,
            },
            access,
        )
    };
    let profile = |entries| {
        PermissionProfile::from_runtime_permissions(
            &FileSystemSandboxPolicy::restricted(entries),
            NetworkSandboxPolicy::Restricted,
        )
    };
    let minimal = profile(vec![entry(Access::Read)]);
    let denied = profile(vec![entry(Access::Read), entry(Access::Deny)]);
    assert!(intersect(&denied, &minimal, &cwd).is_err());
    let none = profile(vec![]);
    assert!(
        !intersect(&none, &minimal, &cwd)
            .unwrap()
            .file_system_sandbox_policy()
            .include_platform_defaults()
    );
    let secret = AbsolutePathBuf::from_absolute_path_checked(cwd.join("secret")).unwrap();
    let parent = profile(vec![
        entry(Access::Read),
        Entry::new(
            FileSystemPath::Path {
                path: PathUri::from_abs_path(&secret),
            },
            Access::Deny,
        ),
    ]);
    let result = intersect(&parent, &minimal, &cwd)
        .unwrap()
        .file_system_sandbox_policy();
    assert!(result.include_platform_defaults());
    assert_eq!(
        result.resolve_access_for_local_path_with_cwd(secret.as_path(), &cwd),
        Access::Deny
    );
}

#[test]
fn shared_packet_is_bound_to_its_admitted_content() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("packet.txt");
    std::fs::write(&path, "bounded task packet").unwrap();
    let reference = PacketReference {
        path,
        sha256: hash(b"bounded task packet"),
    };
    let (packet, provenance) = shared_packet(&reference, 64).unwrap();
    assert_eq!(packet, "bounded task packet");
    assert_eq!(provenance["sha256"], reference.sha256);
    std::fs::write(&reference.path, "changed task packet").unwrap();
    assert!(shared_packet(&reference, 64).is_err());
}

#[test]
fn isolated_worktree_access_does_not_expose_host_siblings() {
    let root = tempfile::tempdir().unwrap();
    let host = root.path().canonicalize().unwrap();
    let worktree = host.join("repo/.omd/contributor");
    let sibling = host.join("secret");
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(&sibling, "secret").unwrap();
    let absolute = |path| AbsolutePathBuf::from_absolute_path_checked(path).unwrap();
    let path_entry = |path, access| {
        Entry::new(
            FileSystemPath::Path {
                path: PathUri::from_abs_path(&absolute(path)),
            },
            access,
        )
    };
    let minimal = Entry::new(
        FileSystemPath::Special {
            value: FileSystemSpecialPath::Minimal,
        },
        Access::Read,
    );
    let profile = |entries| {
        PermissionProfile::from_runtime_permissions(
            &FileSystemSandboxPolicy::restricted(entries),
            NetworkSandboxPolicy::Restricted,
        )
    };
    let parent = profile(vec![minimal, path_entry(host.join("repo"), Access::Write)]);
    let requested = profile(vec![path_entry(worktree.clone(), Access::Write)]);
    let policy = intersect(&parent, &requested, &host)
        .unwrap()
        .file_system_sandbox_policy();
    assert_eq!(
        policy.resolve_access_for_local_path_with_cwd(&worktree, &host),
        Access::Write
    );
    assert_eq!(
        policy.resolve_access_for_local_path_with_cwd(&sibling, &host),
        Access::Deny
    );
}
