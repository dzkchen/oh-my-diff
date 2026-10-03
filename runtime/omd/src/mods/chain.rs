use super::*;
use std::time::Duration;

const INTERCEPTOR_LIMIT: usize = 16;
const ATTEMPT_LIMIT: usize = 3;
const TRACE_LIMIT: usize = 64;
const TRACE_VALUE_BYTES: usize = 2048;
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

fn validate_input(surface: &str, original: &Value, input: &Value) -> Result<()> {
    let mutable: &[&str] = match surface {
        "tool" => &["tool", "arguments"],
        "host_operation" => &["arguments"],
        "input" => &["text"],
        "model_request" => &["route"],
        "tool_specs" => &["tools"],
        _ => &[],
    };
    let (Some(original), Some(object)) = (original.as_object(), input.as_object()) else {
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
        "model_request" => input["routes"].as_array().is_some_and(|routes| {
            routes
                .iter()
                .any(|route| route["name"] == input["route"] && route["name"].is_string())
        }),
        "tool_specs" => tool_specs(&input["tools"], &original["tools"]),
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
                .is_some_and(|text| text.len() <= 4096)
                && (tool["parameters"].is_object() || tool["parameters"].is_null())
                && tool["deferred"].is_boolean()
        })
}

fn validate_result(surface: &str, result: &Value, last: Option<&Value>) -> Result<()> {
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
        _ => deny,
    };
    if valid {
        Ok(())
    } else {
        Err(failure(format!("invalid_interceptor_result: {surface}")))
    }
}

fn bounded(value: &Value) -> Value {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    if bytes.len() <= TRACE_VALUE_BYTES {
        return value.clone();
    }
    json!({"sha256": digest(&bytes), "bytes": bytes.len()})
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
            "received": bounded(received)});
        if let Some(link) = link {
            entry["location"] = json!(link.location);
            entry["required"] = json!(link.required);
        }
        if let Some(returned) = returned {
            entry["returned"] = bounded(returned);
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
        let payload = json!({"surface": self.surface, "input": input, "original": self.original,
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
                validate_result(surface, &result, last(attempts).as_ref())?;
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
            Some(Err(downstream)) => {
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
            None => {
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
    let granted = access.with(|runtime| {
        Ok(runtime
            .loaded
            .get(caller)
            .map(|loaded| loaded.package.capabilities.clone())
            .unwrap_or_default())
    })?;
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
    if call.operation != "mods.service" {
        return host(caller, call);
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
        }?;
        return Ok(ModChain {
            result,
            input,
            answered_by: None,
            trace: Vec::new(),
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
    };
    let result = chain.link(access, host, core, active, scope, 0, input);
    let record = ModChain {
        result: result.as_ref().map_or(Value::Null, Value::clone),
        input: chain.effective,
        answered_by: chain.answered_by.filter(|_| !chain.executed),
        trace: chain.trace,
    };
    let logged = json!({"result": bounded(&record.result), "input": bounded(&record.input),
        "answered_by": record.answered_by, "trace": record.trace});
    let entry = json!({"surface": surface, "origin": chain.origin, "error": result.as_ref().err().map(ToString::to_string), "chain": logged});
    let _ = access.with(|runtime| {
        runtime.chains.push(entry);
        if runtime.chains.len() > CHAIN_LOG {
            runtime.chains.remove(0);
        }
        Ok(())
    });
    result.map(|_| record)
}

impl ModHost {
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
                            && selects(&interceptor.pattern, surface, &loaded.package.capabilities)
                    })
                    .map(|interceptor| interceptor.required)
            })
            .max()
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
                        && selects(&interceptor.pattern, surface, &loaded.package.capabilities)
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
