//! "Stop when you reach a safe point."
//!
//! Ctrl+C used to be received and then ignored: `with_graceful_shutdown` stops accepting
//! new connections and waits for the open ones, and a suite's SSE stream stays open for
//! as long as the suite runs. Pressing it again did nothing, because the signal future
//! had already completed. The server sat there for minutes still creating accounts.
//!
//! Two presses now mean two different things:
//!
//! - **First** — runs stop at their next node boundary, and their teardown still runs.
//!   The same rule as a client walking away: there is no version of cancel that leaves
//!   the account behind.
//! - **Second** — exit now. Cleanup may not have finished, which is why it takes asking
//!   twice.
//!
//! The flag is process-wide because process shutdown is, and it is an `Arc` rather than
//! a bare static so tests can hold their own and never touch the real one — a global
//! that tests mutate is a global that makes tests flaky in parallel.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use tokio::sync::Notify;

fn cell() -> &'static (Arc<AtomicBool>, Notify) {
    static CELL: OnceLock<(Arc<AtomicBool>, Notify)> = OnceLock::new();
    CELL.get_or_init(|| (Arc::new(AtomicBool::new(false)), Notify::new()))
}

/// The process-wide stop flag. Runs hold a clone.
pub fn flag() -> Arc<AtomicBool> {
    cell().0.clone()
}

/// Ask every run to stop at its next safe point.
pub fn request_stop() {
    cell().0.store(true, Ordering::Relaxed);
    // Wakes a stepped run parked waiting for the author to press Next. Without this it
    // would sit there until the process was killed outright.
    cell().1.notify_waiters();
}

/// Has a stop been asked for?
pub fn stopping() -> bool {
    cell().0.load(Ordering::Relaxed)
}

/// Resolves when a stop has been asked for — now, or later.
///
/// The `notified()` future is created *before* the flag is read, or a stop landing
/// between the two would be missed and the caller would wait for a wake-up that has
/// already happened.
pub async fn stop_requested() {
    let notified = cell().1.notified();
    if cell().0.load(Ordering::Relaxed) {
        return;
    }
    notified.await;
}
