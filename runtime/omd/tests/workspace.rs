use codex_omd::File;
use codex_omd::Snapshot;
use codex_omd::cleanup_owned_directory;
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
    let mut input = snapshot();
    input.files.insert(".gitignore".into(), File {
        bytes: b"source.txt\n".to_vec(), executable: false,
    });
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
fn cleanup_removes_only_a_direct_owned_directory() {
    let temp = tempfile::tempdir().unwrap();
    let owned = temp.path().join("owned");
    fs::create_dir(&owned).unwrap();
    fs::write(owned.join("artifact"), "data").unwrap();
    cleanup_owned_directory(temp.path(), &owned).unwrap();
    assert!(!owned.exists());
    let nested_parent = temp.path().join("nested");
    let nested = nested_parent.join("not-direct");
    fs::create_dir_all(&nested).unwrap();
    assert!(cleanup_owned_directory(temp.path(), &nested).is_err());
    assert!(nested.exists());
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
