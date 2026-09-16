use omd_bridge_client::Application;
use omd_bridge_client::BridgeClient;
use serde_json::json;
use std::time::Duration;

fn main() -> Result<(), String> {
    let arguments = std::env::args().collect::<Vec<_>>();
    let mut client = BridgeClient::from_connection_file(
        arguments.get(1).ok_or("connection path required")?,
        Application {
            id: "rust".into(),
            adapter: "rust".into(),
            version_sha256: "1".repeat(64),
            reproduction_id: "repro-1".into(),
        },
    )?;
    client.expose("health", || {
        Ok(json!({"ready": true, "secret": "rust-secret"}))
    })?;
    client.connect()?;
    client.event(
        "error",
        Some("error"),
        "rust-fixture",
        json!({"token": "rust-token"}),
    )?;
    client.start_polling(Duration::from_millis(20))?;
    std::thread::sleep(Duration::from_secs(5));
    client.close()
}
