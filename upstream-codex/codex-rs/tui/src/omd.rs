use ratatui::buffer::Buffer;
use ratatui::layout::Position;
use ratatui::style::Modifier;
use serde::Deserialize;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use std::borrow::Cow;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

#[cfg(test)]
pub(crate) const MODE_ENV: &str = codex_omd::MODE_ENV;
pub(crate) const MANIFEST_ENV: &str = codex_omd::MANIFEST_ENV;
pub(crate) const GRAPH_ENV: &str = "OMD_GRAPH_SNAPSHOT";
pub(crate) const INSTALL_PROFILE_ENV: &str = "OMD_INSTALL_PROFILE";
pub(crate) const REVOCATION_FILE: &str = "contributor-revoked.json";
static FULLSCREEN_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct MouseSelection {
    pub(crate) anchor: Position,
    pub(crate) head: Position,
    pub(crate) dragged: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ContributorAuthorization {
    Authorized,
    Revoked,
    Invalid,
    Disabled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Snapshot {
    pub(crate) evidence: PathBuf,
    pub(crate) task_status: String,
    pub(crate) live_workers: usize,
    pub(crate) archived_workers: usize,
    pub(crate) requests_consumed: u64,
    pub(crate) requests_remaining: u64,
    pub(crate) exposure_consumed_microusd: u64,
    pub(crate) exposure_remaining_microusd: u64,
    pub(crate) authorization: ContributorAuthorization,
    pub(crate) direct_single_agent: bool,
    pub(crate) selected_capabilities: Vec<String>,
    pub(crate) settled_task_charge_microusd: u64,
    pub(crate) retained_exposure_upper_bound_microusd: u64,
    pub(crate) raw_usage_attempts: u64,
}

#[derive(Deserialize)]
struct Manifest {
    evidence: PathBuf,
    authorization: PathBuf,
    authorization_sha256: String,
    repository_identity: String,
    #[serde(default)]
    capabilities: Capabilities,
    #[serde(default)]
    repository: Option<PathBuf>,
    #[serde(default)]
    mods: Option<PathBuf>,
    #[serde(default)]
    mod_pi_user: Option<PathBuf>,
    #[serde(default)]
    mod_secret_refs: std::collections::BTreeMap<String, PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ModPaths {
    pub(crate) evidence: PathBuf,
    pub(crate) repository: PathBuf,
    pub(crate) store: Option<PathBuf>,
    pub(crate) pi_user: Option<PathBuf>,
    pub(crate) protected: Vec<PathBuf>,
}

#[derive(Deserialize)]
struct Capabilities {
    #[serde(default = "enabled_by_default")]
    delegation: bool,
    #[serde(default = "enabled_by_default")]
    code_graph: bool,
    #[serde(default = "enabled_by_default")]
    terminal: bool,
}

impl Default for Capabilities {
    fn default() -> Self {
        Self {
            delegation: true,
            code_graph: true,
            terminal: true,
        }
    }
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Default, Deserialize)]
struct EffectiveSettings {
    #[serde(default)]
    direct_single_agent: bool,
    #[serde(default)]
    selected_capabilities: Vec<String>,
}

#[derive(Default, Deserialize)]
struct TaskCostCapture {
    #[serde(default)]
    settled_task_charge_microusd: u64,
    #[serde(default)]
    retained_exposure_upper_bound_microusd: u64,
    #[serde(default)]
    raw_usage_attempts: u64,
}

#[derive(Default, Deserialize)]
struct Checkpoint {
    #[serde(default)]
    task_status: String,
    #[serde(default)]
    workers: Vec<Value>,
    #[serde(default)]
    archived_workers: usize,
    #[serde(default)]
    allowance: Allowance,
}

#[derive(Default, Deserialize)]
struct Allowance {
    #[serde(default)]
    requests_consumed: u64,
    #[serde(default)]
    requests_remaining: u64,
    #[serde(default)]
    exposure_consumed_microusd: u64,
    #[serde(default)]
    exposure_remaining_microusd: u64,
}

pub(crate) fn is_active() -> bool {
    effective_mode().is_ok_and(|mode| mode.mode.task_hooks_enabled())
}

fn manifest() -> Option<Manifest> {
    let path = std::env::var_os(MANIFEST_ENV).map(PathBuf::from)?;
    serde_json::from_slice(&bounded_read(&path, 65_536).ok()?).ok()
}

pub(crate) fn mod_snapshot() -> (bool, codex_omd::ModViewSnapshot) {
    if effective_mode().is_ok_and(|mode| mode.mode == codex_omd::RuntimeMode::Platform) {
        return mod_paths().map_or_else(
            || (false, codex_omd::ModViewSnapshot::default()),
            |paths| {
                (
                    true,
                    codex_omd::ModViewSnapshot::read(&paths.evidence.join("mod-view.json"))
                        .unwrap_or_default(),
                )
            },
        );
    }
    let Some(manifest) = manifest().filter(|_| is_active()) else {
        return (false, codex_omd::ModViewSnapshot::default());
    };
    if !manifest.capabilities.terminal {
        return (false, codex_omd::ModViewSnapshot::default());
    }
    (
        true,
        codex_omd::ModViewSnapshot::read(&manifest.evidence.join("mod-view.json"))
            .unwrap_or_default(),
    )
}

pub(crate) fn mod_paths() -> Option<ModPaths> {
    if effective_mode().is_ok_and(|mode| mode.mode == codex_omd::RuntimeMode::Platform) {
        let root = PathBuf::from(std::env::var_os(codex_omd::MOD_STORE_ENV)?);
        if !root.is_absolute() || root.canonicalize().ok()? != root {
            return None;
        }
        return Some(ModPaths {
            evidence: root.clone(),
            repository: std::env::current_dir().ok()?,
            store: Some(root.clone()),
            pi_user: None,
            protected: vec![root],
        });
    }
    if !is_active() {
        return None;
    }
    let manifest = manifest()?;
    if manifest.mods.is_none() && manifest.mod_pi_user.is_none() {
        return None;
    }
    Some(ModPaths {
        repository: manifest.repository?,
        protected: manifest
            .mod_secret_refs
            .into_values()
            .chain(manifest.mods.iter().cloned())
            .collect(),
        evidence: manifest.evidence,
        store: manifest.mods,
        pi_user: manifest.mod_pi_user,
    })
}

pub(crate) fn mod_status() -> Option<Value> {
    let paths = mod_paths()?;
    serde_json::from_slice(&bounded_read(&paths.evidence.join("mod-status.json"), 262_144).ok()?)
        .ok()
}

pub(crate) fn terminal_active() -> bool {
    mod_paths().is_some_and(|_| {
        effective_mode().is_ok_and(|mode| mode.mode == codex_omd::RuntimeMode::Platform)
    }) || is_active() && manifest().is_some_and(|manifest| manifest.capabilities.terminal)
}

pub(crate) fn graph_active() -> bool {
    is_active() && manifest().is_some_and(|manifest| manifest.capabilities.code_graph)
}

pub(crate) fn effective_mode() -> Result<codex_omd::EffectiveMode, String> {
    codex_omd::effective_mode()
}

pub(crate) fn launch_title(version: &str) -> String {
    format!("OpenAI Codex | Oh My Diffed (v{version})")
}

fn profile_label(value: &str) -> &'static str {
    match value {
        "full" => "Full OMD",
        "platform_only" => "Modding platform only",
        "private" => "Private foundation",
        _ => "Unknown",
    }
}

pub(crate) fn install_profile() -> Option<&'static str> {
    std::env::var(INSTALL_PROFILE_ENV)
        .ok()
        .map(|value| profile_label(&value))
}

