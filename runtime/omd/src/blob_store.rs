use crate::resource_data::{ResourceStore, hash};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;

pub const BLOB_BYTES: usize = 16 * 1024 * 1024;
pub const IMAGE_BYTES: usize = 8 * 1024 * 1024;
pub const SVG_BYTES: usize = 1024 * 1024;
pub const BLOB_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
pub const BLOB_ENTRIES: usize = 4096;
pub const ROTATING_RECORDS: usize = 1024;
const ROTATING_KEEP: usize = 768;
const PRUNE_WRITES: u32 = 16;
const ORPHAN_GRACE: std::time::Duration = std::time::Duration::from_secs(60);

fn svg(bytes: &[u8]) -> Result<(), &'static str> {
    use quick_xml::events::Event;
    use quick_xml::name::{Namespace, ResolveResult};
    if bytes.len() > SVG_BYTES {
        return Err("svg_too_large");
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "svg_not_utf8")?;
    let external = |value: &str| {
        let value = value.to_ascii_lowercase();
        ["@import", "@font-face", "image-set(", "src(", "\\"]
            .iter()
            .any(|token| value.contains(token))
            || value.split("url(").skip(1).any(|rest| {
                !rest
                    .trim_start()
                    .trim_start_matches(['"', '\''])
                    .starts_with('#')
            })
    };
    let mut reader = quick_xml::NsReader::from_str(text);
    let (mut root, mut style) = (false, None::<String>);
    loop {
        let (namespace, event) = reader
            .read_resolved_event()
            .map(|(namespace, event)| {
                let svg = matches!(
                    namespace,
                    ResolveResult::Unbound
                        | ResolveResult::Bound(Namespace(b"http://www.w3.org/2000/svg"))
                );
                (svg, event)
            })
            .map_err(|_| "svg_malformed")?;
        let open = matches!(event, Event::Start(_));
        match event {
            Event::Eof if style.is_some() => return Err("svg_malformed"),
            Event::Eof if root => return Ok(()),
            Event::Eof => return Err("svg_root_missing"),
            Event::DocType(_) => return Err("svg_doctype"),
            Event::PI(_) => return Err("svg_processing_instruction"),
            Event::Decl(_) if root => return Err("svg_processing_instruction"),
            Event::Start(element) | Event::Empty(element) => {
                let name =
                    String::from_utf8_lossy(element.local_name().as_ref()).to_ascii_lowercase();
                if !root && name != "svg" {
                    return Err("svg_root_not_svg");
                }
                if style.is_some()
                    || !namespace
                    || matches!(
                        name.as_str(),
                        "script"
                            | "foreignobject"
                            | "iframe"
                            | "object"
                            | "embed"
                            | "audio"
                            | "video"
                    )
                {
                    return Err("svg_element_forbidden");
                }
                root = true;
                if open && name == "style" {
                    style = Some(String::new());
                }
                for attribute in element.attributes() {
                    let attribute = attribute.map_err(|_| "svg_malformed")?;
                    let key = attribute.key.local_name().as_ref().to_ascii_lowercase();
                    let value = attribute
                        .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                        .map_err(|_| "svg_malformed")?;
                    let animation = name.starts_with("animate") || name == "set";
                    if key.starts_with(b"on")
                        || animation
                            && key == b"attributename"
                            && value.to_ascii_lowercase().starts_with("on")
                    {
                        return Err("svg_event_handler");
                    }
                    if matches!(
                        key.as_slice(),
                        b"src" | b"srcset" | b"data" | b"action" | b"formaction" | b"ping"
                    ) {
                        return Err("svg_attribute_forbidden");
                    }
                    if key == b"href"
                        && !["#", "data:image/png;base64,", "data:image/jpeg;base64,"]
                            .iter()
                            .any(|prefix| value.starts_with(prefix))
                        || animation
                            && key == b"attributename"
                            && value.to_ascii_lowercase().ends_with("href")
                    {
                        return Err("svg_href_external");
                    }
                    if external(&value) {
                        return Err("svg_url_external");
                    }
                }
            }
            Event::Text(text) => {
                if let Some(css) = style.as_mut() {
                    css.push_str(&text.decode().map_err(|_| "svg_malformed")?);
                }
            }
            Event::CData(data) => {
                if let Some(css) = style.as_mut() {
                    css.push_str(&data.decode().map_err(|_| "svg_malformed")?);
                }
            }
            Event::GeneralRef(_) if style.is_some() => return Err("svg_url_external"),
            Event::End(_) if style.take().is_some_and(|css| external(&css)) => {
                return Err("svg_url_external");
            }
            _ => {}
        }
    }
}

fn sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

