use super::*;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

#[derive(Default)]
struct TestGate {
    refuse_peer: bool,
    allow: AtomicBool,
    asked: Mutex<Vec<String>>,
    delay: std::time::Duration,
}

impl Gate for TestGate {
    fn peer(&self, _stream: &UnixStream) -> io::Result<()> {
        if self.refuse_peer {
            Err(failure("authority_peer_unverified"))
        } else {
            Ok(())
        }
    }

    fn authorize(
        &self,
        _stream: &UnixStream,
        right: &str,
        _authorization: &str,
        _password: Option<&str>,
    ) -> bool {
        std::thread::sleep(self.delay);
        self.asked.lock().unwrap().push(right.to_owned());
        self.allow.load(Ordering::SeqCst)
    }
}

#[test]
fn authorization_wait_outlives_the_transport_read_timeout() {
    for allowed in [true, false] {
        let gate = Arc::new(TestGate {
            allow: AtomicBool::new(allowed),
            delay: std::time::Duration::from_millis(80),
            ..Default::default()
        });
        let (_temp, socket, store) = serve(gate);
        let mut client = Client::at(&socket).unwrap();
        let timeout = std::time::Duration::from_millis(20);
        let arguments = json!({"store": store, "generation": 0, "grants": ["a"]});
        let nonce = client
            .call(
                "challenge",
                json!({"sha256": request_digest("grants.put", &arguments).unwrap()}),
            )
            .unwrap();
        client
            .stream
            .get_mut()
            .set_read_timeout(Some(timeout))
            .unwrap();
        let result = client.send_authorized(&json!({"op": "grants.put", "arguments": arguments, "nonce": nonce, "authorization": "token"}));
        assert_eq!(
            client.stream.get_ref().read_timeout().unwrap(),
            Some(timeout)
        );
        if allowed {
            assert_eq!(result.unwrap()["generation"], 1);
        } else {
            assert_eq!(error(result), "authority_authorization_denied");
        }
    }
}

fn serve(gate: Arc<TestGate>) -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("broker");
    fs::create_dir(&root).unwrap();
    let store = base.join("store");
    fs::create_dir(&store).unwrap();
    let socket = base.join("s");
    let listener = UnixListener::bind(&socket).unwrap();
    let broker = Arc::new(Broker::open(root).unwrap());
    std::thread::spawn(move || broker.serve(listener, gate));
    (temp, socket, store)
}

fn error(result: io::Result<Value>) -> String {
    result.unwrap_err().to_string()
}

#[test]
fn unverified_peers_get_nothing() {
    let gate = Arc::new(TestGate {
        refuse_peer: true,
        ..TestGate::default()
    });
    let (_temp, socket, store) = serve(gate);
    let mut client = Client::at(&socket).unwrap();
    assert_eq!(
        error(client.call("grants.get", json!({"store": store}))),
        "authority_peer_unverified"
    );
}

#[test]
fn a_store_owned_by_another_user_is_refused() {
    let (_temp, socket, _store) = serve(Arc::new(TestGate::default()));
    let mut client = Client::at(&socket).unwrap();
    assert_eq!(
        error(client.call("grants.get", json!({"store": "/usr"}))),
        "authority_store_unowned"
    );
}

#[test]
fn a_store_path_first_named_by_another_user_is_refused() {
    let (temp, socket, store) = serve(Arc::new(TestGate::default()));
    let mut client = Client::at(&socket).unwrap();
    client.call("grants.get", json!({"store": store})).unwrap();
    let owners = temp.path().canonicalize().unwrap().join("broker/owners");
    let record = owners.join(format!(
        "store-{}.json",
        sha256(store.as_os_str().as_encoded_bytes())
    ));
    assert_eq!(
        fs::read_to_string(&record).unwrap(),
        unsafe { libc::getuid() }.to_string()
    );
    fs::write(&record, "0").unwrap();
    assert_eq!(
        error(client.call("grants.get", json!({"store": store}))),
        "authority_store_unowned"
    );
}

