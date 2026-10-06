use codex_omd::sessions::SessionIndex;
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

fn record(path: &Path, repo: &Path, id: &str, memory: &str) {
    let rows = [
        json!({"type":"session_meta","payload":{"id":id,"session_id":"task-a","cwd":repo,"timestamp":"2026-09-26T12:00:00Z","memory_mode":memory}}),
        json!({"type":"turn_context","payload":{"turn_id":"turn-a","cwd":repo}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Please preserve my changes."}]}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","channel":"analysis","content":[{"type":"output_text","text":"hidden-reasoning-sentinel"}]}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done\nAuthorization: Bearer private-sentinel"}]}}),
    ];
    fs::write(
        path,
        rows.iter()
            .map(|row| row.to_string() + "\n")
            .collect::<String>(),
    )
    .unwrap();
}

fn fixture() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let repo = root.join("repo");
    let sessions = root.join("sessions");
    fs::create_dir(&repo).unwrap();
    fs::create_dir(&sessions).unwrap();
    (temp, repo, sessions)
}

#[test]
fn repository_scope_opt_out_and_hidden_content_are_enforced() {
    let (_temp, repo, sessions) = fixture();
    let other = repo.parent().unwrap().join("other");
    fs::create_dir(&other).unwrap();
    record(&sessions.join("a.jsonl"), &repo, "session-a", "enabled");
    record(&sessions.join("b.jsonl"), &other, "session-b", "enabled");
    record(&sessions.join("c.jsonl"), &repo, "session-c", "disabled");
    let index = SessionIndex {
        database: None,
        root: &sessions,
        repository: &repo,
        enabled: true,
    };
    let list = index
        .call("sessions.list", json!({"since":"2026-09-01"}), || true)
        .unwrap();
    assert_eq!(list["sessions"].as_array().unwrap().len(), 1);
    let summary = &list["sessions"][0];
    let result = index
        .call(
            "sessions.read",
            json!({"session_id":"session-a","revision":summary["revision"],"handle":summary["handle"]}),
            || true,
        )
        .unwrap();
    let rendered = result.to_string();
    assert!(!rendered.contains("private-sentinel"));
    assert!(!rendered.contains("hidden-reasoning-sentinel"));
    assert_eq!(result["records"].as_array().unwrap().len(), 2);
    assert_eq!(result["records"][0]["turn_id"], "turn-a");
    assert_eq!(result["records"][1]["redacted"], true);
    assert!(
        index
            .call(
                "sessions.read",
                json!({"session_id":"session-b","revision":summary["revision"],"handle":summary["handle"]}),
                || true
            )
            .is_err()
    );
    assert!(
        index
            .call("sessions.list", json!({"repository":other}), || true)
            .is_err()
    );
    assert!(index.call("sessions.list", json!({}), || false).is_err());
    assert!(
        SessionIndex {
            database: None,
            enabled: false,
            ..index
        }
        .call("sessions.list", json!({}), || true)
        .is_err()
    );
}

#[test]
fn frozen_revision_rejects_append_and_ignores_partial_record() {
    let (_temp, repo, sessions) = fixture();
    let path = sessions.join("a.jsonl");
    record(&path, &repo, "session-a", "enabled");
    let index = SessionIndex {
        database: None,
        root: &sessions,
        repository: &repo,
        enabled: true,
    };
    let summary = index.call("sessions.list", json!({}), || true).unwrap()["sessions"][0].clone();
    let original = fs::read_to_string(&path).unwrap();
    fs::write(&path, original.clone() + "{\"partial\":").unwrap();
    let request =
        json!({"session_id":"session-a","revision":summary["revision"],"handle":summary["handle"]});
    assert_eq!(
        index
            .call("sessions.read", request.clone(), || true)
            .unwrap()["session"]["incomplete_tail"],
        true
    );
    fs::write(
        &path,
        original + "{\"type\":\"event_msg\",\"payload\":{}}\n",
    )
    .unwrap();
    assert!(
        index
            .call("sessions.read", request, || true)
            .unwrap_err()
            .to_string()
            .contains("revision_changed")
    );
}

#[test]
fn index_cursors_reject_drift_and_ambiguous_ids() {
    let (_temp, repo, sessions) = fixture();
    record(&sessions.join("a.jsonl"), &repo, "session-a", "enabled");
    record(&sessions.join("b.jsonl"), &repo, "session-b", "enabled");
    let index = SessionIndex {
        database: None,
        root: &sessions,
        repository: &repo,
        enabled: true,
    };
    let page = index
        .call("sessions.list", json!({"limit":1}), || true)
        .unwrap();
    assert!(page["cursor"].is_string());
    let next = index
        .call(
            "sessions.list",
            json!({"limit":1,"cursor":page["cursor"]}),
            || true,
        )
        .unwrap();
    assert_ne!(
        page["sessions"][0]["session_id"],
        next["sessions"][0]["session_id"]
    );
    fs::remove_file(sessions.join("b.jsonl")).unwrap();
    assert!(
        index
            .call("sessions.list", json!({"cursor":page["cursor"]}), || true)
            .unwrap_err()
            .to_string()
            .contains("index_changed")
    );
    fs::copy(sessions.join("a.jsonl"), sessions.join("duplicate.jsonl")).unwrap();
    assert!(
        index
            .call("sessions.list", json!({}), || true)
            .unwrap_err()
            .to_string()
            .contains("identity_ambiguous")
    );
}