impl ResourceStore<'_> {
    fn blob_directory(&self) -> io::Result<PathBuf> {
        crate::workspace::private_path(&self.directory()?, &["blobs"], "blob_directory_invalid")
    }

    pub(crate) fn rotating_directory(&self) -> io::Result<PathBuf> {
        crate::workspace::private_path(&self.directory()?, &["rotating"], "blob_directory_invalid")
    }
}

fn write_new(path: &std::path::Path, bytes: &[u8]) -> io::Result<()> {
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
    {
        Ok(mut file) => file
            .write_all(bytes)
            .and_then(|()| file.sync_all())
            .inspect_err(|_| {
                let _ = fs::remove_file(path);
            }),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if fs::read(path)? == bytes {
                return Ok(());
            }
            static REPAIRS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let serial = REPAIRS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let temporary = path.with_extension(format!("{}.{serial}.tmp", std::process::id()));
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(bytes)
                .and_then(|()| file.sync_all())
                .and_then(|()| fs::rename(&temporary, path))
                .inspect_err(|_| {
                    let _ = fs::remove_file(&temporary);
                })
        }
        Err(error) => Err(error),
    }
}

fn prune_rotating(directory: &std::path::Path, limit: u64) -> io::Result<()> {
    let (mut records, mut bins, mut total) = (Vec::new(), Vec::new(), 0u64);
    for entry in fs::read_dir(directory)?.filter_map(Result::ok) {
        let metadata = entry.metadata()?;
        match entry.path().extension().and_then(|e| e.to_str()) {
            Some("json") => records.push((metadata.modified()?, entry.path())),
            Some("bin") => {
                total += metadata.len();
                bins.push((metadata.modified()?, entry.path(), metadata.len()));
            }
            _ => {}
        }
    }
    if records.len() <= ROTATING_RECORDS && total <= limit {
        return Ok(());
    }
    records.sort();
    let blobs = records
        .iter()
        .map(|(_, path)| {
            fs::read(path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .and_then(|record| record["payload"]["blob"].as_str().map(str::to_owned))
        })
        .collect::<Vec<_>>();
    let mut live = std::collections::BTreeMap::<&str, usize>::new();
    for digest in blobs.iter().flatten() {
        *live.entry(digest).or_default() += 1;
    }
    // Only blobs that records hold count against the limit: evicting records cannot free the rest, which go once settled.
    let mut held = 0u64;
    if let Some((newest, _)) = records.last() {
        let settled = std::time::SystemTime::now() - ORPHAN_GRACE;
        for (modified, path, size) in bins {
            let digest = path.file_stem().and_then(|stem| stem.to_str());
            if digest.is_some_and(|digest| live.contains_key(digest)) {
                held += size;
            } else if modified < *newest && modified < settled {
                let _ = fs::remove_file(&path);
            }
        }
    }
    let by_count = if records.len() > ROTATING_RECORDS {
        records.len() - ROTATING_KEEP
    } else {
        0
    };
    for (index, (_, path)) in records.iter().enumerate().take(records.len() - 1) {
        if index >= by_count && held <= limit {
            break;
        }
        if let Some(digest) = &blobs[index]
            && let Some(users) = live.get_mut(digest.as_str())
        {
            *users -= 1;
            if *users == 0 {
                let blob = directory.join(format!("{digest}.bin"));
                let size = fs::metadata(&blob).map_or(0, |metadata| metadata.len());
                if fs::remove_file(&blob).is_ok() {
                    held = held.saturating_sub(size);
                }
            }
        }
        let _ = fs::remove_file(path);
    }
    Ok(())
}

// A sweep stats every file in the directory, so a process sweeps on its first write to one and then every PRUNE_WRITES writes or 1/16 of the byte limit.
fn prune_due(directory: &std::path::Path, bytes: usize) -> bool {
    static SINCE: std::sync::Mutex<std::collections::BTreeMap<PathBuf, (u32, u64)>> =
        std::sync::Mutex::new(std::collections::BTreeMap::new());
    let mut since = SINCE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (writes, written) = since
        .entry(directory.to_owned())
        .or_insert((PRUNE_WRITES - 1, 0));
    *writes += 1;
    *written += bytes as u64;
    let due = *writes >= PRUNE_WRITES || *written >= BLOB_TOTAL_BYTES / 16;
    if due {
        (*writes, *written) = (0, 0);
    }
    due
}

impl ResourceStore<'_> {
    pub fn put_blob(&self, bytes: &[u8]) -> io::Result<String> {
        if bytes.len() > BLOB_BYTES {
            return Err(io::Error::other("blob_too_large"));
        }
        let digest = hash(bytes);
        let directory = self.blob_directory()?;
        let path = directory.join(format!("{digest}.bin"));
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(directory.join(".blobs.lock"))?;
        lock.lock()?;
        if path.try_exists()? {
            return self.blob(&digest).map(|_| digest);
        }
        let (mut total, mut entries) = (0u64, 0usize);
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            if entry.path().extension().is_some_and(|e| e == "bin") {
                entries += 1;
                total = total.saturating_add(entry.metadata()?.len());
            }
        }
        if entries >= BLOB_ENTRIES || total.saturating_add(bytes.len() as u64) > BLOB_TOTAL_BYTES {
            return Err(io::Error::other("blob_store_quota"));
        }
        let temporary = directory.join(format!(".{digest}.{}", std::process::id()));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        if let Err(error) = file
            .write_all(bytes)
            .and_then(|()| file.sync_all())
            .and_then(|()| fs::rename(&temporary, &path))
        {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        Ok(digest)
    }

    pub fn blob_path(&self, digest: &str) -> io::Result<PathBuf> {
        if !sha(digest) {
            return Err(io::Error::other("blob_reference_invalid"));
        }
        let mut path = self.blob_directory()?.join(format!("{digest}.bin"));
        if !path.try_exists()? {
            path = self.rotating_directory()?.join(format!("{digest}.bin"));
        }
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| io::Error::other("blob_unavailable"))?;
        if !metadata.is_file() || metadata.len() > BLOB_BYTES as u64 {
            return Err(io::Error::other("blob_invalid"));
        }
        Ok(path)
    }

    pub fn blob(&self, digest: &str) -> io::Result<Vec<u8>> {
        let path = self.blob_path(digest)?;
        let mut bytes = Vec::new();
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(path)?
            .take(BLOB_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if hash(&bytes) != digest {
            return Err(io::Error::other("blob_integrity_failed"));
        }
        Ok(bytes)
    }

    pub fn blob_text(&self, payload: &Value) -> io::Result<Option<String>> {
        match payload.get("blob") {
            Some(Value::String(digest)) => Ok(Some(
                String::from_utf8_lossy(&self.blob(digest)?).into_owned(),
            )),
            Some(_) => Err(io::Error::other("blob_reference_invalid")),
            None => Ok(None),
        }
    }

    pub fn evidence_record(&self, arguments: Value) -> io::Result<Value> {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            media_type: String,
            #[serde(default)]
            content: Option<Value>,
            #[serde(default)]
            base64: Option<String>,
            #[serde(default)]
            label: Option<String>,
        }
        let input: Input = serde_json::from_value(arguments)?;
        let invalid = || io::Error::other("evidence_record_invalid");
        if input.label.as_deref().is_some_and(|label| {
            label.is_empty() || label.len() > 128 || label.chars().any(char::is_control)
        }) {
            return Err(invalid());
        }
        match (input.media_type.as_str(), input.content, input.base64) {
            ("application/json", Some(content), None) => Ok(
                json!({"media_type": input.media_type, "label": input.label, "content": content}),
            ),
            ("text/plain", Some(Value::String(text)), None) => {
                Ok(json!({"media_type": input.media_type, "label": input.label, "content": text}))
            }
            (
                media @ ("image/png" | "image/jpeg" | "image/svg+xml" | "application/octet-stream"),
                None,
                Some(encoded),
            ) => {
                let bytes = STANDARD.decode(encoded.as_bytes()).map_err(|_| invalid())?;
                let signature = match media {
                    "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
                    "image/jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
                    "image/svg+xml" => {
                        svg(&bytes).map_err(|reason| {
                            io::Error::other(format!("evidence_record_invalid: {reason}"))
                        })?;
                        true
                    }
                    _ => true,
                };
                if !signature || media.starts_with("image/") && bytes.len() > IMAGE_BYTES {
                    return Err(invalid());
                }
                let blob = self.put_blob(&bytes)?;
                Ok(
                    json!({"media_type": media, "label": input.label, "blob": blob, "bytes": bytes.len()}),
                )
            }
            _ => Err(invalid()),
        }
    }

    pub fn text_evidence(
        &self,
        label: &str,
        text: &str,
    ) -> io::Result<crate::resource_data::ResourceRef> {
        if text.len() > BLOB_BYTES {
            return Err(io::Error::other("blob_too_large"));
        }
        let directory = self.rotating_directory()?;
        let blob = hash(text.as_bytes());
        write_new(&directory.join(format!("{blob}.bin")), text.as_bytes())?;
        let record = self.record(
            "evidence",
            json!({"media_type": "text/plain", "label": label, "blob": blob, "bytes": text.len()}),
        )?;
        let sha256 = hash(&record);
        write_new(&directory.join(format!("{sha256}.json")), &record)?;
        if prune_due(&directory, text.len()) {
            prune_rotating(&directory, BLOB_TOTAL_BYTES)?;
        }
        Ok(crate::resource_data::ResourceRef {
            reference: sha256.clone(),
            sha256,
        })
    }
}

#[cfg(test)]
#[path = "blob_store_tests.rs"]
mod tests;
