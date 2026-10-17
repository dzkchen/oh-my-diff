use super::*;
use std::collections::BTreeMap;
use std::sync::mpsc;

fn fixture() -> (tempfile::TempDir, WorkspaceWatches) {
    let dir = tempfile::tempdir().unwrap();
    for sub in ["src", ".git", "store"] {
        std::fs::create_dir_all(dir.path().join(sub)).unwrap();
    }
    let root = dir.path().canonicalize().unwrap();
    let watches = WorkspaceWatches::new(
        Arc::new(FileWatcher::new().unwrap()),
        root.clone(),
        vec![root.join("store")],
        Default::default(),
    )
    .unwrap();
    (dir, watches)
}

fn channel_sink() -> (ChangeSink, mpsc::Receiver<(String, Vec<String>)>) {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    (
        Arc::new(move |id: &str, paths: Vec<String>| {
            let _ = tx.lock().unwrap().send((id.to_owned(), paths));
        }),
        rx,
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn external_changes_are_reported_relative_to_the_root() {
    let (dir, watches) = fixture();
    let (sink, rx) = channel_sink();
    let id = watches
        .watch("m", "sha", &["src".to_owned()], true, Some(50), sink)
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let file = dir.path().join("src/a.txt");
    let (watch_id, paths) = tokio::task::spawn_blocking(move || {
        let mut seen = Vec::new();
        for round in 0..20 {
            std::fs::write(&file, round.to_string()).unwrap();
            while let Ok(batch) = rx.recv_timeout(Duration::from_millis(500)) {
                if batch.1.iter().any(|p| p == "src/a.txt") {
                    return batch;
                }
                seen.push(batch);
            }
        }
        panic!("{seen:?}")
    })
    .await
    .unwrap();
    assert_eq!(watch_id, id);
    assert!(paths.iter().any(|p| p == "src/a.txt"), "{paths:?}");
    assert!(watches.unwatch("m", &id));
    assert!(!watches.unwatch("m", &id));
}

#[tokio::test(flavor = "multi_thread")]
async fn paths_outside_git_and_protected_areas_are_refused() {
    let (_dir, watches) = fixture();
    for path in ["/etc", "../x", "src/../../x", ".git", "store", "missing"] {
        let (sink, _rx) = channel_sink();
        assert!(
            watches
                .watch("m", "sha", &[path.to_owned()], false, None, sink)
                .is_err(),
            "{path}"
        );
    }
    let (sink, _rx) = channel_sink();
    assert!(
        watches
            .watch("m", "sha", &["src".to_owned()], false, Some(10), sink)
            .is_err()
    );
    let (sink, _rx) = channel_sink();
    assert!(watches.watch("m", "sha", &[], false, None, sink).is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn watches_are_limited_per_mod_and_released_with_their_source() {
    let (_dir, watches) = fixture();
    for _ in 0..codex_omd::mod_limits::ModLimits::default().watches_per_mod {
        let (sink, _rx) = channel_sink();
        watches
            .watch("m", "sha", &["src".to_owned()], false, None, sink)
            .unwrap();
    }
    let (sink, _rx) = channel_sink();
    assert!(
        watches
            .watch("m", "sha", &["src".to_owned()], false, None, sink.clone())
            .is_err()
    );
    assert!(
        watches
            .watch("other", "sha", &["src".to_owned()], false, None, sink)
            .is_ok()
    );
    watches.retain_sources(&BTreeMap::from([("other".to_owned(), "sha".to_owned())]));
    assert_eq!(
        (watches.unwatch_all("m"), watches.unwatch_all("other")),
        (0, 1)
    );
}