#[test]
fn bounds_symlinks_and_changed_turn_scope_fail_closed() {
    let (_temp, repo, sessions) = fixture();
    let outside = repo.join("outside.jsonl");
    record(&outside, &repo, "external-session", "enabled");
    std::os::unix::fs::symlink(&outside, sessions.join("link.jsonl")).unwrap();
    let index = SessionIndex {
        database: None,
        root: &sessions,
        repository: &repo,
        enabled: true,
    };
    assert_eq!(
        index.call("sessions.list", json!({}), || true).unwrap()["sessions"],
        json!([])
    );
    record(&sessions.join("a.jsonl"), &repo, "session-a", "enabled");
    let mut rows: Vec<Value> = fs::read_to_string(sessions.join("a.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    rows[1]["payload"]["cwd"] = json!(repo.parent().unwrap());
    fs::write(
        sessions.join("a.jsonl"),
        rows.iter()
            .map(|row| row.to_string() + "\n")
            .collect::<String>(),
    )
    .unwrap();
    let summary = index.call("sessions.list", json!({}), || true).unwrap()["sessions"][0].clone();
    let result = index
        .call(
            "sessions.read",
            json!({"session_id":"session-a","revision":summary["revision"],"handle":summary["handle"]}),
            || true,
        )
        .unwrap();
    assert_eq!(result["records"], json!([]));
    for request in [
        json!({"limit":101}),
        json!({"since":"2026-99-99"}),
        json!({"since":"2026-09-26","until":"2026-09-01"}),
    ] {
        assert!(index.call("sessions.list", request, || true).is_err());
    }
}

#[test]
fn later_metadata_and_state_database_opt_out_override_earlier_records() {
    let (_temp, repo, sessions) = fixture();
    let path = sessions.join("a.jsonl");
    record(&path, &repo, "session-a", "enabled");
    let index = SessionIndex {
        database: None,
        root: &sessions,
        repository: &repo,
        enabled: true,
    };
    let old = index.call("sessions.list", json!({}), || true).unwrap()["sessions"][0].clone();
    let before = fs::read_to_string(&path).unwrap();
    let mut meta: Value = serde_json::from_str(before.lines().next().unwrap()).unwrap();
    meta["payload"]["memory_mode"] = json!("disabled");
    fs::write(&path, format!("{before}{meta}\n")).unwrap();
    assert_eq!(
        index.call("sessions.list", json!({}), || true).unwrap()["sessions"],
        json!([])
    );
    fs::write(&path, &before).unwrap();
    let sqlite = sessions.parent().unwrap().join("separate-state");
    fs::create_dir(&sqlite).unwrap();
    let db = sqlite.join("state_5.sqlite");
    let index = SessionIndex {
        database: Some(&db),
        ..index
    };
    let sql = format!(
        "CREATE TABLE threads(id TEXT,cwd TEXT,memory_mode TEXT,rollout_path TEXT); INSERT INTO threads VALUES('session-a','{}','disabled',NULL);",
        repo.to_str().unwrap().replace('\'', "''")
    );
    assert!(
        std::process::Command::new("/usr/bin/sqlite3")
            .arg(&db)
            .arg(sql)
            .status()
            .unwrap()
            .success()
    );
    let bytes = fs::read(&db).unwrap();
    assert_eq!(
        index.call("sessions.list", json!({}), || true).unwrap()["sessions"],
        json!([])
    );
    assert!(
        index
            .call(
                "sessions.read",
                json!({"session_id":"session-a","revision":old["revision"],"handle":old["handle"]}),
                || true
            )
            .is_err()
    );
    assert_eq!(fs::read(&db).unwrap(), bytes);
    assert!(
        std::process::Command::new("/usr/bin/sqlite3")
            .arg(&db)
            .arg("UPDATE threads SET memory_mode='enabled'")
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(
        index.call("sessions.list", json!({}), || true).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    fs::write(sqlite.join("state_6.sqlite"), b"future-state").unwrap();
    assert!(index.call("sessions.list", json!({}), || true).is_err());
}

#[test]
fn inherited_child_prefix_is_excluded_even_with_matching_turn_context() {
    let (_temp, repo, sessions) = fixture();
    let path = sessions.join("a.jsonl");
    record(&path, &repo, "session-a", "enabled");
    let mut rows: Vec<Value> = fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    rows[0]["payload"]["subagent_history_start_ordinal"] = json!(5);
    rows.push(
        json!({"type":"turn_context","ordinal":5,"payload":{"cwd":repo,"turn_id":"child-turn"}}),
    );
    rows.push(json!({"type":"response_item","ordinal":6,"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Local child result"}]}}));
    fs::write(
        path,
        rows.iter()
            .map(|row| row.to_string() + "\n")
            .collect::<String>(),
    )
    .unwrap();
    let index = SessionIndex {
        database: None,
        root: &sessions,
        repository: &repo,
        enabled: true,
    };
    let summary = index.call("sessions.list", json!({}), || true).unwrap()["sessions"][0].clone();
    let result = index
        .call(
            "sessions.read",
            json!({"session_id":"session-a","revision":summary["revision"],"handle":summary["handle"]}),
            || true,
        )
        .unwrap();
    assert_eq!(result["records"].as_array().unwrap().len(), 1);
    assert_eq!(result["records"][0]["turn_id"], "child-turn");
}

#[test]
fn truncated_scan_marks_the_list_without_blocking_handle_reads() {
    let (_temp, repo, sessions) = fixture();
    record(&sessions.join("a.jsonl"), &repo, "session-a", "enabled");
    let other = sessions.join("zz");
    fs::create_dir(&other).unwrap();
    for index in 0..4100 {
        fs::write(other.join(format!("{index:04}.jsonl")), "{}\n").unwrap();
    }
    let index = SessionIndex {
        database: None,
        root: &sessions,
        repository: &repo,
        enabled: true,
    };
    let list = index.call("sessions.list", json!({}), || true).unwrap();
    assert_eq!(list["scan_truncated"], true);
    let summary = &list["sessions"][0];
    let result = index
        .call(
            "sessions.read",
            json!({"session_id":"session-a","revision":summary["revision"],"handle":summary["handle"]}),
            || true,
        )
        .unwrap();
    assert_eq!(result["records"].as_array().unwrap().len(), 2);
    assert_eq!(result["projection_truncated"], false);
    assert!(
        index
            .call(
                "sessions.read",
                json!({"session_id":"session-a","revision":summary["revision"],"handle":"0".repeat(64)}),
                || true,
            )
            .is_err()
    );
}

#[test]
fn continuation_segments_list_separately_while_copies_stay_ambiguous() {
    let (_temp, repo, sessions) = fixture();
    record(&sessions.join("a.jsonl"), &repo, "session-a", "enabled");
    let rows = [
        json!({"type":"session_meta","payload":{"id":"session-a","session_id":"task-a","cwd":repo,"timestamp":"2026-09-26T13:00:00Z","memory_mode":"enabled","history_mode":"paginated","history_base":{"thread_id":"session-a","end_ordinal_exclusive":5}}}),
        json!({"type":"turn_context","payload":{"turn_id":"turn-b","cwd":repo}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"A later request."}]}}),
    ];
    let part = sessions.join("a_part.jsonl");
    fs::write(
        &part,
        rows.iter()
            .map(|row| row.to_string() + "\n")
            .collect::<String>(),
    )
    .unwrap();
    let index = SessionIndex {
        database: None,
        root: &sessions,
        repository: &repo,
        enabled: true,
    };
    let list = index.call("sessions.list", json!({}), || true).unwrap();
    let listed = list["sessions"].as_array().unwrap();
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().all(|row| row["session_id"] == "session-a"));
    assert_ne!(listed[0]["handle"], listed[1]["handle"]);
    assert_eq!(listed[0]["inherited_history"], true);
    let result = index
        .call(
            "sessions.read",
            json!({"session_id":"session-a","revision":listed[0]["revision"],"handle":listed[0]["handle"]}),
            || true,
        )
        .unwrap();
    assert_eq!(result["records"][0]["turn_id"], "turn-b");
    fs::copy(&part, sessions.join("a_copy.jsonl")).unwrap();
    assert!(
        index
            .call("sessions.list", json!({}), || true)
            .unwrap_err()
            .to_string()
            .contains("identity_ambiguous")
    );
}

