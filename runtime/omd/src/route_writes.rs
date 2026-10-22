use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::sync::OnceLock;

const HOST_CONFIG_BYTES: usize = 262_144;
const ROUTE_DATA_BYTES: usize = 2048;

pub type HostCheck = fn(&Path, &Value) -> Result<(), String>;

static HOST_CHECK: OnceLock<HostCheck> = OnceLock::new();

/// The session host validates a whole `host.json` the way it loads one.
pub fn set_host_check(check: HostCheck) {
    let _ = HOST_CHECK.set(check);
}

pub struct RouteWrite {
    caller: String,
    routes: Vec<Value>,
    services: Option<Vec<Value>>,
    changes: Vec<String>,
}

pub fn plan(
    store: &Path,
    repository: &Path,
    caller: &str,
    arguments: &Value,
) -> Result<(RouteWrite, Vec<String>), String> {
    let object = arguments
        .as_object()
        .filter(|object| {
            object
                .keys()
                .all(|key| key == "routes" || key == "services")
        })
        .ok_or("routes_write_arguments_invalid")?;
    let list = |key: &str| -> Result<Option<Vec<Value>>, String> {
        match object.get(key) {
            None => Ok(None),
            Some(Value::Array(items)) if items.iter().all(Value::is_object) => {
                Ok(Some(items.clone()))
            }
            Some(_) => Err(format!("routes_write_{key}_invalid")),
        }
    };
    let mut write = RouteWrite {
        caller: caller.to_owned(),
        routes: list("routes")?.ok_or("routes_write_routes_invalid")?,
        services: list("services")?,
        changes: Vec::new(),
    };
    let host = read(store)?;
    let merged = merged(store, repository, &write, host.clone())?;
    write.changes = changes(store, caller, &host, &merged);
    let changes = write.changes.clone();
    Ok((write, changes))
}

pub fn apply(store: &Path, repository: &Path, write: &RouteWrite) -> Result<Value, String> {
    let _lock =
        crate::mods::store_lock(&store.join("store.lock")).map_err(|error| error.to_string())?;
    let current = read(store)?;
    let merged = merged(store, repository, write, current.clone())?;
    if changes(store, &write.caller, &current, &merged) != write.changes {
        return Err(
            "routes_write_changed: host.json changed after the confirmation; try again".into(),
        );
    }
    crate::broker::write_private(&store.join("host.json"), &merged)
        .map_err(|error| error.to_string())?;
    let names = |key: &str, field: &str, owner: &str| {
        merged[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| item[owner] == write.caller.as_str())
            .map(|item| item[field].clone())
            .collect::<Vec<_>>()
    };
    Ok(json!({"routes": names("routes", "name", "provider"),
        "services": names("services", "id", "mod_id")}))
}

