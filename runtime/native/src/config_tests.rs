use super::*;
use serde_json::json;

#[test]
fn route_data_is_bounded() {
    let route = |data: serde_json::Value| {
        json!({"schema": 1, "routes": [{"name": "work", "roles": ["lead"], "provider": "fixture", "model": "work",
            "reasoning_effort": "medium", "responses_url": "http://127.0.0.1:9/v1/responses", "data": data,
            "rates": {"input_microusd_per_million": 0, "cached_microusd_per_million": 0, "output_microusd_per_million": 0,
                "reservation_microusd": 0, "max_output_tokens": 10, "input_token_ceiling": 100, "included_subscription": true}}]})
    };
    let repository = Path::new("/repo");
    assert_eq!(
        HostConfig::check(repository, &route(json!({"upstream": "gpt-6.1"}))),
        Ok(())
    );
    assert_eq!(
        HostConfig::check(repository, &route(json!("x".repeat(2048)))),
        Err("host.json route work is invalid".into())
    );
}
