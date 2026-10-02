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

/// Trims the warm pool back to one runner once callbacks have been idle for five seconds.
fn reap() {
    static REAPER: std::sync::Once = std::sync::Once::new();
    REAPER.call_once(|| {
        std::thread::spawn(|| {
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let Ok(mut spares) = SPARES.lock() else {
                    return;
                };
                if spares.1.is_some_and(|last| last.elapsed() >= IDLE_AFTER) {
                    while spares.0.len() > 1 {
                        if let Some((_, child)) = spares.0.pop() {
                            stop(child);
                        }
                    }
                }
            }
        });
    });
}

fn spawn(node: &Path) -> Result<Child> {
    command(node)?
        .args([
            "--max-old-space-size=64",
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

pub(super) fn evaluate(
    node: &Path,
    request: &Value,
    budget: Duration,
    active: &dyn Fn() -> bool,
    host: &mut dyn FnMut(Value) -> Result<Value>,
) -> Result<Value> {
    let mut bytes = serde_json::to_vec(request)?;
    if bytes.len() > 524_288 {
        return Err(failure("input_limit"));
    }
    bytes.push(b'\n');
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
    let mut deadline = Instant::now() + budget + Duration::from_millis(250);
    let output = if let Err(error) = stdin.write_all(&bytes) {
        Err(error)
    } else {
        loop {
            if !active() {
                break Err(failure("callback_cancelled"));
            }
            let line = match lines.recv_timeout(Duration::from_millis(10)) {
                Ok(line) => line,
                Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => break Err(failure("callback_timeout")),
                Err(mpsc::RecvTimeoutError::Disconnected) => break Ok(Vec::new()),
            };
            if line.len() > 262_144 {
                break Err(failure("output_limit"));
            }
            let frame = match serde_json::from_slice::<Value>(&line) {
                Ok(frame) if frame.get("call").is_some() => frame,
                _ => break Ok(line),
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
        }
    };
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
    let value: Value = serde_json::from_slice(&output).map_err(|_| {
        let errors = String::from_utf8_lossy(&errors);
        if errors.contains("heap out of memory") || errors.contains("Reached heap limit") {
            failure("mod_out_of_memory: the mod exceeded its 64 MB heap")
        } else {
            failure(format!(
                "mod_process_failed: {}",
                errors.lines().next().unwrap_or_default()
            ))
        }
    })?;
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
