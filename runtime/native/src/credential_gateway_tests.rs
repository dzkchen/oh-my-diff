use super::*;

fn get(url: &str) -> (u16, String) {
    let response = reqwest::blocking::get(url).unwrap();
    (response.status().as_u16(), response.text().unwrap())
}

#[test]
fn only_registered_sidecars_reach_approved_profiles_until_revoked() {
    let temp = tempfile::tempdir().unwrap();
    let store = temp.path().canonicalize().unwrap();
    let profiles = CredentialProfiles::local(&store).unwrap();
    let approved = profiles
        .create("up", "provider", Some("up"), Some("https://up.example"))
        .unwrap();
    let other = profiles.create("other", "api_key", None, None).unwrap();
    let (base, registration) = register(store, "mod".into(), BTreeSet::from([approved.id.clone()])).unwrap();
    let port = base.rsplit_once('/').unwrap().0;
    assert_eq!(
        get(&format!("{port}/unknown/{}/v1", approved.id)),
        (403, "credential_not_host_approved".into())
    );
    assert_eq!(
        get(&format!("{base}/{}/v1", other.id)),
        (403, "credential_not_host_approved".into())
    );
    assert_eq!(
        get(&format!("{base}/{}/v1", approved.id)),
        (403, format!("credential_not_enrolled: {}", approved.id))
    );
    drop(registration);
    assert_eq!(
        get(&format!("{base}/{}/v1", approved.id)),
        (403, "credential_not_host_approved".into())
    );
}

#[test]
fn a_grant_naming_another_mods_secret_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let store = temp.path().canonicalize().unwrap();
    let profiles = CredentialProfiles::local(&store).unwrap();
    let secret = profiles
        .create_secret("token", "https://up.example", "owner")
        .unwrap();
    let url = |base: &str| format!("{base}/{}/v1", secret.id);
    let (base, _intruder) = register(
        store.clone(),
        "intruder".into(),
        BTreeSet::from([secret.id.clone()]),
    )
    .unwrap();
    assert_eq!(
        get(&url(&base)),
        (403, format!("credential_secret_not_owned: {}", secret.id))
    );
    let (base, _owner) =
        register(store, "owner".into(), BTreeSet::from([secret.id.clone()])).unwrap();
    assert_ne!(
        get(&url(&base)),
        (403, format!("credential_secret_not_owned: {}", secret.id))
    );
}

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::time::Instant;

const WAIT: Duration = Duration::from_secs(3);

fn upstream_listener() -> TcpListener {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    listener
}

fn fixture(gateway: &Gateway, listener: &TcpListener) -> (tempfile::TempDir, String, Registration) {
    let temp = tempfile::tempdir().unwrap();
    let store = temp.path().canonicalize().unwrap();
    let profiles = CredentialProfiles::local(&store).unwrap();
    let profile = profiles
        .create(
            "fixture",
            "provider",
            Some("fixture"),
            Some("https://fixture.invalid"),
        )
        .unwrap();
    profiles
        .store_auth(&profile.id, r#"{"OPENAI_API_KEY":"fixture-token"}"#)
        .unwrap();
    let path = store.join("credentials/profiles.json");
    let mut document: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    document["profiles"][0]["origin"] =
        serde_json::json!(format!("http://{}", listener.local_addr().unwrap()));
    std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
    let (base, registration) =
        register_at(gateway, store, "mod".into(), BTreeSet::from([profile.id.clone()])).unwrap();
    (temp, format!("{base}/{}/v1", profile.id), registration)
}

fn begin(url: String) -> mpsc::Receiver<Result<reqwest::blocking::Response, reqwest::Error>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let result = reqwest::blocking::Client::builder()
            .timeout(WAIT * 4)
            .build()
            .unwrap()
            .get(url)
            .send();
        let _ = sender.send(result);
    });
    receiver
}

