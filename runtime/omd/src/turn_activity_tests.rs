use super::*;
use ActivityRecord::*;

fn s(text: &str) -> String {
    text.to_owned()
}

fn log() -> (tempfile::TempDir, TurnActivityLog) {
    let dir = tempfile::tempdir().unwrap();
    let log = TurnActivityLog::open(&dir.path().join("activity"), "thread-1").unwrap();
    (dir, log)
}

fn read(log: &TurnActivityLog, turn: Option<&str>, last: usize, running: Option<&str>) -> Value {
    log.read(turn, last, running, &|id| (id == "live").then_some(true))
        .unwrap()
}

#[test]
fn missing_log_reads_as_no_turns() {
    let (_dir, log) = log();
    assert_eq!(read(&log, None, 1, None), json!({"turns": []}));
}

#[test]
fn thread_ids_cannot_escape_the_root() {
    let dir = tempfile::tempdir().unwrap();
    for thread in ["", "../x", "a/b", "a.b"] {
        assert!(
            TurnActivityLog::open(dir.path(), thread).is_err(),
            "{thread}"
        );
    }
}

#[test]
fn completed_turn_reports_tools_processes_and_files() {
    let (_dir, log) = log();
    for record in [
        TurnStarted {
            turn_id: s("t1"),
            at: s("1"),
        },
        ToolStarted {
            turn_id: s("t1"),
            call_id: s("c1"),
            tool: s("shell"),
            at: s("2"),
        },
        ProcessStarted {
            turn_id: s("t1"),
            id: s("p1"),
            kind: s("exec"),
            command: s("make"),
            at: s("2"),
        },
        ProcessExited {
            id: s("p1"),
            exit_code: Some(2),
            at: s("3"),
        },
        ToolFinished {
            turn_id: s("t1"),
            call_id: s("c1"),
            at: s("3"),
            outcome: s("error"),
        },
        FileChanged {
            turn_id: s("t1"),
            path: s("a.rs"),
            before: Some(s("h0")),
            after: Some(s("h1")),
            source: s("tool"),
        },
        TurnEnded {
            turn_id: s("t1"),
            at: s("4"),
            outcome: s("completed"),
            reason: None,
            error: None,
        },
    ] {
        log.append(&record).unwrap();
    }
    let turn = &read(&log, None, 1, None)["turns"][0];
    assert_eq!(
        (turn["outcome"].as_str(), turn["unrecorded_end"].as_bool()),
        (Some("completed"), Some(false))
    );
    assert_eq!(
        turn["tool_calls"][0],
        json!({"call_id": "c1", "tool": "shell", "started_at": "2", "finished_at": "3", "outcome": "error"})
    );
    assert_eq!(
        turn["processes"][0],
        json!({"id": "p1", "kind": "exec", "command": "make", "running": false, "exit_code": 2})
    );
    assert_eq!(turn["files"][0]["after"], "h1");
}

#[test]
fn a_turn_without_an_end_is_interrupted_unless_running_or_paused() {
    let (_dir, log) = log();
    log.append(&TurnStarted {
        turn_id: s("t1"),
        at: s("1"),
    })
    .unwrap();
    log.append(&ToolStarted {
        turn_id: s("t1"),
        call_id: s("c1"),
        tool: s("apply_patch"),
        at: s("2"),
    })
    .unwrap();
    log.append(&ProcessStarted {
        turn_id: s("t1"),
        id: s("live"),
        kind: s("managed"),
        command: s("server"),
        at: s("2"),
    })
    .unwrap();
    log.append(&ProcessStarted {
        turn_id: s("t1"),
        id: s("gone"),
        kind: s("exec"),
        command: s("sleep"),
        at: s("2"),
    })
    .unwrap();
    let turn = &read(&log, None, 1, None)["turns"][0];
    assert_eq!(
        (turn["outcome"].as_str(), turn["unrecorded_end"].as_bool()),
        (Some("interrupted"), Some(true))
    );
    assert_eq!(turn["tool_calls"][0]["finished_at"], Value::Null);
    assert_eq!(
        (
            turn["processes"][0]["running"].clone(),
            turn["processes"][1]["running"].clone()
        ),
        (json!(true), Value::Null)
    );
    assert_eq!(
        read(&log, None, 1, Some("t1"))["turns"][0]["outcome"],
        "running"
    );
    log.append(&Paused { at: s("3") }).unwrap();
    let turn = &read(&log, None, 1, None)["turns"][0];
    assert_eq!(
        (turn["outcome"].as_str(), turn["unrecorded_end"].as_bool()),
        (Some("unknown"), Some(false))
    );
}

#[test]
fn selection_by_turn_and_last_n_keeps_order() {
    let (_dir, log) = log();
    for n in 1..=4 {
        log.append(&TurnStarted {
            turn_id: format!("t{n}"),
            at: s("x"),
        })
        .unwrap();
        log.append(&TurnEnded {
            turn_id: format!("t{n}"),
            at: s("y"),
            outcome: s("completed"),
            reason: None,
            error: None,
        })
        .unwrap();
    }
    let ids = |value: Value| {
        value["turns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["turn_id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(read(&log, None, 2, None)), ["t3", "t4"]);
    assert_eq!(ids(read(&log, Some("t2"), 1, None)), ["t2"]);
    assert_eq!(ids(read(&log, Some("nope"), 1, None)), Vec::<String>::new());
    assert_eq!(ids(read(&log, None, 0, None)), ["t4"]);
}

#[test]
fn per_turn_lists_are_bounded_and_marked_truncated() {
    let (_dir, log) = log();
    log.append(&TurnStarted {
        turn_id: s("t"),
        at: s("0"),
    })
    .unwrap();
    for n in 0..ACTIVITY_FILES + 3 {
        log.append(&FileChanged {
            turn_id: s("t"),
            path: format!("f{n}"),
            before: None,
            after: None,
            source: s("exec"),
        })
        .unwrap();
    }
    let turn = &read(&log, None, 1, None)["turns"][0];
    assert_eq!(
        (
            turn["files"].as_array().unwrap().len(),
            turn["truncated"].as_bool()
        ),
        (ACTIVITY_FILES, Some(true))
    );
    assert_eq!(turn["files"][0]["path"], "f3");
}

#[test]
fn corrupt_lines_are_skipped() {
    let (_dir, log) = log();
    log.append(&TurnStarted {
        turn_id: s("t"),
        at: s("0"),
    })
    .unwrap();
    OpenOptions::new()
        .append(true)
        .open(&log.path)
        .unwrap()
        .write_all(b"{not json\n")
        .unwrap();
    log.append(&TurnEnded {
        turn_id: s("t"),
        at: s("1"),
        outcome: s("aborted"),
        reason: Some(s("interrupted by user")),
        error: None,
    })
    .unwrap();
    let turn = &read(&log, None, 1, None)["turns"][0];
    assert_eq!(
        (turn["outcome"].as_str(), turn["reason"].as_str()),
        (Some("aborted"), Some("interrupted by user"))
    );
}
