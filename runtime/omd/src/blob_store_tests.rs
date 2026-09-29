use super::*;
use crate::resource_data::ResourceBinding;

fn binding() -> ResourceBinding {
    ResourceBinding {
        repository: "a".repeat(64),
        owner: "mod_a".into(),
        thread: "thread_1".into(),
        generation: 1,
        source_sha256: "b".repeat(64),
    }
}

fn with_store(test: impl FnOnce(&ResourceStore)) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let binding = binding();
    test(&ResourceStore {
        root: &root,
        binding: &binding,
    });
}

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";

#[test]
fn blobs_are_content_addressed_and_verified() {
    with_store(|store| {
        let digest = store.put_blob(b"hello").unwrap();
        assert_eq!(digest, hash(b"hello"));
        assert_eq!(store.put_blob(b"hello").unwrap(), digest);
        assert_eq!(store.blob(&digest).unwrap(), b"hello");
        fs::write(store.blob_path(&digest).unwrap(), b"tampered").unwrap();
        assert_eq!(
            store.blob(&digest).unwrap_err().to_string(),
            "blob_integrity_failed"
        );
        assert!(store.blob("../x").is_err());
        assert!(store.blob(&"c".repeat(64)).is_err());
        assert!(store.put_blob(&vec![0; BLOB_BYTES + 1]).is_err());
    });
}

#[test]
fn evidence_records_keep_text_and_json_inline_and_images_in_blobs() {
    with_store(|store| {
        let text = store
            .evidence_record(json!({"media_type": "text/plain", "content": "hi"}))
            .unwrap();
        assert_eq!(text["content"], "hi");
        let data = store
            .evidence_record(
                json!({"media_type": "application/json", "content": {"a": 1}, "label": "x"}),
            )
            .unwrap();
        assert_eq!(data["content"]["a"], 1);
        let image = store
            .evidence_record(json!({"media_type": "image/png", "base64": STANDARD.encode(PNG)}))
            .unwrap();
        assert_eq!(
            (
                image["bytes"].as_u64(),
                store.blob(image["blob"].as_str().unwrap()).unwrap()
            ),
            (Some(PNG.len() as u64), PNG.to_vec())
        );
    });
}

#[test]
fn invalid_evidence_is_refused() {
    with_store(|store| {
        for arguments in [
            json!({"media_type": "text/plain", "content": 1}),
            json!({"media_type": "image/png", "base64": STANDARD.encode(b"not a png")}),
            json!({"media_type": "image/jpeg", "base64": "***"}),
            json!({"media_type": "image/png", "content": "x"}),
            json!({"media_type": "text/html", "content": "x"}),
            json!({"media_type": "text/plain", "content": "x", "label": ""}),
            json!({"media_type": "text/plain", "content": "x", "extra": 1}),
        ] {
            assert!(
                store.evidence_record(arguments.clone()).is_err(),
                "{arguments}"
            );
        }
    });
}

#[test]
fn text_evidence_pages_over_the_blob_content() {
    with_store(|store| {
        let text = "line\n".repeat(10_000);
        let reference = store.text_evidence("tool_output", &text).unwrap();
        let first = store.page(&reference, "evidence", 0, 16_384).unwrap();
        assert_eq!(
            (
                first["text"].as_str().unwrap().len(),
                first["bytes"].as_u64()
            ),
            (16_384, Some(text.len() as u64))
        );
        assert!(first["text"].as_str().unwrap().starts_with("line\nline"));
        let cursor = first["cursor"].as_u64().unwrap() as usize;
        let second = store.page(&reference, "evidence", cursor, 16_384).unwrap();
        assert_eq!(
            &text[cursor..cursor + 16_384],
            second["text"].as_str().unwrap()
        );
    });
}
