use codex_omd::EvidenceStatus;
use codex_omd::KnowledgeAction;
use codex_omd::KnowledgeApproval;
use codex_omd::KnowledgeMode;
use codex_omd::KnowledgeRemoval;
use codex_omd::KnowledgeReset;
use codex_omd::KnowledgeStore;
use codex_omd::LessonCandidate;
use codex_omd::RecordKind;
use codex_omd::SourceAnchor;
use codex_omd::SourceFactInput;
use codex_omd::SourceFactStatus;
use codex_omd::TaskEvidenceInput;
use std::sync::Arc;
use std::sync::Barrier;

fn hash(character: char) -> String {
    character.to_string().repeat(64)
}

fn action(reason: &str) -> KnowledgeAction {
    KnowledgeAction {
        actor: "maintainer@example.test".into(),
        reason: reason.into(),
    }
}

fn evidence_input(
    expected_revision: u64,
    id: &str,
    artifact: std::path::PathBuf,
) -> TaskEvidenceInput {
    TaskEvidenceInput {
        expected_revision,
        id: id.into(),
        task_id: "development-task".into(),
        summary: "Focused executable task evidence".into(),
        kind: "check".into(),
        workspace_sha256: hash('a'),
        artifact,
    }
}

fn fact_input(expected_revision: u64, id: &str) -> SourceFactInput {
    SourceFactInput {
        expected_revision,
        id: id.into(),
        task_id: "development-task".into(),
        label: "Selected configuration line".into(),
        source: SourceAnchor {
            path: "src/config.txt".into(),
            start_line: 2,
            end_line: 2,
        },
    }
}

fn fixture() -> (
    tempfile::TempDir,
    std::path::PathBuf,
    std::path::PathBuf,
    KnowledgeStore,
) {
    let temp = tempfile::tempdir().unwrap();
    let repository = temp.path().join("repository");
    let parent = temp.path().join("stores");
    std::fs::create_dir_all(repository.join("src")).unwrap();
    std::fs::create_dir(&parent).unwrap();
    std::fs::write(repository.join("src/config.txt"), "first\nsecond\n").unwrap();
    let artifact = temp.path().join("check.json");
    std::fs::write(&artifact, "{\"passed\":true}").unwrap();
    let store =
        KnowledgeStore::create(parent.join("knowledge"), "fixture/repository".into()).unwrap();
    (
        temp,
        repository.canonicalize().unwrap(),
        artifact.canonicalize().unwrap(),
        store,
    )
}

#[test]
fn retains_task_evidence_with_provenance_and_detects_tampering() {
    let (_temp, repository, artifact, store) = fixture();
    let evidence = store
        .retain_evidence(evidence_input(0, "check-1", artifact.clone()))
        .unwrap();
    assert_eq!(evidence.original_artifact, artifact);
    assert_eq!(evidence.workspace_sha256, hash('a'));
    assert_eq!(evidence.status, EvidenceStatus::Available);
    assert_eq!(
        std::fs::read(store.root().join(&evidence.retained_artifact)).unwrap(),
        b"{\"passed\":true}"
    );

    std::fs::write(store.root().join(&evidence.retained_artifact), "changed").unwrap();
    let inspection = store.inspect(&repository).unwrap();
    assert!(matches!(
        inspection.evidence[0].status,
        EvidenceStatus::Invalidated { .. }
    ));
    assert_eq!(inspection.events.last().unwrap().record_ids, ["check-1"]);
}

#[test]
fn refreshes_exact_source_facts_and_invalidates_missing_sources() {
    let (_temp, repository, _artifact, store) = fixture();
    let original = store
        .retain_source_fact(&repository, fact_input(0, "config-line"))
        .unwrap();
    let SourceFactStatus::Fresh { version } = original.status else {
        unreachable!();
    };
    assert_eq!(version.excerpt, "second");

    std::fs::write(repository.join("src/config.txt"), "first\nupdated\n").unwrap();
    let reused = store
        .session(&repository, KnowledgeMode::Reuse, 65_536)
        .unwrap();
    assert_eq!(reused.refreshed_fact_ids, ["config-line"]);
    let SourceFactStatus::Fresh { version } = &reused.facts[0].status else {
        unreachable!();
    };
    assert_eq!(version.excerpt, "updated");

    std::fs::remove_file(repository.join("src/config.txt")).unwrap();
    let invalidated = store
        .session(&repository, KnowledgeMode::Reuse, 65_536)
        .unwrap();
    assert!(invalidated.facts.is_empty());
    assert_eq!(invalidated.invalidated_ids, ["config-line"]);
    assert!(matches!(
        store.inspect(&repository).unwrap().facts[0].status,
        SourceFactStatus::Invalidated { .. }
    ));
}

