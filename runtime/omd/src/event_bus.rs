use crate::app_routes::subscribed;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

pub const CHANNEL_QUEUE_EVENTS: usize = 256;
pub const CHANNEL_QUEUE_BYTES: usize = 1 << 20;
pub const CHANNEL_EVENT_BYTES: usize = 64 * 1024;
pub const CHANNELS_PER_PUBLISHER: usize = 256;
pub const CHANNEL_SEQUENCES: usize = 4096;
pub const CHANNEL_PUBLISHER_IDLE: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Debug, PartialEq)]
pub struct ChannelEvent {
    pub publisher: String,
    pub thread: String,
    pub channel: String,
    pub data: Value,
    pub correlation: Option<String>,
    pub sequence: u64,
    pub dropped: u64,
}

#[derive(Debug, Default, PartialEq)]
pub struct Delivery {
    pub delivered: usize,
    pub dropped: usize,
}

struct Subscriber {
    patterns: Vec<String>,
    queue: VecDeque<(ChannelEvent, usize)>,
    bytes: usize,
    dropped: u64,
}

struct PublisherSequences {
    used: Instant,
    channels: BTreeMap<String, u64>,
}

pub struct EventBus {
    subscribers: BTreeMap<String, Subscriber>,
    sequences: BTreeMap<String, PublisherSequences>,
    max_events: usize,
    max_bytes: usize,
}

static GLOBAL: LazyLock<Mutex<EventBus>> = LazyLock::new(|| Mutex::new(EventBus::default()));

pub fn global() -> &'static Mutex<EventBus> {
    &GLOBAL
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(CHANNEL_QUEUE_EVENTS, CHANNEL_QUEUE_BYTES)
    }
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-' | b'.')
        })
}

impl EventBus {
    pub fn new(max_events: usize, max_bytes: usize) -> Self {
        Self {
            subscribers: BTreeMap::new(),
            sequences: BTreeMap::new(),
            max_events,
            max_bytes,
        }
    }

    pub fn subscribe(&mut self, subscriber: &str, patterns: Vec<String>) {
        if patterns.is_empty() {
            self.subscribers.remove(subscriber);
            return;
        }
        let entry = self
            .subscribers
            .entry(subscriber.to_owned())
            .or_insert_with(|| Subscriber {
                patterns: Vec::new(),
                queue: VecDeque::new(),
                bytes: 0,
                dropped: 0,
            });
        entry.patterns = patterns;
    }

    pub fn unsubscribe(&mut self, subscriber: &str) {
        self.subscribers.remove(subscriber);
    }

    pub fn publish(
        &mut self,
        publisher: &str,
        name: &str,
        data: Value,
        correlation: Option<String>,
        thread: &str,
    ) -> io::Result<Delivery> {
        self.publish_at(publisher, name, data, correlation, thread, Instant::now())
    }

    fn publish_at(
        &mut self,
        publisher: &str,
        name: &str,
        data: Value,
        correlation: Option<String>,
        thread: &str,
        now: Instant,
    ) -> io::Result<Delivery> {
        if !valid_name(name) {
            return Err(io::Error::other(format!("channel_name_invalid: {name}")));
        }
        let size = data.to_string().len();
        if size > CHANNEL_EVENT_BYTES {
            return Err(io::Error::other(format!("channel_event_too_large: {size}")));
        }
        if correlation.as_ref().is_some_and(|c| c.len() > 256) {
            return Err(io::Error::other("channel_correlation_too_large"));
        }
        let queued = self.subscribers.values()
            .flat_map(|subscriber| subscriber.queue.iter().map(|(event, _)| event.publisher.as_str()))
            .collect::<BTreeSet<_>>();
        self.sequences.retain(|publisher, sequences| {
            now.duration_since(sequences.used) < CHANNEL_PUBLISHER_IDLE
                || queued.contains(publisher.as_str())
        });
        let current = self.sequences.get(publisher);
        if !current.is_some_and(|sequences| sequences.channels.contains_key(name))
            && (current.is_some_and(|sequences| sequences.channels.len() >= CHANNELS_PER_PUBLISHER)
                || self.sequences.values().map(|sequences| sequences.channels.len()).sum::<usize>() >= CHANNEL_SEQUENCES)
        {
            return Err(io::Error::other("channel_sequence_limit"));
        }
        let channel = format!("{publisher}/{name}");
        let publisher_sequences = self.sequences.entry(publisher.to_owned()).or_insert_with(|| PublisherSequences {
            used: now,
            channels: BTreeMap::new(),
        });
        publisher_sequences.used = now;
        let sequence = publisher_sequences.channels.entry(name.to_owned()).or_default();
        *sequence += 1;
        let event = ChannelEvent {
            publisher: publisher.to_owned(),
            thread: thread.to_owned(),
            channel: channel.clone(),
            data,
            correlation,
            sequence: *sequence,
            dropped: 0,
        };
        let mut delivery = Delivery::default();
        for subscriber in self
            .subscribers
            .values_mut()
            .filter(|s| subscribed(&s.patterns, &channel))
        {
            subscriber.bytes += size;
            subscriber.queue.push_back((event.clone(), size));
            delivery.delivered += 1;
            while subscriber.queue.len() > self.max_events
                || (subscriber.bytes > self.max_bytes && subscriber.queue.len() > 1)
            {
                if let Some((_, old)) = subscriber.queue.pop_front() {
                    subscriber.bytes -= old;
                    subscriber.dropped += 1;
                    delivery.dropped += 1;
                }
            }
        }
        Ok(delivery)
    }

    pub fn drain(&mut self, subscriber: &str, limit: usize) -> Vec<ChannelEvent> {
        let Some(entry) = self.subscribers.get_mut(subscriber) else {
            return Vec::new();
        };
        let count = limit.min(entry.queue.len());
        let mut drained: Vec<_> = entry
            .queue
            .drain(..count)
            .map(|(event, bytes)| {
                entry.bytes -= bytes;
                event
            })
            .collect();
        if let Some(first) = drained.first_mut() {
            first.dropped = std::mem::take(&mut entry.dropped);
        }
        drained
    }

    pub fn pending(&self, subscriber: &str) -> usize {
        self.subscribers
            .get(subscriber)
            .map_or(0, |s| s.queue.len())
    }
}

#[cfg(test)]
#[path = "event_bus_tests.rs"]
mod tests;
