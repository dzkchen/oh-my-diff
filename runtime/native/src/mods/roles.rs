use super::*;
use codex_extension_api::AgentRoleContributor;
use codex_extension_api::ContributedAgentRole;
use codex_omd::ModAgentDefinition;
use std::collections::BTreeSet;

const PLAN_PREFIX: &str = "omd-agent-";

pub(super) struct AgentTools(pub(super) BTreeSet<String>);

#[derive(Clone, Deserialize, Serialize)]
struct Plan {
    definition: Option<String>,
    cwd: Option<std::path::PathBuf>,
    tools: Option<Vec<String>>,
}

pub(super) fn is_spawn(tool: &ToolName) -> bool {
    tool.name == "spawn_agent"
}

fn agents_dir(host: &Host) -> std::path::PathBuf {
    host.root.join("agents")
}

fn write_once(path: &std::path::Path, text: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    let parent = path.parent().ok_or("agent_role_path_invalid")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    codex_omd::fsio::write_bytes(path, text.as_bytes(), codex_omd::fsio::Durability::Durable)
        .map_err(|e| e.to_string())
}

impl Core {
    pub(super) fn definition(&self, name: &str) -> Option<ModAgentDefinition> {
        let (owner, short) = name.split_once('/')?;
        self.expansion
            .definitions
            .lock()
            .ok()?
            .iter()
            .find(|definition| definition.owner == owner && definition.agent.name == short)
            .cloned()
    }

    fn role_file(
        &self,
        lead: &Lead,
        name: &str,
        description: &str,
        definition: Option<&ModAgentDefinition>,
    ) -> Result<std::path::PathBuf, String> {
        let quote = |text: &str| serde_json::to_string(text).unwrap_or_default();
        let mut lines = vec![
            format!("name = {}", quote(name)),
            format!("description = {}", quote(description)),
        ];
        if let Some(definition) = definition {
            lines.push(format!(
                "developer_instructions = {}",
                quote(&format!(
                    "Agent definition {}/{} from mod {}; it is subordinate to current user and project instructions.\n{}",
                    definition.owner, definition.agent.name, definition.owner, definition.agent.instructions
                ))
            ));
            let mut effort = definition.agent.effort.clone();
            if let Some(name) = &definition.agent.route {
                let provider = lead
                    .host
                    .accounts
                    .by_thread
                    .lock()
                    .map_err(|_| "account lock poisoned")?
                    .get(&lead.thread.to_string())
                    .map(|account| account.provider.clone());
                let (routing, _) = lead.host.route_config();
                let route = routing
                    .route(name, config::RouteRole::Lead, Some(&definition.owner))
                    .filter(|route| Some(&route.provider) == provider.as_ref())
                    .ok_or_else(|| format!("agent_definition_route_unavailable: {name}"))?;
                lines.push(format!("model = {}", quote(&route.model)));
                effort = effort.or_else(|| {
                    serde_json::to_value(&route.reasoning_effort)
                        .ok()
                        .and_then(|effort| effort.as_str().map(str::to_owned))
                });
            }
            if let Some(effort) = effort {
                lines.push(format!("model_reasoning_effort = {}", quote(&effort)));
            }
        }
        let text = lines.join("\n") + "\n";
        let path = agents_dir(&lead.host)
            .join(format!("{}.toml", &execution::hash(text.as_bytes())[..16]));
        write_once(&path, &text)?;
        Ok(path)
    }

    fn plan(&self, host: &Host, name: &str) -> Option<Plan> {
        let text =
            std::fs::read(agents_dir(host).join("plans").join(format!("{name}.json"))).ok()?;
        serde_json::from_slice(&text).ok()
    }

    pub(super) fn role_tools(&self, host: &Host, name: &str) -> Option<BTreeSet<String>> {
        let (definition, planned) = if name.starts_with(PLAN_PREFIX) {
            let plan = self.plan(host, name)?;
            (
                plan.definition.and_then(|name| self.definition(&name)),
                plan.tools,
            )
        } else {
            (self.definition(name), None)
        };
        let defined = definition.and_then(|definition| definition.agent.tools);
        match (defined, planned) {
            (Some(defined), Some(planned)) => Some(
                planned
                    .into_iter()
                    .filter(|tool| defined.contains(tool))
                    .collect(),
            ),
            (defined, planned) => defined.or(planned).map(|tools| tools.into_iter().collect()),
        }
    }

    pub(super) fn role_definition(&self, host: &Host, name: &str) -> Option<ModAgentDefinition> {
        if name.starts_with(PLAN_PREFIX) {
            return self
                .plan(host, name)?
                .definition
                .and_then(|name| self.definition(&name));
        }
        self.definition(name)
    }

