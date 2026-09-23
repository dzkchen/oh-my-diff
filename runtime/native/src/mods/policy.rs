use super::*;
use codex_protocol::models::PermissionProfile;
use codex_protocol::models::PermissionProfileSnapshot;
use codex_protocol::permissions::FileSystemAccessMode;
use codex_protocol::permissions::FileSystemPath;
use codex_protocol::permissions::FileSystemSandboxEntry;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use codex_utils_absolute_path::AbsolutePathBuf;

fn mod_provenance(runtime: &codex_omd::ModHost, id: &str) -> Value {
    let owner = runtime
        .owners()
        .into_iter()
        .find_map(|(candidate, owner)| (candidate == id).then_some(owner));
    json!({
        "owner": owner,
        "configuration_sha256": runtime.configuration_sha256(),
        "generation": runtime.generation(),
    })
}

fn native_worker_context(owner: &Host) -> PolicySelection {
    PolicySelection {
        policy: "native_fallback".into(),
        value: owner.manifest.context_policy.name().as_str().into(),
        provenance: json!({"owner": codex_omd::PolicyOwner::bundled()}),
    }
}

pub(super) fn refresh_worker_context(
    runtime: &mut codex_omd::ModHost,
    owner: &Host,
) -> Option<String> {
    let fallback = native_worker_context(owner);
    let available = owner.available_worker_contexts();
    let active = owner
        .worker_context
        .lock()
        .map(|selection| selection.value.clone())
        .unwrap_or_else(|_| fallback.value.clone());
    let payload = json!({
        "available": available,
        "native_fallback": owner.manifest.context_policy.name(),
        "active": active,
    });
    let mut selected = None;
    let mut diagnostic = None;
    for (id, result) in runtime.event("worker_context", payload) {
        match result {
            Ok(value) if value.is_null() => {}
            Ok(value) => {
                let parsed = value["mode"]
                    .as_str()
                    .and_then(|mode| serde_json::from_value::<WorkerContextName>(json!(mode)).ok());
                match parsed.filter(|mode| available.contains(mode)) {
                    Some(mode) if selected.is_none() => {
                        selected = Some(PolicySelection {
                            policy: "mod".into(),
                            value: mode.as_str().into(),
                            provenance: mod_provenance(runtime, &id),
                        });
                    }
                    Some(_) => diagnostic = Some("mod_worker_context_conflict".into()),
                    None => {
                        diagnostic = Some(format!(
                            "mod_worker_context_not_configured: {id}; native fallback retained"
                        ));
                    }
                }
            }
            Err(error) => {
                diagnostic = Some(format!(
                    "mod_worker_context_failed: {id}: {error}; native fallback retained"
                ));
            }
        }
    }
    if let Ok(mut current) = owner.worker_context.lock() {
        *current = selected.unwrap_or(fallback);
    } else {
        diagnostic = Some("worker_context_lock_poisoned".into());
    }
    diagnostic
}

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
        let choices = [LeadName::Sol, LeadName::Astra];
        let routes = choices.iter().map(|name| {
            let route = self.owner.route(*name);
            json!({"name":name,"model":route.model,"provider":route.provider,"reasoning":route.reasoning_effort})
        }).collect::<Vec<_>>();
        let acquired = match self.runtime.try_lock() {
            Ok(runtime) => Some(runtime),
            Err(std::sync::TryLockError::Poisoned(_)) => return Err("mod_runtime_poisoned".into()),
            Err(std::sync::TryLockError::WouldBlock) => None,
        };
        let Some(mut runtime) = acquired else {
            self.views
                .diagnostic(&self.owner, "compaction_prompt", None);
            return Ok(());
        };
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
        let entry = choices.iter().copied().find(|name| {
            let route = self.owner.route(*name);
            config.model.as_deref() == Some(route.model.as_str())
                && config.model_provider_id == route.provider
                && config.model_reasoning_effort.as_ref() == Some(&route.reasoning_effort)
        });
        let native = match self.owner.manifest.lead_policy {
            LeadPolicy::Fixed { lead } => ("fixed", Some(lead)),
            LeadPolicy::TaskEntry => ("task_entry", entry),
        };
        let values = runtime.event(
            "routing",
            json!({
                "routes":routes,
                "model":config.model,
                "provider":config.model_provider_id,
                "reasoning":config.model_reasoning_effort,
                "native_fallback":{"policy":native.0,"route":native.1},
            }),
        );
        let mut selected: Option<(LeadName, String, String)> = None;
        let mut routing_diagnostic = None;
        for (id, result) in values {
            let value = match result {
                Ok(value) => value,
                Err(error) => {
                    routing_diagnostic = Some(format!(
                        "mod_routing_failed: {id}: {error}; native fallback retained"
                    ));
                    continue;
                }
            };
            if value.is_null() {
                continue;
            }
            if selected.is_some() {
                routing_diagnostic = Some("mod_routing_conflict; native fallback retained".into());
                selected = None;
                break;
            }
            let (name, policy) = if let Some(name) = value.as_str() {
                (
                    serde_json::from_value(json!(name)).map_err(|e| e.to_string())?,
                    "fixed".to_owned(),
                )
            } else {
                let object = value.as_object().ok_or("invalid_routing_decision")?;
                if object.len() != 2 {
                    return Err("invalid_routing_decision".into());
                }
                let name = serde_json::from_value(
                    object
                        .get("route")
                        .cloned()
                        .ok_or("invalid_routing_decision")?,
                )
                .map_err(|e| e.to_string())?;
                let policy = object
                    .get("policy")
                    .and_then(Value::as_str)
                    .filter(|policy| ["fixed", "task_entry"].contains(policy))
                    .ok_or("invalid_routing_decision")?
                    .to_owned();
                (name, policy)
            };
            if !choices.contains(&name) || policy == "task_entry" && entry != Some(name) {
                routing_diagnostic = Some(format!(
                    "mod_route_not_authorized: {id}; native fallback retained"
                ));
                continue;
            }
            selected = Some((name, policy, id));
        }
        if let Some((name, policy, id)) = selected {
            let route = self.owner.route(name);
            config.model = Some(route.model.clone());
            config.model_provider_id = route.provider.clone();
            config.model_provider = config
                .model_providers
                .get(&route.provider)
                .cloned()
                .ok_or("configured_provider_missing")?;
            config.model_reasoning_effort = Some(route.reasoning_effort.clone());
            if let Ok(mut active) = self.owner.lead_routing.lock() {
                *active = PolicySelection {
                    policy,
                    value: name.as_str().into(),
                    provenance: mod_provenance(&runtime, &id),
                };
            }
        } else if let Ok(mut active) = self.owner.lead_routing.lock() {
            *active = PolicySelection {
                policy: native.0.into(),
                value: native.1.map(LeadName::as_str).unwrap_or("unmatched").into(),
                provenance: json!({"owner": codex_omd::PolicyOwner::bundled()}),
            };
        }
        let worker_diagnostic = refresh_worker_context(&mut runtime, &self.owner);
        drop(runtime);
        self.views.diagnostic(
            &self.owner,
            "coordination_policy",
            routing_diagnostic.or(worker_diagnostic),
        );
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
