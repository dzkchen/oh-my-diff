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

