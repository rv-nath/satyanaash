//! Somewhere for a callback to land.
//!
//! Several requests take a `drCallbackUrl` and expect it to be POSTed when a message is
//! delivered. Without somewhere to receive that, those tests assert on the 202 acknowledgement —
//! "I have your message" — and the delivery, which is the thing under test, is never checked.
//!
//! **In memory, on purpose.** A callback matters to a run that is waiting for it, and the one that
//! matters is persisted where it counts: on that step's `NodeResult`, which run history already
//! stores. An inbox surviving a restart would be a second, staler copy of the same fact.
//!
//! **Unauthenticated, by construction.** The sender is somebody else's service and it will not
//! carry our credentials. So the surface is deliberately tiny — record a request against a path,
//! and nothing else. Reading is *not* here: it lives on the main API, on loopback, because a
//! delivery report carries phone numbers and the recorder is the part exposed to the network.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::watch;

/// Bodies larger than this are recorded truncated rather than dropped.
///
/// A delivery report is small. The cap is about not letting one caller hold a megabyte per
/// callback, and truncating rather than refusing is the choice that keeps the report: a 413 would
/// make the sender's retry our problem, and lose the evidence either way.
///
/// **It caps `json` too**, which is the whole reason it caps anything. The first version parsed the
/// body before clipping it, so a 200 KB report kept a clipped `body` beside a complete parsed copy
/// — a record contradicting itself, and a limit that saved nothing, since the parsed form is larger
/// in memory than the text it came from.
pub const MAX_BODY_BYTES: usize = 64 * 1024;

/// How many callbacks one path keeps. Oldest out first, and the drop is counted.
pub const MAX_PER_PATH: usize = 100;

/// How many paths are held at once. The paths are author-chosen and unbounded, and anyone who can
/// reach the recorder can invent more, so this is the thing standing between a typo and the heap.
pub const MAX_PATHS: usize = 256;

/// How long a callback is kept. Long enough to outlive any wait, short enough that a day of
/// delivery reports is not still in memory tomorrow.
pub const TTL_MINUTES: i64 = 60;

/// One received request, as faithfully as it arrived.
#[derive(Debug, Clone, Serialize)]
pub struct Received {
    pub method: String,
    /// The path under the hook base — what the author put in `drCallbackUrl`.
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    pub headers: HashMap<String, String>,
    pub body: String,
    /// Parsed when it parses. A delivery report is somebody else's contract and refusing a shape
    /// we did not expect would be refusing the test, so a non-JSON body is kept as text.
    ///
    /// Absent whenever `truncated` is set: half a document does not parse, and a parse of the
    /// *whole* body sitting beside a clipped `body` would be a record disagreeing with itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json: Option<Value>,
    /// True when `body` is only the first `MAX_BODY_BYTES`. Never silently short.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    pub received_at: DateTime<Utc>,
}

/// What a reader sees for one path.
#[derive(Debug, Clone, Serialize)]
pub struct Inbox {
    pub path: String,
    pub count: usize,
    /// Callbacks this path dropped to stay inside its cap. Reported rather than hidden — an inbox
    /// that quietly forgot something is worse than one that says it is full.
    pub dropped: usize,
    pub received: Vec<Received>,
}

#[derive(Debug, Default)]
struct Slot {
    items: VecDeque<Received>,
    dropped: usize,
}

/// The recorder, shared by the two listeners.
///
/// One channel for everything rather than one per path: a waiter wakes on any callback and
/// re-checks its own path, which costs a lock and is wrong for nobody. Per-path channels would be a
/// map to create, find and clean up for a saving no run will notice.
///
/// A `watch` of a counter rather than a `Notify`, and that is not a style choice. `Notify::notified`
/// does not register the waiter until the future is first polled, and `notify_waiters` only wakes
/// waiters already registered — so a callback landing between "check the inbox" and "await the next
/// one" is missed, and the waiter sits until its timeout while the thing it wanted is already
/// recorded. `Notified::enable` fixes that but cannot be returned from a function, being `!Unpin`.
/// A `watch::Receiver` remembers the version it has seen, so the race cannot be written.
#[derive(Clone)]
pub struct Hooks {
    slots: Arc<Mutex<HashMap<String, Slot>>>,
    /// Bumped once per recorded callback. The value is meaningless; that it changed is the signal.
    ticks: Arc<watch::Sender<u64>>,
}

impl Default for Hooks {
    fn default() -> Self {
        Self::new()
    }
}

impl Hooks {
    pub fn new() -> Self {
        Self {
            slots: Arc::new(Mutex::new(HashMap::new())),
            ticks: Arc::new(watch::Sender::new(0)),
        }
    }