fn read(store: &Path) -> Result<Value, String> {
    match std::fs::read(store.join("host.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({"schema": 1})),
        Err(error) => Err(error.to_string()),
    }
}

fn merged(
    store: &Path,
    repository: &Path,
    write: &RouteWrite,
    mut host: Value,
) -> Result<Value, String> {
    let caller = write.caller.as_str();
    let object = host.as_object_mut().ok_or("host_config_invalid")?;
    let owned_refs = object
        .get("services")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|grant| grant["mod_id"] == caller)
        .flat_map(|grant| {
            grant["secrets"]
                .as_object()
                .cloned()
                .unwrap_or_default()
                .into_values()
        })
        .collect::<Vec<_>>();
    let credentials = crate::credentials::CredentialProfiles::open(store)
        .and_then(|profiles| profiles.list())
        .map_err(|error| error.to_string())?;
    let usable = |id: &str| {
        credentials.iter().any(|profile| {
            profile.id == id
                && (profile.kind != "secret" || profile.owner.as_deref() == Some(caller))
        })
    };
    let allowance = object
        .get("limits")
        .and_then(|limits| limits["exposure_microusd"].as_u64())
        .is_some_and(|limit| limit > 0);
    let billed = |route: &Value| -> Result<(), String> {
        let name = route["name"].as_str().unwrap_or_default();
        if route["provider"] != caller {
            return Err(format!("routes_write_provider_mismatch: {name}"));
        }
        let rates = &route["rates"];
        if rates["included_subscription"] != true && rates["provider_billed"] != true && !allowance
        {
            return Err(format!("routes_write_allowance_required: {name}"));
        }
        if route
            .get("data")
            .is_some_and(|data| data.to_string().len() > ROUTE_DATA_BYTES)
        {
            return Err(format!("routes_write_data_too_large: {name}"));
        }
        Ok(())
    };
    for route in &write.routes {
        let name = route["name"].as_str().unwrap_or_default();
        if route["roles"] != json!(["lead"]) || route.get("grant").is_some() {
            return Err(format!("routes_write_lead_only: {name}"));
        }
        if route.get("credential").is_some() {
            return Err(format!("routes_write_credential_field: {name}"));
        }
        billed(route)?;
    }
    let routes = object
        .entry("routes")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or("host_config_invalid")?;
    routes.retain(|route| route["provider"] != caller || route.get("grant").is_some());
    routes.extend(write.routes.iter().cloned());
    if let Some(services) = &write.services {
        let current = object
            .entry("services")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("host_config_invalid")?;
        let mut next = Vec::new();
        for service in services {
            let id = service["id"]
                .as_str()
                .ok_or("routes_write_service_id_required")?;
            if current
                .iter()
                .any(|grant| grant["id"] == id && grant["mod_id"] != caller)
            {
                return Err(format!("routes_write_service_taken: {id}"));
            }
            let mut grant = current
                .iter()
                .find(|grant| grant["id"] == id)
                .cloned()
                .unwrap_or_else(|| json!({}));
            for (key, value) in service.as_object().into_iter().flatten() {
                grant[key] = value.clone();
            }
            if grant["mod_id"] != caller {
                return Err(format!("routes_write_service_owner_mismatch: {id}"));
            }
            if let Some(route) = grant.get("route") {
                billed(route)?;
            }
            for reference in grant["secrets"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(_, r)| r)
            {
                if !owned_refs.contains(reference) {
                    return Err(format!("routes_write_secret_ref_unknown: {id}"));
                }
            }
            for credential in grant["credentials"].as_array().into_iter().flatten() {
                if !credential.as_str().is_some_and(usable) {
                    return Err(format!("routes_write_credential_unknown: {id}"));
                }
            }
            next.push(grant);
        }
        current.retain(|grant| grant["mod_id"] != caller);
        current.extend(next);
    }
    let bytes = serde_json::to_vec(&host).map_err(|error| error.to_string())?;
    if bytes.len() > HOST_CONFIG_BYTES {
        return Err("routes_write_host_config_too_large".into());
    }
    let check = HOST_CHECK
        .get()
        .ok_or("routes_write_unavailable: the session host is not running")?;
    check(repository, &host).map_err(|error| format!("routes_write_invalid: {error}"))?;
    Ok(host)
}

