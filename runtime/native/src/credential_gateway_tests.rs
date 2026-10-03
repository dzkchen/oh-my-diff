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

struct Paced(Vec<&'static [u8]>, std::sync::mpsc::Receiver<()>);

impl Read for Paced {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.0.len() == 1 {
            let _ = self.1.recv();
        }
        let Some(piece) = self.0.pop() else {
            return Ok(0);
        };
        buffer[..piece.len()].copy_from_slice(piece);
        Ok(piece.len())
    }
}

#[test]
fn streamed_replies_reach_the_client_before_the_body_ends() {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let (more, wait) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let body = Paced(vec![&b"data: 2\n\n"[..], &b"data: 1\n\n"[..]], wait);
        stream(server.recv().unwrap(), 200, Vec::new(), body).unwrap();
    });
    let mut response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap()
        .get(format!("http://127.0.0.1:{port}/"))
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
