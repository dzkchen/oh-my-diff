use crate::{ModInstallRequest, ModPackageSource, ModPackageTrust, ModStore};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

#[derive(Clone, Debug, PartialEq)]
pub struct PackageControl {
    pub action: String,
    pub id: String,
    request: Option<ModInstallRequest>,
    confirmation: Option<String>,
    selection: Option<Selection>,
    generation: u64,
}

#[derive(Clone, Debug, PartialEq)]
struct Selection {
    path: PathBuf,
    scope: String,
    sha256: String,
    capabilities: Vec<String>,
    enabled: bool,
    secret_environment: Vec<String>,
    exec_environment: Value,
}

pub struct PackagePreview {
    pub public: Value,
    pub control: PackageControl,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    action: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    source: Option<ModPackageSource>,
    #[serde(default)]
    reference: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    index: Option<PathBuf>,
    #[serde(default = "user")]
    scope: String,
    #[serde(default)]
    expected_generation: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexArguments {
    #[serde(default)]
    index: Option<PathBuf>,
    #[serde(default)]
    query: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

pub fn index(store: &ModStore, arguments: Value) -> io::Result<Value> {
    let arguments: IndexArguments = serde_json::from_value(arguments)
        .map_err(|error| failure(format!("package_arguments_invalid: {error}")))?;
    let path = arguments
        .index
        .or_else(|| store.package_index())
        .ok_or_else(|| {
            failure("package_index_unavailable: install from npm:, git+ or a folder instead")
        })?;
    let start = arguments
        .cursor
        .map(|cursor| cursor.parse::<usize>())
        .transpose()
        .map_err(|_| failure("package_arguments_invalid: cursor"))?
        .unwrap_or(0);
    let limit = arguments.limit.unwrap_or(200);
    if !(1..=200).contains(&limit) {
        return Err(failure("package_arguments_invalid: limit must be 1-200"));
    }
    store.package_index_entries(&path, &arguments.query, start, limit)
}

fn user() -> String {
    "user".into()
}

fn failure(message: impl Into<String>) -> io::Error {
    io::Error::other(message.into())
}

fn generation(store: &ModStore) -> io::Result<u64> {
    Ok(store.configuration()?.revision)
}

fn source_kind(source: &ModPackageSource) -> &'static str {
    match source {
        ModPackageSource::Local { .. } => "local",
        ModPackageSource::Repository { .. } => "repository",
        ModPackageSource::Package { .. } => "package",
        ModPackageSource::Npm { .. } => "npm",
    }
}

struct Selections {
    lock: crate::ModPackageLock,
    configuration: crate::ModConfiguration,
    status: Value,
    manifests: Vec<Value>,
    listing: Option<Mutex<Option<(Value, Value)>>>,
}

type Listed = (Value, Vec<(PathBuf, crate::FileStamp)>, Arc<Selections>);

static LISTED: Mutex<Option<Listed>> = Mutex::new(None);

const LISTING_RUNTIME_FIELDS: [&str; 7] = [
    "id",
    "scope",
    "sha256",
    "error",
    "version",
    "api",
    "capabilities",
];

/// The store side of a listing, reused while the store files and every package file are unchanged.
fn selections(store: &ModStore) -> io::Result<Arc<Selections>> {
    let key = store.listing_stamp();
    let listed = LISTED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    if let (Some(key), Some((cached, stamps, selections))) = (&key, listed)
        && key == &cached
        && ModStore::stamps_unchanged(&stamps)
    {
        return Ok(selections);
    }
    let lock = store.package_lock()?;
    let configuration = store.configuration()?;
    let stamps = key.as_ref().and_then(|_| {
        ModStore::package_stamps(
            configuration
                .mods
                .iter()
                .map(|selection| selection.path.as_path()),
        )
    });
    let mut manifests = Vec::new();
    let status =
        store.selection_status_inspected_in(None, &configuration, &lock, Some(&mut manifests))?;
    let selections = Arc::new(Selections {
        lock,
        configuration,
        status,
        manifests,
        listing: stamps.as_ref().map(|_| Mutex::default()),
    });
    if let (Some(key), Some(stamps)) = (key, stamps) {
        *LISTED.lock().unwrap_or_else(PoisonError::into_inner) =
            Some((key, stamps, selections.clone()));
    }
    Ok(selections)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArguments {
    fields: Vec<String>,
}

pub fn list_fields(
    store: &ModStore,
    runtime: Option<&Value>,
    arguments: Value,
) -> io::Result<Value> {
    let fields = match arguments {
        Value::Null => None,
        arguments => Some(
            serde_json::from_value::<ListArguments>(arguments)
                .map_err(|error| failure(format!("package_arguments_invalid: {error}")))?
                .fields,
        ),
    };
    let mut listed = list(store, runtime)?;
    if let (Some(fields), Some(packages)) = (fields, listed["packages"].as_array_mut()) {
        for package in packages.iter_mut().filter_map(Value::as_object_mut) {
            package.retain(|key, _| fields.iter().any(|field| field == key));
        }
    }
    Ok(listed)
}

pub fn list(store: &ModStore, runtime: Option<&Value>) -> io::Result<Value> {
    let selections = selections(store)?;
    let Some(cache) = &selections.listing else {
        return Ok(with_route_choices(
            store.root(),
            listing(&selections, runtime)?.0,
        ));
    };
    let read = listing_key(runtime);
    let mut cache = cache.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((key, listed)) = &*cache
        && *key == read
    {
        return Ok(with_route_choices(store.root(), listed.clone()));
    }
    let (listed, cacheable) = listing(&selections, runtime)?;
    if cacheable {
        *cache = Some((read, listed.clone()));
    }
    Ok(with_route_choices(store.root(), listed))
}

/// Lists the `host.json` worker routes open to each mod as the `enum` of its `"choices": "routes"` settings; read on
/// every call because `host.json` changes outside the listing cache.
fn with_route_choices(root: &Path, mut listed: Value) -> Value {
    let config = std::fs::read(root.join("host.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or_default();
    let routes = config["routes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    for package in listed["packages"].as_array_mut().into_iter().flatten() {
        let id = package["id"].clone();
        let names: Vec<Value> = routes
            .iter()
            .filter(|route| {
                route["roles"]
                    .as_array()
                    .is_some_and(|roles| roles.contains(&json!("worker")))
                    && route["mods"]
                        .as_array()
                        .is_none_or(|mods| mods.is_empty() || mods.contains(&id))
            })
            .filter_map(|route| route["name"].as_str().map(Value::from))
            .collect();
        for property in package
            .get_mut("settings_schema")
            .and_then(|schema| schema.get_mut("properties"))
            .and_then(Value::as_object_mut)
            .into_iter()
            .flat_map(|properties| properties.values_mut())
            .filter(|property| property["choices"] == "routes")
        {
            property["enum"] = Value::from(names.clone());
        }
    }
    listed
}

pub fn listing_key(runtime: Option<&Value>) -> Value {
    runtime.map_or(Value::Null, |runtime| {
        let fields = |key: &str, names: &[&str]| -> Vec<Vec<Value>> {
            let items = runtime[key].as_array().into_iter().flatten();
            items
                .map(|item| names.iter().map(|name| item[*name].clone()).collect())
                .collect()
        };
        json!([
            fields("mods", &LISTING_RUNTIME_FIELDS),
            fields("rejected", &["path", "reason"]),
            runtime["reload_error"],
        ])
    })
}

fn listing(selections: &Selections, runtime: Option<&Value>) -> io::Result<(Value, bool)> {
    let Selections {
        lock,
        configuration,
        status,
        manifests,
        ..
    } = selections;
    let mut cacheable = true;
    let generation = configuration.revision;
    let selections = status["selections"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let configured = &configuration.mods;
    let runtime_list = |key: &str| {
        runtime
            .and_then(|runtime| runtime[key].as_array())
            .map(Vec::as_slice)
            .unwrap_or_default()
    };
    let (loaded, rejected) = (runtime_list("mods"), runtime_list("rejected"));
    let empty_settings = Default::default();
    let mut packages: Vec<Value> = selections
        .iter()
        .enumerate()
        .map(|(index, selection)| {
            let id = selection["id"].as_str().unwrap_or("unreadable_mod");
            let locked = lock
                .packages
                .get(id)
                .filter(|_| selection["packaged"] == true);
            let pending_manifest;
            let manifest = if selection["reason"] == "managed_pending_sync" {
                cacheable = false;
                pending_manifest = selection["path"]
                    .as_str()
                    .and_then(|path| ModStore::inspect_package(Path::new(path)).ok())
                    .map(|inspected| inspected["manifest"].clone())
                    .unwrap_or(Value::Null);
                &pending_manifest
            } else {
                &manifests[index]
            };
            let api = manifest["api"]
                .as_str()
                .or(locked.map(|package| package.api.as_str()))
                .unwrap_or_default();
            let wanted = selection["effective"] == true;
            let enabled = selection["selected"] == true;
            let running = loaded.iter().find(|item| {
                item["id"] == selection["id"]
                    && item["scope"] == selection["scope"]
                    && item["sha256"] == selection["sha256"]
            });
            let failed = selection["error"].as_str().or_else(|| {
                enabled
                    .then(|| {
                        running.and_then(|item| item["error"].as_str()).or_else(|| {
                            rejected
                                .iter()
                                .find(|item| item["path"] == selection["path"])
                                .and_then(|item| item["reason"].as_str())
                        })
                    })
                    .flatten()
            });
            json!({
                "id": id,
                "kind": "mod",
                "version": manifest["version"].as_str().or(locked.map(|package| package.version.as_str())).unwrap_or_default(),
                "description": manifest["description"],
                "scope": selection["scope"],
                "path": selection["path"],
                "source": locked.map_or("selection", |package| source_kind(&package.source)),
                "blocked": locked.and_then(|package| lock.blocked_reason(&package.id, &package.version, &package.integrity)),
                "installed": true,
                "enabled": enabled,
                "required": selection["required"],
                "effective": if runtime.is_some() { running.is_some_and(|item| item["error"].is_null()) } else { wanted },
                "pending": (runtime.is_some() && wanted != running.is_some()).then_some("reload"),
                "failed": failed,
                "api": api,
                "compatible": crate::SUPPORTED_MOD_APIS.iter().any(|(version, _, _)| *version == api),
                "grants": selection["capabilities"],
                "settings_schema": manifest["settings_schema"],
                "settings": crate::effective_settings(
                    manifest.get("settings_schema"),
                    configured
                        .iter()
                        .find(|item| selection["path"].as_str() == item.path.to_str())
                        .map(|item| &item.settings)
                        .unwrap_or(&empty_settings),
                ),
                "conflicts": selection["reason"]
                    .as_str()
                    .filter(|reason| reason.contains("conflict"))
                    .map(|reason| vec![reason.to_owned()])
                    .unwrap_or_default(),
            })
        })
        .collect();
    packages.extend(
        loaded
            .iter()
            .filter(|item| {
                !selections.iter().any(|selection| {
                    selection["id"] == item["id"] && selection["scope"] == item["scope"]
                })
            })
            .map(|item| {
                json!({
                    "id": item["id"], "kind": "mod", "version": item["version"], "description": null,
                    "scope": item["scope"], "path": null, "source": "selection", "installed": false,
                    "enabled": false, "effective": item["error"].is_null(), "pending": "reload",
                    "failed": item["error"], "api": item["api"], "compatible": true,
                    "grants": item["capabilities"], "conflicts": [],
                })
            }),
    );
    Ok((
        json!({
            "packages": packages,
            "generation": generation,
            "reload_error": runtime.map_or(Value::Null, |runtime| runtime["reload_error"].clone()),
        }),
        cacheable,
    ))
}

pub fn preview(store: &ModStore, arguments: Value) -> io::Result<PackagePreview> {
    let arguments: Arguments = serde_json::from_value(arguments)
        .map_err(|error| failure(format!("package_arguments_invalid: {error}")))?;
    let generation = generation(store)?;
    if arguments
        .expected_generation
        .is_some_and(|expected| expected != generation)
    {
        return Err(failure("package_state_changed: list again"));
    }
    let lock = store.package_lock()?;
    let locked = |id: &Option<String>| {
        let id = id
            .as_deref()
            .ok_or_else(|| failure("package_id_required"))?;
        lock.packages
            .get(id)
            .cloned()
            .ok_or_else(|| failure(format!("package_not_installed: {id}")))
    };
    let mut codex_config = Value::Null;
    let (id, request, plan, selection, added) = match arguments.action.as_str() {
        "install" => {
            let index = arguments.index.clone().or_else(|| store.package_index());
            let source = match (&arguments.source, &arguments.reference) {
                (Some(source), None) => source.clone(),
                (None, Some(reference)) => ModPackageSource::parse(reference, index.clone())?,
                _ => {
                    return Err(failure(
                        "package_source_required: give a source or a reference",
                    ));
                }
            };
            let source = match arguments.version.as_deref() {
                Some(version) if !version.is_empty() => source.with_version(version)?,
                _ => source,
            };
            let (request, plan) = requested(store, source, index, arguments.scope.clone())?;
            (plan.root.clone(), Some(request), Some(plan), None, None)
        }
        "update" => {
            let package = locked(&arguments.id)?;
            let index = arguments.index.clone().or_else(|| {
                std::iter::once(&package.source)
                    .chain(
                        package
                            .dependencies
                            .iter()
                            .filter_map(|dependency| lock.packages.get(&dependency.id))
                            .map(|dependency| &dependency.source),
                    )
                    .find_map(|source| match source {
                        ModPackageSource::Package { index, .. } => Some(index.clone()),
                        _ => None,
                    })
            });
            let (request, plan) = requested(
                store,
                package.source.updatable(),
                index,
                package.scope.clone(),
            )
            .map_err(|error| failure(format!("package_update_unavailable: {error}")))?;
            (package.id, Some(request), Some(plan), None, None)
        }
        "remove" => {
            let package = locked(&arguments.id)?;
            let plan = store.package_uninstall_plan(&package.id)?;
            (package.id, None, Some(plan), None, None)
        }
        "rollback" => {
            let package = locked(&arguments.id)?;
            let plan = store.package_rollback_plan(&package.id)?;
            (package.id, None, Some(plan), None, None)
        }
        "enable" | "disable" => match selected(store, &arguments) {
            Ok((id, current)) => {
                let added = if arguments.action == "enable" {
                    current.capabilities.clone()
                } else {
                    Vec::new()
                };
                (id, None, None, Some(current), Some(added))
            }
            Err(_) => (locked(&arguments.id)?.id, None, None, None, None),
        },
        "trust" => {
            let (id, current) = selected(store, &arguments)?;
            let inspected = ModStore::inspect_package(&current.path)?;
            let sha256 = inspected["sha256"].as_str().unwrap_or_default().to_owned();
            let exec_environment: Vec<String> =
                serde_json::from_value(inspected["manifest"]["exec_environment"].clone())
                    .unwrap_or_default();
            let secret_environment: Vec<String> = exec_environment
                .into_iter()
                .filter(|name| crate::host::secret_like(name))
                .collect();
            if sha256 == current.sha256
                && secret_environment
                    .iter()
                    .all(|name| current.secret_environment.contains(name))
            {
                return Err(failure("package_source_unchanged"));
            }
            let capabilities: Vec<String> =
                serde_json::from_value(inspected["manifest"]["capabilities"].clone())?;
            let added = capabilities
                .iter()
                .filter(|capability| !current.capabilities.contains(capability))
                .cloned()
                .collect();
            codex_config = inspected["manifest"]["codex_config"].clone();
            let trusted = Selection {
                sha256,
                capabilities,
                exec_environment: inspected["manifest"]["exec_environment"].clone(),
                secret_environment,
                ..current
            };
            (id, None, None, Some(trusted), Some(added))
        }
        other => return Err(failure(format!("package_action_invalid: {other}"))),
    };
    let grants_added =
        added.unwrap_or_else(|| managed_grants(&lock, &id, &request, &arguments.action));
    let changes = match (&plan, &selection) {
        (Some(plan), _) => plan.changes.clone(),
        (None, Some(selection)) if arguments.action == "trust" => {
            json!({"sha256": selection.sha256, "enabled": selection.enabled,
                "exec_environment": selection.exec_environment,
                "secret_environment": selection.secret_environment, "codex_config": codex_config})
        }
        _ => json!({"enabled": arguments.action == "enable"}),
    };
    let public = json!({
        "action": arguments.action,
        "id": id,
        "changes": changes,
        "grants_added": grants_added,
    });
    Ok(PackagePreview {
        public,
        control: PackageControl {
            action: arguments.action,
            id,
            request,
            confirmation: plan.map(|plan| plan.confirmation),
            selection,
            generation,
        },
    })
}

fn managed_grants(
    lock: &crate::ModPackageLock,
    id: &str,
    request: &Option<ModInstallRequest>,
    action: &str,
) -> Vec<String> {
    let grants: BTreeMap<String, Vec<String>> = match (request, lock.packages.get(id)) {
        (Some(request), _) => request
            .trust
            .packages
            .iter()
            .map(|(package, grant)| (package.clone(), grant.capabilities.clone()))
            .collect(),
        (None, Some(package)) => {
            BTreeMap::from([(id.to_owned(), package.trust.capabilities.clone())])
        }
        (None, None) => BTreeMap::new(),
    };
    let enabling = action == "enable";
    grants
        .iter()
        .flat_map(|(package, capabilities)| {
            let previous = lock
                .packages
                .get(package)
                .map(|p| p.trust.capabilities.clone())
                .unwrap_or_default();
            capabilities
                .iter()
                .filter(move |grant| !previous.contains(grant) || enabling)
                .map(move |grant| {
                    if package == id {
                        grant.clone()
                    } else {
                        format!("{package}:{grant}")
                    }
                })
        })
        .collect()
}

fn selected(store: &ModStore, arguments: &Arguments) -> io::Result<(String, Selection)> {
    let id = arguments
        .id
        .clone()
        .ok_or_else(|| failure("package_id_required"))?;
    let status = store.selection_status()?;
    let selection = status["selections"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|item| {
            item["id"] == id.as_str()
                && item["scope"] == arguments.scope.as_str()
                && item["packaged"] != true
        })
        .ok_or_else(|| failure(format!("package_not_installed: {id}")))?;
    let current = Selection {
        path: PathBuf::from(selection["path"].as_str().unwrap_or_default()),
        scope: arguments.scope.clone(),
        sha256: selection["sha256"].as_str().unwrap_or_default().to_owned(),
        capabilities: serde_json::from_value(selection["capabilities"].clone())?,
        enabled: selection["selected"] == true,
        secret_environment: serde_json::from_value(selection["secret_environment"].clone())
            .unwrap_or_default(),
        exec_environment: selection["exec_environment"].clone(),
    };
    Ok((id, current))
}

fn requested(
    store: &ModStore,
    source: ModPackageSource,
    index: Option<PathBuf>,
    scope: String,
) -> io::Result<(ModInstallRequest, crate::ModPackagePlan)> {
    let mut request = ModInstallRequest {
        action: None,
        offline: matches!(source, ModPackageSource::Local { .. }),
        source,
        index,
        scope,
        trust: ModPackageTrust::default(),
        settings: BTreeMap::new(),
    };
    request.trust.packages = store
        .package_requirements(request.clone())?
        .packages
        .into_iter()
        .map(|package| (package.id, package.trust))
        .collect();
    let plan = store.package_plan(request.clone())?;
    Ok((request, plan))
}

pub fn apply(store: &ModStore, control: &PackageControl) -> io::Result<Value> {
    if generation(store)? != control.generation {
        return Err(failure("package_state_changed: preview again"));
    }
    let confirmation = || {
        control
            .confirmation
            .as_deref()
            .ok_or_else(|| failure("package_confirmation_missing"))
    };
    match (
        control.action.as_str(),
        &control.request,
        &control.selection,
    ) {
        ("install" | "update", Some(request), None) => {
            store.package_apply(request.clone(), confirmation()?)?;
        }
        ("remove", None, None) => {
            store.package_uninstall(&control.id, confirmation()?)?;
        }
        ("rollback", None, None) => {
            store.package_rollback(&control.id, confirmation()?)?;
        }
        ("enable", None, None) => {
            store.package_enable(&control.id)?;
        }
        ("disable", None, None) => {
            store.package_disable(&control.id)?;
        }
        ("enable" | "disable", None, Some(selection)) => {
            store.enable(&selection.path, control.action == "enable")?;
        }
        ("trust", None, Some(selection)) => {
            store.trust_with_secrets(
                selection.path.clone(),
                &selection.sha256,
                selection.capabilities.clone(),
                &selection.scope,
                selection.secret_environment.clone(),
            )?;
            if selection.enabled {
                store.enable(&selection.path, true)?;
            }
        }
        _ => return Err(failure("package_action_invalid")),
    }
    Ok(json!({"status": "applied", "generation": generation(store)?}))
}

/// Forces every selection to revalidate at the serving session's next safe boundary.
pub fn reload(store: &ModStore) -> io::Result<Value> {
    store.reload()?;
    let status = store.selection_status()?;
    let failed = status["selections"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["selected"] == true && !item["error"].is_null())
        .filter_map(|item| item["id"].as_str().or(item["path"].as_str()))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    Ok(json!({"generation": generation(store)?, "failed": failed, "applies": "next_boundary"}))
}

#[cfg(test)]
#[path = "package_controls_tests.rs"]
mod tests;
