use super::Result;
use super::failure;
use serde_json::Value;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::ChildStdin;
use std::process::ChildStdout;
use std::process::Command;
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

const RUNNER: &str = include_str!("runner.mjs");

fn command(node: &Path) -> Result<Command> {
    if !cfg!(target_os = "macos") {
        return Err(failure("unsupported_platform: mods require macOS Seatbelt"));
    }
    let node = node.canonicalize()?;
    let literal = serde_json::to_string(&node)?;
    let profile = format!(
        "(version 1)(deny default)(allow process-exec (literal {literal}))(allow process-info* (target self))(allow sysctl-read)(allow signal (target self))(allow file-read* (literal \"/\")(literal {literal})(subpath \"/System/Library\")(subpath \"/usr/lib\")(literal \"/dev/null\")(literal \"/dev/urandom\")(literal \"/dev/random\"))(allow file-write* (literal \"/dev/null\"))"
    );
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .args(["-p", &profile])
        .arg(&node)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .current_dir("/");
    Ok(command)
}

type Spares = (Vec<(PathBuf, Child)>, Option<Instant>);

static SPARES: Mutex<Spares> = Mutex::new((Vec::new(), None));
const BUSY_RUNNERS: usize = 3;
const IDLE_AFTER: Duration = Duration::from_secs(5);

