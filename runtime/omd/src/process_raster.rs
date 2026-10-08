use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

pub type Sink = Arc<dyn Fn(Value) -> bool + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Raster,
    Keys,
}

type Bound = BTreeMap<String, (String, Role, Sink, u64)>;

static BOUND: Mutex<Bound> = Mutex::new(BTreeMap::new());
static SERIAL: AtomicU64 = AtomicU64::new(0);

fn bound() -> std::sync::MutexGuard<'static, Bound> {
    BOUND.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A managed process bound to its owner's raster (and optional keys component); dropping it unbinds them.
pub struct Binding {
    components: Vec<String>,
    sink: Sink,
}

pub fn bind(owner: &str, components: Vec<(String, Role)>, sink: Sink) -> Binding {
    let mut table = bound();
    let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
    for (component, role) in &components {
        table.insert(
            component.clone(),
            (owner.to_owned(), *role, sink.clone(), serial),
        );
    }
    drop(table);
    crate::client_surface::redraw();
    Binding {
        components: components
            .into_iter()
            .map(|(component, _)| component)
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

/// The role `component` is bound in when `owner` owns the binding.
pub fn role(owner: &str, component: &str) -> Option<Role> {
    bound()
        .get(component)
        .filter(|(bound, _, _, _)| bound == owner)
        .map(|(_, role, _, _)| *role)
}

/// Identifies the process bound to `owner`'s `component`; a restarted process has a new one.
pub fn serial(owner: &str, component: &str) -> Option<u64> {
    bound()
        .get(component)
        .filter(|(bound, _, _, _)| bound == owner)
        .map(|(_, _, _, serial)| *serial)
}

/// The keys component bound to the same process as `owner`'s raster `component`.
pub fn keys(owner: &str, component: &str) -> Option<String> {
    let table = bound();
    let (_, role, _, serial) = table
        .get(component)
        .filter(|(bound, _, _, _)| bound == owner)?;
    (*role == Role::Raster).then_some(())?;
    table
        .iter()
        .find(|(_, (_, role, _, other))| *role == Role::Keys && other == serial)
        .map(|(keys, _)| keys.clone())
}

/// Writes `message` to the process bound to `owner`'s `component`; false when none is bound or it stopped.
pub fn send(owner: &str, component: &str, message: Value) -> bool {
    let sink = bound()
        .get(component)
        .filter(|(bound, _, _, _)| bound == owner)
        .map(|(_, _, sink, _)| sink.clone());
    sink.is_some_and(|sink| sink(message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
            "owner",
            vec![
                ("pr-frame".into(), Role::Raster),
                ("pr-keys".into(), Role::Keys),
            ],
            sink,
        );
        assert_eq!(role("owner", "pr-keys"), Some(Role::Keys));
        assert_eq!(role("other", "pr-frame"), None);
        assert!(!send("other", "pr-frame", json!(1)));
        assert!(send("owner", "pr-frame", json!(2)));
        drop(binding);
        assert!(!send("owner", "pr-frame", json!(3)));
        assert_eq!(*seen.lock().unwrap(), vec![json!(2)]);
    }
}
