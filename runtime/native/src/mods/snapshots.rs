use super::*;
use codex_omd::Snapshot;
use codex_omd::resource_data::ResourceRef;
use std::collections::BTreeSet;

const SNAPSHOT_LIMIT: usize = 16;
const SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const EXECUTION_LIMIT: usize = 64;

struct Stored {
    owner: String,
    generation: u64,
    thread: ThreadId,
    source: String,
    snapshot: Arc<Snapshot>,
    digest: String,
    bytes: usize,
    sequence: u64,
}

#[derive(Default)]
pub(super) struct Snapshots {
    entries: BTreeMap<String, Stored>,
    executions: BTreeMap<String, Execution>,
    sequence: u64,
}

struct Execution {
    owner: String,
    source: String,
    generation: u64,
    thread: ThreadId,
    candidate: String,
    evidence: ResourceRef,
    passed: bool,
    sequence: u64,
}

impl Snapshots {
    fn next(&mut self) -> u64 {
        self.sequence += 1;
        self.sequence
    }

    pub(super) fn record_execution(
        &mut self,
        caller: &operations::Caller<'_>,
        thread: ThreadId,
        candidate: String,
        evidence: ResourceRef,
        result: &Value,
    ) {
        if self.executions.len() >= EXECUTION_LIMIT
            && let Some(oldest) = self
                .executions
                .iter()
                .min_by_key(|(_, entry)| entry.sequence)
                .map(|(key, _)| key.clone())
        {
            self.executions.remove(&oldest);
        }
        let sequence = self.next();
        self.executions.insert(
            evidence.reference.clone(),
            Execution {
                owner: caller.id.into(),
                source: caller.source.into(),
                generation: caller.generation,
                thread,
                candidate,
                evidence,
                passed: result["exit_code"] == 0
                    && result["signal"].is_null()
                    && result["timed_out"] == false
                    && result["stdout_truncated"] == false
                    && result["stderr_truncated"] == false,
                sequence,
            },
        );
    }

    pub(super) fn attest_execution(
        &self,
        caller: &operations::Caller<'_>,
        thread: ThreadId,
        candidate: &str,
        evidence: &ResourceRef,
        outcome: codex_omd::ReceiptOutcome,
    ) -> Result<(), String> {
        let record = self
            .executions
            .get(&evidence.reference)
            .filter(|record| {
                record.owner == caller.id
                    && record.source == caller.source
                    && record.generation == caller.generation
                    && record.thread == thread
                    && record.candidate == candidate
                    && record.evidence.sha256 == evidence.sha256
            })
            .ok_or("unknown_or_foreign_execution")?;
        if outcome == codex_omd::ReceiptOutcome::Pass && !record.passed {
            return Err("execution_did_not_pass".into());
        }
        Ok(())
    }