    /// Record a callback and wake anything waiting.
    pub fn record(&self, mut received: Received) {
        if received.body.len() > MAX_BODY_BYTES {
            // On a char boundary, or the truncated string is not a string.
            let mut cut = MAX_BODY_BYTES;
            while cut > 0 && !received.body.is_char_boundary(cut) {
                cut -= 1;
            }
            received.body.truncate(cut);
            received.truncated = true;
            // The parse, if any, was of the whole body — so keeping it would leave a clipped `body`
            // beside a complete `json`, and would defeat the cap, the parsed form being the larger
            // of the two. The handler skips the parse for an oversized body; this is what
            // guarantees it, for any caller.
            received.json = None;
        }

        let mut slots = self.slots.lock().expect("hooks lock");
        prune_expired(&mut slots);

        // A path nobody has used is a new path, and there is a ceiling on those.
        if !slots.contains_key(&received.path) && slots.len() >= MAX_PATHS {
            // Drop the path whose newest callback is oldest — the one least likely to be waited
            // on. Not the whole map: an eviction that clears everything would take the inbox a
            // run is waiting on with it.
            if let Some(stalest) = slots
                .iter()
                .min_by_key(|(_, s)| s.items.back().map(|r| r.received_at))
                .map(|(p, _)| p.clone())
            {
                slots.remove(&stalest);
                tracing::warn!(
                    "Hook inbox limit of {} paths reached — dropped everything recorded for \"{}\" \
                     to make room for \"{}\"",
                    MAX_PATHS,
                    stalest,
                    received.path
                );
            }
        }

        let slot = slots.entry(received.path.clone()).or_default();
        while slot.items.len() >= MAX_PER_PATH {
            slot.items.pop_front();
            slot.dropped += 1;
        }
        slot.items.push_back(received);
        drop(slots);

        // After the lock, so a woken waiter does not immediately block on it.
        self.ticks.send_modify(|n| *n += 1);
    }

    /// Everything recorded for a path, newest last.
    pub fn inbox(&self, path: &str) -> Inbox {
        let mut slots = self.slots.lock().expect("hooks lock");
        prune_expired(&mut slots);
        let slot = slots.get(path);
        Inbox {
            path: path.to_string(),
            count: slot.map(|s| s.items.len()).unwrap_or(0),
            dropped: slot.map(|s| s.dropped).unwrap_or(0),
            received: slot.map(|s| s.items.iter().cloned().collect()).unwrap_or_default(),
        }
    }

    /// Callbacks for a path that arrived at or after `since`, oldest first.
    ///
    /// The filter is what makes an author-chosen path safe to reuse. A path like `dr/jt1-sms` is
    /// readable and stable, which also means last week's delivery report is still sitting in it —
    /// and without this, a wait would be satisfied by that instantly and report a pass for a
    /// message this run never sent.
    pub fn since(&self, path: &str, since: DateTime<Utc>) -> Vec<Received> {
        let mut slots = self.slots.lock().expect("hooks lock");
        prune_expired(&mut slots);
        slots
            .get(path)
            .map(|s| s.items.iter().filter(|r| r.received_at >= since).cloned().collect())
            .unwrap_or_default()
    }

    /// Subscribe *before* reading the inbox, then await `changed()`.
    ///
    /// Subscribing marks the current version as seen, so `changed()` reports anything recorded from
    /// this moment on — including a callback that lands while the caller is still reading. Getting
    /// this order wrong is the bug this shape exists to make unwritable; see the note on `Hooks`.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.ticks.subscribe()
    }

    /// Paths currently held, for the localhost listing.
    pub fn paths(&self) -> Vec<String> {
        let mut slots = self.slots.lock().expect("hooks lock");
        prune_expired(&mut slots);
        let mut out: Vec<String> = slots.keys().cloned().collect();
        out.sort();
        out
    }
}

