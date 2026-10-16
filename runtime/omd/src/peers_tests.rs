use super::*;

struct TestSeal;

impl Seal for TestSeal {
    fn seal(&self, sha256: &str) -> io::Result<String> {
        Ok(format!("tag:{sha256}"))
    }

    fn verify(&self, sha256: &str, tag: &str) -> io::Result<bool> {
        Ok(tag == format!("tag:{sha256}"))
    }
}

fn endpoint(package: &str, projects: &str) -> Endpoint {
    Endpoint {
        package: package.into(),
        sha256: "a".repeat(64),
        projects: projects.into(),
    }
}

fn inbox_file(store: &Path, session: &str) -> PathBuf {
    fs::read_dir(store.join("peers/inbox").join(session))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
}

#[test]
fn sessions_exchange_sealed_messages_and_receipts() {
    let store = tempfile::tempdir().unwrap();
    let alpha = Peers::open(store.path(), "alpha", Path::new("/repo")).unwrap();
    let beta = Peers::open(store.path(), "beta", Path::new("/repo")).unwrap();
    let chat = endpoint("chat", "same");
    alpha.publish(std::slice::from_ref(&chat)).unwrap();
    beta.publish(std::slice::from_ref(&chat)).unwrap();
    assert_eq!(alpha.list(&chat, "chat").unwrap()[0]["session"], "beta");
    assert!(alpha.list(&chat, "other").unwrap().is_empty());

    let sent = alpha
        .send(
            &TestSeal,
            &chat,
            "beta",
            "chat",
            json!({"text": "hi"}),
            Some("c1".into()),
            60_000,
        )
        .unwrap();
    assert_eq!(sent["status"], "queued");
    let replay = fs::read(inbox_file(store.path(), "beta")).unwrap();
    let received = beta.receive(&TestSeal).unwrap();
    assert_eq!(received.len(), 1);
    assert_eq!(received[0].message["from"]["session"], "alpha");
    assert_eq!(received[0].message["data"]["text"], "hi");
    beta.receipt(&TestSeal, &received[0].message, "delivered", None)
        .unwrap();

    fs::create_dir_all(store.path().join("peers/inbox/beta")).unwrap();
    fs::write(store.path().join("peers/inbox/beta/replayed.json"), &replay).unwrap();
    assert!(beta.receive(&TestSeal).unwrap().is_empty());
    let receipts = alpha.receipts(&TestSeal).unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].0, "chat");
    assert_eq!(receipts[0].1["status"], "delivered");
    assert_eq!(receipts[0].1["correlation"], "c1");
}