#[test]
fn wal_state_database_without_sidecar_files_is_readable() {
    let (_temp, repo, sessions) = fixture();
    record(&sessions.join("a.jsonl"), &repo, "session-a", "enabled");
    record(&sessions.join("a_replaced.jsonl"), &repo, "session-a", "enabled");
    let sqlite = sessions.parent().unwrap().join("wal-state");
    fs::create_dir(&sqlite).unwrap();
    let db = sqlite.join("state_5.sqlite");
    let sql = format!(
        "PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT,cwd TEXT,memory_mode TEXT,rollout_path TEXT); INSERT INTO threads VALUES('session-a','{}','enabled','{}'); PRAGMA wal_checkpoint(TRUNCATE);",
        repo.to_str().unwrap().replace('\'', "''"),
        sessions.join("a.jsonl").to_str().unwrap().replace('\'', "''")
    );
    assert!(
        std::process::Command::new("/usr/bin/sqlite3")
            .arg(&db)
            .arg(sql)
            .status()
            .unwrap()
            .success()
    );
    for sidecar in ["state_5.sqlite-wal", "state_5.sqlite-shm"] {
        let _ = fs::remove_file(sqlite.join(sidecar));
    }
    let index = SessionIndex {
        database: Some(&db),
        root: &sessions,
        repository: &repo,
        enabled: true,
    };
    assert_eq!(
        index.call("sessions.list", json!({}), || true).unwrap()["sessions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
