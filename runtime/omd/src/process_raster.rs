use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::File;
use std::os::unix::fs::FileExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

/// Accepts bounded input without blocking the UI thread.
pub type Sink = Arc<dyn Fn(Value) -> bool + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Raster,
    Keys,
}

type Key = (Option<String>, String, String);
type Bound = BTreeMap<Key, (String, Role, Sink, u64)>;

static BOUND: Mutex<Bound> = Mutex::new(BTreeMap::new());
static SERIAL: AtomicU64 = AtomicU64::new(0);
static PIXELS: Mutex<BTreeMap<String, Arc<Mutex<PixelBuffer>>>> = Mutex::new(BTreeMap::new());

struct PixelBuffer {
    key: Key,
    serial: u64,
    file: File,
    sequence: u64,
    generation: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PixelSource {
    pub source: String,
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub sequence: u64,
}

#[derive(Debug)]
pub struct PixelFrame {
    pub source: PixelSource,
    pub id: String,
    pub image: image::DynamicImage,
    png: OnceLock<Option<Arc<[u8]>>>,
    jpeg: OnceLock<Option<Arc<[u8]>>>,
}

impl PixelFrame {
    pub fn new(source: PixelSource, image: image::DynamicImage) -> Self {
        Self {
            id: format!("{}:{}", source.source, source.sequence),
            source,
            image,
            png: OnceLock::new(),
            jpeg: OnceLock::new(),
        }
    }

    pub fn encoded(&self, jpeg: bool) -> Option<Arc<[u8]>> {
        let cache = if jpeg { &self.jpeg } else { &self.png };
        cache.get_or_init(|| self.encode(jpeg)).clone()
    }

    fn encode(&self, jpeg: bool) -> Option<Arc<[u8]>> {
        let mut encoded = std::io::Cursor::new(Vec::new());
        if jpeg {
            image::DynamicImage::ImageRgb8(self.image.to_rgb8())
                .write_to(&mut encoded, image::ImageFormat::Jpeg)
                .ok()?;
        } else {
            self.image
                .write_to(&mut encoded, image::ImageFormat::Png)
                .ok()?;
        }
        Some(encoded.into_inner().into())
    }
}

impl PixelSource {
    pub fn byte_len(&self) -> Result<usize, String> {
        let channels = match self.format.as_str() {
            "rgb" => 3,
            "rgba" => 4,
            _ => return Err("terminal_blit_pixels_invalid".into()),
        };
        if !(1..=crate::client_surface::IMAGE_PIXELS).contains(&self.width)
            || !(1..=crate::client_surface::IMAGE_PIXELS).contains(&self.height)
            || self.sequence == 0
        {
            return Err("terminal_blit_pixels_invalid".into());
        }
        Ok(self.width as usize * self.height as usize * channels)
    }
}

pub fn snapshot(
    thread: Option<&str>,
    owner: &str,
    component: &str,
    source: PixelSource,
) -> Result<Arc<PixelFrame>, String> {
    let _stage = crate::frame_metrics::stage("raw_snapshot");
    let key = key(thread, owner, component);
    let (sink, serial, buffer) = {
        let table = bound();
        let (_, role, sink, serial) = table.get(&key).ok_or("terminal_blit_source_unavailable")?;
        if *role != Role::Raster {
            return Err("terminal_blit_source_not_owned".into());
        }
        let buffer = PIXELS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&source.source)
            .cloned()
            .ok_or("terminal_blit_source_not_owned")?;
        (sink.clone(), *serial, buffer)
    };
    let mut buffer = buffer.lock().unwrap_or_else(PoisonError::into_inner);
    if !(buffer.key == key
        && buffer.serial == serial
        && buffer.generation == crate::client_surface::current_generation())
    {
        return Err("terminal_blit_source_not_owned".into());
    }
    let result = (|| {
        let length = source.byte_len()?;
        if source.sequence <= buffer.sequence {
            return Err("terminal_blit_sequence_stale".into());
        }
        if buffer
            .file
            .metadata()
            .map_err(|_| "terminal_blit_pixels_io".to_owned())?
            .len()
            != length as u64
        {
            return Err("terminal_blit_pixels_length".to_owned());
        }
        let mut bytes = vec![0; length];
        buffer
            .file
            .read_exact_at(&mut bytes, 0)
            .map_err(|_| "terminal_blit_pixels_io".to_owned())?;
        let image = if source.format == "rgb" {
            image::DynamicImage::ImageRgb8(
                image::RgbImage::from_raw(source.width, source.height, bytes)
                    .ok_or("terminal_blit_pixels_invalid")?,
            )
        } else {
            image::DynamicImage::ImageRgba8(
                image::RgbaImage::from_raw(source.width, source.height, bytes)
                    .ok_or("terminal_blit_pixels_invalid")?,
            )
        };
        if !bound()
            .get(&key)
            .is_some_and(|(_, _, current, current_serial)| {
                *current_serial == serial && Arc::ptr_eq(current, &sink)
            })
        {
            return Err("terminal_blit_source_unavailable".into());
        }
        buffer.sequence = source.sequence;
        Ok(Arc::new(PixelFrame::new(source.clone(), image)))
    })();
    drop(buffer);
    sink(
        serde_json::json!({"pixels": {"source": source.source, "sequence": source.sequence,
        "ready": result.is_ok(), "error": result.as_ref().err()}}),
    );
    result
}

