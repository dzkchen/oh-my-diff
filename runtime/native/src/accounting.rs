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
    pub rates: Option<Rates>,
    pub repository_identity: String,
    pub cost_capture: std::path::PathBuf,
    pub route: Option<String>,
    pub lead_routes: Vec<RequestRoute>,
    pub worker_authorization: Option<(std::path::PathBuf, String)>,
    pub credential: Option<String>,
}

static CREDENTIAL_ROOT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

pub fn set_credential_root(root: std::path::PathBuf) {
    let _ = CREDENTIAL_ROOT.set(root);
}

const ROUTE_HEADER: &str = "x-omd-route";

fn mark_route(request: &mut Request, name: &str) -> Result<(), TransportError> {
    let value = http::HeaderValue::from_str(name)
        .map_err(|_| denied("route name is not a valid header"))?;
    request.headers.insert(ROUTE_HEADER, value);
    Ok(())
}

fn inject_credential(
    request: &mut Request,
    credential: Option<&str>,
) -> Result<(), TransportError> {
    let Some(profile) = credential else {
        return Ok(());
    };
    let root = CREDENTIAL_ROOT
        .get()
        .ok_or_else(|| denied("credential store unavailable"))?;
    let origin = codex_omd::credentials::url_origin(&request.url)
        .ok_or_else(|| denied("request URL has no origin"))?;
    let secret = codex_omd::credentials::CredentialProfiles::open(root)
        .and_then(|profiles| profiles.secret(profile, &origin))
        .map_err(|error| denied(error.to_string()))?;
    let mut value = http::HeaderValue::from_str(&format!("Bearer {}", secret.token))
        .map_err(|_| denied("credential token is not a valid header"))?;
    value.set_sensitive(true);
    request.headers.insert(http::header::AUTHORIZATION, value);
    match secret.account_id {
        Some(account) => {
            let value = http::HeaderValue::from_str(&account)
                .map_err(|_| denied("credential account is not a valid header"))?;
            request.headers.insert("chatgpt-account-id", value);
        }
        None => {
            request.headers.remove("chatgpt-account-id");
        }
    }
    Ok(())
}

#[derive(Clone, serde::Serialize)]
pub struct RequestRoute {
    pub name: String,
    pub model: String,
    pub provider: String,
    pub reasoning: String,
    #[serde(skip)]
    pub rates: Rates,
    pub credential: Option<String>,
}

static GLOBAL: std::sync::OnceLock<Arc<Accounts>> = std::sync::OnceLock::new();

pub fn global() -> Arc<Accounts> {
    GLOBAL
        .get_or_init(|| {
            let accounts = Arc::new(Accounts::default());
            let _ = codex_api::request_observer::install_response_observer(accounts.clone());
            accounts
        })
        .clone()
}

/// Serves a model interceptor's own host call for a thread: `(thread, caller, call, active)`.
pub type ModDispatcher = Arc<
    dyn Fn(&str, &str, codex_omd::ModHostCall, &dyn Fn() -> bool) -> std::io::Result<Value>
        + Send
        + Sync,
>;

type RequiredSurfaces = Arc<Mutex<Vec<&'static str>>>;

#[derive(Default)]
pub struct Accounts(
    pub Mutex<BTreeMap<String, Account>>,
    Mutex<Option<(Arc<Mutex<codex_omd::ModHost>>, RequiredSurfaces)>>,
    AtomicU64,
    Arc<AtomicUsize>,
    Mutex<Option<ModDispatcher>>,
);

const MIDDLEWARE_WAIT: Duration = Duration::from_secs(2);
const MIDDLEWARE_LOG_BYTES: u64 = 8 * 1024 * 1024;

enum Hook<T> {
    Ran(T),
    Absent,
    Skipped(&'static str),
}

impl Accounts {
    pub fn install_mod_runtime(
        &self,
        runtime: Arc<Mutex<codex_omd::ModHost>>,
        required: RequiredSurfaces,
    ) {
        if let Ok(mut installed) = self.1.lock() {
            *installed = Some((runtime, required));
        }
    }

    pub fn install_mod_dispatcher(&self, dispatcher: ModDispatcher) {
        if let Ok(mut installed) = self.4.lock() {
            *installed = Some(dispatcher);
        }
    }

    fn mods(&self) -> Option<Arc<Mutex<codex_omd::ModHost>>> {
        self.1
            .lock()
            .ok()
            .and_then(|installed| installed.as_ref().map(|(runtime, _)| runtime.clone()))
    }

