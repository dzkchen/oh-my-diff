use super::*;
use std::time::Duration;

const INTERCEPTOR_LIMIT: usize = 16;
const ATTEMPT_LIMIT: usize = 3;
const TRACE_LIMIT: usize = 64;
const RESULT_BYTES: usize = 65_536;
const CHAIN_LOG: usize = 16;
pub(super) const REQUIRED_WAIT: Duration = Duration::from_secs(5);
const OPTIONAL_WAIT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModInterceptor {
    pub pattern: String,
    #[serde(rename = "match", default)]
    pub matcher: Value,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub before: Vec<String>,
    #[serde(default)]
    pub after: Vec<String>,
    #[serde(default)]
    pub catch: bool,
    #[serde(default)]
    pub location: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ModChain {
    pub result: Value,
    pub input: Value,
    pub answered_by: Option<String>,
    pub trace: Vec<Value>,
    #[serde(skip)]
    pub reads: BTreeMap<String, BTreeSet<String>>,
}

#[derive(Clone)]
struct Link {
    id: String,
    index: usize,
    required: bool,
    catch: bool,
    location: String,
    matcher: Value,
    generation: u64,
}

pub(super) enum Core<'c> {
    Call(&'c mut dyn FnMut(Value) -> Result<Value>),
    Host { caller: String, generation: u64 },
    Spawn { caller: String, arguments: Value },
    Peer { caller: String, arguments: Value },
}

type HostFn<'h> = dyn FnMut(&str, ModHostCall) -> Result<Value> + 'h;

fn glob(pattern: &str, text: &str) -> bool {
    let parts = pattern.split('*').collect::<Vec<_>>();
    let [first, .., last] = parts.as_slice() else {
        return pattern == text;
    };
    if text.len() < first.len() + last.len() || !text.starts_with(first) || !text.ends_with(last) {
        return false;
    }
    let (mut at, end) = (first.len(), text.len() - last.len());
    parts[1..parts.len() - 1].iter().all(|part| {
        let found = text[at..end].find(part);
        if let Some(found) = found {
            at += found + part.len();
        }
        found.is_some()
    })
}

pub struct SendPolicy {
    pub required: bool,
    pub unavailable: Option<String>,
    pub fingerprint: String,
}

/// Like `selects`, but an expired grant no longer entitles authority surfaces.
fn granted(loaded: &Loaded, pattern: &str, surface: &str) -> bool {
    selects(pattern, surface, &loaded.package.capabilities)
        && (loaded.selection.authority_current()
            || !MOD_INTERCEPT_SURFACES.iter().any(|(name, capability)| {
                *name == surface && AUTHORITY_CAPABILITIES.contains(capability)
            }))
}

pub(super) fn selects(pattern: &str, surface: &str, capabilities: &[String]) -> bool {
    let entitled = MOD_INTERCEPT_SURFACES.iter().any(|(name, capability)| {
        *name == surface && capabilities.iter().any(|granted| granted == capability)
    });
    let (selector, negated) = pattern
        .strip_prefix('!')
        .map_or((pattern, false), |rest| (rest, true));
    entitled && pattern != "!*" && glob(selector, surface) != negated
}

/// A RegExp leaf can only be decided by the runner, so it always passes this filter.
fn may_match(matcher: &Value, value: &Value) -> bool {
    match (matcher, value) {
        (Value::Array(alternatives), _) => alternatives.iter().any(|item| may_match(item, value)),
        (_, Value::Array(items)) => items.iter().any(|item| may_match(matcher, item)),
        (Value::Object(object), _) if object.contains_key("$regex") => {
            !value.is_object() && !value.is_null()
        }
        (Value::Object(object), Value::Object(value)) => object
            .iter()
            .all(|(key, item)| value.get(key).is_some_and(|value| may_match(item, value))),
        (Value::Object(_), _) => false,
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        _ => matcher == value,
    }
}

pub(super) fn validate(interceptors: &[ModInterceptor], capabilities: &[String]) -> Result<()> {
    if interceptors.len() > INTERCEPTOR_LIMIT {
        return Err(failure("interceptor_limit"));
    }
    for interceptor in interceptors {
        let entitled = MOD_INTERCEPT_SURFACES
            .iter()
            .any(|(surface, _)| selects(&interceptor.pattern, surface, capabilities));
        let ordered = interceptor.before.iter().chain(&interceptor.after);
        if !entitled
            || interceptor.pattern.len() > 64
            || serde_json::to_vec(&interceptor.matcher)?.len() > 4096
            || interceptor.before.len() + interceptor.after.len() > 16
            || !ordered.into_iter().all(|id| identifier(id))
            || interceptor.location.len() > 256
        {
            return Err(failure("invalid_interceptor_registration"));
        }
    }
    Ok(())
}

/// Outermost first: explicit `before`/`after`, then consumers outside their dependencies, then ID.
pub(super) fn order(
    loaded: &BTreeMap<String, Loaded>,
) -> std::result::Result<Vec<String>, Vec<String>> {
    let ids = loaded
        .iter()
        .filter(|(_, m)| m.error.is_none() && !m.registrations.interceptors.is_empty())
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    fn height(loaded: &BTreeMap<String, Loaded>, id: &str, depth: usize) -> usize {
        let Some(m) = loaded.get(id).filter(|_| depth < 32) else {
            return 0;
        };
        m.package
            .dependencies
            .iter()
            .map(|dependency| height(loaded, &dependency.id, depth + 1) + 1)
            .max()
            .unwrap_or(0)
    }
    let mut edges = BTreeSet::new();
    for id in &ids {
        for interceptor in &loaded[id].registrations.interceptors {
            for other in interceptor
                .before
                .iter()
                .filter(|other| ids.contains(other))
            {
                edges.insert((id.clone(), other.clone()));
            }
            for other in interceptor.after.iter().filter(|other| ids.contains(other)) {
                edges.insert((other.clone(), id.clone()));
            }
        }
    }
    let mut remaining = ids;
    let mut sorted = Vec::new();
    while !remaining.is_empty() {
        let next = remaining
            .iter()
            .filter(|id| {
                !edges
                    .iter()
                    .any(|(from, to)| to == *id && remaining.contains(from))
            })
            .min_by_key(|id| (std::cmp::Reverse(height(loaded, id, 0)), (*id).clone()))
            .cloned();
        let Some(next) = next else {
            return Err(remaining);
        };
        remaining.retain(|id| *id != next);
        sorted.push(next);
    }
    Ok(sorted)
}

fn validate_input(surface: &str, before: &Value, input: &Value) -> Result<()> {
    let mutable: &[&str] = match surface {
        "tool" => &["tool", "arguments"],
        "host_operation" => &["arguments"],
        "input" => &["text"],
        "model_request" => &["route", "effort", "sections"],
        "response_stream" => &["text", "tool", "arguments"],
        "tool_specs" => &["tools"],
        "command_list" => &["commands"],
        "command" => &["args"],
        "config_list" => &["rows"],
        "config_set" => &["value"],
        "render" => &["props"],
        "agent_offers" => &["offers"],
        "agent_spawn" => &["definition", "prompt", "model", "effort", "cwd", "tools"],
        "peer_send" | "peer_receive" => &["data"],
        _ => &[],
    };
    let (Some(original), Some(object)) = (before.as_object(), input.as_object()) else {
        return Err(failure(format!("invalid_continuation_input: {surface}")));
    };
    let unchanged = original
        .iter()
        .all(|(key, value)| mutable.contains(&key.as_str()) || object.get(key) == Some(value))
        && object.keys().all(|key| original.contains_key(key));
    let typed = match surface {
        "tool" => {
            input["tool"]
                .as_str()
                .is_some_and(|tool| !tool.is_empty() && tool.len() <= 128)
                && (input["arguments"].is_object() || input["arguments"].is_string())
        }
        "input" => input["text"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty() && text.len() <= 61_440),
        "model_request" => {
            input["routes"].as_array().is_some_and(|routes| {
                routes
                    .iter()
                    .any(|route| route["name"] == input["route"] && route["name"].is_string())
            }) && (input["effort"] == before["effort"]
                || !before["effort"].is_null()
                    && input["effort"]
                        .as_str()
                        .is_some_and(|effort| crate::model_request::EFFORTS.contains(&effort)))
                && (input["sections"] == before["sections"]
                    || crate::model_request::valid_sections(
                        &input["sections"],
                        &before["sections"],
                    ))
        }
        "response_stream" => {
            crate::model_request::valid_stream_result(&json!({"chunks": [input]}), before)
        }
        "tool_specs" => tool_specs(&input["tools"], &original["tools"]),
        "command_list" => rows(&input["commands"], &original["commands"], "command"),
        "config_list" => rows(&input["rows"], &original["rows"], "key"),
        "command" => input["args"]
            .as_str()
            .is_some_and(|args| args.len() <= 8192),
        "config_set" => serde_json::to_vec(&input["value"])?.len() <= 65_536,
        "render" => render::valid_input(before, input),
        "host_operation" => {
            input["operation"] != "turns.queue"
                || input["arguments"]["event"] == before["arguments"]["event"]
        }
        "agent_offers" => offers(&input["offers"], &original["offers"]),
        "agent_spawn" => spawn_request(input, before),
        "peer_send" | "peer_receive" => serde_json::to_vec(&input["data"])?.len() <= 65_536,
        _ => true,
    };
    if unchanged && typed {
        Ok(())
    } else {
        Err(failure(format!("invalid_continuation_input: {surface}")))
    }
}

/// Tool specs may drop, defer or re-describe tools they were given, never add or rename one.
fn tool_specs(tools: &Value, given: &Value) -> bool {
    let given = given
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<BTreeSet<_>>();
    let Some(tools) = tools.as_array() else {
        return false;
    };
    let names = tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<BTreeSet<_>>();
    names.len() == tools.len()
        && names.is_subset(&given)
        && tools.iter().all(|tool| {
            tool.as_object().is_some_and(|object| {
                object.keys().all(|key| {
                    ["name", "description", "parameters", "deferred"].contains(&key.as_str())
                })
            }) && tool["description"]
                .as_str()
                .is_some_and(|text| text.chars().count() <= 4096)
                && (tool["parameters"].is_object() || tool["parameters"].is_null())
                && tool["deferred"].is_boolean()
        })
}

/// Agent offers may be dropped or re-described, never added, renamed or reassigned.
fn offers(offers: &Value, given: &Value) -> bool {
    let given = given
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|offer| Some((offer["name"].as_str()?, offer)))
        .collect::<BTreeMap<_, _>>();
    let Some(offers) = offers.as_array() else {
        return false;
    };
    let names = offers
        .iter()
        .filter_map(|offer| offer["name"].as_str())
        .collect::<BTreeSet<_>>();
    names.len() == offers.len()
        && offers.iter().all(|offer| {
            offer["name"]
                .as_str()
                .and_then(|name| given.get(name))
                .is_some_and(|original| {
                    offer.as_object().is_some_and(|object| object.len() == 3)
                        && offer["owner"] == original["owner"]
                        && offer["description"].as_str().is_some_and(|text| {
                            !text.trim().is_empty() && text.chars().count() <= 512
                        })
                })
        })
}

