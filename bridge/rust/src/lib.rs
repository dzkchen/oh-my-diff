use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::io::Read;
use std::io::Write;
use std::net::TcpStream;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread::JoinHandle;
use std::time::Duration;

#[derive(Clone, Deserialize)]
pub struct Connection {
    pub url: String,
    pub token: String,
}

#[derive(Clone, Serialize)]
pub struct Application {
    pub id: String,
    pub adapter: String,
    pub version_sha256: String,
    pub reproduction_id: String,
}

type Handler = Arc<dyn Fn() -> Result<Value, String> + Send + Sync>;

pub struct BridgeClient {
    connection: Connection,
    application: Application,
    instance_id: Option<String>,
    handlers: BTreeMap<String, Handler>,
    stopping: Arc<AtomicBool>,
    polling: Option<JoinHandle<()>>,
}

impl BridgeClient {
    pub fn from_connection_file(
        path: impl AsRef<Path>,
        application: Application,
    ) -> Result<Self, String> {
        let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
        let connection = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        Ok(Self {
            connection,
            application,
            instance_id: None,
            handlers: BTreeMap::new(),
            stopping: Arc::new(AtomicBool::new(false)),
            polling: None,
        })
    }

    pub fn expose(
        &mut self,
        name: impl Into<String>,
        handler: impl Fn() -> Result<Value, String> + Send + Sync + 'static,
    ) -> Result<(), String> {
        if self.instance_id.is_some() {
            return Err("state handlers must be exposed before connect".into());
        }
        self.handlers.insert(name.into(), Arc::new(handler));
        Ok(())
    }

    fn body(&self) -> Value {
        json!({
            "token": self.connection.token,
            "app_id": self.application.id,
            "adapter": self.application.adapter,
            "version_sha256": self.application.version_sha256,
            "reproduction_id": self.application.reproduction_id,
            "instance_id": self.instance_id,
        })
    }

    pub fn connect(&mut self) -> Result<String, String> {
        if let Some(instance) = &self.instance_id {
            return Ok(instance.clone());
        }
        let mut body = self.body();
        body["exposed_state"] = json!(self.handlers.keys().collect::<Vec<_>>());
        let response = post(&self.connection.url, "/v1/register", &body)?;
        let instance = response
            .get("instance_id")
            .and_then(Value::as_str)
            .ok_or("bridge registration omitted instance_id")?
            .to_owned();
        self.instance_id = Some(instance.clone());
        Ok(instance)
    }

    pub fn event(
        &self,
        kind: &str,
        level: Option<&str>,
        message: &str,
        data: Value,
    ) -> Result<Value, String> {
        if self.instance_id.is_none() {
            return Err("bridge client is not connected".into());
        }
        let mut body = self.body();
        body["kind"] = json!(kind);
        body["level"] = json!(level);
        body["message"] = json!(message);
        body["data"] = data;
        post(&self.connection.url, "/v1/event", &body)
    }

    pub fn poll(&self) -> Result<(), String> {
        let response = post(&self.connection.url, "/v1/poll", &self.body())?;
        for command in response
            .get("commands")
            .and_then(Value::as_array)
            .ok_or("bridge poll omitted commands")?
        {
            let request_id = command
                .get("request_id")
                .and_then(Value::as_str)
                .ok_or("state command omitted request_id")?;
            let name = command
                .get("name")
                .and_then(Value::as_str)
                .ok_or("state command omitted name")?;
            let mut body = self.body();
            body["request_id"] = json!(request_id);
            match self.handlers.get(name).map(|handler| handler()) {
                Some(Ok(value)) => body["value"] = value,
                Some(Err(error)) => body["error"] = json!(error),
                None => body["error"] = json!("state handler unavailable"),
            }
            post(&self.connection.url, "/v1/state", &body)?;
        }
        Ok(())
    }

    pub fn start_polling(&mut self, interval: Duration) -> Result<(), String> {
        if self.polling.is_some() {
            return Ok(());
        }
        let connection = self.connection.clone();
        let application = self.application.clone();
        let instance_id = self
            .instance_id
            .clone()
            .ok_or("bridge client is not connected")?;
        let handlers = self.handlers.clone();
        let stopping = self.stopping.clone();
        self.polling = Some(std::thread::spawn(move || {
            let client = Self {
                connection,
                application,
                instance_id: Some(instance_id),
                handlers,
                stopping: stopping.clone(),
                polling: None,
            };
            while !stopping.load(Ordering::Acquire) {
                let _ = client.poll();
                std::thread::sleep(interval);
            }
        }));
        Ok(())
    }

    pub fn close(&mut self) -> Result<(), String> {
        self.stopping.store(true, Ordering::Release);
        if let Some(handle) = self.polling.take() {
            let _ = handle.join();
        }
        if self.instance_id.is_some() {
            post(&self.connection.url, "/v1/disconnect", &self.body())?;
            self.instance_id = None;
        }
        Ok(())
    }
}

fn post(base: &str, route: &str, value: &Value) -> Result<Value, String> {
    let authority = base
        .strip_prefix("http://")
        .ok_or("bridge URL must use loopback HTTP")?;
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or("bridge URL is missing its port")?;
    if host != "127.0.0.1" {
        return Err("bridge URL must bind IPv4 loopback".into());
    }
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let mut stream = TcpStream::connect((
        host,
        port.parse::<u16>().map_err(|error| error.to_string())?,
    ))
    .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;
    write!(stream, "POST {route} HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).and_then(|_| stream.write_all(&body)).map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| error.to_string())?;
    let marker = b"\r\n\r\n";
    let split = response
        .windows(marker.len())
        .position(|window| window == marker)
        .ok_or("bridge HTTP response is malformed")?;
    let headers = std::str::from_utf8(&response[..split]).map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_slice(&response[split + marker.len()..])
        .map_err(|error| error.to_string())?;
    if !headers.starts_with("HTTP/1.1 200 ") {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("bridge request failed")
            .into());
    }
    Ok(value)
}
