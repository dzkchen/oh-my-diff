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
fn svg_evidence_is_gated() {
    with_store(|store| {
        let record = |svg: &str| {
            store
                .evidence_record(
                    json!({"media_type": "image/svg+xml", "base64": STANDARD.encode(svg)}),
                )
                .map_err(|error| error.to_string())
        };
        let svg = r##"<?xml version="1.0"?><!-- c --><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><style><![CDATA[.a{fill:url(#g)}]]></style><rect id="r" style="fill: url('#g')"/><use xlink:href="#r"/><image href="data:image/png;base64,iVBO"/></svg>"##;
        assert_eq!(
            record(svg).unwrap()["bytes"].as_u64(),
            Some(svg.len() as u64)
        );
        for (svg, reason) in [
            ("<svg><script>x</script></svg>", "svg_element_forbidden"),
            ("<svg><foreignObject/></svg>", "svg_element_forbidden"),
            (r#"<svg onload="x()"/>"#, "svg_event_handler"),
            (
                r#"<svg><img xmlns="http://www.w3.org/1999/xhtml"/></svg>"#,
                "svg_element_forbidden",
            ),
            (
                r#"<svg xmlns="http://www.w3.org/1999/xhtml"/>"#,
                "svg_element_forbidden",
            ),
            (
                r#"<svg xmlns:h="http://www.w3.org/1999/xhtml"><h:a/></svg>"#,
                "svg_element_forbidden",
            ),
            (
                r#"<svg><animate attributeName="OnClick" to="x()"/></svg>"#,
                "svg_event_handler",
            ),
            (
                r#"<svg><image src="x.png"/></svg>"#,
                "svg_attribute_forbidden",
            ),
            (r#"<svg><a ping="//e"/></svg>"#, "svg_attribute_forbidden"),
            (
                r#"<svg><use href="http://e/x.svg#a"/></svg>"#,
                "svg_href_external",
            ),
            (
                r#"<svg><a xlink:href="&#106;avascript:x"/></svg>"#,
                "svg_href_external",
            ),
            (
                r##"<svg><set attributeName="xlink:href" to="#a"/></svg>"##,
                "svg_href_external",
            ),
            (
                r#"<svg><rect fill="url(http://e/p)"/></svg>"#,
                "svg_url_external",
            ),
            (
                r#"<svg><rect style="fill:-WebKit-Image-Set(&quot;x&quot; 1x)"/></svg>"#,
                "svg_url_external",
            ),
            (
                r#"<svg><rect style="fill:image-set(&#39;x&#39; 1x)"/></svg>"#,
                "svg_url_external",
            ),
            (
                "<svg><style>@FONT-FACE{font-family:f}</style></svg>",
                "svg_url_external",
            ),
            (
                "<svg><style><![CDATA[a{b:sr]]><!---->c(x)}</style></svg>",
                "svg_url_external",
            ),
            (
                "<svg><style>a{b:ur<!---->l(//e)}</style></svg>",
                "svg_url_external",
            ),
            ("<svg><style>a{b:url(//e)}", "svg_malformed"),
            ("<!DOCTYPE svg><svg/>", "svg_doctype"),
            (
                r#"<svg><?xml-stylesheet href="x"?></svg>"#,
                "svg_processing_instruction",
            ),
            ("<html><svg/></html>", "svg_root_not_svg"),
            ("<!-- only -->", "svg_root_missing"),
        ] {
            assert_eq!(
                record(svg).unwrap_err(),
                format!("evidence_record_invalid: {reason}"),
                "{svg}"
            );
        }
        let large = format!("<svg>{}</svg>", " ".repeat(SVG_BYTES));
        assert_eq!(
            record(&large).unwrap_err(),
            "evidence_record_invalid: svg_too_large"
        );
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

#[test]
fn package_imports_survive_config_and_thread_changes_but_keep_owner_source_and_repository() {
    with_store(|store| {
        let mut package = store.binding.clone();
        package.thread = "package".into();
        package.generation = 0;
        let imported = ResourceStore {
            root: store.root,
            binding: &package,
        };
        let reference = imported
            .save(
                "evidence",
                imported
                    .evidence_record(
                        json!({"media_type":"image/png","base64":STANDARD.encode(PNG)}),
                    )
                    .unwrap(),
            )
            .unwrap();
        let mut next = store.binding.clone();
        next.generation += 1;
        next.thread = "thread_2".into();
        assert!(
            ResourceStore {
                root: store.root,
                binding: &next
            }
            .load(&reference, "evidence")
            .is_ok()
        );
        for changed in ["owner", "source", "repository"] {
            let mut other = next.clone();
            match changed {
                "owner" => other.owner = "mod_b".into(),
                "source" => other.source_sha256 = "c".repeat(64),
                _ => other.repository = "d".repeat(64),
            };
            assert!(
                ResourceStore {
                    root: store.root,
                    binding: &other
                }
                .load(&reference, "evidence")
                .is_err()
            );
        }
        let record = imported.load(&reference, "evidence").unwrap();
        fs::write(
            imported
                .blob_path(record["blob"].as_str().unwrap())
                .unwrap(),
            b"changed",
        )
        .unwrap();
        assert!(imported.blob(record["blob"].as_str().unwrap()).is_err());
    });
}
