use codex_api::request_observer::ResponseAttempt;
use codex_api::request_observer::ResponseObserver;
use codex_client::EncodedJsonBody;
use codex_client::Request;
use codex_client::TransportError;
use codex_omd::Admission;
use codex_omd::Task;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

pub const REVOCATION_FILE: &str = "contributor-revoked.json";

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rates {
    pub input_microusd_per_million: u64,
    pub cached_microusd_per_million: u64,
    #[serde(default)]
    pub cache_write_microusd_per_million: Option<u64>,
    pub output_microusd_per_million: u64,
    pub reservation_microusd: u64,
    pub max_output_tokens: u64,
    pub input_token_ceiling: u64,
    pub included_subscription: bool,
    #[serde(default)]
    pub external_subscription: bool,
}

#[derive(Clone)]
pub struct Account {
    pub task: Arc<Task>,
    pub owner: String,
    pub model: String,
    pub provider: String,
    pub url: String,
    pub max_request_bytes: usize,
    pub rates: Rates,
    pub authorization: std::path::PathBuf,
    pub authorization_sha256: String,
    pub repository_identity: String,
    pub revocation: std::path::PathBuf,
    pub cost_capture: std::path::PathBuf,
    pub preset: String,
    pub authorized_presets: Vec<RequestPreset>,
    pub worker_authorization: Option<(std::path::PathBuf, String)>,
}

#[derive(Clone, serde::Serialize)]
pub struct RequestPreset {
    pub name: String,
    pub model: String,
    pub provider: String,
    pub reasoning: String,
    pub url: String,
    #[serde(skip_serializing)]
    pub accounting_provider: String,
}

#[derive(Default)]
pub struct Accounts(
    pub Mutex<BTreeMap<String, Account>>,
    Mutex<Option<Arc<Mutex<codex_omd::ModHost>>>>,
    AtomicU64,
    Arc<AtomicUsize>,
);

const MIDDLEWARE_WAIT: Duration = Duration::from_secs(2);
const MIDDLEWARE_LOG_BYTES: u64 = 8 * 1024 * 1024;

enum Hook<T> {
    Ran(T),
    Absent,
    Skipped(&'static str),
}

impl Accounts {
    pub fn install_mod_runtime(&self, runtime: Arc<Mutex<codex_omd::ModHost>>) {
        if let Ok(mut installed) = self.1.lock() {
            *installed = Some(runtime);
        }
    }

    fn mods(&self) -> Option<Arc<Mutex<codex_omd::ModHost>>> {
        self.1.lock().ok().and_then(|installed| installed.clone())
    }

