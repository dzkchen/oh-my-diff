use super::*;

#[test]
fn status_does_not_create_or_rewrite_consent_documents() {
    let root = tempfile::tempdir().unwrap();
    assert!(
        status(root.path(), "empty", "owner", "id")
            .unwrap()
            .is_none()
    );
    assert!(!root.path().join("consents/empty.json").exists());
    grant(root.path(), "t1", "owner", "digest", "id").unwrap();
    let path = root.path().join("consents/t1.json");
    let original = format!("{}\n", fs::read_to_string(&path).unwrap());
    fs::write(&path, &original).unwrap();
    assert!(status(root.path(), "t1", "owner", "id").unwrap().is_some());
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
}

#[test]
fn failed_replacement_preserves_the_previous_consent_document() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    grant(root.path(), "thread", "owner", "digest", "id").unwrap();
    let directory = root.path().join("consents");
    let path = directory.join("thread.json");
    let original = fs::read(&path).unwrap();
    let result = with(root.path(), "thread", |consents| {
        consents.clear();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o500))
    });
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
    assert_eq!(fs::read(path).unwrap(), original);
    assert!(
        status(root.path(), "thread", "owner", "id")
            .unwrap()
            .is_some()
    );
}

#[test]
fn concurrent_status_reads_observe_complete_atomic_documents() {
    let root = tempfile::tempdir().unwrap();
    std::thread::scope(|scope| {
        let writers: Vec<_> = (0..2)
            .map(|writer| {
                let root = root.path();
                scope.spawn(move || {
                    for number in 0..20 {
                        grant(
                            root,
                            "thread",
                            &format!("owner{writer}"),
                            "digest",
                            &format!("{writer}-{number}"),
                        )
                        .unwrap();
                    }
                })
            })
            .collect();
        while writers.iter().any(|writer| !writer.is_finished()) {
            status(root.path(), "thread", "owner0", "0-0").unwrap();
        }
        for writer in writers {
            writer.join().unwrap();
        }
    });
    assert_eq!(
        read(&root.path().join("consents/thread.json"))
            .unwrap()
            .len(),
        40
    );
}

#[test]
fn consent_status_preserves_the_recovery_document() {
    use std::os::unix::fs::MetadataExt;
    let root = tempfile::tempdir().unwrap();
    grant(root.path(), "thread", "owner", "hash", "id").unwrap();
    let path = root.path().join("consents/thread.json");
    let bytes = fs::read(&path).unwrap();
    let before = fs::metadata(&path).unwrap();
    status(root.path(), "thread", "owner", "id").unwrap();
    let after = fs::metadata(&path).unwrap();
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(
        (before.ino(), before.mtime_nsec()),
        (after.ino(), after.mtime_nsec())
    );
    consume(root.path(), "thread", "owner", "id", "hash", "client").unwrap();
    assert_ne!(fs::metadata(&path).unwrap().ino(), before.ino());
    assert_eq!(
        serde_json::from_slice::<Vec<Consent>>(&bytes).unwrap()[0].client_id,
        None
    );
}

#[test]
fn consents_are_single_use_content_bound_and_reconciled_by_client_id() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    let sha = digest("ship it", &[]);
    grant(root, "t1", "queue", &sha, "c1").unwrap();
    let spend = |sha: &str, client: &str| consume(root, "t1", "queue", "c1", sha, client);
    assert_eq!(
        spend(&digest("ship it now", &[]), "m1")
            .unwrap_err()
            .to_string(),
        "consent_content_changed"
    );
    assert!(
        consume(root, "t1", "other", "c1", &sha, "m1").is_err(),
        "consents bind their owner"
    );
    spend(&sha, "m1").unwrap();
    assert_eq!(spend(&sha, "m2").unwrap_err().to_string(), "consent_spent");
    assert_eq!(
        status(root, "t2", "queue", "c1").unwrap(),
        None,
        "consents stay on their thread"
    );
    delivered(root, "t1", "m1", "turn-9").unwrap();
    let consent = status(root, "t1", "queue", "c1").unwrap().unwrap();
    assert_eq!(
        (consent.client_id.as_deref(), consent.turn_id.as_deref()),
        (Some("m1"), Some("turn-9"))
    );
    grant(root, "t1", "queue", &sha, "c2").unwrap();
    consume(root, "t1", "queue", "c2", &sha, "m3").unwrap();
    restore(root, "t1", "c2").unwrap();
    consume(root, "t1", "queue", "c2", &sha, "m4").unwrap();
    assert_eq!(retain(root, "t1", |consent| consent.id != "c1").unwrap(), 1);
    assert_eq!(
        retain(root, "t1", |consent| consent.owner != "queue").unwrap(),
        1
    );
    assert!(grant(root, "../escape", "queue", &sha, "c3").is_err());
}

#[test]
fn reads_and_unmatched_deliveries_leave_the_file_untouched() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    grant(root, "t1", "queue", &digest("ship it", &[]), "c1").unwrap();
    let path = root.join("consents").join("t1.json");
    let modified = || fs::metadata(&path).unwrap().modified().unwrap();
    let before = modified();
    std::thread::sleep(std::time::Duration::from_millis(20));
    status(root, "t1", "queue", "c1").unwrap();
    delivered(root, "t1", "no-such-message", "turn-1").unwrap();
    assert_eq!(modified(), before);
    grant(root, "t1", "queue", &digest("again", &[]), "c2").unwrap();
    assert_ne!(modified(), before, "a real change is still written");
}