    pub(super) fn insert(
        &mut self,
        caller: &operations::Caller<'_>,
        thread: ThreadId,
        snapshot: Snapshot,
    ) -> Result<Value, String> {
        let digest = snapshot.hash().map_err(|error| error.to_string())?;
        let reference = format!(
            "snapshot:{}",
            execution::hash(
                &serde_json::to_vec(&(
                    caller.id,
                    caller.generation,
                    thread,
                    caller.source,
                    &digest
                ))
                .map_err(|error| error.to_string())?
            )
        );
        if !self.entries.contains_key(&reference) {
            let bytes = snapshot
                .files
                .iter()
                .try_fold(0usize, |total, (name, file)| {
                    total
                        .checked_add(name.len())
                        .and_then(|n| n.checked_add(file.bytes.len()))
                })
                .ok_or("snapshot_byte_limit")?;
            if bytes > SNAPSHOT_BYTES {
                return Err("snapshot_limit".into());
            }
            while self.entries.len() >= SNAPSHOT_LIMIT
                || bytes
                    > SNAPSHOT_BYTES
                        - self
                            .entries
                            .values()
                            .map(|entry| entry.bytes)
                            .sum::<usize>()
            {
                let oldest = self
                    .entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.sequence)
                    .map(|(key, _)| key.clone())
                    .ok_or("snapshot_limit")?;
                self.entries.remove(&oldest);
            }
            let sequence = self.next();
            self.entries.insert(
                reference.clone(),
                Stored {
                    owner: caller.id.into(),
                    generation: caller.generation,
                    thread,
                    source: caller.source.into(),
                    snapshot: Arc::new(snapshot),
                    digest: digest.clone(),
                    bytes,
                    sequence,
                },
            );
        }
        Ok(
            json!({"snapshot": {"reference": reference, "sha256": digest},
            "candidate_sha256": digest}),
        )
    }

    pub(super) fn get(
        &self,
        caller: &operations::Caller<'_>,
        thread: ThreadId,
        reference: &ResourceRef,
    ) -> Result<Arc<Snapshot>, String> {
        let stored = self
            .entries
            .get(&reference.reference)
            .filter(|entry| {
                entry.owner == caller.id
                    && entry.generation == caller.generation
                    && entry.thread == thread
                    && entry.source == caller.source
            })
            .ok_or("unknown_or_foreign_snapshot")?;
        if stored.digest != reference.sha256 {
            return Err("snapshot_digest_mismatch".into());
        }
        Ok(stored.snapshot.clone())
    }

    pub(super) fn remove_owner(&mut self, owner: &str, generation: u64) {
        self.entries
            .retain(|_, entry| entry.owner != owner || entry.generation != generation);
        self.executions
            .retain(|_, entry| entry.owner != owner || entry.generation != generation);
    }

    pub(super) fn remove_thread(&mut self, thread: ThreadId) {
        self.entries.retain(|_, entry| entry.thread != thread);
        self.executions.retain(|_, entry| entry.thread != thread);
    }
}

pub(super) fn permitted(
    snapshot: &Snapshot,
    authority: &crate::workspace_operations::WorkspaceAuthority,
    protected: &[PathBuf],
) -> Result<(), String> {
    for name in snapshot.files.keys() {
        let path = codex_omd::workspace_path(&authority.repository, name)
            .map_err(|error| error.to_string())?;
        if !authority.readable(&path) || protected.iter().any(|root| path.starts_with(root)) {
            return Err("snapshot_permission_denied".into());
        }
    }
    Ok(())
}

