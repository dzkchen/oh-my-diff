use crate::broker;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::Shutdown;
use std::os::unix::net::UnixListener;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;

pub const DAEMON: &str = "/Library/LaunchDaemons/dev.ohmydiff.broker.power.plist";
pub const SOCKET: &str = "/var/run/dev.ohmydiff.broker.power.sock";
pub const RECORD: &str = "/Library/Application Support/OhMyDiff/power.json";
pub const PMSET: &str = "/usr/bin/pmset";
pub const IOREG: &str = "/usr/sbin/ioreg";
pub const MAX_DURATION_MS: u64 = 86_400_000;
const MIN_DURATION_MS: u64 = 60_000;
const REASON_BYTES: usize = 128;
const LEASES_PER_OWNER: usize = 4;
const HOLDERS_LIMIT: u64 = 256;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const LINE_BYTES: u64 = 4096;

fn failure(code: &str) -> io::Error {
    io::Error::other(code.to_owned())
}

fn reply(stream: &mut UnixStream, value: Value) -> io::Result<()> {
    let mut line = serde_json::to_vec(&value)?;
    line.push(b'\n');
    stream.write_all(&line)
}

fn until_closed(mut stream: UnixStream) {
    let _ = stream.set_read_timeout(None);
    let mut buffer = [0u8; 64];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => return,
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return,
        }
    }
}

fn sleep_after(duration: Duration, expire: impl FnOnce() + Send + 'static) -> mpsc::Sender<()> {
    let (cancel, cancelled) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        if cancelled.recv_timeout(duration) == Err(mpsc::RecvTimeoutError::Timeout) {
            expire();
        }
    });
    cancel
}

pub struct Setting {
    pmset: PathBuf,
    ioreg: PathBuf,
    record: PathBuf,
    owner: u32,
    holders: Mutex<u64>,
}

impl Setting {
    pub fn open(pmset: PathBuf, ioreg: PathBuf, record: PathBuf, owner: u32) -> io::Result<Self> {
        let setting = Self {
            pmset,
            ioreg,
            record,
            owner,
            holders: Mutex::new(0),
        };
        setting.restore()?;
        Ok(setting)
    }

    pub fn serve(self: Arc<Self>, listener: UnixListener) {
        for stream in listener.incoming() {
            let Ok(stream) = stream else {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            };
            let setting = self.clone();
            std::thread::spawn(move || setting.connection(stream));
        }
    }

    fn connection(&self, mut stream: UnixStream) -> io::Result<()> {
        if broker::peer_uid(&stream) != Some(self.owner) {
            return reply(&mut stream, json!({"error": "authority_peer_unverified"}));
        }
        stream.set_read_timeout(Some(REQUEST_TIMEOUT))?;
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut line = String::new();
        (&mut reader).take(LINE_BYTES).read_line(&mut line)?;
        stream.set_read_timeout(None)?;
        let request: Value = serde_json::from_str(&line).unwrap_or_default();
        if request != json!({"op": "hold"}) {
            return reply(&mut stream, json!({"error": "authority_request_invalid"}));
        }
        if let Err(error) = self.acquire() {
            return reply(&mut stream, json!({"error": error.to_string()}));
        }
        let replied = reply(&mut stream, json!({"ok": null}));
        let _ = io::copy(&mut reader, &mut io::sink());
        if let Err(error) = self.release() {
            eprintln!("omd-broker power: restoring SleepDisabled failed: {error}");
            std::process::exit(1);
        }
        replied
    }

    fn acquire(&self) -> io::Result<()> {
        let mut holders = self
            .holders
            .lock()
            .map_err(|_| failure("authority_state_poisoned"))?;
        if *holders >= HOLDERS_LIMIT {
            return Err(failure("authority_power_busy"));
        }
        if *holders == 0 && !self.record.exists() {
            broker::write_private(&self.record, &json!({"previous": self.disabled()?}))?;
            if let Err(error) = self.set(true) {
                let _ = fs::remove_file(&self.record);
                return Err(error);
            }
        }
        *holders += 1;
        Ok(())
    }

