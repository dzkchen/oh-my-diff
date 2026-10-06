use super::*;
use std::io::{BufRead, Write};
use std::time::Duration;

static TEST_GATEWAY: Mutex<()> = Mutex::new(());

fn get(url: &str) -> (u16, String) {
    let response = reqwest::blocking::get(url).unwrap();
    (response.status().as_u16(), response.text().unwrap())
}

#[test]
fn only_registered_sidecars_reach_approved_profiles_until_revoked() {
    let _lock = TEST_GATEWAY.lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let store = temp.path().canonicalize().unwrap();
    let profiles = CredentialProfiles::local(&store).unwrap();
    let approved = profiles
        .create("up", "provider", Some("up"), Some("https://up.example"))
        .unwrap();
    let other = profiles.create("other", "api_key", None, None).unwrap();
    let (base, registration) = register(store, BTreeSet::from([approved.id.clone()])).unwrap();
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

fn read_request(socket: &mut std::net::TcpStream) {
    let mut reader = std::io::BufReader::new(socket);
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
        headers.push_str(&line);
    }
    assert!(
        headers
            .to_lowercase()
            .contains("authorization: bearer fixture")
    );
}

fn enrolled(root: &std::path::Path, address: std::net::SocketAddr) -> (String, Registration) {
    let root = root.canonicalize().unwrap();
    let profiles = CredentialProfiles::local(&root).unwrap();
    let profile = profiles
        .create_secret("fixture", &format!("http://{address}"), "owner")
        .unwrap();
    profiles.store_secret(&profile.id, "fixture").unwrap();
    std::fs::write(
        root.join("credentials").join(&profile.id).join("auth.json"),
        r#"{"OPENAI_API_KEY":"fixture"}"#,
    )
    .unwrap();
    let (base, registration) = register(root, BTreeSet::from([profile.id.clone()])).unwrap();
    (format!("{base}/{}/stream", profile.id), registration)
}

#[test]
fn streamed_replies_reach_the_client_before_the_body_ends() {
    let _lock = TEST_GATEWAY.lock().unwrap();
    let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let root = tempfile::tempdir().unwrap();
    let (url, _registration) = enrolled(root.path(), server.local_addr().unwrap());
    let (more, wait) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let (mut socket, _) = server.accept().unwrap();
        read_request(&mut socket);
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n9\r\ndata: 1\n\n\r\n")
            .unwrap();
        wait.recv_timeout(Duration::from_secs(5)).unwrap();
        socket.write_all(b"9\r\ndata: 2\n\n\r\n0\r\n\r\n").unwrap();
    });
    let mut response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap()
        .get(url)
        .send()
        .unwrap();
    let mut first = [0; 9];
    response.read_exact(&mut first).unwrap();
    assert_eq!(&first, b"data: 1\n\n");
    more.send(()).unwrap();
    let mut rest = String::new();
    response.read_to_string(&mut rest).unwrap();
    assert_eq!(rest, "data: 2\n\n");
}

#[test]
fn revocation_closes_inflight_headers_and_streams() {
    let _lock = TEST_GATEWAY.lock().unwrap();
    for prefix in [
        "",
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n",
        "HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\nx",
    ] {
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let root = tempfile::tempdir().unwrap();
        let (url, registration) = enrolled(root.path(), server.local_addr().unwrap());
        let (started, ready) = std::sync::mpsc::channel();
        let upstream = std::thread::spawn(move || {
            let (mut socket, _) = server.accept().unwrap();
            read_request(&mut socket);
            socket.write_all(prefix.as_bytes()).unwrap();
            started.send(()).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let result = socket.read(&mut [0u8; 1]);
            assert!(
                matches!(result, Ok(0))
                    || result.is_err_and(|error| matches!(
                        error.kind(),
                        io::ErrorKind::ConnectionReset | io::ErrorKind::BrokenPipe
                    )),
                "authenticated connection survived revocation"
            );
        });
        let downstream = std::thread::spawn(move || {
            reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap()
                .get(url)
                .send()
                .and_then(|response| response.text())
        });
        ready.recv_timeout(Duration::from_secs(3)).unwrap();
        drop(registration);
        upstream.join().unwrap();
        let _ = downstream.join().unwrap();
    }
}

#[test]
fn stalled_requests_release_capacity_at_the_deadline() {
    let _lock = TEST_GATEWAY.lock().unwrap();
    let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let root = tempfile::tempdir().unwrap();
    let (url, _registration) = enrolled(root.path(), server.local_addr().unwrap());
    let (started, ready) = std::sync::mpsc::channel();
    let upstream = std::thread::spawn(move || {
        let mut sockets = Vec::new();
        for _ in 0..16 {
            let (mut socket, _) = server.accept().unwrap();
            read_request(&mut socket);
            sockets.push(socket);
        }
        started.send(()).unwrap();
        for mut socket in sockets {
            socket
                .set_read_timeout(Some(Duration::from_secs(4)))
                .unwrap();
            let result = socket.read(&mut [0u8; 1]);
            assert!(
                matches!(result, Ok(0))
                    || result.is_err_and(|error| error.kind() == io::ErrorKind::ConnectionReset)
            );
        }
    });
    let clients: Vec<_> = (0..16)
        .map(|_| {
            let url = url.clone();
            std::thread::spawn(move || {
                reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(5))
                    .build()
                    .unwrap()
                    .get(url)
                    .send()
                    .unwrap()
                    .status()
            })
        })
        .collect();
    ready.recv_timeout(Duration::from_secs(4)).unwrap();
    assert_eq!(get(&url).0, 503);
    for client in clients {
        assert!(client.join().unwrap().is_server_error());
    }
    upstream.join().unwrap();
    assert_eq!(
        get(&url).0,
        502,
        "capacity is reusable after all timed-out sockets close"
    );
}
