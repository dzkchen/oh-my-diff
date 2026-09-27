use codex_omd::knowledge_access::KnowledgeAccess;
use codex_omd::resource_data::{ResourceBinding, ResourceRef, ResourceStore, hash};
use codex_omd::{KnowledgeAction, KnowledgeStore};
use serde_json::json;
use std::fs;

#[test]
fn immutable_resources_bind_owner_repository_thread_generation_and_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let binding = ResourceBinding {
        repository: hash(b"repo"),
        owner: "fixture".into(),
        thread: "thread-1".into(),
        generation: 1,
        source_sha256: hash(b"fixture-code"),
    };
    let store = ResourceStore {
        root: &root,
        binding: &binding,
    };
    let reference = store.save("turn", json!({"text":"hello 世界"})).unwrap();
    assert_eq!(
        store.load(&reference, "turn").unwrap()["text"],
        "hello 世界"
    );
    assert_eq!(
        store
            .save("turn", json!({"text":"hello 世界"}))
            .unwrap()
            .sha256,
        reference.sha256
    );
    assert!(store.load(&reference, "knowledge").is_err());
    for modified in [
        ResourceBinding {
            source_sha256: hash(b"changed-code"),
            ..binding.clone()
        },
        ResourceBinding {
            thread: "other".into(),
            ..binding.clone()
        },
        ResourceBinding {
            generation: 2,
            ..binding.clone()
        },
        ResourceBinding {
            owner: "other".into(),
            ..binding.clone()
        },
        ResourceBinding {
            repository: hash(b"other"),
            ..binding.clone()
        },
    ] {
        assert!(
            ResourceStore {
                root: &root,
                binding: &modified
            }
            .load(&reference, "turn")
            .is_err()
        );
    }
    let mut reconstructed = String::new();
    let mut offset = 0;
    loop {
        let page = store.page(&reference, "turn", offset, 8).unwrap();
        reconstructed.push_str(page["text"].as_str().unwrap());
        let Some(next) = page["cursor"].as_u64() else {
            break;
        };
        offset = next as usize;
    }
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&reconstructed).unwrap()["text"],
        "hello 世界"
    );
    let path = root
        .join("resources")
        .join(&binding.repository)
        .join(&binding.owner)
        .join(format!("{}.json", reference.reference));
    fs::write(&path, b"tampered").unwrap();
    assert!(
        store
            .load(&reference, "turn")
            .unwrap_err()
            .to_string()
            .contains("integrity")
    );
}