#[test]
fn protected_mutations_need_a_single_use_challenge_and_authorization() {
    let gate = Arc::new(TestGate::default());
    let (_temp, socket, store) = serve(gate.clone());
    let mut client = Client::at(&socket).unwrap();
    let put = json!({"store": store, "generation": 0, "grants": ["a"]});
    assert_eq!(
        error(client.call("grants.put", put.clone())),
        "authority_challenge_invalid"
    );
    assert_eq!(
        error(client.authorized("grants.put", put.clone())),
        "authority_authorization_denied"
    );
    gate.allow.store(true, Ordering::SeqCst);
    let nonce = client
        .call(
            "challenge",
            json!({"sha256": request_digest("grants.put", &put).unwrap()}),
        )
        .unwrap();
    let request = json!({"op": "grants.put", "arguments": put, "nonce": nonce,
        "authorization": "token"});
    assert_eq!(client.send(&request).unwrap()["generation"], 1);
    assert_eq!(error(client.send(&request)), "authority_grants_stale");
    let other = json!({"store": store, "generation": 1, "grants": ["b"]});
    assert_eq!(
        error(client.authorized(
            "grants.put",
            json!({"store": store, "generation": 0, "grants": []})
        )),
        "authority_grants_stale"
    );
    assert_eq!(
        client.authorized("grants.put", other).unwrap()["generation"],
        2
    );
    assert_eq!(
        client.call("grants.get", json!({"store": store})).unwrap(),
        json!({"generation": 2, "grants": ["b"]})
    );
    let revoke = json!({"store": store, "generation": 2, "grants": []});
    assert_eq!(client.call("grants.put", revoke).unwrap()["generation"], 3);
    assert_eq!(
        error(client.call("policy.put", json!({"key": "k", "value": 1}))),
        "authority_challenge_invalid"
    );
    client
        .authorized("policy.put", json!({"key": "k", "value": 1}))
        .unwrap();
    assert_eq!(client.call("policy.get", json!({"key": "k"})).unwrap(), 1);
    let large_policy = json!({"schema":1,"sources":["x".repeat(20_000)]});
    client
        .authorized("policy.put", json!({"key":"mods","value":large_policy}))
        .unwrap();
    assert_eq!(
        client.call("policy.get", json!({"key":"mods"})).unwrap(),
        large_policy
    );
    client
        .authorized("policy.put", json!({"key": "k", "value": 2}))
        .unwrap();
    assert_eq!(
        error(client.call("policy.rollback", json!({"key": "k"}))),
        "authority_challenge_invalid"
    );
    client
        .authorized("policy.rollback", json!({"key": "k"}))
        .unwrap();
    assert_eq!(client.call("policy.get", json!({"key": "k"})).unwrap(), 1);
    assert_eq!(
        error(client.authorized("policy.rollback", json!({"key": "other"}))),
        "authority_policy_previous_missing"
    );
    assert_eq!(
        *gate.asked.lock().unwrap(),
        [
            GRANT_RIGHT,
            GRANT_RIGHT,
            GRANT_RIGHT,
            POLICY_RIGHT,
            POLICY_RIGHT,
            POLICY_RIGHT,
            POLICY_RIGHT,
            POLICY_RIGHT
        ]
    );
}

#[test]
fn anchors_chain_every_appended_digest() {
    let (_temp, socket, store) = serve(Arc::new(TestGate::default()));
    let mut client = Client::at(&socket).unwrap();
    let (ledger, older) = (store.join("ledger"), store.join("older"));
    let (ledger, older) = (ledger.to_str().unwrap(), older.to_str().unwrap());
    let (first, second) = (sha256(b"one"), sha256(b"two"));
    for entry in [&first, &second] {
        client
            .call("anchor.append", json!({"stream": ledger, "sha256": entry}))
            .unwrap();
    }
    let anchor: Anchor = serde_json::from_value(
        client
            .call("anchor.get", json!({"stream": ledger}))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        anchor,
        Anchor {
            count: 2,
            head: chain(&chain("", &first), &second),
            last: Some(second),
        }
    );
    assert_eq!(
        error(client.call("anchor.append", json!({"stream": ledger, "sha256": "x"}))),
        "authority_request_invalid"
    );
    let seed = |stream: &str| json!({"stream": stream, "count": 2, "head": anchor.head, "last": anchor.last});
    assert_eq!(
        error(client.call("anchor.seed", seed(ledger))),
        "authority_anchor_exists"
    );
    client.call("anchor.seed", seed(older)).unwrap();
    assert_eq!(
        client.call("anchor.get", json!({"stream": older})).unwrap()["head"],
        anchor.head
    );
    assert_eq!(
        error(client.call("anchor.seed", seed("/usr/omd-ledger"))),
        "authority_stream_unowned"
    );
}