    fn required(&self, surface: &str) -> bool {
        self.1.lock().ok().is_none_or(|installed| {
            installed.as_ref().is_none_or(|(_, required)| {
                required
                    .lock()
                    .map_or(true, |required| required.contains(&surface))
            })
        })
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
        body: Some(format!("local OMD request policy: {}", message.to_string())),
        retry_after: None,
    }
}

impl Accounts {
    fn request_route(
        &self,
        mods: &Mutex<codex_omd::ModHost>,
        account: &Account,
        thread: &str,
        value: &Value,
    ) -> Result<Option<RequestRoute>, TransportError> {
        let request_id = format!("mod-request-{}", self.2.fetch_add(1, Ordering::Relaxed) + 1);
        let original = json!({"name": account.route.clone().unwrap_or_else(|| "session".into()),
            "model": value.get("model").cloned().unwrap_or(Value::Null),
            "provider": account.provider,
            "reasoning": value.pointer("/reasoning/effort").cloned().unwrap_or(Value::Null),
            "roles": [if account.owner == "lead" {"lead"} else {"worker"}],
            "billing": if account.rates.as_ref().is_none_or(|rates| rates.included_subscription) {"included_subscription"} else {"explicit_paid_api_grant"},
            "tools": [], "available": true, "credential": account.credential});
        let mut routes = vec![original.clone()];
        if account.owner == "lead" {
            routes.extend(account.lead_routes.iter().map(|route| {
                json!({"name":route.name,"model":route.model,"provider":route.provider,"reasoning":route.reasoning,
                    "roles":["lead"],"billing":if route.rates.included_subscription {"included_subscription"} else {"explicit_paid_api_grant"},
                    "tools":[],"available":true,"credential":route.credential})
            }));
        }
        let payload = json!({"request_id":request_id,"scope":payload_scope(account, thread),
            "routes":routes,"original":original,"effective":original,"provenance":[]});
        let mut selected = original["name"].as_str().unwrap_or_default().to_owned();
        match Self::middleware(
            mods,
            &self.3,
            !account.owner.starts_with("mod-"),
            "model_request",
            |runtime| runtime.model_request(payload, || account.task.check_active().is_ok()),
        )? {
            Hook::Ran(effective) => {
                let effective = effective.map_err(denied)?;
                if effective["provenance"]
                    .as_array()
                    .is_some_and(|provenance| !provenance.is_empty())
                {
                    Self::record_middleware(
                        account,
                        &json!({"kind":"model_request","value":effective}),
                    )?;
                }
                selected = effective["effective"]["name"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
            }
            Hook::Absent => {}
            Hook::Skipped(reason) => {
                Self::record_middleware(
                    account,
                    &json!({"kind":"middleware_skipped","hook":"model_request","request_id":request_id,"reason":reason}),
                )?;
            }
        }
        let deadline = Instant::now() + MIDDLEWARE_WAIT;
        let intercepting = loop {
            match mods.try_lock() {
                Ok(runtime) => break runtime.intercepts("model_request"),
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err(denied("mod runtime poisoned"));
                }
                Err(std::sync::TryLockError::WouldBlock)
                    if account.owner.starts_with("mod-")
                        && self.3.load(Ordering::Acquire) == 0
                        && !self.required("model_request") =>
                {
                    Self::record_middleware(
                        account,
                        &json!({"kind":"intercept_skipped","surface":"model_request","request_id":request_id,"reason":"mod_callback_in_flight"}),
                    )?;
                    break None;
                }
                Err(std::sync::TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(std::sync::TryLockError::WouldBlock) => break Some(true),
            }
        };
        if let Some(required) = intercepting {
            let dispatcher = self.4.lock().ok().and_then(|dispatcher| dispatcher.clone());
            let active = || account.task.check_active().is_ok();
            let input = json!({"request_id":request_id,"scope":payload_scope(account, thread),
                "routes":routes,"original":original,"route":selected});
            let origin = json!({"caller":"engine","thread_id":thread,
                "agent_id":if account.owner == "lead" { Value::Null } else { Value::String(account.owner.clone()) }});
            let _thread = codex_omd::StateThread::enter(Some(thread.to_owned()));
            let chain = codex_omd::intercept_shared(
                mods,
                "model_request",
                required,
                input,
                origin,
                active,
                |caller, call| match &dispatcher {
                    Some(dispatch) => dispatch(thread, caller, call, &active),
                    None => Err(std::io::Error::other(
                        "host_operation_unavailable: no session dispatcher",
                    )),
                },
                |input| Ok(json!({"route": input["route"]})),
            )
            .map_err(denied)?;
            if !chain.trace.is_empty() {
                Self::record_middleware(
                    account,
                    &json!({"kind":"intercept","surface":"model_request","value":chain}),
                )?;
            }
            if let Some(reason) = chain.result["deny"].as_str() {
                return Err(denied(format!(
                    "a mod refused this model request: {reason}"
                )));
            }
            selected = chain.result["route"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
        }
        if selected == original["name"].as_str().unwrap_or_default() {
            return Ok(None);
        }
        account
            .lead_routes
            .iter()
            .find(|route| route.name == selected)
            .filter(|_| account.owner == "lead")
            .cloned()
            .map(Some)
            .ok_or_else(|| denied("mod selected a route that is not configured for this thread"))
    }
}

fn payload_scope(account: &Account, thread: &str) -> Value {
    json!({"thread_id":thread,
        "agent_id":if account.owner == "lead" { Value::Null } else { Value::String(account.owner.clone()) },
        "kind":if account.owner == "lead" {"main"} else {"subagent"}})
}

fn switch_route(
    request: &mut Request,
    value: &mut Value,
    account: &mut Account,
    route: &RequestRoute,
) -> Result<(), TransportError> {
    mark_route(request, &route.name)?;
    value["model"] = route.model.clone().into();
    value["reasoning"]["effort"] = route.reasoning.clone().into();
    account.rates = account.rates.as_ref().map(|_| route.rates.clone());
    Ok(())
}

impl ResponseObserver for Accounts {
    fn prepare(
        &self,
        request: &mut Request,
        body: &mut Option<EncodedJsonBody>,
    ) -> Result<(), TransportError> {
        let Some(thread) = request
            .headers
            .get("thread-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
        else {
            return Ok(());
        };
        let Some(mut account) = self
            .0
            .lock()
            .map_err(|_| denied("account lock poisoned"))?
            .get(&thread)
            .cloned()
        else {
            return Ok(());
        };
        let mut value: Value = serde_json::from_slice(
            body.as_ref()
                .ok_or_else(|| denied("missing JSON request"))?
                .as_bytes(),
        )
        .map_err(denied)?;
        let mut edited = false;
        if account.owner == "lead"
            && let Some(selected) = crate::mods::take_route_selection(&thread)
            && let Some(route) = account
                .lead_routes
                .iter()
                .find(|route| route.name == selected)
                .cloned()
        {
            switch_route(request, &mut value, &mut account, &route)?;
            account.credential = route.credential;
            account.route = Some(route.name);
            edited = true;
        }
        let mods = self.mods();
        if let Some(mods) = &mods
            && let Some(items) = value["input"].as_array().cloned()
            && let Hook::Ran(result) = Self::middleware(
                mods,
                &self.3,
                !account.owner.starts_with("mod-"),
                "history",
                |runtime| {
                    let payload = json!({"thread_id": thread, "agent_id": (account.owner != "lead").then_some(&account.owner),
                        "model": value["model"], "items": codex_omd::history::view(&items)});
                    runtime.history(payload, || account.task.check_active().is_ok())
                },
            )?
        {
            let history = result
                .map_err(|error| error.to_string())
                .and_then(|decision| match decision {
                    None => Ok(None),
                    Some((owner, edit)) => serde_json::from_value(edit)
                        .map_err(|error| format!("history_edit_invalid: {error}"))
                        .and_then(|edit| codex_omd::history::apply(&items, edit))
                        .map(|history| Some((owner, history))),
                });
            match history {
                Ok(Some((owner, history))) => {
                    Self::record_middleware(
                        &account,
                        &json!({"kind": "history", "owner": owner,
                        "items_before": items.len(), "items_after": history.len()}),
                    )?;
                    value["input"] = Value::Array(history);
                    edited = true;
                }
                Ok(None) => {}
                Err(error) => {
                    Self::record_middleware(
                        &account,
                        &json!({"kind": "history_failed", "reason": error}),
                    )?;
                }
            }
        }
        if let Some(mods) = &mods
            && let Some(route) = self.request_route(mods, &account, &thread, &value)?
        {
            switch_route(request, &mut value, &mut account, &route)?;
            edited = true;
        }
        if let Some(rates) = account
            .rates
            .as_ref()
            .filter(|rates| !rates.included_subscription)
        {
            if rates.max_output_tokens == 0 {
                return Err(denied("missing output ceiling"));
            }
            value["max_output_tokens"] = rates.max_output_tokens.into();
            value["service_tier"] = "default".into();
            edited = true;
        }
        if edited {
            *body = Some(EncodedJsonBody::encode(&value).map_err(denied)?);
        }
        Ok(())
    }

    fn before_send(
        &self,
        request: &mut Request,
        body: Option<&EncodedJsonBody>,
    ) -> Result<Option<Box<dyn ResponseAttempt>>, TransportError> {
        let Some(thread) = request
            .headers
            .get("thread-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
        else {
            return Ok(None);
        };
        let Some(account) = self
            .0
            .lock()
            .map_err(|_| denied("account lock poisoned"))?
            .get(&thread)
            .cloned()
        else {
            return Ok(None);
        };
        let requested = body
            .and_then(|body| serde_json::from_slice::<Value>(body.as_bytes()).ok())
            .and_then(|value| {
                value
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        let marked = request
            .headers
            .remove(ROUTE_HEADER)
            .and_then(|value| value.to_str().ok().map(str::to_owned));
        let switched = (account.owner == "lead")
            .then(|| {
                account.lead_routes.iter().find(|route| match &marked {
                    Some(name) => &route.name == name,
                    None => {
                        Some(&route.model) == requested.as_ref() && route.model != account.model
                    }
                })
            })
            .flatten()
            .cloned();
        let credential = match &switched {
            Some(route) => route.credential.clone(),
            None => account.credential.clone(),
        };
        inject_credential(request, credential.as_deref())?;
        let Some(rates) = account.rates.clone() else {
            let value = body
                .and_then(|body| serde_json::from_slice::<Value>(body.as_bytes()).ok())
                .unwrap_or(Value::Null);
            return Ok(Some(Box::new(Attempt {
                model: value
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or(&account.model)
                    .to_owned(),
                account,
                admission: None,
                mods: self.mods(),
                holders: self.3.clone(),
                settled: false,
                failed: false,
                boundary_items: 0,
            })));
        };
        let mut account = account;
        let rates = match switched {
            Some(route) => {
                account.model = route.model;
                account.rates = Some(route.rates.clone());
                route.rates
            }
            None => rates,
        };
        let model = account.model.clone();
        if let Some((path, sha)) = &account.worker_authorization {
            if !worker_authorized(
                path,
                sha,
                &account.repository_identity,
                &account.provider,
                &account.model,
                &account.url,
                rates.included_subscription,
            ) {
                return Err(denied("worker authorization revoked or changed"));
            }
            if rates.included_subscription
                && (request.url != SUBSCRIPTION_RESPONSES_URL
                    || !request.headers.contains_key("chatgpt-account-id"))
            {
                return Err(denied("worker requires the native subscription request"));
            }
        }
        let bytes = body
            .ok_or_else(|| denied("missing JSON request"))?
            .as_bytes();
        if bytes.len() > account.max_request_bytes {
            return Err(denied("request exceeds context byte ceiling"));
        }
        let value: Value = serde_json::from_slice(bytes).map_err(denied)?;
        if value.get("model").and_then(Value::as_str) != Some(model.as_str())
            || value.get("stream") != Some(&Value::Bool(true))
        {
            return Err(denied("unapproved model or nonstreaming request"));
        }
        if !account.url.is_empty() {
            request.url = account.url.clone();
        }
        if rates.included_subscription && rates.reservation_microusd != 0 {
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
        if !rates.included_subscription {
            let output = value
                .get("max_output_tokens")
                .and_then(Value::as_u64)
                .filter(|v| *v > 0 && *v <= rates.max_output_tokens)
                .ok_or_else(|| denied("output ceiling absent or exceeded"))?;
            let input_ceiling = bytes.len() as u128
                + 4096
                + u128::from(rates.max_output_tokens.max(4096)) * u128::from(reasoning);
            if input_ceiling > u128::from(rates.input_token_ceiling) {
                return Err(denied("conservative input ceiling exceeded"));
            }
            let reservation = (input_ceiling
                * u128::from(
                    rates
                        .input_microusd_per_million
                        .max(rates.cached_microusd_per_million),
                )
                + u128::from(output) * u128::from(rates.output_microusd_per_million))
            .div_ceil(1_000_000);
            if reservation > u128::from(rates.reservation_microusd) {
                return Err(denied("request exceeds conservative exposure reservation"));
            }
        }
        let admission = account
            .task
            .admit_with_billing(
                &account.owner,
                &account.provider,
                &model,
                rates.reservation_microusd,
                rates.external_subscription,
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
            model,
            account,
            admission: Some(admission),
            mods: self.mods(),
            holders: self.3.clone(),
            settled: false,
            failed: false,
            boundary_items: 0,
        })))
    }

    fn requires_observation(&self, thread: Option<&str>) -> bool {
        thread.is_some_and(|thread| {
            self.0.lock().map_or(true, |accounts| {
                accounts
                    .get(thread)
                    .is_some_and(|account| account.rates.is_some())
            })
        })
    }
}

struct Attempt {
    account: Account,
    admission: Option<Admission>,
    model: String,
    mods: Option<Arc<Mutex<codex_omd::ModHost>>>,
    holders: Arc<AtomicUsize>,
    settled: bool,
    failed: bool,
    boundary_items: u32,
}

impl Attempt {
    fn persist_cost_capture(&self) -> Result<(), TransportError> {
        use std::io::Write;

        let bytes = serde_json::to_vec(&self.account.task.cost_capture().map_err(denied)?)
            .map_err(denied)?;
        let temporary = self.account.cost_capture.with_extension(format!(
            "json.{}.{}.tmp",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(denied)?
                .as_nanos()
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

    fn observed(&mut self, usage: Option<Value>, status: &str) -> Result<(), TransportError> {
        if self.settled || self.failed {
            return Ok(());
        }
        if status == "completed" {
            self.settled = true;
        } else {
            self.failed = true;
        }
        self.account
            .task
            .observe(
                &self.account.owner,
                &self.account.provider,
                &self.model,
                usage,
                status,
            )
            .map_err(denied)?;
        self.persist_cost_capture()
    }

    fn settle(&mut self, raw: &Value) -> Result<(), TransportError> {
        let success = raw["type"] == "response.completed";
        let usage = raw
            .get("response")
            .and_then(|v| v.get("usage"))
            .filter(|v| v.is_object())
            .cloned();
        let (Some(rates), Some(admission)) = (self.account.rates.clone(), self.admission.clone())
        else {
            return self.observed(usage, if success { "completed" } else { "failed" });
        };
        if !success {
            self.failed("provider returned failed or incomplete response");
        }
        if let Some(usage) = usage {
            self.account
                .task
                .retain_usage(&admission, usage.clone())
                .map_err(denied)?;
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
                    && (input > rates.input_token_ceiling || output > rates.max_output_tokens)
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
                    .settle(&admission, usage.clone(), amount)
                    .map_err(denied)?;
                self.settled = true;
                self.persist_cost_capture()?;
            }
        }
        if !self.settled {
            self.failed("terminal response has unpriced or missing usage");
        }
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
                self.settle(&raw)?;
            }
            Some("error") => self.failed("provider stream error"),
            _ => {}
        }
        let Some(mods) = self.mods.clone() else {
            return Ok(());
        };
        let kind = raw["type"].as_str().unwrap_or("invalid");
        let text_key = if kind == "response.output_text.delta" {
            Some("delta")
        } else if kind == "response.output_text.done" {
            Some("text")
        } else {
            None
        };
        let boundary = kind == "response.output_item.done";
        if boundary {
            self.boundary_items = self.boundary_items.saturating_add(1);
        }
        let text = text_key
            .and_then(|key| raw.get(key).and_then(Value::as_str))
            .map(str::to_owned)
            .or_else(|| {
                boundary
                    .then(|| {
                        raw.pointer("/item/content")
                            .and_then(Value::as_array)
                            .map(|content| {
                                content
                                    .iter()
                                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                                    .collect::<Vec<_>>()
                                    .join("")
                            })
                    })
                    .flatten()
            });
        let payload = json!({"kind":kind,"raw_sha256":crate::execution::hash(&serde_json::to_vec(&raw).map_err(denied)?),
            "raw_usage":raw.pointer("/response/usage").cloned().unwrap_or(Value::Null),
            "opaque_reasoning":kind.contains("reasoning"),"protected":text_key.is_none(),"text":text,
            "boundary":boundary,"attempt":self.boundary_items});
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
        }) || !transformed["control"].is_null()
        {
            Accounts::record_middleware(
                &self.account,
                &json!({"kind":"response_stream","value":transformed}),
            )?;
        }
        if !transformed["control"].is_null() {
            return Err(codex_api::request_observer::stream_control_error(
                &transformed["control"],
            ));
        }
        Ok(())
    }
}

impl ResponseAttempt for Attempt {
    fn observe(&mut self, event: &mut Value, valid: bool) -> Result<(), TransportError> {
        self.event(event, valid)
    }

    fn failed(&mut self, reason: &str) {
        if self.failed || self.settled {
            return;
        }
        match &self.admission {
            Some(admission) => {
                let _ = self.account.task.fail(admission, reason);
                let _ = self.persist_cost_capture();
                self.failed = true;
            }
            None => {
                let _ = self.observed(None, "failed");
            }
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
