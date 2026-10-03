use super::*;
use std::path::Path;

pub(crate) fn open(
    sessions: &Path,
    repository: &str,
    thread: ThreadId,
    limits: codex_omd::Limits,
    resumed: bool,
) -> Result<Task, String> {
    let directory = sessions.join(format!("ledger-{repository}-{thread}"));
    let identity = json!({"schema":1,"repository":repository,"thread":thread});
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) => {
            if !metadata.is_dir()
                || directory.canonicalize().map_err(|e| e.to_string())? != directory
            {
                return Err("ledger_directory_invalid".into());
            }
            if !resumed {
                return Err("ledger_requires_explicit_thread_resume".into());
            }
            let saved = codex_omd::Snapshot::capture(
                &directory,
                &std::collections::BTreeSet::from(["identity.json".into()]),
                1024,
            )
            .map_err(|e| e.to_string())?;
            let saved: Value = serde_json::from_slice(
                &saved
                    .files
                    .get("identity.json")
                    .ok_or("ledger_identity_missing")?
                    .bytes,
            )
            .map_err(|e| e.to_string())?;
            if saved != identity {
                return Err("ledger_identity_changed".into());
            }
            Task::open(limits, directory, Some(&thread.to_string())).map_err(|e| e.to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let task = Task::create(limits, directory.clone()).map_err(|e| e.to_string())?;
            persist(
                &directory,
                "identity.json",
                &serde_json::to_vec(&identity).map_err(|e| e.to_string())?,
                false,
            )?;
            Ok(task)
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> codex_omd::Limits {
        codex_omd::Limits {
            requests: 3,
            exposure_microusd: 100,
            seconds: 300,
            concurrent_workers: 2,
            max_depth: 2,
        }
    }

    #[test]
    fn resumed_ledgers_keep_allowance_observation_and_uncertain_requests() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let thread = ThreadId::new();
        let task = open(&root, "repository", thread, limits(), false).unwrap();
        task.authorize_route("fixture", "worker").unwrap();
        let request = task.admit("lead", "fixture", "worker", 30).unwrap();
        task.dispatch(&request, || Ok(())).unwrap();
        task.observe(
            "lead",
            "fixture",
            "main",
            Some(json!({"input_tokens":10})),
            "completed",
        )
        .unwrap();
        drop(task);
        assert!(open(&root, "repository", thread, limits(), false).is_err());
        let task = open(&root, "repository", thread, limits(), true).unwrap();
        assert_eq!(task.remaining().unwrap().1, 2);
        assert_eq!(task.remaining().unwrap().2, 70);
        assert_eq!(task.uncertain_requests().unwrap(), vec![1]);
        assert_eq!(task.cost_capture().unwrap().observed.len(), 1);
        drop(task);
        let mut raised = limits();
        raised.exposure_microusd = 200;
        let task = open(&root, "repository", thread, raised, true).unwrap();
        assert_eq!(task.remaining().unwrap().2, 170);
        task.set_limits(limits()).unwrap();
        assert_eq!(task.remaining().unwrap().2, 70);
        drop(task);
        let task = open(&root, "repository", thread, limits(), true).unwrap();
        assert_eq!(task.remaining().unwrap().2, 70);
        drop(task);
        let path = root
            .join(format!("ledger-repository-{thread}"))
            .join("identity.json");
        std::fs::write(&path, b"{}").unwrap();
        assert!(open(&root, "repository", thread, limits(), true).is_err());
    }

    #[test]
    fn session_evidence_directories_do_not_block_a_resumed_thread_in_another_repository() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let thread = ThreadId::new();
        drop(open(&root, "first", thread, limits(), false).unwrap());
        std::fs::create_dir(root.join(format!("{thread}-1-{}", ThreadId::new()))).unwrap();
        assert!(open(&root, "second", thread, limits(), true).is_ok());
        assert!(root.join(format!("ledger-second-{thread}")).is_dir());
    }

    #[test]
    fn symlinked_ledgers_never_reset_allowance() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let other = ThreadId::new();
        std::os::unix::fs::symlink(&root, root.join(format!("ledger-repository-{other}"))).unwrap();
        assert!(open(&root, "repository", other, limits(), true).is_err());
    }
}