/// Spawn requests keep their shape; tool lists may only narrow.
fn spawn_request(input: &Value, before: &Value) -> bool {
    let text = |value: &Value, limit: usize| {
        value
            .as_str()
            .is_some_and(|text| !text.is_empty() && text.len() <= limit)
    };
    fn names(value: &Value) -> Option<BTreeSet<&str>> {
        value
            .as_array()
            .map(|tools| tools.iter().filter_map(Value::as_str).collect())
    }
    text(&input["prompt"], 61_440)
        && (input["definition"].is_null() || text(&input["definition"], 128))
        && (input["model"].is_null() || text(&input["model"], 128))
        && (input["effort"].is_null()
            || input["effort"]
                .as_str()
                .is_some_and(|effort| crate::model_request::EFFORTS.contains(&effort)))
        && (input["cwd"] == before["cwd"]
            || text(&input["cwd"], 4096) && Path::new(input["cwd"].as_str().unwrap_or("")).is_absolute())
        && match (names(&input["tools"]), names(&before["tools"])) {
            (None, None) => input["tools"].is_null(),
            (Some(tools), None) => {
                tools.len() <= 32 && input["tools"].as_array().is_some_and(|t| t.len() == tools.len())
            }
            (Some(tools), Some(given)) => tools.is_subset(&given),
            (None, Some(_)) => false,
        }
}

