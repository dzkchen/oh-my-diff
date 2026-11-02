use serde::Deserialize;
use std::path::Path;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, default)]
pub struct ModLimits {
    pub watches_per_mod: usize,
    pub paths_per_watch: usize,
    pub timers_per_mod: usize,
    pub pty_panes_per_mod: usize,
    pub completion_items: usize,
}

impl Default for ModLimits {
    fn default() -> Self {
        Self {
            watches_per_mod: 16,
            paths_per_watch: 32,
            timers_per_mod: 16,
            pty_panes_per_mod: 4,
            completion_items: 200,
        }
    }
}

impl ModLimits {
    pub fn bounded(self) -> Self {
        Self {
            watches_per_mod: self.watches_per_mod.clamp(1, 64),
            paths_per_watch: self.paths_per_watch.clamp(1, 256),
            timers_per_mod: self.timers_per_mod.clamp(1, 64),
            pty_panes_per_mod: self.pty_panes_per_mod.clamp(1, 16),
            completion_items: self.completion_items.clamp(1, 1000),
        }
    }

    pub fn read(store: &Path) -> Self {
        std::fs::read(store.join("host.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|config| serde_json::from_value::<Self>(config["mod_limits"].clone()).ok())
            .unwrap_or_default()
            .bounded()
    }
}
