use codex_omd::resource_data::{ResourceBinding, ResourceStore, hash};
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