    fn middleware<T>(
        runtime: &Mutex<codex_omd::ModHost>,
        holders: &AtomicUsize,
        wait_for_callbacks: bool,
        hook: &str,
        run: impl FnOnce(&mut codex_omd::ModHost) -> T,
    ) -> Result<Hook<T>, TransportError> {
        let deadline = Instant::now() + MIDDLEWARE_WAIT;
        loop {
            match runtime.try_lock() {
                Ok(mut runtime) => {
                    if !runtime.has_event(hook) {
                        return Ok(Hook::Absent);
                    }
                    holders.fetch_add(1, Ordering::AcqRel);
                    let value = run(&mut runtime);
                    drop(runtime);
                    holders.fetch_sub(1, Ordering::AcqRel);
                    return Ok(Hook::Ran(value));
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err(denied("mod runtime poisoned"));
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    if holders.load(Ordering::Acquire) == 0 && !wait_for_callbacks {
                        return Ok(Hook::Skipped("mod_callback_in_flight"));
                    }
                    if Instant::now() >= deadline {
                        return Ok(Hook::Skipped("mod_runtime_busy"));
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
        }
    }

    fn record_middleware(account: &Account, value: &Value) -> Result<(), TransportError> {
        use std::io::Write;
        let path = account
            .cost_capture
            .parent()
            .ok_or_else(|| denied("evidence directory missing"))?
            .join("mod-middleware.jsonl");
        let mut bytes = serde_json::to_vec(value).map_err(denied)?;
        bytes.push(b'\n');
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(denied)?;
        if file.metadata().map_err(denied)?.len() > MIDDLEWARE_LOG_BYTES {
            return Ok(());
        }
        file.write_all(&bytes).map_err(denied)
    }
}

pub fn authorized(
    path: &std::path::Path,
    expected_sha256: &str,
    repository: &str,
    revocation: &std::path::Path,
) -> bool {
    match std::fs::symlink_metadata(revocation) {
        Ok(_) => return false,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return false,
    }
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    if bytes.len() > 65536 || crate::execution::hash(&bytes) != expected_sha256 {
        return false;
    }
    let Ok(grant) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    grant["schema"] == 1
        && grant["data_authorized"] == true
        && grant["revocable"] == true
        && grant["split"] == "development"
        && grant["repositories"]
            .as_array()
            .is_some_and(|v| v.iter().any(|r| r.as_str() == Some(repository)))
}

pub const SUBSCRIPTION_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";

pub fn worker_authorized(
    path: &std::path::Path,
    expected: &str,
    repository: &str,
    provider: &str,
    model: &str,
    url: &str,
    subscription: bool,
) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() > 16384 {
        return false;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    if crate::execution::hash(&bytes) != expected {
        return false;
    }
    let Ok(grant) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    grant["schema"] == 1
        && if subscription {
            grant["included_subscription"] == true
                && grant["paid_api_key"] != true
                && provider == "openai"
                && url == SUBSCRIPTION_RESPONSES_URL
        } else {
            grant["paid_api_key"] == true && grant["included_subscription"] != true
        }
        && grant["revocable"] == true
        && grant["repository"] == repository
        && grant["provider"] == provider
        && grant["model"] == model
        && grant["responses_url"] == url
}

pub fn denied(message: impl ToString) -> TransportError {
    TransportError::Http {
        status: http::StatusCode::BAD_REQUEST,
        url: None,
        headers: None,
        body: Some(format!(
            "local controlled-delegation policy: {}",
            message.to_string()
        )),
    }
}

impl ResponseObserver for Accounts {
    fn prepare(
        &self,
        request: &mut Request,
        body: &mut Option<EncodedJsonBody>,
    ) -> Result<(), TransportError> {
        let thread = request
            .headers
            .get("thread-id")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| denied("missing native thread identity"))?;
        let account = self
            .0
            .lock()
            .map_err(|_| denied("account lock poisoned"))?
            .get(thread)
            .cloned()
            .ok_or_else(|| denied("unenrolled native thread"))?;
        let mut value: Value = serde_json::from_slice(
            body.as_ref()
                .ok_or_else(|| denied("missing JSON request"))?
                .as_bytes(),
        )
        .map_err(denied)?;
        if !account.rates.included_subscription {
            if account.rates.max_output_tokens == 0 {
                return Err(denied("missing output ceiling"));
            }
            value["max_output_tokens"] = account.rates.max_output_tokens.into();
            value["service_tier"] = "default".into();
            *body = Some(EncodedJsonBody::encode(&value).map_err(denied)?);
        }
        if let Some(mods) = self.mods() {
            let request_id = format!("mod-request-{}", self.2.fetch_add(1, Ordering::Relaxed) + 1);
            let original = account
                .authorized_presets
                .iter()
                .find(|preset| preset.name == account.preset)
                .ok_or_else(|| denied("current route is not an authorized preset"))?;
            let presets = account
                .authorized_presets
                .iter()
                .map(|preset| json!({"name":preset.name,"model":preset.model,"provider":preset.provider,"reasoning":preset.reasoning}))
                .collect::<Vec<_>>();
            let route = json!({"name":original.name,"model":original.model,"provider":original.provider,"reasoning":original.reasoning});
            let payload = json!({"request_id":request_id,"scope":{"thread_id":thread,
                "agent_id":if account.owner == "lead" { Value::Null } else { Value::String(account.owner.clone()) },
                "kind":if account.owner == "lead" {"main"} else {"subagent"}},
                "authorized_presets":presets,"original":route,"effective":route,"provenance":[]});
            let effective = match Self::middleware(
                &mods,
                &self.3,
                !account.owner.starts_with("mod-"),
                "model_request",
                |runtime| runtime.model_request(payload, || account.task.check_active().is_ok()),
            )? {
                Hook::Ran(effective) => effective.map_err(denied)?,
                Hook::Absent => return Ok(()),
                Hook::Skipped(reason) => {
                    return Self::record_middleware(
                        &account,
                        &json!({"kind":"middleware_skipped","hook":"model_request","request_id":request_id,"reason":reason}),
                    );
                }
            };
            let selected = effective["effective"]["name"]
                .as_str()
                .and_then(|name| {
                    account
                        .authorized_presets
                        .iter()
                        .find(|preset| preset.name == name)
                })
                .ok_or_else(|| denied("mod selected an unauthorized request preset"))?;
            value["model"] = selected.model.clone().into();
            value["reasoning"]["effort"] = selected.reasoning.clone().into();
            *body = Some(EncodedJsonBody::encode(&value).map_err(denied)?);
            request
                .headers
                .insert("x-omd-preset", selected.name.parse().map_err(denied)?);
            if effective["provenance"]
                .as_array()
                .is_some_and(|provenance| !provenance.is_empty())
            {
                Self::record_middleware(
                    &account,
                    &json!({"kind":"model_request","value":effective}),
                )?;
            }
        }
        Ok(())
    }

    fn before_send(
        &self,
        request: &mut Request,
        body: Option<&EncodedJsonBody>,
    ) -> Result<Option<Box<dyn ResponseAttempt>>, TransportError> {
        let thread = request
            .headers
            .get("thread-id")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| denied("missing native thread identity"))?;
        let account = self
            .0
            .lock()
            .map_err(|_| denied("account lock poisoned"))?
            .get(thread)
            .cloned()
            .ok_or_else(|| denied("unenrolled native thread"))?;
        if let Some((path, sha)) = &account.worker_authorization {
            if !worker_authorized(
                path,
                sha,
                &account.repository_identity,
                &account.provider,
                &account.model,
                &account.url,
                account.rates.included_subscription,
            ) {
                return Err(denied("worker authorization revoked or changed"));
            }
            if account.rates.included_subscription
                && (request.url != SUBSCRIPTION_RESPONSES_URL
                    || !request.headers.contains_key("chatgpt-account-id"))
            {
                return Err(denied("worker requires the native subscription request"));
            }
        }
        if account.provider == "meta" {
            let allowed = authorized(
                &account.authorization,
                &account.authorization_sha256,
                &account.repository_identity,
                &account.revocation,
            );
            account
                .task
                .set_contributor_authorization(
                    allowed,
                    &account.authorization.display().to_string(),
                )
                .map_err(denied)?;
            if !allowed {
                return Err(denied("Contributor authorization revoked or changed"));
            }
        }
        let bytes = body
            .ok_or_else(|| denied("missing JSON request"))?
            .as_bytes();
        if bytes.len() > account.max_request_bytes {
            return Err(denied("request exceeds context byte ceiling"));
        }
        let value: Value = serde_json::from_slice(bytes).map_err(denied)?;
        let selected_name = request
            .headers
            .remove("x-omd-preset")
            .and_then(|value| value.to_str().ok().map(str::to_owned))
            .unwrap_or_else(|| account.preset.clone());
        let selected = account
            .authorized_presets
            .iter()
            .find(|preset| {
                preset.name == selected_name
                    && value.get("model").and_then(Value::as_str) == Some(preset.model.as_str())
                    && value.pointer("/reasoning/effort").and_then(Value::as_str)
                        == Some(preset.reasoning.as_str())
            })
            .cloned();
        let Some(selected) = selected else {
            return Err(denied("unapproved model or nonstreaming request"));
        };
        if value.get("stream") != Some(&Value::Bool(true)) {
            return Err(denied("unapproved model or nonstreaming request"));
        }
        request.url = selected.url.clone();
        if account.worker_authorization.is_some()
            && (selected.model != account.model
                || selected.accounting_provider != account.provider
                || selected.url != account.url)
        {
            return Err(denied("worker preset route cannot change"));
        }
        let mut account = account;
        account.model = selected.model.clone();
        account.provider = selected.accounting_provider.clone();
        account.url = selected.url.clone();
        if account.rates.included_subscription
            && (account.provider != "openai" || account.rates.reservation_microusd != 0)
        {
            return Err(denied("invalid included-subscription billing declaration"));
        }
        if value
            .get("service_tier")
            .is_some_and(|v| v != "default" && v != "auto")
            || ["previous_response_id", "conversation", "background"]
                .iter()
                .any(|k| value.get(k).is_some_and(|v| !v.is_null() && v != false))
        {
            return Err(denied("unbounded remote context or unpriced service tier"));
        }
        let charged_tool = |value: &Value| {
            matches!(
                value.get("type").and_then(Value::as_str),
                Some(
                    "web_search"
                        | "web_search_preview"
                        | "file_search"
                        | "computer"
                        | "computer_use_preview"
                        | "code_interpreter"
                        | "image_generation"
                        | "mcp"
                )
            )
        };
        let declarations = value
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .chain(
                value
                    .get("input")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|item| {
                        item.get("type").and_then(Value::as_str) == Some("additional_tools")
                    })
                    .flat_map(|item| {
                        item.get("tools")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                    })
                    .flat_map(|group| {
                        group
                            .get("tools")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                    }),
            );
        if declarations.into_iter().any(charged_tool) {
            return Err(denied("unbounded charged tool declaration"));
        }
        let mut nodes = value
            .as_object()
            .into_iter()
            .flat_map(|object| object.iter())
            .filter(|(key, _)| *key != "tools" && *key != "input")
            .map(|(_, item)| item)
            .collect::<Vec<_>>();
        nodes.extend(
            value
                .get("input")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|item| {
                    item.get("type").and_then(Value::as_str) != Some("additional_tools")
                }),
        );
        let mut reasoning = 0u64;
        while let Some(node) = nodes.pop() {
            match node {
                Value::Object(object) => {
                    if let Some(field) = ["image_url", "file_id", "file_data", "audio"]
                        .iter()
                        .find(|field| object.contains_key(**field))
                    {
                        return Err(denied(format!("unbounded nontext input field: {field}")));
                    }
                    if let Some(
                        kind @ ("web_search"
                        | "web_search_preview"
                        | "file_search"
                        | "computer"
                        | "computer_use_preview"
                        | "code_interpreter"
                        | "image_generation"
                        | "mcp"
                        | "input_image"
                        | "input_file"
                        | "input_audio"),
                    ) = object.get("type").and_then(Value::as_str)
                    {
                        return Err(denied(format!(
                            "unbounded charged tool or input type: {kind}"
                        )));
                    }
                    if object.get("type").is_some_and(|v| v == "reasoning") {
                        reasoning += 1;
                    }
                    nodes.extend(object.values());
                }
                Value::Array(array) => nodes.extend(array),
                _ => {}
            }
        }
        if !account.rates.included_subscription {
            let output = value
                .get("max_output_tokens")
                .and_then(Value::as_u64)
                .filter(|v| *v > 0 && *v <= account.rates.max_output_tokens)
                .ok_or_else(|| denied("output ceiling absent or exceeded"))?;
            let input_ceiling = bytes.len() as u128
                + 4096
                + u128::from(account.rates.max_output_tokens.max(4096)) * u128::from(reasoning);
            if input_ceiling > u128::from(account.rates.input_token_ceiling) {
                return Err(denied("conservative input ceiling exceeded"));
            }
            let reservation = (input_ceiling
                * u128::from(
                    account
                        .rates
                        .input_microusd_per_million
                        .max(account.rates.cached_microusd_per_million),
                )
                + u128::from(output) * u128::from(account.rates.output_microusd_per_million))
            .div_ceil(1_000_000);
            if reservation > u128::from(account.rates.reservation_microusd) {
                return Err(denied("request exceeds conservative exposure reservation"));
            }
        }
        let admission = account
            .task
            .admit_with_billing(
                &account.owner,
                &account.provider,
                &account.model,
                account.rates.reservation_microusd,
                account.rates.external_subscription,
            )
            .map_err(denied)?;
        request.headers.insert(
            "x-omd-request-id",
            admission.request_id().to_string().parse().map_err(denied)?,
        );
        request
            .headers
            .insert("x-omd-owner", account.owner.parse().map_err(denied)?);
        if let Err(error) = account.task.dispatch(&admission, || Ok(())) {
            let _ = account.task.fail(
                &admission,
                "local dispatch revalidation rejected the request",
            );
            return Err(denied(error));
        }
        Ok(Some(Box::new(Attempt {
            account,
            admission,
            mods: self.mods(),
            holders: self.3.clone(),
            settled: false,
            failed: false,
        })))
    }
}

