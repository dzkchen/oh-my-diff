use super::*;
use crate::config::HostConfig;

fn config() -> HostConfig {
    let route = |name: &str, provider: &str| {
        json!({"name": name, "roles": ["lead"], "provider": provider, "model": name,
            "reasoning_effort": "medium", "responses_url": "http://127.0.0.1:9/v1/responses",
            "rates": {"input_microusd_per_million": 0, "cached_microusd_per_million": 0, "output_microusd_per_million": 0,
                "reservation_microusd": 0, "max_output_tokens": 10, "input_token_ceiling": 100, "included_subscription": true}})
    };
    serde_json::from_value(json!({"schema": 1,
        "routes": [route("status-work", "fixture"), route("status-other", "elsewhere")],
        "services": [{"id": "fixture", "mod_id": "fixture_mod", "program": "/bin/true",
            "program_sha256": "0".repeat(64), "route": route("status-work", "fixture")}]}))
    .unwrap()
}

#[test]
fn only_the_provider_mod_publishes_bounded_status() {
    let config = config();
    let work = config
        .routes
        .iter()
        .find(|r| r.name == "status-work")
        .unwrap();
    let host = Published::default();
    let published = host.publish(&config, "fixture_mod", json!({"route": "status-work", "installed": true,
        "signed_in": false, "models": ["a"], "usage": [{"label": "5h", "used_percent": 42.5, "resets_at": 1}]}))
    .unwrap();
    let status = latest(&host.snapshot(), work);
    assert_eq!(status["checked_at"], published["checked_at"]);
    assert_eq!(status["signed_in"], false);
    assert_eq!(status["usage"][0]["used_percent"], 42.5);
    assert_eq!(status.get("route"), None);

    assert_eq!(
        host.publish(
            &config,
            "other_mod",
            json!({"route": "status-work", "installed": true, "signed_in": true})
        ),
        Err("route_status_not_provider: status-work".into())
    );
    assert_eq!(
        host.publish(
            &config,
            "fixture_mod",
            json!({"route": "status-other", "installed": true, "signed_in": true})
        ),
        Err("route_status_not_provider: status-other".into())
    );
    assert_eq!(
        host.publish(
            &config,
            "fixture_mod",
            json!({"route": "missing", "installed": true, "signed_in": true})
        ),
        Err("route_not_configured: missing".into())
    );
    for invalid in [
        json!({"route": "status-work", "installed": true}),
        json!({"route": "status-work", "installed": true, "signed_in": true, "usage": [{"label": "5h", "used_percent": 101}]}),
        json!({"route": "status-work", "installed": true, "signed_in": true, "detail": "x".repeat(257)}),
        json!({"route": "status-work", "installed": true, "signed_in": true, "extra": 1}),
    ] {
        assert_eq!(
            host.publish(&config, "fixture_mod", invalid),
            Err("route_status_invalid".into())
        );
    }
}

#[test]
fn each_host_keeps_its_own_status() {
    let config = config();
    let work = config
        .routes
        .iter()
        .find(|r| r.name == "status-work")
        .unwrap();
    let (one, other) = (Published::default(), Published::default());
    one.publish(
        &config,
        "fixture_mod",
        json!({"route": "status-work", "installed": true, "signed_in": true}),
    )
    .unwrap();
    assert_eq!(latest(&one.snapshot(), work)["signed_in"], true);
    assert_eq!(latest(&other.snapshot(), work), Value::Null);
}