pub(crate) fn install_profile_status() -> String {
    format!(
        "Install profile {}",
        install_profile().unwrap_or("Unreported")
    )
}

pub(crate) fn direct_mode_details(mode: codex_omd::EffectiveMode) -> Vec<String> {
    vec![
        "Oh My Diff · upstream-style direct".to_string(),
        install_profile_status(),
        format!("Selection {}", mode.source.label()),
        format!(
            "Task behavior Pinned upstream Codex flow ({})",
            codex_omd::PINNED_UPSTREAM
        ),
        "OMD task hooks Disabled before extension registration".to_string(),
        "Binary Oh My Diff custom binary; upstream executable not restored".to_string(),
        "Restore upstream Replace this binary through the supported uninstall/return path"
            .to_string(),
    ]
}

pub(crate) fn load_graph(cwd: &Path) -> Result<(codex_omd::CodeGraph, PathBuf), String> {
    if !graph_active() {
        return Err("code graph capability is disabled in the effective OMD settings".to_string());
    }
    let path = std::env::var_os(GRAPH_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| cwd.join(".omd/code-graph.json"));
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
        format!(
            "code graph unavailable at {}: {error}. Run omd-graph snapshot to generate it",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err("code graph snapshot cannot be a symbolic link".to_string());
    }
    let graph = codex_omd::CodeGraph::read(&path).map_err(|error| error.to_string())?;
    let canonical_cwd = cwd.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_cwd.starts_with(&graph.repository.root) {
        return Err("code graph belongs to a different working directory".to_string());
    }
    match graph
        .freshness(&graph.repository.root)
        .map_err(|error| error.to_string())?
    {
        codex_omd::GraphFreshness::Fresh => Ok((graph, path)),
        stale => Err(format!(
            "code graph snapshot is stale; regenerate it with omd-graph snapshot: {}",
            serde_json::to_string(&stale).map_err(|error| error.to_string())?
        )),
    }
}

