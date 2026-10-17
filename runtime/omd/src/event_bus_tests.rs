use super::*;
use serde_json::json;

#[test]
fn channel_sequence_admission_is_bounded_per_publisher_and_globally() {
    let mut bus = EventBus::default();
    for publisher in 0..16 {
        for channel in 0..256 {
            bus.publish(
                &format!("p{publisher}"),
                &format!("c{channel}"),
                json!(null),
                None,
                "t",
            )
            .unwrap();
        }
        assert_eq!(
            bus.publish(&format!("p{publisher}"), "extra", json!(null), None, "t")
                .unwrap_err()
                .to_string(),
            "channel_sequence_limit"
        );
    }
    assert_eq!(
        bus.publish("extra", "c", json!(null), None, "t")
            .unwrap_err()
            .to_string(),
        "channel_sequence_limit"
    );
    bus.subscribe("watcher", vec!["p0/*".into()]);
    bus.publish("p0", "c0", json!(null), None, "t").unwrap();
    bus.publish("p0", "c1", json!(null), None, "t").unwrap();
    assert_eq!(
        bus.drain("watcher", 10)
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        vec![2, 2]
    );
}

#[test]
fn channel_sequences_expire_only_after_publisher_idle_and_queue_drain() {
    let mut bus = EventBus::default();
    let start = Instant::now();
    bus.publish_at("expired", "c", json!(null), None, "t", start)
        .unwrap();
    bus.publish_at(
        "probe",
        "c",
        json!(null),
        None,
        "t",
        start + CHANNEL_PUBLISHER_IDLE - Duration::from_nanos(1),
    )
    .unwrap();
    assert!(bus.sequences.contains_key("expired"));
    bus.publish_at(
        "probe",
        "c",
        json!(null),
        None,
        "t",
        start + CHANNEL_PUBLISHER_IDLE,
    )
    .unwrap();
    assert!(!bus.sequences.contains_key("expired"));
    let mut bus = EventBus::default();
    for channel in 0..CHANNELS_PER_PUBLISHER {
        bus.publish_at(
            "idle",
            &format!("c{channel}"),
            json!(null),
            None,
            "t",
            start,
        )
        .unwrap();
    }
    let before = start + CHANNEL_PUBLISHER_IDLE - Duration::from_nanos(1);
    assert_eq!(
        bus.publish_at("idle", "extra", json!(null), None, "t", before)
            .unwrap_err()
            .to_string(),
        "channel_sequence_limit"
    );
    bus.publish_at(
        "probe",
        "c",
        json!(null),
        None,
        "t",
        start + CHANNEL_PUBLISHER_IDLE,
    )
    .unwrap();
    assert!(
        !bus.sequences.contains_key("idle"),
        "rejected publication must not extend retention"
    );
    bus.subscribe("watcher", vec!["idle/*".into()]);
    bus.publish_at(
        "idle",
        "c0",
        json!(null),
        None,
        "t",
        start + CHANNEL_PUBLISHER_IDLE,
    )
    .unwrap();
    assert_eq!(bus.drain("watcher", 1)[0].sequence, 1);
    bus.publish_at(
        "idle",
        "c0",
        json!(null),
        None,
        "t",
        start + CHANNEL_PUBLISHER_IDLE,
    )
    .unwrap();
    let later = start + CHANNEL_PUBLISHER_IDLE * 2;
    bus.publish_at("probe", "c", json!(null), None, "t", later)
        .unwrap();
    assert!(
        bus.sequences.contains_key("idle"),
        "queued events retain their publisher's counters"
    );
    assert_eq!(bus.drain("watcher", 1)[0].sequence, 2);
    bus.publish_at("idle", "c0", json!(null), None, "t", later)
        .unwrap();
    assert_eq!(bus.drain("watcher", 1)[0].sequence, 1);
    bus.unsubscribe("watcher");
    bus.publish_at(
        "idle",
        "c0",
        json!(null),
        None,
        "t",
        later + Duration::from_secs(1),
    )
    .unwrap();
    bus.publish_at(
        "probe",
        "c",
        json!(null),
        None,
        "t",
        later + CHANNEL_PUBLISHER_IDLE,
    )
    .unwrap();
    assert!(
        bus.sequences.contains_key("idle"),
        "successful publications without subscribers refresh retention"
    );
}

#[test]
fn publishers_are_namespaced_and_subscribers_filter_by_pattern() {
    let mut bus = EventBus::default();
    bus.subscribe("graph", vec!["runner/*".to_owned()]);
    bus.subscribe("notify", vec!["runner/finished".to_owned()]);
    bus.subscribe("idle", vec!["other/*".to_owned()]);
    assert_eq!(
        bus.publish("runner", "started", json!({"n": 1}), None, "thread-a")
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
            Some("job-7".to_owned()),
            "thread-b"
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
    assert_eq!(graph[0].thread, "thread-a");
    assert_eq!(notify[0].thread, "thread-b");
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
fn slow_subscribers_drop_oldest_and_see_the_count() {
    let mut bus = EventBus::new(2, 1 << 20);
    bus.subscribe("slow", vec!["p/*".to_owned()]);
    let mut dropped = 0;
    for n in 0..5 {
        dropped += bus
            .publish("p", "tick", json!(n), None, "thread")
            .unwrap()
            .dropped;
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
    bus.publish("p", "tick", json!(5), None, "thread").unwrap();
    bus.publish("p", "tick", json!(6), None, "thread").unwrap();
    assert_eq!(bus.drain("slow", 1)[0].data, json!(5));
    assert_eq!(bus.pending("slow"), 1);
    assert_eq!(bus.drain("slow", usize::MAX)[0].dropped, 0);
}