#[test]
fn inferred_lessons_are_inert_until_explicit_approval() {
    let (_temp, repository, artifact, store) = fixture();
    store
        .retain_evidence(evidence_input(0, "check-1", artifact))
        .unwrap();
    store
        .propose_lesson(LessonCandidate {
            expected_revision: 1,
            id: "lesson-1".into(),
            task_id: "development-task".into(),
            text: "Run the focused configuration check after changing the manifest.".into(),
            evidence_ids: vec!["check-1".into()],
        })
        .unwrap();
    let candidate = store
        .session(&repository, KnowledgeMode::Reuse, 65_536)
        .unwrap();
    assert!(candidate.approved_lessons.is_empty());
    assert!(!candidate.render().unwrap().contains("configuration check"));

    store
        .approve_lesson(KnowledgeApproval {
            expected_revision: 2,
            lesson_id: "lesson-1".into(),
            action: action("Approve this bounded repository lesson for reuse"),
        })
        .unwrap();
    let approved = store
        .session(&repository, KnowledgeMode::Reuse, 65_536)
        .unwrap();
    assert_eq!(approved.approved_lessons.len(), 1);
    assert!(approved.render().unwrap().contains("configuration check"));
}

#[test]
fn cold_state_excludes_reuse_and_removal_invalidates_dependencies() {
    let (_temp, repository, artifact, store) = fixture();
    store
        .retain_evidence(evidence_input(0, "check-1", artifact))
        .unwrap();
    store
        .propose_lesson(LessonCandidate {
            expected_revision: 1,
            id: "lesson-1".into(),
            task_id: "development-task".into(),
            text: "Reusable only after approval.".into(),
            evidence_ids: vec!["check-1".into()],
        })
        .unwrap();
    store
        .approve_lesson(KnowledgeApproval {
            expected_revision: 2,
            lesson_id: "lesson-1".into(),
            action: action("Approve for a reuse trial"),
        })
        .unwrap();

    let cold = store
        .session(&repository, KnowledgeMode::Cold, 65_536)
        .unwrap();
    assert_eq!(cold.mode, KnowledgeMode::Cold);
    assert!(cold.facts.is_empty());
    assert!(cold.approved_lessons.is_empty());
    assert!(cold.render().unwrap().contains("no retained task evidence"));

    store
        .remove(KnowledgeRemoval {
            expected_revision: 3,
            kind: RecordKind::Evidence,
            id: "check-1".into(),
            action: action("Remove retained check evidence"),
        })
        .unwrap();
    let reused = store
        .session(&repository, KnowledgeMode::Reuse, 65_536)
        .unwrap();
    assert!(reused.approved_lessons.is_empty());
    assert!(store.inspect(&repository).unwrap().evidence.is_empty());
}

#[test]
fn reset_advances_generation_and_clears_all_reusable_state() {
    let (_temp, repository, artifact, store) = fixture();
    store
        .retain_evidence(evidence_input(0, "check-1", artifact))
        .unwrap();
    store
        .retain_source_fact(&repository, fact_input(1, "config-line"))
        .unwrap();
    let reset = store
        .reset(KnowledgeReset {
            expected_revision: 2,
            action: action("Start an isolated cold trial"),
        })
        .unwrap();
    assert_eq!(reset.generation, 1);
    assert!(reset.evidence.is_empty());
    assert!(reset.facts.is_empty());
    assert!(reset.lessons.is_empty());
    let reused = store
        .session(&repository, KnowledgeMode::Reuse, 65_536)
        .unwrap();
    assert_eq!(reused.generation, 1);
    assert!(reused.facts.is_empty());
    assert!(reused.approved_lessons.is_empty());
}

#[test]
fn concurrent_writers_cannot_overwrite_same_revision() {
    let (_temp, _repository, artifact, store) = fixture();
    let store = Arc::new(store);
    let barrier = Arc::new(Barrier::new(3));
    let threads = ["check-a", "check-b"].map(|id| {
        let store = store.clone();
        let artifact = artifact.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            barrier.wait();
            store.retain_evidence(evidence_input(0, id, artifact))
        })
    });
    barrier.wait();
    let results = threads.map(|thread| thread.join().unwrap());
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
    assert_eq!(store.revision().unwrap(), 1);
}

#[test]
fn unsafe_source_paths_and_unbounded_context_fail_closed() {
    let (_temp, repository, artifact, store) = fixture();
    let mut input = fact_input(0, "unsafe");
    input.source.path = "../outside".into();
    assert!(store.retain_source_fact(&repository, input).is_err());
    assert!(store.session(&repository, KnowledgeMode::Reuse, 0).is_err());
    assert!(
        store
            .retain_evidence(evidence_input(0, "safe/../escape", artifact))
            .is_err()
    );
}