pub(crate) fn ligatures_enabled() -> bool {
    terminal_active()
        && std::env::var("OMD_TUI_ASCII").as_deref() != Ok("1")
        && locale_supports_unicode()
}

pub(crate) fn mouse_enabled() -> bool {
    terminal_active() && std::env::var("OMD_TUI_MOUSE").as_deref() != Ok("off")
}

pub(crate) fn set_fullscreen_active(active: bool) {
    FULLSCREEN_ACTIVE.store(active, Ordering::Relaxed);
}

pub(crate) fn fullscreen_active() -> bool {
    FULLSCREEN_ACTIVE.load(Ordering::Relaxed)
}

fn locale_supports_unicode() -> bool {
    ["LC_ALL", "LC_CTYPE", "LANG"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .find(|value| !value.is_empty())
        .is_none_or(|value| {
            let normalized = value.to_ascii_lowercase();
            normalized.contains("utf-8") || normalized.contains("utf8")
        })
}

pub(crate) fn visual_input(text: &str) -> Cow<'_, str> {
    if !ligatures_enabled()
        || (!text.contains("===") && !text.contains("->") && !text.contains("<="))
    {
        return Cow::Borrowed(text);
    }
    Cow::Owned(visual_input_unicode(text))
}

fn visual_input_unicode(text: &str) -> String {
    let mut rendered = String::with_capacity(text.len());
    let mut remaining = text;
    while !remaining.is_empty() {
        if let Some(rest) = remaining.strip_prefix("===") {
            rendered.push_str("≡  ");
            remaining = rest;
        } else if let Some(rest) = remaining.strip_prefix("->") {
            rendered.push_str("→ ");
            remaining = rest;
        } else if let Some(rest) = remaining.strip_prefix("<=") {
            rendered.push_str("≤ ");
            remaining = rest;
        } else if let Some(character) = remaining.chars().next() {
            rendered.push(character);
            remaining = &remaining[character.len_utf8()..];
        }
    }
    rendered
}

pub(crate) fn snapshot() -> Result<Snapshot, String> {
    let path = std::env::var_os(MANIFEST_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| "Oh My Diff controlled runtime is not active".to_string())?;
    snapshot_from_manifest(&path)
}