    fn resolve(&self, lead: &Lead, name: &str) -> Result<Option<ContributedAgentRole>, String> {
        let (definition, cwd) = if name.starts_with(PLAN_PREFIX) {
            let plan = self
                .plan(&lead.host, name)
                .ok_or("agent_plan_unavailable")?;
            let definition = match &plan.definition {
                Some(name) => Some(
                    self.definition(name)
                        .ok_or_else(|| format!("agent_definition_unavailable: {name}"))?,
                ),
                None => None,
            };
            if let Some(cwd) = &plan.cwd
                && !std::fs::canonicalize(cwd).is_ok_and(|cwd| {
                    codex_omd::app_routes::session_roots(&lead.host.repository).contains(&cwd)
                })
            {
                return Err("agent_spawn_cwd_outside_session".into());
            }
            (definition, plan.cwd)
        } else if name.contains('/') {
            let definition = self
                .definition(name)
                .ok_or_else(|| format!("agent_definition_unavailable: {name}"))?;
            (Some(definition), None)
        } else {
            return Ok(None);
        };
        let description = definition.as_ref().map_or_else(
            || "Spawn adjusted by a mod interceptor".to_owned(),
            |d| d.agent.description.clone(),
        );
        let config_file = self.role_file(lead, name, &description, definition.as_ref())?;
        let cwd = cwd
            .map(codex_utils_absolute_path::AbsolutePathBuf::try_from)
            .transpose()
            .map_err(|e| e.to_string())?;
        Ok(Some(ContributedAgentRole {
            name: name.to_owned(),
            description,
            config_file,
            cwd,
        }))
    }

