use crate::ModStore;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::io;
use std::path::Path;

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