fn snapshot_from_manifest(path: &Path) -> Result<Snapshot, String> {
    let bytes = bounded_read(path, 65_536)?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let checkpoint: Checkpoint = serde_json::from_slice(&bounded_read(
        &manifest.evidence.join("checkpoint.json"),
        65_536,
    )?)
    .map_err(|error| error.to_string())?;
    let settings: EffectiveSettings = serde_json::from_slice(&bounded_read(
        &manifest.evidence.join("effective-settings.json"),
        65_536,
    )?)
    .map_err(|error| error.to_string())?;
    let cost: TaskCostCapture = serde_json::from_slice(&bounded_read(
        &manifest.evidence.join("task-cost.json"),
        8_388_608,
    )?)
    .map_err(|error| error.to_string())?;
    let authorization = if manifest.capabilities.delegation {
        authorization_state(&manifest)
    } else {
        ContributorAuthorization::Disabled
    };
    Ok(Snapshot {
        evidence: manifest.evidence,
        task_status: checkpoint.task_status,
        live_workers: checkpoint.workers.len(),
        archived_workers: checkpoint.archived_workers,
        requests_consumed: checkpoint.allowance.requests_consumed,
        requests_remaining: checkpoint.allowance.requests_remaining,
        exposure_consumed_microusd: checkpoint.allowance.exposure_consumed_microusd,
        exposure_remaining_microusd: checkpoint.allowance.exposure_remaining_microusd,
        authorization,
        direct_single_agent: settings.direct_single_agent,
        selected_capabilities: settings.selected_capabilities,
        settled_task_charge_microusd: cost.settled_task_charge_microusd,
        retained_exposure_upper_bound_microusd: cost.retained_exposure_upper_bound_microusd,
        raw_usage_attempts: cost.raw_usage_attempts,
    })
}

fn authorization_state(manifest: &Manifest) -> ContributorAuthorization {
    match std::fs::symlink_metadata(manifest.evidence.join(REVOCATION_FILE)) {
        Ok(_) => return ContributorAuthorization::Revoked,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return ContributorAuthorization::Invalid,
    }
    let Ok(bytes) = bounded_read(&manifest.authorization, 65_536) else {
        return ContributorAuthorization::Invalid;
    };
    if format!("{:x}", Sha256::digest(&bytes)) != manifest.authorization_sha256 {
        return ContributorAuthorization::Invalid;
    }
    let Ok(grant) = serde_json::from_slice::<Value>(&bytes) else {
        return ContributorAuthorization::Invalid;
    };
    if grant["schema"] == 1
        && grant["data_authorized"] == true
        && grant["revocable"] == true
        && grant["split"] == "development"
        && grant["repositories"]
            .as_array()
            .is_some_and(|repositories| {
                repositories
                    .iter()
                    .any(|repository| repository.as_str() == Some(&manifest.repository_identity))
            })
    {
        ContributorAuthorization::Authorized
    } else {
        ContributorAuthorization::Invalid
    }
}

fn bounded_read(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || metadata.len() > limit as u64 {
        return Err(format!(
            "unsafe or oversized Oh My Diff file: {}",
            path.display()
        ));
    }
    std::fs::read(path).map_err(|error| error.to_string())
}

