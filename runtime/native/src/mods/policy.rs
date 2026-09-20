use super::*;
use codex_protocol::models::PermissionProfile;
use codex_protocol::models::PermissionProfileSnapshot;
use codex_protocol::permissions::FileSystemAccessMode;
use codex_protocol::permissions::FileSystemPath;
use codex_protocol::permissions::FileSystemSandboxEntry;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use codex_utils_absolute_path::AbsolutePathBuf;

impl codex_extension_api::ConfigContributor<Config> for Mods {
    fn prepare_thread_config(&self, config: &mut Config) -> Result<(), String> {
        if !self.owner.manifest.mod_secret_refs.is_empty() || self.owner.manifest.mods.is_some() {
            let profile = config.permissions.effective_permission_profile();
            if matches!(profile, PermissionProfile::External { .. }) {
                return Err("mods_require_native_sandbox_for_host_owned_files".into());
            }
            let mut denies = Vec::new();
            for path in self
                .owner
                .manifest
                .mod_secret_refs
                .values()
                .chain(self.owner.manifest.mods.iter())
            {
                if path
                    .canonicalize()
                    .map_err(|_| "secret_reference_unavailable")?
                    != *path
                    || path.starts_with(&self.owner.manifest.repository)
                {
                    return Err("protected_mod_path_must_be_canonical_and_external".into());
                }
                let path =
                    AbsolutePathBuf::from_absolute_path_checked(path).map_err(|e| e.to_string())?;
                denies.push(FileSystemSandboxEntry::new(
                    FileSystemPath::Path { path: path.into() },
                    FileSystemAccessMode::Deny,
                ));
            }
            let mut filesystem = profile.file_system_sandbox_policy();
            filesystem
                .preserve_deny_read_restrictions_from(&FileSystemSandboxPolicy::restricted(denies));
            let protected = PermissionProfile::from_runtime_permissions(
                &filesystem,
                profile.network_sandbox_policy(),
            );
            config
                .permissions
                .shell_environment_policy
                .r#set
                .insert("OMD_CONTROLLED_NARROW_SANDBOX".into(), "1".into());
            config
                .permissions
                .set_permission_profile_from_session_snapshot(PermissionProfileSnapshot::legacy(
                    protected,
                ))
                .map_err(|e| e.to_string())?;
        }
        let choices: Vec<LeadName> = match self.owner.manifest.lead_policy {
            LeadPolicy::Fixed { lead } => vec![lead],
            LeadPolicy::TaskEntry => vec![LeadName::Sol, LeadName::Astra],
        };
        let routes = choices.iter().map(|name| {
            let route = self.owner.route(*name);
            json!({"name":name,"model":route.model,"provider":route.provider,"reasoning":route.reasoning_effort})
        }).collect::<Vec<_>>();
        let mut runtime = self.runtime.lock().map_err(|_| "mod_runtime_poisoned")?;
        let compaction = runtime.event("compaction", json!({"token_limit":config.model_auto_compact_token_limit,"context_window":config.model_context_window}));
        let mut selected_compaction: Option<(String, Option<i64>, Option<String>)> = None;
        for (id, result) in compaction {
            let value = result.map_err(|e| format!("mod_compaction_failed: {id}: {e}"))?;
            if value.is_null() {
                continue;
            }
            if selected_compaction.is_some() {
                return Err("mod_compaction_conflict".into());
            }
            let (limit, prompt) = match &value {
                Value::Number(_) => (
                    Some(value.as_i64().ok_or("invalid_compaction_limit")?),
                    None,
                ),
                Value::Object(object)
                    if !object.is_empty()
                        && object
                            .keys()
                            .all(|key| key == "threshold" || key == "prompt") =>
                {
                    let limit = object
                        .get("threshold")
                        .map(|limit| limit.as_i64().ok_or("invalid_compaction_limit"))
                        .transpose()?;
                    let prompt = object
                        .get("prompt")
                        .map(|prompt| {
                            prompt
                                .as_str()
                                .filter(|prompt| {
                                    !prompt.trim().is_empty()
                                        && prompt.len() <= 16_384
                                        && !prompt
                                            .chars()
                                            .any(|c| c.is_control() && c != '\n' && c != '\t')
                                })
                                .map(str::to_owned)
                                .ok_or("invalid_compaction_prompt")
                        })
                        .transpose()?;
                    (limit, prompt)
                }
                _ => return Err("invalid_compaction_decision".into()),
            };
            if let Some(limit) = limit {
                let ceiling = config
                    .model_auto_compact_token_limit
                    .or(config.model_context_window)
                    .unwrap_or(1_000_000);
                if !(256..=ceiling).contains(&limit) {
                    return Err("compaction_limit_outside_host_bounds".into());
                }
                config.model_auto_compact_token_limit = Some(limit);
            }
            selected_compaction = Some((id, limit, prompt));
        }
        let values = runtime.event("routing", json!({"routes":routes,"model":config.model,"provider":config.model_provider_id,"reasoning":config.model_reasoning_effort}));
        let mut selected = None;
        for (id, result) in values {
            let value = result.map_err(|e| format!("mod_routing_failed: {id}: {e}"))?;
            if value.is_null() {
                continue;
            }
            if selected.is_some() {
                return Err("mod_routing_conflict".into());
            }
            let name: LeadName = serde_json::from_value(value).map_err(|e| e.to_string())?;
            if !choices.contains(&name) {
                return Err("route_not_authorized_by_selected_policy".into());
            }
            selected = Some(name);
        }
        if let Some(name) = selected {
            let route = self.owner.route(name);
            config.model = Some(route.model.clone());
            config.model_provider_id = route.provider.clone();
            config.model_provider = config
                .model_providers
                .get(&route.provider)
                .cloned()
                .ok_or("configured_provider_missing")?;
            config.model_reasoning_effort = Some(route.reasoning_effort.clone());
        }
        drop(runtime);
        let key = "compaction_prompt";
        match selected_compaction {
            Some((id, _, Some(prompt))) => {
                let remote = codex_model_provider::create_model_provider(
                    config.model_provider.clone(),
                    None,
                )
                .capabilities()
                .remote_compaction;
                if remote == codex_model_provider::RemoteCompactionSupport::Unsupported {
                    config.compact_prompt = Some(prompt);
                    self.views.diagnostic(&self.owner, key, None);
                } else {
                    self.views.diagnostic(
                        &self.owner,
                        key,
                        Some(format!(
                            "{id}: compaction_prompt_unsupported_for_remote_compaction on provider {}; native remote compaction unchanged",
                            config.model_provider_id
                        )),
                    );
                }
            }
            _ => self.views.diagnostic(&self.owner, key, None),
        }
        Ok(())
    }
}