/// List rows may be hidden, re-described or hinted, never added, renamed or changed when protected, managed or secret.
fn rows(rows: &Value, given: &Value, key: &str) -> bool {
    let given = given
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| Some((row[key].as_str()?, row)))
        .collect::<BTreeMap<_, _>>();
    let Some(rows) = rows.as_array() else {
        return false;
    };
    let names = rows
        .iter()
        .filter_map(|row| row[key].as_str())
        .collect::<BTreeSet<_>>();
    let text = |value: &Value, limit: usize| {
        value
            .as_str()
            .is_some_and(|text| text.chars().count() <= limit)
    };
    names.len() == rows.len()
        && given.iter().all(|(name, row)| {
            names.contains(name)
                || !(row["protected"] == true || row["managed"] == true || row["secret"] == true)
        })
        && rows.iter().all(|row| {
            let Some(original) = row[key].as_str().and_then(|name| given.get(name)) else {
                return false;
            };
            let fixed = original["protected"] == true
                || original["managed"] == true
                || original["secret"] == true;
            row.as_object()
                .zip(original.as_object())
                .is_some_and(|(row, original)| {
                    row.len() == original.len()
                        && row.iter().all(|(field, value)| match field.as_str() {
                            _ if fixed || original.get(field.as_str()) == Some(value) => {
                                original.get(field.as_str()) == Some(value)
                            }
                            "description" | "label" => text(value, 160),
                            "args_hint" => value.is_null() || text(value, 64),
                            "hidden" => value.is_boolean(),
                            _ => false,
                        })
                })
        })
}

fn validate_result(
    surface: &str,
    result: &Value,
    last: Option<&Value>,
    input: &Value,
) -> Result<()> {
    if last == Some(result) {
        return Ok(());
    }
    let text = |key: &str, limit: usize| {
        result[key]
            .as_str()
            .is_some_and(|text| !text.is_empty() && text.len() <= limit)
    };
    let object = result.as_object();
    let deny = object.is_some_and(|object| object.len() == 1) && text("deny", 512);
    let valid = match surface {
        "tool" => {
            deny || object.is_some_and(|object| {
                result["output"]
                    .as_str()
                    .is_some_and(|output| output.len() <= RESULT_BYTES)
                    && result["success"].is_boolean()
                    && object.keys().all(|key| {
                        ["output", "success", "truncated", "call_id"].contains(&key.as_str())
                    })
            })
        }
        "host_operation" => {
            object.is_some_and(|object| object.len() == 1)
                && (result.get("value").is_some() || text("error", 768))
                && serde_json::to_vec(result)?.len() <= RESULT_BYTES
        }
        "tool_specs" => {
            object.is_some_and(|object| object.len() == 1)
                && last.is_some_and(|last| tool_specs(&result["tools"], &last["tools"]))
        }
        "command_list" => {
            object.is_some_and(|object| object.len() == 1)
                && last.is_some_and(|last| rows(&result["commands"], &last["commands"], "command"))
        }
        "config_list" => {
            object.is_some_and(|object| object.len() == 1)
                && last.is_some_and(|last| rows(&result["rows"], &last["rows"], "key"))
        }
        "command" => {
            deny || object.is_some_and(|object| object.len() == 1)
                && result.get("result").is_some()
                && serde_json::to_vec(result)?.len() <= RESULT_BYTES
        }
        "admission" => {
            let withheld = |value: &Value| {
                value["withhold"].as_array().map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<BTreeSet<_>>()
                })
            };
            let shaped = deny
                || object.is_some_and(|object| object.len() == 1)
                    && result["withhold"].as_array().is_some_and(|items| {
                        items.len() <= 16
                            && items.iter().all(|item| {
                                item.as_str()
                                    .is_some_and(|item| !item.is_empty() && item.len() <= 64)
                            })
                    });
            // An outer handler may only tighten what the chain beneath it decided.
            shaped
                && match last {
                    Some(last) if last.get("deny").is_some() => deny,
                    Some(last) => match withheld(last) {
                        Some(inner) => {
                            deny || withheld(result).is_some_and(|outer| outer.is_superset(&inner))
                        }
                        None => true,
                    },
                    None => true,
                }
        }
        "render" => render::valid_result(result),
        "agent_offers" => {
            object.is_some_and(|object| object.len() == 1)
                && last.is_some_and(|last| offers(&result["offers"], &last["offers"]))
        }
        "agent_spawn" => {
            deny || last.is_some_and(|last| {
                object.is_some_and(|object| {
                    object.keys().all(|key| ["agent_id", "output", "success"].contains(&key.as_str()))
                }) && result["agent_id"] == last["agent_id"]
                    && result["success"] == last["success"]
                    && result["output"]
                        .as_str()
                        .is_some_and(|output| output.len() <= RESULT_BYTES)
            })
        }
        "peer_send" | "peer_receive" => deny,
        "turn_stop" => {
            object.is_some_and(|object| object.len() == 1)
                && result["continue"]
                    .as_str()
                    .is_some_and(|text| !text.trim().is_empty() && text.len() <= 8192)
        }
        "model_request" => deny || last.is_none() && crate::model_request::valid_answer(result),
        "response_stream" => crate::model_request::valid_stream_result(result, input),
        "model_send" => {
            deny || last
                .is_some_and(|last| crate::model_request::valid_send_result(result, last, input))
        }
        _ => deny,
    };
    if valid {
        Ok(())
    } else {
        Err(failure(format!("invalid_interceptor_result: {surface}")))
    }
}

use crate::model_request::bounded;

/// Final-request pages carry provider-bound text, so their records keep only digests.
fn recorded(surface: &str, value: &Value) -> Value {
    if surface == "model_send" {
        let bytes = serde_json::to_vec(value).unwrap_or_default();
        return json!({"sha256": crate::mods::digest(&bytes), "bytes": bytes.len()});
    }
    bounded(value)
}

#[derive(Default)]
struct Attempts {
    count: usize,
    last: Option<std::result::Result<Value, String>>,
    downstream: Duration,
}

struct Chain {
    surface: String,
    links: Vec<Link>,
    original: Value,
    origin: Value,
    effective: Value,
    executed: bool,
    answered_by: Option<String>,
    trace: Vec<Value>,
    reads: BTreeMap<String, BTreeSet<String>>,
}

