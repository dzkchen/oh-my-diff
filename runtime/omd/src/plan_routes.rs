//! Worker routes on the user's ChatGPT plan, added from a confirmed client request.

use serde_json::Value;
use serde_json::json;
use std::io;
use std::path::Path;

pub const SUBSCRIPTION_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
// `host.json` and grant limits the extension enforces when it loads them.
const ROUTES: usize = 32;
const GRANT_BYTES: usize = 16_384;

pub struct PlanRoute {
    pub model: String,
    pub reasoning_effort: String,
    pub context_window: u64,
    pub mod_id: String,
}

/// One route per model and mod, so approving a mod never opens the route to another mod.
pub fn route_name(model: &str, mod_id: &str) -> String {
    let room = 64usize.saturating_sub("plan--".len() + mod_id.len());
    let slug: String = model
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(room)
        .collect();
    format!("plan-{slug}-{mod_id}")
}

/// Lets `plan.mod_id` run workers on its plan route, adding `repository` to the grant's list of approved repositories.
pub fn add(store: &Path, repository: &Path, plan: &PlanRoute) -> io::Result<String> {
    let name = route_name(&plan.model, &plan.mod_id);
    if name.starts_with("plan--") {
        return Err(io::Error::other("plan_route_name_invalid"));
    }
    let _lock = crate::mods::store_lock(&store.join("store.lock")).map_err(io::Error::other)?;
    let directory = store.join("routes").join("plan");
    std::fs::create_dir_all(&directory)?;
    let grant_path = directory.join(format!("{name}.json"));
    let identity = crate::resource_data::hash(repository.as_os_str().as_encoded_bytes());
    let mut grant = read(&grant_path)?.unwrap_or_else(|| {
        json!({"schema": 1, "included_subscription": true, "revocable": true, "provider": "openai",
            "model": plan.model, "responses_url": SUBSCRIPTION_RESPONSES_URL, "repositories": []})
    });
    if grant["model"] != plan.model.as_str() {
        return Err(io::Error::other("plan_route_name_taken"));
    }
    let repositories = grant["repositories"]
        .as_array_mut()
        .ok_or_else(|| io::Error::other("plan_route_grant_invalid"))?;
    if !repositories.contains(&json!(identity)) {
        repositories.push(json!(identity));
    }
    let bytes = serde_json::to_vec(&grant)?;
    if bytes.len() > GRANT_BYTES {
        return Err(io::Error::other("plan_route_grant_full"));
    }
    let host_path = store.join("host.json");
    let mut host = read(&host_path)?.unwrap_or_else(|| json!({"schema": 1}));
    let routes = host
        .as_object_mut()
        .ok_or_else(|| io::Error::other("host_config_invalid"))?
        .entry("routes")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| io::Error::other("host_config_invalid"))?;
    match routes
        .iter()
        .position(|route| route["name"] == name.as_str())
    {
        Some(index) if routes[index]["grant"]["path"] != grant_path.to_string_lossy().as_ref() => {
            return Err(io::Error::other("plan_route_name_taken"));
        }
        Some(index) => {
            routes.remove(index);
        }
        None if routes.len() >= ROUTES => return Err(io::Error::other("host_routes_full")),
        None => {}
    }
    crate::fsio::write_json(&grant_path, &grant)?;
    let sha256 = crate::resource_data::hash(&bytes);
    routes.push(json!({"name": name, "provider": "openai", "model": plan.model,
        "reasoning_effort": plan.reasoning_effort, "responses_url": SUBSCRIPTION_RESPONSES_URL,
        "roles": ["worker"], "mods": [plan.mod_id], "grant": {"path": grant_path, "sha256": sha256},
        "rates": {"input_microusd_per_million": 0, "cached_microusd_per_million": 0,
            "output_microusd_per_million": 0, "reservation_microusd": 0,
            "max_output_tokens": plan.context_window.min(128_000), "input_token_ceiling": plan.context_window,
            "included_subscription": true}}));
    crate::fsio::write_json(&host_path, &host)?;
    Ok(name)
}

fn read(path: &Path) -> io::Result<Option<Value>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
#[path = "plan_routes_tests.rs"]
mod tests;
