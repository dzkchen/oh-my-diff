use super::*;
use serde_json::json;

#[test]
fn publishers_are_namespaced_and_subscribers_filter_by_pattern() {
    let mut bus = EventBus::default();
    bus.subscribe("graph", vec!["runner/*".to_owned()]);
    bus.subscribe("notify", vec!["runner/finished".to_owned()]);
    bus.subscribe("idle", vec!["other/*".to_owned()]);
    assert_eq!(
        bus.publish("runner", "started", json!({"n": 1}), None)
            .unwrap(),
        Delivery {
            delivered: 1,
            dropped: 0
        }
    );
    assert_eq!(
        bus.publish(
            "runner",
            "finished",
            json!({"n": 2}),
            Some("job-7".to_owned())
        )
        .unwrap()
        .delivered,
        2
    );
    let graph = bus.drain("graph", usize::MAX);
    assert_eq!(
        graph
            .iter()
            .map(|e| (e.channel.as_str(), e.sequence))
            .collect::<Vec<_>>(),
        [("runner/started", 1), ("runner/finished", 1)]
    );
    let notify = bus.drain("notify", usize::MAX);
    assert_eq!(
        (
            notify[0].publisher.as_str(),
            notify[0].correlation.as_deref()
        ),
        ("runner", Some("job-7"))
    );
    assert!(bus.drain("idle", usize::MAX).is_empty());
    assert!(bus.drain("unknown", usize::MAX).is_empty());
}

#[test]
fn names_and_sizes_are_bounded() {
    let mut bus = EventBus::default();
    for name in ["", "Upper", "a/b", &"x".repeat(65)] {
        assert!(bus.publish("m", name, json!(null), None).is_err(), "{name}");
    }
    assert!(
        bus.publish("m", "big", json!("x".repeat(CHANNEL_EVENT_BYTES)), None)
            .is_err()
    );
    assert!(
        bus.publish("m", "ok", json!(null), Some("c".repeat(257)))
            .is_err()
    );
    assert!(bus.publish("m", "ok.v1-x_2", json!(null), None).is_ok());
}

#[test]
fn slow_subscribers_drop_oldest_and_see_the_count() {
    let mut bus = EventBus::new(2, 1 << 20);
    bus.subscribe("slow", vec!["p/*".to_owned()]);
    let mut dropped = 0;
    for n in 0..5 {
        dropped += bus.publish("p", "tick", json!(n), None).unwrap().dropped;
    }
    assert_eq!((dropped, bus.pending("slow")), (3, 2));
    let events = bus.drain("slow", usize::MAX);
    assert_eq!(
        (
            events[0].data.clone(),
            events[0].dropped,
            events[1].sequence
        ),
        (json!(3), 3, 5)
    );
    bus.publish("p", "tick", json!(5), None).unwrap();
    bus.publish("p", "tick", json!(6), None).unwrap();
    assert_eq!(bus.drain("slow", 1)[0].data, json!(5));
    assert_eq!(bus.pending("slow"), 1);
    assert_eq!(bus.drain("slow", usize::MAX)[0].dropped, 0);
}

#[test]
fn resubscribing_replaces_patterns_and_empty_unsubscribes() {
    let mut bus = EventBus::default();
    bus.subscribe("m", vec!["a/*".to_owned()]);
    bus.subscribe("m", vec!["b/*".to_owned()]);
    assert_eq!(bus.publish("a", "x", json!(1), None).unwrap().delivered, 0);
    assert_eq!(bus.publish("b", "x", json!(1), None).unwrap().delivered, 1);
    bus.subscribe("m", Vec::new());
    assert_eq!(
        (
            bus.pending("m"),
            bus.publish("b", "x", json!(1), None).unwrap().delivered
        ),
        (0, 0)
    );
}
