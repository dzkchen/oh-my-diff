use codex_api::request_observer::ResponseAttempt;
use codex_api::request_observer::ResponseObserver;
use codex_client::EncodedJsonBody;
use codex_client::Request;
use codex_client::TransportError;
use codex_omd::Admission;
use codex_omd::Task;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;

pub const REVOCATION_FILE: &str = "contributor-revoked.json";

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rates {
    pub input_microusd_per_million: u64,
    pub cached_microusd_per_million: u64,
    pub output_microusd_per_million: u64,
    pub reservation_microusd: u64,
    pub max_output_tokens: u64,
    pub input_token_ceiling: u64,
    pub included_subscription: bool,
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
}

#[derive(Default)]
pub struct Accounts(pub Mutex<BTreeMap<String, Account>>);

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
        request: &Request,
        body: &mut Option<EncodedJsonBody>,
    ) -> Result<(), TransportError> {
        let thread = request
            .headers
            .get("thread-id")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| denied("missing native thread identity"))?;
        let accounts = self.0.lock().map_err(|_| denied("account lock poisoned"))?;
        let account = accounts
            .get(thread)
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
        if request.url != account.url {
            return Err(denied("provider route differs from authorized route"));
        }
        let bytes = body
            .ok_or_else(|| denied("missing JSON request"))?
            .as_bytes();
        if bytes.len() > account.max_request_bytes {
            return Err(denied("request exceeds context byte ceiling"));
        }
        let value: Value = serde_json::from_slice(bytes).map_err(denied)?;
        if value.get("model").and_then(Value::as_str) != Some(&account.model)
            || value.get("stream") != Some(&Value::Bool(true))
        {
            return Err(denied("unapproved model or nonstreaming request"));
        }
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
        let mut nodes = vec![&value];
        let mut reasoning = 0u64;
        while let Some(node) = nodes.pop() {
            match node {
                Value::Object(object) => {
                    if ["image_url", "file_id", "file_data", "audio"]
                        .iter()
                        .any(|k| object.contains_key(*k))
                        || matches!(
                            object.get("type").and_then(Value::as_str),
                            Some(
                                "web_search"
                                    | "web_search_preview"
                                    | "file_search"
                                    | "computer"
                                    | "computer_use_preview"
                                    | "code_interpreter"
                                    | "image_generation"
                                    | "mcp"
                                    | "input_image"
                                    | "input_file"
                                    | "input_audio"
                            )
                        )
                    {
                        return Err(denied("unbounded nontext input or charged tool"));
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
            .admit(
                &account.owner,
                &account.provider,
                &account.model,
                account.rates.reservation_microusd,
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
            settled: false,
            failed: false,
        })))
    }
}

struct Attempt {
    account: Account,
    admission: Admission,
    settled: bool,
    failed: bool,
}

impl Attempt {
    fn event(&mut self, event: &Value, valid: bool) -> Result<(), TransportError> {
        if !valid
            && !matches!(
                event["type"].as_str(),
                Some("response.failed" | "response.incomplete" | "error")
            )
        {
            self.failed("malformed provider event");
        }
        match event.get("type").and_then(Value::as_str) {
            Some("response.completed" | "response.failed" | "response.incomplete") => {
                let success = event["type"] == "response.completed";
                if !success {
                    self.failed("provider returned failed or incomplete response");
                }
                if let Some(usage) = event
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
                        if cached > input {
                            return Err(denied("cached input exceeds total input"));
                        }
                        let amount = if rates.included_subscription {
                            0
                        } else {
                            let numerator = [
                                (input - cached, rates.input_microusd_per_million),
                                (cached, rates.cached_microusd_per_million),
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
                    }
                }
                if !self.settled {
                    self.failed("terminal response has unpriced or missing usage");
                }
            }
            Some("error") => self.failed("provider stream error"),
            _ => {}
        }
        Ok(())
    }
}

impl ResponseAttempt for Attempt {
    fn observe(&mut self, event: &Value, valid: bool) -> Result<(), TransportError> {
        self.event(event, valid)
    }

    fn failed(&mut self, reason: &str) {
        if !self.failed && !self.settled {
            let _ = self.account.task.fail(&self.admission, reason);
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
