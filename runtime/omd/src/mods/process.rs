use super::Result;
use super::failure;
use serde_json::Value;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::process::Stdio;
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

pub(super) fn evaluate(
    node: &Path,
    request: &Value,
    budget: Duration,
    active: &dyn Fn() -> bool,
) -> Result<Value> {
    let bytes = serde_json::to_vec(request)?;
    if bytes.len() > 524_288 {
        return Err(failure("input_limit"));
    }
    let mut child = command(node)?
        .args([
            "--max-old-space-size=64",
            "--no-warnings",
            "--experimental-vm-modules",
            "--input-type=module",
            "--eval",
            RUNNER,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
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
    let writer = std::thread::spawn(move || stdin.write_all(&bytes));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| failure("missing_stdout"))?;
    let reader = std::thread::spawn(move || {
        let mut output = Vec::new();
        stdout.take(65_537).read_to_end(&mut output)?;
        Ok::<_, std::io::Error>(output)
    });
    let deadline = Instant::now() + budget + Duration::from_millis(250);
    let status = loop {
        if !active() {
            break Err(failure("callback_cancelled"));
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => break Err(failure("callback_timeout")),
            Err(error) => break Err(error),
        }
    };
    if status.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let _ = writer.join();
    let output = reader.join().map_err(|_| failure("reader_failed"))??;
    let errors = errors.join().unwrap_or_default();
    let status = status?;
    if output.len() > 65_536 {
        return Err(failure("output_limit"));
    }
    let value: Value = serde_json::from_slice(&output).map_err(|_| {
        failure(format!(
            "mod_process_failed: {}",
            String::from_utf8_lossy(&errors)
        ))
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