fn accepted(listener: &TcpListener) -> TcpStream {
    let until = Instant::now() + WAIT;
    let socket = loop {
        match listener.accept() {
            Ok((socket, _)) => break socket,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < until, "upstream request did not arrive");
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("accept failed: {error}"),
        }
    };
    socket.set_nonblocking(false).unwrap();
    socket.set_read_timeout(Some(WAIT)).unwrap();
    socket.set_write_timeout(Some(WAIT)).unwrap();
    let mut reader = BufReader::new(socket.try_clone().unwrap());
    let mut text = String::new();
    loop {
        let mut line = String::new();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        if line == "\r\n" {
            break;
        }
        text.push_str(&line);
        assert!(text.len() < 32 * 1024);
    }
    assert!(text.starts_with("GET /v1 HTTP/1.1\r\n"));
    assert!(
        text.to_ascii_lowercase()
            .contains("authorization: bearer fixture-token")
    );
    socket
}

fn closed(socket: &mut TcpStream) {
    let mut byte = [0];
    match socket.read(&mut byte) {
        Ok(0) => {}
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted
            ) => {}
        result => panic!("upstream socket remained open: {result:?}"),
    }
}

fn first_chunk(socket: &mut TcpStream) {
    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n9\r\ndata: 1\n\n\r\n").unwrap();
    socket.flush().unwrap();
}

#[test]
fn revocation_cancels_an_upstream_waiting_for_headers() {
    let gateway = start_gateway(WAIT, WAIT * 2).unwrap();
    let listener = upstream_listener();
    let (_temp, url, registration) = fixture(&gateway, &listener);
    let pending = begin(url);
    let mut upstream = accepted(&listener);
    drop(registration);
    assert!(pending.recv_timeout(WAIT).unwrap().is_err());
    closed(&mut upstream);
}

#[test]
fn streaming_flushes_before_completion_and_revocation_cancels_the_body() {
    let gateway = start_gateway(WAIT, WAIT * 2).unwrap();
    let listener = upstream_listener();
    let (_temp, url, registration) = fixture(&gateway, &listener);
    let pending = begin(url);
    let mut upstream = accepted(&listener);
    first_chunk(&mut upstream);
    let mut response = pending.recv_timeout(WAIT).unwrap().unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let mut first = [0; 9];
    response.read_exact(&mut first).unwrap();
    assert_eq!(&first, b"data: 1\n\n");
    drop(registration);
    assert!(response.read_to_end(&mut Vec::new()).is_err());
    closed(&mut upstream);
}

#[test]
fn streamed_replies_reach_the_client_before_the_body_ends() {
    let gateway = start_gateway(WAIT, WAIT * 2).unwrap();
    let listener = upstream_listener();
    let (_temp, url, _registration) = fixture(&gateway, &listener);
    let pending = begin(url);
    let mut upstream = accepted(&listener);
    first_chunk(&mut upstream);
    let mut response = pending.recv_timeout(WAIT).unwrap().unwrap();
    let mut first = [0; 9];
    response.read_exact(&mut first).unwrap();
    assert_eq!(&first, b"data: 1\n\n");
    upstream
        .write_all(b"9\r\ndata: 2\n\n\r\n0\r\n\r\n")
        .unwrap();
    let mut rest = String::new();
    response.read_to_string(&mut rest).unwrap();
    assert_eq!(rest, "data: 2\n\n");
}

#[test]
fn revocation_cancels_a_fixed_length_response_body() {
    let gateway = start_gateway(WAIT, WAIT * 2).unwrap();
    let listener = upstream_listener();
    let (_temp, url, registration) = fixture(&gateway, &listener);
    let pending = begin(url);
    let mut upstream = accepted(&listener);
    upstream
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\nx")
        .unwrap();
    let mut response = pending.recv_timeout(WAIT).unwrap().unwrap();
    let mut first = [0; 1];
    response.read_exact(&mut first).unwrap();
    assert_eq!(&first, b"x");
    drop(registration);
    assert!(response.read_to_end(&mut Vec::new()).is_err());
    closed(&mut upstream);
}

