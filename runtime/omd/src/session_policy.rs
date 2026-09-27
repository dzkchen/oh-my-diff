use serde_json::Value;
use std::collections::BTreeSet;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub(crate) fn permitted(
    root: &Path,
    repository: &Path,
    configured_database: Option<&Path>,
    active: &dyn Fn() -> bool,
) -> io::Result<Option<BTreeSet<String>>> {
    let database = configured_database.map(Path::to_path_buf).unwrap_or(
        root.parent()
            .ok_or_else(|| io::Error::other("session_home_missing"))?
            .join("state_5.sqlite"),
    );
    let home = database
        .parent()
        .ok_or_else(|| io::Error::other("session_home_missing"))?;
    if home.try_exists()? {
        for (ordinal, entry) in std::fs::read_dir(home)?.enumerate() {
            if ordinal >= 4096 || !active() {
                return Err(io::Error::other("session_policy_scan_limit_or_cancelled"));
            }
            let name = entry?.file_name().to_string_lossy().into_owned();
            if let Some(version) = name
                .strip_prefix("state_")
                .and_then(|value| value.strip_suffix(".sqlite"))
            {
                if version.parse::<u32>().map_or(true, |version| version > 5) {
                    return Err(io::Error::other("session_policy_version_unsupported"));
                }
            }
        }
    }
    if !database.try_exists()? {
        return Ok(None);
    }
    if database.canonicalize()? != database || !std::fs::symlink_metadata(&database)?.is_file() {
        return Err(io::Error::other("session_policy_scope_invalid"));
    }
    if !active() {
        return Err(io::Error::other("session_read_cancelled"));
    }
    let hex: String = repository
        .as_os_str()
        .as_encoded_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let query = format!(
        "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; SELECT id,memory_mode FROM threads WHERE cwd=CAST(X'{hex}' AS TEXT) ORDER BY id LIMIT 4097;"
    );
    let mut child = Command::new("/usr/bin/sqlite3")
        .args([
            "-batch",
            "-json",
            "-init",
            "/dev/null",
            "-cmd",
            ".timeout 100",
        ])
        .arg(&database)
        .arg(query)
        .env_clear()
        .env("HOME", "/nonexistent")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| io::Error::other("session_policy_backend_unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("session_policy_pipe_unavailable"))?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    let result = loop {
        if !active() || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break Err(io::Error::other("session_policy_cancelled_or_timed_out"));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err(io::Error::other("session_policy_unavailable"))
                };
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(error);
            }
        }
    };
    let bytes = reader
        .join()
        .map_err(|_| io::Error::other("session_policy_reader_failed"))??;
    result?;
    if bytes.len() > 1_048_576 {
        return Err(io::Error::other("session_policy_limit"));
    }
    if bytes.is_empty() {
        return Ok(Some(BTreeSet::new()));
    }
    let rows: Vec<Value> = serde_json::from_slice(&bytes)?;
    if rows.len() > 4096 {
        return Err(io::Error::other("session_policy_limit"));
    }
    let mut allowed = BTreeSet::new();
    for row in rows {
        let id = row["id"]
            .as_str()
            .filter(|id| crate::resource_data::token(id))
            .ok_or_else(|| io::Error::other("session_policy_identity_invalid"))?;
        if row["memory_mode"] == "enabled" {
            allowed.insert(id.to_owned());
        }
    }
    Ok(Some(allowed))
}