fn bound() -> std::sync::MutexGuard<'static, Bound> {
    BOUND.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A managed process bound to its thread's owned components; dropping it unbinds them.
pub struct Binding {
    components: Vec<(Key, Role)>,
    sink: Sink,
    pixels: Option<String>,
    serial: u64,
}

impl Binding {
    pub fn prepare(
        thread: Option<&str>,
        owner: &str,
        components: Vec<(String, Role)>,
        sink: Sink,
    ) -> Self {
        Self {
            components: components
                .into_iter()
                .map(|(component, role)| (key(thread, owner, &component), role))
                .collect(),
            sink,
            pixels: None,
            serial: SERIAL.fetch_add(1, Ordering::Relaxed),
        }
    }

    pub fn publish(&self) {
        let mut table = bound();
        for (key, role) in &self.components {
            table.insert(
                key.clone(),
                (key.1.clone(), *role, self.sink.clone(), self.serial),
            );
        }
        drop(table);
        crate::client_surface::redraw();
    }

    pub fn pixels(&mut self, path: &Path, generation: Option<u64>) -> Result<Value, String> {
        if self.pixels.is_some() {
            return Err("terminal_blit_source_exists".into());
        }
        let key = self
            .components
            .iter()
            .find(|(_, role)| *role == Role::Raster)
            .map(|(key, _)| key.clone())
            .ok_or("terminal_blit_source_unavailable")?;
        let serial = self.serial;
        let file = File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|_| "terminal_blit_pixels_io".to_owned())?;
        let source = format!("pixels-{}-{serial}", std::process::id());
        PIXELS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                source.clone(),
                Arc::new(Mutex::new(PixelBuffer {
                    key,
                    serial,
                    file,
                    sequence: 0,
                    generation,
                })),
            );
        self.pixels = Some(source.clone());
        Ok(serde_json::json!({"pixels": {"source": source, "path": path}}))
    }
}

pub fn bind(
    thread: Option<&str>,
    owner: &str,
    components: Vec<(String, Role)>,
    sink: Sink,
) -> Binding {
    let binding = Binding::prepare(thread, owner, components, sink);
    binding.publish();
    binding
}

impl Drop for Binding {
    fn drop(&mut self) {
        let mut table = bound();
        if let Some(source) = &self.pixels {
            PIXELS
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(source);
        }
        for (component, _) in &self.components {
            if table.get(component).is_some_and(|(_, _, sink, serial)| {
                *serial == self.serial && Arc::ptr_eq(sink, &self.sink)
            }) {
                table.remove(component);
            }
        }
    }
}

/// Whether any process is bound, so the terminal keeps routing input even when no mod handles components.
pub fn any() -> bool {
    !bound().is_empty()
}

fn key(thread: Option<&str>, owner: &str, component: &str) -> Key {
    (
        thread.map(str::to_owned),
        owner.to_owned(),
        component.to_owned(),
    )
}