fn changes(store: &Path, caller: &str, before: &Value, after: &Value) -> Vec<String> {
    let labels = crate::credentials::CredentialProfiles::open(store)
        .and_then(|profiles| profiles.list())
        .unwrap_or_default();
    let label = |id: &Value| {
        let id = id.as_str().unwrap_or_default();
        labels.iter().find(|profile| profile.id == id).map_or_else(
            || id.to_owned(),
            |profile| format!("{} ({})", profile.label, profile.kind),
        )
    };
    let owned = |host: &Value, key: &str, owner: &str, field: &str| {
        host[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| item[owner] == caller)
            .map(|item| {
                (
                    item[field].as_str().unwrap_or_default().to_owned(),
                    item.clone(),
                )
            })
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    let billing = |route: &Value| {
        let rates = &route["rates"];
        if rates["included_subscription"] == true {
            "subscription"
        } else if rates["provider_billed"] == true {
            "provider-billed"
        } else {
            "paid API, per request"
        }
    };
    let text = |value: &Value| {
        value
            .as_str()
            .map_or_else(|| value.to_string(), str::to_owned)
    };
    let shown = |key: &str, value: Option<&Value>| match (key, value) {
        ("route", Some(route)) => format!(
            "{} ({})",
            route["name"].as_str().unwrap_or_default(),
            route["model"].as_str().unwrap_or_default()
        ),
        ("network" | "requests", value) => if value == Some(&json!(true)) {
            "on"
        } else {
            "off"
        }
        .to_owned(),
        (_, Some(Value::Array(items))) => items.iter().map(text).collect::<Vec<_>>().join(" "),
        (_, Some(Value::Object(map))) => map
            .iter()
            .map(|(key, value)| format!("{key}={}", text(value)))
            .collect::<Vec<_>>()
            .join(" "),
        (_, value) => value.map_or_else(|| "none".to_owned(), text),
    };
    let field = |lines: &mut Vec<String>, mut line: String| {
        if line.len() > 400 {
            line.truncate(line.floor_char_boundary(399));
            line.push('…');
        }
        lines.push(line);
    };
    let mut lines = Vec::new();
    let (old, new) = (
        owned(before, "routes", "provider", "name"),
        owned(after, "routes", "provider", "name"),
    );
    for (name, route) in &new {
        let model = route["model"].as_str().unwrap_or_default();
        let previous = match old.get(name) {
            None => {
                lines.push(format!(
                    "Add model route {name}: {model}, {}",
                    billing(route)
                ));
                json!({})
            }
            Some(previous) if previous != route => {
                lines.push(format!(
                    "Change model route {name}: {model}, {}",
                    billing(route)
                ));
                previous.clone()
            }
            Some(_) => continue,
        };
        let keys = route
            .as_object()
            .into_iter()
            .chain(previous.as_object())
            .flat_map(|map| map.keys());
        for key in keys.collect::<std::collections::BTreeSet<_>>() {
            if !matches!(key.as_str(), "name" | "provider" | "roles" | "model")
                && previous.get(key) != route.get(key)
            {
                let value = match (previous.get(key), route.get(key)) {
                    (Some(Value::Object(was)), Some(Value::Object(now))) => Some(Value::Object(
                        now.iter()
                            .filter(|(inner, value)| was.get(*inner) != Some(*value))
                            .map(|(inner, value)| (inner.clone(), value.clone()))
                            .chain(
                                was.keys()
                                    .filter(|inner| !now.contains_key(*inner))
                                    .map(|inner| (inner.clone(), Value::Null)),
                            )
                            .collect(),
                    )),
                    (_, value) => value.cloned(),
                };
                field(
                    &mut lines,
                    format!("Route {name} {key}: {}", shown(key, value.as_ref())),
                );
            }
        }
    }
    for name in old.keys().filter(|name| !new.contains_key(*name)) {
        lines.push(format!("Remove model route {name}"));
    }
    let (old, new) = (
        owned(before, "services", "mod_id", "id"),
        owned(after, "services", "mod_id", "id"),
    );
    let list = |grant: &Value, key: &str| -> Vec<Value> {
        grant[key].as_array().cloned().unwrap_or_default()
    };
    for (id, grant) in &new {
        let previous = old.get(id);
        if previous.is_none() {
            lines.push(format!("Add service {id}"));
        }
        let before = previous.cloned().unwrap_or_else(|| json!({}));
        let (was, now) = (list(&before, "credentials"), list(grant, "credentials"));
        for credential in now.iter().filter(|c| !was.contains(c)) {
            lines.push(format!("Let service {id} use {}", label(credential)));
        }
        for credential in was.iter().filter(|c| !now.contains(c)) {
            lines.push(format!("Stop service {id} using {}", label(credential)));
        }
        for key in [
            "program",
            "program_sha256",
            "arguments",
            "network",
            "read_paths",
            "read_hashes",
            "code_roots",
            "requests",
            "secrets",
            "route",
        ] {
            if before.get(key) != grant.get(key) {
                field(
                    &mut lines,
                    format!("Service {id} {key}: {}", shown(key, grant.get(key))),
                );
            }
        }
    }
    for id in old.keys().filter(|id| !new.contains_key(*id)) {
        lines.push(format!("Remove service {id}"));
    }
    lines
}

#[cfg(test)]
#[path = "route_writes_tests.rs"]
mod tests;