    fn release(&self) -> io::Result<()> {
        let mut holders = self
            .holders
            .lock()
            .map_err(|_| failure("authority_state_poisoned"))?;
        *holders = holders.saturating_sub(1);
        if *holders == 0 {
            self.restore()?;
        }
        Ok(())
    }

    fn restore(&self) -> io::Result<()> {
        let record: Value = match fs::read(&self.record) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let previous = record["previous"].as_bool().unwrap_or(false);
        self.set(previous)?;
        if !previous && self.lid_closed() {
            Command::new(&self.pmset).arg("sleepnow").status()?;
        }
        fs::remove_file(&self.record)
    }

    fn lid_closed(&self) -> bool {
        Command::new(&self.ioreg)
            .args(["-r", "-k", "AppleClamshellState", "-d", "1"])
            .output()
            .is_ok_and(|output| {
                String::from_utf8_lossy(&output.stdout).contains("\"AppleClamshellState\" = Yes")
            })
    }

    fn disabled(&self) -> io::Result<bool> {
        let output = Command::new(&self.pmset).arg("-g").output()?;
        if !output.status.success() {
            return Err(failure("authority_power_unavailable"));
        }
        Ok(String::from_utf8_lossy(&output.stdout).lines().any(|line| {
            let mut fields = line.split_whitespace();
            fields.next() == Some("SleepDisabled") && fields.next() == Some("1")
        }))
    }

    fn set(&self, disabled: bool) -> io::Result<()> {
        let value = if disabled { "1" } else { "0" };
        let status = Command::new(&self.pmset)
            .args(["-a", "disablesleep", value])
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(failure("authority_power_unavailable"))
        }
    }
}

pub(crate) struct Hold {
    helper: UnixStream,
    _expiry: mpsc::Sender<()>,
}

impl Hold {
    pub(crate) fn start(socket: &Path, arguments: &Value, client: UnixStream) -> io::Result<Self> {
        arguments["reason"]
            .as_str()
            .filter(|reason| !reason.is_empty() && reason.len() <= REASON_BYTES)
            .ok_or_else(|| failure("authority_request_invalid"))?;
        let duration = arguments["max_duration_ms"]
            .as_u64()
            .filter(|ms| (1..=MAX_DURATION_MS).contains(ms))
            .ok_or_else(|| failure("authority_request_invalid"))?;
        let mut helper =
            UnixStream::connect(socket).map_err(|_| failure("authority_power_unavailable"))?;
        helper.set_read_timeout(Some(REQUEST_TIMEOUT))?;
        reply(&mut helper, json!({"op": "hold"}))?;
        let mut line = String::new();
        BufReader::new(&helper)
            .take(LINE_BYTES)
            .read_line(&mut line)?;
        let answer: Value =
            serde_json::from_str(&line).map_err(|_| failure("authority_power_unavailable"))?;
        if let Some(error) = answer["error"].as_str() {
            return Err(failure(error));
        }
        let ended = helper.try_clone()?;
        std::thread::spawn(move || {
            until_closed(ended);
            let _ = client.shutdown(Shutdown::Both);
        });
        let watched = helper.try_clone()?;
        let expiry = sleep_after(Duration::from_millis(duration), move || {
            let _ = watched.shutdown(Shutdown::Both);
        });
        Ok(Self {
            helper,
            _expiry: expiry,
        })
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        let _ = self.helper.shutdown(Shutdown::Both);
    }
}

struct Lease {
    owner: String,
    source: String,
    _idle: codex_utils_sleep_inhibitor::SleepInhibitor,
    broker: Option<UnixStream>,
    _expiry: mpsc::Sender<()>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(broker) = &self.broker {
            let _ = broker.shutdown(Shutdown::Both);
        }
    }
}

type Records = Arc<Mutex<BTreeMap<String, Lease>>>;

#[derive(Default)]
pub struct Leases {
    broker: Option<PathBuf>,
    records: Records,
    next: AtomicU64,
}

