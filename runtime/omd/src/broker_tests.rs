use super::*;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

#[derive(Default)]
struct TestGate {
    refuse_peer: bool,
    allow: AtomicBool,
    asked: Mutex<Vec<String>>,
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
        self.asked.lock().unwrap().push(right.to_owned());
        self.allow.load(Ordering::SeqCst)
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
    assert_eq!(error(client.send(&request)), "authority_challenge_invalid");
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
    assert_eq!(
        error(client.call("policy.put", json!({"key": "k", "value": 1}))),
        "authority_challenge_invalid"
    );
    client
        .authorized("policy.put", json!({"key": "k", "value": 1}))
        .unwrap();
    assert_eq!(client.call("policy.get", json!({"key": "k"})).unwrap(), 1);
    assert_eq!(
        *gate.asked.lock().unwrap(),
        [
            GRANT_RIGHT,
            GRANT_RIGHT,
            GRANT_RIGHT,
            GRANT_RIGHT,
            POLICY_RIGHT
        ]
    );
}

#[test]
fn anchors_chain_every_appended_digest() {
    let (_temp, socket, _store) = serve(Arc::new(TestGate::default()));
    let mut client = Client::at(&socket).unwrap();
    let (first, second) = (sha256(b"one"), sha256(b"two"));
    for entry in [&first, &second] {
        client
            .call(
                "anchor.append",
                json!({"stream": "/ledger", "sha256": entry}),
            )
            .unwrap();
    }
    let anchor: Anchor = serde_json::from_value(
        client
            .call("anchor.get", json!({"stream": "/ledger"}))
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
        error(client.call("anchor.append", json!({"stream": "/ledger", "sha256": "x"}))),
        "authority_request_invalid"
    );
}

#[test]
fn brokered_credentials_keep_secrets_in_the_broker_and_authorize_writes() {
    let gate = Arc::new(TestGate::default());
    let (_temp, socket, store) = serve(gate.clone());
    let profiles = crate::credentials::CredentialProfiles::brokered(&store, &socket);
    let key = profiles.create("key", "api_key", None).unwrap();
    assert!(
        profiles
            .store_auth(&key.id, r#"{"OPENAI_API_KEY":"sk-broker"}"#)
            .is_err()
    );
    gate.allow.store(true, Ordering::SeqCst);
    profiles
        .store_auth(&key.id, r#"{"OPENAI_API_KEY":"sk-broker"}"#)
        .unwrap();
    assert_eq!(profiles.secret(&key.id).unwrap().token, "sk-broker");
    assert_eq!(profiles.public(&key).unwrap()["status"], "ready");
    assert!(!store.join("credentials").exists());
    let empty = profiles.create("empty", "api_key", None).unwrap();
    gate.allow.store(false, Ordering::SeqCst);
    assert!(profiles.remove(&empty.id).unwrap());
    assert!(profiles.remove(&key.id).is_err());
    assert_eq!(gate.asked.lock().unwrap().len(), 3);
}

#[test]
#[ignore = "needs a deployed broker that pins this test binary"]
fn deployed_broker_holds_credentials_and_detects_ledger_tampering() {
    assert!(deployed());
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let profiles = crate::credentials::CredentialProfiles::open(&base).unwrap();
    let key = profiles.create("dummy", "api_key", None).unwrap();
    profiles
        .store_auth(&key.id, r#"{"OPENAI_API_KEY":"sk-dummy"}"#)
        .unwrap();
    assert_eq!(profiles.secret(&key.id).unwrap().token, "sk-dummy");
    assert!(!base.join("credentials").exists());
    assert_eq!(
        fs::read_dir(ROOT).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    let limits = crate::Limits {
        requests: 3,
        exposure_microusd: 100,
        seconds: 300,
        concurrent_workers: 2,
        max_depth: 2,
    };
    let ledger = base.join("ledger");
    drop(crate::Task::create(limits.clone(), ledger.clone()).unwrap());
    let first = ledger.join("00000001.json");
    let original = fs::read_to_string(&first).unwrap();
    fs::write(
        &first,
        original.replace("\"requests\":3", "\"requests\":30"),
    )
    .unwrap();
    assert_eq!(
        crate::Task::open(limits.clone(), ledger.clone(), Some("resume"))
            .err()
            .unwrap()
            .to_string(),
        "evidence_anchor_mismatch"
    );
    fs::write(&first, original).unwrap();
    crate::Task::open(limits.clone(), ledger.clone(), Some("resume")).unwrap();
    fs::remove_dir_all(&ledger).unwrap();
    assert_eq!(
        crate::Task::create(limits, ledger)
            .err()
            .unwrap()
            .to_string(),
        "evidence_anchor_mismatch"
    );
}