pub(crate) fn compact_status() -> String {
    let mode = match effective_mode() {
        Ok(mode) if mode.mode == codex_omd::RuntimeMode::UpstreamDirect => {
            return "Oh My Diff · upstream-style direct · hooks off".to_string();
        }
        Ok(mode) => mode,
        Err(error) => return format!("Oh My Diff · invalid mode · {error}"),
    };
    if mode.mode == codex_omd::RuntimeMode::Platform {
        let active = mod_status().and_then(|status| status["mods"].as_array().map(Vec::len));
        return match active {
            Some(count) => format!(
                "Oh My Diff · platform only · {count} active mod{} · task hooks off",
                if count == 1 { "" } else { "s" }
            ),
            None => "Oh My Diff · platform only · mod status unavailable · task hooks off".into(),
        };
    }
    let status = (|| {
        let path = std::env::var_os(MANIFEST_ENV).map(PathBuf::from)?;
        let manifest: Manifest = serde_json::from_slice(&bounded_read(&path, 65_536).ok()?).ok()?;
        let checkpoint: Checkpoint = serde_json::from_slice(
            &bounded_read(&manifest.evidence.join("checkpoint.json"), 65_536).ok()?,
        )
        .ok()?;
        Some(format!(
            "Oh My Diff · {} · {} · {}/{} req · Contributor {}",
            mode.mode.label(),
            checkpoint.task_status,
            checkpoint.allowance.requests_consumed,
            checkpoint
                .allowance
                .requests_consumed
                .saturating_add(checkpoint.allowance.requests_remaining),
            match if manifest.capabilities.delegation {
                authorization_state(&manifest)
            } else {
                ContributorAuthorization::Disabled
            } {
                ContributorAuthorization::Authorized => "on",
                ContributorAuthorization::Revoked => "revoked",
                ContributorAuthorization::Invalid => "blocked",
                ContributorAuthorization::Disabled => "off",
            }
        ))
    })();
    status.unwrap_or_else(|| "Oh My Diff · enabled · unavailable".to_string())
}

pub(crate) fn revoke_contributor() -> Result<String, String> {
    let path = std::env::var_os(MANIFEST_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| "Oh My Diff controlled runtime is not active".to_string())?;
    let bytes = bounded_read(&path, 65_536)?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let destination = manifest.evidence.join(REVOCATION_FILE);
    if destination.exists() {
        return Ok("Contributor authorization was already revoked".to_string());
    }
    let marker = serde_json::to_vec(&serde_json::json!({
        "schema": 1,
        "revoked": true,
        "unix_millis": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis(),
        "source": "Oh My Diff inspector"
    }))
    .map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|error| error.to_string())?;
    file.write_all(&marker).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    OpenOptions::new()
        .read(true)
        .open(&manifest.evidence)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())?;
    Ok("Contributor authorization revoked; future dispatches are blocked".to_string())
}

pub(crate) fn highlight_selection(buffer: &mut Buffer, selection: MouseSelection) {
    if !selection.dragged {
        return;
    }
    let positions = selection_positions(buffer, selection).collect::<Vec<_>>();
    for position in positions {
        if let Some(cell) = buffer.cell_mut(position) {
            cell.modifier.insert(Modifier::REVERSED);
        }
    }
}

pub(crate) fn selected_text(buffer: &Buffer, selection: MouseSelection) -> String {
    let mut lines = Vec::new();
    let mut current_y = None;
    let mut line = String::new();
    for position in selection_positions(buffer, selection) {
        if current_y.is_some_and(|y| y != position.y) {
            lines.push(line.trim_end().to_string());
            line.clear();
        }
        current_y = Some(position.y);
        if let Some(cell) = buffer.cell(position) {
            line.push_str(cell.symbol());
        }
    }
    if current_y.is_some() {
        lines.push(line.trim_end().to_string());
    }
    lines.join("\n")
}

fn selection_positions(
    buffer: &Buffer,
    selection: MouseSelection,
) -> impl Iterator<Item = Position> + '_ {
    let (start, end) = ordered(selection.anchor, selection.head);
    let area = buffer.area;
    (start.y..=end.y).flat_map(move |y| {
        let left = if y == start.y { start.x } else { area.left() };
        let right = if y == end.y {
            end.x
        } else {
            area.right().saturating_sub(1)
        };
        (left..=right).filter_map(move |x| {
            area.contains(Position::new(x, y))
                .then_some(Position::new(x, y))
        })
    })
}

