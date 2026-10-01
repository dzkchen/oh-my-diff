use crate::{ModInstallRequest, ModPackageSource, ModPackageTrust, ModStore};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

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
    index: Option<PathBuf>,
    #[serde(default = "user")]
    scope: String,
    #[serde(default)]
    expected_generation: Option<u64>,
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
    }
}

/// Lists every store selection; `runtime` is the serving session's mod status.
pub fn list(store: &ModStore, runtime: Option<&Value>) -> io::Result<Value> {
    let generation = generation(store)?;
    let lock = store.package_lock()?;
    let status = store.selection_status()?;
    let selections = status["selections"].as_array().cloned().unwrap_or_default();
    let runtime_list = |key: &str| {
        runtime
            .and_then(|runtime| runtime[key].as_array())
            .cloned()
            .unwrap_or_default()
    };
    let (loaded, rejected) = (runtime_list("mods"), runtime_list("rejected"));
    let mut packages: Vec<Value> = selections
        .iter()
        .map(|selection| {
            let id = selection["id"].as_str().unwrap_or("unreadable_mod");
            let locked = lock
                .packages
                .get(id)
                .filter(|_| selection["managed"] == true);
            let manifest = selection["path"]
                .as_str()
                .and_then(|path| ModStore::inspect_package(Path::new(path)).ok())
                .map(|inspected| inspected["manifest"].clone())
                .unwrap_or(Value::Null);
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
                "installed": true,
                "enabled": enabled,
                "effective": if runtime.is_some() { running.is_some_and(|item| item["error"].is_null()) } else { wanted },
                "pending": (runtime.is_some() && wanted != running.is_some()).then_some("reload"),
                "failed": failed,
                "api": api,
                "compatible": crate::SUPPORTED_MOD_APIS.iter().any(|(version, _, _)| *version == api),
                "grants": selection["capabilities"],
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
    Ok(json!({
        "packages": packages,
        "generation": generation,
        "reload_error": runtime.map_or(Value::Null, |runtime| runtime["reload_error"].clone()),
    }))
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
    let (id, request, plan, selection, added) = match arguments.action.as_str() {
        "install" => {
            let source = arguments
                .source
                .clone()
                .ok_or_else(|| failure("package_source_required"))?;
            let (request, plan) = requested(
                store,
                source,
                arguments.index.clone(),
                arguments.scope.clone(),
                false,
            )?;
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
                package.source.clone(),
                index,
                package.scope.clone(),
                package.enabled,
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
            if sha256 == current.sha256 {
                return Err(failure("package_source_unchanged"));
            }
            let capabilities: Vec<String> =
                serde_json::from_value(inspected["manifest"]["capabilities"].clone())?;
            let added = capabilities
                .iter()
                .filter(|capability| !current.capabilities.contains(capability))
                .cloned()
                .collect();
            let trusted = Selection {
                sha256,
                capabilities,
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
            json!({"sha256": selection.sha256, "enabled": selection.enabled})
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
                && item["managed"] != true
        })
        .ok_or_else(|| failure(format!("package_not_installed: {id}")))?;
    let current = Selection {
        path: PathBuf::from(selection["path"].as_str().unwrap_or_default()),
        scope: arguments.scope.clone(),
        sha256: selection["sha256"].as_str().unwrap_or_default().to_owned(),
        capabilities: serde_json::from_value(selection["capabilities"].clone())?,
        enabled: selection["selected"] == true,
    };
    Ok((id, current))
}

fn requested(
    store: &ModStore,
    source: ModPackageSource,
    index: Option<PathBuf>,
    scope: String,
    activate: bool,
) -> io::Result<(ModInstallRequest, crate::ModPackagePlan)> {
    let mut request = ModInstallRequest {
        offline: matches!(source, ModPackageSource::Local { .. }),
        source,
        index,
        scope,
        activate,
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
            store.trust(
                selection.path.clone(),
                &selection.sha256,
                selection.capabilities.clone(),
                &selection.scope,
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
