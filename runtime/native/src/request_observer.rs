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

pub(crate) fn reject_unobserved_transport() -> Result<(), crate::error::ApiError> {
    if OBSERVER.get().is_some() {
        return Err(crate::error::ApiError::InvalidRequest {
            message:
                "local controlled-delegation policy requires observed HTTP Responses transport"
                    .into(),
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