impl Chain {
    #[allow(clippy::too_many_arguments)]
    fn entry(
        &mut self,
        index: usize,
        link: Option<&Link>,
        outcome: &str,
        attempts: &Attempts,
        elapsed: Duration,
        received: &Value,
        returned: Option<&Value>,
        reason: Option<&str>,
    ) {
        if self.trace.len() >= TRACE_LIMIT {
            return;
        }
        let own = elapsed.saturating_sub(attempts.downstream);
        let mut entry = json!({"index": index, "mod": link.map_or("engine", |link| link.id.as_str()),
            "outcome": outcome, "attempts": attempts.count, "ms": own.as_millis() as u64,
            "received": recorded(&self.surface, received)});
        if let Some(link) = link {
            entry["location"] = json!(link.location);
            entry["required"] = json!(link.required);
        }
        if let Some(returned) = returned {
            entry["returned"] = recorded(&self.surface, returned);
        }
        if let Some(reason) = reason {
            entry["reason"] = json!(reason.chars().take(256).collect::<String>());
        }
        self.trace.push(entry);
    }

    #[allow(clippy::too_many_arguments)]
    fn call(
        &mut self,
        access: &mut Access<'_>,
        host: &mut HostFn<'_>,
        core: &mut Core<'_>,
        active: &dyn Fn() -> bool,
        scope: &InvocationScope,
        k: usize,
        link: &Link,
        payload: Value,
        attempts: &mut Attempts,
    ) -> Result<Value> {
        let wait = if link.required {
            REQUIRED_WAIT
        } else {
            OPTIONAL_WAIT
        };
        invoke(
            &mut access.bounded(wait),
            &link.id,
            link.generation,
            "intercept",
            &link.index.to_string(),
            payload,
            active,
            host,
            &mut |_| {},
            &scope.child(),
            Some(
                &mut |access: &mut Access<'_>, host: &mut HostFn<'_>, input: Value| {
                    attempts.count += 1;
                    if attempts.count > ATTEMPT_LIMIT {
                        return Err(failure("continuation_attempt_limit"));
                    }
                    let (mark, started) = (self.trace.len(), Instant::now());
                    let result = self.link(access, host, core, active, scope, k + 1, input);
                    attempts.downstream += started.elapsed();
                    attempts.last = Some(
                        result
                            .as_ref()
                            .map(Value::clone)
                            .map_err(ToString::to_string),
                    );
                    let trace = self.trace[mark..].to_vec();
                    result.map(|result| json!({"result": result, "trace": trace}))
                },
            ),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn link(
        &mut self,
        access: &mut Access<'_>,
        host: &mut HostFn<'_>,
        core: &mut Core<'_>,
        active: &dyn Fn() -> bool,
        scope: &InvocationScope,
        k: usize,
        input: Value,
    ) -> Result<Value> {
        if !active() {
            return Err(failure("callback_cancelled"));
        }
        if k > 0 {
            validate_input(&self.surface, &self.original, &input)?;
        }
        let started = Instant::now();
        let Some(link) = self.links.get(k).cloned() else {
            self.effective = input.clone();
            let result = match core {
                Core::Call(run) => run(input.clone()),
                Core::Host { caller, generation } => {
                    effective_call(access, host, caller, *generation, &input, active, scope)
                }
                Core::Spawn { caller, arguments } => {
                    spawn_call(access, host, caller, arguments, &input)
                }
                Core::Peer { caller, arguments } => {
                    let mut arguments = arguments.clone();
                    arguments["data"] = input["data"].clone();
                    let call = ModHostCall {
                        operation: "peers.send".into(),
                        arguments,
                    };
                    forward(access, host, caller, call).map(|receipt| json!({"receipt": receipt}))
                }
            };
            self.executed |= result.is_ok();
            let (outcome, error) = match &result {
                Ok(_) => ("returned", None),
                Err(error) => ("rejected", Some(error.to_string())),
            };
            let once = Attempts {
                count: 1,
                ..Attempts::default()
            };
            self.entry(
                k,
                None,
                outcome,
                &once,
                started.elapsed(),
                &input,
                result.as_ref().ok(),
                error.as_deref(),
            );
            return result;
        };
        if !link.matcher.is_null() && !may_match(&link.matcher, &input) {
            return self.link(access, host, core, active, scope, k + 1, input);
        }
        let mut attempts = Attempts::default();
        if scope.contains(&link.id) || self.origin["caller"] == link.id.as_str() {
            self.entry(
                k,
                Some(&link),
                "skipped",
                &attempts,
                Duration::ZERO,
                &input,
                None,
                Some("reentrant"),
            );
            return self.link(access, host, core, active, scope, k + 1, input);
        }
        // A final-request page is read-only, so its original would only repeat the input.
        let original = match self.surface.as_str() {
            "model_send" => Value::Null,
            _ => self.original.clone(),
        };
        let payload = json!({"surface": self.surface, "input": input, "original": original,
            "origin": self.origin});
        let reply = self.call(
            access,
            host,
            core,
            active,
            scope,
            k,
            &link,
            payload.clone(),
            &mut attempts,
        );
        let reads = self.reads.entry(link.id.clone()).or_default();
        if let Ok(reply) = &reply {
            reads.extend(
                reply["reads"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|key| key.as_str().map(str::to_owned)),
            );
        }
        if reply
            .as_ref()
            .is_ok_and(|reply| reply.get("unmatched") == Some(&Value::Bool(true)))
        {
            return self.link(access, host, core, active, scope, k + 1, input);
        }
        let last = |attempts: &Attempts| attempts.last.clone().and_then(std::result::Result::ok);
        let settled = |reply: Result<Value>, attempts: &Attempts, surface: &str| {
            reply.and_then(|reply| {
                let result = reply.get("result").cloned().unwrap_or(Value::Null);
                validate_result(surface, &result, last(attempts).as_ref(), &input)?;
                Ok(result)
            })
        };
        let error = match settled(reply, &attempts, &self.surface) {
            Ok(result) => {
                let outcome = match &attempts.last {
                    Some(Ok(last)) if *last == result => "passed",
                    Some(Ok(_)) => "returned",
                    _ => {
                        self.answered_by.get_or_insert_with(|| link.id.clone());
                        "returned"
                    }
                };
                self.entry(
                    k,
                    Some(&link),
                    outcome,
                    &attempts,
                    started.elapsed(),
                    &input,
                    Some(&result),
                    None,
                );
                return Ok(result);
            }
            Err(error) => error.to_string(),
        };
        if error.starts_with("callback_cancelled") {
            self.entry(
                k,
                Some(&link),
                "rejected",
                &attempts,
                started.elapsed(),
                &input,
                None,
                Some(&error),
            );
            return Err(failure(error));
        }
        let unavailable = [
            "stale_mod_generation",
            "mod_disabled",
            "mod_failed",
            "mod_runtime_busy",
        ]
        .iter()
        .any(|prefix| error.starts_with(prefix));
        if link.catch && !unavailable {
            let mut payload = payload;
            payload["caught"] = json!({
                "error": {"kind": if error.contains("callback_timeout") {"timeout"} else {"throw"}, "message": error},
                "called": attempts.count > 0,
                "result": last(&attempts),
                "error_after_next": attempts.last.clone().and_then(std::result::Result::err),
            });
            let reply = self.call(
                access,
                host,
                core,
                active,
                scope,
                k,
                &link,
                payload,
                &mut attempts,
            );
            if let Ok(result) = settled(reply, &attempts, &self.surface) {
                if !matches!(attempts.last, Some(Ok(_))) {
                    self.answered_by.get_or_insert_with(|| link.id.clone());
                }
                self.entry(
                    k,
                    Some(&link),
                    "caught",
                    &attempts,
                    started.elapsed(),
                    &input,
                    Some(&result),
                    Some(&error),
                );
                return Ok(result);
            }
        }
        if link.required {
            self.entry(
                k,
                Some(&link),
                "rejected",
                &attempts,
                started.elapsed(),
                &input,
                None,
                Some(&error),
            );
            return Err(failure(format!(
                "intercept_required_failed: {}: {error}",
                link.id
            )));
        }
        match attempts.last.clone() {
            Some(Ok(result)) => {
                self.entry(
                    k,
                    Some(&link),
                    "kept",
                    &attempts,
                    started.elapsed(),
                    &input,
                    Some(&result),
                    Some(&error),
                );
                Ok(result)
            }
            // A render hook that passed `next` invalid props falls back to what it received.
            Some(Err(downstream))
                if self.surface != "render"
                    || !downstream.starts_with("invalid_continuation_input") =>
            {
                self.entry(
                    k,
                    Some(&link),
                    "rejected",
                    &attempts,
                    started.elapsed(),
                    &input,
                    None,
                    Some(&error),
                );
                Err(failure(downstream))
            }
            _ => {
                self.entry(
                    k,
                    Some(&link),
                    "skipped",
                    &attempts,
                    started.elapsed(),
                    &input,
                    None,
                    Some(&error),
                );
                self.link(access, host, core, active, scope, k + 1, input)
            }
        }
    }
}

fn effective_call(
    access: &mut Access<'_>,
    host: &mut HostFn<'_>,
    caller: &str,
    generation: u64,
    input: &Value,
    active: &dyn Fn() -> bool,
    scope: &InvocationScope,
) -> Result<Value> {
    let call = ModHostCall {
        operation: input["operation"].as_str().unwrap_or_default().to_owned(),
        arguments: input["arguments"].clone(),
    };
    let (granted, withheld) = access.with(|runtime| {
        Ok(runtime
            .loaded
            .get(caller)
            .map(|loaded| (loaded.package.capabilities.clone(), loaded.withheld.clone()))
            .unwrap_or_default())
    })?;
    let namespace = crate::mods::host_namespace(&call.operation, &call.arguments);
    if withheld
        .iter()
        .any(|pattern| crate::mods::namespace_matches(pattern, &namespace))
    {
        return Err(failure(format!("capability_withheld: {namespace}")));
    }
    if let Some(missing) = call
        .capabilities()?
        .into_iter()
        .find(|capability| !granted.iter().any(|granted| granted == capability))
    {
        return Err(failure(format!("capability_denied: {missing}")));
    }
    dispatch(access, host, caller, generation, call, active, scope)
        .map(|value| json!({"value": value}))
}

/// A redacted receipt for structured access: origin and path without query, root, server or names, never bodies or values.
pub fn access_receipt(
    caller: &str,
    call: &ModHostCall,
    result: std::result::Result<&Value, String>,
) -> Option<Value> {
    let arguments = &call.arguments;
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default();
    let mut receipt = json!({"mod": caller, "operation": call.operation, "at": at});
    match call.operation.as_str() {
        "http.request" | "http.open" => {
            let url = arguments["url"].as_str().unwrap_or_default();
            let origin = crate::url_origin(url);
            let path = url
                .split_once("://")
                .and_then(|(_, rest)| rest.find(['/', '?', '#']).map(|start| &rest[start..]))
                .filter(|_| origin.is_some())
                .unwrap_or_default()
                .split(['?', '#'])
                .next()
                .unwrap_or_default();
            receipt["origin"] = json!(origin);
            receipt["path"] = json!(path.chars().take(256).collect::<String>());
            receipt["method"] = arguments.get("method").cloned().unwrap_or(json!("GET"));
            receipt["credential"] = arguments.get("credential").cloned().unwrap_or(Value::Null);
        }
        "mcp.connect" | "mcp.disconnect" => receipt["server"] = arguments["server"].clone(),
        "environment.read" => receipt["names"] = arguments["names"].clone(),
        "workspace.read" | "workspace.list" | "workspace.stat" | "workspace.transaction"
            if arguments.get("root").is_some() =>
        {
            receipt["root"] = arguments["root"].clone();
        }
        _ => return None,
    }
    match result {
        Ok(value) => {
            for field in ["status", "redirects"] {
                if let Some(value) = value.get(field) {
                    receipt[field] = value.clone();
                }
            }
        }
        Err(error) => receipt["error"] = json!(error.chars().take(200).collect::<String>()),
    }
    Some(receipt)
}

/// Runs a mod's `agents.spawn` with the request its `agent_spawn` chain settled on.
fn spawn_call(
    access: &mut Access<'_>,
    host: &mut HostFn<'_>,
    caller: &str,
    original: &Value,
    input: &Value,
) -> Result<Value> {
    if !input["cwd"].is_null() || !input["effort"].is_null() {
        return Err(failure(
            "agent_spawn_unsupported: mod spawns choose their workspace and route, not cwd or effort",
        ));
    }
    let mut arguments = original.clone();
    for (field, key) in [
        ("definition", "definition"),
        ("prompt", "prompt"),
        ("model", "route"),
        ("tools", "tools"),
    ] {
        match &input[field] {
            Value::Null => {
                if let Some(object) = arguments.as_object_mut() {
                    object.remove(key);
                }
            }
            value => arguments[key] = value.clone(),
        }
    }
    let call = ModHostCall {
        operation: "agents.spawn".into(),
        arguments,
    };
    let value = forward(access, host, caller, call)?;
    Ok(json!({"agent_id": value["handle"], "output": value.to_string(), "success": true}))
}

fn forward(
    access: &mut Access<'_>,
    host: &mut HostFn<'_>,
    caller: &str,
    call: ModHostCall,
) -> Result<Value> {
    let request = call.clone();
    let result = host(caller, call);
    if let Some(receipt) = access_receipt(
        caller,
        &request,
        result.as_ref().map_err(ToString::to_string),
    ) {
        let _ = access.with(|runtime| {
            runtime.record_access(receipt);
            Ok(())
        });
    }
    result
}

/// Runs a host call for `caller`, routing service calls to their provider.
pub(super) fn dispatch(
    access: &mut Access<'_>,
    host: &mut HostFn<'_>,
    caller: &str,
    generation: u64,
    call: ModHostCall,
    active: &dyn Fn() -> bool,
    scope: &InvocationScope,
) -> Result<Value> {
    if call.operation == "agents.spawn"
        && call.arguments.is_object()
        && let Some(required) = access
            .with(|runtime| Ok(runtime.intercepts("agent_spawn")))
            .ok()
            .flatten()
    {
        let field = |key: &str| call.arguments.get(key).cloned().unwrap_or(Value::Null);
        let input = json!({"origin": "mod", "caller": caller, "thread_id": bound_thread(),
            "agent_id": null, "definition": field("definition"), "prompt": field("prompt"),
            "model": field("route"), "effort": null, "cwd": null, "tools": field("tools")});
        let origin = json!({"caller": caller, "thread_id": bound_thread()});
        let chain = intercept(
            access,
            host,
            &mut Core::Spawn {
                caller: caller.to_owned(),
                arguments: call.arguments,
            },
            "agent_spawn",
            required,
            input,
            origin,
            active,
            scope,
        )?;
        if let Some(reason) = chain.result["deny"].as_str() {
            return Err(failure(format!("agent_spawn_denied: {reason}")));
        }
        return serde_json::from_str(chain.result["output"].as_str().unwrap_or_default())
            .map_err(|_| failure("agent_spawn_result_unavailable"));
    }
    if call.operation == "peers.send"
        && call.arguments.is_object()
        && let Some(required) = access
            .with(|runtime| Ok(runtime.intercepts("peer_send")))
            .ok()
            .flatten()
    {
        let input = json!({"to": {"session": call.arguments["to"], "package": call.arguments.get("package").cloned().unwrap_or(json!(caller))},
            "correlation": call.arguments.get("correlation").cloned().unwrap_or(Value::Null),
            "data": call.arguments.get("data").cloned().unwrap_or(Value::Null)});
        let origin = json!({"caller": caller, "thread_id": bound_thread()});
        let chain = intercept(
            access,
            host,
            &mut Core::Peer {
                caller: caller.to_owned(),
                arguments: call.arguments,
            },
            "peer_send",
            required,
            input,
            origin,
            active,
            scope,
        )?;
        if let Some(reason) = chain.result["deny"].as_str() {
            return Err(failure(format!("peer_send_denied: {reason}")));
        }
        return Ok(chain.result["receipt"].clone());
    }
    if call.operation != "mods.service" {
        return forward(access, host, caller, call);
    }
    let mut guarded = |caller: &str, call: ModHostCall| {
        if matches!(call.operation.as_str(), "tools.define" | "tools.undefine") {
            return Err(failure(format!(
                "host_operation_unavailable: {} is not available inside a service call",
                call.operation
            )));
        }
        host(caller, call)
    };
    access.with(|runtime| {
        runtime.call_service(
            caller,
            generation,
            call.arguments,
            active,
            &mut guarded,
            scope,
        )
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn intercept(
    access: &mut Access<'_>,
    host: &mut HostFn<'_>,
    core: &mut Core<'_>,
    surface: &str,
    required: bool,
    input: Value,
    origin: Value,
    active: &dyn Fn() -> bool,
    scope: &InvocationScope,
) -> Result<ModChain> {
    let wait = if required {
        REQUIRED_WAIT
    } else {
        OPTIONAL_WAIT
    };
    let links = match access
        .bounded(wait)
        .with(|runtime| Ok(runtime.links(surface)))
    {
        Err(error) if !required && error.to_string().starts_with("mod_runtime_busy") => Vec::new(),
        links => links?,
    };
    if links
        .iter()
        .all(|link| !link.matcher.is_null() && !may_match(&link.matcher, &input))
    {
        let result = match core {
            Core::Call(run) => run(input.clone()),
            Core::Host { caller, generation } => {
                effective_call(access, host, caller, *generation, &input, active, scope)
            }
            Core::Spawn { caller, arguments } => {
                spawn_call(access, host, caller, arguments, &input)
            }
            Core::Peer { caller, arguments } => {
                let mut arguments = arguments.clone();
                arguments["data"] = input["data"].clone();
                let call = ModHostCall {
                    operation: "peers.send".into(),
                    arguments,
                };
                forward(access, host, caller, call).map(|receipt| json!({"receipt": receipt}))
            }
        }?;
        return Ok(ModChain {
            result,
            input,
            answered_by: None,
            trace: Vec::new(),
            reads: BTreeMap::new(),
        });
    }
    let mut chain = Chain {
        surface: surface.to_owned(),
        links,
        original: input.clone(),
        origin,
        effective: input.clone(),
        executed: false,
        answered_by: None,
        trace: Vec::new(),
        reads: BTreeMap::new(),
    };
    let result = chain.link(access, host, core, active, scope, 0, input);
    let record = ModChain {
        result: result.as_ref().map_or(Value::Null, Value::clone),
        input: chain.effective,
        answered_by: chain.answered_by.filter(|_| !chain.executed),
        trace: chain.trace,
        reads: chain.reads,
    };
    let logged = json!({"result": recorded(surface, &record.result), "input": recorded(surface, &record.input),
        "answered_by": record.answered_by, "trace": record.trace});
    let entry = json!({"surface": surface, "origin": chain.origin, "error": result.as_ref().err().map(ToString::to_string), "chain": logged});
    // Renders repeat per frame, so only failed ones join the chain log.
    let failed = result.is_err() || record.trace.iter().any(|entry| entry["reason"].is_string());
    let _ = (surface != "render" || failed).then(|| {
        access.with(|runtime| {
            runtime.chains.push(entry);
            if runtime.chains.len() > CHAIN_LOG {
                runtime.chains.remove(0);
            }
            Ok(())
        })
    });
    result.map(|_| record)
}

impl ModHost {
    /// Refuses or restricts packages through `admission` interceptors; policy mods and their dependencies are not judged.
    pub(super) fn admit(&mut self) {
        let Some(required) = self.intercepts("admission") else {
            return;
        };
        let mut exempt = BTreeSet::new();
        let mut pending = self
            .loaded
            .iter()
            .filter(|(_, loaded)| {
                loaded
                    .registrations
                    .interceptors
                    .iter()
                    .any(|interceptor| granted(loaded, &interceptor.pattern, "admission"))
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        while let Some(id) = pending.pop() {
            if exempt.insert(id.clone())
                && let Some(loaded) = self.loaded.get(&id)
            {
                pending.extend(
                    loaded
                        .package
                        .dependencies
                        .iter()
                        .map(|dependency| dependency.id.clone()),
                );
                pending.extend(loaded.package.requires.iter().cloned());
            }
        }
        let scope = exempt
            .iter()
            .filter_map(|id| self.loaded.get(id)?.package.policy.as_ref())
            .flat_map(|policy| policy.namespaces.clone())
            .collect::<Vec<_>>();
        let policy = exempt
            .iter()
            .filter_map(|id| Some(format!("{id}={}", self.loaded.get(id)?.selection.sha256)))
            .collect::<Vec<_>>()
            .join(",");
        let candidates = self
            .order
            .iter()
            .filter(|id| !exempt.contains(*id))
            .filter(|id| {
                self.loaded
                    .get(*id)
                    .is_some_and(|loaded| loaded.error.is_none())
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut refused = BTreeMap::new();
        for id in candidates {
            let Some(loaded) = self.loaded.get(&id) else {
                continue;
            };
            let key = format!("{}:{policy}", loaded.selection.sha256);
            let decision = match self.admissions.get(&key) {
                Some(decision) => decision.clone(),
                None => {
                    let package = &loaded.package;
                    let input = json!({"package": {"id": id, "version": package.version,
                        "sha256": loaded.selection.sha256, "source": loaded.selection.path,
                        "scope": loaded.selection.scope, "capabilities": package.capabilities,
                        "dependencies": package.dependencies, "requires": package.requires,
                        "services": package.services, "registrations": loaded.registrations,
                        "source_use": loaded.source_use}, "reason": "load"});
                    let chain = intercept(
                        &mut Access::Held(self),
                        &mut |_, _| {
                            Err(failure(
                                "host_operation_unavailable: admission runs without host operations",
                            ))
                        },
                        &mut Core::Call(&mut |_| Ok(json!({"admit": true}))),
                        "admission",
                        required,
                        input,
                        json!({"caller": "engine"}),
                        &|| true,
                        &InvocationScope::default(),
                    );
                    match chain {
                        Ok(chain) => {
                            let decision = admission(&chain.result, &scope);
                            if self.admissions.len() >= 256 {
                                self.admissions.clear();
                            }
                            self.admissions.insert(key, decision.clone());
                            decision
                        }
                        Err(error) => Err(format!("admission_policy_unavailable: {error}")),
                    }
                }
            };
            match decision {
                Ok(withheld) => {
                    if let Some(loaded) = self.loaded.get_mut(&id) {
                        loaded.withheld = withheld;
                    }
                }
                Err(reason) => {
                    refused.insert(id, reason);
                }
            }
        }
        loop {
            let services = refused
                .keys()
                .filter_map(|id| self.loaded.get(id))
                .flat_map(|loaded| &loaded.registrations.services)
                .map(|contract| &contract.name)
                .collect::<BTreeSet<_>>();
            let dependents = self
                .loaded
                .iter()
                .filter(|(id, _)| !refused.contains_key(*id) && !exempt.contains(*id))
                .filter_map(|(id, loaded)| {
                    let refusal = loaded
                        .package
                        .dependencies
                        .iter()
                        .map(|dependency| &dependency.id)
                        .chain(&loaded.package.requires)
                        .find(|dependency| refused.contains_key(*dependency))
                        .or_else(|| {
                            loaded
                                .package
                                .services
                                .imports
                                .iter()
                                .find(|import| !import.optional && services.contains(&import.name))
                                .map(|import| &import.name)
                        })?;
                    Some((id.clone(), format!("dependency_not_admitted: {refusal}")))
                })
                .collect::<Vec<_>>();
            if dependents.is_empty() {
                break;
            }
            refused.extend(dependents);
        }
        for (id, reason) in refused {
            if let Some(loaded) = self.loaded.remove(&id) {
                self.order.retain(|item| *item != id);
                self.rejected.push(ModRejection {
                    path: loaded.selection.path,
                    id: Some(id),
                    scope: loaded.selection.scope,
                    reason,
                });
            }
        }
    }

    /// The final-request stage, absent without `model_send` interceptors or an enabled `request_policy` selection.
    pub fn send_policy(&self) -> Option<SendPolicy> {
        let required = self.intercepts("model_send");
        if required.is_none() && self.policies.is_empty() {
            return None;
        }
        let unavailable = self.policies.iter().find_map(|path| {
            let Some(loaded) = self
                .loaded
                .values()
                .find(|loaded| &loaded.selection.path == path)
            else {
                let rejection = self
                    .rejected
                    .iter()
                    .find(|rejection| &rejection.path == path);
                return Some(match rejection {
                    Some(rejection) => format!(
                        "{}: {}",
                        rejection.id.as_deref().unwrap_or("mod"),
                        rejection.reason
                    ),
                    None => format!("{} is not loaded", path.display()),
                });
            };
            let id = &loaded.package.id;
            if let Some(error) = &loaded.error {
                return Some(format!("{id}: {error}"));
            }
            (!loaded.registrations.interceptors.iter().any(|interceptor| {
                interceptor.required && granted(loaded, &interceptor.pattern, "model_send")
            }))
            .then(|| format!("{id} registers no required model_send interceptor"))
        });
        let policies = self
            .loaded
            .iter()
            .filter(|(_, loaded)| {
                loaded
                    .registrations
                    .interceptors
                    .iter()
                    .any(|interceptor| granted(loaded, &interceptor.pattern, "model_send"))
            })
            .map(|(id, loaded)| json!([id, loaded.selection.sha256, loaded.selection.settings]))
            .collect::<Vec<_>>();
        let fingerprint = crate::mods::digest(
            &serde_json::to_vec(&json!([self.generation, policies])).unwrap_or_default(),
        );
        Some(SendPolicy {
            required: required == Some(true) || !self.policies.is_empty(),
            unavailable,
            fingerprint,
        })
    }

    /// `Some(true)` when a required interceptor, including a faulted mod's, selects `surface`.
    pub fn intercepts(&self, surface: &str) -> Option<bool> {
        self.loaded
            .values()
            .flat_map(|loaded| {
                loaded
                    .registrations
                    .interceptors
                    .iter()
                    .filter(|interceptor| {
                        (loaded.error.is_none() || interceptor.required)
                            && granted(loaded, &interceptor.pattern, surface)
                    })
                    .map(|interceptor| interceptor.required)
            })
            .max()
    }

    pub(super) fn may_intercept(&self, surface: &str, input: &Value) -> bool {
        self.links(surface)
            .iter()
            .any(|link| link.matcher.is_null() || may_match(&link.matcher, input))
    }

    /// Ordinary links wrap required ones; a faulted mod's required links stay and fail closed.
    fn links(&self, surface: &str) -> Vec<Link> {
        let order = order(&self.loaded).unwrap_or_default();
        let faulted = self
            .loaded
            .iter()
            .filter(|(_, loaded)| loaded.error.is_some())
            .map(|(id, _)| id.clone());
        let required_order = order.iter().cloned().chain(faulted).collect::<Vec<_>>();
        let mut links = Vec::new();
        for (required, order) in [(false, &order), (true, &required_order)] {
            for id in order {
                let Some(loaded) = self.loaded.get(id) else {
                    continue;
                };
                for (index, interceptor) in loaded.registrations.interceptors.iter().enumerate() {
                    if interceptor.required == required
                        && granted(loaded, &interceptor.pattern, surface)
                    {
                        links.push(Link {
                            id: id.clone(),
                            index,
                            required,
                            catch: interceptor.catch,
                            location: interceptor.location.clone(),
                            matcher: interceptor.matcher.clone(),
                            generation: self.generation,
                        });
                    }
                }
            }
        }
        links
    }
}

/// An admission result: the withheld namespaces, which must fall inside a policy mod's `policy.namespaces`, or the refusal.
fn admission(result: &Value, scope: &[String]) -> std::result::Result<Vec<String>, String> {
    if let Some(reason) = result.get("deny") {
        return Err(format!(
            "admission_denied: {}",
            reason.as_str().unwrap_or_default()
        ));
    }
    let withheld = result["withhold"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    match withheld.iter().find(|namespace| {
        !scope
            .iter()
            .any(|pattern| crate::mods::namespace_matches(pattern, namespace))
    }) {
        Some(namespace) => Err(format!(
            "admission_policy_invalid: {namespace} is outside policy.namespaces"
        )),
        None => Ok(withheld),
    }
}

/// Composes command or config rows without host operations; a row a handler drops becomes hidden.
pub fn compose_rows(
    runtime: &Mutex<ModHost>,
    surface: &str,
    field: &str,
    key: &str,
    rows: Vec<Value>,
) -> Result<Vec<Value>> {
    let required = runtime
        .lock()
        .map_err(|_| failure("mod_runtime_poisoned"))?
        .intercepts(surface);
    let Some(required) = required else {
        return Ok(rows);
    };
    let chain = intercept_shared(
        runtime,
        surface,
        required,
        json!({field: rows}),
        json!({"caller": "user"}),
        || true,
        |_, _| {
            Err(failure(format!(
                "host_operation_unavailable: {surface} runs without host operations"
            )))
        },
        |effective| Ok(json!({field: effective[field]})),
    )?;
    let composed = chain.result[field].as_array().cloned().unwrap_or_default();
    Ok(rows
        .into_iter()
        .map(
            |mut row| match composed.iter().find(|item| item[key] == row[key]) {
                Some(item) => item.clone(),
                None => {
                    row["hidden"] = json!(true);
                    row
                }
            },
        )
        .collect())
}

/// Runs `core` behind the surface's interceptors, or directly when none is registered.
pub fn continue_operation(
    runtime: &Mutex<ModHost>,
    surface: &str,
    input: Value,
    origin: Value,
    active: impl Fn() -> bool,
    host: impl FnMut(&str, ModHostCall) -> Result<Value>,
    mut core: impl FnMut(Value) -> Result<Value>,
) -> Result<Value> {
    let required = runtime
        .lock()
        .map_err(|_| failure("mod_runtime_poisoned"))?
        .intercepts(surface);
    let result = match required {
        Some(required) => {
            intercept_shared(
                runtime, surface, required, input, origin, active, host, core,
            )?
            .result
        }
        None => core(input)?,
    };
    match result.get("deny").and_then(Value::as_str) {
        Some(reason) => Err(failure(format!("{surface}_denied: {reason}"))),
        None => Ok(result),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn intercept_shared(
    runtime: &Mutex<ModHost>,
    surface: &str,
    required: bool,
    input: Value,
    origin: Value,
    active: impl Fn() -> bool,
    mut host: impl FnMut(&str, ModHostCall) -> Result<Value>,
    mut core: impl FnMut(Value) -> Result<Value>,
) -> Result<ModChain> {
    intercept(
        &mut Access::Bounded(runtime, REQUIRED_WAIT),
        &mut host,
        &mut Core::Call(&mut core),
        surface,
        required,
        input,
        origin,
        &active,
        &InvocationScope::default(),
    )
}
