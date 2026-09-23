use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::io;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "snake_case")]
pub enum ReactiveScope {
    Lead,
    Worker,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "snake_case")]
pub enum ReactiveToolOutcome {
    CompletedHostSuccess,
    CompletedHostFailure,
    Blocked,
    FailedBeforeExecution,
    FailedAfterExecution,
    Aborted,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(tag = "event", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReactiveTrigger {
    ToolFinished {
        tool: String,
        outcome: ReactiveToolOutcome,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReactiveRule {
    pub id: String,
    pub scope: ReactiveScope,
    pub trigger: ReactiveTrigger,
    pub instruction: String,
    pub max_activations: u32,
    pub max_context_reactivations: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReactiveRuleSet {
    pub schema: u32,
    pub version: String,
    pub rules: Vec<ReactiveRule>,
}

#[derive(Clone, Debug, Serialize, Eq, PartialEq)]
pub struct ReactiveActivation {
    pub rule_id: String,
    pub rule_set_version: String,
    pub source: String,
    pub source_sha256: String,
    pub scope: ReactiveScope,
    pub trigger: ReactiveTrigger,
    pub activation: u32,
    pub max_activations: u32,
    pub executed_effects_rolled_back: bool,
    pub retry_started: bool,
    #[serde(skip)]
    instruction: String,
}

#[derive(Clone)]
struct ActiveRule {
    activation: ReactiveActivation,
    remaining_context_reactivations: u32,
}

#[derive(Default)]
struct ReactiveState {
    activations: BTreeMap<String, u32>,
    active: BTreeMap<(String, String), ActiveRule>,
}

pub struct ReactiveRules {
    rule_set: ReactiveRuleSet,
    source: String,
    source_sha256: String,
    state: Mutex<ReactiveState>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::other(message)
}

fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_tool(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':' | b'/')
        })
}

fn valid_instruction(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value.trim() == value
        && !value.contains(['\r', '\n'])
}

impl ReactiveRuleSet {
    pub fn validate(&self) -> io::Result<()> {
        if self.schema != 1 || !valid_token(&self.version) || !(1..=16).contains(&self.rules.len())
        {
            return Err(invalid("invalid reactive rule set"));
        }
        let mut ids = BTreeSet::new();
        let mut matches = BTreeSet::new();
        for rule in &self.rules {
            let ReactiveTrigger::ToolFinished { tool, .. } = &rule.trigger;
            if !valid_token(&rule.id)
                || !ids.insert(rule.id.as_str())
                || !valid_tool(tool)
                || !valid_instruction(&rule.instruction)
                || !(1..=8).contains(&rule.max_activations)
                || rule.max_context_reactivations > 4
                || !matches.insert((rule.scope, rule.trigger.clone()))
            {
                return Err(invalid("invalid or ambiguous reactive rule"));
            }
        }
        if serde_json::to_vec(self)?.len() > 65_536 {
            return Err(invalid("reactive rule set exceeds size limit"));
        }
        Ok(())
    }
}

impl ReactiveActivation {
    pub fn prompt(&self) -> String {
        format!(
            "A scoped reactive rule was activated after the host observed an exact tool outcome. Rule {} from rule set {} at {} with SHA256 {} says: {} This developer-capability guidance is subordinate to current user and project instructions. The triggering call has already reached its recorded outcome; no executed effect was rolled back. This activation does not start a retry. Any follow-up model request or retry remains subject to the shared task allowance and request accounting.",
            self.rule_id, self.rule_set_version, self.source, self.source_sha256, self.instruction
        )
    }

    pub fn context_prompt(&self) -> String {
        format!("Reactivated after a context rebuild: {}", self.prompt())
    }
}

impl ReactiveRules {
    pub fn new(
        rule_set: ReactiveRuleSet,
        source: String,
        source_sha256: String,
    ) -> io::Result<Self> {
        rule_set.validate()?;
        if source.is_empty() || source.len() > 4096 || !valid_sha256(&source_sha256) {
            return Err(invalid("invalid reactive rule provenance"));
        }
        Ok(Self {
            rule_set,
            source,
            source_sha256,
            state: Mutex::new(ReactiveState::default()),
        })
    }

    pub fn rule_set(&self) -> &ReactiveRuleSet {
        &self.rule_set
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn source_sha256(&self) -> &str {
        &self.source_sha256
    }

    pub fn activate(
        &self,
        thread: &str,
        owner: &str,
        trigger: &ReactiveTrigger,
    ) -> io::Result<Option<ReactiveActivation>> {
        if thread.is_empty() || thread.len() > 256 || owner.is_empty() || owner.len() > 256 {
            return Err(invalid("invalid reactive activation identity"));
        }
        let scope = if owner == "lead" {
            ReactiveScope::Lead
        } else {
            ReactiveScope::Worker
        };
        let Some(rule) = self
            .rule_set
            .rules
            .iter()
            .find(|rule| rule.scope == scope && &rule.trigger == trigger)
        else {
            return Ok(None);
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| invalid("reactive rule lock poisoned"))?;
        let count = state.activations.entry(rule.id.clone()).or_default();
        if *count >= rule.max_activations {
            return Ok(None);
        }
        *count += 1;
        let activation = ReactiveActivation {
            rule_id: rule.id.clone(),
            rule_set_version: self.rule_set.version.clone(),
            source: self.source.clone(),
            source_sha256: self.source_sha256.clone(),
            scope: rule.scope,
            trigger: rule.trigger.clone(),
            activation: *count,
            max_activations: rule.max_activations,
            executed_effects_rolled_back: false,
            retry_started: false,
            instruction: rule.instruction.clone(),
        };
        state.active.insert(
            (thread.to_owned(), rule.id.clone()),
            ActiveRule {
                activation: activation.clone(),
                remaining_context_reactivations: rule.max_context_reactivations,
            },
        );
        Ok(Some(activation))
    }

    pub fn context_prompts(&self, thread: &str) -> io::Result<Vec<String>> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| invalid("reactive rule lock poisoned"))?;
        let mut prompts = Vec::new();
        for ((active_thread, _), active) in &mut state.active {
            if active_thread == thread && active.remaining_context_reactivations > 0 {
                active.remaining_context_reactivations -= 1;
                prompts.push(active.activation.context_prompt());
            }
        }
        Ok(prompts)
    }
}