/// Drop what is past its TTL, and any path left empty by it.
///
/// On write and on read rather than on a timer: there is no thread to own, and an inbox nobody
/// touches costs nothing by staying a moment longer than an hour.
///
/// **Assumes the front is the oldest**, which holds because callbacks are stamped as they arrive
/// and pushed to the back. That is what makes this O(1) per expired item instead of a scan of every
/// path on every write. A test that injects out-of-order timestamps will not see the later ones
/// expire — worth knowing before writing one, not a defect in production.
fn prune_expired(slots: &mut HashMap<String, Slot>) {
    let cutoff = Utc::now() - Duration::minutes(TTL_MINUTES);
    slots.retain(|_, slot| {
        while slot.items.front().is_some_and(|r| r.received_at < cutoff) {
            slot.items.pop_front();
            // Not counted as a drop: expiring is time passing, not the inbox being full, and
            // conflating them would make "dropped" mean two things.
        }
        !slot.items.is_empty()
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds_ago: i64) -> DateTime<Utc> {
        Utc::now() - Duration::seconds(seconds_ago)
    }

    fn callback(path: &str, body: &str, when: DateTime<Utc>) -> Received {
        Received {
            method: "POST".into(),
            path: path.into(),
            query: None,
            headers: HashMap::new(),
            body: body.into(),
            json: serde_json::from_str(body).ok(),
            truncated: false,
            received_at: when,
        }
    }

    #[test]
    fn a_callback_is_recorded_and_read_back() {
        let hooks = Hooks::new();
        hooks.record(callback("dr/jt1", r#"{"status":"DELIVERED"}"#, Utc::now()));

        let inbox = hooks.inbox("dr/jt1");
        assert_eq!(inbox.count, 1);
        assert_eq!(inbox.received[0].json.as_ref().unwrap()["status"], "DELIVERED");
        // A path nobody called is empty rather than missing — the caller asking "did it arrive?"
        // gets an answer, not an error.
        assert_eq!(hooks.inbox("dr/never").count, 0);
    }

    #[test]
    fn a_body_that_is_not_json_is_kept_as_text() {
        // A delivery report is somebody else's contract. Refusing a shape we did not expect would
        // be refusing the test.
        let hooks = Hooks::new();
        hooks.record(callback("dr/x", "id=1&status=DELIVERED", Utc::now()));
        let inbox = hooks.inbox("dr/x");
        assert_eq!(inbox.received[0].body, "id=1&status=DELIVERED");
        assert!(inbox.received[0].json.is_none());
    }

    #[test]
    fn only_callbacks_that_arrived_after_a_wait_began_are_offered() {
        // The rule that makes an author-chosen path safe to reuse. `dr/jt1-sms` is readable and
        // stable, which also means last week's delivery report is still in it — and without this a
        // wait would be satisfied instantly and report a pass for a message this run never sent.
        let hooks = Hooks::new();
        // Five minutes, not an hour: past the TTL it would be pruned and the test would pass for
        // the wrong reason — the stale callback gone rather than filtered.
        hooks.record(callback("dr/jt1", r#"{"n":"old"}"#, at(300)));
        let step_began = Utc::now();
        hooks.record(callback("dr/jt1", r#"{"n":"new"}"#, Utc::now()));

        let fresh = hooks.since("dr/jt1", step_began);
        assert_eq!(fresh.len(), 1, "{fresh:?}");
        assert_eq!(fresh[0].json.as_ref().unwrap()["n"], "new");
        // Both are still readable — the filter is for the wait, not a deletion.
        assert_eq!(hooks.inbox("dr/jt1").count, 2);
    }

    #[test]
    fn a_clipped_body_keeps_no_json() {
        // Otherwise the record contradicts itself — `truncated` set, yet carrying fields that are
        // not in the body it shows — and the cap saves nothing, the parsed copy being bigger than
        // the text. Recorded here rather than trusted to the handler, so it holds for any caller.
        let hooks = Hooks::new();
        let big = format!(r#"{{"pad":"{}"}}"#, "x".repeat(MAX_BODY_BYTES));
        let mut note = callback("dr/big", &big, Utc::now());
        assert!(note.json.is_some(), "the fixture really did parse before clipping");
        note.path = "dr/big".into();
        hooks.record(note);

        let got = &hooks.inbox("dr/big").received[0];
        assert!(got.truncated);
        assert!(got.json.is_none(), "a clipped note must not carry a whole parse");
    }

    #[test]
    fn a_body_over_the_cap_is_truncated_and_says_so() {
        // Never silently short. Truncating rather than refusing keeps the evidence: a non-2xx is an
        // instruction to retry on most platforms and the report would be lost either way.
        let hooks = Hooks::new();
        hooks.record(callback("dr/big", &"x".repeat(MAX_BODY_BYTES + 500), Utc::now()));
        let got = &hooks.inbox("dr/big").received[0];
        assert_eq!(got.body.len(), MAX_BODY_BYTES);
        assert!(got.truncated);
    }

    #[test]
    fn truncation_does_not_split_a_character() {
        // `String::truncate` panics off a char boundary, and a multi-byte body is not exotic — a
        // status message in any non-Latin script is one.
        let hooks = Hooks::new();
        // 3 bytes each, so the cap lands mid-character.
        let body = "\u{20b9}".repeat(MAX_BODY_BYTES);
        hooks.record(callback("dr/utf8", &body, Utc::now()));
        let got = &hooks.inbox("dr/utf8").received[0];
        assert!(got.truncated);
        assert!(got.body.len() <= MAX_BODY_BYTES);
        // Still valid UTF-8 and a whole number of characters.
        assert!(got.body.chars().all(|c| c == '\u{20b9}'));
    }

    #[test]
    fn a_full_path_drops_the_oldest_and_counts_it() {
        // An inbox that quietly forgot something is worse than one that says it is full.
        let hooks = Hooks::new();
        for i in 0..(MAX_PER_PATH + 5) {
            hooks.record(callback("dr/busy", &format!(r#"{{"i":{i}}}"#), Utc::now()));
        }
        let inbox = hooks.inbox("dr/busy");
        assert_eq!(inbox.count, MAX_PER_PATH);
        assert_eq!(inbox.dropped, 5);
        // The newest survive: a delivery report is more interesting than its predecessor.
        assert_eq!(inbox.received.last().unwrap().json.as_ref().unwrap()["i"], MAX_PER_PATH + 4);
    }

    #[test]
    fn too_many_paths_drops_the_stalest_one_not_all_of_them() {
        // Paths are author-chosen and unbounded, and anyone who can reach the recorder can invent
        // more. Clearing the map would take the inbox a run is waiting on with it.
        let hooks = Hooks::new();
        hooks.record(callback("dr/stale", "{}", at(300)));
        for i in 0..MAX_PATHS {
            hooks.record(callback(&format!("dr/p{i}"), "{}", Utc::now()));
        }
        assert_eq!(hooks.inbox("dr/stale").count, 0, "the stalest path went");
        assert_eq!(hooks.inbox("dr/p0").count, 1, "a recent one stayed");
        assert!(hooks.paths().len() <= MAX_PATHS);
    }

    #[test]
    fn a_callback_past_its_ttl_is_forgotten() {
        let hooks = Hooks::new();
        hooks.record(callback("dr/old", "{}", at(TTL_MINUTES * 60 + 60)));
        hooks.record(callback("dr/old", "{}", Utc::now()));
        assert_eq!(hooks.inbox("dr/old").count, 1);
    }

    #[test]
    fn expiring_is_not_counted_as_dropping() {
        // Expiring is time passing; dropping is the inbox being full. Conflating them would make
        // "dropped" mean two things and neither would be actionable.
        //
        // Against `prune_expired` directly, because going through `record` cannot show this: a
        // path emptied by expiry is removed entirely, counter and all, so an extra increment would
        // vanish with it and the test would pass either way.
        let mut slots = HashMap::new();
        slots.insert(
            "dr/mixed".to_string(),
            Slot {
                items: [
                    callback("dr/mixed", "{}", at(TTL_MINUTES * 60 + 60)),
                    callback("dr/mixed", "{}", Utc::now()),
                ]
                .into(),
                dropped: 3,
            },
        );

        prune_expired(&mut slots);

        let slot = &slots["dr/mixed"];
        assert_eq!(slot.items.len(), 1, "the expired one went");
        assert_eq!(slot.dropped, 3, "and the cap's tally is untouched by it");
    }

    #[test]
    fn a_path_emptied_by_expiry_stops_being_held() {
        let hooks = Hooks::new();
        hooks.record(callback("dr/gone", "{}", at(TTL_MINUTES * 60 + 60)));
        // Any read prunes.
        assert_eq!(hooks.inbox("dr/gone").count, 0);
        assert!(!hooks.paths().contains(&"dr/gone".to_string()));
    }

    #[tokio::test]
    async fn a_waiter_is_woken_the_moment_a_callback_lands() {
        // Event, not poll. Nothing here elapses an interval: the test would hang if the wake did
        // not happen, and `tokio::select!` proves which side finished.
        let hooks = Hooks::new();
        let mut sub = hooks.subscribe();
        let recorder = hooks.clone();
        tokio::spawn(async move {
            recorder.record(callback("dr/wake", r#"{"status":"DELIVERED"}"#, Utc::now()));
        });

        tokio::select! {
            _ = sub.changed() => {}
            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {
                panic!("the waiter was never woken");
            }
        }
        assert_eq!(hooks.inbox("dr/wake").count, 1);
    }

    #[tokio::test]
    async fn the_wake_future_is_armed_before_the_inbox_is_read() {
        // The ordering `shutdown::stop_requested` is careful about: a callback landing between the
        // read and the wait must not be missed, or the waiter sits until its timeout while the
        // thing it wanted is already recorded.
        let hooks = Hooks::new();
        let mut sub = hooks.subscribe();                          // subscribed first
        assert_eq!(hooks.since("dr/race", Utc::now()).len(), 0);  // then read: nothing yet
        hooks.record(callback("dr/race", "{}", Utc::now()));      // lands in between

        tokio::select! {
            _ = sub.changed() => {}
            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {
                panic!("a callback that landed after the read was missed");
            }
        }
    }
}
