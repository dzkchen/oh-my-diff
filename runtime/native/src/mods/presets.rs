use super::*;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkerPreset {
    pub name: String,
    pub mod_id: String,
    pub route: Route,
    pub tools: Vec<String>,
    pub paid_authorization: Option<PacketReference>,
    pub subscription_authorization: Option<PacketReference>,
}

impl WorkerPreset {
    pub(crate) fn authorization(&self) -> Option<&PacketReference> {
        match (&self.paid_authorization, &self.subscription_authorization) {
            (None, Some(grant)) if self.route.rates.included_subscription => Some(grant),
            (Some(grant), None) if !self.route.rates.included_subscription => Some(grant),
            _ => None,
        }
    }

    pub(crate) fn covers(&self, route: &Route) -> bool {
        self.route.provider == route.provider
            && self.route.model == route.model
            && self.route.reasoning_effort == route.reasoning_effort
            && self.route.responses_url == route.responses_url
    }

    pub(crate) fn validate(&self, manifest: &Manifest) -> Result<(), String> {
        let grant = self
            .authorization()
            .ok_or("worker_preset_billing_grant_mismatch")?;
        if !codex_omd::resource_data::token(&self.name)
            || matches!(self.name.as_str(), "sol" | "astra")
            || !codex_omd::resource_data::token(&self.mod_id)
            || self.route.model.is_empty()
            || self.route.model.len() > 128
            || self.route.provider == "meta"
            || self.route.rates.external_subscription
            || (self.route.rates.reservation_microusd == 0)
                != self.route.rates.included_subscription
            || self.tools.len() > 16
            || self.tools.iter().any(|tool| !read_only_sandbox_tool(tool))
            || grant.path.starts_with(&manifest.repository)
        {
            return Err("worker_preset_invalid".into());
        }
        let url = self
            .route
            .responses_url
            .parse::<http::Uri>()
            .map_err(|_| "worker_preset_url_invalid")?;
        if url.scheme_str() != Some("https")
            || url
                .authority()
                .is_none_or(|authority| authority.as_str().contains('@'))
        {
            return Err("worker_preset_requires_explicit_https_route".into());
        }
        if !accounting::worker_authorized(
            &grant.path,
            &grant.sha256,
            &manifest.repository_identity,
            &self.route.provider,
            &self.route.model,
            &self.route.responses_url,
            self.route.rates.included_subscription,
        ) {
            return Err("worker_grant_missing_changed_or_revoked".into());
        }
        Ok(())
    }
}

pub(crate) fn read_only_sandbox_tool(name: &str) -> bool {
    matches!(
        name,
        "shell"
            | "shell_command"
            | "exec_command"
            | "write_stdin"
            | "web"
            | "web_search"
            | "read"
            | "grep_files"
            | "list_dir"
    )
}

pub(super) fn list(host: &Host, owner: &str) -> Value {
    json!(host.manifest.mod_worker_presets.iter().filter(|preset|preset.mod_id==owner).map(|preset|json!({"name":preset.name,"model":preset.route.model,"provider":preset.route.provider,"reasoning":preset.route.reasoning_effort,"tools":preset.tools,"billing":if preset.route.rates.included_subscription {"included_subscription"} else {"explicit_paid_api_grant"},"available":preset.validate(&host.manifest).is_ok()})).collect::<Vec<_>>())
}
