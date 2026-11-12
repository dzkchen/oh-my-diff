use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Mutex;

const TEXT_BYTES: usize = 256;
const NAME_BYTES: usize = 128;
const MODELS: usize = 64;
const WINDOWS: usize = 4;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Window {
    label: String,
    used_percent: f64,
    #[serde(default)]
    window_minutes: Option<u64>,
    #[serde(default)]
    resets_at: Option<u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Status {
    route: String,
    installed: bool,
    signed_in: bool,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    models: Option<Vec<String>>,
    #[serde(default)]
    usage: Option<Vec<Window>>,
    #[serde(default)]
    detail: Option<String>,
}

static PUBLISHED: Mutex<BTreeMap<String, (String, Value)>> = Mutex::new(BTreeMap::new());

fn invalid(status: &Status) -> bool {
    let long = |text: &str, max: usize| text.is_empty() || text.len() > max;
    status.version.as_deref().is_some_and(|v| long(v, NAME_BYTES))
        || status.detail.as_deref().is_some_and(|d| long(d, TEXT_BYTES))
        || status.models.as_ref().is_some_and(|models| {
            models.len() > MODELS || models.iter().any(|m| long(m, NAME_BYTES))
        })
        || status.usage.as_ref().is_some_and(|usage| {
            usage.len() > WINDOWS
                || usage.iter().any(|w| {
                    long(&w.label, NAME_BYTES) || !(0.0..=100.0).contains(&w.used_percent)
                })
        })
}

pub(super) fn publish(
    config: &crate::config::HostConfig,
    mod_id: &str,
    arguments: Value,
) -> Result<Value, String> {
    let status: Status =
        serde_json::from_value(arguments).map_err(|_| "route_status_invalid".to_string())?;
    if invalid(&status) {
        return Err("route_status_invalid".into());
    }
    let route = config
        .routes
        .iter()
        .find(|route| route.name == status.route)
        .ok_or_else(|| format!("route_not_configured: {}", status.route))?;
    if !config
        .services
        .iter()
        .any(|grant| grant.provides(mod_id, &route.provider))
    {
        return Err(format!("route_status_not_provider: {}", status.route));
    }
    let checked_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    let mut value = serde_json::to_value(&status).map_err(|error| error.to_string())?;
    value["checked_at"] = json!(checked_at);
    if let Some(object) = value.as_object_mut() {
        object.remove("route");
    }
    let mut published = PUBLISHED.lock().map_err(|_| "route_status_poisoned")?;
    published.retain(|name, _| config.routes.iter().any(|route| &route.name == name));
    published.insert(status.route.clone(), (route.provider.clone(), value));
    Ok(json!({"route": status.route, "checked_at": checked_at}))
}

pub(super) fn latest(route: &crate::config::Route) -> Value {
    PUBLISHED
        .lock()
        .ok()
        .and_then(|published| {
            published
                .get(&route.name)
                .filter(|(provider, _)| provider == &route.provider)
                .map(|(_, value)| value.clone())
        })
        .unwrap_or(Value::Null)
}

#[cfg(test)]
#[path = "route_status_tests.rs"]
mod tests;
