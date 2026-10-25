use super::*;
use std::os::unix::fs::PermissionsExt;
use std::time::Instant;

struct OpenGate;

impl broker::Gate for OpenGate {
    fn peer(&self, _stream: &UnixStream) -> io::Result<()> {
        Ok(())
    }

    fn authorize(&self, _: &UnixStream, _: &str, _: &str, _: Option<&str>) -> bool {
        false
    }
}

struct Machine {
    _temp: tempfile::TempDir,
    base: PathBuf,
    helper: PathBuf,
    broker: PathBuf,
}

impl Machine {
    fn new(disabled: bool, owner: u32) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let pmset = base.join("pmset");
        fs::write(
            &pmset,
            "#!/bin/sh\nd=$(dirname \"$0\")\nif [ \"$1\" = sleepnow ]; then echo sleepnow >> \"$d/log\"; exit 0; fi\nif [ \"$1\" = -g ]; then printf 'System-wide power settings:\\n SleepDisabled\\t\\t%s\\n' \"$(cat \"$d/state\")\"; exit 0; fi\necho \"$3\" > \"$d/state\"\necho \"$3\" >> \"$d/log\"\n",
        )
        .unwrap();
        let ioreg = base.join("ioreg");
        fs::write(&ioreg, "#!/bin/sh\necho \"  \\\"AppleClamshellState\\\" = $(cat \"$(dirname \"$0\")/lid\")\"\n").unwrap();
        for program in [&pmset, &ioreg] {
            fs::set_permissions(program, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(base.join("lid"), "No").unwrap();
        fs::write(base.join("state"), if disabled { "1\n" } else { "0\n" }).unwrap();
        let setting =
            Arc::new(Setting::open(pmset, ioreg, base.join("power.json"), owner).unwrap());
        let helper = base.join("helper.sock");
        let listener = UnixListener::bind(&helper).unwrap();
        std::thread::spawn(move || setting.serve(listener));
        let root = base.join("broker");
        fs::create_dir(&root).unwrap();
        let mut served = broker::Broker::open(root).unwrap();
        served.power = helper.clone();
        let served = Arc::new(served);
        let socket = base.join("broker.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        std::thread::spawn(move || served.serve(listener, Arc::new(OpenGate)));
        Self {
            _temp: temp,
            base,
            helper,
            broker: socket,
        }
    }

    fn uid() -> u32 {
        unsafe { libc::getuid() }
    }

    fn state(&self) -> String {
        fs::read_to_string(self.base.join("state"))
            .unwrap()
            .trim()
            .to_owned()
    }

    fn close_lid(&self) {
        fs::write(self.base.join("lid"), "Yes").unwrap();
    }

    fn log(&self) -> String {
        fs::read_to_string(self.base.join("log")).unwrap_or_default()
    }

    fn settles(&self, state: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.state() != state || self.base.join("power.json").exists() != (state == "1") {
            assert!(
                Instant::now() < deadline,
                "SleepDisabled stayed {}",
                self.state()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn leases(&self) -> Leases {
        Leases {
            broker: Some(self.broker.clone()),
            ..Leases::default()
        }
    }
}

fn hold(lid_closed: bool) -> Value {
    json!({"reason": "agents working", "lid_closed": lid_closed, "max_duration_ms": 60_000})
}

#[test]
fn lid_closed_leases_share_one_setting_and_the_last_one_restores_it_and_sleeps_a_closed_mac() {
    let machine = Machine::new(false, Machine::uid());
    machine.close_lid();
    let leases = machine.leases();
    let first = leases.hold("a", "s", &hold(true)).unwrap();
    leases.hold("b", "s", &hold(true)).unwrap();
    assert_eq!(first["lid_closed"], true);
    machine.settles("1");
    assert_eq!(
        leases
            .release("a", &json!({"lease": first["lease"]}))
            .unwrap(),
        json!({"released": true})
    );
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(machine.state(), "1");
    leases.release_owner("b");
    machine.settles("0");
    assert_eq!(machine.log(), "1\n0\nsleepnow\n");
}

#[test]
fn a_setting_that_was_already_disabled_is_put_back() {
    let machine = Machine::new(true, Machine::uid());
    machine.close_lid();
    let leases = machine.leases();
    let held = leases.hold("a", "s", &hold(true)).unwrap();
    machine.settles("1");
    leases
        .release("a", &json!({"lease": held["lease"]}))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while machine.base.join("power.json").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        (machine.state().as_str(), machine.log().as_str()),
        ("1", "1\n1\n")
    );
}

#[test]
fn an_expired_broker_hold_restores_sleep() {
    let machine = Machine::new(false, Machine::uid());
    let mut client = broker::Client::at(&machine.broker).unwrap();
    let arguments = json!({"reason": "agents working", "max_duration_ms": 200});
    client.call("power.hold", arguments.clone()).unwrap();
    assert_eq!(
        client
            .call("power.hold", arguments)
            .unwrap_err()
            .to_string(),
        "authority_power_held"
    );
    machine.settles("1");
    machine.settles("0");
    assert!(client.call("anchor.get", json!({})).is_err());
}

#[test]
fn a_record_left_by_a_failed_restore_keeps_the_setting_from_before_the_first_hold() {
    let machine = Machine::new(true, Machine::uid());
    fs::write(machine.base.join("power.json"), r#"{"previous":false}"#).unwrap();
    let leases = machine.leases();
    let held = leases.hold("a", "s", &hold(true)).unwrap();
    leases
        .release("a", &json!({"lease": held["lease"]}))
        .unwrap();
    machine.settles("0");
}

#[test]
fn a_lease_ends_when_its_broker_connection_drops() {
    let temp = tempfile::tempdir().unwrap();
    let socket = temp.path().join("broker.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut line = String::new();
        BufReader::new(&stream).read_line(&mut line).unwrap();
        (&stream).write_all(b"{\"ok\":null}\n").unwrap();
    });
    let leases = Leases {
        broker: Some(socket),
        ..Leases::default()
    };
    let held = leases.hold("a", "s", &hold(true)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while leases
        .records
        .lock()
        .unwrap()
        .contains_key(held["lease"].as_str().unwrap())
    {
        assert!(
            Instant::now() < deadline,
            "the lease outlived its broker connection"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn the_helper_restores_a_record_left_by_a_crash_and_refuses_other_users() {
    let machine = Machine::new(true, Machine::uid() + 1);
    assert_eq!(machine.state(), "1");
    fs::write(machine.base.join("power.json"), r#"{"previous":false}"#).unwrap();
    let base = &machine.base;
    Setting::open(
        base.join("pmset"),
        base.join("ioreg"),
        base.join("power.json"),
        0,
    )
    .unwrap();
    assert_eq!(machine.state(), "0");
    assert!(!machine.base.join("power.json").exists());
    let refused = Hold::start(
        &machine.helper,
        &json!({"reason": "agents working", "max_duration_ms": 1000}),
        UnixStream::pair().unwrap().0,
    );
    assert_eq!(
        refused.err().unwrap().to_string(),
        "authority_peer_unverified"
    );
}

#[test]
fn leases_belong_to_their_owner_and_current_source() {
    let leases = Leases::default();
    let held = leases.hold("a", "s1", &hold(false)).unwrap();
    assert_eq!(held["lid_closed"], false);
    assert_eq!(
        leases
            .release("b", &json!({"lease": held["lease"]}))
            .unwrap(),
        json!({"released": false})
    );
    for _ in 1..LEASES_PER_OWNER {
        leases.hold("a", "s1", &hold(false)).unwrap();
    }
    assert_eq!(
        leases.hold("a", "s1", &hold(false)).unwrap_err(),
        "power_lease_limit"
    );
    assert_eq!(
        leases
            .hold("b", "s1", &json!({"reason": "x", "max_duration_ms": 1000}))
            .unwrap_err(),
        "power_request_invalid"
    );
    leases.retain(&BTreeMap::from([("a".to_owned(), "s2".to_owned())]));
    assert_eq!(
        leases
            .release("a", &json!({"lease": held["lease"]}))
            .unwrap(),
        json!({"released": false})
    );
    leases.hold("a", "s2", &hold(false)).unwrap();
}