#[test]
fn frozen_knowledge_keeps_selection_and_revokes_deleted_or_changed_facts() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let repo = root.join("repo");
    fs::create_dir(&repo).unwrap();
    fs::write(repo.join("source.txt"), "stable fact\n").unwrap();
    let binding = ResourceBinding {
        repository: hash(repo.as_os_str().as_encoded_bytes()),
        owner: "fixture".into(),
        thread: "thread-1".into(),
        generation: 1,
        source_sha256: hash(b"fixture-code"),
    };
    let store = KnowledgeStore::create(root.join("knowledge"), binding.repository.clone()).unwrap();
    let readable = |_: &std::path::Path| true;
    let access = KnowledgeAccess {
        store: &store,
        repository: &repo,
        resources: ResourceStore {
            root: &root,
            binding: &binding,
        },
        user_action: None,
        readable: &readable,
    };
    access.call("knowledge.retain",json!({"expected_revision":0,"id":"fact-a","label":"source fact","source":{"path":"source.txt","start_line":1,"end_line":1}}),||true).unwrap();
    let reference: ResourceRef = serde_json::from_value(
        access
            .call(
                "context.freeze",
                json!({"mode":"reuse","ids":["fact-a"]}),
                || true,
            )
            .unwrap(),
    )
    .unwrap();
    let payload = json!({"snapshot":reference});
    assert_eq!(
        access
            .call("context.deliver", payload.clone(), || true)
            .unwrap()["facts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    access.call("knowledge.retain",json!({"expected_revision":1,"id":"fact-b","label":"additional fact","source":{"path":"source.txt","start_line":1,"end_line":1}}),||true).unwrap();
    assert_eq!(
        access
            .call("context.deliver", payload.clone(), || true)
            .unwrap()["facts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        access
            .call("knowledge.reset", json!({"expected_revision":2}), || true)
            .unwrap_err()
            .to_string()
            .contains("explicit_user")
    );
    fs::write(repo.join("source.txt"), "changed fact\n").unwrap();
    assert!(
        access
            .call("context.deliver", payload, || true)
            .unwrap_err()
            .to_string()
            .contains("source_changed")
    );
    let reference = access
        .call(
            "context.freeze",
            json!({"mode":"reuse","ids":["fact-a"]}),
            || true,
        )
        .unwrap();
    let access = KnowledgeAccess {
        user_action: Some(KnowledgeAction {
            actor: "user".into(),
            reason: "explicit test reset".into(),
        }),
        ..access
    };
    access
        .call(
            "knowledge.reset",
            json!({"expected_revision":store.revision().unwrap()}),
            || true,
        )
        .unwrap();
    assert!(
        access
            .call("context.deliver", json!({"snapshot":reference}), || true)
            .unwrap_err()
            .to_string()
            .contains("revoked")
    );
}

#[test]
fn source_denial_secret_exclusion_cold_mode_and_cancellation() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let repo = root.join("repo");
    fs::create_dir(&repo).unwrap();
    fs::write(repo.join("secret.txt"), "API_KEY=private\n").unwrap();
    fs::write(repo.join("plain.txt"), "allowed\n").unwrap();
    let binding = ResourceBinding {
        repository: hash(b"repo"),
        owner: "fixture".into(),
        thread: "thread-1".into(),
        generation: 1,
        source_sha256: hash(b"fixture-code"),
    };
    let store = KnowledgeStore::create(root.join("knowledge"), binding.repository.clone()).unwrap();
    let readable = |path: &std::path::Path| path.file_name().unwrap() != "plain.txt";
    let access = KnowledgeAccess {
        store: &store,
        repository: &repo,
        resources: ResourceStore {
            root: &root,
            binding: &binding,
        },
        user_action: None,
        readable: &readable,
    };
    for file in ["secret.txt", "plain.txt", "../escape"] {
        assert!(access.call("knowledge.retain",json!({"expected_revision":0,"id":"fact-a","label":"fact","source":{"path":file,"start_line":1,"end_line":1}}),||true).is_err());
    }
    assert_eq!(store.revision().unwrap(), 0);
    assert!(
        access
            .call("knowledge.inspect", json!({}), || false)
            .is_err()
    );
    let reference = access
        .call("context.freeze", json!({"mode":"cold","ids":[]}), || true)
        .unwrap();
    assert_eq!(
        access
            .call("context.deliver", json!({"snapshot":reference}), || true)
            .unwrap()["facts"],
        json!([])
    );
    assert!(
        access
            .call(
                "knowledge.approve",
                json!({"expected_revision":0,"lesson_id":"missing","action":{"actor":"user"}}),
                || true
            )
            .is_err()
    );
}

#[test]
fn stale_facts_and_secrets_outside_the_anchor_do_not_break_inspection() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let repo = root.join("repo");
    fs::create_dir(&repo).unwrap();
    fs::write(repo.join("config.txt"), "name = demo\npassword: hunter2\n").unwrap();
    fs::write(repo.join("gone.txt"), "temporary fact\n").unwrap();
    let binding = ResourceBinding {
        repository: hash(repo.as_os_str().as_encoded_bytes()),
        owner: "fixture".into(),
        thread: "thread-1".into(),
        generation: 1,
        source_sha256: hash(b"fixture-code"),
    };
    let store = KnowledgeStore::create(root.join("knowledge"), binding.repository.clone()).unwrap();
    let readable = |_: &std::path::Path| true;
    let access = KnowledgeAccess {
        store: &store,
        repository: &repo,
        resources: ResourceStore {
            root: &root,
            binding: &binding,
        },
        user_action: None,
        readable: &readable,
    };
    let retain = |revision: u64, id: &str, path: &str, line: u32| {
        access.call("knowledge.retain",json!({"expected_revision":revision,"id":id,"label":"fact","source":{"path":path,"start_line":line,"end_line":line}}),||true)
    };
    retain(0, "fact-a", "config.txt", 1).unwrap();
    retain(1, "fact-b", "gone.txt", 1).unwrap();
    assert!(retain(2, "fact-c", "config.txt", 2).is_err());
    fs::remove_file(repo.join("gone.txt")).unwrap();
    let inspection = access
        .call("knowledge.inspect", json!({}), || true)
        .unwrap();
    let status = |id: &str| {
        inspection["facts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|fact| fact["id"] == id)
            .unwrap()["status"]["status"]
            .clone()
    };
    assert_eq!(status("fact-a"), "fresh");
    assert_eq!(status("fact-b"), "invalidated");
}
