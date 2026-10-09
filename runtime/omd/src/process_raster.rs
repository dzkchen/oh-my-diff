use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
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

fn bound() -> std::sync::MutexGuard<'static, Bound> {
    BOUND.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A managed process bound to its thread's owned components; dropping it unbinds them.
pub struct Binding {
    components: Vec<Key>,
    sink: Sink,
}

pub fn bind(
    thread: Option<&str>,
    owner: &str,
    components: Vec<(String, Role)>,
    sink: Sink,
) -> Binding {
    let mut table = bound();
    let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
    for (component, role) in &components {
        table.insert(
            key(thread, owner, component),
            (owner.to_owned(), *role, sink.clone(), serial),
        );
    }
    drop(table);
    crate::client_surface::redraw();
    Binding {
        components: components
            .into_iter()
            .map(|(component, _)| key(thread, owner, &component))
            .collect(),
        sink,
    }
}

impl Drop for Binding {
    fn drop(&mut self) {
        let mut table = bound();
        for component in &self.components {
            if table
                .get(component)
                .is_some_and(|(_, _, sink, _)| Arc::ptr_eq(sink, &self.sink))
            {
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
