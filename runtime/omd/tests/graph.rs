use codex_omd::CodeGraph;
use codex_omd::GraphConfidence;
use codex_omd::GraphFreshness;
use codex_omd::GraphLimits;
use codex_omd::GraphNodeKind;
use codex_omd::GraphRelationship;
use std::fs;
use std::path::PathBuf;

fn fixture() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fs::create_dir_all(root.join("src")).unwrap();
    fs::create_dir_all(root.join("tests")).unwrap();
    fs::write(
        root.join("src/lib.rs"),
        "mod worker;\nuse crate::worker::run;\npub fn entry() { run(); mystery(); }\n",
    )
    .unwrap();
    fs::write(
        root.join("src/worker.rs"),
        "pub fn run() { service(); }\nfn service() {}\n",
    )
    .unwrap();
    fs::write(
        root.join("tests/graph_test.rs"),
        "use crate::worker::run;\n#[test]\nfn test_run() { run(); }\n",
    )
    .unwrap();
    fs::write(
        root.join("app.py"),
        "from service import handle\ndef py_call():\n    handle()\n",
    )
    .unwrap();
    fs::write(root.join("service.py"), "def handle():\n    pass\n").unwrap();
    fs::write(
        root.join("client.ts"),
        "import { helper } from './helper';\nexport function invoke() { helper(); }\n",
    )
    .unwrap();
    fs::write(root.join("helper.ts"), "export function helper() {}\n").unwrap();
    fs::write(
        root.join("Demo.java"),
        "import demo.Missing;\nclass Demo { void execute() { absent(); } }\n",
    )
    .unwrap();
    temp
}

#[test]
fn one_versioned_graph_supports_both_views_and_evidence_selection() {
    let temp = fixture();
    let graph = CodeGraph::build(
        temp.path(),
        "fixture/repository".to_string(),
        "fixture-revision".to_string(),
        GraphLimits::default(),
    )
    .unwrap();
    assert_eq!(graph.schema, 1);
    assert!(graph.nodes.iter().any(|node| node.name == "entry"));
    assert!(
        graph
            .nodes
            .iter()
            .any(|node| node.kind == GraphNodeKind::Test)
    );
    assert!(graph.edges.iter().any(|edge| {
        edge.relationship == GraphRelationship::Imports
            && edge.confidence == GraphConfidence::Extracted
    }));
    assert!(graph.edges.iter().any(|edge| {
        edge.relationship == GraphRelationship::Calls
            && edge.confidence == GraphConfidence::Inferred
    }));
    assert!(
        graph
            .edges
            .iter()
            .any(|edge| edge.confidence == GraphConfidence::Unknown)
    );
    assert!(
        graph
            .coverage
            .iter()
            .any(|item| item.unknown_relationships > 0)
    );

    let selected = graph
        .nodes
        .iter()
        .find(|node| node.name == "entry")
        .unwrap();
    let evidence = graph.select(std::slice::from_ref(&selected.id)).unwrap();
    assert!(evidence.nodes.iter().any(|node| node.id == selected.id));
    assert!(!evidence.relationships.is_empty());
    let prompt = graph
        .selection_prompt(std::slice::from_ref(&selected.id))
        .unwrap();
    assert!(prompt.contains("Verify inferred and unknown"));

    let graph_path = temp.path().join("snapshot/graph.json");
    let html_path = temp.path().join("snapshot/graph.html");
    graph.write(&graph_path).unwrap();
    graph.write_html(&html_path).unwrap();
    let loaded = CodeGraph::read(&graph_path).unwrap();
    assert_eq!(loaded, graph);
    let html = fs::read_to_string(&html_path).unwrap();
    assert!(html.contains("graph-data"));
    assert!(html.contains("Copy selections"));
    assert!(html.contains(&graph.repository.source_digest));
    assert_eq!(graph.freshness(temp.path()).unwrap(), GraphFreshness::Fresh);
    graph.write(&graph_path).unwrap();
    graph.write_html(&html_path).unwrap();
    let source = temp.path().join("src/lib.rs");
    let original = fs::read(&source).unwrap();
    assert!(graph.write(&source).is_err());
    assert!(graph.write_html(&source).is_err());
    assert_eq!(fs::read(&source).unwrap(), original);
    assert!(graph.write(&html_path).is_err());
}

#[test]
fn regeneration_is_deterministic_and_detects_changed_missing_and_added_sources() {
    let temp = fixture();
    let first = CodeGraph::build(
        temp.path(),
        "fixture/repository".to_string(),
        "revision".to_string(),
        GraphLimits::default(),
    )
    .unwrap();
    let second = CodeGraph::build(
        temp.path(),
        "fixture/repository".to_string(),
        "revision".to_string(),
        GraphLimits::default(),
    )
    .unwrap();
    assert_eq!(first, second);
    fs::write(temp.path().join("src/lib.rs"), "pub fn changed() {}\n").unwrap();
    fs::remove_file(temp.path().join("service.py")).unwrap();
    fs::write(temp.path().join("added.js"), "export function added() {}\n").unwrap();
    let GraphFreshness::Stale {
        added,
        changed,
        missing,
    } = first.freshness(temp.path()).unwrap()
    else {
        panic!("graph should be stale")
    };
    assert_eq!(added, [PathBuf::from("added.js")]);
    assert_eq!(changed, [PathBuf::from("src/lib.rs")]);
    assert_eq!(missing, [PathBuf::from("service.py")]);
}

#[test]
fn bounds_and_tampering_fail_closed() {
    let temp = fixture();
    let limits = GraphLimits {
        max_files: 1,
        ..GraphLimits::default()
    };
    assert!(
        CodeGraph::build(
            temp.path(),
            "fixture/repository".to_string(),
            "revision".to_string(),
            limits,
        )
        .is_err()
    );

    let mut graph = CodeGraph::build(
        temp.path(),
        "fixture/repository".to_string(),
        "revision".to_string(),
        GraphLimits::default(),
    )
    .unwrap();
    graph.repository.source_digest = "tampered".to_string();
    assert!(graph.validate().is_err());
}

#[test]
fn html_escapes_embedded_repository_metadata() {
    let temp = fixture();
    fs::write(
        temp.path().join("evil&quot;onmouseover=alert(1).rs"),
        "pub fn linked() {}\n",
    )
    .unwrap();
    let graph = CodeGraph::build(
        temp.path(),
        "</script><script>alert(1)</script>".to_string(),
        "revision".to_string(),
        GraphLimits::default(),
    )
    .unwrap();
    let html = graph.html().unwrap();
    assert!(!html.contains("</script><script>alert(1)</script>"));
    assert!(html.contains("\\u003c/script\\u003e"));
    assert!(html.contains("evil\\u0026quot;onmouseover=alert(1).rs"));
    assert!(html.contains("href=\"${esc(href(a))}\""));
    assert!(html.contains("href=\"${esc(href(e.evidence))}\""));
}
