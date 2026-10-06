use super::*;

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
