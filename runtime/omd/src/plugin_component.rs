use crate::ModStore;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};

pub fn inspect(root: &Path) -> io::Result<Value> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Descriptor {
        schema: u32,
        component: String,
        sha256: String,
    }
    if root.canonicalize()? != root {
        return Err(io::Error::other("plugin_root_not_canonical"));
    }
    let snapshot = crate::Snapshot::capture(
        root,
        &BTreeSet::from([".codex-plugin/omd.json".into()]),
        8192,
    )?;
    let descriptor: Descriptor = serde_json::from_slice(
        &snapshot
            .files
            .get(".codex-plugin/omd.json")
            .ok_or_else(|| io::Error::other("plugin_component_missing"))?
            .bytes,
    )?;
    if descriptor.schema != 1
        || descriptor.component.len() > 256
        || descriptor.component.is_empty()
        || Path::new(&descriptor.component)
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(io::Error::other("plugin_component_invalid"));
    }
    let mut path = root.to_owned();
    for part in Path::new(&descriptor.component).components() {
        path.push(part);
        if path.canonicalize()? != path || !std::fs::symlink_metadata(&path)?.is_dir() {
            return Err(io::Error::other("plugin_component_scope_invalid"));
        }
    }
    let package = ModStore::inspect_package(&path)?;
    if package["sha256"] != descriptor.sha256 {
        return Err(io::Error::other("plugin_component_hash_mismatch"));
    }
    Ok(
        json!({"schema":1,"plugin_root":root,"component":path,"package":package,"activation":"requires separate mod-store trust and enable"}),
    )
}

pub(crate) fn cached(path: &Path) -> bool {
    crate::host::codex_home()
        .and_then(|home| {
            home.join(codex_core_plugin_common::installed::PLUGINS_CACHE_DIR)
                .canonicalize()
                .ok()
        })
        .is_some_and(|cache| path.starts_with(cache))
}

fn installed(codex_home: &Path) -> io::Result<Vec<(String, String, String, PathBuf)>> {
    use codex_core_plugin_common::installed::{
        PLUGINS_CACHE_DIR, active_plugin_version, validate_plugin_version_segment,
    };
    let config: toml::Table = match std::fs::read_to_string(codex_home.join("config.toml")) {
        Ok(text) => toml::from_str(&text).map_err(io::Error::other)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let keys = config.get("plugins").and_then(toml::Value::as_table);
    Ok(keys
        .into_iter()
        .flatten()
        .filter(|(_, entry)| entry.get("enabled").and_then(toml::Value::as_bool) != Some(false))
        .filter_map(|(key, _)| {
            let (plugin, marketplace) = key.split_once('@')?;
            validate_plugin_version_segment(plugin).ok()?;
            validate_plugin_version_segment(marketplace).ok()?;
            let base = codex_home
                .join(PLUGINS_CACHE_DIR)
                .join(marketplace)
                .join(plugin);
            let version = active_plugin_version(
                &codex_utils_absolute_path::AbsolutePathBuf::from_absolute_path(&base).ok()?,
            )?;
            let root = base.join(&version);
            root.join(".codex-plugin/omd.json")
                .is_file()
                .then(|| (plugin.to_owned(), marketplace.to_owned(), version, root))
        })
        .collect())
}

pub fn components(store: &ModStore, codex_home: &Path) -> io::Result<Value> {
    let status = store.selection_status()?;
    let selections = status["selections"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let components = installed(codex_home)?
        .into_iter()
        .map(|(plugin, marketplace, version, root)| {
            let inspected = root.canonicalize().and_then(|root| inspect(&root));
            let package = inspected
                .as_ref()
                .map_or(&Value::Null, |inspected| &inspected["package"]);
            let id = &package["manifest"]["id"];
            let mine = selections
                .iter()
                .filter(|item| !id.is_null() && &item["id"] == id);
            json!({
                "plugin": plugin, "marketplace": marketplace, "version": version, "id": id,
                "description": package["manifest"]["description"], "sha256": package["sha256"],
                "error": inspected.as_ref().err().map(ToString::to_string),
                "installed": mine.clone().next().is_some(),
                "enabled": mine.clone().any(|item| item["selected"] == true),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({"components": components}))
}

pub fn resolve(
    codex_home: &Path,
    plugin: &str,
    marketplace: Option<&str>,
) -> io::Result<(PathBuf, String)> {
    let mut matching = installed(codex_home)?
        .into_iter()
        .filter(|(name, market, ..)| {
            name == plugin && marketplace.is_none_or(|marketplace| marketplace == market)
        });
    let (.., root) = matching
        .next()
        .ok_or_else(|| io::Error::other(format!("plugin_component_not_installed: {plugin}")))?;
    if matching.next().is_some() {
        return Err(io::Error::other(format!(
            "plugin_marketplace_required: {plugin}"
        )));
    }
    let inspected = inspect(&root.canonicalize()?)?;
    Ok((
        serde_json::from_value(inspected["component"].clone())?,
        inspected["package"]["sha256"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    ))
}
