use codex_omd::File;
use codex_omd::Snapshot;
use codex_omd::capture_tracked;
use codex_omd::create_worktree;
use codex_omd::tracked_paths;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fs;

fn snapshot() -> Snapshot {
    Snapshot {
        files: BTreeMap::from([(
            "source.txt".into(),
            File {
                bytes: b"dirty tracked input".to_vec(),
                executable: false,
            },
        )]),
    }
}

#[test]
fn worktree_contains_snapshot_without_touching_original_inputs() {
    let temp = tempfile::tempdir().unwrap();
    let input = snapshot();
    let workspace = create_worktree(&input, &temp.path().join("isolated"), 4096).unwrap();
    assert!(workspace.join(".git").is_file());
    let paths = tracked_paths(&workspace, &BTreeSet::new()).unwrap();
    assert_eq!(Snapshot::capture(&workspace, &paths, 4096).unwrap(), input);
    fs::write(workspace.join("source.txt"), "worker edit").unwrap();
    assert_eq!(
        fs::read(temp.path().join("isolated/depot/source.txt")).unwrap(),
        b"dirty tracked input"
    );
}

#[test]
fn captures_tracked_dirty_files_and_only_approved_untracked_files() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = create_worktree(&snapshot(), &temp.path().join("isolated"), 4096).unwrap();
    fs::write(workspace.join("source.txt"), "dirty").unwrap();
    fs::write(workspace.join("approved.txt"), "approved").unwrap();
    fs::write(workspace.join(".env"), "excluded-secret-fixture").unwrap();
    let paths = tracked_paths(&workspace, &BTreeSet::from(["approved.txt".into()])).unwrap();
    let captured =
        capture_tracked(&workspace, &BTreeSet::from(["approved.txt".into()]), 4096).unwrap();
    assert_eq!(paths, captured.files.keys().cloned().collect());
    assert_eq!(
        captured.files.keys().cloned().collect::<Vec<_>>(),
        ["approved.txt", "source.txt"]
    );
    assert_eq!(captured.files["source.txt"].bytes, b"dirty");
}

#[test]
fn integration_candidate_preserves_unrelated_edits_and_rejects_conflicts() {
    let base = snapshot();
    let mut candidate = base.clone();
    candidate.files.get_mut("source.txt").unwrap().bytes = b"worker".to_vec();
    let mut current = base.clone();
    current.files.insert(
        "unrelated.txt".into(),
        File {
            bytes: b"user".to_vec(),
            executable: false,
        },
    );
    let merged = base.merge_candidate(&candidate, &current).unwrap();
    assert_eq!(
        merged.files["unrelated.txt"],
        current.files["unrelated.txt"]
    );
    assert_eq!(merged.files["source.txt"], candidate.files["source.txt"]);
    current.files.get_mut("source.txt").unwrap().bytes = b"concurrent".to_vec();
    assert!(base.merge_candidate(&candidate, &current).is_err());
}

#[test]
fn ancestor_and_descendant_conflicts_are_rejected() {
    let base = Snapshot {
        files: BTreeMap::new(),
    };
    let file = File {
        bytes: vec![],
        executable: false,
    };
    let ancestor = Snapshot {
        files: BTreeMap::from([("a".into(), file.clone())]),
    };
    let descendant = Snapshot {
        files: BTreeMap::from([("a/b".into(), file)]),
    };
    assert!(base.merge_candidate(&ancestor, &descendant).is_err());
    assert!(base.merge_candidate(&descendant, &ancestor).is_err());
}

#[test]
fn worktree_preserves_bytes_despite_repository_attributes() {
    let temp = tempfile::tempdir().unwrap();
    let mut input = snapshot();
    input.files.insert(
        ".gitattributes".into(),
        File {
            bytes: b"*.txt text eol=lf working-tree-encoding=UTF-16\n".to_vec(),
            executable: false,
        },
    );
    input.files.get_mut("source.txt").unwrap().bytes = b"dirty\r\ninput\r\n".to_vec();
    let workspace = create_worktree(&input, &temp.path().join("isolated"), 4096).unwrap();
    assert_eq!(
        Snapshot::capture(&workspace, &input.files.keys().cloned().collect(), 4096).unwrap(),
        input
    );
}