#[test]
fn tampered_and_expired_messages_are_not_delivered() {
    let store = tempfile::tempdir().unwrap();
    let alpha = Peers::open(store.path(), "alpha", Path::new("/repo")).unwrap();
    let beta = Peers::open(store.path(), "beta", Path::new("/repo")).unwrap();
    let chat = endpoint("chat", "same");
    beta.publish(std::slice::from_ref(&chat)).unwrap();
    alpha
        .send(
            &TestSeal,
            &chat,
            "beta",
            "chat",
            json!("original"),
            None,
            60_000,
        )
        .unwrap();
    let path = inbox_file(store.path(), "beta");
    let mut envelope: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    envelope["message"]["data"] = json!("forged");
    fs::write(&path, serde_json::to_vec(&envelope).unwrap()).unwrap();
    assert!(beta.receive(&TestSeal).unwrap().is_empty());
    fs::write(&path, br#"{"message": {}}"#).unwrap();
    assert!(beta.receive(&TestSeal).unwrap().is_empty());
    assert!(
        !path.exists(),
        "an envelope without a tag is dropped, not retried"
    );

    let mut expired = envelope["message"].clone();
    expired["data"] = json!("late");
    expired["expires_at_ms"] = json!(1);
    fs::write(
        &path,
        serde_json::to_vec(&sealed(&TestSeal, "message", expired).unwrap()).unwrap(),
    )
    .unwrap();
    assert!(beta.receive(&TestSeal).unwrap().is_empty());
    let receipts = alpha.receipts(&TestSeal).unwrap();
    assert_eq!(receipts[0].1["status"], "expired");
}

#[test]
fn closed_sessions_and_other_projects_are_refused() {
    let store = tempfile::tempdir().unwrap();
    let alpha = Peers::open(store.path(), "alpha", Path::new("/repo")).unwrap();
    let chat = endpoint("chat", "same");
    {
        let beta = Peers::open(store.path(), "beta", Path::new("/other")).unwrap();
        beta.publish(std::slice::from_ref(&chat)).unwrap();
        assert!(alpha.list(&chat, "chat").unwrap().is_empty());
        let error = alpha
            .send(&TestSeal, &chat, "beta", "chat", json!(1), None, 60_000)
            .unwrap_err();
        assert_eq!(error.to_string(), "peer_scope_denied");
        let wide = endpoint("chat", "any");
        beta.publish(std::slice::from_ref(&wide)).unwrap();
        assert_eq!(alpha.list(&wide, "chat").unwrap().len(), 1);
        assert!(alpha.list(&chat, "chat").unwrap().is_empty());
    }
    let error = alpha
        .send(
            &TestSeal,
            &endpoint("chat", "any"),
            "beta",
            "chat",
            json!(1),
            None,
            60_000,
        )
        .unwrap_err();
    assert!(error.to_string().starts_with("peer_closed"));
    assert!(Peers::open(store.path(), "alpha", Path::new("/repo")).is_err());
}

struct OpenGate;

impl broker::Gate for OpenGate {
    fn peer(&self, _stream: &std::os::unix::net::UnixStream) -> io::Result<()> {
        Ok(())
    }

    fn authorize(
        &self,
        _stream: &std::os::unix::net::UnixStream,
        _right: &str,
        _authorization: &str,
        _password: Option<&str>,
    ) -> bool {
        false
    }
}

fn until<T>(mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        if let Some(value) = check() {
            return value;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "peer process timed out"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// One side of `two_processes_exchange_broker_sealed_messages`; idle unless that test runs it.
#[test]
fn peer_process() {
    let (Ok(role), Ok(store), Ok(socket)) = (
        std::env::var("OMD_PEER_ROLE"),
        std::env::var("OMD_PEER_STORE"),
        std::env::var("OMD_PEER_SOCKET"),
    ) else {
        return;
    };
    let seal = SocketSeal(PathBuf::from(socket));
    let chat = endpoint("chat", "same");
    let peers = Peers::open(Path::new(&store), &role, Path::new("/repo")).unwrap();
    peers.publish(std::slice::from_ref(&chat)).unwrap();
    if role == "beta" {
        let message = until(|| peers.receive(&seal).unwrap().pop()).message;
        assert_eq!(message["from"]["session"], "alpha");
        assert_eq!(message["data"], "across processes");
        peers.receipt(&seal, &message, "delivered", None).unwrap();
        until(|| Path::new(&store).join("alpha.done").exists().then_some(()));
        return;
    }
    until(|| (!peers.list(&chat, "chat").unwrap().is_empty()).then_some(()));
    peers
        .send(
            &seal,
            &chat,
            "beta",
            "chat",
            json!("across processes"),
            None,
            60_000,
        )
        .unwrap();
    let receipt = until(|| peers.receipts(&seal).unwrap().pop()).1;
    assert_eq!(receipt["status"], "delivered");
    assert_eq!(receipt["by"]["session"], "beta");
    fs::write(Path::new(&store).join("alpha.done"), b"").unwrap();
}

#[test]
fn two_processes_exchange_broker_sealed_messages() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("broker");
    fs::create_dir(&root).unwrap();
    let socket = base.join("s");
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let server = std::sync::Arc::new(broker::Broker::open(root).unwrap());
    std::thread::spawn(move || server.serve(listener, std::sync::Arc::new(OpenGate)));
    let store = base.join("store");
    fs::create_dir(&store).unwrap();
    let spawn = |role: &str| {
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "peers::tests::peer_process", "--nocapture"])
            .env("OMD_PEER_ROLE", role)
            .env("OMD_PEER_STORE", &store)
            .env("OMD_PEER_SOCKET", &socket)
            .spawn()
            .unwrap()
    };
    let mut beta = spawn("beta");
    let mut alpha = spawn("alpha");
    assert!(alpha.wait().unwrap().success());
    assert!(beta.wait().unwrap().success());
}
