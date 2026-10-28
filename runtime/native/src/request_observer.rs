use codex_client::EncodedJsonBody;
use codex_client::Request;
use codex_client::StreamResponse;
use codex_client::TransportError;
use serde_json::Value;
use std::sync::Arc;
use std::sync::OnceLock;

pub trait ResponseAttempt: Send + Sync {
    /// Observes one raw event; replacing it with `Value::Null` drops it.
    fn observe(&mut self, event: &mut Value, valid: bool) -> Result<(), TransportError>;
    fn injected(&mut self) -> Vec<Value> {
        Vec::new()
    }
    fn failed(&mut self, reason: &str);
}

pub trait ResponseObserver: Send + Sync {
    fn prepare(
        &self,
        request: &mut Request,
        body: &mut Option<EncodedJsonBody>,
    ) -> Result<(), TransportError>;
    fn before_send(
        &self,
        request: &mut Request,
        body: Option<&EncodedJsonBody>,
    ) -> Result<Option<Box<dyn ResponseAttempt>>, TransportError>;
    /// Runs the final-request stage over a unary JSON request body.
    fn police_unary(&self, thread: Option<&str>, body: &mut Value) -> Result<(), TransportError> {
        let _ = (thread, body);
        Ok(())
    }
    fn requires_observation(&self, thread: Option<&str>) -> bool {
        let _ = thread;
        true
    }
    /// The mods whose required final-request policy must see every provider request.
    fn policed(&self) -> Option<String> {
        None
    }
    fn answer(&self, request: &Request) -> Option<Vec<Value>> {
        let _ = request;
        None
    }
}

/// Marks a request whose items carry metadata the provider does not accept; it is removed after `prepare`.
pub const STRIP_ITEM_METADATA: &str = "x-codex-strip-item-metadata";

pub fn installed() -> bool {
    OBSERVER.get().is_some()
}

pub const STREAM_CONTROL: &str = "stream_control:";

pub fn stream_control_error(control: &serde_json::Value) -> TransportError {
    TransportError::Build(format!("{STREAM_CONTROL}{control}"))
}

pub fn stream_control(message: &str) -> Option<serde_json::Value> {
    let start = message.find(STREAM_CONTROL)? + STREAM_CONTROL.len();
    serde_json::Deserializer::from_str(&message[start..])
        .into_iter::<serde_json::Value>()
        .next()?
        .ok()
        .filter(serde_json::Value::is_object)
}

static OBSERVER: OnceLock<Arc<dyn ResponseObserver>> = OnceLock::new();

pub fn install_response_observer(observer: Arc<dyn ResponseObserver>) -> Result<(), &'static str> {
    OBSERVER
        .set(observer)
        .map_err(|_| "response observer already installed")
}

pub(crate) struct ObservedStream {
    pub response: StreamResponse,
    pub attempt: Option<Box<dyn ResponseAttempt>>,
}

impl crate::telemetry::WithStatus for ObservedStream {
    fn status(&self) -> http::StatusCode {
        self.response.status
    }
}

pub(crate) fn admit(
    request: &mut Request,
    body: Option<&EncodedJsonBody>,
) -> Result<Option<Box<dyn ResponseAttempt>>, TransportError> {
    match OBSERVER.get() {
        Some(observer) => observer.before_send(request, body),
        None => Ok(None),
    }
}

pub(crate) fn reject_policed_transport(transport: &str) -> Result<(), crate::error::ApiError> {
    if let Some(owners) = OBSERVER.get().and_then(|observer| observer.policed()) {
        return Err(crate::error::ApiError::InvalidRequest {
            message: format!("local OMD request policy: final_request_refused: request_policy_unsupported_transport: {transport} requests cannot pass the final-request policy of {owners}; turn {owners} off to use this feature"),
        });
    }
    Ok(())
}

/// Web search sends recent conversation text and queries without passing final-request policies.
pub const UNPOLICED_SEARCH_PATH: &str = "alpha/search";
pub const POLICED_UNARY_PATHS: &[&str] = &[
    "images/generations",
    "images/edits",
    "memories/trace_summarize",
];

pub(crate) fn admit_unary(
    path: &str,
    headers: &http::HeaderMap,
    body: Option<&mut Value>,
) -> Result<(), crate::error::ApiError> {
    let thread = headers
        .get("thread-id")
        .and_then(|value| value.to_str().ok());
    match (OBSERVER.get(), body) {
        _ if path == UNPOLICED_SEARCH_PATH => {}
        (Some(observer), Some(body)) if POLICED_UNARY_PATHS.contains(&path) => {
            observer.police_unary(thread, body)?
        }
        _ => reject_policed_transport(path)?,
    }
    if OBSERVER
        .get()
        .is_some_and(|observer| observer.requires_observation(thread))
    {
        return Err(crate::error::ApiError::InvalidRequest {
            message: "local OMD request policy requires observed HTTP Responses transport".into(),
        });
    }
    Ok(())
}

pub(crate) fn reject_websocket_transport() -> Result<(), crate::error::ApiError> {
    if OBSERVER.get().is_some() {
        return Err(crate::error::ApiError::InvalidRequest {
            message: "local OMD request policy requires observed HTTP Responses transport".into(),
        });
    }
    Ok(())
}

pub(crate) fn prepare(
    request: &mut Request,
    body: &mut Option<EncodedJsonBody>,
) -> Result<(), TransportError> {
    if let Some(observer) = OBSERVER.get() {
        observer.prepare(request, body)?;
    }
    if request.headers.remove(STRIP_ITEM_METADATA).is_some()
        && let Some(encoded) = body.as_ref()
    {
        let build = |error: serde_json::Error| TransportError::Build(error.to_string());
        let mut value: Value = serde_json::from_slice(encoded.as_bytes()).map_err(build)?;
        for item in value["input"].as_array_mut().into_iter().flatten() {
            if let Some(item) = item.as_object_mut() {
                item.remove("internal_chat_message_metadata_passthrough");
            }
        }
        *body = Some(EncodedJsonBody::encode(&value).map_err(build)?);
    }
    Ok(())
}

pub(crate) fn answer(request: &Request) -> Option<StreamResponse> {
    let events = OBSERVER.get()?.answer(request)?;
    let chunks = events
        .into_iter()
        .map(|event| Ok(bytes::Bytes::from(format!("data: {event}\n\n"))))
        .collect::<Vec<_>>();
    let mut headers = http::HeaderMap::new();
    headers.insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("text/event-stream"),
    );
    Some(StreamResponse {
        status: http::StatusCode::OK,
        headers,
        bytes: Box::pin(futures::stream::iter(chunks)),
    })
}
