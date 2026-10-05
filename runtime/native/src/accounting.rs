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
use std::collections::VecDeque;
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
    pub context_window: Option<i64>,
    pub max_output_tokens: Option<u64>,
    pub capture_tools: bool,
}

static CREDENTIAL_ROOT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

pub fn set_credential_root(root: std::path::PathBuf) {
    let _ = CREDENTIAL_ROOT.set(root);
}

const ROUTE_HEADER: &str = "x-omd-route";
const REQUEST_HEADER: &str = "x-omd-request-id";
const SYNTHETIC_HEADER: &str = "x-omd-synthetic";
const SUMMARY_TEXT_BYTES: usize = 4096;
const COLLECTED_TEXT_BYTES: usize = 32_768;

fn cut(text: &str, limit: usize) -> &str {
    let mut end = limit.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

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
    #[serde(skip)]
    pub url: String,
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

pub type ModDispatcher = codex_omd::host::SessionDispatcher;

/// Delivers an observer event to mods outside the transport thread.
pub type ModNotifier = Arc<dyn Fn(&'static str, Value) + Send + Sync>;

type RequiredSurfaces = Arc<Mutex<Vec<&'static str>>>;

#[derive(Default)]
struct RequestState {
    fingerprints: BTreeMap<String, Vec<(String, String)>>,
    retries: BTreeMap<String, u32>,
    synthetic: BTreeMap<String, (String, Vec<Value>)>,
    responses: BTreeMap<String, Vec<Value>>,
    verdicts: BTreeMap<String, Option<Edits>>,
    verdict_order: VecDeque<String>,
}

type Edits = Vec<(usize, usize, String)>;

const VERDICTS: usize = 8192;

impl RequestState {
    fn remember(&mut self, key: String, verdict: Option<Edits>) {
        if self.verdicts.insert(key.clone(), verdict).is_none() {
            self.verdict_order.push_back(key);
        }
        while self.verdict_order.len() > VERDICTS {
            if let Some(oldest) = self.verdict_order.pop_front() {
                self.verdicts.remove(&oldest);
            }
        }
    }
}

#[derive(Default)]
pub struct Accounts(
    pub Mutex<BTreeMap<String, Account>>,
    Mutex<Option<(Arc<Mutex<codex_omd::ModHost>>, RequiredSurfaces)>>,
    AtomicU64,
    Arc<AtomicUsize>,
    Mutex<Option<ModDispatcher>>,
    Mutex<Option<ModNotifier>>,
    Arc<Mutex<RequestState>>,
);

const MIDDLEWARE_WAIT: Duration = Duration::from_secs(2);
const SEND_POLICY_WAIT: Duration = Duration::from_secs(5);
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

    pub fn install_mod_notifier(&self, notifier: ModNotifier) {
        if let Ok(mut installed) = self.5.lock() {
            *installed = Some(notifier);
        }
    }

    /// Keeps the `model_response` records of a thread until `take_responses`.
    pub fn collect(&self, thread: &str) {
        if let Ok(mut state) = self.6.lock() {
            state.responses.insert(thread.to_owned(), Vec::new());
        }
    }

    pub fn take_responses(&self, thread: &str) -> Vec<Value> {
        self.6
            .lock()
            .ok()
            .and_then(|mut state| state.responses.remove(thread))
            .unwrap_or_default()
    }

    fn dispatcher(&self) -> Option<ModDispatcher> {
        self.4.lock().ok().and_then(|dispatcher| dispatcher.clone())
    }

    fn notifier(&self) -> Option<ModNotifier> {
        self.5.lock().ok().and_then(|notifier| notifier.clone())
    }

    /// Whether `surface` has interceptors (`Some(required)`), waiting for a busy runtime unless a mod-owned
    /// request would deadlock on its own in-flight callback.
    fn intercepting(
        mods: &Mutex<codex_omd::ModHost>,
        holders: &AtomicUsize,
        account: &Account,
        surface: &'static str,
        required: bool,
    ) -> Result<Option<bool>, TransportError> {
        let deadline = Instant::now() + MIDDLEWARE_WAIT;
        loop {
            match mods.try_lock() {
                Ok(runtime) => return Ok(runtime.intercepts(surface)),
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err(denied("mod runtime poisoned"));
                }
                Err(std::sync::TryLockError::WouldBlock)
                    if account.owner.starts_with("mod-")
                        && holders.load(Ordering::Acquire) == 0
                        && !required =>
                {
                    Self::record_middleware(
                        account,
                        &json!({"kind":"intercept_skipped","surface":surface,"reason":"mod_callback_in_flight"}),
                    )?;
                    return Ok(None);
                }
                Err(std::sync::TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(std::sync::TryLockError::WouldBlock) if required => return Ok(Some(true)),
                Err(std::sync::TryLockError::WouldBlock) => {
                    Self::record_middleware(
                        account,
                        &json!({"kind":"intercept_skipped","surface":surface,"reason":"mod_runtime_busy"}),
                    )?;
                    return Ok(None);
                }
            }
        }
    }

    /// The final-request stage under the runtime lock; a busy runtime refuses when a policy is required.
    fn send_policy(
        &self,
        mods: &Mutex<codex_omd::ModHost>,
        owner: Option<&str>,
    ) -> Result<Option<codex_omd::SendPolicy>, TransportError> {
        let required = self.required("model_send");
        let deadline = Instant::now()
            + if required {
                SEND_POLICY_WAIT
            } else {
                MIDDLEWARE_WAIT
            };
        loop {
            match mods.try_lock() {
                Ok(runtime) => return Ok(runtime.send_policy()),
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err(denied("mod runtime poisoned"));
                }
                Err(std::sync::TryLockError::WouldBlock)
                    if !required
                        && (owner.is_some_and(|owner| owner.starts_with("mod-"))
                            && self.3.load(Ordering::Acquire) == 0
                            || Instant::now() >= deadline) =>
                {
                    return Ok(None);
                }
                Err(std::sync::TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    return Err(denied(
                        "final_request_refused: intercept_required_failed: mod_runtime_busy",
                    ));
                }
            }
        }
    }

    /// Runs `model_send` over the exact body about to be sent, page by page, until no policy edits it.
    #[allow(clippy::too_many_arguments)]
    fn police(
        &self,
        mods: &Mutex<codex_omd::ModHost>,
        account: Option<&Account>,
        thread: &str,
        request_id: &str,
        attempt: u32,
        value: &mut Value,
    ) -> Result<bool, TransportError> {
        let Some(policy) = self.send_policy(mods, account.map(|account| account.owner.as_str()))?
        else {
            return Ok(false);
        };
        let refuse = |reason: String| {
            if let Some(account) = account {
                let _ = Self::record_middleware(
                    account,
                    &json!({"kind":"final_request_refused","request_id":request_id,"reason":reason}),
                );
            }
            denied(format!("final_request_refused: {reason}"))
        };
        if let Some(reason) = policy.unavailable {
            return Err(refuse(format!("request_policy_unavailable: {reason}")));
        }
        let scope = match account {
            Some(account) => payload_scope(account, thread),
            None => {
                json!({"thread_id":(!thread.is_empty()).then_some(thread),"agent_id":null,"kind":"internal"})
            }
        };
        let provider = account.map_or(Value::Null, |account| account.provider.clone().into());
        let route = account
            .and_then(|account| account.route.clone())
            .map_or(Value::Null, Value::from);
        let context =
            json!([policy.fingerprint, provider, route, value["model"], scope]).to_string();
        let key = |segment: &Value| {
            crate::execution::hash(
                json!([
                    context,
                    segment["kind"],
                    segment["role"],
                    segment["editable"],
                    segment["sha256"]
                ])
                .to_string()
                .as_bytes(),
            )
        };
        let origin =
            json!({"caller":"engine","thread_id":scope["thread_id"],"agent_id":scope["agent_id"]});
        let dispatcher = self.dispatcher();
        let active = || account.is_none_or(|account| account.task.check_active().is_ok());
        let _thread =
            codex_omd::StateThread::enter((!thread.is_empty()).then(|| thread.to_owned()));
        let (mut pages_run, mut scanned, mut cached) = (0, 0, 0);
        let mut applied = Vec::new();
        for round in 0..2 {
            let (segments, opaque) = codex_omd::model_request::send_segments(value);
            let mut edits = BTreeMap::<String, Edits>::new();
            let mut keys = Vec::new();
            let mut pending = Vec::new();
            {
                let state = self
                    .6
                    .lock()
                    .map_err(|_| denied("request state poisoned"))?;
                for segment in segments {
                    let id = segment["id"].as_str().unwrap_or_default().to_owned();
                    let segment_key = key(&segment);
                    match state.verdicts.get(&segment_key) {
                        Some(None) => cached += 1,
                        Some(Some(_)) if round > 0 => {
                            return Err(refuse(format!("final_request_unsettled: {id}")));
                        }
                        Some(Some(known)) => {
                            cached += 1;
                            edits.insert(id, known.clone());
                        }
                        None => {
                            keys.push((id, segment_key));
                            pending.push(segment);
                        }
                    }
                }
            }
            scanned += pending.len();
            let mut pages = codex_omd::model_request::send_pages(pending);
            if pages.len() > codex_omd::model_request::SEND_PAGES {
                return Err(refuse(format!(
                    "final_request_too_large: {} pages",
                    pages.len()
                )));
            }
            if pages.is_empty() && round == 0 {
                pages.push(Vec::new());
            }
            let count = pages.len();
            let mut found = BTreeMap::<String, Edits>::new();
            let mut uncached = std::collections::BTreeSet::new();
            for (index, page) in pages.into_iter().enumerate() {
                let input = json!({"request_id":request_id,"attempt":attempt,"scope":scope,
                    "provider":provider,"route":route,"model":value["model"],"page":index + 1,
                    "pages":count,"cached":cached,"segments":page,"opaque":opaque});
                let chain = codex_omd::intercept_shared(
                    mods,
                    "model_send",
                    policy.required,
                    input,
                    origin.clone(),
                    active,
                    |caller, call| match &dispatcher {
                        Some(dispatch) => dispatch(thread, caller, call, &active),
                        None => Err(std::io::Error::other(
                            "host_operation_unavailable: no session dispatcher",
                        )),
                    },
                    |_| Ok(json!({"edits": []})),
                )
                .map_err(|error| refuse(error.to_string()))?;
                pages_run += 1;
                if let Some(reason) = chain.result["deny"].as_str() {
                    return Err(refuse(format!("{}: {reason}", settled_by(&chain))));
                }
                if chain.result["cache"] == false {
                    uncached.extend(
                        page.iter()
                            .filter_map(|segment| segment["id"].as_str().map(str::to_owned)),
                    );
                }
                for (segment, start, end, text) in
                    codex_omd::model_request::page_edits(&chain.result, &page, value)
                        .map_err(|error| refuse(error))?
                {
                    found.entry(segment).or_default().push((start, end, text));
                }
            }
            if let Some(segment) = found.keys().next().filter(|_| round > 0) {
                return Err(refuse(format!("final_request_unsettled: {segment}")));
            }
            if let Ok(mut state) = self.6.lock() {
                for (id, segment_key) in keys.into_iter().filter(|(id, _)| !uncached.contains(id)) {
                    state.remember(segment_key, found.get(&id).cloned());
                }
            }
            for (id, ranges) in found {
                edits.entry(id).or_default().extend(ranges);
            }
            if edits.is_empty() {
                break;
            }
            for (id, ranges) in &edits {
                let text = value
                    .pointer(id)
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                for (start, end, _) in ranges {
                    let original = text.get(*start..*end).unwrap_or_default();
                    applied.push(json!({"segment":id,"start":start,"end":end,
                        "sha256":crate::execution::hash(original.as_bytes())}));
                }
            }
            codex_omd::model_request::apply_send_edits(value, &edits)
                .map_err(|error| refuse(error))?;
        }
        if let Some(account) = account {
            Self::record_middleware(
                account,
                &json!({"kind":"final_request","request_id":request_id,"attempt":attempt,
                    "pages":pages_run,"scanned":scanned,"cached":cached,"edits":applied}),
            )?;
        }
        Ok(!applied.is_empty())
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

#[derive(Default)]
struct Intercepted {
    route: Option<RequestRoute>,
    effort: Option<Value>,
    sections: Option<(Vec<Value>, Vec<Value>)>,
    answer: Option<(String, Value)>,
}

fn route_info(route: &RequestRoute) -> Value {
    json!({"name":route.name,"model":route.model,"provider":route.provider,"reasoning":route.reasoning,
        "roles":["lead"],"billing":if route.rates.included_subscription {"included_subscription"} else {"explicit_paid_api_grant"},
        "tools":[],"available":true,"credential":route.credential})
}

/// The mod whose result settled a chain: the outermost link that returned or caught.
fn settled_by(chain: &codex_omd::ModChain) -> String {
    chain
        .trace
        .iter()
        .rev()
        .find(|entry| matches!(entry["outcome"].as_str(), Some("returned" | "caught")))
        .and_then(|entry| entry["mod"].as_str())
        .unwrap_or("mod")
        .to_owned()
}

fn chain_record(surface: &str, request_id: &str, chain: &codex_omd::ModChain) -> Value {
    json!({"kind":"intercept","surface":surface,"request_id":request_id,
        "answered_by":chain.answered_by,"trace":chain.trace,
        "result":codex_omd::model_request::bounded(&chain.result)})
}

impl Accounts {
    #[allow(clippy::too_many_arguments)]
    fn intercept_request(
        &self,
        mods: &Mutex<codex_omd::ModHost>,
        account: &Account,
        thread: &str,
        value: &Value,
        request_id: &str,
        attempt: u32,
    ) -> Result<Intercepted, TransportError> {
        let Some(required) = Self::intercepting(
            mods,
            &self.3,
            account,
            "model_request",
            self.required("model_request"),
        )?
        else {
            return Ok(Intercepted::default());
        };
        let original = json!({"name": account.route.clone().unwrap_or_else(|| "session".into()),
            "model": value.get("model").cloned().unwrap_or(Value::Null),
            "provider": account.provider,
            "reasoning": value.pointer("/reasoning/effort").cloned().unwrap_or(Value::Null),
            "roles": [if account.owner == "lead" {"lead"} else {"worker"}],
            "billing": if account.rates.as_ref().is_none_or(|rates| rates.included_subscription) {"included_subscription"} else {"explicit_paid_api_grant"},
            "tools": [], "available": true, "credential": account.credential});
        let mut routes = vec![original.clone()];
        if account.owner == "lead" {
            routes.extend(account.lead_routes.iter().map(route_info));
        }
        let sections = codex_omd::model_request::sections(value);
        let effort = value
            .pointer("/reasoning/effort")
            .cloned()
            .unwrap_or(Value::Null);
        let tools = value["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();
        let input = json!({"request_id":request_id,"attempt":attempt,"scope":payload_scope(account, thread),
            "routes":routes,"original":original,"route":original["name"],"model":original["model"],
            "provider":account.provider,"effort":effort,"sections":sections,"tools":tools});
        let origin = json!({"caller":"engine","thread_id":thread,
            "agent_id":if account.owner == "lead" { Value::Null } else { Value::String(account.owner.clone()) }});
        let dispatcher = self.dispatcher();
        let active = || account.task.check_active().is_ok();
        let _thread = codex_omd::StateThread::enter(Some(thread.to_owned()));
        let state = self.6.clone();
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
            |input| {
                let mut probe = value.clone();
                if let Some(effective) = input["sections"].as_array() {
                    codex_omd::model_request::apply_sections(&mut probe, &sections, effective);
                }
                let current = codex_omd::model_request::fingerprints(&probe);
                let from = state.lock().ok().and_then(|mut state| {
                    let previous = state
                        .fingerprints
                        .insert(thread.to_owned(), current.clone())
                        .unwrap_or_default();
                    codex_omd::model_request::changed_from(&previous, &current)
                });
                Ok(json!({"route": input["route"], "effort": input["effort"], "cache": {"from": from}}))
            },
        )
        .map_err(denied)?;
        if !chain.trace.is_empty() {
            Self::record_middleware(account, &chain_record("model_request", request_id, &chain))?;
        }
        if let Some(reason) = chain.result["deny"].as_str() {
            return Err(denied(format!(
                "a mod refused this model request: {reason}"
            )));
        }
        if chain.answered_by.is_some() && chain.result.get("response").is_some() {
            return Ok(Intercepted {
                answer: Some((settled_by(&chain), chain.result)),
                ..Intercepted::default()
            });
        }
        let effective = chain.input;
        let selected = effective["route"].as_str().unwrap_or_default();
        let route = if selected == original["name"].as_str().unwrap_or_default() {
            None
        } else {
            Some(
                account
                    .lead_routes
                    .iter()
                    .find(|route| route.name == selected)
                    .filter(|_| account.owner == "lead")
                    .cloned()
                    .ok_or_else(|| {
                        denied("mod selected a route that is not configured for this thread")
                    })?,
            )
        };
        Ok(Intercepted {
            route,
            effort: (effective["effort"] != effort).then(|| effective["effort"].clone()),
            sections: effective["sections"]
                .as_array()
                .filter(|effective| **effective != sections)
                .map(|effective| (sections.clone(), effective.clone())),
            answer: None,
        })
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
    if route.provider != account.provider {
        if route.credential.is_none() {
            return Err(denied(
                "a route on another provider needs its own credential profile",
            ));
        }
        // Opaque reasoning belongs to the provider that produced it; the transcript keeps it.
        if let Some(input) = value["input"].as_array_mut() {
            input.retain(|item| item["type"] != "reasoning");
        }
        request.headers.insert(
            codex_api::request_observer::STRIP_ITEM_METADATA,
            http::HeaderValue::from_static("1"),
        );
    }
    mark_route(request, &route.name)?;
    value["model"] = route.model.clone().into();
    value["reasoning"]["effort"] = route.reasoning.clone().into();
    account.rates = Some(route.rates.clone());
    Ok(())
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
            .map(str::to_owned)
            .unwrap_or_default();
        let Some(mut account) = self
            .0
            .lock()
            .map_err(|_| denied("account lock poisoned"))?
            .get(&thread)
            .cloned()
        else {
            // Unenrolled internal requests (titles, reviews, guardians) still pass the final-request stage.
            let (Some(mods), Some(encoded)) = (self.mods(), body.as_ref()) else {
                return Ok(());
            };
            let mut value: Value = serde_json::from_slice(encoded.as_bytes()).map_err(denied)?;
            let request_id = format!("req-{}", self.2.fetch_add(1, Ordering::Relaxed) + 1);
            if self.police(&mods, None, &thread, &request_id, 1, &mut value)? {
                *body = Some(EncodedJsonBody::encode(&value).map_err(denied)?);
            }
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
            account.provider = route.provider;
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
        let request_id = format!("req-{}", self.2.fetch_add(1, Ordering::Relaxed) + 1);
        request
            .headers
            .insert(REQUEST_HEADER, request_id.parse().map_err(denied)?);
        let attempt = self
            .6
            .lock()
            .ok()
            .and_then(|mut state| state.retries.remove(&thread))
            .unwrap_or(1);
        if let Some(mods) = &mods {
            let intercepted =
                self.intercept_request(mods, &account, &thread, &value, &request_id, attempt)?;
            if let Some((owner, answer)) = intercepted.answer {
                let mut next = 0;
                let events = codex_omd::model_request::synthetic_events(
                    &answer,
                    &format!("{request_id}-{owner}"),
                    &mut || {
                        next += 1;
                        format!("mod-{owner}-{request_id}-{next}")
                    },
                );
                if let Ok(mut state) = self.6.lock() {
                    state.synthetic.insert(request_id.clone(), (owner, events));
                }
                request
                    .headers
                    .insert(SYNTHETIC_HEADER, request_id.parse().map_err(denied)?);
                return Ok(());
            }
            if let Some(route) = &intercepted.route {
                switch_route(request, &mut value, &mut account, route)?;
                account.route = Some(route.name.clone());
                account.provider = route.provider.clone();
                edited = true;
            }
            if let Some(effort) = intercepted.effort {
                value["reasoning"]["effort"] = effort;
                edited = true;
            }
            if let Some((given, effective)) = intercepted.sections {
                edited |= codex_omd::model_request::apply_sections(&mut value, &given, &effective);
            }
        }
        request.headers.insert(
            "x-omd-attempt",
            attempt.to_string().parse().map_err(denied)?,
        );
        if let Some(rates) = account
            .rates
            .as_ref()
            .filter(|rates| !rates.included_subscription)
        {
            if rates.max_output_tokens == 0 {
                return Err(denied("missing output ceiling"));
            }
            value["max_output_tokens"] = rates
                .max_output_tokens
                .min(account.max_output_tokens.unwrap_or(u64::MAX))
                .into();
            value["service_tier"] = "default".into();
            edited = true;
        } else if let Some(tokens) = account.max_output_tokens {
            value["max_output_tokens"] = tokens.into();
            edited = true;
        }
        if let Some(mods) = &mods {
            edited |= self.police(
                mods,
                Some(&account),
                &thread,
                &request_id,
                attempt,
                &mut value,
            )?;
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
        let header = |request: &Request, name: &str| {
            request
                .headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        };
        let request_id = header(request, REQUEST_HEADER).unwrap_or_default();
        let attempt = request
            .headers
            .remove("x-omd-attempt")
            .and_then(|value| value.to_str().ok()?.parse().ok())
            .unwrap_or(1);
        if let Some(key) = header(request, SYNTHETIC_HEADER) {
            let owner = self
                .6
                .lock()
                .ok()
                .and_then(|state| state.synthetic.get(&key).map(|(owner, _)| owner.clone()))
                .ok_or_else(|| denied("synthetic answer missing"))?;
            let model = account.model.clone();
            return Ok(Some(Box::new(self.attempt(
                account,
                thread,
                request_id,
                attempt,
                model,
                None,
                Some(owner),
            ))));
        }
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
        let mut account = account;
        account.credential = credential;
        let mut url = account.url.clone();
        if let Some(route) = switched {
            account.model = route.model;
            account.rates = Some(route.rates);
            account.route = Some(route.name);
            account.provider = route.provider;
            if !route.url.is_empty() {
                url = route.url;
            }
        }
        let Some(rates) = account.rates.clone() else {
            let model = requested.unwrap_or_else(|| account.model.clone());
            return Ok(Some(Box::new(self.attempt(
                account, thread, request_id, attempt, model, None, None,
            ))));
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
        if !url.is_empty() {
            request.url = url;
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
        Ok(Some(Box::new(self.attempt(
            account,
            thread,
            request_id,
            attempt,
            model,
            Some(admission),
            None,
        ))))
    }

    fn answer(&self, request: &Request) -> Option<Vec<Value>> {
        let key = request.headers.get(SYNTHETIC_HEADER)?.to_str().ok()?;
        self.6
            .lock()
            .ok()?
            .synthetic
            .remove(key)
            .map(|(_, events)| events)
    }

    fn policed(&self) -> bool {
        self.1.lock().ok().is_some_and(|installed| {
            installed.as_ref().is_some_and(|(_, required)| {
                required
                    .lock()
                    .map_or(true, |required| required.contains(&"model_send"))
            })
        })
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

#[derive(Default)]
struct Stream {
    dropped: std::collections::BTreeSet<u64>,
    renamed: BTreeMap<u64, Value>,
    texts: BTreeMap<u64, (String, bool)>,
    calls: BTreeMap<u64, (Value, Value, &'static str)>,
    injected: u64,
}

struct Attempt {
    account: Account,
    thread: String,
    request_id: String,
    attempt: u32,
    admission: Option<Admission>,
    model: String,
    mods: Option<Arc<Mutex<codex_omd::ModHost>>>,
    holders: Arc<AtomicUsize>,
    dispatcher: Option<ModDispatcher>,
    notifier: Option<ModNotifier>,
    state: Arc<Mutex<RequestState>>,
    required: bool,
    synthetic: Option<String>,
    settled: bool,
    failed: bool,
    reported: bool,
    started: Instant,
    started_at_ms: u128,
    first_event: Option<Duration>,
    served_model: Option<String>,
    usage: Option<Value>,
    microusd: Option<u64>,
    text: Vec<(u64, String)>,
    tool_calls: Vec<Value>,
    stream: Stream,
    injected: Vec<Value>,
}

impl Accounts {
    #[allow(clippy::too_many_arguments)]
    fn attempt(
        &self,
        account: Account,
        thread: String,
        request_id: String,
        attempt: u32,
        model: String,
        admission: Option<Admission>,
        synthetic: Option<String>,
    ) -> Attempt {
        Attempt {
            account,
            thread,
            request_id,
            attempt,
            admission,
            model,
            mods: self.mods(),
            holders: self.3.clone(),
            dispatcher: self.dispatcher(),
            notifier: self.notifier(),
            state: self.6.clone(),
            required: self.required("response_stream"),
            synthetic,
            settled: false,
            failed: false,
            reported: false,
            started: Instant::now(),
            started_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_millis()),
            first_event: None,
            served_model: None,
            usage: None,
            microusd: None,
            text: Vec::new(),
            tool_calls: Vec::new(),
            stream: Stream::default(),
            injected: Vec::new(),
        }
    }
}

fn joined(item: &Value) -> String {
    item["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect()
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
            self.fail("provider returned failed or incomplete response");
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
                    self.fail("provider usage exceeded admitted token ceilings");
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
                self.microusd = Some(amount);
                self.persist_cost_capture()?;
            }
        }
        if !self.settled {
            self.fail("terminal response has unpriced or missing usage");
        }
        Ok(())
    }

    fn fail(&mut self, reason: &str) {
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

    fn chunk(&mut self, event: &Value) -> Option<Value> {
        let index = event["output_index"].as_u64();
        let item = &event["item"];
        let mut chunk = match event["type"].as_str()? {
            "response.output_text.delta" => {
                json!({"kind":"text","index":index?,"item_id":event["item_id"],"text":event["delta"].as_str()?})
            }
            "response.output_item.added"
                if matches!(
                    item["type"].as_str(),
                    Some("function_call" | "custom_tool_call")
                ) =>
            {
                let format = if item["type"] == "custom_tool_call" {
                    "freeform"
                } else {
                    "json"
                };
                self.stream.calls.insert(
                    index?,
                    (item["call_id"].clone(), item["name"].clone(), format),
                );
                json!({"kind":"tool_call","index":index,"item_id":item["id"],"call_id":item["call_id"],
                    "tool":item["name"],"format":format})
            }
            "response.function_call_arguments.delta" | "response.custom_tool_call_input.delta" => {
                let (call_id, tool, format) = self.stream.calls.get(&index?)?.clone();
                json!({"kind":"tool_input","index":index,"item_id":event["item_id"],"call_id":call_id,
                    "tool":tool,"format":format,"text":event["delta"].as_str()?})
            }
            "response.output_item.done" => match item["type"].as_str()? {
                "message" => {
                    let text = self
                        .stream
                        .texts
                        .get(&index?)
                        .filter(|(_, changed)| *changed)
                        .map_or_else(|| joined(item), |(text, _)| text.clone());
                    json!({"kind":"message","index":index,"item_id":item["id"],"text":text})
                }
                "function_call" => {
                    json!({"kind":"tool_done","index":index,"item_id":item["id"],"call_id":item["call_id"],
                        "tool":item["name"],"format":"json","arguments":item["arguments"]})
                }
                "custom_tool_call" => {
                    json!({"kind":"tool_done","index":index,"item_id":item["id"],"call_id":item["call_id"],
                        "tool":item["name"],"format":"freeform","arguments":item["input"]})
                }
                "reasoning" => json!({"kind":"reasoning","index":index,"item_id":item["id"]}),
                _ => return None,
            },
            kind @ ("response.completed" | "response.incomplete" | "response.failed") => {
                json!({"kind":"stop","index":null,"status":kind.trim_start_matches("response."),
                    "usage":event.pointer("/response/usage").cloned().unwrap_or(Value::Null)})
            }
            _ => return None,
        };
        chunk["protected"] = matches!(chunk["kind"].as_str(), Some("reasoning" | "stop")).into();
        chunk["request_id"] = self.request_id.clone().into();
        chunk["scope"] = payload_scope(&self.account, &self.thread);
        chunk["synthetic"] = self.synthetic.clone().into();
        Some(chunk)
    }

    fn apply(&mut self, event: &mut Value, chunk: &Value, effective: &Value) {
        let index = chunk["index"].as_u64().unwrap_or_default();
        match chunk["kind"].as_str() {
            Some("text") => {
                let text = effective["text"].as_str().unwrap_or_default();
                event["delta"] = text.into();
                let entry = self.stream.texts.entry(index).or_default();
                entry.0.push_str(text);
                entry.1 |= effective["text"] != chunk["text"];
            }
            Some("tool_input") => event["delta"] = effective["text"].clone(),
            Some("tool_call") if effective["tool"] != chunk["tool"] => {
                event["item"]["name"] = effective["tool"].clone();
                self.stream.renamed.insert(index, effective["tool"].clone());
            }
            Some("message") if effective["text"].as_str() != Some(&joined(&event["item"])) => {
                event["item"]["content"] =
                    json!([{"type":"output_text","text":effective["text"],"annotations":[]}]);
            }
            Some("tool_done") => {
                event["item"]["name"] = effective["tool"].clone();
                let field = if chunk["format"] == "freeform" {
                    "input"
                } else {
                    "arguments"
                };
                event["item"][field] = effective["arguments"].clone();
            }
            _ => {}
        }
    }

    fn inject(&mut self, chunk: &Value, origin: &str) -> Vec<Value> {
        self.stream.injected += 1;
        let id = format!("mod-{origin}-{}-{}", self.request_id, self.stream.injected);
        let item = codex_omd::model_request::output_item(chunk, &id);
        let index = 100_000 + self.stream.injected;
        let mut events = Vec::new();
        if item["type"] == "message" {
            let mut added = item.clone();
            added["status"] = "in_progress".into();
            added["content"] = json!([]);
            events.push(
                json!({"type":"response.output_item.added","output_index":index,"item":added}),
            );
        }
        events.push(json!({"type":"response.output_item.done","output_index":index,"item":item}));
        events
    }

    /// Runs the stream chunk chain; returns a stop control when a handler stopped the response.
    fn transform(&mut self, event: &mut Value) -> Result<Option<Value>, TransportError> {
        let index = event["output_index"].as_u64();
        if self.account.capture_tools
            && let Some(index) = index
            && matches!(
                event["type"].as_str(),
                Some("response.output_item.added" | "response.output_item.done")
            )
            && matches!(
                event["item"]["type"].as_str(),
                Some("function_call" | "custom_tool_call")
            )
        {
            // A fork returns the calls its model asked for; they never run.
            if event["type"] == "response.output_item.done" && self.tool_calls.len() < 32 {
                let item = &event["item"];
                let arguments = item.get("arguments").unwrap_or(&item["input"]);
                self.tool_calls
                    .push(json!({"call_id":item["call_id"],"tool":item["name"],
                    "arguments":arguments,"executed":false}));
            }
            self.stream.dropped.insert(index);
            *event = Value::Null;
            return Ok(None);
        }
        if index.is_some_and(|index| self.stream.dropped.contains(&index)) {
            *event = Value::Null;
            return Ok(None);
        }
        if event["type"] == "response.output_item.done"
            && let Some(tool) = index.and_then(|index| self.stream.renamed.get(&index))
        {
            event["item"]["name"] = tool.clone();
        }
        let Some(mods) = self.mods.clone() else {
            return Ok(None);
        };
        let Some(chunk) = self.chunk(event) else {
            return Ok(None);
        };
        let Some(required) = Accounts::intercepting(
            &mods,
            &self.holders,
            &self.account,
            "response_stream",
            self.required,
        )?
        else {
            // Registrations change only at reload, so the rest of this response needs no checks.
            self.mods = None;
            return Ok(None);
        };
        let dispatcher = self.dispatcher.clone();
        let thread = self.thread.clone();
        let task = self.account.task.clone();
        let active = || task.check_active().is_ok();
        let _thread = codex_omd::StateThread::enter(Some(thread.clone()));
        let origin = json!({"caller":"engine","thread_id":thread,
            "agent_id":if self.account.owner == "lead" { Value::Null } else { Value::String(self.account.owner.clone()) }});
        let chain = codex_omd::intercept_shared(
            &mods,
            "response_stream",
            required,
            chunk.clone(),
            origin,
            active,
            |caller, call| match &dispatcher {
                Some(dispatch) => dispatch(&thread, caller, call, &active),
                None => Err(std::io::Error::other(
                    "host_operation_unavailable: no session dispatcher",
                )),
            },
            |input| Ok(json!({"chunks": [input]})),
        )
        .map_err(denied)?;
        if chain.result == json!({"chunks": [chunk]}) {
            self.apply(event, &chunk, &chunk);
            return Ok(None);
        }
        Accounts::record_middleware(
            &self.account,
            &chain_record("response_stream", &self.request_id, &chain),
        )?;
        let origin = settled_by(&chain);
        if let Some(stop) = chain.result.get("stop") {
            if chain.result.get("retry").is_some()
                && let Ok(mut state) = self.state.lock()
            {
                state.retries.insert(self.thread.clone(), self.attempt + 1);
            }
            return Ok(Some(
                json!({"origin":origin,"reason":stop["reason"],"retry":chain.result.get("retry")}),
            ));
        }
        let chunks = chain.result["chunks"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        match chunks.iter().find(|chunk| chunk.get("index").is_some()) {
            Some(effective) => self.apply(event, &chunk, effective),
            None => {
                if let Some(index) = index {
                    match chunk["kind"].as_str() {
                        Some("tool_call") => {
                            self.stream.dropped.insert(index);
                        }
                        Some("text") => self.stream.texts.entry(index).or_default().1 = true,
                        _ => {}
                    }
                }
                *event = Value::Null;
            }
        }
        let injected = chunks
            .iter()
            .filter(|chunk| chunk.get("index").is_none())
            .flat_map(|chunk| self.inject(chunk, &origin))
            .collect::<Vec<_>>();
        if chunk["kind"] == "stop" && !injected.is_empty() {
            let terminal = std::mem::take(event);
            self.injected.extend(injected);
            self.injected.push(terminal);
        } else {
            self.injected.extend(injected);
        }
        Ok(None)
    }

    /// Keeps the visible text per output item as streamed, replaced by the recorded text once the item completes.
    fn summarize(&mut self, event: &Value) {
        let index = event["output_index"].as_u64().unwrap_or_default();
        let item = &event["item"];
        let mut entry = |text: &mut dyn FnMut(&mut String)| {
            if !self.text.iter().any(|(item, _)| *item == index) && self.text.len() < 32 {
                self.text.push((index, String::new()));
            }
            if let Some((_, kept)) = self.text.iter_mut().find(|(item, _)| *item == index) {
                text(kept);
            }
        };
        match (event["type"].as_str(), item["type"].as_str()) {
            (Some("response.output_text.delta"), _) => {
                let delta = event["delta"].as_str().unwrap_or_default();
                entry(&mut |kept| {
                    if kept.len() < COLLECTED_TEXT_BYTES {
                        kept.push_str(delta);
                    }
                });
            }
            (Some("response.output_item.done"), Some("message")) => {
                let recorded = joined(item);
                entry(&mut |kept| *kept = recorded.clone());
            }
            (Some("response.output_item.done"), Some("function_call" | "custom_tool_call"))
                if self.tool_calls.len() < 32 =>
            {
                self.tool_calls
                    .push(json!({"call_id":item["call_id"],"tool":item["name"]}));
            }
            _ => {}
        }
    }

    fn report(&mut self, status: &str, stop_reason: Option<String>, error: Option<&str>) {
        if self.reported {
            return;
        }
        self.reported = true;
        let usage = self.usage.clone().unwrap_or(Value::Null);
        let text = self
            .text
            .iter()
            .map(|(_, text)| text.as_str())
            .collect::<String>();
        let cost = match (&self.synthetic, &self.account.rates, self.microusd) {
            (Some(_), _, _) => json!({"microusd": 0, "basis": "synthetic"}),
            (None, Some(rates), _) if rates.included_subscription => {
                json!({"microusd": 0, "basis": "included_subscription"})
            }
            (None, Some(_), Some(amount)) => json!({"microusd": amount, "basis": "settled"}),
            (None, Some(_), None) => json!({"microusd": null, "basis": "unsettled"}),
            (None, None, _) => json!({"microusd": null, "basis": "unpriced"}),
        };
        let payload = json!({"request_id": self.request_id, "attempt": self.attempt,
            "ledger_request": self.admission.as_ref().map(Admission::request_id),
            "scope": payload_scope(&self.account, &self.thread),
            "route": self.account.route.clone().unwrap_or_else(|| "session".into()),
            "provider": self.account.provider, "credential": self.account.credential,
            "requested_model": self.model, "served_model": self.served_model,
            "status": status, "stop_reason": stop_reason,
            "output": {"text": cut(&text, SUMMARY_TEXT_BYTES), "tool_calls": self.tool_calls},
            "usage": usage,
            "cache": {"read_tokens": usage.pointer("/input_tokens_details/cached_tokens"),
                "write_tokens": usage.pointer("/input_tokens_details/cache_write_tokens")},
            "cost": cost, "context_window": self.account.context_window,
            "timing": {"started_at_ms": self.started_at_ms,
                "first_event_ms": self.first_event.map(|elapsed| elapsed.as_millis() as u64),
                "duration_ms": self.started.elapsed().as_millis() as u64},
            "synthetic": self.synthetic, "error": error});
        if let Ok(mut state) = self.state.lock()
            && let Some(collected) = state.responses.get_mut(&self.thread)
            && collected.len() < 16
        {
            let mut kept = payload.clone();
            kept["output"]["text"] = cut(&text, COLLECTED_TEXT_BYTES).into();
            collected.push(kept);
        }
        if let Some(notify) = &self.notifier {
            notify("model_response", payload);
        }
    }

    fn event(&mut self, event: &mut Value, valid: bool) -> Result<(), TransportError> {
        self.first_event
            .get_or_insert_with(|| self.started.elapsed());
        let raw = event.clone();
        let kind = raw["type"].as_str().unwrap_or("invalid").to_owned();
        if !valid
            && !matches!(
                kind.as_str(),
                "response.failed" | "response.incomplete" | "error"
            )
        {
            self.fail("malformed provider event");
        }
        if let Some(model) = raw.pointer("/response/model").and_then(Value::as_str) {
            self.served_model = Some(model.to_owned());
        }
        let terminal = matches!(
            kind.as_str(),
            "response.completed" | "response.failed" | "response.incomplete"
        );
        if terminal {
            self.usage = raw
                .pointer("/response/usage")
                .filter(|usage| usage.is_object())
                .cloned();
            if self.synthetic.is_some() {
                self.settled = true;
            } else {
                self.settle(&raw)?;
            }
        }
        if kind == "error" {
            self.fail("provider stream error");
        }
        let control = self.transform(event)?;
        let delivered = std::iter::once(event.clone())
            .chain(self.injected.iter().cloned())
            .collect::<Vec<_>>();
        for item in &delivered {
            self.summarize(item);
        }
        if terminal {
            let status = kind.trim_start_matches("response.").to_owned();
            let stop_reason = match status.as_str() {
                "completed" if self.tool_calls.is_empty() => Some("end_turn".to_owned()),
                "completed" => Some("tool_use".to_owned()),
                "incomplete" => raw
                    .pointer("/response/incomplete_details/reason")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                _ => None,
            };
            let error = raw
                .pointer("/response/error/message")
                .and_then(Value::as_str)
                .map(str::to_owned);
            self.report(&status, stop_reason, error.as_deref());
        }
        if let Some(control) = control {
            return Err(codex_api::request_observer::stream_control_error(&control));
        }
        Ok(())
    }
}

impl ResponseAttempt for Attempt {
    fn observe(&mut self, event: &mut Value, valid: bool) -> Result<(), TransportError> {
        self.event(event, valid)
    }

    fn injected(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.injected)
    }

    fn failed(&mut self, reason: &str) {
        self.fail(reason);
        self.report("failed", None, Some(reason));
    }
}

impl Drop for Attempt {
    fn drop(&mut self) {
        if self.synthetic.is_some()
            && let Ok(mut state) = self.state.lock()
        {
            state.synthetic.remove(&self.request_id);
        }
        if !self.settled {
            let reason = "request cancelled, dropped, or closed without priced final usage";
            self.report("cancelled", None, Some(reason));
            self.fail(reason);
        }
    }
}

#[cfg(test)]
#[path = "accounting_tests.rs"]
mod tests;
