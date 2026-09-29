use crate::{ModInstallRequest, ModPackageSource, ModPackageTrust, ModStore};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io;
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq)]
pub struct PackageControl {
    pub action: String,
    pub id: String,
    request: Option<ModInstallRequest>,
    confirmation: Option<String>,
    generation: u64,
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

pub fn list(store: &ModStore) -> io::Result<Value> {
    let lock = store.package_lock()?;
    let status = store.selection_status()?;
    let selections = status["selections"].as_array().cloned().unwrap_or_default();
    let packages: Vec<Value> = lock
        .packages
        .values()
        .map(|package| {
            let selection = selections.iter().find(|s| s["id"] == package.id.as_str() && s["scope"] == package.scope.as_str());
            json!({
                "id": package.id,
                "kind": "mod",
                "version": package.version,
                "scope": package.scope,
                "source": match &package.source { ModPackageSource::Local { .. } => "local", ModPackageSource::Repository { .. } => "repository", ModPackageSource::Package { .. } => "package" },
                "installed": true,
                "enabled": package.enabled,
                "effective": selection.is_some_and(|s| s["effective"] == true),
                "pending": selection.and_then(|s| (s["reason"] == "pending_runtime_validation").then_some("reload")),
                "failed": selection.and_then(|s| s["error"].as_str()),
                "api": package.api,
                "compatible": crate::SUPPORTED_MOD_APIS.iter().any(|(version, _, _)| *version == package.api),
                "grants": package.trust.capabilities,
                "conflicts": selection
                    .and_then(|s| s["reason"].as_str())
                    .filter(|reason| reason.contains("conflict"))
                    .map(|reason| vec![reason.to_owned()])
                    .unwrap_or_default(),
            })
        })
        .collect();
    Ok(json!({"packages": packages, "generation": lock.revision}))
}

pub fn preview(store: &ModStore, arguments: Value) -> io::Result<PackagePreview> {
    let arguments: Arguments = serde_json::from_value(arguments)
        .map_err(|error| failure(format!("package_arguments_invalid: {error}")))?;
    let lock = store.package_lock()?;
    if arguments
        .expected_generation
        .is_some_and(|expected| expected != lock.revision)
    {
        return Err(failure("package_state_changed: list again"));
    }
    let locked = |id: &Option<String>| {
        let id = id
            .as_deref()
            .ok_or_else(|| failure("package_id_required"))?;
        lock.packages
            .get(id)
            .cloned()
            .ok_or_else(|| failure(format!("package_not_installed: {id}")))
    };
    let (id, request, plan) = match arguments.action.as_str() {
        "install" => {
            let source = arguments
                .source
                .ok_or_else(|| failure("package_source_required"))?;
            let (request, plan) =
                requested(store, source, arguments.index, arguments.scope, false)?;
            (plan.root.clone(), Some(request), Some(plan))
        }
        "update" => {
            let package = locked(&arguments.id)?;
            let index = arguments.index.or_else(|| {
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
            (package.id, Some(request), Some(plan))
        }
        "remove" => {
            let package = locked(&arguments.id)?;
            (
                package.id.clone(),
                None,
                Some(store.package_uninstall_plan(&package.id)?),
            )
        }
        "rollback" => {
            let package = locked(&arguments.id)?;
            (
                package.id.clone(),
                None,
                Some(store.package_rollback_plan(&package.id)?),
            )
        }
        "enable" | "disable" => (locked(&arguments.id)?.id, None, None),
        other => return Err(failure(format!("package_action_invalid: {other}"))),
    };
    let grants: BTreeMap<String, Vec<String>> = match (&request, lock.packages.get(&id)) {
        (Some(request), _) => request
            .trust
            .packages
            .iter()
            .map(|(package, grant)| (package.clone(), grant.capabilities.clone()))
            .collect(),
        (None, Some(package)) => BTreeMap::from([(id.clone(), package.trust.capabilities.clone())]),
        (None, None) => BTreeMap::new(),
    };
    let (enabling, root) = (arguments.action == "enable", id.as_str());
    let grants_added = grants
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
                    if package == root {
                        grant.clone()
                    } else {
                        format!("{package}:{grant}")
                    }
                })
        })
        .collect::<Vec<_>>();
    let public = json!({
        "action": arguments.action,
        "id": id,
        "changes": plan.as_ref().map(|plan| plan.changes.clone()).unwrap_or_else(|| json!({"enabled": arguments.action == "enable"})),
        "grants_added": grants_added,
    });
    Ok(PackagePreview {
        public,
        control: PackageControl {
            action: arguments.action,
            id,
            request,
            confirmation: plan.map(|plan| plan.confirmation),
            generation: lock.revision,
        },
    })
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
    if store.package_lock()?.revision != control.generation {
        return Err(failure("package_state_changed: preview again"));
    }
    let confirmation = || {
        control
            .confirmation
            .as_deref()
            .ok_or_else(|| failure("package_confirmation_missing"))
    };
    let lock = match (control.action.as_str(), &control.request) {
        ("install" | "update", Some(request)) => {
            store.package_apply(request.clone(), confirmation()?)?
        }
        ("remove", None) => store.package_uninstall(&control.id, confirmation()?)?,
        ("rollback", None) => store.package_rollback(&control.id, confirmation()?)?,
        ("enable", None) => store.package_enable(&control.id)?,
        ("disable", None) => store.package_disable(&control.id)?,
        _ => return Err(failure("package_action_invalid")),
    };
    Ok(json!({"status": "applied", "generation": lock.revision}))
}

#[cfg(test)]
#[path = "package_controls_tests.rs"]
mod tests;
