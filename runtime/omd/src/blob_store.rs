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
pub const ROTATING_RECORDS: usize = 256;
const ROTATING_KEEP: usize = 192;

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
        private_directory(self.directory()?.join("blobs"))
    }

    pub(crate) fn rotating_directory(&self) -> io::Result<PathBuf> {
        private_directory(self.directory()?.join("rotating"))
    }
}

fn private_directory(path: PathBuf) -> io::Result<PathBuf> {
    crate::resource_data::private_dir(&path, "blob_directory_invalid")?;
    Ok(path)
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
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

fn prune_rotating(directory: &std::path::Path) -> io::Result<()> {
    let mut records = fs::read_dir(directory)?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|e| e == "json"))
        .map(|entry| Ok((entry.metadata()?.modified()?, entry.path())))
        .collect::<io::Result<Vec<_>>>()?;
    if records.len() <= ROTATING_RECORDS {
        return Ok(());
    }
    records.sort();
    let (evicted, kept) = records.split_at(records.len() - ROTATING_KEEP);
    let blob = |path: &std::path::Path| {
        fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|record| record["payload"]["blob"].as_str().map(str::to_owned))
    };
    let live = kept
        .iter()
        .filter_map(|(_, path)| blob(path))
        .collect::<std::collections::BTreeSet<_>>();
    for (_, path) in evicted {
        if let Some(digest) = blob(path).filter(|digest| !live.contains(digest)) {
            let _ = fs::remove_file(directory.join(format!("{digest}.bin")));
        }
        let _ = fs::remove_file(path);
    }
    Ok(())
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
        prune_rotating(&directory)?;
        Ok(crate::resource_data::ResourceRef {
            reference: sha256.clone(),
            sha256,
        })
    }
}

#[cfg(test)]
#[path = "blob_store_tests.rs"]
mod tests;