fn ordered(first: Position, second: Position) -> (Position, Position) {
    if (first.y, first.x) <= (second.y, second.x) {
        (first, second)
    } else {
        (second, first)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;
    use ratatui::text::Line;
    use serial_test::serial;
    use tempfile::TempDir;

    struct EnvGuard {
        name: &'static str,
        original: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn set(name: &'static str, value: Option<&str>) -> Self {
            let original = std::env::var_os(name);
            match value {
                Some(value) => unsafe { std::env::set_var(name, value) },
                None => unsafe { std::env::remove_var(name) },
            }
            Self { name, original }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(value) => unsafe { std::env::set_var(self.name, value) },
                None => unsafe { std::env::remove_var(self.name) },
            }
        }
    }

    fn runtime_fixture(root: &TempDir) -> PathBuf {
        let evidence = root.path().join("evidence");
        std::fs::create_dir(&evidence).unwrap();
        let authorization = root.path().join("authorization.json");
        let grant = serde_json::to_vec(&serde_json::json!({
            "schema": 1,
            "data_authorized": true,
            "revocable": true,
            "split": "development",
            "repositories": ["fixture"]
        }))
        .unwrap();
        std::fs::write(&authorization, &grant).unwrap();
        std::fs::write(
            evidence.join("checkpoint.json"),
            serde_json::to_vec(&serde_json::json!({
                "task_status": "active",
                "workers": [{"id": "live"}],
                "archived_workers": 1,
                "allowance": {
                    "requests_consumed": 2,
                    "requests_remaining": 3,
                    "exposure_consumed_microusd": 10,
                    "exposure_remaining_microusd": 20
                }
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            evidence.join("00000001.json"),
            serde_json::to_vec(&serde_json::json!({
                "record": {"event": "worker_archived"}
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            evidence.join("effective-settings.json"),
            serde_json::to_vec(&serde_json::json!({
                "direct_single_agent": false,
                "selected_capabilities": ["delegation", "checkpoints", "terminal"]
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            evidence.join("task-cost.json"),
            serde_json::to_vec(&serde_json::json!({
                "settled_task_charge_microusd": 7,
                "retained_exposure_upper_bound_microusd": 10,
                "raw_usage_attempts": 2
            }))
            .unwrap(),
        )
        .unwrap();
        let manifest = root.path().join("manifest.json");
        std::fs::write(
            &manifest,
            serde_json::to_vec(&serde_json::json!({
                "evidence": evidence,
                "authorization": authorization,
                "authorization_sha256": format!("{:x}", Sha256::digest(&grant)),
                "repository_identity": "fixture"
            }))
            .unwrap(),
        )
        .unwrap();
        manifest
    }

    #[test]
    fn launch_identity_and_profile_labels_are_bounded() {
        assert_eq!(
            launch_title("0.156.1"),
            "OpenAI Codex | Oh My Diffed (v0.156.1)"
        );
        assert_eq!(
            launch_title("0.156.0"),
            "OpenAI Codex | Oh My Diffed (v0.156.0)"
        );
        assert_eq!(profile_label("full"), "Full OMD");
        assert_eq!(profile_label("platform_only"), "Modding platform only");
        assert_eq!(profile_label("private"), "Private foundation");
        assert_eq!(profile_label("unexpected"), "Unknown");
    }

    #[test]
    fn unicode_input_is_width_preserving() {
        let source = "a === b -> c <= d";
        let visual = visual_input_unicode(source);
        assert_eq!(visual, "a ≡   b →  c ≤  d");
        assert_eq!(Line::from(source).width(), Line::from(visual).width());
        assert_eq!(source, "a === b -> c <= d");
    }

    #[test]
    #[serial]
    fn ascii_fallback_keeps_literal_input() {
        let root = TempDir::new().unwrap();
        let manifest = runtime_fixture(&root);
        let _manifest = EnvGuard::set(MANIFEST_ENV, manifest.to_str());
        let _locale = EnvGuard::set("LC_ALL", Some("en_CA.UTF-8"));
        let _ascii = EnvGuard::set("OMD_TUI_ASCII", Some("1"));
        let _mouse = EnvGuard::set("OMD_TUI_MOUSE", Some("off"));

        assert_eq!(visual_input("=== -> <=").as_ref(), "=== -> <=");
        assert!(!mouse_enabled());
    }

    #[test]
    #[serial]
    fn non_unicode_locale_automatically_uses_ascii() {
        let root = TempDir::new().unwrap();
        let manifest = runtime_fixture(&root);
        let _manifest = EnvGuard::set(MANIFEST_ENV, manifest.to_str());
        let _locale = EnvGuard::set("LC_ALL", Some("C"));
        let _ascii = EnvGuard::set("OMD_TUI_ASCII", None);

        assert_eq!(visual_input("=== -> <=").as_ref(), "=== -> <=");
    }

    #[test]
    #[serial]
    fn active_unicode_mode_is_visual_only() {
        let root = TempDir::new().unwrap();
        let manifest = runtime_fixture(&root);
        let _manifest = EnvGuard::set(MANIFEST_ENV, manifest.to_str());
        let _locale = EnvGuard::set("LC_ALL", Some("en_CA.UTF-8"));
        let _ascii = EnvGuard::set("OMD_TUI_ASCII", None);
        let source = String::from("=== -> <=");

        assert_eq!(visual_input(&source).as_ref(), "≡   →  ≤ ");
        assert_eq!(source, "=== -> <=");
    }

    #[test]
    #[serial]
    fn inspector_snapshot_and_durable_revocation_share_effective_state() {
        let root = TempDir::new().unwrap();
        let manifest = runtime_fixture(&root);
        let _manifest = EnvGuard::set(MANIFEST_ENV, manifest.to_str());

        let before = snapshot().unwrap();
        assert_eq!(before.task_status, "active");
        assert_eq!(before.live_workers, 1);
        assert_eq!(before.archived_workers, 1);
        assert_eq!(before.requests_consumed, 2);
        assert_eq!(before.authorization, ContributorAuthorization::Authorized);
        assert_eq!(before.settled_task_charge_microusd, 7);
        assert_eq!(before.retained_exposure_upper_bound_microusd, 10);
        assert_eq!(before.raw_usage_attempts, 2);
        assert!(
            before
                .selected_capabilities
                .contains(&"terminal".to_string())
        );
        assert_eq!(
            compact_status(),
            "Oh My Diff · OMD enabled · active · 2/5 req · Contributor on"
        );

        assert!(revoke_contributor().unwrap().contains("revoked"));
        assert_eq!(
            snapshot().unwrap().authorization,
            ContributorAuthorization::Revoked
        );
        assert_eq!(
            compact_status(),
            "Oh My Diff · OMD enabled · active · 2/5 req · Contributor revoked"
        );
        assert!(root.path().join("evidence").join(REVOCATION_FILE).is_file());
        assert!(revoke_contributor().unwrap().contains("already revoked"));
    }

    #[test]
    #[serial]
    fn explicit_direct_mode_is_visible_and_disables_omd_presentation_hooks() {
        let _mode = EnvGuard::set(MODE_ENV, Some("upstream_direct"));
        let _manifest = EnvGuard::set(MANIFEST_ENV, None);
        let _locale = EnvGuard::set("LC_ALL", Some("en_CA.UTF-8"));

        assert!(!is_active());
        assert!(!ligatures_enabled());
        assert!(!mouse_enabled());
        assert_eq!(visual_input("=== -> <=").as_ref(), "=== -> <=");
        assert_eq!(
            compact_status(),
            "Oh My Diff · upstream-style direct · hooks off"
        );
        let details = direct_mode_details(effective_mode().unwrap()).join("\n");
        assert!(details.contains("Install profile"));
        assert!(details.contains(codex_omd::PINNED_UPSTREAM));
        assert!(details.contains("Disabled before extension registration"));
        assert!(details.contains("upstream executable not restored"));
        assert!(details.contains("supported uninstall/return path"));
    }

    #[test]
    #[serial]
    fn platform_mode_exposes_mod_controls_without_task_presentation() {
        let root = TempDir::new().unwrap();
        let store = root.path().canonicalize().unwrap();
        std::fs::write(
            store.join("mod-status.json"),
            serde_json::json!({"mods":[{"id":"fixture"}],"rejected":[]}).to_string(),
        )
        .unwrap();
        let _mode = EnvGuard::set(MODE_ENV, Some("platform"));
        let _manifest = EnvGuard::set(MANIFEST_ENV, None);
        let _store = EnvGuard::set(codex_omd::MOD_STORE_ENV, store.to_str());

        assert!(!is_active());
        assert!(terminal_active());
        assert!(!graph_active());
        assert_eq!(mod_paths().unwrap().store, Some(store));
        assert_eq!(
            compact_status(),
            "Oh My Diff · platform only · 1 active mod · task hooks off"
        );
    }

    #[test]
    #[serial]
    fn enabled_mode_respects_independent_terminal_and_graph_switches() {
        let root = TempDir::new().unwrap();
        let manifest_path = runtime_fixture(&root);
        let mut value: Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        value["capabilities"] = serde_json::json!({
            "delegation": false,
            "code_graph": false,
            "terminal": false
        });
        std::fs::write(&manifest_path, serde_json::to_vec(&value).unwrap()).unwrap();
        let _mode = EnvGuard::set(MODE_ENV, Some("enabled"));
        let _manifest = EnvGuard::set(MANIFEST_ENV, manifest_path.to_str());
        let _locale = EnvGuard::set("LC_ALL", Some("en_CA.UTF-8"));

        assert!(is_active());
        assert!(!terminal_active());
        assert!(!graph_active());
        assert!(!ligatures_enabled());
        assert!(!mouse_enabled());
        assert!(
            load_graph(root.path())
                .unwrap_err()
                .contains("capability is disabled")
        );
        assert_eq!(
            snapshot().unwrap().authorization,
            ContributorAuthorization::Disabled
        );
        assert_eq!(
            compact_status(),
            "Oh My Diff · OMD enabled · active · 2/5 req · Contributor off"
        );
    }

    #[test]
    #[serial]
    fn direct_mode_refuses_a_leaked_controlled_manifest() {
        let _mode = EnvGuard::set(MODE_ENV, Some("upstream_direct"));
        let _manifest = EnvGuard::set(MANIFEST_ENV, Some("unexpected.json"));

        assert!(!is_active());
        assert!(compact_status().contains("upstream_direct forbids OMD_CONTROLLED_MANIFEST"));
    }

    #[test]
    fn linear_selection_copies_and_highlights_visible_cells() {
        let mut buffer = Buffer::with_lines(["alpha", "beta "]);
        let selection = MouseSelection {
            anchor: Position::new(2, 0),
            head: Position::new(1, 1),
            dragged: true,
        };
        assert_eq!(selected_text(&buffer, selection), "pha\nbe");
        highlight_selection(&mut buffer, selection);
        assert!(buffer[(2, 0)].modifier.contains(Modifier::REVERSED));
        assert!(!buffer[(0, 0)].modifier.contains(Modifier::REVERSED));
        assert_eq!(buffer.area, Rect::new(0, 0, 5, 2));
    }

    #[test]
    #[serial]
    fn graph_loader_accepts_fresh_data_and_rejects_stale_sources() {
        let root = TempDir::new().unwrap();
        let manifest = runtime_fixture(&root);
        let _manifest = EnvGuard::set(MANIFEST_ENV, manifest.to_str());
        std::fs::write(root.path().join("lib.rs"), "pub fn entry() {}\n").unwrap();
        let graph = codex_omd::CodeGraph::build(
            root.path(),
            "fixture/repository".to_string(),
            "fixture-revision".to_string(),
            codex_omd::GraphLimits::default(),
        )
        .unwrap();
        std::fs::create_dir(root.path().join(".omd")).unwrap();
        graph
            .write(&root.path().join(".omd/code-graph.json"))
            .unwrap();
        assert_eq!(
            load_graph(root.path()).unwrap().0.repository.revision,
            "fixture-revision"
        );
        std::fs::write(root.path().join("lib.rs"), "pub fn changed() {}\n").unwrap();
        assert!(load_graph(root.path()).unwrap_err().contains("stale"));
    }
}