/// The role `component` is bound in when `owner` owns the binding in `thread`.
pub fn role(thread: Option<&str>, owner: &str, component: &str) -> Option<Role> {
    bound()
        .get(&key(thread, owner, component))
        .filter(|(bound, _, _, _)| bound == owner)
        .map(|(_, role, _, _)| *role)
}

pub fn target(thread: Option<&str>, owner: &str, component: &str) -> Option<(Role, u64, Sink)> {
    bound()
        .get(&key(thread, owner, component))
        .map(|(_, role, sink, serial)| (*role, *serial, sink.clone()))
}

/// Identifies the process bound to `owner`'s `component`; a restarted process has a new one.
pub fn serial(thread: Option<&str>, owner: &str, component: &str) -> Option<u64> {
    bound()
        .get(&key(thread, owner, component))
        .filter(|(bound, _, _, _)| bound == owner)
        .map(|(_, _, _, serial)| *serial)
}

/// The keys component bound to the same process as `owner`'s raster `component`.
pub fn keys(thread: Option<&str>, owner: &str, component: &str) -> Option<String> {
    let table = bound();
    let (_, role, _, serial) = table
        .get(&key(thread, owner, component))
        .filter(|(bound, _, _, _)| bound == owner)?;
    (*role == Role::Raster).then_some(())?;
    table
        .iter()
        .find(|(_, (_, role, _, other))| *role == Role::Keys && other == serial)
        .map(|(keys, _)| keys.2.clone())
}