impl Leases {
    pub fn hold(&self, owner: &str, source: &str, arguments: &Value) -> Result<Value, String> {
        let reason = arguments["reason"]
            .as_str()
            .filter(|reason| !reason.is_empty() && reason.len() <= REASON_BYTES)
            .ok_or("power_request_invalid")?;
        let duration = arguments["max_duration_ms"]
            .as_u64()
            .filter(|ms| (MIN_DURATION_MS..=MAX_DURATION_MS).contains(ms))
            .ok_or("power_request_invalid")?;
        let lid_closed = arguments["lid_closed"].as_bool().unwrap_or(false);
        let full = |records: &BTreeMap<String, Lease>| {
            records
                .values()
                .filter(|lease| lease.owner == owner)
                .count()
                >= LEASES_PER_OWNER
        };
        {
            let records = self.records.lock().map_err(|_| "power_state_poisoned")?;
            if let Some(current) = arguments["lease"].as_str()
                && records.get(current).is_some_and(|lease| {
                    lease.owner == owner && lease.broker.is_some() == lid_closed
                })
            {
                return Ok(json!({"lease": current, "lid_closed": lid_closed}));
            }
            if full(&records) {
                return Err("power_lease_limit".into());
            }
        }
        let broker = if lid_closed {
            let socket = self
                .broker
                .clone()
                .or_else(|| broker::deployed().then(|| PathBuf::from(broker::SOCKET)))
                .ok_or("power_unavailable: the authority broker is not deployed")?;
            let mut client = broker::Client::at(&socket).map_err(|error| error.to_string())?;
            client
                .call(
                    "power.hold",
                    json!({"reason": reason, "max_duration_ms": duration}),
                )
                .map_err(|error| match error.to_string().as_str() {
                    "authority_operation_unknown" => {
                        "power_unavailable: reinstall the authority broker for lid-closed holds"
                            .to_owned()
                    }
                    other => other.to_owned(),
                })?;
            Some(client.socket().map_err(|error| error.to_string())?)
        } else {
            None
        };
        let mut idle = codex_utils_sleep_inhibitor::SleepInhibitor::new(true);
        idle.set_turn_running(true);
        let lease = format!("power-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let end = {
            let (records, lease) = (Arc::downgrade(&self.records), lease.clone());
            move || {
                if let Some(records) = records.upgrade()
                    && let Ok(mut records) = records.lock()
                {
                    records.remove(&lease);
                }
            }
        };
        let closed = broker
            .as_ref()
            .map(|broker| broker.try_clone().map(|closed| (closed, end.clone())))
            .transpose()
            .map_err(|e| e.to_string())?;
        let expiry = sleep_after(Duration::from_millis(duration), end);
        let mut records = self.records.lock().map_err(|_| "power_state_poisoned")?;
        if full(&records) {
            if let Some(broker) = &broker {
                let _ = broker.shutdown(Shutdown::Both);
            }
            return Err("power_lease_limit".into());
        }
        records.insert(
            lease.clone(),
            Lease {
                owner: owner.to_owned(),
                source: source.to_owned(),
                _idle: idle,
                broker,
                _expiry: expiry,
            },
        );
        if let Some((closed, end)) = closed {
            std::thread::spawn(move || {
                until_closed(closed);
                end();
            });
        }
        Ok(json!({"lease": lease, "lid_closed": lid_closed}))
    }

    pub fn release(&self, owner: &str, arguments: &Value) -> Result<Value, String> {
        let lease = arguments["lease"].as_str().ok_or("power_request_invalid")?;
        let mut records = self.records.lock().map_err(|_| "power_state_poisoned")?;
        let released = records
            .get(lease)
            .is_some_and(|record| record.owner == owner);
        if released {
            records.remove(lease);
        }
        Ok(json!({"released": released}))
    }

    pub fn retain(&self, sources: &BTreeMap<String, String>) {
        if let Ok(mut records) = self.records.lock() {
            records.retain(|_, lease| sources.get(&lease.owner) == Some(&lease.source));
        }
    }

    pub fn release_owner(&self, owner: &str) {
        if let Ok(mut records) = self.records.lock() {
            records.retain(|_, lease| lease.owner != owner);
        }
    }

    pub fn clear(&self) {
        if let Ok(mut records) = self.records.lock() {
            records.clear();
        }
    }
}

#[cfg(test)]
#[path = "power_tests.rs"]
mod tests;
