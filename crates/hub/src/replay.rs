//! The catch-up buffer.
//!
//! The invariant everything else rests on: **the hub subscribes before any
//! client does.** A session is subscribed the first time anyone opens it, and
//! from then on nothing in it goes unobserved — so a client's catch-up
//! happens entirely inside this buffer and never depends on the engine
//! replaying anything (it does not) or on the transcript being current
//! (mid-turn, it is not).
//!
//! Three facts about AttaCore make this layer necessary rather than tidy:
//! `session.history` reads the on-disk log and the log is written once per
//! turn, so a running turn is invisible in history; reconnecting re-sends
//! nothing; and a dropped connection loses only its subscription while the
//! turn keeps running. Together: refresh mid-turn and you would see the
//! second half of an answer. Refreshing is the most basic thing a page does.

use std::collections::VecDeque;

use serde_json::Value;

/// Frames of one turn kept for catch-up, and the byte ceiling over them. A
/// long turn streams thousands of `text_delta` frames; they are coalesced on
/// the way in, so these bounds are generous in practice.
pub const MAX_FRAMES: usize = 20_000;
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
/// Consecutive `text_delta` frames merge up to this size.
const COALESCE_BYTES: usize = 4096;

pub struct ReplayFrame {
    pub seq: u64,
    pub turn_id: String,
    pub event: Value,
}

#[derive(Default)]
pub struct Buffer {
    frames: VecDeque<ReplayFrame>,
    bytes: usize,
    /// Set when the oldest frames were dropped. The interface says so rather
    /// than showing a turn with a hole in it; history fills it after settling.
    pub truncated: bool,
}

impl Buffer {
    pub fn push(&mut self, seq: u64, turn_id: &str, event: &Value) {
        if self.merge_delta(seq, turn_id, event) {
            return;
        }
        let bytes = event.to_string().len();
        self.frames.push_back(ReplayFrame {
            seq,
            turn_id: turn_id.to_string(),
            event: event.clone(),
        });
        self.bytes += bytes;
        while self.frames.len() > MAX_FRAMES || self.bytes > MAX_BYTES {
            let Some(dropped) = self.frames.pop_front() else { break };
            self.bytes = self.bytes.saturating_sub(dropped.event.to_string().len());
            self.truncated = true;
        }
    }

    fn merge_delta(&mut self, seq: u64, turn_id: &str, event: &Value) -> bool {
        if event.get("kind").and_then(Value::as_str) != Some("text_delta") {
            return false;
        }
        let Some(last) = self.frames.back_mut() else { return false };
        let mergeable = last.turn_id == turn_id
            && last.event.get("kind").and_then(Value::as_str) == Some("text_delta")
            && last
                .event
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|t| t.len() < COALESCE_BYTES);
        if !mergeable {
            return false;
        }
        let add = event.get("text").and_then(Value::as_str).unwrap_or("");
        if let Some(Value::String(text)) = last.event.get_mut("text") {
            text.push_str(add);
        }
        last.seq = seq;
        self.bytes += add.len();
        true
    }

    pub fn clear(&mut self) {
        self.frames.clear();
        self.bytes = 0;
        self.truncated = false;
    }

    pub fn snapshot(&self) -> Vec<Value> {
        self.frames
            .iter()
            .map(|f| serde_json::json!({"seq": f.seq, "turn_id": f.turn_id, "event": f.event}))
            .collect()
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn delta(text: &str) -> Value {
        json!({"kind": "text_delta", "text": text})
    }

    #[test]
    fn consecutive_deltas_coalesce() {
        let mut b = Buffer::default();
        b.push(1, "t", &delta("hel"));
        b.push(2, "t", &delta("lo"));
        let snap = b.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0]["event"]["text"], "hello");
        // The merged frame carries the newest seq, so a client that has seen
        // it does not ask for the first half again.
        assert_eq!(snap[0]["seq"], 2);
    }

    #[test]
    fn deltas_from_different_turns_do_not_merge() {
        let mut b = Buffer::default();
        b.push(1, "t1", &delta("a"));
        b.push(2, "t2", &delta("b"));
        assert_eq!(b.snapshot().len(), 2);
    }

    #[test]
    fn dropping_the_oldest_is_reported() {
        let mut b = Buffer::default();
        for i in 0..(MAX_FRAMES + 2) {
            b.push(i as u64, "t", &json!({"kind": "tool_use", "id": i}));
        }
        assert!(b.truncated);
        assert!(b.snapshot().len() <= MAX_FRAMES);
    }
}