fn stop(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Trims the warm pool back to one runner once callbacks have been idle for five seconds, and
/// stops render runners unused for a minute.
fn reap() {
    static REAPER: std::sync::Once = std::sync::Once::new();
    REAPER.call_once(|| {
        std::thread::spawn(|| {
            loop {
                std::thread::sleep(Duration::from_secs(1));
                for runner in
                    retire_warm(|runner| !runner.pinned && runner.used.elapsed() >= WARM_IDLE)
                {
                    runner.stop();
                }
                let surplus = {
                    let Ok(mut spares) = SPARES.lock() else {
                        return;
                    };
                    if spares.1.is_some_and(|last| last.elapsed() >= IDLE_AFTER)
                        && !spares.0.is_empty()
                    {
                        spares.0.split_off(1)
                    } else {
                        Vec::new()
                    }
                };
                for (_, child) in surplus {
                    stop(child);
                }
            }
        });
    });
}

fn spawn(node: &Path) -> Result<Child> {
    let _profile = super::Profile::new("runner_spawn");
    command(node)?
        .args([
            "--max-old-space-size=64",
            "--no-compilation-cache",
            "--no-lazy",
            "--enable-source-maps",
            "--no-warnings",
            "--experimental-vm-modules",
            "--input-type=module",
            "--eval",
            RUNNER,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}

fn runner(node: &Path) -> Result<Child> {
    let _profile = super::Profile::new("spare_acquisition");
    let mut spares = SPARES.lock().map_err(|_| failure("mod_runner_poisoned"))?;
    let busy = spares.1.is_some_and(|last| last.elapsed() < IDLE_AFTER);
    spares.1 = Some(Instant::now());
    for (_, child) in spares.0.extract_if(.., |(path, child)| {
        path != node || !matches!(child.try_wait(), Ok(None))
    }) {
        stop(child);
    }
    let warm = (!spares.0.is_empty()).then(|| spares.0.remove(0).1);
    while spares.0.len() < if busy { BUSY_RUNNERS } else { 1 } {
        match spawn(node) {
            Ok(child) => spares.0.push((node.to_path_buf(), child)),
            Err(_) => break,
        }
    }
    reap();
    warm.map_or_else(|| spawn(node), Ok)
}

const INPUT_LIMIT: usize = 1_048_576;

fn request_line(request: &impl serde::Serialize) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(request)?;
    if bytes.len() > INPUT_LIMIT {
        return Err(failure("input_limit"));
    }
    bytes.push(b'\n');
    Ok(bytes)
}

fn lines(stdout: ChildStdout) -> (mpsc::Receiver<Vec<u8>>, std::thread::JoinHandle<()>) {
    let (sender, lines) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut stdout = BufReader::new(stdout);
        loop {
            let mut line = Vec::new();
            match (&mut stdout).take(262_145).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if sender.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    (lines, reader)
}

/// Sends one request and answers its host calls until the runner writes its result line.
fn converse(
    stdin: &mut ChildStdin,
    lines: &mpsc::Receiver<Vec<u8>>,
    bytes: &[u8],
    budget: Duration,
    active: &dyn Fn() -> bool,
    host: &mut dyn FnMut(Value) -> Result<Value>,
) -> (Result<Option<Value>>, Instant) {
    let mut deadline = Instant::now() + budget + Duration::from_millis(250);
    if let Err(error) = stdin.write_all(bytes) {
        return (Err(error), deadline);
    }
    let output = loop {
        if !active() {
            break Err(failure("callback_cancelled"));
        }
        let line = match lines.recv_timeout(Duration::from_millis(10)) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => continue,
            Err(mpsc::RecvTimeoutError::Timeout) => break Err(failure("callback_timeout")),
            Err(mpsc::RecvTimeoutError::Disconnected) => break Ok(None),
        };
        if line.len() > 262_144 {
            break Err(failure("output_limit"));
        }
        let frame = match serde_json::from_slice::<Value>(&line) {
            Ok(frame) if frame.get("call").is_some() => frame,
            Ok(frame) => break Ok(Some(frame)),
            Err(_) => break Ok(None),
        };
        let started = Instant::now();
        let receipt = match host(frame) {
            Ok(receipt) => receipt,
            Err(error) => break Err(error),
        };
        deadline += started.elapsed();
        let mut receipt = receipt.to_string().into_bytes();
        receipt.push(b'\n');
        if let Err(error) = stdin.write_all(&receipt) {
            break Err(error);
        }
    };
    (output, deadline)
}

struct Warm {
    key: String,
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<Vec<u8>>,
    reader: std::thread::JoinHandle<()>,
    errors: std::thread::JoinHandle<Vec<u8>>,
    used: Instant,
    serve: bool,
    /// A mounted component's runner: never idle-retired, only unmounted or displaced by newer ones.
    pinned: bool,
    /// Bytes of the activation request outside its serve fields.
    base: usize,
}

impl Warm {
    fn stop(self) -> Vec<u8> {
        stop(self.child);
        let _ = self.reader.join();
        self.errors.join().unwrap_or_default()
    }
}

pub(super) fn invalidate_warm(key: &str) {
    for runner in retire_warm(|runner| runner.key == key) {
        runner.stop();
    }
}

pub(super) fn unmount(id: &str, component: &str) {
    let instance = format!(":component:{id}:{component}:");
    for runner in retire_warm(|runner| runner.pinned && runner.key.contains(&instance)) {
        runner.stop();
    }
}

static WARM: Mutex<Vec<Warm>> = Mutex::new(Vec::new());
const WARM_RUNNERS: usize = 4;
const PINNED_RUNNERS: usize = 4;
const REUSED_RUNNERS: usize = 2;
const WARM_IDLE: Duration = Duration::from_secs(60);

fn warm_runner(node: &Path, key: &str, serve: bool) -> Result<Warm> {
    let mut child = runner(node)?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| failure("missing_stderr"))?;
    let errors = std::thread::spawn(move || {
        let mut stderr = stderr;
        let mut output = Vec::new();
        let mut chunk = [0; 1024];
        while let Ok(count) = stderr.read(&mut chunk) {
            if count == 0 {
                break;
            }
            output.extend_from_slice(&chunk[..count.min(769 - output.len())]);
        }
        output
    });
    let stdin = child.stdin.take().ok_or_else(|| failure("missing_stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| failure("missing_stdout"))?;
    let (lines, reader) = lines(stdout);
    Ok(Warm {
        key: key.to_owned(),
        child,
        stdin,
        lines,
        reader,
        errors,
        used: Instant::now(),
        serve,
        pinned: false,
        base: 0,
    })
}

/// Evaluates a render callback in a runner that stays activated for later renders with the same
/// `key`: the package, its settings and state, everything except the render's own input. Other
/// callbacks reuse a runner only of the same package identity, each in a fresh context.
pub(super) fn evaluate_warm<R>(
    node: &Path,
    key: &str,
    request: &R,
    budget: Duration,
    active: &dyn Fn() -> bool,
    host: &mut dyn FnMut(Value) -> Result<Value>,
) -> Result<Value>
where
    R: serde::Serialize + for<'a> std::ops::Index<&'a str, Output = Value>,
{
    let _profile = super::Profile::new(if request["serve"] == true {
        "render_callback"
    } else {
        "fresh_callback"
    });
    let serve = if request["reuse"] == true {
        request_line(request)?
    } else {
        request_line(
            &["name", "payload", "receipts", "state", "virtual_time_ms"]
                .map(|field| (field, &request[field]))
                .into_iter()
                .collect::<std::collections::BTreeMap<_, _>>(),
        )?
    };
    let mut reused = WARM.lock().ok().and_then(|mut runners| {
        let index = runners.iter().position(|runner| runner.key == key)?;
        Some(runners.swap_remove(index))
    });
    if let Some(dead) = reused.take_if(|warm| !matches!(warm.child.try_wait(), Ok(None))) {
        dead.stop();
    }
    let (mut warm, bytes) = match reused {
        Some(warm) => {
            // The activation request differs from this one only in the serve fields.
            if warm.base + serve.len() > INPUT_LIMIT + 1 {
                pool(warm);
                return Err(failure("input_limit"));
            }
            (warm, serve)
        }
        None => {
            let bytes = request_line(request)?;
            let mut warm = warm_runner(node, key, request["serve"] == true)?;
            warm.pinned = request["event"] == "component";
            warm.base = bytes.len().saturating_sub(serve.len());
            (warm, bytes)
        }
    };
    let (output, _) = converse(&mut warm.stdin, &warm.lines, &bytes, budget, active, host);
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            warm.stop();
            return Err(error);
        }
    };
    let Some(value) = output else {
        return Err(process_failure(&warm.stop()));
    };
    if let Some(error) = value.get("error") {
        warm.stop();
        return Err(failure(error.as_str().unwrap_or("mod_process_failed")));
    }
    pool(warm);
    Ok(value)
}

fn retire_warm(retire: impl FnMut(&mut Warm) -> bool) -> Vec<Warm> {
    WARM.lock()
        .map(|mut runners| runners.extract_if(.., retire).collect())
        .unwrap_or_default()
}

/// Returns a runner to the pool, stopping the least recently used ones of its kind beyond that
/// kind's size.
fn pool(mut runner: Warm) {
    runner.used = Instant::now();
    let kind = (runner.serve, runner.pinned);
    let size = match kind {
        (_, true) => PINNED_RUNNERS,
        (true, false) => WARM_RUNNERS,
        (false, false) => REUSED_RUNNERS,
    };
    let evicted = match WARM.lock() {
        Ok(mut runners) => {
            runners.push(runner);
            let mut evicted = Vec::new();
            while runners
                .iter()
                .filter(|runner| (runner.serve, runner.pinned) == kind)
                .count()
                > size
            {
                let oldest = runners
                    .iter()
                    .enumerate()
                    .filter(|(_, runner)| (runner.serve, runner.pinned) == kind)
                    .min_by_key(|(_, runner)| runner.used)
                    .map_or(0, |(index, _)| index);
                evicted.push(runners.swap_remove(oldest));
            }
            evicted
        }
        Err(_) => vec![runner],
    };
    for runner in evicted {
        runner.stop();
    }
}

fn process_failure(errors: &[u8]) -> std::io::Error {
    let errors = String::from_utf8_lossy(errors);
    if errors.contains("heap out of memory") || errors.contains("Reached heap limit") {
        failure("mod_out_of_memory: the mod exceeded its 64 MB heap")
    } else {
        failure(format!(
            "mod_process_failed: {}",
            errors.lines().next().unwrap_or_default()
        ))
    }
}

pub(super) fn evaluate(
    node: &Path,
    request: &impl serde::Serialize,
    budget: Duration,
    active: &dyn Fn() -> bool,
    host: &mut dyn FnMut(Value) -> Result<Value>,
) -> Result<Value> {
    let bytes = request_line(request)?;
    let mut child = runner(node)?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| failure("missing_stderr"))?;
    let errors = std::thread::spawn(move || {
        let mut output = Vec::new();
        let _ = stderr.take(769).read_to_end(&mut output);
        output
    });
    let mut stdin = child.stdin.take().ok_or_else(|| failure("missing_stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| failure("missing_stdout"))?;
    let (lines, reader) = lines(stdout);
    let (output, deadline) = converse(&mut stdin, &lines, &bytes, budget, active, host);
    drop(stdin);
    if output.is_ok() {
        while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    let _ = child.kill();
    let status = child.wait();
    let _ = reader.join();
    let errors = errors.join().unwrap_or_default();
    let output = output?;
    let status = status?;
    let value = output.ok_or_else(|| process_failure(&errors))?;
    if !status.success() || value.get("error").is_some() {
        return Err(failure(
            value["error"].as_str().unwrap_or("mod_process_failed"),
        ));
    }
    Ok(value)
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;
