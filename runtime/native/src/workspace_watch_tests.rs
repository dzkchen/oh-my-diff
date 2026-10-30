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
    let (id, _) = watches
        .watch(
            "m",
            "sha",
            &["src".to_owned()],
            true,
            false,
            Some(50),
            None,
            sink,
        )
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
                .watch(
                    "m",
                    "sha",
                    &[path.to_owned()],
                    false,
                    false,
                    None,
                    None,
                    sink
                )
                .is_err(),
            "{path}"
        );
    }
    let (sink, _rx) = channel_sink();
    assert!(
        watches
            .watch(
                "m",
                "sha",
                &["src".to_owned()],
                false,
                false,
                Some(10),
                None,
                sink
            )
            .is_err()
    );
    let (sink, _rx) = channel_sink();
    assert!(
        watches
            .watch("m", "sha", &[], false, false, None, None, sink)
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn watches_are_limited_per_mod_and_released_with_their_source() {
    let (_dir, watches) = fixture();
    for _ in 0..codex_omd::mod_limits::ModLimits::default().watches_per_mod {
        let (sink, _rx) = channel_sink();
        watches
            .watch(
                "m",
                "sha",
                &["src".to_owned()],
                false,
                false,
                None,
                None,
                sink,
            )
            .unwrap();
    }
    let (sink, _rx) = channel_sink();
    assert!(
        watches
            .watch(
                "m",
                "sha",
                &["src".to_owned()],
                false,
                false,
                None,
                None,
                sink.clone()
            )
            .is_err()
    );
    assert!(
        watches
            .watch(
                "other",
                "sha",
                &["src".to_owned()],
                false,
                false,
                None,
                None,
                sink
            )
            .is_ok()
    );
    watches.retain_sources(&BTreeMap::from([("other".to_owned(), "sha".to_owned())]));
    assert_eq!(
        (watches.unwatch_all("m"), watches.unwatch_all("other")),
        (0, 1)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_keyed_watch_is_kept_when_unchanged_and_replaced_within_the_limit_otherwise() {
    let (_dir, watches) = fixture();
    let watch = |key: Option<(&str, &str)>| {
        let (sink, _rx) = channel_sink();
        watches.watch(
            "m",
            "sha",
            &["src".to_owned()],
            false,
            false,
            None,
            key,
            sink,
        )
    };
    let (first, replaced) = watch(Some(("k", "a"))).unwrap();
    assert_eq!(replaced, None);
    assert_eq!(watch(Some(("k", "a"))).unwrap(), (first.clone(), None));
    for _ in 1..codex_omd::mod_limits::ModLimits::default().watches_per_mod {
        watch(None).unwrap();
    }
    let (second, replaced) = watch(Some(("k", "b"))).unwrap();
    assert_eq!(replaced.as_deref(), Some(first.as_str()));
    assert!(watch(Some(("other", "a"))).is_err());
    assert!(!watches.unwatch("m", &first));
    assert!(!watches.unwatch_key("other", "k"));
    assert!(watches.unwatch_key("m", "k"));
    assert!(!watches.unwatch("m", &second));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_git_watch_reports_head_index_and_refs_but_not_objects_or_locks() {
    let (dir, watches) = fixture();
    let git = dir.path().join(".git");
    std::fs::create_dir_all(git.join("refs/heads")).unwrap();
    std::fs::create_dir_all(git.join("objects/ab")).unwrap();
    let (sink, rx) = channel_sink();
    watches
        .watch(
            "m",
            "sha",
            &["src".to_owned()],
            true,
            true,
            Some(50),
            None,
            sink,
        )
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let seen = tokio::task::spawn_blocking(move || {
        let mut seen = std::collections::BTreeSet::new();
        for round in 0..20 {
            std::fs::write(git.join("objects/ab/cd"), round.to_string()).unwrap();
            std::fs::write(git.join("index.lock"), round.to_string()).unwrap();
            std::fs::write(git.join("HEAD"), format!("ref: refs/heads/b{round}\n")).unwrap();
            std::fs::write(git.join("refs/heads/main"), round.to_string()).unwrap();
            while let Ok((_, paths)) = rx.recv_timeout(Duration::from_millis(500)) {
                seen.extend(paths);
            }
            if seen.contains(".git/HEAD") && seen.contains(".git/refs/heads/main") {
                break;
            }
        }
        seen
    })
    .await
    .unwrap();
    assert!(
        seen.contains(".git/HEAD") && seen.contains(".git/refs/heads/main"),
        "{seen:?}"
    );
    assert!(
        seen.iter()
            .all(|path| !path.contains("objects") && !path.ends_with(".lock")),
        "{seen:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_git_watch_needs_a_repository() {
    let dir = tempfile::tempdir().unwrap();
    let watches = WorkspaceWatches::new(
        Arc::new(FileWatcher::new().unwrap()),
        dir.path().to_path_buf(),
        Vec::new(),
        Default::default(),
    )
    .unwrap();
    let (sink, _rx) = channel_sink();
    let error = watches
        .watch("m", "sha", &[".".to_owned()], true, true, None, None, sink)
        .unwrap_err();
    assert_eq!(error.to_string(), "watch_git_unavailable");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_worktree_git_watch_reports_its_own_head_and_shared_refs_only() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let (main, tree) = (base.join("main/.git"), base.join("tree"));
    let own = main.join("worktrees/tree");
    for path in [main.join("refs/heads"), own.clone(), tree.clone()] {
        std::fs::create_dir_all(path).unwrap();
    }
    std::fs::write(own.join("commondir"), "../..\n").unwrap();
    std::fs::write(
        own.join("gitdir"),
        format!("{}\n", tree.join(".git").display()),
    )
    .unwrap();
    std::fs::write(tree.join(".git"), format!("gitdir: {}\n", own.display())).unwrap();
    let watches = WorkspaceWatches::new(
        Arc::new(FileWatcher::new().unwrap()),
        tree.clone(),
        Vec::new(),
        Default::default(),
    )
    .unwrap();
    let (sink, rx) = channel_sink();
    watches
        .watch(
            "m",
            "sha",
            &[".".to_owned()],
            true,
            true,
            Some(50),
            None,
            sink,
        )
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let seen = tokio::task::spawn_blocking(move || {
        let mut seen = std::collections::BTreeSet::new();
        for round in 0..20 {
            std::fs::write(main.join("HEAD"), round.to_string()).unwrap();
            std::fs::write(own.join("HEAD"), round.to_string()).unwrap();
            std::fs::write(main.join("refs/heads/x"), round.to_string()).unwrap();
            while let Ok((_, paths)) = rx.recv_timeout(Duration::from_millis(500)) {
                seen.extend(paths);
            }
            if seen.contains(".git/HEAD") && seen.contains(".git/refs/heads/x") {
                break;
            }
        }
        seen
    })
    .await
    .unwrap();
    assert_eq!(
        seen,
        [".git/HEAD", ".git/refs/heads/x"].map(str::to_owned).into(),
        "{seen:?}"
    );

    std::fs::write(
        tree.join(".git"),
        format!("gitdir: {}\n", base.join("main/.git").display()),
    )
    .unwrap();
    let (sink, _rx) = channel_sink();
    assert_eq!(
        watches
            .watch("n", "sha", &[".".to_owned()], true, true, None, None, sink)
            .unwrap_err()
            .to_string(),
        "watch_git_unavailable"
    );
}

fn git_events(
    rx: mpsc::Receiver<(String, Vec<String>)>,
    write: impl Fn(usize) + Send + 'static,
    wanted: &'static [&'static str],
) -> tokio::task::JoinHandle<std::collections::BTreeSet<String>> {
    tokio::task::spawn_blocking(move || {
        let mut seen = std::collections::BTreeSet::new();
        for round in 0..20 {
            write(round);
            while let Ok((_, paths)) = rx.recv_timeout(Duration::from_millis(500)) {
                seen.extend(paths);
            }
            if wanted.iter().all(|path| seen.contains(*path)) {
                break;
            }
        }
        seen
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_git_watch_follows_a_relative_gitfile_without_commondir() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let (modules, sub) = (base.join("super/.git/modules/sub"), base.join("super/sub"));
    for path in [
        modules.join("refs/heads"),
        modules.join("objects"),
        sub.clone(),
    ] {
        std::fs::create_dir_all(path).unwrap();
    }
    std::fs::write(modules.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::write(sub.join(".git"), "gitdir: ../.git/modules/sub\n").unwrap();
    let watches = WorkspaceWatches::new(
        Arc::new(FileWatcher::new().unwrap()),
        sub.clone(),
        Vec::new(),
        Default::default(),
    )
    .unwrap();
    let (sink, rx) = channel_sink();
    watches
        .watch(
            "m",
            "sha",
            &[".".to_owned()],
            true,
            true,
            Some(50),
            None,
            sink,
        )
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let written = modules.clone();
    let seen = git_events(
        rx,
        move |round| {
            std::fs::write(written.join("HEAD"), format!("ref: refs/heads/b{round}\n")).unwrap();
            std::fs::write(written.join("refs/heads/x"), round.to_string()).unwrap();
        },
        &[".git/HEAD", ".git/refs/heads/x"],
    )
    .await
    .unwrap();
    assert_eq!(
        seen,
        [".git/HEAD", ".git/refs/heads/x"].map(str::to_owned).into(),
        "{seen:?}"
    );

    std::fs::remove_dir_all(modules.join("objects")).unwrap();
    let (sink, _rx) = channel_sink();
    assert_eq!(
        watches
            .watch("n", "sha", &[".".to_owned()], true, true, None, None, sink)
            .unwrap_err()
            .to_string(),
        "watch_git_unavailable"
    );

    for other in [
        base.join("private/.git"),
        base.join("elsewhere/.git/modules/sub"),
    ] {
        for path in [other.join("refs/heads"), other.join("objects")] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(other.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(sub.join(".git"), format!("gitdir: {}\n", other.display())).unwrap();
        let (sink, _rx) = channel_sink();
        assert_eq!(
            watches
                .watch("o", "sha", &[".".to_owned()], true, true, None, None, sink)
                .unwrap_err()
                .to_string(),
            "watch_git_unavailable",
            "{other:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_git_watch_resolves_relative_worktree_links_from_the_git_directory() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let (main, tree) = (base.join("main/.git"), base.join("tree"));
    let own = main.join("worktrees/tree");
    for path in [main.join("refs/heads"), own.clone(), tree.clone()] {
        std::fs::create_dir_all(path).unwrap();
    }
    std::fs::write(own.join("commondir"), "../..\n").unwrap();
    std::fs::write(own.join("gitdir"), "../../../../tree/.git\n").unwrap();
    std::fs::write(tree.join(".git"), "gitdir: ../main/.git/worktrees/tree\n").unwrap();
    let watches = WorkspaceWatches::new(
        Arc::new(FileWatcher::new().unwrap()),
        tree.clone(),
        Vec::new(),
        Default::default(),
    )
    .unwrap();
    let (sink, rx) = channel_sink();
    watches
        .watch(
            "m",
            "sha",
            &[".".to_owned()],
            true,
            true,
            Some(50),
            None,
            sink,
        )
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let seen = git_events(
        rx,
        move |round| {
            std::fs::write(own.join("HEAD"), round.to_string()).unwrap();
            std::fs::write(main.join("refs/heads/x"), round.to_string()).unwrap();
        },
        &[".git/HEAD", ".git/refs/heads/x"],
    )
    .await
    .unwrap();
    assert_eq!(
        seen,
        [".git/HEAD", ".git/refs/heads/x"].map(str::to_owned).into(),
        "{seen:?}"
    );
}