    fn offers(&self, lead: &Lead) -> Vec<(String, String)> {
        let offers = self
            .expansion
            .definitions
            .lock()
            .map(|definitions| {
                definitions
                    .iter()
                    .filter(|definition| definition.agent.offer)
                    .map(|definition| {
                        json!({"name": format!("{}/{}", definition.owner, definition.agent.name),
                            "description": definition.agent.description, "owner": definition.owner})
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if offers.is_empty() {
            return Vec::new();
        }
        let required = *self
            .expansion
            .agent_offers
            .lock()
            .ok()
            .as_deref()
            .unwrap_or(&None);
        let offers = match required {
            None => Value::Array(offers),
            Some(required) => {
                let payload = json!({"thread_id": lead.thread.to_string(), "offers": offers});
                let origin = json!({"caller": "engine", "thread_id": lead.thread.to_string()});
                match codex_omd::intercept_shared(
                    &self.runtime,
                    "agent_offers",
                    required,
                    payload,
                    origin,
                    || true,
                    |_, _| {
                        Err(std::io::Error::other(
                            "host_operation_unavailable: agent_offers runs without host operations",
                        ))
                    },
                    |effective| Ok(json!({"offers": effective["offers"]})),
                ) {
                    Ok(chain) => {
                        self.views.diagnostic(&self.host, "agent_offers", None);
                        chain.result["offers"].clone()
                    }
                    Err(error) => {
                        self.views.diagnostic(
                            &self.host,
                            "agent_offers",
                            Some(format!("{error}; no mod agents offered")),
                        );
                        return Vec::new();
                    }
                }
            }
        };
        offers
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|offer| {
                Some((
                    offer["name"].as_str()?.to_owned(),
                    format!(
                        "{} (mod {})",
                        offer["description"].as_str()?,
                        offer["owner"].as_str()?
                    ),
                ))
            })
            .collect()
    }

    pub(super) fn spawn_payload(
        &self,
        lead: &Lead,
        arguments: &Value,
        cwd: &std::path::Path,
    ) -> Value {
        let prompt = match &arguments["message"] {
            Value::String(message) => message.clone(),
            _ => arguments["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        };
        json!({"origin": "model", "caller": "model", "thread_id": lead.thread.to_string(),
            "agent_id": (lead.owner != "lead").then(|| lead.owner.clone()),
            "definition": arguments["agent_type"], "prompt": prompt, "model": arguments["model"],
            "effort": arguments["reasoning_effort"], "cwd": cwd.to_string_lossy(),
            "tools": null})
    }

    pub(super) fn spawn_arguments(
        &self,
        lead: &Lead,
        original: &Value,
        before: &Value,
        effective: &Value,
    ) -> Result<Value, String> {
        let mut arguments = original.clone();
        if effective["prompt"] != before["prompt"] {
            if let Some(object) = arguments.as_object_mut() {
                object.remove("items");
            }
            arguments["message"] = effective["prompt"].clone();
        }
        for (field, key) in [("model", "model"), ("effort", "reasoning_effort")] {
            match &effective[field] {
                Value::Null => {
                    if let Some(object) = arguments.as_object_mut() {
                        object.remove(key);
                    }
                }
                value => arguments[key] = value.clone(),
            }
        }
        spawn_route_admitted(lead, arguments["model"].as_str())?;
        let definition = effective["definition"].as_str();
        if let Some(name) = definition.filter(|name| name.contains('/'))
            && self.definition(name).is_none()
        {
            return Err(format!("unknown_agent_definition: {name}"));
        }
        let cwd = (effective["cwd"] != before["cwd"])
            .then(|| effective["cwd"].as_str().map(std::path::PathBuf::from))
            .flatten();
        if let Some(cwd) = &cwd {
            let allowed = std::fs::canonicalize(cwd).is_ok_and(|cwd| {
                codex_omd::app_routes::session_roots(&self.host.repository).contains(&cwd)
            });
            if !allowed {
                return Err("agent_spawn_cwd_outside_session".into());
            }
        }
        let tools = effective["tools"].as_array().map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        });
        if cwd.is_none() && tools.is_none() {
            match definition {
                Some(name) => arguments["agent_type"] = json!(name),
                None => {
                    if let Some(object) = arguments.as_object_mut() {
                        object.remove("agent_type");
                    }
                }
            }
            return Ok(arguments);
        }
        if definition.is_some_and(|name| !name.contains('/') && name != "default") {
            return Err("agent_spawn_override_requires_definition: express cwd or tool changes as a mod agent definition".into());
        }
        let plan = Plan {
            definition: definition
                .filter(|name| name.contains('/'))
                .map(str::to_owned),
            cwd,
            tools,
        };
        let text = serde_json::to_string(&plan).map_err(|e| e.to_string())?;
        let name = format!("{PLAN_PREFIX}{}", &execution::hash(text.as_bytes())[..16]);
        write_once(
            &agents_dir(&lead.host)
                .join("plans")
                .join(format!("{name}.json")),
            &text,
        )?;
        arguments["agent_type"] = json!(name);
        Ok(arguments)
    }
}

pub(super) fn spawn_result(result: &Value) -> Value {
    let output = result["output"].as_str().unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(output).unwrap_or(Value::Null);
    let agent_id = parsed["agent_id"]
        .as_str()
        .or(parsed["task_name"].as_str())
        .filter(|_| result["success"] == true);
    json!({"agent_id": agent_id, "output": output, "success": result["success"]})
}

impl AgentRoleContributor for Mods {
    fn offered_agent_roles(&self, thread_store: &ExtensionData) -> Vec<ContributedAgentRole> {
        let Some(lead) = thread_store.get::<Lead>() else {
            return Vec::new();
        };
        self.offers(&lead)
            .into_iter()
            .filter_map(|(name, description)| {
                let definition = self.definition(&name)?;
                match self.role_file(&lead, &name, &description, Some(&definition)) {
                    Ok(config_file) => Some(ContributedAgentRole {
                        name,
                        description,
                        config_file,
                        cwd: None,
                    }),
                    Err(error) => {
                        self.views
                            .diagnostic(&self.host, &format!("agent:{name}"), Some(error));
                        None
                    }
                }
            })
            .collect()
    }

    fn resolve_agent_role(
        &self,
        thread_store: &ExtensionData,
        name: &str,
    ) -> Option<ContributedAgentRole> {
        let lead = thread_store.get::<Lead>()?;
        match self.resolve(&lead, name) {
            Ok(role) => role,
            Err(error) => {
                self.views
                    .diagnostic(&self.host, &format!("agent:{name}"), Some(error));
                None
            }
        }
    }
}

pub(super) fn spawn_capacity_admitted(
    inventory: &super::inventory::Inventory,
    lead: &Lead,
    call_id: &str,
) -> Result<(), String> {
    let tracked_as_workers = lead
        .host
        .accounts
        .by_thread
        .lock()
        .map_err(|_| "account lock poisoned")?
        .iter()
        .filter(|(_, account)| crate::provider_worker(&account.owner))
        .map(|(thread, _)| thread.clone())
        .collect::<std::collections::BTreeSet<_>>();
    inventory.reserve_spawn(
        &inventory.root_thread(&lead.thread.to_string()),
        call_id,
        |thread| !tracked_as_workers.contains(thread),
        |live| {
            lead.session
                .task
                .admit_subagent(lead.depth.saturating_add(1), live)
                .map_err(|error| error.to_string())
        },
    )
}

pub(super) fn spawn_route_admitted(lead: &Lead, model: Option<&str>) -> Result<(), String> {
    let Some((provider, _)) = model.and_then(codex_models_manager::runtime_models::find) else {
        return Ok(());
    };
    let parent = lead
        .host
        .accounts
        .by_thread
        .lock()
        .map_err(|_| "account lock poisoned")?
        .get(&lead.thread.to_string())
        .map(|account| account.provider.clone());
    if parent.as_deref() == Some(provider.as_str())
        || lead
            .host
            .provider_lead_route(&provider, model.unwrap_or_default())
            .is_some()
    {
        return Ok(());
    }
    Err(format!(
        "agent_route_unavailable: {} has no lead route on provider {provider}",
        model.unwrap_or_default()
    ))
}