#[test]
fn upstream_header_and_body_idle_deadlines_close_the_upstream() {
    for headers in [false, true] {
        let gateway = start_gateway(Duration::from_millis(250), WAIT * 2).unwrap();
        let listener = upstream_listener();
        let (_temp, url, _registration) = fixture(&gateway, &listener);
        let pending = begin(url);
        let mut upstream = accepted(&listener);
        if headers {
            first_chunk(&mut upstream);
            let mut response = pending.recv_timeout(WAIT).unwrap().unwrap();
            let mut first = [0; 9];
            response.read_exact(&mut first).unwrap();
            assert!(response.read_to_end(&mut Vec::new()).is_err());
        } else {
            assert_eq!(
                pending
                    .recv_timeout(WAIT)
                    .unwrap()
                    .unwrap()
                    .status()
                    .as_u16(),
                504
            );
        }
        closed(&mut upstream);
    }
}

#[test]
fn stalled_requests_release_capacity_at_the_deadline() {
    let gateway = start_gateway(Duration::from_secs(1), WAIT * 4).unwrap();
    let listener = upstream_listener();
    let (_temp, url, _registration) = fixture(&gateway, &listener);
    let mut pending = Vec::new();
    let mut upstreams = Vec::new();
    for _ in 0..ROUTE_CONNECTIONS {
        pending.push(begin(url.clone()));
        upstreams.push(accepted(&listener));
    }
    assert_eq!(
        begin(url.clone())
            .recv_timeout(WAIT)
            .unwrap()
            .unwrap()
            .status()
            .as_u16(),
        429
    );
    for request in pending {
        assert_eq!(
            request
                .recv_timeout(WAIT)
                .unwrap()
                .unwrap()
                .status()
                .as_u16(),
            504
        );
    }
    for mut upstream in upstreams {
        closed(&mut upstream);
    }
    drop(listener);
    assert_eq!(
        begin(url)
            .recv_timeout(WAIT)
            .unwrap()
            .unwrap()
            .status()
            .as_u16(),
        502,
        "capacity is reusable after all timed-out sockets close"
    );
}

#[test]
fn connection_lifetime_closes_a_stream_even_when_its_idle_deadline_is_longer() {
    let gateway = start_gateway(WAIT * 2, Duration::from_millis(250)).unwrap();
    let listener = upstream_listener();
    let (_temp, url, _registration) = fixture(&gateway, &listener);
    let pending = begin(url);
    let mut upstream = accepted(&listener);
    first_chunk(&mut upstream);
    let mut response = pending.recv_timeout(WAIT).unwrap().unwrap();
    let mut first = [0; 9];
    response.read_exact(&mut first).unwrap();
    assert!(response.read_to_end(&mut Vec::new()).is_err());
    closed(&mut upstream);
}

#[test]
fn concurrent_forwards_are_limited_per_registration() {
    let gateway = start_gateway(WAIT * 4, WAIT * 4).unwrap();
    let listener = upstream_listener();
    let (_temp, url, registration) = fixture(&gateway, &listener);
    let mut pending = Vec::new();
    let mut upstreams = Vec::new();
    for _ in 0..ROUTE_CONNECTIONS {
        pending.push(begin(url.clone()));
        upstreams.push(accepted(&listener));
    }
    assert_eq!(
        begin(url)
            .recv_timeout(WAIT)
            .unwrap()
            .unwrap()
            .status()
            .as_u16(),
        429
    );
    drop(registration);
    for request in pending {
        assert!(request.recv_timeout(WAIT).unwrap().is_err());
    }
    for mut upstream in upstreams {
        closed(&mut upstream);
    }
}

#[test]
fn concurrent_connections_are_limited_across_registrations() {
    let gateway = start_gateway(WAIT * 4, WAIT * 4).unwrap();
    let listener = upstream_listener();
    let mut fixtures = Vec::new();
    let mut pending = Vec::new();
    let mut upstreams = Vec::new();
    for _ in 0..CONNECTIONS {
        let fixture = fixture(&gateway, &listener);
        pending.push(begin(fixture.1.clone()));
        upstreams.push(accepted(&listener));
        fixtures.push(fixture);
    }
    assert!(
        begin(fixtures[0].1.clone())
            .recv_timeout(WAIT)
            .unwrap()
            .is_err()
    );
    drop(fixtures);
    for request in pending {
        assert!(request.recv_timeout(WAIT).unwrap().is_err());
    }
    for mut upstream in upstreams {
        closed(&mut upstream);
    }
}