struct Attempt {
    account: Account,
    admission: Admission,
    mods: Option<Arc<Mutex<codex_omd::ModHost>>>,
    holders: Arc<AtomicUsize>,
    settled: bool,
    failed: bool,
}

impl Attempt {
    fn persist_cost_capture(&self) -> Result<(), TransportError> {
        use std::io::Write;

        let bytes = serde_json::to_vec(&self.account.task.cost_capture().map_err(denied)?)
            .map_err(denied)?;
        let temporary = self.account.cost_capture.with_extension(format!(
            "json.{}.{}.tmp",
            std::process::id(),
            self.admission.request_id()
        ));
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(denied)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(denied)?;
        std::fs::rename(&temporary, &self.account.cost_capture).map_err(denied)?;
        Ok(())
    }

    fn event(&mut self, event: &mut Value, valid: bool) -> Result<(), TransportError> {
        let raw = event.clone();
        if !valid
            && !matches!(
                raw["type"].as_str(),
                Some("response.failed" | "response.incomplete" | "error")
            )
        {
            self.failed("malformed provider event");
        }
        match raw.get("type").and_then(Value::as_str) {
            Some("response.completed" | "response.failed" | "response.incomplete") => {
                let success = raw["type"] == "response.completed";
                if !success {
                    self.failed("provider returned failed or incomplete response");
                }
                if let Some(usage) = raw
                    .get("response")
                    .and_then(|v| v.get("usage"))
                    .filter(|v| v.is_object())
                {
                    self.account
                        .task
                        .retain_usage(&self.admission, usage.clone())
                        .map_err(denied)?;
                    let rates = &self.account.rates;
                    let input = usage.get("input_tokens").and_then(Value::as_u64);
                    let cached = usage
                        .pointer("/input_tokens_details/cached_tokens")
                        .and_then(Value::as_u64);
                    let cache_write = usage
                        .pointer("/input_tokens_details/cache_write_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let output = usage.get("output_tokens").and_then(Value::as_u64);
                    if let (Some(input), Some(cached), Some(output)) = (input, cached, output) {
                        if !rates.included_subscription
                            && (input > rates.input_token_ceiling
                                || output > rates.max_output_tokens)
                        {
                            self.failed("provider usage exceeded admitted token ceilings");
                            self.account.task.stop().map_err(denied)?;
                            return Err(denied("provider usage exceeded admitted token ceilings"));
                        }
                        if cached > input || cache_write > input - cached {
                            return Err(denied("cache input exceeds total input"));
                        }
                        let amount = if rates.included_subscription {
                            0
                        } else {
                            let numerator = [
                                (
                                    input - cached - cache_write,
                                    rates.input_microusd_per_million,
                                ),
                                (cached, rates.cached_microusd_per_million),
                                (
                                    cache_write,
                                    rates
                                        .cache_write_microusd_per_million
                                        .unwrap_or(rates.input_microusd_per_million),
                                ),
                                (output, rates.output_microusd_per_million),
                            ]
                            .into_iter()
                            .try_fold(0u128, |sum, (tokens, rate)| {
                                sum.checked_add(u128::from(tokens) * u128::from(rate))
                            })
                            .ok_or_else(|| denied("pricing arithmetic overflow"))?;
                            u64::try_from(numerator.div_ceil(1_000_000)).map_err(denied)?
                        };
                        self.account
                            .task
                            .settle(&self.admission, usage.clone(), amount)
                            .map_err(denied)?;
                        self.settled = true;
                        self.persist_cost_capture()?;
                    }
                }
                if !self.settled {
                    self.failed("terminal response has unpriced or missing usage");
                }
            }
            Some("error") => self.failed("provider stream error"),
            _ => {}
        }
        if let Some(mods) = self.mods.clone() {
            let kind = raw["type"].as_str().unwrap_or("invalid");
            let text_key = if kind == "response.output_text.delta" {
                Some("delta")
            } else if kind == "response.output_text.done" {
                Some("text")
            } else {
                None
            };
            let text = text_key.and_then(|key| raw.get(key).and_then(Value::as_str));
            let payload = json!({"kind":kind,"raw_sha256":crate::execution::hash(&serde_json::to_vec(&raw).map_err(denied)?),
                "raw_usage":raw.pointer("/response/usage").cloned().unwrap_or(Value::Null),
                "opaque_reasoning":kind.contains("reasoning"),"protected":text_key.is_none(),"text":text});
            let active = || self.account.task.check_active().is_ok();
            let transformed = match Accounts::middleware(
                &mods,
                &self.holders,
                false,
                "response_stream",
                |runtime| runtime.response_stream(payload, active),
            )? {
                Hook::Ran(transformed) => transformed.map_err(denied)?,
                Hook::Absent => {
                    self.mods = None;
                    return Ok(());
                }
                Hook::Skipped(reason) => {
                    self.mods = None;
                    return Accounts::record_middleware(
                        &self.account,
                        &json!({"kind":"middleware_skipped","hook":"response_stream","reason":reason}),
                    );
                }
            };
            if let Some(key) = text_key
                && let Some(text) = transformed["effective"].as_str()
            {
                event[key] = text.into();
            }
            if ["provenance", "fallback"].iter().any(|field| {
                transformed[*field]
                    .as_array()
                    .is_some_and(|entries| !entries.is_empty())
            }) {
                Accounts::record_middleware(
                    &self.account,
                    &json!({"kind":"response_stream","value":transformed}),
                )?;
            }
        }
        Ok(())
    }
}

impl ResponseAttempt for Attempt {
    fn observe(&mut self, event: &mut Value, valid: bool) -> Result<(), TransportError> {
        self.event(event, valid)
    }

    fn failed(&mut self, reason: &str) {
        if !self.failed && !self.settled {
            let _ = self.account.task.fail(&self.admission, reason);
            let _ = self.persist_cost_capture();
            self.failed = true;
        }
    }
}

impl Drop for Attempt {
    fn drop(&mut self) {
        if !self.settled {
            self.failed("request cancelled, dropped, or closed without priced final usage");
        }
    }
}

#[cfg(test)]
#[path = "accounting_tests.rs"]
mod tests;