#[test]
fn rejects_unsafe_names_size_overflow_and_existing_destinations() {
    let temp = tempfile::tempdir().unwrap();
    for name in [
        "../outside",
        "/absolute",
        ".git/config",
        ".GIT/config",
        "a//b",
        "a/./b",
        "a\\b",
    ] {
        let mut input = snapshot();
        input.files.insert(
            name.into(),
            File {
                bytes: Vec::new(),
                executable: false,
            },
        );
        assert!(input.write_new(&temp.path().join("invalid"), 4096).is_err());
        assert!(!temp.path().join("invalid").exists());
    }
    assert!(snapshot().write_new(&temp.path().join("large"), 1).is_err());
    snapshot()
        .write_new(&temp.path().join("existing"), 4096)
        .unwrap();
    assert!(
        snapshot()
            .write_new(&temp.path().join("existing"), 4096)
            .is_err()
    );
}

#[test]
#[cfg(unix)]
fn rejects_symbolic_and_hard_links() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("regular"), "data").unwrap();
    symlink("regular", temp.path().join("symbolic")).unwrap();
    fs::hard_link(temp.path().join("regular"), temp.path().join("hard")).unwrap();
    for name in ["symbolic", "hard"] {
        assert!(Snapshot::capture(temp.path(), &BTreeSet::from([name.into()]), 4096).is_err());
    }
}

#[test]
#[cfg(unix)]
fn concurrent_symlink_replacement_never_imports_outside_bytes() {
    use std::os::unix::fs::symlink;
    use std::sync::Arc;
    use std::sync::Barrier;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    fs::create_dir(&root).unwrap();
    let outside = temp.path().join("outside");
    fs::write(&outside, "outside-secret-fixture").unwrap();
    let target = root.join("file");
    fs::write(&target, "inside").unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let other = barrier.clone();
    let writer = std::thread::spawn(move || {
        other.wait();
        for _ in 0..1000 {
            fs::remove_file(&target).unwrap();
            symlink(&outside, &target).unwrap();
            let replacement = target.parent().unwrap().join("incoming");
            fs::write(&replacement, "inside").unwrap();
            fs::rename(&replacement, &target).unwrap();
        }
    });
    barrier.wait();
    for _ in 0..1000 {
        if let Ok(captured) = Snapshot::capture(&root, &BTreeSet::from(["file".into()]), 4096)
            && let Some(file) = captured.files.get("file")
        {
            assert_eq!(file.bytes, b"inside");
        }
    }
    writer.join().unwrap();
}

#[test]
#[cfg(unix)]
fn materialization_does_not_write_or_chmod_a_replacement_symlink_target() {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let outside = temp.path().join("outside");
    fs::write(&outside, "outside").unwrap();
    fs::set_permissions(&outside, fs::Permissions::from_mode(0o600)).unwrap();
    let root = temp.path().join("snapshot");
    let path = root.join("file");
    let input = Snapshot {
        files: BTreeMap::from([(
            "file".into(),
            File {
                bytes: vec![b'x'; 4_000_000],
                executable: true,
            },
        )]),
    };
    let writer = std::thread::spawn(move || input.write_new(&root, 4_001_000));
    while !path.exists() && !writer.is_finished() {
        std::thread::yield_now();
    }
    if path.exists() {
        fs::remove_file(&path).unwrap();
        symlink(&outside, &path).unwrap();
    }
    let _result = writer.join().unwrap();
    assert_eq!(fs::read(&outside).unwrap(), b"outside");
    assert_eq!(
        fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