#[test]
fn brokered_credentials_keep_secrets_in_the_broker_and_authorize_writes() {
    let gate = Arc::new(TestGate::default());
    let (_temp, socket, store) = serve(gate.clone());
    let profiles = crate::credentials::CredentialProfiles::brokered(&store, &socket);
    let key = profiles.create("key", "api_key", None, None).unwrap();
    assert!(
        profiles
            .store_auth(&key.id, r#"{"OPENAI_API_KEY":"sk-broker"}"#)
            .is_err()
    );
    gate.allow.store(true, Ordering::SeqCst);
    profiles
        .store_auth(&key.id, r#"{"OPENAI_API_KEY":"sk-broker"}"#)
        .unwrap();
    assert_eq!(
        profiles
            .secret(&key.id, "https://api.openai.com", None)
            .unwrap()
            .token,
        "sk-broker"
    );
    assert_eq!(profiles.public(&key).unwrap()["status"], "ready");
    assert!(!store.join("credentials").exists());
    let site = profiles
        .create_secret("site", "https://example.com", "vault")
        .unwrap();
    profiles.store_secret(&site.id, "hunter2").unwrap();
    assert!(
        profiles
            .secret(&site.id, "https://example.com", Some("vault"))
            .is_ok()
    );
    assert!(
        profiles
            .secret(&site.id, "https://example.com", Some("other"))
            .unwrap_err()
            .to_string()
            .contains("credential_secret_not_owned")
    );
    let empty = profiles.create("empty", "api_key", None, None).unwrap();
    gate.allow.store(false, Ordering::SeqCst);
    assert!(profiles.remove(&empty.id).unwrap());
    assert!(profiles.remove(&key.id).is_err());
    assert_eq!(gate.asked.lock().unwrap().len(), 4);
}

#[test]
fn peer_tags_verify_only_the_sealed_digest() {
    let (_temp, socket, _store) = serve(Arc::new(TestGate::default()));
    let mut client = Client::at(&socket).unwrap();
    let digest = sha256(b"message");
    let tag = client.call("peer.seal", json!({"sha256": digest})).unwrap();
    assert_eq!(
        client
            .call("peer.verify", json!({"sha256": digest, "tag": tag}))
            .unwrap(),
        true
    );
    assert_eq!(
        client
            .call(
                "peer.verify",
                json!({"sha256": sha256(b"other"), "tag": tag})
            )
            .unwrap(),
        false
    );
    assert_eq!(
        client.call("peer.seal", json!({"sha256": digest})).unwrap(),
        tag
    );
}

/// The connecting side of `peers_are_verified_by_kernel_cdhash_…`; idle unless that test runs it.
#[test]
fn peer_client() {
    let Some(socket) = std::env::var_os("OMD_BROKER_PEER_SOCKET") else {
        return;
    };
    let _stream = UnixStream::connect(socket).unwrap();
    let _ = io::stdin().read_to_end(&mut Vec::new());
}

#[cfg(target_os = "macos")]
#[test]
fn peers_are_verified_by_kernel_cdhash_even_when_their_executable_is_unreadable() {
    let temp = tempfile::tempdir().unwrap();
    let folder = temp.path().join("private");
    fs::create_dir(&folder).unwrap();
    let binary = folder.join("peer");
    fs::copy(std::env::current_exe().unwrap(), &binary).unwrap();
    let signature = std::process::Command::new("/usr/bin/codesign")
        .args(["-d", "--verbose=4"])
        .arg(&binary)
        .output()
        .unwrap();
    let cdhash = String::from_utf8_lossy(&signature.stderr)
        .lines()
        .find_map(|line| line.strip_prefix("CDHash=").map(str::to_owned))
        .unwrap();
    let socket = temp.path().join("peer.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut child = std::process::Command::new(&binary)
        .args(["--exact", "broker::tests::peer_client", "--test-threads=1"])
        .env("OMD_BROKER_PEER_SOCKET", &socket)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let ours = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(_) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            Err(error) => panic!("peer never connected: {error}"),
        }
    };
    fs::set_permissions(&folder, std::os::unix::fs::PermissionsExt::from_mode(0o000)).unwrap();
    let pinned = platform::verify_peer(&ours, &[cdhash.as_str()]);
    let other = platform::verify_peer(&ours, &["0".repeat(40).as_str()]);
    fs::set_permissions(&folder, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(pinned.is_ok(), "{pinned:?}");
    assert_eq!(other.unwrap_err().to_string(), "authority_peer_unverified");
}

#[test]
fn symlinked_broker_directories_are_refused() {
    let (temp, socket, store) = serve(Arc::new(TestGate::default()));
    let root = temp.path().canonicalize().unwrap().join("broker");
    std::os::unix::fs::symlink(&store, root.join("stores")).unwrap();
    let mut client = Client::at(&socket).unwrap();
    assert_eq!(
        error(client.call("grants.get", json!({"store": store}))),
        "authority_directory_invalid"
    );
}

#[test]
fn concurrent_private_writes_to_one_path_all_succeed() {
    let directory = tempfile::tempdir().unwrap();
    let path = Arc::new(directory.path().join("owner.json"));
    let writers: Vec<_> = (0..8)
        .map(|writer| {
            let path = path.clone();
            std::thread::spawn(move || (0..50).all(|_| write_json(&path, &json!(writer)).is_ok()))
        })
        .collect();
    assert!(writers.into_iter().all(|writer| writer.join().unwrap()));
}
