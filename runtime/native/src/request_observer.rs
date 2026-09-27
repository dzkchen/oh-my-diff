use codex_client::EncodedJsonBody;
use codex_client::Request;
use codex_client::StreamResponse;
use codex_client::TransportError;
use serde_json::Value;
use std::sync::Arc;
use std::sync::OnceLock;

pub trait ResponseAttempt: Send + Sync {
    fn observe(&mut self, event: &mut Value, valid: bool) -> Result<(), TransportError>;
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

pub(crate) fn reject_unobserved_transport(
    headers: Option<&http::HeaderMap>,
) -> Result<(), crate::error::ApiError> {
    let thread = headers
        .and_then(|headers| headers.get("thread-id"))
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

pub(crate) fn prepare(
    request: &mut Request,
    body: &mut Option<EncodedJsonBody>,
) -> Result<(), TransportError> {
    if let Some(observer) = OBSERVER.get() {
        observer.prepare(request, body)?;
    }
    Ok(())
}
