use crate::accounting::Rates;
use codex_omd::Limits;
use codex_omd::WorkerLimits;
use codex_protocol::openai_models::ReasoningEffort;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

pub(crate) const HOST_CONFIG: &str = "host.json";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Grant {
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, Deserialize, serde::Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RouteRole {
    Lead,
    Worker,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Route {
    pub name: String,
    pub provider: String,
    pub model: String,
    pub reasoning_effort: ReasoningEffort,
    pub responses_url: String,
    pub rates: Rates,
    #[serde(default)]
    pub roles: Vec<RouteRole>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub mods: Vec<String>,
    #[serde(default)]
    pub grant: Option<Grant>,
    #[serde(default)]
    pub credential: Option<String>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ContractSelectionConfig {
    #[serde(default)]
    pub user: Option<PathBuf>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HostConfig {
    #[serde(default = "schema")]
    pub schema: u32,
    #[serde(default = "agent_limits")]
    pub limits: Limits,
    #[serde(default = "worker_limits")]
    pub worker_limits: WorkerLimits,
    #[serde(default)]
    pub routes: Vec<Route>,
    #[serde(default)]
    pub services: Vec<crate::mods::services::Grant>,
    #[serde(default)]
    pub secret_refs: BTreeMap<String, PathBuf>,
    #[serde(default)]
    pub protected: Vec<PathBuf>,
    #[serde(default)]
    pub toolchain_reads: Vec<PathBuf>,
    #[serde(default = "snapshot_bytes")]
    pub snapshot_bytes: usize,
    #[serde(default = "max_request_bytes")]
    pub max_request_bytes: usize,
    #[serde(default)]
    pub approved_untracked: Vec<String>,
    #[serde(default)]
    pub contract: ContractSelectionConfig,
    #[serde(default)]
    pub editor: Vec<String>,
    #[serde(default)]
    pub mod_limits: codex_omd::mod_limits::ModLimits,
}

fn schema() -> u32 {
    1
}

fn agent_limits() -> Limits {
    Limits {
        requests: 400,
        exposure_microusd: 0,
        seconds: 86_400,
        concurrent_workers: 4,
        max_depth: 2,
    }
}

fn worker_limits() -> WorkerLimits {
    WorkerLimits {
        requests: 60,
        exposure_microusd: 0,
        seconds: 1_800,
    }
}

fn snapshot_bytes() -> usize {
    8 * 1024 * 1024
}

fn max_request_bytes() -> usize {
    1024 * 1024
}

fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

impl Default for HostConfig {
    fn default() -> Self {
        Self {
            schema: schema(),
            limits: agent_limits(),
            worker_limits: worker_limits(),
            routes: Vec::new(),
            services: Vec::new(),
            secret_refs: BTreeMap::new(),
            protected: Vec::new(),
            toolchain_reads: Vec::new(),
            snapshot_bytes: snapshot_bytes(),
            max_request_bytes: max_request_bytes(),
            approved_untracked: Vec::new(),
            contract: ContractSelectionConfig::default(),
            editor: Vec::new(),
            mod_limits: Default::default(),
        }
    }
}

impl HostConfig {
    pub(crate) fn load(root: &Path, repository: &Path) -> Result<Self, String> {
        let path = root.join(HOST_CONFIG);
        let config = match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() && metadata.len() <= 262_144 => {
                serde_json::from_slice::<Self>(&std::fs::read(&path).map_err(|e| e.to_string())?)
                    .map_err(|error| format!("invalid {}: {error}", path.display()))?
            }
            Ok(_) => return Err(format!("{HOST_CONFIG} must be a bounded regular file")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(error) => return Err(error.to_string()),
        };
        config.validate(repository)?;
        Ok(config)
    }

    pub(crate) fn validate(&self, repository: &Path) -> Result<(), String> {
        let external = |path: &Path| {
            path.is_absolute()
                && path.canonicalize().ok().as_deref() == Some(path)
                && !path.starts_with(repository)
        };
        let mut names = std::collections::BTreeSet::new();
        if self.schema != 1
            || self.editor.len() > 16
            || self
                .editor
                .iter()
                .any(|arg| arg.is_empty() || arg.len() > 1024)
            || self.routes.len() > 32
            || self.snapshot_bytes == 0
            || self.max_request_bytes == 0
            || self.protected.len() > 32
            || self.approved_untracked.len() > 256
            || self.protected.iter().any(|path| !external(path))
            || self.secret_refs.values().any(|path| !external(path))
            || self.toolchain_reads.iter().any(|path| !path.is_absolute())
            || self
                .contract
                .user
                .as_ref()
                .is_some_and(|path| !path.is_absolute())
        {
            return Err(format!("{HOST_CONFIG} limits or paths are invalid"));
        }
        for route in &self.routes {
            if !name(&route.name)
                || !names.insert(route.name.as_str())
                || route.roles.is_empty()
                || route.provider.is_empty()
                || route.provider.len() > 64
                || route.model.is_empty()
                || route.model.len() > 128
                || route.tools.len() > 16
                || route.mods.len() > 16
                || route.mods.iter().any(|id| !name(id))
                || route
                    .tools
                    .iter()
                    .any(|tool| !crate::mods::read_only_sandbox_tool(tool))
                || route
                    .grant
                    .as_ref()
                    .is_some_and(|grant| !external(&grant.path) || grant.sha256.len() != 64)
                || (route.rates.reservation_microusd == 0) != route.rates.included_subscription
                || route.roles.contains(&RouteRole::Worker) && route.grant.is_none()
            {
                return Err(format!("{HOST_CONFIG} route {} is invalid", route.name));
            }
        }
        Ok(())
    }

    pub(crate) fn route(
        &self,
        name: &str,
        role: RouteRole,
        mod_id: Option<&str>,
    ) -> Option<&Route> {
        self.routes.iter().find(|route| {
            route.name == name
                && route.roles.contains(&role)
                && mod_id
                    .is_none_or(|id| route.mods.is_empty() || route.mods.iter().any(|m| m == id))
        })
    }

    pub(crate) fn routes_for(&self, mod_id: &str) -> Vec<&Route> {
        self.routes
            .iter()
            .filter(|route| route.mods.is_empty() || route.mods.iter().any(|m| m == mod_id))
            .collect()
    }
}