pub(super) fn capture(
    authority: &crate::workspace_operations::WorkspaceAuthority,
    protected: &[PathBuf],
    approved: &BTreeSet<String>,
    limit: usize,
    active: &dyn Fn() -> bool,
) -> Result<Snapshot, String> {
    if !active() {
        return Err("snapshot_cancelled".into());
    }
    let paths = codex_omd::tracked_paths(&authority.repository, approved)
        .map_err(|error| error.to_string())?;
    for name in &paths {
        let path = codex_omd::workspace_path(&authority.repository, name)
            .map_err(|error| error.to_string())?;
        if !authority.readable(&path) || protected.iter().any(|root| path.starts_with(root)) {
            return Err("snapshot_permission_denied".into());
        }
    }
    let snapshot = Snapshot::capture(&authority.repository, &paths, limit)
        .map_err(|error| error.to_string())?;
    if !active() {
        return Err("snapshot_cancelled".into());
    }
    if codex_omd::tracked_paths(&authority.repository, approved)
        .map_err(|error| error.to_string())?
        != paths
    {
        return Err("snapshot_source_changed".into());
    }
    permitted(&snapshot, authority, protected)?;
    Ok(snapshot)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Capture {
    pub agent: Option<String>,
    pub expected: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_file_system::FileSystemSandboxContext;
    use codex_protocol::models::PermissionProfile;
    use codex_protocol::permissions::{
        FileSystemAccessMode, FileSystemPath, FileSystemSandboxEntry, FileSystemSandboxPolicy,
        NetworkSandboxPolicy,
    };
    use codex_utils_absolute_path::AbsolutePathBuf;
    use codex_utils_path_uri::PathUri;

    fn authority(
        repository: PathBuf,
        access: FileSystemAccessMode,
    ) -> crate::workspace_operations::WorkspaceAuthority {
        let absolute = AbsolutePathBuf::from_absolute_path_checked(&repository).unwrap();
        let cwd = PathUri::from_abs_path(&absolute);
        let policy = FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry::new(
            FileSystemPath::Path { path: cwd.clone() },
            access,
        )]);
        let profile =
            PermissionProfile::from_runtime_permissions(&policy, NetworkSandboxPolicy::Restricted);
        crate::workspace_operations::WorkspaceAuthority {
            repository,
            session_root: None,
            session_database: None,
            policy,
            context: FileSystemSandboxContext::from_permission_profile(profile, cwd),
        }
    }

    fn caller(id: &str, source: &str, generation: u64) -> operations::Caller<'static> {
        operations::Caller {
            id: if id == "one" { "one" } else { "two" },
            source: if source == "a" { "a" } else { "b" },
            generation,
            grants: None,
            origin: codex_omd::data_store::Origin::Event,
            record_changes: false,
        }
    }

    #[test]
    fn snapshots_are_owner_source_generation_thread_and_digest_bound() {
        let mut store = Snapshots::default();
        let thread = ThreadId::new();
        let owner = caller("one", "a", 1);
        let snapshot = Snapshot {
            files: BTreeMap::new(),
        };
        let value = store.insert(&owner, thread, snapshot.clone()).unwrap();
        let reference: ResourceRef = serde_json::from_value(value["snapshot"].clone()).unwrap();
        assert_eq!(*store.get(&owner, thread, &reference).unwrap(), snapshot);
        for stranger in [
            caller("two", "a", 1),
            caller("one", "b", 1),
            caller("one", "a", 2),
        ] {
            assert!(store.get(&stranger, thread, &reference).is_err());
        }
        assert!(store.get(&owner, ThreadId::new(), &reference).is_err());
        let changed = ResourceRef {
            sha256: "0".repeat(64),
            ..reference.clone()
        };
        assert!(store.get(&owner, thread, &changed).is_err());
        store.remove_owner("one", 1);
        assert!(store.get(&owner, thread, &reference).is_err());
    }

    #[test]
    fn snapshots_deduplicate_and_evict_the_oldest_until_session_cleanup() {
        let mut store = Snapshots::default();
        let owner = caller("one", "a", 1);
        let thread = ThreadId::new();
        let mut first = None;
        for number in 0..SNAPSHOT_LIMIT {
            let snapshot = Snapshot {
                files: BTreeMap::from([(
                    "file".into(),
                    codex_omd::File {
                        bytes: vec![number as u8],
                        executable: false,
                    },
                )]),
            };
            let inserted = store.insert(&owner, thread, snapshot.clone()).unwrap();
            assert_eq!(store.insert(&owner, thread, snapshot).unwrap(), inserted);
            first.get_or_insert(inserted);
        }
        let first: ResourceRef =
            serde_json::from_value(first.unwrap()["snapshot"].clone()).unwrap();
        assert!(store.get(&owner, thread, &first).is_ok());
        let empty = Snapshot {
            files: BTreeMap::new(),
        };
        assert!(store.insert(&owner, thread, empty).is_ok());
        assert_eq!(store.entries.len(), SNAPSHOT_LIMIT);
        assert!(store.get(&owner, thread, &first).is_err());
        store.remove_thread(thread);
        assert!(store.entries.is_empty());
    }

    #[test]
    fn capture_requires_current_permissions_and_preserves_frozen_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        assert!(
            std::process::Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(&root)
                .status()
                .unwrap()
                .success()
        );
        std::fs::write(root.join("source"), "before").unwrap();
        let paths = BTreeSet::from(["source".into()]);
        let readable = authority(root.clone(), FileSystemAccessMode::Read);
        let captured = capture(&readable, &[], &paths, 128, &|| true).unwrap();
        std::fs::write(root.join("source"), "after").unwrap();
        assert_eq!(captured.files["source"].bytes, b"before");
        assert_ne!(
            captured.hash().unwrap(),
            capture(&readable, &[], &paths, 128, &|| true)
                .unwrap()
                .hash()
                .unwrap()
        );
        assert!(capture(&readable, &[], &paths, 1, &|| true).is_err());
        assert!(capture(&readable, &[], &paths, 128, &|| false).is_err());
        assert!(capture(&readable, &[root.join("source")], &paths, 128, &|| true).is_err());
        let denied = authority(root.clone(), FileSystemAccessMode::Deny);
        assert!(capture(&denied, &[], &paths, 128, &|| true).is_err());
        assert!(permitted(&captured, &denied, &[]).is_err());
        std::fs::remove_file(root.join("source")).unwrap();
        std::os::unix::fs::symlink("elsewhere", root.join("source")).unwrap();
        assert!(capture(&readable, &[], &paths, 128, &|| true).is_err());
    }

    #[test]
    fn execution_receipts_reject_forged_bindings_and_false_success() {
        let mut store = Snapshots::default();
        let owner = caller("one", "a", 1);
        let thread = ThreadId::new();
        let candidate = "a".repeat(64);
        let evidence = ResourceRef {
            reference: "execution:one".into(),
            sha256: "b".repeat(64),
        };
        let passed = json!({"exit_code":0,"signal":null,"timed_out":false,"stdout_truncated":false,"stderr_truncated":false});
        store.record_execution(&owner, thread, candidate.clone(), evidence.clone(), &passed);
        let attest = |store: &Snapshots,
                      caller: &operations::Caller<'_>,
                      thread,
                      candidate: &str,
                      evidence: &ResourceRef| {
            store.attest_execution(
                caller,
                thread,
                candidate,
                evidence,
                codex_omd::ReceiptOutcome::Pass,
            )
        };
        assert!(attest(&store, &owner, thread, &candidate, &evidence).is_ok());
        assert!(
            attest(
                &store,
                &caller("two", "a", 1),
                thread,
                &candidate,
                &evidence
            )
            .is_err()
        );
        assert!(
            attest(
                &store,
                &caller("one", "b", 1),
                thread,
                &candidate,
                &evidence
            )
            .is_err()
        );
        assert!(
            attest(
                &store,
                &caller("one", "a", 2),
                thread,
                &candidate,
                &evidence
            )
            .is_err()
        );
        assert!(attest(&store, &owner, ThreadId::new(), &candidate, &evidence).is_err());
        assert!(attest(&store, &owner, thread, &"c".repeat(64), &evidence).is_err());
        assert!(
            attest(
                &store,
                &owner,
                thread,
                &candidate,
                &ResourceRef {
                    sha256: "c".repeat(64),
                    ..evidence.clone()
                }
            )
            .is_err()
        );
        for (key, value) in [
            ("exit_code", json!(1)),
            ("timed_out", json!(true)),
            ("stdout_truncated", json!(true)),
            ("signal", json!("9")),
        ] {
            let mut failed = passed.clone();
            failed[key] = value;
            store.record_execution(&owner, thread, candidate.clone(), evidence.clone(), &failed);
            assert!(attest(&store, &owner, thread, &candidate, &evidence).is_err());
            assert!(
                store
                    .attest_execution(
                        &owner,
                        thread,
                        &candidate,
                        &evidence,
                        codex_omd::ReceiptOutcome::Fail
                    )
                    .is_ok()
            );
        }
        store.record_execution(&owner, thread, candidate.clone(), evidence.clone(), &passed);
        for index in 0..EXECUTION_LIMIT {
            let other = ResourceRef {
                reference: format!("execution:other-{index}"),
                sha256: "d".repeat(64),
            };
            store.record_execution(&owner, thread, candidate.clone(), other, &passed);
        }
        assert_eq!(store.executions.len(), EXECUTION_LIMIT);
        assert!(attest(&store, &owner, thread, &candidate, &evidence).is_err());
        store.remove_thread(thread);
        assert!(store.executions.is_empty());
    }
}