/// Writes `message` to the process bound to `owner`'s `component`; false when none is bound or it stopped.
pub fn send(thread: Option<&str>, owner: &str, component: &str, message: Value) -> bool {
    let sink = bound()
        .get(&key(thread, owner, component))
        .filter(|(bound, _, _, _)| bound == owner)
        .map(|(_, _, sink, _)| sink.clone());
    sink.is_some_and(|sink| sink(message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn raw_binding_initializes_before_input_can_find_it() {
        let directory = tempfile::tempdir().unwrap();
        let messages = Arc::new(Mutex::new(Vec::new()));
        let received = messages.clone();
        let sink: Sink = Arc::new(move |message| {
            received.lock().unwrap().push(message);
            true
        });
        let mut binding = Binding::prepare(
            Some("init-thread"),
            "init-owner",
            vec![("init-frame".into(), Role::Raster)],
            sink.clone(),
        );
        assert!(!send(
            Some("init-thread"),
            "init-owner",
            "init-frame",
            json!({"box": {}})
        ));
        let message = binding
            .pixels(&directory.path().join("pixels"), None)
            .unwrap();
        assert!(sink(message));
        binding.publish();
        assert!(send(
            Some("init-thread"),
            "init-owner",
            "init-frame",
            json!({"box": {}})
        ));
        let messages = messages.lock().unwrap();
        assert!(messages[0]["pixels"]["path"].is_string());
        assert!(messages[1]["box"].is_object());
    }

    #[test]
    fn raw_frame_encoding_is_shared_per_format() {
        let frame = PixelFrame::new(
            PixelSource {
                source: "cache".into(),
                format: "rgb".into(),
                width: 1,
                height: 1,
                sequence: 1,
            },
            image::DynamicImage::new_rgb8(1, 1),
        );
        for jpeg in [false, true] {
            let first = frame.encoded(jpeg).unwrap();
            let second = frame.encoded(jpeg).unwrap();
            assert!(Arc::ptr_eq(&first, &second));
            assert_eq!(
                image::guess_format(&first).unwrap(),
                if jpeg {
                    image::ImageFormat::Jpeg
                } else {
                    image::ImageFormat::Png
                }
            );
            assert_eq!(image::load_from_memory(&first).unwrap().width(), 1);
        }
    }

    #[test]
    fn raw_buffer_wait_does_not_lock_other_bindings_and_rechecks_revocation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pixels");
        let mut binding = bind(
            Some("copy-thread"),
            "copy-owner",
            vec![("copy-frame".into(), Role::Raster)],
            Arc::new(|_| true),
        );
        let initialized = binding.pixels(&path, None).unwrap();
        std::fs::write(&path, [1, 2, 3]).unwrap();
        let source = PixelSource {
            source: initialized["pixels"]["source"].as_str().unwrap().into(),
            format: "rgb".into(),
            width: 1,
            height: 1,
            sequence: 1,
        };
        let buffer = PIXELS.lock().unwrap().get(&source.source).unwrap().clone();
        let held = buffer.lock().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            sender.send(()).unwrap();
            snapshot(Some("copy-thread"), "copy-owner", "copy-frame", source)
        });
        receiver.recv().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while Arc::strong_count(&buffer) < 3 && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(Arc::strong_count(&buffer), 3);
        let unlocked = || BOUND.try_lock().is_ok() && PIXELS.try_lock().is_ok();
        let available = loop {
            if unlocked() {
                break true;
            }
            if std::time::Instant::now() >= deadline {
                break false;
            }
            std::thread::yield_now();
        };
        assert!(available);
        let mut other = bind(
            Some("other-copy"),
            "other-owner",
            vec![("frame".into(), Role::Raster)],
            Arc::new(|_| true),
        );
        assert!(target(Some("other-copy"), "other-owner", "frame").is_some());
        let other_path = directory.path().join("other-pixels");
        let initialized = other.pixels(&other_path, None).unwrap();
        std::fs::write(&other_path, [4, 5, 6]).unwrap();
        let other_frame = snapshot(
            Some("other-copy"),
            "other-owner",
            "frame",
            PixelSource {
                source: initialized["pixels"]["source"].as_str().unwrap().into(),
                format: "rgb".into(),
                width: 1,
                height: 1,
                sequence: 1,
            },
        )
        .unwrap();
        assert_eq!(other_frame.image.as_bytes(), &[4, 5, 6]);
        drop(binding);
        drop(held);
        assert!(worker.join().unwrap().is_err());
        drop(other);
    }

    #[test]
    fn raw_frames_are_owned_immutable_and_revoked_with_the_binding() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pixels");
        let replies = Arc::new(Mutex::new(Vec::new()));
        let received = replies.clone();
        let mut binding = bind(
            Some("pixels-thread"),
            "pixels-owner",
            vec![("pixels-frame".into(), Role::Raster)],
            Arc::new(move |value| {
                received.lock().unwrap().push(value);
                true
            }),
        );
        let initialized = binding.pixels(&path, None).unwrap();
        let mut source = PixelSource {
            source: initialized["pixels"]["source"].as_str().unwrap().to_owned(),
            format: "rgb".into(),
            width: 1,
            height: 1,
            sequence: 1,
        };
        std::fs::write(&path, [1, 2, 3]).unwrap();
        assert!(
            snapshot(
                Some("foreign-thread"),
                "pixels-owner",
                "pixels-frame",
                source.clone()
            )
            .is_err()
        );
        assert!(
            snapshot(
                Some("pixels-thread"),
                "foreign-owner",
                "pixels-frame",
                source.clone()
            )
            .is_err()
        );
        assert!(replies.lock().unwrap().is_empty());
        assert!(
            crate::client_surface::with_admission("source", 99, None, || snapshot(
                Some("pixels-thread"),
                "pixels-owner",
                "pixels-frame",
                source.clone()
            ))
            .is_err()
        );
        assert!(replies.lock().unwrap().is_empty());
        let frame = snapshot(
            Some("pixels-thread"),
            "pixels-owner",
            "pixels-frame",
            source.clone(),
        )
        .unwrap();
        assert_eq!(frame.image.as_bytes(), &[1, 2, 3]);
        std::fs::write(&path, [4, 5, 6]).unwrap();
        assert_eq!(frame.image.as_bytes(), &[1, 2, 3]);
        assert_eq!(replies.lock().unwrap()[0]["pixels"]["ready"], true);
        assert!(
            snapshot(
                Some("pixels-thread"),
                "pixels-owner",
                "pixels-frame",
                source.clone()
            )
            .is_err()
        );
        assert_eq!(
            replies.lock().unwrap().last().unwrap()["pixels"]["error"],
            "terminal_blit_sequence_stale"
        );
        assert!(
            snapshot(
                Some("pixels-thread"),
                "pixels-owner",
                "pixels-frame",
                PixelSource {
                    height: 0,
                    ..source.clone()
                }
            )
            .is_err()
        );
        assert_eq!(
            replies.lock().unwrap().last().unwrap()["pixels"]["error"],
            "terminal_blit_pixels_invalid"
        );
        source.sequence = 2;
        let renamed = directory.path().join("original");
        std::fs::rename(&path, &renamed).unwrap();
        std::os::unix::fs::symlink("/dev/zero", &path).unwrap();
        assert_eq!(
            snapshot(
                Some("pixels-thread"),
                "pixels-owner",
                "pixels-frame",
                source.clone()
            )
            .unwrap()
            .image
            .as_bytes(),
            &[4, 5, 6]
        );
        source.sequence = 3;
        source.format = "rgba".into();
        assert!(
            snapshot(
                Some("pixels-thread"),
                "pixels-owner",
                "pixels-frame",
                source.clone()
            )
            .is_err()
        );
        assert_eq!(
            replies.lock().unwrap().last().unwrap()["pixels"]["ready"],
            false
        );
        std::fs::write(&renamed, [7, 8, 9, 10]).unwrap();
        assert_eq!(
            snapshot(
                Some("pixels-thread"),
                "pixels-owner",
                "pixels-frame",
                source.clone()
            )
            .unwrap()
            .image
            .as_bytes(),
            &[7, 8, 9, 10]
        );
        assert!(
            PixelSource {
                width: 4097,
                ..source.clone()
            }
            .byte_len()
            .is_err()
        );
        assert!(
            PixelSource {
                height: 0,
                ..source.clone()
            }
            .byte_len()
            .is_err()
        );
        drop(binding);
        source.sequence = 5;
        assert!(
            snapshot(
                Some("pixels-thread"),
                "pixels-owner",
                "pixels-frame",
                source
            )
            .is_err()
        );
    }

    #[test]
    fn bindings_isolate_identical_components_across_threads() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let make = |thread: &'static str| {
            let seen = seen.clone();
            bind(
                Some(thread),
                "same-owner",
                vec![
                    ("same-frame".into(), Role::Raster),
                    ("same-keys".into(), Role::Keys),
                ],
                Arc::new(move |value| {
                    seen.lock().unwrap().push((thread, value));
                    true
                }),
            )
        };
        let first = make("first");
        let second = make("second");
        assert_ne!(
            serial(Some("first"), "same-owner", "same-frame"),
            serial(Some("second"), "same-owner", "same-frame")
        );
        assert_eq!(
            keys(Some("first"), "same-owner", "same-frame"),
            Some("same-keys".into())
        );
        assert!(send(Some("first"), "same-owner", "same-frame", json!(1)));
        assert!(send(Some("second"), "same-owner", "same-keys", json!(2)));
        assert!(!send(None, "same-owner", "same-keys", json!(3)));
        drop(first);
        assert_eq!(role(Some("first"), "same-owner", "same-frame"), None);
        assert!(send(Some("second"), "same-owner", "same-frame", json!(4)));
        drop(second);
        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                ("first", json!(1)),
                ("second", json!(2)),
                ("second", json!(4))
            ]
        );
    }

    #[test]
    fn bindings_route_only_their_owner_and_unbind_on_drop() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink: Sink = {
            let seen = seen.clone();
            Arc::new(move |message| {
                seen.lock().unwrap().push(message);
                true
            })
        };
        let binding = bind(
            None,
            "owner",
            vec![
                ("pr-frame".into(), Role::Raster),
                ("pr-keys".into(), Role::Keys),
            ],
            sink,
        );
        assert_eq!(role(None, "owner", "pr-keys"), Some(Role::Keys));
        assert_eq!(role(None, "other", "pr-frame"), None);
        assert!(!send(None, "other", "pr-frame", json!(1)));
        assert!(send(None, "owner", "pr-frame", json!(2)));
        drop(binding);
        assert!(!send(None, "owner", "pr-frame", json!(3)));
        assert_eq!(*seen.lock().unwrap(), vec![json!(2)]);
    }
}
