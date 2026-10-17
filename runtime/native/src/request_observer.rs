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
    fn requires_observation(&self, thread: Option<&str>) -> bool {
        let _ = thread;
        true
    }
    /// Whether a required final-request policy must see every provider request.
    fn policed(&self) -> bool {
        false
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

pub(crate) fn reject_policed_transport() -> Result<(), crate::error::ApiError> {
    if OBSERVER.get().is_some_and(|observer| observer.policed()) {
        return Err(crate::error::ApiError::InvalidRequest {
            message: "local OMD request policy: final_request_refused: request_policy_unsupported_transport: a final-request policy is active and this provider transport cannot pass it".into(),
        });
    }
    Ok(())
}

pub(crate) fn reject_unobserved_transport(
    headers: &http::HeaderMap,
) -> Result<(), crate::error::ApiError> {
    reject_policed_transport()?;
    let thread = headers
        .get("thread-id")
        .and_then(|value| value.to_str().ok());
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
